import type { Message, ToolCallPart, ToolResultPart } from '../types';

/**
 * Pictures in a long session. Every picture keeps its words in the history (the result's text: what was looked at
 * and what it showed) and its data in the blob store; what the next request carries is decided here.
 *
 * - One picture per view: a page at one width, one file, one canvas. An older picture of the same view was looked at
 *   and acted on, and goes once a newer one of that view is in, if it is recent; an older one waits for the next
 *   batch, so that a provider's prompt cache breaks near the end, not far back.
 * - At most `slots` pictures in all, the newest kept. Past that the oldest go together, down to 60% of the slots:
 *   the cache breaks once for a batch, not at every step.
 * - The last round's pictures, the ones the model is looking at now, stay; pictures the user sent are not tool
 *   results and are not touched here. recall brings a picture back as a new result, the newest of all.
 *
 * Measured in GUI agents in 2026: consecutive screenshots are mostly the same (REVISION, arXiv 2605.11212), and a
 * fixed budget of pictures over a text record of every step beats both the record alone and the newest pictures
 * alone (CausalCache, arXiv 2608.22577).
 */

export interface ImageDrop {
  callId: string;
  /** The line the result keeps in place of its pictures. */
  caption: string;
}

/** Rounds within which a picture superseded by a newer one of its view goes at once. */
const RECENT_ROUNDS = 6;

/** The view a picture-taking call shows: the same view twice means the later picture replaces the earlier. */
export function viewOf(call: ToolCallPart | undefined): string {
  if (!call) return 'unknown';
  const i = (call.input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === 'string' || typeof i[k] === 'number' ? String(i[k]) : '');
  if (/^(browser|Screenshot|screenshot)$/.test(call.name)) return `page ${s('url') || 'current'} ${s('width')}x${s('height')}${i.full_page || i.fullPage ? ' full' : ''}`.trim();
  if (/^(read|read_file|Read|view_image)$/.test(call.name)) {
    // Favilla's read takes `paths` (with ranges and regions in them): keyed by path alone, every read was one view, and
    // a second picture dropped the first, so a render could not be set beside its reference.
    const paths = Array.isArray(i.paths) ? (i.paths as unknown[]).map(String) : [s('path') || s('file_path')];
    const region = i.region === undefined ? '' : ` ${JSON.stringify(i.region)}`;
    return `file ${paths.map((p) => p.replace(/\\/g, '/')).join(' ')}${region}`;
  }
  if (call.name === 'paint') return `canvas ${s('canvas') || s('path') || s('out')}`;
  return `${call.name} ${s('path') || s('url')}`.trim();
}

/** Slots for pictures in a context window: about 15% of it at some 1,600 tokens a picture, between 4 and 8. */
export function imageSlots(window: number): number {
  return Math.max(4, Math.min(8, Math.floor((window * 0.15) / 1600)));
}

/** Which tool results of `messages[from..]` let their pictures go now. */
export function planImages(messages: Message[], from: number, slots: number): ImageDrop[] {
  const calls = new Map<string, ToolCallPart>();
  for (let i = from; i < messages.length; i++) for (const p of messages[i].parts) if (p.type === 'tool_call') calls.set(p.id, p);
  const rounds: number[] = [];
  for (let i = from; i < messages.length; i++) if (messages[i].parts.some((p) => p.type === 'tool_result')) rounds.push(i);
  const last = rounds.at(-1) ?? messages.length;
  const recentFrom = rounds[Math.max(0, rounds.length - RECENT_ROUNDS)] ?? from;
  // Results that still carry picture data, oldest first.
  const held: { index: number; part: ToolResultPart; view: string; count: number }[] = [];
  for (let i = from; i < messages.length; i++) {
    for (const p of messages[i].parts) {
      if (p.type !== 'tool_result') continue;
      const count = (p.images ?? []).filter((img) => img.data).length;
      if (count) held.push({ index: i, part: p, view: viewOf(calls.get(p.callId)), count });
    }
  }
  const drops = new Map<string, ImageDrop>();
  const caption = (h: (typeof held)[number], why: string) => ({ callId: h.part.callId, caption: `[${h.count} picture${h.count === 1 ? '' : 's'} of ${h.view} let go to save context (${why}); the text above is what was seen, and recall with call_id ${h.part.callId} brings ${h.count === 1 ? 'it' : 'them'} back.]` });
  const newest = new Map<string, number>();
  for (const h of held) newest.set(h.view, h.index);
  for (const h of held) {
    if (h.index >= last || h.index >= (newest.get(h.view) ?? -1)) continue;
    if (h.index >= recentFrom) drops.set(h.part.callId, caption(h, 'a newer picture of the same view came after it'));
  }
  let count = held.filter((h) => !drops.has(h.part.callId)).reduce((n, h) => n + h.count, 0);
  if (count > slots) {
    const floor = Math.floor(slots * 0.6);
    for (const h of held) {
      if (count <= floor || h.index >= last) break;
      if (drops.has(h.part.callId)) continue;
      drops.set(h.part.callId, caption(h, 'older than the pictures kept'));
      count -= h.count;
    }
  }
  return [...drops.values()];
}

/**
 * Picture data a request may carry, in base64 characters, when the provider has not refused less: a guard for a
 * history that collected many pictures (the user's own are never let go by `planImages`), not a policy.
 */
export const PICTURE_BYTES = 8_000_000;

/** Below this a body refused for its size is not the pictures' doing: the conversation is compacted instead. */
export const PICTURE_FLOOR = 400_000;

/**
 * What each provider took no more than, learned from a body it refused for its size (HTTP 413), for every session of
 * this process: a relay in front of a hosted model turned away a session that had taken many screenshots (2026-11-05).
 */
const learned = new Map<string, number>();

export function pictureBudget(provider: string): number {
  return learned.get(provider) ?? PICTURE_BYTES;
}

/** A body with `carried` picture data was refused: carry at most half of it from now on, down to the floor. */
export function learnPictureBudget(provider: string, carried: number): number {
  const next = Math.max(PICTURE_FLOOR, Math.floor(Math.min(pictureBudget(provider), carried) / 2));
  learned.set(provider, next);
  return next;
}

/** Picture data in these messages, in base64 characters. */
export function pictureBytes(messages: Message[]): number {
  let n = 0;
  for (const m of messages)
    for (const p of m.parts) {
      if (p.type === 'image') n += p.data?.length ?? 0;
      else if (p.type === 'tool_result') for (const img of p.images ?? []) n += img.data?.length ?? 0;
    }
  return n;
}

/**
 * The messages as a request carries them under `budget` of picture data: the oldest pictures stay out of the request,
 * each with a line in its place, until the rest fit. Only what is sent changes; the history keeps every picture.
 */
export function fitPictures(messages: Message[], budget: number): Message[] {
  let over = pictureBytes(messages) - budget;
  if (over <= 0) return messages;
  const out = messages.slice();
  for (let i = 0; i < out.length && over > 0; i++) {
    let changed = false;
    const parts = out[i].parts.map((p): Message['parts'][number] => {
      if (over <= 0) return p;
      if (p.type === 'image' && p.data) {
        over -= p.data.length;
        changed = true;
        return { type: 'text', text: `[A picture${p.name ? ` (${p.name})` : ''} was left out of this request: with it the request is too large for this provider.]`, synthetic: true };
      }
      if (p.type === 'tool_result' && p.images?.some((img) => img.data)) {
        const gone = p.images.filter((img) => img.data);
        over -= gone.reduce((n, img) => n + img.data.length, 0);
        changed = true;
        return { ...p, images: [], content: `${p.content}\n[${gone.length} picture${gone.length === 1 ? '' : 's'} left out of this request: with ${gone.length === 1 ? 'it' : 'them'} the request is too large for this provider. recall with call_id ${p.callId} brings ${gone.length === 1 ? 'it' : 'them'} back.]` };
      }
      return p;
    });
    if (changed) out[i] = { ...out[i], parts };
  }
  return out;
}
