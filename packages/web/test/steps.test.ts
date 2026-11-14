import { describe, expect, it } from 'vitest';
import { commandFailed, markRanges, parseMatches, stepFailed, stepPaths, viewCommand } from '../src/lib/steps';

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
