/**
 * String replacement with forgiving matching. Exact matches always win. When the model's
 * old_string differs from the file only in whitespace, indentation or escaping, a unique fuzzy
 * match is applied (re-indenting the replacement to fit). Anything ambiguous is refused with
 * the locations, and a miss returns the closest region so the next attempt can succeed.
 */

export interface ReplaceSuccess {
  ok: true;
  content: string;
  strategy: string;
  /** Line ranges (1-based, in the new content) that changed. */
  ranges: { start: number; end: number }[];
}

export interface ReplaceFailure {
  ok: false;
  error: string;
}

export type ReplaceResult = ReplaceSuccess | ReplaceFailure;

interface Span {
  start: number;
  end: number;
  replacement: string;
}

export function applyReplace(content: string, oldRaw: string, newRaw: string, replaceAll = false): ReplaceResult {
  const oldStr = oldRaw.replace(/\r\n/g, '\n');
  const newStr = newRaw.replace(/\r\n/g, '\n');
  if (oldStr === newStr) return { ok: false, error: 'old_string and new_string are identical; nothing to change.' };
  if (!oldStr) return { ok: false, error: 'old_string is empty. To create a file use the write tool; to insert text, include a nearby line in old_string.' };

  const exact = indexesOf(content, oldStr);
  if (exact.length === 1 || (exact.length > 1 && replaceAll)) {
    return apply(content, exact.map((i) => ({ start: i, end: i + oldStr.length, replacement: newStr })), 'exact');
  }
  if (exact.length > 1) return ambiguous(content, exact, oldStr);

  const attempts: [string, () => Span[]][] = [
    ['trailing-whitespace', () => lineMatch(content, oldStr, newStr, (a, b) => a.trimEnd() === b.trimEnd(), false)],
    ['indentation', () => lineMatch(content, oldStr, newStr, (a, b) => a.trim() === b.trim(), true)],
    ['unescaped', () => unescapedMatch(content, oldStr, newStr)],
    ['whitespace', () => collapsedMatch(content, oldStr, newStr)],
    ['anchor', () => anchorMatch(content, oldStr, newStr)],
  ];
  for (const [name, find] of attempts) {
    const spans = find();
    if (spans.length === 1 || (spans.length > 1 && replaceAll)) return apply(content, spans, name);
    if (spans.length > 1) return ambiguous(content, spans.map((s) => s.start), oldStr);
  }
  return { ok: false, error: `old_string was not found in the file.${closestHint(content, oldStr)}` };
}

function indexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function apply(content: string, spans: Span[], strategy: string): ReplaceSuccess {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  const ranges: { start: number; end: number }[] = [];
  for (const s of sorted) {
    if (s.start < cursor) continue;
    out += content.slice(cursor, s.start);
    const startLine = lineOf(out, out.length);
    out += s.replacement;
    const endLine = startLine + Math.max(0, s.replacement.split('\n').length - 1);
    ranges.push({ start: startLine, end: endLine });
    cursor = s.end;
  }
  out += content.slice(cursor);
  return { ok: true, content: out, strategy, ranges };
}

function ambiguous(content: string, starts: number[], oldStr: string): ReplaceFailure {
  const lines = starts.slice(0, 12).map((s) => lineOf(content, s));
  const more = starts.length > 12 ? ` and ${starts.length - 12} more` : '';
  const preview = oldStr.split('\n')[0].slice(0, 80);
  return {
    ok: false,
    error: `old_string matches ${starts.length} places (lines ${lines.join(', ')}${more}), starting "${preview}". Include more surrounding lines to pick one, or set replace_all to change every occurrence.`,
  };
}

/** Byte offsets of each line start, plus a sentinel at the end. */
function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function leading(s: string): string {
  return /^[ \t]*/.exec(s)![0];
}

/**
 * Re-indent `text` (written with the model's indentation) to the file's indentation, using the
 * matched lines as the key: each indentation the model used maps to what the file actually has,
 * and deeper levels scale by the same ratio.
 */
function remapIndent(text: string, findLines: string[], fileLines: string[]): string {
  const map = new Map<string, string>();
  let ratio: number | undefined;
  let unit = ' ';
  for (let k = 0; k < findLines.length; k++) {
    if (!findLines[k]?.trim()) continue;
    const f = leading(findLines[k]);
    const t = leading(fileLines[k] ?? '');
    if (!map.has(f)) map.set(f, t);
    if (t.length) unit = t[0];
    if (ratio === undefined && f.length > 0 && t.length > 0 && !f.includes('	') && !t.includes('	')) ratio = t.length / f.length;
  }
  if ([...map].every(([f, t]) => f === t)) return text;
  const firstFrom = [...map.keys()][0] ?? '';
  const firstTo = map.get(firstFrom) ?? '';
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      const lead = leading(line);
      const rest = line.slice(lead.length);
      const exact = map.get(lead);
      if (exact !== undefined) return exact + rest;
      let best: string | undefined;
      for (const key of map.keys()) if (lead.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
      if (best !== undefined) {
        const extra = lead.slice(best.length);
        const scaled = ratio && unit === ' ' && !extra.includes('	') ? ' '.repeat(Math.round(extra.length * ratio)) : extra;
        return map.get(best)! + scaled + rest;
      }
      const shift = firstTo.length - firstFrom.length;
      return (unit === '	' ? '	' : ' ').repeat(Math.max(0, lead.length + shift)) + rest;
    })
    .join('\n');
}

function lineMatch(content: string, oldStr: string, newStr: string, eq: (fileLine: string, findLine: string) => boolean, adjustIndent: boolean): Span[] {
  const trailingNl = oldStr.endsWith('\n');
  const findLines = (trailingNl ? oldStr.slice(0, -1) : oldStr).split('\n');
  if (!findLines.some((l) => l.trim())) return [];
  const lines = content.split('\n');
  const starts = lineStarts(content);
  const spans: Span[] = [];
  for (let i = 0; i + findLines.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < findLines.length; k++) {
      if (!eq(lines[i + k], findLines[k])) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const last = i + findLines.length - 1;
    const start = starts[i];
    let end = starts[last] + lines[last].length;
    if (trailingNl && end < content.length) end += 1;
    const replacement = adjustIndent ? remapIndent(newStr, findLines, lines.slice(i, i + findLines.length)) : newStr;
    spans.push({ start, end, replacement });
    i = last;
  }
  return spans;
}

function unescape(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function unescapedMatch(content: string, oldStr: string, newStr: string): Span[] {
  if (!/\\[nt"'\\]/.test(oldStr)) return [];
  const o = unescape(oldStr);
  const n = /\\[nt"'\\]/.test(newStr) ? unescape(newStr) : newStr;
  const hits = indexesOf(content, o);
  if (hits.length) return hits.map((i) => ({ start: i, end: i + o.length, replacement: n }));
  return lineMatch(content, o, n, (a, b) => a.trim() === b.trim(), true);
}

/** Match with every whitespace run collapsed, mapping back to original offsets. */
function collapsedMatch(content: string, oldStr: string, newStr: string): Span[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const needle = norm(oldStr);
  if (needle.length < 8) return [];
  let collapsed = '';
  const map: number[] = [];
  let inWs = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (/\s/.test(ch)) {
      if (!inWs) {
        collapsed += ' ';
        map.push(i);
        inWs = true;
      }
    } else {
      collapsed += ch;
      map.push(i);
      inWs = false;
    }
  }
  const hits = indexesOf(collapsed, needle);
  return hits.map((h) => {
    const start = map[h];
    const lastIdx = map[h + needle.length - 1];
    return { start, end: lastIdx + 1, replacement: newStr };
  });
}

/** First and last lines match exactly (trimmed) and the middle is mostly the same. */
function anchorMatch(content: string, oldStr: string, newStr: string): Span[] {
  const findLines = oldStr.replace(/\n$/, '').split('\n');
  if (findLines.length < 3) return [];
  const first = findLines[0].trim();
  const last = findLines[findLines.length - 1].trim();
  if (!first || !last) return [];
  const lines = content.split('\n');
  const starts = lineStarts(content);
  const spans: Span[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== first) continue;
    const maxEnd = Math.min(lines.length - 1, i + findLines.length + 3);
    for (let j = i + Math.max(1, findLines.length - 3); j <= maxEnd; j++) {
      if (lines[j].trim() !== last) continue;
      const block = lines.slice(i, j + 1);
      if (similarity(block.map((l) => l.trim()).join('\n'), findLines.map((l) => l.trim()).join('\n')) < 0.8) continue;
      spans.push({ start: starts[i], end: starts[j] + lines[j].length, replacement: remapIndent(newStr, findLines, block) });
      break;
    }
  }
  return spans;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

function closestHint(content: string, oldStr: string): string {
  const findLines = oldStr.replace(/\n$/, '').split('\n');
  const lines = content.split('\n');
  if (lines.length > 20_000 || findLines.length > 200) return ' Re-read the file and copy the exact text.';
  const n = findLines.length;
  const target = findLines.map((l) => l.trim());
  let best = { score: 0, at: -1 };
  for (let i = 0; i + n <= lines.length; i++) {
    let score = 0;
    for (let k = 0; k < n; k++) score += similarity(lines[i + k].trim(), target[k]);
    score /= n;
    if (score > best.score) best = { score, at: i };
  }
  if (best.at < 0 || best.score < 0.5) return ' Re-read the file and copy the exact text, including indentation.';
  const from = best.at + 1;
  const to = best.at + n;
  const snippet = lines
    .slice(best.at, best.at + n)
    .map((l, k) => `${String(from + k).padStart(6)}\t${l}`)
    .join('\n');
  return ` The closest text is at lines ${from}-${to} (${Math.round(best.score * 100)}% similar):\n${snippet}\nCopy the exact text from these lines (the part after each tab) into old_string and try again; read the file again only when they do not show what you need.`;
}
