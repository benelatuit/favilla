import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { ShellInfo } from './shell';
import { spawnJob } from './job-recovery';
import { endWithProcess, killChild } from '../util/proc';
import { debug } from '../util/log';
import { normalizeForCompare } from '../util/paths';
import { OutputDecoder } from '../util/text';

export interface Job {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  started: number;
  exitCode: number | null;
  done: boolean;
  buffer: string;
  readOffset: number;
  logPath: string;
  unreadLog?: string;
  log: fs.WriteStream;
  /** Bytes in the current log file; past LOG_LIMIT it starts over and the previous part is kept as .old.log. */
  logBytes: number;
  /** Stopped by the kill tool or with the session, not ended on its own. */
  killed?: boolean;
  /** Its output was read after it had ended: whoever started it has seen how it ended. */
  seenEnd?: boolean;
  /** The end has been told to the onEnd listener (a process can report both an error and a close). */
  endTold?: boolean;
}

const KEEP = 1_000_000;
const FINISHED_KEEP = 4000;
/** A dev server can log for days: each job keeps at most two log files of this size. */
const LOG_LIMIT = 8 * 1024 * 1024;

function openLog(file: string): fs.WriteStream {
  const log = fs.createWriteStream(file, { highWaterMark: 256 * 1024 });
  log.on('error', (e) => debug('jobs', 'log not written', String(e)));
  return log;
}

function rotate(job: Job): void {
  job.log.end();
  try {
    fs.renameSync(job.logPath, job.logPath.replace(/\.log$/, '.old.log'));
  } catch {
    /* the old part stays where it is */
  }
  job.log = openLog(job.logPath);
  job.logBytes = 0;
}

/** Every running job of every session in this process: the desktop app's one engine serves all its sessions. */
const everyJob = new Set<{ job: Job; manager: JobManager }>();

/**
 * The last address on this computer a server printed (Vite's "Local: http://localhost:5173/", http.server's
 * "http://0.0.0.0:8000/"), 0.0.0.0 read as this computer: where its page is.
 */
export function servedUrl(output: string): string | null {
  const plain = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const found = [...plain.matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s'"`<>)\]]*)?/gi)].at(-1)?.[0];
  return found ? found.replace('0.0.0.0', '127.0.0.1').replace(/\[::1?\]/, 'localhost') : null;
}

/**
 * The pages a folder serves: the running jobs of every session in this process started in it or below it that
 * printed an address on this computer, newest first.
 */
export function servedIn(cwd: string): { url: string; command: string; started: number }[] {
  const root = normalizeForCompare(cwd);
  const out: { url: string; command: string; started: number }[] = [];
  for (const { job } of everyJob) {
    const at = normalizeForCompare(job.cwd);
    if (job.done || (at !== root && !at.startsWith(root + path.sep))) continue;
    const url = servedUrl(job.buffer);
    if (url) out.push({ url, command: job.command, started: job.started });
  }
  return out.sort((a, b) => b.started - a.started);
}

/** A server, a preview or a watcher: what a second session in the same folder can use as it runs. */
const LONG_LIVED = /\b(dev|serve|server|start|preview|watch)\b|http\.server|--watch\b/i;

/** Long-running commands (dev servers, watchers) that keep running between tool calls. */
export class JobManager {
  private jobs = new Map<string, Job>();
  private next = 1;
  private ended?: (job: Job) => void;

  constructor(
    private readonly shell: ShellInfo,
    private readonly logDir: string,
  ) {}

  /** Called once for each job when it ends, killed or not. */
  onEnd(listener: (job: Job) => void): void {
    this.ended = listener;
  }

  private tellEnd(job: Job): void {
    if (job.endTold) return;
    job.endTold = true;
    this.ended?.(job);
  }

  /**
   * The same long-running command, run by another session of this process in the same folder. Two sessions in one
   * folder each started its dev server: the second failed on the port, or took another and served the folder twice.
   */
  twin(command: string, cwd: string): Job | undefined {
    if (!LONG_LIVED.test(command)) return undefined;
    const same = (c: string) => c.replace(/\s+/g, ' ').trim();
    for (const e of everyJob) {
      if (e.manager !== this && !e.job.done && same(e.job.command) === same(command) && normalizeForCompare(e.job.cwd) === normalizeForCompare(cwd)) return e.job;
    }
    return undefined;
  }

  start(command: string, cwd: string): Job {
    const id = `job_${this.next++}`;
    fs.mkdirSync(this.logDir, { recursive: true });
    const logPath = path.join(this.logDir, `${id}.log`);
    const child = spawnJob(this.shell, command, cwd);
    endWithProcess(child);
    // Writing to a command that has exited raises EPIPE on its input; that is reported by write(), not thrown.
    child.stdin?.on('error', () => {});
    const job: Job = { id, command, cwd, child, started: Date.now(), exitCode: null, done: false, buffer: '', readOffset: 0, logPath, log: openLog(logPath), logBytes: 0 };
    // A character split between two chunks came out as two broken ones.
    const out = new OutputDecoder();
    const err = new OutputDecoder();
    const onData = (from: OutputDecoder) => (d: Buffer) => {
      job.logBytes += d.length;
      if (job.logBytes > LOG_LIMIT) rotate(job);
      const log = job.log;
      if (!log.destroyed && !log.write(d)) {
        // Both pipes share this writer. Don't keep draining them into memory while the disk is behind.
        child.stdout?.pause();
        child.stderr?.pause();
        const resume = () => {
          log.off('drain', resume);
          log.off('close', resume);
          child.stdout?.resume();
          child.stderr?.resume();
        };
        log.once('drain', resume).once('close', resume);
      }
      job.buffer += from.push(d);
      if (job.buffer.length > KEEP * 2) {
        const drop = job.buffer.length - KEEP;
        job.buffer = job.buffer.slice(drop);
        job.readOffset = Math.max(0, job.readOffset - drop);
      }
    };
    child.stdout?.on('data', onData(out));
    child.stderr?.on('data', onData(err));
    const entry = { job, manager: this };
    everyJob.add(entry);
    child.on('close', (code) => {
      everyJob.delete(entry);
      job.buffer += out.end() + err.end();
      job.done = true;
      job.exitCode = code;
      job.log.end();
      this.tellEnd(job);
      void this.parkOutput(job);
    });
    child.on('error', (e) => {
      everyJob.delete(entry);
      job.buffer += `\n${e.message}\n`;
      job.done = true;
      this.tellEnd(job);
    });
    this.jobs.set(id, job);
    return job;
  }

  private async parkOutput(job: Job): Promise<void> {
    const unread = job.buffer.slice(job.readOffset);
    const tail = unread.slice(-FINISHED_KEEP);
    if (unread.length > tail.length) {
      const dir = path.join(this.logDir, '.unread');
      const file = path.join(dir, randomUUID() + '.log');
      try {
        await fsp.mkdir(dir, { recursive: true });
        // Raw logs mix the two pipes' bytes. Keep the exact decoded, unread text, including split UTF-16 pairs.
        await fsp.writeFile(file, unread.slice(0, -FINISHED_KEEP), 'utf16le');
        if (job.seenEnd) {
          await fsp.rm(file, { force: true });
          return;
        }
        job.unreadLog = file;
      } catch (e) {
        debug('jobs', 'unread output not parked', String(e));
        return;
      }
    }
    // Detach the small tail from the backing string of the whole output.
    job.buffer = Buffer.from(tail, 'utf16le').toString('utf16le');
    job.readOffset = 0;
  }

  private unreadOutput(job: Job): string {
    return job.unreadLog ? fs.readFileSync(job.unreadLog, 'utf16le') + job.buffer : job.buffer.slice(job.readOffset);
  }

  /** Output since the last read and whether the job has ended, without moving the read position. */
  peek(id: string): { text: string; done: boolean } | null {
    const job = this.jobs.get(id);
    return job ? { text: this.unreadOutput(job), done: job.done } : null;
  }

  /** Output produced since the last read, optionally filtered by a regex. */
  read(id: string, filter?: string): { output: string; status: string; job?: Job } {
    const job = this.jobs.get(id);
    if (!job) return { output: '', status: `No background job "${id}". Running: ${this.list().map((j) => j.id).join(', ') || 'none'}.` };
    let fresh = this.unreadOutput(job);
    if (job.done) {
      job.seenEnd = true;
      if (job.unreadLog) void fsp.rm(job.unreadLog, { force: true }).catch(() => {});
      job.unreadLog = undefined;
      job.buffer = '';
    }
    job.readOffset = job.buffer.length;
    if (filter) {
      try {
        const re = new RegExp(filter);
        fresh = fresh
          .split('\n')
          .filter((l) => re.test(l))
          .join('\n');
      } catch {
        /* invalid regex: return unfiltered */
      }
    }
    const status = job.done ? `exited with code ${job.exitCode}` : `running for ${Math.round((Date.now() - job.started) / 1000)}s`;
    return { output: fresh, status, job };
  }

  /** Send text to a running job's standard input (an answer to a prompt, a line for a REPL). */
  write(id: string, text: string): string | null {
    const job = this.jobs.get(id);
    if (!job) return `No background job "${id}".`;
    if (job.done || !job.child.stdin || job.child.stdin.destroyed) return `${id} has already exited; it cannot take input.`;
    job.child.stdin.write(text);
    return null;
  }

  kill(id: string): string {
    const job = this.jobs.get(id);
    if (!job) return `No background job "${id}".`;
    if (job.done) return `${id} had already exited with code ${job.exitCode}.`;
    job.killed = true;
    killChild(job.child, job.started);
    return `Stopped ${id} (${job.command}).`;
  }

  list(): Job[] {
    return [...this.jobs.values()].filter((j) => !j.done);
  }

  /** A job by id, running or ended. */
  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Stops every job and its tree; resolves once the kills have run. */
  disposeAll(): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => !j.done);
    for (const j of running) j.killed = true;
    return Promise.all(running.map((j) => killChild(j.child, j.started))).then(() => {});
  }
}
