import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Deferred } from '../src/util/async';
import { fullContent } from '../src/store/pack';
import { SessionStore } from '../src/store/sessions';
import type { SessionMeta } from '../src/types';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-background-pack-'));
  const store = new SessionStore(root);
  const meta: SessionMeta = { id: 'fixture', title: 'Fixture', cwd: root, created: 1, updated: 1, provider: 'fixture', model: 'm', effort: 'off', mode: 'build', profile: 'favilla' };
  const output = 'Invented tool output.\n'.repeat(14000);
  store.create(meta, 'Fixture system.');
  store.saveMessage(meta, {
    id: 'tool', role: 'user', origin: 'tool', time: 1, parts: [{ type: 'tool_result', callId: 'read', name: 'read', content: output }],
  });
  store.saveCompaction(meta, 1);
  store.flushIndex();
  const hot = store.dataDir(meta) + '.jsonl';
  const clean = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  return { root, store, meta, hot, output, clean };
}

it('keeps a session hot and append-only if another message lands during background blob compression', async () => {
  const { store, meta, hot, clean } = fixture();
  let entered!: () => void;
  const compressing = new Promise<void>((resolve) => { entered = resolve; });
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => { resume = resolve; });
  const put = store.blobs.putLargeText.bind(store.blobs);
  const spy = vi.spyOn(store.blobs, 'putLargeText').mockImplementation(async (text) => {
    entered();
    await pause;
    return put(text);
  });
  const freezing = store.freeze(meta.id);
  try {
    await Promise.race([compressing, freezing.then(() => { throw new Error('Packing finished before compressing the large output'); })]);
    const prior = fs.readFileSync(hot);
    store.saveMessage(meta, { id: 'next', role: 'user', time: 2, parts: [{ type: 'text', text: 'Keep this append.' }] });
    resume();
    expect(await freezing).toBe(false);
    expect(fs.readFileSync(hot).subarray(0, prior.length)).toEqual(prior);
    expect(fs.existsSync(hot + '.br')).toBe(false);
    expect(fs.readdirSync(path.dirname(hot)).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(store.load(meta.id)?.messages.map((m) => m.id)).toEqual(['tool', 'next']);
  } finally {
    resume();
    await freezing.catch(() => {});
    spy.mockRestore();
    clean();
  }
});

it('does not publish a stale pack over the pack of an appended session', async () => {
  const { root, store, meta, hot, clean } = fixture();
  const other = new SessionStore(root);
  const olderStaging = new Deferred<void>();
  const newerStaged = new Deferred<void>();
  const olderStaged = new Deferred<void>();
  const finishOlder = new Deferred<void>();
  const write = fs.promises.writeFile.bind(fs.promises);
  let calls = 0;
  const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
    if (typeof file !== 'string' || !file.startsWith(hot + '.br')) return write(file, data, options);
    if (++calls === 1) {
      olderStaging.resolve();
      await newerStaged.promise;
      await write(file, data, options);
      olderStaged.resolve();
      await finishOlder.promise;
    } else {
      await write(file, data, options);
      newerStaged.resolve();
      await olderStaged.promise;
    }
  });
  const older = store.freeze(meta.id);
  let newer: Promise<boolean> | undefined;
  try {
    await Promise.race([olderStaging.promise, older.then(() => { throw new Error('The older pack did not reach its write'); })]);
    other.saveMessage(meta, { id: 'next', role: 'user', time: 2, parts: [{ type: 'text', text: 'Keep this append.' }] });
    newer = other.freeze(meta.id);
    // The newer pack publishes after the older one wrote its bytes, before that older pack tries to publish.
    expect(await Promise.race([newer, older])).toBe(true);
    finishOlder.resolve();
    expect(await older).toBe(false);
    expect(new SessionStore(root).load(meta.id)?.messages.map((m) => m.id)).toEqual(['tool', 'next']);
  } finally {
    newerStaged.resolve();
    olderStaged.resolve();
    finishOlder.resolve();
    await Promise.allSettled([older, newer]);
    spy.mockRestore();
    clean();
  }
});

it('opens a session even when another engine thaws it during the asynchronous read', async () => {
  const { root, store, meta, hot, clean } = fixture();
  const other = new SessionStore(root);
  const read = fs.promises.readFile.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'readFile');
  try {
    expect(await store.freeze(meta.id)).toBe(true);
    spy.mockImplementationOnce(async (file, options) => {
      try {
        return await read(file, options);
      } catch (error) {
        expect(file).toBe(hot);
        other.saveMessage(meta, { id: 'thawed', role: 'user', time: 2, parts: [{ type: 'text', text: 'Saved after thawing.' }] });
        throw error;
      }
    });
    expect((await store.loadAsync(meta.id))?.messages.map((m) => m.id)).toEqual(['tool', 'thawed']);
  } finally {
    spy.mockRestore();
    clean();
  }
});

it('keeps the hot result when a full disk prevents the blob from being installed', async () => {
  const { root, store, meta, hot, output, clean } = fixture();
  const before = fs.readFileSync(hot);
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).startsWith(store.blobs.root)) throw Object.assign(new Error('The disk is full'), { code: 'ENOSPC' });
    rename(from, to);
  });
  try {
    await expect(store.freeze(meta.id)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fs.readFileSync(hot)).toEqual(before);
    spy.mockRestore();
    const restarted = new SessionStore(root);
    const result = restarted.load(meta.id)?.messages[0]?.parts[0];
    expect(result?.type === 'tool_result' && fullContent(result, restarted.blobs)).toBe(output);
  } finally {
    spy.mockRestore();
    clean();
  }
});



it('checks the tail again before appending after a partial write to a full disk', () => {
  const { root, store, meta, hot, clean } = fixture();
  const append = fs.appendFileSync;
  const failed = { id: 'partial', role: 'user' as const, time: 2, parts: [{ type: 'text' as const, text: 'Cut while saving.' }] };
  const spy = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce((file, data, opts) => {
    expect(file).toBe(hot);
    append(file, data.slice(0, Math.floor(data.length / 2)), opts);
    throw Object.assign(new Error('The disk is full'), { code: 'ENOSPC' });
  });
  try {
    expect(() => store.saveMessage(meta, failed)).toThrow('The disk is full');
    spy.mockRestore();
    store.saveMessage(meta, { ...failed, id: 'kept' });
    expect(new SessionStore(root).load(meta.id)?.messages.map((m) => m.id)).toEqual(['tool', 'kept']);
  } finally {
    spy.mockRestore();
    clean();
  }
});
