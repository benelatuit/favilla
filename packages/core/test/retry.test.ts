import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorFromStatus } from '../src/net/http';
import { triesFor } from '../src/agent/session';

// A relay that went down on 2026-11-02 answered every request with 503 for an hour, and each request took 184 s of
// retries to fail, its errors sometimes a whole HTML page. With the user waiting, Favilla now says so after three tries.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-retry-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

let hits = 0;
const down = http.createServer((req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
  }
  hits++;
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable', type: 'api_error' } }));
});
let port = 0;

// A relay that cuts long replies: the first reply streams a long file and the connection drops; the next is answered.
const cutBodies: string[] = [];
const cutter = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    cutBodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const sent = JSON.parse(body).messages as { role: string; content: unknown }[];
    const asked = sent.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content)).join('\n');
    const replies = sent.filter((m) => m.role === 'assistant').length;
    const cut = () => setTimeout(() => res.socket?.destroy(), 50);
    // A long text reply, cut: the first time only.
    if (asked.includes('Write the whole program.') && replies === 0) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: `Here is the whole program:\n${'x = 1\n'.repeat(900)}` } }] });
      return void cut();
    }
    // A new file being written, or an existing one rewritten, cut in its 31st line: the first time it is asked.
    const lastAsk = sent.map((m) => m.role).lastIndexOf('user');
    const writeOf = /(Make|Rewrite|Draft) (\S+) now/.exec(JSON.stringify(sent[lastAsk]?.content ?? ''));
    if (writeOf && !sent.slice(lastAsk).some((m) => m.role === 'tool')) {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1} ${'#'.repeat(60)}`).join('\n');
      // Drafted with its content first, cut in the middle of its path.
      const args = writeOf[1] === 'Draft' ? JSON.stringify({ content: `${lines}\n`, path: writeOf[2] }).slice(0, -6) + '"' : JSON.stringify({ path: writeOf[2], content: `${lines}\nline 31 is cu` });
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${writeOf[1]}`, type: 'function', function: { name: 'write', arguments: args.slice(0, -2) } }] } }] });
      return void cut();
    }
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Short now.' } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
  });
});
let cutPort = 0;

beforeAll(async () => {
  await new Promise<void>((r) => down.listen(0, '127.0.0.1', r));
  port = (down.address() as AddressInfo).port;
  await new Promise<void>((r) => cutter.listen(0, '127.0.0.1', r));
  cutPort = (cutter.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'down/m1',
      tools: 'favilla',
      languageServers: false,
      providers: {
        down: { name: 'Down relay', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } },
        cut: { name: 'Cutting relay', api: 'openai-chat', baseUrl: `http://127.0.0.1:${cutPort}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } },
      },
    }),
  );
});

afterAll(async () => {
  down.close();
  cutter.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a provider that does not answer', () => {
  it('reads an HTML error page by its title', () => {
    const page = '<!DOCTYPE html><html><head><title>relay.example | 524: A timeout occurred</title></head><body><div>lots of markup</div></body></html>';
    expect(errorFromStatus(524, new Headers(), page, 'gateway').message).toBe('gateway: relay.example | 524: A timeout occurred');
  });

  it('waits an outage out as long as a rate limit when nobody is waiting, and no longer when someone is', () => {
    for (const kind of ['server', 'overloaded', 'network', 'stream_stalled']) expect(triesFor(kind, false)).toBe(triesFor('rate_limit', true));
    expect(triesFor('server', true)).toBe(7);
    expect(triesFor('rate_limit', false)).toBe(triesFor('rate_limit', true));
    expect(triesFor('server', false)).toBeGreaterThan(7);
    expect(triesFor('invalid_request', false)).toBe(7);
  });

  it('is reported to a waiting user after three tries, not after three minutes', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true });
      const notices: string[] = [];
      s.on((e) => e.type === 'notice' && notices.push(e.text));
      const started = Date.now();
      await s.send('Say hello.').catch(() => undefined);
      expect(hits).toBe(3);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(notices.join('\n')).toMatch(/no answer after 3 tries: the service may be down/);
    } finally {
      rt.dispose();
    }
  }, 30_000);

  it('keeps a long reply the connection cut off, and asks for the rest of it', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true, model: 'cut/m1' });
      const before = cutBodies.length;
      await s.send('Write the whole program.');
      expect(cutBodies.length - before).toBe(2);
      const next = JSON.parse(cutBodies.at(-1)!).messages as { role: string; content: string }[];
      expect(next.find((m) => m.role === 'assistant')?.content).toMatch(/^Here is the whole program:\n(x = 1\n){100}/);
      expect(JSON.stringify(next.at(-1))).toContain('The connection dropped while your reply was being written; what arrived is kept above.');
    } finally {
      rt.dispose();
    }
  }, 30_000);

  it('writes the complete lines of a new file cut off mid-write and says where to go on; an existing file stays as it was', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true, model: 'cut/m1' });
      await s.send('Make fresh.txt now');
      const written = fs.readFileSync(path.join(project, 'fresh.txt'), 'utf8');
      expect(written.split('\n')).toHaveLength(31);
      expect(written.endsWith('\n')).toBe(true);
      expect(written).not.toContain('line 31');
      expect(cutBodies.at(-1)).toContain('its first 30 complete lines are written, and nothing after them. Add the rest from line 31 with edits');

      fs.writeFileSync(path.join(project, 'old.txt'), 'keep me\n');
      await s.send('Rewrite old.txt now');
      expect(fs.readFileSync(path.join(project, 'old.txt'), 'utf8')).toBe('keep me\n');
      expect(cutBodies.at(-1)).toContain('This tool call was cut off by the connection dropping mid-reply, so it did not run.');

      // Its content sent first and the cut in its path: no file of a half name.
      await s.send('Draft src/config.ts now');
      expect(fs.readdirSync(project).filter((f) => f.startsWith('src'))).toEqual([]);
      expect(cutBodies.at(-1)).toContain('This tool call was cut off by the connection dropping mid-reply, so it did not run.');
    } finally {
      rt.dispose();
    }
  }, 30_000);
});
