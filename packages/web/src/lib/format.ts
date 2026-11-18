/** A changed file's operation as git's status letter: added, deleted, renamed, modified. */
export const diffOp = (op: string) => (op === 'add' ? 'A' : op === 'delete' ? 'D' : op === 'move' ? 'R' : 'M');

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** Bytes as people read them: 812 KB, 85 MB, 8.7 GB. */
export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getRtf(lang: string): Intl.RelativeTimeFormat {
  let f = rtfCache.get(lang);
  if (!f) {
    f = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    rtfCache.set(lang, f);
  }
  return f;
}

function getDtf(locale: string, key: string, opts?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${locale}\u0000${key}`;
  let f = dtfCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    dtfCache.set(k, f);
  }
  return f;
}

export function relativeTime(ts: number, lang: string): string {
  const diff = Date.now() - ts;
  const rtf = getRtf(lang);
  const min = Math.round(diff / 60_000);
  if (min < 1) return rtf.format(0, 'minute');
  if (min < 60) return rtf.format(-min, 'minute');
  const h = Math.round(min / 60);
  if (h < 24) return rtf.format(-h, 'hour');
  const d = Math.round(h / 24);
  if (d < 30) return rtf.format(-d, 'day');
  return getDtf(lang, 'date-default').format(ts);
}

export function shortPath(p: string, max = 42): string {
  const s = p.replace(/\\/g, '/');
  if (s.length <= max) return s;
  const parts = s.split('/');
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0 && out.length + parts[i].length + 2 < max; i--) out = `${parts[i]}/${out}`;
  return `…/${out}`;
}

export function folderName(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  return s.split(/[\\/]/).pop() || s;
}

/** A title as plain text: session titles come from the first line of a prompt and may carry markdown. */
export function plainTitle(s: string | undefined): string {
  return (s ?? '')
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^\s*(#+|>|[-*])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ageCache = new Map<string, Intl.NumberFormat>();

function ageUnit(locale: string, unit: 'minute' | 'hour' | 'day', n: number): string {
  const k = `${locale} ${unit}`;
  let f = ageCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' });
    ageCache.set(k, f);
  }
  return f.format(n);
}

/**
 * How long ago, as short as the language writes it: now, 5m, 3h, 2d, a short date past a week. A list of sessions reads
 * by age, and a column of clock times (15:46, 15:46, 15:44) said the same thing longer.
 */
export function age(ts: number, locale: string, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return getRtf(locale).format(0, 'second');
  if (min < 60) return ageUnit(locale, 'minute', min);
  const h = Math.floor(min / 60);
  if (h < 24) return ageUnit(locale, 'hour', h);
  const d = Math.floor(h / 24);
  if (d < 7) return ageUnit(locale, 'day', d);
  return shortTime(ts, locale);
}

/** Clock time for today, a short date otherwise. */
export function shortTime(ts: number, locale: string): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return getDtf(locale, 'hm', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  }
  if (d.getFullYear() === now.getFullYear()) return getDtf(locale, 'md', { month: 'short', day: 'numeric' }).format(d);
  return getDtf(locale, 'ym', { year: 'numeric', month: 'short' }).format(d);
}

export type DayGroup = 'today' | 'yesterday' | 'week' | 'older';

export function dayGroup(ts: number): DayGroup {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ts >= start.getTime()) return 'today';
  if (ts >= start.getTime() - day) return 'yesterday';
  if (ts >= start.getTime() - 6 * day) return 'week';
  return 'older';
}

/** Elapsed time as a clock: 0:42, 12:05, 1:02:13. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
