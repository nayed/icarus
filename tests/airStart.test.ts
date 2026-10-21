import { describe, expect, it } from 'vitest';
import { AIR_APART, AIR_HOME, MAX_AIR_Y, airTrack, pickAirStart } from '../src/world/airStart.ts';
import { START_BOX, headingDir, type Vec2 } from '../src/world/params.ts';
import { terrainHeight } from '../src/world/terrain.ts';
import { cruise } from '../src/sim/scenarios.ts';
import type { FlightModel } from '../src/sim/aircraft.ts';
import { seeded } from './random.ts';

/** A random wind up to the slider's 15 m/s: where it blows from, and the air's velocity (WorldEnv.baseWind). */
function randomWind(rand: () => number): { from: number; speed: number; v: { x: number; z: number } } {
  const from = Math.floor(rand() * 360);
  const speed = rand() * 15;
  const [x, z] = headingDir(from + 180);
  return { from, speed, v: { x: x * speed, z: z * speed } };
}

/**
 * Least height of a start above the ground (or water) along its way over the ground and around it,
 * at full detail and twice as densely as the picker samples.
 */
function clearance(s: { x: number; y: number; z: number }, way: Vec2): number {
  const [dx, dz] = way;
  const g = (x: number, z: number) => Math.max(terrainHeight(x, z), 0);
  let least = Infinity;
  for (let a = 0; a <= 4000; a += 25) for (let b = -300; b <= 300; b += 37.5) least = Math.min(least, s.y - g(s.x + dx * a - dz * b, s.z + dz * a + dx * b));
  for (let r = 25; r <= 400; r += 25) for (let k = 0; k < 64; k++) least = Math.min(least, s.y - g(s.x + Math.cos((k * Math.PI) / 32) * r, s.z + Math.sin((k * Math.PI) / 32) * r));
  return least;
}

describe('air starts', () => {
  it('clear the ground on the way ahead and around, below the clouds, well away from the last', () => {
    const rand = seeded(5);
    let last: { x: number; z: number } | undefined;
    let overWater = 0;
    const headings = new Set<number>();
    for (let n = 0; n < 60; n++) {
      const wind = randomWind(rand);
      const s = pickAirStart(wind.v, rand, last);
      const at = `start ${n} at (${Math.round(s.x)}, ${Math.round(s.y)}, ${Math.round(s.z)}) on ${s.heading}°, wind ${wind.from}° ${wind.speed.toFixed(1)} m/s`;
      expect(clearance(s, airTrack(s.heading, wind.v)), at).toBeGreaterThan(140);
      expect(s.y, at).toBeLessThanOrEqual(MAX_AIR_Y);
      expect(s.x >= START_BOX[0] && s.z >= START_BOX[1] && s.x <= START_BOX[2] && s.z <= START_BOX[3], at).toBe(true);
      if (last) expect(Math.hypot(s.x - last.x, s.z - last.z), at).toBeGreaterThanOrEqual(AIR_APART);
      if (terrainHeight(s.x, s.z) < 0) overWater++;
      headings.add(s.heading);
      last = s;
    }
    // over the sea and the fjords a third of the time, over the land the rest, in all directions
    expect(overWater / 60).toBeGreaterThan(0.15);
    expect(overWater / 60).toBeLessThan(0.6);
    expect(headings.size).toBeGreaterThanOrEqual(12);
  });

  it('are repeatable with the same random sequence', () => {
    const a = seeded(9);
    const b = seeded(9);
    for (let n = 0; n < 4; n++) expect(pickAirStart({ x: 2.6, z: 3.1 }, a)).toEqual(pickAirStart({ x: 2.6, z: 3.1 }, b));
  });

  it.each(['arcade', 'assisted', 'simulation'] as FlightModel[])('fly on clear of the ground with the %s model, drifting with the wind', (model) => {
    const rand = seeded(model.length + 100);
    for (let n = 0; n < 5; n++) {
      const wind = randomWind(rand);
      const s = pickAirStart(wind.v, rand);
      const r = cruise(model, s, wind, 60);
      const at = `from (${Math.round(s.x)}, ${Math.round(s.y)}, ${Math.round(s.z)}) on ${s.heading}°, wind ${wind.from}° ${wind.speed.toFixed(1)} m/s`;
      expect(r.crashed, `${at}: ${r.crashReason}`).toBe(false);
      expect(r.minAgl, at).toBeGreaterThan(100);
    }
    // the classic start too
    expect(cruise(model, AIR_HOME).crashed).toBe(false);
  });
});
