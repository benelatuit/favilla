import fs from 'node:fs';
import type { ImagePart, Message, ToolCallPart, ToolResultPart } from '../types';
import { resolvePath } from '../util/paths';
import { estimateImageTokens } from '../util/tokens';
import { selectOptimalPrefixCut, type PrefixCacheContext } from './cache-cut';

/**
 * Unified image lifecycle and context budget for a session:
 * - Window-proportional token and slot watermarks (`imageBudget` / `imageSlots`) merged with the per-provider
 *   base64 payload ceiling (`pictureBudget` / `learnPictureBudget` / `fitPictures`).
 * - Stable virtual snapshot paths (`.favilla/images/img-NN.<ext>`) resolved from the session's `BlobStore` by `read`.
 * - Cache-preserving eviction: ordinary turns keep active images untouched unless a newer picture of the exact same
 *   view arrived recently or the epoch overflows the hard budget, in which case images batch-evict down to the 60%
 *   soft watermark in priority order (pinned current turn / latest tool round > recently mentioned/reopened > recency).
 */

export interface ImageDrop {
  callId: string;
  /** The line the result keeps in place of its pictures. */
  caption: string;
  /** Whether a newer picture of the same view replaced this one (needs no separate text extraction). */
  superseded?: boolean;
}

export interface UserImageDrop {
  messageIndex: number;
  partIndex: number;
  image: ImagePart;
  caption: string;
}

export interface ImageBudget {
  /** Trigger batch eviction once active images exceed this token count (`clamp(floor(window * 0.10), 3200, 28000)`). */
  hardTokens: number;
  /** Target token count after a batch eviction (`floor(hardTokens * 0.60)`). */
  softTokens: number;
  /** Maximum active images before batch eviction (`min(clamp(floor(window / 16000), 2, 16), providerMaxImages)`). */
  maxSlots: number;
  /** Maximum base64 characters per outbound request (`pictureBudget(provider)`, halved on HTTP 413). */
  maxBytes: number;
  /** Provider hard cap on images in a single request. */
  maxRequestImages: number;
}

export interface PlanImagesOptions {
  /** Message index at which an `img-NN` was most recently reopened via `read`. */
  reopenedAt?: ReadonlyMap<string, number>;
  /** Formats a surface-accurate `read` call hint for a virtual path. */
  readCallHint?: (virtualPath: string) => string;
  /** Live prompt-cache context; when active (`cachedShare < 1`), skips soft evictions that cost more in lost prefix cache than they save. */
  cache?: PrefixCacheContext;
}

/** Rounds within which a picture superseded by a newer one of its view goes at once. */
const RECENT_ROUNDS = 6;

const VIRTUAL_REL_RE = /^\.favilla\/images\/(img-\d+)\.[a-z0-9]+$/i;
const VIRTUAL_ANY_RE = /(?:^|[\s"'`=([{])((?:\.\/|\.\\)?\.favilla[\\/]+images[\\/]+(img-\d+)\.[a-z0-9]+)(?=$|[\s"'`),\]}:;])/gi;

export function extForImageMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.png';
  }
}

/** Virtual workspace-relative path used to reopen a session image via the `read` tool. */
export function virtualImagePath(id: string, mediaType = 'image/png'): string {
  return `.favilla/images/${id}${extForImageMediaType(mediaType)}`;
}

/**
 * Parse `.favilla/images/img-NN.<ext>` relative to `cwd` into its `img-NN` id, or `null` for any other path.
 * Callers MUST additionally check that the returned id is registered in the session's `ImageRegistry` before serving
 * from `BlobStore`, so real `.favilla/*` project files and unregistered filenames always fall through to disk.
 */
export function parseVirtualImageId(rawPath: string, cwd?: string): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  if (!cwd) {
    const clean = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
    const m = VIRTUAL_REL_RE.exec(clean);
    return m ? m[1].toLowerCase() : null;
  }
  const abs = resolvePath(cwd, trimmed);
  const root = resolvePath(cwd, '.').replace(/\\/g, '/').replace(/\/+$/, '');
  const norm = abs.replace(/\\/g, '/');
  const sameRoot = process.platform === 'win32' ? norm.toLowerCase().startsWith(`${root.toLowerCase()}/`) : norm.startsWith(`${root}/`);
  if (!sameRoot) return null;
  const rel = norm.slice(root.length + 1);
  const m = VIRTUAL_REL_RE.exec(rel);
  return m ? m[1].toLowerCase() : null;
}

/** Surface-matched call syntax for reopening a virtual image with the bound read tool (`read` / `Read` / `view_image` / `read_file`). */
export function formatReadImageCall(toolNames: Iterable<string>, vpath: string, withRegionHint = false): string {
  const set = new Set(toolNames);
  const region = withRegionHint ? ', region=[x,y,w,h] optional' : '';
  if (set.has('view_image')) return `view_image(path="${vpath}"${region})`;
  if (set.has('Read')) return `Read(file_path="${vpath}"${region})`;
  if (set.has('read_file')) return `read_file(path="${vpath}")`;
  return `read(paths=["${vpath}"]${region})`;
}

/**
 * Find registered `.favilla/images/img-NN.<ext>` references inside non-`read` tool arguments when no physical file
 * exists at that path on disk, so the caller can return a clear 1-line pointer to `read` instead of `ENOENT`.
 */
export function findVirtualImageRefs(
  value: unknown,
  cwd: string,
  isRegistered: (id: string) => boolean,
): { id: string; virtualPath: string }[] {
  const found = new Map<string, string>();
  const checkPath = (candidate: string) => {
    const id = parseVirtualImageId(candidate, cwd);
    if (!id || !isRegistered(id)) return;
    const abs = resolvePath(cwd, candidate);
    if (fs.existsSync(abs)) return;
    found.set(id, candidate.replace(/\\/g, '/').replace(/^\.\//, ''));
  };
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      checkPath(v);
      VIRTUAL_ANY_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = VIRTUAL_ANY_RE.exec(v)) !== null) checkPath(m[1]);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (v && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) visit(val);
    }
  };
  visit(value);
  return [...found.entries()].map(([id, vpath]) => ({ id, virtualPath: vpath }));
}

export function providerMaxImages(api?: string): number {
  if (api === 'anthropic') return 100;
  if (api === 'openai-chat' || api === 'openai-responses' || api === 'gemini') return 64;
  return 16;
}

/**
 * Maximum active image slots scaled proportionally to the context window (`32k` -> 2, `64k` -> 4, `128k` -> 8,
 * `256k+` -> 16), capped by the provider's per-request limit when known.
 */
export function imageSlots(window: number, providerApi?: string): number {
  const byWindow = Math.max(2, Math.min(16, Math.floor(window / 16_000)));
  return providerApi ? Math.min(byWindow, providerMaxImages(providerApi)) : byWindow;
}

/** Unified window-proportional + provider-aware image budget for a session. */
export function imageBudget(window: number, providerKey?: string, providerApi?: string): ImageBudget {
  const hardTokens = Math.max(3_200, Math.min(28_000, Math.floor(window * 0.10)));
  const softTokens = Math.floor(hardTokens * 0.60);
  const maxSlots = imageSlots(window, providerApi);
  const maxBytes = providerKey ? pictureBudget(providerKey) : PICTURE_BYTES;
  return {
    hardTokens,
    softTokens,
    maxSlots,
    maxBytes,
    maxRequestImages: providerMaxImages(providerApi),
  };
}

/** The view a picture-taking call shows: the same view twice means the later picture replaces the earlier. */
export function viewOf(call: ToolCallPart | undefined, result?: ToolResultPart): string {
  if (!call) return 'unknown';
  const i = (call.input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === 'string' || typeof i[k] === 'number' ? String(i[k]) : '');
  if (/^(browser|Screenshot|screenshot)$/.test(call.name)) return `page ${s('url') || 'current'} ${s('width')}x${s('height')}${i.full_page || i.fullPage ? ' full' : ''}`.trim();
  if (/^(read|read_file|Read|view_image)$/.test(call.name)) {
    // Favilla's read takes `paths` (with ranges and regions in them): keyed by path alone, every read was one view, and
    // a second picture dropped the first, so a render could not be set beside its reference.
    const paths = Array.isArray(i.paths) ? (i.paths as unknown[]).map(String) : [s('path') || s('file_path')];
    const region = i.region === undefined ? '' : ` ${JSON.stringify(i.region)}`;
    // If a file on disk was overwritten between two reads (`sourceSha256` changed), v1 and v2 are distinct versions
    // rather than redundant reads of the same picture, so keep v1 available for visual before/after comparison.
    const hashes = (result?.images ?? []).map((img) => img.sourceSha256).filter(Boolean);
    const ver = hashes.length ? ` @${hashes.map((h) => h!.slice(0, 12)).join(',')}` : '';
    return `file ${paths.map((p) => p.replace(/\\/g, '/')).join(' ')}${region}${ver}`;
  }
  if (call.name === 'paint') return `canvas ${s('canvas') || s('path') || s('out')}`;
  return `${call.name} ${s('path') || s('url')}`.trim();
}

function lastMentions(messages: Message[], from: number): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = from; i < messages.length; i++) {
    for (const p of messages[i].parts) {
      const text = p.type === 'text' ? p.text : p.type === 'tool_call' ? (p.raw ?? JSON.stringify(p.input ?? {})) : '';
      if (!text) continue;
      for (const m of text.matchAll(/\b(img-\d+)\b/gi)) {
        map.set(m[1].toLowerCase(), i);
      }
    }
  }
  return map;
}

function reopenTail(imgs: ImagePart[], readCallHint?: (vpath: string) => string): string {
  const ids = imgs.filter((img) => img.id);
  if (!ids.length) return '';
  const open = ids
    .map((img) => {
      const vpath = virtualImagePath(img.id!, img.mediaType);
      return `${img.id} via ${readCallHint ? readCallHint(vpath) : `read("${vpath}")`}`;
    })
    .join(', ');
  return ` Reopen virtual snapshot${ids.length === 1 ? '' : 's'} (read tool only, not on disk): ${open}.`;
}

/**
 * Plan mid-epoch image drops across both tool results and earlier user turns when active images exceed the unified
 * window/provider budget, while keeping the current unfinished user turn and latest tool round pinned.
 */
export function planSessionImages(
  messages: Message[],
  from: number,
  slotsOrBudget: number | ImageBudget,
  opts: PlanImagesOptions = {},
): { toolDrops: ImageDrop[]; userDrops: UserImageDrop[] } {
  const budget: ImageBudget =
    typeof slotsOrBudget === 'number'
      ? {
          hardTokens: Number.POSITIVE_INFINITY,
          softTokens: Number.POSITIVE_INFINITY,
          maxSlots: slotsOrBudget,
          maxBytes: Number.POSITIVE_INFINITY,
          maxRequestImages: slotsOrBudget,
        }
      : slotsOrBudget;

  const calls = new Map<string, ToolCallPart>();
  for (let i = from; i < messages.length; i++) for (const p of messages[i].parts) if (p.type === 'tool_call') calls.set(p.id, p);
  const rounds: number[] = [];
  for (let i = from; i < messages.length; i++) if (messages[i].parts.some((p) => p.type === 'tool_result')) rounds.push(i);
  const lastToolRound = rounds.at(-1) ?? messages.length;
  const recentFrom = rounds[Math.max(0, rounds.length - RECENT_ROUNDS)] ?? from;

  // Pin user images belonging to an unfinished current turn so the model always sees every image just sent in this turn.
  let latestUserIdx = -1;
  for (let i = messages.length - 1; i >= from; i--) {
    if (messages[i].role === 'user' && messages[i].origin === 'user') {
      latestUserIdx = i;
      break;
    }
  }
  let latestTurnFinished = false;
  if (latestUserIdx >= 0) {
    for (let i = latestUserIdx + 1; i < messages.length; i++) {
      if (messages[i].role === 'assistant' && !messages[i].parts.some((p) => p.type === 'tool_call')) {
        latestTurnFinished = true;
        break;
      }
    }
  }
  const pinnedUserFrom = latestUserIdx >= 0 && !latestTurnFinished ? latestUserIdx : messages.length;

  const toolHeld: { index: number; part: ToolResultPart; view: string; active: ImagePart[]; tokens: number; bytes: number }[] = [];
  const userHeld: { index: number; partIndex: number; image: ImagePart; tokens: number; bytes: number }[] = [];

  for (let i = from; i < messages.length; i++) {
    const m = messages[i];
    m.parts.forEach((p, partIndex) => {
      if (p.type === 'tool_result') {
        const active = (p.images ?? []).filter((img) => img.data);
        if (active.length) {
          toolHeld.push({
            index: i,
            part: p,
            view: viewOf(calls.get(p.callId), p),
            active,
            tokens: active.reduce((n, img) => n + estimateImageTokens(img), 0),
            bytes: active.reduce((n, img) => n + img.data.length, 0),
          });
        }
      } else if (p.type === 'image' && p.data) {
        userHeld.push({
          index: i,
          partIndex,
          image: p,
          tokens: estimateImageTokens(p),
          bytes: p.data.length,
        });
      }
    });
  }

  const rawCount = toolHeld.reduce((n, h) => n + h.active.length, 0) + userHeld.length;
  const rawBytes = toolHeld.reduce((n, h) => n + h.bytes, 0) + userHeld.reduce((n, u) => n + u.bytes, 0);
  const hardWireOverflow = rawCount > budget.maxRequestImages || rawBytes > budget.maxBytes;

  const toolDrops = new Map<string, ImageDrop>();
  const toolDropMeta = new Map<string, { index: number; tokens: number }>();
  const makeToolCaption = (h: (typeof toolHeld)[number], why: string, superseded = false): ImageDrop => {
    const count = h.active.length;
    const reopen = reopenTail(h.active, opts.readCallHint);
    const digests = h.active.map((img) => (img.digest ? `${img.id ? `[${img.id}] ` : ''}${img.digest}` : '')).filter(Boolean);
    const digestNote = digests.length ? ` Recorded details: ${digests.join(' | ')}.` : '';
    return {
      callId: h.part.callId,
      superseded,
      caption: `[${count} picture${count === 1 ? '' : 's'} of ${h.view} let go to save context (${why}); the text above is what was seen, and recall with call_id ${h.part.callId} brings ${count === 1 ? 'it' : 'them'} back.${reopen}${digestNote}]`,
    };
  };

  const newestByView = new Map<string, number>();
  for (const h of toolHeld) newestByView.set(h.view, h.index);
  for (const h of toolHeld) {
    if (h.index >= lastToolRound || h.index >= (newestByView.get(h.view) ?? -1)) continue;
    if (h.index >= recentFrom) {
      toolDrops.set(h.part.callId, makeToolCaption(h, 'a newer picture of the same view came after it', true));
      toolDropMeta.set(h.part.callId, { index: h.index, tokens: h.tokens });
    }
  }

  let totalCount =
    toolHeld.filter((h) => !toolDrops.has(h.part.callId)).reduce((n, h) => n + h.active.length, 0) +
    userHeld.length;
  let totalTokens =
    toolHeld.filter((h) => !toolDrops.has(h.part.callId)).reduce((n, h) => n + h.tokens, 0) +
    userHeld.reduce((n, u) => n + u.tokens, 0);
  let totalBytes =
    toolHeld.filter((h) => !toolDrops.has(h.part.callId)).reduce((n, h) => n + h.bytes, 0) +
    userHeld.reduce((n, u) => n + u.bytes, 0);

  const userDrops: UserImageDrop[] = [];
  const userDropTokens = new Map<string, number>();
  if (totalCount > budget.maxSlots || totalTokens > budget.hardTokens || totalBytes > budget.maxBytes) {
    const mentions = lastMentions(messages, from);
    const scoreOf = (arrived: number, imgs: ImagePart[], isUser: boolean): number => {
      let active = arrived;
      for (const img of imgs) {
        if (!img.id) continue;
        const m = mentions.get(img.id.toLowerCase()) ?? -1;
        const r = opts.reopenedAt?.get(img.id.toLowerCase()) ?? -1;
        if (m > active) active = m;
        if (r > active) active = r;
      }
      return active + (isUser ? 2 : 0);
    };

    type Candidate =
      | { kind: 'tool'; priority: number; index: number; order: number; item: (typeof toolHeld)[number] }
      | { kind: 'user'; priority: number; index: number; order: number; item: (typeof userHeld)[number] };

    const candidates: Candidate[] = [];
    for (const h of toolHeld) {
      if (toolDrops.has(h.part.callId) || h.index >= lastToolRound) continue;
      candidates.push({ kind: 'tool', priority: scoreOf(h.index, h.active, false), index: h.index, order: 0, item: h });
    }
    for (const u of userHeld) {
      if (u.index >= pinnedUserFrom) continue;
      candidates.push({ kind: 'user', priority: scoreOf(u.index, [u.image], true), index: u.index, order: u.partIndex + 1, item: u });
    }
    candidates.sort((a, b) => a.priority - b.priority || a.index - b.index || a.order - b.order);

    const floorSlots = Math.max(1, Math.floor(budget.maxSlots * 0.6));
    const softTokens = budget.softTokens;
    const softBytes = Number.isFinite(budget.maxBytes) ? Math.floor(budget.maxBytes * 0.75) : Number.POSITIVE_INFINITY;

    for (const c of candidates) {
      if (totalCount <= floorSlots && totalTokens <= softTokens && totalBytes <= softBytes) break;
      if (c.kind === 'tool') {
        toolDrops.set(c.item.part.callId, makeToolCaption(c.item, 'older than the pictures kept'));
        toolDropMeta.set(c.item.part.callId, { index: c.item.index, tokens: c.item.tokens });
        totalCount -= c.item.active.length;
        totalTokens -= c.item.tokens;
        totalBytes -= c.item.bytes;
      } else {
        const img = c.item.image;
        const vpath = img.id ? virtualImagePath(img.id, img.mediaType) : undefined;
        const openHint = vpath ? ` Reopen virtual snapshot (read tool only, not on disk) with ${opts.readCallHint ? opts.readCallHint(vpath) : `read("${vpath}")`}.` : '';
        const label = img.id ? `[${img.id}${img.name ? ` "${img.name}"` : ''}]` : `Picture${img.name ? ` "${img.name}"` : ''}`;
        userDrops.push({
          messageIndex: c.item.index,
          partIndex: c.item.partIndex,
          image: img,
          caption: `[${label} raw pixels moved out to stay within the window's image budget.${img.digest ? ` Recorded details: ${img.digest}.` : ''}${openHint}]`,
        });
        userDropTokens.set(`${c.item.index}:${c.item.partIndex}`, c.item.tokens);
        totalCount -= 1;
        totalTokens -= c.item.tokens;
        totalBytes -= c.item.bytes;
      }
    }
  }

  if (!hardWireOverflow && opts.cache && opts.cache.cachedShare < 1 && (toolDrops.size > 0 || userDrops.length > 0)) {
    const savingsByMessage = new Map<number, number>();
    for (const meta of toolDropMeta.values()) {
      savingsByMessage.set(meta.index, (savingsByMessage.get(meta.index) ?? 0) + meta.tokens);
    }
    for (const u of userDrops) {
      const tok = userDropTokens.get(`${u.messageIndex}:${u.partIndex}`) ?? 0;
      savingsByMessage.set(u.messageIndex, (savingsByMessage.get(u.messageIndex) ?? 0) + tok);
    }
    const cut = selectOptimalPrefixCut(messages, from, savingsByMessage, opts.cache);
    if (!cut) return { toolDrops: [], userDrops: [] };
    return {
      toolDrops: [...toolDrops.values()].filter((d) => (toolDropMeta.get(d.callId)?.index ?? -1) >= cut.cutIndex),
      userDrops: userDrops.filter((u) => u.messageIndex >= cut.cutIndex),
    };
  }

  return { toolDrops: [...toolDrops.values()], userDrops };
}

/** Which tool results of `messages[from..]` let their pictures go now. */
export function planImages(messages: Message[], from: number, slotsOrBudget: number | ImageBudget, opts?: PlanImagesOptions): ImageDrop[] {
  return planSessionImages(messages, from, slotsOrBudget, opts).toolDrops;
}

/**
 * Picture data a request may carry, in base64 characters, when the provider has not refused less: a guard for a
 * history that collected many pictures, merged with the learned HTTP 413 ceiling.
 */
export const PICTURE_BYTES = 20_000_000;

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

export function pictureCount(messages: Message[]): number {
  let n = 0;
  for (const m of messages)
    for (const p of m.parts) {
      if (p.type === 'image' && p.data) n += 1;
      else if (p.type === 'tool_result') for (const img of p.images ?? []) if (img.data) n += 1;
    }
  return n;
}

/**
 * The messages as a request carries them under `budget` of picture data (and optional `maxImages` provider cap):
 * the oldest pictures stay out of the request, each with a line in its place, until the rest fit. Only what is sent
 * changes; the history keeps every picture.
 */
export function fitPictures(
  messages: Message[],
  budget: number,
  opts: { maxImages?: number; readCallHint?: (virtualPath: string) => string } = {},
): Message[] {
  let overBytes = pictureBytes(messages) - budget;
  let overCount = opts.maxImages !== undefined ? pictureCount(messages) - opts.maxImages : 0;
  if (overBytes <= 0 && overCount <= 0) return messages;
  const out = messages.slice();
  for (let i = 0; i < out.length && (overBytes > 0 || overCount > 0); i++) {
    let changed = false;
    const parts = out[i].parts.map((p): Message['parts'][number] => {
      if (overBytes <= 0 && overCount <= 0) return p;
      if (p.type === 'image' && p.data) {
        overBytes -= p.data.length;
        overCount -= 1;
        changed = true;
        const vpath = p.id ? virtualImagePath(p.id, p.mediaType) : undefined;
        const reopen = vpath ? ` Reopen virtual snapshot (read tool only, not on disk) with ${opts.readCallHint ? opts.readCallHint(vpath) : `read("${vpath}")`}.` : '';
        const digest = p.digest ? ` Recorded details: ${p.digest}.` : '';
        return {
          type: 'text',
          text: `[A picture${p.id ? ` (${p.id}${p.name ? `: ${p.name}` : ''})` : p.name ? ` (${p.name})` : ''} was left out of this request: with it the request is too large for this provider.${digest}${reopen}]`,
          synthetic: true,
        };
      }
      if (p.type === 'tool_result' && p.images?.some((img) => img.data)) {
        const gone = p.images.filter((img) => img.data);
        overBytes -= gone.reduce((n, img) => n + img.data.length, 0);
        overCount -= gone.length;
        changed = true;
        const reopen = reopenTail(gone, opts.readCallHint);
        const digests = gone.map((img) => (img.digest ? `${img.id ? `[${img.id}] ` : ''}${img.digest}` : '')).filter(Boolean);
        const digest = digests.length ? ` Recorded details: ${digests.join(' | ')}.` : '';
        return {
          ...p,
          images: [],
          content: `${p.content}\n[${gone.length} picture${gone.length === 1 ? '' : 's'} left out of this request: with ${gone.length === 1 ? 'it' : 'them'} the request is too large for this provider.${digest} recall with call_id ${p.callId} brings ${gone.length === 1 ? 'it' : 'them'} back.${reopen}]`,
        };
      }
      return p;
    });
    if (changed) out[i] = { ...out[i], parts };
  }
  return out;
}
