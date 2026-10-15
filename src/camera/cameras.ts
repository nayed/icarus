// Chase, cockpit and cinematic cameras. All are kept above the drawn terrain and the sea.
import * as THREE from 'three';
import { AIRCRAFT, DEG } from '../sim/config.ts';
import { STRIPS, headingDir } from '../world/params.ts';

export type CameraMode = 'chase' | 'cockpit' | 'cinematic';

export interface CameraEnv {
  groundAt(x: number, z: number): number;
}

interface Pose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
}

type ShotKind = 'flyby' | 'telephoto' | 'wing' | 'orbit' | 'tower' | 'low';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * Vertical FOV for the screen: the modes are framed for landscape screens; on screens narrower than
 * square (phones in portrait) the vertical FOV opens up to keep a square screen's horizontal view.
 */
export function screenFov(fov: number, aspect: number): number {
  if (aspect >= 1) return fov;
  const t = Math.tan(THREE.MathUtils.degToRad(fov) / 2) / aspect;
  return Math.min(100, THREE.MathUtils.radToDeg(2 * Math.atan(t)));
}
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  mode: CameraMode = 'chase';
  /** mouse look offsets (radians) */
  lookYaw = 0;
  lookPitch = 0;
  private lookHold = 0;
  private readonly chasePos = new THREE.Vector3();
  private readonly chaseUp = new THREE.Vector3(0, 1, 0);
  private chaseInit = false;
  private shot: ShotKind = 'flyby';
  private shotTime = 0;
  private shotDur = 9;
  private readonly shotPos = new THREE.Vector3();
  private shotFov = 40;
  /** vertical FOV as framed for a landscape screen (see screenFov) */
  private fov = 60;
  private orbitAng = 0;
  private shotIndex = 0;
  /** smoothing for cinematic tracking */
  private readonly trackDir = new THREE.Vector3(0, 0, -1);

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly env: CameraEnv) {}

  /** Forget smoothed state (after a teleport). */
  snap(): void {
    this.chaseInit = false;
    this.shotTime = 1e9;
  }

  setMode(m: CameraMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.chaseInit = false;
    this.shotTime = 1e9;
    this.lookYaw = this.lookPitch = 0;
  }

  cycle(): CameraMode {
    const order: CameraMode[] = ['chase', 'cockpit', 'cinematic'];
    this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
    return this.mode;
  }

  /** Mouse drag deltas (pixels). */
  look(dx: number, dy: number): void {
    this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - dx * 0.004, -2.6, 2.6);
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * 0.004, -1.0, 1.2);
    this.lookHold = 1.5;
  }

  private clampAbove(p: THREE.Vector3, margin: number): void {
    const g = Math.max(this.env.groundAt(p.x, p.z), 0.6);
    if (p.y < g + margin) p.y = g + margin;
  }

  update(dt: number, pose: Pose): void {
    const cam = this.camera;
    if (this.lookHold > 0) this.lookHold -= dt;
    else if (this.mode !== 'cockpit') {
      const k = Math.min(1, dt * 1.5);
      this.lookYaw -= this.lookYaw * k;
      this.lookPitch -= this.lookPitch * k;
    }
    if (this.mode === 'cockpit') this.cockpit(pose);
    else if (this.mode === 'chase') this.chase(dt, pose);
    else this.cinematic(dt, pose);
    cam.fov = screenFov(this.fov, cam.aspect);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  private chase(dt: number, pose: Pose): void {
    const cam = this.camera;
    const fwd = _v.set(0, 0, -1).applyQuaternion(pose.quat);
    // follow the flight path when moving, the nose when slow
    const speed = pose.vel.length();
    const dir = _v2.copy(pose.vel).normalize();
    if (speed > 8) fwd.lerp(dir, 0.6).normalize();
    const flat = Math.hypot(fwd.x, fwd.z) > 1e-3 ? fwd : _v.set(0, 0, -1);
    // orbit offsets from mouse look
    const yaw = this.lookYaw;
    const pitch = THREE.MathUtils.clamp(0.16 + this.lookPitch * 0.8, -0.4, 1.3);
    const back = new THREE.Vector3(-flat.x, 0, -flat.z).normalize();
    back.applyAxisAngle(UP, yaw);
    const dist = 15.5;
    const target = new THREE.Vector3()
      .copy(pose.pos)
      .addScaledVector(back, dist * Math.cos(pitch))
      .addScaledVector(UP, dist * Math.sin(pitch) + 2.2 - Math.min(fwd.y, 0) * 4);
    if (!this.chaseInit) {
      this.chasePos.copy(target);
      this.chaseInit = true;
    }
    const k = 1 - Math.exp(-dt * 5.5);
    this.chasePos.lerp(target, k);
    this.clampAbove(this.chasePos, 1.4);
    cam.position.copy(this.chasePos);
    // bank the horizon a little with the aircraft
    const planeUp = _v2.set(0, 1, 0).applyQuaternion(pose.quat);
    this.chaseUp.lerp(_v.copy(UP).lerp(planeUp, 0.28).normalize(), Math.min(1, dt * 3));
    cam.up.copy(this.chaseUp);
    const look = new THREE.Vector3().copy(pose.pos).addScaledVector(fwd, 6).addScaledVector(UP, 1.2);
    cam.lookAt(look);
    this.fov = THREE.MathUtils.lerp(this.fov, 58 + Math.min(speed, 60) * 0.12, Math.min(1, dt * 2));
    cam.near = 0.25;
  }

  private cockpit(pose: Pose): void {
    const cam = this.camera;
    _v.set(AIRCRAFT.eye[0], AIRCRAFT.eye[1], AIRCRAFT.eye[2]).applyQuaternion(pose.quat).add(pose.pos);
    cam.position.copy(_v);
    // looking a little down: the runway over the nose and both rows of instruments in view
    _q.setFromEuler(new THREE.Euler(this.lookPitch - 6 * DEG, this.lookYaw, 0, 'YXZ'));
    cam.quaternion.copy(pose.quat).multiply(_q);
    cam.up.set(0, 1, 0);
    this.fov = 76;
    cam.near = 0.05;
  }

  private pickShot(pose: Pose): void {
    const kinds: ShotKind[] = ['flyby', 'telephoto', 'wing', 'flyby', 'orbit', 'low'];
    // a tower shot when close to a strip
    for (const s of STRIPS) {
      if (Math.hypot(pose.pos.x - s.center[0], pose.pos.z - s.center[1]) < 1800 && pose.pos.y - s.elevation < 250) {
        kinds.splice(1, 0, 'tower');
        break;
      }
    }
    this.shot = kinds[this.shotIndex++ % kinds.length];
    this.shotTime = 0;
    const v = pose.vel.length() > 5 ? _v.copy(pose.vel).normalize() : _v.set(0, 0, -1).applyQuaternion(pose.quat);
    const side = new THREE.Vector3(-v.z, 0, v.x).normalize();
    const sgn = this.shotIndex % 2 ? 1 : -1;
    const lead = Math.max(pose.vel.length(), 15);
    switch (this.shot) {
      case 'flyby':
        // stand ahead of the aircraft, slightly off its track
        this.shotPos.copy(pose.pos).addScaledVector(v, lead * 5).addScaledVector(side, sgn * 28).add(_v2.set(0, 6, 0));
        this.shotFov = 34;
        this.shotDur = 9;
        break;
      case 'low':
        this.shotPos.copy(pose.pos).addScaledVector(v, lead * 4).addScaledVector(side, sgn * 60);
        this.shotPos.y = Math.max(this.env.groundAt(this.shotPos.x, this.shotPos.z), 0.6) + 2.5;
        this.shotFov = 26;
        this.shotDur = 9;
        break;
      case 'telephoto':
        this.shotPos.copy(pose.pos).addScaledVector(v, -lead * 2).addScaledVector(side, sgn * 140).add(_v2.set(0, 45, 0));
        this.shotFov = 14;
        this.shotDur = 10;
        break;
      case 'wing':
        this.shotDur = 8;
        this.shotFov = 66;
        break;
      case 'orbit':
        this.orbitAng = Math.atan2(side.z, side.x);
        this.shotDur = 11;
        this.shotFov = 48;
        break;
      case 'tower': {
        let best = STRIPS[0];
        let bd = 1e9;
        for (const s of STRIPS) {
          const d = Math.hypot(pose.pos.x - s.center[0], pose.pos.z - s.center[1]);
          if (d < bd) {
            bd = d;
            best = s;
          }
        }
        const hd = headingDir(best.heading);
        this.shotPos.set(best.center[0] - hd[1] * 60, best.elevation + 9, best.center[1] + hd[0] * 60);
        this.shotFov = 30;
        this.shotDur = 12;
        break;
      }
    }
    this.clampAbove(this.shotPos, 2);
  }

  private cinematic(dt: number, pose: Pose): void {
    const cam = this.camera;
    this.shotTime += dt;
    const dist = cam.position.distanceTo(pose.pos);
    if (this.shotTime > this.shotDur || (this.shot !== 'wing' && this.shot !== 'orbit' && dist > 1400) || this.shotTime > 1e8) this.pickShot(pose);
    if (this.shot === 'wing') {
      _v.set(-7.0, 1.9, 1.2).applyQuaternion(pose.quat).add(pose.pos);
      cam.position.copy(_v);
      cam.up.set(0, 1, 0).applyQuaternion(pose.quat);
      cam.lookAt(_v2.set(-0.5, 0.6, -5).applyQuaternion(pose.quat).add(pose.pos));
    } else if (this.shot === 'orbit') {
      this.orbitAng += dt * 0.22;
      cam.position.set(pose.pos.x + Math.cos(this.orbitAng) * 32, pose.pos.y + 7, pose.pos.z + Math.sin(this.orbitAng) * 32);
      this.clampAbove(cam.position, 2);
      cam.up.set(0, 1, 0);
      cam.lookAt(pose.pos);
    } else {
      cam.position.copy(this.shotPos);
      cam.up.set(0, 1, 0);
      // smooth tracking (a camera operator, not a gimbal lock)
      const want = _v.copy(pose.pos).sub(cam.position).normalize();
      if (this.shotTime < dt * 1.5) this.trackDir.copy(want);
      this.trackDir.lerp(want, Math.min(1, dt * 6)).normalize();
      cam.lookAt(_v2.copy(cam.position).add(this.trackDir));
    }
    this.fov = THREE.MathUtils.lerp(this.fov, this.shotFov, Math.min(1, dt * 4));
    if (this.shotTime < dt * 1.5) this.fov = this.shotFov;
    cam.near = 0.3;
  }
}
