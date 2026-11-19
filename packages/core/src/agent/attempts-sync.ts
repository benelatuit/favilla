import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Copy } from './attempts';

// The synchronous worktree API used by extensions. The agent uses the asynchronous exports in attempts.ts.
function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

export function gitRoot(cwd: string): string | null {
  try {
    return path.resolve(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  } catch {
    return null;
  }
}

/** Folders of installed dependencies a copy can share: node_modules (not nested in another) and Python virtualenvs. */
function dependencyDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.name === 'node_modules' || ((e.name === '.venv' || e.name === 'venv' || e.name === 'env') && fs.existsSync(path.join(full, 'pyvenv.cfg')))) {
        out.push(path.relative(root, full));
        continue;
      }
      if (depth < 3 && !e.name.startsWith('.') && e.name !== 'dist' && e.name !== 'build' && e.name !== 'target') walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** A copy of the working tree at `dir`: the current commit, the uncommitted changes, the untracked files, shared dependencies. */
export function makeCopy(root: string, dir: string): Copy {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD']);
  const changes = git(root, ['diff', 'HEAD', '--binary']);
  if (changes.trim()) git(dir, ['apply', '--binary', '--whitespace=nowarn'], changes);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const rel of untracked) {
    const from = path.join(root, rel);
    const to = path.join(dir, rel);
    try {
      if (!fs.statSync(from).isFile()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    } catch {
      // Gone or unreadable since it was listed: the copy does without it.
    }
  }
  const links: string[] = [];
  for (const rel of dependencyDirs(root)) {
    const to = path.join(dir, rel);
    if (fs.existsSync(to) || !fs.existsSync(path.dirname(to))) continue;
    fs.symlinkSync(path.join(root, rel), to, 'junction');
    links.push(rel);
  }
  // The starting point, committed in the copy, so the attempt's change is exactly what it did.
  git(dir, ['add', '-A', '--', '.', ...exclusions(dir, links)]);
  git(dir, ['-c', 'user.name=favilla', '-c', 'user.email=favilla@localhost', 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'start']);
  return { dir, links };
}

/**
 * Pathspecs that keep the linked dependency folders out of a commit, for the ones git does not ignore already:
 * naming an ignored path in `git add` is an error.
 */
function exclusions(dir: string, links: string[]): string[] {
  return links
    .filter((l) => {
      try {
        git(dir, ['check-ignore', '-q', l]);
        return false;
      } catch {
        return true;
      }
    })
    .map((l) => `:(exclude)${l.replace(/\\/g, '/')}`);
}

/** What an attempt changed, as a patch against its starting point, and per file the lines added and removed. */
export function copyChanges(copy: Copy): { patch: string; files: { path: string; added: number; removed: number }[] } {
  git(copy.dir, ['add', '-A', '--', '.', ...exclusions(copy.dir, copy.links)]);
  const patch = git(copy.dir, ['diff', '--cached', '--binary', 'HEAD']);
  const files = git(copy.dir, ['diff', '--cached', '--numstat', 'HEAD'])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split('\t');
      return { path: p.join('\t'), added: Number(a) || 0, removed: Number(r) || 0 };
    });
  return { patch, files };
}

/** Remove a copy: its dependency links first (unlinked, so nothing is deleted through them), then the worktree. */
export function removeCopy(root: string, copy: Copy): void {
  for (const rel of copy.links) {
    try {
      fs.unlinkSync(path.join(copy.dir, rel));
    } catch {
      // Already gone.
    }
  }
  try {
    git(root, ['worktree', 'remove', '--force', copy.dir]);
  } catch {
    fs.rmSync(copy.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    try {
      git(root, ['worktree', 'prune']);
    } catch {
      // Nothing to prune.
    }
  }
}

/** Apply a patch to the working tree; throws with git's reason when it does not apply. */
export function applyPatch(root: string, patch: string): void {
  git(root, ['apply', '--binary', '--whitespace=nowarn'], patch);
}
