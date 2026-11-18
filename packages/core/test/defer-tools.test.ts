import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidenceSummary } from '../src/agent/evidence';
import { findBrowser } from '../src/tools/browser';

// Rarely used tools are listed in short until the main session loads them: on 2026-11-02 their definitions, with
// fifty skills at full length, were a third of every request's opening. Loading never changes the tool list, which a
// provider's prompt cache starts with.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-defer-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'main.go'), 'package main\n\nfunc main() {}\n');

type Reply = { text?: string; call?: { name: string; args: unknown } };
let plan: Reply[] = [];
const bodies: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    bodies.push(JSON.parse(body));
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

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', languageServers: false, providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }),
  );
});

afterAll(async () => {
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const names = (b: (typeof bodies)[number]) => (b.tools ?? []).map((t) => t.function.name);
const tool = (b: (typeof bodies)[number], name: string) => (b.tools ?? []).find((t) => t.function.name === name)?.function as { description: string; parameters: unknown } | undefined;
const text = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));
const system = (b: (typeof bodies)[number]) => b.messages.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n');
const results = (b: (typeof bodies)[number]) => b.messages.filter((m) => m.role === 'tool').map((m) => text(m.content));
const lastUser = (b: (typeof bodies)[number]) => text(b.messages.filter((m) => m.role === 'user').at(-1)?.content);
// attempts only in a git repository, which this folder is not; symbols, remember and review are listed in full;
// paint stays in short in tools[] so mid-session paint never alters tools[], while music/film/watch stay out of routine turns.
const HELD = ['paint', 'browser', 'brief'];

// The browser is one of the tools held back, and a session has it only where a browser is installed.
describe.skipIf(!findBrowser())('tools held back until needed', () => {
  it('lists the rarely used tools in short, keeps audio/video tools off routine code turns, and keeps tools[] unchanged when loading stubs', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true });
      plan = [
        { call: { name: 'load_tools', args: { names: ['brief'] } } },
        { call: { name: 'load_tools', args: { names: ['paint'] } } },
        { call: { name: 'watch', args: { path: 'missing.mp4' } } },
        { text: 'Done.' },
      ];
      const before = bodies.length;
      await s.send('Tidy up main.go.');
      const [first, second, third, fourth] = bodies.slice(before);
      expect(names(first)).toEqual(expect.arrayContaining(['load_tools', 'shell', 'check', 'symbols', 'remember', 'review', 'ask', ...HELD]));
      for (const omitted of ['attempts', 'present_plan', 'music', 'film', 'watch']) {
        expect(names(first), omitted).not.toContain(omitted);
      }
      for (const n of ['symbols', 'remember', 'review']) expect(tool(first, n)!.description, n).not.toMatch(/load_tools/);
      // In short: a whole line on what it is for, a pointer to load_tools, and parameters without their descriptions.
      const brief = tool(first, 'brief')!;
      expect(brief.description).toBe('Researches examples, picks a direction and sets quality criteria before making a new page, film, deck or game from a short prompt. Listed in short: load_tools gives its full instructions.');
      expect(brief.description.length).toBeLessThan(260);
      expect(JSON.stringify(brief.parameters)).not.toContain('"description"');
      // Not recall: after a compaction it is how details come back, so it is listed in full.
      expect(tool(first, 'recall')!.description).not.toMatch(/load_tools/);
      expect(tool(first, 'criteria')!.description).toMatch(/load_tools/);
      expect(system(first)).toMatch(/Some tools in your list are in short: .* In short now: [^.]*browser, paint, criteria, brief/);
      // Loading brief or paint never changes tools[] byte-for-byte (preserving the provider prompt cache).
      const initialTools = JSON.stringify(first.tools);
      expect(JSON.stringify(second.tools)).toBe(initialTools);
      expect(results(second).at(-1)).toMatch(/## brief\n[\s\S]*Parameters \(JSON schema\): \{/);
      expect(JSON.stringify(third.tools)).toBe(initialTools);
      expect(results(third).at(-1)).toMatch(/## paint\n[\s\S]*Parameters \(JSON schema\): \{/);
      // watch was called directly: it ran, and its instructions came with its first result.
      expect(results(fourth).at(-1)).toMatch(/The full instructions of watch, for your next calls:\n\n## watch/);
      expect(names(fourth)).toContain('watch');
      expect(JSON.stringify(fourth.tools!.slice(0, first.tools!.length))).toBe(initialTools);
      plan = [{ call: { name: 'load_tools', args: { names: ['music'] } } }, { text: 'Ready.' }];
      await s.send('Load the next tool.');
      const last = bodies.at(-1)!;
      expect(names(last).at(-1)).toBe('music');
      expect(last.tools!.slice(0, fourth.tools!.length)).toEqual(fourth.tools);
      expect(system(last)).toBe(system(first));
      const beforeOpen = JSON.stringify(s.toolSpecs);
      rt.close(s.id);
      expect(JSON.stringify((await rt.get(s.id)).toolSpecs)).toBe(beforeOpen);
    } finally {
      rt.dispose();
    }
  });

  it('unlocks and preloads paint on artwork requests, while keeping paint as a stub without preloading 21 params on plain landing pages', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const sPoster = await rt.start({ cwd: project, interactive: true });
      plan = [{ text: 'Done.' }];
      const beforePoster = bodies.length;
      await sPoster.send('Make a poster for our gig on Friday.');
      const posterBody = bodies[beforePoster];
      const posterNote = lastUser(posterBody);
      expect(names(posterBody)).toContain('paint');
      expect(posterNote).toMatch(/Loaded for this request, no load_tools call needed: the full instructions of browser, paint\./);
      expect(posterNote).toContain('## browser');
      expect(posterNote).toContain('## paint');
      expect(posterNote).not.toContain('## review');
      rt.close(sPoster.id);

      const emptyDir = fs.mkdtempSync(path.join(home, 'landing-'));
      const rtEmpty = createRuntime(emptyDir, { interactive: true });
      const sLanding = await rtEmpty.start({ cwd: emptyDir, interactive: true });
      plan = [{ call: { name: 'load_tools', args: { names: ['paint'] } } }, { text: 'Done.' }];
      const beforeLanding = bodies.length;
      await sLanding.send('Build a landing page for our coffee subscription.');
      const [landingFirst, landingSecond] = bodies.slice(beforeLanding);
      const landingNote = lastUser(landingFirst);
      // Empty/non-code folder keeps paint as a stub without preloading 21 params on plain landing pages, and loading it mid-turn keeps tools[] unchanged.
      expect(names(landingFirst)).toContain('paint');
      expect(JSON.stringify(landingSecond.tools)).toBe(JSON.stringify(landingFirst.tools));
      expect(landingNote).toContain('## browser');
      expect(landingNote).not.toContain('## paint');
      expect(results(landingSecond).at(-1)).toContain('## paint');
      rtEmpty.close(sLanding.id);
      rtEmpty.dispose();

      const sAuto = await rt.start({ cwd: project, autonomous: true, interactive: false });
      plan = [{ text: 'Done.' }];
      const beforeAuto = bodies.length;
      await sAuto.send('Compose a 12-bar jazz soundtrack.');
      const autoBody = bodies[beforeAuto];
      expect(names(autoBody)).not.toContain('ask');
      expect(names(autoBody)).toContain('music');
      expect(lastUser(autoBody)).toContain('## music');
      expect(system(autoBody)).not.toContain('use ask only');
      rt.close(sAuto.id);
    } finally {
      rt.dispose();
    }
  });

  it('keeps tools[] and system byte-for-byte identical across mid-session paint, # Interfaces injection, compaction, and non-code -> code folder growth while preserving shell evidence and STALE detection', async () => {
    const { createRuntime } = await import('../src/runtime');
    // 1. Code folder: routine start -> write .tsx (# Interfaces injected) -> direct paint call -> load_tools(['paint']) -> manual compaction -> post-compaction UI turn.
    const codeDir = fs.mkdtempSync(path.join(home, 'code-inv-'));
    fs.writeFileSync(path.join(codeDir, 'package.json'), JSON.stringify({ name: 'code-inv', version: '1.0.0' }));
    fs.writeFileSync(path.join(codeDir, 'index.ts'), 'export const x = 1;\n');
    const rtCode = createRuntime(codeDir, { interactive: false });
    try {
      const s = await rtCode.start({ cwd: codeDir, autonomous: true, interactive: false });
      const startIdx = bodies.length;
      plan = [
        { call: { name: 'write', args: { path: 'src/App.tsx', content: 'export function App() { return <main>Hello</main>; }\n' } } },
        // Direct paint call (missing prompt triggers fast input error after firstUse attaches full paint instructions).
        { call: { name: 'paint', args: { out: 'hero.png' } } },
        { call: { name: 'load_tools', args: { names: ['paint'] } } },
        { text: 'Initial UI step done.' },
      ];
      await s.send('Set up the entry module.');
      // Manual compaction sends a summary request with the exact same tools[] and system prefix.
      plan = [{ text: '<summary>Created src/App.tsx, inspected paint instructions, and prepared layout.</summary>' }];
      const compacted = await s.compact('manual');
      expect(compacted).toBe(true);
      // Post-compaction turn re-triggers # Interfaces on demand without mutating tools[] or system.
      plan = [{ text: 'Updated mobile layout.' }];
      await s.send('Refine src/App.tsx layout at 390px.');

      const codeReqs = bodies.slice(startIdx);
      expect(codeReqs.length).toBe(6);
      const codeTools0 = JSON.stringify(codeReqs[0].tools);
      const codeSys0 = system(codeReqs[0]);
      // Verify # Interfaces arrived mid-session via <harness-note>, not system mutation.
      expect(codeSys0).not.toContain('# Interfaces');
      expect(JSON.stringify(codeReqs[1].messages)).toContain('# Interfaces');
      expect(results(codeReqs[2]).at(-1)).toContain('The full instructions of paint, for your next calls:');
      for (const [i, req] of codeReqs.entries()) {
        expect(JSON.stringify(req.tools), `code req ${i} tools[]`).toBe(codeTools0);
        expect(system(req), `code req ${i} system`).toBe(codeSys0);
      }
      rtCode.close(s.id);
    } finally {
      rtCode.dispose();
    }

    // 2. Non-code folder (no check tool) that creates package.json + code + tests mid-session, runs tests via shell, edits source (STALE), compacts, and reopens.
    const growDir = fs.mkdtempSync(path.join(home, 'grow-inv-'));
    fs.writeFileSync(path.join(growDir, 'notes.md'), '# Spec\n');
    const rtGrow = createRuntime(growDir, { interactive: false });
    try {
      const s = await rtGrow.start({ cwd: growDir, autonomous: true, interactive: false });
      const startIdx = bodies.length;
      plan = [
        { call: { name: 'write', args: { path: 'package.json', content: '{"name":"grown","scripts":{"test":"node test.js"}}\n' } } },
        { call: { name: 'write', args: { path: 'sum.js', content: 'module.exports = (a, b) => a + b;\n' } } },
        { call: { name: 'write', args: { path: 'test.js', content: 'const assert = require("node:assert"); const sum = require("./sum"); assert.strictEqual(sum(2, 3), 5);\n' } } },
        { call: { name: 'shell', args: { command: 'npm test' } } },
        { text: 'Project created and tested.' },
      ];
      await s.send('Create the sum package and run its tests.');

      // Evidence recorded for shell test run even without the check tool: tracked inputs are clean right after passing.
      const cleanSummary = evidenceSummary(s.messages, growDir);
      expect(cleanSummary).toContain('passed: npm test');
      expect(cleanSummary).toContain('tracked inputs unchanged');

      // Now edit sum.js -> the previous shell test run flips to STALE after source changes.
      plan = [
        { call: { name: 'edit', args: { path: 'sum.js', old_string: 'a + b', new_string: 'Number(a) + Number(b)' } } },
        { call: { name: 'load_tools', args: { names: ['paint'] } } },
        { text: 'Edited sum.js.' },
      ];
      await s.send('Coerce inputs to numbers in sum.js.');
      const staleSummary = evidenceSummary(s.messages, growDir);
      expect(staleSummary).toContain('passed: npm test');
      expect(staleSummary).toContain('STALE after source changes');
      expect( evidenceSummary(s.messages, growDir, true)).toContain('STALE after source changes');

      // Compact and reopen after package.json + .js files exist on disk: tools[] and system still stay byte-for-byte identical!
      plan = [{ text: '<summary>Built sum.js and test.js, ran npm test, and updated sum.js coercion.</summary>' }];
      expect(await s.compact('manual')).toBe(true);
      const id = s.id;
      rtGrow.close(id);
      const reopened = await rtGrow.get(id);
      plan = [{ text: 'Reopened cleanly.' }];
      await reopened.send('Check status.');

      const growReqs = bodies.slice(startIdx);
      expect(growReqs.length).toBe(10);
      const growTools0 = JSON.stringify(growReqs[0].tools);
      const growSys0 = system(growReqs[0]);
      expect(names(growReqs[0])).not.toContain('check');
      expect(names(growReqs[0])).toContain('paint');
      for (const [i, req] of growReqs.entries()) {
        expect(JSON.stringify(req.tools), `grow req ${i} tools[]`).toBe(growTools0);
        expect(system(req), `grow req ${i} system`).toBe(growSys0);
      }
      rtGrow.close(id);
    } finally {
      rtGrow.dispose();
    }
  });
});
