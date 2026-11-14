import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSummary } from '../src/agent/session';

// A compaction whose model answers the summary request by going on with the work: the reply is asked again as one
// transcript with no tools, and only a real summary goes in.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-retry-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const asked: ('in-context' | 'transcript')[] = [];
let inContextReply = '';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    const transcript = body.includes('You write precise hand-off summaries');
    asked.push(transcript ? 'transcript' : 'in-context');
    const text = transcript ? '<summary>GOOD-SUMMARY: the parser drops the last token; fix in lexer.ts, tests in lexer.test.ts.</summary>' : inContextReply;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
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

async function compactWith(reply: string) {
  asked.length = 0;
  inContextReply = reply;
  const s = (await rt.start({ cwd: project, model: 'fake/m1' })) as unknown as { push(m: unknown): void; compact(r: string): Promise<boolean>; active(): { origin?: string; parts: { type: string; text?: string }[] }[] };
  s.push({ id: 'u1', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Fix the parser.' }], time: 1 });
  s.push({ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Looking at the lexer.' }], time: 2 });
  expect(await s.compact('manual')).toBe(true);
  return s.active().find((m) => m.origin === 'compaction')!.parts[0].text ?? '';
}

describe('a summary that is no summary', () => {
  it('is asked again as a transcript when the model wrote a tool call instead', async () => {
    const text = await compactWith('Found it.<|open|>tools<|sep|><|open|>call tool="read"<|sep|>');
    expect(asked).toEqual(['in-context', 'transcript']);
    expect(text).toContain('GOOD-SUMMARY');
    expect(text).not.toContain('<|open|>');
  });

  it('is asked again when the model only said it had summarized', async () => {
    const text = await compactWith('Summary written above.');
    expect(asked).toEqual(['in-context', 'transcript']);
    expect(text).toContain('GOOD-SUMMARY');
  });

  it('goes in at once when it is one', async () => {
    const text = await compactWith('<summary>The parser drops the last token; the fix belongs in lexer.ts.</summary>');
    expect(asked).toEqual(['in-context']);
    expect(text).toContain('the fix belongs in lexer.ts');
  });

  it("opens with the folder's facts as the session gave them, or as gathered when it started", async () => {
    type S = { send(t: string): Promise<void>; push(m: unknown): void; compact(r: string): Promise<boolean>; messages: { role: string; parts: { type: string; text?: string }[] }[]; active(): { origin?: string; parts: { type: string; text?: string }[] }[] };
    inContextReply = '<summary>The parser drops the last token; the fix belongs in lexer.ts.</summary>';
    const s = (await rt.start({ cwd: project, model: 'fake/m1' })) as unknown as S;
    await s.send('Fix the parser.');
    const note = s.messages[0].parts[0].text ?? '';
    expect(note).toMatch(/^<harness-note>Working directory: .+\/project\nScratch folder: .+\nGit: not a repository\n/);
    expect(await s.compact('manual')).toBe(true);
    const facts = note.slice('<harness-note>'.length, -'</harness-note>'.length);
    expect(s.active()[0].parts[0].text?.startsWith(`${facts}\n\nThis session continues`)).toBe(true);
    await s.send('Go on.');
    expect(s.messages.filter((m) => m.role === 'user' && m.parts.some((p) => p.text?.includes('Working directory'))).length).toBe(2);

    const bare = (await rt.start({ cwd: project, model: 'fake/m1' })) as unknown as S;
    bare.push({ id: 'u1', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Fix the parser.' }], time: 1 });
    bare.push({ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Looking at the lexer.' }], time: 2 });
    expect(await bare.compact('manual')).toBe(true);
    expect(bare.active()[0].parts[0].text).toMatch(/^Working directory: .+\/project\n[\s\S]*\n\nThis session continues/);
    await bare.send('Go on.');
    expect(bare.messages.at(-2)?.parts.map((p) => p.text).join('')).toBe('Go on.');
  });

  it('is told apart by its tags, its body and no tool call written out', () => {
    expect(isSummary('<summary>Work so far: the parser drops the last token.</summary>')).toBe(true);
    expect(isSummary('Understood. The summary is ready above.')).toBe(false);
    expect(isSummary('<summary>ok</summary>')).toBe(false);
    expect(isSummary('<summary><|open|>tools<|sep|> call read a long enough body here</summary>')).toBe(false);
  });
});
