import { describe, expect, it } from 'vitest';
import { foldTurns, turnFace } from '../src/lib/turns';

const user = (key: string) => ({ kind: 'user', key });
const note = (key: string) => ({ kind: 'text', key });
const answer = (key: string) => ({ kind: 'text', key, final: true });
const run = (key: string, ...kinds: string[]) => ({ kind: 'process', key, steps: kinds.map((kind) => ({ kind })) });

describe('turns the user has moved on from', () => {
  it('fold the steps and notes before the answer once the user writes again', () => {
    const items = [user('u1'), run('p1', 'tool'), note('t1'), run('p2', 'reasoning', 'tool'), answer('a1'), user('u2')];
    const out = foldTurns(items);
    expect(out.map((x) => x.key)).toEqual(['u1', 'w:p1', 'a1', 'u2']);
    expect(out[1]).toEqual({ kind: 'work', key: 'w:p1', items: items.slice(1, 4) });
  });

  it('leave the last turn open, and a turn whose answer came without a tool step', () => {
    const items = [user('u1'), run('p1', 'reasoning'), answer('a1'), user('u2'), run('p2', 'tool'), answer('a2')];
    expect(foldTurns(items)).toEqual(items);
  });

  it('leave a turn without an answer as it is: what happened stays in view', () => {
    const items = [user('u1'), run('p1', 'tool'), note('t1'), user('u2')];
    expect(foldTurns(items)).toEqual(items);
  });

  it('keep what came after the answer in view', () => {
    const items = [user('u1'), run('p1', 'tool'), answer('a1'), { kind: 'compaction', key: 'c1' }, user('u2')];
    expect(foldTurns(items).map((x) => x.key)).toEqual(['u1', 'w:p1', 'a1', 'c1', 'u2']);
  });
});

describe('a turn as its restore point shows it', () => {
  const msg = (role: 'user' | 'assistant', turn: string, parts: unknown[], extra: Record<string, unknown> = {}) => ({ id: `${role}${turn}${parts.length}`, role, turn, parts, time: 1, ...extra }) as never;
  it('says what the answer says first, with the picture the answer shows', () => {
    const messages = [
      msg('user', 't1', [{ type: 'text', text: '结算有问题' }], { origin: 'user' }),
      msg('assistant', 't1', [{ type: 'text', text: '**结算**少算了 10 元：折扣被扣了两次。\n\n![结算页](pic:3f9a2c1b7d4e "wide")\n\n改好了。' }]),
    ];
    const face = turnFace(messages, 't1', new Map(), 's1');
    expect(face.said).toBe('结算少算了 10 元：折扣被扣了两次。');
    expect(face.picture).toEqual({ src: '/api/image?path=pic%3A3f9a2c1b7d4e&session=s1', name: '结算页' });
  });

  it('takes the last picture a step took when the answer shows none, and skips a leading table or picture line', () => {
    const results = new Map([['c2', { type: 'tool_result', callId: 'c2', name: 'browser', content: '', images: [{ type: 'image', mediaType: 'image/png', data: '', url: '/api/blob/b2.bin', name: 'page' }] }]]);
    const messages = [
      msg('assistant', 't2', [{ type: 'tool_call', id: 'c1', name: 'shell', input: {} }]),
      msg('assistant', 't2', [{ type: 'tool_call', id: 'c2', name: 'browser', input: {} }]),
      msg('assistant', 't2', [{ type: 'text', text: '| a | b |\n|---|---|\n首页做好了，[预览](http://localhost:5173) 在这里。' }]),
    ];
    const face = turnFace(messages, 't2', results as never);
    expect(face.said).toBe('首页做好了，预览 在这里。');
    expect(face.picture).toEqual({ src: '/api/blob/b2.bin', name: 'page' });
  });
});

describe('a turn that did not end in an answer', () => {
  it('stays open when its last text came in a reply that went on to tools, was cut or failed', () => {
    const items = [user('u1'), run('p1', 'tool'), { kind: 'text', key: 't1', final: true, ended: false }, user('u2')];
    expect(foldTurns(items)).toEqual(items);
  });
});
