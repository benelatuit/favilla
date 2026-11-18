import { structuredPatch } from 'diff';
import type { DiffFile } from '../types';
import { isBinary, type FileContent } from '../util/file-content';

/**
 * Unified diff of one file for the UI, plus added/removed line counts. `context` is the unchanged lines kept around
 * each change; Infinity keeps all of them, for a view that opens the unchanged runs in place.
 */
export function makeDiff(displayName: string, before: FileContent | Buffer, after: FileContent | Buffer, op: DiffFile['op'], movedTo?: string, context = 3): DiffFile {
  type Side = typeof before;
  const binary = (v: Side) => Buffer.isBuffer(v) ? isBinary(v) : typeof v === 'string' ? v.includes('\0') : v !== null;
  if (binary(before) || binary(after)) {
    const size = (v: Side) => Buffer.isBuffer(v) ? v.length : typeof v === 'string' ? Buffer.byteLength(v) : v?.bytes ?? 0;
    return { path: displayName, op, movedTo, binary: { before: size(before), after: size(after) }, patch: '', added: 0, removed: 0 };
  }
  // File tools compare decoded text without the BOM. Keep the original bytes above for mixed text/binary edits.
  const text = (v: Side) => Buffer.isBuffer(v) ? v.toString('utf8').replace(/^\uFEFF/, '') : typeof v === 'string' ? v : '';
  return makeTextDiff(displayName, text(before), text(after), op, movedTo, context);
}

export function makeTextDiff(displayName: string, before: string | null, after: string | null, op: DiffFile['op'], movedTo?: string, context = 3): DiffFile {
  const a = (before ?? '').replace(/\r\n/g, '\n');
  const b = (after ?? '').replace(/\r\n/g, '\n');
  let patch = '';
  let added = 0;
  let removed = 0;
  const around = Number.isFinite(context) ? context : Math.max(a.split('\n').length, b.split('\n').length);
  const result = structuredPatch(displayName, movedTo ?? displayName, a, b, undefined, undefined, { context: around, timeout: 1500, maxEditLength: 50_000 } as never) as
    | { hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] }
    | undefined;
  if (result) {
    const out: string[] = [];
    for (const h of result.hunks) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const line of h.lines) {
        if (line.startsWith('\\')) continue;
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
        out.push(line);
      }
    }
    patch = out.join('\n');
  } else {
    added = b ? b.split('\n').length : 0;
    removed = a ? a.split('\n').length : 0;
    patch = `@@ large change: ${removed} lines replaced by ${added} @@`;
  }
  if (patch.length > 400_000) patch = `${patch.slice(0, 400_000)}\n@@ diff truncated @@`;
  return { path: displayName, op, movedTo, patch, added, removed };
}
