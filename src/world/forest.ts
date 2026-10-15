// Forest placement on the CPU. Mirrors the forest/birch masks of the terrain shader
// (same noise, same thresholds) so instanced trees stand where the ground is painted as forest.
import { terrainHeight } from './terrain.ts';
import { vnoise, smoothstep, hashU } from './noise.ts';

export interface TreeTile {
  key: string;
  /** packed per tree: x, y, z, height | species(0 pine,1 birch), rotation, tint, phase */
  data: Float32Array;
  count: number;
}

const TREE_OCT = 7;

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
    smoothstep(-0.55, 0.05, nM + 0.45 * nS);
  const birch = smoothstep(-0.5, 0.4, nL + 0.7 * nM);
  return { forest, birch };
}

function rnd(i: number, j: number, k: number): number {
  return hashU((Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1)) | 0) / 4294967296;
}

/** Generates the trees of one square tile (origin tx*size, tz*size). */
export function makeTreeTile(tx: number, tz: number, size: number, cell: number): TreeTile {
  const n = Math.floor(size / cell);
  const out = new Float32Array(n * n * 8);
  let count = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gi = tx * n + i;
      const gj = tz * n + j;
      const r0 = rnd(gi, gj, 1);
      const x = (gi + 0.15 + 0.7 * rnd(gi, gj, 2)) * cell;
      const z = (gj + 0.15 + 0.7 * rnd(gi, gj, 3)) * cell;
      // quick reject far above any treeline or in the sea
      const h = terrainHeight(x, z, TREE_OCT);
      if (h < 3 || h > 600) continue;
      const e = 4;
      const hx = terrainHeight(x + e, z, TREE_OCT) - terrainHeight(x - e, z, TREE_OCT);
      const hz = terrainHeight(x, z + e, TREE_OCT) - terrainHeight(x, z - e, TREE_OCT);
      const ny = (2 * e) / Math.sqrt(hx * hx + hz * hz + 4 * e * e);
      const { forest, birch } = forestAt(x, z, h, 1 - ny);
      if (r0 > forest * 0.9) continue;
      const isBirch = rnd(gi, gj, 4) < birch ? 1 : 0;
      const height = isBirch ? 7 + 6 * rnd(gi, gj, 5) : 9 + 9 * rnd(gi, gj, 5);
      const o = count * 8;
      out[o] = x;
      out[o + 1] = h - 0.6;
      out[o + 2] = z;
      out[o + 3] = height;
      out[o + 4] = isBirch;
      out[o + 5] = rnd(gi, gj, 6) * Math.PI * 2;
      out[o + 6] = rnd(gi, gj, 7);
      out[o + 7] = rnd(gi, gj, 8) * 6.283;
      count++;
    }
  }
  return { key: `${tx},${tz}`, data: out.slice(0, count * 8), count };
}
