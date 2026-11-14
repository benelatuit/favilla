import type { Pricing } from '../config/config';
import type { Usage } from '../types';
import type { SessionStore } from './sessions';
import { readTokenLog, tokenLogSince, tokens, type TokenEntry } from './token-log';

/** Tokens of one model in one folder on one day, as the usage page draws them. */
export interface TokenRow {
  /** YYYY-MM-DD in the time zone asked for. */
  day: string;
  provider: string;
  model: string;
  cwd: string;
  /** Requests, side requests (compaction, summaries, titles) among them. */
  requests: number;
  side: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
  /** Requests whose provider said nothing of their tokens: counted, their tokens not known. */
  unreported: number;
  /** Replies timed as they came (see `speedOf`): the tokens that streamed and how long they took, in ms. */
  timed: number;
  streamTokens: number;
  streamMs: number;
  /** Replies whose first word was timed, and the waits summed in ms. */
  waited: number;
  waitMs: number;
}

/** Tokens of one session on one day, a sub-agent's counted with the session it worked for. */
export interface SessionRow {
  day: string;
  session: string;
  cwd: string;
  requests: number;
  input: number;
  output: number;
  cost: number;
}

export interface TokenStats {
  rows: TokenRow[];
  sessions: SessionRow[];
  /** The names of the sessions in `sessions` that are still kept. */
  titles: Record<string, string>;
  /** Models (provider/model) with no price list and not on a server of the user's own: their cost is not known, not nothing. */
  unpriced: string[];
  /** When the token log began: before it, the counts are the replies kept in sessions, without side requests. */
  since: number | null;
  /** The first request counted at all, for a range that reaches back to the start. */
  first: number | null;
}

/** A cost from a price list in dollars per million tokens, as the session reckons it (session.ts recordUsage). */
export function costOf(u: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>, p: Pricing | undefined): number {
  if (!p) return 0;
  const fresh = Math.max(0, u.input - u.cacheRead - u.cacheWrite);
  return (fresh * p.input + u.cacheRead * (p.cacheRead ?? p.input * 0.1) + u.cacheWrite * (p.cacheWrite ?? p.input * 1.25) + u.output * p.output) / 1e6;
}

/**
 * The tokens a reply streamed and the time they took: from its first word to its end, the reasoning left out when it
 * came as no words. None for a reply too short to time, or one a relay held back and sent at once.
 */
export function speedOf(e: Pick<TokenEntry, 'output' | 'reasoning' | 'ms' | 'waitMs' | 'hidden'>): { tokens: number; ms: number } | null {
  if (!e.ms || e.waitMs === undefined) return null;
  const tokens = e.hidden ? Math.max(0, e.output - e.reasoning) : e.output;
  const ms = e.ms - e.waitMs;
  // Under half a second or a few dozen tokens says more about the network than the model; past 5000 a second, the
  // words were held and let go together.
  if (ms < 500 || tokens < 32 || (tokens / ms) * 1000 > 5000) return null;
  return { tokens, ms };
}

/** A folder for grouping: one kind of separator, no trailing one, case aside (as the server compares folders). */
const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The calendar day of a moment where the user is; the computer's own zone when the one asked for is not known. */
function dayFormat(tz: string | undefined): (at: number) => string {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  return (at) => f.format(at);
}

/** The replies read from each session file before, while it has not changed. */
const read = new Map<string, { updated: number; entries: TokenEntry[] }>();

/**
 * The replies kept in sessions from before the token log began, as log entries. A session last written after `from`
 * may hold some; each file is read once and again only when it has changed.
 */
async function fromSessions(store: SessionStore, from: number, before: number, price: (provider: string, model: string) => Pricing | undefined): Promise<TokenEntry[]> {
  const metas = store.everyMeta().filter((m) => m.updated >= from && m.created < before);
  const out: TokenEntry[] = [];
  let next = 0;
  // A few at a time: a first look over hundreds of sessions opens each one.
  const worker = async () => {
    for (let i = next++; i < metas.length; i = next++) {
      const meta = metas[i];
      const key = `${store.root}\u0000${meta.id}`;
      let known = read.get(key);
      if (!known || known.updated !== meta.updated) {
        const replies = (await store.replyUsage(meta.id)) ?? [];
        known = {
          updated: meta.updated,
          entries: replies.map((r) => {
            const provider = r.provider ?? meta.provider ?? '';
            const model = r.model ?? meta.model ?? '';
            const t = tokens(r.usage);
            return { at: r.at, session: meta.id, ...(meta.parentId ? { parent: meta.parentId } : {}), cwd: meta.cwd, provider, model, kind: 'main' as const, ...t, cost: costOf(t, price(provider, model)), ...(t.input + t.output === 0 ? { unreported: true as const } : {}) };
          }),
        };
        read.set(key, known);
      }
      for (const e of known.entries) if (e.at >= from && e.at < before) out.push(e);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, metas.length) }, worker));
  return out;
}

/**
 * Tokens by day, model and folder since `from` (ms): every request in the token log, and before the log began, the
 * replies the sessions kept.
 */
export async function tokenStats(
  store: SessionStore,
  opts: { from?: number; tz?: string; price?: (provider: string, model: string) => Pricing | undefined; free?: (provider: string) => boolean } = {},
): Promise<TokenStats> {
  const from = Math.max(0, opts.from ?? 0);
  const since = tokenLogSince();
  const price = opts.price ?? (() => undefined);
  const logged = await readTokenLog(from);
  const older = since === null || from < since ? await fromSessions(store, from, since ?? Infinity, price) : [];
  const day = dayFormat(opts.tz);
  const rows = new Map<string, TokenRow>();
  const shown = new Map<string, string>();
  const metas = new Map(store.everyMeta().map((m) => [m.id, m]));
  // The session a request counts for: the one a sub-agent worked for, up through a sub-agent's own sub-agents.
  const rootOf = (id: string) => {
    for (let i = 0; i < 8; i++) {
      const up = metas.get(id)?.parentId;
      if (!up) break;
      id = up;
    }
    return id;
  };
  const bySession = new Map<string, SessionRow>();
  let first: number | null = null;
  for (const e of [...older, ...logged]) {
    if (!e.model) continue;
    if (first === null || e.at < first) first = e.at;
    const folder = folderKey(e.cwd);
    if (!shown.has(folder)) shown.set(folder, e.cwd);
    const k = [day(e.at), e.provider, e.model, folder].join('\u0000');
    let r = rows.get(k);
    if (!r) {
      r = { day: day(e.at), provider: e.provider, model: e.model, cwd: shown.get(folder)!, requests: 0, side: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, unreported: 0, timed: 0, streamTokens: 0, streamMs: 0, waited: 0, waitMs: 0 };
      rows.set(k, r);
    }
    r.requests++;
    if (e.kind === 'side') r.side++;
    if (e.unreported) r.unreported++;
    r.input += e.input;
    r.output += e.output;
    r.cacheRead += e.cacheRead;
    r.cacheWrite += e.cacheWrite;
    r.reasoning += e.reasoning;
    r.cost += e.cost;
    const speed = speedOf(e);
    if (speed) {
      r.timed++;
      r.streamTokens += speed.tokens;
      r.streamMs += speed.ms;
    }
    if (e.waitMs !== undefined) {
      r.waited++;
      r.waitMs += e.waitMs;
    }
    const root = rootOf(e.parent ?? e.session);
    const sk = `${r.day}\u0000${root}`;
    let sr = bySession.get(sk);
    if (!sr) bySession.set(sk, (sr = { day: r.day, session: root, cwd: r.cwd, requests: 0, input: 0, output: 0, cost: 0 }));
    sr.requests++;
    sr.input += e.input;
    sr.output += e.output;
    sr.cost += e.cost;
  }
  const titles: Record<string, string> = {};
  for (const sr of bySession.values()) {
    const title = metas.get(sr.session)?.title;
    if (title) titles[sr.session] = title;
  }
  // A model with no price now, none when it ran, on a server that is not the user's own: "$0.00" would say it was free.
  const spent = new Map<string, { provider: string; model: string; cost: number }>();
  for (const r of rows.values()) {
    const k = `${r.provider}/${r.model}`;
    const m = spent.get(k) ?? { provider: r.provider, model: r.model, cost: 0 };
    m.cost += r.cost;
    spent.set(k, m);
  }
  const unpriced = [...spent].filter(([, m]) => m.cost === 0 && !price(m.provider, m.model) && !opts.free?.(m.provider)).map(([k]) => k);
  const order = (r: TokenRow) => [r.day, r.provider, r.model, folderKey(r.cwd)].join('\u0000');
  const sessions = [...bySession.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.session < b.session ? -1 : 1));
  return { rows: [...rows.values()].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0)), sessions, titles, unpriced, since, first };
}
