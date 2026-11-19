import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { debug } from '../util/log';

/**
 * A git repository of Favilla's own beside the workspace (never the user's .git): the folder as it was when each turn
 * began and ended, so a turn's changes can be undone whoever made them, a file tool or a command (`sed -i`, a
 * generator, `npm install`, a deleted file). People who never use git get the same undo as those who do.
 *
 * Kept small: content is stored once across all snapshots and sessions of the folder, what the project's
 * .gitignore leaves out is left out here too, as are installs and builds, files over 20 MB and nested
 * repositories. Each snapshot is a commit of its own under refs/favilla/, so old ones are simply dropped.
 * A folder too big to snapshot quickly is left to the file tools' own snapshots.
 */
const EXCLUDE = [
  '.git/',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.parcel-cache/',
  '.gradle/',
  '.idea/',
  '.vs/',
  'dist/',
  'build/',
  'out/',
  'target/',
  'coverage/',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
];
const BIG = 20 * 1024 * 1024;
/** Past this many files the folder is left to the file tools' snapshots. */
const MAX_FILES = 40_000;
const SLOW_MS = 90_000;
const SEED_MIN_FILES = 400;
const SEED_MS = 20_000;

/** git's own variables from a calling process (a hook, a script) would point it somewhere else. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_AUTHOR_NAME: 'Favilla', GIT_AUTHOR_EMAIL: 'favilla@localhost', GIT_COMMITTER_NAME: 'Favilla', GIT_COMMITTER_EMAIL: 'favilla@localhost', GIT_TERMINAL_PROMPT: '0' };
}

/** Paths for `cat-file --batch`, a few hundred a process; one with a line break cannot be asked that way. */
function batches(rels: string[]): string[][] {
  const ok = rels.filter((r) => !r.includes('\n'));
  const out: string[][] = [];
  for (let i = 0; i < ok.length; i += 400) out.push(ok.slice(i, i + 400));
  return out;
}

/** `cat-file --batch` output, one answer per path asked, in order: "<id> blob <size>" and the bytes, or "… missing". */
function readBatch(buf: Buffer, asked: string[], out: Map<string, Buffer | null>): void {
  let at = 0;
  for (const rel of asked) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) return;
    const head = /^[0-9a-f]+ (\w+) (\d+)$/.exec(buf.toString('utf8', at, nl));
    at = nl + 1;
    if (!head) {
      out.set(rel, null);
      continue;
    }
    const size = Number(head[2]);
    out.set(rel, head[1] === 'blob' ? Buffer.from(buf.subarray(at, at + size)) : null);
    at += size + 1;
  }
}

/** Snapshots of one folder share an index: one at a time in this process. */
const queues = new Map<string, Promise<unknown>>();

export class Shadow {
  private last: { tree: string; commit: string } | null = null;
  private off: string | null = null;

  constructor(
    readonly cwd: string,
    readonly dir: string,
  ) {
    try {
      this.off = fs.readFileSync(path.join(dir, 'favilla-off'), 'utf8') || 'off';
    } catch {
      /* in use */
    }
  }

  /** Why this folder has no snapshots, or null when it has them. */
  get disabled(): string | null {
    return this.off;
  }

  private args(extra: string[]): string[] {
    // Bytes as they are on disk: no line-ending conversion, and no LFS filter (Git for Windows turns it on for every
    // repository; it would store pointers here and copy the content again under lfs/).
    const filters = ['filter.lfs.clean=', 'filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false'].flatMap((c) => ['-c', c]);
    return ['--git-dir', this.dir, '--work-tree', this.cwd, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false', '-c', 'core.longpaths=true', '-c', 'gc.auto=0', '-c', 'advice.addEmbeddedRepo=false', ...filters, ...extra];
  }

  private run(extra: string[], input?: string, ms = SLOW_MS, options?: { project?: boolean; env?: NodeJS.ProcessEnv }): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn('git', options?.project ? extra : this.args(extra), { cwd: this.cwd, env: { ...gitEnv(), ...options?.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill(), ms);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, out, err: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, out, err });
      });
      child.stdin.end(input ?? '');
    });
  }

  private async disable(why: string): Promise<void> {
    this.off = why;
    debug('shadow', `snapshots off for ${this.cwd}`, why);
    try {
      // What was stored so far is of no use: the folder is left to the file tools' snapshots.
      for (const name of await fs.promises.readdir(this.dir)) if (name !== 'favilla-off') await fs.promises.rm(path.join(this.dir, name), { recursive: true, force: true });
      fs.writeFileSync(path.join(this.dir, 'favilla-off'), why);
    } catch {
      /* gone already */
    }
  }

  private async ensure(): Promise<boolean> {
    if (fs.existsSync(path.join(this.dir, 'HEAD'))) return true;
    fs.mkdirSync(this.dir, { recursive: true });
    const r = await new Promise<number>((resolve) => {
      const c = spawn('git', ['init', '--bare', '--quiet', this.dir], { env: gitEnv(), windowsHide: true, stdio: 'ignore' });
      c.on('error', () => resolve(-1));
      c.on('close', (code) => resolve(code ?? -1));
    });
    if (r !== 0) {
      this.off = 'git is not available';
      return false;
    }
    fs.mkdirSync(path.join(this.dir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'info', 'exclude'), `${EXCLUDE.join('\n')}\n`);
    return true;
  }

  /** Files over 20 MB about to be taken in are left out from now on. */
  private async leaveOutBig(): Promise<number> {
    const r = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
    if (r.code !== 0) return 0;
    const items = r.out.split('\0').filter(Boolean);
    const big: string[] = [];
    for (const item of items) {
      const rel = item.slice(3);
      if (!rel || item.startsWith(' D') || item.startsWith('D ')) continue;
      try {
        if ((await fs.promises.stat(path.join(this.cwd, rel))).size > BIG) big.push(`/${rel.replace(/^\/+/, '')}`);
      } catch {
        /* gone meanwhile */
      }
    }
    if (big.length) fs.appendFileSync(path.join(this.dir, 'info', 'exclude'), `${big.join('\n')}\n`);
    return items.length - big.length;
  }

  /**
   * On Windows, writing thousands of loose objects dominates a cold add. The project's objects are usable only by
   * hash: the shadow index still has to read the working files with its own ignore, mode and filter rules. Pack the
   * resulting tree into our own store before installing the index, so the snapshot can outlive the project.
   */
  private async seedIndex(index: string): Promise<string | null> {
    const deadline = Date.now() + SEED_MS;
    const timeLeft = () => Math.max(1, deadline - Date.now());
    let temp: string | undefined;
    try {
      const [project, shadow] = await Promise.all([
        this.run(['rev-parse', '--path-format=absolute', '--show-object-format', '--git-path', 'objects'], undefined, timeLeft(), { project: true }),
        this.run(['rev-parse', '--show-object-format'], undefined, timeLeft()),
      ]);
      const [format, objects] = project.out.trimEnd().split(/\r?\n/);
      if (project.code || shadow.code || format !== shadow.out.trim() || !objects || !path.isAbsolute(objects)) return null;
      temp = fs.mkdtempSync(path.join(this.dir, 'seed-'));
      const env = { GIT_INDEX_FILE: path.join(temp, 'index'), GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects.split(path.sep).join('/')), GIT_NO_LAZY_FETCH: '1' };
      const add = await this.run(['add', '-A', '--ignore-errors', '.'], undefined, timeLeft(), { env });
      if (add.code) return null;
      const written = await this.run(['write-tree'], undefined, timeLeft(), { env });
      const tree = written.out.trim();
      if (written.code || !/^[0-9a-f]{40,64}$/.test(tree)) return null;
      const pack = await this.run(['pack-objects', '--quiet', '--revs', path.join(this.dir, 'objects', 'pack', 'pack')], tree + '\n', timeLeft(), { env });
      if (pack.code) return null;
      // Publish under Git's index lock. A concurrent add may already be preparing its own index.
      const lock = `${index}.lock`;
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.linkSync(env.GIT_INDEX_FILE, index);
      } finally {
        fs.closeSync(fd);
        fs.unlinkSync(lock);
      }
      return tree;
    } catch {
      return null;
    } finally {
      if (temp) {
        try { await fs.promises.rm(temp, { recursive: true, force: true }); } catch { /* a closed Git process may still be releasing it */ }
      }
    }
  }

  /** Take the folder as it is now; resolves to the snapshot's id, or null when there is none to be had. */
  snapshot(label: string): Promise<string | null> {
    const prev = queues.get(this.dir) ?? Promise.resolve();
    const next = prev.then(() => this.take(label));
    const queued = next.catch(() => null);
    queues.set(this.dir, queued);
    void queued.then(() => {
      if (queues.get(this.dir) === queued) queues.delete(this.dir);
    });
    return next;
  }

  private async take(label: string): Promise<string | null> {
    if (this.off || !(await this.ensure())) return null;
    let started = Date.now();
    // A lock a crashed snapshot left behind.
    const lock = path.join(this.dir, 'index.lock');
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { force: true });
    } catch {
      /* none */
    }
    const listed = await this.leaveOutBig();
    const index = path.join(this.dir, 'index');
    const beforeSeed = Date.now();
    const seeded = process.platform === 'win32' && listed >= SEED_MIN_FILES && !fs.existsSync(index) ? await this.seedIndex(index) : null;
    if (!seeded) {
      started += Date.now() - beforeSeed;
      const add = await this.run(['add', '-A', '--ignore-errors', '.']);
      if (add.code !== 0 && !/unable to index|could not open|Permission denied/i.test(add.err)) {
        debug('shadow', 'add failed', add.err.slice(0, 300));
        if (add.code === -1 && Date.now() - started >= SLOW_MS - 1000) await this.disable('the folder takes too long to snapshot');
        return null;
      }
    }
    if (!this.last) {
      const count = (await this.run(['ls-files', '-z'])).out.split('\0').filter(Boolean).length;
      if (count > MAX_FILES) {
        await this.disable(`the folder has ${count} files`);
        return null;
      }
    }
    if (Date.now() - started > SLOW_MS) {
      await this.disable('the folder takes too long to snapshot');
      return null;
    }
    const tree = seeded ?? (await this.run(['write-tree'])).out.trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return null;
    if (this.last?.tree === tree) return this.last.commit;
    const commit = (await this.run(['commit-tree', tree, '-m', label])).out.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return null;
    await this.run(['update-ref', `refs/favilla/${Date.now()}-${commit.slice(0, 8)}`, commit]);
    this.last = { tree, commit };
    // Once a day, snapshots older than a month go, with what only they held.
    const stamp = path.join(this.dir, 'favilla-pruned');
    let pruned = 0;
    try {
      pruned = fs.statSync(stamp).mtimeMs;
    } catch {
      fs.writeFileSync(stamp, '');
      pruned = Date.now();
    }
    if (Date.now() - pruned > 86400_000) {
      fs.writeFileSync(stamp, '');
      await this.prune(30);
    }
    return commit;
  }

  /** Paths (relative, with /) that differ between two snapshots. */
  async changed(from: string, to: string): Promise<string[]> {
    if (from === to) return [];
    const r = await this.run(['diff', '--name-only', '-z', '--no-renames', '--ignore-submodules=all', from, to]);
    return r.code === 0 ? r.out.split('\0').filter(Boolean) : [];
  }

  /** A file's content in a snapshot; null when it was not there. */
  show(at: string, rel: string): Promise<Buffer | null> {
    return new Promise((resolve) => {
      execFile('git', this.args(['cat-file', 'blob', `${at}:${rel}`]), { cwd: this.cwd, env: gitEnv(), windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: SLOW_MS }, (err, stdout) => resolve(err ? null : stdout));
    });
  }

  /** Read snapshot contents in batches. Paths containing newlines use individual blob reads. */
  async showMany(at: string, rels: string[]): Promise<Map<string, Buffer | null>> {
    const out = new Map<string, Buffer | null>();
    for (const part of batches(rels)) {
      const stdout = await new Promise<Buffer | null>((resolve) => {
        const child = spawn('git', this.args(['cat-file', '--batch']), { cwd: this.cwd, env: gitEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => child.kill(), SLOW_MS);
        child.stdout.on('data', (d: Buffer) => chunks.push(d));
        child.on('error', () => {
          clearTimeout(timer);
          resolve(null);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(code === 0 ? Buffer.concat(chunks) : null);
        });
        child.stdin.end(part.map((rel) => `${at}:${rel}\n`).join(''));
      });
      if (stdout) readBatch(stdout, part, out);
    }
    for (const rel of rels) if (!out.has(rel)) out.set(rel, await this.show(at, rel));
    return out;
  }

  /** Put these paths back as they were in a snapshot: written where they were there, deleted where they were not. */
  async restore(at: string, rels: string[]): Promise<string[]> {
    const done: string[] = [];
    if (!rels.length) return done;
    // A snapshot that is gone (pruned after 30 days, or the folder's snapshots switched off and wiped) lists nothing,
    // and every path read as absent then was deleted, while the restore said it had put them back (2026-11-06): with
    // no snapshot to read, nothing is touched.
    if (this.off) return done;
    const tree = await this.run(['ls-tree', '-r', '-z', '--name-only', at]);
    if (tree.code !== 0) return done;
    const present = new Set(tree.out.split('\0').filter(Boolean));
    const back = rels.filter((r) => present.has(r));
    if (back.length && (await this.run(['checkout', at, '--pathspec-from-file=-', '--pathspec-file-nul'], back.join('\0'))).code === 0) done.push(...back);
    for (const rel of rels.filter((r) => !present.has(r))) {
      try {
        await fs.promises.rm(path.join(this.cwd, rel), { force: true });
        done.push(rel);
      } catch {
        /* held open */
      }
    }
    return done;
  }

  private get workLog(): string {
    return path.join(this.dir, 'favilla-work');
  }

  /**
   * Who worked in this folder when, for every session and process that has it: a turn's start (s) and end (e), and
   * each file a session's tools wrote (w). An undo reads it to leave other sessions' work alone.
   */
  note(writer: string, kind: 's' | 'e' | 'w', file = ''): void {
    if (this.off) return;
    const rel = file ? path.relative(this.cwd, file).split(path.sep).join('/') : '';
    if (rel.startsWith('..')) return;
    try {
      fs.appendFileSync(this.workLog, `${Date.now()}\t${writer}\t${kind}\t${rel}\n`);
    } catch {
      /* no snapshots here yet */
    }
  }

  /**
   * What other writers did in this folder since `since` (ms): whether any of them worked here meanwhile (a turn open
   * or ended since then, or a file written), and the files their tools wrote, lower-cased. `own` names writers whose
   * lines count as this one's up to a time: a branch's source, until the branch was made.
   */
  othersSince(writer: string, since: number, own: Record<string, number> = {}): { active: boolean; wrote: Set<string> } {
    const wrote = new Set<string>();
    const open = new Map<string, number>();
    let active = false;
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(this.workLog, 'utf8').split('\n');
    } catch {
      return { active, wrote };
    }
    for (const line of lines) {
      const [t, w, kind, rel] = line.split('\t');
      const at = Number(t);
      if (!kind || w === writer || !Number.isFinite(at) || at <= (own[w] ?? -1)) continue;
      if (kind === 's') open.set(w, at);
      else if (kind === 'e') {
        if (at >= since) active = true;
        open.delete(w);
      } else if (kind === 'w' && at >= since) {
        active = true;
        if (rel) wrote.add(rel.toLowerCase());
      }
    }
    // A turn still open counts unless it is a day old: a process that died leaves its last turn open.
    for (const at of open.values()) if (at > Date.now() - 86400_000) active = true;
    return { active, wrote };
  }

  /** Drop snapshots older than `days`, and what only they held. */
  async prune(days = 30): Promise<void> {
    if (this.off || !fs.existsSync(path.join(this.dir, 'HEAD'))) return;
    const cutoff = Date.now() - days * 86400_000;
    try {
      const kept = fs.readFileSync(this.workLog, 'utf8').split('\n').filter((l) => Number(l.split('\t')[0]) >= cutoff);
      fs.writeFileSync(this.workLog, kept.length ? `${kept.join('\n')}\n` : '');
    } catch {
      /* no log yet */
    }
    // Every snapshot ref, under whatever name the app had when it was written: those of a former name go the same way.
    const refs = (await this.run(['for-each-ref', '--format=%(refname)', 'refs/'])).out.split('\n').filter(Boolean);
    const old = refs.filter((r) => Number(/^refs\/\w+\/(\d+)-[0-9a-f]{8}$/.exec(r)?.[1] ?? Date.now()) < cutoff);
    if (!old.length) return;
    await this.run(['update-ref', '--stdin'], old.map((r) => `delete ${r}\n`).join(''));
    // An hour's grace: another process may be writing a snapshot of this folder right now.
    await this.run(['gc', '--prune=1.hour.ago', '--quiet'], undefined, 10 * 60_000);
  }
}
