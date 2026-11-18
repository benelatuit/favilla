import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidenceSummary } from '../src/agent/evidence';
import type { AgentEvent, ToolResultPart } from '../src/types';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-job-repeat-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'sample.txt'), 'line 1\n');

type Step = { text?: string; call?: { id?: string; name: string; args: unknown }; before?: () => void | Promise<void> };
let plan: Step[] = [];
let requests = 0;

const fake = http.createServer((req, res) => {
  let body = '';
  res.on('error', () => {});
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    requests++;
    const r = plan.shift() ?? { text: 'Done.' };
    await r.before?.();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.call) {
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{ index: 0, id: r.call.id ?? 'call_same', type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }],
            },
          },
        ],
      });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
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
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const allText = (s: { messages: { parts: { type: string; text?: string; content?: unknown }[] }[] }) =>
  s.messages.flatMap((m) => m.parts.map((p) => p.text ?? (typeof p.content === 'string' ? p.content : ''))).join('\n');

describe('repeat detection across background job waits and real loops', () => {
  it('allows eight consecutive timed-out waits on a still-running job without stopping or nudging', async () => {
    const gate = path.join(project, 'gate-eight');
    fs.rmSync(gate, { force: true });
    const s = await rt.start({ cwd: project, interactive: false });
    const notices: string[] = [];
    s.on((e: AgentEvent) => {
      if (e.type === 'notice') notices.push(e.text);
    });
    const waitArgs = { id: 'job_1', action: 'wait', until: 'ALL_DONE', timeout_ms: 1000 };
    plan = [
      { call: { name: 'shell', args: { command: `node -e "const fs=require('node:fs'); const t=setInterval(()=>{if(fs.existsSync('gate-eight')){clearInterval(t);console.log('ALL_DONE');}},30)"`, background: true } } },
      ...Array.from({ length: 8 }, () => ({ call: { name: 'job', args: waitArgs } })),
      { text: 'Still running cleanly after eight waits.' },
    ];
    try {
      await s.send('Run the long job and keep waiting.');
      expect(s.answer).toBe('Still running cleanly after eight waits.');
      expect(s.jobs.get('job_1')?.done).toBe(false);
      expect(notices).not.toContain('Stopped: the agent kept repeating the same action.');
      const text = allText(s);
      expect(text).not.toContain('You have made the same call with the same outcome several times.');
      expect(text).not.toContain('Repeated interrupted failure');
    } finally {
      const job = s.jobs.get('job_1');
      const closed = job && !job.done ? once(job.child, 'close') : Promise.resolve();
      fs.writeFileSync(gate, '1');
      await closed;
    }
  }, 40_000);

  it('completes cleanly when five timed-out waits are followed by a sixth wait matching the end marker', async () => {
    const gate = path.join(project, 'gate-six');
    fs.rmSync(gate, { force: true });
    const s = await rt.start({ cwd: project, interactive: false });
    const notices: string[] = [];
    s.on((e: AgentEvent) => {
      if (e.type === 'notice') notices.push(e.text);
    });
    const waitArgs = { id: 'job_1', action: 'wait', until: 'ALL_ROUND_DONE', timeout_ms: 1000 };
    plan = [
      { call: { name: 'shell', args: { command: `node -e "const fs=require('node:fs'); const t=setInterval(()=>{if(fs.existsSync('gate-six')){clearInterval(t);console.log('ALL_ROUND_DONE');}},30)"`, background: true } } },
      ...Array.from({ length: 5 }, () => ({ call: { name: 'job', args: waitArgs } })),
      { before: () => fs.writeFileSync(gate, '1'), call: { name: 'job', args: waitArgs } },
      { text: 'Matched end marker on the sixth wait.' },
    ];
    await s.send('Wait until ALL_ROUND_DONE.');
    expect(s.answer).toBe('Matched end marker on the sixth wait.');
    expect(notices).not.toContain('Stopped: the agent kept repeating the same action.');
    const text = allText(s);
    expect(text).toContain('ALL_ROUND_DONE');
    expect(text).not.toContain('You have made the same call with the same outcome several times.');
  }, 40_000);

  it('stops on the sixth wait when the job has already ended and returns no new output', async () => {
    const s = await rt.start({ cwd: project, interactive: false });
    const notices: string[] = [];
    s.on((e: AgentEvent) => {
      if (e.type === 'notice') notices.push(e.text);
    });
    const job = s.jobs.start(`node -e "console.log('finished')"`, project);
    await once(job.child, 'close');
    s.jobs.read(job.id);

    const before = requests;
    const waitArgs = { id: job.id, action: 'wait', until: 'NEVER', timeout_ms: 1000 };
    plan = [
      ...Array.from({ length: 7 }, () => ({ call: { name: 'job', args: waitArgs } })),
      { text: 'Unreachable.' },
    ];
    await s.send('Wait on the finished job.');
    expect(requests - before).toBe(6);
    expect(notices).toContain('Stopped: the agent kept repeating the same action.');
    expect(allText(s)).toContain('You have made the same call with the same outcome several times.');
    expect(s.answer).not.toBe('Unreachable.');
  }, 30_000);

  it('stops on the sixth run of the same failing command even when timing output changes each time', async () => {
    const s = await rt.start({ cwd: project, interactive: false });
    const notices: string[] = [];
    s.on((e: AgentEvent) => {
      if (e.type === 'notice') notices.push(e.text);
    });
    const before = requests;
    const cmd = { command: `node -e "console.log('elapsed ' + Date.now() + Math.random() + 'ms'); process.exit(1)"` };
    plan = [
      ...Array.from({ length: 7 }, () => ({ call: { name: 'shell', args: cmd } })),
      { text: 'Unreachable.' },
    ];
    await s.send('Run the broken command.');
    expect(requests - before).toBe(6);
    expect(notices).toContain('Stopped: the agent kept repeating the same action.');
    expect(s.answer).not.toBe('Unreachable.');
  }, 30_000);

  it('allows repeated job output calls with new output, while stopping empty output spins and repeated file reads', async () => {
    const s1 = await rt.start({ cwd: project, interactive: false });
    const notices1: string[] = [];
    s1.on((e: AgentEvent) => {
      if (e.type === 'notice') notices1.push(e.text);
    });
    let seq = 0;
    const gate = path.join(project, 'gate-stream');
    fs.rmSync(gate, { force: true });
    const live = s1.jobs.start(
      `node -e "const fs=require('node:fs'); const t=setInterval(()=>{if(fs.existsSync('gate-stream'))clearInterval(t);},30)"`,
      project,
    );
    try {
      plan = [
        ...Array.from({ length: 8 }, () => ({
          before: () => {
            live.buffer += `progress line ${++seq}\n`;
          },
          call: { name: 'job', args: { id: live.id, action: 'output' } },
        })),
        { text: 'Read eight streaming output chunks.' },
      ];
      await s1.send('Poll output while lines arrive.');
      expect(s1.answer).toBe('Read eight streaming output chunks.');
      expect(notices1).not.toContain('Stopped: the agent kept repeating the same action.');
      expect(allText(s1)).not.toContain('You have made the same call with the same outcome several times.');

      const beforeEmpty = requests;
      plan = [
        ...Array.from({ length: 7 }, () => ({ call: { name: 'job', args: { id: live.id, action: 'output' } } })),
        { text: 'Unreachable.' },
      ];
      await s1.send('Now spin on output with nothing new.');
      expect(requests - beforeEmpty).toBe(6);
      expect(notices1).toContain('Stopped: the agent kept repeating the same action.');
    } finally {
      const closed = !live.done ? once(live.child, 'close') : Promise.resolve();
      fs.writeFileSync(gate, '1');
      await closed;
    }

    const s2 = await rt.start({ cwd: project, interactive: false });
    const notices2: string[] = [];
    s2.on((e: AgentEvent) => {
      if (e.type === 'notice') notices2.push(e.text);
    });
    const before = requests;
    plan = [
      ...Array.from({ length: 7 }, () => ({ call: { name: 'read', args: { paths: ['sample.txt'] } } })),
      { text: 'Unreachable.' },
    ];
    await s2.send('Read sample.txt repeatedly.');
    expect(requests - before).toBe(6);
    expect(notices2).toContain('Stopped: the agent kept repeating the same action.');
  }, 40_000);

  it('keeps real failure evidence when a background job exits non-zero, while dropping interrupted on running checks', async () => {
    const gate = path.join(project, 'gate-fail');
    fs.rmSync(gate, { force: true });
    const s = await rt.start({ cwd: project, interactive: false });
    const waitArgs = { id: 'job_1', action: 'wait', timeout_ms: 1000 };
    plan = [
      {
        call: {
          name: 'shell',
          args: {
            command: `node -e "const fs=require('node:fs'); const t=setInterval(()=>{if(fs.existsSync('gate-fail')){clearInterval(t);console.error('AssertionError: expected 2, got 1');process.exit(1);}},30)"`,
            background: true,
          },
        },
      },
      { call: { name: 'job', args: waitArgs } },
      { before: () => fs.writeFileSync(gate, '1'), call: { name: 'job', args: waitArgs } },
      { text: 'Saw the background failure.' },
    ];
    await s.send('Run the failing job in the background and wait on it.');
    expect(s.answer).toBe('Saw the background failure.');
    const jobResults = s.messages
      .flatMap((m) => m.parts)
      .filter((p): p is ToolResultPart => p.type === 'tool_result' && p.name === 'job');
    expect(jobResults).toHaveLength(2);
    expect(jobResults[0].display?.kind === 'terminal' ? jobResults[0].display.exitCode : undefined).toBeNull();
    expect(jobResults[0].evidence?.failure).toBeUndefined();
    expect(jobResults[1].display?.kind === 'terminal' ? jobResults[1].display.exitCode : undefined).toBe(1);
    expect(jobResults[1].evidence?.failure).toMatchObject({
      kind: 'assertion',
      diagnostic: expect.stringContaining('AssertionError: expected 2, got 1'),
    });
    expect(evidenceSummary(s.messages, project)).toContain('AssertionError: expected 2, got 1');
  }, 30_000);
});
