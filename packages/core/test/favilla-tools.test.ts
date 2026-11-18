import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readManyTool, searchTool } from '../src/tools/favilla-tools';
import { recallTool } from '../src/tools/recall';
import { findBrowser } from '../src/tools/browser';
import { imageWorker } from '../src/tools/image';
import { editTool, patchTool } from '../src/tools/fs-tools';
import { buildTools, type ProfileContext } from '../src/tools/profiles';
import { hasNotebooks } from '../src/tools/notebook';
import { FileTracker } from '../src/tools/filestate';
import { Checkpoints } from '../src/agent/checkpoints';
import { BlobStore } from '../src/store/blobs';
import type { ToolContext } from '../src/tools/types';
import type { ShellInfo } from '../src/tools/shell';

let root: string;
let ctx: ToolContext;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-tools-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), Array.from({ length: 50 }, (_, i) => `export const a${i + 1} = ${i + 1};`).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'import { a1 } from "./a";\nexport function twice() {\n  return a1 * 2;\n}\n');
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\nnothing here\n');
  ctx = {
    cwd: root,
    sessionId: 's',
    callId: 'c',
    turn: 't',
    signal: new AbortController().signal,
    model: { vision: true } as ToolContext['model'],
    config: {} as ToolContext['config'],
    shell: { kind: 'bash', path: 'bash', label: 'bash' } as ShellInfo,
    mode: 'build',
    outputChars: 40_000,
    outputDir: path.join(root, '.out'),
    files: new FileTracker(),
    checkpoints: new Checkpoints(path.join(root, '.cp'), new BlobStore(path.join(root, '.blobs'))),
    jobs: {} as ToolContext['jobs'],
    progress: () => {},
    setTodos: () => {},
    goal: () => undefined,
    setGoal: () => {},
    makeBrief: async () => { throw new Error('Unexpected brief call'); },
    ask: async () => null,
    approvePlan: async () => null,
    setMode: () => {},
    runSubagent: async () => ({}) as never,
    proxy: false,
  };
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("Favilla's own tools", () => {
  it('lists exact byte sizes and bounded line counts without changing the paths for the UI', async () => {
    const folder = path.join(root, 'sizes');
    fs.mkdirSync(folder);
    for (const [name, bytes] of Object.entries({ 'empty.txt': '', 'short.txt': 'a\r\nb', 'big.txt': 'x\n'.repeat(10000), 'raw.txt': '\0\0\0' })) fs.writeFileSync(path.join(folder, name), bytes);
    const result = await readManyTool.execute({ paths: [folder] }, ctx);
    expect(result.content).toContain('empty.txt  0 B, 0 lines');
    expect(result.content).toContain('big.txt  20000 B, 4096+ lines');
    expect(result.content).toContain('short.txt  4 B, 2 lines');
    expect(result.content).not.toContain('raw.txt  3 B,');
    expect(result.display).toMatchObject({ items: ['big.txt', 'empty.txt', 'raw.txt', 'short.txt'] });
  });
  it('reads several files and line ranges in one call', async () => {
    const r = await readManyTool.execute({ paths: ['src/a.ts:10-12', 'src/b.ts', 'src'] }, ctx);
    expect(r.content).toContain('==> src/a.ts:10 <==');
    expect(r.content).toMatch(/ {4}10\texport const a10 = 10;/);
    expect(r.content).not.toContain('a13 =');
    expect(r.content).toContain('Read further with a range, e.g. "src/a.ts:START-END".');
    expect(r.content).toContain('==> src/b.ts <==');
    expect(r.content).toContain('return a1 * 2;');
    expect(r.content).toMatch(/==> src <==\nsrc is a directory with 2 entries/);
    const one = await readManyTool.execute({ paths: ['src/a.ts:49'] }, ctx);
    expect(one.content).toMatch(/49\texport const a49/);
    expect(one.content).toContain('a50');
  });

  it('reads tails and explicit whole files under the same budget, even after a preview', async () => {
    const local = { ...ctx, inContext: () => true, files: new FileTracker() };
    const file = 'ids.csv';
    fs.writeFileSync(path.join(root, file), Array.from({ length: 2120 }, (_, i) => String(i)).join('\n') + '\n');
    await readManyTool.execute({ paths: [file] }, local);
    expect((await readManyTool.execute({ paths: [file + ':-2'] }, local)).content).toMatch(/2119\t2118\n\s*2120\t2119$/);
    const smallTail = await readManyTool.execute({ paths: [file], tail: 100 }, { ...local, files: new FileTracker(), outputChars: 40 });
    expect(smallTail.content).toContain('2120\t2119');
    expect(smallTail.content).toContain('final lines');
    const partial = await readManyTool.execute({ paths: [file], full: true }, { ...local, outputChars: 80 });
    expect(partial.content).toMatch(/output limit reached/);
    expect(local.files.readWhole(path.join(root, file))).toBe(false);
    for (const request of [{ paths: [file + ':full'] }, { paths: [file], full: true }]) {
      const whole = await readManyTool.execute(request, local);
      expect(whole.content).toMatch(/^\s*1\t0\n/);
      expect(whole.content).toMatch(/2120\t2119$/);
    }
    expect((await readManyTool.execute({ paths: [file, 'notes.md'], full: true }, local)).isError).toBe(true);
    expect((await readManyTool.execute({ paths: [file + ':-0'] }, local)).isError).toBe(true);
  });

  it('samples large record files by default and reads explicit ranges exactly', async () => {
    const files = new FileTracker();
    const wide = { ...ctx, files, outputChars: 89_600 };
    const csv = Array.from({ length: 2500 }, (_, i) => i ? `${i},${'a'.repeat(54)}` : 'id,label');
    const jsonl = Array.from({ length: 11311 }, (_, i) => JSON.stringify({ n: i, value: 'b'.repeat(35) }));
    fs.writeFileSync(path.join(root, 'records.csv'), csv.join('\n'));
    fs.writeFileSync(path.join(root, 'items.ndjson'), jsonl.join('\n'));
    const { content } = await readManyTool.execute({ paths: ['records.csv', 'items.ndjson'] }, wide);
    expect(content.length).toBeLessThan(2000);
    expect(content.length).toMatchInlineSnapshot(`1194`);
    expect(content).toContain(csv[0]);
    expect(content).toContain(jsonl[3]);
    expect(content).not.toContain(jsonl[15]);
    expect(content).toContain('11311');
    expect(files.coverage().map((c) => c.ranges)).toEqual([[[1, 8]], [[1, 8]]]);
    const range = await readManyTool.execute({ paths: ['records.csv:2499-2500', 'items.ndjson:11311'] }, wide);
    expect(range.content).toContain(csv.at(-1));
    expect(range.content).toContain(jsonl.at(-1));
    fs.writeFileSync(path.join(root, 'short.tsv'), 'x\ty\n3\t4');
    expect((await readManyTool.execute({ paths: ['short.tsv'] }, wide)).content).toContain('3\t4');
    fs.writeFileSync(path.join(root, 'wide.jsonl'), jsonl.map((l, i) => i ? l : JSON.stringify('z'.repeat(20000))).join('\n'));
    const largeLine = await readManyTool.execute({ paths: ['wide.jsonl'] }, wide);
    expect(largeLine.content.length).toBeLessThan(2400);
    expect(files.coverage().find((c) => c.path.endsWith('wide.jsonl'))?.ranges ?? []).toEqual([]);
    expect((await readManyTool.execute({ paths: ['wide.jsonl:1-1'] }, wide)).content).toContain('z'.repeat(20000));
  });

  it('returns a wide line intact on an explicit read, including after a partial preview', async () => {
    const file = path.join(root, 'packed.json');
    const row = JSON.stringify({ payload: 'x'.repeat(8000), marker: 'tail-check' });
    fs.writeFileSync(file, `header\n${row}\nend`);
    const local = { ...ctx, files: new FileTracker(), inContext: () => true };
    const first = await readManyTool.execute({ paths: [file] }, local);
    expect(first.content).not.toContain('tail-check');
    expect(local.files.readWhole(file)).toBe(false);
    const tooWide = await readManyTool.execute({ paths: [`${file}:2-2`] }, { ...local, outputChars: 8000 });
    expect(tooWide.content).toContain('on disk');
    expect(local.files.readWhole(file)).toBe(false);
    const whole = await readManyTool.execute({ paths: [`${file}:1-3`] }, local);
    expect(whole.content).toContain(row);
    expect(local.files.readWhole(file)).toBe(true);
  });

  it('previews uniform record streams but preserves prose and explicit middle rows', async () => {
    const local = { ...ctx, files: new FileTracker() };
    for (const [name, line] of [['export.dat', 'part42|queued|4'], ['manifest', 'item-400-zone']]) {
      const rows = Array.from({ length: 510 }, (_, i) => line.replace(/4/, String(i + 100)));
      fs.writeFileSync(path.join(root, name), rows.join('\n'));
      expect((await readManyTool.execute({ paths: [name] }, local)).content).toContain('Lines 1-8 of 510');
      expect((await readManyTool.execute({ paths: [`${name}:309-309`] }, local)).content).toContain(rows[308]);
    }
    const prose = Array.from({ length: 500 }, (_, i) => `Clause ${i}. Each item remains subject to review.`);
    prose[220] = 'A written waiver changes the due date.';
    fs.writeFileSync(path.join(root, 'terms.txt'), prose.join('\n'));
    expect((await readManyTool.execute({ paths: ['terms.txt'] }, local)).content).toContain(prose[220]);
  });

  it('batches up to 40 medium files whole in one call, stops cleanly on tight budgets, and recalls one file section by call_id + query', async () => {
    const dir = path.join(root, 'batch');
    fs.mkdirSync(dir, { recursive: true });
    const paths: string[] = [];
    for (let i = 1; i <= 34; i++) {
      const name = `m${String(i).padStart(2, '0')}.py`;
      const lines = Array.from({ length: 85 }, (_, k) => `def f_${i}_${k}(): return "${name}:line${k + 1}:${'x'.repeat(32)}"`);
      fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`);
      paths.push(`batch/${name}`);
    }
    const wide = { ...ctx, files: new FileTracker(), outputChars: 89_600 };
    const all = await readManyTool.execute({ paths: [...paths, paths[0]] }, wide);
    expect(all.isError).toBeFalsy();
    expect(all.content).not.toContain('output limit reached');
    expect(all.content).toContain('m01.py:line85:');
    expect(all.content).toContain('m34.py:line85:');
    expect(all.content.match(/==> batch\/m01\.py <==/g)?.length).toBe(1);

    const tight = { ...ctx, files: new FileTracker(), outputChars: 8_000 };
    const capped = await readManyTool.execute({ paths: paths.slice(0, 12) }, tight);
    expect(capped.content).toMatch(/\[Read \d+ of 12 files \(output limit reached\); ask for the rest in another call\.\]/);
    expect(capped.content).toContain('m01.py:line85:');

    const blobs = new BlobStore(path.join(root, '.blobs-recall'));
    const history = [
      { id: 'm1', time: 1, role: 'assistant' as const, parts: [{ type: 'tool_call' as const, id: 'call_batch', name: 'read', input: { paths } }] },
      { id: 'm2', time: 2, role: 'user' as const, parts: [{ type: 'tool_result' as const, callId: 'call_batch', name: 'read', content: all.content }] },
    ];
    const rctx = { ...ctx, outputChars: 30_000, blobs, history: () => history };
    const picked = await recallTool.execute({ callId: 'call_batch', query: 'm28.py' }, rctx);
    expect(picked.content).toContain('==> batch/m28.py <==');
    expect(picked.content).toContain('m28.py:line85:');
    expect(picked.content).not.toContain('==> batch/m01.py <==');

    const paged = await recallTool.execute({ callId: 'call_batch' }, rctx);
    expect(paged.content).toContain('pass query="<path>" or from=N');
    expect(paged.content).toContain('batch/m28.py@');
  });

  it.skipIf(!findBrowser())('takes the same region of every picture read together', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mPYmiqLFTEMLQkAh4pNwcwO4KQAAAAASUVORK5CYII=', 'base64');
    for (const name of ['rest.png', 'pressed.png']) fs.writeFileSync(path.join(root, name), png);
    try {
      const r = await readManyTool.execute({ paths: ['rest.png', 'pressed.png'], region: [2, 2, 4, 4] }, ctx);
      expect(r.content).toContain('Region [2, 2, 4, 4] of rest.png');
      expect(r.content).toContain('Region [2, 2, 4, 4] of pressed.png');
      expect(r.images?.map((i) => i.name)).toEqual(['rest.png [2, 2, 4, 4]', 'pressed.png [2, 2, 4, 4]']);
    } finally {
      imageWorker.close();
    }
  });

  it('searches contents grouped by file, and names with a glob alone', async () => {
    const r = await searchTool.execute({ pattern: 'a1\\b' }, ctx);
    expect(r.content).toMatch(/^3 matching lines in 2 files:/);
    expect(r.content).toMatch(/src\/a\.ts\n1:export const a1 = 1;/);
    expect(r.content).toMatch(/src\/b\.ts\n1:import \{ a1 \}/);
    const files = await searchTool.execute({ glob: '*.ts' }, ctx);
    expect(files.content).toContain('2 files');
    const none = await searchTool.execute({}, ctx);
    expect(none.isError).toBe(true);
  });

  it('applies several edits to one file at once, writing the ones that match and naming the one that does not', async () => {
    const file = path.join(root, 'src', 'b.ts');
    const before = fs.readFileSync(file, 'utf8');
    const none = await editTool.execute({ path: 'src/b.ts', old: '', new: '', edits: [{ old: 'not in the file', new: 'x' }], requireRead: false }, ctx);
    expect(none.isError).toBe(true);
    expect(none.content).toMatch(/^Edit 1 of 1/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const part = await editTool.execute({ path: 'src/b.ts', old: '', new: '', edits: [{ old: 'twice', new: 'double' }, { old: 'not in the file', new: 'x' }], requireRead: false }, ctx);
    expect(part.isError).toBeFalsy();
    expect(part.content).toMatch(/^Edit 2 of 2/);
    expect(part.content).toContain('The other 1 edit was written');
    expect(fs.readFileSync(file, 'utf8')).toContain('export function double()');
    const ok = await editTool.execute({ path: 'src/b.ts', old: '', new: '', edits: [{ old: 'double', new: 'double' }, { old: 'a1 * 2', new: 'a1 + a1' }], requireRead: false }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(fs.readFileSync(file, 'utf8')).toBe('import { a1 } from "./a";\nexport function double() {\n  return a1 + a1;\n}\n');
    expect(ok.content).toContain('(1 edit)');
    expect(ok.content).toMatch(/2\texport function double\(\)/);
    // Text that already reads as asked is no error.
    const same = await editTool.execute({ path: 'src/b.ts', old: 'a1 + a1', new: 'a1 + a1', requireRead: false }, ctx);
    expect(same.isError).toBeFalsy();
    expect(same.content).toContain('already reads that way');
  });

  it('trims long exact edit echoes to boundary lines while keeping full snippets on fuzzy matches or syntax errors', async () => {
    const file = path.join(root, 'src', 'long-edit.ts');
    const initial = [
      ...Array.from({ length: 10 }, (_, i) => `export const head${i + 1} = ${i + 1};`),
      'export function computeTotal(items: number[]) {',
      ...Array.from({ length: 24 }, (_, i) => `  const step${i + 1} = items[${i}] ?? ${i};`),
      '  return step24;',
      '}',
      ...Array.from({ length: 10 }, (_, i) => `export const tail${i + 1} = ${i + 1};`),
    ].join('\n') + '\n';
    fs.writeFileSync(file, initial);

    const oldBody = Array.from({ length: 24 }, (_, i) => `  const step${i + 1} = items[${i}] ?? ${i};`).join('\n');
    const newBody = Array.from({ length: 24 }, (_, i) => `  const step${i + 1} = (items[${i}] ?? ${i}) * 2;`).join('\n');
    const exactRes = await editTool.execute({ path: 'src/long-edit.ts', old: oldBody, new: newBody, requireRead: false }, ctx);
    expect(exactRes.isError).toBeFalsy();
    expect(exactRes.content).toContain('lines written as given');
    expect(exactRes.content).toContain('const step1 = (items[0] ?? 0) * 2;');
    expect(exactRes.content).toContain('const step24 = (items[23] ?? 23) * 2;');
    expect(exactRes.content).not.toContain('const step12 =');

    // Indentation-adjusted fuzzy match shows the full region so adjusted lines can be verified.
    const misindentedOld = newBody.split('\n').map((l) => `  ${l}`).join('\n');
    const fuzzyNew = Array.from({ length: 24 }, (_, i) => `    const step${i + 1} = (items[${i}] ?? ${i}) + 1;`).join('\n');
    const fuzzyRes = await editTool.execute({ path: 'src/long-edit.ts', old: misindentedOld, new: fuzzyNew, requireRead: false }, ctx);
    expect(fuzzyRes.isError).toBeFalsy();
    expect(fuzzyRes.content).toContain('matched ignoring indentation');
    expect(fuzzyRes.content).not.toContain('lines written as given');
    expect(fuzzyRes.content).toContain('const step12 = (items[11] ?? 11) + 1;');
  });

  it("keeps a sub-agent's file limits on edits that need no read first", async () => {
    const file = path.join(root, 'notes.md');
    const before = fs.readFileSync(file, 'utf8');
    const held = { ...ctx, mayChange: (abs: string) => (abs === file ? 'notes.md belongs to another agent.' : null) };
    const r = await editTool.execute({ path: 'notes.md', old: 'nothing here', new: 'changed', requireRead: false }, held);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('belongs to another agent');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('applies the sections of one patch in order, two for one file and an added file updated after', async () => {
    fs.writeFileSync(path.join(root, 'p.txt'), 'one\ntwo\nthree\n');
    const patch = ['*** Begin Patch', '*** Update File: p.txt', '@@', '-one', '+ONE', '*** Update File: p.txt', '@@', '-three', '+THREE', '*** Add File: q.txt', '+first', '*** Update File: q.txt', '@@', '-first', '+second', '*** End Patch'].join('\n');
    const r = await patchTool.execute({ patch }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(root, 'p.txt'), 'utf8')).toBe('ONE\ntwo\nTHREE\n');
    expect(fs.readFileSync(path.join(root, 'q.txt'), 'utf8').trim()).toBe('second');
  });

  // On Windows and macOS a rename that changes only the letter case is one file: writing the new name and deleting
  // the old one had deleted it, and the tool said it had succeeded (2026-11-06).
  it('renames a file to the same name in other letter case and keeps it', async () => {
    fs.mkdirSync(path.join(root, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ui', 'button.txt'), 'label = "old"\n');
    const patch = ['*** Begin Patch', '*** Update File: ui/button.txt', '*** Move to: ui/Button.txt', '@@', '-label = "old"', '+label = "new"', '*** End Patch'].join('\n');
    const r = await patchTool.execute({ patch }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readdirSync(path.join(root, 'ui'))).toEqual(['Button.txt']);
    expect(fs.readFileSync(path.join(root, 'ui', 'Button.txt'), 'utf8')).toBe('label = "new"\n');
  });

  it('reads a PDF as text, page by page', async () => {
    // A two-page PDF with a text layer, written by hand (no cross-reference table: readers rebuild it).
    const page = (text: string) => `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
      `<< /Length ${page('Hello page one').length} >>\nstream\n${page('Hello page one')}\nendstream`,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
      `<< /Length ${page('Second page text').length} >>\nstream\n${page('Second page text')}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const pdf = `%PDF-1.4\n${objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj`).join('\n')}\ntrailer << /Root 1 0 R /Size 8 >>\n%%EOF\n`;
    fs.writeFileSync(path.join(root, 'doc.pdf'), pdf);
    const all = await readManyTool.execute({ paths: ['doc.pdf'] }, ctx);
    expect(all.isError).toBeFalsy();
    expect(all.content).toMatch(/--- page 1 of 2 ---\nHello page one/);
    expect(all.content).toMatch(/--- page 2 of 2 ---\nSecond page text/);
    const second = await readManyTool.execute({ paths: ['doc.pdf:2'] }, ctx);
    expect(second.content).not.toContain('Hello page one');
    expect(second.content).toContain('Second page text');
    const first = await readManyTool.execute({ paths: ['doc.pdf:1-1'] }, ctx);
    expect(first.content).toContain('Read further with a range, e.g. "doc.pdf:START-END".');
  });

  it('edits notebooks under Claude Code\'s own tool name and parameters', () => {
    const base: ProfileContext = { shell: ctx.shell, cwd: root, timeoutMs: 1000, vision: true, role: 'main', search: 'off', screenshot: false, notebooks: true };
    const nb = buildTools('claude', base).find((b) => b.spec.name === 'NotebookEdit')!;
    expect(nb.normalize({ notebook_path: 'a.ipynb', cell_id: 'x1', new_source: 'print(1)', edit_mode: 'insert' })).toEqual({ path: 'a.ipynb', cell: 'x1', source: 'print(1)', cellType: undefined, mode: 'insert' });
    expect(buildTools('codex', base).map((b) => b.spec.name)).toContain('notebook_edit');
    expect(buildTools('claude', { ...base, role: 'explore' }).map((b) => b.spec.name)).not.toContain('NotebookEdit');
    // Only projects with notebooks get the tool, so the others do not pay for its schema on every step.
    expect(buildTools('claude', { ...base, notebooks: false }).map((b) => b.spec.name)).not.toContain('NotebookEdit');
    expect(hasNotebooks(root)).toBe(false);
    fs.writeFileSync(path.join(root, 'src', 'demo.ipynb'), '{"cells": []}');
    expect(hasNotebooks(root)).toBe(true);
    fs.rmSync(path.join(root, 'src', 'demo.ipynb'));
  });

  it('builds one surface with the same names for every model', () => {
    const base: ProfileContext = { shell: ctx.shell, cwd: root, timeoutMs: 1000, vision: true, role: 'main', search: 'client', screenshot: true };
    const names = buildTools('favilla', base).map((b) => b.spec.name);
    expect(names).toEqual(['shell', 'job', 'read', 'search', 'edit', 'write', 'apply_patch', 'web_fetch', 'check', 'web_search', 'browser', 'paint', 'music', 'film', 'attempts', 'symbols', 'watch', 'agent', 'ask', 'present_plan', 'criteria', 'review', 'brief', 'remember', 'recall']);
    expect(buildTools('favilla', { ...base, notebooks: true }).map((b) => b.spec.name)).toContain('notebook_edit');
    expect(buildTools('favilla', { ...base, role: 'explore' }).map((b) => b.spec.name)).toEqual(['shell', 'job', 'read', 'search', 'web_fetch', 'web_search', 'browser', 'symbols', 'watch']);
    const read = buildTools('favilla', base).find((b) => b.spec.name === 'read')!;
    expect(read.normalize({ path: 'x.ts' })).toMatchObject({ paths: ['x.ts'] });
  });

  it('gives every shell surface multi-line syntax for the shell actually running', () => {
    for (const profile of ['favilla', 'claude', 'codex'] as const) {
      for (const kind of ['bash', 'pwsh', 'cmd'] as const) {
        const base: ProfileContext = { shell: { ...ctx.shell, kind }, cwd: root, timeoutMs: 1000, vision: false, role: 'main', search: 'off', screenshot: false };
        const description = buildTools(profile, base).find((b) => b.def.kind === 'shell')!.spec.description;
        expect(description).toContain('Avoid packing them into python -c');
        expect(description).toContain(kind === 'bash' ? "python - <<'PY'" : kind === 'pwsh' ? "'@ | python -" : 'script file in the scratch folder');
        if (kind !== 'bash') expect(description).not.toContain("<<'PY'");
      }
    }
  });
});

describe('a large file read whole', () => {
  it('comes back as its start and a map of the rest; a range, or a short file, comes back as asked', async () => {
    const big = ['import { thing } from "./thing";', ...Array.from({ length: 599 }, (_, i) => (i % 100 === 50 ? `export function step${i}() {` : `  const v${i} = ${i};`))].join('\n') + '\n';
    fs.writeFileSync(path.join(root, 'src', 'big.ts'), big);
    const whole = await readManyTool.execute({ paths: ['src/big.ts'] }, ctx);
    expect(whole.content).toContain('[Lines 1-80 of 600. The rest of the file defines, by line:]');
    expect(whole.content).toMatch(/\s152 {2}export function step150\(\)/);
    expect(whole.content).not.toContain('const v300 = 300;');
    const range = await readManyTool.execute({ paths: ['src/big.ts:300-302'] }, ctx);
    expect(range.content).toContain('const v300 = 300;');
    const short = await readManyTool.execute({ paths: ['src/a.ts'] }, ctx);
    expect(short.content).toContain('export const a50 = 50;');
  });
});

describe('outline', () => {
  it('maps a file to its definitions with line numbers', async () => {
    const { outline } = await import('../src/tools/outline');
    const ts = ['import x from "y";', '', 'export interface Shape {', '  area(): number;', '}', '', 'export class Square implements Shape {', '  constructor(private side: number) {}', '  area(): number {', '    if (this.side < 0) {', '      return 0;', '    }', '    return this.side ** 2;', '  }', '}', '', 'export const twice = (n: number) => n * 2;', 'export function main() {}'].join('\n');
    const map = outline(ts, '.ts')!;
    expect(map.split('\n').map((l) => l.trim())).toEqual([
      '3  export interface Shape',
      '7  export class Square implements Shape',
      '8    constructor(private side: number) {}',
      '9    area(): number',
      '17  export const twice = (n: number) => n * 2;',
      '18  export function main() {}',
    ]);
    const py = outline('import os\n\nclass Store:\n    def add(self, x):\n        # not a definition\n        return x\n\nasync def main():\n    pass\n', '.py')!;
    expect(py.split('\n').map((l) => l.trim())).toEqual(['3  class Store:', '4      def add(self, x):', '8  async def main():']);
    expect(outline('a,b\n1,2', '.csv')).toBeNull();
  });

  it('reads an outline through read', async () => {
    fs.writeFileSync(path.join(root, 'src', 'big.py'), Array.from({ length: 60 }, (_, i) => `def f${i}(x):\n    return x + ${i}\n`).join('\n'));
    const r = await readManyTool.execute({ paths: ['src/big.py'], outline: true }, ctx);
    expect(r.content).toMatch(/^Outline of src\/big\.py \(\d+ lines; read a range for the code\):/);
    expect(r.content).toContain('def f59(x):');
    expect(r.content).not.toContain('return x');
  });
});
