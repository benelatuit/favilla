import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/store/sessions';
import { BlobStore, blobIds } from '../src/store/blobs';
import { fullContent, fullDisplay, lighten, lightResult, PREVIEW_CHARS } from '../src/store/pack';
import { openLines, unseal } from '../src/store/seal';
import { Checkpoints } from '../src/agent/checkpoints';
import type { ImagePart, SessionMeta, ToolResultPart } from '../src/types';

const meta = (id: string, cwd: string): SessionMeta => ({
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
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-pack-'));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(3000, 7)]);
const shot = (): ImagePart => ({ type: 'image', mediaType: 'image/png', data: png.toString('base64') });
const output = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of a long build log`).join('\n');

function withRoot(fn: (root: string) => Promise<void> | void) {
  return async () => {
    const root = tmp();
    try {
      await fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('compact storage', () => {
  it(
    'reuses released previews while serving full output and respecting missing or changed blobs',
    withRoot((root) => {
      const blobs = new BlobStore(root);
      const text = output(900);
      const contentBlob = blobs.put(text);
      const rawDisplay = { kind: 'terminal', command: 'build', output: text, exitCode: 0, durationMs: 20, cwd: root };
      const displayBlob = blobs.put(JSON.stringify(rawDisplay));
      const content: ToolResultPart = { type: 'tool_result', name: 'read', callId: 'c1', content: 'stub', pruned: true, contentBlob };
      const terminal: ToolResultPart = { type: 'tool_result', name: 'shell', callId: 'c2', content: '', displayBlob };
      const view = (part: ToolResultPart) => lightResult(part, blobs, (id) => id);
      const decompress = vi.spyOn(zlib, 'brotliDecompressSync');
      try {
        const preview = view(content);
        const clipped = view(terminal);
        expect(preview).toMatchObject({ content: text.slice(0, PREVIEW_CHARS), truncated: true });
        expect(clipped.content).toBe('');
        expect(clipped.display).toMatchObject({ kind: 'terminal', clipped: true });
        expect(decompress).toHaveBeenCalledTimes(2);
        expect(view(content)).toEqual(preview);
        expect(view(terminal)).toEqual(clipped);
        expect(decompress).toHaveBeenCalledTimes(2);
        expect(fullContent(content, blobs)).toBe(text);
        expect(fullDisplay(terminal, blobs)).toEqual(rawDisplay);

        const file = path.join(root, contentBlob.slice(0, 2), contentBlob);
        const original = fs.readFileSync(file);
        fs.rmSync(file);
        expect(view(content).content).toBe('stub');
        fs.writeFileSync(file, Buffer.from('invalid Brotli'));
        expect(view(content).content).toBe('stub');
        fs.writeFileSync(file, original);
        expect(view(content)).toEqual(preview);
      } finally {
        decompress.mockRestore();
      }
    }),
  );
  it(
    'keeps one copy of each blob, compressed when it is text',
    withRoot((root) => {
      const blobs = new BlobStore(root);
      const text = output(2000);
      const a = blobs.put(text);
      expect(blobs.put(text)).toBe(a);
      expect(a.endsWith('.br')).toBe(true);
      expect(blobs.text(a)).toBe(text);
      expect(fs.statSync(path.join(root, a.slice(0, 2), a)).size).toBeLessThan(text.length / 5);
      const b = blobs.put(png, false);
      expect(b.endsWith('.bin')).toBe(true);
      expect(blobs.get(b)?.equals(png)).toBe(true);
      expect(blobs.get('../../etc/passwd')).toBeNull();
    }),
  );

  it(
    'stores images once outside the session file and brings them back for the active context',
    withRoot((root) => {
      const store = new SessionStore(root);
      const m = meta('s1', path.join(root, 'p'));
      store.create(m, 'S');
      for (let i = 0; i < 3; i++) store.saveMessage(m, { id: `u${i}`, role: 'user', parts: [{ type: 'text', text: 'look' }, shot()], time: i });
      store.flushIndex();
      const file = openLines(fs.readFileSync(`${store.dataDir(m)}.jsonl`, 'utf8'));
      expect(file.includes(png.toString('base64').slice(0, 200))).toBe(false);
      expect(new Set(blobIds(file)).size).toBe(1);
      const img = new SessionStore(root).load('s1')!.messages[2].parts[1] as ImagePart;
      expect(Buffer.from(img.data, 'base64').equals(png)).toBe(true);
    }),
  );

  it(
    'freezes an idle session file and thaws it on the next write',
    withRoot(async (root) => {
      const store = new SessionStore(root);
      const m = meta('s2', path.join(root, 'p'));
      store.create(m, 'S');
      for (let i = 0; i < 40; i++) {
        store.saveMessage(m, { id: `t${i}`, role: 'user', parts: [{ type: 'tool_result', callId: `c${i}`, name: 'Bash', content: output(300) }], time: i });
      }
      store.flushIndex();
      const hot = `${store.dataDir(m)}.jsonl`;
      const plain = fs.statSync(hot).size;
      expect(await store.freeze('s2')).toBe(true);
      expect(fs.existsSync(hot)).toBe(false);
      expect(fs.statSync(`${hot}.br`).size).toBeLessThan(plain / 20);
      expect(new SessionStore(root).load('s2')!.messages).toHaveLength(40);
      store.saveMessage(m, { id: 'after', role: 'assistant', parts: [{ type: 'text', text: 'done' }], time: 99 });
      expect(fs.existsSync(`${hot}.br`)).toBe(false);
      // Thawed beside the file and renamed into place, with nothing left over.
      expect(fs.readdirSync(path.dirname(hot)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      expect(new SessionStore(root).load('s2')!.messages.at(-1)?.id).toBe('after');
    }),
  );

  it(
    'reads a session letting the thread go, to the same record as reading it at once',
    withRoot(async (root) => {
      const store = new SessionStore(root);
      const m = meta('s7', path.join(root, 'p'));
      store.create(m, 'S');
      const long = output(1200);
      for (let i = 0; i < 300; i++) {
        store.saveMessage(m, { id: `t${i}`, role: 'user', parts: [{ type: 'tool_result', callId: `c${i}`, name: 'Bash', content: output(400) }, ...(i % 50 ? [] : [shot()])], time: i });
        store.saveMessage(m, { id: `a${i}`, role: 'assistant', parts: [{ type: 'text', text: `step ${i}` }], time: i });
      }
      store.saveMessage(m, { id: 'old', role: 'user', parts: [{ type: 'tool_result', callId: 'cx', name: 'Bash', content: long }], time: 900 });
      store.savePrune(m, [{ callId: 'c3', stub: '[pruned]', blob: store.blobs.put(output(400)) }]);
      store.saveCompaction(m, 200);
      store.saveTodos(m, [{ content: 'check', status: 'pending' } as never]);
      store.flushIndex();
      const hot = new SessionStore(root).load('s7');
      expect(await store.freeze('s7')).toBe(true);
      const frozen = new SessionStore(root);
      let longest = 0;
      let last = performance.now();
      const tick = setInterval(() => {
        longest = Math.max(longest, performance.now() - last);
        last = performance.now();
      }, 2);
      const read = await frozen.loadAsync('s7');
      await new Promise((r) => setTimeout(r, 10));
      clearInterval(tick);
      expect(JSON.stringify(read)).toBe(JSON.stringify(hot));
      expect(read!.messages).toHaveLength(601);
      expect(read!.activeStart).toBe(200);
      expect(longest).toBeLessThan(150);
      expect(await frozen.loadAsync('nothing')).toBeNull();
    }),
  );

  it(
    'keeps only the active context in memory, records what it released, and gives the UI previews',
    withRoot((root) => {
      const store = new SessionStore(root);
      const m = meta('s3', path.join(root, 'p'));
      store.create(m, 'S');
      const long = output(1200);
      store.saveMessage(m, {
        id: 'old',
        role: 'user',
        parts: [{ type: 'tool_result', callId: 'c1', name: 'Bash', content: long, display: { kind: 'terminal', command: 'make', output: long, exitCode: 0, durationMs: 5, cwd: '.' } }],
        time: 1,
      });
      store.saveMessage(m, { id: 'sum', role: 'user', origin: 'compaction', parts: [{ type: 'text', text: 'summary' }], time: 2 });
      store.saveCompaction(m, 1);
      store.flushIndex();

      const rec = new SessionStore(root).load('s3')!;
      const old = rec.messages[0].parts[0] as ToolResultPart;
      expect(old.content).toBe('');
      expect(old.display).toBeUndefined();
      expect(fullContent(old, store.blobs)).toBe(long);
      // The ids are on disk now, so housekeeping keeps the blobs while the session exists.
      const lines = openLines(fs.readFileSync(`${store.dataDir(m)}.jsonl`, 'utf8'));
      expect(lines).toContain('"t":"released"');
      expect(blobIds(lines)).toEqual(expect.arrayContaining([old.contentBlob!, old.displayBlob!]));

      // A terminal shows its own output, clipped to the end; the text the model got is not sent at all.
      const view = lighten(rec.messages[0], store.blobs, (id) => `/api/blob/${id}`).parts[0] as ToolResultPart;
      expect(view.content).toBe('');
      expect(view.display?.kind === 'terminal' && view.display.clipped).toBe(true);
      expect(view.display?.kind === 'terminal' && long.endsWith(view.display.output)).toBe(true);
      // A result without a view arrives as a preview.
      const plain = lighten({ id: 'x', role: 'user', parts: [{ type: 'tool_result', callId: 'c9', name: 'web_fetch', content: long }], time: 1 }, store.blobs, (id) => id).parts[0] as ToolResultPart;
      expect(plain.truncated).toBe(true);
      expect(plain.content.length).toBe(PREVIEW_CHARS);

      // Loading again records nothing new.
      new SessionStore(root).load('s3');
      expect(openLines(fs.readFileSync(`${store.dataDir(m)}.jsonl`, 'utf8')).match(/"t":"released"/g)).toHaveLength(1);
    }),
  );

  it(
    'collects blobs nothing refers to, and spares those sessions and snapshots use',
    withRoot(async (root) => {
      const store = new SessionStore(root);
      const m = meta('s4', path.join(root, 'p'));
      store.create(m, 'S');
      store.saveMessage(m, { id: 'u', role: 'user', parts: [shot()], time: 1 });
      store.flushIndex();
      const checkpoints = new Checkpoints(path.join(store.dataDir(m), 'checkpoints'), store.blobs);
      const src = path.join(root, 'file.txt');
      fs.writeFileSync(src, 'before');
      checkpoints.capture('turn1', src);
      const orphan = store.blobs.put('nobody refers to this');
      await store.freeze('s4');

      // Only blobs older than a day are candidates.
      const old = new Date(Date.now() - 3 * 24 * 3600_000);
      for (const d of fs.readdirSync(store.blobs.root)) {
        if (d.length !== 2) continue;
        for (const f of fs.readdirSync(path.join(store.blobs.root, d))) fs.utimesSync(path.join(store.blobs.root, d, f), old, old);
      }
      const r = await store.collectGarbage(true);
      expect(r.removed).toBe(1);
      expect(store.blobs.has(orphan)).toBe(false);
      expect((new SessionStore(root).load('s4')!.messages[0].parts[0] as ImagePart).data.length).toBeGreaterThan(0);

      fs.writeFileSync(src, 'after');
      expect((await checkpoints.changesAsync('turn1'))[0].before).toBe('before');
      await checkpoints.revertFrom('turn1');
      expect(fs.readFileSync(src, 'utf8')).toBe('before');
    }),
  );

  it(
    'writes a tool call input once when its raw text spells it out',
    withRoot((root) => {
      const store = new SessionStore(root);
      const m = meta('s5', path.join(root, 'p'));
      store.create(m, 'S');
      const raw = '{"command": "ls -la",  "timeout_ms": 5000}';
      store.saveMessage(m, {
        id: 'a',
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'c1', name: 'shell_command', input: { command: 'ls -la', timeout_ms: 5000 }, raw },
          { type: 'tool_call', id: 'c2', name: 'apply_patch', input: { input: '*** Begin Patch' }, raw: '*** Begin Patch', custom: true },
          // Input the harness changed after parsing: both are kept.
          { type: 'tool_call', id: 'c3', name: 'read_file', input: { path: '/abs/a.ts' }, raw: '{"path":"a.ts"}' },
        ],
        time: 1,
      });
      store.flushIndex();
      const line = JSON.parse(openLines(fs.readFileSync(`${store.dataDir(m)}.jsonl`, 'utf8')).split('\n')[1]);
      expect(line.m.parts.map((p: { input?: unknown }) => p.input === undefined)).toEqual([true, true, false]);
      const parts = new SessionStore(root).load('s5')!.messages[0].parts;
      expect(parts.map((p) => (p.type === 'tool_call' ? p.input : null))).toEqual([{ command: 'ls -la', timeout_ms: 5000 }, { input: '*** Begin Patch' }, { path: '/abs/a.ts' }]);
      expect(parts[0].type === 'tool_call' && parts[0].raw).toBe(raw);
    }),
  );

  it(
    'repacks a frozen session: old outputs kept once in the blob store, old replay data dropped, the active context exact',
    withRoot(async (root) => {
      const store = new SessionStore(root);
      const m = meta('s6', path.join(root, 'p'));
      store.create(m, 'S');
      const long = output(500);
      const reasoning = (enc: string) => ({ type: 'reasoning' as const, text: 'thinking', provider: 'openai', model: 'gpt-6-luna', encrypted: enc });
      store.saveMessage(m, { id: 'a1', role: 'assistant', parts: [reasoning('OLD-SECRET'), { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'make' }, raw: '{"command":"make"}' }], time: 1 });
      store.saveMessage(m, { id: 'r1', role: 'user', parts: [{ type: 'tool_result', callId: 'c1', name: 'Bash', content: long }], time: 2 });
      store.saveMessage(m, { id: 'sum', role: 'user', origin: 'compaction', parts: [{ type: 'text', text: 'summary' }], time: 3 });
      store.saveCompaction(m, 2);
      store.saveMessage(m, { id: 'a2', role: 'assistant', parts: [reasoning('NEW-SECRET'), { type: 'text', text: 'next' }], time: 4 });
      store.flushIndex();
      expect(await store.freeze('s6')).toBe(true);

      const cold = zlib.brotliDecompressSync(unseal(fs.readFileSync(`${store.dataDir(m)}.jsonl.br`))).toString('utf8');
      expect(cold.includes(long.slice(0, 500))).toBe(false);
      expect(cold.includes('OLD-SECRET')).toBe(false);
      expect(cold.includes('NEW-SECRET')).toBe(true);

      const rec = new SessionStore(root).load('s6')!;
      expect(rec.activeStart).toBe(2);
      expect(fullContent(rec.messages[1].parts[0] as ToolResultPart, store.blobs)).toBe(long);
      expect(rec.messages[0].parts[1]).toMatchObject({ type: 'tool_call', input: { command: 'make' } });
      expect(rec.messages[3].parts[0]).toMatchObject({ type: 'reasoning', encrypted: 'NEW-SECRET' });
      // Loading the repacked file does not make it plain again.
      expect(fs.existsSync(`${store.dataDir(m)}.jsonl`)).toBe(false);
    }),
  );

  it(
    'still reads snapshots written before the shared store',
    withRoot(async (root) => {
      const dir = path.join(root, 'checkpoints');
      const legacy = 'a'.repeat(64);
      fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'blobs', legacy), 'old content');
      const file = path.join(root, 'f.txt');
      fs.writeFileSync(file, 'new content');
      fs.writeFileSync(path.join(dir, 'index.jsonl'), `${JSON.stringify({ turn: 't', path: file, blob: legacy })}\n`);
      const cp = new Checkpoints(dir, new BlobStore(path.join(root, 'blobs')));
      expect((await cp.changesAsync('t'))[0].before).toBe('old content');
    }),
  );
});
