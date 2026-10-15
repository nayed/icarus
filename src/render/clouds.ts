// Volumetric cloud layer: low-resolution raymarch through a 3D noise texture (generated here,
// on the CPU) shaped by a 2D weather map, then a depth-aware upsample over the HDR scene.
import * as THREE from 'three';
import { FullscreenPass, passMaterial } from './fullscreen.ts';
import { ATMOSPHERE_GLSL, SKYVIEW_SAMPLE_GLSL } from './atmosphere.ts';
import { GLOBALS_GLSL, globals } from './globals.ts';
import { NOISE_GLSL } from '../world/noise.ts';

export const CLOUD_BASE = 1550;
export const CLOUD_TOP = 2650;

/** Weather map shared with terrain/water (cloud shadows). Needs NOISE_GLSL + GLOBALS_GLSL. */
export const CLOUD_COMMON_GLSL = /* glsl */ `
const float CLOUD_BASE = ${CLOUD_BASE.toFixed(1)};
const float CLOUD_TOP = ${CLOUD_TOP.toFixed(1)};
float cloudWeather(vec2 xz) {
  vec2 p = (xz + uCloudOffset) * (1.0 / 7000.0);
  float n = 0.55 * vnoise(p, 801u) + 0.3 * vnoise(p * 2.3 + 1.7, 802u) + 0.15 * vnoise(p * 5.1 - 3.1, 803u);
  n = n * 0.5 + 0.5;
  return smoothstep(1.0 - uCloudCover - 0.12, 1.0 - uCloudCover + 0.32, n);
}
/** Approximate shadow of the cloud layer on a point below it (1 = no cloud). */
float cloudShadowAt(vec3 P, vec3 L) {
  if (L.y < 0.03 || uCloudCover <= 0.0) return 1.0;
  float mid = 0.5 * (CLOUD_BASE + CLOUD_TOP);
  vec3 Q = P + L * ((mid - P.y) / L.y);
  float w = cloudWeather(Q.xz);
  return 1.0 - 0.82 * smoothstep(0.15, 0.75, w);
}
`;

const DEPTH_GLSL = /* glsl */ `
uniform vec2 uProjZ;
uniform float uFar;
float linearDepth(float d) {
#if defined(USE_REVERSED_DEPTH_BUFFER)
  return d <= 0.0 ? 1e9 : uProjZ.y / (d + uProjZ.x);
#elif defined(USE_LOGARITHMIC_DEPTH_BUFFER)
  return d >= 1.0 ? 1e9 : exp2(d * log2(uFar + 1.0)) - 1.0;
#else
  return d >= 1.0 ? 1e9 : uProjZ.y / (d * 2.0 - 1.0 + uProjZ.x);
#endif
}
`;

const DEPTH_DOWN_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D uDepth;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float z = linearDepth(texture(uDepth, vUv).r);
  fragColor = vec4(z, z, 0.0, 1.0);
}
`;

const MARCH_FRAG = /* glsl */ `
${ATMOSPHERE_GLSL}
${SKYVIEW_SAMPLE_GLSL}
${NOISE_GLSL}
${GLOBALS_GLSL}
${CLOUD_COMMON_GLSL}
precision highp sampler3D;
uniform sampler3D uNoise;
uniform sampler2D uDepthLow;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamFwd;
uniform vec3 uSunCloud;
uniform vec3 uMoonCloud;
uniform float uFrame;
in vec2 vUv;
out vec4 fragColor;

float hgPhase(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float density(vec3 p, float cov, bool detail) {
  float hf = (p.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
  if (hf <= 0.0 || hf >= 1.0 || cov <= 0.0) return 0.0;
  vec3 drift = vec3(uCloudOffset.x, 0.0, uCloudOffset.y);
  vec3 uvw = (p + drift) * (1.0 / 4200.0);
  float shape = texture(uNoise, uvw).r;
  float top = mix(0.45, 1.0, cov);
  float profile = smoothstep(0.0, 0.1, hf) * (1.0 - smoothstep(top * 0.6, top, hf));
  float d = (shape * profile - (1.0 - cov)) / max(cov, 0.05);
  if (d <= 0.0) return 0.0;
  if (detail) {
    float det = texture(uNoise, uvw * 4.7 + vec3(0.0, uTime * 0.002, 0.0)).g;
    d -= det * 0.42 * (1.0 - d);
  }
  return max(d, 0.0);
}
void main() {
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 ro = uCamPosF;
  float sceneDist = texture(uDepthLow, vUv).r / max(dot(rd, uCamFwd), 1e-3);
  // slab intersection
  float tb = (CLOUD_BASE - ro.y) / rd.y;
  float tt = (CLOUD_TOP - ro.y) / rd.y;
  float t0 = rd.y == 0.0 ? 0.0 : max(min(tb, tt), 0.0);
  float t1 = rd.y == 0.0 ? 60000.0 : max(tb, tt);
  if (ro.y > CLOUD_BASE && ro.y < CLOUD_TOP) { t0 = 0.0; t1 = rd.y > 0.0 ? tt : (rd.y < 0.0 ? tb : 60000.0); }
  t1 = min(min(t1, sceneDist), 60000.0);
  if (t1 <= t0 || uCloudCover <= 0.0) { fragColor = vec4(0.0, 0.0, 0.0, 0.0); return; }

  float len = t1 - t0;
  float dt = max(len / float(STEPS), 40.0);
  float jitter = fract(float(hashU(uint(gl_FragCoord.x) * 7919u + uint(gl_FragCoord.y) * 104729u) >> 8u) / 16777216.0 + uFrame * 0.618034);
  float t = t0 + dt * jitter;
  vec3 T = vec3(1.0);
  vec3 L = vec3(0.0);
  float wsum = 0.0;
  float dsum = 0.0;
  float cs = dot(rd, uSunDir);
  float cm = dot(rd, uMoonDir);
  float phS = mix(hgPhase(cs, 0.65), hgPhase(cs, -0.2), 0.3);
  float phM = mix(hgPhase(cm, 0.65), hgPhase(cm, -0.2), 0.3);
  vec3 ambTop = envDiffuse(vec3(0.0, 1.0, 0.0));
  vec3 ambBot = envDiffuse(vec3(0.0, -1.0, 0.0)) * 0.6 + ambTop * 0.15;
  const float SIGMA = 0.045;
  for (int i = 0; i < STEPS; i++) {
    if (t > t1 || T.g < 0.01) break;
    vec3 p = ro + rd * t;
    float cov = cloudWeather(p.xz);
    float d = density(p, cov, true);
    if (d > 0.0) {
      // light march towards the key light
      vec3 Ld = uSunDir.y > -0.05 ? uSunDir : uMoonDir;
      float od = 0.0;
      float ls = 60.0;
      vec3 lp = p;
      for (int k = 0; k < 5; k++) {
        lp += Ld * ls;
        od += density(lp, cloudWeather(lp.xz), false) * ls;
        ls *= 1.9;
      }
      float beer = max(exp(-SIGMA * od), 0.28 * exp(-0.22 * SIGMA * od));
      float powder = 1.0 - exp(-2.0 * SIGMA * d * 60.0);
      float hf = (p.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
      vec3 amb = mix(ambBot, ambTop, hf) * (0.55 + 0.45 * hf);
      bool sunKey = uSunDir.y > -0.05;
      vec3 direct = (sunKey ? uSunCloud * phS : uMoonCloud * phM) * beer * mix(0.6, 1.0, powder) * 8.0;
      vec3 S = (direct + amb) ;
      float sig = SIGMA * d;
      float st = exp(-sig * dt);
      vec3 Sint = S * (1.0 - st);
      L += T * Sint;
      float w = T.g * (1.0 - st);
      wsum += w;
      dsum += w * t;
      T *= st;
    }
    t += dt;
  }
  float alpha = 1.0 - T.g;
  if (alpha <= 0.001) { fragColor = vec4(0.0); return; }
  // aerial perspective between camera and the cloud
  float dist = dsum / max(wsum, 1e-5);
  vec3 P = ro + rd * dist;
  vec3 Tf = fogTransmittance(ro, P);
  vec3 sky = skyRadiance(vec3(rd.x, max(rd.y, 0.015), rd.z));
  vec3 col = L * Tf + sky * (1.0 - Tf) * alpha;
  fragColor = vec4(col, alpha);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform sampler2D uClouds;
uniform sampler2D uDepthLow;
uniform vec2 uLowSize;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  float z = linearDepth(texture(uDepth, vUv).r);
  // depth-aware upsample: weight the 4 nearest low-res texels by depth similarity
  vec2 st = vUv * uLowSize - 0.5;
  vec2 f = fract(st);
  vec2 b = (floor(st) + 0.5) / uLowSize;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 uv = b + vec2(float(i), float(j)) / uLowSize;
    float zl = texture(uDepthLow, uv).r;
    float bil = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    float rel = abs(z - zl) / max(min(z, zl), 1.0);
    float w = bil / (1e-3 + rel * 40.0) + 1e-6;
    acc += texture(uClouds, uv) * w;
    wsum += w;
  }
  vec4 c = acc / wsum;
  fragColor = vec4(scene * (1.0 - c.a) + c.rgb, 1.0);
}
`;


const TEMPORAL_FRAG = /* glsl */ `
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uDepthLow;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uPrevViewProj;
uniform vec3 uCamFwd;
uniform vec3 uCamPosF;
uniform vec2 uLowSize;
uniform float uHistoryValid;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 cur = texture(uCurrent, vUv);
  vec4 mn = cur;
  vec4 mx = cur;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    vec4 c = texture(uCurrent, vUv + vec2(float(i), float(j)) / uLowSize);
    mn = min(mn, c);
    mx = max(mx, c);
  }
  // reproject a point at the cloud layer (or the scene depth if closer)
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  float sceneDist = texture(uDepthLow, vUv).r / max(dot(rd, uCamFwd), 1e-3);
  float mid = 0.5 * (${CLOUD_BASE.toFixed(1)} + ${CLOUD_TOP.toFixed(1)});
  float tl = abs(rd.y) > 1e-3 ? (mid - uCamPosF.y) / rd.y : 1e5;
  if (tl <= 0.0) tl = 4000.0;
  float dist = min(tl, sceneDist);
  vec4 pc = uPrevViewProj * vec4(uCamPosF + rd * dist, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  bool inside = pc.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)));
  if (uHistoryValid < 0.5 || !inside) { fragColor = cur; return; }
  vec4 hist = texture(uHistory, puv);
  vec4 ext = (mx - mn) * 0.15;
  hist = clamp(hist, mn - ext, mx + ext);
  fragColor = mix(hist, cur, 0.12);
}
`;

/** Tileable 3D noise: R = Perlin-Worley shape, G = Worley detail. */
export function generateCloudNoise(N = 64): THREE.Data3DTexture {
  const data = new Uint8Array(N * N * N * 4);
  const hash = (x: number, y: number, z: number, s: number) => {
    let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ Math.imul(s, 0x165667b1)) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d) >>> 0;
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39) >>> 0;
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  };
  const mod = (a: number, p: number) => ((a % p) + p) % p;
  const valueNoise = (x: number, y: number, z: number, P: number, s: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
    let v = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
      v += w * hash(mod(ix + dx, P), mod(iy + dy, P), mod(iz + dz, P), s);
    }
    return v;
  };
  const worley = (x: number, y: number, z: number, P: number, s: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let best = 9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const cx = ix + a, cy = iy + b, cz = iz + c;
      const wx = mod(cx, P), wy = mod(cy, P), wz = mod(cz, P);
      const px = cx + hash(wx, wy, wz, s), py = cy + hash(wx, wy, wz, s + 1), pz = cz + hash(wx, wy, wz, s + 2);
      const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
      if (d < best) best = d;
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
  let o = 0;
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = i / N, v = j / N, w = k / N;
    // perlin-ish fbm
    let pf = 0, amp = 0.5, tot = 0;
    for (let oct = 0, P = 4; oct < 4; oct++, P *= 2) {
      pf += amp * valueNoise(u * P, v * P, w * P, P, 11 + oct);
      tot += amp;
      amp *= 0.5;
    }
    pf /= tot;
    const wf = 0.625 * worley(u * 4, v * 4, w * 4, 4, 21) + 0.25 * worley(u * 8, v * 8, w * 8, 8, 31) + 0.125 * worley(u * 16, v * 16, w * 16, 16, 41);
    // Perlin-Worley: remap perlin by worley
    const pw = Math.max(0, Math.min(1, (pf - (wf - 1) * 0.6 - 0.35) / (1 - 0.35)));
    const det = 0.625 * worley(u * 6, v * 6, w * 6, 6, 51) + 0.25 * worley(u * 12, v * 12, w * 12, 12, 61) + 0.125 * worley(u * 24, v * 24, w * 24, 24, 71);
    data[o++] = Math.round(pw * 255);
    data[o++] = Math.round(Math.max(0, Math.min(1, det)) * 255);
    data[o++] = 0;
    data[o++] = 255;
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

export class Clouds {
  readonly depthLow: THREE.WebGLRenderTarget;
  readonly target: THREE.WebGLRenderTarget;
  readonly output: THREE.WebGLRenderTarget;
  private history: THREE.WebGLRenderTarget[];
  private readonly temporalPass: FullscreenPass;
  private readonly prevViewProj = new THREE.Matrix4();
  private historyValid = false;
  private readonly depthPass: FullscreenPass;
  private readonly marchPass: FullscreenPass;
  private readonly compPass: FullscreenPass;
  readonly uniforms = {
    uNoise: { value: null as THREE.Data3DTexture | null },
    uDepth: { value: null as THREE.Texture | null },
    uScene: { value: null as THREE.Texture | null },
    uDepthLow: { value: null as THREE.Texture | null },
    uClouds: { value: null as THREE.Texture | null },
    uSrcTexel: { value: new THREE.Vector2() },
    uDiv: { value: 2 },
    uLowSize: { value: new THREE.Vector2() },
    uProjZ: { value: new THREE.Vector2() },
    uFar: { value: 1 },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uCamFwd: { value: new THREE.Vector3() },
    uSunCloud: { value: new THREE.Vector3() },
    uMoonCloud: { value: new THREE.Vector3() },
    uFrame: { value: 0 },
    uCurrent: { value: null as THREE.Texture | null },
    uHistory: { value: null as THREE.Texture | null },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uHistoryValid: { value: 0 },
  };

  constructor(type: THREE.TextureDataType, readonly div: number, steps: number) {
    const rt = (depthFloat = false) =>
      new THREE.WebGLRenderTarget(1, 1, {
        type: depthFloat ? THREE.FloatType : type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
    this.depthLow = rt(true);
    this.depthLow.texture.minFilter = this.depthLow.texture.magFilter = THREE.NearestFilter;
    this.target = rt();
    this.target.texture.minFilter = this.target.texture.magFilter = THREE.NearestFilter;
    this.output = rt();
    this.history = [rt(), rt()];
    this.uniforms.uNoise.value = generateCloudNoise(64);
    this.uniforms.uDepthLow.value = this.depthLow.texture;
    this.uniforms.uClouds.value = this.target.texture;
    this.uniforms.uDiv.value = div;
    const u = { ...globals, ...this.uniforms };
    this.depthPass = new FullscreenPass(passMaterial(DEPTH_DOWN_FRAG, u));
    this.marchPass = new FullscreenPass(passMaterial(MARCH_FRAG, u, { STEPS: steps }));
    this.compPass = new FullscreenPass(passMaterial(COMPOSITE_FRAG, u));
    this.temporalPass = new FullscreenPass(passMaterial(TEMPORAL_FRAG, u));
    this.uniforms.uCurrent.value = this.target.texture;
  }

  setSize(w: number, h: number): void {
    const lw = Math.max(1, Math.ceil(w / this.div));
    const lh = Math.max(1, Math.ceil(h / this.div));
    this.depthLow.setSize(lw, lh);
    this.target.setSize(lw, lh);
    for (const h of this.history) h.setSize(lw, lh);
    this.historyValid = false;
    this.output.setSize(w, h);
    this.uniforms.uLowSize.value.set(lw, lh);
    this.uniforms.uSrcTexel.value.set(1 / w, 1 / h);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.WebGLRenderTarget, camera: THREE.PerspectiveCamera, frame: number): void {
    const u = this.uniforms;
    u.uScene.value = scene.texture;
    u.uDepth.value = scene.depthTexture;
    const pe = camera.projectionMatrix.elements;
    u.uProjZ.value.set(pe[10], pe[14]);
    u.uFar.value = camera.far;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    camera.getWorldDirection(u.uCamFwd.value);
    u.uFrame.value = frame % 64;
    this.depthPass.render(renderer, this.depthLow);
    this.marchPass.render(renderer, this.target);
    // temporal accumulation (history ping-pong)
    const [prev, next] = this.history;
    u.uHistory.value = prev.texture;
    u.uPrevViewProj.value.copy(this.prevViewProj);
    u.uHistoryValid.value = this.historyValid ? 1 : 0;
    this.temporalPass.render(renderer, next);
    this.history = [next, prev];
    this.historyValid = true;
    this.prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uClouds.value = next.texture;
    this.compPass.render(renderer, this.output);
  }
}
