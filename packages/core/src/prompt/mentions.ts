import fs from 'node:fs';
import path from 'node:path';
import type { ImagePart } from '../types';
import { displayPath, resolvePath } from '../util/paths';
import { decodeFile, decodeOutput, isProbablyBinary, numberLines } from '../util/text';
import { attach, typedPart } from './attached';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/**
 * `@path` in a message attaches that file: text files are inlined with line numbers (so the
 * model starts from the content the user pointed at), images are attached, folders are listed. Only the words the
 * user typed name files: an @ inside something they pasted is part of the paste.
 */
export function expandMentions(text: string, cwd: string, maxChars = 60_000): { text: string; images: ImagePart[]; files: string[] } {
  const images: ImagePart[] = [];
  const blocks: string[] = [];
  const files: string[] = [];
  let budget = maxChars;
  const seen = new Set<string>();
  for (const m of typedPart(text).matchAll(/(^|\s)@("[^"]+"|[^\s"]+)/g)) {
    const raw = m[2].replace(/^"|"$/g, '').replace(/[,.;:!?)]+$/, '');
    const abs = resolvePath(cwd, raw);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    const shown = displayPath(cwd, abs);
    files.push(shown);
    if (st.isDirectory()) {
      const entries = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      const block = `<folder path="${shown}">\n${entries.join('\n')}\n</folder>`;
      if (block.length < budget) {
        blocks.push(block);
        budget -= block.length;
      }
      continue;
    }
    const ext = path.extname(abs).toLowerCase();
    if (IMAGE_TYPES[ext] && st.size < 5 * 1024 * 1024) {
      images.push({ type: 'image', mediaType: IMAGE_TYPES[ext], data: fs.readFileSync(abs).toString('base64'), name: path.basename(abs) });
      continue;
    }
    if (st.size > 2 * 1024 * 1024) continue;
    const buf = fs.readFileSync(abs);
    if (isProbablyBinary(buf)) continue;
    const whole = decodeFile(buf);
    const lines = (whole.encoding === 'unknown' ? decodeOutput(buf) : whole.text).replace(/\r\n/g, '\n').split('\n');
    let body = numberLines(lines, 1);
    if (body.length > budget) {
      body = `${body.slice(0, Math.max(0, budget - 200))}\n… (truncated; read the rest with the read tool)`;
    }
    if (budget < 500) continue;
    blocks.push(`<file path="${shown}">\n${body}\n</file>`);
    budget -= body.length;
  }
  if (!blocks.length) return { text, images, files };
  return { text: attach(text, blocks), images, files };
}
