import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The sheet that shows a sub-agent's whole conversation asks the runtime for that session while it works: it must
// get the running session itself, never a copy read from disk that stops moving.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-child-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    const json = JSON.parse(body);
    const isChild = JSON.stringify(json.messages).includes('Count the files slowly');
    const last = json.messages.at(-1);
    const toolResults = json.messages.filter((m: { role: string }) => m.role === 'tool').length;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const call = (name: string, args: unknown) => {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    };
    if (isChild && toolResults < 3) call('shell', { command: 'node -e "setTimeout(() => {}, 700)"', description: 'Wait a little' });
    else if (!isChild && last.role === 'user') call('agent', { description: 'Slow counter', prompt: 'Count the files slowly.' });
    else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 5 } });
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
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', providers: { fake: { api: 'openai-chat', baseUrl: base, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a sub-agent asked for while it works', () => {
  it('is the running session, and what it holds keeps growing', async () => {
    const parent = await rt.start({ cwd: project, model: 'fake/m1' });
    let childId = '';
    let seen!: () => void;
    const firstStep = new Promise<void>((r) => (seen = r));
    parent.on((e) => {
      if (e.type === 'subagent' && e.event.type === 'tool.start' && !childId) {
        childId = e.event.sessionId;
        seen();
      }
    });
    const turn = parent.send('Count the files with a sub-agent.');
    await firstStep;
    const a = await rt.get(childId);
    expect(a).toBe(parent.descendant(childId));
    const early = a.messages.length;
    // It keeps working: wait until it holds more (a busy machine starts its commands slowly).
    const deadline = Date.now() + 15_000;
    while ((await rt.get(childId)).messages.length <= early && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const b = await rt.get(childId);
    expect(b).toBe(a);
    expect(b.messages.length).toBeGreaterThan(early);
    await turn;
  }, 30_000);
});
