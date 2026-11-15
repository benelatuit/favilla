import { describe, expect, it } from 'vitest';
import { selectOptimalPrefixCut } from '../src/context/cache-cut';
import { imageBudget, planSessionImages } from '../src/context/images';
import { filterPruneByPrefixCut, planPrune, prunePays } from '../src/context/prune';
import type { ImagePart, Message } from '../src/types';

const pngData = Buffer.alloc(12_000, 3).toString('base64');

function shot(id: string): ImagePart {
  return {
    type: 'image',
    id,
    mediaType: 'image/png',
    data: pngData,
    width: 1280,
    height: 800,
  };
}

function callMsg(id: string, name: string, input: Record<string, unknown>): Message {
  return { id: `a_${id}`, role: 'assistant', time: 1, parts: [{ type: 'tool_call', id, name, input }] };
}

function resultMsg(id: string, name: string, content: string, images?: ImagePart[]): Message {
  return {
    id: `t_${id}`,
    role: 'user',
    origin: 'tool',
    time: 2,
    parts: [{ type: 'tool_result', callId: id, name, content, ...(images ? { images } : {}) }],
  };
}

describe('optimal prefix-cut cache preservation', () => {
  it('drops back-to-back duplicate screenshots when no large cached suffix sits after the first shot', () => {
    const budget = imageBudget(128_000, 'test-provider');
    const history: Message[] = [
      { id: 'u0', role: 'user', origin: 'user', time: 0, parts: [{ type: 'text', text: 'Inspect the layout.' }] },
      callMsg('s1', 'browser', { action: 'screenshot', url: 'http://127.0.0.1:4173/' }),
      resultMsg('s1', 'browser', 'Page http://127.0.0.1:4173/', [shot('img-01')]),
      callMsg('s2', 'browser', { action: 'screenshot', url: 'http://127.0.0.1:4173/' }),
      resultMsg('s2', 'browser', 'Page http://127.0.0.1:4173/', [shot('img-02')]),
    ];

    const drops = planSessionImages(history, 0, budget, {
      cache: { cachedShare: 0.1, remainingSteps: 10, contextTokens: 8_000, compactAt: 104_960, avgStepGrowth: 2_000 },
    });
    expect(drops.toolDrops.map((d) => d.callId)).toEqual(['s1']);
  });

  it('keeps an earlier screenshot cached when thousands of cached edit tokens sit between the two views', () => {
    const budget = imageBudget(128_000, 'test-provider');
    const history: Message[] = [
      { id: 'u0', role: 'user', origin: 'user', time: 0, parts: [{ type: 'text', text: 'Build and verify the dashboard.' }] },
      callMsg('s1', 'browser', { action: 'screenshot', url: 'http://127.0.0.1:4173/' }),
      resultMsg('s1', 'browser', 'Page http://127.0.0.1:4173/', [shot('img-01')]),
      ...['e1', 'e2', 'e3', 'e4'].flatMap((id) => [
        callMsg(id, 'edit', { path: `src/${id}.tsx`, old: 'a', new: 'b'.repeat(6_000) }),
        resultMsg(id, 'edit', `Updated src/${id}.tsx\n${'x'.repeat(12_000)}`),
      ]),
      callMsg('s2', 'browser', { action: 'screenshot', url: 'http://127.0.0.1:4173/' }),
      resultMsg('s2', 'browser', 'Page http://127.0.0.1:4173/', [shot('img-02')]),
    ];

    const drops = planSessionImages(history, 0, budget, {
      cache: { cachedShare: 0.1, remainingSteps: 8, contextTokens: 36_000, compactAt: 104_960, avgStepGrowth: 4_000 },
    });
    expect(drops.toolDrops).toEqual([]);
  });

  it('always enforces hard wire limits (maxBytes / maxRequestImages) regardless of prefix-cache cost', () => {
    const tightBytes = { ...imageBudget(128_000, 'test-provider'), maxBytes: pngData.length + 100 };
    const history: Message[] = [
      { id: 'u0', role: 'user', origin: 'user', time: 0, parts: [{ type: 'text', text: 'Check two pages.' }] },
      callMsg('s1', 'browser', { action: 'screenshot', url: 'http://127.0.0.1:4173/a' }),
      resultMsg('s1', 'browser', 'Page /a', [shot('img-01')]),
      callMsg('e1', 'edit', { path: 'src/app.tsx', old: 'a', new: 'b'.repeat(25_000) }),
      resultMsg('e1', 'edit', 'x'.repeat(40_000)),
      callMsg('s2', 'browser', { action: 'screenshot', url: 'http://127.0.0.1:4173/b' }),
      resultMsg('s2', 'browser', 'Page /b', [shot('img-02')]),
    ];

    const drops = planSessionImages(history, 0, tightBytes, {
      cache: { cachedShare: 0.1, remainingSteps: 8, contextTokens: 30_000, compactAt: 104_960, avgStepGrowth: 4_000 },
    });
    expect(drops.toolDrops.map((d) => d.callId)).toEqual(['s1']);
  });

  it('skips a tiny early superseded read so a large late build log prunes without busting the early prefix', () => {
    const history: Message[] = [
      { id: 'u0', role: 'user', origin: 'user', time: 0, parts: [{ type: 'text', text: 'Fix failing tests.' }] },
      callMsg('r_early', 'read', { paths: ['src/config.ts'] }),
      resultMsg('r_early', 'read', 'const port = 8080;\n'.repeat(60)),
      ...Array.from({ length: 6 }, (_, i) => [
        callMsg(`m${i}`, 'edit', { path: `src/f${i}.ts`, new: 'code line;\n'.repeat(2_000) }),
        resultMsg(`m${i}`, 'edit', `Updated f${i}.ts\n${'line;\n'.repeat(400)}`),
      ]).flat(),
      callMsg('r_again', 'read', { paths: ['src/config.ts'] }),
      resultMsg('r_again', 'read', 'const port = 9090;\n'.repeat(60)),
      callMsg('big_log', 'shell', { command: 'npm test' }),
      resultMsg('big_log', 'shell', 'test output line\n'.repeat(3_200)),
      ...['k1', 'k2', 'k3', 'k4'].flatMap((id) => [
        callMsg(id, 'shell', { command: `step ${id}` }),
        resultMsg(id, 'shell', 'short'),
      ]),
    ];

    const raw = planPrune(history, 0, 4);
    expect(raw.map((i) => i.callId)).toEqual(['r_early', 'big_log']);

    const filtered = filterPruneByPrefixCut(history, 0, raw, {
      cachedShare: 0.1,
      remainingSteps: 10,
      contextTokens: 70_000,
      compactAt: 104_960,
      avgStepGrowth: 3_000,
    });
    expect(filtered).not.toBeNull();
    expect(filtered!.items.map((i) => i.callId)).toEqual(['big_log']);
    expect(filtered!.invalidatedTokens).toBeLessThan(2_000);
  });

  it('requires meaningful compaction-deferral runway near compactAt', () => {
    const base = { compactAt: 100_000, cachedShare: 0.1, requests: 2 };
    // 16k saving from 92k -> 76k only buys ~2 steps before compaction: reject.
    expect(prunePays({ ...base, context: 92_000, saving: 16_000 })).toBe(false);
    // 26k saving from 92k -> 66k frees >= 22% of compactAt and lands <= 68%: accept.
    expect(prunePays({ ...base, context: 92_000, saving: 26_000 })).toBe(true);
    expect(selectOptimalPrefixCut([], 0, new Map(), { cachedShare: 0.1, remainingSteps: 5 })).toBeNull();
  });
});
