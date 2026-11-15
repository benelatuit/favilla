import type { ImagePart, Message, Part, TextPart, ToolCallPart, ToolDisplay, ToolResultPart } from '../types';
import type { BlobStore } from './blobs';
import { imageHeaderSize } from '../util/tokens';

/** Longer tool results (and their UI views) than this leave memory once they fall before the active context. */
const RELEASE_AT = 2000;
const BACKGROUND_COMPRESS_AT = 256 * 1024;
/** How much of a long tool result the UI gets up front; the rest comes when the user opens it. */
export const PREVIEW_CHARS = 4000;
/** How much of a terminal's raw output, and of a patch, the UI gets up front. */
const TERMINAL_TAIL = 2000;
const PATCH_HEAD = 8000;
/** Longer strings in a tool call's input are clipped in the UI's view (the change itself shows as a diff). */
const INPUT_CHARS = 400;

function images(p: Part): ImagePart[] {
  if (p.type === 'image') return [p];
  if (p.type === 'tool_result') return p.images ?? [];
  return [];
}

/** The input a tool call's raw text spells out, when it has one (custom tools take the text as it is). */
function inputFromRaw(p: ToolCallPart): Record<string, unknown> | undefined {
  if (p.raw === undefined) return undefined;
  if (p.custom) return { input: p.raw };
  try {
    const v = JSON.parse(p.raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The copy of a message that goes to disk: images move to the blob store (once per content) and the
 * line keeps their ids; the message in memory gets the ids too, so nothing is stored twice. A tool call
 * whose input is exactly what its raw text says keeps only the text, which is kept for exact replay.
 */
export function forDisk(m: Message, blobs: BlobStore): Message {
  let changed = false;
  for (const p of m.parts) {
    for (const img of images(p)) {
      if (img.data && (!img.blob || !img.width || !img.height)) {
        const buf = Buffer.from(img.data, 'base64');
        if (!img.width || !img.height) {
          const sz = imageHeaderSize(buf);
          if (sz) {
            img.width = sz.width;
            img.height = sz.height;
          }
        }
        if (!img.blob) img.blob = blobs.put(buf, false);
      }
      if (img.blob && img.data) changed = true;
    }
    if (p.type === 'tool_call' && p.input && sameJson(inputFromRaw(p), p.input)) changed = true;
  }
  if (!changed) return m;
  const strip = (img: ImagePart): ImagePart => (img.blob ? { ...img, data: '' } : img);
  return {
    ...m,
    parts: m.parts.map((p): Part => {
      if (p.type === 'image') return strip(p);
      if (p.type === 'tool_result' && p.images) return { ...p, images: p.images.map(strip) };
      if (p.type === 'tool_call' && p.input && sameJson(inputFromRaw(p), p.input)) {
        const { input: _, ...rest } = p;
        return rest as ToolCallPart;
      }
      return p;
    }),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** A message as read from disk: tool-call input parsed back from the raw text where only that was kept. */
export function fromDisk(m: Message): Message {
  for (const p of m.parts) if (p.type === 'tool_call' && !p.input) p.input = inputFromRaw(p) ?? {};
  return m;
}

/** Load images back from the blob store (messages the model will see again, or all of them when editing in the UI). */
export function withImages(m: Message, blobs: BlobStore, includeStripped = false): Message {
  for (const p of m.parts) {
    // Pruned output keeps its images out of the context.
    if (p.type === 'tool_result' && p.pruned && !includeStripped) continue;
    for (const img of images(p)) {
      if (img.stripped && !includeStripped) continue;
      if (!img.data && img.blob) img.data = blobs.get(img.blob)?.toString('base64') ?? '';
    }
  }
  return m;
}

/**
 * A session file rewritten for cold storage, line by line and in order. Messages before the active context
 * (which no provider will see again) are released: long outputs and large views go to the blob store, the
 * only copy from then on, and replay-only reasoning data is dropped. Every message gets its disk form. Lines
 * that do not parse are kept as they are; `released` lines go, since the message lines name those blobs now.
 */
export async function repack(text: string, blobs: BlobStore): Promise<string> {
  const lines = text.split('\n').filter((l) => l.trim());
  let active = 0;
  for (const l of lines) {
    if (!l.startsWith('{"t":"compact"')) continue;
    try {
      active = JSON.parse(l).start;
    } catch {
      /* keep the earlier start */
    }
  }
  let index = 0;
  const out: string[] = [];
  for (const l of lines) {
    let line: { t?: string; m?: Message; messages?: number };
    try {
      line = JSON.parse(l);
    } catch {
      out.push(l);
      continue;
    }
    if (line.t === 'released') continue;
    // A branch's own messages come after the ones it reads from its source.
    if (line.t === 'base') index = line.messages ?? 0;
    if (line.t !== 'msg' || !line.m) {
      out.push(l);
      continue;
    }
    const m = fromDisk(line.m);
    if (index++ < active) {
      const work = releaseTexts(m, blobs);
      let next = work.next();
      while (!next.done) {
        const data = next.value;
        const id = data.length >= BACKGROUND_COMPRESS_AT ? await blobs.putLargeText(data) : blobs.put(data);
        next = work.next(id);
      }
    }
    out.push(JSON.stringify({ ...line, m: forDisk(m, blobs) }));
  }
  return `${out.join('\n')}\n`;
}

/**
 * Free the memory of a message that is no longer in the model's context (before the latest compaction):
 * long tool results and images stay on disk only, and replay-only data (signatures, encrypted reasoning)
 * is dropped. The UI still shows such messages through previews.
 */
export function release(m: Message, blobs: BlobStore): void {
  const work = releaseTexts(m, blobs);
  let next = work.next();
  while (!next.done) next = work.next(blobs.put(next.value));
}

// Keep the publication order identical when a background pack can yield to compress its larger text blobs.
function* releaseTexts(m: Message, blobs: BlobStore): Generator<string, void, string> {
  for (const p of m.parts) {
    if (p.type === 'text') {
      if (p.textBlob && p.text.length > PREVIEW_CHARS) p.text = `${p.text.slice(0, PREVIEW_CHARS)}…`;
      if (p.saidBlob && p.said && p.said.length > PREVIEW_CHARS) p.said = `${p.said.slice(0, PREVIEW_CHARS)}…`;
    }
    if (p.type === 'tool_result') {
      if (p.content.length > RELEASE_AT) {
        p.contentBlob ??= yield p.content;
        p.content = '';
      }
      if (p.display) {
        const json = JSON.stringify(p.display);
        if (json.length > RELEASE_AT) {
          p.displayBlob = yield json;
          delete p.display;
        }
      }
    }
    for (const img of images(p)) {
      if (img.data) img.blob ??= blobs.put(Buffer.from(img.data, 'base64'), false);
      img.data = '';
    }
    if (p.type === 'reasoning') {
      delete p.signature;
      delete p.encrypted;
      delete p.redacted;
      delete p.details;
    }
  }
}

/** Blob ids a message holds in memory, so the files they name are kept while it is around. */
export function blobRefs(m: Message): string[] {
  const ids: string[] = [];
  for (const p of m.parts) {
    if (p.type === 'text') {
      if (p.textBlob) ids.push(p.textBlob);
      if (p.saidBlob) ids.push(p.saidBlob);
    }
    if (p.type === 'tool_result') {
      if (p.contentBlob) ids.push(p.contentBlob);
      if (p.displayBlob) ids.push(p.displayBlob);
    }
    for (const img of images(p)) if (img.blob) ids.push(img.blob);
  }
  return ids;
}

/** A text part's full unclipped text when an oversized inbound message stored its full body in `textBlob`. */
export function fullText(p: TextPart, blobs?: BlobStore): string {
  if (p.textBlob && blobs) return blobs.text(p.textBlob) ?? p.text;
  return p.text;
}

/** A mid-turn note's full unclipped `said` text when `saidBlob` holds the original words. */
export function fullSaid(p: TextPart, blobs?: BlobStore): string | undefined {
  if (p.said === undefined) return undefined;
  if (p.saidBlob && blobs) return blobs.text(p.saidBlob) ?? p.said;
  return p.said;
}

/** A tool result's full content, wherever it is kept. */
export function fullContent(p: ToolResultPart, blobs: BlobStore): string {
  if (p.pruned && p.contentBlob) return blobs.text(p.contentBlob) ?? p.content;
  return p.content || (p.contentBlob ? (blobs.text(p.contentBlob) ?? '') : '');
}

export function parseDisplay(text: string | null): ToolDisplay | undefined {
  try {
    return JSON.parse(text ?? 'null') ?? undefined;
  } catch {
    return undefined;
  }
}

function displayOf(p: ToolResultPart, blobs: BlobStore): ToolDisplay | undefined {
  return p.display || !p.displayBlob ? p.display : parseDisplay(blobs.text(p.displayBlob));
}

/** A tool result's full UI view, wherever it is kept. */
export function fullDisplay(p: ToolResultPart, blobs: BlobStore): ToolDisplay | undefined {
  return displayOf(p, blobs);
}

/** The end of a long terminal and the start of a long patch are what the UI gets first. */
function lightDisplay(d: ToolDisplay | undefined): ToolDisplay | undefined {
  if (d?.kind === 'terminal' && d.output.length > TERMINAL_TAIL) {
    const cut = d.output.indexOf('\n', d.output.length - TERMINAL_TAIL);
    return { ...d, output: d.output.slice(cut >= 0 ? cut + 1 : -TERMINAL_TAIL), clipped: true };
  }
  if (d?.kind === 'diff' && d.files.some((f) => f.patch.length > PATCH_HEAD)) {
    const head = (patch: string) => (patch.length > PATCH_HEAD ? patch.slice(0, Math.max(patch.lastIndexOf('\n', PATCH_HEAD), 0)) : patch);
    return { ...d, files: d.files.map((f) => ({ ...f, patch: head(f.patch) })), clipped: true };
  }
  return d;
}

/** Results whose view replaces their text in the UI: the text is fetched only if asked for. */
function shownByDisplay(p: ToolResultPart, d: ToolDisplay | undefined): boolean {
  if (!d) return false;
  if (d.kind === 'terminal') return true;
  return !p.isError && (d.kind === 'diff' || (d.kind === 'file' && !d.image) || d.kind === 'list' || d.kind === 'todo');
}

/** A tool call as the UI gets it: enough of the input for its title (paths, commands); long text clipped. */
function lightCall(p: ToolCallPart): ToolCallPart {
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.input ?? {})) {
    if (typeof v !== 'string' || v.length <= INPUT_CHARS) input[k] = v;
    // A patch keeps its file headers, which name what it changes.
    else if (/^\*\*\* Begin Patch/.test(v)) input[k] = v.split('\n').filter((l) => /^\*\*\* /.test(l)).join('\n');
    else input[k] = `${v.slice(0, INPUT_CHARS)}…`;
  }
  const { raw: _, ...rest } = p;
  return { ...rest, input };
}

/** Where the UI fetches a blob (an image, a full tool result). */
export type BlobUrl = (id: string) => string;

function lightImage(img: ImagePart, blobs: BlobStore, blobUrl: BlobUrl): ImagePart {
  const blob = img.blob ?? (img.data ? blobs.put(Buffer.from(img.data, 'base64'), false) : undefined);
  if (blob) img.blob = blob;
  return { type: 'image', mediaType: img.mediaType, name: img.name, data: '', blob, url: blob ? blobUrl(blob) : undefined };
}

const previewContent = (text: string) => text.slice(0, PREVIEW_CHARS + 1);
const previewDisplay = (text: string) => {
  const display = lightDisplay(parseDisplay(text));
  return display === undefined ? undefined : JSON.stringify(display);
};

/**
 * A tool result as the UI gets it: a preview of long output, nothing of output its view already shows,
 * views clipped, images as links. The rest comes from the result route when the user opens it.
 */
export function lightResult(p: ToolResultPart, blobs: BlobStore, blobUrl: BlobUrl): ToolResultPart {
  const display = p.display || !p.displayBlob
    ? lightDisplay(p.display)
    : parseDisplay(blobs.previewText(p.displayBlob, previewDisplay));
  let content = '';
  if (!shownByDisplay(p, display)) {
    content = p.content || '';
    if (p.contentBlob && (p.pruned || !content)) content = blobs.previewText(p.contentBlob, previewContent) ?? content;
  }
  const long = content.length > PREVIEW_CHARS;
  return {
    ...p,
    content: long ? content.slice(0, PREVIEW_CHARS) : content,
    truncated: long || undefined,
    contentBlob: undefined,
    display,
    displayBlob: undefined,
    images: p.images?.map((img) => lightImage(img, blobs, blobUrl)),
  };
}

/**
 * The view of a message the UI gets: images as links to the blob store instead of data, long tool results
 * as previews, and nothing that only matters when replaying to a provider (signatures, encrypted reasoning).
 */
export function lighten(m: Message, blobs: BlobStore, blobUrl: BlobUrl): Message {
  return {
    ...m,
    parts: m.parts.map((p): Part => {
      switch (p.type) {
        case 'image':
          return lightImage(p, blobs, blobUrl);
        case 'tool_result':
          return lightResult(p, blobs, blobUrl);
        case 'tool_call':
          return lightCall(p);
        case 'reasoning':
          return { type: 'reasoning', text: p.text, provider: p.provider, model: p.model };
        case 'opaque': {
          // Only what the UI shows of a provider's own tool calls (the query, the page).
          const d = (p.data ?? {}) as { action?: unknown; name?: unknown; input?: unknown; type?: unknown };
          return { ...p, data: { type: d.type, action: d.action, name: d.name, input: d.input } };
        }
        case 'text':
          return p.textBlob || p.saidBlob ? { ...p, textBlob: undefined, saidBlob: undefined } : p;
        default:
          return p;
      }
    }),
  };
}
