import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Sub-agents in the background against a scripted server: the main agent goes on while one works, and its
// report comes back later, in the next step or in a turn of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-subagent-bg-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'a.ts'), 'export const a = 1;\n');

type Reply = { text?: string; call?: { name: string; args: unknown }; delay?: number };
let mainPlan: Reply[] = [];
let childPlan: Reply[] = [];
let childDelay = 0;
let undoGate: Promise<void> | undefined;
const log: string[] = [];
const reply = (res: http.ServerResponse, r: Reply) => {
  // A request the client gave up on (a stop) gets no answer.
  if (res.destroyed) return;
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
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    const json = JSON.parse(body);
    const system = String(json.messages?.[0]?.content ?? '');
    // A sub-agent: a fresh one has its own system prompt, a fork the parent's conversation with its job as a note.
    if (system.includes('sub-agent of Favilla') || body.includes('You are a fork of the conversation above')) {
      log.push('child');
      // A brief that says BROKEN is refused for good: the sub-agent's turn ends in an error.
      if (body.includes('BROKEN')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ error: { message: 'Refused for this test.', type: 'invalid_request_error' } }));
      }
      // A brief that says SLOW takes longer than the rest.
      const wait = body.includes('SLOW') ? 3000 : childDelay;
      if (body.includes('WAIT TO UNDO')) await undoGate;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      // Stopped meanwhile: its turn in the plan stays for the next test's sub-agent.
      if (res.destroyed) return;
      return reply(res, childPlan.shift() ?? { text: 'Report: the project has one file, a.ts.' });
    }
    log.push('main');
    const r = mainPlan.shift() ?? { text: 'Done.' };
    if (r.delay) await new Promise((resolve) => setTimeout(resolve, r.delay));
    return reply(res, r);
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

const textOf = (m: { parts: { type: string; text?: string }[] }) => m.parts.map((p) => p.text ?? '').join('');
const until = async (ok: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
};

describe('sub-agents in the background', () => {
  it('the main agent goes on and ends its turn; the report wakes it for a turn of its own', async () => {
    log.length = 0;
    childDelay = 1500;
    mainPlan = [
      { call: { name: 'agent', args: { description: 'Survey', prompt: 'List the files.', background: true } } },
      { call: { name: 'read', args: { paths: ['a.ts'] } } },
      { text: 'The survey runs in the background; a.ts exports a.' },
      { text: 'The survey found one file, a.ts.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Survey the project in the background and read a.ts meanwhile.');
    const first = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'agent') as { content: string; display?: { background?: boolean } };
    expect(first.content).toMatch(/Running in the background/);
    expect(first.display?.background).toBe(true);
    // The main agent read a.ts and finished its turn before the sub-agent answered.
    expect(log.indexOf('child')).toBeGreaterThan(-1);
    expect(log.filter((x) => x === 'main')).toHaveLength(3);
    await until(() => s.messages.some((m) => m.role === 'assistant' && textOf(m).includes('found one file')));
    const woke = s.messages.find((m) => m.origin === 'harness' && textOf(m).includes('has finished. Its report'));
    expect(woke && textOf(woke)).toContain('the project has one file, a.ts');
    expect(textOf(s.messages.at(-1)!)).toBe('The survey found one file, a.ts.');
  }, 30_000);

  it("passes up a sub-agent's steps but not its commands' output, which nothing shows live", async () => {
    log.length = 0;
    childDelay = 0;
    childPlan = [{ call: { name: 'shell', args: { command: 'echo relay-check-output', description: 'print a line' } } }, { text: 'Printed it.' }];
    mainPlan = [{ call: { name: 'agent', args: { description: 'Print', prompt: 'Print a line.' } } }, { text: 'It printed.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    const seen: string[] = [];
    const off = s.on((e) => {
      if (e.type === 'subagent') seen.push(e.event.type);
    });
    await s.send('Have a sub-agent print a line.');
    off();
    expect(seen).toContain('tool.start');
    expect(seen).toContain('tool.end');
    expect(seen).not.toContain('tool.progress');
  }, 30_000);

  it('files a background sub-agent may change are its own until it reports', async () => {
    log.length = 0;
    childDelay = 2500;
    childPlan = [{ call: { name: 'write', args: { path: 'owned.txt', content: 'from the sub-agent\n' } } }, { text: 'Wrote owned.txt.' }];
    mainPlan = [
      { call: { name: 'agent', args: { description: 'Write owned', prompt: 'Write owned.txt.', type: 'general', files: ['owned.txt'], background: true } } },
      { call: { name: 'write', args: { path: 'owned.txt', content: 'from the main agent\n' } } },
      { call: { name: 'write', args: { path: 'free.txt', content: 'mine\n' } } },
      { text: 'Wrote free.txt; owned.txt is the sub-agent’s.' },
      { text: 'Both files are written.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Write both files, owned.txt through a sub-agent in the background.');
    const results = s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result' && p.name === 'write') as { content: string; isError?: boolean }[];
    expect(results[0].content).toMatch(/background sub-agent "Write owned" is changing owned\.txt/);
    expect(fs.readFileSync(path.join(project, 'free.txt'), 'utf8')).toBe('mine\n');
    await until(() => s.messages.some((m) => m.role === 'assistant' && textOf(m).includes('Both files are written')));
    expect(fs.readFileSync(path.join(project, 'owned.txt'), 'utf8')).toBe('from the sub-agent\n');
  }, 30_000);

  it('a sub-agent whose turn ended in an error says so, with the error, where it once read as a sub-agent without a report', async () => {
    childDelay = 0;
    mainPlan = [{ call: { name: 'agent', args: { description: 'Broken', prompt: 'BROKEN: look at a.ts.' } } }, { text: 'The sub-agent failed.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Have a sub-agent look at a.ts.');
    const r = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'agent') as { content: string; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Refused for this test/);
  }, 30_000);

  it('a general sub-agent in the background must name its files', async () => {
    childDelay = 0;
    mainPlan = [{ call: { name: 'agent', args: { description: 'Anything', prompt: 'Change what you like.', type: 'general', background: true } } }, { text: 'It needs files.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Go, with a sub-agent in the background.');
    const r = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'agent') as { content: string; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/must name the files it may change/);
  }, 30_000);

  it('the main agent is woken once, when the last background sub-agent is in', async () => {
    log.length = 0;
    childDelay = 1500;
    mainPlan = [
      { call: { name: 'agent', args: { description: 'Quick', prompt: 'List the files.', background: true } } },
      { call: { name: 'agent', args: { description: 'Slow', prompt: 'List the files. SLOW', background: true } } },
      { text: 'Both run in the background; I go on when they are in.' },
      { text: 'Both reported.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Survey twice in the background.');
    // The turn ended with both still out, and the session stays loaded for them.
    expect(s.backgroundRuns().map((b) => b.description)).toEqual(['Quick', 'Slow']);
    expect(s.inUse()).toBe(true);
    await s.settled();
    const wakes = s.messages.filter((m) => m.origin === 'harness' && textOf(m).includes('Carry on with the work'));
    expect(wakes).toHaveLength(1);
    expect(textOf(wakes[0])).toMatch(/"Quick" has finished[^]*"Slow" has finished/);
    expect(log.filter((x) => x === 'main')).toHaveLength(4);
    expect(textOf(s.messages.at(-1)!)).toBe('Both reported.');
  }, 30_000);

  it('refuses undo until stop has waited for an idle session’s background sub-agent', async () => {
    log.length = 0;
    childDelay = 0;
    const file = path.join(project, 'undo-while-working.txt');
    fs.writeFileSync(file, 'before\n');
    let release!: () => void;
    undoGate = new Promise<void>((resolve) => { release = resolve; });
    mainPlan = [
      { call: { name: 'read', args: { paths: [path.basename(file)] } } },
      { call: { name: 'write', args: { path: path.basename(file), content: 'after\n' } } },
      { call: { name: 'agent', args: { description: 'Survey', prompt: 'WAIT TO UNDO', background: true } } },
      { text: 'The survey is still running.' },
    ];
    const s = await rt.start({ cwd: project });
    try {
      await s.send('Change the file and survey in the background.');
      await until(() => log.includes('child'));
      expect(s.status).toBe('idle');
      expect(s.backgroundRuns().map((b) => b.description)).toEqual(['Survey']);
      const turn = s.messages.find((m) => m.origin === 'user')!.turn!;
      await expect(s.undoFiles(turn)).rejects.toThrow('Wait for background work to finish or stop it before undoing file changes.');
      expect(fs.readFileSync(file, 'utf8')).toBe('after\n');

      await s.stop();
      expect(s.backgroundRuns()).toEqual([]);
      expect((await s.undoFiles(turn)).map((f) => path.basename(f))).toContain(path.basename(file));
      expect(fs.readFileSync(file, 'utf8')).toBe('before\n');
    } finally {
      s.abort();
      release();
      await s.settled();
      undoGate = undefined;
      fs.rmSync(file, { force: true });
    }
  }, 30_000);

  it('one stop ends the turn and every sub-agent, and nothing starts again on its own', async () => {
    log.length = 0;
    childDelay = 4000;
    mainPlan = [
      { call: { name: 'agent', args: { description: 'Survey', prompt: 'List the files.', background: true } } },
      { text: 'Started.', delay: 4000 },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    const turn = s.send('Survey the project in the background.');
    await until(() => log.filter((x) => x === 'main').length === 2 && log.includes('child'));
    expect(s.backgroundRuns().map((b) => b.description)).toEqual(['Survey']);
    s.abort();
    await turn;
    await s.settled();
    // The time a wake would need: none comes.
    await new Promise((r) => setTimeout(r, 600));
    expect(s.busy).toBe(false);
    expect(s.backgroundRuns()).toEqual([]);
    expect(log.filter((x) => x === 'main')).toHaveLength(2);
    expect(s.messages.some((m) => textOf(m).includes('Carry on with the work'))).toBe(false);
    // What the stopped sub-agent left comes with the next message.
    mainPlan = [{ text: 'Noted.' }];
    await s.send('What happened?');
    const asked = s.messages.filter((m) => m.role === 'user' && m.origin === 'user').at(-1)!;
    expect(textOf(asked)).toMatch(/background sub-agent "Survey" was stopped by the user[^]*The user stopped this sub-agent after \d+ steps?, before it finished/);
  }, 30_000);

  it('stopping one sub-agent tells the agent that started it, which goes on', async () => {
    log.length = 0;
    childDelay = 4000;
    mainPlan = [{ call: { name: 'agent', args: { description: 'Survey', prompt: 'List the files.' } } }, { text: 'Went on without it.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    const turn = s.send('Survey the project with a sub-agent.');
    await until(() => s.liveState().children.length === 1 && log.includes('child'));
    expect(s.stopChild('no-such-session')).toBe(false);
    expect(s.stopChild(s.liveState().children[0].sessionId)).toBe(true);
    await turn;
    const r = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'agent') as { content: string; display?: { stopped?: boolean } };
    expect(r.content).toMatch(/The user stopped this sub-agent/);
    expect(r.display?.stopped).toBe(true);
    expect(textOf(s.messages.at(-1)!)).toBe('Went on without it.');
  }, 30_000);
});

describe('what a sub-agent may do and what is recorded', () => {
  it('a run waits for its background sub-agents, and their tokens count', async () => {
    log.length = 0;
    childDelay = 1200;
    mainPlan = [{ call: { name: 'agent', args: { description: 'Survey', prompt: 'List the files.', background: true } } }, { text: 'Started.' }, { text: 'All done.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Survey it with a sub-agent.');
    await s.settled();
    expect(textOf(s.messages.at(-1)!)).toBe('All done.');
    expect(s.usage.requests).toBe(4);
    expect(s.usage.totalInput).toBe(2000);
    // The token log has each request once: the sub-agent's under its own session, with the one it worked for.
    const { readTokenLog } = await import('../src/store/token-log');
    const logged = (await readTokenLog()).filter((e) => e.session === s.id || e.parent === s.id);
    expect(logged.map((e) => [e.session === s.id ? 'main' : 'child', e.kind, e.model, e.input].join(' ')).sort()).toEqual(['child main m1 500', 'main main m1 500', 'main main m1 500', 'main main m1 500']);
  }, 30_000);

  it('keeps its record across turns, and git shows what its commands wrote', async () => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    childDelay = 1200;
    childPlan = [{ call: { name: 'write', args: { path: 'tool.txt', content: 'x\n' } } }, { call: { name: 'shell', args: { command: 'echo x > by-shell.txt' } } }, { text: 'Wrote both.' }];
    mainPlan = [{ call: { name: 'agent', args: { description: 'Write', prompt: 'Write them.', type: 'general', files: ['tool.txt', 'by-shell.txt'], background: true } } }, { text: 'Started.' }, { text: 'Noted.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Write both through a sub-agent.');
    await s.settled();
    const report = textOf(s.messages.find((m) => m.origin === 'harness' && textOf(m).includes('has finished'))!);
    expect(report).toMatch(/Files it changed: tool\.txt \(\+1 -0\)/);
    expect(report).toMatch(/Also changed while it ran[^.]*by-shell\.txt/);
    expect(report).not.toContain('It changed no files');
  }, 30_000);

  it('runs side by side only what cannot collide', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    const safe = (name: string, input: unknown) => (s as unknown as { parallelSafe(c: unknown): boolean }).parallelSafe({ type: 'tool_call', id: 'c', name, input });
    expect(safe('agent', { description: 'd', prompt: 'p' })).toBe(true);
    expect(safe('agent', { description: 'd', prompt: 'p', type: 'general', files: ['a.ts'] })).toBe(true);
    expect(safe('agent', { description: 'd', prompt: 'p', type: 'general' })).toBe(false);
    expect(safe('attempts', { task: 't' })).toBe(false);
  }, 30_000);

  it('plan mode: a session opened in it is told, and nothing that writes can start', async () => {
    log.length = 0;
    mainPlan = [{ call: { name: 'agent', args: { description: 'Edit', prompt: 'Edit a.ts.', type: 'general', files: ['a.ts'] } } }, { text: 'Understood.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1', mode: 'plan' });
    await s.send('Change a.ts through a sub-agent.');
    expect(textOf(s.messages[0])).toMatch(/Plan mode is on[^]*present_plan/);
    const r = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'agent') as { content: string; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Plan mode is on/);
    expect(log).not.toContain('child');
  }, 30_000);

  it('a plan written as an answer gets the approval card, and approval starts the work', async () => {
    const plan = 'The plan is short and leaves the public interface as it is today, which keeps every caller working as it does now, with no change needed on their side.\n\n1. Add the parser in src/a.ts.\n2. Update the caller in src/b.ts.\n3. Add a test.';
    mainPlan = [{ text: plan }, { text: 'Building now.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1', mode: 'plan', interactive: true });
    s.on((e) => {
      if (e.type === 'plan.request') s.respondPlan(e.id, true);
    });
    await s.send('Plan it.');
    expect(s.meta.mode).toBe('build');
    expect(textOf(s.messages.at(-1)!)).toBe('Building now.');
    // With nobody to ask it is the answer: no request is spent on it, and words alone start nothing.
    mainPlan = [{ text: plan }];
    const alone = await rt.start({ cwd: project, model: 'fake/m1', mode: 'plan' });
    await alone.send('Plan it.');
    expect(alone.meta.mode).toBe('plan');
    expect(alone.usage.requests).toBe(1);
  }, 30_000);
});

describe('when the agent may hand work out', () => {
  const agentResults = (s: { messages: { parts: { type: string; name?: string }[] }[] }) => s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result' && p.name === 'agent') as unknown as { content: string; isError?: boolean }[];

  it('not before it has looked at the work itself: it is told to, and goes on alone', async () => {
    log.length = 0;
    childDelay = 0;
    mainPlan = [{ call: { name: 'agent', args: { description: 'Exports', prompt: 'What does a.ts export?' } } }, { call: { name: 'read', args: { paths: ['a.ts'] } } }, { text: 'a.ts exports a.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('What does a.ts export?');
    const [refused] = agentResults(s);
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/^Not started: look at the work yourself first/);
    expect(log).not.toContain('child');
    expect(textOf(s.messages.at(-1)!)).toBe('a.ts exports a.');
  }, 30_000);

  it('after looking, two a turn; a user who asks for sub-agents lifts both limits', async () => {
    log.length = 0;
    childDelay = 0;
    const read = { call: { name: 'read', args: { paths: ['a.ts'] } } };
    const agent = (d: string) => ({ call: { name: 'agent', args: { description: d, prompt: 'Report on a.ts.' } } });
    mainPlan = [read, read, read, agent('One'), agent('Two'), agent('Three'), { text: 'Done.' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Look into a.ts.');
    const results = agentResults(s);
    expect(results.slice(0, 2).every((r) => !r.isError)).toBe(true);
    expect(results[2].content).toMatch(/^Not started: 2 sub-agents already ran this turn/);
    expect(log.filter((x) => x === 'child')).toHaveLength(2);
    // Asked for, they start at once and past two.
    log.length = 0;
    mainPlan = [agent('One'), agent('Two'), agent('Three'), { text: 'Done.' }];
    const asked = await rt.start({ cwd: project, model: 'fake/m1' });
    await asked.send('Use three sub-agents to look into a.ts.');
    expect(agentResults(asked).every((r) => !r.isError)).toBe(true);
    expect(log.filter((x) => x === 'child')).toHaveLength(3);
  }, 30_000);
});
