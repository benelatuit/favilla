import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { projectFacts } from '../src/prompt/env';
import { toForward } from '../src/util/paths';
import { capture } from '../src/util/proc';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-project-facts-'));
const project = path.join(home, 'project');
const elsewhere = path.join(home, 'elsewhere');
const git = (cwd: string, ...args: string[]) => capture('git', args, { cwd, timeoutMs: 6000 });

beforeAll(() => {
  vi.stubEnv('FAVILLA_HOME', home);
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CEILING_DIRECTORIES', home);
  for (const dir of [project, elsewhere, path.join(home, 'cache')]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(home, 'cache', 'toolchains2.json'), JSON.stringify({ at: Date.now(), versions: {} }));
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function run(...args: string[]) {
  const result = await git(project, ...args);
  expect(result.code, result.stderr).toBe(0);
}

// Compare the note to the three original Git queries in each repository state, including their ordering and quoting.
async function check(cwd: string) {
  const root = await git(cwd, 'rev-parse', '--show-toplevel');
  const want = ['Working directory: ' + toForward(cwd)];
  if (root.code !== 0) want.push('Git: not a repository');
  else {
    const [branch, status, log] = await Promise.all([
      git(cwd, 'branch', '--show-current'),
      git(cwd, 'status', '--porcelain=v1', '-uall'),
      git(cwd, 'log', '--oneline', '-n', '5', '--no-decorate'),
    ]);
    const lines = status.stdout.split('\n').filter(Boolean);
    const newFiles = lines.filter((line) => line.startsWith('??')).length;
    want.push('Git: repository at ' + toForward(root.stdout.trim()) + ', branch ' + (branch.stdout.trim() || '(detached)')
      + '; ' + (lines.length - newFiles) + ' changed and ' + newFiles + ' untracked files');
    if (lines.length) want.push('  ' + lines.slice(0, 12).map((line) => line.trim()).join('\n  ')
      + (lines.length > 12 ? '\n  … ' + (lines.length - 12) + ' more' : ''));
    if (log.stdout.trim()) want.push('Recent commits:\n  ' + log.stdout.trim().split('\n').join('\n  '));
  }
  const note = await projectFacts({ cwd });
  expect(note.split('\nTop-level entries:')[0]).toBe(want.join('\n'));
}

it('keeps the Git note byte-for-byte for an unborn branch, tracking branches, staged paths, and a detached worktree', async () => {
  await check(elsewhere);
  await run('init', '--quiet', '--initial-branch=topic/first');
  fs.writeFileSync(path.join(project, 'original.txt'), 'first\n');
  await check(project);
  await run('add', 'original.txt');
  await run('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'First fixture commit');
  await run('branch', 'upstream');
  await run('branch', '--set-upstream-to=upstream');
  await run('mv', 'original.txt', 'renamed 文件.txt');
  await run('config', 'core.quotePath', 'false');
  const nested = path.join(project, 'nested');
  fs.mkdirSync(nested);
  for (let i = 0; i < 13; i++) fs.writeFileSync(path.join(nested, 'untracked ' + i + '.txt'), 'fixture\n');
  await check(nested);
  await run('branch', '-D', 'upstream');
  await check(project);
  const detached = path.join(home, 'detached');
  await run('worktree', 'add', '--detach', '--quiet', detached);
  await check(detached);
}, 30_000);
