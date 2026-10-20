// 6-DOF rigid-body flight model for the amphibian: per-surface aerodynamics, propeller,
// wheel and float contacts, crash detection and telemetry. Pure TS (three.js math only).
import * as THREE from 'three';
import { AIRCRAFT, DEG, type V3 } from './config.ts';
import { liftCoefficient, groundEffect, airDensity, type LiftResult } from './aero.ts';
import type { SurfaceSample } from '../world/clipmap.ts';

export type FlightModel = 'arcade' | 'assisted' | 'simulation';

/** Pilot intent (keyboard after smoothing). Axes in [-1, 1]. */
export interface PilotInput {
  /** + nose up */
  pitch: number;
  /** + roll right */
  roll: number;
  /** + yaw right */
  yaw: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  flapNotch: number;
  gearDown: boolean;
  /** elevator trim, -1..1 */
  trim: number;
}

export interface SimEnv {
  /** rendered terrain surface (height + triangle normal) */
  surface(x: number, z: number, out: SurfaceSample): SurfaceSample;
  waterHeight(x: number, z: number, t: number): number;
  /** wind velocity (air movement) at a point */
  wind(x: number, y: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3;
  /** true when (x, z) lies on a runway surface */
  onRunway(x: number, z: number): boolean;
}

export interface Touchdown {
  time: number;
  x: number;
  z: number;
  sinkRate: number;
  groundSpeed: number;
  bank: number;
  pitch: number;
  onWater: boolean;
  onRunway: boolean;
  gearDown: boolean;
}

export interface Telemetry {
  ias: number;
  tas: number;
  groundSpeed: number;
  altitude: number;
  agl: number;
  vs: number;
  heading: number;
  pitch: number;
  bank: number;
  alpha: number;
  beta: number;
  gLoad: number;
  throttle: number;
  rpm: number;
  flaps: number;
  flapNotch: number;
  gear: number;
  brake: number;
  onGround: boolean;
  onWater: boolean;
  wheelsOnGround: number;
  stallWarning: boolean;
  stalled: boolean;
  /** indicated airspeed above the red line (vne) */
  overspeed: boolean;
  crashed: boolean;
  crashReason: string;
  damage: string;
}

const G = 9.81;
const RHO_WATER = 1025;
const _r = new THREE.Vector3();
const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _lift: LiftResult = { cl: 0, stall: 0 };
const _surf: SurfaceSample = { h: 0, nx: 0, ny: 1, nz: 0, level: 0 };
// dedicated temporaries (never shared between helpers that call each other)
const _gA = new THREE.Vector3();
const _gB = new THREE.Vector3();
const _vAir = new THREE.Vector3();
const _vl = new THREE.Vector3();
const _span = new THREE.Vector3();
const _up = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _tq = new THREE.Vector3();
const FWD = new THREE.Vector3(0, 0, -1);
const _extra = new THREE.Vector3();
const _fwdW = new THREE.Vector3();
const _local = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _tLat = new THREE.Vector3();
const _tFwd = new THREE.Vector3();
const _p = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _vr = new THREE.Vector3();
const _vIas = new THREE.Vector3();
const _cn = new THREE.Vector3();

interface Contact {
  anchor: THREE.Vector3;
  active: boolean;
  /** was touching last step (for impact detection) */
  touching: boolean;
}

export class Aircraft {
  readonly pos = new THREE.Vector3();
  readonly q = new THREE.Quaternion();
  readonly vel = new THREE.Vector3();
  /** angular velocity, body frame */
  readonly omega = new THREE.Vector3();
  model: FlightModel = 'assisted';
  time = 0;

  // actuators
  throttle = 0;
  rpm = AIRCRAFT.idleRpm;
  flaps = 0;
  flapNotch = 0;
  gear = 1;
  elevator = 0;
  aileron = 0;
  rudder = 0;
  steer = 0;
  brakeL = 0;
  brakeR = 0;
  autoTrim = 0;
  engineOn = true;

  crashed = false;
  crashReason = '';
  damage = '';
  stalled = false;
  stallWarning = false;
  overspeed = false;
  /** wing panel stall fraction (left, right) */
  stallL = 0;
  stallR = 0;
  alpha = 0;
  beta = 0;
  thrust = 0;
  wheelsOnGround = 0;
  keelInWater = 0;
  keelOnGround = 0;
  airborneTime = 0;
  lastTouchdown: Touchdown | null = null;
  onTouchdown: ((t: Touchdown) => void) | null = null;
  onCrash: ((reason: string) => void) | null = null;
  /** splash/thump events for audio: impact speed (m/s) */
  onImpact: ((kind: 'wheel' | 'water' | 'scrape', speed: number) => void) | null = null;

  private readonly contacts = new Map<string, Contact>();
  private readonly force = new THREE.Vector3();
  private readonly torque = new THREE.Vector3();
  private readonly accel = new THREE.Vector3();
  private readonly windV = new THREE.Vector3();

  constructor() {
    for (const w of AIRCRAFT.wheels) this.contacts.set(w.name, { anchor: new THREE.Vector3(), active: false, touching: false });
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i < AIRCRAFT.keel.length; i++) this.contacts.set(`keel${s}${i}`, { anchor: new THREE.Vector3(), active: false, touching: false });
    }
  }

  // ---------------------------------------------------------------- frames

  toWorld(local: V3 | THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (local instanceof THREE.Vector3) out.copy(local);
    else out.set(local[0], local[1], local[2]);
    return out.applyQuaternion(this.q).add(this.pos);
  }
  dirToWorld(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, y, z).applyQuaternion(this.q);
  }
  forward(out: THREE.Vector3): THREE.Vector3 {
    return this.dirToWorld(0, 0, -1, out);
  }
  get heading(): number {
    const f = this.forward(_gA);
    let h = Math.atan2(f.x, -f.z) / DEG;
    if (h < 0) h += 360;
    return h;
  }
  get pitchAngle(): number {
    return Math.asin(THREE.MathUtils.clamp(this.forward(_gA).y, -1, 1)) / DEG;
  }
  get bankAngle(): number {
    const ry = this.dirToWorld(1, 0, 0, _gA).y;
    const upY = this.dirToWorld(0, 1, 0, _gB).y;
    return Math.atan2(-ry, upY) / DEG;
  }

  // ---------------------------------------------------------------- setup

  /** Place the aircraft. On the ground it is settled onto its wheels (or floats on water). */
  reset(x: number, y: number, z: number, headingDeg: number, speed: number, pitchDeg = 0): void {
    this.pos.set(x, y, z);
    const yaw = -headingDeg * DEG;
    this.q.setFromEuler(new THREE.Euler(pitchDeg * DEG, yaw, 0, 'YXZ'));
    this.forward(this.vel).multiplyScalar(speed);
    this.omega.set(0, 0, 0);
    this.crashed = false;
    this.crashReason = '';
    this.damage = '';
    // a crash stops the engine; a placed aircraft always starts with it running
    this.engineOn = true;
    this.stalled = false;
    this.overspeed = false;
    this.airborneTime = 0;
    this.lastTouchdown = null;
    this.throttle = speed > 1 ? 0.6 : 0;
    this.rpm = speed > 1 ? 1700 : AIRCRAFT.idleRpm;
    this.elevator = this.aileron = this.rudder = 0;
    this.autoTrim = 0;
    for (const c of this.contacts.values()) {
      c.active = false;
      c.touching = speed < 1;
    }
  }

  /**
   * Puts the gear and flaps where the controls set them, at once: a placed aircraft must not spend its
   * first seconds still moving them from the last flight (a runway start after a gear-up flight would
   * drop onto its floats).
   */
  configure(gearDown: boolean, flapNotch: number): void {
    this.gear = gearDown ? 1 : 0;
    this.flapNotch = THREE.MathUtils.clamp(Math.round(flapNotch), 0, AIRCRAFT.flapNotches.length - 1);
    this.flaps = AIRCRAFT.flapNotches[this.flapNotch];
  }

  // ---------------------------------------------------------------- simulation

  step(dt: number, input: PilotInput, env: SimEnv): void {
    this.time += dt;
    if (this.crashed) {
      // the wreck keeps its contacts (it rests on the ground or floats), engine dead, heavy damping
      this.engineOn = false;
      const dead: PilotInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1, flapNotch: this.flapNotch, gearDown: this.gear > 0.5, trim: 0 };
      this.updateActuators(dt, dead);
      this.vel.multiplyScalar(Math.max(0, 1 - dt * 0.8));
      this.omega.multiplyScalar(Math.max(0, 1 - dt * 1.5));
      for (let i = 0; i < 2; i++) this.substep(dt / 2, dead, env);
      return;
    }
    this.updateActuators(dt, input);
    const sub = 2;
    const h = dt / sub;
    for (let i = 0; i < sub; i++) this.substep(h, input, env);
    // telemetry helpers
    this.airborneTime = this.wheelsOnGround + this.keelInWater + this.keelOnGround > 0 ? 0 : this.airborneTime + dt;
  }

  private updateActuators(dt: number, input: PilotInput): void {
    const rate = (cur: number, target: number, r: number) => cur + THREE.MathUtils.clamp(target - cur, -r * dt, r * dt);
    this.throttle = rate(this.throttle, THREE.MathUtils.clamp(input.throttle, 0, 1), 1.2);
    const targetRpm = this.engineOn ? AIRCRAFT.idleRpm + (AIRCRAFT.maxRpm - AIRCRAFT.idleRpm) * Math.pow(this.throttle, 0.85) : 0;
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 1.8);
    this.flapNotch = THREE.MathUtils.clamp(Math.round(input.flapNotch), 0, AIRCRAFT.flapNotches.length - 1);
    this.flaps = rate(this.flaps, AIRCRAFT.flapNotches[this.flapNotch], 0.22);
    this.gear = rate(this.gear, input.gearDown ? 1 : 0, 0.22);
  }

  private wind(env: SimEnv, out: THREE.Vector3): THREE.Vector3 {
    env.wind(this.pos.x, this.pos.y, this.pos.z, this.time, out);
    return out;
  }

  /** Computes control surface positions from pilot input according to the flight model. */
  private controls(dt: number, input: PilotInput, extraTorque: THREE.Vector3): void {
    const m = this.model;
    const w = this.omega;
    const bank = this.bankAngle * DEG;
    const onGround = this.wheelsOnGround + this.keelOnGround + this.keelInWater > 0;
    const v = Math.max(this.vel.length(), 1);
    extraTorque.set(0, 0, 0);
    const stallLimit = (AIRCRAFT.surfaces[0].clmax / AIRCRAFT.surfaces[0].cla) + AIRCRAFT.surfaces[0].alpha0 - AIRCRAFT.surfaces[0].incidence + this.flaps * AIRCRAFT.flapStall;
    // high-speed protection (arcade, assisted): 0 below ~136 kt, 1 at the red line
    const vProt = AIRCRAFT.vne - 10;
    const over = THREE.MathUtils.clamp((this.indicatedAirspeed() - vProt) / (AIRCRAFT.vne - vProt), 0, 1.5);
    // a dive steeper than 12° nose down, with the stick released
    const released = Math.abs(input.pitch) < 0.05 && !onGround;
    const steep = released ? THREE.MathUtils.clamp((-this.pitchAngle - 12) / 10, 0, 1) : 0;
    if (m === 'arcade') {
      // rate command / attitude hold via assist torques; surfaces only add a little feel
      const I = AIRCRAFT.inertia;
      const airF = THREE.MathUtils.clamp((v - 8) / 20, 0, 1);
      let pitchRate = input.pitch * 0.7;
      // stall protection
      if (this.alpha > stallLimit - 3 * DEG) pitchRate = Math.min(pitchRate, -(this.alpha - (stallLimit - 3 * DEG)) * 3);
      // high-speed protection and dive recovery: the nose comes up by itself
      if (over + steep > 0) pitchRate = Math.max(pitchRate, (over + steep) * 0.25);
      const rollRate = input.roll !== 0 ? input.roll * 1.7 : -bank * 1.2;
      const yawRate = onGround ? input.yaw * 0.6 : (G * Math.tan(THREE.MathUtils.clamp(bank, -1.2, 1.2))) / v * Math.cos(bank) + input.yaw * 0.25;
      // desired body rates: pitch about +x, yaw about +y (left positive), roll about +z (left positive)
      const k = 5 * airF;
      extraTorque.set(I[0] * k * (pitchRate - w.x), I[1] * k * (-yawRate - w.y) * 0.7, I[2] * k * (-rollRate - w.z));
      this.elevator = input.pitch * 0.15;
      this.aileron = input.roll * 0.1;
      this.rudder = onGround ? input.yaw : THREE.MathUtils.clamp(this.beta * 2.5 + w.y * 0.4, -1, 1);
    } else if (m === 'assisted') {
      // auto-trim holds the attitude when the stick is released, but not a dive: near the red line or
      // beyond 12° nose down it trims the nose back up (a released stick never ends in an overspeed)
      if (released) this.autoTrim = THREE.MathUtils.clamp(this.autoTrim - w.x * dt * 1.5, -0.6, 0.6);
      if (released && over + steep > 0) this.autoTrim = THREE.MathUtils.clamp(this.autoTrim + (over + steep) * dt * 0.3, -0.6, 0.6);
      let elev = input.pitch + this.autoTrim + input.trim * 0.5;
      if (this.alpha > stallLimit - 2.5 * DEG) elev = Math.min(elev, -(this.alpha - (stallLimit - 2.5 * DEG)) * 6);
      // high-speed protection: nose-down authority fades out towards the red line
      if (over > 0) elev = Math.max(elev, over - 0.6);
      this.elevator = THREE.MathUtils.clamp(elev, -1, 1);
      const level = Math.abs(bank) < 35 * DEG && input.roll === 0 && !onGround;
      this.aileron = level ? THREE.MathUtils.clamp(-bank * 1.4 + w.z * 0.6, -0.6, 0.6) : input.roll;
      // yaw damper + turn coordination
      this.rudder = onGround ? input.yaw : THREE.MathUtils.clamp(input.yaw + this.beta * 3.5 + w.y * 0.4, -1, 1);
    } else {
      this.elevator = THREE.MathUtils.clamp(input.pitch + input.trim * 0.5, -1, 1);
      this.aileron = input.roll;
      this.rudder = input.yaw;
    }
    // nose-wheel steering (fades out with speed); differential braking in simulation
    const gs = this.vel.length();
    const steerMax = m === 'simulation' ? 14 * DEG : 32 * DEG;
    this.steer = input.yaw * steerMax * THREE.MathUtils.clamp(1 - (gs - 6) / 20, 0.15, 1);
    const b = THREE.MathUtils.clamp(input.brake, 0, 1);
    const diff = m === 'simulation' ? input.yaw * 0.6 : 0;
    this.brakeL = THREE.MathUtils.clamp(b * (1 - Math.max(0, diff)) + (b > 0 ? Math.max(0, -diff) * 0.4 : 0), 0, 1);
    this.brakeR = THREE.MathUtils.clamp(b * (1 - Math.max(0, -diff)) + (b > 0 ? Math.max(0, diff) * 0.4 : 0), 0, 1);
  }

  private substep(dt: number, input: PilotInput, env: SimEnv): void {
    const F = this.force.set(0, 0, 0); // world
    const M = this.torque.set(0, 0, 0); // body
    _qi.copy(this.q).invert();

    // ---- air
    const rho = airDensity(this.pos.y);
    this.wind(env, this.windV);
    const vAir = _vAir.copy(this.vel).sub(this.windV).applyQuaternion(_qi); // body-frame airspeed vector
    const V = vAir.length();
    const vFwd = -vAir.z;
    this.alpha = Math.atan2(-vAir.y, Math.max(vFwd, 0.1));
    this.beta = Math.atan2(vAir.x, Math.max(Math.hypot(vFwd, vAir.y), 0.1));

    this.controls(dt, input, _extra);
    M.add(_extra);

    // ---- propeller
    const area = Math.PI * AIRCRAFT.propRadius * AIRCRAFT.propRadius;
    const rpmF = THREE.MathUtils.clamp((this.rpm - AIRCRAFT.idleRpm * 0.8) / (AIRCRAFT.maxRpm - AIRCRAFT.idleRpm * 0.8), 0, 1);
    const P = AIRCRAFT.maxPower * Math.pow(rpmF, 1.6) * (rho / 1.225);
    const tStatic = 0.75 * Math.cbrt(2 * rho * area * P * P);
    const tDyn = (0.8 * P) / Math.max(vFwd, 1);
    const T = P > 1 ? 1 / Math.pow(1 / Math.pow(tStatic, 4) + 1 / Math.pow(tDyn, 4), 0.25) : 0;
    // windmilling drag at idle
    const thrust = T - (1 - rpmF) * 0.02 * rho * vFwd * Math.abs(vFwd);
    this.thrust = thrust;
    const vw = Math.sqrt(Math.max(vFwd * Math.abs(vFwd), 0) + (2 * Math.max(T, 0)) / (rho * area));
    const wash = Math.max(0, vw - Math.max(vFwd, 0));
    {
      _f.set(0, 0, -thrust);
      _r.set(AIRCRAFT.propPos[0], AIRCRAFT.propPos[1], AIRCRAFT.propPos[2]);
      M.add(_tq.crossVectors(_r, _f));
      F.add(_f.applyQuaternion(this.q));
      // torque reaction (roll left) and P-factor / slipstream swirl (yaw left)
      const k = this.model === 'simulation' ? 1 : this.model === 'assisted' ? 0.35 : 0;
      const omegaProp = Math.max(this.rpm, 300) * (2 * Math.PI / 60);
      M.z += k * 0.22 * (P / omegaProp);
      M.y += k * (thrust * THREE.MathUtils.clamp(this.alpha, -0.3, 0.4) * 0.35 + thrust * (wash / (vFwd + wash + 1)) * 0.22);
    }

    // ---- aerodynamic surfaces
    const flaps = this.flaps;
    let wingAlpha = 0;
    let stallSum = 0;
    const heightAbove = this.pos.y - this.groundLevel(env, this.pos.x, this.pos.z);
    const ge = groundEffect(heightAbove - 0.7, AIRCRAFT.wingSpan);
    const soft = this.model === 'arcade' ? 1 : 0;
    for (const s of AIRCRAFT.surfaces) {
      _r.set(s.pos[0], s.pos[1], s.pos[2]);
      // local airflow: body velocity + rotation, minus propwash on the tail
      const vl = _vl.crossVectors(this.omega, _r).add(vAir);
      vl.z -= wash * s.wash;
      const span = _span.set(s.span[0], s.span[1], s.span[2]);
      const vs = vl.addScaledVector(span, -vl.dot(span)); // section velocity
      const Vs = vs.length();
      if (Vs < 0.3) continue;
      // surface "up" = span × forward; alpha measured in the section plane
      const up = _up.crossVectors(span, FWD);
      const a = Math.atan2(-vs.dot(up), vs.dot(FWD));
      let aeff = a + s.incidence - s.alpha0;
      if (s.name === 'htail') aeff -= 0.32 * wingAlpha; // wing downwash
      let clmax = s.clmax;
      let cd0 = s.cd0;
      let dCl = 0;
      if (s.flaps) {
        clmax += AIRCRAFT.flapCl * flaps;
        aeff -= AIRCRAFT.flapStall * flaps * 0.5;
        dCl += AIRCRAFT.flapCl * flaps * 0.55;
        cd0 += AIRCRAFT.flapCd * flaps;
      }
      liftCoefficient(aeff, s.cla, clmax, soft, _lift);
      let cl = _lift.cl + dCl * (1 - _lift.stall * 0.5);
      const eff = 1 - 0.5 * _lift.stall;
      if (s.aileron) cl += s.aileron * this.aileron * eff;
      if (s.elevator) cl += s.elevator * this.elevator * eff;
      if (s.rudder) cl += s.rudder * this.rudder * eff;
      const isWing = s.flaps === true;
      if (isWing) {
        wingAlpha += a * 0.5;
        stallSum += _lift.stall;
        if (s.name === 'wingL') this.stallL = _lift.stall;
        else this.stallR = _lift.stall;
      }
      const cdi = (cl * cl) / (Math.PI * s.oswald * s.aspect) * (isWing ? ge : 1);
      const cdStall = 1.1 * Math.pow(Math.sin(aeff), 2) * _lift.stall;
      const cd = cd0 + cdi + cdStall;
      const qd = 0.5 * rho * Vs * Vs * s.area;
      const liftDir = _ld.crossVectors(span, vs).normalize();
      const fx = qd * (cl * liftDir.x - (cd * vs.x) / Vs);
      const fy = qd * (cl * liftDir.y - (cd * vs.y) / Vs);
      const fz = qd * (cl * liftDir.z - (cd * vs.z) / Vs);
      _f.set(fx, fy, fz);
      M.add(_tq.crossVectors(_r, _f));
      F.add(_f.applyQuaternion(this.q));
      if (isWing) {
        // camber + flap pitching moment
        M.x += 0.5 * rho * Vs * Vs * s.area * AIRCRAFT.chord * (-0.035 + AIRCRAFT.flapCm * flaps);
      }
    }
    this.stalled = stallSum > 0.6;
    this.stallWarning = this.wheelsOnGround === 0 && this.keelInWater === 0 && V > 8 && this.alpha > (AIRCRAFT.surfaces[0].clmax / AIRCRAFT.surfaces[0].cla) + AIRCRAFT.surfaces[0].alpha0 - AIRCRAFT.surfaces[0].incidence + flaps * AIRCRAFT.flapStall - 3 * DEG;

    // ---- body drag (fuselage, floats, gear)
    {
      const bd = AIRCRAFT.bodyDrag;
      const az = bd[2] + AIRCRAFT.gearDragArea * this.gear;
      _f.set(-0.5 * rho * bd[0] * vAir.x * Math.abs(vAir.x), -0.5 * rho * bd[1] * vAir.y * Math.abs(vAir.y), -0.5 * rho * az * vAir.z * Math.abs(vAir.z));
      F.add(_f.applyQuaternion(this.q));
      // rotational damping of the whole airframe (small, mostly from surfaces already)
      M.addScaledVector(this.omega, -0.5 * rho * V * 40);
    }

    // ---- gravity
    F.y -= AIRCRAFT.mass * G;

    // ---- contacts (world forces, body torques)
    this.contactForces(env, F, M);

    // ---- integrate (semi-implicit Euler)
    this.accel.copy(F).multiplyScalar(1 / AIRCRAFT.mass);
    this.vel.addScaledVector(this.accel, dt);
    this.pos.addScaledVector(this.vel, dt);
    const I = AIRCRAFT.inertia;
    const w = this.omega;
    // gyroscopic term ω × Iω
    const gx = w.y * I[2] * w.z - w.z * I[1] * w.y;
    const gy = w.z * I[0] * w.x - w.x * I[2] * w.z;
    const gz = w.x * I[1] * w.y - w.y * I[0] * w.x;
    w.x += ((M.x - gx) / I[0]) * dt;
    w.y += ((M.y - gy) / I[1]) * dt;
    w.z += ((M.z - gz) / I[2]) * dt;
    const ang = w.length() * dt;
    if (ang > 1e-9) {
      _q.setFromAxisAngle(_tq.copy(w).normalize(), ang);
      this.q.multiply(_q).normalize();
    }
    this.checkStructure();
  }

  /** Highest of terrain and water under (x, z). */
  groundLevel(env: SimEnv, x: number, z: number): number {
    return Math.max(env.surface(x, z, _surf).h, env.waterHeight(x, z, this.time));
  }

  /** Indicated airspeed (m/s): airspeed scaled by air density, as the airspeed indicator shows it. */
  indicatedAirspeed(): number {
    return _vIas.copy(this.vel).sub(this.windV).length() * Math.sqrt(airDensity(this.pos.y) / 1.225);
  }

  private checkStructure(): void {
    if (this.crashed) return;
    // speed limits are indicated airspeed, like the red line on the airspeed indicator: not ground
    // speed, which grows with altitude (thin air) and with a tailwind
    const ias = this.indicatedAirspeed();
    this.overspeed = ias > AIRCRAFT.vne && this.wheelsOnGround === 0;
    if (ias > AIRCRAFT.vBreak) this.crash('overspeed: structural failure');
    const g = Math.abs(this.accel.y / G + 1);
    if (g > 7.5 && this.wheelsOnGround === 0) this.crash('over-g: structural failure');
  }

  crash(reason: string): void {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.onCrash?.(reason);
  }

  /**
   * Deep penetration can only come from a teleport or a level-of-detail change of the drawn surface
   * (camera cut): lift the aircraft out by position, without injecting energy.
   */
  private resolveDeepPenetration(env: SimEnv): void {
    let worst = 0;
    const p = _p;
    const ext = (1 - this.gear) * 0.34;
    const check = (x: number, y: number, z: number) => {
      _local.set(x, y, z);
      this.toWorld(_local, p);
      const h = env.surface(p.x, p.z, _surf).h;
      worst = Math.max(worst, (h - p.y) * _surf.ny);
    };
    for (const w of AIRCRAFT.wheels) if (this.gear > 0.3) check(w.pos[0], w.pos[1] + ext, w.pos[2]);
    for (const s of [-1, 1]) for (const k of AIRCRAFT.keel) check(s * AIRCRAFT.floatX, k[1], k[0]);
    const allowed = 0.3;
    if (worst > allowed) {
      this.pos.y += worst - allowed * 0.5;
      if (this.vel.y < 0) this.vel.y = 0;
    }
  }

  private contactForces(env: SimEnv, F: THREE.Vector3, M: THREE.Vector3): void {
    this.resolveDeepPenetration(env);
    let wheels = 0;
    let keelWater = 0;
    let keelGround = 0;
    const t = this.time;
    const p = _p;
    const vc = _vc;
    const applyAt = (local: THREE.Vector3, fWorld: THREE.Vector3) => {
      // torque = r × F in body frame
      const fb = _f.copy(fWorld).applyQuaternion(_qi);
      M.x += local.y * fb.z - local.z * fb.y;
      M.y += local.z * fb.x - local.x * fb.z;
      M.z += local.x * fb.y - local.y * fb.x;
      F.add(fWorld);
    };
    const pointVel = (local: THREE.Vector3, out: THREE.Vector3) => {
      out.crossVectors(this.omega, local).applyQuaternion(this.q).add(this.vel);
      return out;
    };
    const fwd = this.forward(_fwdW);
    const local = _local;
    const fw = _fw;
    const tdLat = _tLat;
    const tdFwd = _tFwd;

    // ---- wheels (extend with the gear)
    const ext = (1 - this.gear) * 0.34;
    for (const wdef of AIRCRAFT.wheels) {
      const c = this.contacts.get(wdef.name)!;
      local.set(wdef.pos[0], wdef.pos[1] + ext, wdef.pos[2]);
      this.toWorld(local, p);
      env.surface(p.x, p.z, _surf);
      const n = _cn.set(_surf.nx, _surf.ny, _surf.nz);
      const water = env.waterHeight(p.x, p.z, t);
      // wheels in water: heavy hydrodynamic drag (gear down on water flips the aircraft)
      const sub = water - p.y;
      if (sub > 0 && this.gear > 0.5) {
        pointVel(local, vc);
        const k = this.model === 'arcade' ? 0.15 : 1;
        const area = 0.16 * Math.min(1, sub / 0.3) * this.gear * k;
        fw.copy(vc).multiplyScalar(-0.5 * RHO_WATER * area * vc.length());
        applyAt(local, fw);
      }
      const pen = (_surf.h - p.y) * n.y;
      if (pen <= 0 || this.gear < 0.3) {
        c.active = false;
        c.touching = false;
        continue;
      }
      wheels++;
      pointVel(local, vc);
      const vn = vc.dot(n);
      if (!c.touching) {
        c.touching = true;
        this.onImpact?.('wheel', -vn);
        this.registerTouchdown(env, -vn, false);
        const limit = this.model === 'arcade' ? 5.5 : 4.0;
        if (-vn > limit) this.crash(`gear collapsed (sink ${(-vn * 196.85).toFixed(0)} fpm)`);
        const steep = Math.acos(THREE.MathUtils.clamp(n.y, -1, 1));
        if (steep > 16 * DEG && this.vel.length() > 5) this.crash('touched down on rough terrain');
      }
      const Fn = Math.max(0, wdef.k * pen - wdef.c * vn);
      // tangent frame: rolling direction from the (steered) heading
      tdFwd.copy(fwd);
      if (!wdef.main && Math.abs(this.steer) > 1e-4) tdFwd.applyAxisAngle(n, -this.steer);
      tdFwd.addScaledVector(n, -tdFwd.dot(n)).normalize();
      tdLat.crossVectors(tdFwd, n);
      const vLong = vc.dot(tdFwd);
      const vLat = vc.dot(tdLat);
      const brake = wdef.main ? (wdef.pos[0] < 0 ? this.brakeL : this.brakeR) : 0;
      const onRwy = env.onRunway(p.x, p.z);
      const roll = onRwy ? 0.018 : 0.06;
      const mu = onRwy ? 0.8 : 0.55;
      // longitudinal: rolling resistance + brakes (smooth through zero)
      let fLong = -Fn * (roll * Math.tanh(vLong / 0.4) + brake * 0.55 * Math.tanh(vLong / 0.25));
      // lateral: anchored "bristle" friction → no creep or jitter at rest
      if (!c.active) {
        c.anchor.copy(p);
        c.active = true;
      }
      const d = fw.copy(p).sub(c.anchor);
      const dLat = d.dot(tdLat);
      const dLong = d.dot(tdFwd);
      const kt = 2.2e5 * (Fn / (AIRCRAFT.mass * G * 0.5) + 0.05);
      const ct = 2 * Math.sqrt(kt * AIRCRAFT.mass * 0.3);
      let fLat = -kt * dLat - ct * vLat;
      const latMax = mu * Fn * (wdef.main ? 1 : this.model === 'simulation' ? 0.35 : 0.9);
      if (Math.abs(fLat) > latMax) {
        // sliding: move the anchor so the spring holds exactly the friction limit
        fLat = Math.sign(fLat) * latMax;
        c.anchor.addScaledVector(tdLat, dLat + fLat / kt);
      }
      // longitudinal anchor only while braked and nearly stopped (parking)
      if (brake > 0.5 && Math.abs(vLong) < 0.3) {
        const lmax = mu * Fn * brake;
        let fl = -kt * dLong - ct * vLong;
        if (Math.abs(fl) > lmax) {
          fl = Math.sign(fl) * lmax;
          c.anchor.addScaledVector(tdFwd, dLong + fl / kt);
        }
        fLong = fl;
      } else {
        c.anchor.addScaledVector(tdFwd, dLong);
      }
      fw.copy(n).multiplyScalar(Fn).addScaledVector(tdFwd, fLong).addScaledVector(tdLat, fLat);
      applyAt(local, fw);
    }

    // ---- floats: buoyancy, hydrodynamics, and sliding on land
    const keel = AIRCRAFT.keel;
    const nK = keel.length;
    for (let side = 0; side < 2; side++) {
      const x = side === 0 ? -AIRCRAFT.floatX : AIRCRAFT.floatX;
      for (let i = 0; i < nK; i++) {
        const c = this.contacts.get(`keel${side}${i}`)!;
        local.set(x, keel[i][1], keel[i][0]);
        this.toWorld(local, p);
        pointVel(local, vc);
        // water
        const wh = env.waterHeight(p.x, p.z, t);
        const depth = wh - p.y;
        if (depth > 0) {
          keelWater++;
          if (!c.touching && this.airborneTime > 0.2) {
            this.onImpact?.('water', Math.max(0, -vc.y));
            this.registerTouchdown(env, -vc.y, true);
            const limit = this.model === 'arcade' ? 5 : 3.4;
            if (-vc.y > limit) this.crash(`floats struck the water too hard (${(-vc.y * 196.85).toFixed(0)} fpm)`);
          }
          c.touching = true;
          const s = Math.min(depth, AIRCRAFT.floatDepth);
          // buoyancy (Archimedes on this slice)
          const fb = RHO_WATER * G * AIRCRAFT.keelArea * s;
          // water surface vertical speed (finite difference) for relative damping
          const wh2 = env.waterHeight(p.x, p.z, t + 0.02);
          const vWater = (wh2 - wh) / 0.02;
          const vRel = _vr.copy(vc);
          vRel.y -= vWater;
          const vb = vRel.applyQuaternion(_qi); // body frame
          const frac = Math.min(1, s / 0.35);
          // forward: low drag with a hump before planing; lateral: keel; vertical: heave damping
          const vf = vb.z;
          const hump = 1 + 1.4 * Math.exp(-Math.pow((Math.abs(vf) - 8) / 4, 2));
          const fbx = -0.5 * RHO_WATER * 0.5 * frac * vb.x * Math.abs(vb.x);
          const fby = -0.5 * RHO_WATER * 0.9 * frac * vb.y * Math.abs(vb.y) - 1800 * frac * vb.y;
          const fbz = -0.5 * RHO_WATER * 0.0024 * hump * frac * vf * Math.abs(vf);
          fw.set(fbx, fby, fbz).applyQuaternion(this.q);
          // planing lift: dynamic pressure on the wetted bottom, rising with trim (Savitsky-like);
          // a wet bow lifts the nose, which keeps the floats from digging in
          const trimDeg = THREE.MathUtils.clamp(this.pitchAngle + 1.5 + (i < 2 ? 3 : 0), 0, 12);
          const clp = 0.012 * Math.pow(trimDeg, 1.1);
          const plane = 0.5 * RHO_WATER * vf * vf * 0.22 * frac * clp;
          fw.y += fb + plane;
          applyAt(local, fw);
        } else if (wh < p.y - 0.05) {
          c.touching = false;
        }
        // land under the float (beaching / gear-up landing)
        env.surface(p.x, p.z, _surf);
        const n = _cn.set(_surf.nx, _surf.ny, _surf.nz);
        const pen = (_surf.h - p.y) * n.y;
        if (pen > 0) {
          keelGround++;
          const vn = vc.dot(n);
          if (!c.active && this.airborneTime > 0.2 && depth <= 0) {
            this.onImpact?.('scrape', -vn);
            this.registerTouchdown(env, -vn, false);
            if (this.gear < 0.5 && this.vel.length() > 8) this.damage = 'gear-up landing: floats damaged';
            if (-vn > 4) this.crash('hull impact on land');
          }
          c.active = true;
          const Fn = Math.max(0, 1.6e5 * pen - 1.2e4 * vn);
          const vt = fw.copy(vc).addScaledVector(n, -vn);
          const vtl = vt.length();
          const mu = 0.45;
          if (vtl > 1e-5) fw.copy(vt).multiplyScalar((-mu * Fn * Math.tanh(vtl / 0.04)) / vtl);
          else fw.set(0, 0, 0);
          fw.addScaledVector(n, Fn);
          applyAt(local, fw);
        } else {
          c.active = false;
        }
      }
    }

    // ---- crash points (after a crash they act as plain contacts so the wreck rests on the surface)
    for (const cp of AIRCRAFT.crashPoints) {
      local.set(cp.pos[0], cp.pos[1], cp.pos[2]);
      this.toWorld(local, p);
      env.surface(p.x, p.z, _surf);
      const water = env.waterHeight(p.x, p.z, t);
      const pen = (_surf.h - p.y) * _surf.ny;
      if (!this.crashed) {
        if (pen > 0) this.crash(`${cp.name} struck the ground`);
        else if (p.y < water - 0.1) this.crash(cp.name === 'propeller' ? 'propeller hit the water' : `${cp.name} dug into the water`);
      }
      if (this.crashed && pen > 0) {
        pointVel(local, vc);
        const n = _cn.set(_surf.nx, _surf.ny, _surf.nz);
        const vn = vc.dot(n);
        const Fn = Math.max(0, 8.0e5 * pen - 6.0e4 * vn);
        const vt = fw.copy(vc).addScaledVector(n, -vn);
        const vtl = vt.length();
        if (vtl > 1e-5) vt.multiplyScalar((-0.65 * Fn * Math.tanh(vtl / 0.04)) / vtl);
        else vt.set(0, 0, 0);
        fw.addScaledVector(n, Fn);
        applyAt(local, fw);
      }
    }
    // capsized on water
    if (keelWater > 0 && this.dirToWorld(0, 1, 0, _gB).y < 0.15) this.crash('capsized');

    this.wheelsOnGround = wheels;
    this.keelInWater = keelWater;
    this.keelOnGround = keelGround;
  }

  private registerTouchdown(env: SimEnv, sink: number, water: boolean): void {
    if (this.airborneTime < 0.5 || this.crashed) return;
    const td: Touchdown = {
      time: this.time,
      x: this.pos.x,
      z: this.pos.z,
      sinkRate: sink,
      groundSpeed: Math.hypot(this.vel.x, this.vel.z),
      bank: this.bankAngle,
      pitch: this.pitchAngle,
      onWater: water,
      onRunway: env.onRunway(this.pos.x, this.pos.z),
      gearDown: this.gear > 0.9,
    };
    this.airborneTime = 0;
    this.lastTouchdown = td;
    this.onTouchdown?.(td);
  }

  telemetry(env: SimEnv, out: Partial<Telemetry> = {}): Telemetry {
    const rho = airDensity(this.pos.y);
    this.wind(env, this.windV);
    const tas = _vr.copy(this.vel).sub(this.windV).length();
    const t = out as Telemetry;
    t.tas = tas;
    t.ias = tas * Math.sqrt(rho / 1.225);
    t.groundSpeed = Math.hypot(this.vel.x, this.vel.z);
    t.altitude = this.pos.y;
    t.agl = this.pos.y - 2.2 - this.groundLevel(env, this.pos.x, this.pos.z);
    t.vs = this.vel.y;
    t.heading = this.heading;
    t.pitch = this.pitchAngle;
    t.bank = this.bankAngle;
    t.alpha = this.alpha / DEG;
    t.beta = this.beta / DEG;
    t.gLoad = _vr.copy(this.accel).applyQuaternion(_qi.copy(this.q).invert()).y / G + this.dirToWorld(0, 1, 0, _gB).y;
    t.throttle = this.throttle;
    t.rpm = this.rpm;
    t.flaps = this.flaps;
    t.flapNotch = this.flapNotch;
    t.gear = this.gear;
    t.brake = Math.max(this.brakeL, this.brakeR);
    t.onGround = this.wheelsOnGround > 0 || this.keelOnGround > 0;
    t.onWater = this.keelInWater > 0;
    t.wheelsOnGround = this.wheelsOnGround;
    t.stallWarning = this.stallWarning;
    t.stalled = this.stalled;
    t.overspeed = this.overspeed;
    t.crashed = this.crashed;
    t.crashReason = this.crashReason;
    t.damage = this.damage;
    return t;
  }
}
