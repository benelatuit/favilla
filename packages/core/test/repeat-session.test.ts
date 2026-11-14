import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A scripted model whose first reply falls into a loop inside a tool call and would run on for a long while.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-repeat-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

const row = '\t\t{"RoundUp", "0.01230000000000000000000000000000", 4, "0.0123", -4},\n';
const LOOP_CHUNKS = 4000;
let requests = 0;
let loopChunksSent = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    // A request the client gave up on before its body was sent (the stop this file tests) needs no answer.
    let json: { messages: unknown[] };
    try {
      json = JSON.parse(body);
    } catch {
      res.destroy();
      return;
    }
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (requests === 1) {
      const start = JSON.stringify({ path: 'cases.go', old_string: 'x', new_string: '' }).slice(0, -2);
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'edit', arguments: start } }] } }] });
      // About 300k characters, unless the client stops reading first.
      for (let i = 0; i < LOOP_CHUNKS && !res.destroyed && !req.socket.destroyed; i++) {
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(row).slice(1, -1) } }] } }] });
        loopChunksSent++;
        if (i % 20 === 0) await new Promise((r) => setTimeout(r, 1));
      }
      if (!res.destroyed) res.end('data: [DONE]\n\n');
      return;
    }
    const last = JSON.stringify(json.messages.at(-1));
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: last.includes('stopped and dropped') ? 'Wrote the cases with a loop instead.' : 'Done.' } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 5 } });
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

describe('a reply that falls into repeating itself', () => {
  it('is stopped early, kept out of the history, and the model is told why', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Add the rounding cases.');
    // Stopped within the first few thousand characters of the loop, not at the end of the stream.
    expect(loopChunksSent).toBeLessThan(LOOP_CHUNKS / 4);
    expect(s.messages.some((m) => m.parts.some((p) => p.type === 'tool_call'))).toBe(false);
    const notes = s.messages.filter((m) => m.origin === 'harness').map((m) => m.parts.map((p) => (p as { text?: string }).text ?? '').join(''));
    expect(notes.some((n) => n.includes('stopped and dropped') && n.includes('RoundUp'))).toBe(true);
    expect(s.messages.at(-1)!.parts.map((p) => (p as { text?: string }).text ?? '').join('')).toBe('Wrote the cases with a loop instead.');
  }, 30_000);
});
