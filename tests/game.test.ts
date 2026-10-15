import { describe, it, expect } from 'vitest';
import { gradeLanding, gradeRings, gradeFromScore, type LandingInput } from '../src/game/grading.ts';
import { buildCourse, courseClearance, courseLength, coursePar, GATE_COUNT } from '../src/game/course.ts';

const good: LandingInput = {
  sinkRate: 1.0, centreline: 0.8, pastThreshold: 65, aim: 60, runwayLength: 420, bank: 0.5, bounces: 0,
  stoppedOnRunway: true, crashed: false, crashReason: '', gearDown: true, onRunway: true, rollout: 180,
};

describe('landing grade', () => {
  it('rewards a soft, centred landing on the aim point', () => {
    const r = gradeLanding(good);
    expect(['S', 'A']).toContain(r.grade);
    expect(r.success).toBe(true);
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
    const base = { missed: 0, penaltyPerMiss: 5, par: 260, gates: 14, crashed: false, crashReason: '', splits: [] };
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

describe('ring course', () => {
  const gates = buildCourse();
  it('has 14 gates, roughly evenly spaced, all flown in the same general direction', () => {
    expect(gates.length).toBe(GATE_COUNT);
    for (let i = 1; i < gates.length; i++) {
      const d = Math.hypot(gates[i].x - gates[i - 1].x, gates[i].z - gates[i - 1].z);
      expect(d).toBeGreaterThan(600);
      expect(d).toBeLessThan(1500);
      // consecutive gate directions never reverse
      expect(gates[i].nx * gates[i - 1].nx + gates[i].nz * gates[i - 1].nz).toBeGreaterThan(0.3);
    }
    expect(courseLength(gates)).toBeGreaterThan(10000);
    expect(coursePar(gates)).toBeGreaterThan(180);
  });
  it('keeps every ring and every straight leg well clear of terrain and water', () => {
    const c = courseClearance(gates);
    expect(c.ring).toBeGreaterThan(25);
    expect(c.leg).toBeGreaterThan(30);
  });
});
