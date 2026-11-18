import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The working line said "Retrying" over a model that was writing its reply (2026-11-17): the detail was set when a
// request was tried again and nothing took it back until the turn ended.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-retry-status-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

let asked = 0;
const flaky = http.createServer((req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
  }
  req.resume();
  req.on('end', () => {
    if (++asked === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable', type: 'api_error' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' } }] });
    setTimeout(() => {
      chunk({ choices: [{ index: 0, delta: { content: 'again.' } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    }, 300);
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', r));
  const port = (flaky.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'flaky/m1',
      tools: 'favilla',
      languageServers: false,
      providers: { flaky: { name: 'Flaky relay', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } },
    }),
  );
});

afterAll(async () => {
  flaky.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the working line after a request is tried again', () => {
  it('says "retrying" while it waits and stops saying so once the reply arrives', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true });
      const seen: string[] = [];
      s.on((e) => {
        if (e.type === 'status') seen.push(`status:${e.status}:${e.detail ?? ''}`);
        else if (e.type.startsWith('stream')) seen.push(e.type);
      });
      await s.send('Say hello.');
      expect(asked).toBe(2);
      const retrying = seen.indexOf('status:running:retrying');
      expect(retrying).toBeGreaterThanOrEqual(0);
      const after = seen.slice(retrying + 1);
      const firstStream = after.findIndex((x) => x.startsWith('stream'));
      const cleared = after.indexOf('status:running:');
      expect(firstStream).toBeGreaterThanOrEqual(0);
      // The plain running status comes back no later than the first piece of the reply.
      expect(cleared).toBeGreaterThanOrEqual(0);
      expect(cleared).toBeLessThanOrEqual(firstStream + 1);
      expect(after.slice(cleared + 1)).not.toContain('status:running:retrying');
    } finally {
      rt.dispose();
    }
  }, 30_000);
});
