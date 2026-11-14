import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SessionStore } from '../src/store/sessions';
import { logTokens, readTokenLog, tokenLogSince, type TokenEntry } from '../src/store/token-log';
import { costOf, tokenStats } from '../src/store/token-stats';
import type { Message, SessionMeta, Usage } from '../src/types';

let home: string;
let before: string | undefined;

beforeEach(() => {
  before = process.env.FAVILLA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-token-stats-'));
  process.env.FAVILLA_HOME = home;
});

afterEach(() => {
  if (before === undefined) delete process.env.FAVILLA_HOME;
  else process.env.FAVILLA_HOME = before;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

const DAY = 86_400_000;
// Noon UTC on 2026-03-10, so a day's name is the same in UTC and a zone a few hours either side.
const T = Date.UTC(2026, 2, 10, 12);
const usage = (input: number, output: number, more: Partial<Usage> = {}): Usage => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...more });

function entry(over: Partial<TokenEntry>): TokenEntry {
  return { at: T, session: 's', cwd: 'C:\\work\\alpha', provider: 'relay', model: 'm-1', kind: 'main', input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, ...over };
}

function session(store: SessionStore, id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  const meta: SessionMeta = { id, title: id, cwd: 'C:\\work\\alpha', created: T - 5 * DAY, updated: T - DAY, provider: 'relay', model: 'm-1', effort: 'off', mode: 'build', profile: 'favilla', ...over };
  store.create(meta, 'Invented system.');
  return meta;
}

const reply = (id: string, time: number, u: Usage, model?: string): Message => ({ id, role: 'assistant', time, parts: [{ type: 'text', text: 'Invented reply.' }], usage: u, ...(model ? { provider: 'relay', model } : {}) });

it('keeps each request sealed in a file of its month and reads back only what is asked for', async () => {
  logTokens(entry({ at: T - 40 * DAY, input: 7 }));
  logTokens(entry({ at: T, input: 300, cacheRead: 200, kind: 'side' }));
  const files = fs.readdirSync(path.join(home, 'usage')).sort();
  expect(files).toEqual(['2026-01.jsonl', '2026-03.jsonl']);
  // Sealed with the test key: no line of the file is the JSON it holds.
  expect(fs.readFileSync(path.join(home, 'usage', '2026-03.jsonl'), 'utf8').startsWith('~')).toBe(true);
  expect((await readTokenLog()).map((e) => e.input)).toEqual([7, 300]);
  const recent = await readTokenLog(T - DAY);
  expect(recent).toHaveLength(1);
  expect(recent[0]).toMatchObject({ kind: 'side', cacheRead: 200 });
});

it('passes over a line cut short and reads counts another version wrote oddly as nothing', async () => {
  logTokens(entry({ input: 50 }));
  const file = path.join(home, 'usage', '2026-03.jsonl');
  fs.appendFileSync(file, '{"at":' + T + ',"model":"m-1","input":"many","output":-3,"cost":null}\n{"at":12');
  const all = await readTokenLog();
  expect(all.map((e) => [e.input, e.output, e.cost])).toEqual([[50, 10, 0], [0, 0, 0]]);
});

it('begins the log once, whichever process gets there first', () => {
  expect(tokenLogSince()).toBeNull();
  const first = tokenLogSince(true)!;
  expect(tokenLogSince(true)).toBe(first);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'usage', 'since.json'), 'utf8')).since).toBe(first);
});

it('sums by day where the user is, model and folder, the same folder whatever its spelling', async () => {
  fs.mkdirSync(path.join(home, 'usage'), { recursive: true });
  fs.writeFileSync(path.join(home, 'usage', 'since.json'), JSON.stringify({ since: 0 }));
  logTokens(entry({ input: 100, output: 10 }));
  logTokens(entry({ cwd: 'c:/Work/Alpha/', input: 50, output: 5, kind: 'side', cost: 0.25 }));
  logTokens(entry({ model: 'm-2', input: 1, output: 1 }));
  // 23:30 in Los Angeles (summer time from 8 March) is the next day in UTC.
  logTokens(entry({ at: Date.UTC(2026, 2, 11, 6, 30), input: 9, output: 9 }));
  const { rows, first } = await tokenStats(new SessionStore(path.join(home, 'sessions')), { tz: 'America/Los_Angeles' });
  expect(first).toBe(T);
  expect(rows.map((r) => [r.day, r.model, r.requests, r.side, r.input, r.output, r.cost])).toEqual([
    ['2026-03-10', 'm-1', 3, 1, 159, 24, 0.25],
    ['2026-03-10', 'm-2', 1, 0, 1, 1, 0],
  ]);
  expect(rows[0].cwd).toBe('C:\\work\\alpha');
  const utc = await tokenStats(new SessionStore(path.join(home, 'sessions')), { tz: 'UTC' });
  expect(utc.rows.map((r) => r.day)).toEqual(['2026-03-10', '2026-03-10', '2026-03-11']);
});

it('counts a request whose provider said nothing of its tokens apart, as a request with no tokens known', async () => {
  fs.mkdirSync(path.join(home, 'usage'), { recursive: true });
  fs.writeFileSync(path.join(home, 'usage', 'since.json'), JSON.stringify({ since: 0 }));
  logTokens(entry({ input: 100, output: 10 }));
  logTokens(entry({ input: 0, output: 0, unreported: true }));
  const { rows } = await tokenStats(new SessionStore(path.join(home, 'sessions')), { tz: 'UTC' });
  expect(rows.map((r) => [r.requests, r.unreported, r.input])).toEqual([[2, 1, 100]]);
});

it('times the replies that streamed long enough to time, their reasoning left out when it came as no words', async () => {
  fs.mkdirSync(path.join(home, 'usage'), { recursive: true });
  fs.writeFileSync(path.join(home, 'usage', 'since.json'), JSON.stringify({ since: 0 }));
  // 600 tokens in the 10 s from the first word to the end.
  logTokens(entry({ output: 600, ms: 12_000, waitMs: 2_000 }));
  // Its 500 tokens of reasoning took their time before the first word: 400 tokens in 8 s.
  logTokens(entry({ output: 900, reasoning: 500, hidden: true, ms: 9_000, waitMs: 1_000 }));
  // Too short to say anything of the model.
  logTokens(entry({ output: 20, ms: 3_000, waitMs: 1_000 }));
  // A relay that held the reply back and let it go at once.
  logTokens(entry({ output: 4000, ms: 30_100, waitMs: 30_000 }));
  // A side request, not timed.
  logTokens(entry({ kind: 'side', output: 300 }));
  const { rows } = await tokenStats(new SessionStore(path.join(home, 'sessions')), { tz: 'UTC' });
  expect(rows.map((r) => [r.timed, r.streamTokens, r.streamMs, r.waited, r.waitMs])).toEqual([[2, 1000, 18_000, 4, 34_000]]);
});

it('reads replies from before the log out of the sessions, once each, and a branch’s history only from its source', async () => {
  const store = new SessionStore(path.join(home, 'sessions'));
  fs.mkdirSync(path.join(home, 'usage'), { recursive: true });
  fs.writeFileSync(path.join(home, 'usage', 'since.json'), JSON.stringify({ since: T }));
  const a = session(store, 'a');
  store.saveMessage(a, { id: 'u1', role: 'user', origin: 'user', time: T - 3 * DAY, parts: [{ type: 'text', text: 'Invented question.' }] });
  store.saveMessage(a, reply('r1', T - 3 * DAY, usage(1000, 100)));
  // Saved again once finished: counted as its last save.
  store.saveMessage(a, reply('r1', T - 3 * DAY, usage(1000, 200)));
  store.saveMessage(a, reply('r2', T - 2 * DAY, usage(500, 50, { cacheRead: 400 }), 'm-2'));
  // After the log began, so the log has it.
  store.saveMessage(a, reply('r3', T + 1000, usage(9999, 9999)));
  const b = session(store, 'b', { parentId: undefined });
  store.saveBase(b, { id: 'a', messages: 3 });
  store.saveMessage(b, reply('b1', T - 2 * DAY, usage(70, 7)));
  store.flushIndex();
  logTokens(entry({ at: T + 1000, session: 'a', input: 9999, output: 9999 }));
  const price = (_p: string, m: string) => (m === 'm-1' ? { input: 1, output: 2 } : undefined);
  const { rows, since } = await tokenStats(store, { tz: 'UTC', price });
  expect(since).toBe(T);
  expect(rows.map((r) => [r.day, r.model, r.requests, r.input, r.output, r.cacheRead])).toEqual([
    ['2026-03-07', 'm-1', 1, 1000, 200, 0],
    ['2026-03-08', 'm-1', 1, 70, 7, 0],
    ['2026-03-08', 'm-2', 1, 500, 50, 400],
    ['2026-03-10', 'm-1', 1, 9999, 9999, 0],
  ]);
  // A reply from before the log is priced from the list, as the session would have.
  expect(rows[0].cost).toBeCloseTo(costOf(usage(1000, 200), { input: 1, output: 2 }));
  // From a day on, sessions last written before it are not opened.
  const later = await tokenStats(store, { from: T - DAY / 2, tz: 'UTC', price });
  expect(later.rows.map((r) => r.input)).toEqual([9999]);
});

it('sums each session by day, a sub-agent’s with the session it worked for, and names models of no known price', async () => {
  const store = new SessionStore(path.join(home, 'sessions'));
  fs.mkdirSync(path.join(home, 'usage'), { recursive: true });
  fs.writeFileSync(path.join(home, 'usage', 'since.json'), JSON.stringify({ since: 0 }));
  session(store, 'lead', { title: 'Fix the parser' });
  session(store, 'helper', { parentId: 'lead', title: 'Read the tests' });
  session(store, 'helper2', { parentId: 'helper' });
  store.flushIndex();
  logTokens(entry({ session: 'lead', input: 100, output: 10, cost: 0.5, provider: 'relay', model: 'm-1' }));
  logTokens(entry({ session: 'helper', parent: 'lead', input: 40, output: 4, provider: 'relay', model: 'm-2' }));
  logTokens(entry({ session: 'helper2', input: 20, output: 2, provider: 'home', model: 'q-9' }));
  logTokens(entry({ session: 'gone', at: T + DAY, input: 7, output: 1, provider: 'relay', model: 'm-2' }));
  const free = (p: string) => p === 'home';
  const price = (_p: string, m: string) => (m === 'm-1' ? { input: 1, output: 2 } : undefined);
  const s = await tokenStats(store, { tz: 'UTC', price, free });
  expect(s.sessions.map((r) => [r.day, r.session, r.requests, r.input, r.output, r.cost])).toEqual([
    ['2026-03-10', 'lead', 3, 160, 16, 0.5],
    ['2026-03-11', 'gone', 1, 7, 1, 0],
  ]);
  expect(s.sessions[0].cwd).toBe('C:\\work\\alpha');
  // A session no longer kept has no name to show.
  expect(s.titles).toEqual({ lead: 'Fix the parser' });
  // m-1 has a price, q-9 runs on a server of the user's own: only m-2's cost is unknown.
  expect(s.unpriced).toEqual(['relay/m-2']);
});
