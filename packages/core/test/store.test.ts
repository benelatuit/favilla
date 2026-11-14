import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { unseal } from '../src/store/seal';
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
