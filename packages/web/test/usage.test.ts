import { describe, expect, it } from 'vitest';
import { bucketKey, bucketKeys, cachedShare, columnsBefore, columnsOf, freshOf, previousDays, rangeDays, rowsIn, sessionParts, slotsOf, speedColumns, ticksFor, unitFor, type TokenRow } from '../src/lib/usage';

const row = (day: string, model: string, input: number, output: number, more: Partial<TokenRow> = {}): TokenRow => ({
  day,
  provider: 'relay',
  model,
  cwd: 'C:\\work\\alpha',
  requests: 1,
  side: 0,
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 0,
  ...more,
});

describe('the usage page’s sums', () => {
  it('takes a range of days back from today, and the same length before it', () => {
    expect(rangeDays('7', '2026-03-10', '2025-01-01')).toEqual({ from: '2026-03-04', to: '2026-03-10' });
    expect(previousDays('7', '2026-03-10')).toEqual({ from: '2026-02-25', to: '2026-03-03' });
    // Across the change to summer time and the end of a month.
    expect(rangeDays('30', '2026-03-10', null)).toEqual({ from: '2026-02-09', to: '2026-03-10' });
    expect(rangeDays('all', '2026-03-10', '2025-12-30')).toEqual({ from: '2025-12-30', to: '2026-03-10' });
    expect(rangeDays('all', '2026-03-10', null)).toEqual({ from: '2026-03-10', to: '2026-03-10' });
    expect(previousDays('all', '2026-03-10')).toBeNull();
  });

  it('puts days in weeks from Monday and in months once there are too many for a column each', () => {
    expect(bucketKey('2026-03-08', 'week')).toBe('2026-03-02'); // a Sunday
    expect(bucketKey('2026-03-09', 'week')).toBe('2026-03-09'); // a Monday
    expect(bucketKey('2026-03-31', 'month')).toBe('2026-03-01');
    expect(unitFor('2026-01-01', '2026-03-10')).toBe('day');
    expect(unitFor('2025-06-01', '2026-03-10')).toBe('week');
    expect(unitFor('2023-06-01', '2026-03-10')).toBe('month');
    expect(bucketKeys('2025-11-20', '2026-02-02', 'month')).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
    expect(bucketKeys('2026-03-01', '2026-03-10', 'week')).toEqual(['2026-02-23', '2026-03-02', '2026-03-09']);
    expect(bucketKeys('2026-03-08', '2026-03-10', 'day')).toEqual(['2026-03-08', '2026-03-09', '2026-03-10']);
  });

  it('gives each model its colour by all it has used, whatever range is shown, and the rest one grey', () => {
    const rows = [row('2026-03-01', 'big', 9000, 0), ...['a', 'b', 'c', 'd', 'e', 'f'].map((m, i) => row('2026-03-09', m, 100 - i, 0))];
    const slots = slotsOf(rows);
    expect(slots.get('relay/big')).toBe(0);
    expect(slots.get('relay/a')).toBe(1);
    expect(slots.has('relay/e')).toBe(false);
    // The last week alone: "big" is not in it, and "a" keeps the colour it has over everything.
    const week = rowsIn(rows, '2026-03-04', '2026-03-10');
    const [col] = columnsOf(week, ['2026-03-09'], 'day', 'model', slots);
    expect(col.values).toEqual([0, 100, 99, 98, 97, 96 + 95]);
    expect(col.sums.requests).toBe(6);
    // Cost goes by model whatever split was chosen last.
    const [spent] = columnsOf([row('2026-03-09', 'a', 10, 0, { cost: 0.5 }), row('2026-03-09', 'f', 10, 0, { cost: 0.25 })], ['2026-03-09'], 'day', 'kind', slots, 'cost');
    expect(spent.values).toEqual([0, 0.5, 0, 0, 0, 0.25]);
  });

  it('draws each model’s speed over all its timed replies, a gap where none was timed and no line for the rest', () => {
    const slots = new Map([['relay/a', 0], ['relay/b', 1]]);
    const rows = [
      row('2026-03-09', 'a', 0, 0, { timed: 2, streamTokens: 3000, streamMs: 50_000 }),
      row('2026-03-09', 'a', 0, 0, { timed: 1, streamTokens: 1000, streamMs: 10_000 }),
      row('2026-03-10', 'b', 0, 0, { timed: 1, streamTokens: 900, streamMs: 10_000 }),
      row('2026-03-10', 'other', 0, 0, { timed: 1, streamTokens: 900, streamMs: 1_000 }),
    ];
    const [mon, tue] = speedColumns(rows, ['2026-03-09', '2026-03-10'], 'day', slots);
    // 4000 tokens in 60 s, not the mean of 60 and 100 a second.
    expect(mon.values[0]).toBeCloseTo(66.667, 2);
    expect(mon.values[1]).toBeNaN();
    expect(tue.values[1]).toBe(90);
    expect(tue.values.slice(2).every(Number.isNaN)).toBe(true);
    expect(tue.sums.timed).toBe(2);
  });

  it('counts the columns wholly before the log began, and sums each session’s days, largest first', () => {
    expect(columnsBefore(['2026-03-08', '2026-03-09', '2026-03-10'], '2026-03-10', '2026-03-10')).toBe(2);
    expect(columnsBefore(['2026-03-08'], '2026-03-10', '2026-01-01')).toBe(0);
    // A week that holds the day the log began is not before it.
    expect(columnsBefore(['2026-02-23', '2026-03-02', '2026-03-09'], '2026-03-10', '2026-03-04')).toBe(1);
    const s = (day: string, session: string, input: number, cost = 0) => ({ day, session, cwd: 'C:/w', requests: 1, input, output: 0, cost });
    expect(sessionParts([s('2026-03-09', 'a', 10), s('2026-03-09', 'b', 50, 0.5), s('2026-03-10', 'a', 60)]).map((p) => [p.session, p.requests, p.total, p.cost])).toEqual([
      ['a', 2, 70, 0],
      ['b', 1, 50, 0.5],
    ]);
  });

  it('splits the prompt into the part no cache held, the cache read and written, and the answer', () => {
    const r = row('2026-03-10', 'm', 1000, 50, { cacheRead: 700, cacheWrite: 200 });
    const [col] = columnsOf([r], ['2026-03-10'], 'day', 'kind', new Map());
    expect(col.values).toEqual([100, 700, 200, 50]);
    expect(cachedShare(r)).toBe(0.7);
    // A provider that counts the cache apart from the prompt: never less than nothing fresh, never over all of it.
    expect(freshOf(row('d', 'm', 100, 0, { cacheRead: 300 }))).toBe(0);
    expect(cachedShare(row('d', 'm', 100, 0, { cacheRead: 300 }))).toBe(1);
    expect(cachedShare(row('d', 'm', 0, 5))).toBeNull();
  });

  it('marks the axis in round steps up to the tallest column', () => {
    expect(ticksFor(0)).toEqual([0]);
    expect(ticksFor(10_000)).toEqual([0, 2500, 5000, 7500, 10_000]);
    expect(ticksFor(1_234_567)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
    expect(ticksFor(7)).toEqual([0, 2, 4, 6, 8]);
  });
});
