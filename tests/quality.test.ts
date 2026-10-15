import { describe, expect, it } from 'vitest';
import { ResolutionScaler } from '../src/render/quality.ts';

const VSYNC = 1000 / 60;
/** GPU work proportional to the pixel count (scale squared) */
const gpuMs = (fullMs: number, scale: number) => fullMs * scale * scale;
/** what requestAnimationFrame sees on a 60 Hz display: whole vsync periods */
const interval = (work: number) => Math.max(1, Math.ceil(work / VSYNC - 1e-6)) * VSYNC;

function run(s: ResolutionScaler, seconds: number, fullMs: (t: number) => number, measured: boolean, t0 = 0) {
  let t = t0;
  const trace: number[] = [];
  while (t < t0 + seconds) {
    const work = gpuMs(fullMs(t), s.scale);
    const dt = interval(work) / 1000;
    s.update(measured ? work : interval(work), dt, measured);
    t += dt;
    trace.push(s.scale);
  }
  return trace;
}

describe('ResolutionScaler', () => {
  it('drops under load and recovers when the load goes, with GPU timings', () => {
    const s = new ResolutionScaler();
    run(s, 10, () => 30, true);
    expect(s.scale).toBeLessThan(0.8);
    // 30 ms at full res fits 60 fps around scale 0.72: it must settle there, not oscillate wildly
    const settled = run(s, 20, () => 30, true, 10).slice(-300);
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(gpuMs(30, s.scale)).toBeLessThan(VSYNC * 1.12);
    run(s, 40, () => 8, true, 30);
    expect(s.scale).toBe(1);
  });

  it('recovers on a 60 Hz display with only the frame interval (probing)', () => {
    const s = new ResolutionScaler();
    run(s, 5, () => 40, false); // a heavy moment (e.g. shader compiles)
    expect(s.scale).toBeLessThan(0.8);
    run(s, 120, () => 9, false, 5); // then light work: frames come exactly at vsync
    expect(s.scale).toBe(1);
  });

  it('backs off when probes fail, instead of pumping the resolution', () => {
    const s = new ResolutionScaler();
    s.scale = 0.8;
    // fits 60 Hz up to scale ~0.82; each step above misses frames
    const trace = run(s, 300, () => 24, false);
    const atOrBelow = trace.filter((v) => v <= 0.8 + 1e-9).length / trace.length;
    expect(atOrBelow).toBeGreaterThan(0.95);
    expect(s.probes).toBeLessThanOrEqual(8);
    expect(s.scale).toBe(0.8);
  });
});
