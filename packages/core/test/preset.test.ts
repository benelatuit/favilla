import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message } from '../src/types';

// SillyTavern presets, made up here: what comes in from the file, the layers and roles each prompt goes to, and that
// the libraries of two folders and the global one never touch.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-preset-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
const other = path.join(home, 'other');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(other, { recursive: true });

const { activePreset, copyPreset, deletePreset, importPreset, listPresets, macroContext, moveToLibrary, parseTavernPreset, placePreset, presetSystem, presetsView, readPreset, renderMacros, setGlobalChoice, setWorkspaceChoice, updatePreset, workspaceChoice } = await import('../src/prompt/preset');
const { toAnthropicMessages } = await import('../src/providers/anthropic');
const { toChatMessages } = await import('../src/providers/openai-chat');
const { toGeminiContents } = await import('../src/providers/gemini');
const { toResponsesInput } = await import('../src/providers/openai-responses');
const { createRuntime } = await import('../src/runtime');

type Prompt = Record<string, unknown>;
const prompt = (identifier: string, role: string, content: string, more: Prompt = {}): Prompt => ({ identifier, name: identifier, role, content, system_prompt: false, marker: false, ...more });
const marker = (identifier: string): Prompt => ({ identifier, name: identifier, marker: true, system_prompt: true });
const file = (prompts: Prompt[], order: { identifier: string; enabled: boolean }[], more: Record<string, unknown> = {}) => ({
  temperature: 1.31,
  top_p: 0.77,
  openai_model: 'secret-model-name',
  reverse_proxy: 'https://proxy.invalid/v1',
  proxy_password: 'hunter2-proxy-password',
  prompts,
  prompt_order: [
    { character_id: 100000, order: [{ identifier: 'wrong', enabled: true }] },
    { character_id: 100001, order },
  ],
  ...more,
});
const on = (...ids: string[]) => ids.map((identifier) => ({ identifier, enabled: true }));

const user = (text: string, origin: Message['origin'] = 'user'): Message => ({ id: text, role: 'user', origin, parts: [{ type: 'text', text }], time: 1 });
const reply = (text: string): Message => ({ id: text, role: 'assistant', parts: [{ type: 'text', text }], time: 1 });
const toolCall = (id: string): Message => ({ id, role: 'assistant', parts: [{ type: 'tool_call', id, name: 'read', input: {} }], time: 1 });
const toolResult = (id: string): Message => ({ id: `r${id}`, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: id, name: 'read', content: 'x' }], time: 1 });
const said = (m: Message) => m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_call' ? `call:${p.id}` : p.type === 'tool_result' ? `result:${p.callId}` : '')).join('');
const shape = (list: Message[]) => list.map((m) => `${m.asSystem ? 'system' : m.role}:${said(m)}`);
const ctx = (over: Partial<ReturnType<typeof macroContext>> = {}) => ({ user: 'Mei', char: 'Rook', seed: 's1', now: Date.UTC(2026, 9, 30, 8), vars: new Map(), ...over });

describe('reading a SillyTavern preset', () => {
  it('takes the prompts, their layer and role, and the prefill, and nothing else', () => {
    const raw = file(
      [
        prompt('main', 'system', 'Be {{char}}.', { system_prompt: true }),
        prompt('off', 'system', 'Not this one.'),
        marker('charDescription'),
        marker('chatHistory'),
        prompt('late', 'user', 'After the chat.'),
        prompt('deep', 'assistant', 'In the chat.', { injection_position: 1, injection_depth: 3, injection_order: 50 }),
        prompt('google', 'model', 'A Gemini-style role.'),
        prompt('empty', 'system', '   '),
      ],
      [...on('main'), { identifier: 'off', enabled: false }, ...on('charDescription', 'chatHistory', 'late', 'deep', 'google', 'empty')],
      { assistant_prefill: 'Sure:' },
    );
    const { preset, report } = parseTavernPreset(raw, 'Mine');
    expect(preset.entries.map((e) => [e.id, e.role, e.place, e.enabled])).toEqual([
      ['main', 'system', 'before', true],
      ['off', 'system', 'before', false],
      ['late', 'user', 'after', true],
      ['deep', 'assistant', 'depth', true],
      ['google', 'assistant', 'after', true],
    ]);
    expect(preset.entries[3]).toMatchObject({ depth: 3, order: 50 });
    expect(preset.prefill).toBe('Sure:');
    expect(report).toMatchObject({ entries: 5, off: 1, markers: ['charDescription'] });

    // The file as kept and the report hold none of the rest, whatever it was.
    const kept = JSON.stringify({ preset, report });
    for (const leak of ['1.31', '0.77', 'secret-model-name', 'proxy.invalid', 'hunter2', 'temperature', 'top_p', 'reverse_proxy']) expect(kept).not.toContain(leak);
  });

  it('falls back on the last order, or the prompts as listed, and names what it cannot use', () => {
    const last = parseTavernPreset({ prompts: [prompt('a', 'user', 'A'), prompt('b', 'user', 'B')], prompt_order: [{ character_id: 7, order: on('b', 'a') }] }, 'x');
    expect(last.preset.entries.map((e) => e.id)).toEqual(['b', 'a']);
    const none = parseTavernPreset({ prompts: [prompt('a', 'user', 'A'), prompt('b', 'user', 'B')] }, 'x');
    expect(none.preset.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(() => parseTavernPreset({ temp: 1, story_string: 'x' }, 'x')).toThrow(/no prompts list/);
    expect(() => importPreset('global', project, 'not json', 'x')).toThrow(/not JSON/);
    const { report } = parseTavernPreset(file([prompt('a', 'user', '{{user}} {{description}} {{mystery}}')], on('a')), 'x');
    expect(report.macros).toEqual(['mystery']);
    expect(report.blank).toEqual(['description']);
  });
});

describe('macros', () => {
  it('fills in what it knows and leaves the rest as written', () => {
    expect(renderMacros('{{user}} and {{char}}{{// not sent}}{{noop}}', ctx())).toBe('Mei and Rook');
    expect(renderMacros('a  {{trim}}  b{{newline}}c', ctx())).toBe('ab\nc');
    expect(renderMacros('[{{description}}] {{mystery}} {{mystery::1}}', ctx())).toBe('[] {{mystery}} {{mystery::1}}');
    expect(renderMacros('{{isodate}} {{isotime}}', ctx())).toBe('2026-10-30 08:00');
    expect(renderMacros('{{lastUserMessage}}|{{lastCharMessage}}|{{model}}', ctx({ lastUser: 'hi', lastChar: 'yo', model: 'm' }))).toBe('hi|yo|m');
  });

  it('draws the same thing for a session, so the cache holds, and carries variables through a request', () => {
    const list = '{{random::a::b::c::d::e::f::g::h}}';
    expect(renderMacros(list, ctx())).toBe(renderMacros(list, ctx()));
    const seeds = new Set(['1', '2', '3', '4', '5', '6', '7', '8'].map((seed) => renderMacros(list, ctx({ seed }))));
    expect(seeds.size).toBeGreaterThan(1);
    expect(Number(renderMacros('{{roll:2d6}}', ctx()))).toBeGreaterThanOrEqual(2);
    const c = ctx();
    expect(renderMacros('{{setvar::mood::calm::still}}', c)).toBe('');
    expect(renderMacros('{{getvar::mood}}', c)).toBe('calm::still');
  });
});

describe('placing a preset in a request', () => {
  const preset = (prompts: Prompt[], order = prompts.map((p) => p.identifier as string), more = {}) => parseTavernPreset(file(prompts, on(...order), more), 'x').preset;
  const place = (p: ReturnType<typeof preset>, messages: Message[], continues = false) => placePreset(messages, p, ctx(), { continues });

  it('keeps each prompt in its layer and role', () => {
    const p = preset([prompt('main', 'system', 'Opening.'), prompt('ack', 'assistant', 'Understood.'), prompt('more', 'system', 'Second system.'), prompt('ask', 'user', 'Lead-in.'), marker('chatHistory'), prompt('end', 'user', 'Closing.')]);
    expect(presetSystem(p, ctx())).toBe('Opening.');
    expect(shape(place(p, [user('Hello')]).messages)).toEqual(['user:Start.', 'assistant:Understood.', 'system:Second system.', 'user:Lead-in.', 'user:Hello', 'user:Closing.']);
  });

  it('sets in-chat prompts as SillyTavern does: depth back from the end, the highest order and system nearest it', () => {
    const p = preset([
      prompt('a', 'assistant', 'd1 o100 assistant', { injection_position: 1, injection_depth: 1 }),
      prompt('b', 'system', 'd1 o100 system', { injection_position: 1, injection_depth: 1 }),
      prompt('c', 'user', 'd1 o100 user', { injection_position: 1, injection_depth: 1 }),
      prompt('d', 'user', 'd1 o200 user', { injection_position: 1, injection_depth: 1, injection_order: 200 }),
      prompt('e', 'system', 'd1 o50 one', { injection_position: 1, injection_depth: 1, injection_order: 50 }),
      prompt('f', 'system', 'd1 o50 two', { injection_position: 1, injection_depth: 1, injection_order: 50 }),
      prompt('g', 'system', 'd0', { injection_position: 1, injection_depth: 0 }),
      prompt('h', 'system', 'd9', { injection_position: 1, injection_depth: 9 }),
    ]);
    const out = place(p, [user('one'), reply('two'), user('three')]);
    expect(shape(out.messages)).toEqual([
      'system:d9',
      'user:one',
      'assistant:two',
      'system:d1 o50 one\nd1 o50 two',
      'assistant:d1 o100 assistant',
      'user:d1 o100 user',
      'system:d1 o100 system',
      'user:d1 o200 user',
      'user:three',
      'system:d0',
    ]);
  });

  it('counts the chat and not tool rounds, and leaves everything in place through a turn', () => {
    const p = preset([
      prompt('note', 'system', 'NOTE', { injection_position: 1, injection_depth: 2 }),
      prompt('near', 'user', 'NEAR', { injection_position: 1, injection_depth: 0 }),
      marker('chatHistory'),
      prompt('end', 'user', 'END'),
    ], ['note', 'near', 'chatHistory', 'end'], { assistant_prefill: 'Well,' });
    const early = [user('first'), reply('done'), user('second')];
    const later = [...early, toolCall('c1'), toolResult('c1'), toolCall('c2'), toolResult('c2')];
    const a = place(p, early).messages;
    const b = place(p, later).messages;
    expect(shape(a)).toEqual(['user:first', 'system:NOTE', 'assistant:done', 'user:second', 'user:NEAR', 'user:END', expect.stringContaining('Well,')]);
    // The request only grows at its end: the provider's cache and the socket's chain go on from what was sent.
    expect(shape(b).slice(0, a.length)).toEqual(shape(a));
    expect(shape(b).slice(a.length)).toEqual(['assistant:call:c1', 'user:result:c1', 'assistant:call:c2', 'user:result:c2']);
    // Nothing falls between a call and its result, at any depth.
    const stack = placePreset(later, parseTavernPreset(file([0, 1, 2, 3, 4, 5].map((d) => prompt(`d${d}`, 'user', `D${d}`, { injection_position: 1, injection_depth: d })), on('d0', 'd1', 'd2', 'd3', 'd4', 'd5')), 'x').preset, ctx(), { continues: false }).messages;
    for (const i of stack.keys()) if (stack[i].parts[0].type === 'tool_call') expect(stack[i + 1].parts[0].type).toBe('tool_result');
  });

  it('continues from a prefill only where the model truly does, and only at the start of a reply', () => {
    const p = preset([prompt('main', 'system', 'x')], ['main'], { assistant_prefill: 'Certainly, {{user}}: ' });
    const first = place(p, [user('Hello')], true);
    expect(first.continued).toBe('Certainly, Mei:');
    expect(shape(first.messages)).toEqual(['user:Hello', 'assistant:Certainly, Mei:']);
    const going = place(p, [user('Hello'), toolCall('c1'), toolResult('c1')], true);
    expect(going.continued).toBeUndefined();
    expect(shape(going.messages)).toEqual(['user:Hello', 'assistant:call:c1', 'user:result:c1']);

    const asked = place(p, [user('Hello')], false);
    expect(asked.continued).toBeUndefined();
    expect(asked.messages.at(-1)!.role).toBe('user');
    expect(said(asked.messages.at(-1)!)).toContain('Certainly, Mei:');
  });

  it('takes an assistant prompt at the very end as a prefill', () => {
    const p = preset([marker('chatHistory'), prompt('tail', 'assistant', 'And so,')], ['chatHistory', 'tail']);
    expect(place(p, [user('Hello')], true).continued).toBe('And so,');
    expect(said(place(p, [user('Hello')], false).messages.at(-1)!)).toContain('And so,');
  });

  it('sends a system message inside the chat where the provider has them, and a user message where it has not', () => {
    const p = preset([prompt('deep', 'system', 'Inside.', { injection_position: 1, injection_depth: 0 })]);
    const messages = place(p, [user('Hello')]).messages;
    const model = { quirks: {}, vision: true } as never;
    const call = { model, messages, system: 'sys', turnStart: 0 } as never;
    expect(toChatMessages(call)).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'Hello' }, { role: 'system', content: 'Inside.' }]);
    expect(toResponsesInput(messages, 'p')).toEqual([expect.objectContaining({ role: 'user' }), expect.objectContaining({ role: 'developer' })]);
    expect(toAnthropicMessages(messages, 'p')).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'Inside.' }] }]);
    expect((toGeminiContents(messages, 'm') as { role: string }[]).map((c) => c.role)).toEqual(['user']);
    expect(shape(placePreset([user('Hello')], p, ctx(), { continues: false, flatSystem: true }).messages)).toEqual(['user:Hello', 'user:Inside.']);
  });

  it('keeps a reply\'s thinking at the front when an assistant prompt lands ahead of it', () => {
    const thinking: Message = { id: 'a', role: 'assistant', parts: [{ type: 'reasoning', text: 't', provider: 'p', model: 'm', signature: 'sig' }, { type: 'text', text: 'Reply.' }], time: 1 };
    const injected: Message = { id: 'preset-0', role: 'assistant', origin: 'harness', parts: [{ type: 'text', text: 'Prompt.', synthetic: true }], time: 0 };
    const out = toAnthropicMessages([user('Hi'), injected, thinking, user('Next')], 'p') as { content: { type: string; signature?: string }[] }[];
    expect(out[1].content.map((c) => c.type)).toEqual(['thinking', 'text', 'text']);
    expect(out[1].content[0].signature).toBe('sig');
  });
});

describe('the libraries', () => {
  const sample = (text: string) => JSON.stringify(file([prompt('main', 'system', text)], on('main')));

  it('keeps every folder and the global library apart, and writes nothing into a project', () => {
    importPreset('workspace', project, sample('Project preset.'), 'Here.json');
    importPreset('workspace', other, sample('Other preset.'), 'There');
    importPreset('global', project, sample('Global preset.'), 'Shared');
    expect(listPresets('workspace', project).map((p) => p.name)).toEqual(['Here']);
    expect(listPresets('workspace', other).map((p) => p.name)).toEqual(['There']);
    expect(listPresets('global', other).map((p) => p.name)).toEqual(['Shared']);
    expect(fs.readdirSync(project)).toEqual([]);

    // Nothing chosen: nothing active anywhere.
    expect(activePreset(project)).toBeNull();
    // A folder's choice reaches that folder only.
    setWorkspaceChoice(project, { use: 'own', name: 'Here' });
    expect(activePreset(project)).toMatchObject({ scope: 'workspace', preset: { name: 'Here' } });
    expect(activePreset(other)).toBeNull();
    // The global choice reaches the folders that follow it, not one with its own, nor one that said none.
    setGlobalChoice('Shared');
    expect(activePreset(other)).toMatchObject({ scope: 'global', preset: { name: 'Shared' } });
    expect(activePreset(project)!.preset.name).toBe('Here');
    setWorkspaceChoice(other, { use: 'none' });
    expect(activePreset(other)).toBeNull();
    setWorkspaceChoice(other, { use: 'global' });
    // A folder cannot name another folder's preset: its own library is the only one it reads.
    setWorkspaceChoice(other, { use: 'own', name: 'Here' });
    expect(activePreset(other)).toBeNull();
    setWorkspaceChoice(other, { use: 'global' });
    setGlobalChoice(null);
  });

  it('lists presets in each library beside files that are not entries', () => {
    const cwd = path.join(home, 'list');
    importPreset('global', cwd, sample('Global words.'), 'Named global');
    importPreset('workspace', cwd, sample('Folder words.'), 'Named workspace');
    const view = presetsView(cwd);
    const values = [null, [], 12, 'Name', {}, { name: 12 }];
    const files = [view.global.dir, view.workspace.dir].flatMap((dir) => values.map((_, i) => path.join(dir, `invalid-${i}.json`)));
    try {
      files.forEach((file, i) => fs.writeFileSync(file, JSON.stringify(values[i % values.length])));
      expect(presetsView(cwd)).toEqual(view);
      for (const file of files) {
        const scope = path.dirname(file) === view.global.dir ? 'global' : 'workspace';
        expect(readPreset(scope, cwd, path.basename(file, '.json'))).toBeNull();
      }
    } finally {
      for (const file of files) fs.rmSync(file, { force: true });
      deletePreset('global', cwd, 'Named global');
      deletePreset('workspace', cwd, 'Named workspace');
    }
  });

  it('copies between libraries as a separate preset, and an edit stays where it was made', () => {
    copyPreset('workspace', project, 'Here');
    updatePreset('global', project, 'Here', { user: 'Global name', prefill: 'Ok:', entries: [{ id: 'main', enabled: false }] });
    expect(readPreset('workspace', project, 'Here')).toMatchObject({ entries: [{ enabled: true }] });
    expect(readPreset('workspace', project, 'Here')!.user).toBeUndefined();
    expect(readPreset('global', project, 'Here')).toMatchObject({ user: 'Global name', prefill: 'Ok:', entries: [{ enabled: false }] });
    // Importing again takes the file's prompts and keeps the names set here.
    importPreset('global', project, sample('New words.'), 'Here');
    expect(readPreset('global', project, 'Here')).toMatchObject({ user: 'Global name', entries: [{ content: 'New words.', enabled: true }] });
    // Only the named fields of a change go through.
    updatePreset('global', project, 'Here', { temperature: 2, name: 'Renamed' } as never);
    expect(JSON.stringify(readPreset('global', project, 'Here'))).not.toContain('temperature');
    expect(readPreset('global', project, 'Here')!.name).toBe('Here');
    deletePreset('global', project, 'Here');
    expect(readPreset('workspace', project, 'Here')).toBeTruthy();
  });

  it('handles names that make poor file names, and goes back to following when a chosen preset is deleted', () => {
    importPreset('workspace', project, sample('x'), 'a/b: *c* 预设');
    expect(readPreset('workspace', project, 'a/b: *c* 预设')!.name).toBe('a/b: *c* 预设');
    setWorkspaceChoice(project, { use: 'own', name: 'a/b: *c* 预设' });
    deletePreset('workspace', project, 'a/b: *c* 预设');
    expect(workspaceChoice(project)).toEqual({ use: 'global' });
    setWorkspaceChoice(project, { use: 'own', name: 'Here' });
    const v = presetsView(project);
    expect(v.workspace.items[0].entries[0].layer).toBe('system');
    expect(v.active).toEqual({ name: 'Here', scope: 'workspace' });
  });

  it('lets every folder pick a library preset by name, with no copy kept in the folder', () => {
    const lib = path.join(home, 'lib-a');
    const lib2 = path.join(home, 'lib-b');
    importPreset('global', lib, sample('Shared words.'), 'Picked');
    setWorkspaceChoice(lib, { use: 'library', name: 'Picked' });
    setWorkspaceChoice(lib2, { use: 'library', name: 'Picked' });
    expect(activePreset(lib)).toMatchObject({ scope: 'global', preset: { name: 'Picked' } });
    expect(activePreset(lib2)).toMatchObject({ scope: 'global', preset: { name: 'Picked' } });
    expect(listPresets('workspace', lib)).toEqual([]);
    // One edit in the library reaches every folder that picked it.
    updatePreset('global', lib, 'Picked', { user: 'Mira' });
    expect(activePreset(lib2)!.preset.user).toBe('Mira');
    // Deleted from the library, the folders follow the default again.
    setGlobalChoice('Shared');
    deletePreset('global', lib, 'Picked');
    expect(activePreset(lib)).toMatchObject({ scope: 'global', preset: { name: 'Shared' } });
    setGlobalChoice(null);
  });

  it('moves a folder copy into the library: dropped when the library has it word for word, kept apart when it differs', () => {
    const a = path.join(home, 'move-a');
    const b = path.join(home, 'move-b');
    importPreset('global', a, sample('Same words.'), 'Twin');
    importPreset('workspace', a, sample('Same words.'), 'Twin');
    setWorkspaceChoice(a, { use: 'own', name: 'Twin' });
    expect(moveToLibrary(a, 'Twin')).toBe('Twin');
    expect(listPresets('workspace', a)).toEqual([]);
    expect(workspaceChoice(a)).toEqual({ use: 'library', name: 'Twin' });
    expect(listPresets('global', a).filter((p) => p.name.startsWith('Twin'))).toHaveLength(1);
    // A different preset under a name the library has: both kept, the copy under the folder's name.
    importPreset('workspace', b, sample('Other words.'), 'Twin');
    setWorkspaceChoice(b, { use: 'own', name: 'Twin' });
    const moved = moveToLibrary(b, 'Twin');
    expect(moved).toBe('Twin (move-b)');
    expect(readPreset('global', b, 'Twin')!.entries[0].content).toBe('Same words.');
    expect(readPreset('global', b, moved)!.entries[0].content).toBe('Other words.');
    expect(activePreset(b)).toMatchObject({ scope: 'global', preset: { name: moved } });
  });

  it.each([false, true])('keeps the matching global file and its import time (name collision: %s)', (collision) => {
    const cwd = path.join(home, collision ? 'collision' : 'direct');
    const name = collision ? 'Existing alias' : 'Different key order';
    const target = collision ? `${name} (collision)` : name;
    const words = sample('Identical words.');
    const source = importPreset('workspace', cwd, words, name).preset;
    if (collision) importPreset('global', cwd, sample('Different words.'), name);
    importPreset('global', cwd, words, target);
    const file = path.join(presetsView(cwd).global.dir, encodeURIComponent(target) + '.json');
    const original = collision
      ? { ...source, name: target, imported: 100 }
      : { imported: 100, entries: source.entries.map((e) => Object.fromEntries(Object.entries(e).reverse())), format: source.format, name: target };
    fs.writeFileSync(file, JSON.stringify(original));
    fs.utimesSync(file, 100, 100);
    const stamp = fs.statSync(file).mtimeMs;
    setWorkspaceChoice(cwd, { use: 'own', name });

    expect(moveToLibrary(cwd, name)).toBe(target);
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(original));
    expect(fs.statSync(file).mtimeMs).toBe(stamp);
    expect(readPreset('global', cwd, target)?.imported).toBe(100);
    expect(readPreset('workspace', cwd, name)).toBeNull();
    expect(workspaceChoice(cwd)).toEqual({ use: 'library', name: target });
  });
});

describe('a session with a preset', () => {
  const asks: { messages: { role: string; content: unknown; tool_calls?: unknown }[] }[] = [];
  /** Text the next reply says; `refuse` answers the next request with this error. */
  const script = { replies: [] as (string | { call: string })[], refuse: [] as string[] };
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      }
      const refusal = script.refuse.shift();
      if (refusal) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ error: { message: refusal } }));
      }
      asks.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const next = script.replies.shift() ?? 'Done.';
      if (typeof next === 'string') {
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: next } }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      } else {
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.call, type: 'function', function: { name: 'read', arguments: JSON.stringify({ paths: ['a.ts'] }) } }] } }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      }
      chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } });
      res.end('data: [DONE]\n\n');
    });
  });

  let rt: ReturnType<typeof createRuntime>;
  const folder = path.join(home, 'session');
  const preset = JSON.stringify(
    file(
      [
        prompt('main', 'system', 'PRESET-SYSTEM for {{user}}.'),
        prompt('lead', 'user', 'PRESET-LEAD'),
        marker('chatHistory'),
        prompt('deep', 'system', 'PRESET-DEPTH', { injection_position: 1, injection_depth: 0 }),
      ],
      on('main', 'lead', 'chatHistory', 'deep'),
      { assistant_prefill: 'PRESET-FILL' },
    ),
  );

  beforeAll(async () => {
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const port = (fake.address() as AddressInfo).port;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(
      path.join(process.env.FAVILLA_HOME!, 'config.json'),
      JSON.stringify({
        model: 'fake/m1',
        tools: 'favilla',
        languageServers: false,
        providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 100_000, family: 'gpt', quirks: { prefill: true } } } } },
      }),
    );
    rt = createRuntime(folder, { interactive: false });
    importPreset('workspace', folder, preset, 'Mine');
    setWorkspaceChoice(folder, { use: 'own', name: 'Mine' });
  });

  afterAll(async () => {
    rt.dispose();
    fake.close();
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const text = (m: { content: unknown }) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

  it('sends each prompt in its place and keeps none of them in the history', async () => {
    const s = await rt.start({ cwd: folder });
    expect(s.meta.preset).toEqual({ name: 'Mine', scope: 'workspace' });
    asks.length = 0;
    script.replies = [{ call: 'c1' }, 'Finished.'];
    const streamed: string[] = [];
    s.on((e) => e.type === 'stream.text' && streamed.push(e.delta));
    await s.send('Hello there');

    expect(asks).toHaveLength(2);
    const [first, second] = asks;
    expect(first.messages[0].role).toBe('system');
    expect(text(first.messages[0])).toContain('PRESET-SYSTEM for User.');
    expect(first.messages.slice(1).map((m) => [m.role, text(m)])).toEqual([
      ['user', 'PRESET-LEAD'],
      ['user', expect.stringContaining('Hello there')],
      ['system', 'PRESET-DEPTH'],
      ['assistant', 'PRESET-FILL'],
    ]);
    // The second step goes on from the first, without the prefill, with its reply in its place.
    expect(second.messages.slice(0, 4).map(text)).toEqual(first.messages.slice(0, 4).map(text));
    expect(second.messages.slice(4).map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(text(second.messages[4])).toContain('PRESET-FILL');
    expect(streamed.join('')).toBe('Finished.');

    const saved = JSON.stringify(s.messages.filter((m) => m.role === 'user'));
    expect(saved).not.toContain('PRESET-LEAD');
    expect(saved).not.toContain('PRESET-DEPTH');
    expect(s.messages.some((m) => m.parts.some((p) => p.type === 'text' && p.text === 'PRESET-LEAD'))).toBe(false);
    expect(s.messages.find((m) => m.role === 'assistant')!.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'PRESET-FILL' });
  });

  it('starts the stored reply with the prefill when the model goes on from it', async () => {
    const s = await rt.start({ cwd: folder });
    script.replies = [' and the rest.'];
    const streamed: string[] = [];
    s.on((e) => e.type === 'stream.text' && streamed.push(e.delta));
    await s.send('Go');
    expect(streamed.join('')).toBe('PRESET-FILL and the rest.');
    expect(s.messages.at(-1)!.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'PRESET-FILL and the rest.' });
  });

  it('asks in words once a model refuses a prefill, and stays that way', async () => {
    const s = await rt.start({ cwd: folder });
    asks.length = 0;
    script.refuse = ['This model does not support assistant message prefill. The conversation must end with a user message.'];
    script.replies = ['PRESET-FILL by hand.', 'Second.'];
    await s.send('Go');
    expect(asks).toHaveLength(1);
    expect(asks[0].messages.at(-1)!.role).toBe('user');
    expect(text(asks[0].messages.at(-1)!)).toContain('PRESET-FILL');
    expect(s.messages.at(-1)!.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'PRESET-FILL by hand.' });
    await s.send('Again');
    expect(asks[1].messages.at(-1)!.role).toBe('user');
  });

  it('sends system prompts as user messages once a server refuses them inside the chat', async () => {
    const s = await rt.start({ cwd: folder });
    asks.length = 0;
    script.refuse = ['System message must be at the beginning.'];
    await s.send('Go');
    expect(asks).toHaveLength(1);
    expect(asks[0].messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(asks[0].messages.some((m) => m.role === 'user' && text(m) === 'PRESET-DEPTH')).toBe(true);
  });

  it('keeps its own copy: a later change of the library reaches neither an open session, a resumed one nor a branch', async () => {
    const s = await rt.start({ cwd: folder });
    await s.send('Go');
    const id = s.id;
    updatePreset('workspace', folder, 'Mine', { entries: [{ id: 'lead', enabled: false }] });
    setWorkspaceChoice(folder, { use: 'none' });

    asks.length = 0;
    await s.send('Again');
    expect(asks[0].messages.some((m) => text(m) === 'PRESET-LEAD')).toBe(true);

    rt.close(id);
    const back = await rt.get(id);
    expect(back.meta.preset).toEqual({ name: 'Mine', scope: 'workspace' });
    asks.length = 0;
    await back.send('Resumed');
    expect(asks[0].messages.some((m) => text(m) === 'PRESET-LEAD')).toBe(true);
    expect(text(asks[0].messages[0])).toContain('PRESET-SYSTEM');

    const first = back.messages.find((m) => m.role === 'user' && m.origin === 'user')!;
    const { session: branch } = await rt.branch(back, first.id, 'after');
    asks.length = 0;
    await branch.send('On the branch');
    expect(asks[0].messages.some((m) => text(m) === 'PRESET-LEAD')).toBe(true);

    // A new session takes the folder's choice as it is now, and reloading rules brings an open one up to it.
    const fresh = await rt.start({ cwd: folder });
    expect(fresh.meta.preset).toBeUndefined();
    await s.reloadRules();
    expect(s.meta.preset).toBeUndefined();
    asks.length = 0;
    await s.send('Plain now');
    // Its earlier replies stay as they were said; the prompts are gone.
    for (const word of ['PRESET-SYSTEM', 'PRESET-LEAD', 'PRESET-DEPTH']) expect(JSON.stringify(asks[0].messages)).not.toContain(word);
    setWorkspaceChoice(folder, { use: 'own', name: 'Mine' });
    updatePreset('workspace', folder, 'Mine', { entries: [{ id: 'lead', enabled: true }] });
  });

  it('runs through the server: a library per scope, and nothing but the named fields', async () => {
    const { startServer } = await import('../src/server/server');
    const server = await startServer({ runtime: rt, token: 't', port: 0 });
    const call = async (action: string, body: Record<string, unknown>) => {
      const res = await fetch(`${server.url}api/presets/${action}`.replace(/([^:])\/\/api/, '$1/api'), { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: folder, ...body }) });
      return { status: res.status, json: (await res.json()) as ReturnType<typeof presetsView> & { report?: { entries: number } } };
    };
    try {
      const imported = await call('import', { scope: 'global', name: 'FromServer.json', text: preset });
      expect(imported.status).toBe(200);
      expect(imported.json.report!.entries).toBe(3);
      expect(imported.json.global.items.map((p) => p.name)).toContain('FromServer');
      expect(imported.json.workspace.items.map((p) => p.name)).toEqual(['Mine']);
      expect(JSON.stringify(imported.json)).not.toContain('hunter2');
      expect((await call('use', { scope: 'global', name: 'FromServer' })).json.global.use).toBe('FromServer');
      // The folder has its own, so the global choice does not reach it until it follows.
      expect((await call('use', { scope: 'workspace', use: 'global' })).json.active).toEqual({ name: 'FromServer', scope: 'global' });
      expect((await call('use', { scope: 'workspace', use: 'own', name: 'Mine' })).json.active).toEqual({ name: 'Mine', scope: 'workspace' });
      const updated = await call('update', { scope: 'global', name: 'FromServer', patch: { user: 'Mei', temperature: 2 } });
      expect(updated.json.global.items.find((p) => p.name === 'FromServer')).toMatchObject({ user: 'Mei' });
      expect(JSON.stringify(updated.json)).not.toContain('temperature');
      expect((await call('copy', { scope: 'global', name: 'FromServer' })).json.workspace.items.map((p) => p.name)).toEqual(['FromServer', 'Mine']);
      expect((await call('delete', { scope: 'workspace', name: 'FromServer' })).json.global.items.map((p) => p.name)).toContain('FromServer');
      const gone = await call('delete', { scope: 'global', name: 'FromServer' });
      expect(gone.json.global.use).toBeNull();
      expect((await call('import', { scope: 'global', name: 'bad', text: '{"temperature":1}' })).status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.close();
    }
  });

  it('gives a sub-agent nothing of it', async () => {
    const parent = await rt.start({ cwd: folder });
    const child = await rt.start({ cwd: folder, role: 'general', parent });
    expect(parent.meta.preset).toBeTruthy();
    expect(child.meta.preset).toBeUndefined();
    asks.length = 0;
    await child.send('Sub-task');
    expect(JSON.stringify(asks[0].messages)).not.toContain('PRESET-');
  });
});
