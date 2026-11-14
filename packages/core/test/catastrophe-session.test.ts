import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Message, PermissionDecision, PermissionRequest, ToolCallPart, ToolResultPart } from '../src/types';
import type { ToolBinding, ToolOutput } from '../src/tools/types';
import type { Session as SessionType } from '../src/agent/session';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-catastrophe-'));
process.env.FAVILLA_HOME = home;
process.env.FAVILLA_FOLDER_SNAPSHOTS = '0';
const { Session } = await import('../src/agent/session');
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

// Exercise the real tool dispatch and card lifecycle, with execution replaced so no destructive command can run.
type UnderTest = Pick<SessionType, keyof SessionType> & {
  runTool(call: ToolCallPart, signal: AbortSignal, truncated: false): Promise<ToolResultPart>;
  bindings: ToolBinding[];
  sessionAllows: Set<string>;
  budget: { toolOutputChars: number };
  controller: AbortController;
};

function session(opts: { interactive?: boolean; mode?: string; guard?: Record<string, unknown>; parent?: UnderTest } = {}) {
  const cwd = path.join(home, 'project');
  const config = { guard: { mode: 'off', ...opts.guard }, languageServers: false, checkpoints: false };
  const deps = { config, catalog: { provider: () => ({ serial: true }) }, store: { dataDir: () => home, blobs: {} } };
  const s = Reflect.construct(Session, [deps, { id: 'test', cwd, mode: opts.mode ?? 'build' }, { ...opts, role: opts.parent ? 'general' : 'main' }]) as UnderTest;
  const execute = vi.fn(async (input: { command?: string }): Promise<ToolOutput> => ({ content: 'executed', display: { kind: 'terminal', command: input.command ?? '', output: '', exitCode: 0, durationMs: 0, cwd } }));
  // Private fields are inspected only here; the public permission answer API is the one the UI uses.
  Object.assign(s, { budget: { toolOutputChars: 4000 }, model: { provider: 'fake' }, controller: new AbortController() });
  const bindings: ToolBinding[] = ['shell', 'write', 'edit', 'patch'].map((name) => ({
    spec: { name, description: '', parameters: { type: 'object', properties: {} } },
    def: { kind: name as ToolBinding['def']['kind'], readOnly: false, title: () => name, execute },
    normalize: (input) => input,
  }));
  Object.assign(s, { bindings });
  let next = 0;
  const run = (command: string, workdir?: string) => s.runTool({ type: 'tool_call', id: `c${++next}`, name: 'shell', input: { command, workdir } }, s.controller.signal, false);
  const file = (name: string, input: Record<string, unknown>) => s.runTool({ type: 'tool_call', id: `c${++next}`, name, input }, s.controller.signal, false);
  const say = (text: string, extra: Partial<Message> = {}) => s.messages.push({ id: `m${++next}`, role: 'user', origin: 'user', parts: [{ type: 'text', text }], time: Date.now(), ...extra });
  const cards: PermissionRequest[] = [];
  const answer = (decision: PermissionDecision) => s.on((event) => {
    if (event.type === 'permission.request') { cards.push(event.request); s.respondPermission(event.request.id, decision); }
  });
  return { s, run, file, say, cards, answer, execute, cwd };
}

describe('catastrophe decisions in the session', () => {
  it('asks with approvals off, allow/deny lists and old session answers; an allow_session answer still covers only one action', async () => {
    const t = session({ interactive: true, guard: { allow: ['.*'], deny: ['.*'] } });
    t.s.sessionAllows.add('catastrophe');
    t.s.sessionAllows.add('delete-critical');
    t.answer('allow_session');
    await t.run('rm -rf .git');
    await t.run('rm -rf .git');
    expect(t.cards).toHaveLength(2);
    expect(t.cards.every((card) => card.once && card.reason.includes('.git'))).toBe(true);
    expect(t.execute).toHaveBeenCalledTimes(2);
    expect(t.s.pendingRequests().permissions).toEqual([]);
  });

  it('does not store one-action answers in the ordinary approval cache or ask twice', async () => {
    const t = session({ interactive: true, guard: { mode: 'ask' } });
    t.answer('allow_session');
    await t.run('rm -rf .git');
    expect(t.cards).toHaveLength(1);
    expect(t.s.sessionAllows.size).toBe(0);
  });

  it('refuses when nobody can answer', async () => {
    const t = session({ interactive: false });
    const result = await t.run('rm -rf ~');
    expect(t.execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Ask the user.*do not try another command/);
    expect(t.s.pendingRequests().permissions).toEqual([]);
  });

  it('lets an explicitly requested cleanup through without its own question, and never widens the ordinary approvals', async () => {
    const off = session({ interactive: false });
    off.say('Delete .git.');
    const before = structuredClone(off.s.messages);
    expect((await off.run('rm -rf .git')).isError).not.toBe(true);
    expect(off.execute).toHaveBeenCalledOnce();
    expect(off.s.messages).toEqual(before);
    // With approvals on, the ordinary card still comes, as it did before the backstop: the user's words pass the
    // backstop, not the approvals.
    const on = session({ interactive: true, guard: { mode: 'confirm' } });
    on.say('Delete .git.');
    on.answer('allow');
    await on.run('rm -rf .git');
    expect(on.cards).toHaveLength(1);
    expect(on.cards[0].rule).not.toBe('catastrophe');
    expect(on.cards[0].once).toBeUndefined();
    expect(on.execute).toHaveBeenCalledOnce();
  });

  it('ignores tool text, synthetic notes, old requests and model-generated child briefs', async () => {
    const parent = session();
    parent.say('Delete .git.');
    parent.say('Now just inspect the repository.');
    parent.say('Delete .git.', { origin: 'tool' });
    parent.say('irrelevant', { origin: 'harness' });
    const child = session({ parent: parent.s });
    child.say('Delete .git.');
    await child.run('rm -rf .git');
    expect(child.execute).not.toHaveBeenCalled();
    expect(parent.execute).not.toHaveBeenCalled();
  });

  it('uses the root user request for children and sends their question to an available parent', async () => {
    const parent = session({ interactive: true });
    const child = session({ parent: parent.s });
    parent.answer('deny');
    await child.run('rm -rf .git');
    expect(parent.cards).toHaveLength(1);
    expect(child.execute).not.toHaveBeenCalled();
    parent.say('Remove .git.');
    await child.run('rm -rf .git');
    expect(child.execute).toHaveBeenCalledOnce();
    expect(parent.cards).toHaveLength(1);
  });

  it('withdraws a child question when the child stops', async () => {
    const parent = session({ interactive: true });
    const child = session({ parent: parent.s });
    const running = child.run('rm -rf .git');
    expect(parent.s.pendingRequests().permissions).toHaveLength(1);
    child.s.controller.abort();
    expect((await running).isError).toBe(true);
    expect(parent.s.pendingRequests().permissions).toEqual([]);
    expect(child.execute).not.toHaveBeenCalled();
  });

  it('requires a separate decision for an extra target and respects shell workdir', async () => {
    const t = session({ interactive: true });
    t.say('Remove .git.');
    t.answer('deny');
    await t.run('rm -rf .git ~');
    expect(t.cards).toHaveLength(1);
    expect(t.cards[0].reason).not.toContain('.git');
    await t.run('rm -rf ..', 'src');
    expect(t.cards).toHaveLength(2);
    expect(t.execute).not.toHaveBeenCalled();
  });

  it('checks writes, edits and patch destinations before execution', async () => {
    const t = session();
    await t.file('write', { path: '.git/HEAD', content: '' });
    await t.file('edit', { path: '.git/HEAD', old: 'x', new: '' });
    await t.file('patch', { patch: '*** Begin Patch\n*** Delete File: .git\n*** End Patch' });
    expect(t.execute).not.toHaveBeenCalled();
  });

  it('leaves ordinary cleanup alone and permits a database successfully made by this task only once', async () => {
    const t = session();
    for (const command of ['rm -rf node_modules dist build', 'git clean -fdX', 'rm src/old.ts', 'rm -rf /tmp/cache']) expect((await t.run(command)).isError).not.toBe(true);
    await t.run('createdb -h local scratch');
    expect((await t.run('dropdb -h remote scratch')).isError).toBe(true);
    expect((await t.run('dropdb -h local scratch')).isError).not.toBe(true);
    expect((await t.run('dropdb -h local scratch')).isError).toBe(true);
    expect(t.execute).toHaveBeenCalledTimes(6);
  });

  it('a failed creation does not make a pre-existing database disposable', async () => {
    const t = session();
    t.execute.mockResolvedValueOnce({ content: 'already exists', isError: true });
    await t.run('createdb scratch');
    expect((await t.run('dropdb scratch')).isError).toBe(true);
    expect(t.execute).toHaveBeenCalledOnce();
  });
});
