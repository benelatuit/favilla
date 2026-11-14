import type { Effort } from '../types';
import { EFFORT_ORDER } from '../types';

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'overloaded'
  | 'server'
  | 'network'
  | 'context_overflow'
  /** A body refused for its size (HTTP 413): sent again it fails again, so what it carries must shrink first. */
  | 'too_large'
  | 'invalid_request'
  /** A model the provider does not have, or has no route to just now (a relay's "no available channel"). */
  | 'model_not_found'
  | 'stream_stalled'
  | 'aborted'
  | 'unknown';

const RETRYABLE: ProviderErrorKind[] = ['rate_limit', 'overloaded', 'server', 'network', 'stream_stalled'];

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly body?: string;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts: { status?: number; retryAfterMs?: number; retryable?: boolean; body?: string } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable = opts.retryable ?? RETRYABLE.includes(kind);
    this.body = opts.body;
  }
}

/** Classify low-level failures (DNS, resets, timeouts) that never produced a response. */
export function networkError(e: unknown, provider: string): ProviderError {
  if (e instanceof ProviderError) return e;
  const err = e as Error & { code?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'AbortError') return new ProviderError('aborted', 'Aborted', { retryable: false });
  const code = err?.code || err?.cause?.code || '';
  const detail = err?.cause?.message || err?.message || String(e);
  return new ProviderError('network', `${provider}: ${code && !detail.includes(code) ? `${code} ` : ''}${detail}`);
}

/** What a server refused about the thinking level sent: the level (with the ones it takes, when it says), or the setting itself. */
export type EffortRefusal = { kind: 'levels'; levels: Effort[] } | { kind: 'level' } | { kind: 'param' };

const LEVEL_WORDS = /\b(none|minimal|low|medium|high|xhigh|max)\b/gi;
const LIST_START = /(?:supported values|allowed values|valid values|possible values|accepted values|permitted values|must be one of|should be one of|expected one of|one of|input should be|expected)\s*(?:are|is)?\s*:?/i;
const LIST_END = /[[(\n]|\binput_value\b|\bbut\b|\bgot\b|\breceived\b|\binstead\b|\.(?:\s|$)/i;
const REFUSED = /(?:not supported|unsupported|invalid|not allowed|not permitted|not available|is not one of)/i;
const PARAM = /(?:reasoning_effort|reasoning\.effort|output_config\.effort|reasoning effort|"effort"|'effort'|\beffort\b)/i;
const UNKNOWN_PARAM = /(?:unrecognized|unknown|extra inputs are not permitted|extra_forbidden|additional properties|not a valid parameter|unexpected (?:keyword|field|parameter)|does not support (?:the )?(?:parameter|field))/i;

/**
 * Read a server's refusal of the thinking level it was sent: "'max' is not supported with this model. Supported values
 * are: 'low', 'medium', and 'high'", "Input should be 'low' or 'high' [input_value='max']", "Expected 'low' | 'high',
 * received 'max'", or an unknown reasoning_effort parameter. `sent` holds the level as it went on the wire. Undefined
 * when the error is about something else.
 */
export function effortRefusal(text: string, sent: string[]): EffortRefusal | undefined {
  if (!/effort|reasoning|thinking/i.test(text)) return undefined;
  const start = LIST_START.exec(text);
  if (start) {
    const rest = text.slice(start.index + start[0].length, start.index + start[0].length + 240);
    // A list may open with its own bracket ("one of ['low', 'high']"); a bracket after it starts the server's notes.
    const list = rest.replace(/^\s*[[(]/, '').split(LIST_END)[0];
    const refused = new Set(sent.map((s) => s.toLowerCase()));
    const levels = [...list.matchAll(LEVEL_WORDS)]
      .map((m) => m[1].toLowerCase())
      .filter((w) => !refused.has(w))
      .map((w) => (w === 'none' ? 'off' : w) as Effort);
    if (levels.length) return { kind: 'levels', levels: [...new Set(levels)].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)) };
  }
  for (const s of sent) {
    const quoted = new RegExp(`['"\`]${s}['"\`]`, 'i');
    const at = text.search(quoted);
    if (at >= 0 && REFUSED.test(text.slice(Math.max(0, at - 40), at + 80))) return { kind: 'level' };
  }
  if (PARAM.test(text) && UNKNOWN_PARAM.test(text)) return { kind: 'param' };
  return undefined;
}
