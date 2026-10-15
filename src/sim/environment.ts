// What the flight model sees of the world: the rendered terrain surface, the sea, wind and runways.
import * as THREE from 'three';
import type { SimEnv } from './aircraft.ts';
import { type ClipState, type ClipmapConfig, drawnSurface, makeClipState, type SurfaceSample } from '../world/clipmap.ts';
import { WaveSet, waterHeight } from '../world/water.ts';
import { STRIPS, SEA_LEVEL, headingDir } from '../world/params.ts';
import { vnoise } from '../world/noise.ts';
import { terrainHeight } from '../world/terrain.ts';

const STRIP_FRAMES = STRIPS.map((s) => ({ s, d: headingDir(s.heading) }));

/** Runway-local coordinates: along (from centre, + towards heading) and across (+ right). */
export function runwayLocal(stripIndex: number, x: number, z: number): { along: number; across: number } {
  const { s, d } = STRIP_FRAMES[stripIndex];
  const rx = x - s.center[0];
  const rz = z - s.center[1];
  return { along: rx * d[0] + rz * d[1], across: -rx * d[1] + rz * d[0] };
}

export function onRunway(x: number, z: number): boolean {
  for (let i = 0; i < STRIPS.length; i++) {
    const { along, across } = runwayLocal(i, x, z);
    if (Math.abs(along) <= STRIPS[i].halfLength && Math.abs(across) <= STRIPS[i].halfWidth + 1) return true;
  }
  return false;
}

export class WorldEnv implements SimEnv {
  clip: ClipState;
  readonly waves = new WaveSet();
  /** wind the air moves towards (m/s), at 200 m above ground */
  readonly baseWind = new THREE.Vector3(3.6, 0, -1.7);
  /** 0 = steady, 1 = full gusts and terrain turbulence */
  gustiness = 0.6;

  constructor(cfg: ClipmapConfig) {
    this.clip = makeClipState(cfg, 0, 0);
    this.setWind(250, 4);
  }

  /** Wind from `fromDeg` (meteorological) at `speed` m/s. */
  setWind(fromDeg: number, speed: number): void {
    const towards = ((fromDeg + 180) * Math.PI) / 180;
    this.baseWind.set(Math.sin(towards) * speed, 0, -Math.cos(towards) * speed);
    this.waves.set(speed > 0.01 ? this.baseWind.x / speed : 1, speed > 0.01 ? this.baseWind.z / speed : 0, speed);
  }

  /** For headless runs: keep the clipmap centred on a point (as the camera would). */
  follow(x: number, z: number): void {
    if (Math.abs(x - this.clip.cx) > 1 || Math.abs(z - this.clip.cz) > 1) this.clip = makeClipState(this.clip.cfg, x, z);
  }

  surface(x: number, z: number, out: SurfaceSample): SurfaceSample {
    return drawnSurface(x, z, this.clip, out);
  }

  waterHeight(x: number, z: number, t: number): number {
    return SEA_LEVEL + waterHeight(this.waves, x, z, t, this.clip.cfg.s0);
  }

  wind(x: number, y: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3 {
    const ground = Math.max(terrainHeight(x, z, 4), SEA_LEVEL);
    const h = Math.max(y - ground, 0.3);
    // logarithmic boundary layer
    const prof = THREE.MathUtils.clamp(Math.log(h / 0.05) / Math.log(200 / 0.05), 0.3, 1.15);
    out.copy(this.baseWind).multiplyScalar(prof);
    const speed = this.baseWind.length();
    if (this.gustiness > 0 && speed > 0.2) {
      // gusts: slow 3-axis noise, stronger near terrain (mechanical turbulence in the mountains)
      const terrainTurb = THREE.MathUtils.clamp(1 - h / 500, 0, 1) * THREE.MathUtils.clamp((ground - 50) / 400, 0, 1);
      const a = speed * this.gustiness * (0.18 + 0.35 * terrainTurb);
      const px = x / 300;
      const pz = z / 300;
      out.x += a * (vnoise(t * 0.45 + px, pz, 71) + 0.5 * vnoise(t * 1.3, px + 3.1, 72));
      out.z += a * (vnoise(pz, t * 0.45 + px, 73) + 0.5 * vnoise(t * 1.1 + 7.7, pz, 74));
      out.y += a * 0.6 * (vnoise(t * 0.7 + pz, px, 75) + 0.5 * vnoise(t * 1.7, pz + 2.2, 76)) * (0.4 + terrainTurb);
    }
    return out;
  }

  onRunway(x: number, z: number): boolean {
    return onRunway(x, z);
  }
}
