import type { Message, Part } from '../types';

const NON_ASCII = /[^\x00-\x7f]/;

/**
 * Fast token estimate. Code and English average close to 3.7 characters per token across
 * current tokenizers; CJK characters cost roughly one token each. Provider-reported usage
 * re-anchors the estimate after every request (see Calibrator), so this only has to be
 * good for the slice of text added since the last response.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Most of what is counted (code, logs, outputs) is ASCII: one native scan settles it. Counting it character by
  // character in a process just started held the desktop engine 432 ms on opening a 300-step session.
  if (!NON_ASCII.test(text)) return Math.ceil(text.length / 3.7);
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) ascii++;
    else if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
    else other++;
  }
  return Math.ceil(ascii / 3.7 + cjk * 1.05 + other / 2);
}

/**
 * Structure-aware token estimate for inbound user pastes, telemetry tables, and transcripts before `Calibrator`
 * has anchored on the current turn (e.g. Turn 1 or `--resume`). Pipe/backtick/delimiter-heavy tables and
 * digit-heavy IDs tokenize near ~2.1 chars/token on BPE rather than prose's 3.7 chars/token.
 */
export function estimateInboundTokens(text: string): number {
  if (!text) return 0;
  let alpha = 0;
  let ws = 0;
  let digits = 0;
  let sym = 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) alpha++;
    else if (c === 32 || c === 10 || c === 13 || c === 9) ws++;
    else if (c >= 48 && c <= 57) digits++;
    else if (c < 128) sym++;
    else if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
    else other++;
  }
  const base = text.length / 3.7;
  const dense = (alpha + ws * 0.65) / 3.7 + digits * 0.68 + sym * 1.05 + cjk * 1.05 + other * 0.6;
  return Math.ceil(Math.max(base, dense));
}

export const IMAGE_TOKENS = 1100;

/** Width and height from an image's header: PNG, JPEG, GIF, WebP and BMP. */
export function imageHeaderSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM') return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: walk the segments to the frame header (SOF0-SOF15 except DHT, JPG and DAC).
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

function sizeFromBase64(data: string): { width: number; height: number } | null {
  if (!data) return null;
  const head = Buffer.from(data.slice(0, 512), 'base64');
  const fast = imageHeaderSize(head);
  if (fast || head.length < 2 || head[0] !== 0xff || head[1] !== 0xd8 || data.length <= 512) return fast;
  // A JPEG with an EXIF segment before SOF: inspect up to the first 48 KB.
  return imageHeaderSize(Buffer.from(data.slice(0, 65536), 'base64'));
}

/**
 * Vision token estimate from pixel dimensions (512px tiles inside a 2048px box, ~170 tokens a tile + 85 base),
 * falling back to IMAGE_TOKENS when dimensions cannot be read. Stripped images (`data === ''`) cost 0.
 */
export function estimateImageTokens(img: { width?: number; height?: number; data?: string }): number {
  if (img.data === '') return 0;
  let w = img.width ?? 0;
  let h = img.height ?? 0;
  if ((w <= 0 || h <= 0) && img.data) {
    const parsed = sizeFromBase64(img.data);
    if (parsed) {
      w = parsed.width;
      h = parsed.height;
    }
  }
  if (w <= 0 || h <= 0) return IMAGE_TOKENS;
  const scale = Math.min(1, 2048 / Math.max(w, h));
  const tiles = Math.ceil((w * scale) / 512) * Math.ceil((h * scale) / 512);
  return Math.max(170, Math.min(4000, tiles * 170 + 85));
}

/**
 * Each part's estimate, kept. Every request counts the whole conversation again, and a long one (300 steps of
 * DeepSeek's reasoning) spent 9.5 s of a 42 s turn on the main thread counting the same text, most of the app's lag
 * there (2026-11-04). A part can change in place (a pruned output becomes its stub, a caption joins it), so the
 * estimate is kept with the size it was made from and made again when that changes.
 */
const kept = new WeakMap<Part, { size: number; tokens: number }>();

function sizeOf(part: Part): number {
  switch (part.type) {
    case 'text':
      return part.text.length;
    case 'image':
      return (part.data?.length ?? 0) * 8 + (part.width ?? 0) * 3 + (part.height ?? 0);
    case 'reasoning':
      return part.text.length * 2 + (part.encrypted?.length ?? 0);
    case 'tool_call':
      return part.raw?.length ?? -1;
    case 'tool_result': {
      let imgSig = 0;
      for (const img of part.images ?? []) imgSig = imgSig * 31 + (img.data ? img.data.length + (img.width ?? 0) + (img.height ?? 0) : 0);
      return part.content.length * 4 + imgSig * 2 + (part.pruned ? 1 : 0);
    }
    default:
      return -2;
  }
}

export function estimatePartTokens(part: Part): number {
  const size = sizeOf(part);
  const known = kept.get(part);
  if (known && known.size === size) return known.tokens;
  const tokens = countPart(part);
  kept.set(part, { size, tokens });
  return tokens;
}

function countPart(part: Part): number {
  switch (part.type) {
    case 'text':
      return estimateTokens(part.text);
    case 'image':
      return estimateImageTokens(part);
    case 'reasoning':
      return estimateTokens(part.text) + (part.encrypted ? Math.ceil(part.encrypted.length / 6) : 0);
    case 'tool_call':
      return estimateTokens(part.raw ?? JSON.stringify(part.input)) + 12;
    case 'tool_result': {
      let imgTokens = 0;
      for (const img of part.images ?? []) if (img.data) imgTokens += estimateImageTokens(img);
      return estimateTokens(part.content) + imgTokens + 8;
    }
    case 'opaque':
      return estimateTokens(JSON.stringify(part.data ?? '')) / 2;
  }
}

export function estimateMessageTokens(message: Message): number {
  let n = 4;
  for (const part of message.parts) n += estimatePartTokens(part);
  return n;
}

/** Keeps estimates honest by comparing them with what providers report. */
export class Calibrator {
  private ratio = 1;
  private samples = 0;

  observe(estimated: number, actual: number): void {
    if (estimated < 500 || actual <= 0) return;
    const r = Math.min(3, Math.max(0.4, actual / estimated));
    this.samples++;
    const weight = this.samples < 4 ? 0.5 : 0.25;
    this.ratio = this.ratio * (1 - weight) + r * weight;
  }

  adjust(estimate: number): number {
    return Math.ceil(estimate * this.ratio);
  }

  get factor(): number {
    return this.ratio;
  }
}
