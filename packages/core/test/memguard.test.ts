import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryFloor, memoryProbe, watchMemory } from '../src/util/memguard';
import { detectShell, runShell } from '../src/tools/shell';

const GB = 1024 ** 3;
const real = { ...memoryProbe };
afterEach(() => Object.assign(memoryProbe, real));

// Free memory as the test says it is, read quickly.
function fake(free: number, total = 32 * GB) {
  const state = { free };
  Object.assign(memoryProbe, { free: () => state.free, total: () => total, everyMs: 40, minRunMs: 100 });
  return state;
}

describe('memory guard', () => {
  it('has a floor of 1.5 GB, or 4% on a small machine', () => {
    expect(memoryFloor(64 * GB)).toBe(1.5 * GB);
    expect(memoryFloor(16 * GB)).toBeCloseTo(0.64 * GB);
  });

  it.skipIf(process.platform === 'darwin')('stops a command when memory runs out while it runs, and says why', async () => {
    const mem = fake(20 * GB);
    const started = Date.now();
    const pending = runShell(detectShell(), 'node -e "setTimeout(() => {}, 30000)"', {
      cwd: os.tmpdir(),
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      logFile: path.join(os.tmpdir(), 'favilla-memguard.log'),
    });
    setTimeout(() => (mem.free = 0.4 * GB), 300);
    const run = await pending;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(run.stoppedFor).toBe('the computer was running out of memory (0.4 GB free of 32.0 GB) while it ran');
    expect(run.exitCode).not.toBe(0);
  }, 30_000);

  it.skipIf(process.platform === 'darwin')('leaves alone a command that started when memory was already short', async () => {
    const mem = fake(1 * GB);
    let why: string | undefined;
    const unwatch = watchMemory((w) => (why = w));
    mem.free = 0.3 * GB;
    await new Promise((r) => setTimeout(r, 400));
    unwatch();
    expect(why).toBeUndefined();
  });

  it.skipIf(process.platform === 'darwin')('does nothing while memory is plentiful', async () => {
    fake(12 * GB);
    let why: string | undefined;
    const unwatch = watchMemory((w) => (why = w));
    await new Promise((r) => setTimeout(r, 300));
    unwatch();
    expect(why).toBeUndefined();
  });
});
