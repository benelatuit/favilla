import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { SessionStore } from '../src/store/sessions';
import type { SessionMeta } from '../src/types';

it('leaves the thread free while a writer holds the index lock and then merges both histories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-index-wait-'));
  const meta = (id: string): SessionMeta => ({ id, title: id, cwd: root, created: 1, updated: 1, provider: 'fixture', model: 'm', effort: 'off', mode: 'build', profile: 'favilla' });
  const reader = new SessionStore(root);
  const writer = new SessionStore(root);
  const lock = path.join(root, 'index.json.lock');
  reader.create(meta('first'), 'First session.');
  writer.create(meta('second'), 'Second session.');
  const file = reader.dataDir(meta('first')) + '.jsonl';
  const history = fs.readFileSync(file);
  fs.mkdirSync(lock);
  const finished: string[] = [];
  const writing = reader.flushIndexAsync().then(() => finished.push('waiting writer'));
  try {
    await delay(25);
    expect(finished).toEqual([]);
    expect(fs.existsSync(path.join(root, 'index.json'))).toBe(false);
    fs.rmdirSync(lock);
    writer.flushIndex();
    finished.push('lock holder');
    await writing;
    expect(finished).toEqual(['lock holder', 'waiting writer']);
    expect(new SessionStore(root).list().map((row) => row.id).sort()).toEqual(['first', 'second']);
    expect(fs.readFileSync(file)).toEqual(history);
  } finally {
    fs.rmSync(lock, { force: true, recursive: true });
    await writing;
    writer.flushIndex();
    fs.rmSync(root, { force: true, recursive: true, maxRetries: 8, retryDelay: 100 });
  }
});



it('sees another engine replace the index even if its timestamp is unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-index-clock-'));
  const index = path.join(root, 'index.json');
  const meta: SessionMeta = { id: 'first', title: 'Fixture', cwd: root, created: 1, updated: 1, provider: 'fixture', model: 'm', effort: 'off', mode: 'build', profile: 'favilla' };
  const first = new SessionStore(root), second = new SessionStore(root);
  const time = new Date(1_600_000_000_000);
  try {
    first.create(meta, 'Fixture.');
    first.flushIndex();
    fs.utimesSync(index, time, time);
    expect(second.list().map((row) => row.id)).toEqual(['first']);
    first.create({ ...meta, id: 'second' }, 'Second session.');
    first.flushIndex();
    fs.utimesSync(index, time, time);
    expect(second.list().map((row) => row.id).sort()).toEqual(['first', 'second']);
  } finally {
    fs.rmSync(root, { force: true, recursive: true, maxRetries: 8, retryDelay: 100 });
  }
});
