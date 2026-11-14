import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { which, killLeaf } from '../util/proc';
import { addAgentPath } from './shell';
import { decodeOutput } from '../util/text';

let cached: string | null | undefined;

/** Bundled ripgrep if its binary was installed, otherwise the one on PATH. */
export function ripgrepPath(): string | null {
  if (cached !== undefined) return cached;
  const given = process.env.FAVILLA_RG;
  if (given && fs.existsSync(given)) {
    // The desktop app ships rg in a folder of its own; commands get it too unless one is installed already.
    if (!which('rg')) addAgentPath(path.dirname(given));
    return (cached = given);
  }
  try {
    const require = createRequire(import.meta.url);
    const p = (require('@vscode/ripgrep') as { rgPath: string }).rgPath.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(p)) {
      addAgentPath(path.dirname(p));
      return (cached = p);
    }
  } catch {
    /* platform package missing */
  }
  return (cached = which('rg'));
}

export interface RgResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Stopped at the time limit: stdout holds what was found until then. */
  timedOut?: boolean;
}

/** How long one search may run: a search over a whole drive or home folder otherwise goes on for minutes. */
export const SEARCH_LIMIT_MS = 45_000;

/** Files newest first, by their modification time (unreadable ones last), for results that are already found. */
export function newestFirst(files: string[], cwd: string): string[] {
  const at = new Map(
    files.map((f) => {
      try {
        return [f, fs.statSync(path.resolve(cwd, f)).mtimeMs] as const;
      } catch {
        return [f, 0] as const;
      }
    }),
  );
  return [...files].sort((a, b) => at.get(b)! - at.get(a)!);
}

/** Run ripgrep, stopping early once enough output has arrived. */
export function runRipgrep(args: string[], cwd: string, signal: AbortSignal, maxBytes = 4_000_000, limitMs = SEARCH_LIMIT_MS): Promise<RgResult> {
  const rg = ripgrepPath();
  if (!rg) return Promise.resolve({ code: 2, stdout: '', stderr: 'ripgrep (rg) was not found. Install it or set FAVILLA_RG.', truncated: false });
  return new Promise((resolve) => {
    const child = spawn(rg, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    const onAbort = () => killLeaf(child);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killLeaf(child);
    }, limitMs);
    child.stdout.on('data', (d: Buffer) => {
      if (truncated) return;
      size += d.length;
      out.push(d);
      if (size > maxBytes) {
        truncated = true;
        killLeaf(child);
      }
    });
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => (clearTimeout(timer), resolve({ code: 2, stdout: '', stderr: String(e), truncated: false })));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code: truncated || (timedOut && size) ? 0 : timedOut ? 1 : code, stdout: decodeOutput(Buffer.concat(out)), stderr: decodeOutput(Buffer.concat(err)), truncated, timedOut });
    });
  });
}
