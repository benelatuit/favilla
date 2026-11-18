import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { ReadEvidence } from '../types';
import { normalizeForCompare } from '../util/paths';

interface Seen {
  mtimeMs: number;
  size: number;
  at: number;
  /** Written by the agent itself, so its content is known. */
  written: boolean;
  digest?: string;
}

/** Lines of one version of a file that a read showed the model, and which call showed them. */
interface Shown {
  callId: string;
  start: number;
  end: number;
}

/** What the model has read of a file since it last changed: merged line ranges, kept across compactions. */
interface Coverage {
  path: string;
  mtimeMs: number;
  size: number;
  total: number;
  ranges: [number, number][];
  shown: Shown[];
  digest?: string;
}

/**
 * Tracks which files the model has seen. Edits require a prior read (so the model never edits
 * from a guess) and refuse to overwrite changes made outside the agent since that read. It also
 * remembers which lines each read showed, so a repeated read of unchanged lines can point back to
 * the output still in context, and a compaction can say how much of each file was read.
 */
/** The latest write of each file by any session's tools in this process, to say whose change an edit had not seen. */
const lastWrite = new Map<string, { by: FileTracker; at: number }>();

export class FileTracker {
  private seen = new Map<string, Seen>();
  private order: string[] = [];
  private covered = new Map<string, Coverage>();

  private key(p: string): string {
    return normalizeForCompare(p);
  }

  private touch(p: string, written: boolean): void {
    const k = this.key(p);
    if (written) {
      lastWrite.delete(k);
      lastWrite.set(k, { by: this, at: Date.now() });
      if (lastWrite.size > 5000) lastWrite.delete(lastWrite.keys().next().value!);
    }
    try {
      const st = fs.statSync(p);
      this.seen.set(k, { mtimeMs: st.mtimeMs, size: st.size, at: Date.now(), written, digest: fileDigest(p) ?? undefined });
    } catch {
      this.seen.delete(k);
    }
    this.order = this.order.filter((x) => x !== p);
    this.order.push(p);
    if (this.order.length > 200) this.order.shift();
  }

  /** When the tools last read or wrote the file, and which. */
  lastTouch(p: string): { at: number; written: boolean } | undefined {
    const s = this.seen.get(this.key(p));
    return s && { at: s.at, written: s.written };
  }

  recordRead(p: string): void {
    this.touch(p, false);
  }

  /** Track touch recency (`recent()`) without marking the file's text as currently shown or editable. */
  recordRecent(p: string): void {
    this.order = this.order.filter((x) => x !== p);
    this.order.push(p);
    if (this.order.length > 200) this.order.shift();
  }

  /** Clear stale read coverage for a file edited since its earlier read, without granting edit permission. */
  clearCoverage(p: string): void {
    this.covered.delete(this.key(p));
  }

  recordWrite(p: string): void {
    this.touch(p, true);
    // What was read before describes the old content.
    this.covered.delete(this.key(p));
  }

  /** Whether tracked read coverage still matches the file currently on disk (or its pre-read `rawBytes`). */
  hasCurrentCoverage(p: string, rawBytes?: Buffer): boolean {
    const c = this.covered.get(this.key(p));
    if (!c) return false;
    if (rawBytes !== undefined) {
      if (c.size !== rawBytes.length) return false;
      if (c.digest === undefined || rawBytes.length > 4 * 1024 * 1024) return true;
      return createHash('sha256').update(rawBytes).digest('hex') === c.digest;
    }
    try {
      return same(c, fs.statSync(p)) && (c.digest === undefined || fileDigest(p) === c.digest);
    } catch {
      return false;
    }
  }

  /**
   * Record an in-place edit whose earliest modified 1-based line is `firstChangedLine`.
   * When `preservePreEdit` is true, read ranges strictly above `firstChangedLine` (`1 .. firstChangedLine - 1`)
   * remain byte-for-byte identical at the same line numbers and stay eligible for `earlierRead`.
   */
  recordEdit(p: string, firstChangedLine: number, totalLines: number, preservePreEdit: boolean): void {
    const k = this.key(p);
    const maxUnchanged = firstChangedLine - 1;
    const prev = preservePreEdit && maxUnchanged >= 1 ? this.covered.get(k) : undefined;
    this.touch(p, true);
    if (!prev) {
      this.covered.delete(k);
      return;
    }
    const clippedRanges: [number, number][] = [];
    for (const [start, end] of prev.ranges) {
      if (start <= maxUnchanged) clippedRanges.push([start, Math.min(end, maxUnchanged)]);
    }
    const clippedShown = prev.shown
      .filter((s) => s.start <= maxUnchanged)
      .map((s) => (s.end <= maxUnchanged ? s : { callId: s.callId, start: s.start, end: maxUnchanged }));
    const seenNow = this.seen.get(k);
    if (!seenNow || (!clippedRanges.length && !clippedShown.length)) {
      this.covered.delete(k);
      return;
    }
    this.covered.set(k, {
      path: p,
      mtimeMs: seenNow.mtimeMs,
      size: seenNow.size,
      total: totalLines,
      ranges: merge(clippedRanges),
      shown: clippedShown,
      digest: seenNow.digest,
    });
  }

  /** Lines `start`-`end` of a text file of `total` lines, shown to the model by call `callId`. */
  recordShown(p: string, callId: string, start: number, end: number, total: number): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    const k = this.key(p);
    let c = this.covered.get(k);
    const digest = fileDigest(p) ?? undefined;
    if (!c || !same(c, st) || c.digest !== digest) {
      c = { path: p, mtimeMs: st.mtimeMs, size: st.size, total, ranges: [], shown: [], digest };
      this.covered.set(k, c);
    }
    c.total = total;
    c.ranges = merge([...c.ranges, [start, end]]);
    c.shown.push({ callId, start, end });
    if (c.shown.length > 40) c.shown.shift();
  }

  /**
   * The newest call that showed lines `start`-`end` of the file as it is now, if its output is still in
   * the model's context (`visible`): a repeated read can point there instead of adding the text again.
   */
  earlierRead(p: string, start: number, end: number, visible: (callId: string) => boolean): string | undefined {
    const c = this.covered.get(this.key(p));
    if (!c) return undefined;
    try {
      if (!same(c, fs.statSync(p)) || (c.digest !== undefined && fileDigest(p) !== c.digest)) return undefined;
    } catch {
      return undefined;
    }
    for (let i = c.shown.length - 1; i >= 0; i--) {
      const s = c.shown[i];
      if (s.start <= start && s.end >= end && visible(s.callId)) return s.callId;
    }
    return undefined;
  }

  /**
   * Whether the reads recorded of the file cover all its lines. It takes the record as it stands, so it is for a caller
   * that has just checked the file against a digest, as a reopen does read by read: coverage() checks every file on disk
   * again, and called per restored read it had a reopen of 400 reads over 40 files digest 16,000 files.
   */
  readWhole(p: string): boolean {
    const c = this.covered.get(this.key(p));
    return !!c && c.total > 0 && c.ranges.length === 1 && c.ranges[0][0] === 1 && c.ranges[0][1] >= c.total;
  }

  /** Files read and not changed since, with the line ranges the model has seen of each. */
  coverage(): { path: string; total: number; ranges: [number, number][] }[] {
    const out: { path: string; total: number; ranges: [number, number][] }[] = [];
    for (const c of this.covered.values()) {
      try {
        if (same(c, fs.statSync(c.path)) && (c.digest === undefined || fileDigest(c.path) === c.digest)) out.push({ path: c.path, total: c.total, ranges: c.ranges });
      } catch {
        // Deleted since: nothing to say about it.
      }
    }
    return out;
  }

  /** Only this call's actual lines, not a cumulative claim about earlier reads. */
  shownBy(callId: string): ReadEvidence[] {
    return [...this.covered.values()].filter((c) => c.digest && c.shown.some((s) => s.callId === callId)).map((c) => ({
      path: c.path, digest: c.digest!, total: c.total,
      ranges: merge(c.shown.filter((s) => s.callId === callId).map((s) => [s.start, s.end])),
    }));
  }

  /** Restoring knowledge never restores permission to edit or a claim that the old text is still in context. */
  restore(read: ReadEvidence): boolean {
    if (fileDigest(read.path) !== read.digest) return false;
    try {
      const st = fs.statSync(read.path);
      const k = this.key(read.path);
      const old = this.covered.get(k);
      this.covered.set(k, {
        ...read, mtimeMs: st.mtimeMs, size: st.size, shown: [],
        ranges: merge([...(old?.digest === read.digest ? old.ranges : []), ...read.ranges]),
      });
      return true;
    } catch { return false; }
  }

  /**
   * A read whose output the model still has word for word (rounds a compaction kept): while the file is as that read
   * showed it, it stays read, for an edit and for a repeated read to point back to. False when the file changed since.
   */
  keepShown(read: ReadEvidence, callId: string): boolean {
    if (fileDigest(read.path) !== read.digest) return false;
    this.recordRead(read.path);
    for (const [start, end] of read.ranges) this.recordShown(read.path, callId, start, end, read.total);
    return true;
  }

  /** After a compaction: the model has no file's text any more (see keepShown for what it keeps). */
  forgetAll(): void {
    this.seen.clear();
    for (const c of this.covered.values()) c.shown = [];
  }

  /** The model no longer has the file's text: edits need a new read, and repeated reads are served again. */
  forget(p: string): void {
    const k = this.key(p);
    this.seen.delete(k);
    const c = this.covered.get(k);
    if (c) c.shown = [];
  }

  /** null when the file may be edited, otherwise the reason it may not. */
  checkEditable(p: string): string | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return null;
    }
    const s = this.seen.get(this.key(p));
    if (!s) return 'File has not been read yet. Read it first, then edit.';
    if (!same(s, st) || (s.digest !== undefined && fileDigest(p) !== s.digest)) {
      // Whose change it was, when it was another session's in this process (the app runs them all in one engine).
      const w = lastWrite.get(this.key(p));
      if (w && w.by !== this && w.at > s.at) return `Another Favilla session in this folder changed this file ${Math.max(1, Math.round((Date.now() - w.at) / 1000))} s ago, after you last read it. Read it again and build on its change rather than write over it.`;
      return 'File was modified since it was last read (by the user, a formatter or a command). Read it again before editing.';
    }
    return null;
  }

  /** Files this agent wrote, as absolute paths. */
  written(): string[] {
    return this.order.filter((p) => this.seen.get(this.key(p))?.written);
  }

  /** Most recently touched files, newest last. */
  recent(limit = 12): string[] {
    return this.order.slice(-limit);
  }
}

/** Digests already taken while withDigests runs, by path as given; null when there is no such run. */
let digestsTaken: Map<string, string | null | undefined> | null = null;

/**
 * Runs `fn` with each file's digest taken once: for work that only reads, such as restoring what a reopened session had
 * read and written, where the same file is checked once per read, per write and again by each tracker call. Nothing
 * may write a file inside it.
 */
export function withDigests<T>(fn: () => T): T {
  if (digestsTaken) return fn();
  digestsTaken = new Map();
  try {
    return fn();
  } finally {
    digestsTaken = null;
  }
}

/** Evidence is deliberately bounded to source-sized files. Unknown is distinct from absent. */
export function fileDigest(p: string): string | null | undefined {
  if (digestsTaken) {
    if (digestsTaken.has(p)) return digestsTaken.get(p);
    const d = digestOf(p);
    digestsTaken.set(p, d);
    return d;
  }
  return digestOf(p);
}

function digestOf(p: string): string | null | undefined {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return undefined;
    return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

function same(c: { mtimeMs: number; size: number }, st: fs.Stats): boolean {
  return Math.abs(st.mtimeMs - c.mtimeMs) <= 1 && st.size === c.size;
}

/** Sorted, with overlapping and touching ranges joined. */
function merge(ranges: [number, number][]): [number, number][] {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** "all 980 lines", or "lines 1-120, 300-410 of 980 (not read: 121-299, 411-980)". */
export function describeCoverage(ranges: [number, number][], total: number): string {
  const span = ([a, b]: [number, number]) => (a === b ? `${a}` : `${a}-${b}`);
  const missing: [number, number][] = [];
  let next = 1;
  for (const [a, b] of ranges) {
    if (a > next) missing.push([next, a - 1]);
    next = Math.max(next, b + 1);
  }
  if (next <= total) missing.push([next, total]);
  if (!missing.length) return `all ${total} lines`;
  return `lines ${ranges.map(span).join(', ')} of ${total} (not read: ${missing.map(span).join(', ')})`;
}
