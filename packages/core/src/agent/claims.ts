import path from 'node:path';
import { isWindows, toForward } from '../util/paths';

/**
 * Which files each running sub-agent may change. A sub-agent that changes files names them (paths, folders
 * or globs); one that names none may change anything. Two whose files could overlap never run at the same
 * time: the later one waits for the earlier to finish, so parallel agents never edit the same file.
 */
export class Claims {
  private active = new Map<string, { label: string; patterns: string[] | null }>();
  private waiters: (() => void)[] = [];

  constructor(private cwd: string) {}

  /** Wait until nothing running overlaps `patterns` (null: everything), then hold them. */
  async acquire(id: string, label: string, patterns: string[] | null, onWait: (holder: string) => void, signal: AbortSignal): Promise<void> {
    const want = patterns && patterns.map((p) => this.norm(p));
    for (;;) {
      const holder = [...this.active.values()].find((c) => overlaps(c.patterns, want));
      if (!holder) break;
      onWait(holder.label);
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal.removeEventListener('abort', stop);
          resolve();
        };
        const stop = () => {
          this.waiters = this.waiters.filter((w) => w !== done);
          reject(new Error('Stopped while waiting for another sub-agent.'));
        };
        signal.addEventListener('abort', stop, { once: true });
        this.waiters.push(done);
      });
    }
    this.active.set(id, { label, patterns: want });
  }

  release(id: string): void {
    if (!this.active.delete(id)) return;
    for (const w of this.waiters.splice(0)) w();
  }

  /**
   * For the agent that started them: null when no sub-agent running in the background holds `abs`, otherwise
   * why the change waits. Two hands on one file undo each other's work.
   */
  heldElsewhere(abs: string, background: Set<string>): string | null {
    const rel = this.norm(abs);
    for (const [id, c] of this.active) {
      if (!background.has(id) || !c.patterns?.some((p) => covers(p, rel))) continue;
      return `The background sub-agent "${c.label}" is changing ${rel}, so this change was refused. Work on other files until its report comes back, then build on what it did.`;
    }
    return null;
  }

  /** null when the agent holding `patterns` may change `abs`, otherwise why not. */
  check(patterns: string[] | null, abs: string): string | null {
    if (!patterns) return null;
    const rel = this.norm(abs);
    if (patterns.some((p) => covers(this.norm(p), rel))) return null;
    return `Your brief lets you change only ${patterns.join(', ')}; ${rel} is not among them, so the change was refused. If the work needs it, say so in your report.`;
  }

  /** Relative to the project, forward slashes, lower case where the file system ignores case. */
  private norm(p: string): string {
    const abs = path.isAbsolute(p) ? p : path.join(this.cwd, p);
    let rel = toForward(path.relative(this.cwd, abs)).replace(/\/+$/, '');
    if (isWindows) rel = rel.toLowerCase();
    return rel || '.';
  }
}

const WILD = /[*?[{]/;

/** The part of a pattern before its first wildcard, cut at a folder boundary: what every match starts with. */
function stem(p: string): string {
  const i = p.search(WILD);
  if (i < 0) return p;
  const head = p.slice(0, i);
  return head.slice(0, head.lastIndexOf('/') + 1).replace(/\/$/, '');
}

function globRe(p: string): RegExp {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      re += '.*';
      i++;
      if (p[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Whether pattern `p` (a file, a folder or a glob) covers the file `rel`. */
function covers(p: string, rel: string): boolean {
  if (p === '.' || p === rel || rel.startsWith(`${p}/`)) return true;
  return WILD.test(p) && globRe(p).test(rel);
}

/** One path inside or equal to another (folders contain what is below them). */
function nested(a: string, b: string): boolean {
  return a === b || a === '.' || b === '.' || !a || !b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** A path whose last part has no extension is taken for a folder. */
const folderLike = (p: string) => !/\.[^/]+$/.test(p);

/** Whether a glob and a plain path could name the same file. */
function globMeets(glob: string, plain: string): boolean {
  if (covers(glob, plain)) return true;
  const s = stem(glob);
  // A folder at or above where the glob starts holds its matches; a folder below it may.
  return folderLike(plain) && nested(s, plain);
}

/** Whether two claims could touch the same file; when unsure, they could. */
function overlaps(a: string[] | null, b: string[] | null): boolean {
  if (!a || !b) return true;
  for (const x of a) {
    for (const y of b) {
      const gx = WILD.test(x);
      const gy = WILD.test(y);
      if (!gx && !gy ? nested(x, y) : gx && gy ? nested(stem(x), stem(y)) : gx ? globMeets(x, y) : globMeets(y, x)) return true;
    }
  }
  return false;
}

export const claimsForTest = { covers, overlaps, stem };
