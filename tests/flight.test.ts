import { describe, it, expect } from 'vitest';
import { takeoff, restOnRunway, stall, approach, waterTakeoff, drop, WATER_LANE } from '../src/sim/scenarios.ts';
import { STRIPS } from '../src/world/params.ts';
import { Aircraft, type FlightModel, type PilotInput } from '../src/sim/aircraft.ts';
import { WorldEnv } from '../src/sim/environment.ts';
import { idleInput } from '../src/sim/autopilot.ts';
import { AIRCRAFT } from '../src/sim/config.ts';

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

describe('speed limits', () => {
  // engine cut at 10 000 ft, a nose-down push held for `pushSec`, then hands off
  const dive = (model: FlightModel, pushSec: number, seconds = 150, windFrom = 40, windSpeed = 4) => {
    const env = new WorldEnv({ M: 128, levels: 11, s0: 1 });
    env.setWind(windFrom, windSpeed);
    const ac = new Aircraft();
    ac.model = model;
    ac.reset(-20000, 3048, 4000, 80, 46);
    const inp: PilotInput = { ...idleInput(), throttle: 0, gearDown: false };
    const DT = 1 / 120;
    let maxIas = 0;
    let warnedAt = -1;
    let iasAtFailure = 0;
    for (let i = 0; i < seconds / DT && !ac.crashed; i++) {
      const t = i * DT;
      inp.pitch = t >= 10 && t < 10 + pushSec ? -0.6 : 0;
      env.follow(ac.pos.x, ac.pos.z);
      ac.step(DT, inp, env);
      const tel = ac.telemetry(env);
      maxIas = Math.max(maxIas, tel.ias * 1.944);
      if (tel.overspeed && warnedAt < 0) warnedAt = t;
      if (ac.crashed) iasAtFailure = tel.ias * 1.944;
    }
    return { ac, maxIas, warnedAt, iasAtFailure, pitch: ac.pitchAngle };
  };

  it.each(['arcade', 'assisted'] as FlightModel[])('%s: a released dive recovers instead of building to an overspeed', (model) => {
    const r = dive(model, 2);
    expect(r.ac.crashed).toBe(false);
    expect(r.maxIas).toBeLessThan(AIRCRAFT.vne * 1.944);
    expect(r.pitch).toBeGreaterThan(-12);
  });

  it.each(['arcade', 'assisted'] as FlightModel[])('%s: holding the nose down stays near the red line, never breaks', (model) => {
    const r = dive(model, 40);
    expect(r.ac.crashed).toBe(false);
    expect(r.maxIas).toBeLessThan(AIRCRAFT.vne * 1.944 + 8);
  });

  it('simulation: warns at the red line, breaks up at the indicated break-up speed', () => {
    const r = dive('simulation', 60);
    expect(r.ac.crashReason).toBe('overspeed: structural failure');
    expect(r.warnedAt).toBeGreaterThan(0);
    expect(r.iasAtFailure).toBeGreaterThan(AIRCRAFT.vBreak * 1.944 - 1);
  });

  it('a strong tailwind adds ground speed, not structural load', () => {
    // 30 m/s wind from the west at altitude, flying east fast: ground speed well past 185 kt
    const env = new WorldEnv({ M: 128, levels: 11, s0: 1 });
    env.setWind(270, 30);
    env.gustiness = 0;
    const ac = new Aircraft();
    ac.model = 'simulation';
    ac.reset(-20000, 3048, 4000, 90, 100);
    const inp: PilotInput = { ...idleInput(), throttle: 0.8, gearDown: false };
    for (let i = 0; i < 240; i++) {
      env.follow(ac.pos.x, ac.pos.z);
      ac.step(1 / 120, inp, env);
    }
    expect(ac.vel.length()).toBeGreaterThan(95);
    expect(ac.crashed).toBe(false);
  });
});

describe('restarts', () => {
  it('a reset after a crash starts with the engine running', () => {
    const env = new WorldEnv({ M: 128, levels: 11, s0: 1 });
    const ac = new Aircraft();
    const inp: PilotInput = { ...idleInput(), throttle: 1, gearDown: false };
    ac.reset(-20000, 600, 4000, 80, 46);
    ac.crash('test');
    ac.step(1 / 120, inp, env); // a wreck stops its engine
    expect(ac.engineOn).toBe(false);
    ac.reset(-20000, 600, 4000, 80, 46);
    for (let i = 0; i < 240; i++) {
      env.follow(ac.pos.x, ac.pos.z);
      ac.step(1 / 120, inp, env);
    }
    expect(ac.engineOn).toBe(true);
    expect(ac.rpm).toBeGreaterThan(1900);
  });
});
