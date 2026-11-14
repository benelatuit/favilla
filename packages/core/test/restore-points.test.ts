import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A restore point lists what it would put back: a file made and removed in the turn (a scratch script) is not in it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-restore-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

const plan: ({ call: { name: string; args: unknown } } | { text: string })[] = [
  { call: { name: 'write', args: { path: 'scratch.py', content: 'print(1)\n' } } },
  { call: { name: 'write', args: { path: 'keep.txt', content: 'kept\n' } } },
  { call: { name: 'shell', args: { command: 'rm scratch.py' } } },
  { text: 'Done.' },
];
const model = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url?.endsWith('/models')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm1' }] }));
    const r = plan.shift() ?? { text: 'Done.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if ('call' in r) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${plan.length}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
});

let rt: ReturnType<typeof import('../src/runtime').createRuntime>;
beforeAll(async () => {
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'fake/m1', tools: 'favilla', providers: { fake: { api: 'openai-chat', baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 32000 } } } } }));
  const { createRuntime } = await import('../src/runtime');
  rt = createRuntime(project, { interactive: false });
});
afterAll(async () => {
  rt.dispose();
  model.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a restore point', () => {
  it('lists the files it would put back, not one the turn made and removed', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Try something in a script, then keep a note.');
    expect(fs.existsSync(path.join(project, 'scratch.py'))).toBe(false);
    const turn = s.messages.find((m) => m.origin === 'user')!.turn!;
    expect(s.turnChanges(turn).map((c) => c.path)).toEqual(['keep.txt']);
  }, 30_000);
});
