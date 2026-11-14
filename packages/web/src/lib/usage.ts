/** Tokens by day, model and folder as the server sums them (core store/token-stats.ts), and the sums the usage page draws. */
export interface TokenRow {
  day: string;
  provider: string;
  model: string;
  cwd: string;
  requests: number;
  side: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
  /** Requests whose provider said nothing of their tokens. */
  unreported?: number;
  /** Replies timed as they streamed: the tokens that streamed and the time they took (ms), for a speed. */
  timed?: number;
  streamTokens?: number;
  streamMs?: number;
  /** Replies whose first word was timed, and their waits summed (ms). */
  waited?: number;
  waitMs?: number;
}

/** One session's requests on one day, its sub-agents' with it. */
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
  since: number | null;
  first: number | null;
  /** From servers that sum by session; an older one sends none. */
  sessions?: SessionRow[];
  /** The title of each session still kept. */
  titles?: Record<string, string>;
  /** Models (provider/model) used at no cost whose price is not known: their cost is unknown, not nothing. */
  unpriced?: string[];
}

export type Range = '7' | '30' | '90' | 'all';
export type Unit = 'day' | 'week' | 'month';
/** What the chart measures: tokens and cost as stacked columns, the speed of each model as a line. */
export type Metric = 'tokens' | 'cost' | 'speed';

export type Sums = Pick<
  TokenRow,
  'requests' | 'side' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'cost' | 'unreported' | 'timed' | 'streamTokens' | 'streamMs' | 'waited' | 'waitMs'
>;

export const zero = (): Sums => ({ requests: 0, side: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, unreported: 0, timed: 0, streamTokens: 0, streamMs: 0, waited: 0, waitMs: 0 });

export function add(to: Sums, r: Sums): Sums {
  to.requests += r.requests;
  to.side += r.side;
  to.input += r.input;
  to.output += r.output;
  to.cacheRead += r.cacheRead;
  to.cacheWrite += r.cacheWrite;
  to.reasoning += r.reasoning;
  to.cost += r.cost;
  to.unreported = (to.unreported ?? 0) + (r.unreported ?? 0);
  to.timed = (to.timed ?? 0) + (r.timed ?? 0);
  to.streamTokens = (to.streamTokens ?? 0) + (r.streamTokens ?? 0);
  to.streamMs = (to.streamMs ?? 0) + (r.streamMs ?? 0);
  to.waited = (to.waited ?? 0) + (r.waited ?? 0);
  to.waitMs = (to.waitMs ?? 0) + (r.waitMs ?? 0);
  return to;
}

/** Tokens a second while replies streamed, or null with none timed. */
export const speedOf = (s: Sums) => (s.streamMs ? ((s.streamTokens ?? 0) / s.streamMs) * 1000 : null);
/** The wait for a reply's first word on average, in ms, or null with none timed. */
export const waitOf = (s: Sums) => (s.waited ? (s.waitMs ?? 0) / s.waited : null);

/** Every token a request took: the prompt, cached parts included, and the answer, reasoning included. */
export const totalOf = (s: Sums) => s.input + s.output;
/** The prompt tokens no cache held. Some providers count the cache apart from the prompt: never below nothing. */
export const freshOf = (s: Sums) => Math.max(0, s.input - s.cacheRead - s.cacheWrite);
/** The share of the prompt read from a cache, or null with no prompt to speak of. */
export const cachedShare = (s: Sums) => (s.input > 0 ? Math.min(1, s.cacheRead / s.input) : null);

/** A local calendar day as the server names days in the zone it was given: YYYY-MM-DD. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The day a key names, at noon, so adding days never lands on the wrong one across a change of clocks. */
export function dayOf(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export const plusDays = (key: string, n: number) => {
  const d = dayOf(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
};

/** The first and last day of a range, today being the last; "all" starts on the first day anything was counted. */
export function rangeDays(range: Range, today: string, first: string | null): { from: string; to: string } {
  if (range === 'all') return { from: first && first < today ? first : today, to: today };
  return { from: plusDays(today, 1 - Number(range)), to: today };
}

/** The range just before one of so many days, to say how this one compares; none for "all". */
export function previousDays(range: Range, today: string): { from: string; to: string } | null {
  if (range === 'all') return null;
  const n = Number(range);
  return { from: plusDays(today, 1 - 2 * n), to: plusDays(today, -n) };
}

/** Columns a chart of this many days can show apart: a day each up to three months, then weeks, then months. */
export function unitFor(from: string, to: string): Unit {
  const days = Math.round((dayOf(to).getTime() - dayOf(from).getTime()) / 86_400_000) + 1;
  return days <= 92 ? 'day' : days <= 730 ? 'week' : 'month';
}

/** The column a day goes in: itself, the Monday of its week, or the first of its month. */
export function bucketKey(day: string, unit: Unit): string {
  if (unit === 'day') return day;
  if (unit === 'month') return `${day.slice(0, 7)}-01`;
  const d = dayOf(day);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dayKey(d);
}

/** Every column from the first day to the last, the empty ones too, so a quiet week shows as one. */
export function bucketKeys(from: string, to: string, unit: Unit): string[] {
  const out: string[] = [];
  for (let k = bucketKey(from, unit); k <= to; ) {
    out.push(k);
    if (unit === 'day') k = plusDays(k, 1);
    else if (unit === 'week') k = plusDays(k, 7);
    else {
      const d = dayOf(k);
      k = dayKey(new Date(d.getFullYear(), d.getMonth() + 1, 1, 12));
    }
  }
  return out;
}

export const modelKey = (r: Pick<TokenRow, 'provider' | 'model'>) => `${r.provider}/${r.model}`;
export const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export interface Part {
  key: string;
  label: string;
  /** The provider of a model, the full path of a folder. */
  detail: string;
  sums: Sums;
}

/** Rows summed by a key, largest first. */
export function partsBy(rows: TokenRow[], keyOf: (r: TokenRow) => string, labelOf: (r: TokenRow) => string, detailOf: (r: TokenRow) => string): Part[] {
  const parts = new Map<string, Part>();
  for (const r of rows) {
    const key = keyOf(r);
    let p = parts.get(key);
    if (!p) parts.set(key, (p = { key, label: labelOf(r), detail: detailOf(r), sums: zero() }));
    add(p.sums, r);
  }
  return [...parts.values()].sort((a, b) => totalOf(b.sums) - totalOf(a.sums) || a.label.localeCompare(b.label));
}

/** How many models get a colour of their own; the rest share the grey of "Other". Five hues stay apart for every reader. */
export const SERIES = 5;

/**
 * The colour slot of each model, by how much it was used over everything counted: a model keeps its colour whichever
 * range is shown, as the reader learned it.
 */
export function slotsOf(allRows: TokenRow[]): Map<string, number> {
  const ranked = partsBy(allRows, modelKey, (r) => r.model, (r) => r.provider);
  return new Map(ranked.slice(0, SERIES).map((p, i) => [p.key, i]));
}

export interface Column {
  key: string;
  /** Per series, in the order of the series given. */
  values: number[];
  sums: Sums;
}

/**
 * The chart's columns: tokens or cost per column, split by model (one value per colour slot and one for the rest) or,
 * for tokens, by kind (fresh prompt, read from a cache, written to one, answer).
 */
export function columnsOf(rows: TokenRow[], keys: string[], unit: Unit, split: 'model' | 'kind', slots: Map<string, number>, metric: Exclude<Metric, 'speed'> = 'tokens'): Column[] {
  const byModel = split === 'model' || metric === 'cost';
  const width = byModel ? SERIES + 1 : 4;
  const at = new Map(keys.map((k) => [k, { key: k, values: new Array<number>(width).fill(0), sums: zero() } as Column]));
  for (const r of rows) {
    const c = at.get(bucketKey(r.day, unit));
    if (!c) continue;
    add(c.sums, r);
    if (byModel) c.values[slots.get(modelKey(r)) ?? SERIES] += metric === 'cost' ? r.cost : totalOf(r);
    else {
      c.values[0] += freshOf(r);
      c.values[1] += r.cacheRead;
      c.values[2] += r.cacheWrite;
      c.values[3] += r.output;
    }
  }
  return keys.map((k) => at.get(k)!);
}

/**
 * Each model's speed per column, in tokens a second over all its timed replies there; NaN where none was timed. The
 * models without a colour get no line: the speeds of several models do not add up to one.
 */
export function speedColumns(rows: TokenRow[], keys: string[], unit: Unit, slots: Map<string, number>): Column[] {
  const at = new Map(keys.map((k) => [k, { key: k, values: new Array<number>(SERIES + 1).fill(NaN), sums: zero() } as Column]));
  const timed = new Map<string, Sums[]>();
  for (const r of rows) {
    const c = at.get(bucketKey(r.day, unit));
    if (!c) continue;
    add(c.sums, r);
    const i = slots.get(modelKey(r));
    if (i === undefined || !r.streamMs) continue;
    const per = timed.get(c.key) ?? Array.from({ length: SERIES }, zero);
    add(per[i], r);
    timed.set(c.key, per);
  }
  for (const [k, per] of timed) per.forEach((s, i) => (at.get(k)!.values[i] = speedOf(s) ?? NaN));
  return keys.map((k) => at.get(k)!);
}

/** Rows of the days from `from` to `to`, both in. */
export const rowsIn = <R extends { day: string }>(rows: R[], from: string, to: string) => rows.filter((r) => r.day >= from && r.day <= to);

/** How many columns at the start hold only days before `day`: those before the log began. */
export function columnsBefore(keys: string[], to: string, day: string): number {
  let n = 0;
  // A column ends the day before the next one starts; the last one ends on the last day shown.
  while (n < keys.length && (n + 1 < keys.length ? keys[n + 1] : plusDays(to, 1)) <= day) n++;
  return n;
}

export interface SessionPart {
  session: string;
  cwd: string;
  requests: number;
  total: number;
  cost: number;
}

/** Each session's sums over the days given, largest first. */
export function sessionParts(rows: SessionRow[]): SessionPart[] {
  const at = new Map<string, SessionPart>();
  for (const r of rows) {
    let p = at.get(r.session);
    if (!p) at.set(r.session, (p = { session: r.session, cwd: r.cwd, requests: 0, total: 0, cost: 0 }));
    p.requests += r.requests;
    p.total += r.input + r.output;
    p.cost += r.cost;
  }
  return [...at.values()].sort((a, b) => b.total - a.total || a.session.localeCompare(b.session));
}

/** Up to four round steps for an axis that reaches `max`: 0, 2.5K, 5K, 7.5K, 10K. */
export function ticksFor(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
