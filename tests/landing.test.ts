import { describe, expect, it } from 'vitest';
import { LANDING_GLIDE, approachStart, landFromFinal, landingAim } from '../src/sim/scenarios.ts';
import { STRIPS } from '../src/world/params.ts';
import { terrainHeight } from '../src/world/terrain.ts';
import type { FlightModel } from '../src/sim/aircraft.ts';

describe('landing mode', () => {
  it("starts each strip's final on the glide path, 2 km out or more, well above the ground", () => {
    STRIPS.forEach((s, i) => {
      const a = approachStart(i);
      expect(a.heading, s.id).toBe(s.heading);
      expect(a.dist, s.id).toBeGreaterThanOrEqual(2000);
      expect(a.dist, s.id).toBeLessThanOrEqual(4200);
      const path = s.elevation + LANDING_GLIDE.wheels + (a.dist + landingAim(s)) * Math.tan((LANDING_GLIDE.angle * Math.PI) / 180);
      expect(a.y, s.id).toBeCloseTo(path, 6);
      expect(a.y - Math.max(terrainHeight(a.x, a.z), 0), s.id).toBeGreaterThan(100);
    });
  });

  it.each(['arcade', 'assisted', 'simulation'] as FlightModel[])('the autoland lands on every strip from its final with the %s model', (model) => {
    STRIPS.forEach((s, i) => {
      const r = landFromFinal(model, i);
      expect(r.crashed, `${s.id}: ${r.crashReason}`).toBe(false);
      expect(r.touchdown?.onRunway, s.id).toBe(true);
      expect(r.pastThreshold, s.id).toBeGreaterThan(0);
      expect(r.stoppedOnRunway, s.id).toBe(true);
    });
  });
});
