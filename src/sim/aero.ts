// Lift and drag coefficients with a stall break and post-stall flat-plate behaviour.

export interface LiftResult {
  cl: number;
  /** 0 = attached flow, 1 = fully stalled */
  stall: number;
}

/**
 * Lift coefficient for effective angle of attack `a` (rad, already including alpha0 shift).
 * `soft` > 0 keeps lift near CLmax beyond the stall (arcade model).
 */
export function liftCoefficient(a: number, cla: number, clmax: number, soft: number, out: LiftResult): LiftResult {
  const aStall = clmax / cla;
  const abs = Math.abs(a);
  const sign = a < 0 ? -1 : 1;
  if (abs <= aStall) {
    out.cl = cla * a;
    out.stall = 0;
    return out;
  }
  // past the stall: lift drops (~30%) over a few degrees, then follows a flat plate
  const w = 5 * (Math.PI / 180);
  const t = Math.min(1, (abs - aStall) / w);
  const tt = t * t * (3 - 2 * t);
  const drop = clmax * (1 - 0.32 * tt * (1 - soft));
  const flat = 1.05 * Math.abs(Math.sin(2 * a));
  const far = Math.min(1, Math.max(0, (abs - aStall - w) / (20 * (Math.PI / 180))));
  const cl = drop * (1 - far) + Math.max(flat, soft * clmax * 0.85) * far;
  out.cl = sign * cl;
  out.stall = tt;
  return out;
}

/** Ground effect factor on induced drag for height h above the surface and span b. */
export function groundEffect(h: number, b: number): number {
  if (h <= 0) return 0.25;
  const r = (16 * h) / b;
  const r2 = r * r;
  return Math.max(0.25, r2 / (1 + r2));
}

/** Air density (kg/m³) at altitude y (m), simple exponential atmosphere. */
export function airDensity(y: number): number {
  return 1.225 * Math.exp(-Math.max(y, -200) / 8500);
}
