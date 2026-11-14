import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changesProject } from '../src/agent/turn-checks';

// A plan changes nothing until it is approved, then build does what was said.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-modes-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'a.txt'), 'hello\n');

type Reply = { text?: string; call?: { name: string; args: unknown } };
let script: Reply[] = [];
let requests = 0;
/** The reasoning effort each request carried. */
const efforts: (string | undefined)[] = [];
const reply = (res: http.ServerResponse, r: Reply) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (r.call) {
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${requests}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  res.end('data: [DONE]\n\n');
};
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    requests++;
    efforts.push(JSON.parse(body).reasoning_effort);
    reply(res, script.shift() ?? { text: 'Done.' });
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
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', modelRegistry: false, effort: 'high', providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt', efforts: ['off', 'low', 'high', 'max'] } } } } }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  delete process.env.FAVILLA_ACCEPT_PLANS;
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const results = (s: { messages: { parts: { type: string }[] }[] }) => s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as unknown as { content: string; isError?: boolean; name: string }[];
const words = (m: { parts: { type: string; text?: string }[] }) => m.parts.map((p) => p.text ?? '').join('');

describe('what plan mode refuses', () => {
  it('commands that change the project, by what they say', () => {
    for (const c of [
      'echo hi > x.txt',
      'cat a >> b',
      'rm -rf build',
      'cd src && mv a.go b.go',
      'sed -i s/a/b/ file.go',
      'gofmt -w .',
      'git commit -m x',
      'git -C sub push',
      'git checkout main',
      'pnpm add lodash',
      'npm install',
      'pip install requests',
      'go mod tidy',
      'go get example.com/x',
      'prettier --write src',
      'ruff format .',
      'docker run ubuntu',
      'find . -name "*.tmp" | xargs rm',
    ])
      expect(changesProject(c), c).toBeTruthy();
  });

  it('nothing that only looks, or runs the tests', () => {
    for (const c of ['go test ./...', 'pytest -q', 'npm test', 'pnpm build', 'cat a.txt', 'grep -rn "rm -rf" src', "sed -n '1,20p' a.go", 'git status', 'git log --oneline -5', 'git diff', 'ls -la 2>/dev/null', 'go vet ./... 2>&1 | head -20', 'rg "x > y" src', 'docker ps', 'node -e "console.log(1 > 0)"', 'find . -name "*.go"'])
      expect(changesProject(c), c).toBeNull();
  });
});

describe('plan mode', () => {
  it('sends its rules with the message, thinks at the level the user set, and refuses what would change the project', async () => {
    script = [{ call: { name: 'shell', args: { command: 'echo hi > made.txt' } } }, { call: { name: 'shell', args: { command: 'cat a.txt' } } }, { text: 'Here is what I found.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1', mode: 'plan' });
    efforts.length = 0;
    await s.send('Change a.txt.');
    expect(efforts).toEqual(['high', 'high', 'high']);
    expect(words(s.messages[0])).toMatch(/Plan mode is on[^]*present_plan/);
    const [refused, looked] = results(s);
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/Plan mode is on, so this was not run: it writes a file/);
    expect(fs.existsSync(path.join(project, 'made.txt'))).toBe(false);
    expect(looked.isError).toBeFalsy();
    expect(looked.content).toContain('hello');
  }, 30_000);

  it('run on its own, it ends with the plan and starts nothing', async () => {
    delete process.env.FAVILLA_ACCEPT_PLANS;
    requests = 0;
    script = [{ call: { name: 'present_plan', args: { plan: '# Rename\n\nChange a.txt.', steps: ['Rename it'] } } }, { text: 'That is the plan.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1', mode: 'plan' });
    await s.send('Rename a.txt.');
    expect(s.meta.mode).toBe('plan');
    expect(s.meta.goal).toBeUndefined();
    expect(requests).toBe(2);
    expect(results(s)[0].content).toMatch(/the plan stands as your answer/);
  }, 30_000);

  it('once approved, its steps become the progress, and thinking stays at the set level', async () => {
    const live = createRuntime(project, { interactive: true });
    try {
      script = [{ call: { name: 'present_plan', args: { plan: '# Rename a.txt\n\nDetails.', steps: ['Rename the file', 'Update the callers'] } } }, { text: 'Built.' }];
      const s = await live.start({ cwd: project, model: 'fake/m1', mode: 'plan', interactive: true });
      s.on((e) => {
        if (e.type === 'plan.request') s.respondPlan(e.id, true);
      });
      efforts.length = 0;
      await s.send('Rename a.txt.');
      expect(s.meta.mode).toBe('build');
      expect(s.meta.goal?.objective).toBe('Rename a.txt');
      expect(s.meta.goal?.criteria.map((c) => c.text)).toEqual(['Rename the file', 'Update the callers']);
      // One level through the plan and the work after it: a level that changed on approval cost the whole prompt cache.
      expect(efforts).toEqual(['high', 'high']);
    } finally {
      live.dispose();
    }
  }, 30_000);
});
