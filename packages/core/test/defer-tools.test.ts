import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBrowser } from '../src/tools/browser';

// Rarely used tools are listed in short until the main session loads them: on 2026-11-02 their definitions, with
// fifty skills at full length, were a third of every request's opening. Loading never changes the tool list, which a
// provider's prompt cache starts with.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-defer-'));
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
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', languageServers: false, providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }),
  );
});

afterAll(async () => {
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const names = (b: (typeof bodies)[number]) => (b.tools ?? []).map((t) => t.function.name);
const tool = (b: (typeof bodies)[number], name: string) => (b.tools ?? []).find((t) => t.function.name === name)?.function as { description: string; parameters: unknown } | undefined;
const text = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));
const system = (b: (typeof bodies)[number]) => b.messages.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n');
const results = (b: (typeof bodies)[number]) => b.messages.filter((m) => m.role === 'tool').map((m) => text(m.content));
const lastUser = (b: (typeof bodies)[number]) => text(b.messages.filter((m) => m.role === 'user').at(-1)?.content);
// attempts only in a git repository, which this folder is not; symbols, remember and review are listed in full.
const HELD = ['paint', 'browser', 'watch'];
let plainTools = '';

// The browser is one of the tools held back, and a session has it only where a browser is installed.
describe.skipIf(!findBrowser())('tools held back until needed', () => {
  it('lists the rarely used tools in short, gives their instructions in the conversation, and never changes the list', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true });
      plan = [{ call: { name: 'load_tools', args: { names: ['paint'] } } }, { call: { name: 'watch', args: { path: 'missing.mp4' } } }, { text: 'Done.' }];
      const before = bodies.length;
      await s.send('Tidy up main.go.');
      const [first, second, third] = bodies.slice(before);
      expect(names(first)).toEqual(expect.arrayContaining(['load_tools', 'shell', 'symbols', 'remember', 'review', ...HELD]));
      expect(names(first)).not.toContain('attempts');
      for (const n of ['symbols', 'remember', 'review']) expect(tool(first, n)!.description, n).not.toMatch(/load_tools/);
      // In short: a whole line on what it is for, a pointer to load_tools, and parameters without their descriptions.
      const paint = tool(first, 'paint')!;
      expect(paint.description).toBe('Paints pictures by hand (illustrations, scenes, textures) and cuts a picture out of its ground. Listed in short: load_tools gives its full instructions.');
      expect(paint.description.length).toBeLessThan(260);
      expect(JSON.stringify(paint.parameters)).not.toContain('"description"');
      // Not recall: after a compaction it is how details come back, so it is listed in full.
      expect(tool(first, 'recall')!.description).not.toMatch(/load_tools/);
      expect(system(first)).toMatch(/Some tools in your list are in short: .* In short now: [^.]*paint/);
      // A provider's prompt cache starts with the tool list: it is the same in every request.
      plainTools = JSON.stringify(first.tools);
      expect(JSON.stringify(second.tools)).toBe(plainTools);
      expect(JSON.stringify(third.tools)).toBe(plainTools);
      // load_tools answers with the whole definition.
      expect(results(second).at(-1)).toMatch(/## paint\n[\s\S]*Parameters \(JSON schema\): \{/);
      // watch was called without loading: it ran, and its instructions came with its first result.
      expect(results(third).at(-1)).toMatch(/The full instructions of watch, for your next calls:\n\n## watch/);
    } finally {
      rt.dispose();
    }
  });

  it('brings the browser and the paint tool in full on a message that needs them, with the list unchanged', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true });
      plan = [{ text: 'Done.' }];
      const before = bodies.length;
      await s.send('Make a poster for our gig on Friday.');
      const note = lastUser(bodies[before]);
      expect(note).toMatch(/Loaded for this request, no load_tools call needed: the full instructions of browser, paint\./);
      expect(note).toContain('## browser');
      expect(note).toContain('## paint');
      expect(note).not.toContain('## review');
      expect(JSON.stringify(bodies[before].tools)).toBe(plainTools);
    } finally {
      rt.dispose();
    }
  });
});
