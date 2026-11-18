import { describe, expect, it } from 'vitest';
import { planStroke, type Point, type StrokeAction } from '../src/tools/stroke';

describe('a timed mouse path', () => {
  it('interpolates the anchors, starts with a small move and spends time by distance', () => {
    const stroke: Point[] = [[10, 80], [70, 20], [70, 20], [130, 80]];
    const samples = planStroke({ stroke, ms: 600 }, 150, 100);
    expect(samples[0]).toEqual([10, 80, 0]);
    expect(samples.at(-1)).toEqual([130, 80, 600]);
    expect(Math.hypot(samples[1][0] - 10, samples[1][1] - 80)).toBeCloseTo(2, 1);
    expect(samples).toContainEqual([70, 20, 300]);
    // A straight interpolation would be at y=50 halfway up either side.
    expect(samples.some(([x, y]) => Math.abs(x - 40) < 3 && y < 46)).toBe(true);
    expect(samples.every((p, i) => !i || p[2] >= samples[i - 1][2] + 8)).toBe(true);
  });

  it('bounds the event stream and stays in the picture even at the corners', () => {
    const stroke: Point[] = Array.from({ length: 128 }, (_, i) => [i % 3 === 0 ? 0 : 4095, i % 2 === 0 ? 0 : 4095]);
    const samples = planStroke({ stroke }, 4096, 4096);
    expect(samples.length - 1).toBeLessThanOrEqual(256);
    for (const [x, y, t] of samples) {
      expect([x, y, t].every(Number.isFinite)).toBe(true);
      expect(Math.min(x, y)).toBeGreaterThanOrEqual(0);
      expect(Math.max(x, y)).toBeLessThanOrEqual(4095);
    }
    expect(samples.at(-1)?.slice(0, 2)).toEqual(stroke.at(-1));
  });

  it('rejects malformed or out-of-picture strokes and invalid durations', () => {
    for (const stroke of [null, [], [[1, 1]], Array(129).fill([0, 0]), [[1, 1], [1, 1]], [[0, 1], null],
      [[1, '2'], [1, 1]], [[NaN, 0], [1, 1]], [[1, 1], [2, 3, 4]], [[0, -1], [1, 1]], [[0, 0], [100, 1]]]) {
      expect(() => planStroke({ stroke } as StrokeAction, 100, 100)).toThrow(/stroke/i);
    }
    for (const ms of [0, Infinity, '250', null, 2001]) {
      expect(() => planStroke({ stroke: [[0, 0], [1, 1]], ms } as StrokeAction, 2, 2)).toThrow(/ms/);
    }
  });
});
