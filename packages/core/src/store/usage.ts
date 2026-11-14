import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { appPath, projectSlug } from '../util/paths';
import { confirmSweep, measure, sweepConfirmed, sweepScratch, SCRATCH_RULES } from './scratch';
import { dataKey, isSealed, keyPlace, seal, sealing, unseal } from './seal';
import type { SessionStore } from './sessions';

/** What Favilla's own folder holds, part by part, for the settings page. */
export interface StorageView {
  at: number;
  total: number;
  sessions: { bytes: number; count: number };
  blobs: { bytes: number; files: number };
  /** reclaimable: what the size rules would take now (a dry run); confirmed: they run by themselves every day. */
  scratch: { bytes: number; projects: { folder: string; bytes: number; entries: number }[]; reclaimable: { bytes: number; entries: number }; confirmed: boolean };
  browser: { bytes: number; cache: number };
  other: number;
}

/** Chrome's caches in the browser profile: safe to delete, the sign-ins (cookies, local storage) stay. */
const BROWSER_CACHES = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', path.join('Service Worker', 'CacheStorage'), path.join('Service Worker', 'ScriptCache')];
const browserCacheDirs = (root: string) => [path.join(root, 'GrShaderCache'), path.join(root, 'ShaderCache'), path.join(root, 'GraphiteDawnCache'), ...BROWSER_CACHES.map((d) => path.join(root, 'Default', d))];

async function dirs(p: string): Promise<string[]> {
  try {
    return (await fsp.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

let cached: StorageView | null = null;

/** Measure Favilla's folder; a minute-old measurement is reused (a big folder takes a while to walk). */
export async function storageView(store: SessionStore, fresh = false): Promise<StorageView> {
  if (cached && !fresh && Date.now() - cached.at < 60_000) return cached;
  const root = appPath();
  const [all, sessions, blobs, browser] = await Promise.all([measure(root), measure(store.root), measure(store.blobs.root), measure(appPath('browser-profile'))]);
  let cache = 0;
  for (const d of browserCacheDirs(appPath('browser-profile'))) cache += (await measure(d)).bytes;
  // Scratch folders by project, named by the folder their sessions work in.
  const folders = new Map(store.list({ limit: 5000 }).filter((m) => m.cwd).map((m) => [projectSlug(m.cwd), m.cwd]));
  const projects: StorageView['scratch']['projects'] = [];
  const reclaimable = { bytes: 0, entries: 0 };
  for (const slug of await dirs(appPath('projects'))) {
    const dir = appPath('projects', slug, 'scratch');
    if (!fs.existsSync(dir)) continue;
    // One walk gives both: the folder's size and what the size rules would take from it.
    const would = await sweepScratch(dir, SCRATCH_RULES, Date.now(), true);
    if (!would.total) continue;
    projects.push({ folder: folders.get(slug) ?? slug, bytes: would.total, entries: would.kept + would.removed });
    reclaimable.bytes += would.freed;
    reclaimable.entries += would.removed;
  }
  projects.sort((a, b) => b.bytes - a.bytes);
  const scratch = projects.reduce((n, p) => n + p.bytes, 0);
  cached = {
    at: Date.now(),
    total: all.bytes,
    sessions: { bytes: sessions.bytes, count: store.list({ limit: 100_000 }).length },
    blobs: { bytes: blobs.bytes, files: blobs.files },
    scratch: { bytes: scratch, projects: projects.slice(0, 8), reclaimable, confirmed: sweepConfirmed() },
    browser: { bytes: browser.bytes, cache },
    other: Math.max(0, all.bytes - sessions.bytes - blobs.bytes - scratch - browser.bytes),
  };
  return cached;
}

/**
 * Make room on request. scratch: every project's scratch entries untouched for six hours; sessions: compress the
 * sessions not open and drop the pictures and outputs no session refers to; browser: Chrome's caches, sign-ins kept.
 */
export async function cleanStorage(store: SessionStore, what: string, open: Set<string>): Promise<{ removed: number; freed: number }> {
  let removed = 0;
  let freed = 0;
  if (what === 'scratch-rules') {
    // The size rules, now and from now on every day: the user has seen what they take.
    confirmSweep();
    for (const slug of await dirs(appPath('projects'))) {
      const r = await sweepScratch(appPath('projects', slug, 'scratch'), SCRATCH_RULES);
      removed += r.removed;
      freed += r.freed;
    }
  } else if (what === 'scratch') {
    for (const slug of await dirs(appPath('projects'))) {
      const r = await sweepScratch(appPath('projects', slug, 'scratch'), { ...SCRATCH_RULES, maxAgeDays: SCRATCH_RULES.keepHours / 24, capBytes: 0 });
      removed += r.removed;
      freed += r.freed;
    }
  } else if (what === 'sessions') {
    const before = (await measure(store.root)).bytes;
    removed += await store.freezeIdle(open, 60_000);
    const gc = await store.collectGarbage(true);
    removed += gc.removed;
    freed += gc.freed + Math.max(0, before - (await measure(store.root)).bytes);
  } else if (what === 'browser') {
    for (const d of browserCacheDirs(appPath('browser-profile'))) {
      const m = await measure(d);
      if (!m.files) continue;
      try {
        await fsp.rm(d, { recursive: true, force: true, maxRetries: 2 });
        removed += m.files;
        freed += m.bytes;
      } catch {
        // Held by Favilla's browser while it runs: what could go has gone.
      }
    }
  } else if (what === 'seal') {
    // Seal what was written before sealing was on: sessions not open are put away (sealed whole), the list of
    // sessions is written again, and each older file is checked to open back to the same bytes first.
    removed += await store.freezeIdle(open, 60_000);
    store.flushIndex(true);
    const files: string[] = [];
    for (const slug of await dirs(store.root)) for (const n of await fsp.readdir(path.join(store.root, slug)).catch(() => [] as string[])) if (n.endsWith('.jsonl.br') && !open.has(n.slice(0, -'.jsonl.br'.length))) files.push(path.join(store.root, slug, n));
    for (const d of await dirs(store.blobs.root)) for (const n of await fsp.readdir(path.join(store.blobs.root, d)).catch(() => [] as string[])) if (/^[0-9a-f]{40}\.(br|bin)$/.test(n)) files.push(path.join(store.blobs.root, d, n));
    for (const f of files) {
      try {
        const raw = await fsp.readFile(f);
        if (isSealed(raw)) continue;
        const sealed = seal(raw);
        if (!isSealed(sealed) || !unseal(sealed).equals(raw)) break;
        const tmp = `${f}.${process.pid}.seal`;
        await fsp.writeFile(tmp, sealed);
        await fsp.rename(tmp, f);
        removed++;
      } catch {
        /* in use: next time */
      }
    }
  } else throw new Error(`Nothing to clean called "${what}".`);
  cached = null;
  return { removed, freed };
}

/** How sealing stands, for the settings page; place is where the key is kept (see keyPlace). */
export function sealView(): { on: boolean; key: 'ready' | 'none' | 'unreadable'; place: string | null } {
  const k = dataKey(false);
  const place = keyPlace();
  return { on: sealing(), key: k ? 'ready' : place ? 'unreadable' : 'none', place };
}
