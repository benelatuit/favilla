import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A model that nothing describes is planned at a guessed window. When its server refuses a request for size, the
// session plans a tenth under what was refused; this keeps that figure for the sessions after it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-window-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

// A relay whose model takes less than anyone says: it refuses the first request of each model, then answers.
const refusedOnce = new Set<string>();
const bodies: string[] = [];
const relay = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'brand-new-7' }, { id: 'set-by-hand' }] }));
    }
    bodies.push(body);
    const model = String(JSON.parse(body).model);
    if (!refusedOnce.has(model)) {
      refusedOnce.add(model);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: "This model's maximum context length is 9000 tokens. However, your messages resulted in more tokens.", type: 'invalid_request_error' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello.' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
  const port = (relay.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'relay/brand-new-7',
      tools: 'favilla',
      languageServers: false,
      providers: { relay: { name: 'Relay', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', discover: 'openai', models: { 'set-by-hand': { contextWindow: 200_000 } } } },
    }),
  );
});

afterAll(async () => {
  relay.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a window nobody states, refused by the server', () => {
  it('is planned smaller for the rest of the session and from the first request of the next', async () => {
    const { createRuntime } = await import('../src/runtime');
    const cache = path.join(process.env.FAVILLA_HOME!, 'cache', 'windows-learned.json');
    let learned = 0;
    const rt = createRuntime(project, { interactive: true });
    try {
      expect(rt.catalog.resolve('relay/brand-new-7')).toMatchObject({ contextWindow: 128_000, windowAssumed: true });
      const s = await rt.start({ cwd: project, interactive: true });
      const windows: number[] = [];
      s.on((e) => e.type === 'usage' && windows.push(e.usage.contextWindow));
      await s.send('Say hello.');
      learned = JSON.parse(fs.readFileSync(cache, 'utf8'))['relay/brand-new-7'].window;
      // A tenth under what the refused request held: more than the tools and the prompt, far less than the guess.
      expect(learned).toBeGreaterThan(8192);
      expect(learned).toBeLessThan(40_000);
      expect(windows.at(-1)).toBe(learned);
    } finally {
      rt.dispose();
    }
    const next = createRuntime(project, { interactive: true });
    try {
      expect(next.catalog.resolve('relay/brand-new-7')).toMatchObject({ contextWindow: learned, windowAssumed: true });
    } finally {
      next.dispose();
    }
  }, 60_000);

  it('is not kept past the session when the window was set by hand', async () => {
    const { createRuntime } = await import('../src/runtime');
    const cache = path.join(process.env.FAVILLA_HOME!, 'cache', 'windows-learned.json');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true, model: 'relay/set-by-hand' });
      await s.send('Say hello.');
      expect(JSON.parse(fs.readFileSync(cache, 'utf8'))['relay/set-by-hand']).toBeUndefined();
      expect(rt.catalog.resolve('relay/set-by-hand').contextWindow).toBe(200_000);
    } finally {
      rt.dispose();
    }
  }, 60_000);
});
