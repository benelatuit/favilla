import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appPath, ensureDir } from '../util/paths';
import { readSettingDocument, settingNotice, SettingsError, SettingsFileError, type SettingReporter } from '../config/document';
import { checkedCredentials, isObject } from '../config/schema';
import { settingsWords } from '../i18n';

/** Credentials Favilla owns, kept in ~/.favilla/auth.json (owner-only permissions where the OS allows). */
export interface AuthFile {
  keys?: Record<string, string>;
}

export function authPath(): string {
  return appPath('auth.json');
}

/** Serialize a read and its replacement across Favilla processes, including aliases of a config file. */
export function withFileUpdate<T>(file: string, run: (stillHeld: () => void) => T): T {
  const dir = ensureDir(path.dirname(file));
  let target: string;
  try {
    target = fs.realpathSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw e;
    target = path.join(fs.realpathSync(dir), path.basename(file));
  }
  const lock = `${target}.edit-lock`;
  const mark = `${process.pid}-${randomUUID()}`;
  const owner = path.join(lock, mark);
  const busy = () => new SettingsError({ key: settingsWords.busy, vars: { file } });
  const deadline = performance.now() + 1500;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (performance.now() >= deadline) throw busy();
      try {
        const [holder] = fs.readdirSync(lock);
        const pid = holder?.match(/^(\d+)-[a-f\d-]{36}$/)?.[1];
        // The gate covers one synchronous edit. A dead writer's PID may already name another program.
        let stale = Date.now() - fs.statSync(lock).mtimeMs > 5000;
        if (!stale && pid) {
          try { process.kill(Number(pid), 0); }
          catch (e) { stale = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
        }
        if (stale) {
          if (holder) fs.unlinkSync(path.join(lock, holder));
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        // The writer, or another waiter reaping a dead writer, already let it go.
      }
      pauseSync(10);
    }
  }
  let marked = false;
  const stillHeld = () => {
    let names: string[];
    try { names = fs.readdirSync(lock); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw busy();
      throw e;
    }
    if (names.length !== 1 || names[0] !== mark) throw busy();
  };
  try {
    fs.writeFileSync(owner, '');
    marked = true;
    stillHeld();
    return run(stillHeld);
  } finally {
    // A writer that slept through a takeover must not remove the next writer's gate.
    try {
      if (marked) fs.unlinkSync(owner);
      fs.rmdirSync(lock);
    } catch (e) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    }
  }
}

let lastAuth: { file: string; value: AuthFile } | undefined;

export function readAuthFile(report?: SettingReporter, phase: 'start' | 'reload' = 'reload', raw?: (value: Record<string, unknown>) => void): AuthFile {
  const file = authPath();
  try {
    const { value, source } = readSettingDocument(file, { credentials: true });
    raw?.(value);
    const auth = checkedCredentials(value, (key) => report?.(settingNotice(source, settingsWords.value, { key }))) as AuthFile;
    lastAuth = { file, value: auth };
    return auth;
  } catch (e) {
    if (!(e instanceof SettingsFileError)) throw e;
    report?.(e.notice(phase));
    if (phase === 'start' && lastAuth?.file === file) lastAuth = undefined;
    return lastAuth?.file === file ? lastAuth.value : {};
  }
}

export function writeAuthFile(next: AuthFile): void {
  updateAuthFile(() => next);
}

export function updateAuthFile(fn: (current: AuthFile) => AuthFile): AuthFile {
  const file = authPath();
  return withFileUpdate(file, (stillHeld) => {
    const { value, text, encode } = readSettingDocument(file, { editing: true, credentials: true });
    for (const key of ['keys', 'mail'] as const) {
      if (Object.hasOwn(value, key) && !isObject(value[key])) throw new SettingsError({ key: settingsWords.value, vars: { file, key } });
    }
    const next = fn(value as AuthFile);
    if (next === value) return next;
    const eol = /\r\n|\n|\r/.exec(text)?.[0] ?? '\n';
    writeFileAtomic(file, encode(JSON.stringify(next, null, 2).replace(/\n/g, eol) + eol), { beforeReplace: stillHeld });
    return next;
  });
}

/** A lock this old was left by a process that died holding it. */
const AUTH_LOCK_STALE_MS = 30_000;

/**
 * Runs `fn` while no other Favilla process runs one on the same auth file: a directory beside it that only one can make.
 * The holder keeps it fresh while `fn` runs; one older than 30 s belongs to a process that died, and is taken over.
 */
export async function withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${authPath()}.lock`;
  ensureDir(path.dirname(lock));
  for (let waited = 0; ; waited += 50) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > AUTH_LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* gone meanwhile */
      }
      if (waited > 2 * AUTH_LOCK_STALE_MS) throw new Error('Could not take the lock on the sign-in file');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const keep = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lock, now, now);
    } catch {
      /* best effort */
    }
  }, 5_000);
  try {
    return await fn();
  } finally {
    clearInterval(keep);
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Wait without leaving the call: for the few places that must stay synchronous. */
export function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows refuses to replace a file another process has open for that moment. */
function renameRetrying(from: string, to: string): void {
  for (let tries = 0; ; tries++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (tries >= 25 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      pauseSync(20);
    }
  }
}

/**
 * Write via a temp file and rename so a crash never leaves half a file: a credentials file only its owner reads, or
 * with `own` a file the user keeps (config.json, rules, notes), which keeps its mode and, when it is a link (dotfiles
 * kept elsewhere), is written where the link points, the link left as it is.
 */
export function writeFileAtomic(file: string, data: string | Buffer, o: { own?: boolean; beforeReplace?: () => void } = {}): void {
  let mode = 0o600;
  if (o.own) {
    try {
      file = fs.realpathSync(file);
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      mode = 0o644;
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  try {
    o.beforeReplace?.();
    renameRetrying(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* Windows ignores POSIX modes */
  }
}
