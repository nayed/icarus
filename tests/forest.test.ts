import { describe, expect, it } from 'vitest';
import { makeTreeTile } from '../src/world/forest.ts';

describe('forest tiles', () => {
  it('keep their trees inside the tile and tile the plane without gaps or duplicates', () => {
    const size = 128;
    for (const cell of [9, 12, 16]) {
      // a 3x3 block of tiles near the coastal strip (forested shore)
      const all = new Set<string>();
      let total = 0;
      for (let tz = 47; tz <= 49; tz++) {
        for (let tx = 3; tx <= 5; tx++) {
          const t = makeTreeTile(tx, tz, size, cell);
          for (let q = 0; q < t.count; q++) {
            const x = t.a[q * 4], z = t.a[q * 4 + 2];
            // jitter keeps each tree inside its own cell, and cells start inside the tile
            expect(x).toBeGreaterThanOrEqual(tx * size - cell);
            expect(x).toBeLessThan((tx + 1) * size + cell);
            expect(z).toBeGreaterThanOrEqual(tz * size - cell);
            expect(z).toBeLessThan((tz + 1) * size + cell);
            all.add(`${x.toFixed(2)},${z.toFixed(2)}`);
          }
          total += t.count;
        }
      }
      expect(total).toBeGreaterThan(50);
      expect(all.size).toBe(total);
    }
  });
});
