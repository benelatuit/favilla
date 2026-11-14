import { describe, expect, it } from 'vitest';
import { slowSince, timedSync } from '../src/util/slow';

const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* hold the thread */
  }
};

describe('the steps that held the thread up', () => {
  it('keeps a slow step with its label and time, the slowest first, and not a quick one', () => {
    const before = Date.now() - 1;
    expect(timedSync('quick step', () => 7)).toBe(7);
    timedSync('slow step', () => busy(230));
    timedSync('slower step', () => busy(320));
    const slow = slowSince(before);
    expect(slow.map((s) => s.label)).toEqual(['slower step', 'slow step']);
    expect(slow[0].ms).toBeGreaterThanOrEqual(300);
    expect(slowSince(Date.now() + 1000)).toEqual([]);
  });

  it('records a step that throws, and passes the error on', () => {
    const before = Date.now() - 1;
    expect(() =>
      timedSync('failing step', () => {
        busy(220);
        throw new Error('no');
      }),
    ).toThrow('no');
    expect(slowSince(before).map((s) => s.label)).toContain('failing step');
  });
});
