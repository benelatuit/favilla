import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Session } from '../src/agent/session';
import type { AgentEvent, StreamDraft } from '../src/types';

const lead = 'Already said: 先';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-stream-draft-'));
const project = path.join(home, 'project');
let replies: ((res: http.ServerResponse) => void)[] = [];
const asks: { messages: { role: string; content: unknown }[] }[] = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8').on('data', (chunk) => { body += chunk; }).on('end', () => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[{"id":"m1"}]}');
      return;
    }
    asks.push(JSON.parse(body));
    const reply = replies.shift();
    if (reply) reply(res);
    else res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"Unexpected request"}}');
  });
});

function stream(res: http.ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  return (delta: object, finish_reason?: string) => res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
  );
}

function answer(res: http.ServerResponse) {
  const piece = stream(res);
  piece({ content: 'Finished.' });
  piece({}, 'stop');
  res.end('data: [DONE]\n\n');
}

let runtime: ReturnType<typeof import('../src/runtime').createRuntime>;
let preset: import('../src/prompt/preset').ActivePreset;
beforeAll(async () => {
  process.env.FAVILLA_HOME = path.join(home, 'favilla');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(process.env.FAVILLA_HOME, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(process.env.FAVILLA_HOME, 'cache/toolchains2.json'), JSON.stringify({ at: Date.now(), versions: {} }));
  fs.writeFileSync(path.join(project, 'one.txt'), 'first fixture\n');
  fs.writeFileSync(path.join(project, 'two.txt'), 'second fixture\n');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  fs.writeFileSync(path.join(process.env.FAVILLA_HOME, 'config.json'), JSON.stringify({
    model: 'fixture/m1', modelRegistry: false, folderSnapshots: false, languageServers: false, skills: false, webSearch: false, tools: 'favilla',
    providers: {
      fixture: { name: 'Fixture', api: 'openai-chat', auth: 'none', local: true, baseUrl: `http://127.0.0.1:${port}/v1`,
        models: { m1: { contextWindow: 100_000, family: 'gpt', quirks: { prefill: true } } } },
    },
  }));
  const { parseTavernPreset } = await import('../src/prompt/preset');
  preset = { scope: 'workspace', preset: parseTavernPreset({ prompts: [], assistant_prefill: lead }, 'Fixture').preset };
  const { createRuntime } = await import('../src/runtime');
  runtime = createRuntime(project, { interactive: true });
});

afterAll(async () => {
  runtime?.dispose();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type StreamEvent = Extract<AgentEvent, { type: 'stream.start' | 'stream.text' | 'stream.reasoning' | 'stream.tool' | 'stream.end' | 'stream.discard' }>;
type Capture = { event: StreamEvent; draft: StreamDraft | null };

function observe(session: Session, abort = false): Capture[] {
  const captures: Capture[] = [];
  session.on((event) => {
    if (event.type === 'stream.start' || event.type === 'stream.text' || event.type === 'stream.reasoning'
      || event.type === 'stream.tool' || event.type === 'stream.end' || event.type === 'stream.discard') {
      captures.push({ event, draft: session.liveState().draft });
      if (abort && event.type === 'stream.text') session.abort();
    }
  });
  return captures;
}

function verify(captures: Capture[]) {
  let active: string | undefined;
  const parts = new Map<number, StreamDraft['parts'][number]>();
  for (const { event, draft } of captures) {
    if (event.type === 'stream.start') {
      expect(active).toBeUndefined();
      active = event.messageId;
      parts.clear();
    } else if (event.type === 'stream.end' || event.type === 'stream.discard') {
      expect(event.messageId).toBe(active);
      active = undefined;
    } else {
      expect(event.messageId).toBe(active);
      const before = parts.get(event.index)?.text ?? '';
      expect(event.at).toBe(before.length);
      const base = { index: event.index, text: before + event.delta };
      parts.set(event.index, event.type === 'stream.tool'
        ? { ...base, kind: 'tool', id: event.id, name: event.name }
        : { ...base, kind: event.type === 'stream.text' ? 'text' : 'reasoning' });
    }
    expect(draft).toEqual(active === undefined ? null : { messageId: active, parts: [...parts.values()] });
  }
  expect(active).toBeUndefined();
}

it('publishes the exact draft and offsets for prefilled text, reasoning and interleaved tool calls', async () => {
  replies = [
    (res) => {
      const piece = stream(res);
      piece({ reasoning_content: 'Think ' });
      piece({ reasoning_content: '再想。' });
      piece({ content: ' continue ' });
      piece({ tool_calls: [
        { index: 0, id: 'left', function: { name: 'read', arguments: '' } },
        { index: 1, id: 'right', function: { name: 'read', arguments: '{"paths":' } },
      ] });
      piece({ content: 'here 🎨.' });
      piece({ tool_calls: [{ index: 0, function: { arguments: '{"paths":["one.txt"]}' } }] });
      piece({ tool_calls: [{ index: 1, function: { arguments: '["two.txt"]}' } }] });
      piece({}, 'tool_calls');
      res.end('data: [DONE]\n\n');
    },
    answer,
  ];
  const session = await runtime.start({ cwd: project, preset });
  const seen = observe(session);
  const before = asks.length;
  await session.send('Go.');
  verify(seen);
  expect(asks.slice(before)).toHaveLength(2);
  expect(asks[before].messages.at(-1)).toMatchObject({ role: 'assistant', content: lead });
  const first = seen.filter(({ event }) => event.messageId === seen[0].event.messageId);
  expect(first.map(({ event }) => event.type)).toEqual([
    'stream.start', 'stream.reasoning', 'stream.reasoning', 'stream.text', 'stream.tool', 'stream.tool',
    'stream.text', 'stream.tool', 'stream.tool', 'stream.end',
  ]);
  expect(first[3].event).toMatchObject({ at: 0, delta: lead + ' continue ' });
  expect(first[6].event).toMatchObject({ at: (lead + ' continue ').length, delta: 'here 🎨.' });
  expect(session.liveState().draft).toBeNull();
});

it('drops the failed attempt before starting a retry at offset zero', async () => {
  replies = [(res) => { stream(res)({ content: 'Partial.' }); res.end(); }, answer];
  const session = await runtime.start({ cwd: project, preset: null });
  const seen = observe(session);
  await session.send('Go.');
  verify(seen);
  expect(seen.map(({ event }) => event.type)).toEqual([
    'stream.start', 'stream.text', 'stream.discard', 'stream.start', 'stream.text', 'stream.end',
  ]);
  expect(seen[0].event.messageId).not.toBe(seen[3].event.messageId);
  expect(session.liveState().draft).toBeNull();
});

it('clears an aborted draft', async () => {
  replies = [(res) => { stream(res)({ content: 'Interrupt me.' }); }];
  const session = await runtime.start({ cwd: project, preset: null });
  const seen = observe(session, true);
  await session.send('Go.');
  verify(seen);
  expect(seen.map(({ event }) => event.type)).toEqual(['stream.start', 'stream.text', 'stream.end']);
  expect(session.liveState().draft).toBeNull();
});

it('clears a draft when the provider refuses the request', async () => {
  replies = [(res) => res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"Request rejected"}}')];
  const session = await runtime.start({ cwd: project, preset: null });
  const seen = observe(session);
  await session.send('Go.');
  verify(seen);
  expect(seen.map(({ event }) => event.type)).toEqual(['stream.start', 'stream.discard']);
  expect(session.liveState().draft).toBeNull();
});
