/**
 * The parts of a page that answer a query: the page is cut into passages under their headings and ranked with
 * BM25, so a search can quote the lines that matter instead of a page's first screen.
 */

export interface Passage {
  /** The nearest heading above the passage. */
  heading?: string;
  text: string;
  /** Character offset in the page text, so a reader can continue from there. */
  start: number;
}

const STOP = new Set(
  'a an and are as at be been but by can could did do does for from had has have how i if in into is it its may might more most must no not of on or our should so than that the their them then there these they this those to was we were what when where which who why will with would you your'.split(' '),
);

/** A crude English stem, applied the same way to queries and pages: tests/test, running/run, parsed/parse. */
function stem(w: string): string {
  if (w.length <= 4 || /\d/.test(w)) return w;
  let s = w;
  if (s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (/(ches|shes|sses|xes)$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('ing') && s.length > 6) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 5) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  // runn(ing) -> run, stopp(ed) -> stop; long stems keep their double letter (install, pass, call).
  if (s !== w && s.length <= 5 && /([b-df-hj-np-tv-z])\1$/.test(s) && !/(ll|ss|zz)$/.test(s)) s = s.slice(0, -1);
  // parse, parsed, parsing -> pars
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

/** Character pairs of questions and filler in Chinese: they say nothing about what a page is about. */
const CJK_STOP = new Set('怎么 如何 什么 为什 怎样 哪些 哪个 可以 能否 是否 一个 这个 那个 我们 你们 他们 就是 还是 已经 没有 的话 一下 请问 求助'.split(' '));

/** Names written with dots, dashes or pluses between their parts: v4.1, ctx.signal, utf-8, --retry-all-errors, c++. */
const COMPOUND = /[\p{L}\p{N}_]+(?:[.+#-]+[\p{L}\p{N}_]+)+|\b[a-z]\+\+|\b[a-z]#/gu;

/**
 * Search terms of a text: stemmed words, and overlapping character pairs for Chinese, Japanese and Korean. A
 * compound name counts whole as well as by its parts: "retry", "all" and "errors" are on most of curl's manual,
 * "retry-all-errors" in one place.
 */
export function terms(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(COMPOUND)) out.push(m[0]);
  for (const m of lower.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}_]+|\p{L}+/gu)) {
    const w = m[0];
    if (CJK.test(w)) {
      const chars = [...w];
      if (chars.length === 1) out.push(w);
      for (let i = 0; i + 1 < chars.length; i++) if (!CJK_STOP.has(chars[i] + chars[i + 1])) out.push(chars[i] + chars[i + 1]);
    } else if (w.length > 1 && !STOP.has(w)) out.push(stem(w));
  }
  return out;
}

/**
 * Passages of about `size` characters that keep to one section: a heading starts a new one, a fenced code block
 * is never cut, and each passage remembers the heading it sits under.
 */
export function splitPassages(text: string, size = 700): Passage[] {
  const blocks: { text: string; start: number; heading?: string }[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let current: { lines: string[]; start: number } | null = null;
  let fence = false;
  const flush = () => {
    if (current && current.lines.join('\n').trim()) blocks.push({ text: current.lines.join('\n').trim(), start: current.start });
    current = null;
  };
  for (const line of lines) {
    const at = offset;
    offset += line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^#{1,6}\s/.test(line)) {
      flush();
      blocks.push({ text: line.trim(), start: at, heading: line.replace(/^#+\s*/, '').trim() });
      continue;
    }
    if (!fence && !line.trim()) {
      flush();
      continue;
    }
    current ??= { lines: [], start: at };
    current.lines.push(line);
  }
  flush();
  const out: Passage[] = [];
  let heading: string | undefined;
  let open: Passage | null = null;
  for (const b of blocks.flatMap((b) => (b.heading === undefined ? pieces(b, size) : [b]))) {
    if (b.heading !== undefined) {
      if (open) out.push(open);
      open = null;
      heading = b.heading;
      continue;
    }
    if (open && open.text.length + b.text.length > size) {
      out.push(open);
      open = null;
    }
    if (open) open.text += `\n\n${b.text}`;
    else open = { heading, text: b.text, start: b.start };
  }
  if (open) out.push(open);
  return out;
}

/** A block longer than this is cut into pieces: a long table or code block whole was cut off at its start in a quote. */
const LONG_BLOCK = 1400;

/**
 * A long table as groups of rows, each under the table's header row; a long code block as runs of lines, cut at
 * blank lines where it can, each in the block's own fence; a long list (a docs index is one) as runs of items.
 * Anything else, or anything short, stays whole.
 */
function pieces(b: { text: string; start: number }, size: number): { text: string; start: number; heading?: string }[] {
  if (b.text.length <= LONG_BLOCK) return [b];
  const lines = b.text.split('\n');
  const offsets: number[] = [];
  let at = b.start;
  for (const l of lines) {
    offsets.push(at);
    at += l.length + 1;
  }
  const out: { text: string; start: number }[] = [];
  const group = (from: number, to: number, cut: (i: number, chars: number) => boolean) => {
    const runs: [number, number][] = [];
    let first = from;
    let chars = 0;
    for (let i = from; i < to; i++) {
      chars += lines[i].length + 1;
      if (i + 1 < to && cut(i, chars)) {
        runs.push([first, i + 1]);
        first = i + 1;
        chars = 0;
      }
    }
    runs.push([first, to]);
    return runs;
  };
  if (lines.length > 4 && lines.every((l) => l.startsWith('|')) && /^\|[\s|:-]+\|$/.test(lines[1])) {
    const head = `${lines[0]}\n${lines[1]}`;
    for (const [i, j] of group(2, lines.length, (_i, chars) => chars + head.length > size)) out.push({ text: `${head}\n${lines.slice(i, j).join('\n')}`, start: offsets[i] });
    return out;
  }
  const open = lines.findIndex((l) => /^\s*(```|~~~)/.test(l));
  if (open < 0) {
    if (lines.length < 4) return [b];
    // Cut before an item at the list's own depth, so an option stays with its sub-options (cutting at any item
    // split Node's fs.cp options from their heading's call), and before a deeper one only when a run grows long.
    const item = (l: string) => /^\s*([-*+]|\d+[.)])\s/.test(l);
    const depth = (l: string) => /^\s*/.exec(l)![0].length;
    const top = Math.min(...lines.filter(item).map(depth));
    for (const [i, j] of group(0, lines.length, (i, chars) => chars > size && item(lines[i + 1]) && (depth(lines[i + 1]) <= top || chars > 2 * LONG_BLOCK))) out.push({ text: lines.slice(i, j).join('\n'), start: offsets[i] });
    return out;
  }
  const close = lines.findIndex((l, i) => i > open && /^\s*(`{3,}|~{3,})\s*$/.test(l));
  if (close < 0 || close - open < 4) return [b];
  const fence = lines[open].trim();
  const end = lines[close].trim();
  const runs = group(open + 1, close, (i, chars) => (chars > size && !lines[i].trim()) || chars > LONG_BLOCK);
  runs.forEach(([i, j], n) => {
    const before = n === 0 ? lines.slice(0, open + 1) : [fence];
    const after = n === runs.length - 1 ? lines.slice(close) : [end];
    out.push({ text: [...before, ...lines.slice(i, j), ...after].join('\n').replace(/\n{2,}(?=(```|~~~))/g, '\n'), start: n === 0 ? b.start : offsets[i] });
  });
  return out;
}

/**
 * The passages that best answer `query`, at most `max` of them and `maxChars` together, back in page order.
 * Empty when nothing on the page shares a term with the query, or, with `minCover`, when no passage holds at
 * least that share of the query's terms (a home page that only names the project does not answer a question).
 */
export function bestPassages(text: string, query: string, opts: { max?: number; maxChars?: number; size?: number; minCover?: number } = {}): Passage[] {
  const max = opts.max ?? 3;
  const maxChars = opts.maxChars ?? 1800;
  const q = [...new Set(terms(query))];
  if (!q.length) return [];
  const passages = splitPassages(text, opts.size ?? 700);
  if (!passages.length) return [];
  const docs = passages.map((p) => {
    const tf = new Map<string, number>();
    const words = terms(p.text);
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { tf, len: words.length, head: new Set(terms(p.heading ?? '')) };
  });
  const n = docs.length;
  const avg = docs.reduce((a, d) => a + d.len, 0) / n || 1;
  const idf = new Map(q.map((t) => {
    const df = docs.filter((d) => d.tf.has(t) || d.head.has(t)).length;
    return [t, Math.log(1 + (n - df + 0.5) / (df + 0.5))];
  }));
  const k1 = 1.2;
  const b = 0.75;
  const scored = passages.map((p, i) => {
    const d = docs[i];
    let score = 0;
    let covered = 0;
    for (const t of q) {
      const f = d.tf.get(t) ?? 0;
      const inHead = d.head.has(t);
      if (f || inHead) covered++;
      score += idf.get(t)! * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg)) + (inHead ? 0.6 : 0));
    }
    // Passages that hold more of the query's terms beat ones repeating a single term.
    return { p, i, cover: covered / q.length, score: covered ? score * (0.5 + covered / q.length) : 0 };
  });
  if (opts.minCover && !scored.some((s) => s.cover >= opts.minCover!)) return [];
  const picked: typeof scored = [];
  let chars = 0;
  for (const s of scored.filter((s) => s.score > 0).sort((x, y) => y.score - x.score)) {
    if (picked.length >= max) break;
    const len = s.p.text.length;
    if (picked.length && chars + len > maxChars) continue;
    picked.push(s);
    chars += len;
  }
  return picked.sort((x, y) => x.i - y.i).map((s) => (s.p.text.length > maxChars ? { ...s.p, text: `${s.p.text.slice(0, maxChars).trimEnd()}…` } : s.p));
}

/** Passages as quoted text under their headings, for a tool result. */
export function quotePassages(ps: Passage[], indent = ''): string {
  return ps
    .map((p) => {
      const head = p.heading ? `${indent}§ ${p.heading}\n` : '';
      return head + p.text.split('\n').map((l) => `${indent}> ${l}`.trimEnd()).join('\n');
    })
    .join(`\n${indent}…\n`);
}
