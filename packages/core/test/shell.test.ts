import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectShell, PIPE_CLOSED, runShell } from '../src/tools/shell';
import { isWindows } from '../src/util/paths';

const run = (choice: string, command: string) =>
  runShell(detectShell(choice), command, { cwd: os.tmpdir(), timeoutMs: 20_000, signal: new AbortController().signal, logFile: path.join(os.tmpdir(), 'favilla-shell-test.log') });

describe('shell choice', () => {
  it('runs bash by default', async () => {
    const shell = detectShell();
    expect(['bash', 'pwsh', 'powershell']).toContain(shell.kind);
    if (shell.kind === 'bash') {
      const r = await run('', 'echo "$((6 * 7))" | tr 4 x');
      expect(r.output.trim()).toBe('x2');
      expect(shell.fallback).toBeUndefined();
    } else expect(shell.fallback).toMatch(/Git Bash was not found/);
  });

  it('passes the command to bash verbatim', async () => {
    if (detectShell().kind !== 'bash') return;
    // A quoted heredoc is literal: every backslash must arrive (MSYS argument parsing used to halve them).
    const heredoc = String.raw`cat <<'EOF'
print('x\\y'.replace('\\', '/'), "q\"")
EOF`;
    expect((await run('', heredoc)).output.trim()).toBe(String.raw`print('x\\y'.replace('\\', '/'), "q\"")`);
    expect((await run('', String.raw`printf '%s|' 'a\\b' "c\\d" 'e"f'`)).output).toBe(String.raw`a\\b|c\d|e"f|`);
    // Longer than a Windows command line can be, and the command is not left in the children's environment.
    const r = await run('', `x='${'a'.repeat(100_000)}'; echo "\${#x}"; env | grep -c FAVILLA_COMMAND; exit 4`);
    expect(r.output.trim().split(/\s+/)).toEqual(['100000', '0']);
    expect(r.exitCode).toBe(4);
  });

  it('runs a multi-line Python script on stdin with nested quotes intact', async () => {
    if (detectShell().kind !== 'bash') return;
    const r = await run('', `python - <<'PY'\nitems = {"label": "owner's file"}\nfor key, value in items.items():\n    print(f'{key}: {value}')\nPY`);
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe("label: owner's file");
  });

  it('says why when the configured shell is missing', () => {
    const shell = detectShell(path.join(os.tmpdir(), 'no-such-shell.exe'));
    expect(shell.fallback).toMatch(/was not found/);
    expect(detectShell('BASH').kind).toBe(detectShell().kind);
  });

  it.runIf(isWindows)('runs cmd with UTF-8 output', async () => {
    const shell = detectShell('cmd');
    expect(shell.kind).toBe('cmd');
    const r = await run('cmd', 'echo one & echo 两个 "quoted" & exit /b 3');
    expect(r.output).toContain('one');
    expect(r.output).toContain('两个 "quoted"');
    expect(r.exitCode).toBe(3);
  });

  it('a failure early in a pipe shows in the exit code', async () => {
    if (detectShell().kind !== 'bash') return;
    expect((await run('', 'false | cat')).exitCode).toBe(1);
    expect((await run('', 'sh -c "exit 3" | tail -n 1')).exitCode).toBe(3);
    expect((await run('', 'true | cat')).exitCode).toBe(0);
    expect((await run('', 'yes | head -n 1')).exitCode).toBe(PIPE_CLOSED);
  });

  it.runIf(isWindows)('runs Windows PowerShell when asked', async () => {
    const r = await run('powershell', "Write-Output ('a' + 'b')");
    expect(r.output.trim()).toBe('ab');
  });
});

describe('commands that would open an editor', () => {
  // Real git in a folder of its own: without an editor to fall back on, each of these sat in vim until the time limit.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-editor-'));
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (command: string) =>
    runShell(detectShell(), command, { cwd: repo, timeoutMs: 20_000, signal: new AbortController().signal, logFile: path.join(repo, '..', 'favilla-editor-test.log') });
  const hasGit = spawnSync('git', ['--version']).status === 0 && detectShell().kind === 'bash';

  it.runIf(hasGit)('end at once and say why, or keep the message there is', async () => {
    const setup = await git('git init -q . && git config user.name t && git config user.email t@example.com && git config commit.gpgsign false && echo one > a.txt && git add a.txt && git commit -q -m "first message" && echo two > b.txt && git add b.txt && git commit -q -m "second message" && echo three >> a.txt && git add a.txt');
    expect(setup.exitCode).toBe(0);

    const started = Date.now();
    const bare = await git('git commit');
    expect(bare.exitCode).not.toBe(0);
    expect(bare.timedOut).toBeFalsy();
    expect(bare.output).toMatch(/empty commit message/i);
    expect((await git('git log --format=%s')).output.trim().split('\n')).toEqual(['second message', 'first message']);

    const amend = await git('git commit --amend');
    expect(amend.exitCode).toBe(0);
    expect((await git('git log --format=%s')).output.trim().split('\n')).toEqual(['second message', 'first message']);
    expect((await git('git show --stat --format= HEAD')).output).toContain('a.txt');

    const rebase = await git('git rebase -i HEAD~1');
    expect(rebase.exitCode).not.toBe(0);
    expect(rebase.timedOut).toBeFalsy();
    expect(rebase.output).toContain('No editor can open here');
    expect(fs.existsSync(path.join(repo, '.git', 'rebase-merge'))).toBe(false);

    // A command that brings its own way of editing the list is left to it.
    const own = await git('GIT_SEQUENCE_EDITOR="sed -i -e 1s/^pick/reword/" git rebase -i HEAD~1');
    expect(own.exitCode).toBe(0);
    expect((await git('git log --format=%s')).output.trim().split('\n')).toEqual(['second message', 'first message']);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});
