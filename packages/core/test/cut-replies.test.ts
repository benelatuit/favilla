import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseToolArgs } from '../src/util/json';
import { toChatMessages } from '../src/providers/openai-chat';

// Replies that stop short, against a scripted server: a closed connection is not an answer, and half a write is not a write.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-cut-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'a.txt'), 'hello\n');

type Script = (chunk: (o: unknown) => void, res: http.ServerResponse) => void;
let script: Script[] = [];
let requests = 0;
const toolChunk = (name: string, args: string) => ({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${requests}`, type: 'function', function: { name, arguments: args } }] } }] });
const text = (t: string, finish = 'stop') => [{ choices: [{ index: 0, delta: { role: 'assistant', content: t } }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }];
const say = (t: string): Script => (chunk, res) => {
  for (const c of text(t)) chunk(c);
  res.end('data: [DONE]\n\n');
};
const fake = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    (script.shift() ?? say('Done.'))((o) => res.write(`data: ${JSON.stringify(o)}\n\n`), res);
  });
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', modelRegistry: false, providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const results = (s: { messages: { parts: { type: string }[] }[] }) => s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as unknown as { content: string; isError?: boolean; name: string }[];

describe('a reply that stops short', () => {
  it('a connection closed in the middle of a tool call runs nothing, and the request goes again', async () => {
    requests = 0;
    script = [
      (chunk, res) => {
        chunk(toolChunk('write', '{"path":"half.txt","content":"the first ha'));
        res.end();
      },
      say('Done.'),
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Write it.');
    expect(fs.existsSync(path.join(project, 'half.txt'))).toBe(false);
    expect(requests).toBe(2);
    expect(results(s)).toHaveLength(0);
  }, 30_000);

  it('a closed connection after a full reply with no [DONE] is an ordinary end', async () => {
    requests = 0;
    script = [
      (chunk, res) => {
        for (const c of text('All here.')) chunk(c);
        res.end();
      },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Say it.');
    expect(requests).toBe(1);
  }, 30_000);

  it('a write cut by the output limit does not run; a read that repair could close does', async () => {
    requests = 0;
    script = [
      (chunk, res) => {
        chunk(toolChunk('write', '{"path":"cut.txt","content":"the first ha'));
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
        res.end('data: [DONE]\n\n');
      },
      (chunk, res) => {
        chunk(toolChunk('read', '{"paths":["a.txt"]'));
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
        res.end('data: [DONE]\n\n');
      },
      say('Done.'),
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Write it.');
    expect(fs.existsSync(path.join(project, 'cut.txt'))).toBe(false);
    const [write, read] = results(s);
    expect(write.isError).toBe(true);
    expect(write.content).toMatch(/cut off by the output limit, so it did not run/);
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('hello');
  }, 30_000);

  it('a call that ends inside a string does not run, even with an ordinary finish', async () => {
    requests = 0;
    script = [
      (chunk, res) => {
        chunk(toolChunk('write', '{"path":"cut2.txt","content":"the first ha'));
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        res.end('data: [DONE]\n\n');
      },
      say('Done.'),
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Write it.');
    expect(fs.existsSync(path.join(project, 'cut2.txt'))).toBe(false);
    expect(results(s)[0].content).toMatch(/ended in the middle of a value/);
  }, 30_000);

  it('a call missing only its last brace still runs when the reply ended normally', async () => {
    requests = 0;
    script = [
      (chunk, res) => {
        chunk(toolChunk('write', '{"path":"whole.txt","content":"all of it\\n"'));
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        res.end('data: [DONE]\n\n');
      },
      say('Done.'),
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Write it.');
    expect(fs.readFileSync(path.join(project, 'whole.txt'), 'utf8')).toBe('all of it\n');
  }, 30_000);

  it('keeps reasoning that came only as opaque details', async () => {
    requests = 0;
    script = [
      (chunk, res) => {
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Answer.', reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque', index: 0 }] } }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.end('data: [DONE]\n\n');
      },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Think.');
    const part = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'reasoning') as { details?: unknown[] } | undefined;
    expect(part?.details).toEqual([{ type: 'reasoning.encrypted', data: 'opaque', index: 0 }]);
  }, 30_000);
});

describe('what repair says it did', () => {
  it('names what it had to close', () => {
    expect(parseToolArgs('{"a":1}').cut).toBeUndefined();
    expect(parseToolArgs('{"a":1,}').cut).toBeUndefined();
    expect(parseToolArgs('{"a":"bc').cut).toBe('string');
    expect(parseToolArgs('{"a":["b"').cut).toBe('structure');
    expect(parseToolArgs('{"a":"bc').value).toEqual({ a: 'bc' });
  });
});

describe('reasoning across turns', () => {
  const messages = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'One.' }], time: 0 },
    { id: 'a1', role: 'assistant', parts: [{ type: 'reasoning', text: 'first thought' }, { type: 'text', text: 'Yes.' }], time: 0 },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Two.' }], time: 0 },
  ];
  const wire = (id: string) => {
    const quirks = id.includes('v4.1') ? { reasoningEcho: 'all', reasoningField: 'reasoning_content' } : { reasoningEcho: 'turn', reasoningField: 'reasoning_content' };
    return toChatMessages({ system: 's', messages, turnStart: 2, model: { id, quirks, vision: false } } as never) as { role: string; reasoning_content?: string }[];
  };

  it('DeepSeek V4.1 keeps every turn of it, as its encoding does when tools are declared', () => {
    expect(wire('deepseek-v4.1-flash').find((m) => m.role === 'assistant')?.reasoning_content).toBe('first thought');
    expect(wire('deepseek-chat').find((m) => m.role === 'assistant')?.reasoning_content).toBeUndefined();
  });
});
