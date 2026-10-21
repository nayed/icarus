import { describe, expect, it } from 'vitest';
import { COAST, MAX_SEA, WATER_HOME, clearTakeoff, pickWaterStart, waterAt } from '../src/world/waterStart.ts';
import { START_BOX } from '../src/world/params.ts';
import { terrainHeight } from '../src/world/terrain.ts';
import { fetchFactor, seaState } from '../src/world/water.ts';
import { waterTakeoff } from '../src/sim/scenarios.ts';
import type { FlightModel } from '../src/sim/aircraft.ts';
import { seeded } from './random.ts';
const offWind = (heading: number, windFrom: number) => Math.abs(((((heading - windFrom) % 360) + 540) % 360) - 180);

describe('water starts', () => {
  it('are deep, sheltered for the wind, clear for a take-off into it, and in a different water each time', () => {
    const rand = seeded(7);
    let last: number | undefined;
    for (let n = 0; n < 150; n++) {
      const from = Math.floor(rand() * 360);
      const speed = rand() * 15;
      const s = pickWaterStart(from, speed, rand, last);
      const at = `start ${n} at (${Math.round(s.x)}, ${Math.round(s.z)}), wind ${from}° ${speed.toFixed(1)} m/s`;
      expect(s.water, at).not.toBe(last);
      expect(waterAt(s.x, s.z), at).toBe(s.water);
      expect(terrainHeight(s.x, s.z), at).toBeLessThan(-4);
      expect(seaState(speed) * fetchFactor(s.x), at).toBeLessThanOrEqual(MAX_SEA);
      expect(clearTakeoff(s.x, s.z, s.heading), at).toBe(true);
      expect(offWind(s.heading, from), at).toBeLessThanOrEqual(70);
      expect(s.x >= START_BOX[0] && s.z >= START_BOX[1] && s.x <= START_BOX[2] && s.z <= START_BOX[3], at).toBe(true);
      last = s.water;
    }
  });

  it('spread over the coast and the fjords', () => {
    const rand = seeded(11);
    const count = new Map<number, number>();
    let last: number | undefined;
    for (let n = 0; n < 200; n++) {
      last = pickWaterStart(Math.floor(rand() * 360), 4, rand, last).water;
      count.set(last, (count.get(last) ?? 0) + 1);
    }
    // the coast about one start in five, the three long fjords one in ten each, and most arms
    expect(count.get(COAST)! / 200).toBeGreaterThan(0.1);
    expect(count.get(COAST)! / 200).toBeLessThan(0.35);
    for (const f of [0, 3, 7]) expect(count.get(f)! / 200, `fjord ${f}`).toBeGreaterThan(0.05);
    expect(count.size).toBeGreaterThanOrEqual(14);
  });

  it('are repeatable with the same random sequence', () => {
    const a = seeded(3);
    const b = seeded(3);
    for (let n = 0; n < 5; n++) expect(pickWaterStart(40, 4, a)).toEqual(pickWaterStart(40, 4, b));
  });

  it('know the water a point lies in', () => {
    expect(waterAt(WATER_HOME.x, WATER_HOME.z)).toBe(WATER_HOME.water);
    expect(waterAt(3750, -12750)).toBe(3); // the northern fjord
    expect(waterAt(-9000, 0)).toBe(COAST);
  });

  it.each(['arcade', 'assisted', 'simulation'] as FlightModel[])('take off with the %s model and climb clear', (model) => {
    const rand = seeded(model.length);
    for (let n = 0; n < 5; n++) {
      const wind = { from: Math.floor(rand() * 360), speed: rand() * 15 };
      const s = pickWaterStart(wind.from, wind.speed, rand);
      const r = waterTakeoff(model, s, wind);
      const at = `from (${Math.round(s.x)}, ${Math.round(s.z)}) on ${s.heading}°, wind ${wind.from}° ${wind.speed.toFixed(1)} m/s`;
      expect(r.crashed, `${at}: ${r.crashReason}`).toBe(false);
      // off the water inside the run the checks keep clear (it takes 70–290 m), and well up a minute
      // later (160 m or more in calm air)
      expect(r.distance, at).toBeGreaterThan(0);
      expect(r.distance, at).toBeLessThan(700);
      expect(r.agl, at).toBeGreaterThan(100);
    }
  });
});
