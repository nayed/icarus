// CPU noise. Mirrored line-for-line by NOISE_GLSL below; both must stay in sync.
// The lattice hash is pure 32-bit integer math so CPU and GPU agree bit-for-bit;
// only the float interpolation differs (f64 vs f32), at the sub-millimetre level.

export function hashU(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b | 0);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash of an integer lattice point to [0, 1) with 24 bits (exact in f32). */
export function hash2(ix: number, iy: number, seed: number): number {
  const h = hashU((Math.imul(ix, 0x9e3779b1 | 0) + hashU((iy + seed) | 0)) | 0);
  return (h >>> 8) / 16777216;
}

/** Value noise in [-1, 1] with analytic derivatives. Writes [value, dx, dy] to out. */
export function noised(x: number, y: number, seed: number, out: Float64Array): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  const k1 = b - a;
  const k2 = c - a;
  const k4 = a - b - c + d;
  out[0] = -1 + 2 * (a + k1 * ux + k2 * uy + k4 * ux * uy);
  out[1] = 2 * dux * (k1 + k4 * uy);
  out[2] = 2 * duy * (k2 + k4 * ux);
}

/** Value noise in [-1, 1], no derivatives. */
export function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return -1 + 2 * (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy);
}

const GRAD_X = [1, -1, 0, 0, 1, -1, 1, -1];
const GRAD_Y = [0, 0, 1, -1, 1, 1, -1, -1];

function hash2u(ix: number, iy: number, seed: number): number {
  return hashU((Math.imul(ix, 0x9e3779b1 | 0) + hashU((iy + seed) | 0)) | 0);
}

/** Gradient noise (about [-1, 1]) with analytic derivatives. Writes [value, dx, dy] to out. */
export function gnoised(x: number, y: number, seed: number, out: Float64Array): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const ha = hash2u(ix, iy, seed) & 7;
  const hb = hash2u(ix + 1, iy, seed) & 7;
  const hc = hash2u(ix, iy + 1, seed) & 7;
  const hd = hash2u(ix + 1, iy + 1, seed) & 7;
  const gax = GRAD_X[ha], gay = GRAD_Y[ha];
  const gbx = GRAD_X[hb], gby = GRAD_Y[hb];
  const gcx = GRAD_X[hc], gcy = GRAD_Y[hc];
  const gdx = GRAD_X[hd], gdy = GRAD_Y[hd];
  const va = gax * fx + gay * fy;
  const vb = gbx * (fx - 1) + gby * fy;
  const vc = gcx * fx + gcy * (fy - 1);
  const vd = gdx * (fx - 1) + gdy * (fy - 1);
  const k4 = va - vb - vc + vd;
  out[0] = va + ux * (vb - va) + uy * (vc - va) + ux * uy * k4;
  out[1] = gax + ux * (gbx - gax) + uy * (gcx - gax) + ux * uy * (gax - gbx - gcx + gdx) + dux * (uy * k4 + vb - va);
  out[2] = gay + ux * (gby - gay) + uy * (gcy - gay) + ux * uy * (gay - gby - gcy + gdy) + duy * (ux * k4 + vc - va);
}

// Octave rotation+scale: exact dyadic entries (13/8, 9/8) → |scale| ≈ 1.976, angle ≈ 34.7°.
export const M2A = 1.625;
export const M2B = 1.125;

/** 3-octave value-noise fbm in about [-1, 1]. */
export function fbm3(x: number, y: number, seed: number): number {
  let a = 0;
  let b = 0.5;
  for (let i = 0; i < 3; i++) {
    a += b * vnoise(x, y, seed);
    b *= 0.5;
    const nx = M2A * x - M2B * y;
    const ny = M2B * x + M2A * y;
    x = nx;
    y = ny;
  }
  return a * (1 / 0.875);
}

export function smoothstep(e0: number, e1: number, x: number): number {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}

export const NOISE_GLSL = /* glsl */ `
uint hashU(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float hash2(ivec2 p, uint seed) {
  uint h = hashU(uint(p.x) * 0x9e3779b1u + hashU(uint(p.y) + seed));
  return float(h >> 8u) * (1.0 / 16777216.0);
}
vec3 noised(vec2 x, uint seed) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  ivec2 ii = ivec2(i);
  float a = hash2(ii, seed);
  float b = hash2(ii + ivec2(1, 0), seed);
  float c = hash2(ii + ivec2(0, 1), seed);
  float d = hash2(ii + ivec2(1, 1), seed);
  float k1 = b - a;
  float k2 = c - a;
  float k4 = a - b - c + d;
  return vec3(-1.0 + 2.0 * (a + k1 * u.x + k2 * u.y + k4 * u.x * u.y),
              2.0 * du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
float vnoise(vec2 x, uint seed) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec2 ii = ivec2(i);
  float a = hash2(ii, seed);
  float b = hash2(ii + ivec2(1, 0), seed);
  float c = hash2(ii + ivec2(0, 1), seed);
  float d = hash2(ii + ivec2(1, 1), seed);
  return -1.0 + 2.0 * (a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y);
}
const vec2 GRAD[8] = vec2[8](vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
                             vec2(1.0, 1.0), vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(-1.0, -1.0));
uint hash2u(ivec2 p, uint seed) {
  return hashU(uint(p.x) * 0x9e3779b1u + hashU(uint(p.y) + seed));
}
vec3 gnoised(vec2 x, uint seed) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  ivec2 ii = ivec2(i);
  vec2 ga = GRAD[int(hash2u(ii, seed) & 7u)];
  vec2 gb = GRAD[int(hash2u(ii + ivec2(1, 0), seed) & 7u)];
  vec2 gc = GRAD[int(hash2u(ii + ivec2(0, 1), seed) & 7u)];
  vec2 gd = GRAD[int(hash2u(ii + ivec2(1, 1), seed) & 7u)];
  float va = ga.x * f.x + ga.y * f.y;
  float vb = gb.x * (f.x - 1.0) + gb.y * f.y;
  float vc = gc.x * f.x + gc.y * (f.y - 1.0);
  float vd = gd.x * (f.x - 1.0) + gd.y * (f.y - 1.0);
  float k4 = va - vb - vc + vd;
  return vec3(va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k4,
              ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * k4 + vec2(vb, vc) - va));
}
const float M2A = 1.625;
const float M2B = 1.125;
vec2 octRot(vec2 p) { return vec2(M2A * p.x - M2B * p.y, M2B * p.x + M2A * p.y); }
float fbm3(vec2 p, uint seed) {
  float a = 0.0;
  float b = 0.5;
  for (int i = 0; i < 3; i++) {
    a += b * vnoise(p, seed);
    b *= 0.5;
    p = octRot(p);
  }
  return a * (1.0 / 0.875);
}
`;
