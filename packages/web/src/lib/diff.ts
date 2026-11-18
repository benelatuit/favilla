import { highlightCode } from './highlight';

/**
 * A unified diff as rows to read: each side of a hunk highlighted as one block, so a comment or a string that spans
 * lines keeps its colour, the words that changed inside a changed line marked, and the unchanged stretches between
 * hunks counted.
 */
export type CodeRow =
  | { k: 'ctx' | 'ins' | 'rem'; o?: number; n?: number; html: string; text: string; mark?: boolean }
  /**
   * Unchanged lines left out: `count` of them, from old line `o` and new line `n`. A run folded from a patch with all
   * of the file as context keeps its rows, to open in place; a gap between a patch's hunks has none.
   */
  | { k: 'gap'; count: number; o: number; n: number; rows?: CodeRow[] }
  /** A line the patch says instead of lines: a change too large to diff, or the end of a cut patch. */
  | { k: 'note'; text: string };

/** A row that shows a line of code. */
export type LineRow = Extract<CodeRow, { html: string }>;

export interface DiffRows {
  rows: CodeRow[];
  /** Rows likely to be the widest when laid out, kept laid out so the box's width never grows while scrolling. */
  widest: number[];
  /** Digits of the largest line number, for the gutter's width. */
  digits: number;
}

const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Highlighted HTML split at its line breaks, each line closing the spans still open and the next opening them again. */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  // Search for either delimiter together: a log without tags used to scan to EOF for every line.
  const delimiter = /[<\n]/g;
  let line = '';
  let i = 0;
  while (i < html.length) {
    const c = html[i];
    if (c === '<') {
      const end = html.indexOf('>', i);
      const tag = html.slice(i, end + 1);
      if (tag.startsWith('</')) open.pop();
      else if (!tag.endsWith('/>')) open.push(tag);
      line += tag;
      i = end + 1;
    } else if (c === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
      i++;
    } else {
      delimiter.lastIndex = i;
      const stop = delimiter.exec(html)?.index ?? html.length;
      line += html.slice(i, stop);
      i = stop;
    }
  }
  lines.push(line + '</span>'.repeat(open.length));
  return lines;
}

/** The lines of a file highlighted as one block; plain escaped lines when `highlight` is off. */
export function highlightLines(lines: string[], path: string, highlight = true): string[] {
  if (!highlight) return lines.map(escapeHtml);
  const out = splitHighlighted(highlightCode(lines.join('\n'), path));
  // A highlighter that dropped or added a break would misplace every later line: plain text is safer then.
  return out.length === lines.length ? out : lines.map(escapeHtml);
}

// One word, a run of spaces, or one other character; each CJK character is a word of its own.
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_$]+|\s+|[^\s]/gu;
const MAX_TOKENS = 160;
const MAX_LINE = 400;

/**
 * The character ranges that differ between two versions of a line, by the longest run of words they share. Nothing
 * when the lines share too little for marks to help, when they are long, or when they are the same.
 */
export function wordChanges(a: string, b: string): { a: [number, number][]; b: [number, number][] } | null {
  if (a === b || a.length > MAX_LINE || b.length > MAX_LINE) return null;
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  let head = 0;
  while (head < ta.length && head < tb.length && ta[head] === tb[head]) head++;
  let tail = 0;
  while (tail < ta.length - head && tail < tb.length - head && ta[ta.length - 1 - tail] === tb[tb.length - 1 - tail]) tail++;
  const ma = ta.slice(head, ta.length - tail);
  const mb = tb.slice(head, tb.length - tail);
  if (ma.length > MAX_TOKENS || mb.length > MAX_TOKENS) return null;
  // Longest common subsequence of the middle tokens.
  const w = mb.length + 1;
  const table = new Uint16Array((ma.length + 1) * w);
  for (let i = ma.length - 1; i >= 0; i--)
    for (let j = mb.length - 1; j >= 0; j--)
      table[i * w + j] = ma[i] === mb[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
  const keptA = new Uint8Array(ma.length);
  const keptB = new Uint8Array(mb.length);
  for (let i = 0, j = 0; i < ma.length && j < mb.length; ) {
    if (ma[i] === mb[j]) {
      keptA[i++] = 1;
      keptB[j++] = 1;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++;
    else j++;
  }
  const ranges = (tokens: string[], middle: string[], kept: Uint8Array) => {
    const out: [number, number][] = [];
    let at = tokens.slice(0, head).reduce((s, t) => s + t.length, 0);
    for (let i = 0; i < middle.length; i++) {
      const t = middle[i];
      // A space between two changed words joins them into one mark.
      const joins = !kept[i] || (/^\s+$/.test(t) && i > 0 && i < middle.length - 1 && !kept[i - 1] && !kept[i + 1]);
      if (joins) {
        const last = out[out.length - 1];
        if (last && last[1] === at) last[1] = at + t.length;
        else out.push([at, at + t.length]);
      }
      at += t.length;
    }
    return out;
  };
  const ra = ranges(ta, ma, keptA);
  const rb = ranges(tb, mb, keptB);
  const marked = (r: [number, number][]) => r.reduce((s, [x, y]) => s + y - x, 0);
  // A line mostly rewritten reads better without marks: the whole row already says it changed.
  const same = a.length - marked(ra);
  if (same < Math.max(a.length, b.length) * 0.4 || (!ra.length && !rb.length)) return null;
  return { a: ra, b: rb };
}

/** Wraps the given text ranges of highlighted HTML in marks, closing and reopening them around tags. */
export function markRanges(html: string, ranges: [number, number][], cls = 'dl-word'): string {
  if (!ranges.length) return html;
  const open = `<mark class="${cls}">`;
  let out = '';
  let at = 0;
  let r = 0;
  let inside = false;
  for (let i = 0; i < html.length; ) {
    if (inside && at === ranges[r][1]) {
      out += '</mark>';
      inside = false;
      r++;
    }
    if (!inside && r < ranges.length && at === ranges[r][0]) {
      out += open;
      inside = true;
    }
    const c = html[i];
    if (c === '<') {
      const end = html.indexOf('>', i) + 1;
      out += inside ? `</mark>${html.slice(i, end)}${open}` : html.slice(i, end);
      i = end;
      continue;
    }
    const len = c === '&' ? html.indexOf(';', i) + 1 - i : 1;
    out += html.slice(i, i + len);
    i += len;
    at++;
  }
  if (inside) out += '</mark>';
  return out.replace(/<mark class="[^"]*"><\/mark>/g, '');
}

/** Columns a line takes in a monospaced font: wide characters count two, a tab moves to the next stop of four. */
export function columns(text: string): number {
  // Printable ASCII alone, the usual line, is one column a character.
  if (!/[^\x20-\x7e]/.test(text)) return text.length;
  let n = 0;
  for (const ch of text) {
    if (ch === '\t') n += 4 - (n % 4);
    else n += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u.test(ch) ? 2 : 1;
  }
  return n;
}

/** The indexes of the `keep` rows, or lines, with the most columns. */
export function widestRows(rows: (CodeRow | string)[], keep = 3): number[] {
  const top: [number, number][] = [];
  rows.forEach((r, i) => {
    if (typeof r !== 'string' && (r.k === 'gap' || r.k === 'note')) return;
    const text = typeof r === 'string' ? r : r.text;
    if (top.length === keep && text.length * 2 < top[keep - 1][0]) return;
    const c = columns(text);
    if (top.length < keep || c > top[keep - 1][0]) {
      top.push([c, i]);
      top.sort((x, y) => y[0] - x[0]);
      if (top.length > keep) top.pop();
    }
  });
  return top.map(([, i]) => i);
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function hunksOf(patch: string): { hunks: Hunk[]; notes: { before: number; text: string }[] } {
  const hunks: Hunk[] = [];
  const notes: { before: number; text: string }[] = [];
  let hunk: Hunk | null = null;
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      hunk = { oldStart: Number(h[1]), oldLines: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), newLines: h[4] === undefined ? 1 : Number(h[4]), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (line.startsWith('@@')) {
      notes.push({ before: hunks.length, text: line.replace(/^@@\s*|\s*@@$/g, '') });
      hunk = null;
      continue;
    }
    if (!hunk || line.startsWith('\\')) continue;
    if (line[0] === '+' || line[0] === '-' || line[0] === ' ') hunk.lines.push(line);
    // An empty context line whose space was trimmed away, while the hunk still has old lines to come.
    else if (line === '' && hunk.lines.filter((l) => l[0] !== '+').length < hunk.oldLines) hunk.lines.push(' ');
  }
  return { hunks, notes };
}

/**
 * The rows of a unified diff. `fold` folds runs of unchanged lines longer than twice that many inside a hunk into a
 * gap, for a patch made with all of the file as context.
 */
export function diffRows(patch: string, path: string, options: { highlight?: boolean; words?: boolean; fold?: number } = {}): DiffRows {
  const { highlight = true, words = true, fold } = options;
  const { hunks, notes } = hunksOf(patch);
  const rows: CodeRow[] = [];
  let largest = 0;
  let prevEnd = 1;
  const noteAt = (i: number) => {
    for (const n of notes) if (n.before === i) rows.push({ k: 'note', text: n.text });
  };
  hunks.forEach((h, index) => {
    noteAt(index);
    // The server's patches come straight from jsdiff's hunks, where a side with no lines names the line the change
    // stands at (an added file's is 1). A patch in the printed form names the line before it, 0 for an added file.
    const os = Math.max(1, h.oldStart);
    const ns = Math.max(1, h.newStart);
    const above = os - prevEnd;
    if (above > 0) rows.push({ k: 'gap', count: above, o: prevEnd, n: ns - above });
    prevEnd = os + h.oldLines;
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const l of h.lines) {
      if (l[0] !== '+') oldText.push(l.slice(1));
      if (l[0] !== '-') newText.push(l.slice(1));
    }
    const oldHtml = oldText.some((l) => l.length) ? highlightLines(oldText, path, highlight) : oldText.map(escapeHtml);
    const newHtml = newText.some((l) => l.length) ? highlightLines(newText, path, highlight) : newText.map(escapeHtml);
    let oi = 0;
    let ni = 0;
    let o = os;
    let n = ns;
    const start = rows.length;
    for (const l of h.lines) {
      if (l[0] === '+') rows.push({ k: 'ins', n: n++, html: newHtml[ni], text: newText[ni++] });
      else if (l[0] === '-') rows.push({ k: 'rem', o: o++, html: oldHtml[oi], text: oldText[oi++] });
      else {
        rows.push({ k: 'ctx', o: o++, n: n++, html: newHtml[ni], text: newText[ni++] });
        oi++;
      }
    }
    largest = Math.max(largest, o, n);
    if (words) markWords(rows, start);
    if (fold) foldRuns(rows, start, fold);
  });
  noteAt(hunks.length);
  return { rows, widest: widestRows(rows), digits: String(Math.max(largest - 1, 1)).length };
}

/** The markup of each of a patch's rows as `diffRows` lays them out, empty for a gap or a note: what a worker sends back. */
export function diffHtml(patch: string, path: string): string[] {
  return diffRows(patch, path).rows.map((r) => (r.k === 'gap' || r.k === 'note' ? '' : r.html));
}

/** Pairs each run of removed lines with the added run right after it, line by line, and marks the words. */
function markWords(rows: CodeRow[], from: number) {
  for (let i = from; i < rows.length; ) {
    if (rows[i].k !== 'rem') {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].k === 'rem') j++;
    let k = j;
    while (k < rows.length && rows[k].k === 'ins') k++;
    const pairs = Math.min(j - i, k - j);
    for (let p = 0; p < pairs; p++) {
      const a = rows[i + p] as LineRow;
      const b = rows[j + p] as LineRow;
      const w = wordChanges(a.text, b.text);
      if (!w) continue;
      a.html = markRanges(a.html, w.a);
      b.html = markRanges(b.html, w.b);
    }
    i = k;
  }
}

/** Folds the long unchanged runs of rows[from..] into gaps that keep `keep` lines next to each change. */
function foldRuns(rows: CodeRow[], from: number, keep: number) {
  const out: CodeRow[] = [];
  let i = from;
  while (i < rows.length) {
    if (rows[i].k !== 'ctx') {
      out.push(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].k === 'ctx') j++;
    const first = i === from;
    const last = j === rows.length;
    const head = first ? 0 : keep;
    const tail = last ? 0 : keep;
    if (j - i > head + tail + 1) {
      out.push(...rows.slice(i, i + head));
      const g = rows[i + head] as LineRow;
      out.push({ k: 'gap', count: j - i - head - tail, o: g.o!, n: g.n!, rows: rows.slice(i + head, j - tail) });
      out.push(...rows.slice(j - tail, j));
    } else out.push(...rows.slice(i, j));
    i = j;
  }
  rows.splice(from, rows.length - from, ...out);
}

/**
 * A long file highlighted a slice at a time, for a caller that gives the page its frames back between slices. Each
 * slice ends on a blank line and is highlighted as a block; when the blank line comes back with markup, a comment or a
 * string is still open there and the slice grows to the next blank line, so colours never break where slices meet.
 */
export function* highlightSlices(lines: string[], path: string, size = 300): Generator<string[]> {
  let from = 0;
  while (from < lines.length) {
    let to = Math.min(lines.length, from + size);
    for (;;) {
      let cut = to;
      if (to < lines.length) {
        let k = to;
        while (k > from + 1 && lines[k - 1].trim() !== '') k--;
        if (k > from + 1) cut = k;
      }
      const html = highlightLines(lines.slice(from, cut), path);
      const open = cut < lines.length && lines[cut - 1].trim() === '' && html[html.length - 1].replace(/\s/g, '') !== '';
      if (open && to < lines.length) {
        to = Math.min(lines.length, to + size);
        continue;
      }
      yield html;
      from = cut;
      break;
    }
  }
}
