import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLines } from '../src/store/seal';

// A whole session against a model server of our own: everything stays in a scratch home and costs nothing.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-branch-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

/** An OpenAI-compatible server that answers every request with "reply N", streamed. */
let replies = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    replies++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: `reply ${replies}` } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 5 } });
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
    // Windows can hold files written a moment ago (a virus scan, the indexer): a scratch folder left in the temp
    // folder is no failure of the branches tested here.
  }
});

// What the user and the model said, without Favilla's notes (the folder's facts open every first message).
const texts = (ms: { role: string; parts: { type: string; text?: string; synthetic?: boolean }[] }[]) => ms.map((m) => `${m.role}: ${m.parts.filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('')}`);

describe('branches', () => {
  it('start from a message, copy the history up to it, and leave the source as it was', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('first question');
    await s.send('second question');
    expect(texts(s.messages)).toEqual(['user: first question', 'assistant: reply 1', 'user: second question', 'assistant: reply 2']);
    const second = s.messages[2].id;

    // Editing the second question: a branch that stops just before it, then the changed text.
    const edit = await rt.fork(s, second, 'before');
    expect(edit.id).not.toBe(s.id);
    expect(edit.meta.branchOf).toEqual({ id: s.id, title: s.meta.title, message: second });
    expect(texts(edit.messages)).toEqual(['user: first question', 'assistant: reply 1']);
    await edit.send('second question, asked differently');
    expect(texts(edit.messages).slice(2)).toEqual(['user: second question, asked differently', 'assistant: reply 3']);

    // Branching after the first answer takes the whole first turn.
    const after = await rt.fork(s, s.messages[0].id, 'after');
    expect(texts(after.messages)).toEqual(['user: first question', 'assistant: reply 1']);

    // The source is untouched, and a branch reloads from disk as it was saved.
    expect(texts(s.messages)).toHaveLength(4);
    rt.close(edit.id);
    const reopened = await rt.get(edit.id);
    expect(texts(reopened.messages)).toEqual(['user: first question', 'assistant: reply 1', 'user: second question, asked differently', 'assistant: reply 3']);
    expect(reopened.meta.branchOf?.id).toBe(s.id);
  });

  it('refuses a message the session does not have', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await expect(rt.fork(s, 'nope', 'before')).rejects.toThrow(/not in this session/);
  });

  it('a branch of a session someone is at can ask them, whatever the runtime defaults to', async () => {
    const attended = (x: unknown) => (x as { interactive: boolean }).interactive;
    // The desktop's runtime starts sessions without anyone by default; a branch made from the app took that and
    // answered its own questions with "nobody is available" (2026-11-02).
    const s = await rt.start({ cwd: project, model: 'fake/m1', interactive: true });
    await s.send('a question');
    const { session: edit } = await rt.branch(s, s.messages[0].id, 'before', { text: 'the question, asked again' });
    expect(attended(edit)).toBe(true);
    // A session first loaded without anyone (here the runtime's default) is someone's once a front end opens it.
    const quiet = await rt.start({ cwd: project, model: 'fake/m1' });
    expect(attended(quiet)).toBe(false);
    expect(attended(await rt.get(quiet.id, { interactive: true }))).toBe(true);
  });

  it('reads the history from the file of its source, with the compaction it was made with', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('first question');
    await s.send('second question');
    expect(await s.compact('manual')).toBe(true);
    await s.send('third question');
    const at = (x: unknown) => (x as { activeStart: number }).activeStart;
    const third = s.messages.findLast((m) => m.role === 'user' && m.origin === 'user')!;
    const b = await rt.fork(s, third.id, 'before');
    expect(at(b)).toBe(at(s));
    // The branch's file names the history in one line; none of its messages is copied.
    const kinds = openLines(fs.readFileSync(`${rt.store.dataDir(b.meta)}.jsonl`, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).t);
    expect(kinds.filter((k) => k === 'base' || k === 'msg' || k === 'compact')).toEqual(['base', 'compact']);
    const before = texts(b.messages);
    await s.send('the source goes on');
    rt.close(b.id);
    const reopened = await rt.get(b.id);
    expect(texts(reopened.messages)).toEqual(before);
    expect(at(reopened)).toBe(at(s));
  });

  it('sends a message again in place: the conversation after it goes and the new session takes its place', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('first question');
    await s.send('second question');
    const { session: again } = await rt.branch(s, s.messages[2].id, 'before', { replace: true });
    expect(again.meta.branchOf).toBeUndefined();
    expect(again.meta.created).toBe(s.meta.created);
    expect(rt.live.has(s.id)).toBe(false);
    const listed = rt.store.list().map((m) => m.id);
    expect(listed).toContain(again.id);
    expect(listed).not.toContain(s.id);
    await again.send('second question, asked differently');
    rt.close(again.id);
    const reopened = await rt.get(again.id);
    expect(texts(reopened.messages).slice(0, 3)).toEqual(['user: first question', texts(s.messages)[1], 'user: second question, asked differently']);
    expect(reopened.messages).toHaveLength(4);
    // The old conversation stays on disk only while the new one reads from it.
    expect(rt.store.metaOf(s.id)?.hidden).toBe(true);
    rt.close(again.id);
    rt.store.delete(again.id);
    expect(rt.store.metaOf(s.id)).toBeNull();
  });

  it('announces the replacement on the global stream and refuses work on its hidden source', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('first question');
    await s.send('second question');
    const server = await startServer({ runtime: rt, token: 't' });
    const headers = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };
    const abort = new AbortController();
    try {
      const events = await fetch(`${server.url}api/events`, { headers, signal: abort.signal });
      const { session: again } = await rt.branch(s, s.messages[2].id, 'before', { replace: true });
      expect(rt.store.metaOf(s.id)?.hidden).toBe(true);
      const before = texts(again.messages);
      const calls = replies;
      for (const [route, body] of Object.entries({
        send: { text: 'from a stale window' },
        compact: {},
        settings: { title: 'not the active session' },
        fork: { message: s.messages[0].id, where: 'before' },
      })) {
        const response = await fetch(`${server.url}api/sessions/${s.id}/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
        expect(response.status, route).toBe(410);
        expect(await response.json()).toEqual({ error: 'This session was replaced.', replacementId: again.id });
        expect(rt.live.has(s.id)).toBe(false);
      }
      expect(texts(again.messages)).toEqual(before);
      expect(replies).toBe(calls);
      expect(texts(rt.store.load(again.id)!.messages)).toEqual(before);
      const history = await fetch(`${server.url}api/sessions/${s.id}`, { headers });
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({ meta: { id: s.id, hidden: true } });
      rt.close(s.id);

      const reader = events.body!.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const deadline = setTimeout(() => abort.abort(), 3000);
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('The global stream ended before the replacement event.');
          pending += decoder.decode(chunk.value, { stream: true });
          const frames = pending.split('\n\n');
          pending = frames.pop()!;
          const event = frames.filter((frame) => frame.startsWith('data: ')).map((frame) => JSON.parse(frame.slice(6)))
            .find((event) => event.type === 'session.replaced');
          if (event) {
            expect(event).toMatchObject({ sessionId: s.id, replacement: { id: again.id } });
            break;
          }
        }
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      abort.abort();
      await server.close();
    }
  });

  it('names the replacement even when the old session had no history to keep', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('first question');
    const { session: again } = await rt.branch(s, s.messages[0].id, 'before', { replace: true });
    expect(rt.store.metaOf(s.id)).toBeNull();
    const server = await startServer({ runtime: rt, token: 't' });
    try {
      const response = await fetch(`${server.url}api/sessions/${s.id}/send`, {
        method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'late' }),
      });
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: 'This session was replaced.', replacementId: again.id });
      expect(rt.live.has(s.id)).toBe(false);
      expect(again.messages).toEqual([]);
    } finally {
      await server.close();
    }
  });

  // Sent again in place, the source goes, and the restore points of the turns kept had gone with it (2026-11-06).
  it('keeps the restore points of the turns before the branch point, sent again in place too', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('first question');
    await s.send('second question');
    const [t1, t2] = [s.messages[0].turn!, s.messages[2].turn!];
    const file = path.join(project, 'kept.txt');
    fs.writeFileSync(file, 'before the first turn\n');
    s.checkpoints.capture(t1, file);
    fs.writeFileSync(file, 'after the first turn\n');
    s.checkpoints.capture(t2, file);
    const { session: again } = await rt.branch(s, s.messages[2].id, 'before', { replace: true });
    expect(again.checkpoints.turns()).toEqual([t1]);
    rt.close(again.id);
    const reopened = await rt.get(again.id);
    expect(reopened.checkpoints.turns()).toEqual([t1]);
    expect(reopened.checkpoints.changes(t1)[0]).toMatchObject({ before: 'before the first turn\n', after: 'after the first turn\n' });
    await reopened.undoFiles(t1);
    expect(fs.readFileSync(file, 'utf8')).toBe('before the first turn\n');
  });

  it('reads from as far back as the branch point allows, and through no more than eight files', async () => {
    const lastAsked = (x: { messages: { id: string; role: string; origin?: string }[] }) => [...x.messages].reverse().find((m) => m.role === 'user' && m.origin === 'user')!;
    let s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('q1');
    await s.send('q2');
    await s.send('q3');
    const first = s.id;
    // Sent again at q3, then at q2: q2 lies in what the second session reads from the first, so the third reads the
    // first itself and the second goes for good.
    const { session: second } = await rt.branch(s, lastAsked(s).id, 'before', { replace: true });
    await second.send('q3 again');
    const { session: third } = await rt.branch(second, second.messages[2].id, 'before', { replace: true });
    expect(third.meta.base).toEqual({ id: first, messages: 2 });
    expect(rt.store.metaOf(second.id)).toBeNull();
    await third.send('q2 again');

    // Sent again in place round after round, each further on: the chain grows to eight files, then the history is
    // copied once and every hidden session behind it goes.
    s = third;
    const chain = [first, third.id];
    for (let round = 1; round <= 9; round++) {
      await s.send(`question ${round}`);
      const { session: next } = await rt.branch(s, lastAsked(s).id, 'before', { replace: true });
      await next.send(`question ${round}, asked again`);
      expect(!!next.meta.base).toBe(round !== 8);
      chain.push(next.id);
      s = next;
    }
    // Everything before the copy is gone; the copy stays, hidden, for the last session to read.
    expect(chain.slice(0, -2).map((id) => rt.store.metaOf(id))).toEqual(chain.slice(0, -2).map(() => null));
    expect(rt.store.metaOf(chain.at(-2)!)?.hidden).toBe(true);
    const now = texts(s.messages);
    rt.close(s.id);
    const reopened = await rt.get(s.id);
    expect(texts(reopened.messages)).toEqual(now);
    expect(now.filter((t) => t.startsWith('user:'))).toEqual(['user: q1', 'user: q2 again', ...Array.from({ length: 9 }, (_, i) => `user: question ${i + 1}, asked again`)]);
  });
});
