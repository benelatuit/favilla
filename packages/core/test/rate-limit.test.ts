import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A relay that turns requests away for a while, against a scripted server: a rate limit is waited out longer than a
// server error when someone is waiting; with nobody waiting, as long, and both have an end.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-rate-limit-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

/** How the next requests are refused before one is answered: a status, so many times. */
let refuse = { status: 429, times: 0 };
let requests = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    requests++;
    if (refuse.times > 0) {
      refuse.times--;
      // The server says how long to wait, a few milliseconds, so the test does not sit through real waits.
      res.writeHead(refuse.status, { 'Content-Type': 'application/json', 'retry-after-ms': '10' });
      return void res.end(JSON.stringify({ error: { message: refuse.status === 429 ? 'Your requests have exceeded token rate limit.' : 'Internal error.', type: refuse.status === 429 ? 'rate_limit_error' : 'server_error' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Answered.' } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 2 } });
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
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const lastText = (s: { messages: { role: string; parts: { type: string; text?: string }[] }[] }) =>
  [...s.messages].reverse().find((m) => m.role === 'assistant')?.parts.map((p) => p.text ?? '').join('') ?? '';

describe('a provider that turns requests away for a while', () => {
  it('waits out a rate limit past the tries a server error gets', async () => {
    refuse = { status: 429, times: 9 };
    requests = 0;
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Hello.');
    expect(requests).toBe(10);
    expect(lastText(s)).toBe('Answered.');
  }, 30_000);

  // With nobody waiting, an outage is waited out as long as a rate limit: seven tries had ended 10 of 16 eval runs on
  // a relay that cut a third of its requests for hours (2026-11-06). It still has an end.
  it('waits a failing server out as long as a rate limit when nobody is waiting, and gives up after those tries', async () => {
    refuse = { status: 500, times: 9 };
    requests = 0;
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Hello.');
    expect(requests).toBe(10);
    expect(lastText(s)).toBe('Answered.');
    refuse = { status: 500, times: 20 };
    requests = 0;
    const t = await rt.start({ cwd: project, model: 'fake/m1' });
    await t.send('Hello.');
    expect(requests).toBe(13);
    expect(lastText(t)).not.toBe('Answered.');
    refuse = { status: 500, times: 0 };
  }, 60_000);
});
