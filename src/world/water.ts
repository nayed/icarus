// Sea surface: a sum of Gerstner waves driven by the wind and by the fetch (open sea in the west,
// sheltered fjords inland). The same functions run in the water vertex shader (WATER_GLSL).
import { smoothstep } from './noise.ts';

export const WAVE_COUNT = 6;
const G = 9.81;
const BASE_LAMBDA = [41, 27, 17.5, 11.3, 7.4, 4.9];
const SPREAD = [0, 0.55, -0.4, 0.9, -0.75, 0.25];

/** Packed per wave: dirX, dirZ, wavelength, amplitude. Plus steepness array. */
export class WaveSet {
  readonly waves = new Float32Array(WAVE_COUNT * 4);
  readonly q = new Float32Array(WAVE_COUNT);
  windSpeed = 6;

  /** windDir: direction the wind blows towards (x, z), speed m/s. */
  set(dirX: number, dirZ: number, speed: number): void {
    this.windSpeed = speed;
    const base = Math.atan2(dirZ, dirX);
    const sea = Math.min(1.6, Math.pow(Math.max(speed, 0.5) / 8, 1.3));
    for (let i = 0; i < WAVE_COUNT; i++) {
      const a = base + SPREAD[i];
      const lambda = BASE_LAMBDA[i];
      const amp = lambda * 0.0105 * sea * (i === 0 ? 1.25 : 1);
      const k = (2 * Math.PI) / lambda;
      this.waves.set([Math.fround(Math.cos(a)), Math.fround(Math.sin(a)), lambda, Math.fround(amp)], i * 4);
      this.q[i] = Math.fround(Math.min(1, 0.55 / (k * Math.max(amp, 1e-4) * WAVE_COUNT)));
    }
  }
}

/** How exposed the water is to the open sea (1) vs sheltered in the fjords (~0.25). */
export function fetchFactor(x: number): number {
  return 1 - 0.75 * smoothstep(-9000, 7000, x);
}

/** Gerstner displacement of the undisplaced point (x, z) at time t, with level spacing s (waves < 4s fade). */
export function waveDisplacement(ws: WaveSet, x: number, z: number, t: number, s: number, out: Float64Array): void {
  let dx = 0;
  let dy = 0;
  let dz = 0;
  const f = fetchFactor(x);
  for (let i = 0; i < WAVE_COUNT; i++) {
    const o = i * 4;
    const lambda = ws.waves[o + 2];
    const lod = smoothstep(4 * s, 8 * s, lambda);
    if (lod <= 0) continue;
    const k = (2 * Math.PI) / lambda;
    const w = Math.sqrt(G * k);
    const A = ws.waves[o + 3] * f * lod;
    const th = k * (ws.waves[o] * x + ws.waves[o + 1] * z) - w * t + i * 1.7;
    const c = Math.cos(th);
    dx += ws.q[i] * A * ws.waves[o] * c;
    dz += ws.q[i] * A * ws.waves[o + 1] * c;
    dy += A * Math.sin(th);
  }
  out[0] = dx;
  out[1] = dy;
  out[2] = dz;
}

const d3 = new Float64Array(3);
/**
 * Water surface height at world (x, z): inverts the horizontal Gerstner displacement by fixed-point
 * iteration so the result is the height of the displaced surface above this exact point.
 */
export function waterHeight(ws: WaveSet, x: number, z: number, t: number, s = 1): number {
  let px = x;
  let pz = z;
  for (let it = 0; it < 4; it++) {
    waveDisplacement(ws, px, pz, t, s, d3);
    px = x - d3[0];
    pz = z - d3[2];
  }
  waveDisplacement(ws, px, pz, t, s, d3);
  return d3[1];
}

export const WATER_GLSL = /* glsl */ `
#define WAVE_COUNT ${WAVE_COUNT}
uniform vec4 uWaves[WAVE_COUNT];
uniform float uWaveQ[WAVE_COUNT];
uniform float uWaveTime;
float fetchFactor(float x) { return 1.0 - 0.75 * smoothstep(-9000.0, 7000.0, x); }
vec3 waveDisplacement(vec2 p, float s) {
  vec3 d = vec3(0.0);
  float f = fetchFactor(p.x);
  for (int i = 0; i < WAVE_COUNT; i++) {
    vec4 w = uWaves[i];
    float lod = smoothstep(4.0 * s, 8.0 * s, w.z);
    if (lod <= 0.0) continue;
    float k = 6.28318530718 / w.z;
    float om = sqrt(9.81 * k);
    float A = w.w * f * lod;
    float th = k * (w.x * p.x + w.y * p.y) - om * uWaveTime + float(i) * 1.7;
    float c = cos(th);
    d.x += uWaveQ[i] * A * w.x * c;
    d.z += uWaveQ[i] * A * w.y * c;
    d.y += A * sin(th);
  }
  return d;
}
// Surface normal of the displaced surface (GPU Gems ch.1), and the Jacobian-ish crest factor in w.
vec4 waveNormal(vec2 p, float s) {
  vec3 n = vec3(0.0, 1.0, 0.0);
  float crest = 0.0;
  float f = fetchFactor(p.x);
  for (int i = 0; i < WAVE_COUNT; i++) {
    vec4 w = uWaves[i];
    float lod = smoothstep(2.0 * s, 4.0 * s, w.z);
    if (lod <= 0.0) continue;
    float k = 6.28318530718 / w.z;
    float om = sqrt(9.81 * k);
    float A = w.w * f * lod;
    float th = k * (w.x * p.x + w.y * p.y) - om * uWaveTime + float(i) * 1.7;
    float WA = k * A;
    float S = sin(th);
    float C = cos(th);
    n.x -= w.x * WA * C;
    n.z -= w.y * WA * C;
    n.y -= uWaveQ[i] * WA * S;
    crest += uWaveQ[i] * WA * S;
  }
  return vec4(normalize(n), crest);
}
`;
