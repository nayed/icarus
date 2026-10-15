// Sea surface on clipmap rings (out to the horizon) with Gerstner waves, planar reflections of the
// fjord walls, sky reflections, sun/moon glitter, depth-based colour and shoreline foam.
import * as THREE from 'three';
import {
  type ClipmapConfig, type PieceGeometry, ringPiece, centerPiece, trimColumnPiece, trimRowPiece, clipInstances,
} from '../world/clipmap.ts';
import { WaveSet, WATER_GLSL, WAVE_COUNT } from '../world/water.ts';
import { worldGlsl } from '../world/params.ts';
import { NOISE_GLSL } from '../world/noise.ts';
import { terrainGlsl } from '../world/terrain.ts';
import { ATMOSPHERE_GLSL, SKYVIEW_SAMPLE_GLSL } from './atmosphere.ts';
import { GLOBALS_GLSL, globals } from './globals.ts';
import { CLOUD_COMMON_GLSL } from './clouds.ts';
import { OUTPUT_GLSL } from './post.ts';

export const LAYER_REFLECT = 1;

const VERT = /* glsl */ `
in vec4 aInst;
uniform vec2 uClipCenter;
uniform float uClipM;
out vec3 vWorld;
out vec2 vLattice;
out float vSpacing;
#include <logdepthbuf_pars_vertex>
float morphFactor(vec2 p, float s) {
  float W = uClipM / 8.0;
  vec2 d = abs(p - uClipCenter) / s;
  return clamp((max(d.x, d.y) - (uClipM * 0.5 - 2.0 - W)) / W, 0.0, 1.0);
}
vec3 waterVertex(vec2 p, float s) {
  vec3 d = waveDisplacement(p, s);
  float k = morphFactor(p, s);
  if (k <= 0.0) return d;
  ivec2 ii = ivec2(round(p / s));
  int ox = ii.x & 1;
  int oz = ii.y & 1;
  float S = 2.0 * s;
  vec3 dc;
  if (ox == 0 && oz == 0) dc = waveDisplacement(p, S);
  else if (ox == 1 && oz == 0) dc = 0.5 * (waveDisplacement(p - vec2(s, 0.0), S) + waveDisplacement(p + vec2(s, 0.0), S));
  else if (ox == 0 && oz == 1) dc = 0.5 * (waveDisplacement(p - vec2(0.0, s), S) + waveDisplacement(p + vec2(0.0, s), S));
  else dc = 0.5 * (waveDisplacement(p - vec2(s), S) + waveDisplacement(p + vec2(s), S));
  return mix(d, dc, k);
}
void main() {
  float s = aInst.z;
  vec2 p = aInst.xy + position.xz * s;
  vec3 d = waterVertex(p, s);
  vWorld = vec3(p.x + d.x, SEA_LEVEL + d.y, p.y + d.z);
  vLattice = p;
  vSpacing = s;
  gl_Position = projectionMatrix * (uViewRot * vec4(vWorld - uCamPosF, 1.0));
  #include <icarus_logdepth_vertex>
}
`;

const FLOOR_GLSL = /* glsl */ `
#ifdef HEIGHT_ATLAS
uniform highp sampler2D uHeightAtlas;
uniform vec2 uLevelOrigin[ATLAS_LEVELS];
uniform float uS0;
float atlasBilinear(vec2 p, int L) {
  float s = uS0 * exp2(float(L));
  vec2 t = (p - uLevelOrigin[L]) / s + float(CLIP_M / 2 + 1);
  vec2 i = floor(t);
  vec2 f = t - i;
  ivec2 b = ivec2(i) + ivec2(0, L * ATLAS_W);
  float h00 = texelFetch(uHeightAtlas, b, 0).r;
  float h10 = texelFetch(uHeightAtlas, b + ivec2(1, 0), 0).r;
  float h01 = texelFetch(uHeightAtlas, b + ivec2(0, 1), 0).r;
  float h11 = texelFetch(uHeightAtlas, b + ivec2(1, 1), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
/** Sea floor height from the terrain clipmap's baked heights (finest level covering p). */
float seaFloor(vec2 p) {
  for (int L = 0; L < ATLAS_LEVELS - 1; L++) {
    float s = uS0 * exp2(float(L));
    vec2 d = abs(p - uLevelOrigin[L]) / s;
    if (max(d.x, d.y) < float(CLIP_M / 2) - 1.0) return atlasBilinear(p, L);
  }
  return -200.0;
}
#else
float seaFloor(vec2 p) { return terrainHeight(p, 3); }
#endif
`;

const FRAG = /* glsl */ `
in vec3 vWorld;
in vec2 vLattice;
in float vSpacing;
uniform sampler2D uReflTex;
uniform mat4 uReflViewProj;
uniform float uHasPlanar;
out vec4 fragColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec3 P = vWorld;
  vec3 toCam = uCamPosF - P;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float foot = dist * uPixelAngle;
  // footprint stretches along the view direction at grazing angles
  float footA = foot / max(abs(V.y), 0.035);

  vec4 wn = waveNormal(vLattice, max(vSpacing, footA * 0.5));
  vec3 N = wn.xyz;
  // ripples: wind-aligned wave trains, modulated by patchy gusts ("cat's paws") so calm mirror
  // areas alternate with ruffled water; faded by pixel footprint to avoid shimmer
  float wind = length(uWind.xz);
  float wa = wind > 0.01 ? atan(uWind.z, uWind.x) : 0.0;
  vec2 drift = uWind.xz * uTime * 0.6;
  float gust = smoothstep(-0.35, 0.55, vnoise((P.xz - drift) * (1.0 / 55.0), 905u) + 0.5 * vnoise((P.xz - drift) * (1.0 / 13.0), 906u));
  float calm = mix(0.3, 1.0, fetchFactor(P.x));
  float slope = (0.015 + 0.011 * min(wind, 14.0)) * mix(0.55, 1.0, gust) * calm * mix(1.0, 1.8, smoothstep(0.7, 1.0, fetchFactor(P.x)));
  vec2 grad = vec2(0.0);
  // slope variance of ripples too small to resolve becomes roughness (keeps distant water from looking glassy)
  float lost = 0.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float lam = 7.0 * pow(0.7, fi);
    float fade = 1.0 - smoothstep(0.25, 0.6, footA / lam);
    lost += slope * slope * (1.0 - fade * fade) * 0.5;
    if (fade <= 0.0) continue;
    float h1 = fract(sin(fi * 12.9898 + 4.1) * 43758.5453);
    float h2 = fract(sin(fi * 78.233 + 1.7) * 24634.6345);
    float ang = wa + (h1 - 0.5) * 2.4;
    vec2 dir = vec2(cos(ang), sin(ang));
    float k = 6.28318 / lam;
    float ph = k * dot(dir, P.xz) - sqrt(9.81 * k) * uTime + h2 * 6.28318;
    grad += dir * cos(ph) * slope * fade * (0.6 + 0.8 * h2);
  }
  N = normalize(N + vec3(-grad.x, 0.0, -grad.y));
  if (dot(N, V) < 0.02) N = normalize(N + V * (0.02 - dot(N, V)));

  // water column depth below this point (cheap terrain evaluation)
  float floorH = seaFloor(P.xz);
  float wdepth = max(P.y - floorH, 0.0);
  float path = wdepth / max(V.y, 0.12) + wdepth;
  vec3 ext = vec3(0.45, 0.16, 0.11);
  vec3 Tw = exp(-ext * path);
  float T = Tw.g;

  // lighting
  float tsh = terrainShadow(P) * planeShadow(P);
  float shSun = mix(1.0, tsh, uKeyIsSun) * cloudShadowAt(P, uSunDir);
  float shMoon = mix(tsh, 1.0, uKeyIsSun) * cloudShadowAt(P, uMoonDir);
  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  float rough = clamp(sqrt(lost) * 6.0, 0.0, 1.0);
  vec3 refl = envSpecular(R, 0.04 + 0.5 * rough);
  if (uHasPlanar > 0.5) {
    vec4 pc = uReflViewProj * vec4(P.x, SEA_LEVEL, P.z, 1.0);
    vec2 uv = pc.xy / pc.w * 0.5 + 0.5;
    uv += N.xz * (0.18 / (1.0 + dist * 0.004));
    uv = clamp(uv, vec2(0.002), vec2(0.998));
    vec3 pl = texture(uReflTex, uv).rgb;
    refl = mix(refl, pl, 0.92 * (1.0 - smoothstep(0.15, 0.7, rough)));
  }
  // sun and moon glitter (GGX-ish lobe)
  vec3 H = normalize(uSunDir + V);
  float r2 = mix(0.006, 0.03, smoothstep(2.0, 12.0, wind)) + lost * 2.0;
  float nh = max(dot(N, H), 0.0);
  float d = nh * nh * (r2 - 1.0) + 1.0;
  float ggx = r2 / (PI * d * d);
  vec3 Hm = normalize(uMoonDir + V);
  float nhm = max(dot(N, Hm), 0.0);
  float dm = nhm * nhm * (r2 - 1.0) + 1.0;
  float ggxm = r2 / (PI * dm * dm);
  vec3 spec = (uSunColor * ggx * shSun * max(dot(N, uSunDir), 0.0) + uMoonColor * ggxm * shMoon * max(dot(N, uMoonDir), 0.0)) * F * 0.25;
  spec = min(spec, vec3(2000.0));

  // light scattered back out of the water body
  vec3 inLight = (uSunColor * max(uSunDir.y, 0.0) * shSun + uMoonColor * max(uMoonDir.y, 0.0) * shMoon) / PI + envDiffuse(vec3(0.0, 1.0, 0.0));
  vec3 body = vec3(0.012, 0.03, 0.034) * inLight;

  vec3 col = refl * F + spec + body * (1.0 - F) * (1.0 - T);
  float alpha = 1.0 - T * (1.0 - F);

  // foam: shoreline and wave crests
  float fn = vnoise(P.xz * 0.35 + uTime * 0.2, 910u) * 0.5 + 0.5;
  float fn2 = vnoise(P.xz * 1.3 - uTime * 0.3, 911u) * 0.5 + 0.5;
  float shore = (1.0 - smoothstep(0.0, 0.9 + 1.4 * fn, wdepth)) * smoothstep(0.25, 0.65, fn2 + 0.25 * sin(uTime * 1.3 + wdepth * 3.0));
  float crest = smoothstep(0.35, 0.75, wn.w) * smoothstep(5.0, 11.0, wind) * fetchFactor(P.x) * fn2;
  float foam = clamp(max(shore * 0.9, crest * 0.8), 0.0, 1.0) * (1.0 - smoothstep(400.0, 1500.0, dist));
  vec3 foamCol = vec3(0.75) * ((uSunColor * max(dot(N, uSunDir), 0.0) * shSun + uMoonColor * max(dot(N, uMoonDir), 0.0) * shMoon) / PI + envDiffuse(vec3(0.0, 1.0, 0.0)));
  col = mix(col, foamCol, foam);
  alpha = mix(alpha, 1.0, foam);

  col += lampLight(P, N) / PI * 0.05 * alpha;
  // aerial perspective on the premultiplied colour
  vec3 Tf = fogTransmittance(uCamPosF, P);
  vec3 vd = -V;
  vec3 sky = skyRadiance(vec3(vd.x, max(abs(vd.y), 0.015), vd.z));
  col = col * Tf + sky * (1.0 - Tf) * alpha;
#ifdef LDR_OUTPUT
  fragColor = vec4(finalOutput(col / max(alpha, 1e-3)).rgb * alpha, alpha);
#else
  fragColor = vec4(min(col, vec3(60000.0)), alpha);
#endif
}
`;

export class Water {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly waves = new WaveSet();
  private readonly attrs: Record<'ring' | 'center' | 'column' | 'row', THREE.InstancedBufferAttribute>;
  readonly reflection: THREE.WebGLRenderTarget | null;
  readonly reflCam = new THREE.PerspectiveCamera();
  readonly uniforms = {
    uClipCenter: { value: new THREE.Vector2() },
    uClipM: { value: 0 },
    uWaves: { value: Array.from({ length: WAVE_COUNT }, () => new THREE.Vector4()) },
    uWaveQ: { value: new Array<number>(WAVE_COUNT).fill(0) },
    uWaveTime: { value: 0 },
    uReflTex: { value: null as THREE.Texture | null },
    uReflViewProj: { value: new THREE.Matrix4() },
    uHasPlanar: { value: 0 },
  };

  constructor(
    readonly cfg: ClipmapConfig,
    ldr: boolean,
    readonly reflScale: number,
    terrain: { uniforms: Record<string, THREE.IUniform>; defines: Record<string, string | number> },
  ) {
    this.uniforms.uClipM.value = cfg.M;
    const atlasU = {
      uHeightAtlas: terrain.uniforms.uHeightAtlas,
      uLevelOrigin: terrain.uniforms.uLevelOrigin,
      uS0: terrain.uniforms.uS0,
    };
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + GLOBALS_GLSL + worldGlsl() + WATER_GLSL + VERT,
      fragmentShader:
        ATMOSPHERE_GLSL + SKYVIEW_SAMPLE_GLSL + GLOBALS_GLSL + worldGlsl() + NOISE_GLSL + terrainGlsl() + WATER_GLSL + CLOUD_COMMON_GLSL + OUTPUT_GLSL + FLOOR_GLSL + FRAG,
      uniforms: { ...globals, ...this.uniforms, ...atlasU },
      defines: { ...(ldr ? { LDR_OUTPUT: '' } : {}), ...terrain.defines },
      transparent: true,
      depthWrite: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const make = (piece: PieceGeometry, count: number) => {
      const g = new THREE.InstancedBufferGeometry();
      const pos = new Float32Array((piece.local.length / 2) * 3);
      for (let v = 0; v < piece.local.length / 2; v++) {
        pos[3 * v] = piece.local[2 * v];
        pos[3 * v + 2] = piece.local[2 * v + 1];
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(piece.index, 1));
      const inst = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
      inst.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aInst', inst);
      g.instanceCount = count;
      const m = new THREE.Mesh(g, this.material);
      m.frustumCulled = false;
      m.renderOrder = 500;
      this.group.add(m);
      return inst;
    };
    const L = cfg.levels;
    this.attrs = {
      center: make(centerPiece(cfg.M), 1),
      ring: make(ringPiece(cfg.M), L),
      column: make(trimColumnPiece(cfg.M), L - 1),
      row: make(trimRowPiece(cfg.M), L - 1),
    };
    this.reflection =
      reflScale > 0
        ? new THREE.WebGLRenderTarget(1, 1, {
            type: ldr ? THREE.UnsignedByteType : THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: true,
          })
        : null;
    this.uniforms.uReflTex.value = this.reflection?.texture ?? null;
    this.uniforms.uHasPlanar.value = this.reflection ? 1 : 0;
    this.reflCam.layers.set(LAYER_REFLECT);
    this.setWind(4, 2);
  }

  setWind(x: number, z: number): void {
    const speed = Math.hypot(x, z);
    const dx = speed > 0.01 ? x / speed : 1;
    const dz = speed > 0.01 ? z / speed : 0;
    this.waves.set(dx, dz, speed);
    for (let i = 0; i < WAVE_COUNT; i++) {
      const o = i * 4;
      this.uniforms.uWaves.value[i].set(this.waves.waves[o], this.waves.waves[o + 1], this.waves.waves[o + 2], this.waves.waves[o + 3]);
      this.uniforms.uWaveQ.value[i] = this.waves.q[i];
    }
  }

  setSize(w: number, h: number): void {
    this.reflection?.setSize(Math.max(1, Math.round(w * this.reflScale)), Math.max(1, Math.round(h * this.reflScale)));
  }

  update(x: number, z: number, time: number): void {
    const inst = clipInstances(this.cfg, x, z);
    this.uniforms.uClipCenter.value.set(Math.fround(x), Math.fround(z));
    this.uniforms.uWaveTime.value = time;
    const put = (a: THREE.InstancedBufferAttribute, v: number[]) => {
      (a.array as Float32Array).set(v);
      a.needsUpdate = true;
    };
    put(this.attrs.ring, inst.ring);
    put(this.attrs.center, inst.center);
    put(this.attrs.column, inst.column);
    put(this.attrs.row, inst.row);
  }

  /** Mirror camera across the sea plane. */
  updateReflectionCamera(cam: THREE.PerspectiveCamera): void {
    const rc = this.reflCam;
    rc.fov = cam.fov;
    rc.aspect = cam.aspect;
    rc.near = cam.near;
    rc.far = cam.far;
    rc.updateProjectionMatrix();
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    rc.position.set(cam.position.x, -cam.position.y, cam.position.z);
    rc.up.set(up.x, -up.y, up.z);
    rc.lookAt(rc.position.x + fwd.x, rc.position.y - fwd.y, rc.position.z + fwd.z);
    rc.updateMatrixWorld();
    this.uniforms.uReflViewProj.value.multiplyMatrices(rc.projectionMatrix, rc.matrixWorldInverse);
  }
}
