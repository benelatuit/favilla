/**
 * Synchronous steps of Favilla's that held its thread up, kept a short while: the desktop app's stall log names them, so a
 * window that stopped answering says which step it was (a session opened, an output stored, a view built), never what
 * the step held.
 */
const spans: { label: string; ms: number; at: number }[] = [];
const KEEP = 60;
const SLOW_MS = 200;
let recording = false;

export function recordSlowSteps(on: boolean): void {
  recording = on;
  if (!on) spans.length = 0;
}

export function timedSync<T>(label: string, work: () => T): T {
  if (!recording) return work();
  const t0 = performance.now();
  try {
    return work();
  } finally {
    const ms = performance.now() - t0;
    if (ms >= SLOW_MS) {
      spans.push({ label, ms: Math.round(ms), at: Date.now() });
      if (spans.length > KEEP) spans.shift();
    }
  }
}

/** The slowest steps that ended since `at` (ms since the epoch), at most four. */
export function slowSince(at: number): { label: string; ms: number }[] {
  return spans
    .filter((s) => s.at >= at)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 4)
    .map(({ label, ms }) => ({ label, ms }));
}
