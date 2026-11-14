/**
 * The `apply_patch` format GPT models are trained on:
 *
 *   *** Begin Patch
 *   *** Update File: src/app.py
 *   @@ def main():
 *   -    old()
 *   +    new()
 *   *** End Patch
 *
 * Parsing is lenient about the wrappers models sometimes add (heredocs, missing markers,
 * blank context lines without their leading space); applying is strict about ambiguity.
 */

export interface Chunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  eof: boolean;
}

export type PatchOp =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; moveTo?: string; chunks: Chunk[] };

export class PatchError extends Error {}

const OP_RE = /^\*\*\* (Add File|Delete File|Update File): (.+)$/;

export function parsePatch(input: string): PatchOp[] {
  let text = input.replace(/\r\n/g, '\n');
  const heredoc = /^\s*(?:apply_patch\s*)?<<\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\s*$/.exec(text);
  if (heredoc) text = heredoc[2];
  text = text.replace(/^\s*```(?:diff|patch)?\s*\n/, '').replace(/\n```\s*$/, '');
  const lines = text.split('\n');
  let i = lines.findIndex((l) => l.trim() === '*** Begin Patch');
  i = i === -1 ? lines.findIndex((l) => OP_RE.test(l.trim())) : i + 1;
  if (i === -1) throw new PatchError('No patch operations found. Start with "*** Begin Patch" followed by "*** Update File: <path>", "*** Add File: <path>" or "*** Delete File: <path>".');

  const ops: PatchOp[] = [];
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (line.trim() === '*** End Patch') break;
    if (!line.trim()) {
      i++;
      continue;
    }
    const m = OP_RE.exec(line.trim());
    if (!m) throw new PatchError(`Unexpected line ${i + 1}: "${line}". Expected "*** Add File:", "*** Update File:", "*** Delete File:" or "*** End Patch".`);
    const [, kind, rawPath] = m;
    const path = rawPath.trim();
    i++;
    if (kind === 'Delete File') {
      ops.push({ type: 'delete', path });
      continue;
    }
    if (kind === 'Add File') {
      const body: string[] = [];
      while (i < lines.length && !isOpLine(lines[i])) {
        const l = lines[i];
        body.push(l.startsWith('+') ? l.slice(1) : l);
        i++;
      }
      while (body.length && body[body.length - 1] === '' && !lines[i - 1]?.startsWith('+')) body.pop();
      ops.push({ type: 'add', path, content: body.length ? `${body.join('\n')}\n` : '' });
      continue;
    }
    let moveTo: string | undefined;
    const mv = /^\*\*\* Move to: (.+)$/.exec(lines[i]?.trim() ?? '');
    if (mv) {
      moveTo = mv[1].trim();
      i++;
    }
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    while (i < lines.length && !isOpLine(lines[i])) {
      const l = lines[i];
      if (l.startsWith('@@')) {
        const ctx = l.slice(2).trim();
        cur = { context: ctx || undefined, oldLines: [], newLines: [], eof: false };
        chunks.push(cur);
      } else if (l.trim() === '*** End of File') {
        if (cur) cur.eof = true;
      } else {
        if (!cur) {
          cur = { oldLines: [], newLines: [], eof: false };
          chunks.push(cur);
        }
        if (l.startsWith('+')) cur.newLines.push(l.slice(1));
        else if (l.startsWith('-')) cur.oldLines.push(l.slice(1));
        else {
          const ctx = l.startsWith(' ') ? l.slice(1) : l;
          cur.oldLines.push(ctx);
          cur.newLines.push(ctx);
        }
      }
      i++;
    }
    for (const c of chunks) {
      while (c.oldLines.length && c.newLines.length && c.oldLines[c.oldLines.length - 1] === '' && c.newLines[c.newLines.length - 1] === '') {
        c.oldLines.pop();
        c.newLines.pop();
      }
    }
    const real = chunks.filter((c) => c.oldLines.length || c.newLines.length);
    if (!real.length && !moveTo) throw new PatchError(`Update for ${path} contains no changes.`);
    ops.push({ type: 'update', path, moveTo, chunks: real });
  }
  if (!ops.length) throw new PatchError('The patch contains no operations.');
  return ops;
}

function isOpLine(line: string): boolean {
  const t = line.trim();
  return t === '*** End Patch' || OP_RE.test(t);
}

const PUNCT: Record<string, string> = {
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
};

function normPunct(s: string): string {
  return s.replace(/[‐-―−‘-‟     ]/g, (c) => PUNCT[c] ?? c).trim();
}

const PASSES: ((s: string) => string)[] = [(s) => s, (s) => s.trimEnd(), (s) => s.trim(), normPunct];

function matchesAt(lines: string[], pattern: string[], at: number, f: (s: string) => string): boolean {
  for (let k = 0; k < pattern.length; k++) if (f(lines[at + k]) !== f(pattern[k])) return false;
  return true;
}

/** Find `pattern` in `lines` at or after `start`, trying progressively looser comparisons. */
export function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return -1;
  for (const f of PASSES) {
    if (eof) {
      const at = lines.length - pattern.length;
      if (at >= start && matchesAt(lines, pattern, at, f)) return at;
    }
    for (let at = start; at + pattern.length <= lines.length; at++) if (matchesAt(lines, pattern, at, f)) return at;
  }
  // Out-of-order chunks: accept a unique match anywhere in the file.
  for (const f of PASSES) {
    const hits: number[] = [];
    for (let at = 0; at + pattern.length <= lines.length && hits.length < 2; at++) if (matchesAt(lines, pattern, at, f)) hits.push(at);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return -1;
  }
  return -1;
}

/** Apply update chunks to file content; throws PatchError with the lines it could not find. */
export function applyChunks(content: string, chunks: Chunk[], path: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  let lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  const replacements: [number, number, string[]][] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context) {
      const at = seekSequence(lines, [chunk.context], cursor, false);
      if (at === -1) throw new PatchError(`Failed to find context "${chunk.context}" in ${path}.`);
      cursor = at + 1;
    }
    if (!chunk.oldLines.length) {
      const at = chunk.context ? cursor : lines.length;
      replacements.push([at, 0, chunk.newLines]);
      continue;
    }
    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let at = seekSequence(lines, pattern, cursor, chunk.eof);
    if (at === -1 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (replacement[replacement.length - 1] === '') replacement = replacement.slice(0, -1);
      at = seekSequence(lines, pattern, cursor, chunk.eof);
    }
    if (at === -1) {
      throw new PatchError(`Failed to find the expected lines in ${path}:\n${chunk.oldLines.map((l) => `  ${l}`).join('\n')}\nRead the file again and base the patch on its current content.`);
    }
    replacements.push([at, pattern.length, replacement]);
    cursor = at + pattern.length;
  }
  replacements.sort((a, b) => b[0] - a[0]);
  for (const [at, len, seg] of replacements) lines.splice(at, len, ...seg);
  return `${lines.join(eol)}${eol}`;
}
