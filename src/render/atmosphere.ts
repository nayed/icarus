// Physically based sky (after Hillaire 2020): transmittance LUT + multiple-scattering LUT
// (computed once) and a sky-view LUT re-rendered every frame for the sun and the moon.
// All radiance written to the sky-view LUT is pre-exposed.
import * as THREE from 'three';
import { FullscreenPass, passMaterial } from './fullscreen.ts';

export const ATMOSPHERE_GLSL = /* glsl */ `
const float ATM_RG = 6360.0;
const float ATM_RT = 6460.0;
const vec3 RAY_SCAT = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const float RAY_H = 8.0;
const float MIE_SCAT = 3.996e-3;
const float MIE_EXT = 4.40e-3;
const float MIE_H = 1.2;
const vec3 OZONE_ABS = vec3(0.650e-3, 1.881e-3, 0.085e-3);
const vec3 GROUND_ALBEDO = vec3(0.25);
const float PI = 3.14159265359;

vec3 atmScattering(float h, out vec3 rayS, out float mieS) {
  float rd = exp(-h / RAY_H);
  float md = exp(-h / MIE_H);
  float od = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  rayS = RAY_SCAT * rd;
  mieS = MIE_SCAT * md;
  return RAY_SCAT * rd + vec3(MIE_EXT * md) + OZONE_ABS * od;
}
// distance to sphere of radius R from ro (|ro| = r) along rd; -1 if no hit
float raySphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  float t0 = -b - s;
  float t1 = -b + s;
  if (t0 > 0.0) return t0;
  if (t1 > 0.0) return t1;
  return -1.0;
}
float rayleighPhase(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float miePhase(float c, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
vec2 transmittanceUv(float r, float mu) {
  float H = sqrt(ATM_RT * ATM_RT - ATM_RG * ATM_RG);
  float rho = sqrt(max(0.0, r * r - ATM_RG * ATM_RG));
  float disc = r * r * (mu * mu - 1.0) + ATM_RT * ATM_RT;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dmin = ATM_RT - r;
  float dmax = rho + H;
  return vec2((d - dmin) / (dmax - dmin), rho / H);
}
vec3 transmittanceToTop(sampler2D lut, float r, float mu) {
  return texture(lut, transmittanceUv(r, mu)).rgb;
}
// Transmittance towards a light, zero when the planet is in the way (soft over the light's disc).
vec3 lightTransmittance(sampler2D lut, vec3 pos, vec3 L) {
  float r = length(pos);
  float mu = dot(pos, L) / r;
  float muHorizon = -sqrt(max(0.0, 1.0 - (ATM_RG * ATM_RG) / (r * r)));
  float vis = smoothstep(muHorizon - 0.004, muHorizon + 0.004, mu);
  return transmittanceToTop(lut, r, mu) * vis;
}
vec2 msUv(float r, float muS) {
  return vec2(clamp(0.5 + 0.5 * muS, 0.0, 1.0), clamp((r - ATM_RG) / (ATM_RT - ATM_RG), 0.0, 1.0));
}
`;

const TRANSMITTANCE_FRAG = /* glsl */ `
${ATMOSPHERE_GLSL}
in vec2 vUv;
out vec4 fragColor;
void main() {
  float H = sqrt(ATM_RT * ATM_RT - ATM_RG * ATM_RG);
  float rho = H * vUv.y;
  float r = sqrt(rho * rho + ATM_RG * ATM_RG);
  float dmin = ATM_RT - r;
  float dmax = rho + H;
  float d = dmin + vUv.x * (dmax - dmin);
  float mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  float tmax = raySphere(ro, rd, ATM_RT);
  vec3 tau = vec3(0.0);
  const int N = 48;
  float dt = tmax / float(N);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (float(i) + 0.5) * dt;
    vec3 rs; float ms;
    tau += atmScattering(length(p) - ATM_RG, rs, ms) * dt;
  }
  fragColor = vec4(exp(-tau), 1.0);
}
`;

const MULTISCAT_FRAG = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D uTransmittance;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float muS = vUv.x * 2.0 - 1.0;
  float r = ATM_RG + vUv.y * (ATM_RT - ATM_RG) + 0.01;
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 L = vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  vec3 lum = vec3(0.0);
  vec3 fms = vec3(0.0);
  const int SQ = 8;
  const int STEPS = 20;
  for (int a = 0; a < SQ; a++) {
    for (int b = 0; b < SQ; b++) {
      float th = PI * (float(a) + 0.5) / float(SQ);
      float ph = acos(1.0 - 2.0 * (float(b) + 0.5) / float(SQ));
      vec3 rd = vec3(cos(th) * sin(ph), cos(ph), sin(th) * sin(ph));
      float tg = raySphere(ro, rd, ATM_RG);
      float tt = raySphere(ro, rd, ATM_RT);
      float tmax = tg > 0.0 ? tg : tt;
      float dt = tmax / float(STEPS);
      vec3 T = vec3(1.0);
      vec3 L2 = vec3(0.0);
      vec3 F = vec3(0.0);
      for (int i = 0; i < STEPS; i++) {
        vec3 p = ro + rd * (float(i) + 0.5) * dt;
        vec3 rs; float ms;
        vec3 ext = atmScattering(length(p) - ATM_RG, rs, ms);
        vec3 sampT = exp(-ext * dt);
        vec3 scat = rs + ms;
        vec3 sunT = lightTransmittance(uTransmittance, p, L);
        vec3 S = sunT * scat / (4.0 * PI);
        vec3 Sint = (S - S * sampT) / max(ext, vec3(1e-7));
        L2 += T * Sint;
        vec3 Fint = (scat - scat * sampT) / max(ext, vec3(1e-7));
        F += T * Fint;
        T *= sampT;
      }
      if (tg > 0.0) {
        vec3 hp = ro + rd * tg;
        vec3 n = normalize(hp);
        L2 += T * lightTransmittance(uTransmittance, hp, L) * max(dot(n, L), 0.0) * GROUND_ALBEDO / PI;
      }
      lum += L2 / float(SQ * SQ);
      fms += F / float(SQ * SQ);
    }
  }
  fragColor = vec4(lum / (1.0 - fms), 1.0);
}
`;

export const SKYVIEW_SAMPLE_GLSL = /* glsl */ `
vec2 skyViewUv(vec3 d) {
  float az = atan(d.x, -d.z);
  float u = az / (2.0 * PI) + 0.5;
  float l = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(l) * sqrt(abs(l) / (0.5 * PI));
  return vec2(u, v);
}
`;

const SKYVIEW_FRAG = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScat;
uniform float uCamAltKm;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunIllum;   // pre-exposed illuminance
uniform vec3 uMoonIllum;
in vec2 vUv;
out vec4 fragColor;
vec3 lightIn(vec3 p, vec3 L, vec3 illum, float cosT, vec3 rs, float ms) {
  vec3 T = lightTransmittance(uTransmittance, p, L);
  vec3 single = T * (rs * rayleighPhase(cosT) + ms * miePhase(cosT, 0.8));
  float r = length(p);
  vec3 psi = texture(uMultiScat, msUv(r, dot(p, L) / r)).rgb;
  return illum * (single + psi * (rs + ms));
}
void main() {
  float az = (vUv.x - 0.5) * 2.0 * PI;
  float vv = vUv.y * 2.0 - 1.0;
  float l = sign(vv) * vv * vv * 0.5 * PI;
  vec3 rd = vec3(sin(az) * cos(l), sin(l), -cos(az) * cos(l));
  float r = ATM_RG + max(uCamAltKm, 0.005);
  vec3 ro = vec3(0.0, r, 0.0);
  float tg = raySphere(ro, rd, ATM_RG);
  float tt = raySphere(ro, rd, ATM_RT);
  float tmax = tg > 0.0 ? tg : tt;
  tmax = min(tmax, 2000.0);
  const int N = 32;
  vec3 T = vec3(1.0);
  vec3 lum = vec3(0.0);
  float cs = dot(rd, uSunDir);
  float cm = dot(rd, uMoonDir);
  float tPrev = 0.0;
  for (int i = 0; i < N; i++) {
    float f = (float(i) + 0.3) / float(N);
    float t = tmax * f * f;
    float dt = t - tPrev;
    tPrev = t;
    vec3 p = ro + rd * t;
    vec3 rs; float ms;
    vec3 ext = atmScattering(length(p) - ATM_RG, rs, ms);
    vec3 sampT = exp(-ext * dt);
    vec3 S = lightIn(p, uSunDir, uSunIllum, cs, rs, ms) + lightIn(p, uMoonDir, uMoonIllum, cm, rs, ms);
    lum += T * (S - S * sampT) / max(ext, vec3(1e-7));
    T *= sampT;
  }
  fragColor = vec4(lum, 1.0);
}
`;

export class Atmosphere {
  readonly transmittance: THREE.WebGLRenderTarget;
  readonly multiScat: THREE.WebGLRenderTarget;
  readonly skyView: THREE.WebGLRenderTarget;
  private readonly skyPass: FullscreenPass;
  readonly uniforms = {
    uTransmittance: { value: null as THREE.Texture | null },
    uMultiScat: { value: null as THREE.Texture | null },
    uCamAltKm: { value: 0.1 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uSunIllum: { value: new THREE.Vector3(1, 1, 1) },
    uMoonIllum: { value: new THREE.Vector3(0, 0, 0) },
  };
  private initialised = false;

  constructor(type: THREE.TextureDataType) {
    const opts = (w: number, h: number, wrapS: THREE.Wrapping = THREE.ClampToEdgeWrapping) =>
      new THREE.WebGLRenderTarget(w, h, {
        type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        generateMipmaps: false,
      });
    this.transmittance = opts(256, 64);
    this.multiScat = opts(32, 32);
    this.skyView = opts(192, 108, THREE.RepeatWrapping);
    this.uniforms.uTransmittance.value = this.transmittance.texture;
    this.uniforms.uMultiScat.value = this.multiScat.texture;
    this.skyPass = new FullscreenPass(passMaterial(SKYVIEW_FRAG, this.uniforms));
  }

  init(renderer: THREE.WebGLRenderer): void {
    if (this.initialised) return;
    const t = new FullscreenPass(passMaterial(TRANSMITTANCE_FRAG, {}));
    t.render(renderer, this.transmittance);
    const m = new FullscreenPass(passMaterial(MULTISCAT_FRAG, { uTransmittance: this.uniforms.uTransmittance }));
    m.render(renderer, this.multiScat);
    t.material.dispose();
    m.material.dispose();
    this.initialised = true;
  }

  update(renderer: THREE.WebGLRenderer): void {
    this.skyPass.render(renderer, this.skyView);
  }
}

// ---------------------------------------------------------------- CPU mirror for light colours

const RG = 6360;
const RT = 6460;
const RAY = [5.802e-3, 13.558e-3, 33.1e-3];
const OZ = [0.65e-3, 1.881e-3, 0.085e-3];

/** Transmittance from altitude hKm towards a direction with elevation sine `mu` (0 if blocked). */
export function transmittanceCPU(hKm: number, mu: number, out: THREE.Vector3): THREE.Vector3 {
  const r = RG + Math.max(hKm, 0.001);
  const muH = -Math.sqrt(Math.max(0, 1 - (RG * RG) / (r * r)));
  const vis = THREE.MathUtils.smoothstep(mu, muH - 0.004, muH + 0.004);
  if (vis <= 0) return out.set(0, 0, 0);
  const sx = Math.sqrt(Math.max(0, 1 - mu * mu));
  // distance to top of atmosphere
  const b = r * mu;
  const tmax = -b + Math.sqrt(b * b - (r * r - RT * RT));
  const N = 64;
  const dt = tmax / N;
  const tau = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * dt;
    const px = sx * t;
    const py = r + mu * t;
    const h = Math.hypot(px, py) - RG;
    const rd = Math.exp(-h / 8);
    const md = Math.exp(-h / 1.2);
    const od = Math.max(0, 1 - Math.abs(h - 25) / 15);
    for (let c = 0; c < 3; c++) tau[c] += (RAY[c] * rd + 4.4e-3 * md + OZ[c] * od) * dt;
  }
  return out.set(Math.exp(-tau[0]) * vis, Math.exp(-tau[1]) * vis, Math.exp(-tau[2]) * vis);
}
