import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { folderGit } from '../src/prompt/env';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-folder-git-'));

afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('the folder’s branch and uncommitted files, for the welcome page', () => {
  it('gives the branch and counts changed and untracked files, and nothing outside a repository', async () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore', windowsHide: true });
    git('init', '-q', '-b', 'fix/dates');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    expect(await folderGit(repo)).toEqual({ branch: 'fix/dates', changed: 0 });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n');
    fs.mkdirSync(path.join(repo, 'new'));
    fs.writeFileSync(path.join(repo, 'new', 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(repo, 'new', 'c.txt'), 'c\n');
    expect(await folderGit(repo)).toEqual({ branch: 'fix/dates', changed: 3 });
    // A placeholder .git, as the fixtures use, stops git at the folder: not a repository.
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, '.git'), '');
    expect(await folderGit(plain)).toBeNull();
  });
});
