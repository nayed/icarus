// Free flights on the water start at a random spot. A water is drawn first (the coast and its islands,
// or one of the fjords, arms and lakes), then spots in it until one is deep enough, sheltered enough
// for the wind, and has a clear take-off into the wind: a run on open water, then a straight climb-out
// over whatever comes after. Checked on the CPU terrain, the heights the world is drawn and collided with.
import { terrainHeight } from './terrain.ts';
import { FJORDS, FJORD_LENGTH, START_BOX, headingDir, type Vec2 } from './params.ts';
import { fetchFactor, seaState } from './water.ts';

export interface WaterStart {
  x: number;
  z: number;
  /** take-off heading, degrees */
  heading: number;
  /** the water it lies in: an index into FJORDS, or COAST */
  water: number;
}

/** The coast, its islands and the open water between the fjords' mouths. */
export const COAST = -1;

/** The classic start in the main fjord, off the coastal strip (tests, repeatable screenshots). */
export const WATER_HOME: WaterStart = { x: 2600, z: 2350, heading: 95, water: 0 };

// The checks (metres). Lift-off on the water takes 70–290 m, the run allows 700 (tests/waterStart.test.ts).
/** terrain octaves for the checks: cheaper than all 11, and random picks pass with all 11 too */
const OCT = 8;
/** the start itself: at least this deep */
const START_DEPTH = 5;
/**
 * and no rougher than this (seaState × fetchFactor): the classic start in the strongest wind is 0.62,
 * and take-offs start to fail around 0.9. In a strong wind the coast is out, the inner fjords are not.
 */
export const MAX_SEA = 0.65;
/** the run: water at least 2 m deep from 150 m behind to 900 m ahead, ±60 m */
const RUN = { back: 150, ahead: 900, step: 50, sides: [0, -30, 30, -60, 60], depth: 2 };
/** the climb-out: from lift-off 700 m ahead, at 8 %, 25 m above any land within ±120 m, for 2.5 km */
const CLIMB = { from: 700, gradient: 0.08, length: 2500, step: 100, sides: [0, -60, 60, -120, 120], margin: 25 };
/** headings tried, from straight into the wind outwards: never more than 70° off it, so never a tailwind */
const OFF_WIND = [0, 10, -10, 20, -20, 30, -30, 40, -40, 50, -50, 60, -60, 70, -70];
/** the coast only within 3 km of land: out on the open sea there is nothing to see */
const NEAR_LAND = 3000;

/**
 * How likely each water is drawn (COAST first, then FJORDS): the square root of its area, so bigger
 * waters come up more often but not in proportion (by area the coast would take every other start
 * and the arms almost none). The coast counts as 250 km², about its startable part.
 */
const WEIGHT = [Math.sqrt(250e6), ...FJORDS.map((fj, f) => Math.sqrt(FJORD_LENGTH[f] * (fj.widthMouth + fj.widthHead)))];

function segmentDistance(x: number, z: number, a: Vec2, b: Vec2): number {
  const vx = b[0] - a[0];
  const vz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / (vx * vx + vz * vz)));
  return Math.hypot(x - a[0] - vx * t, z - a[1] - vz * t);
}

/** The water (x, z) lies in: the fjord whose shores it is within, or COAST. */
export function waterAt(x: number, z: number): number {
  let water = COAST;
  let best = 0;
  for (let f = 0; f < FJORDS.length; f++) {
    const fj = FJORDS[f];
    // the widest bottom, its walls, and the meander around the line
    const band = 1.6 * Math.max(fj.widthMouth, fj.widthHead) + 600;
    for (let k = 0; k < fj.points.length - 1; k++) {
      const d = segmentDistance(x, z, fj.points[k], fj.points[k + 1]) - band;
      if (d < best) {
        best = d;
        water = f;
      }
    }
  }
  return water;
}

/** A take-off from (x, z) along `heading` has open water for its run and clears the land after it. */
export function clearTakeoff(x: number, z: number, heading: number): boolean {
  const [dx, dz] = headingDir(heading);
  const h = (a: number, b: number) => terrainHeight(x + dx * a - dz * b, z + dz * a + dx * b, OCT);
  // line by line, the centre line first: a heading at a shore fails within a few samples
  for (const b of RUN.sides) for (let a = -RUN.back; a <= RUN.ahead; a += RUN.step) if (h(a, b) > -RUN.depth) return false;
  for (const b of CLIMB.sides) {
    for (let d = 0; d <= CLIMB.length; d += CLIMB.step) {
      const g = h(CLIMB.from + d, b);
      if (g > 0 && g + CLIMB.margin > CLIMB.gradient * d) return false;
    }
  }
  return true;
}

/** The clear take-off heading from (x, z) closest to straight into a wind from `windFrom`, or null. */
export function waterTakeoffHeading(x: number, z: number, windFrom: number): number | null {
  for (const off of OFF_WIND) {
    const heading = (((windFrom + off) % 360) + 360) % 360;
    if (clearTakeoff(x, z, heading)) return heading;
  }
  return null;
}

function nearLand(x: number, z: number): boolean {
  for (let r = 250; r <= NEAR_LAND; r += 250) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      if (terrainHeight(x + Math.cos(a) * r, z + Math.sin(a) * r, 5) > 0) return true;
    }
  }
  return false;
}

/** A random spot in water w, not checked yet: for a fjord, along its line and within its width. */
function spotIn(w: number, rand: () => number): Vec2 {
  const B = START_BOX;
  if (w === COAST) return [B[0] + rand() * (B[2] - B[0]), B[1] + rand() * (B[3] - B[1])];
  const fj = FJORDS[w];
  const s = rand() * FJORD_LENGTH[w];
  const off = (rand() * 2 - 1) * (fj.widthMouth + (fj.widthHead - fj.widthMouth) * (s / FJORD_LENGTH[w]));
  let d = s;
  for (let k = 0; ; k++) {
    const a = fj.points[k];
    const b = fj.points[k + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d > l && k < fj.points.length - 2) {
      d -= l;
      continue;
    }
    const t = Math.min(d / l, 1);
    return [a[0] + (b[0] - a[0]) * t - ((b[1] - a[1]) / l) * off, a[1] + (b[1] - a[1]) * t + ((b[0] - a[0]) / l) * off];
  }
}

/**
 * A random start on the water, facing into a wind from `windFrom` at `windSpeed` m/s. A water is drawn
 * by WEIGHT (never `avoid`, the last start's), then random spots in it until one passes the checks. A
 * water where no spot passes in this wind (a lake ringed by mountains, an arm across the wind, the
 * coast in a gale) is dropped and another drawn.
 */
export function pickWaterStart(windFrom: number, windSpeed: number, rand: () => number = Math.random, avoid?: number): WaterStart {
  const B = START_BOX;
  const sea = seaState(windSpeed);
  const waters = [COAST, ...FJORDS.map((_, f) => f)].filter((w) => w !== avoid);
  while (waters.length) {
    let r = rand() * waters.reduce((sum, w) => sum + WEIGHT[w + 1], 0);
    const w = waters.find((v) => (r -= WEIGHT[v + 1]) < 0) ?? waters[waters.length - 1];
    for (let spots = 0, checked = 0; spots < 80 && checked < 6; spots++) {
      const [x, z] = spotIn(w, rand);
      if (x < B[0] || z < B[1] || x > B[2] || z > B[3] || sea * fetchFactor(x) > MAX_SEA) continue;
      if (terrainHeight(x, z, OCT) > -START_DEPTH || waterAt(x, z) !== w) continue;
      if (w === COAST && !nearLand(x, z)) continue;
      checked++;
      const heading = waterTakeoffHeading(x, z, windFrom);
      if (heading !== null) return { x, z, heading, water: w };
    }
    waters.splice(waters.indexOf(w), 1);
  }
  return WATER_HOME;
}
