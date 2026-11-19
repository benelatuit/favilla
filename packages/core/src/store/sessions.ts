import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Message, Mode, SessionMeta, SessionUsage, Todo, Usage } from '../types';
import { appPath, ensureDir, projectSlug } from '../util/paths';
import { pauseSync, writeFileAtomic } from '../auth/store';
import { debug } from '../util/log';
import type { ActivePreset } from '../prompt/preset';
import { BlobStore, blobIds } from './blobs';
import { SessionLocks } from './locks';
import { blobRefs, forDisk, fromDisk, release, repack, withImages } from './pack';
import { KeyStoreUnavailable, openLines, seal, SealError, sealLine, sealLines, unseal } from './seal';
import { timedSync } from '../util/slow';

/** How long a write of the index waits its turn, and how old a lock has to be to count as left behind. */
const LOCK_WAIT_MS = 1500;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 10_000;

export interface SessionRecord {
  meta: SessionMeta;
  system: string;
  messages: Message[];
  /** Index of the first message in the model's active context (after the latest compaction). */
  activeStart: number;
  todos: Todo[];
  usage?: SessionUsage;
  /** The session's own copy of its preset: changing the library later does not reach it. */
  preset?: ActivePreset | null;
}

type Line =
  | { t: 'session'; meta: SessionMeta; system: string }
  | { t: 'meta'; meta: SessionMeta }
  | { t: 'system'; system: string }
  | { t: 'preset'; preset: ActivePreset | null }
  | { t: 'msg'; m: Message; consumed?: string[] }
  | { t: 'compact'; start: number }
  /** Blobs that messages before the active context were moved to, recorded so housekeeping keeps them. */
  | { t: 'released'; ids: string[] }
  /** Tool output cut to stubs by light compaction; the full text is in the blob store. */
  | { t: 'prune'; items: { callId: string; stub: string; blob: string }[] }
  | { t: 'todos'; todos: Todo[] }
  | { t: 'usage'; usage: SessionUsage }
  /**
   * A branch's history up to its branch point: the first `messages` messages of session `id`'s file, which keeps
   * them in order whatever is appended or repacked later. The compaction and the prunes among them are the branch's
   * own lines, written when it was made.
   */
  | { t: 'base'; id: string; messages: number };

type StoredMeta = Omit<SessionMeta, 'mode'> & { mode: Mode | 'wish'; wish?: unknown };

/** The old mode and its progress are read as build metadata; the session history stays as written. */
function sessionMeta(meta: StoredMeta): SessionMeta {
  const { mode, wish: _progress, ...rest } = meta;
  return { ...rest, mode: mode === 'wish' ? 'build' : mode };
}

export interface IndexEntry {
  slug: string;
  meta: SessionMeta;
}

type Index = Record<string, IndexEntry>;

function recoverMeta(text: string | null, id: string): SessionMeta | undefined {
  let meta: SessionMeta | undefined;
  for (const raw of text?.split('\n') ?? []) {
    if (!raw.startsWith('{"t":"session"') && !raw.startsWith('{"t":"meta"')) continue;
    const line = parseLine(raw);
    if (line?.t !== 'session' && line?.t !== 'meta') continue;
    if (line.meta?.id === id && typeof line.meta.cwd === 'string') meta = sessionMeta(line.meta);
  }
  return meta;
}

/** A session file being read into its record. */
interface Reading {
  rec: SessionRecord;
  prunes: Map<string, { stub: string; blob: string }>;
  consumed?: Set<string>;
  /** Messages that came from a branch's source: that file names their blobs, so this one need not. */
  based: number;
}

/** A line of a session file; null for an empty or torn one. */
function parseLine(raw: string): Line | null {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as Line;
  } catch {
    return null;
  }
}

/** The session a branch's file reads its history from, if it is a branch (the `base` line, near its top). */
function baseOf(text: string): string | undefined {
  const at = text.indexOf('\n{"t":"base"');
  if (at < 0) return undefined;
  const end = text.indexOf('\n', at + 1);
  const line = parseLine(text.slice(at + 1, end < 0 ? undefined : end));
  return line?.t === 'base' ? line.id : undefined;
}

const brotli = promisify(zlib.brotliCompress);
const decompress = promisify(zlib.brotliDecompress);
const ARCHIVE_CHUNK = 128 * 1024;

// Large histories fill the default 16 KiB output buffer many times on the thread pool.
const unbrotli = (packed: Buffer) => packed.length >= ARCHIVE_CHUNK
  ? decompress(packed, { chunkSize: ARCHIVE_CHUNK })
  : decompress(packed);

function addUp(a: { removed: number; freed: number }, b: { removed: number; freed: number }) {
  return { removed: a.removed + b.removed, freed: a.freed + b.freed };
}

/** Delete files older than `maxAgeMs` in these folders (command logs the model was pointed to long ago). */
async function removeOld(dirs: string[], maxAgeMs: number): Promise<{ removed: number; freed: number }> {
  let removed = 0;
  let freed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const f = path.join(dir, name);
      try {
        const st = await fsp.stat(f);
        if (!st.isFile() || st.mtimeMs > cutoff) continue;
        await fsp.rm(f, { force: true });
        removed++;
        freed += st.size;
      } catch {
        /* in use or gone */
      }
    }
  }
  return { removed, freed };
}

/**
 * Sessions are append-only JSONL files (one line per event, each sealed on its own when sealing is on), so a
 * crash loses at most the line being written and a session can be resumed exactly as the model last saw it.
 */
/** A session read for viewing while another process writes it (see SessionStore.peek). */
export interface SessionPeek {
  readonly record: SessionRecord;
  /** The messages added since the last read; `reset` when the file was rewritten and the record read again whole. */
  more(): { added: Message[]; reset: boolean; changed: boolean } | null;
}

export class SessionStore {
  private index: Index | null = null;
  private indexTimer: NodeJS.Timeout | null = null;
  /** The index file this process read, even if the clock gives its replacement the same timestamp. */
  private indexStamp = '';
  /** Entries this process changed or removed since its last write, merged into whatever is on disk. */
  private dirty = new Set<string>();
  private removed = new Set<string>();

  /** Images, released tool results and file snapshots, stored once and compressed. */
  readonly blobs: BlobStore;
  /** Which process has a session open, so two never write one. */
  readonly locks: SessionLocks;

  /** `blobs` for a store of another Favilla folder, whose blobs sit beside its sessions rather than in them. */
  constructor(readonly root = appPath('sessions'), blobs?: BlobStore) {
    this.blobs = blobs ?? new BlobStore(root === appPath('sessions') ? appPath('blobs') : path.join(root, 'blobs'));
    this.locks = new SessionLocks(root);
  }

  private indexFile(): string {
    return path.join(this.root, 'index.json');
  }

  /** Raw bytes for malformed JSON. An I/O error or a missing key must never count as corruption. */
  private readIndexFile(): Index | Buffer | null {
    for (let tries = 0; ; tries++) {
      let raw: Buffer;
      let text: string;
      try {
        raw = fs.readFileSync(this.indexFile());
        const plain = unseal(raw);
        if (!isUtf8(plain)) return raw;
        text = plain.toString('utf8');
      } catch (e) {
        if (e instanceof KeyStoreUnavailable) throw e;
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
        if (e instanceof SealError || tries >= 5) return null;
        pauseSync(20);
        continue;
      }
      try {
        const index = JSON.parse(text) as Record<string, { slug: string; meta: StoredMeta }>;
        if (!index || typeof index !== 'object' || Array.isArray(index)) return raw;
        const entries = Object.entries(index);
        if (entries.some(([id, entry]) => typeof entry?.slug !== 'string' || entry.meta?.id !== id || typeof entry.meta.cwd !== 'string')) return raw;
        return Object.fromEntries(entries.map(([id, { slug, meta }]) => [id, { slug, meta: sessionMeta(meta) }]));
      } catch {
        return raw;
      }
    }
  }

  /** A healthy index is read directly. Only a writer holding its lock can put back a damaged one. */
  private repairIndex(): Index | null {
    for (let waited = 0; waited < LOCK_WAIT_MS; waited += LOCK_RETRY_MS) {
      const unlock = this.tryIndexLock();
      if (unlock) {
        try {
          const disk = this.readIndexFile();
          if (!Buffer.isBuffer(disk)) return disk;
          const index = this.rebuildIndex(disk);
          this.putIndex(index);
          return index;
        } catch (e) {
          debug('store', 'index not rebuilt', String(e));
          return null;
        } finally {
          unlock();
        }
      }
      pauseSync(LOCK_RETRY_MS);
    }
    return null;
  }

  private rebuildIndex(bytes: Buffer): Index {
    const entries: Index = Object.create(null);
    for (const dir of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name === 'blobs' || dir.name.endsWith('.lock')) continue;
      let names: string[];
      try { names = fs.readdirSync(path.join(this.root, dir.name)); }
      catch { continue; }
      const ids = new Set(names.filter((n) => /\.jsonl(?:\.br)?$/.test(n)).map((n) => n.replace(/\.jsonl(?:\.br)?$/, '')));
      for (const id of ids) {
        const meta = recoverMeta(this.readSessionText(path.join(this.root, dir.name, `${id}.jsonl`)), id);
        if (meta) entries[id] = { slug: dir.name, meta };
      }
    }
    writeFileAtomic(`${this.indexFile()}.broken`, bytes);
    return entries;
  }

  private putIndex(index: Index): void {
    writeFileAtomic(this.indexFile(), seal(Buffer.from(JSON.stringify(index), 'utf8')));
  }

  /** One process at a time reads, merges and writes the index: two doing it together lose each other's sessions. */
  private tryIndexLock(): (() => void) | undefined {
    const lock = `${this.indexFile()}.lock`;
    try {
      fs.mkdirSync(lock);
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch {
      // A lock this old belongs to a process that died holding it.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // Gone already: the next try takes it.
      }
    }
  }

  private indexFileStamp(): string {
    try {
      const s = fs.statSync(this.indexFile(), { bigint: true });
      return `${s.ino}:${s.mtimeNs}:${s.size}`;
    } catch {
      return '';
    }
  }

  /** The index; re-read when another process (the CLI, another window) has written it, keeping this process's changes. */
  private loadIndex(): Record<string, IndexEntry> {
    const stamp = this.indexFileStamp();
    if (this.index && stamp === this.indexStamp) return this.index;
    const read = this.readIndexFile();
    const disk = Buffer.isBuffer(read) ? this.repairIndex() : read;
    if (!disk) return (this.index ??= {});
    if (this.index) {
      for (const id of this.dirty) if (this.index[id]) disk[id] = this.index[id];
      for (const id of this.removed) delete disk[id];
    }
    this.index = disk;
    this.indexStamp = stamp;
    return disk;
  }

  private saveIndexSoon(): void {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.flushIndexAsync().catch((e) => debug('store', 'index not written', String(e)));
    }, 200);
  }

  /** Write this process's changes to the index; `again` writes it even with none (sealed, after sealing was turned on). */
  flushIndex(again = false): void {
    for (const _ of this.indexWrites(again)) pauseSync(LOCK_RETRY_MS);
  }

  /** A turn and the timer can wait for another writer without holding up other sessions or windows. */
  async flushIndexAsync(): Promise<void> {
    for (const _ of this.indexWrites(false)) await delay(LOCK_RETRY_MS);
  }

  private *indexWrites(again: boolean): Generator<void> {
    if (again) this.loadIndex();
    if (!this.index || (!again && !this.dirty.size && !this.removed.size)) return;
    ensureDir(this.root);
    for (let waited = 0; waited < LOCK_WAIT_MS; waited += LOCK_RETRY_MS) {
      const unlock = this.tryIndexLock();
      if (unlock) return this.writeIndex(again, unlock);
      yield;
      if (!again && !this.dirty.size && !this.removed.size) return;
    }
    if (again) throw new Error('Session index is busy');
    this.saveIndexSoon();
    this.indexTimer?.unref();
  }

  private writeIndex(again: boolean, unlock: () => void): void {
    try {
      if (!this.index || (!again && !this.dirty.size && !this.removed.size)) return;
      // Merge into what is on disk now, so sessions other processes added survive this write.
      const read = this.readIndexFile();
      if (!read) throw new Error('index unreadable');
      const disk = Buffer.isBuffer(read) ? this.rebuildIndex(read) : read;
      for (const id of this.dirty) if (this.index[id]) disk[id] = this.index[id];
      for (const id of this.removed) delete disk[id];
      this.putIndex(disk);
      this.index = disk;
      this.indexStamp = this.indexFileStamp();
      this.dirty.clear();
      this.removed.clear();
    } catch (e) {
      // The session itself is safe in its own file. The entry stays marked and goes out with the next write.
      debug('store', 'index not written', String(e));
      this.saveIndexSoon();
      this.indexTimer?.unref();
    } finally {
      unlock();
    }
  }

  /** Folder for a session's side data (outputs, checkpoints). */
  dataDir(meta: SessionMeta): string {
    return path.join(this.root, projectSlug(meta.cwd), meta.id);
  }

  private file(meta: SessionMeta): string {
    return path.join(this.root, projectSlug(meta.cwd), `${meta.id}.jsonl`);
  }

  /** A session not in use is kept Brotli-compressed as <id>.jsonl.br (cold); writing to it makes it plain again. */
  private coldFile(hot: string): string {
    return `${hot}.br`;
  }

  private append(meta: SessionMeta, line: Line): void {
    if (this.locks.owns(meta.id)) this.appendHeld(meta, line);
    else this.locks.writeWithoutLease(meta.id, () => this.appendHeld(meta, line));
  }

  private appendHeld(meta: SessionMeta, line: Line): void {
    const f = this.file(meta);
    ensureDir(path.dirname(f));
    timedSync('session thawed', () => this.thaw(f));
    try {
      this.mendTail(f);
      fs.appendFileSync(f, `${sealLine(JSON.stringify(line))}\n`);
    } catch (error) {
      // A failed write can leave half a line even when this process is still running.
      this.mended.delete(f);
      throw error;
    }
  }

  /** Files whose end this process has checked before writing to them. */
  private mended = new Set<string>();

  /** A crash mid-write leaves a line without its end; the next line must not run into it and be lost with it. */
  private mendTail(f: string): void {
    if (this.mended.has(f)) return;
    this.mended.add(f);
    let last = 0x0a;
    try {
      const fd = fs.openSync(f, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const b = Buffer.alloc(1);
        if (size && fs.readSync(fd, b, 0, 1, size - 1) === 1) last = b[0];
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return; // a new file
    }
    if (last !== 0x0a) fs.appendFileSync(f, '\n');
  }

  /**
   * Back to a plain file to write to, its lines sealed one by one as new lines are. Written beside it and renamed: a
   * process stopped while it wrote the plain file in place left it cut short, and from then on that was read before
   * the whole compressed one, and compressed over it.
   */
  private thaw(hot: string): void {
    const cold = this.coldFile(hot);
    if (fs.existsSync(hot) || !fs.existsSync(cold)) return;
    writeFileAtomic(hot, sealLines(zlib.brotliDecompressSync(unseal(fs.readFileSync(cold))).toString('utf8')));
    fs.rmSync(cold, { force: true });
  }

  /** The session's lines in plain text, from whichever file holds it; null when there is none or it will not open. */
  private readSessionText(hot: string): string | null {
    let text: string;
    try {
      text = fs.readFileSync(hot, 'utf8');
    } catch {
      try {
        text = zlib.brotliDecompressSync(unseal(fs.readFileSync(this.coldFile(hot)))).toString('utf8');
      } catch (e) {
        if (e instanceof KeyStoreUnavailable) throw e;
        return null;
      }
    }
    try {
      return openLines(text);
    } catch (e) {
      if (e instanceof KeyStoreUnavailable) throw e;
      return null;
    }
  }

  /** As `readSessionText`, read and unpacked on the thread pool. */
  private async readSessionTextAsync(hot: string): Promise<string | null> {
    let text: string;
    try {
      text = await fsp.readFile(hot, 'utf8');
    } catch {
      try {
        text = (await unbrotli(unseal(await fsp.readFile(this.coldFile(hot))))).toString('utf8');
      } catch (e) {
        if (e instanceof KeyStoreUnavailable) throw e;
        // A writer can have thawed the archive between the two reads.
        const thawed = await fsp.readFile(hot, 'utf8').catch(() => null);
        if (thawed === null) return null;
        text = thawed;
      }
    }
    try {
      return openLines(text);
    } catch (e) {
      if (e instanceof KeyStoreUnavailable) throw e;
      return null;
    }
  }

  /** A session's lines by id (see `readSessionText`). */
  private textOf(id: string): string | null {
    const entry = this.loadIndex()[id];
    return entry ? this.readSessionText(path.join(this.root, entry.slug, `${id}.jsonl`)) : null;
  }

  /**
   * Compress a session file that is not being written: first repacked (see `repack`: what only an old
   * provider replay needed goes, and old long outputs are kept once, in the blob store), then Brotli with a
   * 16 MB window, so repeats across the whole conversation shrink too. Compression runs on the thread pool;
   * a file that grew meanwhile stays plain. Only publication holds the gate used by a new writer.
   */
  async freeze(id: string): Promise<boolean> {
    const entry = this.loadIndex()[id];
    if (!entry || this.locks.holder(id)) return false;
    const hot = path.join(this.root, entry.slug, `${id}.jsonl`);
    let raw: Buffer;
    let text: string;
    try {
      raw = await fsp.readFile(hot);
      text = openLines(raw.toString('utf8'));
    } catch {
      return false;
    }
    const lines = Buffer.from(await repack(text, this.blobs), 'utf8');
    // The slowest setting packs about 7% tighter; worth it while a file takes at most a few seconds.
    const quality = lines.length <= 4 * 1024 * 1024 ? 11 : 9;
    const packed = await brotli(lines, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: lines.length },
    });
    const cold = this.coldFile(hot);
    // Two engines may prepare a pack of the same session, each from a different point in its history.
    const tmp = `${cold}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, seal(packed));
      try {
        return this.locks.publishArchive(id, () => {
          if (fs.statSync(hot).size !== raw.length) return false;
          fs.renameSync(tmp, cold);
          fs.rmSync(hot, { force: true });
          this.mended.delete(hot);
          return true;
        });
      } catch {
        return false;
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /**
   * Put session files the index has lost back into it (a crash between writing a session and the index,
   * or an older version's index race), so no conversation goes missing from the list.
   */
  async recoverOrphans(): Promise<number> {
    const index = this.loadIndex();
    let n = 0;
    let slugs: string[];
    try {
      slugs = (await fsp.readdir(this.root, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== 'blobs').map((d) => d.name);
    } catch {
      return 0;
    }
    for (const slug of slugs) {
      let names: string[];
      try {
        names = await fsp.readdir(path.join(this.root, slug));
      } catch {
        continue;
      }
      for (const name of names) {
        const id = name.replace(/\.jsonl(\.br)?$/, '');
        if (id === name || index[id]) continue;
        const meta = recoverMeta(this.readSessionText(path.join(this.root, slug, `${id}.jsonl`)), id);
        if (!meta) continue;
        index[id] = { slug, meta };
        this.dirty.add(id);
        n++;
      }
    }
    if (n) this.flushIndex();
    return n;
  }

  /** Freeze every plain session file not written for a while and not open here (left by crashes or other processes). */
  async freezeIdle(open: Set<string>, idleMs = 10 * 60_000): Promise<number> {
    let n = 0;
    for (const [id, entry] of Object.entries(this.loadIndex())) {
      if (open.has(id)) continue;
      try {
        if (Date.now() - fs.statSync(path.join(this.root, entry.slug, `${id}.jsonl`)).mtimeMs < idleMs) continue;
      } catch {
        continue;
      }
      if (await this.freeze(id)) n++;
    }
    return n;
  }

  /**
   * Housekeeping, at most once a day: delete blobs that no session line and no checkpoint refers to (a
   * deleted session leaves its images, released outputs and snapshots there), and the full-output logs of
   * commands older than a week. Reads files asynchronously so a front end in the same process stays responsive.
   */
  async collectGarbage(force = false): Promise<{ removed: number; freed: number }> {
    const none = { removed: 0, freed: 0 };
    const stamp = path.join(this.blobs.root, '.gc');
    try {
      if (!force && Date.now() - fs.statSync(stamp).mtimeMs < 24 * 3600_000) return none;
    } catch {
      /* never ran */
    }
    const live = new Set<string>();
    let logs = { removed: 0, freed: 0 };
    const slugs = new Set(Object.values(this.loadIndex()).map((e) => e.slug));
    for (const slug of slugs) {
      const dir = path.join(this.root, slug);
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const f = path.join(dir, name);
        try {
          // Sealed lines are opened first: the names of the blobs they keep are inside.
          if (name.endsWith('.jsonl')) blobIds(openLines(await fsp.readFile(f, 'utf8'))).forEach((b) => live.add(b));
          else if (name.endsWith('.jsonl.br')) blobIds(openLines((await unbrotli(unseal(await fsp.readFile(f)))).toString('utf8'))).forEach((b) => live.add(b));
          else if (!name.includes('.')) {
            const index = path.join(f, 'checkpoints', 'index.jsonl');
            if (fs.existsSync(index)) blobIds(await fsp.readFile(index, 'utf8')).forEach((b) => live.add(b));
            const dirs = [path.join(f, 'outputs'), path.join(f, 'jobs')];
            // A live session still owes the model its unread job output, even after a week.
            if (!this.locks.owns(name) && !this.locks.holder(name)) dirs.push(path.join(f, 'jobs', '.unread'));
            logs = addUp(logs, await removeOld(dirs, 7 * 24 * 3600_000));
          }
        } catch {
          // A file that cannot be read may hold references: leave every blob alone this time.
          return none;
        }
      }
    }
    const result = addUp(this.blobs.gc(live), logs);
    await fsp.mkdir(this.blobs.root, { recursive: true });
    await fsp.writeFile(stamp, String(Date.now()));
    return result;
  }

  private saveEntry(meta: SessionMeta, line: Line): void {
    this.append(meta, line);
    this.loadIndex()[meta.id] = { slug: projectSlug(meta.cwd), meta };
    this.dirty.add(meta.id);
    this.removed.delete(meta.id);
    this.saveIndexSoon();
  }

  create(meta: SessionMeta, system: string): void {
    this.saveEntry(meta, { t: 'session', meta, system });
  }

  saveMeta(meta: SessionMeta): void {
    this.saveEntry(meta, { t: 'meta', meta });
  }

  saveSystem(meta: SessionMeta, system: string): void {
    this.append(meta, { t: 'system', system });
  }

  savePreset(meta: SessionMeta, preset: ActivePreset | null): void {
    this.append(meta, { t: 'preset', preset });
  }

  saveMessage(meta: SessionMeta, m: Message, consumed?: string[]): void {
    this.append(meta, { t: 'msg', m: forDisk(m, this.blobs), ...(consumed?.length ? { consumed } : {}) });
  }

  /** A failed append can still have left a complete line (the newline or close was what failed). */
  messageSaved(meta: SessionMeta, id: string): boolean {
    return this.readSessionText(this.file(meta))?.split('\n').some((raw) => {
      const line = parseLine(raw);
      return line?.t === 'msg' && line.m.id === id;
    }) ?? false;
  }

  saveCompaction(meta: SessionMeta, start: number): void {
    this.append(meta, { t: 'compact', start });
  }

  /** A branch's history read from its source's file (see the `base` line) instead of copied into its own. */
  saveBase(meta: SessionMeta, base: { id: string; messages: number }): void {
    this.append(meta, { t: 'base', ...base });
  }

  /** Sessions that read this one's file as the history before their branch point. */
  private readers(id: string): string[] {
    return Object.entries(this.loadIndex())
      .filter(([, e]) => e.meta.base?.id === id)
      .map(([rid]) => rid);
  }

  /** How many files reading this session's history goes through beyond its own (0 for a session that is no branch). */
  baseDepth(id: string): number {
    let n = 0;
    for (let base = this.metaOf(id)?.base; base && n < 64; base = this.metaOf(base.id)?.base) n++;
    return n;
  }

  savePrune(meta: SessionMeta, items: { callId: string; stub: string; blob: string }[]): void {
    if (items.length) this.append(meta, { t: 'prune', items });
  }

  saveReleased(meta: SessionMeta, ids: string[]): void {
    if (ids.length) this.append(meta, { t: 'released', ids: [...new Set(ids)] });
  }

  saveTodos(meta: SessionMeta, todos: Todo[]): void {
    this.append(meta, { t: 'todos', todos });
  }

  saveUsage(meta: SessionMeta, usage: SessionUsage): void {
    this.append(meta, { t: 'usage', usage });
  }

  touch(meta: SessionMeta): void {
    const entry = this.loadIndex()[meta.id];
    if (entry) {
      entry.meta = meta;
      this.saveIndexSoon();
    }
  }

  load(id: string): SessionRecord | null {
    return timedSync('session read', () => this.loadRecord(id));
  }

  private loadRecord(id: string): SessionRecord | null {
    const entry = this.loadIndex()[id];
    if (!entry) return null;
    const text = this.readSessionText(path.join(this.root, entry.slug, `${id}.jsonl`));
    if (text === null) return null;
    const into = this.reading(entry);
    for (const line of this.lines(text, (source) => this.textOf(source))) this.take(into, line);
    return this.finishRecord(into, text);
  }

  /**
   * The index as it is on disk, for a store another process owns: read each time, never repaired, cached or written.
   * Null when it cannot be read here (torn, or sealed under a key that is not here).
   */
  peekIndex(): Record<string, IndexEntry> | null {
    const read = this.readIndexFile();
    return read && !Buffer.isBuffer(read) ? read : null;
  }

  /**
   * A session as it is on disk, for watching one another process writes: nothing is written, not the index, the
   * file, its blobs or its unread mark. `more()` takes in the lines added since the last read, from the byte where
   * that read ended; a file that shrank or was put away is read again whole. Null when there is no such session or
   * it cannot be read here.
   */
  peek(id: string): SessionPeek | null {
    const entry = this.peekIndex()?.[id];
    if (!entry) return null;
    const hot = path.join(this.root, entry.slug, `${id}.jsonl`);
    const sourceText = (source: string) => {
      const e = this.peekIndex()?.[source];
      return e ? this.readSessionText(path.join(this.root, e.slug, `${source}.jsonl`)) : null;
    };
    let into = this.reading(entry);
    /** Bytes of the plain file read so far, up to the end of its last whole line; -1 while it is put away. */
    let offset = 0;
    const takeIn = (text: string): void => {
      for (const line of this.lines(openLines(text), sourceText)) this.take(into, line);
      // Light compaction as `load` replays it; the stubs stand in for the output.
      if (into.prunes.size)
        for (const m of into.rec.messages)
          for (const p of m.parts) {
            const it = p.type === 'tool_result' ? into.prunes.get(p.callId) : undefined;
            if (it && p.type === 'tool_result' && !p.pruned) Object.assign(p, { content: it.stub, contentBlob: it.blob, pruned: true });
          }
    };
    /** The whole lines from `start` to the end of the file, and where they end; null when it is not there. */
    const tail = (start: number): { text: string; end: number } | null => {
      let fd: number;
      try {
        fd = fs.openSync(hot, 'r');
      } catch {
        return null;
      }
      try {
        const size = fs.fstatSync(fd).size;
        if (size < start) return { text: '', end: -2 };
        const buf = Buffer.alloc(size - start);
        let got = 0;
        while (got < buf.length) {
          const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
          if (!n) break;
          got += n;
        }
        // A line still being written waits for its end.
        const last = buf.lastIndexOf(0x0a, got - 1);
        return last < 0 ? { text: '', end: start } : { text: buf.subarray(0, last + 1).toString('utf8'), end: start + last + 1 };
      } finally {
        fs.closeSync(fd);
      }
    };
    const whole = (): boolean => {
      into = this.reading(entry);
      const t = tail(0);
      if (t) {
        offset = t.end;
        takeIn(t.text);
        return true;
      }
      const text = this.readSessionText(hot);
      if (text === null) return false;
      offset = -1;
      takeIn(text);
      return true;
    };
    try {
      if (!whole()) return null;
    } catch (e) {
      if (e instanceof KeyStoreUnavailable) throw e;
      return null;
    }
    return {
      get record() {
        return into.rec;
      },
      more: () => {
        const before = into.rec.messages.length;
        const t = offset >= 0 ? tail(offset) : null;
        if (!t || t.end === -2) {
          // Put away, or written again from the start: read whole.
          const was = into.rec.messages;
          if (!whole()) return null;
          const same = into.rec.messages.length >= was.length && was.every((m, i) => into.rec.messages[i].id === m.id);
          return { added: same ? into.rec.messages.slice(was.length) : [], reset: !same, changed: true };
        }
        if (t.end === offset) return { added: [], reset: false, changed: false };
        offset = t.end;
        takeIn(t.text);
        return { added: into.rec.messages.slice(before), reset: false, changed: true };
      },
    };
  }

  /**
   * As `load`, letting the thread go: the file (and a branch's sources) is read and unpacked on the thread pool and
   * its lines are read in slices of 30 ms, so opening a long session holds up nothing else (a 300-step one held the
   * desktop engine 452 ms).
   */
  async loadAsync(id: string): Promise<SessionRecord | null> {
    const entry = this.loadIndex()[id];
    if (!entry) return null;
    const text = await this.readSessionTextAsync(path.join(this.root, entry.slug, `${id}.jsonl`));
    if (text === null) return null;
    const sources = new Map<string, string | null>();
    for (let source = baseOf(text); source && !sources.has(source) && sources.size < 16; ) {
      const entry = this.loadIndex()[source];
      const t = entry ? await this.readSessionTextAsync(path.join(this.root, entry.slug, `${source}.jsonl`)) : null;
      sources.set(source, t);
      source = t ? baseOf(t) : undefined;
    }
    const into = this.reading(entry);
    let since = performance.now();
    for (const line of this.lines(text, (source) => sources.get(source) ?? null)) {
      this.take(into, line);
      if (performance.now() - since > 30) {
        await new Promise((r) => setImmediate(r));
        since = performance.now();
      }
    }
    return this.finishRecord(into, text);
  }

  private reading(entry: IndexEntry): Reading {
    return { rec: { meta: entry.meta, system: '', messages: [], activeStart: 0, todos: [] }, prunes: new Map(), based: 0 };
  }

  /** A session file's lines, a branch's `base` line after the message lines it stands for. */
  private *lines(text: string, read: (id: string) => string | null): Generator<Line> {
    for (const raw of text.split('\n')) {
      const line = parseLine(raw);
      if (!line) continue;
      if (line.t === 'base') yield* this.baseMessages(line, read, 0);
      yield line;
    }
  }

  /**
   * The message lines a branch's `base` line stands for: the first `messages` of its source's file, read through the
   * source's own base when that is a branch too. Only those lines are opened: the source's meta, prompt, plan and
   * usage stay its own.
   */
  private *baseMessages(base: { id: string; messages: number }, read: (id: string) => string | null, depth: number): Generator<Line> {
    const text = depth < 16 ? read(base.id) : null;
    if (!text) return;
    let n = 0;
    for (const raw of text.split('\n')) {
      if (n >= base.messages) return;
      if (!raw.startsWith('{"t":"msg"') && !raw.startsWith('{"t":"base"')) continue;
      const line = parseLine(raw);
      const found = line?.t === 'base' ? this.baseMessages(line, read, depth + 1) : line ? [line] : [];
      for (const m of found) {
        if (n++ >= base.messages) return;
        yield m;
      }
    }
  }

  /** One line of a session file into the record being read. */
  private take(into: Reading, line: Line): void {
    const { rec, prunes } = into;
    switch (line.t) {
      case 'base':
        into.based = rec.messages.length;
        break;
      case 'session':
        rec.meta = sessionMeta(line.meta);
        rec.system = line.system;
        break;
      case 'meta':
        rec.meta = sessionMeta(line.meta);
        break;
      case 'system':
        rec.system = line.system;
        break;
      case 'preset':
        rec.preset = line.preset;
        break;
      case 'msg':
        rec.messages.push(fromDisk(line.m));
        if (line.consumed) for (const id of line.consumed) (into.consumed ??= new Set()).add(id);
        break;
      case 'compact':
        rec.activeStart = line.start;
        break;
      case 'todos':
        rec.todos = line.todos;
        break;
      case 'usage':
        rec.usage = line.usage;
        break;
      case 'prune':
        for (const it of line.items) prunes.set(it.callId, it);
        break;
    }
  }

  /** The record once all its lines are read: prunes replayed, images back where the model sees them. */
  private finishRecord(into: Reading, text: string): SessionRecord {
    const { rec, prunes, consumed } = into;
    if (consumed && rec.meta.queued) {
      const queued = rec.meta.queued.filter((q) => !q.id || !consumed.has(q.id));
      rec.meta = { ...rec.meta, queued: queued.length ? queued : undefined };
    }
    // Light compaction is replayed: the stubs stand in for the output, which stays in the blob store.
    if (prunes.size) {
      for (const m of rec.messages) {
        for (const p of m.parts) {
          const it = p.type === 'tool_result' ? prunes.get(p.callId) : undefined;
          if (!it || p.type !== 'tool_result') continue;
          p.content = it.stub;
          p.contentBlob = it.blob;
          p.pruned = true;
          for (const img of p.images ?? []) img.data = '';
        }
      }
    }
    // The model sees only messages after the latest compaction: those get their images back. Older ones
    // stay light in memory (their long outputs and images are on disk) and the UI shows them as previews.
    rec.messages.forEach((m, i) => (i >= rec.activeStart ? withImages(m, this.blobs) : release(m, this.blobs)));
    // Sessions compacted before releases were recorded: record them now, once. A branch's history from its source
    // is that file's to record.
    const refs = rec.messages.slice(into.based, rec.activeStart).flatMap(blobRefs);
    if (refs.length) {
      // Only a release candidate needs the set of IDs already named anywhere in the file.
      const recorded = new Set(blobIds(text));
      const missing = refs.filter((b) => !recorded.has(b));
      if (missing.length) this.saveReleased(rec.meta, missing);
    }
    return rec;
  }

  /** A session's metadata from the index, without loading it. */
  metaOf(id: string): SessionMeta | null {
    return this.loadIndex()[id]?.meta ?? null;
  }

  /** The current session for a window still holding an id from before a replacement. */
  replacementOf(id: string): SessionMeta | undefined {
    return Object.values(this.loadIndex()).map((e) => e.meta).find((m) => !m.hidden && m.replaces?.includes(id));
  }

  list(opts: { cwd?: string; limit?: number; children?: boolean } = {}): SessionMeta[] {
    const all = Object.values(this.loadIndex())
      .map((e) => e.meta)
      .filter((m) => !m.hidden)
      .filter((m) => (opts.children ? true : !m.parentId))
      .filter((m) => !opts.cwd || path.resolve(m.cwd).toLowerCase() === path.resolve(opts.cwd).toLowerCase())
      .sort((a, b) => b.updated - a.updated);
    return opts.limit ? all.slice(0, opts.limit) : all;
  }

  /** Every session on disk: sub-agents' and the hidden sources of branches too. */
  everyMeta(): SessionMeta[] {
    return Object.values(this.loadIndex()).map((e) => e.meta);
  }

  /**
   * The replies a session's own file holds, with when they came, the model that wrote them and the tokens they took:
   * no text. A branch's history before its branch point is its source's, so it is counted there once. A reply saved
   * again (finished after it was cut, say) counts as its last save. Null when the file will not open.
   */
  async replyUsage(id: string): Promise<{ at: number; provider?: string; model?: string; usage: Usage }[] | null> {
    const entry = this.loadIndex()[id];
    if (!entry) return null;
    let text: string | null;
    try {
      text = await this.readSessionTextAsync(path.join(this.root, entry.slug, `${id}.jsonl`));
    } catch {
      return null;
    }
    if (text === null) return null;
    const replies = new Map<string, { at: number; provider?: string; model?: string; usage: Usage }>();
    for (const raw of text.split('\n')) {
      if (!raw.startsWith('{"t":"msg"')) continue;
      const m = (parseLine(raw) as { t: 'msg'; m: Message } | null)?.m;
      if (m?.role !== 'assistant' || !m.usage || typeof m.id !== 'string') continue;
      replies.set(m.id, { at: typeof m.time === 'number' ? m.time : entry.meta.updated, provider: m.provider, model: m.model, usage: m.usage });
    }
    return [...replies.values()];
  }

  /**
   * A session goes, with its file. One whose file branches still read for their history stays on disk, hidden from
   * every list, and goes with the last of them; a hidden source no branch reads any more goes with it.
   */
  delete(id: string): void {
    const entry = this.loadIndex()[id];
    if (!entry) return;
    if (this.readers(id).length) {
      // Marked in its own file too, so an index rebuilt from the files still leaves it out.
      this.saveMeta({ ...entry.meta, hidden: true });
      this.flushIndex();
      return;
    }
    const hot = path.join(this.root, entry.slug, `${id}.jsonl`);
    fs.rmSync(hot, { force: true });
    this.mended.delete(hot);
    fs.rmSync(this.coldFile(hot), { force: true });
    fs.rmSync(path.join(this.root, entry.slug, id), { recursive: true, force: true });
    delete this.loadIndex()[id];
    this.dirty.delete(id);
    this.removed.add(id);
    this.flushIndex();
    const base = entry.meta.base?.id;
    if (base && this.loadIndex()[base]?.meta.hidden && !this.readers(base).length) this.delete(base);
  }
}
