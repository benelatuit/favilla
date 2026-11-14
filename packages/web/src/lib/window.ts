/** Items drawn at first, and added each time the reader reaches the top: a long session drew every message. */
export const WINDOW = 60;

/** How far back from a place a turn's start is looked for, so a turn is not cut in the middle. */
const TURN_REACH = 20;

/** The start of the turn `i` is in, when it starts near; `i` itself otherwise. */
function turnStart(items: { kind: string }[], i: number): number {
  for (let k = i; k >= Math.max(0, i - TURN_REACH); k--) if (items[k].kind === 'user') return k;
  return i;
}

/**
 * Where the drawn part of a long conversation starts: about `limit` items from the end, moved back to the start of
 * that turn when it is near, so a turn is not cut in the middle.
 */
export function windowStart(items: { kind: string }[], limit: number): number {
  const start = Math.max(0, items.length - limit);
  return start === 0 ? 0 : turnStart(items, start);
}

/**
 * The drawn part of a conversation. At first it is the end (`from` and `to` null, `limit` items back); to show a
 * place far back (a find match, a message picked in the outline) it becomes a stretch around that place, named by
 * its first and last items' keys, so drawing it costs what drawing the end does and not every turn since.
 */
export interface Win {
  from: string | null;
  to: string | null;
  limit: number;
}

export const TAIL: Win = { from: null, to: null, limit: WINDOW };

type Item = { key: string; kind: string };

const indexOf = (items: Item[], key: string) => items.findIndex((x) => x.key === key);

/** The items a window draws, as [start, end). A key that is gone (a new session) counts as no bound. */
export function drawn(items: Item[], w: Win): { start: number; end: number } {
  const to = w.to === null ? -1 : indexOf(items, w.to);
  const end = to < 0 ? items.length : to + 1;
  const from = w.from === null ? -1 : indexOf(items, w.from);
  const start = from < 0 ? windowStart(items.slice(0, end), w.limit) : from;
  return { start: Math.min(start, end), end };
}

/**
 * A stretch around item `i`: from the start of a turn a little before it (so it can be brought to the middle of the
 * view, with what led to it above), a window's worth on; the end when that reaches it.
 */
function around(items: Item[], i: number): Win {
  const start = turnStart(items, Math.max(0, i - 6));
  const last = start + WINDOW - 1;
  return { from: items[start].key, to: last >= items.length - 1 ? null : items[last].key, limit: WINDOW };
}

/** A window's worth more above. */
export function earlier(items: Item[], w: Win): Win {
  if (w.from === null) return { ...w, limit: w.limit + WINDOW };
  const at = Math.max(0, indexOf(items, w.from));
  return { ...w, from: items[turnStart(items, Math.max(0, at - WINDOW))].key };
}

/** A window's worth more below; reaching the end, the window follows the end again. */
export function later(items: Item[], w: Win): Win {
  if (w.to === null) return w;
  const at = indexOf(items, w.to);
  const next = at < 0 ? items.length : at + WINDOW;
  return { ...w, to: next >= items.length - 1 ? null : items[next].key };
}

/** The window that shows item `i`: this one when it already does, one grown to it when it is near, else a stretch around it. */
export function toShow(items: Item[], w: Win, i: number): Win {
  const { start, end } = drawn(items, w);
  if (i >= start && i < end) return w;
  if (i < start && start - i <= WINDOW) return { ...w, from: items[turnStart(items, i)].key };
  if (i >= end && i - end < WINDOW) {
    const last = Math.min(items.length - 1, i + 8);
    return { ...w, to: last >= items.length - 1 ? null : items[last].key };
  }
  return around(items, i);
}
