import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Runtime } from '../src/runtime';
import type { ServerHandle } from '../src/server/server';
import { BlobStore } from '../src/store/blobs';
import { SessionFollow, type FollowChange } from '../src/store/follow';
import { SessionStore } from '../src/store/sessions';
import type { Message, SessionMeta } from '../src/types';

// A session another Favilla process writes (a terminal, `favilla -p -r <id> --wait-jobs`) is shown here as it is on
// disk and followed as it grows, and nothing here writes it: not its file, its index entry, its blobs or a lock.
// The other process is played by a second store in this process whose lock names the process that started the test.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-follow-'));
process.env.FAVILLA_HOME = home;
process.env.FAVILLA_FOLDER_SNAPSHOTS = '0';
process.env.FAVILLA_PREFETCH = '0';
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-follow-other-'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end && !ok(); ) await sleep(20);
  return ok();
};

let n = 0;
const metaFor = (cwd: string): SessionMeta => {
  const now = Date.now();
  return { id: `s${Date.now().toString(36)}${n++}`, title: 'Held elsewhere', cwd, created: now, updated: now, provider: 'fake', model: 'm1', effort: 'medium', mode: 'build', profile: 'favilla' };
};
const user = (text: string): Message => ({ id: `u-${n++}`, role: 'user', origin: 'user', parts: [{ type: 'text', text }], time: Date.now() });
const reply = (text: string): Message => ({ id: `a-${n++}`, role: 'assistant', parts: [{ type: 'text', text }], time: Date.now() });

/** The writing process: its store holds the session, and the lock says another live process has it. */
function holder(root: string, blobs?: BlobStore) {
  const store = new SessionStore(root, blobs);
  const meta = metaFor(project);
  store.locks.take(meta.id);
  store.create(meta, 'system prompt');
  store.saveMessage(meta, user('first question'));
  store.flushIndex();
  const lock = path.join(root, `${meta.id}.lock`);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, beat: Date.now() }));
  return {
    store,
    meta,
    say: (m: Message) => store.saveMessage(meta, m),
    letGo: () => fs.rmSync(lock, { force: true }),
  };
}

/** Every file under a folder with its bytes' hash, to show nothing was written. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(dir, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const frames = (body: ReadableStream<Uint8Array>) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const got: unknown[] = [];
  let pending = '';
  void (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      const parts = pending.split('\n\n');
      pending = parts.pop()!;
      for (const p of parts) for (const line of p.split('\n')) if (line.startsWith('data: ')) got.push(JSON.parse(line.slice(6)));
    }
  })();
  return got as { added: Message[]; reset: boolean; following: { holder: number | null; home?: string }; meta: SessionMeta }[];
};

describe('a session another process holds', () => {
  it('is read as it is on disk and followed as lines are added, with nothing written', async () => {
    const root = path.join(home, 'sessions');
    const h = holder(root);
    const before = snapshot(root);
    const reader = new SessionStore(root);
    const changes: FollowChange[] = [];
    const follow = SessionFollow.start(reader, h.meta.id, (c) => changes.push(c))!;
    try {
      expect(follow.record.messages.map((m) => m.id)).toEqual(reader.peek(h.meta.id)!.record.messages.map((m) => m.id));
      expect(follow.record.messages).toHaveLength(1);
      expect(follow.holder()).toEqual({ pid: process.ppid });
      expect(snapshot(root)).toEqual(before);

      // A finished reply shows within a second or two.
      const at = Date.now();
      h.say(reply('first answer'));
      expect(await until(() => changes.length > 0)).toBe(true);
      expect(Date.now() - at).toBeLessThan(2000);
      expect(changes[0].added.map((m) => m.role)).toEqual(['assistant']);
      expect(changes[0].reset).toBe(false);
      expect(changes[0].holder).toEqual({ pid: process.ppid });

      // Half a line, as a writer leaves it mid-write, waits for its end.
      const file = path.join(root, reader.peekIndex()![h.meta.id].slug, `${h.meta.id}.jsonl`);
      const line = `${JSON.stringify({ t: 'msg', m: user('second question') })}\n`;
      fs.appendFileSync(file, line.slice(0, 20));
      follow.read();
      expect(follow.record.messages).toHaveLength(2);
      fs.appendFileSync(file, line.slice(20));
      expect(await until(() => follow.record.messages.length === 3)).toBe(true);

      // The holder lets go: one more report, with no holder.
      const seen = changes.length;
      h.letGo();
      follow.read();
      expect(changes).toHaveLength(seen + 1);
      expect(changes.at(-1)!.holder).toBeNull();
      expect(changes.at(-1)!.added).toEqual([]);
    } finally {
      follow.close();
    }
    // Nothing of the reader's: the file, the index and the folder are the writer's alone.
    const after = snapshot(root);
    for (const [f, hash] of Object.entries(before)) if (!f.endsWith('.lock') && !f.endsWith('.jsonl')) expect(after[f], f).toBe(hash);
    expect(Object.keys(after).filter((f) => !(f in before))).toEqual([]);
  });

  it('reads a file rewritten from its start again whole', async () => {
    const root = path.join(home, 'sessions-rewrite');
    const h = holder(root);
    h.say(reply('answer'));
    const reader = new SessionStore(root);
    const changes: FollowChange[] = [];
    const follow = SessionFollow.start(reader, h.meta.id, (c) => changes.push(c))!;
    try {
      const file = path.join(root, reader.peekIndex()![h.meta.id].slug, `${h.meta.id}.jsonl`);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      // Shorter than before, as a compaction that writes the file again leaves it.
      fs.writeFileSync(file, `${lines[0]}\n`);
      follow.read();
      expect(changes.at(-1)!.reset).toBe(true);
      expect(follow.record.messages).toHaveLength(0);
    } finally {
      follow.close();
    }
  });
});

describe('a session put away between runs', () => {
  // A headless run (favilla -p -r <id>) packs the session when it ends and the next one unpacks it.
  it('is followed through being packed and unpacked, without starting over', async () => {
    const root = path.join(home, 'sessions-cold');
    const h = holder(root);
    h.say(reply('first answer'));
    const reader = new SessionStore(root);
    const changes: FollowChange[] = [];
    const follow = SessionFollow.start(reader, h.meta.id, (c) => changes.push(c))!;
    try {
      const dir = path.join(root, reader.peekIndex()![h.meta.id].slug);
      h.letGo();
      expect(await h.store.freeze(h.meta.id)).toBe(true);
      expect(fs.existsSync(path.join(dir, `${h.meta.id}.jsonl`))).toBe(false);
      follow.read();
      expect(changes.every((c) => !c.reset)).toBe(true);
      expect(follow.record.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(changes.at(-1)!.holder).toBeNull();

      // The next run takes it again and saves its first message.
      fs.writeFileSync(path.join(root, `${h.meta.id}.lock`), JSON.stringify({ pid: process.ppid, beat: Date.now() }));
      h.say(user('next question'));
      expect(fs.existsSync(path.join(dir, `${h.meta.id}.jsonl`))).toBe(true);
      follow.read();
      expect(changes.every((c) => !c.reset)).toBe(true);
      expect(follow.record.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(changes.at(-1)!.holder).toEqual({ pid: process.ppid });
    } finally {
      follow.close();
    }
  });
});

describe('the server', () => {
  let rt: Runtime;
  let server: ServerHandle;
  const headers = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };
  const api = (p: string, init?: RequestInit) => fetch(`${server.url}api/${p}`, { headers, ...init });

  beforeAll(async () => {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        model: 'fake/m1', tools: 'favilla', modelRegistry: false, languageServers: false, skills: false,
        providers: { fake: { api: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } },
        storage: { otherHomes: [other] },
      }),
    );
    const { createRuntime } = await import('../src/runtime');
    const { startServer } = await import('../src/server/server');
    rt = createRuntime(project, { interactive: true });
    server = await startServer({ runtime: rt, token: 't' });
  });
  afterAll(async () => {
    await server?.close();
    rt?.dispose();
    for (const d of [home, other]) await fs.promises.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('opens a held session read-only, streams what is saved, and refuses work on it', async () => {
    const root = path.join(home, 'sessions');
    const h = holder(root);
    // The runtime's own index is read before the session was made, as a desktop app started earlier has it.
    const before = snapshot(root);
    const view = await api(`sessions/${h.meta.id}`);
    expect(view.status).toBe(200);
    const body = (await view.json()) as { following: unknown; messages: unknown[] };
    expect(body.following).toEqual({ holder: process.ppid });
    expect(body.messages).toHaveLength(1);
    expect(rt.live.has(h.meta.id)).toBe(false);

    const send = await api(`sessions/${h.meta.id}/send`, { method: 'POST', body: JSON.stringify({ text: 'from here' }) });
    expect(send.status).toBe(409);

    // Saved after the page's view and before its stream: the stream takes up the view's read and still has it.
    h.say(reply('saved between the view and the stream'));
    const abort = new AbortController();
    const stream = await fetch(`${server.url}api/sessions/${h.meta.id}/follow?after=1`, { headers, signal: abort.signal });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const got = frames(stream.body!);
    try {
      expect(await until(() => got.length === 1)).toBe(true);
      expect(got[0].added.map((m) => m.role)).toEqual(['assistant']);
      const at = Date.now();
      h.say(reply('saved by the other process'));
      expect(await until(() => got.length === 2)).toBe(true);
      expect(Date.now() - at).toBeLessThan(2000);
      expect(got[1].added.map((m) => m.role)).toEqual(['assistant']);
      expect(got[1].following.holder).toBe(process.ppid);
    } finally {
      abort.abort();
    }
    expect(rt.live.has(h.meta.id)).toBe(false);
    const after = snapshot(root);
    for (const f of Object.keys(before).filter((f) => f.includes(h.meta.id) && f.endsWith('.lock'))) expect(after[f], f).toBe(before[f]);
    expect(Object.keys(after).filter((f) => f.includes(h.meta.id) && !(f in before))).toEqual([]);
  });

  it('lists another Favilla folder’s sessions and only reads them', async () => {
    const root = path.join(other, 'sessions');
    const h = holder(root, new BlobStore(path.join(other, 'blobs')));
    h.letGo();
    const before = snapshot(other);
    const list = (await (await api(`sessions?cwd=${encodeURIComponent(project)}`)).json()) as { id: string; home?: string }[];
    const row = list.find((s) => s.id === h.meta.id)!;
    expect(row).toMatchObject({ id: h.meta.id, live: null, home: other.replace(/\\/g, '/').replace(os.homedir().replace(/\\/g, '/'), '~') });

    const view = (await (await api(`sessions/${h.meta.id}`)).json()) as { following: unknown; messages: unknown[] };
    expect(view.following).toMatchObject({ holder: null, home: row.home });
    expect(view.messages).toHaveLength(1);

    for (const [route, method] of [['send', 'POST'], ['settings', 'POST'], ['changes', 'GET'], ['', 'DELETE']] as const) {
      const response = await api(`sessions/${h.meta.id}${route ? `/${route}` : ''}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(response.status, `${method} ${route}`).toBe(409);
    }
    expect(rt.live.has(h.meta.id)).toBe(false);
    expect(snapshot(other)).toEqual(before);
    // Nothing of it lands in this folder either.
    expect(fs.existsSync(path.join(home, 'sessions', `${h.meta.id}.lock`))).toBe(false);
  });
});
