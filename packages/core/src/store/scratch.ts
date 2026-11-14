import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { appPath } from '../util/paths';

const MB = 1024 * 1024;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface Measured {
  bytes: number;
  files: number;
  /** When anything inside last changed; a folder's own time moves only when its direct entries do. */
  newest: number;
}

/** Size, file count and the newest change inside a file or folder. Links (and Windows junctions) are not followed. */
export async function measure(target: string): Promise<Measured> {
  const out: Measured = { bytes: 0, files: 0, newest: 0 };
  const walk = async (p: string): Promise<void> => {
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      return;
    }
    out.newest = Math.max(out.newest, st.mtimeMs);
    if (st.isSymbolicLink()) return;
    if (!st.isDirectory()) {
      out.bytes += st.size;
      out.files++;
      return;
    }
    let names: string[];
    try {
      names = await fsp.readdir(p);
    } catch {
      return;
    }
    // A few at a time: fast on big trees without holding thousands of handles open.
    for (let i = 0; i < names.length; i += 32) await Promise.all(names.slice(i, i + 32).map((n) => walk(path.join(p, n))));
  };
  await walk(target);
  return out;
}

export interface SweepRules {
  /** Anything untouched this long goes. */
  maxAgeDays: number;
  /** A big entry (a copy of a repository, an install) untouched this long goes. */
  bigBytes: number;
  bigIdleDays: number;
  /** Past this total the oldest entries go, down to it. */
  capBytes: number;
  /** Nothing changed this recently is removed, whatever its size: a session may be working in it. */
  keepHours: number;
}

export const SCRATCH_RULES: SweepRules = { maxAgeDays: 14, bigBytes: 300 * MB, bigIdleDays: 2, capBytes: 3 * 1024 * MB, keepHours: 6 };
/** Until the user has seen what the size rules would take and said yes once, only the age rule runs by itself. */
export const AGE_ONLY: SweepRules = { ...SCRATCH_RULES, bigBytes: Infinity, capBytes: Infinity };

const confirmedFile = () => appPath('scratch-sweep.confirmed');

export function sweepConfirmed(): boolean {
  return fs.existsSync(confirmedFile());
}

/** The user said yes to the size rules (Settings > Storage): from now on the daily sweep applies all of them. */
export function confirmSweep(): void {
  fs.mkdirSync(path.dirname(confirmedFile()), { recursive: true });
  fs.writeFileSync(confirmedFile(), new Date().toISOString());
}

/** The rules the daily sweep runs by itself. */
export function scratchRules(): SweepRules {
  return sweepConfirmed() ? SCRATCH_RULES : AGE_ONLY;
}

/**
 * Clear a scratch folder by its top-level entries: what is old, what is big and idle, then the oldest until it
 * fits its cap. Copies of whole repositories (with their .git, installs and builds) were what filled scratch
 * folders to gigabytes; they are rarely needed after a day or two.
 */
export async function sweepScratch(dir: string, rules: SweepRules = SCRATCH_RULES, now = Date.now(), dryRun = false): Promise<{ removed: number; freed: number; kept: number; total: number }> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return { removed: 0, freed: 0, kept: 0, total: 0 };
  }
  const items: (Measured & { p: string; gone?: boolean })[] = [];
  for (const name of names) items.push({ p: path.join(dir, name), ...(await measure(path.join(dir, name))) });
  let removed = 0;
  let freed = 0;
  // A dry run counts what would go and leaves everything where it is.
  const drop = async (it: (typeof items)[number]) => {
    try {
      if (!dryRun) await fsp.rm(it.p, { recursive: true, force: true, maxRetries: 2 });
      it.gone = true;
      removed++;
      freed += it.bytes;
    } catch {
      /* in use: next time */
    }
  };
  for (const it of items) {
    const idle = now - it.newest;
    if (idle < rules.keepHours * HOUR) continue;
    if (idle > rules.maxAgeDays * DAY || (it.bytes >= rules.bigBytes && idle > rules.bigIdleDays * DAY)) await drop(it);
  }
  let total = items.filter((i) => !i.gone).reduce((n, i) => n + i.bytes, 0);
  for (const it of items.filter((i) => !i.gone).sort((a, b) => a.newest - b.newest)) {
    if (total <= rules.capBytes) break;
    if (now - it.newest < rules.keepHours * HOUR) continue;
    await drop(it);
    if (it.gone) total -= it.bytes;
  }
  return { removed, freed, kept: items.filter((i) => !i.gone).length, total: items.reduce((n, i) => n + i.bytes, 0) };
}
