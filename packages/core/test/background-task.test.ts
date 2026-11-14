import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolDisplay } from '../src/types';
import type { BackgroundWork, ToolOutput } from '../src/tools/types';

// A tool's own work in the background (ctx.inBackground), against a scripted server: in a session someone has open the
// call returns at once and the result comes back later; headless runs do the work in the call.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-bg-task-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

type Reply = { text?: string; call?: { name: string; args: unknown } };
let plan: Reply[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  res.on('error', () => {});
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    const r = plan.shift() ?? { text: 'Done.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.call) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
});

const board = (state: 'on' | 'done'): ToolDisplay => ({ kind: 'stages', stages: [{ label: 'Work', state }], figures: [{ label: '{n} done', n: state === 'done' ? 1 : 0 }] });
/** What the slow tool's work saw: whether it was stopped. */
const seen: { stopped: boolean }[] = [];
const work = (ms: number) => async (bg: BackgroundWork): Promise<ToolOutput> => {
  bg.show(board('on'));
  const stopped = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    bg.signal.addEventListener('abort', () => (clearTimeout(t), resolve(true)), { once: true });
  });
  seen.push({ stopped });
  return stopped ? { content: 'Stopped midway.', isError: true } : { content: 'Work result: 42', display: board('done') };
};

const { createRuntime } = await import('../src/runtime');
const { registerExtension } = await import('../src/extensions/registry');
registerExtension({
  name: 'slow-test',
  tools: [
    {
      binding: {
        def: {
          kind: 'task',
          readOnly: true,
          title: () => 'Slow work',
          async execute(input: { ms: number }, ctx) {
            const run = work(input.ms);
            if (ctx.inBackground) return ctx.inBackground({ description: 'Slow work', resume: 'Call slow_work again.', work: run });
            return run({ signal: ctx.signal, show: () => {}, progress: ctx.progress });
          },
        },
        spec: { name: 'slow_work', description: 'Does slow work.', parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } },
        normalize: (a) => ({ ms: Number(a.ms) }),
      },
    },
  ],
});
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const textOf = (m: { parts: { type: string; text?: string; content?: string }[] }) => m.parts.map((p) => p.text ?? p.content ?? '').join('');
const resultOf = (s: { messages: { parts: { type: string; name?: string }[] }[] }) => s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'slow_work') as { content: string } | undefined;

describe("a tool's work in the background", () => {
  it('returns at once in a session someone has open; the result wakes the session and its card is kept', async () => {
    plan = [{ call: { name: 'slow_work', args: { ms: 1500 } } }, { text: 'It runs in the background.' }, { text: 'The work found 42.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    s.attend();
    await s.send('Do the slow work.');
    expect(resultOf(s)?.content).toMatch(/Running in the background as "Slow work"/);
    expect(s.backgroundRuns()).toMatchObject([{ description: 'Slow work', tool: 'slow_work', display: board('on') }]);
    expect(s.inUse()).toBe(true);
    expect(s.meta.tasks).toMatchObject([{ tool: 'slow_work', state: 'running', resume: 'Call slow_work again.' }]);
    await s.settled();
    const wakes = s.messages.filter((m) => m.origin === 'harness' && textOf(m).includes('Carry on with the work'));
    expect(wakes).toHaveLength(1);
    expect(textOf(wakes[0])).toContain('The slow_work call "Slow work" in the background has finished. Its result:\nWork result: 42');
    expect(textOf(s.messages.at(-1)!)).toBe('The work found 42.');
    expect(s.backgroundRuns()).toEqual([]);
    expect(s.meta.tasks).toMatchObject([{ state: 'done', display: board('done') }]);
  }, 30_000);

  it('is the call itself in a headless run', async () => {
    plan = [{ call: { name: 'slow_work', args: { ms: 10 } } }, { text: 'Found 42.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Do the slow work.');
    expect(resultOf(s)?.content).toBe('Work result: 42');
    expect(s.meta.tasks).toBeUndefined();
  }, 30_000);

  it("ends with the user's stop, and nothing starts a turn after it", async () => {
    seen.length = 0;
    plan = [{ call: { name: 'slow_work', args: { ms: 20_000 } } }, { text: 'Started.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    s.attend();
    await s.send('Do the slow work.');
    expect(s.backgroundRuns()).toHaveLength(1);
    const before = s.messages.length;
    s.abort();
    await s.settled();
    expect(seen).toEqual([{ stopped: true }]);
    expect(s.meta.tasks).toMatchObject([{ state: 'stopped' }]);
    expect(s.messages.length).toBe(before);
  }, 30_000);

  it('cut off by a stop of Favilla: opened again, its card says so and the agent hears how to go on', async () => {
    plan = [{ text: 'Hello.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Hi.');
    // What a crash leaves: the record of work that was going on, and no process doing it.
    rt.store.saveMeta({ ...s.meta, tasks: [{ callId: 'c-gone', tool: 'slow_work', description: 'Slow work', started: Date.now() - 60_000, state: 'running', resume: 'Call slow_work again.' }] });
    rt.live.delete(s.id);
    const again = await rt.get(s.id);
    expect(again.meta.tasks).toMatchObject([{ callId: 'c-gone', state: 'interrupted' }]);
    plan = [{ text: 'Carrying on.' }];
    await again.send('继续');
    const sent = again.messages.filter((m) => textOf(m).includes('was cut off in the background when Favilla stopped. Call slow_work again.'));
    expect(sent).toHaveLength(1);
  }, 30_000);
});
