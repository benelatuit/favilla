import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The project as it was before this session changed it, beside the real one. A partial fix passes the agent's
 * own tests as well as a complete one does, so nothing in a turn tells them apart; the agent's tests run against
 * the old code do: a test for a fix fails there. The copy keeps every file the session left alone, puts back the
 * source files it changed (and removes the ones it made), and holds the session's test files as they are now.
 */

/** Dependency and build-cache folders: linked into the copy, since the old code shares them. */
const LINKED = new Set(['node_modules', '.venv', 'venv', 'target', '.gradle']);
/** History, build output and caches: left out. */
const SKIPPED = new Set(['.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'coverage', '.favilla']);
const MAX_FILES = 40_000;
const MAX_BYTES = 400 * 1024 * 1024;
/** Copies older than this, or beyond the newest few, are removed when a new one is made. */
const KEEP_MS = 24 * 3600_000;
const KEEP_COPIES = 3;

const base = () => path.join(os.tmpdir(), 'favilla-before');

/** A test file by the usual names and places: Go, JS and TS, Python, Rust, Java and Kotlin, Ruby, C#. */
export function isTestFile(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  const name = p.split('/').pop() ?? '';
  return (
    /_test\.go$/.test(name) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /^test_.*\.py$|_test\.py$|^conftest\.py$/.test(name) ||
    /(Test|Tests|Spec)\.(java|kt|cs)$/.test(name) ||
    /_spec\.rb$|_test\.rb$/.test(name) ||
    /(^|\/)(__tests__|tests?|spec)\//.test(p)
  );
}

export function copyTree(from: string, to: string, signal?: AbortSignal): { files: number } | { error: string } {
  let files = 0;
  let bytes = 0;
  const walk = (src: string, dst: string): string | null => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (signal?.aborted) return 'copy interrupted';
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) {
        if (SKIPPED.has(e.name)) continue;
        if (LINKED.has(e.name)) {
          fs.symlinkSync(s, d, process.platform === 'win32' ? 'junction' : 'dir');
          continue;
        }
        const err = walk(s, d);
        if (err) return err;
      } else if (e.isFile()) {
        bytes += fs.statSync(s).size;
        if (++files > MAX_FILES || bytes > MAX_BYTES) return `the project is too large to copy (over ${MAX_FILES.toLocaleString('en')} files or ${MAX_BYTES / 1024 / 1024} MB outside its dependency folders)`;
        fs.copyFileSync(s, d);
      }
    }
    return null;
  };
  const err = walk(from, to);
  return err ? { error: err } : { files };
}

/** Old copies go: those of sessions long over, and all but the newest few. */
function prune(keep: string): void {
  let dirs: { dir: string; at: number }[] = [];
  try {
    dirs = fs.readdirSync(base()).map((d) => {
      const dir = path.join(base(), d);
      return { dir, at: fs.statSync(dir).mtimeMs };
    });
  } catch {
    return;
  }
  dirs.sort((a, b) => b.at - a.at);
  dirs.forEach((d, i) => {
    if (d.dir !== keep && (i >= KEEP_COPIES || Date.now() - d.at > KEEP_MS)) fs.rmSync(d.dir, { recursive: true, force: true, maxRetries: 3 });
  });
}

/**
 * The copy for a session, made on first use and brought up to date with what the session changed since.
 * `originals` holds each changed file as it was before the session first touched it (null: it did not exist).
 */
export function beforeTree(cwd: string, sessionId: string, originals: Map<string, Buffer | null>): { root: string } | { error: string } {
  const root = path.join(base(), sessionId.replace(/[^\w-]/g, '_'));
  const stamp = path.join(root, '.favilla-before');
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== cwd) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    prune(root);
    const made = copyTree(cwd, root);
    if ('error' in made) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      return made;
    }
    fs.writeFileSync(stamp, cwd);
  }
  for (const [abs, before] of originals) {
    const rel = path.relative(cwd, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const at = path.join(root, rel);
    // The agent's tests as they are now; the code under them as it was.
    const now = isTestFile(rel) ? (fs.existsSync(abs) ? fs.readFileSync(abs) : null) : before;
    if (now === null) fs.rmSync(at, { force: true });
    else {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, now);
    }
  }
  fs.utimesSync(root, new Date(), new Date());
  return { root };
}

/** The test files this session added or changed, as they are now, and a key that changes when any of them does. */
export function changedTests(cwd: string, originals: Map<string, Buffer | null>): { files: string[]; key: string } {
  const files: string[] = [];
  const hash = createHash('sha1');
  for (const [abs, before] of originals) {
    const rel = path.relative(cwd, abs);
    if (!rel || rel.startsWith('..') || !isTestFile(rel) || !fs.existsSync(abs)) continue;
    const now = fs.readFileSync(abs);
    if (before && before.equals(now)) continue;
    files.push(rel.replace(/\\/g, '/'));
    hash.update(rel).update(now);
  }
  return { files: files.sort(), key: hash.digest('hex') };
}

/** Go test functions in `now` that `before` did not have (all of them when it was a new file). */
export function newGoTests(before: string | null, now: string): string[] {
  const names = (text: string) => new Set([...text.matchAll(/^func (Test\w+|Fuzz\w+)\s*\(/gm)].map((m) => m[1]));
  const old = before ? names(before) : new Set<string>();
  return [...names(now)].filter((n) => !old.has(n));
}
