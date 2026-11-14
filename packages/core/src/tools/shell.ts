import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { isWindows } from '../util/paths';
import { killChild, which } from '../util/proc';
import { watchMemory } from '../util/memguard';
import { decodeOutput } from '../util/text';

export interface ShellInfo {
  kind: 'bash' | 'zsh' | 'sh' | 'pwsh' | 'powershell' | 'cmd';
  path: string;
  /** How the shell is described to the model. */
  label: string;
  /** What the user calls it. */
  name: string;
  /** Set when this is not the shell that was asked for: why, for the user. */
  fallback?: string;
}

let detected: ShellInfo | undefined;

/**
 * The shell agent commands run in. bash unless the config picks another (`shell`: pwsh, powershell, cmd or a
 * path to an executable): models know bash best. On Windows bash means Git Bash, never WSL's bash.exe; when
 * it is missing, commands fall back to PowerShell and `fallback` says why, so a front end can tell the user.
 */
export function detectShell(choice?: string): ShellInfo {
  const want = choice?.trim().toLowerCase() ?? '';
  if (!want || want === 'bash' || want === 'auto') return (detected ??= defaultShell());
  if (want === 'pwsh') {
    const pwsh = which('pwsh');
    return pwsh ? { kind: 'pwsh', path: pwsh, label: 'PowerShell 7', name: 'PowerShell 7' } : { ...windowsPowerShell(), fallback: 'PowerShell 7 (pwsh) was not found; commands run in Windows PowerShell.' };
  }
  if (want === 'powershell') return isWindows ? windowsPowerShell() : detectShell('pwsh');
  if (want === 'cmd') {
    if (isWindows) return { kind: 'cmd', path: process.env.ComSpec || 'cmd.exe', label: 'cmd.exe (Windows Command Prompt syntax)', name: 'cmd' };
    return { ...(detected ??= defaultShell()), fallback: 'cmd is only on Windows; commands run in bash.' };
  }
  const exe = choice!.trim();
  if (fs.existsSync(exe)) return describe(exe);
  return { ...(detected ??= defaultShell()), fallback: `The configured shell ${exe} was not found; commands run in the default shell.` };
}

function defaultShell(): ShellInfo {
  if (isWindows) {
    const candidates = [
      process.env.FAVILLA_BASH,
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      gitBashFromGit(),
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
    ];
    const bash = candidates.find((c) => c && fs.existsSync(c));
    if (bash) return { kind: 'bash', path: bash, label: 'Git Bash (bash on Windows; use Unix syntax and forward slashes)', name: 'Git Bash' };
    const pwsh = which('pwsh');
    const fallback = 'Git Bash was not found, so commands run in PowerShell. Install Git for Windows (git-scm.com) to give the agent bash.';
    return pwsh ? { kind: 'pwsh', path: pwsh, label: 'PowerShell 7', name: 'PowerShell 7', fallback } : { ...windowsPowerShell(), fallback };
  }
  const sh = fs.existsSync('/bin/bash') ? '/bin/bash' : process.env.SHELL && /(bash|zsh)$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
  return describe(sh);
}

function windowsPowerShell(): ShellInfo {
  return { kind: 'powershell', path: 'powershell.exe', label: 'Windows PowerShell 5.1', name: 'Windows PowerShell' };
}

function gitBashFromGit(): string | undefined {
  const git = which('git');
  if (!git) return undefined;
  const root = path.resolve(path.dirname(git), '..');
  const bash = path.join(root, 'bin', 'bash.exe');
  return fs.existsSync(bash) ? bash : undefined;
}

function describe(p: string): ShellInfo {
  const name = path.basename(p).toLowerCase();
  if (name.startsWith('pwsh')) return { kind: 'pwsh', path: p, label: 'PowerShell 7', name: 'PowerShell 7' };
  if (name.startsWith('powershell')) return { kind: 'powershell', path: p, label: 'Windows PowerShell', name: 'Windows PowerShell' };
  if (name.startsWith('zsh')) return { kind: 'zsh', path: p, label: 'zsh', name: 'zsh' };
  if (name === 'sh' || name === 'sh.exe') return { kind: 'sh', path: p, label: 'sh', name: 'sh' };
  if (name === 'cmd' || name === 'cmd.exe') return { kind: 'cmd', path: p, label: 'cmd.exe (Windows Command Prompt syntax)', name: 'cmd' };
  return { kind: 'bash', path: p, label: isWindows ? 'Git Bash (Unix syntax, forward slashes)' : 'bash', name: isWindows ? 'Git Bash' : 'bash' };
}

/** Folders prepended to PATH for agent commands (the bundled ripgrep), so `rg` always works. */
const extraPath: string[] = [];
export function addAgentPath(dir: string): void {
  if (!extraPath.includes(dir)) extraPath.push(dir);
}

/**
 * What git runs in place of an editor for the list of commits of `rebase -i`: nobody can edit the list here, and
 * a rebase that ran as if it had been edited would look like one that did what was meant. Git hands the line to sh
 * with the file name after it, on Windows too. A command that names its own GIT_SEQUENCE_EDITOR keeps it.
 */
export const NO_SEQUENCE_EDITOR = `echo >&2 "No editor can open here, so the list of commits cannot be edited by hand. Set GIT_SEQUENCE_EDITOR for this command to one that edits the list (sed -i -e '2s/^pick/squash/' for example), or use git rebase --onto, git commit --fixup with git rebase --autosquash, or git reset --soft."; false`;

/** Environment for agent commands: never page, never prompt, never open an editor, flush output promptly. */
export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (extraPath.length) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[key] = [...extraPath, env[key] ?? ''].join(path.delimiter);
  }
  return {
    ...env,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    // No one can type into an editor here: `git commit` without -m, `commit --amend`, a merge and `rebase -i`
    // each opened vim and sat in it until the time limit. With `true` as the editor a message that already
    // exists is kept (amend, merge, revert) and an empty one ends the commit at once, with git saying why.
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: NO_SEQUENCE_EDITOR,
    EDITOR: 'true',
    VISUAL: 'true',
    GCM_INTERACTIVE: 'never',
    DEBIAN_FRONTEND: 'noninteractive',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    NO_UPDATE_NOTIFIER: '1',
    npm_config_yes: 'true',
    npm_config_update_notifier: 'false',
    FAVILLA_AGENT: '1',
    ...extra,
  };
}

/** WSL's bash.exe: Windows environment variables do not cross into it, so it still takes the command as an argument. */
function wslShell(p: string): boolean {
  return /[\\/](system32|sysnative)[\\/]bash\.exe$/i.test(p) || /(^|[\\/])wsl(\.exe)?$/i.test(p);
}

/**
 * A failure early in a pipe must not hide behind the last command's exit code: without this, `go test | tail` reads
 * as green. Tried in a subshell first, since a plain sh has no such option and would stop at the line.
 */
const PIPEFAIL = '(set -o pipefail) 2>/dev/null && set -o pipefail';

/** The exit code of a pipe whose reader left early (`find | head`): SIGPIPE, which by itself is no failure. */
export const PIPE_CLOSED = 141;

// Detached cmd and PowerShell can drop the pipes of the programs they launch. A detached Node process
// can pass its handles to an ordinary shell, keeping the same input and output while the tree is recoverable.
const SHELL_BRIDGE = String.raw`
const { spawn } = require('node:child_process');
const [, file, verbatim, ...args] = process.argv.slice(1);
for (const [key, value] of Object.entries(JSON.parse(process.env.FAVILLA_JOB_BRIDGE_ENV))) {
  if (value === null) delete process.env[key];
  else process.env[key] = value;
}
const shell = spawn(file, args, { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: verbatim === '1' });
shell.on('exit', (code) => { process.exitCode = code ?? 1; });
shell.on('error', (e) => { process.stderr.write('\n' + e.message + '\n'); process.exitCode = 1; });
`;

function launchShell(file: string, args: string[], options: SpawnOptions, mark?: string): ChildProcess {
  if (!mark) return spawn(file, args, options);
  const env = { ...options.env };
  env.FAVILLA_JOB_BRIDGE_ENV = JSON.stringify(Object.fromEntries(['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'FAVILLA_JOB_BRIDGE_ENV'].map((key) => [key, env[key] ?? null])));
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  delete env.NODE_OPTIONS;
  return spawn(process.execPath, ['--input-type=commonjs', '-e', SHELL_BRIDGE, '--', mark, file, options.windowsVerbatimArguments ? '1' : '0', ...args], {
    ...options, env, detached: true, windowsVerbatimArguments: false,
  });
}

/** `stdin` keeps a pipe to the command's input (background jobs the agent may answer); otherwise input is empty. */
export function spawnShell(shell: ShellInfo, command: string, cwd: string, env: NodeJS.ProcessEnv, opts: { stdin?: boolean; jobMark?: string } = {}): ChildProcess {
  const mark = opts.jobMark;
  if (shell.kind === 'cmd') {
    // cmd takes the whole line as one verbatim argument; code page 65001 makes its output UTF-8.
    return launchShell(shell.path, ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`], {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    }, mark);
  }
  const powershell = shell.kind === 'pwsh' || shell.kind === 'powershell';
  // MSYS and Cygwin shells re-parse the Windows command line with their own rules, which turn `\\` inside quotes
  // into `\` (a quoted heredoc writing Python loses half its backslashes) and cap it at 32,767 characters. The
  // command goes in the environment instead, read once and evaluated verbatim, then dropped so children never see it.
  const viaEnv = isWindows && !powershell && !wslShell(shell.path);
  const args = powershell
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`]
    : viaEnv
      ? ['-c', `${PIPEFAIL}; ${mark ? `: ${mark}; ` : ''}__favilla_command=$FAVILLA_COMMAND; unset FAVILLA_COMMAND; eval "$__favilla_command"${mark ? '; exit $?' : ''}`]
      : ['-c', `${PIPEFAIL}\n${command}`];
  return launchShell(shell.path, args, {
    cwd,
    env: viaEnv ? { ...env, FAVILLA_COMMAND: command } : env,
    windowsHide: true,
    detached: !isWindows || (viaEnv && !!mark),
    stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  }, viaEnv ? undefined : mark);
}

export interface ShellRun {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** Full output on disk when it was too large to keep in memory. */
  logPath?: string;
  totalBytes: number;
  /** Why Favilla stopped the command itself (the computer ran short of memory). */
  stoppedFor?: string;
}

const MEMORY_LIMIT = 6 * 1024 * 1024;

/** Run a command to completion, streaming output to `onData`, with a timeout and abort support. */
export function runShell(
  shell: ShellInfo,
  command: string,
  opts: { cwd: string; timeoutMs: number; signal: AbortSignal; onData?: (text: string) => void; logFile: string; env?: NodeJS.ProcessEnv; memoryGuard?: boolean },
): Promise<ShellRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnShell(shell, command, opts.cwd, opts.env ?? agentEnv());
    } catch (e) {
      resolve({ output: `Failed to start shell: ${(e as Error).message}`, exitCode: null, timedOut: false, aborted: false, durationMs: 0, totalBytes: 0 });
      return;
    }
    const chunks: Buffer[] = [];
    let inMemory = 0;
    let total = 0;
    let fileStream: fs.WriteStream | undefined;
    let tail: Buffer[] = [];
    let tailSize = 0;
    let timedOut = false;
    let aborted = false;

    const onChunk = (d: Buffer) => {
      total += d.length;
      opts.onData?.(decodeOutput(d));
      if (!fileStream && inMemory + d.length <= MEMORY_LIMIT) {
        chunks.push(d);
        inMemory += d.length;
        return;
      }
      if (!fileStream) {
        fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
        fileStream = fs.createWriteStream(opts.logFile);
        for (const c of chunks) fileStream.write(c);
      }
      fileStream.write(d);
      tail.push(d);
      tailSize += d.length;
      while (tailSize > 512 * 1024 && tail.length > 1) tailSize -= tail.shift()!.length;
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child, started);
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killChild(child, started);
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    let stoppedFor: string | undefined;
    const unwatch =
      opts.memoryGuard === false
        ? () => {}
        : watchMemory((why) => {
            stoppedFor = why;
            killChild(child, started);
          });

    // A process started in the background (`server &`) can hold the output open after the shell exits.
    // Give the output a moment to drain, then return instead of waiting for the timeout.
    let leftRunning = false;
    let exitTimer: NodeJS.Timeout | undefined;
    child.on('exit', () => {
      exitTimer = setTimeout(() => {
        leftRunning = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 1500);
    });
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      opts.signal.removeEventListener('abort', onAbort);
      unwatch();
      let output: string;
      if (fileStream) {
        fileStream.end();
        const head = Buffer.concat(chunks).subarray(0, 256 * 1024);
        output = `${decodeOutput(head)}\n[… output continues; full log saved …]\n${decodeOutput(Buffer.concat(tail))}`;
      } else {
        output = decodeOutput(Buffer.concat(chunks));
      }
      if (leftRunning) output += '\n(The shell exited, but a process it started is still running in the background.)';
      resolve({ output, exitCode: code, timedOut, aborted, durationMs: Date.now() - started, logPath: fileStream ? opts.logFile : undefined, totalBytes: total, stoppedFor });
    };
    child.on('error', (e) => {
      chunks.push(Buffer.from(`\n${e.message}`));
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
