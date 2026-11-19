import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BlobStore } from '../store/blobs';
import { binaryContent, fileContent, isBinary, type BinaryContent, type FileContent } from '../util/file-content';
import type { Shadow } from './shadow';

/** A file a turn changed: its content before the turn (null: it did not exist) and now (null: it is gone). */
export interface Change {
  path: string;
  before: FileContent;
  after: FileContent;
  via: 'tool' | 'command';
}

interface Entry {
  turn: string;
  path: string;
  /** Blob id of the file before the turn touched it; null when it did not exist. */
  blob: string | null;
  binary?: BinaryContent;
}

/** A turn's place in the folder's own snapshots (see shadow.ts): the folder before and after it, and what differed. */
interface Point {
  kind: 'point';
  turn: string;
  before: string;
  /** When the turn began (ms): an undo leaves alone what other sessions did in this folder since. */
  at?: number;
  after?: string;
  /** Paths relative to the folder, with /. */
  paths?: string[];
  /** A turn kept from the session this one branched off: that session, and when the branch was made (see adopt). */
  from?: { writer: string; until: number };
}

const MAX_FILE = 20 * 1024 * 1024;

/**
 * Before the agent's file tools change a file, its previous content is stored once per turn,
 * so any turn's file changes can be shown as a diff and undone, even after a restart.
 */
export class Checkpoints {
  private entries: Entry[] = [];
  private seen = new Set<string>();
  private points = new Map<string, Point>();
  /** Turns in the order they first left a mark, file or snapshot. */
  private order: string[] = [];

  constructor(
    private readonly dir: string,
    /** Snapshots go to the shared blob store: compressed, and kept once across turns and sessions. */
    private readonly blobs: BlobStore,
    private readonly enabled = true,
    /** The folder's own snapshots, which also see what commands changed; null where there are none. */
    private readonly shadow: Shadow | null = null,
  ) {
    this.load();
  }

  /** This session as the folder's work log names it (shadow.ts note). */
  private get writer(): string {
    return crypto.createHash('sha1').update(this.dir).digest('hex').slice(0, 12);
  }

  private mark(turn: string): void {
    if (!this.order.includes(turn)) this.order.push(turn);
  }

  private write(line: Entry | Point): void {
    fs.mkdirSync(this.dir, { recursive: true });
    // A process killed mid-write leaves a line without its end: the next one starts on a line of its own, or it
    // would run into the torn one and be lost with it. One byte read per line written.
    let torn = false;
    try {
      const fd = fs.openSync(this.indexFile, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const b = Buffer.alloc(1);
        torn = size > 0 && fs.readSync(fd, b, 0, 1, size - 1) === 1 && b[0] !== 0x0a;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* a new index */
    }
    fs.appendFileSync(this.indexFile, `${torn ? '\n' : ''}${JSON.stringify(line)}\n`);
  }

  /** Take the folder as the turn finds it. Resolves once taken: tools that change files wait for it. */
  async begin(turn: string): Promise<void> {
    if (!this.enabled || !this.shadow) return;
    const at = Date.now();
    this.shadow.note(this.writer, 's');
    const before = await this.shadow.snapshot(`before ${turn}`);
    if (!before) return;
    const p: Point = { kind: 'point', turn, before, at };
    this.points.set(turn, p);
    this.mark(turn);
    this.write(p);
  }

  /** Take the folder as the turn leaves it; resolves to what changed in it, whoever changed it. */
  async end(turn: string): Promise<string[]> {
    const p = this.points.get(turn);
    if (!p || !this.shadow) return [];
    const after = await this.shadow.snapshot(`after ${turn}`);
    this.shadow.note(this.writer, 'e');
    if (!after) return [];
    const paths = await this.shadow.changed(p.before, after);
    Object.assign(p, { after, paths });
    this.write(p);
    return paths.map((r) => path.join(this.shadow!.cwd, r));
  }

  private get indexFile(): string {
    return path.join(this.dir, 'index.jsonl');
  }

  private load(): void {
    try {
      for (const line of fs.readFileSync(this.indexFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        // One torn line (a process killed mid-write) had hidden every restore point after it.
        let e: Entry | Point;
        try {
          e = JSON.parse(line) as Entry | Point;
        } catch {
          continue;
        }
        this.mark(e.turn);
        if ('kind' in e && e.kind === 'point') {
          this.points.set(e.turn, { ...this.points.get(e.turn), ...e });
          continue;
        }
        const f = e as Entry;
        this.entries.push(f);
        this.seen.add(`${f.turn}\0${f.path}`);
      }
    } catch {
      /* no checkpoints yet */
    }
  }

  capture(turn: string, file: string): void {
    if (!this.enabled) return;
    this.shadow?.note(this.writer, 'w', file);
    const key = `${turn}\0${file}`;
    if (this.seen.has(key)) return;
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st?.isFile() && st.size > MAX_FILE) return;
    // A failed backup must not be recorded as a nonexistent original, or let the next edit through.
    const bytes = st?.isFile() ? fs.readFileSync(file) : null;
    const binary = bytes && isBinary(bytes) ? binaryContent(bytes) : undefined;
    const entry: Entry = { turn, path: file, blob: bytes ? this.blobs.put(bytes) : null, ...(binary && { binary }) };
    this.write(entry);
    this.entries.push(entry);
    this.seen.add(key);
    this.mark(turn);
  }

  /**
   * The restore points of the turns a branch keeps from the session it came from, written into its own index: a
   * message sent again in place drops that session, and every earlier restore point had gone with it. Undoing one of
   * these turns here counts what that session did before the branch as this one's own, and what it did after as
   * another session's.
   */
  adopt(src: Checkpoints, turns: Set<string>, until = Date.now()): void {
    if (!this.enabled) return;
    for (const t of src.order) {
      if (!turns.has(t) || this.order.includes(t)) continue;
      for (const e of src.entries.filter((x) => x.turn === t)) {
        // A copy from before the shared store lives in the source's own folder: it moves to the shared store.
        const data = e.blob && !e.blob.includes('.') ? src.readBlob(e.blob) : null;
        const entry: Entry = { ...e, blob: data ? this.blobs.put(data) : e.blob };
        this.entries.push(entry);
        this.seen.add(`${t}\0${e.path}`);
        this.write(entry);
      }
      const p = src.points.get(t);
      if (p) {
        const point: Point = { ...p, from: p.from ?? { writer: src.writer, until } };
        this.points.set(t, point);
        this.write(point);
      }
      this.mark(t);
    }
  }

  /** What the snapshots saw a turn change that no file tool recorded (commands, generators), as full paths. */
  private seenOnly(turn: string): string[] {
    const p = this.points.get(turn);
    if (!p?.paths?.length || !this.shadow) return [];
    const tools = new Set(this.entries.filter((e) => e.turn === turn).map((e) => path.resolve(e.path).toLowerCase()));
    return p.paths.map((r) => path.join(this.shadow!.cwd, r)).filter((f) => !tools.has(path.resolve(f).toLowerCase()));
  }

  turns(): string[] {
    return this.order.filter((t) => this.entries.some((e) => e.turn === t) || !!this.points.get(t)?.paths?.length);
  }

  files(turn: string): string[] {
    return [...this.entries.filter((e) => e.turn === turn).map((e) => e.path), ...this.seenOnly(turn)];
  }

  private readBlob(blob: string | null): Buffer | null {
    if (!blob) return null;
    // Ids with an extension live in the shared store; plain hashes are snapshots from before it existed.
    if (blob.includes('.')) return this.blobs.get(blob);
    try {
      return fs.readFileSync(path.join(this.dir, 'blobs', blob));
    } catch {
      return null;
    }
  }

  /** Each file this session changed, as it was before the session first touched it (null: it did not exist). */
  originals(): Map<string, Buffer | null> {
    const out = new Map<string, Buffer | null>();
    for (const e of this.entries) if (!out.has(e.path)) out.set(e.path, this.readBlob(e.blob));
    return out;
  }

  /** Content before the turn and now, per file the turn changed: by a file tool, or by a command (seen by the snapshots). */
  async changesAsync(turn: string): Promise<Change[]> {
    const p = this.points.get(turn);
    const seen = this.seenOnly(turn);
    const shadow = this.shadow;
    const pending = p && shadow ? this.fill(p.before, seen, shadow) : new Map<string, FileContent>();
    // The files as they are now, read off the thread too: 3,000 of them held it 0.2 s read one by one.
    const files = [...new Set([...this.entries.filter((e) => e.turn === turn).map((e) => e.path), ...seen])];
    const current = new Map<string, FileContent>();
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(files.slice(i, i + 64).map(async (f) => current.set(f, fileContent(await fs.promises.readFile(f).catch(() => null)))));
    }
    return this.assemble(turn, seen, await pending, current);
  }

  private assemble(turn: string, seen: string[], before: Map<string, FileContent>, current: Map<string, FileContent>): Change[] {
    const now = (f: string) => current.get(f) ?? null;
    return [
      ...this.entries.filter((e) => e.turn === turn).map((e) => ({ path: e.path, before: e.binary ?? fileContent(this.readBlob(e.blob)), after: now(e.path), via: 'tool' as const })),
      ...seen.map((f) => ({ path: f, before: before.get(f) ?? null, after: now(f), via: 'command' as const })),
    ];
  }

  /**
   * These files as snapshot `at` holds them, read from git once: a snapshot never changes, and the app asks every
   * turn's changes again after each turn. Answered at once when all are known, else after one read for the rest.
   */
  private async fill(at: string, files: string[], shadow: Shadow): Promise<Map<string, FileContent>> {
    const out = new Map<string, FileContent>();
    const rel = (f: string) => path.relative(this.shadow!.cwd, f).split(path.sep).join('/');
    const need = files.filter((f) => {
      const k = `${at}\0${rel(f)}`;
      if (!this.known.has(k)) return true;
      out.set(f, this.known.get(k)!);
      return false;
    });
    if (!need.length) return out;
    const got = await shadow.showMany(at, need.map(rel));
    for (const f of need) {
      const text = fileContent(got.get(rel(f)) ?? null);
      out.set(f, text);
      this.know(`${at}\0${rel(f)}`, text);
    }
    return out;
  }

  /** Snapshot contents read so far, oldest first; large files are not kept, and the whole stays under 32 MB of text. */
  private known = new Map<string, FileContent>();
  private knownChars = 0;
  private know(key: string, text: FileContent): void {
    if (typeof text === 'string' && text.length > 2_000_000) return;
    this.known.set(key, text);
    this.knownChars += typeof text === 'string' ? text.length : 64;
    for (const [k, v] of this.known) {
      if (this.knownChars <= 32_000_000) break;
      this.known.delete(k);
      this.knownChars -= typeof v === 'string' ? v.length : 64;
    }
  }

  /** Like `changes`, over the turns after the first `skip`: each file as it was when first touched there, and now. */
  async changesAfter(skip: number) {
    const seen = new Map<string, Change & { text: () => Promise<{ before: string | null; after: string | null }> }>();
    for (const turn of this.turns().slice(skip)) for (const c of await this.changesAsync(turn)) {
      if (seen.has(c.path)) continue;
      // Only model reports need the release text view. Keep decoded media out of the snapshot cache and UI.
      const text = async () => {
        const original = () => {
          const entry = this.entries.find(e => e.turn === turn && e.path === c.path);
          if (entry) return this.readBlob(entry.blob);
          const point = this.points.get(turn);
          return point && this.shadow ? this.shadow.show(point.before, path.relative(this.shadow.cwd, c.path).split(path.sep).join('/')) : null;
        };
        const before = c.before && typeof c.before === 'object' ? (await original())?.toString('utf8') ?? null : c.before;
        if (!c.after || typeof c.after === 'string') return { before, after: c.after };
        try { return { before, after: await fs.promises.readFile(c.path, 'utf8') }; } catch { return { before, after: null }; }
      };
      seen.set(c.path, { ...c, text });
    }
    return [...seen.values()];
  }

  /**
   * Restore every file changed in `turn` and all later turns, newest first: what the file tools recorded, then, where
   * the folder's snapshots have the turn, every path they saw change put back as the turn found it (made since:
   * deleted; deleted since: back), which undoes what commands did too.
   */
  async revertFrom(turn: string): Promise<string[]> {
    const order = this.turns();
    const from = order.indexOf(turn);
    if (from === -1) return [];
    const restored = new Set<string>();
    const later = order.slice(from);
    for (const t of order.slice(from).reverse()) {
      for (const e of this.entries.filter((x) => x.turn === t)) {
        const data = this.readBlob(e.blob);
        try {
          if (data) {
            fs.mkdirSync(path.dirname(e.path), { recursive: true });
            fs.writeFileSync(e.path, data);
          } else if (!e.blob) {
            fs.rmSync(e.path, { force: true });
          }
          restored.add(e.path);
        } catch {
          /* leave files we cannot restore */
        }
      }
    }
    // The snapshots last: a file tool's copy is from when the file was first touched, which may be after a command in
    // the same turn changed it; the snapshot is the folder as the turn found it.
    const first = later.map((t) => this.points.get(t)).find((p) => p?.before);
    if (first && this.shadow) {
      let paths = [...new Set(later.flatMap((t) => this.points.get(t)?.paths ?? []))];
      // A turn's paths are everything that changed in the folder while it ran, whoever changed it. When another
      // session worked here meanwhile, its writes and its commands' cannot be told from this one's: undoing a turn
      // put back another session's file and deleted the one it had made (2026-11-06). Then only the files this
      // session's own tools touched go back, and none another session's tools wrote.
      const own: Record<string, number> = {};
      for (const p of this.points.values()) if (p.from) own[p.from.writer] = Math.max(own[p.from.writer] ?? 0, p.from.until);
      const others = first.at ? this.shadow.othersSince(this.writer, first.at, own) : { active: false, wrote: new Set<string>() };
      if (others.active) {
        const rel = (f: string) => path.relative(this.shadow!.cwd, f).split(path.sep).join('/').toLowerCase();
        const mine = new Set(this.entries.filter((e) => later.includes(e.turn)).map((e) => rel(e.path)));
        paths = paths.filter((r) => mine.has(r.toLowerCase()) && !others.wrote.has(r.toLowerCase()));
      }
      for (const rel of await this.shadow.restore(first.before, paths)) restored.add(path.join(this.shadow.cwd, rel));
    }
    return [...restored];
  }
}
