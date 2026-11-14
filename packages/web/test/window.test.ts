import { describe, expect, it } from 'vitest';
import { TAIL, WINDOW, drawn, earlier, later, toShow, windowStart } from '../src/lib/window';

const items = (n: number, userEvery = 10) => Array.from({ length: n }, (_, i) => ({ kind: i % userEvery === 0 ? 'user' : 'process' }));

describe('the drawn part of a conversation', () => {
  it('draws a short conversation whole', () => {
    expect(windowStart(items(40), WINDOW)).toBe(0);
    expect(windowStart(items(WINDOW), WINDOW)).toBe(0);
  });

  it('starts a long one at the start of a turn near the limit', () => {
    const list = items(1000);
    const start = windowStart(list, WINDOW);
    expect(start).toBe(940 - (940 % 10));
    expect(list[start].kind).toBe('user');
  });

  it('cuts in a very long turn when no turn starts near', () => {
    const list = Array.from({ length: 500 }, () => ({ kind: 'process' }));
    expect(windowStart(list, WINDOW)).toBe(440);
  });

  it('reaches further back as the limit grows, down to the first item', () => {
    const list = items(150);
    expect(windowStart(list, WINDOW * 2)).toBeLessThan(windowStart(list, WINDOW));
    expect(windowStart(list, WINDOW * 3)).toBe(0);
  });
});

describe('a stretch of a long conversation', () => {
  const list = Array.from({ length: 1000 }, (_, i) => ({ key: `k${i}`, kind: i % 10 === 0 ? 'user' : 'process' }));

  it('draws the end at first', () => {
    expect(drawn(list, TAIL)).toEqual({ start: 940, end: 1000 });
  });

  it('shows a place far back as a stretch from a turn before it, not every turn since', () => {
    const w = toShow(list, TAIL, 123);
    const { start, end } = drawn(list, w);
    expect(start).toBe(110);
    expect(end - start).toBe(WINDOW);
    expect(start <= 123 && 123 < end).toBe(true);
  });

  it('grows to a place near the drawn part instead of jumping', () => {
    const w = toShow(list, TAIL, 900);
    expect(drawn(list, w)).toEqual({ start: 900, end: 1000 });
    expect(toShow(list, w, 950)).toBe(w);
  });

  it('adds more above and below, and follows the end again once it reaches it', () => {
    let w = toShow(list, TAIL, 123);
    w = earlier(list, w);
    expect(drawn(list, w).start).toBe(50);
    for (let i = 0; i < 20 && w.to !== null; i++) w = later(list, w);
    expect(w.to).toBeNull();
    expect(drawn(list, w).end).toBe(1000);
  });

  it('keeps a stretch whole when the conversation grows below it', () => {
    const w = toShow(list, TAIL, 123);
    const grown = [...list, { key: 'k1000', kind: 'user' }];
    expect(drawn(grown, w)).toEqual(drawn(list, w));
  });
});
