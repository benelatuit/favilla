import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/store/sessions';
import { fullContent } from '../src/store/pack';
import { openLines, unseal } from '../src/store/seal';
import type { Message, SessionMeta, ToolResultPart } from '../src/types';

// A branch's file names its history in its source's file instead of holding it again: what is read back, what the
// source does later, repacking either file, and deleting them in any order.

const meta = (id: string, cwd: string, more: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: id,
  cwd,
  created: 1,
  updated: 1,
  provider: 'openai',
  model: 'gpt-6-luna',
  effort: 'medium',
  mode: 'build',
  profile: 'codex',
  ...more,
});

const say = (id: string, role: 'user' | 'assistant', text: string): Message => ({ id, role, parts: [{ type: 'text', text }], time: 1 });
const ids = (ms: Message[]) => ms.map((m) => m.id);
const kinds = (store: SessionStore, m: SessionMeta) =>
  openLines(fs.readFileSync(`${store.dataDir(m)}.jsonl`, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).t);
const sizeOf = (store: SessionStore, m: SessionMeta) => fs.statSync(`${store.dataDir(m)}.jsonl`).size;
const output = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of a long build log`).join('\n');

/** A source of messages m0..m{n-1}, long enough that copying them would show. */
function source(store: SessionStore, id: string, cwd: string, n: number): SessionMeta {
  const m = meta(id, cwd);
  store.create(m, 'S');
  for (let i = 0; i < n; i++) store.saveMessage(m, say(`m${i}`, i % 2 ? 'assistant' : 'user', `message ${i} ${'x'.repeat(2000)}`));
  return m;
}

/** A branch reading the first `at` messages of `src`, written as Session.fork writes one. */
function branch(store: SessionStore, src: SessionMeta, id: string, at: number): SessionMeta {
  const b = meta(id, src.cwd, { base: { id: src.id, messages: at }, branchOf: { id: src.id, title: src.title, message: `m${at}` } });
  store.create(b, 'S');
  store.saveBase(b, { id: src.id, messages: at });
  store.saveMeta(b);
  return b;
}

function withRoot(fn: (root: string) => Promise<void> | void) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-branch-store-'));
    try {
      await fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('branch storage', () => {
  it(
    'a branch holds one line for its history and reads it back from its source, whatever the source does later',
    withRoot(async (root) => {
      const store = new SessionStore(root);
      const cwd = path.join(root, 'p');
      const src = meta('s', cwd);
      store.create(src, 'S');
      const long = output(500);
      store.saveMessage(src, say('m0', 'user', 'build it'));
      store.saveMessage(src, { id: 'm1', role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'make' }, raw: '{"command":"make"}' }], time: 1 });
      store.saveMessage(src, { id: 'm2', role: 'user', parts: [{ type: 'tool_result', callId: 'c1', name: 'Bash', content: long }], time: 1 });
      store.saveMessage(src, { id: 'm3', role: 'user', origin: 'compaction', parts: [{ type: 'text', text: 'summary' }], time: 1 });
      store.saveCompaction(src, 3);
      store.saveMessage(src, say('m4', 'assistant', 'built'));
      store.saveMessage(src, say('m5', 'user', 'now test it'));
      // Branched at m5, as Session.fork writes it: the compaction it has is its own line.
      const b = branch(store, src, 'b', 5);
      store.saveCompaction(b, 3);
      store.saveMessage(b, say('b5', 'user', 'now ship it'));
      store.flushIndex();

      expect(kinds(store, b)).toEqual(['session', 'base', 'meta', 'compact', 'msg']);
      expect(sizeOf(store, b)).toBeLessThan(sizeOf(store, src) / 4);
      expect(ids(store.load('b')!.messages)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'b5']);
      expect(ids((await store.loadAsync('b'))!.messages)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'b5']);

      // The source goes on: more messages, an output cut short, another compaction, then a repack into cold storage.
      store.saveMessage(src, say('m6', 'assistant', 'tested'));
      store.savePrune(src, [{ callId: 'c1', stub: '[cut]', blob: store.blobs.put(long) }]);
      store.saveMessage(src, { id: 'sum', role: 'user', origin: 'compaction', parts: [{ type: 'text', text: 'summary again' }], time: 1 });
      store.saveCompaction(src, 7);
      store.flushIndex();
      expect(await store.freeze('s')).toBe(true);

      const rec = new SessionStore(root).load('b')!;
      expect(ids(rec.messages)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'b5']);
      expect(rec.activeStart).toBe(3);
      const result = rec.messages[2].parts[0] as ToolResultPart;
      expect(result.pruned).toBeFalsy();
      expect(fullContent(result, store.blobs)).toBe(long);
      expect(rec.messages[1].parts[0]).toMatchObject({ type: 'tool_call', input: { command: 'make' } });
      // Reading the branch writes nothing into it: the blobs of the history it reads are its source's to record.
      expect(kinds(store, b)).toEqual(['session', 'base', 'meta', 'compact', 'msg']);
    }),
  );

  it(
    'reads a branch of a branch through both files',
    withRoot(async (root) => {
      const store = new SessionStore(root);
      const src = source(store, 's', path.join(root, 'p'), 4);
      const b1 = branch(store, src, 'b1', 3);
      store.saveMessage(b1, say('b3', 'user', 'other way'));
      store.saveMessage(b1, say('b4', 'assistant', 'ok'));
      const b2 = meta('b2', src.cwd, { base: { id: 'b1', messages: 4 } });
      store.create(b2, 'S');
      store.saveBase(b2, { id: 'b1', messages: 4 });
      store.saveMessage(b2, say('c4', 'assistant', 'a third way'));
      store.flushIndex();
      expect(ids(store.load('b2')!.messages)).toEqual(['m0', 'm1', 'm2', 'b3', 'c4']);
      expect(ids((await new SessionStore(root).loadAsync('b2'))!.messages)).toEqual(['m0', 'm1', 'm2', 'b3', 'c4']);
    }),
  );

  it(
    'repacks a branch counting its own messages after the ones it reads',
    withRoot(async (root) => {
      const store = new SessionStore(root);
      const src = source(store, 's', path.join(root, 'p'), 3);
      const b = branch(store, src, 'b', 3);
      const reasoning = (enc: string) => ({ type: 'reasoning' as const, text: 'thinking', provider: 'openai', model: 'gpt-6-luna', encrypted: enc });
      store.saveMessage(b, { id: 'b3', role: 'assistant', parts: [reasoning('OWN-OLD'), { type: 'text', text: 'first' }], time: 1 });
      store.saveMessage(b, { id: 'sum', role: 'user', origin: 'compaction', parts: [{ type: 'text', text: 'summary' }], time: 1 });
      store.saveCompaction(b, 4);
      store.saveMessage(b, { id: 'b5', role: 'assistant', parts: [reasoning('OWN-NEW'), { type: 'text', text: 'next' }], time: 1 });
      store.flushIndex();
      expect(await store.freeze('b')).toBe(true);

      // Message 3 is before the compaction and lets its replay data go; message 5 is in the context and keeps it.
      const cold = zlib.brotliDecompressSync(unseal(fs.readFileSync(`${store.dataDir(b)}.jsonl.br`))).toString('utf8');
      expect(cold.includes('OWN-OLD')).toBe(false);
      expect(cold.includes('OWN-NEW')).toBe(true);
      const rec = new SessionStore(root).load('b')!;
      expect(ids(rec.messages)).toEqual(['m0', 'm1', 'm2', 'b3', 'sum', 'b5']);
      expect(rec.activeStart).toBe(4);
      expect(rec.messages[5].parts[0]).toMatchObject({ type: 'reasoning', encrypted: 'OWN-NEW' });
    }),
  );

  it(
    'keeps a deleted source hidden while branches read it, and lets it go with the last of them',
    withRoot(async (root) => {
      const store = new SessionStore(root);
      const src = source(store, 's', path.join(root, 'p'), 4);
      const b1 = branch(store, src, 'b1', 2);
      const b2 = meta('b2', src.cwd, { base: { id: 'b1', messages: 2 } });
      store.create(b2, 'S');
      store.saveBase(b2, { id: 'b1', messages: 2 });
      store.saveMessage(b2, say('c2', 'user', 'again'));
      store.flushIndex();

      store.delete('s');
      store.delete('b1');
      expect(store.list().map((m) => m.id)).toEqual(['b2']);
      expect(ids(store.load('b2')!.messages)).toEqual(['m0', 'm1', 'c2']);
      // The mark is in their own files too: an index rebuilt from the files leaves them out.
      fs.rmSync(path.join(root, 'index.json'), { force: true });
      const rebuilt = new SessionStore(root);
      expect(await rebuilt.recoverOrphans()).toBe(3);
      expect(rebuilt.list().map((m) => m.id)).toEqual(['b2']);
      expect(rebuilt.metaOf('s')?.hidden).toBe(true);

      rebuilt.delete('b2');
      expect(rebuilt.metaOf('b1')).toBeNull();
      expect(rebuilt.metaOf('s')).toBeNull();
      for (const m of [src, b1, b2]) {
        expect(fs.existsSync(`${store.dataDir(m)}.jsonl`)).toBe(false);
        expect(fs.existsSync(`${store.dataDir(m)}.jsonl.br`)).toBe(false);
      }
    }),
  );
});
