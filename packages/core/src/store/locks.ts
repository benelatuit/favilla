import fs from 'node:fs';
import path from 'node:path';
import { pauseSync, writeFileAtomic } from '../auth/store';

/**
 * Which Favilla process has a session open. Two processes writing one session (the desktop app and `favilla -c` in the
 * same folder) interleaved their turns in the file, each sent requests without the other's turn, and a compaction
 * point saved by one landed on the other's messages. A process keeps a small lock file beside each session it holds
 * and touches it while it lives; one that died leaves a lock that is ignored.
 */

/** A lock nobody touched for this long is a dead process's. */
const STALE_MS = 2 * 60_000;

/**
 * Processes known to have ended, whoever has their PID now: the desktop app starts its engine again at once when it
 * stops, and names the one that stopped. Windows hands a freed PID to the next process that starts, and the new
 * engine refused the old one's sessions for two minutes when another program had taken it.
 */
function livePid(pid: number): boolean {
  if (!pid || process.env.FAVILLA_GONE_PIDS?.split(',').some((gone) => Number(gone) === pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process is alive, but not ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Lock {
  pid: number;
  beat: number;
}

export class SessionLocks {
  private held = new Set<string>();

  constructor(private readonly root: string) {}

  private file(id: string): string {
    return path.join(this.root, `${id}.lock`);
  }

  /** The other live process that has this session open, if one does. */
  holder(id: string): { pid: number } | null {
    let lock: Lock;
    try {
      lock = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as Lock;
    } catch {
      return null;
    }
    return lock.pid !== process.pid && Date.now() - lock.beat <= STALE_MS && livePid(lock.pid) ? { pid: lock.pid } : null;
  }

  owns(id: string): boolean {
    return this.held.has(id);
  }

  take(id: string): void {
    if (this.owns(id)) return;
    this.writeWithoutLease(id, () => {
      if (this.write(id)) this.held.add(id);
    });
  }

  /** One gate for acquiring a writer and publishing an archive. A live writer keeps its lease across appends. */
  private withGate<T>(id: string, run: (holder: { pid: number } | null) => T, unavailable?: T): T {
    fs.mkdirSync(this.root, { recursive: true });
    const lock = path.join(this.root, `${id}.swap`);
    const owner = path.join(lock, String(process.pid));
    const deadline = Date.now() + 1500;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        try {
          fs.writeFileSync(owner, '');
        } catch (e) {
          fs.rmdirSync(lock);
          throw e;
        }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          const [pid] = fs.readdirSync(lock);
          // The gate is held for one write. An old one is a dead process's even when its PID is alive again:
          // Windows hands a freed PID to the next process, and that gate would shut the session for good.
          const old = Date.now() - fs.statSync(lock).mtimeMs > STALE_MS;
          if (old || (pid && !livePid(Number(pid)))) {
            // Only the reaper that removed this owner can remove the directory.
            if (pid) fs.unlinkSync(path.join(lock, pid));
            fs.rmdirSync(lock);
          }
        } catch {
          // The process publishing the archive may have finished.
        }
        if (unavailable !== undefined) return unavailable;
        if (Date.now() >= deadline) throw new Error(`Session ${id} is being archived.`);
        pauseSync(5);
      }
    }
    try {
      return run(this.holder(id));
    } finally {
      fs.unlinkSync(owner);
      fs.rmdirSync(lock);
    }
  }

  writeWithoutLease<T>(id: string, write: () => T): T {
    return this.withGate(id, (holder) => {
      if (holder) throw new SessionHeldError(id, holder.pid);
      return write();
    });
  }

  publishArchive(id: string, publish: () => boolean): boolean {
    return this.withGate(id, (holder) => !holder && publish(), false);
  }

  release(id: string): void {
    if (!this.held.delete(id)) return;
    try {
      const lock = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as Lock;
      if (lock.pid === process.pid) fs.unlinkSync(this.file(id));
    } catch {
      /* gone already */
    }
  }

  /** Touch every lock this process holds. */
  beat(): void {
    for (const id of this.held) this.write(id);
  }

  private write(id: string): boolean {
    try {
      // A reader of the lease must never see it momentarily empty during a heartbeat.
      writeFileAtomic(this.file(id), JSON.stringify({ pid: process.pid, beat: Date.now() } satisfies Lock));
      return true;
    } catch {
      return false;
    }
  }
}

export class SessionHeldError extends Error {
  constructor(
    readonly id: string,
    readonly pid: number,
  ) {
    super(`Session ${id} is open in another Favilla (process ${pid}). Close it there first, or start a new session.`);
  }
}
