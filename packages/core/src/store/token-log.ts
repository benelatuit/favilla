import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Usage } from '../types';
import { appPath, ensureDir } from '../util/paths';
import { debug } from '../util/log';
import { openLines, sealLine } from './seal';

/**
 * One model request as the token log keeps it: which session asked, which model answered and how many tokens it
 * took. Never a word of what was said. A request that compacts, sums up, names a session or looks at a picture is
 * logged too, which the replies kept in a session cannot show.
 */
export interface TokenEntry {
  at: number;
  session: string;
  /** The session a sub-agent worked for. */
  parent?: string;
  cwd: string;
  provider: string;
  model: string;
  /** main: a reply in the conversation; side: any other request the session made. */
  kind: 'main' | 'side';
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** In US dollars at the prices known when it was made; 0 where none were. */
  cost: number;
  /** The provider said nothing of the tokens (a relay that leaves usage out): a request, its tokens not known. */
  unreported?: true;
  /** A reply in the conversation: how long the whole request took and how long its first word took to come, in ms. */
  ms?: number;
  waitMs?: number;
  /** Its reasoning came as no words on the way (a provider that keeps it to itself): those tokens did not stream. */
  hidden?: true;
}

const dir = () => appPath('usage');
const SINCE = 'since.json';

/** A month's file, by the month in UTC: the file a request goes to never depends on where the computer is. */
const monthName = (at: number) => {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
};

/** A count as a non-negative whole number, whatever an older file or another provider wrote there. */
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The usage of one response in the log's terms. */
export function tokens(u: Partial<Usage> | undefined): Pick<TokenEntry, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning'> {
  return { input: count(u?.input), output: count(u?.output), cacheRead: count(u?.cacheRead), cacheWrite: count(u?.cacheWrite), reasoning: count(u?.reasoning) };
}

/**
 * When the log began: requests from then on are all in it, and the replies kept in sessions before then are read
 * from the sessions. Set the first time a runtime starts with this version; kept by whichever process got there first.
 */
export function tokenLogSince(create = false): number | null {
  const file = path.join(dir(), SINCE);
  try {
    const since = JSON.parse(fs.readFileSync(file, 'utf8')).since;
    if (typeof since === 'number' && Number.isFinite(since)) return since;
  } catch {
    // Not begun, or a file cut short: begun again below.
  }
  if (!create) return null;
  const since = Date.now();
  try {
    ensureDir(dir());
    fs.writeFileSync(file, JSON.stringify({ since }), { flag: 'wx' });
    return since;
  } catch {
    // Another process began it a moment ago.
    return tokenLogSince(false) ?? since;
  }
}

/** Add one request. A log that cannot be written never stops the reply it counts. */
export function logTokens(e: TokenEntry): void {
  try {
    ensureDir(dir());
    fs.appendFileSync(path.join(dir(), monthName(e.at)), `${sealLine(JSON.stringify(e))}\n`);
  } catch (error) {
    debug('token-log', 'not written', { error: String(error) });
  }
}

/** A line of the log as an entry, or null when it is not one (cut short by a crash, or written by something else). */
function entryOf(raw: string): TokenEntry | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || typeof v.at !== 'number' || typeof v.model !== 'string') return null;
  return {
    at: v.at,
    session: typeof v.session === 'string' ? v.session : '',
    ...(typeof v.parent === 'string' ? { parent: v.parent } : {}),
    cwd: typeof v.cwd === 'string' ? v.cwd : '',
    provider: typeof v.provider === 'string' ? v.provider : '',
    model: v.model,
    kind: v.kind === 'side' ? 'side' : 'main',
    ...tokens(v as Partial<Usage>),
    cost: money(v.cost),
    ...(v.unreported === true ? { unreported: true as const } : {}),
    ...(count(v.ms) ? { ms: count(v.ms) } : {}),
    ...(count(v.waitMs) ? { waitMs: count(v.waitMs) } : {}),
    ...(v.hidden === true ? { hidden: true as const } : {}),
  };
}

/** Months read before, by file: a month that is over does not change, and the current one is read again as it grows. */
const months = new Map<string, { size: number; mtime: number; entries: TokenEntry[] }>();

/** Every request logged since `from` (ms), oldest month first. */
export async function readTokenLog(from = 0): Promise<TokenEntry[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(dir())).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
  } catch {
    return [];
  }
  // A month before the one `from` falls in holds nothing after it.
  const first = from > 0 ? monthName(from) : '';
  const out: TokenEntry[] = [];
  for (const name of names) {
    if (name < first) continue;
    const file = path.join(dir(), name);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch {
      continue;
    }
    let known = months.get(file);
    if (!known || known.size !== stat.size || known.mtime !== stat.mtimeMs) {
      let text: string;
      try {
        text = openLines(await fsp.readFile(file, 'utf8'));
      } catch (error) {
        debug('token-log', 'month not read', { name, error: String(error) });
        continue;
      }
      const entries = text.split('\n').flatMap((l) => (l.trim() ? (entryOf(l) ?? []) : []));
      known = { size: stat.size, mtime: stat.mtimeMs, entries };
      months.set(file, known);
    }
    for (const e of known.entries) if (e.at >= from) out.push(e);
  }
  return out;
}
