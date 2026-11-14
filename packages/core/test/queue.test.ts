import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Deferred } from '../src/util/async';

// Messages sent while the agent works: shown as waiting, taken back before the agent reads them, delivered at its
// next step, and handed back when the turn is interrupted.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-queue-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

type Reply = { text?: string; call?: { name: string; args: Record<string, unknown> } };
let script: Reply[] = [];
const bodies: string[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    bodies.push(body);
    const r: Reply = script.shift() ?? { text: 'Done.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.call) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', modelRegistry: false, storage: { encrypt: false }, providers: { fake: { api: 'openai-chat', baseUrl: base, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const slow = { call: { name: 'shell', args: { command: 'node -e "setTimeout(() => {}, 800)"', description: 'Wait a moment' } } };
type QueueEvent = { type: 'queue'; items: { id: string; text: string }[]; returned?: { text: string }[] };

describe('messages sent while the agent works', () => {
  it('wait in view, can be taken back, and the rest reach the agent at its next step', async () => {
    script = [slow, { text: 'Read your note.' }];
    bodies.length = 0;
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    const queues: QueueEvent[] = [];
    let started!: () => void;
    const toolStarted = new Promise<void>((r) => (started = r));
    s.on((e) => {
      if (e.type === 'queue') queues.push(e as QueueEvent);
      if (e.type === 'tool.start') started();
    });
    const turn = s.send('Start the slow job.');
    await toolStarted;
    void s.send('First thought, dropped.');
    void s.send('Second thought, kept.');
    expect(s.queued.map((q) => q.text)).toEqual(['First thought, dropped.', 'Second thought, kept.']);
    const back = s.withdraw(s.queued[0].id);
    expect(back?.text).toBe('First thought, dropped.');
    expect(s.queued.map((q) => q.text)).toEqual(['Second thought, kept.']);
    await turn;
    // The kept one went out with the tool's result; the dropped one never did; the queue ended empty.
    expect(bodies[1]).toContain('Second thought, kept.');
    expect(bodies.join('\n')).not.toContain('First thought, dropped.');
    expect(queues.at(-1)?.items).toEqual([]);
    expect(s.withdraw('q-gone')).toBeUndefined();
  }, 30_000);

  it('a message still waiting when Favilla stops comes back when the session is opened again', async () => {
    script = [slow, { text: 'Never reached.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    let started!: () => void;
    const toolStarted = new Promise<void>((r) => (started = r));
    s.on((e) => {
      if (e.type === 'tool.start') started();
    });
    const turn = s.send('Start the slow job.');
    await toolStarted;
    void s.send('Look at the logs too.');
    // Another Favilla opening the session from disk, as after a crash: the message comes back once. (The index of
    // sessions is written 200 ms after a change; the session's own file at once.)
    rt.store.flushIndex();
    const other = createRuntime(project, { interactive: false });
    try {
      const reopened = await other.get(s.id);
      expect(reopened.takeUnread().map((u) => u.text)).toEqual(['Look at the logs too.']);
      expect(reopened.takeUnread()).toEqual([]);
    } finally {
      other.dispose();
    }
    s.abort();
    await turn;
  }, 30_000);

  it('an interrupted turn hands back what the agent never read', async () => {
    script = [slow, { text: 'Never reached.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    const queues: QueueEvent[] = [];
    let started!: () => void;
    const toolStarted = new Promise<void>((r) => (started = r));
    s.on((e) => {
      if (e.type === 'queue') queues.push(e as QueueEvent);
      if (e.type === 'tool.start') started();
    });
    const turn = s.send('Start the slow job.');
    await toolStarted;
    void s.send('Also check the logs.');
    s.abort();
    await turn;
    expect(queues.at(-1)).toMatchObject({ items: [], returned: [{ text: 'Also check the logs.' }] });
    expect(s.queued).toEqual([]);
  }, 30_000);
});


it('keeps returned input across an event reconnect until the window acknowledges it', async () => {
  const { startServer } = await import('../src/server/server');
  const s = await rt.start({ cwd: project, model: 'fake/m1' });
  const server = await startServer({ runtime: rt });
  const auth = { Authorization: 'Bearer ' + server.token };
  const windowId = 'a'.repeat(32);
  const connect = async (after?: string) => {
    const query = new URLSearchParams({ window: windowId, active: s.id, scope: '1', ...(after ? { after } : {}) });
    const res = await fetch(server.url + 'api/events?' + query, { headers: auth, signal: AbortSignal.timeout(3000) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let wire = '';
    try {
      while (!wire.includes('event: ready\n')) {
        const next = await reader.read();
        if (next.done) throw new Error('The event connection closed before replay was ready.');
        wire += decoder.decode(next.value, { stream: true });
      }
      const cursor = [...wire.matchAll(/^id: (.+)$/gm)].at(-1)![1];
      const returned = wire.split('\n').flatMap((line) => line.startsWith('data: ') ? JSON.parse(line.slice(6)).returned ?? [] : []);
      return { cursor, returned };
    } finally { await reader.cancel(); }
  };
  const view = async () => {
    const res = await fetch(server.url + 'api/sessions/' + s.id, { headers: auth });
    return await res.json() as { returned: { id: string; text: string }[] };
  };
  try {
    const disconnected = await connect();
    script = [slow];
    const started = new Promise<void>((resolve) => s.on((e) => { if (e.type === 'tool.start') resolve(); }));
    const turn = s.send('Start the fixture.');
    await started;
    void s.send('Keep this input.');
    s.abort();
    await turn;

    const replay = await connect(disconnected.cursor);
    expect(replay.returned).toMatchObject([{ text: 'Keep this input.' }]);
    expect((await view()).returned).toEqual(replay.returned);
    const received = await fetch(server.url + 'api/sessions/' + s.id + '/returned', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: replay.returned.map((p: { id: string }) => p.id) }),
    });
    expect(received.status).toBe(200);
    expect((await view()).returned).toEqual([]);
    expect((await connect(disconnected.cursor)).returned).toEqual([]);
  } finally {
    await server.close();
  }
}, 15_000);


it('does not recreate a deleted session when preparation is interrupted', async () => {
  const s = await rt.start({ cwd: project, model: 'fake/m1' });
  const entered = new Deferred<void>(), release = new Deferred<void>();
  const control = s as unknown as { shouldCompact(): boolean; compactNow(): Promise<boolean> };
  vi.spyOn(control, 'shouldCompact').mockReturnValue(true);
  vi.spyOn(control, 'compactNow').mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return false;
  });
  const turn = s.send('A message still being prepared.');
  try {
    await entered.promise;
    rt.close(s.id);
    rt.store.delete(s.id);
  } finally {
    release.resolve();
    await turn;
  }
  expect(rt.store.metaOf(s.id)).toBeNull();
});
