import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/agent/session';
import { fill, promptAsset } from '../src/prompt/system';
import { buildTools, type ProfileContext } from '../src/tools/profiles';
import { Deferred } from '../src/util/async';
import type { AgentEvent, Goal, SessionMeta, ToolResultPart } from '../src/types';

vi.hoisted(() => vi.stubEnv('FAVILLA_STALL_MS', '800'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-brief-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
const skill = path.join(project, '.favilla', 'skills', 'gig-layout');
const skillText = 'Set the headline before choosing the size of the date.\n';
fs.mkdirSync(skill, { recursive: true });
fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: gig-layout\ndescription: Lay out a gig poster.\n---\n' + skillText);
fs.writeFileSync(path.join(project, 'notes.txt'), 'A gig for a small room.\n');

const brief = `KIND: A ticket poster
FOR: the people going to the gig
LOOKED AT:
- Ticket stubs | the box office | date and venue in one place
DIRECTIONS:
1. Ticket: put the date by the venue
2. Type: the headliner in bold
3. Photo: a crowd at the gig
CHOSEN: 1 | the date reads first
BAR:
- [look] The date reads at a glance
- [run] The file opens
- [measure] It is 1080 pixels wide
FIRST: the poster
SKILLS: gig-layout`;
const pass = '1: PASS | clear date\n2: PASS | file opened\n3: PASS | 1080 px';
const researchError = 'Research request rejected';
type Reply = { text: string } | { call: { name: string; args: unknown } } | { error: string } | { silent: 'headers' | 'events'; closed: () => void };
const call = (name: string, args: unknown = {}): Reply => ({ call: { name, args } });
let plan: Reply[];
let requests: { messages: unknown[]; tools?: { function: { name: string } }[] }[];
let unscripted: number;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    requests.push(JSON.parse(body));
    const next = plan.shift();
    if (!next) unscripted++;
    if (!next || 'error' in next) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: next?.error ?? 'Unexpected model request' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    if ('silent' in next) {
      res.on('close', next.closed);
      res.flushHeaders();
      if (next.silent === 'events') {
        chunk({ choices: [{ index: 0, delta: { reasoning_content: 'Thinking about the request.' } }] });
        res.write(': keep-alive\n\n');
        chunk({ choices: [{ index: 0, delta: { content: 'FIXED: a poster\nLOOKS:\n1. A photo | an old ticket | rarely' } }] });
      }
      return;
    }
    if ('call' in next) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c-${requests.length}`, type: 'function', function: { name: next.call.name, arguments: JSON.stringify(next.call.args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: next.text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
});

let rt: ReturnType<typeof import('../src/runtime').createRuntime>;
beforeAll(async () => {
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const port = (fake.address() as AddressInfo).port;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    model: 'fake/m1',
    tools: 'favilla',
    languageServers: false,
    providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } },
  }));
  const { createRuntime } = await import('../src/runtime');
  rt = createRuntime(project, { interactive: true });
});
beforeEach(() => {
  requests = [];
  plan = [];
  unscripted = 0;
});
afterEach(() => {
  for (const id of rt.live.keys()) rt.close(id);
  expect(plan).toHaveLength(0);
  expect(unscripted).toBe(0);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  rt?.dispose();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const start = () => rt.start({ cwd: project, interactive: true });
const results = (s: Session, name: string): ToolResultPart[] =>
  s.messages.flatMap((m) => m.parts.filter((p): p is ToolResultPart => p.type === 'tool_result' && p.name === name));
const reviewed = () => requests.filter((r) => JSON.stringify(r.messages).includes('Review finished work against its brief'));
const reviewNotices = (events: AgentEvent[]) => events.flatMap((e) => e.type === 'notice' && e.key === 'A reviewer checks the result against the brief ({n} of 2).' ? [e.text] : []);

describe('the brief tool', () => {
  it.each(['headers', 'events'] as const)('goes on without a look when the looks call stalls after %s', async (silent) => {
    const s = await start();
    const closed = new Deferred<void>();
    const limit = new AbortController();
    plan = [call('brief'), { silent, closed: () => closed.resolve() }, { text: brief }, { text: 'The poster is ready.' }, { text: pass }];
    const turn = s.send('Make a ticket poster for our gig.');
    try {
      await Promise.race([turn, delay(3500, undefined, { signal: limit.signal }).then(() => { throw new Error('The looks call held the turn.'); })]);
      await closed.promise;
      expect(requests).toHaveLength(5);
      expect(JSON.stringify(requests[1].messages)).toContain('Here is a request for something people will look at:');
      expect(JSON.stringify(requests[2].messages)).not.toContain('A photo | an old ticket');
      expect(JSON.stringify(requests[2].messages)).not.toContain('The request fixes:');
      expect(s.meta.goal?.by).toBe('model');
      expect(s.status).toBe('idle');
    } finally {
      limit.abort();
      await s.stop();
      await turn.catch(() => {});
      plan = [];
    }
  });

  it('gives the maker a brief, its criteria and skill, and releases the bar after a passing review', async () => {
    const s = await start();
    const events: AgentEvent[] = [];
    const goals: Goal[] = [];
    let liveChildren: ReturnType<Session['liveState']>['children'] | undefined;
    s.on((e) => {
      events.push(e);
      if (e.type === 'meta' && e.meta.goal) goals.push(e.meta.goal);
      if (e.type === 'subagent' && e.event.type === 'tool.start') liveChildren = s.liveState().children;
    });
    const note = 'Keep the headliner’s name in full.';
    plan = [
      call('brief', { note }),
      { text: 'FIXED: a poster for a gig\nLOOKS:\n1. A big photo of the band | gig posters | often\n2. A ticket stub | the box office | rarely' },
      call('read', { path: 'notes.txt' }),
      { text: brief },
      { text: 'The poster is ready.' },
      { text: pass },
    ];
    await s.send('Make a ticket poster for our gig.');
    expect(JSON.stringify(requests[1].messages)).toContain('Here is a request for something people will look at:');
    const asked = JSON.stringify(requests[2].messages);
    expect(asked).toContain('Make a ticket poster for our gig.');
    expect(asked).toContain(`The maker adds: ${note}`);
    expect(asked).toContain('The request fixes: a poster for a gig.');
    expect(asked).toContain('A ticket stub (from the box office)');
    expect(asked).not.toContain('A big photo of the band');
    expect(asked).toContain('notes.txt');
    expect(asked).toContain('gig-layout (Lay out a gig poster.)');
    expect(requests[2].tools?.map((t) => t.function.name)).toContain('read');
    expect(requests[2].tools?.map((t) => t.function.name)).not.toContain('brief');

    const firstBriefSuffix = '\n\nThe full instructions of brief, for your next calls:\n\n## brief\n';
    const [made] = results(s, 'brief');
    expect(made.content.split(firstBriefSuffix)[0]).toBe(fill(promptAsset('brief-made'), { goal: 'criteria', brief: `${brief}\n\n# Skill: gig-layout\n${skillText}` }));
    expect(made.content).toContain(firstBriefSuffix);
    expect(made.display).toMatchObject({ kind: 'task', description: 'Find out what the request needs', agent: 'brief', steps: 2, childSession: expect.any(String) });
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent', callId: made.callId, event: expect.objectContaining({ type: 'tool.start', name: 'read' }) }));
    expect(liveChildren).toMatchObject([{ callId: made.callId, steps: [{ name: 'read' }] }]);
    expect(goals.find((g) => g.by === 'brief')).toMatchObject({
      objective: 'A ticket poster (1)',
      criteria: [
        { text: 'The date reads at a glance', check: 'look', done: false },
        { text: 'The file opens', check: 'run', done: false },
        { text: 'It is 1080 pixels wide', check: 'measure', done: false },
      ],
    });
    expect(s.meta.goal?.by).toBe('model');
    expect(s.meta.goal?.criteria.map((c) => [c.done, c.proved, c.evidence])).toEqual([[true, true, 'clear date'], [true, true, 'file opened'], [true, true, '1080 px']]);
    expect(reviewed()).toHaveLength(1);
    expect(JSON.stringify(reviewed()[0].messages)).toContain('2. [run] The file opens');
    expect(reviewNotices(events)).toEqual(['A reviewer checks the result against the brief (1 of 2).']);
  });

  it('returns the error if the researcher fails and sets no goal', async () => {
    const s = await start();
    plan = [call('brief'), { error: researchError }, { text: 'I can go on.' }];
    await s.send('Make a field guide.');
    const firstBriefSuffix = '\n\nThe full instructions of brief, for your next calls:\n\n## brief\n';
    expect(results(s, 'brief')).toMatchObject([{
      isError: true,
      content: expect.stringContaining(`The brief failed: Fake: ${researchError}. Go on from the request itself and write your own criteria with criteria.${firstBriefSuffix}`),
    }]);
    expect(s.meta.goal).toBeUndefined();
    expect(reviewed()).toHaveLength(0);
  });

  it('passes a reply without the form to the maker without setting a goal', async () => {
    const s = await start();
    const text = 'A field guide should open with a map.';
    plan = [call('brief'), { text }, { text: 'I can go on.' }];
    await s.send('Make a field guide.');
    const firstBriefSuffix = '\n\nThe full instructions of brief, for your next calls:\n\n## brief\n';
    const [result] = results(s, 'brief');
    expect(result.isError).not.toBe(true);
    expect(result.content.split(firstBriefSuffix)[0]).toBe(`The agent's reply did not have a brief's form, so no criteria were set. What it wrote:\n${text}\n\nUse what holds, and write your own criteria with criteria.`);
    expect(result.content).toContain(firstBriefSuffix);
    expect(s.meta.goal).toBeUndefined();
    expect(reviewed()).toHaveLength(0);
  });

  it('applies two reviews, keeps unmentioned marks and releases even with a gap', async () => {
    const s = await start();
    const events: AgentEvent[] = [];
    s.on((e) => events.push(e));
    plan = [
      call('brief'),
      { text: brief },
      { text: 'The guide is ready.' },
      { text: '1: PASS | clear date\n2: FAIL | file would not open\n3: PASS | 1080 px\nGAPS:\nFix the file.' },
      { text: 'The file opens now.' },
      { text: '1: FAIL | unclear date\n2: PASS | opened\nGAPS:\nPut the date first.' },
      { text: 'The date still needs work.' },
    ];
    await s.send('Make a field guide.');
    expect(reviewed()).toHaveLength(2);
    expect(reviewNotices(events)).toEqual(['A reviewer checks the result against the brief (1 of 2).', 'A reviewer checks the result against the brief (2 of 2).']);
    const sent = requests.map((r) => JSON.stringify(r.messages));
    expect(sent[4]).toContain('The file opens | file would not open');
    expect(sent[4]).toContain('Close them, then finish: the review runs again.');
    expect(sent[6]).toContain('That was the last review. Close what you can, then report and say plainly what is still not met.');
    expect(s.meta.goal?.by).toBe('model');
    expect(s.meta.goal?.criteria.map((c) => [c.done, c.evidence])).toEqual([[false, 'unclear date'], [true, 'opened'], [true, '1080 px']]);
  });

  it('locks the criteria until the user changes the request', async () => {
    const s = await start();
    plan = [call('brief'), { text: brief }, call('criteria', { objective: 'A different guide', criteria: ['The guide has a map'] }), call('criteria', { clear: true }), { text: 'Still working on the guide.' }, { error: researchError }];
    await s.send('Make a field guide.');
    const [replace, clear] = results(s, 'criteria');
    expect(replace.isError).toBe(true);
    expect(replace.content).toContain('The criteria come from the brief and stay as they are until the result has been reviewed: work to them.');
    expect(clear).toMatchObject({ isError: true, content: 'The brief sets these criteria; they stay until the result has been reviewed.' });
    expect(s.meta.goal?.by).toBe('brief');

    plan = [call('criteria', { objective: 'A different guide', criteria: ['The guide has a map'] }), { text: 'The map is ready.' }];
    await s.send('Change the guide to include a map.');
    expect(results(s, 'criteria').at(-1)?.isError).not.toBe(true);
    expect(s.meta.goal).toMatchObject({ by: 'model', objective: 'A different guide', criteria: [{ text: 'The guide has a map' }] });
    expect(reviewed()).toHaveLength(1);
  });

  it('replaces a brief and gives its replacement a fresh review count', async () => {
    const s = await start();
    const replacement = brief.replace('A ticket poster', 'A map');
    plan = [
      call('brief'),
      { text: brief },
      { text: 'The guide is ready.' },
      { text: '1: FAIL | no date\n2: PASS | opened\n3: PASS | 1080 px' },
      call('brief', { note: 'Use a map as the first piece.' }),
      { text: replacement },
      { text: 'The map is ready.' },
      { text: '1: FAIL | missing date\n2: PASS | opened\n3: PASS | 1080 px' },
      { text: 'The date is visible now.' },
      { text: pass },
    ];
    await s.send('Make a field guide.');
    expect(results(s, 'brief')).toHaveLength(2);
    expect(reviewed()).toHaveLength(3);
    expect(JSON.stringify(reviewed()[1].messages)).toContain('KIND: A map');
    expect(s.meta.goal).toMatchObject({ by: 'model', objective: 'A map (1)' });
  });

  it('offers the brief tool to the main agent in all profiles, including in plan mode, defers it on live sessions, and leaves it off both child surfaces', async () => {
    const s = await rt.start({ cwd: project, mode: 'plan' });
    const pc: ProfileContext = { shell: s.shell, cwd: project, timeoutMs: 1000, vision: false, role: 'main', search: 'off', screenshot: false };
    for (const profile of ['claude', 'codex', 'favilla'] as const) {
      const built = buildTools(profile, pc);
      const names = built.map((b) => b.spec.name);
      expect(names[names.indexOf('review') + 1]).toBe('brief');
      expect(built.find((b) => b.spec.name === 'brief')?.spec.description).toContain(
        'A fresh agent finds out what a request for something new needs before you make it',
      );
      for (const role of ['explore', 'general'] as const) {
        expect(buildTools(profile, { ...pc, role }).map((b) => b.spec.name)).not.toContain('brief');
      }
    }
    expect(s.toolSpecs.find((t) => t.name === 'brief')).toMatchObject({
      description: expect.stringContaining('Listed in short: load_tools gives its full instructions.'),
      parameters: { properties: { note: { type: 'string' } }, required: [] },
    });
  });

  it('opens a stored wish in build, drops its progress and unlocks its old criteria', async () => {
    const s = await start();
    const legacy = {
      ...s.meta,
      mode: 'wish',
      wish: { stage: 'make' },
      goal: { by: 'brief', objective: 'An old brief', criteria: [{ text: 'It opens', done: true, evidence: 'It opened.' }], updated: Date.now() },
    } as unknown as SessionMeta;
    rt.close(s.id);
    rt.store.saveMeta(legacy);
    rt.store.flushIndex();

    const { SessionStore } = await import('../src/store/sessions');
    const store = new SessionStore(rt.store.root);
    expect(store.metaOf(s.id)?.mode).toBe('build');
    expect(store.metaOf(s.id)).not.toHaveProperty('wish');
    expect(store.load(s.id)?.meta.mode).toBe('build');
    expect(store.load(s.id)?.meta).not.toHaveProperty('wish');

    const opened = await rt.get(s.id);
    expect(opened.meta.mode).toBe('build');
    expect(opened.meta).not.toHaveProperty('wish');
    expect(opened.meta.goal).toEqual({ ...legacy.goal, by: 'model' });
    plan = [{ text: 'Ready to go on.' }];
    await opened.send('Continue.');
    expect(reviewed()).toHaveLength(0);
  });
});
