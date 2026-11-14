/**
 * Search code by what it does, for when no exact word to grep is known: files are cut at their definitions
 * (the lines an outline lists), identifiers are split into words (parseConfigFile: parse config file), and the
 * pieces are ranked with BM25 against a plain-language query; a piece whose own name or path holds the query's
 * words ranks higher. The index is kept per folder and only files whose time changed are read again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { definitionLines } from './outline';
import { terms } from './passages';
import { runRipgrep } from './ripgrep';

export interface Hit {
  file: string;
  /** 1-based, inclusive. */
  start: number;
  end: number;
  /** The definition's own line (or the piece's first), and its number. */
  head: string;
  line: number;
  /** The lines of the piece that hold the most of the query, with their numbers. */
  lines: { n: number; text: string }[];
  score: number;
}

interface Piece {
  file: string;
  start: number;
  end: number;
  head: string;
  line: number;
  len: number;
  /** The words of its own line and its path, each once: a few, so a list is smaller than a set. */
  name: string[];
}

interface Index {
  pieces: (Piece | null)[];
  /**
   * term -> piece, count, piece, count, ... in one flat list. A pair in an array of its own cost about three times
   * as much: the index of a large workspace (7,400 files) held 657 MB of the engine's memory.
   */
  postings: Map<string, number[]>;
  files: Map<string, { mtime: number; ids: number[] }>;
  totalLen: number;
  live: number;
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|py|pyi|go|rs|java|kt|kts|cs|scala|swift|dart|rb|php|c|h|cc|cpp|cxx|hpp|hh|m|mm|lua|sh|bash|ps1|sql|ex|exs|erl|hs|ml|clj|r|jl|zig|nim|md|mdx|css|scss|less|html|yaml|yml|toml)$/i;
const MAX_FILE = 400_000;
const MAX_FILES = 8000;
/** Folders of installed packages and build output, left out of the index wherever they are. */
const VENDORED = ['node_modules', '.venv', 'venv', 'site-packages', '__pycache__', 'vendor', 'dist', 'build', 'target', '.next', '.nuxt', '.turbo', '.cache', 'coverage', '.gradle', 'Pods'];
const indexes = new Map<string, Index>();
/** When each folder's index was last searched. */
const usedAt = new Map<string, number>();

/** Identifiers as words: camelCase, PascalCase, snake_case and kebab-case split, the whole name kept too. */
export function splitIdentifiers(text: string): string {
  return text.replace(/[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*/g, (id) => {
    const parts = id
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ');
    return parts === id ? id : `${id} ${parts}`;
  });
}

const words = (text: string) => terms(splitIdentifiers(text));

/** A file's pieces: from each definition to the next (long ones in windows), or windows when it has none. */
function cut(text: string, ext: string): { start: number; end: number; def?: number }[] {
  const lines = text.split('\n');
  // A definition's doc comment and decorators sit above it and say what it does: they belong to it.
  const lead = (l: string) => /^\s*(\/\*\*?|\*|\/\/|#(?!\s*(include|define|if|pragma|endif|else))|@\w|"""|''')/.test(l);
  const defs = definitionLines(text, ext) ?? [];
  const starts = defs.map((s, i, all) => {
    let a = s;
    const floor = i ? all[i - 1] + 1 : 0;
    while (a > floor && lead(lines[a - 1])) a--;
    return a;
  });
  const out: { start: number; end: number; def?: number }[] = [];
  const windows = (a: number, b: number) => {
    for (let s = a; s <= b; s += 60) out.push({ start: s, end: Math.min(b, s + 79) });
  };
  if (!starts.length) {
    windows(0, lines.length - 1);
    return out;
  }
  if (starts[0] > 0) windows(0, starts[0] - 1);
  starts.forEach((s, i) => {
    const e = (starts[i + 1] ?? lines.length) - 1;
    if (e - s > 160) windows(s, e);
    else out.push({ start: s, end: e, def: defs[i] });
  });
  return out;
}

function addFile(ix: Index, rel: string, text: string, mtime: number): void {
  const lines = text.split('\n');
  const ids: number[] = [];
  const pathWords = words(rel.replace(/\.[^.]+$/, ''));
  for (const { start, end, def } of cut(text, path.extname(rel))) {
    const body = lines.slice(start, end + 1).join('\n');
    if (!body.trim()) continue;
    const ts = words(body);
    if (!ts.length) continue;
    const id = ix.pieces.length;
    // The definition's own line names the piece, not the comment above it.
    const head = (def !== undefined ? lines[def] : lines.slice(start, end + 1).find((l) => l.trim()))?.trim().slice(0, 160) ?? '';
    ix.pieces.push({ file: rel, start: start + 1, end: end + 1, head, line: (def ?? start) + 1, len: ts.length, name: [...new Set([...words(head), ...pathWords])] });
    const tf = new Map<string, number>();
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      let list = ix.postings.get(t);
      if (!list) ix.postings.set(t, (list = []));
      list.push(id, n);
    }
    ix.totalLen += ts.length;
    ix.live++;
    ids.push(id);
  }
  ix.files.set(rel, { mtime, ids });
}

function dropFile(ix: Index, rel: string): void {
  const f = ix.files.get(rel);
  if (!f) return;
  for (const id of f.ids) {
    const p = ix.pieces[id];
    if (p) {
      ix.totalLen -= p.len;
      ix.live--;
      ix.pieces[id] = null;
    }
  }
  ix.files.delete(rel);
}

/** The folder's index, brought up to date with the files ripgrep lists (so .gitignore is respected). */
async function indexFor(root: string, signal: AbortSignal, rebuild = false): Promise<{ ix: Index; files: number }> {
  let ix = indexes.get(root);
  if (!ix) indexes.set(root, (ix = { pieces: [], postings: new Map(), files: new Map(), totalLen: 0, live: 0 }));
  if (signal.aborted) return { ix, files: ix.files.size };
  // Other people's code stays out even where no .gitignore applies (a folder that is not a repository): a large
  // workspace listed 7,400 files, most of them in node_modules and virtual environments, and its searches found PIL.
  // Sorted before the limit, so a folder over it is cut the same way every time.
  const listed = await runRipgrep(['--files', '--hidden', '--glob', '!.git', ...VENDORED.flatMap((d) => ['--glob', `!**/${d}/**`])], root, signal);
  // A timed-out or failed listing cannot tell us which files left. Exit 1 alone is a valid empty listing.
  if (signal.aborted || listed.timedOut || (listed.code !== 0 && listed.code !== 1)) return { ix, files: ix.files.size };
  if (rebuild && !listed.truncated) indexes.set(root, (ix = { pieces: [], postings: new Map(), files: new Map(), totalLen: 0, live: 0 }));
  const rels = listed.stdout
    .split(/\r?\n/)
    .filter((f) => f && CODE.test(f))
    .map((f) => f.replace(/\\/g, '/'))
    .sort()
    .slice(0, MAX_FILES);
  if (!listed.truncated) {
    const seen = new Set(rels);
    for (const rel of ix.files.keys()) if (!seen.has(rel)) dropFile(ix, rel);
  }
  let since = performance.now();
  for (const rel of rels) {
    // A big folder takes seconds to read: the thread is let go every few dozen milliseconds, so other requests go on
    // and the caller's limit can end it (the lookahead's two seconds never could; one build held the desktop engine
    // 462 ms on 24 files). What was read stays, and the next call goes on from there.
    if (performance.now() - since > 30) {
      await new Promise((r) => setImmediate(r));
      since = performance.now();
    }
    if (signal.aborted) break;
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      continue;
    }
    const known = ix.files.get(rel);
    if (known ? known.mtime === st.mtimeMs : ix.files.size >= MAX_FILES) continue;
    if (known) dropFile(ix, rel);
    if (st.size > MAX_FILE) continue;
    const text = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
    // Minified or generated: long lines say nothing a person wrote.
    if (text.length / Math.max(1, text.split('\n').length) > 300) continue;
    addFile(ix, rel, text, st.mtimeMs);
  }
  // Pieces of changed files leave holes; rebuild when they are most of it.
  if (!listed.truncated && !signal.aborted && ix.pieces.length > 2000 && ix.live < ix.pieces.length / 2) return indexFor(root, signal, true);
  return { ix, files: ix.files.size };
}

/** The pieces of code that best match `query`, at most `limit`. */
export async function searchCode(root: string, query: string, o: { limit?: number; signal: AbortSignal; under?: string }): Promise<{ hits: Hit[]; pieces: number; files: number }> {
  usedAt.set(root, Date.now());
  const { ix, files } = await indexFor(root, o.signal);
  usedAt.set(root, Date.now());
  const q = [...new Set(words(query))];
  const n = ix.live || 1;
  const avg = ix.totalLen / n || 1;
  const k1 = 1.2;
  const b = 0.75;
  const scores = new Map<number, { s: number; covered: number }>();
  const under = o.under ? o.under.replace(/\\/g, '/').replace(/^\.\/|\/$/g, '') : '';
  for (const t of q) {
    const list = ix.postings.get(t);
    if (!list) continue;
    let df = 0;
    for (let i = 0; i < list.length; i += 2) if (ix.pieces[list[i]]) df++;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (let i = 0; i < list.length; i += 2) {
      const id = list[i];
      const tf = list[i + 1];
      const p = ix.pieces[id];
      if (!p || (under && !p.file.startsWith(under))) continue;
      const part = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * p.len) / avg))) * (p.name.includes(t) ? 1.6 : 1);
      const cur = scores.get(id) ?? { s: 0, covered: 0 };
      cur.s += part;
      cur.covered++;
      scores.set(id, cur);
    }
  }
  const ranked = [...scores.entries()]
    .map(([id, v]) => ({ id, score: v.s * (0.4 + v.covered / Math.max(1, q.length)) }))
    .sort((x, y) => y.score - x.score);
  // One piece per definition line at most, and at most three from one file.
  const perFile = new Map<string, number>();
  const hits: Hit[] = [];
  for (const { id, score } of ranked) {
    if (hits.length >= (o.limit ?? 8)) break;
    const p = ix.pieces[id]!;
    const count = perFile.get(p.file) ?? 0;
    if (count >= 3) continue;
    perFile.set(p.file, count + 1);
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, p.file), 'utf8');
    } catch {
      // A file may have gone away since the last complete listing. Keep its index entry until the next one.
      continue;
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n').slice(p.start - 1, p.end);
    const qs = new Set(q);
    const best = lines
      .map((text, i) => ({ n: p.start + i, text, k: words(text).filter((w) => qs.has(w)).length }))
      .filter((l) => l.k > 0 && l.n !== p.line)
      .sort((x, y) => y.k - x.k || x.n - y.n)
      .slice(0, 3)
      .sort((x, y) => x.n - y.n)
      .map(({ n: ln, text }) => ({ n: ln, text: text.trimEnd().slice(0, 160) }));
    hits.push({ file: p.file, start: p.start, end: p.end, head: p.head, line: p.line, lines: best, score });
  }
  return { hits, pieces: ix.live, files };
}

/** Forget the indexes (tests). */
export function forgetCodeIndexes(): void {
  indexes.clear();
  usedAt.clear();
}

/**
 * Let go of the indexes no search has used for `idleMs`: a big folder's stays in memory otherwise for as long as Favilla
 * runs (331 MB for that 7,400-file workspace), and building it again lets the thread go as it reads. How many went.
 */
export function forgetIdleCodeIndexes(idleMs: number, now = Date.now()): number {
  let n = 0;
  for (const [root, at] of usedAt) {
    if (now - at < idleMs) continue;
    indexes.delete(root);
    usedAt.delete(root);
    n++;
  }
  return n;
}
