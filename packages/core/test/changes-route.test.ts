import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A session against a model server of our own: everything stays in a scratch home and costs nothing.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-changes-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

const fake = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'done' } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } });
    res.end('data: [DONE]\n\n');
  });
});

const { createRuntime } = await import('../src/runtime');
const { startServer } = await import('../src/server/server');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ model: 'fake/m1', providers: { fake: { api: 'openai-chat', baseUrl: base, auth: 'none', local: true, models: { m1: { contextWindow: 32000 } } } } }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  try {
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Windows can hold files written a moment ago: a scratch folder left in the temp folder is no failure here.
  }
});

describe('a turn\'s changes', () => {
  it('gives one file with every unchanged line around its changes when asked for it', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('change line 50');
    expect(s.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'done' }]);
    const turn = s.messages[0].turn!;
    const file = path.join(project, 'long.txt');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    s.checkpoints.capture(turn, file);
    lines[49] = 'line fifty';
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const server = await startServer({ runtime: rt, token: 't' });
    const get = async (route: string) => {
      const r = await fetch(`${server.url}api/sessions/${s.id}/${route}`, { headers: { Authorization: 'Bearer t' } });
      return { status: r.status, body: (await r.json()) as any };
    };
    try {
      const list = await get(`changes/${turn}`);
      expect(list.status).toBe(200);
      const short = list.body[0].files[0];
      expect(short).toMatchObject({ path: 'long.txt', op: 'update', added: 1, removed: 1 });
      expect(short.patch.split('\n')[0]).toBe('@@ -47,7 +47,7 @@');

      const one = await get(`changes/${turn}?file=${encodeURIComponent('long.txt')}`);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ path: 'long.txt', op: 'update', added: 1, removed: 1 });
      const patch: string[] = one.body.patch.split('\n');
      expect(patch[0]).toBe('@@ -1,100 +1,100 @@');
      expect(patch.filter((l) => l.startsWith(' '))).toHaveLength(99);

      expect((await get(`changes/${turn}?file=${encodeURIComponent('other.txt')}`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
