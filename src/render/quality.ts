// Quality presets and automatic resolution scaling.

export type QualityName = 'low' | 'medium' | 'high';

export interface QualityPreset {
  name: QualityName;
  /** terrain clipmap: cells per level side and levels */
  terrainM: number;
  terrainLevels: number;
  terrainS0: number;
  waterM: number;
  waterLevels: number;
  envWidth: number;
  bloomLevels: number;
  msaa: number;
  /** cap on device pixel ratio */
  maxPixelRatio: number;
  /** cloud raymarch: resolution divisor and steps */
  cloudDiv: number;
  cloudSteps: number;
  shadowSize: number;
  trees: number;
  treeRadius: number;
  treeCell: number;
  /** planar water reflection resolution scale (0 = sky-only reflections) */
  reflScale: number;
}

export const PRESETS: Record<QualityName, QualityPreset> = {
  high: {
    name: 'high', terrainM: 128, terrainLevels: 11, terrainS0: 1, waterM: 64, waterLevels: 14,
    envWidth: 512, bloomLevels: 6, msaa: 4, maxPixelRatio: 1.5, cloudDiv: 2, cloudSteps: 48, shadowSize: 1024, trees: 60000, treeRadius: 1800, treeCell: 9, reflScale: 0.5,
  },
  medium: {
    name: 'medium', terrainM: 96, terrainLevels: 12, terrainS0: 1, waterM: 48, waterLevels: 15,
    envWidth: 256, bloomLevels: 5, msaa: 2, maxPixelRatio: 1.0, cloudDiv: 4, cloudSteps: 36, shadowSize: 512, trees: 30000, treeRadius: 1300, treeCell: 12, reflScale: 0.35,
  },
  low: {
    name: 'low', terrainM: 64, terrainLevels: 11, terrainS0: 2, waterM: 32, waterLevels: 16,
    envWidth: 128, bloomLevels: 4, msaa: 0, maxPixelRatio: 0.75, cloudDiv: 4, cloudSteps: 24, shadowSize: 256, trees: 10000, treeRadius: 850, treeCell: 16, reflScale: 0,
  },
};

/**
 * Adjusts a render scale to hold a target frame time, from a smoothed frame cost with hysteresis:
 * drops quickly when over budget, climbs slowly when there is headroom.
 *
 * The cost is the measured GPU/CPU work of a frame when the browser exposes GPU timers. Otherwise
 * only the interval between frames is known, and on a display synced at the target rate that never
 * shows headroom: the scaler then probes one step up after a while at full rate, returns to where it
 * was if the probe costs frames, and waits twice as long before the next try.
 */
export class ResolutionScaler {
  scale = 1;
  enabled = true;
  /** probes tried so far (tests) */
  probes = 0;
  private avg: number;
  private overTime = 0;
  private underTime = 0;
  private steadyTime = 0;
  /** seconds since the current probe stepped up (-1: no probe running) */
  private probeAge = -1;
  private probeFrom = 1;
  private probeWait = 4;
  /** seconds left in which frame times are ignored (shader compiles, terrain bakes after a reset) */
  private holdTime = 2;

  constructor(
    public min = 0.5,
    public max = 1,
    public targetMs = 16.7,
  ) {
    this.avg = targetMs;
  }

  /**
   * frameMs is the frame's work time when `measured`, else the interval since the previous frame.
   * Returns true when the scale changed.
   */
  update(frameMs: number, dt: number, measured = false): boolean {
    if (!this.enabled) return false;
    if (this.holdTime > 0) {
      this.holdTime -= dt;
      this.avg = this.targetMs;
      return false;
    }
    frameMs = Math.min(frameMs, 100);
    this.avg += (frameMs - this.avg) * Math.min(1, dt * 4);
    const over = this.avg > this.targetMs * 1.12;
    this.overTime = over ? this.overTime + dt : 0;
    this.underTime = this.avg < this.targetMs * 0.8 ? this.underTime + dt : 0;
    this.steadyTime = over ? 0 : this.steadyTime + dt;
    if (this.probeAge >= 0) this.probeAge += dt;
    let next = this.scale;
    if (this.overTime > 0.75) {
      this.overTime = 0;
      if (this.probeAge >= 0) {
        // the probe cost frames: back to where it started, and wait longer before the next one
        next = this.probeFrom;
        this.probeWait = Math.min(this.probeWait * 2, 128);
      } else next = this.scale * 0.88;
      this.probeAge = -1;
      this.steadyTime = 0;
    } else if (this.underTime > 3) {
      next = this.scale * 1.06;
      this.underTime = 0;
    } else if (!measured && this.probeAge < 0 && this.scale < this.max && this.steadyTime > this.probeWait) {
      this.probeFrom = this.scale;
      next = this.scale * 1.06;
      this.probeAge = 0;
      this.steadyTime = 0;
      this.probes++;
    }
    if (this.probeAge > 3) this.probeAge = -1; // the probe held: keep it
    next = Math.round(Math.min(this.max, Math.max(this.min, next)) * 20) / 20;
    if (next !== this.scale) {
      this.scale = next;
      return true;
    }
    return false;
  }

  /** Ignores the next `seconds` of frame times (expected hitches). */
  hold(seconds: number): void {
    this.holdTime = Math.max(this.holdTime, seconds);
    this.overTime = 0;
  }
}
