import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Compaction in the background against a scripted server whose usage numbers make the context grow: the summary
// is written while the agent goes on working, and swapped in at the mark with everything since kept word for word.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-draft-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
for (let i = 0; i < 14; i++) fs.writeFileSync(path.join(project, `a${i}.ts`), `export const a${i} = ${i};\n`);
for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(project, `big${i}.txt`), `${`line-${i}-`.padEnd(80, 'x')}\n`.repeat(220));

const timeline: { kind: 'main' | 'summary-start' | 'summary-end'; at: number; prompt?: number; body?: string }[] = [];
let mainSeq = 0;
let summarySeq = 0;
// The context each main request reports, step by step. A 100k window here compacts at 82000: the background summary
// starts past 61500 (third step) and is swapped in once the mark is passed (twelfth step).
let script: { prompt: number; cached?: number; read?: string; delayMs?: number; summaryMs?: number }[] = [
  20_000, 40_000, 62_000, 64_000, 66_000, 68_000, 70_000, 72_000, 74_000, 76_000, 78_000, 83_000, 40_000, 41_000,
].map((prompt, i) => ({ prompt, read: i < 13 ? `a${i % 14}.ts` : undefined }));

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    const json = JSON.parse(body);
    const last = JSON.stringify(json.messages?.at(-1) ?? '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (last.includes('The context window is nearly full')) {
      const idx = ++summarySeq;
      timeline.push({ kind: 'summary-start', at: Date.now() });
      await new Promise((r) => setTimeout(r, script[Math.max(0, mainSeq - 1)]?.summaryMs ?? 1500));
      const tag = idx === 1 ? 'SUMMARY-OF-EARLY-WORK' : `SUMMARY-OF-EARLY-WORK-${idx}`;
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: `<summary>${tag}</summary>` } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk({ choices: [], usage: { prompt_tokens: 60_000, completion_tokens: 50 } });
      timeline.push({ kind: 'summary-end', at: Date.now() });
      return void res.end('data: [DONE]\n\n');
    }
    const n = mainSeq++;
    const step = script[n];
    timeline.push({ kind: 'main', at: Date.now(), prompt: step?.prompt, body });
    await new Promise((r) => setTimeout(r, step?.delayMs ?? 200));
    if (step?.read) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${n}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ paths: [step.read] }) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'All done.' } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({
      choices: [],
      usage: {
        prompt_tokens: step?.prompt ?? 30_000,
        completion_tokens: 5,
        ...(step?.cached !== undefined ? { prompt_tokens_details: { cached_tokens: step.cached } } : {}),
      },
    });
    res.end('data: [DONE]\n\n');
  });
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'fake/m1',
      tools: 'favilla',
      languageServers: false,
      // On this computer, as a proxy to a cloud service is, and saying it answers several requests at once.
      providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, slots: 4, models: { m1: { contextWindow: 100_000, family: 'gpt' } } } },
    }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('compaction in the background', () => {
  it('writes the summary while the agent works and swaps it in at the mark, keeping what came after', async () => {
    const s = await rt.start({ cwd: project });
    const statuses: string[] = [];
    s.on((e) => e.type === 'status' && statuses.push(e.status));
    await s.send('Read the files one by one.');

    const start = timeline.find((t) => t.kind === 'summary-start')!;
    const end = timeline.find((t) => t.kind === 'summary-end')!;
    expect(start).toBeTruthy();
    // It started once the context passed three quarters of the mark, and the agent kept going while it was written.
    const before = timeline.filter((t) => t.kind === 'main' && t.at < start.at);
    expect(before.at(-1)!.prompt).toBeGreaterThanOrEqual(50_000);
    const during = timeline.filter((t) => t.kind === 'main' && t.at > start.at && t.at < end.at);
    expect(during.length).toBeGreaterThanOrEqual(2);
    // Only one summary was written: the background one was used, not a second, blocking one.
    expect(timeline.filter((t) => t.kind === 'summary-start')).toHaveLength(1);

    const comp = s.messages.find((m) => m.origin === 'compaction')!;
    expect(JSON.stringify(comp.parts)).toContain('SUMMARY-OF-EARLY-WORK');
    const at = s.messages.indexOf(comp);
    const copies = s.messages.slice(at + 1).filter((m) => m.replay);
    expect(copies.length).toBeGreaterThanOrEqual(4);
    expect(copies[0].role).toBe('assistant');
    // The request after the swap carries the summary and the work since the snapshot, word for word.
    const after = timeline.filter((t) => t.kind === 'main' && t.at > end.at);
    expect(after.length).toBeGreaterThanOrEqual(1);
    const next = JSON.parse(after.at(-1)!.body!);
    const text = JSON.stringify(next.messages);
    expect(text).toContain('SUMMARY-OF-EARLY-WORK');
    expect(text).toContain(copies[0].parts.find((p) => p.type === 'tool_call') ? (copies[0].parts.find((p) => p.type === 'tool_call') as { id: string }).id : 'c');
    // Nobody waited on it.
    expect(statuses).not.toContain('compacting');
    expect(s.messages.at(-1)?.parts.some((p) => p.type === 'text' && p.text === 'All done.')).toBe(true);
  });

  it('prunes near the mark after a draft began, drops the stale draft, and resets prune counts at compaction', async () => {
    timeline.length = 0;
    mainSeq = 0;
    summarySeq = 0;
    const preWarm = Array.from({ length: 26 }, (_, i) => ({ prompt: 20_000 + i * 1_000, cached: 10_000, read: `a${i % 14}.ts`, delayMs: 5, summaryMs: 25 }));
    const preBig = [0, 1, 2].map((i) => ({ prompt: 48_000 + i * 3_000, cached: 35_000, read: `big${i}.txt`, delayMs: 5, summaryMs: 25 }));
    const toPrune = [57_000, 60_000, 63_000, 68_000, 72_000, 76_000].map((prompt, i) => ({
      prompt,
      cached: 50_000,
      read: `a${i % 14}.ts`,
      delayMs: 15,
      summaryMs: 25,
    }));
    const afterPrune = [60_000, 66_000, 72_000, 83_000].map((prompt, i) => ({
      prompt,
      cached: 45_000,
      read: `a${(i + 6) % 14}.ts`,
      delayMs: 20,
      summaryMs: 20,
    }));
    const postBig = [0, 1, 2].map((i) => ({ prompt: 30_000 + i * 4_000, cached: 20_000, read: `big${i}.txt`, delayMs: 5 }));
    const postSmall = [44_000, 46_000, 48_000, 50_000, 52_000, 55_000].map((prompt, i) => ({ prompt, cached: 40_000, read: `a${i % 14}.ts`, delayMs: 5 }));
    script = [...preWarm, ...preBig, ...toPrune, ...afterPrune, ...postBig, ...postSmall, { prompt: 56_000, cached: 50_000, delayMs: 5 }];

    const s = await rt.start({ cwd: project });
    const phases: string[] = [];
    s.on((e) => e.type === 'compaction' && phases.push(e.phase));
    await s.send('Inspect all modules.');

    expect(phases).toEqual(['pruned', 'start', 'end']);
    expect(timeline.filter((t) => t.kind === 'summary-start')).toHaveLength(2);
    const comp = s.messages.find((m) => m.origin === 'compaction')!;
    expect(JSON.stringify(comp.parts)).toContain('SUMMARY-OF-EARLY-WORK-2');
    expect(comp.compacted?.rounds).toBeLessThanOrEqual(4);
  });
});
