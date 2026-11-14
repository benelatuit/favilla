import fs from 'node:fs';
import { isProbablyBinary, numberLines } from '../util/text';

/** A file whose text goes into the context after a compaction, numbered as a read shows it. */
export interface BenchFile {
  path: string;
  text: string;
  lines: number;
}

/**
 * The files the step in progress works on, as they are now: of `paths` (newest first), each one that is text and fits
 * whole in what is left of `maxChars`, `count` at most. After a compaction most reads were of these, each a step that
 * brought back text the model had just had: on a long refactoring task, DeepSeek read files again 6 to 30 times a run
 * (2026-11-06).
 */
export function workbench(paths: string[], maxChars: number, count = 2): BenchFile[] {
  const out: BenchFile[] = [];
  let left = maxChars;
  for (const p of paths) {
    if (out.length >= count) break;
    let buf: Buffer;
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > left) continue;
      buf = fs.readFileSync(p);
    } catch {
      continue;
    }
    if (isProbablyBinary(buf)) continue;
    const lines = buf.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/);
    const text = numberLines(lines, 1);
    if (text.length > left) continue;
    out.push({ path: p, text, lines: lines.length });
    left -= text.length;
  }
  return out;
}
