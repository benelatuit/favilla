import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { beforeTree, changedTests, isTestFile, newGoTests } from '../src/tools/before';
import { checkTool } from '../src/tools/check';
import { detectShell } from '../src/tools/shell';
import { shellTool } from '../src/tools/shell-tools';
import type { ToolContext } from '../src/tools/types';

const roots: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-before-test-'));
  roots.push(d);
  return d;
};
const sessions: string[] = [];
const session = () => {
  const id = `test-${process.pid}-${sessions.length}`;
  sessions.push(id);
  return id;
};
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const s of sessions) fs.rmSync(path.join(os.tmpdir(), 'favilla-before', s), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const goAvailable = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('the code before the session', () => {
  it('knows test files by their names and folders', () => {
    for (const f of ['calc_test.go', 'src/a.test.ts', 'src/a.spec.jsx', 'tests/test_x.py', 'x_test.py', 'conftest.py', 'src/__tests__/a.ts', 'FooTest.java', 'spec/model_spec.rb', 'test/helpers.js']) expect(isTestFile(f), f).toBe(true);
    for (const f of ['calc.go', 'src/a.ts', 'latest.py', 'contest.py', 'src/testing.ts', 'Foo.java']) expect(isTestFile(f), f).toBe(false);
  });

  it('copies the project with changed code put back, the session tests kept, and dependencies linked', () => {
    const cwd = tmp();
    write(cwd, 'src/calc.go', 'package calc\n// fixed\n');
    write(cwd, 'src/calc_test.go', 'package calc\n// with the new test\n');
    write(cwd, 'src/extra.go', 'package calc\n// made in this session\n');
    write(cwd, 'src/untouched.go', 'package calc\n');
    write(cwd, 'node_modules/dep/index.js', 'module.exports = 1;\n');
    write(cwd, '.git/HEAD', 'ref: refs/heads/main\n');
    const originals = new Map<string, Buffer | null>([
      [path.join(cwd, 'src/calc.go'), Buffer.from('package calc\n// broken\n')],
      [path.join(cwd, 'src/calc_test.go'), Buffer.from('package calc\n')],
      [path.join(cwd, 'src/extra.go'), null],
    ]);
    const made = beforeTree(cwd, session(), originals);
    if ('error' in made) throw new Error(made.error);
    const read = (rel: string) => fs.readFileSync(path.join(made.root, rel), 'utf8');
    expect(read('src/calc.go')).toContain('// broken');
    expect(read('src/calc_test.go')).toContain('// with the new test');
    expect(fs.existsSync(path.join(made.root, 'src/extra.go'))).toBe(false);
    expect(read('src/untouched.go')).toBe('package calc\n');
    expect(fs.lstatSync(path.join(made.root, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(made.root, '.git'))).toBe(false);
    // Later changes reach the same copy.
    write(cwd, 'src/calc_test.go', 'package calc\n// a second test\n');
    const again = beforeTree(cwd, sessions.at(-1)!, originals);
    expect('root' in again && again.root).toBe(made.root);
    expect(read('src/calc_test.go')).toContain('// a second test');
  });

  it('runs a command on the old code when asked', async () => {
    const cwd = tmp();
    write(cwd, 'calc.txt', 'fixed\n');
    const originals = new Map<string, Buffer | null>([[path.join(cwd, 'calc.txt'), Buffer.from('broken\n')]]);
    const ctx = {
      cwd,
      sessionId: session(),
      callId: 'c1',
      turn: 't1',
      signal: new AbortController().signal,
      config: { bashTimeoutMs: 60_000, beforeTests: true },
      shell: detectShell(),
      outputChars: 30_000,
      outputDir: path.join(cwd, '.out'),
      progress: () => {},
      checkpoints: { turns: () => ['t1'], files: () => [...originals.keys()], originals: () => originals },
    } as unknown as ToolContext;
    const show = `node -e "process.stdout.write(require('fs').readFileSync('calc.txt', 'utf8'))"`;
    const old = await shellTool.execute({ command: show, before: true, format: 'favilla' }, ctx);
    expect(old.content).toMatch(/^On the code as it was before this session's changes/);
    expect(old.content).toContain('broken');
    const now = await shellTool.execute({ command: show, format: 'favilla' }, ctx);
    expect(now.content).toContain('fixed');
    expect(now.content).not.toContain('before this session');
  }, 60_000);

  it('finds the tests a session added', () => {
    expect(newGoTests('func TestOld(t *testing.T) {}\n', 'func TestOld(t *testing.T) {}\nfunc TestNew(t *testing.T) {}\nfunc FuzzNew(f *testing.F) {}\n')).toEqual(['TestNew', 'FuzzNew']);
    expect(newGoTests(null, 'func TestA(t *testing.T) {}\n')).toEqual(['TestA']);
    const cwd = tmp();
    write(cwd, 'a_test.go', 'new');
    write(cwd, 'same_test.go', 'same');
    write(cwd, 'a.go', 'code');
    const { files } = changedTests(
      cwd,
      new Map([
        [path.join(cwd, 'a_test.go'), Buffer.from('old')],
        [path.join(cwd, 'same_test.go'), Buffer.from('same')],
        [path.join(cwd, 'a.go'), Buffer.from('old code')],
      ]),
    );
    expect(files).toEqual(['a_test.go']);
  });

  it.skipIf(!goAvailable)('says whether the session tests catch its fix, from a run on the old code', async () => {
    const cwd = tmp();
    write(cwd, 'go.mod', 'module calc\n\ngo 1.21\n');
    const broken = 'package calc\n\nfunc Add(a, b int) int { return a - b }\n';
    write(cwd, 'calc.go', 'package calc\n\nfunc Add(a, b int) int { return a + b }\n');
    // A test that fails on the old code: it catches the fix.
    write(cwd, 'calc_test.go', 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("2 + 3")\n\t}\n}\n');
    const originals = new Map<string, Buffer | null>([
      [path.join(cwd, 'calc.go'), Buffer.from(broken)],
      [path.join(cwd, 'calc_test.go'), null],
    ]);
    const checkpoints = { turns: () => ['t1'], files: () => [...originals.keys()], originals: () => originals };
    const ctx = {
      cwd,
      sessionId: session(),
      callId: 'c1',
      turn: 't1',
      signal: new AbortController().signal,
      config: { bashTimeoutMs: 120_000, beforeTests: true },
      shell: detectShell(),
      outputChars: 30_000,
      outputDir: path.join(cwd, '.out'),
      progress: () => {},
      checkpoints,
    } as unknown as ToolContext;
    const caught = await checkTool.execute({ only: ['test'] }, ctx);
    expect(caught.isError).toBeFalsy();
    expect(caught.content).toContain('fail on the code as it was before this session');
    expect(caught.display?.kind === 'checks' && caught.display.verdict).toEqual({ kind: 'catches', files: ['calc_test.go'] });
    // The same tests again: nothing more to say.
    const same = await checkTool.execute({ only: ['test'] }, ctx);
    expect(same.content).not.toContain('before this session');
    // A test that passes on the old code too does not catch it.
    write(cwd, 'calc_test.go', 'package calc\n\nimport "testing"\n\nfunc TestAddZero(t *testing.T) {\n\tif Add(0, 0) != 0 {\n\t\tt.Fatal("0 + 0")\n\t}\n}\n');
    const missed = await checkTool.execute({ only: ['test'] }, ctx);
    expect(missed.content).toContain('also pass on the code as it was before');
    // And the old code checked on request.
    const old = await checkTool.execute({ before: true }, ctx);
    expect(old.content).toMatch(/^On the code as it was before this session's changes/);
    expect(old.display?.kind === 'checks' && old.display.before).toBe(true);
  }, 120_000);
});
