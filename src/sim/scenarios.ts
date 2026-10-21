// Scripted flights shared by the unit tests, the headless tuning script and the in-browser
// test hooks. Each returns plain numbers so callers can assert on them.
import * as THREE from 'three';
import { Aircraft, type FlightModel, type PilotInput, type Touchdown } from './aircraft.ts';
import { WorldEnv } from './environment.ts';
import { Autopilot, idleInput } from './autopilot.ts';
import { STRIPS, headingDir, type StripDef } from '../world/params.ts';
import { drawnHeight } from '../world/clipmap.ts';
import { terrainHeight } from '../world/terrain.ts';
import { WATER_HOME } from '../world/waterStart.ts';
import { AIR_SPEED } from '../world/airStart.ts';

export const SIM_DT = 1 / 120;
const clamp = THREE.MathUtils.clamp;

export interface Rig {
  ac: Aircraft;
  env: WorldEnv;
  inp: PilotInput;
  ap: Autopilot;
}

export function makeRig(model: FlightModel, env?: WorldEnv): Rig {
  const e = env ?? new WorldEnv({ M: 128, levels: 11, s0: 1 });
  if (!env) e.gustiness = 0;
  const ac = new Aircraft();
  ac.model = model;
  return { ac, env: e, inp: idleInput(), ap: new Autopilot() };
}

/** Steps the rig; `each` runs before every step. Stops early on crash if `stopOnCrash`. */
export function run(r: Rig, seconds: number, each?: () => void, stopOnCrash = true): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    r.env.follow(r.ac.pos.x, r.ac.pos.z);
    each?.();
    r.ac.step(SIM_DT, r.inp, r.env);
    if (stopOnCrash && r.ac.crashed) return;
  }
}

/** `back` metres in from the end of strip i, facing `heading` (its own heading, or the reverse). */
export function runwayEnd(i: number, back: number, heading = STRIPS[i].heading): { x: number; z: number; heading: number } {
  const s = STRIPS[i];
  const d = headingDir(s.heading);
  // along the strip's heading: start at its near end; the other way: at its far end
  const e = Math.cos(((heading - s.heading) * Math.PI) / 180) >= 0 ? 1 : -1;
  return { x: s.center[0] - e * d[0] * (s.halfLength - back), z: s.center[1] - e * d[1] * (s.halfLength - back), heading };
}

/** The take-off heading at a strip: among its clear departures, the one most into the wind. */
export function takeoffHeading(s: StripDef, windFrom: number): number {
  let best = s.departures[0];
  let headwind = -2;
  for (const h of s.departures) {
    const c = Math.cos(((windFrom - h) * Math.PI) / 180);
    if (c > headwind + 1e-9) {
      headwind = c;
      best = h;
    }
  }
  return best;
}

/** The landing mode's glide path: 4° down to the strip's aim point, the wheels 2.4 m below the aircraft's centre. */
export const LANDING_GLIDE = { angle: 4, wheels: 2.4 };

/**
 * A strip's aim point, in metres past the threshold: a sixth of the way along it, at least 60 m. On
 * Vika's long runway that also clears the bank 200 m short of it by 10 m.
 */
export function landingAim(s: StripDef): number {
  return Math.max(60, Math.round(s.halfLength / 30) * 10);
}

/**
 * Where the landing mode starts for strip i, on final for its heading: on the glide path, 4.2 km before
 * the threshold, or nearer where the ground further out than 1 km comes within 30 m plus 1 % of the
 * distance of the path (75 m either side of it: Hjelle's final starts past a ridge 2.6 km out). `dist`
 * is the distance to the threshold.
 */
export function approachStart(i: number): { x: number; y: number; z: number; heading: number; dist: number } {
  const s = STRIPS[i];
  const [dx, dz] = headingDir(s.heading);
  const tan = Math.tan((LANDING_GLIDE.angle * Math.PI) / 180);
  const path = (a: number) => s.elevation + LANDING_GLIDE.wheels + (a + landingAim(s)) * tan;
  // `a` metres before the threshold, `b` metres to the right of the centreline
  const at = (a: number, b: number): [number, number] => [s.center[0] - dx * (s.halfLength + a) - dz * b, s.center[1] - dz * (s.halfLength + a) + dx * b];
  let dist = 4200;
  for (let a = 1000; a <= 4200; a += 50) {
    const blocked = [-75, -35, 0, 35, 75].some((b) => Math.max(terrainHeight(...at(a, b), 8), 0) > path(a) - 30 - 0.01 * a);
    if (blocked) {
      dist = a - 300;
      break;
    }
  }
  const [x, z] = at(dist, 0);
  return { x, y: path(dist), z, heading: s.heading, dist };
}

export function placeOnRunway(r: Rig, i: number, back: number, heading = STRIPS[i].heading): void {
  const p = runwayEnd(i, back, heading);
  r.env.follow(p.x, p.z);
  r.ac.reset(p.x, drawnHeight(p.x, p.z, r.env.clip) + 2.47, p.z, p.heading, 0);
}

/** Full-power take-off from strip i along `heading`, holding 8° of pitch, for `seconds`. */
export function takeoff(model: FlightModel, i = 0, heading = STRIPS[i].heading, seconds = 45): { liftoffDistance: number; liftoffKt: number; climbFpm: number; agl: number; crashed: boolean } {
  const r = makeRig(model);
  placeOnRunway(r, i, 20, heading);
  r.inp.flapNotch = 1;
  run(r, 2);
  const x0 = r.ac.pos.clone();
  r.inp.throttle = 1;
  let lift = 0;
  let liftKt = 0;
  const tel = () => r.ac.telemetry(r.env);
  const hdg = heading;
  run(r, seconds, () => {
    const t = tel();
    r.inp.pitch = t.ias > 27 ? clamp((8 - t.pitch) * 0.1 - r.ac.omega.x * 0.5, -0.3, 0.6) : 0;
    r.inp.roll = clamp(-t.bank * 0.05 + r.ac.omega.z * 0.4, -1, 1);
    r.inp.yaw = clamp(((hdg - t.heading + 540) % 360 - 180) * 0.08 + r.ac.beta * 1.5, -1, 1);
    if (!lift && t.wheelsOnGround === 0 && t.agl > 0.5) {
      lift = r.ac.pos.distanceTo(x0);
      liftKt = t.ias * 1.944;
    }
  });
  return { liftoffDistance: lift, liftoffKt: liftKt, climbFpm: r.ac.vel.y * 196.85, agl: tel().agl, crashed: r.ac.crashed };
}

export function restOnRunway(model: FlightModel, seconds = 10): { driftMm: number; rotDeg: number; maxSpeed: number } {
  const r = makeRig(model);
  placeOnRunway(r, 0, 200);
  r.inp.brake = 1;
  run(r, 3);
  const p0 = r.ac.pos.clone();
  const q0 = r.ac.q.clone();
  let d = 0;
  let a = 0;
  let v = 0;
  run(r, seconds, () => {
    d = Math.max(d, r.ac.pos.distanceTo(p0));
    a = Math.max(a, (r.ac.q.angleTo(q0) * 180) / Math.PI);
    v = Math.max(v, r.ac.vel.length());
  });
  return { driftMm: d * 1000, rotDeg: a, maxSpeed: v };
}

export function stall(model: FlightModel): { warnedBeforeStall: boolean; stalled: boolean; maxAlpha: number; altitudeLost: number; recovered: boolean } {
  const r = makeRig(model);
  r.ac.reset(-2000, 1500, 2000, 90, 36);
  run(r, 15, () => r.ap.update(r.ac, { heading: 90, altitude: 1500, speed: 36 }, r.ac.telemetry(r.env).ias, SIM_DT, r.inp));
  let warned = -1;
  let stalledAt = -1;
  const y0 = r.ac.pos.y;
  let minY = y0;
  let maxA = 0;
  r.inp.throttle = 0;
  r.inp.pitch = 0;
  run(r, 30, () => {
    const t = r.ac.telemetry(r.env);
    r.inp.roll = clamp(-t.bank * 0.03 + r.ac.omega.z * 0.3, -1, 1);
    if (stalledAt < 0) r.inp.pitch = Math.min(1, r.inp.pitch + SIM_DT * 0.08);
    if (t.stallWarning && warned < 0) warned = r.ac.time;
    if (t.stalled && stalledAt < 0) stalledAt = r.ac.time;
    minY = Math.min(minY, r.ac.pos.y);
    maxA = Math.max(maxA, t.alpha);
    if (stalledAt > 0) {
      const ts = r.ac.time - stalledAt;
      r.inp.throttle = ts > 1.5 ? 1 : 0;
      r.inp.pitch = ts < 2 ? -0.6 : clamp((5 - t.pitch) * 0.05 - r.ac.omega.x * 0.6, -1, 1);
    }
  });
  return {
    warnedBeforeStall: warned > 0 && (stalledAt < 0 || warned < stalledAt),
    stalled: stalledAt > 0,
    maxAlpha: maxA,
    altitudeLost: y0 - minY,
    recovered: !r.ac.crashed && r.ac.vel.y > -2 && r.ac.telemetry(r.env).ias > 30,
  };
}

export interface ApproachResult {
  touchdown: Touchdown | null;
  pastThreshold: number;
  centreline: number;
  crashed: boolean;
  crashReason: string;
  stoppedOnRunway: boolean;
  finalSpeed: number;
}

export interface StripLike {
  center: readonly [number, number];
  heading: number;
  halfLength: number;
  elevation: number;
}

/** Flies a 3.5° approach, flare and rollout to a strip (or water lane). Used by tests and the live autoland. */
export class ApproachController {
  phase: 'approach' | 'flare' | 'rollout' = 'approach';
  touchdown: Touchdown | null = null;
  readonly thr: [number, number];
  readonly aim: [number, number];
  readonly d: readonly [number, number];
  private readonly ap = new Autopilot();
  private readonly gs = (3.5 * Math.PI) / 180;

  readonly strip: StripLike;
  readonly water: boolean;

  constructor(strip: StripLike, water = false, aimDist = 120) {
    this.strip = strip;
    this.water = water;
    this.d = headingDir(strip.heading);
    this.thr = [strip.center[0] - this.d[0] * strip.halfLength, strip.center[1] - this.d[1] * strip.halfLength];
    this.aim = [this.thr[0] + this.d[0] * aimDist, this.thr[1] + this.d[1] * aimDist];
  }

  /** Initial state `dist` metres before the aim point, on the glide path. */
  place(ac: Aircraft, dist: number): void {
    const s = this.strip;
    ac.reset(this.aim[0] - this.d[0] * dist, s.elevation + 2.5 + dist * Math.tan(this.gs), this.aim[1] - this.d[1] * dist, s.heading, 31);
  }

  onTouchdown(t: Touchdown): void {
    if (!this.touchdown) {
      this.touchdown = t;
      this.phase = 'rollout';
    }
  }

  update(ac: Aircraft, env: WorldEnv, inp: PilotInput, dt: number): void {
    const s = this.strip;
    const t = ac.telemetry(env);
    const rx = ac.pos.x - this.aim[0];
    const rz = ac.pos.z - this.aim[1];
    const d = this.d;
    const along = rx * d[0] + rz * d[1];
    const across = -rx * d[1] + rz * d[0];
    const hdg = s.heading - clamp(across * 0.6, -25, 25);
    if (this.phase === 'approach') {
      const hTgt = s.elevation + 2.5 + Math.max(-along, 0) * Math.tan(this.gs);
      this.ap.update(ac, { heading: hdg, vs: -31 * Math.sin(this.gs) + clamp((hTgt - ac.pos.y) * 0.25, -3, 3), speed: 31, maxBank: 15 }, t.ias, dt, inp);
      if (t.agl < 9) this.phase = 'flare';
    } else if (this.phase === 'flare') {
      this.ap.update(ac, { heading: hdg, vs: -1, speed: 0, throttle: 0, maxBank: 8 }, t.ias, dt, inp);
      const pt = 7 - Math.max(t.agl, 0) * 0.35;
      inp.pitch = clamp((pt - t.pitch) * 0.12 - ac.omega.x * 0.8 + (-0.6 - t.vs) * 0.15, -1, 1);
      inp.throttle = 0;
    } else {
      const ts = ac.time - (this.touchdown?.time ?? ac.time);
      inp.throttle = 0;
      inp.roll = clamp(-t.bank * 0.05, -1, 1);
      inp.brake = this.water ? 0 : ts > 2 ? 1 : 0;
      inp.pitch = clamp(((ts < 3 ? 4 - ts * 1.5 : -1) - t.pitch) * 0.1 - ac.omega.x * 0.8, -1, 1);
      // keep straight: centreline + heading, with yaw-rate damping so the rollout never swerves
      inp.yaw = clamp(-across * 0.15 + (((s.heading - t.heading + 540) % 360) - 180) * 0.04 + ac.omega.y * 1.5, -1, 1);
    }
  }

  result(ac: Aircraft, env: WorldEnv): ApproachResult {
    const t0 = this.touchdown;
    const rel = t0 ? [t0.x - this.thr[0], t0.z - this.thr[1]] : [0, 0];
    return {
      touchdown: t0,
      pastThreshold: rel[0] * this.d[0] + rel[1] * this.d[1],
      centreline: -rel[0] * this.d[1] + rel[1] * this.d[0],
      crashed: ac.crashed,
      crashReason: ac.crashReason,
      stoppedOnRunway: env.onRunway(ac.pos.x, ac.pos.z) && ac.vel.length() < 0.5,
      finalSpeed: ac.vel.length(),
    };
  }
}

/** The landing mode's final for strip i (from approachStart), flown by the autoland as the debug hook flies it. */
export function landFromFinal(model: FlightModel, i: number): ApproachResult {
  const r = makeRig(model);
  const c = new ApproachController(STRIPS[i], false, landingAim(STRIPS[i]) + 10);
  placeInAir(r.ac, r.env, approachStart(i), 36);
  r.ac.configure(true, 2);
  Object.assign(r.inp, { throttle: 0.42, gearDown: true, flapNotch: 2 });
  r.ac.onTouchdown = (t) => c.onTouchdown(t);
  run(r, 200, () => c.update(r.ac, r.env, r.inp, SIM_DT));
  return c.result(r.ac, r.env);
}

/** Scripted approach and landing on a strip (or a virtual water lane). */
export function approach(model: FlightModel, strip: StripLike, dist = 2500, water = false, gearDownOnWater = false): ApproachResult {
  const r = makeRig(model);
  const c = new ApproachController(strip, water);
  c.place(r.ac, dist);
  r.inp.flapNotch = 2;
  r.inp.gearDown = !water || gearDownOnWater;
  r.ac.onTouchdown = (t) => c.onTouchdown(t);
  run(r, 130, () => c.update(r.ac, r.env, r.inp, SIM_DT));
  return c.result(r.ac, r.env);
}

export const WATER_LANE = { center: [3200, 2400] as const, heading: 95, halfLength: 600, elevation: -2.3 };

/**
 * Full-power take-off on the water with the gear up, from `start` along its heading, holding 9° of
 * pitch once flying, for `seconds`.
 */
export function waterTakeoff(model: FlightModel, start: { x: number; z: number; heading: number } = WATER_HOME, wind = { from: 40, speed: 4 }, seconds = 60): { distance: number; liftoffKt: number; agl: number; crashed: boolean; crashReason: string } {
  const r = makeRig(model);
  r.env.setWind(wind.from, wind.speed);
  r.env.follow(start.x, start.z);
  r.ac.reset(start.x, 2.0, start.z, start.heading, 0);
  r.inp.gearDown = false;
  r.inp.flapNotch = 1;
  run(r, 6);
  r.inp.throttle = 1;
  const x0 = r.ac.pos.clone();
  let dist = 0;
  let kt = 0;
  run(r, seconds, () => {
    const t = r.ac.telemetry(r.env);
    r.inp.pitch = clamp(((t.ias > 26 ? 9 : 4) - t.pitch) * 0.08 - r.ac.omega.x * 0.6, -1, 1);
    r.inp.roll = clamp(-t.bank * 0.04 + r.ac.omega.z * 0.3, -1, 1);
    r.inp.yaw = clamp((((start.heading - t.heading + 540) % 360) - 180) * 0.05 + r.ac.beta, -1, 1);
    if (!dist && r.ac.keelInWater === 0 && t.agl > 1) {
      dist = r.ac.pos.distanceTo(x0);
      kt = t.ias * 1.944;
    }
  });
  return { distance: dist, liftoffKt: kt, agl: r.ac.telemetry(r.env).agl, crashed: r.ac.crashed, crashReason: r.ac.crashReason };
}

/** Puts the aircraft in steady flight at `start`: `airspeed` m/s through the air, drifting with the wind there. */
export function placeInAir(ac: Aircraft, env: WorldEnv, start: { x: number; y: number; z: number; heading: number }, airspeed: number): void {
  env.follow(start.x, start.z);
  ac.reset(start.x, start.y, start.z, start.heading, airspeed);
  ac.vel.add(env.wind(start.x, start.y, start.z, 0, new THREE.Vector3()));
}

/**
 * From an airborne start (AIR_SPEED, 62 % power, gear down, flaps up, as the app places it), the
 * autopilot holds the start's heading and height for `seconds`.
 */
export function cruise(model: FlightModel, start: { x: number; y: number; z: number; heading: number }, wind = { from: 40, speed: 4 }, seconds = 60): { crashed: boolean; crashReason: string; minAgl: number } {
  const r = makeRig(model);
  r.env.setWind(wind.from, wind.speed);
  placeInAir(r.ac, r.env, start, AIR_SPEED);
  r.ac.configure(true, 0);
  Object.assign(r.inp, { throttle: 0.62, gearDown: true, flapNotch: 0 });
  let minAgl = Infinity;
  run(r, seconds, () => {
    const t = r.ac.telemetry(r.env);
    minAgl = Math.min(minAgl, t.agl);
    r.ap.update(r.ac, { heading: start.heading, altitude: start.y, speed: AIR_SPEED }, t.ias, SIM_DT, r.inp);
  });
  return { crashed: r.ac.crashed, crashReason: r.ac.crashReason, minAgl };
}

export interface DropResult {
  label: string;
  minTerrainClearance: number;
  minWaterClearance: number;
  restHeight: number;
  finalSpeed: number;
  crashed: boolean;
}

/** Drops the aircraft and records how far any contact point went below the drawn surface. */
export function drop(model: FlightModel, label: string, x: number, z: number, height: number, gearDown: boolean): DropResult {
  const r = makeRig(model);
  r.env.follow(x, z);
  const g = Math.max(drawnHeight(x, z, r.env.clip), 0);
  const P = new THREE.Vector3();
  const pts: [number, number, number][] = [
    [-1.3, -2.47, 0.45], [1.3, -2.47, 0.45], [-1.3, -2.37, -3.3], [1.3, -2.37, -3.3], [-1.3, -2.16, -0.9], [1.3, -2.16, -0.9],
    [0, -0.72, 0.6], [-7.3, 1.32, -0.2], [7.3, 1.32, -0.2], [0, -1.22, -4.55], [0, 0.35, 6.05],
  ];
  // spawn so that every point clears the surface by `height` (slopes put the uphill wheels higher)
  r.ac.reset(x, g + 2.5, z, 30, 0);
  let lowest = 1e9;
  for (const p of pts) {
    r.ac.toWorld(p, P);
    lowest = Math.min(lowest, P.y - Math.max(drawnHeight(P.x, P.z, r.env.clip), r.env.waterHeight(P.x, P.z, 0)));
  }
  r.ac.reset(x, g + 2.5 - lowest + height, z, 30, 0);
  r.inp.gearDown = gearDown;
  r.inp.brake = 1;
  let minT = 1e9;
  let minW = 1e9;
  run(r, 10, () => {
    for (const p of pts) {
      r.ac.toWorld(p, P);
      minT = Math.min(minT, P.y - drawnHeight(P.x, P.z, r.env.clip));
      minW = Math.min(minW, P.y - r.env.waterHeight(P.x, P.z, r.ac.time));
    }
  }, false);
  return { label, minTerrainClearance: minT, minWaterClearance: minW, restHeight: r.ac.pos.y - g, finalSpeed: r.ac.vel.length(), crashed: r.ac.crashed };
}
