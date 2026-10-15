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
}

export const PRESETS: Record<QualityName, QualityPreset> = {
  high: {
    name: 'high', terrainM: 128, terrainLevels: 11, terrainS0: 1, waterM: 64, waterLevels: 14,
    envWidth: 512, bloomLevels: 6, msaa: 4, maxPixelRatio: 1.5, cloudDiv: 2, cloudSteps: 48, shadowSize: 1024, trees: 60000, treeRadius: 1800, treeCell: 9,
  },
  medium: {
    name: 'medium', terrainM: 96, terrainLevels: 12, terrainS0: 1, waterM: 48, waterLevels: 15,
    envWidth: 256, bloomLevels: 5, msaa: 2, maxPixelRatio: 1.0, cloudDiv: 4, cloudSteps: 36, shadowSize: 512, trees: 30000, treeRadius: 1300, treeCell: 12,
  },
  low: {
    name: 'low', terrainM: 64, terrainLevels: 11, terrainS0: 2, waterM: 32, waterLevels: 16,
    envWidth: 128, bloomLevels: 4, msaa: 0, maxPixelRatio: 0.75, cloudDiv: 4, cloudSteps: 24, shadowSize: 256, trees: 10000, treeRadius: 850, treeCell: 16,
  },
};

/**
 * Adjusts a render scale to hold a target frame time. Uses a smoothed frame time with hysteresis:
 * drops quickly when over budget, climbs slowly when there is clear headroom.
 */
export class ResolutionScaler {
  scale = 1;
  private avg = 16.7;
  private overTime = 0;
  private underTime = 0;
  enabled = true;

  constructor(public min = 0.5, public max = 1, public targetMs = 16.7) {}

  /** Returns true when the scale changed. */
  update(frameMs: number, dt: number): boolean {
    if (!this.enabled) return false;
    frameMs = Math.min(frameMs, 100);
    this.avg += (frameMs - this.avg) * Math.min(1, dt * 4);
    if (this.avg > this.targetMs * 1.12) {
      this.overTime += dt;
      this.underTime = 0;
    } else if (this.avg < this.targetMs * 0.8) {
      this.underTime += dt;
      this.overTime = 0;
    } else {
      this.overTime = 0;
      this.underTime = 0;
    }
    let next = this.scale;
    if (this.overTime > 0.75) {
      next = Math.max(this.min, this.scale * 0.88);
      this.overTime = 0;
    } else if (this.underTime > 3) {
      next = Math.min(this.max, this.scale * 1.06);
      this.underTime = 0;
    }
    next = Math.round(next * 20) / 20;
    if (next !== this.scale) {
      this.scale = next;
      return true;
    }
    return false;
  }
}
