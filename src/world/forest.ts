// Forest placement on the CPU. Mirrors the forest/birch masks of the terrain shader
// (same noise, same thresholds) so instanced trees stand where the ground is painted as forest.
import { terrainHeight, boxSdf } from './terrain.ts';
import { vnoise, smoothstep, hashU } from './noise.ts';
import { STRIPS, STRIP_CLEARING, headingDir } from './params.ts';

export interface TreeTile {
  key: string;
  /** per tree: x, y, z, height */
  a: Float32Array;
  /** per tree: species (0 pine, 1 birch), rotation, tint, phase */
  b: Float32Array;
  count: number;
}

const TREE_OCT = 7;

const STRIP_DIRS = STRIPS.map((s) => headingDir(s.heading));

/** 0 on and around the airstrips (no trees there), 1 elsewhere. Mirrored by stripClearingGlsl(). */
export function stripClearing(x: number, z: number): number {
  let c = 1;
  STRIPS.forEach((s, i) => {
    const d = STRIP_DIRS[i];
    const sd = boxSdf(x, z, s.center[0], s.center[1], d[0], d[1], s.halfLength + STRIP_CLEARING.ends, s.halfWidth + STRIP_CLEARING.sides);
    c = Math.min(c, smoothstep(0, STRIP_CLEARING.fade, sd));
  });
  return c;
}

/** GLSL stripClearing(p), expecting worldGlsl() before it (the STRIPn_A and STRIPn_CLEAR constants). */
export function stripClearingGlsl(): string {
  const each = STRIPS.map((_, i) => `  c = min(c, smoothstep(0.0, ${STRIP_CLEARING.fade.toFixed(1)}, clearingSdf(p, STRIP${i}_A, STRIP${i}_CLEAR)));`).join('\n');
  return /* glsl */ `
float clearingSdf(vec2 p, vec4 A, vec2 he) {
  vec2 r = p - A.xy;
  vec2 l = abs(vec2(r.x * A.z + r.y * A.w, -r.x * A.w + r.y * A.z)) - he;
  vec2 o = max(l, 0.0);
  return sqrt(o.x * o.x + o.y * o.y) + min(max(l.x, l.y), 0.0);
}
float stripClearing(vec2 p) {
  float c = 1.0;
${each}
  return c;
}
`;
}

/** Forest density and birch fraction at a point (h = terrain height). */
export function forestAt(x: number, z: number, h: number, slope: number): { forest: number; birch: number } {
  const nL = vnoise(x / 520, z / 520, 501);
  const nM = vnoise(x / 110, z / 110, 502);
  const nS = vnoise(x / 19, z / 19, 503);
  const treeLine = 430 + 110 * nL;
  const forest =
    (1 - smoothstep(treeLine - 80, treeLine + 30, h)) *
    (1 - smoothstep(0.2, 0.36, slope)) *
    smoothstep(3, 10, h) *
    smoothstep(-0.55, 0.05, nM + 0.45 * nS) *
    stripClearing(x, z);
  const birch = smoothstep(-0.5, 0.4, nL + 0.7 * nM);
  return { forest, birch };
}

function rnd(i: number, j: number, k: number): number {
  return hashU((Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1)) | 0) / 4294967296;
}

/**
 * Generates the trees of one square tile (origin tx*size, tz*size): the candidates of the global
 * `cell` lattice whose cell starts inside the tile, so neighbouring tiles share no tree and miss none.
 */
export function makeTreeTile(tx: number, tz: number, size: number, cell: number): TreeTile {
  const i0 = Math.floor((tx * size) / cell), i1 = Math.floor(((tx + 1) * size) / cell);
  const j0 = Math.floor((tz * size) / cell), j1 = Math.floor(((tz + 1) * size) / cell);
  const cap = (i1 - i0) * (j1 - j0) * 4;
  const a = new Float32Array(cap);
  const b = new Float32Array(cap);
  let count = 0;
  for (let gj = j0; gj < j1; gj++) {
    for (let gi = i0; gi < i1; gi++) {
      const r0 = rnd(gi, gj, 1);
      const x = (gi + 0.15 + 0.7 * rnd(gi, gj, 2)) * cell;
      const z = (gj + 0.15 + 0.7 * rnd(gi, gj, 3)) * cell;
      // quick reject far above any treeline or in the sea
      const h = terrainHeight(x, z, TREE_OCT);
      if (h < 3 || h > 600) continue;
      // the density only falls with slope: when flat ground already rejects this tree, skip the
      // four slope probes (same decisions, a fraction of the terrain evaluations)
      if (r0 > forestAt(x, z, h, 0).forest * 0.9) continue;
      const e = 4;
      const hx = terrainHeight(x + e, z, TREE_OCT) - terrainHeight(x - e, z, TREE_OCT);
      const hz = terrainHeight(x, z + e, TREE_OCT) - terrainHeight(x, z - e, TREE_OCT);
      const ny = (2 * e) / Math.sqrt(hx * hx + hz * hz + 4 * e * e);
      const { forest, birch } = forestAt(x, z, h, 1 - ny);
      if (r0 > forest * 0.9) continue;
      const isBirch = rnd(gi, gj, 4) < birch ? 1 : 0;
      const height = isBirch ? 7 + 6 * rnd(gi, gj, 5) : 9 + 9 * rnd(gi, gj, 5);
      const o = count * 4;
      a[o] = x;
      a[o + 1] = h - 0.6;
      a[o + 2] = z;
      a[o + 3] = height;
      b[o] = isBirch;
      b[o + 1] = rnd(gi, gj, 6) * Math.PI * 2;
      b[o + 2] = rnd(gi, gj, 7);
      b[o + 3] = rnd(gi, gj, 8) * 6.283;
      count++;
    }
  }
  return { key: `${tx},${tz}`, a: a.slice(0, count * 4), b: b.slice(0, count * 4), count };
}
