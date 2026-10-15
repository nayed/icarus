// Owns the WebGL renderer and draws the world each frame.
import * as THREE from 'three';
import type { Capabilities } from './capabilities.ts';
import { PRESETS, type QualityPreset, type QualityName, ResolutionScaler } from './quality.ts';
import { Atmosphere, transmittanceCPU } from './atmosphere.ts';
import { Sky } from './sky.ts';
import { TerrainMesh } from './terrainMesh.ts';
import { Post } from './post.ts';
import { Clouds, CLOUD_BASE, CLOUD_TOP } from './clouds.ts';
import { TerrainShadows } from './shadows.ts';
import { Trees } from './trees.ts';
import { Water } from './water.ts';
import { globals } from './globals.ts';
import { GpuTimer } from './gpuTimer.ts';
import {
  sunDirection, moonDirection, starRotation, exposureForSun, elevationDeg, SUN_ILLUMINANCE, MOON_ILLUMINANCE_SCALE, MOON_ILLUMINATION,
} from '../world/celestial.ts';
import { makeClipState, type ClipState } from '../world/clipmap.ts';

// three's logdepthbuf_vertex chunk calls isPerspectiveMatrix() from <common>, which the custom
// shaders here do not include (it would clash with their own helpers): a self-contained copy
(THREE.ShaderChunk as unknown as Record<string, string>).icarus_logdepth_vertex = /* glsl */ `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  vFragDepth = 1.0 + gl_Position.w;
  vIsPerspective = projectionMatrix[2][3] == -1.0 ? 1.0 : 0.0;
#endif
`;

const tmpV = new THREE.Vector3();

export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly atmosphere: Atmosphere;
  sky: Sky;
  terrain: TerrainMesh;
  post: Post;
  clouds: Clouds | null = null;
  shadows: TerrainShadows | null = null;
  trees: Trees;
  water: Water;
  readonly scaler = new ResolutionScaler();
  readonly gpuTimer: GpuTimer;
  preset: QualityPreset;
  /** Clip state of the last rendered frame: collision must use this. */
  clip: ClipState;
  timeOfDay = 18.15;
  frame = 0;
  private cssW = 1;
  private cssH = 1;
  pixelRatio = 1;
  /** debug hook: runs after lighting is computed, before drawing */
  onBeforeRender: (() => void) | null = null;
  /** app hook: runs right before the main scene is drawn (e.g. aircraft shadow map) */
  onBeforeScene: ((r: THREE.WebGLRenderer) => void) | null = null;
  /** time used for the sea surface (the flight model's clock, so physics and visuals agree) */
  waveTime = 0;
  /** debug: when set, each pass is GPU-synced and timed into this map */
  profile: Map<string, number> | null = null;
  private profT = 0;
  private mark(name: string): void {
    if (!this.profile) return;
    const gl = this.renderer.getContext();
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.profPx);
    this.renderer.setRenderTarget(prev);
    const t = performance.now();
    if (name !== 'start') this.profile.set(name, (this.profile.get(name) ?? 0) + (t - this.profT));
    this.profT = t;
  }
  private profPx = new Uint8Array(4);

  constructor(canvas: HTMLCanvasElement, readonly caps: Capabilities, quality: QualityName) {
    this.preset = PRESETS[quality];
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      reversedDepthBuffer: caps.reversedZ,
      logarithmicDepthBuffer: !caps.reversedZ,
    });
    this.renderer.autoClear = true;
    this.renderer.info.autoReset = false;
    this.gpuTimer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext);
    this.renderer.setClearColor(0x000000, 1);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.2, 400000);
    const floatType = caps.floatTargets ? (caps.floatLinear ? THREE.FloatType : THREE.HalfFloatType) : THREE.UnsignedByteType;
    this.atmosphere = new Atmosphere(caps.floatTargets ? floatType : THREE.HalfFloatType);
    globals.uTransmittance.value = this.atmosphere.transmittance.texture;
    globals.uSkyView.value = this.atmosphere.skyView.texture;
    this.sky = new Sky(caps.floatTargets ? THREE.HalfFloatType : THREE.UnsignedByteType, this.preset.envWidth, !caps.floatTargets);
    this.scene.add(this.sky.mesh);
    this.terrain = new TerrainMesh(
      { M: this.preset.terrainM, levels: this.preset.terrainLevels, s0: this.preset.terrainS0 },
      !caps.floatTargets,
      caps.floatTargets && !caps.forced.includes('noatlas'),
    );
    this.scene.add(this.terrain.group);
    this.trees = this.makeTrees();
    this.scene.add(this.trees.mesh);
    this.water = this.makeWater();
    this.scene.add(this.water.group);
    this.sky.mesh.layers.enable(1);
    this.clip = makeClipState(this.terrain.cfg, 0, 0);
    this.post = new Post({ hdr: caps.floatTargets, bloomLevels: this.preset.bloomLevels, samples: this.preset.msaa });
    if (caps.floatTargets) this.clouds = new Clouds(THREE.HalfFloatType, this.preset.cloudDiv, this.preset.cloudSteps);
    if (caps.floatTargets) this.shadows = new TerrainShadows(this.preset.shadowSize, 32000);
  }

  private makeTrees(): Trees {
    const p = this.preset;
    const t = new Trees(p.trees, p.treeRadius, p.treeCell, !this.caps.floatTargets);
    t.mesh.layers.enable(1);
    return t;
  }

  private makeWater(): Water {
    const p = this.preset;
    return new Water({ M: p.waterM, levels: p.waterLevels, s0: p.terrainS0 }, !this.caps.floatTargets, p.reflScale, this.terrain);
  }

  setQuality(name: QualityName): void {
    if (name === this.preset.name) return;
    this.preset = PRESETS[name];
    this.scene.remove(this.terrain.group);
    this.terrain.dispose();
    this.terrain = new TerrainMesh(
      { M: this.preset.terrainM, levels: this.preset.terrainLevels, s0: this.preset.terrainS0 },
      !this.caps.floatTargets,
      this.caps.floatTargets && !this.caps.forced.includes('noatlas'),
    );
    this.scene.add(this.terrain.group);
    this.scene.remove(this.trees.mesh);
    this.trees = this.makeTrees();
    this.scene.add(this.trees.mesh);
    const wind = globals.uWind.value;
    this.scene.remove(this.water.group);
    this.water.reflection?.dispose();
    this.water = this.makeWater();
    this.water.setWind(wind.x, wind.z);
    this.scene.add(this.water.group);
    // environment map size, post (bloom levels, MSAA), clouds and shadows also depend on the preset
    const hdr = this.caps.floatTargets;
    this.scene.remove(this.sky.mesh);
    this.sky.env.dispose();
    this.sky = new Sky(hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, this.preset.envWidth, !hdr);
    this.sky.mesh.layers.enable(1);
    this.scene.add(this.sky.mesh);
    this.post.dispose();
    this.post = new Post({ hdr, bloomLevels: this.preset.bloomLevels, samples: this.preset.msaa });
    this.clouds?.dispose();
    this.clouds = hdr ? new Clouds(THREE.HalfFloatType, this.preset.cloudDiv, this.preset.cloudSteps) : null;
    this.shadows?.dispose();
    this.shadows = hdr ? new TerrainShadows(this.preset.shadowSize, 32000) : null;
    this.scaler.scale = 1;
    this.scaler.hold(2);
    this.applySize();
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.applySize();
  }

  private applySize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.preset.maxPixelRatio * 2);
    this.pixelRatio = Math.min(dpr, this.preset.maxPixelRatio <= 1 ? Math.max(this.preset.maxPixelRatio, 1) : dpr);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.cssW, this.cssH, false);
    const s = this.scaler.scale * Math.min(1, this.preset.maxPixelRatio);
    this.post.setSize(this.cssW * this.pixelRatio * s, this.cssH * this.pixelRatio * s);
    this.clouds?.setSize(this.post.width, this.post.height);
    this.water?.setSize(this.post.width, this.post.height);
    this.camera.aspect = this.cssW / this.cssH;
    this.camera.updateProjectionMatrix();
  }

  /** Updates lighting for the time of day and camera. */
  private updateLighting(): void {
    const g = globals;
    const sun = sunDirection(this.timeOfDay, g.uSunDir.value);
    const moon = moonDirection(this.timeOfDay, g.uMoonDir.value);
    const sunElev = elevationDeg(sun);
    const exposure = exposureForSun(sunElev);
    g.uExposure.value = exposure;
    const altKm = Math.max(this.camera.position.y, 0) / 1000;
    g.uCamAltKm.value = altKm;
    const sunIllum = tmpV.copy(SUN_ILLUMINANCE).multiplyScalar(exposure);
    g.uSunIllum.value.copy(sunIllum);
    const moonScale = MOON_ILLUMINANCE_SCALE * MOON_ILLUMINATION;
    g.uMoonIllum.value.copy(SUN_ILLUMINANCE).multiplyScalar(exposure * moonScale);
    transmittanceCPU(altKm, sun.y, g.uSunColor.value).multiply(g.uSunIllum.value);
    transmittanceCPU(altKm, moon.y, g.uMoonColor.value).multiply(g.uMoonIllum.value);
    const a = this.atmosphere.uniforms;
    a.uCamAltKm.value = altKm;
    a.uSunDir.value.copy(sun);
    a.uMoonDir.value.copy(moon);
    a.uSunIllum.value.copy(g.uSunIllum.value);
    a.uMoonIllum.value.copy(g.uMoonIllum.value);
    // sun disc radiance: illuminance / solid angle of the disc
    const sunSolid = Math.PI * 0.0048 * 0.0048;
    this.sky.uniforms.uSunDiscRad.value.copy(g.uSunIllum.value).multiplyScalar(1 / sunSolid);
    const moonSolid = Math.PI * 0.0047 * 0.0047;
    this.sky.uniforms.uMoonRad.value.copy(SUN_ILLUMINANCE).multiplyScalar((exposure * MOON_ILLUMINANCE_SCALE) / moonSolid * 1.4);
    if (this.clouds) {
      const cu = this.clouds.uniforms;
      const cloudKm = (CLOUD_BASE + CLOUD_TOP) / 2000;
      transmittanceCPU(cloudKm, sun.y, cu.uSunCloud.value).multiply(g.uSunIllum.value);
      transmittanceCPU(cloudKm, moon.y, cu.uMoonCloud.value).multiply(g.uMoonIllum.value);
    }
    starRotation(this.timeOfDay, g.uStarRot.value);
    // stars and aurora only in darkness (they are swamped by the sky anyway, but this saves work)
    const dark = THREE.MathUtils.smoothstep(-sunElev, 4, 14);
    g.uStarBright.value = exposure * 2.2e-6 * dark;
    g.uAurora.value = exposure * 1.3e-5 * THREE.MathUtils.smoothstep(-sunElev, 8, 15);
    this.post.composeUniforms.uNight.value = THREE.MathUtils.smoothstep(Math.log(exposure), Math.log(150), Math.log(4000));
    // valley mist: thicker around dawn and dusk, thin by day
    const twilight = 1 - THREE.MathUtils.smoothstep(Math.abs(sunElev + 2), 3, 12);
    g.uFog.value.set(1, 0.03 + 0.055 * twilight + 0.03 * this.post.composeUniforms.uNight.value, 0.11);
    g.uAmbientBoost.value = 1 + 0.45 * twilight + 0.25 * this.post.composeUniforms.uNight.value;
  }

  private renderReflection(cam: THREE.PerspectiveCamera): void {
    const w = this.water;
    if (!w.reflection) return;
    const g = globals;
    w.updateReflectionCamera(cam);
    const rc = w.reflCam;
    const savedPos = g.uCamPosF.value.clone();
    const savedRot = g.uViewRot.value.clone();
    g.uCamPosF.value.set(Math.fround(rc.position.x), Math.fround(rc.position.y), Math.fround(rc.position.z));
    g.uViewRot.value.extractRotation(rc.matrixWorldInverse);
    g.uReflectPass.value = 1;
    this.sky.updateCamera(rc);
    const r = this.renderer;
    r.setRenderTarget(w.reflection);
    r.clear(true, true, false);
    r.render(this.scene, rc);
    g.uReflectPass.value = 0;
    g.uCamPosF.value.copy(savedPos);
    g.uViewRot.value.copy(savedRot);
    this.sky.updateCamera(cam);
  }

  render(dt: number): void {
    const g = globals;
    this.frame++;
    g.uTime.value += dt;
    g.uCloudOffset.value.x += g.uWind.value.x * dt;
    g.uCloudOffset.value.y += g.uWind.value.z * dt;
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.updateLighting();
    g.uCamPosF.value.set(Math.fround(cam.position.x), Math.fround(cam.position.y), Math.fround(cam.position.z));
    g.uViewRot.value.copy(cam.matrixWorldInverse).setPosition(0, 0, 0);
    // translation of the view must be removed in world space, not view space: rebuild from rotation only
    g.uViewRot.value.extractRotation(cam.matrixWorldInverse);
    g.uPixelAngle.value = THREE.MathUtils.degToRad(cam.fov) / Math.max(1, this.post.height);
    this.sky.updateCamera(cam);
    this.onBeforeRender?.();

    const r = this.renderer;
    r.info.reset();
    this.gpuTimer.begin();
    this.mark('start');
    this.atmosphere.init(r);
    this.atmosphere.update(r);
    this.mark('skyLUT');
    this.sky.renderEnv(r);
    this.mark('env');

    const keyIsSun = g.uSunDir.value.y > -0.07;
    g.uKeyIsSun.value = keyIsSun ? 1 : 0;
    this.shadows?.update(r, cam.position.x, cam.position.z, keyIsSun ? g.uSunDir.value : g.uMoonDir.value);
    this.mark('shadows');
    this.terrain.update(r, cam.position.x, cam.position.z);
    this.mark('terrainBake');
    this.trees.update(cam.position.x, cam.position.z, 1.5);
    this.water.update(cam.position.x, cam.position.z, this.waveTime);
    this.renderReflection(cam);
    this.mark('reflection');
    this.clip = makeClipState(this.terrain.cfg, cam.position.x, cam.position.z);

    this.onBeforeScene?.(r);
    r.setRenderTarget(this.post.scene);
    r.clear(true, true, false);
    r.render(this.scene, cam);
    this.mark('scene');
    if (this.clouds) {
      this.clouds.render(r, this.post.scene, cam, this.frame);
      this.mark('clouds');
      this.post.finish(r, this.frame, this.clouds.output.texture);
    } else {
      this.post.finish(r, this.frame);
    }
    this.gpuTimer.end();
    this.mark('post');
  }
}
