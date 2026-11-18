import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DiffFile } from '../types';
import { extForImageMediaType, parseVirtualImageId } from '../context/images';
import { displayPath, resolvePath } from '../util/paths';
import { fileListLabels } from '../util/file-list';
import { countLines, decodeFile, decodeOutput, detectEol, encode1252, encodeGbk, isProbablyBinary, numberLines, truncateEnd, type TextEncoding } from '../util/text';
import { applyReplace } from './replace';
import { applyChunks, parsePatch, PatchError, type PatchOp } from './patch';
import { checkRegion, imageSize, imageWorker, MAX_RAW_INPUT_BYTES, normalizeIngressImage, sniffImageMediaType } from './image';
import { formatDiagnostics, syntaxCheck } from './diagnostics';
import { makeDiff } from './diffutil';
import { outline } from './outline';
import { structuredPatch } from 'diff';
import { similarity } from './replace';
import { documentNote } from './outbound';
import { OFFICE_TYPES, officeText, type SheetRead } from './office';
import type { ToolContext, ToolDef, ToolOutput } from './types';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const DEFAULT_LIMIT = 2000;
/** Files longer than this, read without a range on Favilla's surface, come back as a start and a map. */
const OVERVIEW_OVER = 400;
const OVERVIEW_HEAD = 80;

/** A tail request keeps the last complete units that fit, even when the requested tail is too large. */
function tailStart(total: number, count: number, budget: number, size: (n: number) => number, separator: number): number {
  let start = total;
  let used = size(total);
  while (start > Math.max(1, total - count + 1)) {
    used += separator + size(start - 1);
    if (used > budget) break;
    start--;
  }
  return start;
}

/** For ambiguous plain text, require the same record shape across the file. Leave prose and source alone. */
function looksLikeRecords(lines: string[], ext: string): boolean {
  if (!['', '.txt', '.dat', '.tsv', '.log'].includes(ext) || lines.length < 32) return false;
  const shape = (s: string): string => {
    if (!s || s.length > 2048) return '';
    for (const sep of ['\t', '|']) {
      const fields = s.split(sep);
      if (fields.length > 1 && fields.every(f => f.length && !/\s/.test(f))) return `${sep}${fields.length}`;
    }
    // Machine identifiers with a numeric component and a repeated field separator.
    return /^(?=.*\d)[\w]+(?:[-.:/][\w]+){2,}$/.test(s) ? s.replace(/[A-Za-z0-9_]+/g, '#') : '';
  };
  const key = shape(lines[1]);
  if (!key) return false;
  const sample = Array.from({ length: 24 }, (_, i) => lines[1 + Math.floor((lines.length - 2) * i / 23)]);
  return new Set(sample).size > 1 && sample.every(s => shape(s) === key);
}

function err(content: string): ToolOutput {
  return { content, isError: true };
}

/** Suggest files with a similar name when a path does not exist. */
function suggest(abs: string, cwd: string): string {
  const dir = path.dirname(abs);
  const base = path.basename(abs).toLowerCase();
  try {
    const entries = fs.readdirSync(dir);
    const close = entries
      .map((e) => ({ e, s: similarity(e.toLowerCase(), base) }))
      .filter((x) => x.s > 0.45)
      .sort((a, b) => b.s - a.s)
      .slice(0, 4)
      .map((x) => displayPath(cwd, path.join(dir, x.e)));
    if (close.length) return ` Did you mean: ${close.join(', ')}?`;
    return ` The folder ${displayPath(cwd, dir)} exists; search with glob if unsure of the name.`;
  } catch {
    return ` The folder ${displayPath(cwd, dir)} does not exist either.`;
  }
}

export function readText(abs: string): { text: string; bom: boolean; encoding: TextEncoding; buf: Buffer } {
  const buf = fs.readFileSync(abs);
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { ...decodeFile(bom ? buf.subarray(3) : buf), bom, buf };
}

/**
 * Written back as it was read: a GBK file stays GBK and a Windows-1252 file stays Windows-1252 (an edit used to
 * rewrite the whole file as UTF-8). A file whose encoding is not known cannot be written back byte for byte and is
 * not written at all: its characters would turn into U+FFFD.
 */
export function writeText(abs: string, text: string, bom: boolean, encoding: TextEncoding = 'utf8'): Buffer {
  const why = unwritable(path.basename(abs), text, encoding);
  if (why) throw new EncodingError(why);
  const bytes = ASCII.test(text) ? Buffer.from(text, 'latin1') : encoding === 'gbk' ? encodeGbk(text)! : encoding === 'cp1252' ? encode1252(text)! : Buffer.from(text, 'utf8');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const data = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
  fs.writeFileSync(abs, data);
  return data;
}

const ASCII = /^[\x00-\x7f]*$/;

/** Why `text` cannot go into a file read in `encoding` without losing characters, or null. Plain ASCII always can. */
export function unwritable(name: string, text: string, encoding: TextEncoding): string | null {
  if (encoding === 'utf8' || ASCII.test(text)) return null;
  if (encoding === 'unknown') return `${name} is not UTF-8 or GBK, and writing it here would destroy its non-ASCII characters. Change it with a command that keeps its bytes (sed, perl or a short script reading and writing bytes), or convert it to UTF-8 first if the project allows that.`;
  if (encoding === 'cp1252') {
    if (encode1252(text)) return null;
    const lost = [...new Set([...text].filter((ch) => !encode1252(ch)))];
    return `${name} is read as Windows-1252 (one byte per character), and the new text has characters that encoding cannot hold: ${lost.slice(0, 8).join(' ')}${lost.length > 8 ? ' …' : ''}. Use characters it has, or convert the file to UTF-8 first if whatever reads the file allows that.`;
  }
  return encodeGbk(text) ? null : `${name} is GBK, and the new text has characters GBK cannot hold (emoji, rare characters). Use characters GBK has, or convert the file to UTF-8 first if the project allows that.`;
}

export class EncodingError extends Error {}

/** A notebook as readable text: each cell with its number, id and type, then its source and outputs. */
export function renderNotebook(text: string): string {
  try {
    const nb = JSON.parse(text);
    return (nb.cells ?? [])
      .map((c: any, i: number) => {
        const src = Array.isArray(c.source) ? c.source.join('') : String(c.source ?? '');
        const outs = (c.outputs ?? [])
          .map((o: any) => (o.text ? (Array.isArray(o.text) ? o.text.join('') : o.text) : o.data?.['text/plain'] ? [].concat(o.data['text/plain']).join('') : ''))
          .filter(Boolean)
          .join('\n');
        return `# cell ${i + 1}${c.id ? ` (id ${c.id})` : ''} [${c.cell_type}]\n${src}${outs ? `\n# output\n${outs}` : ''}`;
      })
      .join('\n\n');
  } catch {
    return text;
  }
}

export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
  tail?: number;
  full?: boolean;
  /** Only the lines that define things, with their numbers: a map of a large file. */
  outline?: boolean;
  /** Read without a range: a large file comes back as its start and a map of the rest (Favilla's own surface). */
  overview?: boolean;
  /** For an image: [x, y, width, height] in its pixels, shown enlarged. */
  region?: number[];
}

export const readTool: ToolDef<ReadInput> = {
  kind: 'read',
  readOnly: true,
  title: (i, cwd) => `Read ${displayPath(cwd, resolvePath(cwd, i.path))}${i.offset ? `:${i.offset}` : ''}`,
  async execute(input, ctx) {
    const explicit = input.full || input.tail !== undefined;
    if (input.tail !== undefined && (!Number.isSafeInteger(input.tail) || input.tail < 1)) return err('tail must be a positive integer.');
    if (explicit && (input.offset !== undefined || input.limit !== undefined || input.outline || input.region || (input.full && input.tail !== undefined))) return err('Choose one of tail, full, or a range.');
    // Only exact `.favilla/images/img-NN.<ext>` registered in this session's ImageRegistry resolves from BlobStore;
    // every other `.favilla/*` file or unregistered filename falls straight through to disk.
    const virtualId = parseVirtualImageId(input.path, ctx.cwd);
    const snap = virtualId ? (ctx.sessionImage?.(virtualId, true) ?? null) : null;
    if (snap) {
      if (explicit) return err('tail and full apply to text and documents.');
      if (!ctx.model.vision) return err(`${snap.virtualPath} is an image and the current model cannot view images.`);
      const buf = ctx.blobs?.get(snap.blob);
      if (!buf) return err(`Session image ${snap.id} (${snap.virtualPath}) could not be loaded from the blob store.`);
      const size = imageSize(buf) ?? (snap.width && snap.height ? { width: snap.width, height: snap.height } : undefined);
      let diskNote = '';
      if (snap.sourcePath && snap.sourceSha256) {
        const diskAbs = resolvePath(ctx.cwd, snap.sourcePath);
        try {
          if (!fs.existsSync(diskAbs)) diskNote = ` (original file "${snap.sourcePath}" was removed from disk after this snapshot)`;
          else if (createHash('sha256').update(fs.readFileSync(diskAbs)).digest('hex') !== snap.sourceSha256) {
            diskNote = ` (note: "${snap.sourcePath}" on disk changed after this snapshot; read "${snap.sourcePath}" for the current version on disk)`;
          }
        } catch {
          /* ignore stat/read errors on moved files */
        }
      }
      if (input.region) {
        if (!size) return err(`${snap.virtualPath}: its size could not be read, so no region can be taken from it.`);
        const r = checkRegion(input.region, size);
        if (typeof r === 'string') return err(`${snap.virtualPath}: ${r}.`);
        let crop;
        try {
          crop = await imageWorker.crop(buf, snap.mediaType, r, 1600);
        } catch (e) {
          return err(`${snap.virtualPath}: ${(e as Error).message}.`);
        }
        return {
          content: `Region [${r.join(', ')}] of session image [${snap.id}]${snap.name ? ` "${snap.name}"` : ''} (${size.width}×${size.height} in all)${diskNote}, shown ${crop.scale >= 1 ? `enlarged ${+crop.scale.toFixed(2)}×` : `reduced to ${Math.round(crop.scale * 100)}%`} as ${crop.width}×${crop.height}.`,
          images: [{ type: 'image', mediaType: 'image/png', data: crop.data, name: `${snap.id} [${r.join(', ')}]`, width: crop.width, height: crop.height, region: r, sourcePath: snap.sourcePath, sourceSha256: snap.sourceSha256 }],
          display: { kind: 'file', path: snap.virtualPath, startLine: 1, lineCount: 0, totalLines: 0, preview: '', image: true, size: [size.width, size.height], region: r },
        };
      }
      const big = size && Math.max(size.width, size.height) > 1000;
      return {
        content: `Session image [${snap.id}]${snap.name ? ` "${snap.name}"` : ''} (${size ? `${size.width}×${size.height}, ` : ''}${Math.max(1, Math.round(buf.length / 1024))} KB)${diskNote} is attached.${big ? ' To look closer at a part, read it again with region: [x, y, width, height] in these pixels.' : ''}`,
        images: [
          {
            type: 'image',
            id: snap.id,
            blob: snap.blob,
            mediaType: snap.mediaType,
            data: buf.toString('base64'),
            name: snap.name ?? `${snap.id}${extForImageMediaType(snap.mediaType)}`,
            ...(size ? { width: size.width, height: size.height } : {}),
            sourcePath: snap.sourcePath,
            sourceSha256: snap.sourceSha256,
          },
        ],
        display: { kind: 'file', path: snap.virtualPath, startLine: 1, lineCount: 0, totalLines: 0, preview: '', image: true, size: size ? [size.width, size.height] : undefined },
      };
    }

    const abs = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, abs);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return err(`File not found: ${shown}.${suggest(abs, ctx.cwd)}`);
    }
    if (st.isDirectory()) {
      if (explicit) return err('tail and full apply to individual files.');
      const entries = fs
        .readdirSync(abs, { withFileTypes: true })
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      const list = entries.slice(0, 300);
      return {
        content: `${shown} is a directory with ${entries.length} entries:\n${fileListLabels(abs, list).join('\n')}${entries.length > list.length ? `\n… ${entries.length - list.length} more` : ''}`,
        display: { kind: 'list', title: shown, items: list, total: entries.length },
      };
    }
    const ext = path.extname(abs).toLowerCase();
    if (IMAGE_TYPES[ext]) {
      if (explicit) return err('tail and full apply to text and documents.');
      if (!ctx.model.vision) return err(`${shown} is an image and the current model cannot view images.`);
      if (st.size > MAX_RAW_INPUT_BYTES) return err(`${shown} is ${(st.size / 1048576).toFixed(0)} MB, too large to work on (limit is 40 MB).`);
      const buf = fs.readFileSync(abs);
      const declaredType = sniffImageMediaType(buf) ?? IMAGE_TYPES[ext];
      const size = imageSize(buf);
      const sourceSha256 = createHash('sha256').update(buf).digest('hex');
      ctx.files.recordRead(abs);
      const name = path.basename(abs);
      if (input.region) {
        // A part of the picture, enlarged: small text, edges and details a whole-image view scales away.
        if (!size) return err(`${shown}: its size could not be read, so no region can be taken from it.`);
        const r = checkRegion(input.region, size);
        if (typeof r === 'string') return err(`${shown}: ${r}.`);
        let crop;
        try {
          crop = await imageWorker.crop(buf, declaredType, r, 1600);
        } catch (e) {
          return err(`${shown}: ${(e as Error).message}.`);
        }
        return {
          content: `Region [${r.join(', ')}] of ${shown} (${size.width}×${size.height} in all), shown ${crop.scale >= 1 ? `enlarged ${+crop.scale.toFixed(2)}×` : `reduced to ${Math.round(crop.scale * 100)}%`} as ${crop.width}×${crop.height}.`,
          images: [{ type: 'image', mediaType: 'image/png', data: crop.data, name: `${name} [${r.join(', ')}]`, width: crop.width, height: crop.height, region: r, sourcePath: shown, sourceSha256 }],
          display: { kind: 'file', path: shown, startLine: 1, lineCount: 0, totalLines: 0, preview: '', image: true, size: [size.width, size.height], region: r },
        };
      }
      let norm;
      try {
        norm = await normalizeIngressImage(buf, declaredType);
      } catch (e) {
        return err(`${shown}: ${(e as Error).message}.`);
      }
      const outSize = norm.width && norm.height ? { width: norm.width, height: norm.height } : size;
      const big = outSize && Math.max(outSize.width, outSize.height) > 1000;
      const scaledNote = norm.resized && size && outSize && (size.width !== outSize.width || size.height !== outSize.height) ? ` (scaled from ${size.width}×${size.height} to ${outSize.width}×${outSize.height}, ${Math.max(1, Math.round(norm.buf.length / 1024))} KB)` : '';
      return {
        content: `Image ${shown} (${outSize ? `${outSize.width}×${outSize.height}, ` : ''}${Math.max(1, Math.round(norm.buf.length / 1024))} KB)${scaledNote} is attached.${big ? ' To look closer at a part, read it again with region: [x, y, width, height] in these pixels.' : ''}`,
        images: [
          {
            type: 'image',
            mediaType: norm.mediaType,
            data: norm.buf.toString('base64'),
            name,
            ...(outSize ? { width: outSize.width, height: outSize.height } : {}),
            sourcePath: shown,
            sourceSha256,
          },
        ],
        display: { kind: 'file', path: shown, startLine: 1, lineCount: 0, totalLines: 0, preview: '', image: true, size: outSize ? [outSize.width, outSize.height] : undefined },
      };
    }
    if (ext === '.pdf') return readPdf(abs, shown, input, ctx);
    const buf = fs.readFileSync(abs);
    let text: string;
    let legacy = '';
    const ranged = explicit || input.offset !== undefined || input.limit !== undefined;
    let start = Math.max(1, Math.floor(input.offset ?? 1));
    const limit = input.tail ?? (input.full ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)));
    const sheet: SheetRead = ranged ? { start, end: start + Math.min(limit, ctx.outputChars) - 1, tail: input.tail } : {};
    if (OFFICE_TYPES.has(ext)) {
      try {
        text = officeText(buf, ext, sheet);
      } catch (e) {
        return err(`${shown} could not be read as a ${ext.slice(1)} file: ${(e as Error).message}`);
      }
    } else {
      // An old Office file is binary: name the way to its text.
      const old = /^\.(?:doc|xls|ppt)$/.test(ext) ? ` LibreOffice, if installed, converts it to ${ext.slice(1)}x for read: soffice --headless --convert-to ${ext.slice(1)}x --outdir <a scratch folder> <the file>.` : '';
      if (isProbablyBinary(buf)) return err(`${shown} is a binary file (${buf.length} bytes) and is not shown.${old}`);
      // In the file's own encoding where it has one, so what is shown is what an edit will match against; a file
      // of no known encoding line by line.
      const whole = decodeFile(buf);
      text = (whole.encoding === 'unknown' ? decodeOutput(buf) : whole.text).replace(/^\ufeff/, '');
      if (whole.encoding === 'cp1252' || whole.encoding === 'gbk') legacy = `\n\n[${shown} is not UTF-8: it is ${whole.encoding === 'gbk' ? 'GBK' : 'read as Windows-1252, one byte per character'}. Edits made with the file tools keep it so; a command that rewrites it has to write the same encoding.]`;
    }
    if (ext === '.ipynb') text = renderNotebook(text);
    if (sheet.sampled) {
      ctx.files.recordRead(abs);
      return { content: truncateEnd(text, ctx.outputChars).text + '\n\n[Workbook preview. Read a document line range for exact rows, or process the workbook on disk.]' };
    }
    if (input.outline) {
      const map = outline(text, ext);
      if (map !== null) {
        ctx.files.recordRead(abs);
        const total = countLines(text);
        return {
          content: `Outline of ${shown} (${total} lines; read a range for the code):${map ? `\n${map}` : ' no definitions found.'}`,
          display: { kind: 'file', path: shown, startLine: 1, lineCount: 0, totalLines: total, preview: map.split('\n').slice(0, 80).join('\n') },
        };
      }
    }
    ctx.files.recordRead(abs);
    if (!text.length) return { content: `${shown} exists but is empty.`, display: { kind: 'file', path: shown, startLine: 1, lineCount: 0, totalLines: 0, preview: '' } };

    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    if (input.tail !== undefined) start = tailStart(total, input.tail, ctx.outputChars, n => Math.max(6, String(n).length) + 1 + lines[n - 1].length, 1);
    // Record streams have no definition map. Show their shape without treating
    // every row as source the caller needs to carry through the conversation.
    const records = /\.(?:csv|tsv|jsonl|ndjson)$/i.test(ext);
    if (!ranged && (total > OVERVIEW_OVER || text.length > 16_000) && (records || looksLikeRecords(lines, ext))) {
      const budget = Math.min(ctx.outputChars, 2048);
      let count = 0;
      let length = 0;
      while (count < Math.min(total, 8) && length + lines[count].length + 8 <= budget) length += lines[count++].length + 8;
      const head = lines.slice(0, count);
      const body = count ? numberLines(head, 1, budget) : numberLines([lines[0].slice(0, Math.max(0, budget - 8))], 1, budget) + '…';
      if (count) ctx.files.recordShown(abs, ctx.callId, 1, count, total);
      const coverage = count ? `Lines 1-${count}` : 'Start of line 1 only';
      return {
        content: `${body}\n\n[${coverage} of ${total}. Read a line range for exact rows or process the file on disk for all records.]${legacy}`,
        display: { kind: 'file', path: shown, startLine: 1, lineCount: count, totalLines: total, preview: body },
      };
    }
    // A large file asked for whole: its start and where everything else is defined, so the reads that follow take
    // the ranges that matter instead of the whole file riding along in every later request.
    if (input.overview && !ranged && total > OVERVIEW_OVER) {
      const rest = (outline(text, ext) ?? '').split('\n').filter((l) => Number(/^\s*(\d+)/.exec(l)?.[1] ?? 0) > OVERVIEW_HEAD);
      if (rest.length) {
        const head = lines.slice(0, OVERVIEW_HEAD);
        if (head.every(l => l.length <= 2000)) ctx.files.recordShown(abs, ctx.callId, 1, OVERVIEW_HEAD, total);
        return {
          content: `${numberLines(head, 1)}\n\n[Lines 1-${OVERVIEW_HEAD} of ${total}. The rest of the file defines, by line:]\n${rest.join('\n')}\n[Read the ranges you need; a range of the whole file reads it all.]`,
          display: { kind: 'file', path: shown, startLine: 1, lineCount: OVERVIEW_HEAD, totalLines: total, preview: head.slice(0, 80).join('\n') },
        };
      }
    }
    if (start > total) return err(`${shown} has only ${total} lines; offset ${start} is past the end.`);
    // The same lines, unchanged, already in the model's context: point there instead of paying for them twice.
    const want = Math.min(total, start - 1 + limit);
    const earlier = !input.full && ctx.inContext && ctx.files.earlierRead(abs, start, want, ctx.inContext);
    if (earlier) {
      const content = earlier.startsWith('m_')
        ? `${shown} lines ${start}-${want} have not changed since compaction and are already shown whole and numbered in the summary message at the top of your context: work from them directly.`
        : `${shown} lines ${start}-${want} have not changed since call ${earlier} showed them, and that output is still in your context above: work from it. (recall with call_id ${earlier} repeats it if you need it again.)`;
      return {
        content,
        display: { kind: 'file', path: shown, startLine: start, lineCount: 0, totalLines: total, preview: '' },
      };
    }
    let slice = lines.slice(start - 1, start - 1 + limit);
    // A requested record wider than the whole tool budget needs an on-disk read.
    // Never mark a partially returned row as fully shown.
    if (ranged && lines[start - 1].length + Math.max(6, String(start).length) + 1 > ctx.outputChars) {
      return { content: `${shown}: line ${start} exceeds the ${ctx.outputChars}-character result limit. Process this row on disk to read it whole.` };
    }
    // Render only complete lines that fit. Avoid building the rest of a very large explicit range.
    const maxWidth = ranged ? Infinity : 2000;
    const rendered: string[] = [];
    let length = 0;
    for (const line of slice) {
      const n = start + rendered.length;
      if (ranged && line.length > ctx.outputChars - length) break;
      const row = numberLines([line], n, maxWidth);
      if (length + row.length + (rendered.length ? 1 : 0) > ctx.outputChars) break;
      length += row.length + (rendered.length ? 1 : 0);
      rendered.push(row);
    }
    const body = rendered.join('\n');
    let note = input.tail !== undefined && start > Math.max(1, total - input.tail + 1) ? `\n\n[Showing final lines ${start}-${total} within the output limit.]` : '';
    if (!rendered.length) return { content: `${shown}: line ${start} exceeds the ${ctx.outputChars}-character result limit. Process this row on disk to read it whole.` };
    if (rendered.length < slice.length) {
      slice = slice.slice(0, rendered.length);
      note = `\n\n[Showing lines ${start}-${start + slice.length - 1} of ${total}; output limit reached. Continue with offset=${start + slice.length}.]`;
    } else if (start - 1 + slice.length < total) {
      note = `\n\n[Showing lines ${start}-${start + slice.length - 1} of ${total}. Use offset and limit to read further.]`;
    }
    if (slice.every(l => l.length <= maxWidth)) ctx.files.recordShown(abs, ctx.callId, start, start + slice.length - 1, total);
    return {
      content: body + note + legacy,
      display: { kind: 'file', path: shown, startLine: start, lineCount: slice.length, totalLines: total, preview: slice.slice(0, 80).join('\n') },
    };
  },
};

/** A PDF's text, page by page; offset and limit count pages. */
async function readPdf(abs: string, shown: string, input: ReadInput, ctx: ToolContext): Promise<ToolOutput> {
  let pages: string[];
  try {
    // Loaded on first use: only sessions that read a PDF pay for the parser.
    const { getDocumentProxy, extractText } = await import('unpdf');
    // verbosity 0: the parser would otherwise print warnings into the terminal UI.
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(abs)), { verbosity: 0 });
    pages = (await extractText(pdf, { mergePages: false })).text;
  } catch (e) {
    return err(`${shown} could not be read as a PDF: ${(e as Error).message}`);
  }
  ctx.files.recordRead(abs);
  const total = pages.length;
  const page = (n: number) => `--- page ${n} of ${total} ---\n${pages[n - 1].trim()}`;
  const first = total && input.tail !== undefined ? tailStart(total, input.tail, ctx.outputChars, n => page(n).length, 2) : Math.max(1, Math.floor(input.offset ?? 1));
  if (first > total) return err(`${shown} has only ${total} page${total === 1 ? '' : 's'}; offset ${first} is past the end.`);
  if (!pages.some((p) => p.trim())) {
    return err(`${shown} (${total} pages) has no text layer, so it is probably scanned. Render it to images or run OCR with a command to read it.`);
  }
  const last = Math.min(total, first - 1 + Math.max(1, Math.floor(input.limit ?? total)));
  const parts: string[] = [];
  let size = 0;
  let shownTo = first - 1;
  for (let n = first; n <= last; n++) {
    const part = page(n);
    if (parts.length && size + 2 + part.length > ctx.outputChars) break;
    if ((input.full || input.tail !== undefined) && part.length > ctx.outputChars) {
      parts.push(`[Page ${n} exceeds the ${ctx.outputChars}-character limit. Extract this page on disk.]`);
      shownTo = n;
      break;
    }
    parts.push(part.length > ctx.outputChars ? truncateEnd(part, ctx.outputChars).text : part);
    size += part.length + (parts.length > 1 ? 2 : 0);
    shownTo = n;
  }
  const note = shownTo < total ? `\n\n[Showing pages ${first}-${shownTo} of ${total} (offset and limit count pages in a PDF). Use offset and limit to read further.]` : '';
  const body = parts.join('\n\n');
  return {
    content: body + note,
    display: { kind: 'file', path: shown, startLine: first, lineCount: shownTo - first + 1, totalLines: total, preview: body.split('\n').slice(0, 80).join('\n') },
  };
}

export interface WriteInput {
  path: string;
  content: string;
}

export const writeTool: ToolDef<WriteInput> = {
  kind: 'write',
  readOnly: false,
  title: (i, cwd) => `Write ${displayPath(cwd, resolvePath(cwd, i.path))}`,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, abs);
    const existed = fs.existsSync(abs);
    if (existed && fs.statSync(abs).isDirectory()) return err(`${shown} is a directory.`);
    // Whose files these are holds for a new file too: a sub-agent's brief, or a background sub-agent's own files.
    const claimed = ctx.mayChange?.(abs);
    if (claimed) return err(claimed);
    if (existed) {
      const why = ctx.files.checkEditable(abs);
      if (why) return err(`${shown} already exists. ${why}`);
    }
    ctx.checkpoints.capture(ctx.turn, abs);
    const before = existed ? readText(abs) : null;
    let content = input.content;
    if (before && detectEol(before.text) === '\r\n' && !content.includes('\r\n')) content = content.replace(/\n/g, '\r\n');
    const bytes = writeText(abs, content, before?.bom ?? false, before?.encoding);
    ctx.files.recordWrite(abs);
    const diff = makeDiff(shown, before?.buf ?? null, bytes, existed ? 'update' : 'add');
    const problems = await syntaxCheck(abs, content);
    return {
      content: `${existed ? 'Updated' : 'Created'} ${shown} (${countLines(content)} lines).${formatDiagnostics(shown, problems)}${documentNote(abs, content, ctx.checkpoints as object | undefined)}`,
      display: { kind: 'diff', files: [diff] },
    };
  },
};

export interface EditInput {
  path: string;
  old: string;
  new: string;
  all?: boolean;
  /** Several replacements in one file, applied in order; those that match are written, one that does not is named. */
  edits?: { old: string; new: string; all?: boolean }[];
  /** Require a prior read (the str_replace profile does; apply_patch style profiles do not). */
  requireRead?: boolean;
}

const COMPACT_SPAN_THRESHOLD = 14;
const COMPACT_EDGE_LINES = 4;

function formatEditedSpan(lines: string[], from: number, to: number, compact: boolean): string {
  const count = to - from + 1;
  if (!compact || count <= COMPACT_SPAN_THRESHOLD) {
    return numberLines(lines.slice(from - 1, to), from);
  }
  const head = numberLines(lines.slice(from - 1, from - 1 + COMPACT_EDGE_LINES), from);
  const tailStart = to - COMPACT_EDGE_LINES + 1;
  const tail = numberLines(lines.slice(tailStart - 1, to), tailStart);
  return `${head}\n    … (${count - COMPACT_EDGE_LINES * 2} lines written as given) …\n${tail}`;
}

function firstChangedLine(beforeLf: string, afterLf: string): number {
  const len = Math.min(beforeLf.length, afterLf.length);
  let line = 1;
  let i = 0;
  for (; i < len && beforeLf.charCodeAt(i) === afterLf.charCodeAt(i); i++) {
    if (beforeLf.charCodeAt(i) === 10) line++;
  }
  return i === beforeLf.length && i === afterLf.length ? line + 1 : line;
}

/** The changed regions of a file after several edits, numbered as the file now reads, with a little context. */
function changedRegions(before: string, after: string, compact = false): string {
  const patch = structuredPatch('a', 'b', before, after, undefined, undefined, { context: 2 } as never) as { hunks: { newStart: number; newLines: number }[] } | undefined;
  const lines = after.split('\n');
  return (patch?.hunks ?? [])
    .slice(0, 6)
    .map((h) => formatEditedSpan(lines, h.newStart, h.newStart + h.newLines - 1, compact))
    .join('\n…\n');
}

export const editTool: ToolDef<EditInput> = {
  kind: 'edit',
  readOnly: false,
  title: (i, cwd) => `Edit ${displayPath(cwd, resolvePath(cwd, i.path))}`,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, abs);
    if (!fs.existsSync(abs)) {
      if (!input.old) return writeTool.execute({ path: input.path, content: input.new }, ctx);
      return err(`File not found: ${shown}.${suggest(abs, ctx.cwd)}`);
    }
    // A sub-agent's file limits hold whether or not this tool set asks for a read first (Favilla's own does not, and
    // its edit used to skip them).
    const refused = ctx.mayChange?.(abs);
    if (refused) return err(refused);
    if (input.requireRead !== false) {
      const why = ctx.files.checkEditable(abs);
      if (why) return err(why);
    }
    const { text, bom, encoding, buf } = readText(abs);
    const eol = detectEol(text);
    const lf = text.replace(/\r\n/g, '\n');
    // Text that already reads as asked is done, not an error (23 of 78 failed edits in the evals were these).
    const already = (o: string, n: string, content: string) => o.replace(/\r\n/g, '\n') === n.replace(/\r\n/g, '\n') && !!o && content.includes(o.replace(/\r\n/g, '\n'));
    if (input.edits?.length) {
      // The edits that match are written; one that does not is named, to be sent again alone (one bad edit used to
      // throw the whole batch away, and the model sent every edit again).
      let content = lf;
      const missed: string[] = [];
      let applied = 0;
      let allExact = true;
      for (const [i, e] of input.edits.entries()) {
        if (already(e.old, e.new, content)) continue;
        const r = applyReplace(content, e.old, e.new, !!e.all);
        if (!r.ok) {
          missed.push(`Edit ${i + 1} of ${input.edits.length}: ${r.error}`);
          continue;
        }
        if (r.strategy !== 'exact') allExact = false;
        content = r.content;
        applied++;
      }
      if (!applied) return missed.length ? err(`${missed.join('\n')}\nNothing was written.`) : { content: `${shown} already reads as these edits ask: nothing to change.` };
      ctx.checkpoints.capture(ctx.turn, abs);
      const out = eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
      const hadCoverage = ctx.files.hasCurrentCoverage(abs, buf);
      const bytes = writeText(abs, out, bom, encoding);
      if (hadCoverage) ctx.files.recordEdit(abs, firstChangedLine(lf, content), countLines(content), true);
      else ctx.files.recordWrite(abs);
      const diff = makeDiff(shown, buf, bytes, 'update');
      const head = missed.length ? `${missed.join('\n')}\nThe other ${applied} edit${applied === 1 ? ' was' : 's were'} written; send only the edit${missed.length === 1 ? '' : 's'} above again, corrected, against the file as it is now.\n\n` : '';
      const problems = await syntaxCheck(abs, out);
      const compact = allExact && missed.length === 0 && problems.length === 0;
      return {
        content: `${head}The file ${shown} has been updated (${applied} edit${applied === 1 ? '' : 's'}). The changed regions now read:\n${changedRegions(lf, content, compact)}${formatDiagnostics(shown, problems)}`,
        display: { kind: 'diff', files: [diff] },
      };
    }
    if (already(input.old, input.new, lf)) return { content: `${shown} already reads that way: nothing to change.` };
    const result = applyReplace(lf, input.old, input.new, !!input.all);
    if (!result.ok) return err(result.error);
    ctx.checkpoints.capture(ctx.turn, abs);
    const out = eol === '\r\n' ? result.content.replace(/\n/g, '\r\n') : result.content;
    const hadCoverage = ctx.files.hasCurrentCoverage(abs, buf);
    const lines = result.content.split('\n');
    const bytes = writeText(abs, out, bom, encoding);
    if (hadCoverage) ctx.files.recordEdit(abs, firstChangedLine(lf, result.content), lines.length, true);
    else ctx.files.recordWrite(abs);
    const diff = makeDiff(shown, buf, bytes, 'update');
    const problems = await syntaxCheck(abs, out);
    const compact = result.strategy === 'exact' && problems.length === 0;
    const snippets = result.ranges.slice(0, 3).map((r) => {
      const from = Math.max(1, r.start - 3);
      const to = Math.min(lines.length, r.end + 3);
      return formatEditedSpan(lines, from, to, compact);
    });
    const more = result.ranges.length > 3 ? `\n… and ${result.ranges.length - 3} more replacements` : '';
    const how = result.strategy === 'exact' ? '' : ` (matched ignoring ${result.strategy === 'indentation' ? 'indentation, which was adjusted' : result.strategy === 'unescaped' ? 'escaping' : 'whitespace differences'})`;
    return {
      content: `The file ${shown} has been updated${how}. The edited region now reads:\n${snippets.join('\n…\n')}${more}${formatDiagnostics(shown, problems)}${documentNote(abs, out, ctx.checkpoints as object | undefined)}`,
      display: { kind: 'diff', files: [diff] },
    };
  },
};

export interface PatchInput {
  patch: string;
}

interface Planned {
  op: PatchOp;
  abs: string;
  dest?: string;
  original?: Buffer;
  before: string | null;
  after: string | null;
  bom: boolean;
  encoding: TextEncoding;
}

export const patchTool: ToolDef<PatchInput> = {
  kind: 'patch',
  readOnly: false,
  title: (i) => {
    const files = [...i.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
    return `Patch ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`;
  },
  async execute(input, ctx) {
    let ops: PatchOp[];
    try {
      ops = parsePatch(input.patch);
    } catch (e) {
      return err(`Invalid patch: ${(e as Error).message}`);
    }
    const planned: Planned[] = [];
    const problems: string[] = [];
    // Each section applies to the file as the sections before it left it: planned from the disk alone, two sections
    // for one file kept only the last, and a file added and then updated in one patch was "not found".
    const state = new Map<string, { text: string | null; bom: boolean; encoding: TextEncoding }>();
    const current = (abs: string): { text: string | null; bom: boolean; encoding: TextEncoding; buf?: Buffer } => state.get(abs) ?? (fs.existsSync(abs) ? readText(abs) : { text: null, bom: false, encoding: 'utf8' as const });
    for (const op of ops) {
      const abs = resolvePath(ctx.cwd, op.path);
      const shown = displayPath(ctx.cwd, abs);
      const refused = ctx.mayChange?.(abs) ?? (op.type === 'update' && op.moveTo ? ctx.mayChange?.(resolvePath(ctx.cwd, op.moveTo)) : null);
      if (refused) {
        problems.push(refused);
        continue;
      }
      try {
        // A delete needs the previous bytes for its diff, never an encoding or a decoded copy.
        if (op.type === 'delete') {
          const staged = state.get(abs);
          if (staged ? staged.text === null : !fs.existsSync(abs)) throw new PatchError(`Cannot delete ${shown}: file not found.`);
          planned.push({ op, abs, original: staged ? undefined : fs.readFileSync(abs), before: staged?.text ?? null, after: null, bom: false, encoding: 'utf8' });
          state.set(abs, { text: null, bom: false, encoding: 'utf8' });
          continue;
        }
        const now = current(abs);
        if (op.type === 'add') {
          if (now.text) throw new PatchError(`${shown} already exists; use "*** Update File:" to change it.`);
          planned.push({ op, abs, original: now.buf, before: now.text === null ? null : '', after: op.content, bom: false, encoding: 'utf8' });
          state.set(abs, { text: op.content, bom: false, encoding: 'utf8' });
        } else {
          if (now.text === null) throw new PatchError(`Cannot update ${shown}: file not found.${suggest(abs, ctx.cwd)}`);
          const after = op.chunks.length ? applyChunks(now.text, op.chunks, shown) : now.text;
          // Checked before anything is written, so a patch never stops halfway on a file it cannot write back.
          const lost = unwritable(shown, after, now.encoding);
          if (lost) throw new PatchError(lost);
          const dest = op.moveTo ? resolvePath(ctx.cwd, op.moveTo) : undefined;
          planned.push({ op, abs, original: now.buf, dest, before: now.text, after, bom: now.bom, encoding: now.encoding });
          if (dest) {
            state.set(abs, { text: null, bom: false, encoding: 'utf8' });
            state.set(dest, { text: after, bom: now.bom, encoding: now.encoding });
          } else state.set(abs, { text: after, bom: now.bom, encoding: now.encoding });
        }
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    if (problems.length) return err(`Patch not applied; no files were changed.\n${problems.join('\n')}`);

    const summary: string[] = [];
    const diffs: DiffFile[] = [];
    // Code like what each file's change touched, left alone: one note per file.
    const diagnostics: string[] = [];
    for (const p of planned) {
      const shown = displayPath(ctx.cwd, p.abs);
      ctx.checkpoints.capture(ctx.turn, p.abs);
      const previous = p.original ?? (p.before === null ? null : fs.readFileSync(p.abs));
      if (p.op.type === 'delete') {
        fs.rmSync(p.abs, { force: true });
        ctx.files.forget(p.abs);
        const diff = makeDiff(shown, previous, null, 'delete');
        summary.push(`D ${shown}`);
        diffs.push(diff);
        continue;
      }
      const target = p.dest ?? p.abs;
      if (p.dest) ctx.checkpoints.capture(ctx.turn, p.dest);
      // A rename that changes only the letter case is one file on Windows and macOS: writing the new name and then
      // deleting the old one deleted the file itself, and the tool said it had succeeded (2026-11-06). It is renamed
      // first, then written, and nothing is deleted.
      const caseOnly = !!p.dest && p.dest !== p.abs && p.dest.toLowerCase() === p.abs.toLowerCase();
      const hadCoverage = !p.dest && p.before !== null && p.after !== null && ctx.files.hasCurrentCoverage(target);
      if (caseOnly) fs.renameSync(p.abs, target);
      const bytes = writeText(target, p.after ?? '', p.bom, p.encoding);
      if (!p.dest && p.before !== null && p.after !== null) {
        ctx.files.recordEdit(target, firstChangedLine(p.before.replace(/\r\n/g, '\n'), p.after.replace(/\r\n/g, '\n')), countLines(p.after), hadCoverage);
      } else {
        ctx.files.recordWrite(target);
      }
      if (p.dest && p.dest !== p.abs) {
        if (!caseOnly) fs.rmSync(p.abs, { force: true });
        ctx.files.forget(p.abs);
      }
      const targetShown = displayPath(ctx.cwd, target);
      const diff = makeDiff(shown, previous, bytes, p.op.type === 'add' ? 'add' : p.dest ? 'move' : 'update', p.dest ? targetShown : undefined);
      diffs.push(diff);
      summary.push(`${p.op.type === 'add' ? 'A' : 'M'} ${targetShown}`);
      const errs = await syntaxCheck(target, p.after ?? '');
      if (errs.length) diagnostics.push(formatDiagnostics(targetShown, errs).trim());
    }
    return {
      content: `Success. Updated the following files:\n${summary.join('\n')}${diagnostics.length ? `\n\n${diagnostics.join('\n\n')}` : ''}`,
      display: { kind: 'diff', files: diffs },
    };
  },
};
