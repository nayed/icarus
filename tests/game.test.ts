import { describe, it, expect } from 'vitest';
import { gradeLanding, gradeRings, gradeFromScore, type LandingInput } from '../src/game/grading.ts';
import { COURSES, buildCourse, courseClearance, courseLength, coursePar, courseStart, GATE_COUNT } from '../src/game/course.ts';
import { ringRun } from '../src/sim/scenarios.ts';
import { terrainHeight } from '../src/world/terrain.ts';
import type { FlightModel } from '../src/sim/aircraft.ts';

const good: LandingInput = {
  strip: 'Hestskar mountain strip',
  sinkRate: 1.0, centreline: 0.8, pastThreshold: 65, aim: 60, runwayLength: 420, bank: 0.5, bounces: 0,
  stoppedOnRunway: true, crashed: false, crashReason: '', gearDown: true, onRunway: true, rollout: 180,
};

describe('landing grade', () => {
  it('rewards a soft, centred landing on the aim point', () => {
    const r = gradeLanding(good);
    expect(['S', 'A']).toContain(r.grade);
    expect(r.success).toBe(true);
    expect(r.title).toBe('Hestskar mountain strip');
  });
  it('penalises a hard landing, a long landing, and a bounce', () => {
    expect(Number(gradeLanding({ ...good, sinkRate: 4.0 }).headline)).toBeLessThan(Number(gradeLanding(good).headline) - 20);
    expect(Number(gradeLanding({ ...good, pastThreshold: 260 }).headline)).toBeLessThan(Number(gradeLanding(good).headline) - 20);
    expect(Number(gradeLanding({ ...good, bounces: 1 }).headline)).toBeLessThan(Number(gradeLanding(good).headline));
  });
  it('fails crashes, overruns, off-strip and wheels-up landings', () => {
    expect(gradeLanding({ ...good, crashed: true, crashReason: 'x' }).grade).toBe('F');
    for (const bad of [{ stoppedOnRunway: false }, { onRunway: false }, { gearDown: false }]) {
      const r = gradeLanding({ ...good, ...bad });
      expect(r.success).toBe(false);
      expect(['D', 'F']).toContain(r.grade);
    }
  });
});

describe('ring run grade', () => {
  it('grades against par with penalties', () => {
    const base = { course: 'Fjordruta', missed: 0, penaltyPerMiss: 5, par: 260, gates: 14, crashed: false, crashReason: '', splits: [] };
    expect(gradeRings({ ...base, time: 250 }).grade).toBe('S');
    expect(['A', 'B']).toContain(gradeRings({ ...base, time: 290 }).grade);
    expect(gradeRings({ ...base, time: 250, missed: 3 }).headline).toBe('4:25.00');
    expect(gradeRings({ ...base, time: 100, crashed: true, crashReason: 'x' }).grade).toBe('F');
  });
  it('maps scores to letters monotonically', () => {
    const order = ['F', 'D', 'C', 'B', 'A', 'S'];
    let last = 0;
    for (let s = 0; s <= 100; s += 1) {
      const g = order.indexOf(gradeFromScore(s));
      expect(g).toBeGreaterThanOrEqual(last);
      last = g;
    }
  });
});

describe.each(COURSES.map((c) => [c.name, c.id] as const))('ring course %s', (_, id) => {
  const gates = buildCourse(id);
  it('has 14 gates, roughly evenly spaced, all flown in the same general direction', () => {
    expect(gates.length).toBe(GATE_COUNT);
    for (let i = 1; i < gates.length; i++) {
      const d = Math.hypot(gates[i].x - gates[i - 1].x, gates[i].z - gates[i - 1].z);
      expect(d).toBeGreaterThan(600);
      expect(d).toBeLessThan(1500);
      // consecutive gate directions never reverse
      expect(gates[i].nx * gates[i - 1].nx + gates[i].nz * gates[i - 1].nz).toBeGreaterThan(0.3);
      // and no leg climbs more steeply than the aircraft can (about 11 % at 90 kt)
      expect((gates[i].y - gates[i - 1].y) / d).toBeLessThan(0.08);
    }
    expect(courseLength(gates)).toBeGreaterThan(10000);
    expect(coursePar(gates)).toBeGreaterThan(180);
  });
  it('keeps every ring and every straight leg well clear of terrain and water, and below the clouds', () => {
    const c = courseClearance(gates);
    expect(c.ring).toBeGreaterThan(25);
    expect(c.leg).toBeGreaterThan(30);
    // cloud base 1550 m (CLOUD_BASE in src/render/clouds.ts)
    for (const g of gates) expect(g.y + g.radius).toBeLessThan(1450);
  });
  it('starts with a clear run in to the first gate', () => {
    const s = courseStart(gates);
    for (let t = 0; t <= 1; t += 0.02) expect(s.y - Math.max(0, terrainHeight(s.x + (gates[0].x - s.x) * t, s.z + (gates[0].z - s.z) * t, 7))).toBeGreaterThan(50);
  });
  // each model in a different wind: the default breeze, and 10 m/s from two sides
  it.each([
    ['arcade', { from: 40, speed: 4 }],
    ['assisted', { from: 220, speed: 10 }],
    ['simulation', { from: 130, speed: 10 }],
  ] as [FlightModel, { from: number; speed: number }][])('is flown clean by the autopilot with the %s model, wind %o', (model, wind) => {
    const r = ringRun(model, gates, courseStart(gates), wind);
    expect(r.crashed, JSON.stringify(r)).toBe(false);
    expect(r.passed, JSON.stringify(r)).toBe(gates.length);
    expect(r.minAgl, JSON.stringify(r)).toBeGreaterThan(30);
  });
});
