import fs from 'node:fs';
import path from 'node:path';
import type { DiffFile } from '../types';
import { displayPath, resolvePath } from '../util/paths';
import { countLines, decodeFile, decodeOutput, detectEol, encode1252, encodeGbk, isProbablyBinary, numberLines, truncateEnd, type TextEncoding } from '../util/text';
import { applyReplace } from './replace';
import { applyChunks, parsePatch, PatchError, type PatchOp } from './patch';
import { checkRegion, imageSize, imageWorker } from './image';
import { formatDiagnostics, syntaxCheck } from './diagnostics';
import { makeDiff } from './diffutil';
import { outline } from './outline';
import { structuredPatch } from 'diff';
import { similarity } from './replace';
import { documentNote } from './outbound';
import { OFFICE_TYPES, officeText } from './office';
import type { ToolContext, ToolDef, ToolOutput } from './types';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_IMAGE = 5 * 1024 * 1024;
const DEFAULT_LIMIT = 2000;
/** Files longer than this, read without a range on Favilla's surface, come back as a start and a map. */
const OVERVIEW_OVER = 400;
const OVERVIEW_HEAD = 80;

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

export function readText(abs: string): { text: string; bom: boolean; encoding: TextEncoding } {
  const buf = fs.readFileSync(abs);
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { ...decodeFile(bom ? buf.subarray(3) : buf), bom };
}

/**
 * Written back as it was read: a GBK file stays GBK and a Windows-1252 file stays Windows-1252 (an edit used to
 * rewrite the whole file as UTF-8). A file whose encoding is not known cannot be written back byte for byte and is
 * not written at all: its characters would turn into U+FFFD.
 */
export function writeText(abs: string, text: string, bom: boolean, encoding: TextEncoding = 'utf8'): void {
  const why = unwritable(path.basename(abs), text, encoding);
  if (why) throw new EncodingError(why);
  const bytes = ASCII.test(text) ? Buffer.from(text, 'latin1') : encoding === 'gbk' ? encodeGbk(text)! : encoding === 'cp1252' ? encode1252(text)! : Buffer.from(text, 'utf8');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes);
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
    const abs = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, abs);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return err(`File not found: ${shown}.${suggest(abs, ctx.cwd)}`);
    }
    if (st.isDirectory()) {
      const entries = fs
        .readdirSync(abs, { withFileTypes: true })
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      const list = entries.slice(0, 300);
      return {
        content: `${shown} is a directory with ${entries.length} entries:\n${list.join('\n')}${entries.length > list.length ? `\n… ${entries.length - list.length} more` : ''}`,
        display: { kind: 'list', title: shown, items: list, total: entries.length },
      };
    }
    const ext = path.extname(abs).toLowerCase();
    if (IMAGE_TYPES[ext]) {
      if (!ctx.model.vision) return err(`${shown} is an image and the current model cannot view images.`);
      const buf = fs.readFileSync(abs);
      const size = imageSize(buf);
      ctx.files.recordRead(abs);
      const name = path.basename(abs);
      if (input.region) {
        // A part of the picture, enlarged: small text, edges and details a whole-image view scales away.
        if (!size) return err(`${shown}: its size could not be read, so no region can be taken from it.`);
        const r = checkRegion(input.region, size);
        if (typeof r === 'string') return err(`${shown}: ${r}.`);
        if (st.size > 40 * 1024 * 1024) return err(`${shown} is ${(st.size / 1048576).toFixed(0)} MB, too large to work on.`);
        let crop;
        try {
          crop = await imageWorker.crop(buf, IMAGE_TYPES[ext], r, 1600);
        } catch (e) {
          return err(`${shown}: ${(e as Error).message}.`);
        }
        return {
          content: `Region [${r.join(', ')}] of ${shown} (${size.width}×${size.height} in all), shown ${crop.scale >= 1 ? `enlarged ${+crop.scale.toFixed(2)}×` : `reduced to ${Math.round(crop.scale * 100)}%`} as ${crop.width}×${crop.height}.`,
          images: [{ type: 'image', mediaType: 'image/png', data: crop.data, name: `${name} [${r.join(', ')}]` }],
          display: { kind: 'file', path: shown, startLine: 1, lineCount: 0, totalLines: 0, preview: '', image: true, size: [size.width, size.height], region: r },
        };
      }
      if (st.size > MAX_IMAGE) return err(`${shown} is ${(st.size / 1048576).toFixed(1)} MB; images above 5 MB cannot be attached whole. Read parts of it with region, or resize it.`);
      const big = size && Math.max(size.width, size.height) > 1000;
      return {
        content: `Image ${shown} (${size ? `${size.width}×${size.height}, ` : ''}${Math.round(st.size / 1024)} KB) is attached.${big ? ' To look closer at a part, read it again with region: [x, y, width, height] in these pixels.' : ''}`,
        images: [{ type: 'image', mediaType: IMAGE_TYPES[ext], data: buf.toString('base64'), name }],
        display: { kind: 'file', path: shown, startLine: 1, lineCount: 0, totalLines: 0, preview: '', image: true, size: size ? [size.width, size.height] : undefined },
      };
    }
    if (ext === '.pdf') return readPdf(abs, shown, input, ctx);
    const buf = fs.readFileSync(abs);
    let text: string;
    let legacy = '';
    if (OFFICE_TYPES.has(ext)) {
      try {
        text = officeText(buf, ext);
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
    // A large file asked for whole: its start and where everything else is defined, so the reads that follow take
    // the ranges that matter instead of the whole file riding along in every later request.
    if (input.overview && input.offset === undefined && input.limit === undefined && total > OVERVIEW_OVER) {
      const rest = (outline(text, ext) ?? '').split('\n').filter((l) => Number(/^\s*(\d+)/.exec(l)?.[1] ?? 0) > OVERVIEW_HEAD);
      if (rest.length) {
        const head = lines.slice(0, OVERVIEW_HEAD);
        ctx.files.recordShown(abs, ctx.callId, 1, OVERVIEW_HEAD, total);
        return {
          content: `${numberLines(head, 1)}\n\n[Lines 1-${OVERVIEW_HEAD} of ${total}. The rest of the file defines, by line:]\n${rest.join('\n')}\n[Read the ranges you need; a range of the whole file reads it all.]`,
          display: { kind: 'file', path: shown, startLine: 1, lineCount: OVERVIEW_HEAD, totalLines: total, preview: head.slice(0, 80).join('\n') },
        };
      }
    }
    const start = Math.max(1, Math.floor(input.offset ?? 1));
    if (start > total) return err(`${shown} has only ${total} lines; offset ${start} is past the end.`);
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
    // The same lines, unchanged, already in the model's context: point there instead of paying for them twice.
    const want = Math.min(total, start - 1 + limit);
    const earlier = ctx.inContext && ctx.files.earlierRead(abs, start, want, ctx.inContext);
    if (earlier) {
      return {
        content: `${shown} lines ${start}-${want} have not changed since call ${earlier} showed them, and that output is still in your context above: work from it. (recall with call_id ${earlier} repeats it if you need it again.)`,
        display: { kind: 'file', path: shown, startLine: start, lineCount: 0, totalLines: total, preview: '' },
      };
    }
    let slice = lines.slice(start - 1, start - 1 + limit);
    let body = numberLines(slice, start);
    let note = '';
    if (body.length > ctx.outputChars) {
      const cut = truncateEnd(body, ctx.outputChars);
      // Whole lines only: a line cut in half must not count as read, or the next offset would skip the rest of it.
      const end = cut.text.endsWith('\n') ? cut.text.length : cut.text.lastIndexOf('\n') + 1;
      const whole = end > 0 ? cut.text.slice(0, end) : cut.text;
      const shownLines = countLines(whole);
      slice = slice.slice(0, shownLines);
      body = whole.trimEnd();
      note = `\n\n[Showing lines ${start}-${start + shownLines - 1} of ${total}; output limit reached. Continue with offset=${start + shownLines}.]`;
    } else if (start - 1 + slice.length < total) {
      note = `\n\n[Showing lines ${start}-${start + slice.length - 1} of ${total}. Use offset and limit to read further.]`;
    }
    ctx.files.recordShown(abs, ctx.callId, start, start + slice.length - 1, total);
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
  const first = Math.max(1, Math.floor(input.offset ?? 1));
  if (first > total) return err(`${shown} has only ${total} page${total === 1 ? '' : 's'}; offset ${first} is past the end.`);
  if (!pages.some((p) => p.trim())) {
    return err(`${shown} (${total} pages) has no text layer, so it is probably scanned. Render it to images or run OCR with a command to read it.`);
  }
  const last = Math.min(total, first - 1 + Math.max(1, Math.floor(input.limit ?? total)));
  const parts: string[] = [];
  let size = 0;
  let shownTo = first - 1;
  for (let n = first; n <= last; n++) {
    const part = `--- page ${n} of ${total} ---\n${pages[n - 1].trim()}`;
    if (parts.length && size + part.length > ctx.outputChars) break;
    parts.push(part.length > ctx.outputChars ? truncateEnd(part, ctx.outputChars).text : part);
    size += part.length;
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
    writeText(abs, content, before?.bom ?? false, before?.encoding);
    ctx.files.recordWrite(abs);
    const problems = await syntaxCheck(abs, content);
    return {
      content: `${existed ? 'Updated' : 'Created'} ${shown} (${countLines(content)} lines).${formatDiagnostics(shown, problems)}${documentNote(abs, content, ctx.checkpoints as object | undefined)}`,
      display: { kind: 'diff', files: [makeDiff(shown, before?.text ?? null, content, existed ? 'update' : 'add')] },
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

/** The changed regions of a file after several edits, numbered as the file now reads, with a little context. */
function changedRegions(before: string, after: string): string {
  const patch = structuredPatch('a', 'b', before, after, undefined, undefined, { context: 2 } as never) as { hunks: { newStart: number; newLines: number }[] } | undefined;
  const lines = after.split('\n');
  return (patch?.hunks ?? [])
    .slice(0, 6)
    .map((h) => numberLines(lines.slice(h.newStart - 1, h.newStart - 1 + h.newLines), h.newStart))
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
    const { text, bom, encoding } = readText(abs);
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
      for (const [i, e] of input.edits.entries()) {
        if (already(e.old, e.new, content)) continue;
        const r = applyReplace(content, e.old, e.new, !!e.all);
        if (!r.ok) {
          missed.push(`Edit ${i + 1} of ${input.edits.length}: ${r.error}`);
          continue;
        }
        content = r.content;
        applied++;
      }
      if (!applied) return missed.length ? err(`${missed.join('\n')}\nNothing was written.`) : { content: `${shown} already reads as these edits ask: nothing to change.` };
      ctx.checkpoints.capture(ctx.turn, abs);
      const out = eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
      writeText(abs, out, bom, encoding);
      ctx.files.recordWrite(abs);
      const problems = await syntaxCheck(abs, out);
      const head = missed.length ? `${missed.join('\n')}\nThe other ${applied} edit${applied === 1 ? ' was' : 's were'} written; send only the edit${missed.length === 1 ? '' : 's'} above again, corrected, against the file as it is now.\n\n` : '';
      return {
        content: `${head}The file ${shown} has been updated (${applied} edit${applied === 1 ? '' : 's'}). The changed regions now read:\n${changedRegions(lf, content)}${formatDiagnostics(shown, problems)}`,
        display: { kind: 'diff', files: [makeDiff(shown, text, out, 'update')] },
      };
    }
    if (already(input.old, input.new, lf)) return { content: `${shown} already reads that way: nothing to change.` };
    const result = applyReplace(lf, input.old, input.new, !!input.all);
    if (!result.ok) return err(result.error);
    ctx.checkpoints.capture(ctx.turn, abs);
    const out = eol === '\r\n' ? result.content.replace(/\n/g, '\r\n') : result.content;
    writeText(abs, out, bom, encoding);
    ctx.files.recordWrite(abs);
    const lines = result.content.split('\n');
    const snippets = result.ranges.slice(0, 3).map((r) => {
      const from = Math.max(1, r.start - 3);
      const to = Math.min(lines.length, r.end + 3);
      return numberLines(lines.slice(from - 1, to), from);
    });
    const more = result.ranges.length > 3 ? `\n… and ${result.ranges.length - 3} more replacements` : '';
    const how = result.strategy === 'exact' ? '' : ` (matched ignoring ${result.strategy === 'indentation' ? 'indentation, which was adjusted' : result.strategy === 'unescaped' ? 'escaping' : 'whitespace differences'})`;
    const problems = await syntaxCheck(abs, out);
    return {
      content: `The file ${shown} has been updated${how}. The edited region now reads:\n${snippets.join('\n…\n')}${more}${formatDiagnostics(shown, problems)}${documentNote(abs, out, ctx.checkpoints as object | undefined)}`,
      display: { kind: 'diff', files: [makeDiff(shown, text, out, 'update')] },
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
    const current = (abs: string) => state.get(abs) ?? (fs.existsSync(abs) ? readText(abs) : { text: null, bom: false, encoding: 'utf8' as const });
    for (const op of ops) {
      const abs = resolvePath(ctx.cwd, op.path);
      const shown = displayPath(ctx.cwd, abs);
      const refused = ctx.mayChange?.(abs) ?? (op.type === 'update' && op.moveTo ? ctx.mayChange?.(resolvePath(ctx.cwd, op.moveTo)) : null);
      if (refused) {
        problems.push(refused);
        continue;
      }
      try {
        const now = current(abs);
        if (op.type === 'add') {
          if (now.text) throw new PatchError(`${shown} already exists; use "*** Update File:" to change it.`);
          planned.push({ op, abs, before: now.text === null ? null : '', after: op.content, bom: false, encoding: 'utf8' });
          state.set(abs, { text: op.content, bom: false, encoding: 'utf8' });
        } else if (op.type === 'delete') {
          if (now.text === null) throw new PatchError(`Cannot delete ${shown}: file not found.`);
          planned.push({ op, abs, before: now.text, after: null, bom: false, encoding: now.encoding });
          state.set(abs, { text: null, bom: false, encoding: 'utf8' });
        } else {
          if (now.text === null) throw new PatchError(`Cannot update ${shown}: file not found.${suggest(abs, ctx.cwd)}`);
          const after = op.chunks.length ? applyChunks(now.text, op.chunks, shown) : now.text;
          // Checked before anything is written, so a patch never stops halfway on a file it cannot write back.
          const lost = unwritable(shown, after, now.encoding);
          if (lost) throw new PatchError(lost);
          const dest = op.moveTo ? resolvePath(ctx.cwd, op.moveTo) : undefined;
          planned.push({ op, abs, dest, before: now.text, after, bom: now.bom, encoding: now.encoding });
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
      if (p.op.type === 'delete') {
        fs.rmSync(p.abs, { force: true });
        ctx.files.forget(p.abs);
        summary.push(`D ${shown}`);
        diffs.push(makeDiff(shown, p.before, null, 'delete'));
        continue;
      }
      const target = p.dest ?? p.abs;
      if (p.dest) ctx.checkpoints.capture(ctx.turn, p.dest);
      // A rename that changes only the letter case is one file on Windows and macOS: writing the new name and then
      // deleting the old one deleted the file itself, and the tool said it had succeeded (2026-11-06). It is renamed
      // first, then written, and nothing is deleted.
      const caseOnly = !!p.dest && p.dest !== p.abs && p.dest.toLowerCase() === p.abs.toLowerCase();
      if (caseOnly) fs.renameSync(p.abs, target);
      writeText(target, p.after ?? '', p.bom, p.encoding);
      ctx.files.recordWrite(target);
      if (p.dest && p.dest !== p.abs) {
        if (!caseOnly) fs.rmSync(p.abs, { force: true });
        ctx.files.forget(p.abs);
      }
      const targetShown = displayPath(ctx.cwd, target);
      summary.push(`${p.op.type === 'add' ? 'A' : 'M'} ${targetShown}`);
      diffs.push(makeDiff(shown, p.before, p.after, p.op.type === 'add' ? 'add' : p.dest ? 'move' : 'update', p.dest ? targetShown : undefined));
      const errs = await syntaxCheck(target, p.after ?? '');
      if (errs.length) diagnostics.push(formatDiagnostics(targetShown, errs).trim());
    }
    return {
      content: `Success. Updated the following files:\n${summary.join('\n')}${diagnostics.length ? `\n\n${diagnostics.join('\n\n')}` : ''}`,
      display: { kind: 'diff', files: diffs },
    };
  },
};
