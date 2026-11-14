import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isWindows } from './paths';
import { decodeOutput } from './text';

const whichCache = new Map<string, string | null>();

/** Find an executable on PATH (honours PATHEXT on Windows). */
export function which(cmd: string): string | null {
  if (whichCache.has(cmd)) return whichCache.get(cmd)!;
  let found: string | null = null;
  if (path.isAbsolute(cmd)) {
    found = fs.existsSync(cmd) ? cmd : null;
  } else {
    const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
    const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
    outer: for (const dir of dirs) {
      for (const ext of isWindows && path.extname(cmd) ? [''] : exts) {
        const candidate = path.join(dir, cmd + ext);
        try {
          if (fs.statSync(candidate).isFile()) {
            found = candidate;
            break outer;
          }
        } catch {
          /* keep looking */
        }
      }
    }
  }
  whichCache.set(cmd, found);
  return found;
}

/**
 * Stop a child we started and everything it started. A child whose exit Node has already seen is
 * not targeted by id: on Windows its id may belong to an unrelated process by now. When `started`
 * (the spawn time) is given, processes the exited child left behind are still found.
 */
export function killChild(child: ChildProcess, started?: number): Promise<void> {
  if (!child.pid) return Promise.resolve();
  const alive = child.exitCode === null && child.signalCode === null;
  return alive || started !== undefined ? killTree(child.pid, alive ? undefined : started).catch(() => {}) : Promise.resolve();
}

/** Stop a program known to have no children, without looking up a process tree. */
export function killLeaf(child: ChildProcess): void {
  if (!child.pid || child.killed || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

/**
 * Children that must not outlive this process (background jobs). The tree kill above is asynchronous and asks Windows
 * for its process table first (0.6 s), and `favilla -p` exits 250 ms after its answer, so a dev server started in the
 * run kept running. At exit whatever is still alive is ended synchronously.
 */
const lasting = new Set<ChildProcess>();
let exitHooked = false;

export function endWithProcess(child: ChildProcess): void {
  lasting.add(child);
  child.once('close', () => lasting.delete(child));
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => {
    for (const c of lasting) {
      if (!c.pid || c.exitCode !== null || c.signalCode !== null) continue;
      try {
        if (isWindows) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else process.kill(-c.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  });
}

interface ProcRow {
  pid: number;
  ppid: number;
  created: number;
}

function lines(command: string, args: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.split(/\r?\n/) : null));
  });
}

/** Windows process table with creation times (ms since epoch). */
async function windowsProcesses(): Promise<ProcRow[] | null> {
  const script =
    "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  const out = await lines('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const rows = (out ?? [])
    .map((l) => l.trim().split(' ').map(Number))
    .filter((r) => r.length === 3 && r.every(Number.isFinite))
    .map(([pid, ppid, created]) => ({ pid, ppid, created }));
  return rows.length ? rows : null;
}

let msysPs: string | null | undefined;

/**
 * Git Bash (MSYS2) emulates exec by starting the new program and ending the old process, so on the
 * Windows side a command run by bash points at a parent that no longer exists. MSYS keeps the real
 * tree; its `ps` lists every MSYS process with its Windows id.
 */
async function msysProcesses(): Promise<{ pid: number; ppid: number; winpid: number }[] | null> {
  if (msysPs === undefined) {
    const git = which('git');
    const roots = [
      git ? path.resolve(path.dirname(git), '..') : undefined,
      'C:\\Program Files\\Git',
      'C:\\Program Files (x86)\\Git',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git') : undefined,
    ];
    msysPs = roots.map((r) => r && path.join(r, 'usr', 'bin', 'ps.exe')).find((p) => p && fs.existsSync(p)) ?? null;
  }
  if (!msysPs) return null;
  const out = await lines(msysPs, ['-e']);
  if (!out) return null;
  return out
    .map((l) => l.trim().split(/\s+/).slice(0, 4).map(Number))
    .filter((r) => r.length === 4 && r.every(Number.isFinite))
    .map(([pid, ppid, , winpid]) => ({ pid, ppid, winpid }));
}

/**
 * Kill a process and its descendants. On Windows `taskkill /T` matches descendants by parent id
 * alone, and ids are reused, so an unrelated process could be taken down with the tree; it also
 * misses programs started by Git Bash. The tree is walked here instead: Windows parent links,
 * checked against creation times (a child is never older than its parent), together with the MSYS
 * process tree. If the root has exited (`exitedRootStarted` is its spawn time), only what it started
 * while it ran is killed. A detached grandchild whose intermediate parent has already exited can escape this walk.
 */
export async function killTree(pid: number | undefined, exitedRootStarted?: number): Promise<void> {
  if (!pid) return;
  if (!isWindows) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    return;
  }
  const [table, msys] = await Promise.all([windowsProcesses(), msysProcesses()]);
  if (!table) {
    if (exitedRootStarted === undefined) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const winChildren = new Map<number, ProcRow[]>();
  for (const r of table) winChildren.set(r.ppid, [...(winChildren.get(r.ppid) ?? []), r]);
  const msysByWin = new Map((msys ?? []).map((r) => [r.winpid, r]));
  const msysChildren = new Map<number, number[]>();
  for (const r of msys ?? []) msysChildren.set(r.ppid, [...(msysChildren.get(r.ppid) ?? []), r.winpid]);

  const victims: ProcRow[] = [];
  const seen = new Set<number>([process.pid]);
  const add = (r: ProcRow | undefined) => {
    if (!r || seen.has(r.pid)) return;
    seen.add(r.pid);
    victims.push(r);
  };
  const current = byPid.get(pid);
  if (exitedRootStarted === undefined) {
    if (!current) return;
    add(current);
  } else {
    // The root is gone; its id may now belong to a newer process. Its orphans were created after it
    // started and before any newcomer took the id.
    const until = current && current.created > exitedRootStarted ? current.created : Infinity;
    for (const r of winChildren.get(pid) ?? []) if (r.created >= exitedRootStarted - 1000 && r.created < until) add(r);
  }
  for (let i = 0; i < victims.length; i++) {
    const p = victims[i];
    for (const c of winChildren.get(p.pid) ?? []) if (c.created >= p.created) add(c);
    const m = msysByWin.get(p.pid);
    if (m) for (const w of msysChildren.get(m.pid) ?? []) add(byPid.get(w));
  }
  for (const v of victims.reverse()) {
    try {
      process.kill(v.pid);
    } catch {
      /* already gone */
    }
  }
}


export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a short command and capture its output (environment probes, git queries). */
export function capture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, opts.timeoutMs ?? 10_000);
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: '', timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: decodeOutput(Buffer.concat(out)), stderr: decodeOutput(Buffer.concat(err)), timedOut });
    });
  });
}

/**
 * End the process with `code`. On Windows, Node 24 aborts ("Assertion failed ... async.c", exit 127) when
 * process.exit() runs right after fetch() calls, so the process ends by letting its event loop drain; a
 * timer that does not hold the loop forces the exit if something else would keep it running.
 */
export function exitProcess(code: number, graceMs = 250): void {
  process.exitCode = code;
  // A paused, unreferenced stdin no longer holds the loop (a terminal UI leaves it open).
  process.stdin.pause();
  (process.stdin as { unref?: () => void }).unref?.();
  setTimeout(() => process.exit(code), graceMs).unref();
}
