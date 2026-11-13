// The best run on each ring-run circuit, kept in this browser's local storage: it stays on this
// device and browser (nothing is sent anywhere), and clearing the site's data forgets it.
import type { CourseId } from './course.ts';
import type { Grade } from './grading.ts';

export interface BestRun {
  /** what the grade was read from (0..100): the time against par, and on a mail run the landing too */
  score: number;
  grade: Grade;
  /** the time with the penalties (s) */
  seconds: number;
  /** the flight model it was flown with */
  model: string;
  /** when, as an ISO date */
  date: string;
}

const KEY = 'icarus.best.v1';

function load(): Partial<Record<CourseId, BestRun>> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Partial<Record<CourseId, BestRun>>;
  } catch {
    // storage can be unavailable (private mode, blocked site data) or hold something unreadable
  }
  return {};
}

/** The circuit's best run so far, if any. */
export function bestRun(id: CourseId): BestRun | null {
  return load()[id] ?? null;
}

/**
 * Keeps a finished run if it is the circuit's best so far: a higher score, or the same score in less
 * time. Only runs that succeeded count (no crash; on a mail run, a landing on the strip). Returns
 * whether it was kept.
 */
export function recordRun(id: CourseId, run: Omit<BestRun, 'date'>, success: boolean): boolean {
  if (!success) return false;
  const all = load();
  const prev = all[id];
  if (prev && (run.score < prev.score || (run.score === prev.score && run.seconds >= prev.seconds))) return false;
  all[id] = { ...run, date: new Date().toISOString().slice(0, 10) };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // ignore: the run just isn't remembered
  }
  return true;
}
