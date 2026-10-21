// Free flights in the air start at a random spot over the map, flying the lowest way on (down a
// valley or a fjord rather than into a mountainside), facing the land rather than the open sea, high
// enough to clear everything on that way and around the spot, and below the clouds. The way is the one
// over the ground, drifting with the wind. Checked on the CPU terrain, the heights the world is drawn
// and collided with.
import { terrainHeight } from './terrain.ts';
import { START_BOX, headingDir, type Vec2 } from './params.ts';

export interface AirStart {
  x: number;
  /** altitude (m) */
  y: number;
  z: number;
  /** heading, degrees */
  heading: number;
}

/** The classic start: over the sea off the main fjord's mouth, flying in (tests, repeatable screenshots). */
export const AIR_HOME: AirStart = { x: -6000, y: 420, z: 2300, heading: 80 };

/** The start's airspeed (m/s, 87 kt). */
export const AIR_SPEED = 45;

/** the way ahead: a minute and a half at AIR_SPEED, and 300 m either side of it */
const AHEAD = 4000;
const SIDE = 300;
/** and the ground within 400 m around the spot */
const AROUND = 400;
/** the start's height above the highest of those (m): from, to */
const CLEARANCE = [150, 350] as const;
/** and below the clouds, whose base is at 1550 m (CLOUD_BASE in src/render/clouds.ts) */
export const MAX_AIR_Y = 1300;
/** a way counts as one of the lowest within this much of the lowest (m) */
const SLACK = 60;
/** a new start is at least this far from the last one (m) */
export const AIR_APART = 6000;

const ground = (x: number, z: number, oct: number) => Math.max(terrainHeight(x, z, oct), 0);

/**
 * The way over the ground (a unit vector) when flying `heading` at AIR_SPEED, with `wind` the air's
 * velocity 200 m above the ground (WorldEnv.baseWind): at the starts' heights it blows about 10 % harder.
 */
export function airTrack(heading: number, wind: { x: number; z: number }): Vec2 {
  const [hx, hz] = headingDir(heading);
  const gx = hx * AIR_SPEED + wind.x * 1.1;
  const gz = hz * AIR_SPEED + wind.z * 1.1;
  const l = Math.hypot(gx, gz);
  return [gx / l, gz / l];
}

/**
 * The highest ground (or water) on the way from (x, z) along `way` (a unit vector) and around the
 * spot, sampled every 50 m along and 75 m across: the start's height is set from it.
 */
export function airFloor(x: number, z: number, way: Vec2): number {
  const [dx, dz] = way;
  let floor = 0;
  for (let a = 0; a <= AHEAD; a += 50) for (let b = -SIDE; b <= SIDE; b += 75) floor = Math.max(floor, ground(x + dx * a - dz * b, z + dz * a + dx * b, 8));
  for (let r = 50; r <= AROUND; r += 50) {
    for (let k = 0; k < 32; k++) floor = Math.max(floor, ground(x + Math.cos((k * Math.PI) / 16) * r, z + Math.sin((k * Math.PI) / 16) * r, 8));
  }
  return floor;
}

/** Hills or mountains of 300 m or more within ±20° and 3–15 km ahead (not the open sea). */
function facesLand(x: number, z: number, heading: number): boolean {
  for (const off of [0, -10, 10, -20, 20]) {
    const [dx, dz] = headingDir(heading + off);
    for (let a = 3000; a <= 15000; a += 1000) if (terrainHeight(x + dx * a, z + dz * a, 4) >= 300) return true;
  }
  return false;
}

/**
 * A random start in the air, in a wind of `wind` (see airTrack): a spot anywhere in START_BOX, at
 * least AIR_APART from `avoid` (the last one); of the headings every 15°, one of those whose way ahead
 * is lowest, facing the land if one of them does; a height CLEARANCE above the highest ground on that
 * way and around the spot. A spot that would put the start in the clouds (among the highest
 * mountains) is dropped and another drawn.
 */
export function pickAirStart(wind: { x: number; z: number }, rand: () => number = Math.random, avoid?: { x: number; z: number }): AirStart {
  const B = START_BOX;
  for (let spots = 0; spots < 200; spots++) {
    const x = B[0] + rand() * (B[2] - B[0]);
    const z = B[1] + rand() * (B[3] - B[1]);
    if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < AIR_APART) continue;
    // a coarse look first: the ground around, then each way ahead, given up on once it is clearly not
    // among the lowest
    let around = ground(x, z, 6);
    for (const r of [AROUND / 2, AROUND]) {
      for (let k = 0; k < 16; k++) around = Math.max(around, ground(x + Math.cos((k * Math.PI) / 8) * r, z + Math.sin((k * Math.PI) / 8) * r, 6));
    }
    if (around + CLEARANCE[0] > MAX_AIR_Y) continue;
    const ways: { heading: number; floor: number }[] = [];
    let lowest = Infinity;
    for (let heading = 0; heading < 360; heading += 15) {
      const [dx, dz] = airTrack(heading, wind);
      let floor = around;
      for (const b of [0, -SIDE / 2, SIDE / 2, -SIDE, SIDE]) {
        for (let a = 100; a <= AHEAD && floor <= lowest + SLACK; a += 100) floor = Math.max(floor, ground(x + dx * a - dz * b, z + dz * a + dx * b, 6));
      }
      ways.push({ heading, floor });
      lowest = Math.min(lowest, floor);
    }
    const low = ways.filter((w) => w.floor <= lowest + SLACK);
    const facing = low.filter((w) => facesLand(x, z, w.heading));
    const pool = facing.length ? facing : low;
    const heading = pool[Math.floor(rand() * pool.length)].heading;
    // then a fine look along the chosen way sets the height
    const y = airFloor(x, z, airTrack(heading, wind)) + CLEARANCE[0] + rand() * (CLEARANCE[1] - CLEARANCE[0]);
    if (y > MAX_AIR_Y) continue;
    return { x, y, z, heading };
  }
  return AIR_HOME;
}
