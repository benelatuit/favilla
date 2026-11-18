import { Readable } from 'node:stream';
import { Agent, ProxyAgent, fetch as undiciFetch, request as undiciRequest, type Dispatcher } from 'undici';
import { ProviderError } from '../providers/errors';

const DEFAULT_DEEP_STALL_MS = 25 * 60_000;
export const STALL_DEEP_MS = Number(process.env.FAVILLA_STALL_MS) || DEFAULT_DEEP_STALL_MS;
// The stream's watch should give up first, even when its silence limit is raised.
const TRANSPORT_TIMEOUT_MS = Math.max(DEFAULT_DEEP_STALL_MS, Number.isFinite(STALL_DEEP_MS) ? Math.ceil(STALL_DEEP_MS) : 0) + 60_000;
const dispatchers = new Map<string, Dispatcher>();

/** One dispatcher per proxy URL; generous timeouts because reasoning models can think for minutes. */
export function getDispatcher(proxy?: string | false): Dispatcher {
  const key = proxy || 'direct';
  let d = dispatchers.get(key);
  if (!d) {
    const opts = { headersTimeout: TRANSPORT_TIMEOUT_MS, bodyTimeout: TRANSPORT_TIMEOUT_MS, keepAliveTimeout: 30_000, connect: { timeout: 30_000 } };
    if (proxy) {
      // Forwarding proxies can create their own client without the agent's defaults.
      d = new ProxyAgent({ uri: proxy, ...opts }).compose((dispatch) => (request, handler) => dispatch({
        ...request,
        headersTimeout: request.headersTimeout ?? opts.headersTimeout,
        bodyTimeout: request.bodyTimeout ?? opts.bodyTimeout,
      }, handler));
    } else d = new Agent(opts);
    dispatchers.set(key, d);
  }
  return d;
}

export function envProxy(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || undefined;
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  proxy?: string | false;
  /**
   * Send only these headers (plus host, length and connection): none of the ones fetch adds on its own
   * (sec-fetch-mode, accept-language, accept-encoding), which a native client never sends.
   */
  exact?: boolean;
}

export async function http(url: string, init: HttpInit = {}): Promise<Response> {
  if (init.exact) {
    const r = await undiciRequest(url, {
      method: (init.method ?? (init.body ? 'POST' : 'GET')) as Dispatcher.HttpMethod,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      dispatcher: getDispatcher(init.proxy),
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) for (const x of [v].flat()) headers.append(k, String(x));
    const empty = r.statusCode === 204 || r.statusCode === 304;
    if (empty) r.body.resume();
    return new Response(empty ? null : (Readable.toWeb(r.body) as ReadableStream<Uint8Array>), { status: r.statusCode, headers });
  }
  const res = await undiciFetch(url, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    dispatcher: getDispatcher(init.proxy),
  });
  return res as unknown as Response;
}

/** A fetch function bound to a proxy, for SDKs that accept a custom fetch. */
export function proxiedFetch(proxy?: string | false): typeof fetch {
  const dispatcher = getDispatcher(proxy);
  return ((input: string | URL, init?: RequestInit) =>
    undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parse a text/event-stream body. `alive` hears of every chunk the server sends, keep-alive comments included: a
 * model that thinks without writing still shows the stream is open.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal, alive?: () => void): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let skipLF = false;
  let ended = false;
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      if (signal?.aborted) break;
      alive?.();
      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      buffer += skipLF && chunk.startsWith('\n') ? chunk.slice(1) : chunk;
      skipLF = false;
      let nl: number;
      while (!signal?.aborted && (nl = buffer.search(/\r\n|\n|\r/)) >= 0) {
        // A CR already ended the line, so a matching LF on the next read cannot end another one.
        skipLF = buffer[nl] === '\r' && nl === buffer.length - 1;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1));
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n') };
          event = '';
          data = [];
        } else if (line.startsWith(':')) {
          continue;
        } else {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let val = colon === -1 ? '' : line.slice(colon + 1);
          if (val.startsWith(' ')) val = val.slice(1);
          if (field === 'event') event = val;
          else if (field === 'data') data.push(val);
        }
      }
    }
    if (!signal?.aborted && data.length) yield { event: event || 'message', data: data.join('\n') };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // An early break after a terminal SSE frame leaves the HTTP stream open unless its reader is cancelled.
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /input is too long/i,
  /exceeds? (the )?(model'?s? )?context/i,
  /context window/i,
  /too many (input )?tokens/i,
  /exceed_context_size/i,
  /n_ctx/i,
  /request too large for model/i,
  /input token count.*exceeds/i,
];

export function isContextOverflow(text: string): boolean {
  return OVERFLOW_PATTERNS.some((re) => re.test(text));
}

function parseRetryBodyMs(body: string): number | undefined {
  const gemini = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (gemini) return Number(gemini[1]) * 1000;
  const rel = /(?:try again|resets?|retry) in (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:ond)?s?|m|min(?:ute)?s?)\b/i.exec(body);
  if (rel) {
    const val = Number(rel[1]);
    const u = rel[2].toLowerCase();
    const mult = u.startsWith('ms') || u.startsWith('milli') ? 1 : u.startsWith('m') ? 60_000 : 1000;
    return Math.ceil(val * mult);
  }
  const utc = /\bat (\d{1,2}):(\d{2})(?::(\d{2}))?\s*UTC\b/i.exec(body);
  if (utc) {
    const now = new Date();
    const target = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      Number(utc[1]),
      Number(utc[2]),
      utc[3] ? Number(utc[3]) : 0,
    );
    const delta = target >= now.getTime() ? target - now.getTime() : target + 86_400_000 - now.getTime();
    if (delta > 0 && delta <= 6 * 3_600_000) return delta;
  }
  return undefined;
}

function retryAfterMs(headers: Headers, body: string): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return secs * 1000;
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const raMs = headers.get('retry-after-ms');
  if (raMs && Number.isFinite(Number(raMs))) return Number(raMs);
  return parseRetryBodyMs(body);
}

/** Classify an in-stream SSE error payload (arriving after HTTP 200) and extract any reset window. */
export function classifyStreamError(message: string, code?: string): { kind: ProviderError['kind']; retryAfterMs?: number } {
  const combined = code ? `${code}: ${message}` : message;
  const after = parseRetryBodyMs(combined);
  if (isContextOverflow(combined)) return { kind: 'context_overflow' };
  if (/resource_exhausted|rate[_\s-]?limit|too many requests|\b429\b/i.test(combined)) {
    return { kind: 'rate_limit', retryAfterMs: after };
  }
  if (/insufficient_quota|billing|credit balance/i.test(combined) && !after) {
    return { kind: 'quota' };
  }
  if (/overloaded|temporarily unavailable|\b529\b|\b503\b/i.test(combined)) {
    return { kind: 'overloaded', retryAfterMs: after };
  }
  return { kind: 'server', retryAfterMs: after };
}

/** Turn a failed HTTP response into a typed provider error. */
export async function errorFromResponse(res: Response, provider: string): Promise<ProviderError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  return errorFromStatus(res.status, res.headers, body, provider, res.statusText);
}

/** A refusal as a ProviderError, from its status, headers and body (an HTTP response, a refused WebSocket, an error event). */
export function errorFromStatus(status: number, headers: Headers, body: string, provider: string, statusText = ''): ProviderError {
  const message = extractMessage(body) || `${status} ${statusText}`.trim();
  const after = retryAfterMs(headers, body);
  if (status === 401 || status === 403) return new ProviderError('auth', `${provider}: ${message}`, { status });
  if (status === 429) {
    const quota = /quota|insufficient|billing|credits|usage limit/i.test(message) && !/per minute|rate/i.test(message);
    return new ProviderError(quota ? 'quota' : 'rate_limit', `${provider}: ${message}`, { status, retryAfterMs: after, retryable: !quota || !!after });
  }
  // A body too large for the server, or for one in front of it (a relay passing on nginx's page): not a service that
  // is down, and no use sending the same again.
  if (status === 413 || /request entity too large|payload too large|request body too large|returned 413\b/i.test(`${message}\n${body}`)) return new ProviderError('too_large', `${provider}: the request is too large for this service (HTTP 413)`, { status, body });
  if (isContextOverflow(message) || isContextOverflow(body)) return new ProviderError('context_overflow', `${provider}: ${message}`, { status });
  // A model the provider does not have: an official API's 404 or model_not_found, a relay's "No available channel for
  // model ..." (503). Said at once to a user who is waiting (a misspelt name had looked like an outage, three tries and
  // "the service may be down"); a relay's channels can come back, so with nobody waiting a 5xx is still tried again.
  if (NO_MODEL.test(message) || (status === 404 && /\bmodel\b/i.test(`${message}\n${body}`)))
    return new ProviderError('model_not_found', `${provider}: ${message}`, { status, body, retryAfterMs: after, retryable: status >= 500 });
  if (status === 529 || status === 503 || /overloaded/i.test(message)) return new ProviderError('overloaded', `${provider}: ${message}`, { status, retryAfterMs: after });
  if (status >= 500) return new ProviderError('server', `${provider}: ${message}`, { status, retryAfterMs: after });
  if (status === 408 || status === 409) return new ProviderError('server', `${provider}: ${message}`, { status, retryAfterMs: after });
  return new ProviderError('invalid_request', `${provider}: ${message}`, { status, body });
}

// Only words that name a model as missing: "model ... is not supported" is how servers refuse a thinking level,
// a prefill or system messages, which the session answers in other ways.
const NO_MODEL = /model_not_found|no available channel for model|no such model|unknown model|is not a valid model|model not exist|invalid model(?: name| id|:)|\bmodels?[\s:/]+[`'\"]?[\w./:@-]+[`'\"]?\s+(?:does not exist|doesn't exist|not found|is not found)|模型不存在|无可用渠道/i;

function extractMessage(body: string): string {
  if (!body) return '';
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? j?.detail ?? j?.error ?? j?.[0]?.error?.message;
    if (typeof m === 'string') return m;
    if (m) return JSON.stringify(m).slice(0, 500);
  } catch {
    /* not json */
  }
  // An HTML error page (a proxy's or Cloudflare's 502, 504, 524): its title says it; the markup is noise.
  if (/^\s*<(?:!doctype|html|head)\b/i.test(body)) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1];
    if (title) return title.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  return body.slice(0, 500);
}
