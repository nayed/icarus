// The aircraft's ground track, for the pause screen's chart: a point every `spacing` metres flown,
// the latest `max` kept (4,000 × 25 m: the last 100 km).

export class Track {
  readonly max: number;
  readonly spacing: number;
  private readonly xs: Float32Array;
  private readonly zs: Float32Array;
  private start = 0;
  /** points stored */
  count = 0;

  constructor(max = 4000, spacing = 25) {
    this.max = max;
    this.spacing = spacing;
    this.xs = new Float32Array(max);
    this.zs = new Float32Array(max);
  }

  reset(): void {
    this.start = 0;
    this.count = 0;
  }

  /** Records (x, z) when it is at least `spacing` from the last point. */
  add(x: number, z: number): void {
    if (this.count > 0) {
      const last = (this.start + this.count - 1) % this.max;
      if (Math.hypot(x - this.xs[last], z - this.zs[last]) < this.spacing) return;
    }
    const i = (this.start + this.count) % this.max;
    this.xs[i] = x;
    this.zs[i] = z;
    if (this.count < this.max) this.count++;
    else this.start = (this.start + 1) % this.max;
  }

  /** The k-th point, oldest first. */
  point(k: number): [number, number] {
    const i = (this.start + k) % this.max;
    return [this.xs[i], this.zs[i]];
  }
}
