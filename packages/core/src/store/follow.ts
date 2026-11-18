import fs from 'node:fs';
import path from 'node:path';
import type { Message } from '../types';
import { debug } from '../util/log';
import type { SessionPeek, SessionRecord, SessionStore } from './sessions';

/** What changed in a followed session since the last report. */
export interface FollowChange {
  record: SessionRecord;
  /** Messages added at the end; with `reset` the record was read again whole and `added` is empty. */
  added: Message[];
  reset: boolean;
  /** The process that holds it, or null once it let go (or died). */
  holder: { pid: number } | null;
}

/** Changes to the file come in bursts (a message, then its usage and meta lines): one read for each burst. */
const SETTLE_MS = 120;
/**
 * How often the lock is read to see whether its holder let go: the lock is beside every other session's, and a watch
 * on that folder would wake for all of them. One small file read every two seconds.
 */
const HOLDER_CHECK_MS = 2_000;

/**
 * One session another process writes, followed as its file grows: a watch on the session's folder, and the lines
 * added read from where the last read ended. Nothing is written. It reports each change, and once more when the
 * holder lets go; `close` ends it.
 */
export class SessionFollow {
  private peek: SessionPeek;
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private check: NodeJS.Timeout | null = null;
  private held: boolean;
  private closed = false;

  private constructor(
    private readonly store: SessionStore,
    readonly id: string,
    peek: SessionPeek,
    private readonly file: string,
    private readonly report: (c: FollowChange) => void,
  ) {
    this.peek = peek;
    this.held = !!store.locks.holder(id);
  }

  /**
   * Start following; null when the session is not in this store or cannot be read here. `from` is a read of it made
   * just before (for the page's view), taken up where it ended.
   */
  static start(store: SessionStore, id: string, report: (c: FollowChange) => void, from?: SessionPeek): SessionFollow | null {
    const peek = from ?? store.peek(id);
    const slug = store.peekIndex()?.[id]?.slug;
    if (!peek || !slug) return null;
    const f = new SessionFollow(store, id, peek, `${id}.jsonl`, report);
    f.watch(path.join(store.root, slug));
    return f;
  }

  get record(): SessionRecord {
    return this.peek.record;
  }

  holder(): { pid: number } | null {
    return this.store.locks.holder(this.id);
  }

  private watch(dir: string): void {
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
        // The cold file of a session put away has the same stem.
        if (!name || String(name).startsWith(this.file)) this.soon();
      });
      this.watcher.on('error', (e) => debug('follow', 'watch failed', String(e)));
    } catch (e) {
      debug('follow', 'watch failed', String(e));
    }
    this.check = setInterval(() => {
      if (this.held && !this.holder()) this.read();
    }, HOLDER_CHECK_MS);
    this.check.unref();
  }

  private soon(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.read();
    }, SETTLE_MS);
    this.timer.unref();
  }

  /** Read what was added and report it; also called by a caller that knows the file changed. */
  read(): void {
    if (this.closed) return;
    let got: ReturnType<SessionPeek['more']>;
    try {
      got = this.peek.more();
    } catch (e) {
      debug('follow', 'read failed', String(e));
      return;
    }
    const holder = this.holder();
    const let_go = this.held && !holder;
    this.held = !!holder;
    if (!got?.changed && !let_go) return;
    this.report({ record: this.peek.record, added: got?.added ?? [], reset: got?.reset ?? false, holder });
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.check) clearInterval(this.check);
    this.timer = this.check = null;
  }
}
