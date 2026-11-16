import type { Message } from '../types';
import { estimateMessageTokens } from '../util/tokens';

export interface PrefixCacheContext {
  /** Ratio of cached input price to uncached input price (e.g. `0.1`); `>= 1` when no cache has been observed yet. */
  cachedShare: number;
  /** Expected upper bound on subsequent requests in the current compaction epoch. */
  remainingSteps: number;
  /** Current estimated prompt tokens, used to cap remaining steps by actual runway before `compactAt`. */
  contextTokens?: number;
  /** Context token threshold at which full compaction replaces the epoch. */
  compactAt?: number;
  /** Estimated prompt token growth per step in the current epoch. */
  avgStepGrowth?: number;
  /** Calibrated multiplier from `estimateMessageTokens` to provider-reported prompt tokens. */
  tokenScale?: number;
}

export interface PrefixCutChoice {
  /** Earliest message index mutated (`messages[from .. cutIndex - 1]` remain byte-identical in cache). */
  cutIndex: number;
  /** Estimated net billed-equivalent tokens saved (`> 0`). */
  netGain: number;
  /** Total tokens removed across `messages[cutIndex..]`. */
  savedTokens: number;
  /** Already-cached surviving tokens in `messages[cutIndex .. cachedEnd]` forced to re-prefill uncached once. */
  invalidatedTokens: number;
}

function sendableForEstimate(m: Message): Message {
  const blank = m.parts.some((p) => (p.type === 'image' && !p.data) || (p.type === 'tool_result' && p.images?.some((i) => !i.data)));
  if (!blank) return m;
  return {
    ...m,
    parts: m.parts
      .filter((p) => p.type !== 'image' || !!p.data)
      .map((p) => (p.type === 'tool_result' && p.images ? { ...p, images: p.images.filter((i) => !!i.data) } : p)),
  };
}

/**
 * Choose the suffix cut start `cutIndex >= from` that maximizes cache-weighted net token savings:
 *
 *   NetGain(k) = R(k) * c * S_cached(k) + (1 + (R(k) - 1) * c) * S_unsent(k) - (1 - c) * P_kept(k)
 *
 * `messages[from .. lastAssistantIdx]` sit in the provider's KV cache (including Decode-KV reuse of the latest
 * assistant message); only `messages[lastAssistantIdx + 1..]` (the newly appended tool results or user turn) will be
 * billed uncached on the upcoming request regardless. Returns `null` when every candidate cut loses more in invalidated
 * prefix cache than it saves over the remaining runway of the epoch.
 */
export function selectOptimalPrefixCut(
  messages: Message[],
  from: number,
  savingsByMessage: ReadonlyMap<number, number>,
  ctx: PrefixCacheContext,
): PrefixCutChoice | null {
  if (!savingsByMessage.size) return null;
  const start = Math.max(0, from);

  if (ctx.cachedShare >= 1) {
    let minIdx = messages.length;
    let totalSaved = 0;
    for (const [idx, saved] of savingsByMessage) {
      if (idx >= start && saved > 0) {
        if (idx < minIdx) minIdx = idx;
        totalSaved += saved;
      }
    }
    return minIdx < messages.length ? { cutIndex: minIdx, netGain: totalSaved, savedTokens: totalSaved, invalidatedTokens: 0 } : null;
  }

  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= start; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  const cachedEnd = lastAssistantIdx >= start ? lastAssistantIdx : start - 1;

  const c = Math.max(0, ctx.cachedShare);
  const maxSteps = Math.max(1, Math.floor(ctx.remainingSteps));
  const growth = Math.max(800, ctx.avgStepGrowth ?? 2500);
  const scale = Math.max(0.4, ctx.tokenScale ?? 1);

  let savedCached = 0;
  let savedUnsent = 0;
  let keptCached = 0;
  let best: PrefixCutChoice | null = null;

  for (let k = messages.length - 1; k >= start; k--) {
    const savedHere = Math.max(0, savingsByMessage.get(k) ?? 0);
    if (k <= cachedEnd) {
      const msgTok = estimateMessageTokens(sendableForEstimate(messages[k])) * scale;
      keptCached += Math.max(0, msgTok - savedHere);
      savedCached += savedHere;
    } else {
      savedUnsent += savedHere;
    }

    if (savedHere <= 0) continue;

    const totalSaved = savedCached + savedUnsent;
    let steps = maxSteps;
    if (ctx.contextTokens !== undefined && ctx.compactAt !== undefined) {
      const afterCut = Math.max(0, ctx.contextTokens - totalSaved);
      const runway = Math.max(1, Math.floor(Math.max(0, ctx.compactAt - afterCut) / growth));
      steps = Math.min(maxSteps, runway);
    }

    const benefit = steps * c * savedCached + (1 + Math.max(0, steps - 1) * c) * savedUnsent;
    const penalty = (1 - c) * keptCached;
    const netGain = benefit - penalty;

    if (netGain > 0 && (!best || netGain > best.netGain)) {
      best = {
        cutIndex: k,
        netGain,
        savedTokens: totalSaved,
        invalidatedTokens: keptCached,
      };
    }
  }

  return best;
}
