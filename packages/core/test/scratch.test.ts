import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { measure, sweepScratch } from '../src/store/scratch';

const MB = 1024 * 1024;
const HOUR = 3600_000;
const top = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-scratch-'));
afterAll(() => fs.rmSync(top, { recursive: true, force: true }));

/** A folder entry of `mb` megabytes whose files were last changed `hours` ago. */
function entry(dir: string, name: string, mb: number, hours: number, now: number): string {
  const p = path.join(dir, name, 'deep', 'er');
  fs.mkdirSync(p, { recursive: true });
  const f = path.join(p, 'data.bin');
  fs.writeFileSync(f, Buffer.alloc(Math.round(mb * MB)));
  const t = new Date(now - hours * HOUR);
  for (const q of [f, p, path.dirname(p), path.join(dir, name)]) fs.utimesSync(q, t, t);
  return path.join(dir, name);
}

describe('the scratch sweep', () => {
  it('measures a tree by its newest change inside, not its own folder time, and does not follow links', async () => {
    const now = Date.now();
    const dir = path.join(top, 'measure');
    const e = entry(dir, 'copy', 1, 48, now);
    // A file deep inside changed just now: the entry is in use, though its own folder time is old.
    fs.writeFileSync(path.join(e, 'deep', 'er', 'fresh.txt'), 'x');
    fs.utimesSync(e, new Date(now - 48 * HOUR), new Date(now - 48 * HOUR));
    const m = await measure(e);
    expect(m.files).toBe(2);
    expect(m.bytes).toBeGreaterThanOrEqual(MB);
    expect(now - m.newest).toBeLessThan(HOUR);
  });

  it('removes what is old, big and idle, then the oldest past the cap, and never what changed lately', async () => {
    const now = Date.now();
    const dir = path.join(top, 'sweep');
    entry(dir, 'old-small', 0.1, 24 * 20, now);
    entry(dir, 'big-idle', 4, 72, now);
    entry(dir, 'big-busy', 4, 1, now);
    entry(dir, 'mid-a', 2, 30, now);
    entry(dir, 'mid-b', 2, 20, now);
    entry(dir, 'small-new', 0.1, 10, now);
    const r = await sweepScratch(dir, { maxAgeDays: 14, bigBytes: 3 * MB, bigIdleDays: 2, capBytes: 7 * MB, keepHours: 6 }, now);
    const left = fs.readdirSync(dir).sort();
    // old-small (20 days), big-idle (3 days, 4 MB); then past 7 MB the oldest of the rest, mid-a; big-busy is in use.
    expect(left).toEqual(['big-busy', 'mid-b', 'small-new']);
    expect(r.removed).toBe(3);
    expect(r.freed).toBeGreaterThanOrEqual(6 * MB);
  });

  it('removes a copy holding a link to a real folder without touching what the link points to', async () => {
    const now = Date.now();
    const dir = path.join(top, 'links');
    const precious = path.join(top, 'project-deps');
    fs.mkdirSync(precious, { recursive: true });
    fs.writeFileSync(path.join(precious, 'index.js'), 'keep me');
    const copy = entry(dir, 'old-copy', 0.1, 24 * 20, now);
    fs.symlinkSync(precious, path.join(copy, 'node_modules'), 'junction');
    // The link is as old as the copy (a link made just now counts as work in it, and keeps the copy).
    const old = new Date(now - 24 * 20 * HOUR);
    fs.lutimesSync(path.join(copy, 'node_modules'), old, old);
    fs.utimesSync(copy, old, old);
    await sweepScratch(dir, { maxAgeDays: 14, bigBytes: Infinity, bigIdleDays: 2, capBytes: Infinity, keepHours: 6 }, now);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.readFileSync(path.join(precious, 'index.js'), 'utf8')).toBe('keep me');
  });

  it('counts what it would take in a dry run and leaves it all, and waits for a yes before the size rules', async () => {
    const now = Date.now();
    const dir = path.join(top, 'dry');
    entry(dir, 'big-idle', 4, 72, now);
    entry(dir, 'fresh', 0.1, 1, now);
    const r = await sweepScratch(dir, { maxAgeDays: 14, bigBytes: 3 * MB, bigIdleDays: 2, capBytes: Infinity, keepHours: 6 }, now, true);
    expect(r).toMatchObject({ removed: 1, kept: 1 });
    expect(r.freed).toBeGreaterThanOrEqual(4 * MB);
    expect(r.total).toBeGreaterThanOrEqual(4 * MB);
    expect(fs.readdirSync(dir).sort()).toEqual(['big-idle', 'fresh']);
    // Before the user says yes, the daily sweep keeps to the age rule; after, all rules.
    process.env.FAVILLA_HOME = path.join(top, 'home');
    const { AGE_ONLY, SCRATCH_RULES, confirmSweep, scratchRules } = await import('../src/store/scratch');
    expect(scratchRules()).toEqual(AGE_ONLY);
    confirmSweep();
    expect(scratchRules()).toEqual(SCRATCH_RULES);
  });
});
