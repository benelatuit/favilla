import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { brotliDecompressSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Session } from '../src/agent/session';
import type { ModelInfo } from '../src/catalog/catalog';
import { toAnthropicMessages } from '../src/providers/anthropic';
import { toGeminiContents } from '../src/providers/gemini';
import { toChatMessages } from '../src/providers/openai-chat';
import { toResponsesInput } from '../src/providers/openai-responses';
import type { ProviderCall } from '../src/providers/types';
import type { Runtime } from '../src/runtime';
import { fullContent, fullDisplay } from '../src/store/pack';
import type { AgentEvent, Message } from '../src/types';
import { Deferred } from '../src/util/async';

const fixture = vi.hoisted(() => ({ delays: [] as number[], slowKill: false }));
vi.mock('../src/util/async', async (original) => {
  const real = await original<typeof import('../src/util/async')>();
  return { ...real, sleep: (ms: number, signal?: AbortSignal) => {
    if (ms >= 250) fixture.delays.push(ms);
    return real.sleep(Math.min(ms, 5), signal);
  } };
});
vi.mock('../src/prompt/env', async (original) => ({
  ...await original<typeof import('../src/prompt/env')>(),
  projectFacts: async ({ cwd }: { cwd: string }) => 'Working directory: ' + cwd,
}));
vi.mock('../src/net/http', async (original) => ({ ...await original<typeof import('../src/net/http')>(), STALL_DEEP_MS: 230 }));
vi.mock('../src/util/proc', async (original) => {
  const real = await original<typeof import('../src/util/proc')>();
  return { ...real, killChild: (...args: Parameters<typeof real.killChild>) => fixture.slowKill ? Promise.resolve() : real.killChild(...args) };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-turn-faults-'));
const favilla = path.join(home, 'favilla');
vi.stubEnv('FAVILLA_HOME', favilla);
vi.stubEnv('FAVILLA_STALL_MS', '160');
vi.stubEnv('FAVILLA_WORDLESS_MS', '320');
vi.stubEnv('FAVILLA_QUIET_MS', '60');
vi.stubEnv('FAVILLA_PREFETCH', '0');
vi.stubEnv('FAVILLA_TEST_DATA_KEY', undefined);

const { createRuntime } = await import('../src/runtime');
const { startServer } = await import('../src/server/server');

type Wire = {
  role?: string;
  type?: string;
  content?: unknown;
  id?: string;
  call_id?: string;
  tool_call_id?: string;
  tool_use_id?: string;
  tool_calls?: Wire[];
  parts?: Wire[];
  functionCall?: Wire;
  functionResponse?: Wire;
  reasoning_content?: string;
  reasoning_details?: unknown[];
};
type Request = { model: string; messages: Wire[]; tool_choice?: string };
type Reply = (res: http.ServerResponse) => void | Promise<void>;
const requests: Request[] = [];
const sockets = new Set<http.ServerResponse>();
let replies: Reply[] = [];
let defaultReply: Reply;
const replyErrors: unknown[] = [];
const fake = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
  let body = '';
  req.setEncoding('utf8').on('data', (s) => body += s);
  req.on('end', () => {
    requests.push(JSON.parse(body));
    sockets.add(res);
    res.once('close', () => sockets.delete(res));
    Promise.resolve().then(() => (replies.shift() ?? defaultReply)(res)).catch((error) => {
      replyErrors.push(error);
      res.destroy();
    });
  });
});

const chunk = (delta: object, finish_reason?: string) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
const say = (text: string) => chunk({ content: text });
const argumentsOf = (name: string, args: string, id: string, index = 0) => chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] });
const tool = (name: string, args: object, id: string, index = 0) => argumentsOf(name, JSON.stringify(args), id, index);
const finish = (kind = 'stop') => chunk({}, kind) + 'data: [DONE]\n\n';
const headers = (res: http.ServerResponse) => res.writeHead(200, { 'Content-Type': 'text/event-stream' });
const stream = (frames: string): Reply => (res) => { headers(res).end(frames); };
const answer = stream(say('Done.') + finish());
const summary = stream(say('<summary>The fixture has a complete hand-off.</summary>') + finish());
const write = (file = 'effect.txt', id = 'write-one') => tool('write', { path: file, content: 'written\n' }, id);
const edit = (id: string) => tool('edit', { path: 'effect.txt', old_string: 'original', new_string: 'written' }, id);
const child = tool('agent', { description: 'Inspect the fixture', prompt: 'Inspect the fixture and reply.', type: 'explore' }, 'delegate');
const denied = () => Object.assign(new Error('Fixture disk full'), { code: 'ENOSPC' });

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const { port } = fake.address() as AddressInfo;
  fs.mkdirSync(path.join(favilla, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(favilla, 'cache', 'toolchains2.json'), JSON.stringify({ at: Date.now(), versions: {} }));
  const model = { contextWindow: 64000, family: 'gpt', efforts: ['off', 'high'], quirks: { reasoningEcho: 'all' } };
  fs.writeFileSync(path.join(favilla, 'config.json'), JSON.stringify({
    model: 'fixture/m1', effort: 'off', tools: 'favilla', skills: false, languageServers: false, folderSnapshots: false,
    modelRegistry: false, memoryGuard: false, storage: { encrypt: false }, autoCompact: false,
    guard: { mode: 'confirm', deny: ['permission\\.cjs'] },
    providers: { fixture: { api: 'openai-chat', baseUrl: 'http://127.0.0.1:' + port + '/v1', local: true, discover: false, auth: 'none', models: { m1: model, m2: model } } },
  }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => { fake.close(() => resolve()); fake.closeAllConnections(); });
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

const places = ['first-byte', 'reasoning', 'text', 'arguments', 'after-tool', 'child', 'summary', 'after-summary'] as const;
const actions = ['wait', 'stop', 'stop-twice', 'send', 'edit-resend', 'undo', 'switch', 'reopen', 'restart'] as const;
type Place = typeof places[number];
type Action = typeof actions[number];
const starts = ['first-byte', 'after-tool', 'child', 'summary', 'after-summary'] as const;
const faults = {
  cut: places, silent: places, comments: places, eof: places,
  duplicate: places.filter((p) => p !== 'first-byte'),
  '429': starts, 'retry-after': starts, '502': starts, '200-error': starts,
  'half-json': ['arguments', 'after-tool', 'child', 'after-summary'],
  'two-calls': ['arguments', 'after-tool', 'after-summary'],
} satisfies Record<string, readonly Place[]>;
type Fault = keyof typeof faults | 'deep' | 'late' | 'crlf' | 'history-disk' | 'usage-disk' | 'checkpoint-index' | 'checkpoint-blob'
  | 'result-disk' | 'queued-result-disk' | 'offline-queue' | 'permission-stop' | 'duplicate-call' | 'flood' | 'slow-kill'
  | 'late-finish' | 'bare-cr' | 'edit-restart' | 'shell-restart' | 'job-restart' | 'duplicate-kept-call';
type Check = 'once' | 'history' | 'ended' | 'input' | 'reopen';
type Case = { fault: Fault; place: Place; action: Action; known?: Check[] };
const product: Case[] = Object.entries(faults).flatMap(([fault, at]) =>
  at.flatMap((place) => actions.map((action) => ({ fault: fault as Fault, place, action }))));
const focused = product.filter((c) => c.action === 'wait');
const pairs = (c: Case) => [c.fault + '/' + c.action, c.place + '/' + c.action];
const covered = new Set(focused.flatMap(pairs));
for (const c of product) {
  const keys = pairs(c);
  if (keys.every((k) => covered.has(k))) continue;
  focused.push(c);
  for (const k of keys) covered.add(k);
}
// A known failure stays in the matrix. The longer runner's --strict flag reproduces it as a failing test.
const boundaries: Case[] = [
  { fault: 'deep', place: 'first-byte', action: 'wait' },
  { fault: 'deep', place: 'summary', action: 'wait' },
  { fault: 'late', place: 'text', action: 'stop' },
  { fault: 'late', place: 'arguments', action: 'stop-twice' },
  { fault: 'late-finish', place: 'text', action: 'stop' },
  { fault: 'crlf', place: 'text', action: 'wait' },
  { fault: 'bare-cr', place: 'text', action: 'wait' },
  { fault: 'history-disk', place: 'first-byte', action: 'wait' },
  { fault: 'usage-disk', place: 'text', action: 'wait' },
  { fault: 'checkpoint-index', place: 'arguments', action: 'wait' },
  { fault: 'checkpoint-blob', place: 'arguments', action: 'wait' },
  { fault: 'result-disk', place: 'after-tool', action: 'wait' },
  { fault: 'queued-result-disk', place: 'after-tool', action: 'send' },
  { fault: 'offline-queue', place: 'first-byte', action: 'restart' },
  { fault: 'permission-stop', place: 'arguments', action: 'stop' },
  { fault: 'duplicate-call', place: 'arguments', action: 'wait' },
  { fault: 'duplicate-kept-call', place: 'arguments', action: 'wait' },
  { fault: 'flood', place: 'after-tool', action: 'stop' },
  { fault: 'slow-kill', place: 'after-tool', action: 'stop', known: ['ended'] },
  { fault: 'edit-restart', place: 'after-tool', action: 'restart' },
  { fault: 'shell-restart', place: 'after-tool', action: 'restart' },
  { fault: 'job-restart', place: 'after-tool', action: 'restart' },
];
const cases = [...(process.env.FAVILLA_TURN_FULL === '1' ? product : focused), ...boundaries];

// No transport status can change after a reply's headers. The matrix covers those faults at request boundaries.
const streamPrefix = (at: Place) =>
  at === 'reasoning' ? chunk({ reasoning_content: 'Fixture thought.' })
    : at === 'arguments' ? argumentsOf('write', '{"path":"partial.txt","content":"half', 'cut-call')
    : at === 'first-byte' ? '' : say('Fixture prefix. ');

const longText = Array.from({ length: 180 }, (_, i) => 'part' + i + ' varies by ' + (i * 37)).join(' ');
function faultReply(c: Case, hit: Deferred<void>): Reply {
  return async (res) => {
    const { fault, place } = c;
    if (fault === '429' || fault === 'retry-after') {
      res.writeHead(429, { 'Content-Type': 'application/json', ...(fault === 'retry-after' ? { 'Retry-After': '3' } : {}) });
      res.end('{"error":{"message":"Fixture rate limit"}}');
    } else if (fault === '502') {
      res.writeHead(502, { 'Content-Type': 'text/html' }).end('<html>Bad Gateway</html>');
    } else if (fault === '200-error') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"error":{"message":"Fixture error"}}');
    } else if (fault === 'cut') {
      const prefix = streamPrefix(place);
      if (prefix) {
        headers(res).write(prefix);
        await wait(14);
      }
      res.destroy();
    } else if (fault === 'silent' || fault === 'comments' || fault === 'deep') {
      const prefix = streamPrefix(place);
      if (prefix || fault === 'comments') {
        headers(res).write(prefix || ': keep-alive\n\n');
        if (fault === 'comments') {
          const ping = setInterval(() => res.write(': keep-alive\n\n'), 18);
          res.once('close', () => clearInterval(ping));
        }
      } else headers(res).flushHeaders();
    } else if (fault === 'eof') {
      headers(res).end(streamPrefix(place));
    } else if (fault === 'duplicate') {
      const prefix = place === 'arguments' ? argumentsOf('write', '{"path":"effect.txt","content":"repeat', 'replayed-call') : streamPrefix(place);
      const tail = place === 'arguments' ? argumentsOf('write', 'ed"}', 'replayed-call') + finish('tool_calls')
        : (place === 'summary' ? say('<summary>Fixture hand-off.</summary>') : say('Done.')) + finish();
      replies.unshift(stream(prefix + tail));
      headers(res).write(prefix);
      await wait(14);
      res.destroy();
    } else if (fault === 'half-json') {
      headers(res).end(streamPrefix('arguments') + finish('tool_calls'));
    } else if (fault === 'two-calls') {
      headers(res).write(say(longText) + write('first.txt', 'whole-call')
        + argumentsOf('write', '{"path":"partial.txt","content":"half', 'cut-call', 1));
      await wait(14);
      res.destroy();
    } else if (fault === 'late') {
      const reply = place === 'arguments'
        ? argumentsOf('write', '{"path":"partial.txt","content":"', 'late-call')
          + argumentsOf('write', 'After stop."}', 'late-call')
        : say('Before stop. ') + say('After stop. ') + write();
      headers(res).end(reply + finish('tool_calls'));
      return;
    } else if (fault === 'late-finish') {
      headers(res).write(say('Before stop. ') + chunk({}, 'stop'));
      return;
    } else if (fault === 'bare-cr') {
      headers(res).write(say('Bare CR.').replaceAll('\n', '\r'));
      await hit.promise;
      res.end(finish());
      return;
    } else if (fault === 'crlf') {
      headers(res).write('data: {"choices": [\r');
      await wait(15);
      res.end('\ndata: {"delta":{"content":"Split CRLF."}}]}\r\n\r\n' + finish());
    } else if (fault === 'duplicate-call') {
      headers(res).end(write() + tool('write', { path: 'first.txt', content: 'duplicate\n' }, 'write-one', 1) + finish('tool_calls'));
    }
    hit.resolve();
  };
}

const same = (value: unknown) => JSON.parse(JSON.stringify(value));
const results = (messages: Message[]) => messages.flatMap((m) => m.parts.flatMap((p) => p.type === 'tool_result' ? [p] : []));
const calls = (messages: Message[]) => messages.flatMap((m) => m.parts.flatMap((p) => p.type === 'tool_call' ? [p] : []));
const messagesOnScreen = (messages: Message[], rt: Runtime) => messages.filter((m) => !m.replay).map((m) => ({
  ...m, parts: m.parts.map((p) => p.type === 'tool_result' ? { ...p, content: fullContent(p, rt.store.blobs), display: fullDisplay(p, rt.store.blobs) } : p),
}));

// Every provider must see a whole round, no blank messages, and the same native reasoning bytes.
const signed: Message[] = [
  { id: 'sig-user', role: 'user', time: 0, parts: [{ type: 'text', text: 'Fixture.' }] },
  { id: 'sig-assistant', role: 'assistant', time: 0, parts: [
    { type: 'reasoning', text: 'Anthropic thought', provider: 'anthropic-fixture', model: 'ant', signature: 'signed-α' },
    { type: 'reasoning', text: '', provider: 'anthropic-fixture', model: 'ant', redacted: 'redacted-β' },
    { type: 'reasoning', text: 'Responses thought', provider: 'responses-fixture', model: 'resp', itemId: 'rs_fixture', encrypted: 'encrypted-γ' },
    { type: 'reasoning', text: '', provider: 'chat-fixture', model: 'chat', details: [{ type: 'reasoning.encrypted', data: 'details-δ' }] },
    { type: 'reasoning', text: 'Gemini thought', provider: 'gemini-fixture', model: 'gemini-fixture', meta: { thoughtSignature: 'gemini-ε' } },
    { type: 'text', text: 'Answer.' },
  ] },
];

type ToolOrder = { call?: string; result?: string; assistant?: boolean };

function paired(order: ToolOrder[]) {
  const pending = new Set<string>();
  for (const item of order) {
    if (item.assistant) expect([...pending]).toEqual([]);
    if (item.call) {
      expect(pending.has(item.call)).toBe(false);
      pending.add(item.call);
    }
    if (item.result) expect(pending.delete(item.result)).toBe(true);
  }
  expect([...pending]).toEqual([]);
}

function checkChat(wire: Wire[]) {
  for (const m of wire) expect(!!(m.content || m.tool_calls?.length || m.reasoning_details?.length || m.reasoning_content)).toBe(true);
  paired(wire.flatMap((m) => [
    ...(m.role === 'assistant' ? [{ assistant: true }] : []),
    ...(m.tool_calls ?? []).map((c) => ({ call: c.id })),
    ...(m.role === 'tool' ? [{ result: m.tool_call_id }] : []),
  ]));
}

function checkHistory(messages: Message[]) {
  for (const m of messages) expect(m.parts.length).toBeGreaterThan(0);
  paired(messages.flatMap((m) => [
    ...(m.role === 'assistant' ? [{ assistant: true }] : []),
    ...m.parts.flatMap<ToolOrder>((p) => p.type === 'tool_call' ? [{ call: p.id }] : p.type === 'tool_result' ? [{ result: p.callId }] : []),
  ]));
  const transcript = [...signed, ...messages];
  const model = { id: 'chat-fixture', vision: false, quirks: { reasoningEcho: 'all', reasoningField: 'reasoning_details' } } as ModelInfo;
  const chat = toChatMessages({ model, system: 'Fixture.', messages: signed, turnStart: 0 } as ProviderCall) as Wire[];
  checkChat(toChatMessages({ model: { ...model, quirks: { reasoningEcho: 'all' } }, system: 'Fixture.', messages, turnStart: 0 } as ProviderCall) as Wire[]);
  expect(chat[2].reasoning_details).toEqual([{ type: 'reasoning.encrypted', data: 'details-δ' }]);
  const anthropic = toAnthropicMessages(transcript, 'anthropic-fixture') as (Wire & { content: Wire[] })[];
  const responses = toResponsesInput(transcript, 'responses-fixture') as Wire[];
  const gemini = toGeminiContents(transcript, 'gemini-fixture') as (Wire & { parts: Wire[] })[];
  for (const m of anthropic) expect(m.content.length).toBeGreaterThan(0);
  for (const m of gemini) expect(m.parts.length).toBeGreaterThan(0);
  for (const m of responses) if (m.type === 'message') expect(m.content).not.toEqual([]);
  paired(anthropic.flatMap((m) => [
    ...(m.role === 'assistant' ? [{ assistant: true }] : []),
    ...m.content.flatMap<ToolOrder>((p) => p.type === 'tool_use' ? [{ call: p.id }] : p.type === 'tool_result' ? [{ result: p.tool_use_id }] : []),
  ]));
  paired(responses.flatMap<ToolOrder>((p) => p.type === 'function_call' ? [{ call: p.call_id }] : p.type === 'function_call_output' ? [{ result: p.call_id }]
    : p.role === 'assistant' ? [{ assistant: true }] : []));
  paired(gemini.flatMap((m) => [
    ...(m.role === 'model' ? [{ assistant: true }] : []),
    ...m.parts.flatMap<ToolOrder>((p) => p.functionCall ? [{ call: p.functionCall.id }] : p.functionResponse ? [{ result: p.functionResponse.id }] : []),
  ]));
  expect(anthropic[1].content.slice(0, 2)).toEqual([
    { type: 'thinking', thinking: 'Anthropic thought', signature: 'signed-α' },
    { type: 'redacted_thinking', data: 'redacted-β' },
  ]);
  expect(responses[1]).toEqual({ type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: 'Responses thought' }], encrypted_content: 'encrypted-γ' });
  expect(gemini[1].parts[0]).toEqual({ text: 'Gemini thought', thought: true, thoughtSignature: 'gemini-ε' });
}

async function within<T>(work: Promise<T>, label: string, ms = 6000): Promise<T> {
  const timeout = new AbortController();
  try {
    return await Promise.race([work, wait(ms, undefined, { signal: timeout.signal }).then(() => { throw new Error(label + ' did not settle'); })]);
  } finally {
    timeout.abort();
  }
}

let number = 0;
it.each(cases)('$fault at $place with $action', async (c) => {
  const { fault, place, action } = c;
  const project = path.join(home, 'project-' + ++number);
  fs.mkdirSync(project);
  requests.length = 0;
  fixture.delays.length = 0;
  defaultReply = answer;
  replies = [];
  const options = { cwd: project, interactive: true, effort: fault === 'deep' ? 'high' as const : 'off' as const };
  let rt = createRuntime(project, { interactive: true });
  let s = await rt.start(options);
  const source = s;
  const hit = new Deferred<void>(), nextReply = new Deferred<void>();
  const events: AgentEvent[] = [];
  const typed = [place === 'summary' ? 'Seed request.' : 'Fixture request.'];
  const returned: string[] = [];
  const running: Promise<unknown>[] = [];
  const broken: Partial<Record<Check, string>> = {};
  const check = (name: Check, fn: () => void) => {
    try { fn(); } catch (error) { broken[name] = String(error); }
  };
  const watched = (e: AgentEvent) => {
    events.push(e);
    if (e.type === 'queue' && e.returned) returned.push(...e.returned.map((p) => p.text));
  };
  const detach = s.on(watched);
  let abortedAt: number | undefined;
  const abort = () => { abortedAt ??= performance.now(); source.abort(); };
  let injected = 0;
  let queuedAtFailure: string[] | undefined;
  let launchesBeforeCut: boolean | undefined;
  const touches: string[] = [];
  const history = rt.store.dataDir(s.meta) + '.jsonl';
  const readHistory = () => fs.existsSync(history) ? fs.readFileSync(history) : brotliDecompressSync(fs.readFileSync(history + '.br'));
  const checkpoint = path.join(rt.store.dataDir(s.meta), 'checkpoints', 'index.jsonl');
  const effect = path.join(project, 'effect.txt');
  const append = fs.appendFileSync, writeFile = fs.writeFileSync;
  const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data, opts) => {
    const line = String(data);
    if (fault === 'usage-disk' && file === history && line.includes('"t":"usage"')
      || !injected && (fault === 'history-disk' && file === history && line.includes('"t":"msg"')
        || (fault === 'result-disk' || fault === 'queued-result-disk') && file === history && line.includes('"type":"tool_result"')
        || fault === 'checkpoint-index' && file === checkpoint)) {
      injected++;
      if (fault === 'queued-result-disk') queuedAtFailure = rt.store.load(s.id)?.meta.queued?.map((q) => q.text);
      hit.resolve();
      throw denied();
    }
    append(file, data, opts);
  });
  const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, opts) => {
    writeFile(file, data, opts);
    if (typeof file === 'string' && path.dirname(file) === project && ['effect.txt', 'first.txt', 'partial.txt'].includes(path.basename(file))) touches.push(path.basename(file));
  });
  const putSpy = fault === 'checkpoint-blob' ? vi.spyOn(rt.store.blobs, 'put').mockImplementationOnce(() => {
    injected++;
    hit.resolve();
    throw denied();
  }) : undefined;
  let window: Awaited<ReturnType<typeof startServer>> | undefined;
  let reopened: Session | undefined;
  let openedReturn: string[] = [];
  const view = async (id: string) => {
    const server = window ??= await startServer({ runtime: rt });
    const res = await fetch(server.url + 'api/sessions/' + id, {
      headers: { Authorization: 'Bearer ' + server.token }, signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    return await res.json() as { status: string; messages: Message[]; turns: string[]; returned: { text: string }[] };
  };
  try {
    if (fault === 'checkpoint-blob' || fault === 'checkpoint-index' || fault === 'edit-restart') writeFile(effect, 'original\n');
    const keepsBranchPrefix = action === 'edit-resend' && place === 'after-tool';
    if (place === 'summary' || place === 'after-summary' || action === 'undo' || keepsBranchPrefix) {
      replies = [stream(write('seed.txt', 'seed-write') + finish('tool_calls')), answer];
      await s.send('Seed request.');
      if (place === 'after-summary') {
        replies = [summary];
        expect(await s.compact()).toBe(true);
      }
    }
    const before = s.messages.filter((m) => !m.replay).map((m) => m.id);
    const prefix = readHistory();
    const first = s.messages.find((m) => m.origin === 'user');
    const brokenReply = faultReply(c, hit);
    const faultAt = requests.length;
    if (fault === 'history-disk') replies = [];
    else if (fault === 'usage-disk') replies = [stream(say('Saved before the usage write.') + finish())];
    else if (fault === 'checkpoint-index') replies = [stream(edit('checkpoint-first') + finish('tool_calls')), stream(edit('checkpoint-second') + finish('tool_calls'))];
    else if (fault === 'checkpoint-blob') replies = [stream(edit('checkpoint-first') + finish('tool_calls'))];
    else if (fault === 'result-disk' || fault === 'queued-result-disk') {
      replies = [stream(write() + finish('tool_calls'))];
      if (fault === 'queued-result-disk') s.on((e) => {
        if (e.type !== 'tool.end') return;
        typed.push('Keep the queued input.');
        running.push(s.send(typed.at(-1)!).catch((error) => error));
      });
    }
    else if (fault === 'offline-queue') replies = [faultReply({ ...c, fault: 'silent' }, hit)];
    else if (fault === 'edit-restart') {
      replies = [stream(edit('edited-once') + finish('tool_calls')), faultReply({ ...c, fault: 'silent' }, hit)];
    } else if (fault === 'shell-restart' || fault === 'job-restart' || fault === 'duplicate-kept-call') {
      writeFile(path.join(project, 'launch.cjs'), "require('node:fs').appendFileSync('launched.txt', '1\\n'); console.log('Recorded once');"
        + (fault === 'job-restart' ? 'setTimeout(() => {}, 3000);' : ''));
      const call = tool('shell', { command: 'node launch.cjs', description: 'Record one invocation', background: fault === 'job-restart' }, 'launched-once');
      replies = fault === 'duplicate-kept-call' ? [
        async (res) => {
          headers(res).write(say(longText) + call);
          await wait(14);
          launchesBeforeCut = fs.existsSync(path.join(project, 'launched.txt'));
          res.destroy();
          hit.resolve();
        },
        stream(call + finish('tool_calls')),
      ] : [stream(call + finish('tool_calls')), faultReply({ ...c, fault: 'silent' }, hit)];
    } else if (fault === 'flood' || fault === 'slow-kill' || fault === 'permission-stop') {
      const permission = fault === 'permission-stop';
      const script = permission ? 'permission.cjs' : 'forever.cjs';
      fs.writeFileSync(path.join(project, script),
        "require('node:fs').appendFileSync('launched.txt', '1\\n'); process.stdout.write('Fixture ready\\n');"
        + (permission ? '' : "const t=setInterval(()=>process.stdout.write('output\\n'), 16); setTimeout(()=>clearInterval(t), 2700);"));
      replies = [stream(tool('shell', { command: 'node ' + script, description: 'Run the local fixture' }, 'shell-one') + finish('tool_calls'))];
      fixture.slowKill = fault === 'slow-kill';
      s.on((e) => {
        if (permission && e.type === 'permission.request') {
          expect(s.status).toBe('waiting');
          expect(s.respondPermission(e.request.id, 'allow')).toBe(true);
          abort();
          hit.resolve();
        } else if (!permission && e.type === 'tool.progress' && e.chunk.includes('Fixture ready')) hit.resolve();
      });
    } else {
      replies = place === 'after-tool' ? [stream(write() + finish('tool_calls')), brokenReply]
        : place === 'child' ? [stream(child + finish('tool_calls')), brokenReply] : [brokenReply];
    }

    defaultReply = async (res) => {
      await nextReply.promise;
      if (!res.destroyed) (requests.at(-1)?.tool_choice === 'none' ? summary : answer)(res);
    };
    if (fault === 'bare-cr' || fault === 'late-finish') s.on((e) => {
      if (e.type !== 'stream.text') return;
      if (fault === 'bare-cr' && e.delta === 'Bare CR.') hit.resolve();
      else if (fault === 'late-finish' && e.delta === 'Before stop. ') setImmediate(() => hit.resolve());
    });
    if (fault === 'late') {
      s.on((e) => {
        const trigger = place === 'arguments'
          ? e.type === 'stream.tool' && e.id === 'late-call'
          : e.type === 'stream.text' && e.delta.startsWith('Before stop. ');
        if (!trigger || abortedAt !== undefined) return;
        abort();
        hit.resolve();
      });
    }
    const turn = (place === 'summary' ? s.compact() : s.send(typed[0])).catch((error) => error);
    running.push(turn);
    await within(hit.promise, 'Fault ' + fault);

    if (action === 'send' && fault !== 'queued-result-disk') {
      typed.push('Keep the second input.');
      running.push(s.send(typed.at(-1)!).catch((error) => error));
    } else if (action === 'stop' || action === 'stop-twice') {
      abort();
      if (action === 'stop-twice') abort();
      if (fault === 'late') {
        typed.push('Input while stopping.');
        running.push(s.send(typed.at(-1)!).catch((error) => error));
      }
    } else if (action === 'edit-resend') {
      const earlier = keepsBranchPrefix ? s.messages.findLast((m) => m.origin === 'user')! : first ?? s.messages.find((m) => m.origin === 'user')!;
      const changed = rt.branch(s, earlier.id, 'before', { replace: true, text: 'Revised request.' });
      nextReply.resolve();
      s = (await within(changed, 'Edit and resend')).session;
      typed.splice(0, typed.length, 'Revised request.');
    } else if (action === 'undo') {
      await expect(s.undoFiles(s.checkpoints.turns()[0])).rejects.toThrow(/wait/i);
    } else if (action === 'switch') {
      // Picked mid-turn, the model waits for the turn to end.
      await expect(s.setModel('fixture/m2')).resolves.toBe('held');
      expect(s.modelInfo.ref).not.toBe('fixture/m2');
    } else if (action === 'reopen') {
      const open = await view(s.id);
      expect(open.messages.some((m) => m.origin === 'user')).toBe(true);
      expect(['running', 'compacting', 'idle']).toContain(open.status);
    } else if (action === 'restart') {
      if (fault === 'job-restart') {
        const launched = path.join(project, 'launched.txt');
        for (const deadline = performance.now() + 1000; !fs.existsSync(launched) && performance.now() < deadline; ) await wait(10);
      }
      if (fault === 'offline-queue') {
        detach();
        typed.push('Input while the window was away.');
        running.push(s.send(typed.at(-1)!).catch((error) => error));
      }
      abortedAt = performance.now();
      await within(rt.shutdown(), 'Engine shutdown');
      rt = createRuntime(project, { interactive: true });
      reopened = await rt.get(s.id);
      openedReturn = reopened.takeUnread().map((p) => p.text);
    }
    nextReply.resolve();
    await within(Promise.all(running), 'Turn');
    await within(s.settled(), 'Turn and background work');
    const stopMs = abortedAt === undefined ? undefined : performance.now() - abortedAt;
    if (action === 'switch') {
      // ...and is in once it has, with nothing more asked.
      expect(s.held).toBeNull();
      expect(s.modelInfo.ref).toBe('fixture/m2');
    }

    if (action === 'undo') {
      const seedTurn = s.checkpoints.turns()[0];
      expect(await s.undoFiles(seedTurn)).toContain(path.join(project, 'seed.txt'));
      expect(fs.existsSync(path.join(project, 'seed.txt'))).toBe(false);
    }
    const finalView = window && await view(s.id);
    const actual = messagesOnScreen(s.messages, rt);
    const changes = s.checkpoints.turns().map((turn) => [turn, s.turnChanges(turn)] as const);
    const live = s.liveState();
    const end = events.findLast((e) => e.type === 'turn.end');
    const launched = fs.existsSync(path.join(project, 'launched.txt')) ? fs.readFileSync(path.join(project, 'launched.txt'), 'utf8').trim().split('\n').length : 0;
    const sentCalls = requests.slice(faultAt);
    const seen = new Set(events.flatMap((e) => e.type === 'message.added' ? [e.message.id] : []));
    const after = actual.map((m) => m.id);
    if (!reopened) {
      rt.store.flushIndex();
      rt.close(s.id);
      reopened = await rt.get(s.id);
      openedReturn = reopened.takeUnread().map((p) => p.text);
    }
    const stored = messagesOnScreen(reopened.messages, rt);
    const output = JSON.stringify(stored);
    const active = [...s.active()];
    const storedActive = [...reopened.active()];
    const effects = action === 'edit-resend' ? [...source.messages, ...stored] : stored;
    check('once', () => {
      expect(touches).toEqual([...new Set(touches)]);
      expect(touches).not.toContain('partial.txt');
      if (fault === 'permission-stop') expect(launched).toBe(0);
      if (['flood', 'slow-kill', 'shell-restart', 'job-restart'].includes(fault)) expect(launched).toBe(1);
      if (fault === 'duplicate-kept-call') {
        expect(launchesBeforeCut).toBe(false);
        expect(launched).toBe(2);
        expect(sentCalls).toHaveLength(3);
        expect(sentCalls[1].messages.find((m) => m.tool_call_id === 'launched-once')?.content).toContain('Recorded once');
        expect(calls(stored).map((p) => p.id)).toEqual(['launched-once', expect.not.stringMatching(/^launched-once$/)]);
      }
      if (fault === 'shell-restart' || fault === 'job-restart') {
        expect(results(stored).find((r) => r.callId === 'launched-once')).toMatchObject({
          content: expect.stringContaining(fault === 'job-restart' ? 'Started background job' : 'Recorded once'),
        });
      }
      if (fault === 'edit-restart') expect(touches).toEqual(['effect.txt']);
      if (fault === 'checkpoint-blob') expect(touches).toEqual([]);
      if (fault === 'duplicate-call') {
        expect(touches).toEqual(['effect.txt', 'first.txt']);
        expect(calls(stored).map((p) => p.id)).toEqual(['write-one', expect.not.stringMatching(/^write-one$/)]);
      }
      for (const file of touches) {
        const related = calls(effects).filter((p) => p.input.path === file);
        const matches = results(effects).filter((r) => related.some((p) => p.id === r.callId));
        if (fault === 'result-disk' || fault === 'queued-result-disk') {
          const content = 'The tool ran, but its output was not stored and its effects may be in place.';
          expect(matches).toMatchObject([{ isError: true, content }]);
          expect(sentCalls[1].messages.find((m) => m.tool_call_id === matches[0].callId)?.content).toBe(content);
        } else expect(matches.some((r) => !r.isError)).toBe(true);
      }
      if (action === 'wait' && fault === 'two-calls') expect(touches).toContain('first.txt');
      if (action === 'wait' && fault === 'duplicate' && place === 'arguments') expect(touches).toEqual(['effect.txt']);
    });
    check('history', () => {
      checkHistory(actual);
      checkHistory(stored);
      checkHistory(active);
      checkHistory(storedActive);
      for (const body of requests) checkChat(body.messages);
      if (fault === 'crlf') expect(output).toContain('Split CRLF.');
      if (fault === 'bare-cr') expect(output).toContain('Bare CR.');
      if (fault === 'late-finish') expect(output).toContain('Before stop. ');
      if (fault === 'usage-disk') expect(output).toContain('Saved before the usage write.');
      if (fault === 'duplicate-kept-call') expect(stored.some((m) => m.stop === 'cut' && calls([m]).length > 0)).toBe(true);
      if (fault === 'late') expect(output).not.toContain('After stop.');
      if (fault === 'duplicate' && action === 'wait' && (place === 'reasoning' || place === 'text')) {
        expect(output.split(place === 'reasoning' ? 'Fixture thought.' : 'Fixture prefix. ')).toHaveLength(2);
      }
      if (fault === 'retry-after' && action === 'wait') expect(fixture.delays.some((ms) => ms >= 3000)).toBe(true);
      if (fault === '429' && action === 'wait') expect(fixture.delays.some((ms) => place === 'summary' ? ms === 2000 : ms >= 1500 && ms < 2000)).toBe(true);
      if (action === 'wait' && (['cut', 'eof', 'silent', 'comments', 'deep', '502', '200-error'] as Fault[]).includes(fault)) expect(sentCalls.length).toBeGreaterThan(place === 'child' || place === 'after-tool' ? 2 : 1);
      if (place === 'child') for (const m of rt.store.list({ children: true }).filter((m) => m.parentId === source.id)) {
        const child = rt.store.load(m.id)!;
        checkHistory(child.messages.filter((m) => !m.replay));
      }
    });
    check('ended', () => {
      expect(s.status).toBe('idle');
      expect(live).toMatchObject({ turnStarted: null, draft: null, running: [], children: [], background: [], preparing: null });
      expect(s.pendingRequests()).toEqual({ permissions: [], questions: [], plans: [] });
      if (stopMs !== undefined) {
        if (place !== 'summary' && fault !== 'offline-queue') expect(end?.reason).toBe('aborted');
        expect(stopMs).toBeLessThan(2000);
      }
      if (place !== 'summary' && action !== 'edit-resend' && fault !== 'offline-queue') expect(end).toBeDefined();
      if (fault === 'usage-disk') expect(end).toMatchObject({ reason: 'done' });
    });
    check('input', () => {
      for (const text of typed) expect(output.includes(text) || returned.includes(text) || openedReturn.includes(text) || s.queued.some((q) => q.text === text)).toBe(true);
      if (fault === 'queued-result-disk') {
        expect(queuedAtFailure).toEqual(['Keep the queued input.']);
        expect(openedReturn).toEqual([]);
        expect(output).toContain('Keep the queued input.');
      }
    });
    check('reopen', () => {
      expect(same(actual)).toEqual(same(stored));
      // A replacement before the first message may delete its source. A branch that keeps a prefix still uses it.
      if (action !== 'edit-resend' || reopened!.meta.base?.id === source.id) expect(readHistory().subarray(0, prefix.length).equals(prefix)).toBe(true);
      if (finalView) {
        expect(finalView.status).toBe('idle');
        expect(finalView.messages.filter((m) => !m.replay).map((m) => m.id)).toEqual(after);
      }
      if (action !== 'edit-resend' || keepsBranchPrefix) expect(after.slice(0, before.length)).toEqual(before);
      if (keepsBranchPrefix) expect(reopened!.meta.base?.id).toBe(source.id);
      if (action !== 'edit-resend' && action !== 'restart') for (const id of after.slice(before.length)) expect(seen.has(id)).toBe(true);
      expect(reopened!.checkpoints.turns()).toEqual(changes.map(([turn]) => turn));
      expect(reopened!.checkpoints.turns().map((turn) => [turn, reopened!.turnChanges(turn)])).toEqual(changes);
    });
    if (action === 'restart') {
      // The next request must replay the finished effects, and starting it must not run any of those tools again.
      const touched = [...touches];
      const start = requests.length;
      replies = [];
      defaultReply = answer;
      await within(reopened.send('Continue after restart.'), 'First turn after restart');
      check('once', () => expect(touches).toEqual(touched));
      check('history', () => {
        const replay = requests.slice(start);
        expect(replay).toHaveLength(1);
        checkChat(replay[0].messages);
        for (const p of results(storedActive)) expect(replay[0].messages.some((m) => m.tool_call_id === p.callId)).toBe(true);
        checkHistory(reopened!.active());
      });
      check('input', () => expect(JSON.stringify(reopened!.messages)).toContain('Continue after restart.'));
      check('reopen', () => expect(same(messagesOnScreen(reopened!.messages, rt).slice(0, stored.length))).toEqual(same(stored)));
    }
    const findings = Object.keys(broken).sort();
    expect(findings, JSON.stringify(broken, null, 2)).toEqual(process.env.FAVILLA_TURN_STRICT === '1' ? [] : [...(c.known ?? [])].sort());
    expect(replyErrors).toEqual([]);
  } finally {
    hit.resolve();
    nextReply.resolve();
    fixture.slowKill = false;
    detach();
    appendSpy.mockRestore();
    writeSpy.mockRestore();
    putSpy?.mockRestore();
    source.abort();
    s.abort();
    await window?.close();
    await Promise.allSettled(running);
    await rt.shutdown();
    for (const res of sockets) res.destroy();
    replyErrors.length = 0;
  }
}, 12_000);
