import { describe, it, expect } from 'vitest';
import {
  type ClipmapConfig, makeClipState, clipInstances, ringPiece, centerPiece, trimColumnPiece, trimRowPiece,
  drawnHeight, vertexHeight, levelSpacing, levelOrigin,
} from '../src/world/clipmap.ts';
import { terrainHeight } from '../src/world/terrain.ts';
import { STRIPS } from '../src/world/params.ts';

const cfg: ClipmapConfig = { M: 64, levels: 6, s0: 1 };

describe('clipmap layout', () => {
  it('pieces tile every level exactly once (no gaps, no overlaps)', () => {
    for (const [cx, cz] of [[0.3, 0.7], [13.9, -7.2], [-1000.5, 333.3], [5.0, 5.0], [-0.01, -0.01]]) {
      const inst = clipInstances(cfg, cx, cz);
      const cover = new Map<string, number>();
      const add = (piece: ReturnType<typeof ringPiece>, list: number[]) => {
        for (let k = 0; k < list.length; k += 4) {
          const [ox, oz, s] = [list[k], list[k + 1], list[k + 2]];
          for (let t = 0; t < piece.index.length; t += 6) {
            // each cell = 2 triangles; use the first vertex of the first triangle as the cell corner
            const a = piece.index[t];
            const i = piece.local[2 * a], j = piece.local[2 * a + 1];
            // only count real cells (seam triangles come after all cells in ring pieces)
            const key = `${s}:${ox + i * s},${oz + j * s}`;
            cover.set(key, (cover.get(key) ?? 0) + 1);
          }
        }
      };
      const cells = (p: ReturnType<typeof ringPiece>, n: number) => ({ local: p.local, index: p.index.slice(0, n * 6) });
      const M = cfg.M, q = M / 4;
      const ringCells = M * M - (2 * q + 1) * (2 * q + 1);
      add(cells(ringPiece(M), ringCells), inst.ring);
      add(centerPiece(M), inst.center);
      add(trimColumnPiece(M), inst.column);
      add(trimRowPiece(M), inst.row);
      // Every cell of every level footprint (minus the finer level's footprint) is covered exactly once.
      for (let L = 0; L < cfg.levels; L++) {
        const s = levelSpacing(cfg, L);
        const ox = levelOrigin(cx, s), oz = levelOrigin(cz, s);
        const fs = s / 2, fox = levelOrigin(cx, fs), foz = levelOrigin(cz, fs), fhe = (M / 2) * fs;
        for (let i = -M / 2; i < M / 2; i++) for (let j = -M / 2; j < M / 2; j++) {
          const x = ox + i * s, z = oz + j * s;
          const inFiner = L > 0 && x >= fox - fhe && x + s <= fox + fhe && z >= foz - fhe && z + s <= foz + fhe;
          expect(cover.get(`${s}:${x},${z}`) ?? 0, `L${L} cell ${x},${z}`).toBe(inFiner ? 0 : 1);
        }
      }
    }
  });
});

describe('drawn surface', () => {
  const H = (x: number, z: number, oct: number) => terrainHeight(x, z, oct);
  it('is continuous across level boundaries', () => {
    const st = makeClipState(cfg, 2000.3, -1500.6);
    // walk outward along a line crossing several level boundaries; steps of 5 cm
    let prev = drawnHeight(2000.3, -1500.6, st, H);
    let maxJump = 0;
    for (let d = 0.05; d < 1500; d += 0.05) {
      const h = drawnHeight(2000.3 + d, -1500.6 + d * 0.37, st, H);
      maxJump = Math.max(maxJump, Math.abs(h - prev));
      prev = h;
    }
    // slope-limited: terrain here is < ~3 m per 5 cm horizontally even on cliffs
    expect(maxJump).toBeLessThan(3);
  });
  it('fine level at its boundary equals the coarse level surface', () => {
    const st = makeClipState(cfg, 123.4, 567.8);
    for (let L = 0; L < cfg.levels - 1; L++) {
      const s = levelSpacing(cfg, L);
      const ox = levelOrigin(st.cx, s), oz = levelOrigin(st.cz, s), he = (cfg.M / 2) * s;
      // vertices on the outer boundary of level L (x = ox + he), odd ones must match coarse interpolation
      for (let j = -cfg.M / 2; j <= cfg.M / 2; j++) {
        const x = ox + he, z = oz + j * s;
        const fine = vertexHeight(x, z, s, st, H);
        const S = 2 * s;
        const zc0 = Math.floor(z / S) * S;
        const t = (z - zc0) / S;
        const coarse = (1 - t) * vertexHeight(x, zc0, S, st, H) + t * vertexHeight(x, zc0 + S, S, st, H);
        expect(Math.abs(fine - coarse)).toBeLessThan(1e-6);
      }
    }
  });
  it('runways are perfectly flat', () => {
    for (const s of STRIPS) {
      const st = makeClipState(cfg, s.center[0] + 37.1, s.center[1] - 12.9);
      for (let k = 0; k < 200; k++) {
        const a = (k / 199 - 0.5) * 2 * s.halfLength * 0.98;
        const r = (s.heading * Math.PI) / 180;
        const x = s.center[0] + Math.sin(r) * a, z = s.center[1] - Math.cos(r) * a;
        expect(Math.abs(drawnHeight(x, z, st) - s.elevation)).toBeLessThan(1e-9);
      }
    }
  });
});
