import type { ModelInfo } from '../catalog/catalog';
import type { FavillaConfig } from '../config/config';
import { DEFAULTS } from '../config/config';

export interface Budget {
  window: number;
  /** max_tokens per request (reasoning included). */
  maxOutput: number;
  /** Compact once the conversation passes this many tokens. */
  compactAt: number;
  /** Most characters one tool result may return. */
  toolOutputChars: number;
  /** Most characters one file read may return: about a tenth of the window. */
  readChars: number;
}

/**
 * Sizes everything from the model's real context window, so a 32k local model and a 1M-token
 * frontier model each get budgets that fit: smaller windows reserve proportionally less output,
 * cap tool results harder and compact earlier.
 */
export function computeBudget(model: ModelInfo, config: FavillaConfig): Budget {
  // Explicit per-model window overrides in Settings (`providers.<p>.models.<m>.contextWindow`) or `context.limit` (0 = uncapped)
  // win as written; otherwise cap ultra-wide models at the 256k sweet spot.
  const userModelWindow = model.provider && model.id ? config.providers?.[model.provider]?.models?.[model.id]?.contextWindow : undefined;
  const rawLimit = config.context?.limit ?? (userModelWindow !== undefined ? Infinity : DEFAULTS.context.limit);
  const limit = rawLimit <= 0 ? Infinity : rawLimit;
  const window = Math.max(4096, Math.min(model.contextWindow, limit));
  const share = config.context?.compactAt ?? DEFAULTS.context.compactAt;
  const outShare = config.context?.toolOutputShare ?? DEFAULTS.context.toolOutputShare;
  let maxOutput: number;
  if (window <= 65_536) maxOutput = Math.max(2048, Math.floor(window * 0.25));
  else if (window < 120_000) maxOutput = 32_000;
  else if (window <= 196_608) maxOutput = Math.max(16_384, Math.floor(window * 0.16));
  else if (window <= 262_144) maxOutput = 32_000;
  else maxOutput = 64_000;
  maxOutput = Math.min(maxOutput, model.maxOutput);
  const usable = window - maxOutput - 1024;
  const compactAt = Math.max(2048, Math.min(Math.floor(window * share), usable));
  const toolOutputChars = Math.round(Math.min(40_000, Math.max(6_000, window * outShare * 3.5)));
  const readChars = Math.round(Math.min(100_000, Math.max(8_000, window * 0.1 * 3.5)));
  return { window, maxOutput, compactAt, toolOutputChars, readChars };
}
