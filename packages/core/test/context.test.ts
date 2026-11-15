import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planPrune, prunePays, sendable, tailOf, userWords } from '../src/context/prune';
import { readTool } from '../src/tools/fs-tools';
import { FileTracker } from '../src/tools/filestate';
import { recallTool } from '../src/tools/recall';
import { SessionStore } from '../src/store/sessions';
import { BlobStore } from '../src/store/blobs';
import { estimateMessageTokens } from '../src/util/tokens';
import { fullContent } from '../src/store/pack';
import type { Message, SessionMeta, ToolResultPart } from '../src/types';
import type { ToolContext } from '../src/tools/types';

let n = 0;
const user = (text: string): Message => ({ id: `u${n++}`, role: 'user', origin: 'user', parts: [{ type: 'text', text }], time: n });
const call = (id: string, name: string, input: Record<string, unknown>): Message => ({ id: `a${n++}`, role: 'assistant', parts: [{ type: 'tool_call', id, name, input }], time: n });
const result = (id: string, name: string, content: string, images = 0): Message => ({
  id: `r${n++}`,
  role: 'user',
  origin: 'tool',
  parts: [{ type: 'tool_result', callId: id, name, content, images: Array.from({ length: images }, () => ({ type: 'image' as const, mediaType: 'image/png', data: 'aGk=' })) }],
  time: n,
});
const big = (k: number) => 'x'.repeat(k);

/** A working session: the same file read twice, tests run twice, a big log, a screenshot, then recent work. */
function session(): Message[] {
  return [
    user('Fix the parser and keep the old API.'),
    call('c1', 'read', { paths: ['src/parse.ts'] }),
    result('c1', 'read', big(3000)),
    call('c2', 'shell', { command: 'npm test' }),
    result('c2', 'shell', big(2000)),
    call('c3', 'shell', { command: 'cat build.log' }),
    result('c3', 'shell', big(9000)),
    call('c4', 'browser', { url: 'http://localhost:5173' }),
    result('c4', 'browser', 'page looks fine', 1),
    call('c5', 'read', { paths: ['src/parse.ts'] }),
    result('c5', 'read', big(1200)),
    call('c6', 'shell', { command: 'npm test' }),
    result('c6', 'shell', big(1500)),
    call('c7', 'edit', { path: 'src/parse.ts' }),
    result('c7', 'edit', 'updated'),
  ];
}

describe('light compaction', () => {
  it('cuts superseded and large old output, keeps recent rounds and small results', () => {
    const items = planPrune(session(), 0, 3);
    expect(items.map((i) => i.callId).sort()).toEqual(['c1', 'c2', 'c3']);
    const c3 = items.find((i) => i.callId === 'c3')!;
    expect(c3.stub).toContain('recall with call_id c3');
    expect(c3.stub).toContain('it is from earlier steps');
    expect(items.find((i) => i.callId === 'c1')!.stub).toContain('a later call has newer output');
    // Unsuperseded small screenshot results stay for planSessionImages; superseded ones still prune cleanly.
    const withNewerShot = [
      ...session().slice(0, 9),
      call('c4b', 'browser', { url: 'http://localhost:5173' }),
      result('c4b', 'browser', 'updated view', 1),
      ...session().slice(9),
    ];
    const cutShot = planPrune(withNewerShot, 0, 3).find((i) => i.callId === 'c4')!;
    expect(cutShot.stub).toContain('1 image');
    // Everything is recent when there are no more rounds than that: not even a huge fresh read is cut.
    expect(planPrune(session().slice(9), 0, 3)).toEqual([]);
    expect(planPrune([user('read it'), call('r1', 'read', { paths: ['a.ts'] }), result('r1', 'read', big(30000))], 0, 6)).toEqual([]);
  });

  it('cuts a web page or search asked again, and keeps one asked differently', () => {
    const h = [
      user('Find the limit.'),
      call('w1', 'web_fetch', { url: 'https://example.com/limits#cpu', prompt: 'cpu time' }),
      result('w1', 'web_fetch', big(3000)),
      call('w2', 'web_fetch', { url: 'https://example.com/limits', start: 9000 }),
      result('w2', 'web_fetch', big(3000)),
      call('s1', 'WebSearch', { query: 'workers cpu limit' }),
      result('s1', 'WebSearch', big(3000)),
      call('w3', 'web_fetch', { url: 'https://example.com/limits', prompt: 'cpu time' }),
      result('w3', 'web_fetch', big(3000)),
      call('s2', 'WebSearch', { query: 'workers cpu limit' }),
      result('s2', 'WebSearch', big(3000)),
      ...['q1', 'q2', 'q3'].flatMap((id) => [call(id, 'shell', { command: `echo ${id}` }), result(id, 'shell', 'ok')]),
    ];
    expect(planPrune(h, 0, 3).map((i) => i.callId)).toEqual(['w1', 's1']);
  });

  it('keeps a read that a later read only points back to', () => {
    const h = [
      user('Fix it.'),
      call('p1', 'read', { paths: ['src/parse.ts'] }),
      result('p1', 'read', big(3100)),
      call('p2', 'read', { paths: ['src/parse.ts'] }),
      result('p2', 'read', 'src/parse.ts lines 1-80 have not changed since call p1 showed them, and that output is still in your context above: work from it.'),
      ...['q1', 'q2', 'q3'].flatMap((id) => [call(id, 'shell', { command: `echo ${id}` }), result(id, 'shell', 'ok')]),
    ];
    expect(planPrune(h, 0, 3).map((i) => i.callId)).not.toContain('p1');
  });

  it('cuts only when it pays for the prompt cache it loses', () => {
    // 140k of context, 30k to save, a tenth of the price for cached input: it pays back over some 42 requests.
    const at = { context: 140_000, saving: 30_000, compactAt: 207_000, cachedShare: 0.1 };
    expect(prunePays({ ...at, requests: 20 })).toBe(false);
    expect(prunePays({ ...at, requests: 45 })).toBe(true);
    // Nothing comes from a cache: there is nothing to lose.
    expect(prunePays({ ...at, requests: 1, cachedShare: 1 })).toBe(true);
    // Near the summary mark, a round that keeps the context well under it puts the summary off; one that does not, waits.
    expect(prunePays({ ...at, context: 190_000, saving: 50_000, requests: 1 })).toBe(true);
    expect(prunePays({ ...at, context: 190_000, saving: 20_000, requests: 1 })).toBe(false);
  });

  it('leaves images without data out of requests', () => {
    const m = result('c9', 'browser', 'x', 2);
    (m.parts[0] as ToolResultPart).images![0].data = '';
    expect((sendable(m).parts[0] as ToolResultPart).images).toHaveLength(1);
    const plain = user('hi');
    expect(sendable(plain)).toBe(plain);
  });

  it('persists stubs, keeps the full output in the blob store, and reloads them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-ctx-'));
    try {
      const store = new SessionStore(root);
      const meta = { id: 's', title: 's', cwd: root, created: 1, updated: 1, provider: 'p', model: 'm', effort: 'medium', mode: 'build', profile: 'favilla' } as SessionMeta;
      store.create(meta, 'S');
      for (const m of session()) store.saveMessage(meta, m);
      const blob = store.blobs.put(big(9000));
      store.savePrune(meta, [{ callId: 'c3', stub: 'stub of the log', blob }]);
      store.flushIndex();
      const rec = new SessionStore(root).load('s')!;
      const p = rec.messages.flatMap((m) => m.parts).find((x) => x.type === 'tool_result' && x.callId === 'c3') as ToolResultPart;
      expect(p.content).toBe('stub of the log');
      expect(p.pruned).toBe(true);
      expect(fullContent(p, store.blobs)).toBe(big(9000));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a read cut by the output limit', () => {
  it('counts only the lines it showed whole, so the next offset starts at the first one it did not', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-partial-'));
    const file = path.join(dir, 'long.txt');
    // Past the point truncation looks back for a line end, the output stops inside a line.
    fs.writeFileSync(file, `short\n${'y'.repeat(1900)}\n${'z'.repeat(1900)}\nlast\n`);
    const files = new FileTracker();
    const ctx = { cwd: dir, callId: 'c', files, outputChars: 2500, signal: new AbortController().signal, config: {} } as unknown as ToolContext;
    const out = await readTool.execute({ path: file }, ctx);
    expect(out.content).toContain('offset=3');
    expect(out.content).not.toContain('zzzz');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('what counts as superseded', () => {
  const rounds = (...reads: [string, string[], boolean?][]) => [
    user('Go.'),
    ...reads.flatMap(([id, paths, failed]) => {
      const r = result(id, 'read', big(3000));
      if (failed) (r.parts[0] as ToolResultPart).isError = true;
      return [call(id, 'read', { paths }), r];
    }),
    call('z1', 'shell', { command: 'a' }),
    result('z1', 'shell', 'ok'),
    call('z2', 'shell', { command: 'b' }),
    result('z2', 'shell', 'ok'),
    call('z3', 'shell', { command: 'c' }),
    result('z3', 'shell', 'ok'),
  ];
  const cut = (m: Message[]) => planPrune(m, 0, 3).map((i) => i.callId);

  it('the same lines read again replace the old read', () => {
    expect(cut(rounds(['r1', ['a.ts']], ['r2', ['a.ts']]))).toEqual(['r1']);
  });
  it('other lines of the file replace nothing', () => {
    expect(cut(rounds(['r1', ['a.ts:1-50']], ['r2', ['a.ts:100-200']]))).toEqual([]);
  });
  it('one file of several read again leaves the read of both', () => {
    expect(cut(rounds(['r1', ['a.ts', 'b.ts']], ['r2', ['a.ts']]))).toEqual([]);
    expect(cut(rounds(['r1', ['a.ts', 'b.ts']], ['r2', ['a.ts']], ['r3', ['b.ts']]))).toEqual(['r1']);
  });
  it('a read that failed answers nothing', () => {
    expect(cut(rounds(['r1', ['a.ts']], ['r2', ['a.ts'], true]))).toEqual([]);
  });
});

describe('full compaction keeps', () => {
  it("every word the user said, carried across summaries, newest whole", () => {
    const summary: Message = { id: 'sum', role: 'user', origin: 'compaction', parts: [{ type: 'text', text: 'summary', synthetic: true }], time: 1, carried: ['First request.', 'Second request.'] };
    expect(userWords([summary, user('Third.'), call('x', 'read', {}), user('Fourth.')])).toEqual(['First request.', 'Second request.', 'Third.', 'Fourth.']);
    // A large window keeps far more multi-turn instructions, while capping any single giant paste so earlier turns stay whole.
    expect(
      userWords([user(big(10000)), user(big(10000)), user(big(10000)), user(big(10000)), user(big(3000))], 400_000).join('').length,
    ).toBe(43000);
    const singlePaste = userWords([user(big(40000)), user(big(3000))], 400_000);
    expect(singlePaste[0].length).toBeLessThanOrEqual(12_000);
    expect(singlePaste[0]).toContain('recall finds the rest with message=0, from=');
    expect(singlePaste[1]).toBe(big(3000));
    // A 500 KB paste in Turn 3 never erases Turn 1 or Turn 2.
    const threeTurns = userWords([user('Turn 1: port 8443.'), user('Turn 2: timeout 30s.'), user(big(500_000))], 256_000);
    expect(threeTurns[0]).toBe('Turn 1: port 8443.');
    expect(threeTurns[1]).toBe('Turn 2: timeout 30s.');
    expect(threeTurns[2].length).toBeLessThanOrEqual(12_000);
    expect(threeTurns[2]).toContain('message=2, from=');
    // Thirty 6,000-char user turns at 256k (budget 89,600) preserve every turn without starving any turn to 0.
    const thirty = userWords(Array.from({ length: 30 }, (_, i) => user(`[t${i}] ${big(5990)}`)), 256_000);
    expect(thirty).toHaveLength(30);
    expect(thirty.join('').length).toBeLessThanOrEqual(89_600);
    for (let i = 0; i < 30; i++) expect(thirty[i].startsWith(`[t${i}]`)).toBe(true);
    // What they sent while the agent worked counts, and the budget holds however many messages there are.
    const note: Message = { id: 'n', role: 'user', origin: 'tool', parts: [{ type: 'text', text: 'The user sent this...', synthetic: true, said: 'Use port 8080.' }], time: 1 };
    expect(userWords([user('Start.'), note])).toEqual(['Start.', 'Use port 8080.']);
    const many = userWords(Array.from({ length: 200 }, () => user(big(1000))));
    expect(many.join('').length).toBeLessThanOrEqual(16_100);
    expect(many[0]).toContain('recall finds them');
    expect(userWords([{ ...user('x'), origin: 'compaction', role: 'user', carried: many } as Message, user('Next.')]).filter((t) => t.includes('recall finds them'))).toHaveLength(1);
    const long = userWords([user(big(15000)), user(big(3000))]);
    expect(long[1]).toBe(big(3000));
    expect(long[0].length).toBeLessThan(15000);
    expect(long[0]).toContain('recall finds the rest');
  });

  it('the last tool rounds, starting at an assistant message: at most twelve, within the budget', () => {
    const s = session();
    const tail = tailOf(s, 100_000);
    expect(tail[0].role).toBe('assistant');
    expect(tail.filter((m) => m.role === 'assistant')).toHaveLength(7);
    expect(tail.at(-1)!.id).toBe(s.at(-1)!.id);
    expect(tailOf(s, 10)).toEqual([]);
    const long = [user('Go.'), ...Array.from({ length: 20 }, (_, i) => [call(`k${i}`, 'shell', { command: `step ${i}` }), result(`k${i}`, 'shell', big(400))]).flat()];
    expect(tailOf(long, 100_000).filter((m) => m.role === 'assistant')).toHaveLength(12);
    expect(tailOf(long, 1_000).filter((m) => m.role === 'assistant').length).toBeLessThan(12);
  });

  it('keeps the last round when not even it fits, up to twice the room: the next step works from what it showed', () => {
    const s = [user('Go.'), call('r1', 'shell', { command: 'git show HEAD~1:src/codec.ts' }), result('r1', 'shell', big(4000))];
    const size = tailOf(s, 100_000).reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0);
    expect(tailOf(s, Math.ceil(size * 0.6)).map((m) => m.id)).toEqual(s.slice(1).map((m) => m.id));
    expect(tailOf(s, Math.floor(size * 0.4))).toEqual([]);
  });
});

describe('recall', () => {
  it('returns a full output by call id and finds words anywhere in the history', async () => {
    const blobs = new BlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-recall-')));
    const history = session();
    const log = history[6].parts[0] as ToolResultPart;
    log.content = `${'ok\n'.repeat(500)}ERROR ENOENT: no such file src/missing.ts\n${'ok\n'.repeat(500)}`;
    log.contentBlob = blobs.put(log.content);
    log.content = 'stub';
    log.pruned = true;
    const ctx = { history: () => history, blobs, outputChars: 50_000 } as unknown as ToolContext;
    const full = await recallTool.execute({ callId: 'c3' }, ctx);
    expect(full.content).toContain('ERROR ENOENT: no such file src/missing.ts');
    expect(full.content.startsWith('shell {"command":"cat build.log"}')).toBe(true);
    const found = await recallTool.execute({ query: 'ENOENT' }, ctx);
    expect(found.content).toMatch(/^1 match/);
    expect(found.content).toContain('output of shell (call_id c3)');
    const words = await recallTool.execute({ query: 'old API' }, ctx);
    expect(words.content).toContain('user');
    expect(words.content).toContain('keep the old API');
    expect((await recallTool.execute({ callId: 'nope' }, ctx)).isError).toBe(true);
  });

  it('slices long user messages by message=#N + from, reads textBlob when clipped, and surfaces multiple hits per message', async () => {
    const blobs = new BlobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-recall-msg-')));
    const chunkA = `${'a'.repeat(40_000)}NEEDLE_ALPHA=101${'a'.repeat(160_000)}`;
    const chunkB = `NEEDLE_BETA=202${'b'.repeat(180_000)}`;
    const chunkC = `NEEDLE_GAMMA=303${'c'.repeat(120_000)}`;
    const rawHuge = `${chunkA}${chunkB}${chunkC}`;
    const blobId = blobs.put(rawHuge);
    const clippedMsg: Message = {
      id: 'u_huge',
      role: 'user',
      origin: 'user',
      parts: [
        { type: 'text', text: '<harness-note>project facts</harness-note>', synthetic: true },
        { type: 'text', text: `${rawHuge.slice(0, 500)}\n[omitted]\n${rawHuge.slice(-200)}`, textBlob: blobId },
      ],
      time: 1,
    };
    const history: Message[] = [clippedMsg, call('c1', 'read', { paths: ['a.ts'] }), result('c1', 'read', 'ok')];
    const ctx = { history: () => history, blobs, outputChars: 30_000 } as unknown as ToolContext;

    const carried = userWords(history, 256_000, blobs);
    const m = /message=(\d+), from=(\d+)/.exec(carried[0]);
    expect(m).not.toBeNull();
    const msgIdx = Number(m![1]);
    const fromOffset = Number(m![2]);
    expect(msgIdx).toBe(0);
    const slice = await recallTool.execute({ message: msgIdx, from: fromOffset }, ctx);
    expect(slice.content).toContain(rawHuge.slice(fromOffset, fromOffset + 120));

    const targeted = await recallTool.execute({ message: 0, query: 'NEEDLE_BETA' }, ctx);
    expect(targeted.content).toContain('NEEDLE_BETA=202');

    const multi = await recallTool.execute({ query: 'NEEDLE_' }, ctx);
    expect(multi.content).toContain('NEEDLE_ALPHA=101');
    expect(multi.content).toContain('NEEDLE_BETA=202');
    expect(multi.content).toContain('NEEDLE_GAMMA=303');
  });
});

describe('repeated reads', () => {
  it('point back to unchanged lines still in context, and serve them again once they are not', async () => {
    const { readTool } = await import('../src/tools/fs-tools');
    const { FileTracker, describeCoverage } = await import('../src/tools/filestate');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-reread-'));
    try {
      const file = path.join(dir, 'a.ts');
      fs.writeFileSync(file, Array.from({ length: 300 }, (_, i) => `const v${i} = ${i};`).join('\n'));
      const files = new FileTracker();
      let visible = true;
      const ctx = (callId: string) => ({ cwd: dir, callId, files, outputChars: 100_000, model: { vision: false }, inContext: () => visible }) as unknown as ToolContext;
      const first = await readTool.execute({ path: 'a.ts' }, ctx('r1'));
      expect(first.content).toContain('const v299 = 299;');
      const again = await readTool.execute({ path: 'a.ts', offset: 100, limit: 20 }, ctx('r2'));
      expect(again.content).toMatch(/lines 100-119 have not changed since call r1/);
      // Cut from context (pruned or compacted): the text comes back.
      visible = false;
      expect((await readTool.execute({ path: 'a.ts', offset: 100, limit: 20 }, ctx('r3'))).content).toContain('const v99 = 99;');
      // Changed on disk: the earlier output is stale.
      visible = true;
      fs.appendFileSync(file, '\nconst extra = 1;');
      expect((await readTool.execute({ path: 'a.ts', offset: 100, limit: 20 }, ctx('r4'))).content).toContain('const v99 = 99;');
      expect(files.coverage()[0].ranges).toEqual([[100, 119]]);
      files.recordShown(file, 'r5', 1, 40, 301);
      files.recordShown(file, 'r6', 41, 60, 301);
      files.recordShown(file, 'r7', 90, 90, 301);
      const c = files.coverage()[0];
      expect(describeCoverage(c.ranges, c.total)).toBe('lines 1-60, 90, 100-119 of 301 (not read: 61-89, 91-99, 120-301)');
      expect(describeCoverage([[1, 301]], 301)).toBe('all 301 lines');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves earlierRead pointers for lines strictly above an in-place edit and invalidates edited or externally touched regions', async () => {
    const { readTool, editTool } = await import('../src/tools/fs-tools');
    const { FileTracker } = await import('../src/tools/filestate');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-edit-reread-'));
    try {
      const file = path.join(dir, 'mod.ts');
      fs.writeFileSync(file, Array.from({ length: 260 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n');
      const files = new FileTracker();
      const ctx = (callId: string) =>
        ({
          cwd: dir,
          callId,
          turn: 't1',
          files,
          checkpoints: { capture: () => {} },
          outputChars: 100_000,
          model: { vision: false },
          inContext: () => true,
        }) as unknown as ToolContext;

      const r1 = await readTool.execute({ path: 'mod.ts', offset: 1, limit: 260 }, ctx('r1'));
      expect(r1.content).toContain('export const line260 = 260;');

      // Edit line 220: lines 1..219 remain unchanged at the exact same line numbers.
      const e1 = await editTool.execute({ path: 'mod.ts', old: 'export const line220 = 220;', new: 'export const line220 = 2200;\nexport const line220b = 1;' }, ctx('e1'));
      expect(e1.isError).toBeFalsy();

      const headerAgain = await readTool.execute({ path: 'mod.ts', offset: 1, limit: 80 }, ctx('r2'));
      expect(headerAgain.content).toMatch(/lines 1-80 have not changed since call r1/);

      const editedRegion = await readTool.execute({ path: 'mod.ts', offset: 215, limit: 15 }, ctx('r3'));
      expect(editedRegion.content).toContain('export const line220 = 2200;');
      expect(editedRegion.content).toContain('export const line220b = 1;');

      // If an external command alters line 5 before a requireRead: false edit at line 240, stale pre-edit coverage is dropped.
      const raw = fs.readFileSync(file, 'utf8').replace('export const line5 = 5;', 'export const line5 = 555;');
      fs.writeFileSync(file, raw);
      await editTool.execute({ path: 'mod.ts', old: 'export const line240 = 240;', new: 'export const line240 = 2400;', requireRead: false }, ctx('e2'));
      const afterExternal = await readTool.execute({ path: 'mod.ts', offset: 1, limit: 20 }, ctx('r4'));
      expect(afterExternal.content).toContain('export const line5 = 555;');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
