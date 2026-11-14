import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Sessions against a model server of our own: the name made when the first message goes, and the file a vague one
// gets once the first turn has changed it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-title-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'tally');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });

type Reply = { text?: string; call?: { name: string; args: unknown } };
let plan: Reply[] = [];
const fake = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
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

let rt: Awaited<ReturnType<typeof runtime>>;
async function runtime() {
  const { createRuntime } = await import('../src/runtime');
  return createRuntime(project, { interactive: true });
}

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'fake/m1',
      tools: 'favilla',
      languageServers: false,
      skills: false,
      providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 200000 } } } },
    }),
  );
  rt = await runtime();
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  try {
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Windows can hold a file written a moment ago; a scratch folder left behind is no failure of the names.
  }
});

const writeParser = { call: { name: 'write', args: { path: 'src/parse.ts', content: 'export const parse = (s: string) => s.split(",");\n' } } };

describe('a session’s name', () => {
  it('is made when the first message goes, and a vague one gets the file the first turn changed', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1', interactive: true });
    plan = [writeParser, { text: 'Done.' }];
    await s.send('fix it');
    expect(fs.existsSync(path.join(project, 'src/parse.ts'))).toBe(true);
    expect(s.meta.title).toBe('Fix it · parse.ts');
    // Later turns leave it alone.
    plan = [{ call: { name: 'write', args: { path: 'src/other.ts', content: 'export {};\n' } } }, { text: 'Done.' }];
    await s.send('and the other one');
    expect(s.meta.title).toBe('Fix it · parse.ts');
  });

  it('keeps a name that says the work as it was made', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1', interactive: true });
    plan = [writeParser, { text: 'Done.' }];
    await s.send('你好，请帮我修一下导入时金额算错的问题，谢谢');
    expect(s.meta.title).toBe('修一下导入时金额算错的问题');
  });

  it('stays as it was when the first turn changed nothing', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1', interactive: true });
    plan = [{ text: 'Which part?' }];
    await s.send('继续');
    expect(s.meta.title).toBe('继续');
  });
});
