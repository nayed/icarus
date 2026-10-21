import { describe, expect, it } from 'vitest';
import { toScreen, toWorld, screenAngle, bearingDeg, formatDistance, rangeAndBearing, scaleBarLength, type ChartView } from '../src/ui/chart.ts';
import { Track } from '../src/game/track.ts';
import { MAP_EXTENT, MAP_HOME, MAP_TEXEL, mapCovers, mapRegionAround } from '../src/render/worldMap.ts';
import { FJORDS, RELIEF_FJORDS, START_BOX, STRIPS } from '../src/world/params.ts';
import { approachStart } from '../src/sim/scenarios.ts';
import { buildCourse } from '../src/game/course.ts';

const DEG = Math.PI / 180;
const view = (up: number): ChartView => ({ sx: 100, sy: 100, wx: 5000, wz: -2000, scale: 0.02, up: up * DEG });
const near = (a: [number, number], b: [number, number]) => {
  expect(a[0]).toBeCloseTo(b[0], 6);
  expect(a[1]).toBeCloseTo(b[1], 6);
};

describe('chart view', () => {
  it('north up: north is up, east is right', () => {
    const v = view(0);
    near(toScreen(v, 5000, -2000), [100, 100]);
    near(toScreen(v, 5000, -3000), [100, 80]); // 1 km north
    near(toScreen(v, 6000, -2000), [120, 100]); // 1 km east
  });

  it('heading up: the heading points up and the map turns the other way', () => {
    // flying east: east is up, north is on the left
    near(toScreen(view(90), 6000, -2000), [100, 80]);
    near(toScreen(view(90), 5000, -3000), [80, 100]);
    // flying south: north is down, east is on the left
    near(toScreen(view(180), 5000, -3000), [100, 120]);
    near(toScreen(view(180), 6000, -2000), [80, 100]);
    // flying north-west: a point ahead along heading 315 is straight up
    const d = 1000;
    near(toScreen(view(315), 5000 + Math.sin(315 * DEG) * d, -2000 - Math.cos(315 * DEG) * d), [100, 80]);
  });

  it('toWorld inverts toScreen', () => {
    for (const up of [0, 37, 90, 211, 333]) {
      const v = view(up);
      for (const [x, z] of [[5000, -2000], [5310, -1777], [-1200, 900]] as [number, number][]) {
        near(toWorld(v, ...toScreen(v, x, z)), [x, z]);
      }
    }
  });

  it('symbols turn by heading minus the view direction', () => {
    expect(screenAngle(view(0), 90 * DEG)).toBeCloseTo(90 * DEG);
    expect(screenAngle(view(90), 90 * DEG)).toBeCloseTo(0);
  });
});

describe('map region', () => {
  it('is snapped to the texel lattice and centred on the point', () => {
    const r = mapRegionAround(1234.5, -987.6);
    expect(r.x0 / MAP_TEXEL).toBe(Math.round(r.x0 / MAP_TEXEL));
    expect(r.z0 / MAP_TEXEL).toBe(Math.round(r.z0 / MAP_TEXEL));
    expect(Math.abs(r.x0 + MAP_EXTENT / 2 - 1234.5)).toBeLessThanOrEqual(MAP_TEXEL / 2);
    expect(Math.abs(r.z0 + MAP_EXTENT / 2 + 987.6)).toBeLessThanOrEqual(MAP_TEXEL / 2);
  });

  it('asks for a new map only near the edge', () => {
    const r = mapRegionAround(0, 0);
    expect(mapCovers(r.x0, r.z0, 0, 0)).toBe(true);
    expect(mapCovers(r.x0, r.z0, MAP_EXTENT / 2 - 7000, 0)).toBe(true);
    expect(mapCovers(r.x0, r.z0, MAP_EXTENT / 2 - 5000, 0)).toBe(false);
    expect(mapCovers(r.x0, r.z0, 0, -MAP_EXTENT)).toBe(false);
  });

  it('the first map covers the main fjord, every strip, the course and every start point, and shows every fjord', () => {
    const home = mapRegionAround(MAP_HOME[0], MAP_HOME[1]);
    // the other fjords reach towards the edges: they only have to be on the map
    for (const f of FJORDS.slice(RELIEF_FJORDS)) for (const [x, z] of f.points) expect(mapCovers(home.x0, home.z0, x, z, 0), `(${x}, ${z})`).toBe(true);
    const pts: [number, number][] = [];
    for (const f of FJORDS.slice(0, RELIEF_FJORDS)) pts.push(...(f.points as [number, number][]));
    for (const s of STRIPS) pts.push(s.center as [number, number]);
    const gates = buildCourse();
    for (const g of gates) pts.push([g.x, g.z]);
    // free-flight starts on the water and in the air, the ring run's start, the landings' finals
    pts.push([2600, 2350], [-6000, 2300], [gates[0].x - gates[0].nx * 1500, gates[0].z - gates[0].nz * 1500]);
    for (let i = 0; i < STRIPS.length; i++) {
      const a = approachStart(i);
      pts.push([a.x, a.z]);
    }
    for (const [x, z] of pts) expect(mapCovers(home.x0, home.z0, x, z), `(${x}, ${z})`).toBe(true);
    // random starts (on the water, in the air): at least the HUD map's range (4 km) inside the first map
    const B = START_BOX;
    for (const [x, z] of [[B[0], B[1]], [B[2], B[3]]]) expect(mapCovers(home.x0, home.z0, x, z, 4000), `(${x}, ${z})`).toBe(true);
  });
});

describe('readouts', () => {
  it('bearings are compass bearings', () => {
    expect(bearingDeg(0, -1)).toBeCloseTo(0);
    expect(bearingDeg(1, 0)).toBeCloseTo(90);
    expect(bearingDeg(0, 1)).toBeCloseTo(180);
    expect(bearingDeg(-1, 0)).toBeCloseTo(270);
    expect(bearingDeg(-1, -1)).toBeCloseTo(315);
  });

  it('formats distance and bearing', () => {
    expect(formatDistance(447)).toBe('450 m');
    expect(formatDistance(6340)).toBe('6.3 km');
    expect(rangeAndBearing(100, 100, 100 + 3000 * Math.sin(DEG * 45), 100 - 3000 * Math.cos(DEG * 45))).toBe('3.0 km · 045°');
    // due north, a hair west: 360 is shown as 000
    expect(rangeAndBearing(0, 0, -0.001, -500)).toBe('500 m · 000°');
  });

  it('picks round scale-bar lengths', () => {
    expect(scaleBarLength(4300)).toBe(5000);
    expect(scaleBarLength(1300)).toBe(1000);
    expect(scaleBarLength(160)).toBe(200);
    expect(scaleBarLength(16000)).toBe(20000);
  });
});

describe('track', () => {
  it('keeps a point every `spacing` metres, and only the latest `max`', () => {
    const t = new Track(5, 25);
    t.add(0, 0);
    t.add(10, 0); // too close: skipped
    t.add(30, 0);
    expect(t.count).toBe(2);
    for (let k = 2; k <= 8; k++) t.add(k * 30, 0);
    expect(t.count).toBe(5);
    expect(t.point(0)).toEqual([120, 0]);
    expect(t.point(4)).toEqual([240, 0]);
    t.reset();
    expect(t.count).toBe(0);
  });
});
