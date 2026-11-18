import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileDigest } from '../src/tools/filestate';

// After a compaction every file's read state was dropped and the model told to read the recent ones again, though
// their text could sit in the rounds the compaction kept word for word (2026-11-06).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-compaction-reads-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });

const bodies: string[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    bodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = '<summary>The parser work so far, summarized for the test.</summary>';
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 50 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;
beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', languageServers: false, providers: { fake: { api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 100_000, family: 'gpt' } } } } }),
  );
  rt = createRuntime(project, { interactive: false });
});
afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Files {
  recordRead(p: string): void;
  recordWrite(p: string): void;
  recordShown(p: string, callId: string, start: number, end: number, total: number): void;
  checkEditable(p: string): string | null;
}
type S = { push(m: unknown): void; compact(r: string): Promise<boolean>; files: Files; active(): { origin?: string; parts: { type: string; text?: string }[] }[] };

let n = 0;
/** A read of one file as the read tool records it: its lines shown, and the read's evidence on the result. */
function read(s: S, file: string) {
  const id = `c${++n}`;
  const text = fs.readFileSync(file, 'utf8');
  s.files.recordRead(file);
  s.files.recordShown(file, id, 1, 1, 1);
  s.push({ id: `a${id}`, role: 'assistant', parts: [{ type: 'tool_call', id, name: 'read', input: { paths: [file] } }], time: n });
  s.push({ id: `r${id}`, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: id, name: 'read', content: `1\t${text}`, evidence: { reads: [{ path: file, digest: fileDigest(file), total: 1, ranges: [[1, 1]] }] } }], time: n });
}
function shell(s: S, command: string) {
  const id = `c${++n}`;
  s.push({ id: `a${id}`, role: 'assistant', parts: [{ type: 'tool_call', id, name: 'shell', input: { command } }], time: n });
  s.push({ id: `r${id}`, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: id, name: 'shell', content: `${command}\n[exit 0 · 0.1 s]` }], time: n });
}

describe('files read before a compaction', () => {
  it('stay read while their text is in the kept rounds; the newest two others come back whole, and the summary names the rest', async () => {
    const older = path.join(project, 'src', 'older.ts');
    const early = path.join(project, 'src', 'early.ts');
    const late = path.join(project, 'src', 'late.ts');
    const changed = path.join(project, 'src', 'changed.ts');
    for (const f of [older, early, late, changed]) fs.writeFileSync(f, `export const ${path.basename(f, '.ts')} = 1;`);
    const s = (await rt.start({ cwd: project, model: 'fake/m1' })) as unknown as S;
    s.push({ id: 'u1', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Fix the parser.' }], time: 0 });
    read(s, older);
    read(s, early);
    for (let i = 0; i < 12; i++) shell(s, `echo step ${i}`);
    read(s, late);
    read(s, changed);
    // Changed by a command after its read: what the kept round shows is no longer the file.
    fs.writeFileSync(changed, 'export const changed = 2;');
    expect(await s.compact('manual')).toBe(true);

    expect(s.files.checkEditable(late)).toBeNull();
    // The newest two whose text the kept rounds do not show, as they are now, numbered as a read shows them.
    const summary = s.active().find((m) => m.origin === 'compaction')!.parts[0].text!;
    expect(summary).toMatch(/src[\\/]changed\.ts\n {5}1\texport const changed = 2;/);
    expect(summary).toMatch(/src[\\/]early\.ts\n {5}1\texport const early = 1;/);
    expect(s.files.checkEditable(changed)).toBeNull();
    expect(s.files.checkEditable(early)).toBeNull();
    expect(s.files.checkEditable(older)).toMatch(/not been read/);
    const again = summary.split('\n').find((l) => l.includes('whose text is not in the kept messages')) ?? '';
    expect(again).toContain('older.ts');
    expect(again).not.toContain('early.ts');
    expect(again).not.toContain('late.ts');
  });

  // A read and then an edit in the kept rounds left the read no longer matching the file: it was listed to be read
  // again and could not be edited, though the model had just written it.
  it('stay editable when the kept rounds wrote them, and every older file is forgotten', async () => {
    const edited = path.join(project, 'src', 'edited.ts');
    fs.writeFileSync(edited, 'export const edited = 1;');
    const s = (await rt.start({ cwd: project, model: 'fake/m1' })) as unknown as S;
    s.push({ id: 'u4', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Fix the printer.' }], time: 0 });
    // Sixty files read early: all of them go with the summary, not only the fifty latest.
    const many = Array.from({ length: 60 }, (_, i) => path.join(project, 'src', `many${i}.ts`));
    for (const f of many) fs.writeFileSync(f, `export const n = 1;`);
    for (const f of many) read(s, f);
    for (let i = 0; i < 12; i++) shell(s, `echo printer ${i}`);
    read(s, edited);
    fs.writeFileSync(edited, 'export const edited = 2;');
    s.files.recordWrite(edited);
    const id = `c${++n}`;
    s.push({ id: `a${id}`, role: 'assistant', parts: [{ type: 'tool_call', id, name: 'edit', input: { path: edited } }], time: n });
    s.push({ id: `r${id}`, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: id, name: 'edit', content: 'Edited src/edited.ts', evidence: { writes: [edited] } }], time: n });
    expect(await s.compact('manual')).toBe(true);

    expect(s.files.checkEditable(edited)).toBeNull();
    expect(s.files.checkEditable(many[0])).toMatch(/not been read/);
    const summary = s.active().find((m) => m.origin === 'compaction')!.parts[0].text!;
    const again = summary.split('\n').find((l) => l.includes('whose text is not in the kept messages')) ?? '';
    expect(again).not.toContain('edited.ts');
  });
});

describe('the summary request', () => {
  it('keeps a pruned diagnostic from inside repeated output visible to the summary request', async () => {
    const s = (await rt.start({ cwd: project, model: 'fake/m1' })) as unknown as S & {
      maybePrune(): boolean; anchorTokens: number; messages: import('../src/types').Message[];
    };
    const id = 'diagnose';
    const marker = 'Old device rejected revision 47';
    const output = 'sample\n'.repeat(2000) + marker + '\n' + 'sample\n'.repeat(2000);
    s.push({ id: 'ask', role: 'user', origin: 'user', time: 1, parts: [{ type: 'text', text: 'Investigate this device.' }] });
    s.push({ id: 'cmd', role: 'assistant', time: 2, parts: [{ type: 'tool_call', id, name: 'shell', input: { command: 'diagnose' } }] });
    s.push({ id: 'log', role: 'user', origin: 'tool', time: 3, parts: [{ type: 'tool_result', callId: id, name: 'shell', content: output }] });
    for (let i = 0; i < 6; i++) shell(s, `echo later-${i}`);
    s.anchorTokens = 55_000;
    expect(s.maybePrune()).toBe(true);
    const result = s.messages.find((m) => m.id === 'log')!.parts[0];
    if (result.type !== 'tool_result') throw new Error('expected the original tool result');
    expect(rt.store.blobs.text(result.contentBlob!)).toBe(output);
    bodies.length = 0;
    expect(await s.compact('manual')).toBe(true);
    expect(bodies[0]).toContain(`recall with call_id ${id}`);
    expect(bodies).toHaveLength(1);
    expect(result.content).toContain(marker);
    expect(result.content.length).toBeLessThan(680);
    expect(bodies[0]).toContain(marker);
  });

  it('is not told which rounds stay, and the summary is installed as older than them', async () => {
    const s = (await rt.start({ cwd: project, model: 'fake/m1' })) as unknown as S;
    s.push({ id: 'u2', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Fix the lexer.' }], time: 0 });
    for (let i = 0; i < 14; i++) shell(s, `echo lexer ${i}`);
    bodies.length = 0;
    expect(await s.compact('manual')).toBe(true);
    // A summary of only the part before the kept rounds put the next step right less often.
    expect(bodies.at(-1)!).not.toContain('stay in the next context word for word');
    const installed = s.active().find((m) => m.origin === 'compaction')!.parts[0].text!;
    expect(installed).toContain('They are newer than the summary');
  });

  // A compaction asked for as one transcript (an overflow, or a reply that was no summary) cut the earlier summary like
  // any note: the user's words and the work record in its second half were lost.
  it('keeps an earlier summary whole when the conversation goes as one transcript', async () => {
    const s = (await rt.start({ cwd: project, model: 'fake/m1' })) as unknown as S & { compactNow(r: string): Promise<boolean> };
    const rules = `Keep every rule below. ${'Indent with tabs. '.repeat(600)}END-OF-RULES`;
    s.push({ id: 'u3', role: 'user', origin: 'user', parts: [{ type: 'text', text: rules }], time: 0 });
    for (let i = 0; i < 14; i++) shell(s, `echo first ${i}`);
    expect(await s.compact('manual')).toBe(true);
    for (let i = 0; i < 10; i++) shell(s, `echo second ${i}`);
    bodies.length = 0;
    expect(await s.compactNow('overflow')).toBe(true);
    const asked = bodies.at(-1)!;
    expect(asked).toContain('EARLIER SUMMARY:');
    expect(asked).toContain('END-OF-RULES');
    // Its summary and the user's words; the record after them is written again over the whole session.
    expect(asked).not.toContain('What the work before this point did');
  });

  it('hydrates FileTracker across Session.open (-p -c) reloads for active edits, pre-compaction workbench/recent, and post-compaction reopen', async () => {
    const olderRead = path.join(project, 'src', 'reopen_older.ts');
    const recentRead = path.join(project, 'src', 'reopen_recent.ts');
    const writtenCode = path.join(project, 'src', 'reopen_written.ts');
    const extModified = path.join(project, 'src', 'reopen_external.ts');
    fs.writeFileSync(olderRead, 'export const olderRead = 1;\n');
    fs.writeFileSync(recentRead, 'export const recentRead = 2;\n');
    fs.writeFileSync(writtenCode, 'export const writtenCode = 10;\n');
    fs.writeFileSync(extModified, 'export const extModified = 1;\n');

    const started = await rt.start({ cwd: project, model: 'fake/m1' });
    const sid = started.id;
    const s1 = started as unknown as S & {
      deps: { store: { saveMessage(meta: unknown, m: unknown): void } };
      meta: unknown;
      messages: unknown[];
    };
    const baseTime = Date.now() - 20_000;
    const pushSaved = (m: Record<string, unknown>) => {
      s1.push(m);
      s1.deps.store.saveMessage(s1.meta, m);
    };

    pushSaved({ id: 'u_reopen', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Inspect and update modules.' }], time: baseTime });
    pushSaved({
      id: 'a_reopen_1',
      role: 'assistant',
      parts: [
        { type: 'tool_call', id: 'cr_old', name: 'read', input: { paths: [olderRead] } },
        { type: 'tool_call', id: 'cr_rec', name: 'read', input: { paths: [recentRead] } },
        { type: 'tool_call', id: 'cw_code', name: 'write', input: { path: writtenCode, content: 'export const writtenCode = 10;\n' } },
        { type: 'tool_call', id: 'cw_ext', name: 'write', input: { path: extModified, content: 'export const extModified = 1;\n' } },
      ],
      time: baseTime + 10,
    });
    pushSaved({
      id: 'r_reopen_1',
      role: 'user',
      origin: 'tool',
      parts: [
        {
          type: 'tool_result',
          callId: 'cr_old',
          name: 'read',
          content: '1\texport const olderRead = 1;\n',
          evidence: { reads: [{ path: olderRead, digest: fileDigest(olderRead), total: 1, ranges: [[1, 1]] }] },
        },
        {
          type: 'tool_result',
          callId: 'cr_rec',
          name: 'read',
          content: '1\texport const recentRead = 2;\n',
          evidence: { reads: [{ path: recentRead, digest: fileDigest(recentRead), total: 1, ranges: [[1, 1]] }] },
        },
        {
          type: 'tool_result',
          callId: 'cw_code',
          name: 'write',
          content: 'Updated src/reopen_written.ts',
          evidence: { writes: [writtenCode] },
        },
        {
          type: 'tool_result',
          callId: 'cw_ext',
          name: 'write',
          content: 'Updated src/reopen_external.ts',
          evidence: { writes: [extModified] },
        },
      ],
      time: baseTime + 20,
    });
    // Fix mtime of agent-touched files at baseTime, and simulate an external user edit 15s AFTER session save on `extModified`.
    const savedSec = baseTime / 1000;
    for (const f of [olderRead, recentRead, writtenCode]) fs.utimesSync(f, savedSec, savedSec);
    fs.writeFileSync(extModified, 'export const extModified = 999;\n');
    const laterSec = (baseTime + 15_000) / 1000;
    fs.utimesSync(extModified, laterSec, laterSec);

    // Push 14 shell rounds so the earlier reads/writes sit in `preTailSlice` when compaction fires on reopen.
    for (let i = 0; i < 14; i++) {
      const cid = `sh_reopen_${i}`;
      pushSaved({ id: `a_${cid}`, role: 'assistant', parts: [{ type: 'tool_call', id: cid, name: 'shell', input: { command: `echo ${i}` } }], time: baseTime + 30 + i });
      pushSaved({ id: `r_${cid}`, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: cid, name: 'shell', content: `${i}\n[exit 0 · 0.1 s]` }], time: baseTime + 30 + i });
    }
    rt.close(sid);

    // 1. Reopen (`-p -c`): un-externally-modified active reads & writes are editable immediately; externally modified file requires re-read!
    const reopened = (await rt.get(sid, { model: 'fake/m1' })) as unknown as S & { files: Files & { written(): string[]; recent(n?: number): string[] } };
    expect(reopened.files.checkEditable(writtenCode)).toBeNull();
    expect(reopened.files.checkEditable(recentRead)).toBeNull();
    expect(reopened.files.checkEditable(extModified)).not.toBeNull();
    expect(reopened.files.written()).toContain(writtenCode);

    // 2. Compact immediately on the reopened session (turn-start pre-compaction): workbench & recent list are populated, not empty!
    bodies.length = 0;
    expect(await reopened.compact('manual')).toBe(true);
    const compText = reopened.active().find((m) => m.origin === 'compaction')!.parts[0].text!;
    expect(compText).toContain('The files the work was on, as they are now');
    expect(compText).toContain('reopen_written.ts');
    expect(compText).toContain('Files touched recently whose text is not in the kept messages:');
    expect(compText).toContain('reopen_older.ts');
    // Summary request included unchanged read coverage (`reopen_older.ts`, `reopen_recent.ts`) and cleared written file coverage.
    expect(bodies.at(-1)!).toContain('reopen_older.ts: all 1 lines');
    expect(bodies.at(-1)!).not.toContain('reopen_written.ts: all');
    rt.close(sid);

    // 3. Reopen AGAIN after compaction: workbench file embedded inside `summaryMsg` stays editable without redundant re-read!
    const afterCompactReopen = (await rt.get(sid, { model: 'fake/m1' })) as unknown as S;
    expect(afterCompactReopen.files.checkEditable(writtenCode)).toBeNull();
    rt.close(sid);
  });
});

describe('a session opened again', () => {
  // The agent's own edit had been taken for a change made outside: every file it read and then edited was named stale
  // on reopen, beside the ones someone else did change.
  it('names a read stale when someone else changed the file, and not when the agent edited it', async () => {
    const edited = path.join(project, 'src', 'digest_edited.ts');
    const outside = path.join(project, 'src', 'digest_outside.ts');
    fs.mkdirSync(path.dirname(edited), { recursive: true });
    fs.writeFileSync(edited, 'export const edited = 1;\n');
    fs.writeFileSync(outside, 'export const outside = 1;\n');
    const started = await rt.start({ cwd: project, model: 'fake/m1' });
    const sid = started.id;
    const s1 = started as unknown as S & { deps: { store: { saveMessage(meta: unknown, m: unknown): void } }; meta: unknown };
    const save = (m: Record<string, unknown>) => {
      s1.push(m);
      s1.deps.store.saveMessage(s1.meta, m);
    };
    const readOf = (file: string) => ({ path: file, digest: fileDigest(file), total: 1, ranges: [[1, 1]] });
    save({ id: 'u_dg', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Update the module.' }], time: 1 });
    save({ id: 'a_dg1', role: 'assistant', parts: [{ type: 'tool_call', id: 'dg_r1', name: 'read', input: { paths: [edited] } }, { type: 'tool_call', id: 'dg_r2', name: 'read', input: { paths: [outside] } }], time: 2 });
    save({
      id: 'r_dg1', role: 'user', origin: 'tool', time: 3,
      parts: [
        { type: 'tool_result', callId: 'dg_r1', name: 'read', content: '1\texport const edited = 1;\n', evidence: { reads: [readOf(edited)] } },
        { type: 'tool_result', callId: 'dg_r2', name: 'read', content: '1\texport const outside = 1;\n', evidence: { reads: [readOf(outside)] } },
      ],
    });
    fs.writeFileSync(edited, 'export const edited = 2;\n');
    save({ id: 'a_dg2', role: 'assistant', parts: [{ type: 'tool_call', id: 'dg_e', name: 'edit', input: { path: edited, oldString: '= 1', newString: '= 2' } }], time: 4 });
    save({
      id: 'r_dg2', role: 'user', origin: 'tool', time: 5,
      parts: [{ type: 'tool_result', callId: 'dg_e', name: 'edit', content: 'Edited src/digest_edited.ts', evidence: { writes: [edited], writtenFiles: [{ path: edited, digest: fileDigest(edited) }] } }],
    });
    rt.close(sid);
    fs.writeFileSync(outside, 'export const outside = 2;\n');

    const reopened = (await rt.get(sid, { model: 'fake/m1' })) as unknown as { notes: string[] };
    const stale = reopened.notes.find((n) => n.startsWith('Stored reads are stale:'));
    expect(stale).toContain('digest_outside.ts');
    expect(stale).not.toContain('digest_edited.ts');
    rt.close(sid);
  });

  // Restoring a reopened session's reads checked every file read so far again for each read, and each file once more
  // per read, per edit and per tracker call: 5.2 s for 400 reads and 200 edits over 40 files, against 0.3 s in 1.2.22.
  it('reads each file once, however many reads and edits name it, and keeps only wholly read files editable', async () => {
    const dir = path.join(project, 'src', 'many');
    fs.mkdirSync(dir, { recursive: true });
    const files = Array.from({ length: 6 }, (_, i) => path.join(dir, `m${i}.ts`));
    for (const f of files) fs.writeFileSync(f, 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    const started = await rt.start({ cwd: project, model: 'fake/m1' });
    const sid = started.id;
    const s1 = started as unknown as S & { deps: { store: { saveMessage(meta: unknown, m: unknown): void } }; meta: unknown };
    const save = (m: Record<string, unknown>) => {
      s1.push(m);
      s1.deps.store.saveMessage(s1.meta, m);
    };
    save({ id: 'u_many', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Go through the modules.' }], time: 1 });
    let t = 2;
    for (let i = 0; i < 60; i++) {
      const f = files[i % files.length];
      // The last file is only ever read in part, so it must not come back editable.
      const ranges = f === files[5] ? [[1, 2]] : [[1, 3]];
      save({ id: `a_many${i}`, role: 'assistant', parts: [{ type: 'tool_call', id: `mr${i}`, name: 'read', input: { paths: [f] } }], time: t++ });
      save({ id: `r_many${i}`, role: 'user', origin: 'tool', time: t++, parts: [{ type: 'tool_result', callId: `mr${i}`, name: 'read', content: '1\texport const a = 1;', evidence: { reads: [{ path: f, digest: fileDigest(f), total: 3, ranges }] } }] });
    }
    for (let i = 0; i < 20; i++) {
      const f = files[i % 4];
      save({ id: `a_mw${i}`, role: 'assistant', parts: [{ type: 'tool_call', id: `mw${i}`, name: 'edit', input: { path: f, oldString: 'a', newString: 'a' } }], time: t++ });
      save({ id: `r_mw${i}`, role: 'user', origin: 'tool', time: t++, parts: [{ type: 'tool_result', callId: `mw${i}`, name: 'edit', content: 'Edited', evidence: { writes: [f], writtenFiles: [{ path: f, digest: fileDigest(f) }] } }] });
    }
    rt.close(sid);

    const named = new Set(files.map((f) => path.resolve(f)));
    const spy = vi.spyOn(fs, 'readFileSync');
    let reads = 0;
    try {
      const reopened = (await rt.get(sid, { model: 'fake/m1' })) as unknown as S;
      reads = spy.mock.calls.filter(([p]) => typeof p === 'string' && named.has(path.resolve(p))).length;
      expect(reopened.files.checkEditable(files[4])).toBeNull();
      expect(reopened.files.checkEditable(files[5])).not.toBeNull();
    } finally {
      spy.mockRestore();
      rt.close(sid);
    }
    expect(reads).toBeLessThanOrEqual(files.length);
  });
});
