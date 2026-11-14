import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
