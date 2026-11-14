import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { foregroundWait } from '../src/tools/shell-tools';

// Background commands in a session someone has open, against a scripted server: a command's end comes back as a
// message and wakes the idle session, and a wait in the foreground is turned away with what to do instead.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-job-wake-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'a.ts'), 'export const a = 1;\n');

type Reply = { text?: string; call?: { name: string; args: unknown } };
let plan: Reply[] = [];
let requests = 0;
const reply = (res: http.ServerResponse, r: Reply) => {
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
};
const fake = http.createServer((req, res) => {
  let body = '';
  res.on('error', () => {});
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    requests++;
    return reply(res, plan.shift() ?? { text: 'Done.' });
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
    JSON.stringify({
      model: 'fake/m1',
      tools: 'favilla',
      guard: { mode: 'off' },
      providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } },
    }),
  );
  rt = createRuntime(project, { interactive: true });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const textOf = (m: { parts: { type: string; text?: string; content?: unknown }[] }) => m.parts.map((p) => p.text ?? (typeof p.content === 'string' ? p.content : '')).join('');
const until = async (ok: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
};
const build = `node -e "setTimeout(() => console.log('built ok'), 1500)"`;

describe('background commands in an open session', () => {
  it('a command that ends wakes the idle session with its exit code and last lines', async () => {
    plan = [{ call: { name: 'shell', args: { command: build, background: true } } }, { text: 'The build runs in the background.' }, { text: 'The build printed built ok.' }];
    const s = await rt.start({ cwd: project, interactive: true });
    await s.send('Build in the background and tell me how it went.');
    const started = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'shell') as { content: string };
    expect(started.content).toMatch(/Started background job job_1/);
    expect(started.content).toMatch(/wake you if your turn is over/);
    await until(() => s.messages.some((m) => m.role === 'assistant' && textOf(m).includes('printed built ok')));
    const woke = s.messages.find((m) => m.origin === 'harness' && textOf(m).includes('ended with exit code 0'));
    expect(woke && textOf(woke)).toContain('built ok');
    expect(textOf(s.messages.at(-1)!)).toBe('The build printed built ok.');
  }, 30_000);

  it('keeps a job running at stop from waking the session, but keeps its report', async () => {
    const s = await rt.start({ cwd: project, interactive: true });
    const command = (gate: string) => `node -e "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('${gate}')) { clearInterval(timer); console.log('built ok'); } }, 20);"`;
    const gate = 'finish-stopped-job';
    const nextGate = 'finish-next-job';
    const job = s.jobs.start(command(gate), project);
    const ended = once(job.child, 'close');
    const before = requests;
    try {
      await s.stop();
      expect(job.done).toBe(false);
      fs.writeFileSync(path.join(project, gate), '');
      await ended;
      await s.settled();
      expect(requests).toBe(before);
      expect(s.messages).toHaveLength(0);

      plan = [{ text: 'Noted.' }];
      await s.send('What happened to the build?');
      const asked = s.messages.findLast((m) => m.role === 'user' && m.origin === 'user');
      expect(asked && textOf(asked)).toMatch(/job_1 ended with exit code 0[^]*built ok/);

      const next = s.jobs.start(command(nextGate), project);
      const nextEnded = once(next.child, 'close');
      plan = [{ text: 'The second build succeeded.' }];
      fs.writeFileSync(path.join(project, nextGate), '');
      await nextEnded;
      await s.settled();
      expect(requests).toBe(before + 2);
      expect(s.answer).toBe('The second build succeeded.');
    } finally {
      fs.writeFileSync(path.join(project, gate), '');
      await ended;
    }
  }, 30_000);

  it('a job that outlives the stop wakes the session again once the user has written', async () => {
    const s = await rt.start({ cwd: project, interactive: true });
    const gate = 'finish-outliving-job';
    const job = s.jobs.start(`node -e "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('${gate}')) { clearInterval(timer); console.log('built ok'); } }, 20);"`, project);
    const ended = once(job.child, 'close');
    try {
      await s.stop();
      plan = [{ text: 'Still building; I will say when it ends.' }];
      await s.send('Carry on.');
      const before = requests;
      plan = [{ text: 'The build ended well.' }];
      fs.writeFileSync(path.join(project, gate), '');
      await ended;
      await s.settled();
      expect(requests).toBe(before + 1);
      expect(s.answer).toBe('The build ended well.');
    } finally {
      fs.writeFileSync(path.join(project, gate), '');
      await ended;
    }
  }, 30_000);

  it('a command the agent waited on and read to its end wakes nothing more', async () => {
    plan = [
      { call: { name: 'shell', args: { command: `node -e "console.log('quick')"`, background: true } } },
      { call: { name: 'job', args: { id: 'job_1', action: 'wait' } } },
      { text: 'It printed quick.' },
    ];
    const s = await rt.start({ cwd: project, interactive: true });
    await s.send('Run it in the background and wait for it.');
    const before = requests;
    await new Promise((r) => setTimeout(r, 2500));
    expect(requests).toBe(before);
    expect(s.messages.some((m) => m.origin === 'harness' && textOf(m).includes('ended with exit code'))).toBe(false);
  }, 30_000);

  it('a wait in the foreground is turned away, with the way to wait instead', async () => {
    plan = [{ call: { name: 'shell', args: { command: 'sleep 30' } } }, { text: 'I will wait in the background instead.' }];
    const s = await rt.start({ cwd: project, interactive: true });
    const t0 = Date.now();
    await s.send('Wait half a minute.');
    expect(Date.now() - t0).toBeLessThan(15_000);
    const result = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'shell') as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Not run: this command would wait 30 s in the foreground/);
    expect(result.content).toMatch(/background: true/);
  }, 30_000);
});

describe('what counts as a wait in the foreground', () => {
  it('adds up the pauses of the shells it knows, and a pause in a loop is a wait of unknown length', () => {
    expect(foregroundWait('sleep 30')).toBe(30);
    expect(foregroundWait('npm start & sleep 2 && curl localhost:3000')).toBe(2);
    expect(foregroundWait('sleep 1m')).toBe(60);
    expect(foregroundWait('Start-Sleep -Seconds 15')).toBe(15);
    expect(foregroundWait('Start-Sleep 12')).toBe(12);
    expect(foregroundWait('Start-Sleep -Milliseconds 500')).toBe(0.5);
    expect(foregroundWait('timeout /t 20 /nobreak')).toBe(20);
    expect(foregroundWait('ping -n 11 127.0.0.1 > nul')).toBe(11);
    expect(foregroundWait('until curl -s localhost:3000; do sleep 2; done')).toBe(Infinity);
    expect(foregroundWait('while ($true) { Start-Sleep 5 }')).toBe(Infinity);
    // Words that only look like a loop, and loops that never pause.
    expect(foregroundWait('git commit -m "fix for the bug" && sleep 3')).toBe(3);
    expect(foregroundWait('for f in *.txt; do wc -l "$f"; done')).toBe(0);
    expect(foregroundWait('timeout 60 go test ./...')).toBe(0);
    expect(foregroundWait('python -c "import time; time.sleep(30)"')).toBe(0);
  });
});
