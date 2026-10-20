// Terrain height function (CPU). TERRAIN_GLSL mirrors it statement by statement.
// Keep both in sync: scripts/parity.mjs runs the GLSL on the GPU and compares.
import { FJORDS, FJORD_BOX, FJORD_FIRST_SEGMENT, FJORD_LENGTH, FJORD_REACH, FJORD_SEGMENT_BOX, RELIEF_FJORDS, STRIPS, SEED, TERRAIN_OCTAVES, headingDir, type FjordDef } from './params.ts';
import { gnoised, vnoise, fbm3, smoothstep, clamp, mix, M2A, M2B } from './noise.ts';

const n3 = new Float64Array(3);

/** Eroded fbm (derivative-damped gradient noise), about [-1, 1]. */
export function fbmEroded(x: number, y: number, oct: number): number {
  let a = 0;
  let b = 0.5;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < TERRAIN_OCTAVES; i++) {
    if (i >= oct) break;
    gnoised(x, y, SEED, n3);
    dx += n3[1];
    dy += n3[2];
    a += (b * n3[0]) / (1 + dx * dx + dy * dy);
    b *= 0.47;
    const nx = M2A * x - M2B * y;
    const ny = M2B * x + M2A * y;
    x = nx;
    y = ny;
  }
  return a * 2;
}

/** Ridged multifractal on gradient noise, about [0, 1]. */
export function ridged(x: number, y: number, oct: number): number {
  let a = 0;
  let b = 0.5;
  let w = 1;
  for (let i = 0; i < 5; i++) {
    if (i >= oct) break;
    gnoised(x, y, SEED + 7, n3);
    let n = 1 - Math.abs(n3[0]);
    n = n * n;
    a += b * n * w;
    w = clamp(n * 1.8, 0, 1);
    b *= 0.5;
    const nx = M2A * x - M2B * y;
    const ny = M2B * x + M2A * y;
    x = nx;
    y = ny;
  }
  return a * 1.25;
}

/**
 * Distance from p to a polyline of length `total`, and a normalised arc position (0 mouth → 1 head).
 * The arc position is an inverse-distance blend over segments so it stays continuous
 * on the inside of bends (a plain "closest segment" position would jump there).
 */
export function fjordDist(px: number, py: number, fj: FjordDef, total: number, out: Float64Array, o: number): void {
  const pts = fj.points;
  let best = 1e30;
  let wsum = 0;
  let ssum = 0;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0];
    const ay = pts[i][1];
    const bax = pts[i + 1][0] - ax;
    const bay = pts[i + 1][1] - ay;
    const pax = px - ax;
    const pay = py - ay;
    const len2 = bax * bax + bay * bay;
    const t = clamp((pax * bax + pay * bay) / len2, 0, 1);
    const ex = pax - bax * t;
    const ey = pay - bay * t;
    const d = Math.sqrt(ex * ex + ey * ey);
    const segLen = Math.sqrt(len2);
    // Smooth min rounds the inside of bends.
    const hk = Math.max(400 - Math.abs(best - d), 0) / 400;
    best = Math.min(best, d) - hk * hk * 100;
    const dk = d * (1 / 1000) + 0.05;
    const k = 1 / (dk * dk * dk * dk);
    wsum += k;
    ssum += k * (acc + t * segLen);
    acc += segLen;
  }
  out[o] = best;
  out[o + 1] = ssum / wsum / total;
}

function carveFjord(h: number, px: number, py: number, d: number, s: number, fj: FjordDef, wallNoise: number): number {
  let w = mix(fj.widthMouth, fj.widthHead, s);
  const r = fj.rough ?? 0;
  if (r > 0) {
    // rough fjords: the width wanders along the fjord, and the shore breaks into coves and points
    w *= 1 + 0.35 * r * vnoise(px * (1 / 2300), py * (1 / 2300), SEED + 10);
    d += r * w * (0.3 * vnoise(px * (1 / 650), py * (1 / 650), SEED + 11) + 0.14 * vnoise(px * (1 / 240), py * (1 / 240), SEED + 12));
  }
  // Floor rises towards the head and climbs above sea level just past it (river valley), unless the
  // fjord is open at both ends.
  const head = fj.points[fj.points.length - 1];
  const hx = px - head[0];
  const hy = py - head[1];
  const dh = Math.sqrt(hx * hx + hy * hy);
  let floor = mix(fj.floorMouth, fj.floorHead, s);
  floor += (90 - floor) * (1 - smoothstep(0, 2600, dh)) * smoothstep(0.75, 1, s) * (fj.open ? 0 : 1);
  const wall = 480 + 240 * wallNoise;
  const t = clamp((d - 0.55 * w) / (0.45 * w + wall), 0, 1);
  const g = t * t * (3 - 2 * t);
  const u = clamp(d / w, 0, 1);
  const bottom = floor + 70 * u * u;
  return Math.min(h, mix(bottom, h, g));
}

/** Signed distance to an oriented box (local half extents hx, hz). */
export function boxSdf(px: number, py: number, cx: number, cy: number, dx: number, dy: number, hx: number, hz: number): number {
  const rx = px - cx;
  const ry = py - cy;
  const lx = Math.abs(rx * dx + ry * dy) - hx;
  const ly = Math.abs(-rx * dy + ry * dx) - hz;
  const ox = Math.max(lx, 0);
  const oy = Math.max(ly, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(lx, ly), 0);
}

const STRIP_DIRS = STRIPS.map((s) => headingDir(s.heading).map(Math.fround) as [number, number]);
const fd = new Float64Array(2 * FJORDS.length);
/** which fjords may reach the current point (the others are skipped: they change nothing there) */
const fdOn = new Uint8Array(FJORDS.length);

/** True when (x, z) is inside fjord i's box and one of its segment boxes (else beyond its reach). */
function nearFjord(i: number, x: number, z: number): boolean {
  const b = FJORD_BOX[i];
  if (x < b[0] || z < b[1] || x > b[2] || z > b[3]) return false;
  const s0 = FJORD_FIRST_SEGMENT[i];
  for (let k = 0; k < FJORDS[i].points.length - 1; k++) {
    const s = FJORD_SEGMENT_BOX[s0 + k];
    if (x >= s[0] && z >= s[1] && x <= s[2] && z <= s[3]) return true;
  }
  return false;
}

/** Terrain height at world (x, z) using `oct` detail octaves. */
export function terrainHeight(x: number, z: number, oct: number = TERRAIN_OCTAVES, withStrips = true): number {
  // Large-scale warp.
  const wx = fbm3(x * (1 / 14000), z * (1 / 14000), SEED + 1);
  const wz = fbm3(x * (1 / 14000) + 5.2, z * (1 / 14000) + 1.3, SEED + 1);
  const qx = x + 2600 * wx;
  const qz = z + 2600 * wz;

  // Land vs sea field: open sea in the west, an indented coast.
  const land0 =
    (qx + 1500) / 8000 +
    1.3 * fbm3(qx * (1 / 10000) - 3.7, qz * (1 / 10000) + 8.1, SEED + 2) +
    0.8 * fbm3(qx * (1 / 3600) + 1.7, qz * (1 / 3600) - 4.4, SEED + 6);
  // Archipelago: islands and sounds in a band off the coast.
  const isl = vnoise(qx * (1 / 2100), qz * (1 / 2100), SEED + 8);
  const land = land0 + 1.25 * Math.max(isl - 0.05, 0) * smoothstep(-1.8, -0.7, land0) * (1 - smoothstep(-0.1, 0.3, land0));
  const landMask = smoothstep(-0.3, 0.35, land);

  // Fjord distances, measured in a slightly meandering frame.
  const fx = x + 380 * vnoise(x * (1 / 3100), z * (1 / 3100), SEED + 4);
  const fz = z + 380 * vnoise(x * (1 / 3100) + 9.1, z * (1 / 3100) - 2.7, SEED + 4);
  let dmin = 1e30;
  for (let i = 0; i < FJORDS.length; i++) {
    fdOn[i] = i < RELIEF_FJORDS || nearFjord(i, fx, fz) ? 1 : 0;
    if (!fdOn[i]) continue;
    fjordDist(fx, fz, FJORDS[i], FJORD_LENGTH[i], fd, 2 * i);
    if (i < RELIEF_FJORDS) dmin = Math.min(dmin, fd[2 * i]);
  }
  const near = 1 - smoothstep(1200, 7000, dmin);

  // Relief: ridged crests + eroded detail, taller next to the fjords.
  const r = ridged(qx * (1 / 5200), qz * (1 / 5200), Math.min(oct, 5));
  const e = fbmEroded(qx * (1 / 2600), qz * (1 / 2600), oct);
  let relief = 0.6 * r + 0.4 * (0.5 + 0.5 * e);
  relief = relief * relief * 1.25;
  const amp = 820 * smoothstep(-0.1, 0.6, land) * (1 + 0.5 * near);
  const hLand = mix(-30, 140, smoothstep(0, 1.2, land)) + amp * relief;

  // Sea floor with low rocky skerries near the coast.
  const sk = vnoise(qx * (1 / 700), qz * (1 / 700), SEED + 3);
  const skerry = Math.max(sk - 0.55, 0) * 260 * smoothstep(-1.3, -0.4, land);
  const hSea = -90 - 110 * (1 - smoothstep(-1.2, 0, land)) + 40 * e + skerry;

  let h = mix(hSea, hLand, landMask);

  const wallNoise = vnoise(x * (1 / 1700), z * (1 / 1700), SEED + 5);
  // beyond its reach a fjord's carving changes nothing: skip it (and its shore noise)
  for (let i = 0; i < FJORDS.length; i++) if (fdOn[i] && fd[2 * i] <= FJORD_REACH[i]) h = carveFjord(h, fx, fz, fd[2 * i], fd[2 * i + 1], FJORDS[i], wallNoise);

  // Airstrips: flat pads blended into the terrain. Inside the pad the height is exact.
  if (withStrips) {
    for (let i = 0; i < STRIPS.length; i++) {
      const s = STRIPS[i];
      const dir = STRIP_DIRS[i];
      const sd = boxSdf(x, z, s.center[0], s.center[1], dir[0], dir[1], s.halfLength + s.padLong, s.halfWidth + s.padLat);
      const k = 1 - smoothstep(0, s.shoulder, sd);
      h = k >= 1 ? s.elevation : mix(h, s.elevation, k);
    }
  }
  return h;
}

export const TERRAIN_GLSL = /* glsl */ `
float fbmEroded(vec2 p, int oct) {
  float a = 0.0;
  float b = 0.5;
  vec2 d = vec2(0.0);
  for (int i = 0; i < TERRAIN_OCTAVES; i++) {
    if (i >= oct) break;
    vec3 n = gnoised(p, SEED);
    d += n.yz;
    a += (b * n.x) / (1.0 + d.x * d.x + d.y * d.y);
    b *= 0.47;
    p = octRot(p);
  }
  return a * 2.0;
}
float ridged(vec2 p, int oct) {
  float a = 0.0;
  float b = 0.5;
  float w = 1.0;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(gnoised(p, SEED + 7u).x);
    n = n * n;
    a += b * n * w;
    w = clamp(n * 1.8, 0.0, 1.0);
    b *= 0.5;
    p = octRot(p);
  }
  return a * 1.25;
}
MAIN_FJORD_FUNCS
// Mirrors nearFjord(): inside fjord f's box and one of its segment boxes.
bool nearFjord(int f, vec2 p) {
  if (any(lessThan(p, FJ_B[f].xy)) || any(greaterThan(p, FJ_B[f].zw))) return false;
  int s0 = FJ_R[f].x - f;
  for (int k = 0; k < FJ_R[f].y - 1; k++) {
    vec4 b = FJ_SB[s0 + k];
    if (all(greaterThanEqual(p, b.xy)) && all(lessThanEqual(p, b.zw))) return true;
  }
  return false;
}
// Distance to fjord f's polyline and the normalised arc position: mirrors fjordDist().
vec2 fjordDist(int f, vec2 p) {
  int i0 = FJ_R[f].x;
  int n = FJ_R[f].y;
  float best = 1e30;
  float wsum = 0.0;
  float ssum = 0.0;
  float acc = 0.0;
  float total = FJ_X[f].z;
  for (int i = 0; i < n - 1; i++) {
    vec2 a = FJ_P[i0 + i];
    vec2 ba = FJ_P[i0 + i + 1] - a;
    vec2 pa = p - a;
    float len2 = ba.x * ba.x + ba.y * ba.y;
    float t = clamp((pa.x * ba.x + pa.y * ba.y) / len2, 0.0, 1.0);
    vec2 e = pa - ba * t;
    float d = sqrt(e.x * e.x + e.y * e.y);
    float segLen = sqrt(len2);
    float hk = max(400.0 - abs(best - d), 0.0) / 400.0;
    best = min(best, d) - hk * hk * 100.0;
    float dk = d * (1.0 / 1000.0) + 0.05;
    float k = 1.0 / (dk * dk * dk * dk);
    wsum += k;
    ssum += k * (acc + t * segLen);
    acc += segLen;
  }
  return vec2(best, ssum / wsum / total);
}
float carveFjord(float h, vec2 p, vec2 ds, vec4 W, vec4 X, vec2 head, float wallNoise) {
  float w = mix(W.x, W.y, ds.y);
  float d = ds.x;
  float r = X.y;
  if (r > 0.0) {
    w *= 1.0 + 0.35 * r * vnoise(p * (1.0 / 2300.0), SEED + 10u);
    d += r * w * (0.3 * vnoise(p * (1.0 / 650.0), SEED + 11u) + 0.14 * vnoise(p * (1.0 / 240.0), SEED + 12u));
  }
  vec2 hv = p - head;
  float dh = sqrt(hv.x * hv.x + hv.y * hv.y);
  float fl = mix(W.z, W.w, ds.y);
  fl += (90.0 - fl) * (1.0 - smoothstep(0.0, 2600.0, dh)) * smoothstep(0.75, 1.0, ds.y) * (1.0 - X.x);
  float wall = 480.0 + 240.0 * wallNoise;
  float t = clamp((d - 0.55 * w) / (0.45 * w + wall), 0.0, 1.0);
  float g = t * t * (3.0 - 2.0 * t);
  float u = clamp(d / w, 0.0, 1.0);
  float bottom = fl + 70.0 * u * u;
  return min(h, mix(bottom, h, g));
}
float boxSdf(vec2 p, vec2 c, vec2 dir, vec2 he) {
  vec2 r = p - c;
  vec2 l = abs(vec2(r.x * dir.x + r.y * dir.y, -r.x * dir.y + r.y * dir.x)) - he;
  vec2 o = max(l, 0.0);
  return sqrt(o.x * o.x + o.y * o.y) + min(max(l.x, l.y), 0.0);
}
float stripPad(float h, vec2 p, vec4 A, vec4 B) {
  float sd = boxSdf(p, A.xy, A.zw, B.xy);
  float k = 1.0 - smoothstep(0.0, B.w, sd);
  return k >= 1.0 ? B.z : mix(h, B.z, k);
}
float terrainHeight(vec2 p, int oct) {
  float wx = fbm3(p * (1.0 / 14000.0), SEED + 1u);
  float wz = fbm3(p * (1.0 / 14000.0) + vec2(5.2, 1.3), SEED + 1u);
  vec2 q = p + 2600.0 * vec2(wx, wz);
  float land0 = (q.x + 1500.0) / 8000.0
    + 1.3 * fbm3(q * (1.0 / 10000.0) + vec2(-3.7, 8.1), SEED + 2u)
    + 0.8 * fbm3(q * (1.0 / 3600.0) + vec2(1.7, -4.4), SEED + 6u);
  float isl = vnoise(q * (1.0 / 2100.0), SEED + 8u);
  float land = land0 + 1.25 * max(isl - 0.05, 0.0) * smoothstep(-1.8, -0.7, land0) * (1.0 - smoothstep(-0.1, 0.3, land0));
  float landMask = smoothstep(-0.3, 0.35, land);
  vec2 fp = p + 380.0 * vec2(vnoise(p * (1.0 / 3100.0), SEED + 4u), vnoise(p * (1.0 / 3100.0) + vec2(9.1, -2.7), SEED + 4u));
  // the main system everywhere (the mountains rise along it); the other fjords inside their boxes only
MAIN_FJORD_DISTS
  float near = 1.0 - smoothstep(1200.0, 7000.0, dmin);
  float r = ridged(q * (1.0 / 5200.0), min(oct, 5));
  float e = fbmEroded(q * (1.0 / 2600.0), oct);
  float relief = 0.6 * r + 0.4 * (0.5 + 0.5 * e);
  relief = relief * relief * 1.25;
  float amp = 820.0 * smoothstep(-0.1, 0.6, land) * (1.0 + 0.5 * near);
  float hLand = mix(-30.0, 140.0, smoothstep(0.0, 1.2, land)) + amp * relief;
  float sk = vnoise(q * (1.0 / 700.0), SEED + 3u);
  float skerry = max(sk - 0.55, 0.0) * 260.0 * smoothstep(-1.3, -0.4, land);
  float hSea = -90.0 - 110.0 * (1.0 - smoothstep(-1.2, 0.0, land)) + 40.0 * e + skerry;
  float h = mix(hSea, hLand, landMask);
  float wallNoise = vnoise(p * (1.0 / 1700.0), SEED + 5u);
  for (int f = 0; f < FJORD_COUNT; f++) {
    vec2 ds;
    if (f < RELIEF_FJORDS) ds = fdm[f];
    else if (nearFjord(f, fp)) ds = fjordDist(f, fp);
    else continue;
    // beyond its reach a fjord's carving changes nothing
    if (ds.x <= FJ_X[f].w) h = carveFjord(h, fp, ds, FJ_W[f], FJ_X[f], FJ_P[FJ_R[f].x + FJ_R[f].y - 1], wallNoise);
  }
STRIP_CALLS
  return h;
}
`;

/** Full GLSL for terrainHeight(), expecting worldGlsl() + NOISE_GLSL before it. */
export function terrainGlsl(): string {
  const main = Array.from({ length: RELIEF_FJORDS }, (_, i) => i);
  // the main fjords' own distance functions, with constant-size loops that unroll (fjordDist() does
  // the same for any fjord, but its loop length is only known at run time)
  const mainFuncs = main.map((i) => TERRAIN_FJORD_MAIN.replaceAll('_I_', String(i))).join('\n');
  const dists =
    `  vec2 fdm[RELIEF_FJORDS] = vec2[RELIEF_FJORDS](${main.map((i) => `fjordDistMain${i}(fp)`).join(', ')});\n` +
    `  float dmin = ${main.map((i) => `fdm[${i}].x`).reduce((a, b) => `min(${a}, ${b})`)};`;
  const strips = STRIPS.map((_, i) => `  h = stripPad(h, p, STRIP${i}_A, STRIP${i}_B);`).join('\n');
  return TERRAIN_GLSL.replace('MAIN_FJORD_FUNCS', mainFuncs).replace('MAIN_FJORD_DISTS', dists).replace('STRIP_CALLS', strips);
}

const TERRAIN_FJORD_MAIN = /* glsl */ `
vec2 fjordDistMain_I_(vec2 p) {
  float best = 1e30;
  float wsum = 0.0;
  float ssum = 0.0;
  float acc = 0.0;
  float total = FJ_X[_I_].z;
  for (int i = 0; i < FJ_I__N - 1; i++) {
    vec2 a = FJ_I__P[i];
    vec2 ba = FJ_I__P[i + 1] - a;
    vec2 pa = p - a;
    float len2 = ba.x * ba.x + ba.y * ba.y;
    float t = clamp((pa.x * ba.x + pa.y * ba.y) / len2, 0.0, 1.0);
    vec2 e = pa - ba * t;
    float d = sqrt(e.x * e.x + e.y * e.y);
    float segLen = sqrt(len2);
    float hk = max(400.0 - abs(best - d), 0.0) / 400.0;
    best = min(best, d) - hk * hk * 100.0;
    float dk = d * (1.0 / 1000.0) + 0.05;
    float k = 1.0 / (dk * dk * dk * dk);
    wsum += k;
    ssum += k * (acc + t * segLen);
    acc += segLen;
  }
  return vec2(best, ssum / wsum / total);
}
`;
