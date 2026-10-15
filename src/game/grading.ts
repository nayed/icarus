// Pure scoring functions (unit tested).

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface Metric {
  label: string;
  value: string;
  /** 0..1 quality for the results bar */
  score: number;
  note?: string;
}

export interface ModeResult {
  mode: 'rings' | 'landing' | 'free';
  title: string;
  grade: Grade;
  /** headline number (time or score) */
  headline: string;
  subtitle: string;
  metrics: Metric[];
  success: boolean;
}

export function gradeFromScore(score: number): Grade {
  if (score >= 92) return 'S';
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

/** Piecewise-linear interpolation over (x, y) keys sorted by x. */
function curve(x: number, keys: [number, number][]): number {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const [x0, y0] = keys[i - 1];
      const [x1, y1] = keys[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return keys[keys.length - 1][1];
}

export interface LandingInput {
  /** m/s, positive down */
  sinkRate: number;
  /** m from the centreline */
  centreline: number;
  /** m past the threshold */
  pastThreshold: number;
  /** aim point and runway length (m) */
  aim: number;
  runwayLength: number;
  bank: number;
  bounces: number;
  stoppedOnRunway: boolean;
  crashed: boolean;
  crashReason: string;
  gearDown: boolean;
  onRunway: boolean;
  /** stopping distance from touchdown (m) */
  rollout: number;
}

export function gradeLanding(l: LandingInput): ModeResult {
  const fpm = l.sinkRate * 196.85;
  const sinkS = curve(fpm, [[0, 100], [180, 100], [350, 85], [500, 65], [700, 40], [900, 15], [1200, 0]]);
  const cl = Math.abs(l.centreline);
  const clS = curve(cl, [[0, 100], [1.5, 100], [4, 75], [7, 45], [10, 15], [14, 0]]);
  const off = l.pastThreshold - l.aim;
  const tdS = l.pastThreshold < 0 ? 0 : curve(Math.abs(off), [[0, 100], [25, 100], [60, 75], [110, 45], [180, 15], [260, 0]]);
  const bankS = curve(Math.abs(l.bank), [[0, 100], [2, 100], [5, 70], [9, 30], [14, 0]]);
  const rollS = l.stoppedOnRunway ? 100 : 0;
  let score = sinkS * 0.32 + clS * 0.2 + tdS * 0.28 + bankS * 0.08 + rollS * 0.12;
  score -= l.bounces * 12;
  const fail = l.crashed || !l.onRunway || !l.gearDown || !l.stoppedOnRunway;
  if (fail) score = Math.min(score, 30);
  score = Math.max(0, Math.round(score));
  const grade: Grade = l.crashed ? 'F' : gradeFromScore(score);
  const subtitle = l.crashed
    ? l.crashReason
    : !l.onRunway
      ? 'Touched down off the strip'
      : !l.gearDown
        ? 'Wheels up on land: floats damaged'
        : !l.stoppedOnRunway
          ? 'Ran off the end of the strip'
          : l.bounces > 0
            ? `Down, after ${l.bounces} bounce${l.bounces > 1 ? 's' : ''}`
            : score >= 80
              ? 'Greased it'
              : 'Down and stopped';
  return {
    mode: 'landing',
    title: 'Hestskar mountain strip',
    grade,
    headline: String(score),
    subtitle,
    success: !fail,
    metrics: [
      { label: 'Sink rate', value: `${Math.round(fpm)} fpm`, score: sinkS / 100 },
      { label: 'Centreline', value: `${cl.toFixed(1)} m ${l.centreline < 0 ? 'left' : 'right'}`, score: clS / 100 },
      { label: 'Touchdown', value: l.pastThreshold < 0 ? `${Math.round(-l.pastThreshold)} m short` : `${Math.round(l.pastThreshold)} m in`, score: tdS / 100, note: `aim ${l.aim} m` },
      { label: 'Wings level', value: `${Math.abs(l.bank).toFixed(1)}°`, score: bankS / 100 },
      { label: 'Rollout', value: l.stoppedOnRunway ? `${Math.round(l.rollout)} m` : 'overrun', score: rollS / 100 },
    ],
  };
}

export interface RingsInput {
  /** elapsed time from the first gate to the last (s) */
  time: number;
  missed: number;
  penaltyPerMiss: number;
  par: number;
  gates: number;
  crashed: boolean;
  crashReason: string;
  splits: number[];
}

export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function gradeRings(r: RingsInput): ModeResult {
  const total = r.time + r.missed * r.penaltyPerMiss;
  const ratio = total / r.par;
  const score = Math.round(curve(ratio, [[0.9, 100], [1.0, 93], [1.1, 82], [1.25, 67], [1.45, 52], [1.7, 37], [2.2, 10], [3, 0]]));
  const grade: Grade = r.crashed ? 'F' : gradeFromScore(score);
  const passed = r.gates - r.missed;
  return {
    mode: 'rings',
    title: 'Fjord ring run',
    grade,
    headline: r.crashed ? 'DNF' : formatTime(total),
    subtitle: r.crashed ? r.crashReason : r.missed === 0 ? 'Clean run' : `${r.missed} gate${r.missed > 1 ? 's' : ''} missed (+${r.missed * r.penaltyPerMiss} s)`,
    success: !r.crashed,
    metrics: [
      { label: 'Flight time', value: formatTime(r.time), score: Math.min(1, r.par / Math.max(r.time, 1)) },
      { label: 'Gates', value: `${passed} / ${r.gates}`, score: passed / r.gates },
      { label: 'Penalties', value: `+${r.missed * r.penaltyPerMiss} s`, score: r.missed === 0 ? 1 : Math.max(0, 1 - r.missed / 4) },
      { label: 'Par', value: formatTime(r.par), score: Math.min(1, r.par / Math.max(total, 1)) },
    ],
  };
}
