// Terrain self-shadowing for low sun angles: a heightfield around the camera is baked on the GPU
// (time-sliced, double-buffered) and a soft shadow is raymarched through it towards the key light.
import * as THREE from 'three';
import { FullscreenPass, passMaterial } from './fullscreen.ts';
import { globals } from './globals.ts';
import { worldGlsl } from '../world/params.ts';
import { NOISE_GLSL } from '../world/noise.ts';
import { terrainGlsl } from '../world/terrain.ts';

const BAKE_FRAG = () => /* glsl */ `
${worldGlsl()}
${NOISE_GLSL}
${terrainGlsl()}
uniform vec4 uBakeOrigin; // x, z, extent
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 p = uBakeOrigin.xy + (vUv - 0.5) * uBakeOrigin.z;
  fragColor = vec4(max(terrainHeight(p, 6), 0.0), 0.0, 0.0, 1.0);
}
`;

const SHADOW_FRAG = /* glsl */ `
uniform sampler2D uHeight;
uniform vec4 uBakeOrigin;
uniform vec3 uKeyDir;
uniform float uTexel;
in vec2 vUv;
out vec4 fragColor;
void main() {
  if (uKeyDir.y < -0.02) { fragColor = vec4(0.0); return; }
  float h0 = texture(uHeight, vUv).r + 4.0;
  vec2 dir = normalize(uKeyDir.xz + 1e-6);
  float tanE = uKeyDir.y / max(length(uKeyDir.xz), 1e-4);
  float ext = uBakeOrigin.z;
  float vis = 1.0;
  float t = uTexel * 1.5;
  for (int i = 0; i < 64; i++) {
    vec2 uv = vUv + dir * (t / ext);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float hs = texture(uHeight, uv).r;
    float hr = h0 + t * tanE;
    if (hr > 2600.0) break;
    vis = min(vis, (hr - hs) / (t * 0.022 + 2.0));
    if (vis < -1.0) break;
    t += max(uTexel * 0.75, t * 0.055);
  }
  fragColor = vec4(clamp(0.5 + 0.5 * vis, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

export class TerrainShadows {
  private heights: THREE.WebGLRenderTarget[];
  private shadow: THREE.WebGLRenderTarget;
  private readonly bake: FullscreenPass;
  private readonly march: FullscreenPass;
  private readonly bakeU = { uBakeOrigin: { value: new THREE.Vector4() } };
  private readonly marchU = {
    uHeight: { value: null as THREE.Texture | null },
    uBakeOrigin: { value: new THREE.Vector4() },
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
    uTexel: { value: 1 },
  };
  /** origin of the heightfield being baked / currently in use */
  private pending = new THREE.Vector3();
  private active = new THREE.Vector3(1e9, 0, 0);
  private bakeRow = -1;
  private lastKey = new THREE.Vector3();
  private needMarch = true;
  private readonly slices = 8;

  constructor(readonly size: number, readonly extent: number) {
    const mk = (type: THREE.TextureDataType) =>
      new THREE.WebGLRenderTarget(size, size, {
        type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
    this.heights = [mk(THREE.FloatType), mk(THREE.FloatType)];
    this.shadow = mk(THREE.UnsignedByteType);
    this.bake = new FullscreenPass(passMaterial(BAKE_FRAG(), this.bakeU));
    this.march = new FullscreenPass(passMaterial(SHADOW_FRAG, this.marchU));
    this.marchU.uTexel.value = extent / size;
    globals.uShadowMap.value = this.shadow.texture;
  }

  /** Call once per frame with the camera position and the key light direction. */
  update(renderer: THREE.WebGLRenderer, camX: number, camZ: number, keyDir: THREE.Vector3): void {
    const texel = this.extent / this.size;
    const snap = texel * 16;
    const need = Math.max(Math.abs(camX - this.active.x), Math.abs(camZ - this.active.z)) > this.extent * 0.18;
    if (need && this.bakeRow < 0) {
      this.pending.set(Math.round(camX / snap) * snap, 0, Math.round(camZ / snap) * snap);
      this.bakeRow = 0;
      // first bake ever: do it all at once so the first frame is shadowed
      if (this.active.x > 1e8) this.bakeRow = -2;
    }
    const back = this.heights[1];
    if (this.bakeRow !== -1) {
      this.bakeU.uBakeOrigin.value.set(this.pending.x, this.pending.z, this.extent, 0);
      if (this.bakeRow === -2) {
        this.bake.render(renderer, back);
        this.bakeRow = this.slices;
      } else {
        const rows = this.size / this.slices;
        back.scissor.set(0, this.bakeRow * rows, this.size, rows);
        back.scissorTest = true;
        this.bake.render(renderer, back);
        back.scissorTest = false;
        this.bakeRow++;
      }
      if (this.bakeRow >= this.slices) {
        this.heights.reverse();
        this.active.copy(this.pending);
        this.bakeRow = -1;
        this.needMarch = true;
      }
    }
    // re-march only when the light moved (~0.03°) or a new heightfield became active
    if (!this.needMarch && this.lastKey.dot(keyDir) > 0.99999986) return;
    this.needMarch = false;
    this.lastKey.copy(keyDir);
    this.marchU.uHeight.value = this.heights[0].texture;
    this.marchU.uBakeOrigin.value.set(this.active.x, this.active.z, this.extent, 0);
    this.marchU.uKeyDir.value.copy(keyDir);
    this.march.render(renderer, this.shadow);
    globals.uShadowOrigin.value.set(this.active.x, this.active.z, this.extent, 0);
  }
}
