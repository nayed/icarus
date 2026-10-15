// Geometry clipmap layout shared by the terrain and the sea.
//
// Level L has spacing s = s0 * 2^L and covers M x M cells around an origin snapped to 2s.
// Vertices always sit on the level's global lattice. Near the outer edge of each level the
// vertex *height* morphs to the coarser level's interpolated surface (same triangle diagonals),
// so neighbouring levels meet exactly: no cracks, no popping, no seams to stitch.
//
// drawnHeight() reproduces the vertex shader + rasterised triangles on the CPU so collision
// uses exactly the surface that is drawn.
import { TERRAIN_OCTAVES, TERRAIN_MIN_OCTAVES } from './params.ts';
import { terrainHeight } from './terrain.ts';

export interface ClipmapConfig {
  /** cells per level side, multiple of 8 */
  M: number;
  levels: number;
  /** base spacing in metres (power of two) */
  s0: number;
}

/** Morph band width in cells. */
export function morphWidth(M: number): number {
  return M / 8;
}

/** Detail octaves used by vertices of a level with spacing s. */
export function octavesForSpacing(s: number): number {
  const o = TERRAIN_OCTAVES - Math.round(Math.log2(s));
  return Math.max(TERRAIN_MIN_OCTAVES, Math.min(TERRAIN_OCTAVES, o));
}

export function levelSpacing(cfg: ClipmapConfig, L: number): number {
  return cfg.s0 * 2 ** L;
}

/** Snapped origin of level L (multiple of 2s). */
export function levelOrigin(c: number, s: number): number {
  return Math.floor(c / (2 * s)) * 2 * s;
}

/** Per-frame clipmap state. `cx/cz` are the f32-rounded centre exactly as the shader sees it. */
export interface ClipState {
  cfg: ClipmapConfig;
  cx: number;
  cz: number;
}

export function makeClipState(cfg: ClipmapConfig, x: number, z: number): ClipState {
  return { cfg, cx: Math.fround(x), cz: Math.fround(z) };
}

export function morphFactor(px: number, pz: number, s: number, st: ClipState): number {
  const M = st.cfg.M;
  const W = morphWidth(M);
  const d = Math.max(Math.abs(px - st.cx), Math.abs(pz - st.cz)) / s;
  const k = (d - (M * 0.5 - 2 - W)) / W;
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

type HeightFn = (x: number, z: number, oct: number) => number;

// Heights of lattice vertices, memoised: contact points query the same few vertices on every
// physics substep. Direct-mapped and keyed on the exact arguments, so results are bit-identical.
const CACHE_BITS = 12;
const cacheX = new Float64Array(1 << CACHE_BITS).fill(NaN);
const cacheZ = new Float64Array(1 << CACHE_BITS);
const cacheO = new Int8Array(1 << CACHE_BITS);
const cacheH = new Float64Array(1 << CACHE_BITS);

export function latticeHeight(x: number, z: number, oct: number): number {
  const k = (Math.imul(Math.round(x * 4) | 0, 0x9e3779b1) ^ Math.imul(Math.round(z * 4) | 0, 0x85ebca6b) ^ Math.imul(oct, 0x27d4eb2d)) >>> (32 - CACHE_BITS);
  if (cacheX[k] === x && cacheZ[k] === z && cacheO[k] === oct) return cacheH[k];
  const h = terrainHeight(x, z, oct);
  cacheX[k] = x;
  cacheZ[k] = z;
  cacheO[k] = oct;
  cacheH[k] = h;
  return h;
}

/** Height of the lattice vertex at (px, pz) of a level with spacing s, after morphing. */
export function vertexHeight(px: number, pz: number, s: number, st: ClipState, H: HeightFn = latticeHeight): number {
  const hf = H(px, pz, octavesForSpacing(s));
  const k = morphFactor(px, pz, s, st);
  if (k <= 0) return hf;
  const oc = octavesForSpacing(2 * s);
  const ix = Math.round(px / s);
  const iz = Math.round(pz / s);
  const ox = ix & 1;
  const oz = iz & 1;
  let hc: number;
  if (ox === 0 && oz === 0) hc = H(px, pz, oc);
  else if (ox === 1 && oz === 0) hc = 0.5 * (H(px - s, pz, oc) + H(px + s, pz, oc));
  else if (ox === 0 && oz === 1) hc = 0.5 * (H(px, pz - s, oc) + H(px, pz + s, oc));
  else hc = 0.5 * (H(px - s, pz - s, oc) + H(px + s, pz + s, oc));
  return hf * (1 - k) + hc * k;
}

/** Finest level whose footprint contains (x, z). */
export function levelAt(x: number, z: number, st: ClipState): number {
  const { cfg } = st;
  // Level origins use the same centre the CPU fed to the instance offsets.
  for (let L = 0; L < cfg.levels; L++) {
    const s = levelSpacing(cfg, L);
    const ox = levelOrigin(st.cx, s);
    const oz = levelOrigin(st.cz, s);
    const he = (cfg.M / 2) * s;
    if (x >= ox - he && x <= ox + he && z >= oz - he && z <= oz + he) return L;
  }
  return cfg.levels - 1;
}

export interface SurfaceSample {
  h: number;
  /** unit normal of the drawn triangle */
  nx: number;
  ny: number;
  nz: number;
  level: number;
}

/**
 * Height (and triangle normal) of the rendered clipmap surface at (x, z).
 * Each cell (i, j) is split along the diagonal from (i, j) to (i+1, j+1), matching the index buffer.
 */
export function drawnSurface(x: number, z: number, st: ClipState, out: SurfaceSample, H: HeightFn = latticeHeight): SurfaceSample {
  const L = levelAt(x, z, st);
  const s = levelSpacing(st.cfg, L);
  const ix = Math.floor(x / s);
  const iz = Math.floor(z / s);
  const fx = x / s - ix;
  const fz = z / s - iz;
  const x0 = ix * s;
  const z0 = iz * s;
  const h00 = vertexHeight(x0, z0, s, st, H);
  const h11 = vertexHeight(x0 + s, z0 + s, s, st, H);
  let h: number;
  let gx: number;
  let gz: number;
  if (fx >= fz) {
    const h10 = vertexHeight(x0 + s, z0, s, st, H);
    gx = (h10 - h00) / s;
    gz = (h11 - h10) / s;
    h = h00 + fx * (h10 - h00) + fz * (h11 - h10);
  } else {
    const h01 = vertexHeight(x0, z0 + s, s, st, H);
    gz = (h01 - h00) / s;
    gx = (h11 - h01) / s;
    h = h00 + fz * (h01 - h00) + fx * (h11 - h01);
  }
  const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
  out.h = h;
  out.nx = -gx * inv;
  out.ny = inv;
  out.nz = -gz * inv;
  out.level = L;
  return out;
}

const tmp: SurfaceSample = { h: 0, nx: 0, ny: 1, nz: 0, level: 0 };
export function drawnHeight(x: number, z: number, st: ClipState, H: HeightFn = latticeHeight): number {
  return drawnSurface(x, z, st, tmp, H).h;
}

// ---------------------------------------------------------------- geometry

export interface PieceGeometry {
  /** local integer corner coordinates, xy pairs */
  local: Float32Array;
  index: Uint32Array;
}

/**
 * Builds a grid piece from a cell predicate over [i0, i1) x [j0, j1).
 * Cells are split along the (i,j)-(i+1,j+1) diagonal, counter-clockwise seen from above (+y).
 */
function gridPiece(i0: number, i1: number, j0: number, j1: number, keep: (i: number, j: number) => boolean): PieceGeometry {
  const w = i1 - i0 + 1;
  const ids = new Int32Array(w * (j1 - j0 + 1)).fill(-1);
  const local: number[] = [];
  const index: number[] = [];
  const vid = (i: number, j: number): number => {
    const k = (j - j0) * w + (i - i0);
    if (ids[k] < 0) {
      ids[k] = local.length / 2;
      local.push(i, j);
    }
    return ids[k];
  };
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      if (!keep(i, j)) continue;
      const a = vid(i, j);
      const b = vid(i + 1, j);
      const c = vid(i, j + 1);
      const d = vid(i + 1, j + 1);
      // +x right, +z "down" on the map; seen from +y these are counter-clockwise in xz → front faces up.
      index.push(a, d, b, a, c, d);
    }
  }
  return { local: new Float32Array(local), index: new Uint32Array(index) };
}

/** Ring for every level: full M x M minus the union of possible holes [-M/4, M/4+1)^2. Includes edge seams. */
export function ringPiece(M: number): PieceGeometry {
  const q = M / 4;
  const g = gridPiece(-M / 2, M / 2, -M / 2, M / 2, (i, j) => !(i >= -q && i < q + 1 && j >= -q && j < q + 1));
  // Seam triangles along the outer boundary: (A, mid, B) for each pair of boundary edges.
  const local = Array.from(g.local);
  const index = Array.from(g.index);
  const find = new Map<string, number>();
  for (let v = 0; v < local.length / 2; v++) find.set(`${local[2 * v]},${local[2 * v + 1]}`, v);
  const id = (i: number, j: number): number => find.get(`${i},${j}`)!;
  const h = M / 2;
  const seam = (a: number, b: number, c: number) => index.push(a, b, c, a, c, b); // both windings
  for (let k = -h; k < h; k += 2) {
    seam(id(k, -h), id(k + 1, -h), id(k + 2, -h));
    seam(id(k, h), id(k + 1, h), id(k + 2, h));
    seam(id(-h, k), id(-h, k + 1), id(-h, k + 2));
    seam(id(h, k), id(h, k + 1), id(h, k + 2));
  }
  return { local: g.local, index: new Uint32Array(index) };
}

/** Centre block that completes level 0: [-M/4, M/4+1)^2. */
export function centerPiece(M: number): PieceGeometry {
  const q = M / 4;
  return gridPiece(-q, q + 1, -q, q + 1, () => true);
}

/** Trim column: 1 x (M/2 + 1) cells. */
export function trimColumnPiece(M: number): PieceGeometry {
  return gridPiece(0, 1, 0, M / 2 + 1, () => true);
}

/** Trim row: (M/2) x 1 cells. */
export function trimRowPiece(M: number): PieceGeometry {
  return gridPiece(0, M / 2, 0, 1, () => true);
}

export interface Instances {
  ring: number[];
  center: number[];
  column: number[];
  row: number[];
}

/** Per-instance (offsetX, offsetZ, spacing, level) for every piece, for centre (cx, cz). */
export function clipInstances(cfg: ClipmapConfig, cx: number, cz: number): Instances {
  const { M } = cfg;
  const q = M / 4;
  const out: Instances = { ring: [], center: [], column: [], row: [] };
  for (let L = 0; L < cfg.levels; L++) {
    const s = levelSpacing(cfg, L);
    const ox = levelOrigin(cx, s);
    const oz = levelOrigin(cz, s);
    out.ring.push(ox, oz, s, L);
    if (L === 0) {
      out.center.push(ox, oz, s, L);
      continue;
    }
    const sf = s / 2;
    const dx = (levelOrigin(cx, sf) - ox) / s; // 0 or 1
    const dz = (levelOrigin(cz, sf) - oz) / s;
    const colI = dx === 0 ? q : -q;
    const rowJ = dz === 0 ? q : -q;
    out.column.push(ox + colI * s, oz - q * s, s, L);
    out.row.push(ox + (dx - q) * s, oz + rowJ * s, s, L);
  }
  return out;
}

/** GLSL: morphed vertex height, mirroring vertexHeight(). Needs terrainHeight() and uniforms. */
export const CLIPMAP_GLSL = /* glsl */ `
uniform vec2 uClipCenter;
uniform float uClipM;
int octavesForSpacing(float s) {
  return clamp(TERRAIN_OCTAVES - int(round(log2(s))), TERRAIN_MIN_OCTAVES, TERRAIN_OCTAVES);
}
float morphFactor(vec2 p, float s) {
  float W = uClipM / 8.0;
  vec2 d = abs(p - uClipCenter) / s;
  return clamp((max(d.x, d.y) - (uClipM * 0.5 - 2.0 - W)) / W, 0.0, 1.0);
}
float clipVertexHeight(vec2 p, float s) {
  float hf = terrainHeight(p, octavesForSpacing(s));
  float k = morphFactor(p, s);
  if (k <= 0.0) return hf;
  int oc = octavesForSpacing(2.0 * s);
  ivec2 ii = ivec2(round(p / s));
  int ox = ii.x & 1;
  int oz = ii.y & 1;
  float hc;
  if (ox == 0 && oz == 0) hc = terrainHeight(p, oc);
  else if (ox == 1 && oz == 0) hc = 0.5 * (terrainHeight(p - vec2(s, 0.0), oc) + terrainHeight(p + vec2(s, 0.0), oc));
  else if (ox == 0 && oz == 1) hc = 0.5 * (terrainHeight(p - vec2(0.0, s), oc) + terrainHeight(p + vec2(0.0, s), oc));
  else hc = 0.5 * (terrainHeight(p - vec2(s), oc) + terrainHeight(p + vec2(s), oc));
  return hf * (1.0 - k) + hc * k;
}
`;
