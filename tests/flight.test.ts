import { describe, it, expect } from 'vitest';
import { takeoff, restOnRunway, stall, approach, waterTakeoff, drop, WATER_LANE } from '../src/sim/scenarios.ts';
import { STRIPS } from '../src/world/params.ts';
import type { FlightModel } from '../src/sim/aircraft.ts';

const MODELS: FlightModel[] = ['arcade', 'assisted', 'simulation'];

describe.each(MODELS)('flight model: %s', (model) => {
  it('takes off from the coastal strip within a STOL distance and climbs', () => {
    const r = takeoff(model);
    expect(r.crashed).toBe(false);
    expect(r.liftoffDistance).toBeGreaterThan(100);
    expect(r.liftoffDistance).toBeLessThan(450);
    expect(r.liftoffKt).toBeGreaterThan(45);
    expect(r.liftoffKt).toBeLessThan(75);
    expect(r.climbFpm).toBeGreaterThan(500);
  });

  it('rests on the runway without creep or jitter', () => {
    const r = restOnRunway(model);
    expect(r.driftMm).toBeLessThan(1);
    expect(r.rotDeg).toBeLessThan(0.01);
  });

  it('lands on the coastal strip', () => {
    const r = approach(model, STRIPS[0]);
    expect(r.crashed, r.crashReason).toBe(false);
    expect(r.touchdown?.onRunway).toBe(true);
    expect(r.touchdown!.sinkRate).toBeLessThan(3.5);
    expect(Math.abs(r.centreline)).toBeLessThan(8);
    expect(r.stoppedOnRunway).toBe(true);
  });

  it('lands on the mountain strip', () => {
    const r = approach(model, STRIPS[1], 2500);
    expect(r.crashed, r.crashReason).toBe(false);
    expect(r.touchdown?.onRunway).toBe(true);
    expect(r.pastThreshold).toBeGreaterThan(0);
    expect(r.stoppedOnRunway).toBe(true);
  });

  it('takes off from and lands on the fjord with the gear up', () => {
    const t = waterTakeoff(model);
    expect(t.crashed).toBe(false);
    expect(t.distance).toBeGreaterThan(100);
    expect(t.distance).toBeLessThan(700);
    const l = approach(model, WATER_LANE, 2000, true);
    expect(l.crashed, l.crashReason).toBe(false);
    expect(l.touchdown?.onWater).toBe(true);
    expect(l.finalSpeed).toBeLessThan(5);
  });

  it('never sinks below the drawn surface when dropped', () => {
    const cases = [
      drop(model, 'runway', 600, 6250, 0.4, true),
      drop(model, 'runway hard', 600, 6250, 3, true),
      drop(model, 'slope', 4300, -1200, 0.4, true),
      drop(model, 'mountain strip', 5550, 350, 0.3, true),
    ];
    for (const c of cases) {
      // contact points may compress into the surface by the tyre/spring travel only
      expect(c.minTerrainClearance, c.label).toBeGreaterThan(-0.35);
      // flat ground: comes to rest; a wreck on a 20° slope may slide slowly but must not accelerate
      expect(c.finalSpeed, c.label).toBeLessThan(c.label === 'slope' ? 1 : 0.05);
    }
    const w = drop(model, 'water', 3000, 2400, 0.1, false);
    expect(w.crashed).toBe(false);
    expect(w.restHeight).toBeGreaterThan(1.4); // floating on the floats
  });
});

describe('simulation-only behaviour', () => {
  it('stalls with warning, loses height, and recovers', () => {
    const r = stall('simulation');
    expect(r.warnedBeforeStall).toBe(true);
    expect(r.stalled).toBe(true);
    expect(r.maxAlpha).toBeGreaterThan(15);
    expect(r.altitudeLost).toBeGreaterThan(30);
    expect(r.recovered).toBe(true);
  });
  it('flips or breaks when landing on water with the wheels down', () => {
    const r = approach('simulation', WATER_LANE, 2000, true, true);
    expect(r.crashed).toBe(true);
  });
  it('arcade model resists stalling', () => {
    const r = stall('arcade');
    expect(r.stalled).toBe(false);
  });
});
