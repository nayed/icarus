import { describe, it, expect } from 'vitest';
import { WaveSet, waveDisplacement, waterHeight, fetchFactor } from '../src/world/water.ts';

describe('water surface (CPU mirror of the wave shader)', () => {
  const ws = new WaveSet();
  ws.set(0.8, 0.6, 9);
  it('inverts the horizontal Gerstner displacement', () => {
    const d = new Float64Array(3);
    for (let k = 0; k < 200; k++) {
      const x = -8000 + k * 37.3, z = 1200 + k * 11.9, t = k * 0.37;
      // find the lattice point that lands on (x, z) the same way waterHeight does
      let px = x, pz = z;
      for (let it = 0; it < 4; it++) { waveDisplacement(ws, px, pz, t, 1, d); px = x - d[0]; pz = z - d[2]; }
      waveDisplacement(ws, px, pz, t, 1, d);
      expect(Math.hypot(px + d[0] - x, pz + d[2] - z)).toBeLessThan(2e-3);
      expect(waterHeight(ws, x, z, t)).toBeCloseTo(d[1], 9);
    }
  });
  it('is calmer in the fjords than on the open sea', () => {
    expect(fetchFactor(-12000)).toBeGreaterThan(0.95);
    expect(fetchFactor(10000)).toBeLessThan(0.3);
    let open = 0, fjord = 0;
    for (let k = 0; k < 400; k++) {
      open = Math.max(open, Math.abs(waterHeight(ws, -12000 + k * 3.1, 500, k * 0.21)));
      fjord = Math.max(fjord, Math.abs(waterHeight(ws, 10000 + k * 3.1, 500, k * 0.21)));
    }
    expect(open).toBeGreaterThan(fjord * 2.5);
    expect(open).toBeLessThan(2.5);
  });
});
