import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The clocks shortened: a dead stream is given up after 1.5 s of nothing, the working line says "thinking" after 0.4 s.
process.env.FAVILLA_STALL_MS = '1500';
process.env.FAVILLA_QUIET_MS = '400';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-quiet-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

/** How each request is answered: kept alive with comments for a while, or left silent, before the words come. */
let plan: ('alive' | 'dead' | 'now')[] = [];
let requests = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    requests++;
    const how = plan.shift() ?? 'now';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const words = () => {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Thought it through.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    if (how === 'now') return words();
    if (how === 'dead') return; // nothing, ever: the client gives it up
    // Thinking out of sight for 3 s, twice the stall limit, with a keep-alive comment every 300 ms.
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 300);
    setTimeout(() => {
      clearInterval(beat);
      words();
    }, 3000);
  });
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'fake/m1', tools: 'favilla', providers: { fake: { api: 'openai-chat', baseUrl: base, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }));
  rt = createRuntime(project, { interactive: true });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a model that thinks out of sight', () => {
  it('is waited for while the stream shows signs of life, with a quiet line and no pop-up', async () => {
    plan = ['alive'];
    requests = 0;
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    const details: (string | undefined)[] = [];
    const notices: string[] = [];
    s.on((e) => {
      if (e.type === 'status') details.push(e.detail);
      if (e.type === 'notice') notices.push(e.text);
    });
    await s.send('Think about it.');
    expect(requests).toBe(1);
    expect(s.messages.at(-1)?.parts.some((p) => p.type === 'text' && p.text === 'Thought it through.')).toBe(true);
    // The working line said so while it waited, and stopped saying it once the words came.
    const at = details.indexOf('thinking');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(details.slice(at + 1)).toContain(undefined);
    expect(notices.filter((n) => /still thinking|nothing has come back/i.test(n))).toEqual([]);
  }, 30_000);

  it('still gives up a stream that sends nothing at all, and asks again', async () => {
    plan = ['dead', 'now'];
    requests = 0;
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await s.send('Again.');
    expect(requests).toBe(2);
    expect(s.messages.at(-1)?.parts.some((p) => p.type === 'text' && p.text === 'Thought it through.')).toBe(true);
  }, 30_000);
});
