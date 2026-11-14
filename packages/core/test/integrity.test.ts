import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pairToolCalls, UNANSWERED } from '../src/context/prune';
import { SessionLocks } from '../src/store/locks';
import type { AgentEvent, Message } from '../src/types';

// A session's history stays whole whatever happens around a turn: a process that ends while a tool runs, a compaction
// asked for by hand during a turn or beside a message, a stop while the turn compacts first. The server below refuses
// what OpenAI refuses: a tool call without its answer right after it, an answer without its call.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-integrity-'));
process.env.FAVILLA_HOME = home;
process.env.FAVILLA_FOLDER_SNAPSHOTS = '0';
process.env.FAVILLA_PREFETCH = '0';
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

type Reply = { text?: string; call?: { name: string; args: Record<string, unknown> }; delayMs?: number };
let handler: (body: { messages: { role: string; content?: unknown; tool_calls?: { id: string }[]; tool_call_id?: string }[] }) => Reply = () => ({ text: 'OK.' });
const refused: string[] = [];
let callNo = 0;

function violation(messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[]): string | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      let j = i - 1;
      while (j >= 0 && messages[j].role === 'tool') j--;
      if (!(messages[j]?.tool_calls ?? []).some((c) => c.id === m.tool_call_id)) return `tool message without its call (${m.tool_call_id})`;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const answered = new Set<string>();
      for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) answered.add(messages[j].tool_call_id!);
      const missing = m.tool_calls.map((c) => c.id).filter((id) => !answered.has(id));
      if (missing.length) return `tool_calls without answers: ${missing.join(', ')}`;
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm1' }] }));
    const body = JSON.parse(raw);
    const bad = violation(body.messages);
    if (bad) {
      refused.push(bad);
      return void res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: bad, type: 'invalid_request_error' } }));
    }
    const r = handler(body);
    if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.call) {
      callNo++;
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${callNo}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text ?? 'OK.' } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
});

const summaryAsked = (b: { messages: { content?: unknown }[] }) => /The context window is nearly full|transcript of a coding session/.test(JSON.stringify(b.messages));
const lastText = (b: { messages: { role: string; content?: unknown }[] }) => JSON.stringify([...b.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
let port = 0;
const config = (extra: Record<string, unknown> = {}) =>
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'fake/m1', tools: 'favilla', modelRegistry: false, languageServers: false, skills: false, providers: { openai: { enabled: false }, fake: { api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } }, ...extra }));

let createRuntime: typeof import('../src/runtime').createRuntime;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  config();
  ({ createRuntime } = await import('../src/runtime'));
});
afterAll(async () => {
  server.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end && !ok(); ) await sleep(25);
  return ok();
};
const said = (m: Message, words: string) => m.parts.some((p) => p.type === 'text' && p.text.includes(words));

describe('what is sent pairs every call with its answer', () => {
  const call = (id: string): Message => ({ id: `a-${id}`, role: 'assistant', parts: [{ type: 'tool_call', id, name: 'shell', input: {} }], time: 0 });
  const result = (id: string): Message => ({ id: `r-${id}`, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: id, name: 'shell', content: 'ran' }], time: 0 });
  const user = (text: string): Message => ({ id: `u-${text}`, role: 'user', origin: 'user', parts: [{ type: 'text', text }], time: 0 });

  it('leaves a whole history as it is, the same objects', () => {
    const h = [user('go'), call('c1'), result('c1')];
    const p = pairToolCalls(h);
    expect(p.messages).toEqual(h);
    expect(p.messages.every((m, i) => m === h[i])).toBe(true);
  });

  it('answers a call the history left open, in the message after it or at the end', () => {
    const mid = pairToolCalls([user('go'), call('c1'), user('hello again')]);
    expect(mid.messages).toHaveLength(3);
    expect(mid.messages[2].parts[0]).toMatchObject({ type: 'tool_result', callId: 'c1', content: UNANSWERED, isError: true });
    expect(said(mid.messages[2], 'hello again')).toBe(true);
    const end = pairToolCalls([user('go'), call('c1')]);
    expect(end.messages.at(-1)?.parts[0]).toMatchObject({ type: 'tool_result', callId: 'c1' });
  });

  it('turns an answer whose call is not there into a line of text, and keeps indexes for the turn start', () => {
    const p = pairToolCalls([user('summary'), result('gone'), call('c2'), call('c3'), result('c3')]);
    expect(p.messages[1].parts[0]).toMatchObject({ type: 'text' });
    expect(p.messages[1].parts.some((x) => x.type === 'tool_result')).toBe(false);
    // c2 is followed by another assistant message: its answer goes in between.
    expect(p.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(p.at(3)).toBe(4);
  });
});

describe('a session stays usable', () => {
  it('after the process ended while a tool ran: the next one answers the call and goes on', async () => {
    handler = () => ({ text: 'Back.' });
    const rt = createRuntime(project, { interactive: false });
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Hello.');
    // What a crash mid-tool leaves: the call saved, its result never.
    rt.store.saveMessage(s.meta, { id: 'm-cut', role: 'assistant', parts: [{ type: 'tool_call', id: 'call_cut', name: 'shell', input: { command: 'sleep 60' } }], time: Date.now() });
    const id = s.id;
    rt.close(id);
    const again = await rt.get(id);
    const last = again.messages.at(-1)!;
    expect(last.parts[0]).toMatchObject({ type: 'tool_result', callId: 'call_cut', isError: true });
    const before = refused.length;
    await again.send('Are you there?');
    expect(refused.length).toBe(before);
    expect(again.messages.at(-1)?.role).toBe('assistant');
    rt.dispose();
  }, 30_000);

  it('asked for twice while it opens: one session, the same for both', async () => {
    handler = () => ({ text: 'Hi.' });
    const rt = createRuntime(project, { interactive: false });
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Hello.');
    const id = s.id;
    rt.close(id);
    const [a, b] = await Promise.all([rt.get(id), rt.get(id, { interactive: true })]);
    expect(a).toBe(b);
    expect(rt.live.get(id)).toBe(a);
    expect(a.messages.at(-1)?.role).toBe('assistant');
    rt.dispose();
  }, 30_000);

  it('compacted by hand while idle: a message sent meanwhile waits and goes after the summary', async () => {
    handler = (b) => (summaryAsked(b) ? { delayMs: 800, text: '<summary>The user said hello.</summary>' } : { text: 'Answer.' });
    const rt = createRuntime(project, { interactive: true });
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('First message.');
    const compacted = s.compact('manual');
    await sleep(150);
    const sent = s.send('Second message, sent during the summary.');
    expect(await compacted).toBe(true);
    await sent;
    await s.settled();
    const active = s.active();
    const summaryAt = active.findIndex((m) => m.origin === 'compaction');
    const secondAt = active.findIndex((m) => m.origin === 'user' && said(m, 'Second message'));
    expect(summaryAt).toBeGreaterThan(-1);
    expect(secondAt).toBeGreaterThan(summaryAt);
    rt.dispose();
  }, 30_000);

  it('compacted by hand while a tool runs: it waits for the next step and nothing is refused', async () => {
    let mains = 0;
    handler = (b) => {
      if (summaryAsked(b)) return { text: '<summary>A slow job was asked for.</summary>' };
      mains++;
      if (mains === 1) return { call: { name: 'shell', args: { command: 'node -e "setTimeout(() => {}, 1200)"', description: 'wait' } } };
      return { text: 'Done.' };
    };
    const rt = createRuntime(project, { interactive: true });
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    const ends: string[] = [];
    s.on((e: AgentEvent) => e.type === 'turn.end' && ends.push(e.reason));
    let toolRunning = false;
    s.on((e: AgentEvent) => e.type === 'tool.start' && (toolRunning = true));
    const before = refused.length;
    const turn = s.send('Run the slow job.');
    expect(await until(() => toolRunning)).toBe(true);
    const compacted = s.compact('manual');
    await turn;
    expect(await compacted).toBe(true);
    await s.send('Next question.');
    expect(refused.length).toBe(before);
    expect(ends.every((r) => r === 'done')).toBe(true);
    rt.dispose();
  }, 30_000);

  it('stopped while the turn compacts first: the message goes back to the composer', async () => {
    handler = (b) => (summaryAsked(b) ? { delayMs: 3000, text: '<summary>s</summary>' } : { text: 'Answer.' });
    const rt = createRuntime(project, { interactive: true });
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send(`First. ${'words '.repeat(400)}`);
    await s.send(`Second. ${'words '.repeat(400)}`);
    // A smaller window: the next turn compacts before its message joins the conversation.
    config({ context: { limit: 4096 } });
    rt.reload();
    const returned: string[] = [];
    s.on((e: AgentEvent) => e.type === 'queue' && e.returned?.length && returned.push(...e.returned.map((x) => x.text)));
    let compacting = false;
    s.on((e: AgentEvent) => e.type === 'compaction' && e.phase === 'start' && (compacting = true));
    const turn = s.send('Third message: please keep this one.');
    expect(await until(() => compacting)).toBe(true);
    s.abort();
    await turn;
    expect(returned).toContain('Third message: please keep this one.');
    config();
    rt.dispose();
  }, 30_000);
});

describe('a session open in another Favilla', () => {
  it('is held while that process lives and touches its lock, and free once it has gone or gone quiet', () => {
    const dir = fs.mkdtempSync(path.join(home, 'locks-'));
    const locks = new SessionLocks(dir);
    locks.take('mine');
    // This process's own lock holds nothing against itself.
    expect(locks.holder('mine')).toBeNull();
    // Another live process (the one that started this test) with a fresh lock.
    fs.writeFileSync(path.join(dir, 'theirs.lock'), JSON.stringify({ pid: process.ppid, beat: Date.now() }));
    expect(locks.holder('theirs')).toEqual({ pid: process.ppid });
    // Gone quiet: a lock nobody touched for minutes.
    fs.writeFileSync(path.join(dir, 'quiet.lock'), JSON.stringify({ pid: process.ppid, beat: Date.now() - 10 * 60_000 }));
    expect(locks.holder('quiet')).toBeNull();
    // An engine the desktop app saw stop, its PID taken by another program meanwhile: its lock holds nothing.
    process.env.FAVILLA_GONE_PIDS = `12345,${process.ppid}`;
    try {
      expect(locks.holder('theirs')).toBeNull();
    } finally {
      delete process.env.FAVILLA_GONE_PIDS;
    }
    expect(locks.holder('theirs')).toEqual({ pid: process.ppid });
    locks.release('mine');
    expect(fs.existsSync(path.join(dir, 'mine.lock'))).toBe(false);
  });

  it('is not opened a second time by the runtime', async () => {
    const rt = createRuntime(project, { interactive: true });
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    const id = s.id;
    rt.close(id);
    fs.writeFileSync(path.join(home, 'sessions', `${id}.lock`), JSON.stringify({ pid: process.ppid, beat: Date.now() }));
    await expect(rt.get(id)).rejects.toThrow(/open in another Favilla/);
    fs.rmSync(path.join(home, 'sessions', `${id}.lock`));
    rt.dispose();
  });
});
