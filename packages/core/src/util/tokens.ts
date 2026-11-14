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

const IMAGE_TOKENS = 1100;

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
    case 'reasoning':
      return part.text.length * 2 + (part.encrypted?.length ?? 0);
    case 'tool_call':
      return part.raw?.length ?? -1;
    case 'tool_result':
      return part.content.length * 4 + (part.images?.length ?? 0) * 2 + (part.pruned ? 1 : 0);
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
      return IMAGE_TOKENS;
    case 'reasoning':
      return estimateTokens(part.text) + (part.encrypted ? Math.ceil(part.encrypted.length / 6) : 0);
    case 'tool_call':
      return estimateTokens(part.raw ?? JSON.stringify(part.input)) + 12;
    case 'tool_result':
      return estimateTokens(part.content) + (part.images?.length ?? 0) * IMAGE_TOKENS + 8;
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
