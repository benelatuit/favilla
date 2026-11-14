import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Rarely used tools wait until the main session loads them: on 2026-11-02 their definitions, with fifty skills at
// full length, were a third of every request's opening.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-images-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'main.go'), 'package main\n\nfunc main() {}\n');

type Reply = { text?: string; call?: { name: string; args: unknown } };
let plan: Reply[] = [];
const bodies: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    bodies.push(JSON.parse(body));
    const r = plan.shift() ?? { text: 'Done.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.call) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', languageServers: false, providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt', vision: true } } } } }),
  );
});

afterAll(async () => {
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const names = (b: (typeof bodies)[number]) => (b.tools ?? []).map((t) => t.function.name);
const system = (b: (typeof bodies)[number]) => b.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

// A 1x1 PNG, read three times: the first picture goes once the second is in, its words stay.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('pictures in a running session', () => {
  it('sends only the newest picture of a view, and keeps the words of the one that went', async () => {
    fs.writeFileSync(path.join(project, 'shot.png'), PNG);
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true });
      plan = [{ call: { name: 'read', args: { path: 'shot.png' } } }, { call: { name: 'read', args: { path: 'shot.png' } } }, { call: { name: 'shell', args: { command: 'echo done' } } }, { text: 'Done.' }];
      const before = bodies.length;
      await s.send('Look at shot.png twice.');
      const sent = bodies.slice(before).map((b) => JSON.stringify(b.messages));
      const pictures = (b: string) => (b.match(/data:image\/png;base64/g) ?? []).length;
      expect(pictures(sent[1])).toBe(1);
      // Once the second picture is in, the first goes before the next request, and its line stands in its place.
      expect(pictures(sent[2])).toBe(1);
      expect(sent[2]).toContain('let go to save context (a newer picture of the same view came after it)');
      expect(pictures(sent[3])).toBe(1);
    } finally {
      rt.dispose();
    }
  });
});

describe('pictures the user sent', () => {
  it('ride with the summary when the conversation is compacted', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true });
      plan = [{ text: 'I see the sketch.' }, { text: 'Summary: the user sent a sketch of the page.' }, { text: 'Done.' }];
      await s.send('Here is my sketch.', [{ type: 'image', mediaType: 'image/png', data: PNG.toString('base64'), name: 'sketch.png' }]);
      await s.compact('manual');
      const summary = s.messages.find((m) => m.origin === 'compaction')!;
      expect(summary.parts.some((p) => p.type === 'image')).toBe(true);
      expect(JSON.stringify(summary.parts)).toContain('The pictures the user sent stay with this summary.');
    } finally {
      rt.dispose();
    }
  });
});
