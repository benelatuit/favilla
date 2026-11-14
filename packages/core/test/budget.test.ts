import { describe, expect, it } from 'vitest';
import { computeBudget } from '../src/context/budget';
import type { ModelInfo } from '../src/catalog/catalog';

const model = (contextWindow: number, maxOutput = 128_000) => ({ contextWindow, maxOutput }) as ModelInfo;

describe('computeBudget', () => {
  it('sizes a 48k local model so there is room to work', () => {
    const b = computeBudget(model(49_152, 32_768), {});
    expect(b.maxOutput).toBe(12_288);
    expect(b.compactAt).toBeLessThan(49_152 - b.maxOutput);
    expect(b.compactAt).toBeGreaterThan(30_000);
    expect(b.toolOutputChars).toBeGreaterThanOrEqual(6_000);
    expect(b.toolOutputChars).toBeLessThan(20_000);
  });

  it('caps large models at the 256k sweet spot by default while honoring explicit limits and per-model overrides', () => {
    const def = computeBudget(model(1_000_000), {});
    expect(def.window).toBe(256_000);
    expect(def.maxOutput).toBe(32_000);
    expect(def.compactAt).toBe(209_920);
    expect(def.toolOutputChars).toBe(40_000);

    const raised = computeBudget(model(1_000_000), { context: { limit: 400_000 } });
    expect(raised.window).toBe(400_000);
    expect(raised.maxOutput).toBe(64_000);
    expect(raised.compactAt).toBe(328_000);

    const uncapped = computeBudget(model(272_000), { context: { limit: 0 } });
    expect(uncapped.window).toBe(272_000);
    expect(uncapped.maxOutput).toBe(64_000);
    expect(uncapped.compactAt).toBeLessThanOrEqual(272_000 - 64_000);

    const overridden = computeBudget({ ...model(400_000), provider: 'happy', id: 'm1' }, { providers: { happy: { models: { m1: { contextWindow: 400_000 } } } } });
    expect(overridden.window).toBe(400_000);
  });

  it('respects the configured compaction share', () => {
    expect(computeBudget(model(200_000), { context: { compactAt: 0.5 } }).compactAt).toBe(100_000);
  });
});
