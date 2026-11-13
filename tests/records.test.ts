import { beforeEach, describe, expect, it } from 'vitest';
import { bestRun, recordRun } from '../src/game/records.ts';

// a stand-in for the browser's local storage
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

describe('best runs', () => {
  beforeEach(() => store.clear());
  const run = { score: 80, grade: 'A' as const, seconds: 300, model: 'assisted' };

  it('keeps the first successful run, then only better ones', () => {
    expect(bestRun('fjord')).toBeNull();
    expect(recordRun('fjord', run, false)).toBe(false);
    expect(bestRun('fjord')).toBeNull();
    expect(recordRun('fjord', run, true)).toBe(true);
    expect(recordRun('fjord', { ...run, score: 70, seconds: 320 }, true)).toBe(false);
    expect(recordRun('fjord', { ...run, seconds: 300 }, true)).toBe(false);
    // the same score in less time, then a higher score
    expect(recordRun('fjord', { ...run, seconds: 299 }, true)).toBe(true);
    expect(recordRun('fjord', { ...run, score: 95, grade: 'S', seconds: 260 }, true)).toBe(true);
    expect(bestRun('fjord')).toMatchObject({ score: 95, grade: 'S', seconds: 260, model: 'assisted' });
  });

  it('keeps each circuit apart', () => {
    recordRun('fjord', run, true);
    expect(bestRun('gorge')).toBeNull();
    recordRun('gorge', { ...run, seconds: 180 }, true);
    expect(bestRun('fjord')?.seconds).toBe(300);
    expect(bestRun('gorge')?.seconds).toBe(180);
  });

  it('starts afresh when what is stored cannot be read', () => {
    store.set('icarus.best.v1', '{not json');
    expect(bestRun('fjord')).toBeNull();
    expect(recordRun('fjord', run, true)).toBe(true);
    expect(bestRun('fjord')?.score).toBe(80);
  });
});
