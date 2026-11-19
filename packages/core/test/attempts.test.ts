import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { applyPatch, copyChanges, gitRoot, makeCopy, removeCopy } from '@favilla/core/agent/attempts';

// Parallel attempts in copies of a real git repository, driven by a scripted model server.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-attempts-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const repo = path.join(home, 'repo');
fs.mkdirSync(repo, { recursive: true });
/** File text with the line endings git's autocrlf may have chosen made plain. */
const read = (...p: string[]) => fs.readFileSync(path.join(repo, ...p), 'utf8').replace(/\r\n/g, '\n');
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// What each attempt writes into calc.js: #1 gets it wrong, #2 and #3 right; the judge then has to choose.
const FIXES: Record<string, string> = {
  '1': 'exports.add = (a, b) => a * b;\n',
  '2': 'exports.add = (a, b) => {\n  const sum = a + b;\n  return sum;\n};\n',
  '3': 'exports.add = (a, b) => a + b;\n',
};
const steps = new Map<string, number>();
const judged: string[] = [];
const reply = (res: http.ServerResponse, r: { text?: string; call?: { name: string; args: unknown } }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (r.call) {
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  chunk({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 5 } });
  res.end('data: [DONE]\n\n');
};
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    const json = JSON.parse(body);
    const system = String(json.messages?.[0]?.content ?? '');
    if (system.includes('You judge code changes')) {
      judged.push(JSON.stringify(json.messages.at(-1)).match(/attempt n=\\"(\d)\\"/g)?.join(',') ?? '');
      return reply(res, { text: 'WINNER: 3\nWHY: the same fix in one line.' });
    }
    // Each session names its folder at the start of its first message.
    const said = (json.messages as { content?: unknown }[]).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const where = /Working directory: (\S+)/.exec(said)?.[1] ?? '';
    const n = /-(\d)$/.exec(where)?.[1];
    const key = n ?? 'main';
    const step = steps.get(key) ?? 0;
    steps.set(key, step + 1);
    if (!n) return reply(res, step === 0 ? { call: { name: 'attempts', args: { task: 'Fix add() in calc.js so that npm test passes.', count: 3 } } } : { text: 'Kept attempt 3.' });
    if (step === 0) return reply(res, { call: { name: 'read', args: { paths: ['calc.js'] } } });
    if (step === 1) return reply(res, { call: { name: 'write', args: { path: 'calc.js', content: FIXES[n] } } });
    return reply(res, { text: `Attempt ${n}: rewrote add().` });
  });
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'calc', scripts: { test: 'node test.js' } }));
  fs.writeFileSync(path.join(repo, 'calc.js'), 'exports.add = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(repo, 'test.js'), "const { add } = require('./calc');\nif (add(2, 3) !== 5 || add(-1, 1) !== 0) { console.error('add is wrong'); process.exit(1); }\nconsole.log('ok');\n");
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'start');
  // Work in progress the copies must carry: a changed file and a new one.
  fs.writeFileSync(path.join(repo, 'README.md'), 'Calc, being fixed.\n');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'untracked note\n');

  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', providers: { fake: { api: 'openai-chat', baseUrl: base, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }),
  );
  rt = createRuntime(repo, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('parallel attempts', () => {
  it('keeps the synchronous worktree API used by extensions', () => {
    type Copy = { dir: string; links: string[] };
    type Changes = { patch: string; files: { path: string; added: number; removed: number }[] };
    expectTypeOf(gitRoot).toEqualTypeOf<(cwd: string) => string | null>();
    expectTypeOf(makeCopy).toEqualTypeOf<(root: string, dir: string) => Copy>();
    expectTypeOf(copyChanges).toEqualTypeOf<(copy: Copy) => Changes>();
    expectTypeOf(removeCopy).toEqualTypeOf<(root: string, copy: Copy) => void>();
    expectTypeOf(applyPatch).toEqualTypeOf<(root: string, patch: string) => void>();

    const file = path.join(repo, 'calc.js');
    const original = fs.readFileSync(file);
    const dir = path.join(home, 'extension-copy');
    expect(gitRoot(path.join(repo, 'node_modules'))).toBe(fs.realpathSync(repo));
    expect(gitRoot(home)).toBeNull();
    try {
      fs.appendFileSync(file, '// local change\n');
      const copy = makeCopy(repo, dir);
      try {
        expect(copy).toEqual({ dir, links: ['node_modules'] });
        expect(fs.readFileSync(path.join(dir, 'calc.js'), 'utf8')).toContain('// local change');
        expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toContain('untracked note');
        expect(fs.realpathSync(path.join(dir, 'node_modules'))).toBe(fs.realpathSync(path.join(repo, 'node_modules')));
        expect(copyChanges(copy)).toEqual({ patch: '', files: [] });
        fs.writeFileSync(path.join(dir, 'extension.txt'), 'result\n');
        const { patch, files } = copyChanges(copy);
        expect(files).toEqual([{ path: 'extension.txt', added: 1, removed: 0 }]);
        expect(applyPatch(repo, patch)).toBeUndefined();
        expect(read('extension.txt')).toBe('result\n');
        expect(() => applyPatch(repo, patch)).toThrow();
      } finally {
        expect(removeCopy(repo, copy)).toBeUndefined();
      }
      expect(fs.existsSync(dir)).toBe(false);
      expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
      expect(read('node_modules', 'dep', 'index.js')).toContain('module.exports');
    } finally {
      fs.writeFileSync(file, original);
      fs.rmSync(path.join(repo, 'extension.txt'), { force: true });
    }
  });

  it('run in copies, are scored by the checks, judged when tied, and only the kept change comes back', async () => {
    const s = await rt.start({ cwd: repo, model: 'fake/m1' });
    await s.send('add() is broken; fix it.');
    const result = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.name === 'attempts') as { content: string; display?: { kind: string; attempts: { n: number; passed: number; failed: number; chosen: boolean }[] } };
    expect(result.content).toMatch(/#3 was kept \(the same fix in one line\.\)/);
    expect(result.display?.attempts.map((a) => [a.n, a.passed, a.failed, a.chosen])).toEqual([
      [1, 0, 1, false],
      [2, 1, 0, false],
      [3, 1, 0, true],
    ]);
    // Only the two that passed were judged.
    expect(judged).toHaveLength(1);
    expect(judged[0].split(',').sort()).toEqual(['attempt n=\\"2\\"', 'attempt n=\\"3\\"']);
    // The kept change is in the working tree; the work in progress is untouched; the shared dependencies survived.
    expect(read('calc.js')).toBe(FIXES['3']);
    expect(read('README.md')).toBe('Calc, being fixed.\n');
    expect(read('notes.txt')).toBe('untracked note\n');
    expect(read('node_modules', 'dep', 'index.js')).toBe('module.exports = 1;\n');
    // No copies left behind; the change belongs to the turn and can be undone.
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
    const turn = s.messages.find((m) => m.origin === 'user')!.turn!;
    expect((await s.turnChangesAsync(turn)).map((c) => c.path)).toContain('calc.js');
    await s.undoFiles(turn);
    expect(read('calc.js')).toBe('exports.add = (a, b) => a - b;\n');
  }, 120_000);
});
