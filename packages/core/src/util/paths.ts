import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FORMER_NAME } from '../former-name';
import { shortHash } from './id';

export const isWindows = process.platform === 'win32';

/** A batch read's selector, unless the path is a literal filename containing a colon. */
export function readSelector(spec: string, cwd?: string): { path: string; offset?: number; limit?: number; tail?: number; full?: boolean } {
  const m = /^(.+?):(?:(\d+)(?:-(\d+))?|-(\d+)|(full))$/.exec(spec.trim());
  if (!m || (cwd && fs.existsSync(resolvePath(cwd, spec)))) return { path: spec };
  if (m[5]) return { path: m[1], full: true };
  if (m[4]) return { path: m[1], tail: Number(m[4]) };
  const start = Number(m[2]);
  const end = Number(m[3]);
  return { path: m[1], offset: start, limit: end && end >= start ? end - start + 1 : undefined };
}

/** The user's own data folder, read before a test can stand another home folder in for it. */
const userHome = path.join(os.homedir(), '.favilla');
const samePath = (a: string, b: string) => (isWindows ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/**
 * Root of everything Favilla stores on this machine: FAVILLA_HOME, else ~/.favilla, and no other folder. While the
 * folder of the app's old name was read until one of the new name existed, a test run that made the new one beside it
 * took over from it: the running app's next settings read found none of the user's settings, providers or permissions.
 */
export function appHome(): string {
  refuseOldVariables();
  const home = process.env.FAVILLA_HOME || path.join(os.homedir(), '.favilla');
  // A test never reaches the user's own folder, however it was started (vitest.shared.ts gives each run one of its own).
  if (process.env.VITEST && samePath(home, userHome)) throw new Error(`A test asked for the user's own ${userHome}: give it a FAVILLA_HOME of its own.`);
  return home;
}

/** What variables under the app's former name start with (its _HOME, _CONFINE, ...); none in a build that had no other. */
const FORMER_PREFIX = FORMER_NAME && `${FORMER_NAME.toUpperCase()}_`;

/**
 * Variables under the app's former name, which it no longer reads. One that is still set comes from a script written
 * for that name, and passing it over would do what the script was there to prevent: a test meant to have a folder of
 * its own would run on the user's data, an agent meant to be confined would not be.
 */
export function oldVariableNames(env: NodeJS.ProcessEnv): string[] {
  return FORMER_PREFIX ? Object.keys(env).filter((k) => k.toUpperCase().startsWith(FORMER_PREFIX)) : [];
}

let variablesChecked = false;

/** The app stops and names them, where the data folder is first asked for: every way of starting it goes through here. */
function refuseOldVariables(): void {
  if (variablesChecked) return;
  const old = oldVariableNames(process.env);
  if (old.length) throw new Error(`${old.join(', ')}: these are read as FAVILLA_ variables now (${FORMER_PREFIX} was the app's former name). Rename them and start again.`);
  variablesChecked = true;
}

export function appPath(...segments: string[]): string {
  return path.join(appHome(), ...segments);
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stable folder name for a project directory. */
export function projectSlug(cwd: string): string {
  const base = path.basename(cwd).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root';
  return `${base}-${shortHash(normalizeForCompare(cwd), 8)}`;
}

export function normalizeForCompare(p: string): string {
  const n = path.resolve(p);
  return isWindows ? n.toLowerCase() : n;
}

/**
 * Resolve a model-supplied path. Accepts absolute paths, paths relative to cwd, `~`,
 * and Git Bash / MSYS style paths (/c/Users/...) on Windows.
 */
export function resolvePath(cwd: string, input: string): string {
  let p = input.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1);
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  if (isWindows) {
    const msys = /^\/([a-zA-Z])(\/|$)(.*)$/.exec(p);
    if (msys) p = `${msys[1].toUpperCase()}:\\${msys[3].replace(/\//g, '\\')}`;
    const cyg = /^\/cygdrive\/([a-zA-Z])\/(.*)$/.exec(p);
    if (cyg) p = `${cyg[1].toUpperCase()}:\\${cyg[2].replace(/\//g, '\\')}`;
    // Git Bash's /tmp is the user's temp folder, so a script written to /tmp/x.py is the one `python /tmp/x.py`
    // runs (it used to land in C:\tmp).
    const tmp = /^\/tmp(\/.*)?$/.exec(p);
    if (tmp) p = path.join(os.tmpdir(), (tmp[1] ?? '').replace(/\//g, '\\'));
  }
  return path.resolve(cwd, p);
}

/** Path as shown to the model and the user: relative inside cwd, absolute outside. */
export function displayPath(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs);
  if (!rel) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return toForward(abs);
  return toForward(rel);
}

/**
 * A folder as a person reads it: one under the user's home starts with ~, as the window shows it, so the account name
 * does not ride along in a screenshot of the terminal; any other stays as it is.
 */
export function homePath(p: string, home = os.homedir()): string {
  const rel = path.relative(normalizeForCompare(home), normalizeForCompare(p));
  if (!rel) return '~';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return toForward(p);
  return `~/${toForward(path.relative(home, p))}`;
}

export function toForward(p: string): string {
  return isWindows ? p.replace(/\\/g, '/') : p;
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Locate the shipped `assets` directory both from source (dev) and from a bundle. */
export function assetsDir(): string {
  const envAssets = process.env.FAVILLA_ASSETS;
  if (envAssets && dirExists(envAssets)) return envAssets;
  // fileURLToPath: a URL's pathname keeps %20 and other escapes, and a folder with a space or a non-ASCII name
  // (D:\My Projects, C:\Users\张三) was not found (2026-11-06).
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'assets');
    if (dirExists(path.join(candidate, 'prompts'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('Favilla assets directory not found; set FAVILLA_ASSETS');
}
