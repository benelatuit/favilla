const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Normalize terminal output for a model: no ANSI, carriage-return overwrites resolved. */
export function cleanTerminal(text: string): string {
  const noAnsi = stripAnsi(text).replace(/\r\n/g, '\n');
  if (!noAnsi.includes('\r')) return noAnsi;
  return noAnsi
    .split('\n')
    .map((line) => {
      const pieces = line.split('\r');
      return pieces.reduce((acc, piece) => (piece.length >= acc.length ? piece : piece + acc.slice(piece.length)), '');
    })
    .join('\n');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
let gbk: InstanceType<typeof TextDecoder> | null = null;

function decodeGbk(buf: Uint8Array): string {
  try {
    gbk ??= new TextDecoder('gbk');
    return gbk.decode(buf);
  } catch {
    return Buffer.from(buf).toString('utf8');
  }
}

/** The bytes without a UTF-8 character cut off at their end (output cut at a size limit, a chunk of a stream). */
function tornTail(buf: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const b = buf[buf.length - back];
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/**
 * Decode process output. Windows console tools often speak the ANSI code page (GBK on Chinese systems), and one
 * stray byte used to send the whole output through GBK, garbling every UTF-8 line in it ("✓ 通过" became "鉁� 閫氳繃").
 * Each line is decoded on its own: UTF-8 where it is, GBK only for the lines that are not.
 */
export function decodeOutput(buf: Buffer): string {
  try {
    return utf8.decode(buf);
  } catch {
    /* per line below */
  }
  const cut = tornTail(buf);
  const body = cut ? buf.subarray(0, buf.length - cut) : buf;
  const out: (string | Uint8Array)[] = [];
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i < body.length && body[i] !== 0x0a) continue;
    const line = body.subarray(start, i);
    try {
      out.push(utf8.decode(line));
    } catch {
      out.push(line);
    }
    start = i + 1;
  }
  // One answer for all the lines that are not UTF-8: a German line with "süß" alone in it reads as GBK by itself
  // (132 of 2326 lines of eight Western texts did), and the lines around it say what it is.
  const western = oneByteText(out.filter((l): l is Uint8Array => typeof l !== 'string'));
  return out.map((l) => (typeof l === 'string' ? l : western ? decode1252(l) : decodeGbk(l))).join('\n');
}

/**
 * Output decoded as it streams in. A character split between two chunks came out as two broken ones: the bytes of a
 * character cut off at a chunk's end wait for the next chunk. Everything else goes through at once (a prompt waiting
 * for input has no newline after it).
 */
export class OutputDecoder {
  private rest: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string {
    const all = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const keep = tornTail(all);
    this.rest = keep ? Buffer.from(all.subarray(all.length - keep)) : Buffer.alloc(0);
    return decodeOutput(keep ? all.subarray(0, all.length - keep) : all);
  }

  end(): string {
    const last = this.rest;
    this.rest = Buffer.alloc(0);
    return last.length ? decodeOutput(last) : '';
  }
}

let gbkCodes: Map<number, number> | null = null;

/** Text as GBK bytes, or null when a character has no GBK code. Built from the platform's GBK decoder. */
export function encodeGbk(text: string): Buffer | null {
  if (!gbkCodes) {
    const dec = new TextDecoder('gbk');
    const codes = new Map<number, number>();
    const pair = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail === 0x7f) continue;
        pair[0] = lead;
        pair[1] = trail;
        const s = dec.decode(pair);
        const cp = s.codePointAt(0)!;
        if (s.length === 1 && s !== '�' && !codes.has(cp)) codes.set(cp, (lead << 8) | trail);
      }
    }
    gbkCodes = codes;
  }
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp === 0x20ac) out.push(0x80);
    else {
      const code = gbkCodes.get(cp);
      if (code === undefined) return null;
      out.push(code >> 8, code & 0xff);
    }
  }
  return Buffer.from(out);
}

// Windows-1252 is Latin-1 with these 27 characters at 0x80-0x9f; the five bytes it leaves undefined keep their own
// code, so every byte is one character and every text read turns back into the bytes it came from.
const CP1252_HIGH = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
let cp1252Codes: Map<number, number> | null = null;

function decode1252(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i < buf.length; i += 8192) {
    const part = buf.subarray(i, i + 8192);
    const codes = new Array<number>(part.length);
    for (let k = 0; k < part.length; k++) codes[k] = part[k] >= 0x80 && part[k] < 0xa0 ? CP1252_HIGH[part[k] - 0x80] : part[k];
    out += String.fromCharCode(...codes);
  }
  return out;
}

/** Text as Windows-1252 bytes, or null when a character has no byte there. */
export function encode1252(text: string): Buffer | null {
  cp1252Codes ??= new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i] as [number, number]));
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    const byte = cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : cp1252Codes.get(cp);
    if (byte === undefined) return null;
    out[i] = byte;
  }
  return out;
}

/**
 * Whether bytes that are not UTF-8 read as text of one byte per character (Windows-1252: German, French, Spanish and
 * the like) rather than as GBK. Such a file used to be read as GBK: "über" came out as a Chinese character, a search
 * hit showed mojibake, and where the bytes happened to pair up as valid GBK an edit wrote new text into the file in
 * GBK. In Western text a byte above ASCII stands alone inside a word; in GBK and every other multi-byte encoding,
 * and in one-byte Cyrillic or Greek, such bytes come in runs. Alone-standing bytes must outweigh the runs, and none
 * may be a byte Windows-1252 leaves undefined.
 */
export function oneByteText(bufs: Uint8Array | Uint8Array[]): boolean {
  let alone = 0;
  let inRuns = 0;
  for (const buf of Array.isArray(bufs) ? bufs : [bufs]) {
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] < 0x80) continue;
      let end = i;
      while (end < buf.length && buf[end] >= 0x80) {
        if (CP1252_UNDEFINED.has(buf[end])) return false;
        end++;
      }
      if (end - i === 1) alone++;
      else inRuns += end - i;
      i = end - 1;
    }
  }
  return alone * 2 > inRuns;
}

export type TextEncoding = 'utf8' | 'gbk' | 'cp1252' | 'unknown';

/**
 * A file's text and what it is written in. Windows-1252 when its bytes read as Western one-byte text; GBK only when
 * the text turns back into exactly the same bytes.
 */
export function decodeFile(buf: Buffer): { text: string; encoding: TextEncoding } {
  try {
    return { text: utf8.decode(buf), encoding: 'utf8' };
  } catch {
    if (oneByteText(buf)) return { text: decode1252(buf), encoding: 'cp1252' };
    const text = decodeGbk(buf);
    const back = encodeGbk(text);
    return { text, encoding: back && back.equals(buf) ? 'gbk' : 'unknown' };
  }
}

export interface Truncated {
  text: string;
  truncated: boolean;
  omittedLines: number;
  omittedChars: number;
}

/** Keep the head and the tail of long text; the tail usually holds the error. */
export function truncateMiddle(text: string, maxChars: number, headShare = 0.35): Truncated {
  if (text.length <= maxChars) return { text, truncated: false, omittedLines: 0, omittedChars: 0 };
  const headChars = Math.floor(maxChars * headShare);
  const tailChars = maxChars - headChars;
  let head = text.slice(0, headChars);
  let tail = text.slice(text.length - tailChars);
  const headCut = head.lastIndexOf('\n');
  if (headCut > headChars * 0.6) head = head.slice(0, headCut + 1);
  const tailCut = tail.indexOf('\n');
  if (tailCut >= 0 && tailCut < tailChars * 0.4) tail = tail.slice(tailCut + 1);
  const middle = text.slice(head.length, text.length - tail.length);
  const omittedLines = countLines(middle);
  return {
    text: `${head}\n[… ${omittedLines} lines (${middle.length} chars) omitted …]\n${tail}`,
    truncated: true,
    omittedLines,
    omittedChars: middle.length,
  };
}

export function truncateEnd(text: string, maxChars: number): Truncated {
  if (text.length <= maxChars) return { text, truncated: false, omittedLines: 0, omittedChars: 0 };
  let head = text.slice(0, maxChars);
  const cut = head.lastIndexOf('\n');
  if (cut > maxChars * 0.7) head = head.slice(0, cut + 1);
  const rest = text.slice(head.length);
  return { text: head, truncated: true, omittedLines: countLines(rest), omittedChars: rest.length };
}

export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

/** `cat -n` layout: right-aligned line number, a tab, the line. */
export function numberLines(lines: string[], startLine: number, maxLineChars = 2000): string {
  return lines
    .map((line, i) => {
      const shown = line.length > maxLineChars ? `${line.slice(0, maxLineChars)}… [line truncated, ${line.length} chars]` : line;
      return `${String(startLine + i).padStart(6, ' ')}\t${shown}`;
    })
    .join('\n');
}

export function detectEol(text: string): '\r\n' | '\n' {
  const crlf = text.indexOf('\r\n');
  if (crlf === -1) return '\n';
  const lf = text.indexOf('\n');
  return lf === crlf + 1 ? '\r\n' : '\n';
}

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function isProbablyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 7 || (c > 13 && c < 32)) suspicious++;
  }
  return len > 0 && suspicious / len > 0.1;
}
