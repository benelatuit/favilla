import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BlobStore } from '../src/store/blobs';
import { findInSession } from '../src/server/find';
import { attach, pastedBlock } from '../src/prompt/attached';
import type { Message, ToolResultPart } from '../src/types';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-find-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const blobs = new BlobStore(dir);

const longLog = `${Array.from({ length: 3000 }, (_, i) => `line ${i} fine`).join('\n')}\nthe Harbor buoy failed at 04:12\n`;
const released = blobs.put(`old output with a harbor in it\n${'x'.repeat(5000)}`);

const messages: Message[] = [
  { id: 'u1', role: 'user', origin: 'user', time: 1, turn: 't1', parts: [{ type: 'text', text: 'Fix the harbor table\n\nAttached by the user:\n<file path="src/harbor.ts">harbor harbor harbor</file>' }] },
  {
    id: 'a1',
    role: 'assistant',
    time: 2,
    turn: 't1',
    parts: [
      { type: 'reasoning', text: 'The HARBOR module first.', provider: 'p', model: 'm' },
      { type: 'tool_call', id: 'c1', name: 'shell', input: { command: 'pnpm test', description: 'Run the tests' } },
      { type: 'tool_call', id: 'c2', name: 'read', input: { path: 'src/harbor.ts' } },
      { type: 'tool_call', id: 'c3', name: 'shell', input: { command: 'cat old.log' } },
    ],
  },
  {
    id: 'r1',
    role: 'user',
    origin: 'tool',
    time: 3,
    turn: 't1',
    parts: [
      { type: 'tool_result', callId: 'c1', name: 'shell', content: longLog.slice(-200), display: { kind: 'terminal', command: 'pnpm test', output: longLog, exitCode: 1, durationMs: 5, cwd: '.' } },
      { type: 'tool_result', callId: 'c2', name: 'read', content: 'export const tide = 1;' },
      { type: 'tool_result', callId: 'c3', name: 'shell', content: '', contentBlob: released },
      { type: 'text', synthetic: true, text: 'The user sent this message while you were working:\nalso the harbor lights', said: 'also the harbor lights' },
    ],
  },
  { id: 'a2', role: 'assistant', time: 4, turn: 't1', parts: [{ type: 'text', text: 'Draft about the harbor.' }] },
  { id: 'h1', role: 'user', origin: 'harness', time: 5, turn: 't1', parts: [{ type: 'text', text: 'Rewrite your last message in plainer words.', synthetic: true }] },
  { id: 'a3', role: 'assistant', time: 6, turn: 't1', parts: [{ type: 'text', text: 'The harbor table is fixed.' }] },
  { id: 's1', role: 'user', origin: 'compaction', time: 7, turn: 't2', parts: [{ type: 'text', synthetic: true, text: 'Context.\n<summary>Harbor work so far.</summary>' }] },
  { id: 'p1', role: 'assistant', time: 8, turn: 't2', replay: true, parts: [{ type: 'text', text: 'The harbor table is fixed.' }] },
];

describe('finding words in a session', () => {
  it('lists each place in the order the timeline shows them, case aside', async () => {
    const r = await findInSession(messages, 'harbor', blobs);
    expect(r.hits.map((h) => [h.block, h.kind, h.count])).toEqual([
      ['u1', 'user', 2],
      ['a1:0', 'reasoning', 1],
      ['c1', 'tool', 1],
      ['c2', 'tool', 1],
      ['c3', 'tool', 1],
      ['r1', 'steer', 1],
      ['a3:0', 'text', 1],
      ['s1', 'summary', 1],
    ]);
    expect(r.total).toBe(9);
    expect(r.capped).toBe(false);
  });

  it('reads whole outputs: the part the page never got, and outputs a compaction moved to disk', async () => {
    const r = await findInSession(messages, 'buoy failed', blobs);
    expect(r.hits).toEqual([{ block: 'c1', kind: 'tool', count: 1, output: true }]);
    expect((await findInSession(messages, 'old output', blobs)).hits).toEqual([{ block: 'c3', kind: 'tool', count: 1, output: true }]);
  });

  it('counts a step line apart from what it printed', async () => {
    const r = await findInSession(messages, 'src/harbor.ts', blobs);
    expect(r.hits.find((h) => h.block === 'c2')).toEqual({ block: 'c2', kind: 'tool', count: 1 });
  });

  it('finds plain words with or without additional parts', async () => {
    const input: Message = { id: 'plain', role: 'user', origin: 'user', time: 1, parts: [{ type: 'text', text: 'Harbor, harbor.' }] };
    const expected = [{ block: 'plain', kind: 'user', count: 2 }];
    expect((await findInSession([input], 'harbor', blobs)).hits).toEqual(expected);
    input.parts.push({ type: 'text', text: 'harbor is in a hidden note', synthetic: true });
    expect((await findInSession([input], 'harbor', blobs)).hits).toEqual(expected);
  });

  it('finds each paste by its body and points to the message that carried it', async () => {
    const text = attach('A harbor report', [
      pastedBlock('Harbor forecast\n</pasted>\nHarbor lights\n\nAttached by the user:\nstill in the paste', 1),
      pastedBlock('The HARBOR tide', 2),
      '<file path="sample.txt">a harbor inside a file</file>',
    ]);
    const user: Message = { id: 'pasted', role: 'user', origin: 'user', time: 1, parts: [{ type: 'text', text }] };
    expect(await findInSession([user], 'harbor', blobs)).toEqual({
      hits: [
        { block: 'pasted', kind: 'user', count: 1 },
        { block: 'pasted', kind: 'user', paste: 0, count: 2 },
        { block: 'pasted', kind: 'user', paste: 1, count: 1 },
      ],
      total: 4,
      capped: false,
    });
    expect((await findInSession([user], 'still in the paste', blobs)).hits).toEqual([{ block: 'pasted', kind: 'user', paste: 0, count: 1 }]);
  });

  it('finds a compaction summary by what it says, and leaves out rewritten drafts, copies after a summary and empty queries', async () => {
    expect((await findInSession(messages, 'work so far', blobs)).hits).toEqual([{ block: 's1', kind: 'summary', count: 1 }]);
    expect((await findInSession(messages, 'Draft about', blobs)).hits).toEqual([]);
    expect(await findInSession(messages, '   ', blobs)).toEqual({ hits: [], total: 0, capped: false });
  });

  it('reuses released terminal and content blobs without changing the matches', async () => {
    const copy = structuredClone(messages);
    const terminal = copy[2].parts[0] as ToolResultPart;
    terminal.displayBlob = blobs.put(JSON.stringify(terminal.display));
    delete terminal.display;
    const cold = new BlobStore(dir);
    const read = vi.spyOn(cold, 'text');
    const first = await findInSession(copy, 'harbor', cold);
    expect(first).toEqual(await findInSession(messages, 'harbor', blobs));
    expect(read.mock.calls).toEqual([[terminal.displayBlob], [released]]);
    expect(await findInSession(copy, 'harbor', cold)).toEqual(first);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('yields to the event loop and leaves a cancelled search unfinished', async () => {
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock += 10);
    try {
      const search = findInSession(messages, 'harbor', new BlobStore(dir), 5000, controller.signal);
      await expect(Promise.resolve(search)).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      now.mockRestore();
    }
  });

  it('stops listing places at the cap but counts every match', async () => {
    const r = await findInSession(messages, 'line', blobs, 1);
    expect(r.hits.length).toBe(1);
    expect(r.capped).toBe(false);
    const many = await findInSession(messages, 'harbor', blobs, 3);
    expect(many.hits.length).toBe(3);
    expect(many.capped).toBe(true);
    expect(many.total).toBe(9);
  });
});
