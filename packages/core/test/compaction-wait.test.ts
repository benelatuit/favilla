import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-draft-wait-'));
delete process.env.FAVILLA_HOME;
delete process.env.FAVILLA_DRAFT_WAIT_MS;
process.env.FAVILLA_HOME = path.join(home, 'favilla');
process.env.FAVILLA_DRAFT_WAIT_MS = '200';
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(project, `f${i}.ts`), `export const f${i} = ${i};\n`);

let summaryCall = 0;
let hangFirstSummary = true;
let firstSummaryAborted = false;
let mainIdx = 0;
let steps: { prompt: number; read?: string; delayMs?: number }[] = [];

const fake = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8').on('data', (c) => (raw += c));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    const wire = JSON.parse(raw);
    const last = JSON.stringify(wire.messages?.at(-1) ?? '');
    const first = JSON.stringify(wire.messages?.[0] ?? '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);

    if (last.includes('The context window is nearly full') || first.includes('Here is a transcript of a coding session')) {
      const n = ++summaryCall;
      if (n === 1 && hangFirstSummary) {
        req.on('close', () => {
          if (!res.writableEnded) firstSummaryAborted = true;
        });
        res.flushHeaders();
        // Hold the stream open silently until the caller's bound aborts it.
        return;
      }
      await new Promise((r) => setTimeout(r, hangFirstSummary ? 20 : 60));
      const tag = hangFirstSummary ? 'SUMMARY-FRESH-FALLBACK' : 'SUMMARY-WAITED-IN-TIME';
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: `<summary>${tag}</summary>` } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: 60_000, completion_tokens: 40 } });
      return void res.end('data: [DONE]\n\n');
    }

    const step = steps[mainIdx++] ?? { prompt: 30_000 };
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (step.read) {
      send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${mainIdx}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ paths: [step.read] }) } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    send({ choices: [], usage: { prompt_tokens: step.prompt, completion_tokens: 10 } });
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
      modelRegistry: false,
      languageServers: false,
      skills: false,
      providers: {
        fake: {
          name: 'Fake',
          api: 'openai-chat',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          auth: 'none',
          local: true,
          slots: 4,
          models: { m1: { contextWindow: 100_000, family: 'gpt' } },
        },
      },
    }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  delete process.env.FAVILLA_DRAFT_WAIT_MS;
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('bounded wait on an in-flight background summary', () => {
  it('bounds the wait on a hung draft, aborts its socket, falls back to compactNow, and emits one start/end pair', async () => {
    // 100k window (maxOutput 8,192) -> compactAt = 82,000, DRAFT_AT = 61,500, room = 88,808.
    // Step 3 (65,000) starts draft #1 (hung); step 4 (90,000 >= room) hits useDraft(), times out at ~200ms, and compacts fresh.
    summaryCall = 0;
    hangFirstSummary = true;
    firstSummaryAborted = false;
    mainIdx = 0;
    steps = [
      { prompt: 25_000, read: 'f0.ts' },
      { prompt: 45_000, read: 'f1.ts' },
      { prompt: 65_000, read: 'f2.ts', delayMs: 20 },
      { prompt: 90_000, read: 'f3.ts', delayMs: 20 },
      { prompt: 35_000 },
    ];

    const s1 = await rt.start({ cwd: project });
    const phases1: string[] = [];
    s1.on((e) => e.type === 'compaction' && phases1.push(e.phase));
    const started = Date.now();
    await s1.send('Inspect modules.');
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3_000);
    await expect.poll(() => firstSummaryAborted, { timeout: 1_000 }).toBe(true);
    expect(summaryCall).toBe(2);
    expect(phases1).toEqual(['start', 'end']);
    const comp1 = s1.messages.find((m) => m.origin === 'compaction')!;
    const compText1 = JSON.stringify(comp1.parts);
    expect(compText1).toContain('SUMMARY-FRESH-FALLBACK');
    expect(compText1).toContain('Continue the work from where it stopped');

    // When the in-flight draft finishes within the bound, useDraft() installs it directly with a single start/end pair.
    summaryCall = 0;
    hangFirstSummary = false;
    mainIdx = 0;
    steps = [
      { prompt: 25_000, read: 'f0.ts' },
      { prompt: 45_000, read: 'f1.ts' },
      { prompt: 65_000, read: 'f2.ts', delayMs: 5 },
      { prompt: 90_000, read: 'f3.ts', delayMs: 5 },
      { prompt: 35_000 },
    ];

    const s2 = await rt.start({ cwd: project });
    const phases2: string[] = [];
    const statuses2: string[] = [];
    s2.on((e) => {
      if (e.type === 'compaction') phases2.push(e.phase);
      if (e.type === 'status') statuses2.push(e.status);
    });
    await s2.send('Inspect modules quickly.');

    expect(summaryCall).toBe(1);
    expect(phases2).toEqual(['start', 'end']);
    expect(statuses2).toContain('compacting');
    const comp2 = s2.messages.find((m) => m.origin === 'compaction')!;
    expect(JSON.stringify(comp2.parts)).toContain('SUMMARY-WAITED-IN-TIME');
  });
});
