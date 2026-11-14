/**
 * A model reply that falls into repeating the same text runs on to the output limit: in one benchmark run a
 * single edit call repeated one line of test data for 128k tokens, which took twelve minutes and then rode along
 * in every later request. The stream is watched for it and stopped early.
 */

/** How much of the stream's end must repeat exactly before it counts: about 2k tokens. */
export const REPEAT_SPAN = 8000;
/** The longest unit that counts as repeating (shorter span-sized stretches repeat it at least eight times). */
const LONGEST_UNIT = 1000;

/** The unit the end of `tail` repeats, when its last REPEAT_SPAN characters are one unit over and over; else null. */
export function repeatingTail(tail: string): string | null {
  if (tail.length < REPEAT_SPAN) return null;
  const t = tail.slice(-REPEAT_SPAN);
  for (let k = 1; k <= LONGEST_UNIT; k++) {
    let i = 0;
    while (i + k < t.length && t.charCodeAt(i) === t.charCodeAt(i + k)) i++;
    if (i + k >= t.length) return t.slice(-k);
  }
  return null;
}

/** Watches the parts of one streamed reply, keeping only the end of each. */
export class RepeatWatch {
  private parts = new Map<string, { tail: string; length: number }>();

  /** Adds a delta to a part; the repeating unit when that part has fallen into a loop. */
  add(key: string, delta: string): string | null {
    const p = this.parts.get(key) ?? { tail: '', length: 0 };
    const before = p.length;
    p.length += delta.length;
    p.tail = (p.tail + delta).slice(-REPEAT_SPAN);
    this.parts.set(key, p);
    // Looked at every 2000 characters: cheap, and a loop is caught within a few seconds of streaming.
    if (p.length < REPEAT_SPAN || Math.floor(p.length / 2000) === Math.floor(before / 2000)) return null;
    return repeatingTail(p.tail);
  }
}
