import { describe, expect, it } from 'vitest';
import { blockOrder, position, startAt, step, type FindHit, type FindState } from '../src/lib/find';
import { userTurns, userWords, attachedFiles } from '../src/lib/messages';
import type { Message } from '../src/lib/types';

const messages: Message[] = [
  { id: 'u1', role: 'user', origin: 'user', time: 1, parts: [{ type: 'text', text: 'First ask\n\nAttached by the user:\n<file path="src/a.ts">x</file>' }] },
  { id: 'a1', role: 'assistant', time: 2, parts: [{ type: 'reasoning', text: 'think', provider: 'p', model: 'm' }, { type: 'tool_call', id: 'c1', name: 'read', input: {} }] },
  { id: 'r1', role: 'user', origin: 'tool', time: 3, parts: [{ type: 'tool_result', callId: 'c1', name: 'read', content: 'x' }] },
  { id: 'a2', role: 'assistant', time: 4, parts: [{ type: 'text', text: 'answer' }] },
  { id: 's1', role: 'user', origin: 'compaction', time: 5, parts: [{ type: 'text', synthetic: true, text: '<summary>so far</summary>' }] },
  { id: 'p1', role: 'assistant', time: 6, replay: true, parts: [{ type: 'text', text: 'answer' }] },
  { id: 'u2', role: 'user', origin: 'user', time: 7, parts: [{ type: 'text', text: 'Second ask' }] },
  { id: 'a3', role: 'assistant', time: 8, parts: [{ type: 'text', text: 'done' }] },
];

const hits: FindHit[] = [
  { block: 'u1', kind: 'user', count: 1 },
  { block: 'c1', kind: 'tool', count: 3, output: true },
  { block: 'a3:0', kind: 'text', count: 2 },
];
const state = (at: FindState['at']): FindState => ({ open: true, query: 'x', hits, total: 6, capped: false, at, busy: false, asked: 1 });

describe('find in the conversation', () => {
  it('orders the parts as the timeline draws them, copies after a summary left out', () => {
    const order = blockOrder(messages);
    expect([...order.keys()]).toEqual(['u1', 'a1:0', 'c1', 'r1', 'a2:0', 's1', 'u2', 'a3:0']);
  });

  it('starts at the first match from the part on screen down, or at the last one', () => {
    const order = blockOrder(messages);
    expect(startAt(hits, order, 'u1')).toBe(0);
    expect(startAt(hits, order, 'a2:0')).toBe(2);
    expect(startAt(hits, order, null)).toBe(2);
    expect(startAt([], order, 'u1')).toBe(-1);
  });

  it('walks every match of every hit, round the ends both ways', () => {
    let at: FindState['at'] = { hit: 0, n: 0 };
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      seen.push(`${at!.hit}.${at!.n}:${position(state(at))}`);
      at = step(state(at), 1);
    }
    expect(seen).toEqual(['0.0:1', '1.0:2', '1.1:3', '1.2:4', '2.0:5', '2.1:6', '0.0:1']);
    expect(step(state({ hit: 0, n: 0 }), -1)).toEqual({ hit: 2, n: 1 });
    expect(step(state({ hit: 1, n: 0 }), -1)).toEqual({ hit: 0, n: 0 });
    expect(step(state(null), 1)).toEqual({ hit: 0, n: 0 });
  });
});

describe('the user’s own messages', () => {
  it('are their words without the attached files, and the files by path', () => {
    expect(userWords(messages[0])).toBe('First ask');
    expect(attachedFiles(messages[0])).toEqual(['src/a.ts']);
  });

  it('are numbered for the outline, marked where a summary came before', () => {
    expect(userTurns(messages)).toEqual([
      { id: 'u1', n: 1, text: 'First ask', time: 1 },
      { id: 'u2', n: 2, text: 'Second ask', time: 7, after: 'compaction' },
    ]);
  });
});
