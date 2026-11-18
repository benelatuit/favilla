import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Runtime } from '../runtime';
import type { ModelInfo } from '../catalog/catalog';
import type { Message, SessionMeta, SessionUsage } from '../types';
import { BlobStore } from '../store/blobs';
import { SessionFollow, type FollowChange } from '../store/follow';
import { lighten } from '../store/pack';
import { openWithKeysAt } from '../store/seal';
import { SessionStore, type SessionPeek, type SessionRecord } from '../store/sessions';
import { appPath, normalizeForCompare } from '../util/paths';

/** Another Favilla folder whose sessions are listed here and open only to be read (storage.otherHomes). */
export interface OtherHome {
  /** Its place in the setting, for blob links. */
  n: number;
  /** The folder as the setting names it, with the user's home as ~. */
  label: string;
  store: SessionStore;
}

/** How a session is shown when this process does not write it: who holds it, and which folder it is in. */
export interface Following {
  /** The process writing it, or null when none does. */
  holder: number | null;
  /** The other Favilla folder it is in; absent for one of this folder's, open in another process. */
  home?: string;
}

const tilde = (p: string) => {
  const home = os.homedir();
  return normalizeForCompare(p).startsWith(normalizeForCompare(home)) ? `~${p.slice(home.length).replace(/\\/g, '/')}` : p.replace(/\\/g, '/');
};

/**
 * Sessions this process only reads: one of its own folder's that another process holds (a terminal, `favilla -p`),
 * and those of other Favilla folders named in the settings. Nothing here writes a session's file, the index, a
 * blob or a lock; each session followed by an open page has one watch on its folder, ended when the last page goes.
 */
/** How long a view's read is kept for the stream its page opens next. */
const KEEP_VIEW_MS = 30_000;

export function followedSessions(rt: Runtime) {
  const homes = new Map<string, OtherHome>();
  const watched = new Map<string, { follow: SessionFollow; pages: Set<http.ServerResponse> }>();
  /** The last view's read, for the stream its page opens next: the file is not read whole twice. */
  let viewed: { id: string; store: SessionStore; peek: SessionPeek; at: number } | null = null;

  function otherHomes(): OtherHome[] {
    const own = normalizeForCompare(appPath());
    const out: OtherHome[] = [];
    (rt.config.storage?.otherHomes ?? []).forEach((raw, n) => {
      const dir = path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()));
      const key = normalizeForCompare(dir);
      if (key === own) return;
      let home = homes.get(key);
      if (!home || home.n !== n) {
        // Its keys open what it sealed, only to read it: nothing of this folder is sealed with them.
        openWithKeysAt(path.join(dir, 'keys'));
        home = { n, label: tilde(dir), store: new SessionStore(path.join(dir, 'sessions'), new BlobStore(path.join(dir, 'blobs'))) };
        homes.set(key, home);
      }
      out.push(home);
    });
    return out;
  }

  /** The other folder a session is in, when it is not one of this folder's own. */
  function homeOf(id: string): OtherHome | undefined {
    const homes = otherHomes();
    if (!homes.length || rt.store.metaOf(id)) return undefined;
    return homes.find((h) => h.store.peekIndex()?.[id]);
  }

  /** The sessions of the other folders for the sidebar, newest first, each marked with its folder. */
  function list(cwd: string | undefined, limit: number): (SessionMeta & { live: 'running' | null; home: string })[] {
    const out: (SessionMeta & { live: 'running' | null; home: string })[] = [];
    for (const h of otherHomes()) {
      const index = h.store.peekIndex();
      if (!index) continue;
      for (const { meta } of Object.values(index)) {
        if (meta.hidden || meta.parentId || (cwd && normalizeForCompare(meta.cwd) !== normalizeForCompare(cwd))) continue;
        out.push({ ...meta, live: h.store.locks.holder(meta.id) ? 'running' : null, home: h.label });
      }
    }
    return out.sort((a, b) => b.updated - a.updated).slice(0, limit);
  }

  const blobUrl = (home?: OtherHome) => (id: string) => (home ? `/api/blob/${id}?home=${home.n}` : `/api/blob/${id}`);

  /**
   * A message as the page gets it, with nothing written: an image kept inline is left out rather than stored. `lighten`
   * builds new parts; the one field it sets on the message's own image parts is the blob they already name.
   */
  function shown(m: Message, store: SessionStore, home?: OtherHome): Message {
    const blobs = Object.create(store.blobs, { put: { value: () => undefined } }) as BlobStore;
    return lighten(m, blobs, blobUrl(home));
  }

  function model(meta: SessionMeta): ModelInfo {
    try {
      return rt.catalog.resolve(`${meta.provider}/${meta.model}`);
    } catch {
      return { id: meta.model, provider: meta.provider, name: meta.model, contextWindow: 0 } as unknown as ModelInfo;
    }
  }

  function usage(rec: SessionRecord): SessionUsage {
    const u = rec.usage as Partial<SessionUsage> | undefined;
    return { contextTokens: 0, contextWindow: 0, compactAt: 0, totalInput: 0, totalOutput: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0, ...u };
  }

  function following(store: SessionStore, id: string, home?: OtherHome): Following {
    return { holder: store.locks.holder(id)?.pid ?? null, ...(home ? { home: home.label } : {}) };
  }

  /** The view of a session this process only reads, in the shape of a live one's; null when it cannot be read. */
  function view(id: string, home?: OtherHome) {
    const store = home?.store ?? rt.store;
    let peek = watched.get(id)?.follow.record;
    if (!peek) {
      const read = store.peek(id);
      if (!read) return null;
      viewed = { id, store, peek: read, at: Date.now() };
      // Not kept past the time a page takes to open its stream.
      setTimeout(() => {
        if (viewed?.peek === read) viewed = null;
      }, KEEP_VIEW_MS).unref();
      peek = read.record;
    }
    return {
      meta: peek.meta,
      messages: peek.messages.map((m) => shown(m, store, home)),
      activeStart: peek.activeStart,
      todos: peek.todos,
      usage: usage(peek),
      status: 'idle' as const,
      pending: { permissions: [], questions: [], plans: [] },
      queued: [],
      held: null,
      model: model(peek.meta),
      turns: [],
      live: null,
      returned: [],
      following: following(store, id, home),
    };
  }

  /** A change as the page gets it. */
  function change(c: FollowChange, store: SessionStore, home?: OtherHome) {
    return {
      meta: c.record.meta,
      added: c.added.map((m) => shown(m, store, home)),
      reset: c.reset,
      activeStart: c.record.activeStart,
      todos: c.record.todos,
      usage: usage(c.record),
      following: { holder: c.holder?.pid ?? null, ...(home ? { home: home.label } : {}) },
    };
  }

  /**
   * An event stream of one session's changes for a page that shows it: one watch for every page on it, ended with the
   * last. False when there is nothing to follow (no such session, or it cannot be read here).
   */
  function stream(req: http.IncomingMessage, res: http.ServerResponse, id: string, after: number, home?: OtherHome): boolean {
    const store = home?.store ?? rt.store;
    let entry = watched.get(id);
    if (!entry) {
      const pages = new Set<http.ServerResponse>();
      const kept = viewed?.id === id && viewed.store === store && Date.now() - viewed.at < KEEP_VIEW_MS ? viewed.peek : undefined;
      viewed = null;
      const follow = SessionFollow.start(store, id, (c) => {
        const data = `data: ${JSON.stringify(change(c, store, home))}\n\n`;
        for (const page of pages) page.write(data);
      }, kept);
      if (!follow) return false;
      entry = { follow, pages };
      watched.set(id, entry);
    }
    const { pages, follow } = entry;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    // What came in between the page's view and this stream, told to the pages already following; this one gets it
    // below from the `after` messages it has.
    follow.read();
    pages.add(res);
    const rec = follow.record;
    const behind = after > rec.messages.length;
    const c: FollowChange = { record: rec, added: behind ? [] : rec.messages.slice(after), reset: behind, holder: follow.holder() };
    res.write(`data: ${JSON.stringify(change(c, store, home))}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    const done = () => {
      clearInterval(ping);
      pages.delete(res);
      if (!pages.size && watched.get(id) === entry) {
        follow.close();
        watched.delete(id);
      }
    };
    req.on('close', done);
    res.on('error', done);
    return true;
  }

  function close(): void {
    for (const { follow, pages } of watched.values()) {
      follow.close();
      for (const page of pages) page.end();
    }
    watched.clear();
  }

  return { otherHomes, homeOf, list, view, stream, close, home: (n: number) => otherHomes().find((h) => h.n === n) };
}
