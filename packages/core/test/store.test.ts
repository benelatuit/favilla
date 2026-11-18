import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openLines, unseal } from '../src/store/seal';
import { buildChatBody } from '../src/providers/openai-chat';
import type { ProviderCall } from '../src/providers/types';
import { projectSlug } from '../src/util/paths';
import { SessionStore } from '../src/store/sessions';
import type { SessionMeta } from '../src/types';

const meta = (id: string, cwd: string, updated: number): SessionMeta => ({
  id,
  title: id,
  cwd,
  created: updated,
  updated,
  provider: 'openai',
  model: 'gpt-6-luna',
  effort: 'medium',
  mode: 'build',
  profile: 'codex',
});

describe('session index shared by several processes', () => {
  it('sees sessions another process wrote, and never drops them when writing its own', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-store-'));
    const folder = path.join(root, 'project');
    try {
      const app = new SessionStore(root);
      const cli = new SessionStore(root);
      expect(app.list({ cwd: folder })).toEqual([]);

      cli.create(meta('from-cli', folder.replace(/\\/g, '/'), 1), 'S');
      cli.flushIndex();
      await new Promise((r) => setTimeout(r, 20));
      // The app finds it, whichever slashes the other process used for the folder.
      expect(app.list({ cwd: folder }).map((m) => m.id)).toEqual(['from-cli']);

      app.create(meta('from-app', folder, 2), 'S');
      app.flushIndex();
      await new Promise((r) => setTimeout(r, 20));
      expect(cli.list({ cwd: folder }).map((m) => m.id)).toEqual(['from-app', 'from-cli']);

      cli.delete('from-cli');
      await new Promise((r) => setTimeout(r, 20));
      expect(app.list({ cwd: folder }).map((m) => m.id)).toEqual(['from-app']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const inFolder = async (run: (root: string, folder: string) => void | Promise<void>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-store-'));
    try {
      await run(root, path.join(root, 'project'));
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const refused = (code: string) => Object.assign(new Error(code), { code });
  it('opens a large archive asynchronously without changing the history or archive bytes', () =>
    inFolder(async (root, folder) => {
      const store = new SessionStore(root);
      const m = meta('large', folder, 1);
      store.create(m, randomBytes(160 * 1024).toString('base64'));
      store.saveMessage(m, { id: 'u', time: 1, role: 'user', parts: [{ type: 'text', text: '跨块🙂\n' }] });
      store.flushIndex();
      const before = JSON.stringify(store.load(m.id));
      expect(await store.freeze(m.id)).toBe(true);
      const file = path.join(root, projectSlug(folder), 'large.jsonl.br');
      const packed = fs.readFileSync(file);
      expect(unseal(packed).length).toBeGreaterThan(128 * 1024);
      expect(JSON.stringify(await store.loadAsync(m.id))).toBe(before);
      expect(fs.readFileSync(file).equals(packed)).toBe(true);
    }));
  it('loads the same request bytes and appends only previously unrecorded releases', () =>
    inFolder(async (root, folder) => {
      const store = new SessionStore(root);
      const m = meta('history', folder, 1);
      const system = 'S\n缓存🙂';
      const known = 'a'.repeat(40) + '.br';
      const text = 'abc'.repeat(700);
      store.create(m, system);
      store.saveMessage(m, { id: 'u', time: 1, role: 'user', parts: [{ type: 'text', text: known, textBlob: known }] });
      store.saveMessage(m, { id: 'r', time: 2, role: 'user', parts: [{ type: 'tool_result', name: 'read', callId: 'c', content: text }] });
      store.flushIndex();
      const file = path.join(root, projectSlug(folder), 'history.jsonl');
      const original = fs.readFileSync(file);
      const id = store.blobs.put(text);
      const rec = store.load(m.id)!;
      const body = buildChatBody({ system: rec.system, messages: rec.messages, model: { id: 'm', quirks: {}, efforts: [] }, provider: {}, tools: [] } as unknown as ProviderCall);
      const expected = `{"model":"m","messages":[{"role":"system","content":"S\\n缓存🙂"},{"role":"user","content":"${known}"},{"role":"tool","tool_call_id":"c","content":"${text}"}],"stream":true,"stream_options":{"include_usage":true}}`;
      expect(Buffer.from(JSON.stringify(body))).toEqual(Buffer.from(expected));
      expect(fs.readFileSync(file)).toEqual(original);
      store.saveCompaction(m, 2);
      const prefix = fs.readFileSync(file);
      expect((await store.loadAsync(m.id))!.messages[1].parts[0]).toMatchObject({ content: '', contentBlob: id });
      const appended = fs.readFileSync(file);
      expect(appended.subarray(0, prefix.length)).toEqual(prefix);
      expect(openLines(appended.subarray(prefix.length).toString())).toBe(`{"t":"released","ids":["${id}"]}\n`);
      store.load(m.id);
      expect(fs.readFileSync(file)).toEqual(appended);
    }));
  const onDisk = (root: string) => Object.keys(JSON.parse(unseal(fs.readFileSync(path.join(root, 'index.json'))).toString('utf8'))).sort();

  it('lives through Windows refusing to replace the index for a moment', () =>
    inFolder((root, folder) => {
      const store = new SessionStore(root);
      store.create(meta('a', folder, 1), 'S');
      store.flushIndex();
      const rename = fs.renameSync;
      let refusals = 3;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (refusals-- > 0) throw refused('EPERM');
        rename(from, to);
      });
      store.create(meta('b', folder, 2), 'S');
      store.flushIndex();
      expect(onDisk(root)).toEqual(['a', 'b']);
    }));

  it('never fails a session because the index cannot be written, and writes it later', () =>
    inFolder((root, folder) => {
      const store = new SessionStore(root);
      const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw refused('EPERM');
      });
      store.create(meta('a', folder, 1), 'S');
      expect(() => store.flushIndex()).not.toThrow();
      rename.mockRestore();
      store.flushIndex();
      expect(onDisk(root)).toEqual(['a']);
    }), 10_000);

  it('does not take an index it cannot read for an empty one', () =>
    inFolder((root, folder) => {
      const other = new SessionStore(root);
      other.create(meta('theirs', folder, 1), 'S');
      other.flushIndex();
      const store = new SessionStore(root);
      const read = fs.readFileSync;
      const index = path.join(root, 'index.json');
      const busy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: never[]) => {
        if (file === index) throw refused('EBUSY');
        return read(file, ...rest);
      }) as typeof fs.readFileSync);
      store.create(meta('mine', folder, 2), 'S');
      store.flushIndex();
      busy.mockRestore();
      expect(onDisk(root)).toEqual(['theirs']);
      store.flushIndex();
      expect(onDisk(root)).toEqual(['mine', 'theirs']);
    }));

  it('waits for a process holding the index, and takes over a lock left behind', () =>
    inFolder((root, folder) => {
      const lock = path.join(root, 'index.json.lock');
      fs.mkdirSync(lock, { recursive: true });
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);
      const store = new SessionStore(root);
      store.create(meta('a', folder, 1), 'S');
      store.flushIndex();
      expect(onDisk(root)).toEqual(['a']);
      expect(fs.existsSync(lock)).toBe(false);
    }));
});
