import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A whole turn against a scripted model: a command changes files, the turn's undo puts them back.
process.env.FAVILLA_FOLDER_SNAPSHOTS = '1';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-snapshots-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'notes.txt'), 'first draft\n');

type Reply = { text?: string; call?: { name: string; args: Record<string, unknown> } };
let script: Reply[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    const r = script.shift() ?? { text: 'Done.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.call) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'fake/m1', tools: 'favilla', providers: { fake: { api: 'openai-chat', baseUrl: base, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }));
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('undo after a turn whose command changed files', () => {
  it('puts back what the command changed and removes what it made, with no file tool involved', async () => {
    script = [{ call: { name: 'shell', args: { command: 'echo rewritten > notes.txt && echo made > extra.txt' } } }, { text: 'Changed them.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await s.send('Rewrite the notes.');
    expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8').trim()).toBe('rewritten');
    expect(fs.existsSync(path.join(project, 'extra.txt'))).toBe(true);
    // The turn's after snapshot comes in once the turn is over; undo waits for it.
    const [turn] = s.checkpoints.turns().length ? s.checkpoints.turns() : [s.messages.find((m) => m.origin === 'user')!.turn!];
    const restored = (await s.undoFiles(turn)).map((f) => path.basename(f)).sort();
    expect(restored).toEqual(['extra.txt', 'notes.txt']);
    expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('first draft\n');
    expect(fs.existsSync(path.join(project, 'extra.txt'))).toBe(false);
  }, 60_000);
});
