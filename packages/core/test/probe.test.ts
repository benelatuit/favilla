import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkTool } from '../src/tools/check';
import { partialReverts, probeChanges } from '../src/tools/probe';
import { detectShell } from '../src/tools/shell';
import type { ToolContext } from '../src/tools/types';

const roots: string[] = [];
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true, maxRetries: 5 })));
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-probe-test-'));
  roots.push(cwd);
  const before = 'exports.a = () => 1;\n\n// independent b\nexports.b = () => 1;\n\n// independent c\nexports.c = () => 1;\n';
  const after = before.replaceAll('=> 1', '=> 2');
  fs.writeFileSync(path.join(cwd, 'calc.cjs'), after);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/*.test.cjs' } }));
  fs.mkdirSync(path.join(cwd, 'test'));
  fs.writeFileSync(path.join(cwd, 'test/calc.test.cjs'), `
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const calc = require('../calc.cjs');
console.log('PROBE_CWD:' + process.cwd());
fs.writeFileSync('last-run.txt', process.cwd());
test('a', () => assert.equal(calc.a(), 2));
`);
  const originals = new Map([[path.join(cwd, 'calc.cjs'), Buffer.from(before)]]);
  const controller = new AbortController();
  const ctx = {
    cwd, sessionId: `probe-${process.pid}`, callId: 'c1', turn: 't1', signal: controller.signal,
    config: { beforeTests: false, memoryGuard: false, bashTimeoutMs: 10_000 }, shell: detectShell(),
    outputChars: 30_000, outputDir: path.join(cwd, '.favilla/outputs'), progress: () => {},
    checkpoints: { turns: () => ['t1'], files: () => [...originals.keys()], originals: () => originals },
  } as unknown as ToolContext;
  return { cwd, before, after, originals, ctx, controller };
}

describe('opt-in partial-revert probes', () => {
  it('does no additional work by default; samples at most two independent changes when requested', async () => {
    const f = fixture();
    const normal = await checkTool.execute({ only: ['test'] }, f.ctx);
    expect(normal.isError).toBe(false);
    expect(normal.display?.kind === 'checks' && normal.display.probe).toBeUndefined();
    const probed = await checkTool.execute({ only: ['test'], probe: true }, f.ctx);
    expect(probed.isError).toBe(false);
    if (probed.display?.kind !== 'checks') throw new Error('missing checks');
    expect(probed.display.probe?.results.map((r) => r.outcome)).toEqual(['detected', 'survived']);
    expect(probed.content).toContain('not proof of a defect');
    expect(fs.readFileSync(path.join(f.cwd, 'calc.cjs'), 'utf8')).toBe(f.after);
    expect(fs.readFileSync(path.join(f.cwd, 'last-run.txt'), 'utf8')).toBe(f.cwd);
    for (const r of probed.display.probe!.results) {
      const log = fs.readFileSync(r.logPath!, 'utf8');
      const root = /PROBE_CWD:(.+)/.exec(log)?.[1].trim();
      expect(root).toBeTruthy();
      expect(root).not.toBe(f.cwd);
      expect(fs.existsSync(root!)).toBe(false);
    }
  }, 60_000);

  it('preserves CRLF and a missing final newline while reverting insertions and deletions separately', () => {
    const f = fixture();
    const file = path.join(f.cwd, 'calc.cjs');
    const before = 'first\r\nremoved\r\nmiddle\r\nlast';
    const after = 'first\r\nmiddle\r\ninserted\r\nlast';
    fs.writeFileSync(file, after);
    const variants = partialReverts(f.cwd, new Map([[file, Buffer.from(before)]]));
    expect(variants.map((v) => v.content)).toEqual(['first\r\nremoved\r\nmiddle\r\ninserted\r\nlast', 'first\r\nmiddle\r\nlast']);
  });

  it('does not repeat the existing all-old-code check when there is only one changed hunk', () => {
    const f = fixture();
    const file = path.join(f.cwd, 'calc.cjs');
    fs.writeFileSync(file, 'exports.a = () => 2;\n');
    expect(partialReverts(f.cwd, new Map([[file, Buffer.from('exports.a = () => 1;\n')]]))).toEqual([]);
  });

  it('treats a compilation failure as inconclusive rather than a discriminating test', async () => {
    const f = fixture();
    f.originals.set(path.join(f.cwd, 'calc.cjs'), Buffer.from(f.before.replace('exports.a = () => 1;', 'exports.a = (;')));
    const out = await checkTool.execute({ only: ['test'], probe: true }, f.ctx);
    if (out.display?.kind !== 'checks') throw new Error('missing checks');
    expect(out.display.probe?.results[0].outcome).toBe('inconclusive');
    expect(fs.readFileSync(path.join(f.cwd, 'calc.cjs'), 'utf8')).toBe(f.after);
  }, 60_000);

  it('does not run probes after a failing or interrupted check, or combine before with probe', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.cwd, 'calc.cjs'), f.before);
    const failed = await checkTool.execute({ only: ['test'], probe: true }, f.ctx);
    expect(failed.isError).toBe(true);
    expect(failed.display?.kind === 'checks' && failed.display.probe?.results).toEqual([]);
    expect((await checkTool.execute({ before: true, probe: true }, f.ctx)).isError).toBe(true);
    f.controller.abort();
    const stopped = await checkTool.execute({ only: ['test'], probe: true }, f.ctx);
    expect(stopped.isError).toBe(true);
    expect(stopped.content).toContain('interrupted');
  }, 60_000);

  it('cleans up when interrupted after copying, before a variant runs', async () => {
    const f = fixture();
    const mkdir = vi.spyOn(fs, 'mkdtempSync');
    f.ctx.progress = (text) => { if (text.includes('(probe 1:')) f.controller.abort(); };
    try {
      const report = await probeChanges(f.ctx, f.cwd, 'node --test test/*.test.cjs');
      expect(report.results).toEqual([]);
      expect(report.skipped).toContain('interrupted');
      expect(mkdir).toHaveBeenCalledOnce();
      expect(fs.existsSync(mkdir.mock.results[0].value)).toBe(false);
      expect(fs.readFileSync(path.join(f.cwd, 'calc.cjs'), 'utf8')).toBe(f.after);
      expect(fs.existsSync(path.join(f.cwd, 'last-run.txt'))).toBe(false);
    } finally {
      mkdir.mockRestore();
    }
  });
});
