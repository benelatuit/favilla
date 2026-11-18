import fs from 'node:fs';
import path from 'node:path';
import { displayPath, resolvePath } from '../util/paths';
import { cleanTerminal, oneLine, truncateMiddle } from '../util/text';
import { sleep } from '../util/async';
import { beforeTree } from './before';
import { PIPE_CLOSED, runShell } from './shell';
import type { ToolDef } from './types';

export interface ShellInput {
  command: string;
  timeoutMs?: number;
  workdir?: string;
  background?: boolean;
  description?: string;
  /** Run on the code as it was before this session's changes, with the session's test files as they are now. */
  before?: boolean;
  /** Result layout the model family was trained on. */
  format?: 'claude' | 'codex' | 'favilla';
}

const UI_LIMIT = 200_000;

/** Only identical adjacent terminal lines. A new clock, count or diagnostic starts another run. */
function foldRepeatedLines(text: string): string {
  if (text.length < 4096) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    let end = i + 1;
    while (end < lines.length && lines[end] === lines[i]) end++;
    const note = `[${end - i} consecutive identical lines]`;
    if (end - i >= 3 && (end - i - 1) * (lines[i].length + 1) > note.length + 1) out.push(lines[i], note);
    else for (let j = i; j < end; j++) out.push(lines[j]);
    i = end;
  }
  const folded = out.join('\n');
  return folded.length + 256 < text.length ? folded : text;
}

/** A pause shorter than this (a server's moment to start) is not a wait. */
export const WAIT_MOST_S = 10;

/**
 * Seconds a command spends sleeping (sleep, Start-Sleep, timeout /t, ping -n as a pause), and Infinity for a sleep of a
 * second or more inside a loop: a wait of unknown length.
 */
export function foregroundWait(command: string): number {
  let seconds = 0;
  let longest = 0;
  for (const m of command.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)([smh]?)\b|\bStart-Sleep\s+(?:-(?:Seconds|s)\s+)?(\d+(?:\.\d+)?)\b|\bStart-Sleep\s+-(?:Milliseconds|m)\s+(\d+)|\btimeout(?:\.exe)?\s+\/t\s+(\d+)|\bping(?:\.exe)?\s+-n\s+(\d+)\s+(?:127\.0\.0\.1|localhost)/gi)) {
    const s = m[1] ? Number(m[1]) * (m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : 1) : m[3] ? Number(m[3]) : m[4] ? Number(m[4]) / 1000 : Number(m[5] ?? m[6] ?? 0);
    seconds += s;
    longest = Math.max(longest, s);
  }
  // A loop as shells write one: bash's while/until/for … do, PowerShell's while ( / for ( / foreach ( / do {, cmd's for /l.
  return longest >= 1 && /\b(?:while|until|for)\b[\s\S]*?\bdo\b|\b(?:while|for|foreach)\s*\(|\bdo\s*\{|\bfor\s+\/[lfdr]\b/i.test(command) ? Infinity : seconds;
}

export const shellTool: ToolDef<ShellInput> = {
  kind: 'shell',
  readOnly: false,
  title: (i) => oneLine(i.command, 160),
  async execute(input, ctx) {
    let cwd = input.workdir ? resolvePath(ctx.cwd, input.workdir) : ctx.cwd;
    if (!fs.existsSync(cwd)) return { content: `Working directory ${input.workdir} does not exist.`, isError: true };
    // On the old code: the copy of the project as it was before this session changed it, its test files kept.
    let onOld = '';
    if (input.before) {
      const originals = ctx.checkpoints?.originals?.() ?? new Map<string, Buffer | null>();
      if (!originals.size) return { content: 'Nothing has changed in this session yet, so the code as it was is the code as it is: run it without before.' };
      const rel = path.relative(ctx.cwd, cwd);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return { content: 'before works in folders inside the working directory.', isError: true };
      const tree = beforeTree(ctx.cwd, ctx.sessionId, originals);
      if ('error' in tree) return { content: `No copy of the old code to run on: ${tree.error}.`, isError: true };
      cwd = path.join(tree.root, rel);
      onOld = "On the code as it was before this session's changes, with your test files as they are now:\n";
    }
    let command = input.command;
    let background = !!input.background;
    if (!background && (ctx.shell.kind === 'bash' || ctx.shell.kind === 'zsh' || ctx.shell.kind === 'sh') &&/(^|[^&])&\s*$/.test(command)) {
      background = true;
      command = command.replace(/&\s*$/, '');
    }
    // Someone is there to talk to the agent: a wait in the foreground keeps them out until it ends, and a background
    // command's end wakes the session anyway (2026-11-04: sleeping in the terminal blocks the chat and the work).
    const wait = ctx.interactive && !background ? foregroundWait(command) : 0;
    if (wait >= WAIT_MOST_S) {
      const option = input.format === 'favilla' ? 'background: true' : 'run_in_background: true';
      return {
        content: `Not run: this command would wait ${Number.isFinite(wait) ? `${Math.round(wait)} s` : 'in a loop'} in the foreground, and the user cannot talk to you until it ends. Start what you are waiting for (or a loop that waits for it) with ${option} instead: when it ends, its exit code and last lines come to you as a message, and they wake you if your turn is over, so you can go on with other work or end your turn. For a server you started, look at its output for the line that says it is ready. Pauses under ${WAIT_MOST_S} s are fine.`,
        isError: true,
      };
    }
    if (background) {
      // Another session in this folder runs it already: one dev server for the folder, not two on one port.
      const twin = ctx.jobs.twin(command, cwd);
      if (twin) {
        const lines = cleanTerminal(twin.buffer).trimEnd().split('\n').slice(-15).join('\n');
        return {
          content: `Not started: another Favilla session in this folder runs this command already (for ${Math.round((Date.now() - twin.started) / 1000)} s), and a second one would fight it for its port. Use that one: its whole output is in ${twin.logPath}, its address among the lines there. It is that session's to stop.${lines ? `\nIts latest output:\n${lines}` : ''}`,
        };
      }
      const job = ctx.jobs.start(command, cwd);
      await sleep(1500, ctx.signal).catch(() => {});
      const first = ctx.jobs.read(job.id);
      const out = truncateMiddle(cleanTerminal(first.output), Math.min(ctx.outputChars, 4000)).text.trim();
      const after = ctx.wakes ? ' When it ends, its exit code and last lines come to you as a message, and they wake you if your turn is over: go on with other work, or end your turn and say what you are waiting for, rather than waiting on it.' : '';
      return {
        content: `${onOld}Started background job ${job.id} (${first.status}). Output log: ${job.logPath}\n${out ? `First output:\n${out}\n` : ''}Check on it with the job output tool (id ${job.id}); stop it with the kill tool when done.${after}`,
        display: { kind: 'terminal', command, output: first.output.slice(-UI_LIMIT), exitCode: null, durationMs: 1500, cwd: displayPath(ctx.cwd, cwd), background: job.id },
      };
    }
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? ctx.config.bashTimeoutMs ?? 120_000, 1000), 600_000);
    const logFile = path.join(ctx.outputDir, `${ctx.callId}.log`);
    const run = await runShell(ctx.shell, command, { cwd, timeoutMs, signal: ctx.signal, onData: ctx.progress, logFile, memoryGuard: ctx.config.memoryGuard !== false });
    const clean = cleanTerminal(run.output).replace(/\s+$/, '');
    const folded = foldRepeatedLines(clean);
    const cut = truncateMiddle(folded, ctx.outputChars);
    let logPath = run.logPath;
    if ((cut.truncated || folded !== clean) && !logPath) {
      fs.mkdirSync(ctx.outputDir, { recursive: true });
      fs.writeFileSync(logFile, run.output);
      logPath = logFile;
    }
    const notes: string[] = [];
    if (run.stoppedFor) notes.push(`Stopped by Favilla: ${run.stoppedFor}. Run a narrower command (one package or one test at a time), or limit what it loads.`);
    else if (run.timedOut) notes.push(`Timed out after ${Math.round(timeoutMs / 1000)}s and was stopped. Run servers and watchers in the background instead.`);
    else if (run.aborted) notes.push('Interrupted by the user.');
    else if (run.exitCode === PIPE_CLOSED) notes.push('A later command in the pipe stopped reading, so the commands before it were cut short.');
    else if (run.exitCode !== 0) notes.push(`Exit code ${run.exitCode}`);
    if (cut.truncated) notes.push(`Output truncated; full output (${clean.length} chars) saved to ${logPath}. Read or grep that file for the omitted part.`);
    else if (folded !== clean) notes.push(`Full output saved to ${logPath}.`);
    const body = cut.text || (run.exitCode === 0 ? '(no output)' : '');
    const content =
      input.format === 'codex'
        ? `Exit code: ${run.exitCode ?? 'none'}\nWall time: ${(run.durationMs / 1000).toFixed(1)} seconds\n${notes.filter((n) => !n.startsWith('Exit code')).map((n) => `${n}\n`).join('')}Output:\n${cut.text}`
        : input.format === 'favilla'
          ? // The status closes the output, where a terminal shows it: exit code, time, then anything unusual.
            `${body || '(no output)'}\n[exit ${run.exitCode ?? 'none'} · ${(run.durationMs / 1000).toFixed(1)} s${notes
              .filter((n) => !n.startsWith('Exit code'))
              .map((n) => ` · ${n}`)
              .join('')}]`
          : `${body}${notes.length ? `\n\n[${notes.join(' ')}]` : ''}`;
    return {
      content: onOld + content,
      isError: !!run.stoppedFor || run.timedOut || run.aborted || (run.exitCode !== 0 && run.exitCode !== null && run.exitCode !== PIPE_CLOSED),
      display: {
        kind: 'terminal',
        command,
        output: run.output.length > UI_LIMIT ? run.output.slice(-UI_LIMIT) : run.output,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        cwd: displayPath(ctx.cwd, cwd),
        truncated: cut.truncated,
        logPath,
        timedOut: run.timedOut,
        stoppedFor: run.stoppedFor,
      },
    };
  },
};

export interface JobInput {
  id: string;
  action: 'output' | 'kill' | 'input' | 'wait';
  /** For wait: a regex the output must show (a server's "ready" line); without it, wait for the job to end. */
  until?: string;
  /** For wait: give up after this long (default 30 s, at most 5 minutes). */
  timeoutMs?: number;
  filter?: string;
  /** Text for the job's standard input, sent before reading its output. */
  input?: string;
}

export const jobTool: ToolDef<JobInput> = {
  kind: 'job',
  readOnly: false,
  title: (i) => `${i.action === 'kill' ? 'Stop' : i.input ? 'Answer' : 'Check'} ${i.id}`,
  async execute(input, ctx) {
    if (input.action === 'kill') return { content: ctx.jobs.kill(input.id) };
    let waited = '';
    let timedOut = false;
    if (input.action === 'wait') {
      let re: RegExp | null = null;
      try {
        re = input.until ? new RegExp(input.until, 'm') : null;
      } catch (e) {
        return { content: `Invalid regex for until: ${(e as Error).message}`, isError: true };
      }
      // With someone there, a long wait keeps them from talking to the agent, and the job's end comes as a message anyway.
      const limit = Math.min(Math.max(input.timeoutMs ?? 30_000, 1000), ctx.interactive ? 60_000 : 300_000);
      const started = Date.now();
      for (;;) {
        const p = ctx.jobs.peek(input.id);
        if (!p) break;
        if (re && re.test(cleanTerminal(p.text))) {
          waited = `matched /${input.until}/ after ${((Date.now() - started) / 1000).toFixed(1)} s`;
          break;
        }
        if (p.done) {
          waited = 'the job ended';
          break;
        }
        if (Date.now() - started >= limit || ctx.signal.aborted) {
          timedOut = !ctx.signal.aborted;
          waited = `no match after ${Math.round(limit / 1000)} s; it is still running${ctx.wakes ? '. Its end will come to you as a message and wake you if your turn is over: no need to wait on it' : ''}`;
          break;
        }
        await sleep(250, ctx.signal).catch(() => {});
      }
    }
    if (input.input) {
      const problem = ctx.jobs.write(input.id, input.input);
      if (problem) return { content: problem, isError: true };
      // Give the program a moment to react before reading what it printed.
      await new Promise((r) => setTimeout(r, 800));
    }
    const r = ctx.jobs.read(input.id, input.filter);
    if (!r.job) return { content: r.status, isError: true };
    const out = truncateMiddle(cleanTerminal(r.output), ctx.outputChars).text.trim();
    const progress = out.length > 0 || (!r.job.done && timedOut);
    return {
      content: `${input.id} ${r.status}${waited ? ` (${waited})` : ''}.\n${out ? `New output:\n${out}` : 'No new output since the last check.'}`,
      progress,
      display: { kind: 'terminal', command: r.job.command, output: r.output.slice(-UI_LIMIT), exitCode: r.job.done ? r.job.exitCode : null, durationMs: Date.now() - r.job.started, cwd: displayPath(ctx.cwd, r.job.cwd), background: r.job.id },
    };
  },
};
