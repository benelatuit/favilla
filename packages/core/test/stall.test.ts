import { describe, expect, it } from 'vitest';
import { watchStalls, type Stall } from '../src/util/stall';

// A function of its own name, so the report can be checked for it.
function holdTheThreadUp(ms: number): number {
  let n = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) n += Math.sqrt(n + 1);
  return n;
}

function readsTheWholeStore(ms: number): number {
  return holdTheThreadUp(ms);
}

describe('a hold-up that names itself', () => {
  it('reports the function that took the time and the calls that led to it, once the thread runs again', async () => {
    const seen: Stall[] = [];
    const errors: string[] = [];
    const stop = watchStalls((s) => seen.push(s), { afterMs: 400, onError: (e) => errors.push(e) });
    // The watchdog thread starts first.
    await new Promise((r) => setTimeout(r, 800));
    readsTheWholeStore(2500);
    for (let i = 0; i < 40 && !seen.length; i++) await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(errors).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].ms).toBeGreaterThan(2000);
    // V8 may inline the loop into its caller, so either name can carry the time; the path starts at the caller.
    expect(seen[0].busiest[0]).toMatch(/^(holdTheThreadUp|readsTheWholeStore) stall\.test\.ts:\d+ \d+ ms$/);
    expect(Number(seen[0].busiest[0].split(' ').at(-2))).toBeGreaterThan(1000);
    expect(seen[0].path.join(' > ')).toMatch(/readsTheWholeStore stall\.test\.ts:\d+/);
  }, 20_000);

  it('says nothing about a thread that keeps beating', async () => {
    const seen: Stall[] = [];
    const stop = watchStalls((s) => seen.push(s), { afterMs: 400 });
    for (let i = 0; i < 10; i++) {
      holdTheThreadUp(100);
      await new Promise((r) => setTimeout(r, 120));
    }
    stop();
    expect(seen).toEqual([]);
  });
});
