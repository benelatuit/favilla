import { structuredPatch } from 'diff';
import type { DiffFile } from '../types';

/** Unified diff of one file for the UI, plus added/removed line counts. */
export function makeDiff(displayName: string, before: string | null, after: string | null, op: DiffFile['op'], movedTo?: string): DiffFile {
  const a = (before ?? '').replace(/\r\n/g, '\n');
  const b = (after ?? '').replace(/\r\n/g, '\n');
  let patch = '';
  let added = 0;
  let removed = 0;
  const result = structuredPatch(displayName, movedTo ?? displayName, a, b, undefined, undefined, { context: 3, timeout: 1500, maxEditLength: 50_000 } as never) as
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
