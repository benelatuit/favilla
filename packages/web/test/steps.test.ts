import { describe, expect, it } from 'vitest';
import { commandFailed, failuresLeft, markRanges, parseMatches, stepFailed, stepPaths, toolTarget, toolTitle, viewCommand } from '../src/lib/steps';

describe('commands as steps show them', () => {
  it('drops a cd to the working folder, keeps one elsewhere, and picks out a heredoc script', () => {
    const cmd = "cd C:/work/app && python - <<'EOF'\nimport json\nprint(1)\nEOF";
    const here = viewCommand(cmd, 'C:\\work\\app\\');
    expect(here.dir).toBeUndefined();
    expect(here.script).toMatchObject({ tool: 'python', as: 'script.py', body: 'import json\nprint(1)', lines: 2, before: "python - <<'EOF'", after: 'EOF' });
    expect(viewCommand(cmd, 'C:/work').dir).toBe('work/app');
    expect(viewCommand('cd "/c/my project/web"; npm test', '/c/other').dir).toBe('my project/web');
  });

  it('names the file a cat heredoc writes, and counts the lines of a plain command', () => {
    const write = viewCommand("cat > src/app.ts <<'EOF'\nexport const a = 1;\nEOF");
    expect(write.script).toMatchObject({ writes: 'src/app.ts', tool: 'src/app.ts', as: 'script.ts', lines: 1 });
    const chain = viewCommand('npm run build &&\n  npm test');
    expect(chain).toMatchObject({ head: 'npm run build &&', lines: 2 });
    expect(chain.script).toBeUndefined();
  });
});

describe('a script that opens with how it runs', () => {
  it('is named by its first line that does something', () => {
    expect(viewCommand('set -euo pipefail\ncd /srv/relay\npkill -f relay || true\ngit pull --ff-only\nnpm ci\necho done')).toMatchObject({ head: 'pkill -f relay || true', lines: 6 });
    expect(viewCommand('#!/usr/bin/env bash\n# stop the old one\nset -e\nexport NODE_ENV=production\nnode server.js').head).toBe('node server.js');
    expect(viewCommand("$ErrorActionPreference = 'Stop'\nGet-Process relay | Stop-Process").head).toBe('Get-Process relay | Stop-Process');
    // A cd on a line of its own says where, as one in front does.
    expect(viewCommand('cd /c/work/app\nnpm test', '/c/other')).toMatchObject({ dir: 'work/app', head: 'npm test' });
    // Nothing but setup: the first line stands.
    expect(viewCommand('set -e').head).toBe('set -e');
  });
});

describe('a command that failed', () => {
  const ran = (command: string, exitCode: number | null, more: { timedOut?: boolean } = {}) => ({ isError: !!exitCode, display: { kind: 'terminal' as const, command, output: '', exitCode, durationMs: 5, cwd: '/w', ...more } });
  it('is not a search that found nothing or a diff that found a difference', () => {
    expect(commandFailed('rg -n unquote src', 1)).toBe(false);
    expect(commandFailed('cd /w && git status --short | grep relay', 1)).toBe(false);
    expect(commandFailed('diff a.txt b.txt', 1)).toBe(false);
    expect(commandFailed('git diff --quiet HEAD', 1)).toBe(false);
    expect(commandFailed('grep -n x missing.txt', 2)).toBe(true);
    expect(commandFailed('npm test', 1)).toBe(true);
    expect(commandFailed('grep -c x a.txt && npm test', 1)).toBe(true);
    expect(stepFailed(ran('grep -n relay src/a.ts', 1))).toBe(false);
    expect(stepFailed(ran('ls fixtures', 2))).toBe(true);
    expect(stepFailed(ran('rg x', 1, { timedOut: true }))).toBe(true);
    expect(stepFailed({ isError: true })).toBe(true);
    expect(stepFailed(ran('node a.js', 0))).toBe(false);
  });
});

describe('failures a later step put right', () => {
  const run = (command: string, exitCode: number, title = 'Run the tests') => ({
    name: 'shell', title, input: { command, description: title },
    result: { content: '', isError: exitCode !== 0, display: { kind: 'terminal' as const, command, output: '', exitCode, durationMs: 5, cwd: '/w' } },
  });
  const edit = (title: string, ok: boolean) => ({ name: 'edit', title, input: { path: title }, result: { content: ok ? 'Edited.' : 'No match.', isError: !ok } });
  it('leaves out a failure the same command or target passed after', () => {
    expect(failuresLeft([run('pnpm test', 1), edit('src/dates.ts', true), run('pnpm test', 0, 'Run the tests again')])).toEqual([]);
    expect(failuresLeft([edit('src/a.ts', false), edit('src/a.ts', true)])).toEqual([]);
  });
  it('keeps a failure that nothing after it fixed, or that came after the pass', () => {
    const late = run('pnpm test', 1);
    expect(failuresLeft([run('pnpm test', 0), late])).toEqual([late]);
    const other = run('pnpm lint', 1);
    expect(failuresLeft([other, run('pnpm test', 0)])).toEqual([other]);
    const missed = edit('src/a.ts', false);
    expect(failuresLeft([missed, edit('src/b.ts', true)])).toEqual([missed]);
  });
  const check = (title: string, results: [string, boolean][], before = false) => ({
    name: 'check', title, input: {},
    result: {
      content: '', isError: results.some(([, ok]) => !ok),
      display: {
        kind: 'checks' as const, found: results.map(([name]) => name), ...(before ? { before } : {}),
        results: results.map(([name, ok]) => ({ name, command: name, ok, durationMs: 5, problems: [] })),
      },
    },
  });
  it('lets a later run of every check put right a run of one that failed', () => {
    const tests = check('test', [['test', false]]);
    expect(failuresLeft([tests, check('types · lint · test', [['types', true], ['lint', true], ['test', true]])])).toEqual([]);
    // A run that failed its lint but passed its tests still puts the earlier tests right.
    const lint = check('lint · test', [['lint', false], ['test', true]]);
    expect(failuresLeft([tests, lint])).toEqual([lint]);
  });
  it('keeps a failed check that no later run passed', () => {
    const both = check('types · test', [['types', false], ['test', false]]);
    expect(failuresLeft([both, check('test', [['test', true]])])).toEqual([both]);
    const tests = check('test', [['test', false]]);
    expect(failuresLeft([tests, check('test', [['test', true]], true)])).toEqual([tests]);
  });
});

describe('search output as files and lines', () => {
  it('reads both layouts and marks the matches', () => {
    expect(parseMatches('src/a.ts\n3:export function load() {\n4-  return 1;\n--\nsrc/b.ts\n10:load();')).toEqual([
      { path: 'src/a.ts', lines: [{ n: 3, text: 'export function load() {', context: false }, { n: 4, text: '  return 1;', context: true }] },
      { path: 'src/b.ts', lines: [{ n: 10, text: 'load();', context: false }] },
    ]);
    expect(parseMatches('src/a.ts:3:load()\nsrc/a.ts:9:reload()\nlib/c.py:1:load')).toEqual([
      { path: 'src/a.ts', lines: [{ n: 3, text: 'load()' }, { n: 9, text: 'reload()' }] },
      { path: 'lib/c.py', lines: [{ n: 1, text: 'load' }] },
    ]);
    expect(markRanges('reload(); load()', 'load')).toEqual([[2, 6], [10, 14]]);
    // Not a valid regex: matched as plain text.
    expect(markRanges('a(b', 'a(')).toEqual([[0, 2]]);
  });
});

describe('the files a step names', () => {
  it('counts each path of a read of several, a range as its file, and each file a patch touches', () => {
    expect(stepPaths({ paths: ['src/prorate.ts', 'test/prorate.test.ts'] })).toEqual(['src/prorate.ts', 'test/prorate.test.ts']);
    expect(stepPaths({ paths: ['src/app.ts:120-200', './src/app.ts', 'src\\app.ts:4'] })).toEqual(['src/app.ts']);
    expect(stepPaths({ file_path: 'README.md', content: 'x' })).toEqual(['README.md']);
    expect(stepPaths({ input: '*** Begin Patch\n*** Update File: a.ts\n@@\n*** Add File: b.ts\n*** End Patch' })).toEqual(['a.ts', 'b.ts']);
    expect(stepPaths({ command: 'ls' })).toEqual([]);
  });
});

describe('what a check row says', () => {
  it('names the checks once, the same while it runs and after', () => {
    expect(toolTarget('check', 'Check types, test')).toBe('types · test');
    expect(toolTarget('check', 'Check test')).toBe('test');
    expect(toolTarget('check', 'Check')).toBe('types · lint · test');
    expect(toolTarget('check', 'Check test in packages/web')).toBe('test in packages/web');
    // After the call the page writes the title itself, without the word.
    expect(toolTarget('check', toolTitle('check', { only: ['types', 'test'] }))).toBe('types · test');
  });
});
