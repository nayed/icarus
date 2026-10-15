// Simple autopilot used by tests, the attract-mode flight and scripted demos.
// Holds a heading, an altitude (or vertical speed / glide path) and an airspeed through PilotInput.
import * as THREE from 'three';
import type { Aircraft, PilotInput } from './aircraft.ts';

export interface ApTarget {
  heading: number;
  /** altitude hold (m) unless vs is set */
  altitude?: number;
  /** vertical speed (m/s) */
  vs?: number;
  /** indicated airspeed target (m/s) */
  speed: number;
  /** optional fixed throttle (otherwise speed hold) */
  throttle?: number;
  maxBank?: number;
}

function wrap180(a: number): number {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

export class Autopilot {
  private iPitch = 3;
  private iThr = 0.5;

  reset(): void {
    this.iPitch = 3;
    this.iThr = 0.5;
  }

  update(ac: Aircraft, tgt: ApTarget, ias: number, dt: number, out: PilotInput): PilotInput {
    // lateral: heading error → bank → roll (with roll-rate damping)
    const hdgErr = wrap180(tgt.heading - ac.heading);
    const maxBank = tgt.maxBank ?? 25;
    const bankCmd = THREE.MathUtils.clamp(hdgErr * 1.5, -maxBank, maxBank);
    out.roll = THREE.MathUtils.clamp((bankCmd - ac.bankAngle) * 0.05 + ac.omega.z * 0.5, -1, 1);
    out.yaw = THREE.MathUtils.clamp(ac.beta * 2 + ac.omega.y * 0.3, -0.5, 0.5);
    // vertical: altitude → vertical speed → pitch attitude → elevator
    const vsCmd = tgt.vs ?? THREE.MathUtils.clamp(((tgt.altitude ?? ac.pos.y) - ac.pos.y) * 0.15, -5, 5);
    const vsErr = vsCmd - ac.vel.y;
    this.iPitch = THREE.MathUtils.clamp(this.iPitch + vsErr * dt * 0.6, -8, 14);
    const pitchCmd = THREE.MathUtils.clamp(this.iPitch + vsErr * 1.6, -12, 16);
    out.pitch = THREE.MathUtils.clamp((pitchCmd - ac.pitchAngle) * 0.09 - ac.omega.x * 0.9, -1, 1);
    // speed (and energy): throttle
    if (tgt.throttle !== undefined) {
      out.throttle = tgt.throttle;
    } else {
      const sErr = tgt.speed - ias;
      this.iThr = THREE.MathUtils.clamp(this.iThr + (sErr * 0.02 + vsErr * 0.015) * dt, 0.05, 1);
      out.throttle = THREE.MathUtils.clamp(this.iThr + sErr * 0.07 + vsErr * 0.06, 0, 1);
    }
    return out;
  }
}

export function idleInput(): PilotInput {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, flapNotch: 0, gearDown: true, trim: 0 };
}
