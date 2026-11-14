import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Everything Favilla writes goes to a scratch home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-settings-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(path.join(project, '.git'), { recursive: true });

const { createRuntime } = await import('../src/runtime');
const { startServer } = await import('../src/server/server');

/** A model server that lists two models, the way OpenAI-compatible servers do. */
const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(req.url?.endsWith('/models') ? JSON.stringify({ data: [{ id: 'tiny-1' }, { id: 'tiny-2.5' }] }) : '{}');
});

let rt: ReturnType<typeof createRuntime>;
let server: Awaited<ReturnType<typeof startServer>>;
let base = '';
const call = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${server.url.replace(/\/$/, '')}/api${route}`, {
    method,
    headers: { Authorization: `Bearer t`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error);
  return data as T;
};

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  rt = createRuntime(project, { interactive: true });
  server = await startServer({ runtime: rt, token: 't' });
});

afterAll(async () => {
  await server.close();
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('custom providers', () => {
  it('are added from a name, a format and an address, find their models, and can be removed', async () => {
    const p = await call<{ id: string; configured: boolean; custom: boolean; models: { id: string }[] }>('POST', '/providers', { name: 'My Server', api: 'openai-chat', baseUrl: `${base}/` });
    expect(p.id).toBe('my-server');
    expect(p.custom).toBe(true);
    expect(p.configured).toBe(true);
    expect(p.models.map((m) => m.id).sort()).toEqual(['tiny-1', 'tiny-2.5']);
    // A second one with the same name gets its own id; a built-in one cannot be removed.
    expect((await call<{ id: string }>('POST', '/providers', { name: 'My Server', api: 'openai-chat', baseUrl: base, models: ['x-1'] })).id).toBe('my-server-2');
    await expect(call('DELETE', '/providers/openai')).rejects.toThrow(/turned off/);
    await call('DELETE', '/providers/my-server-2');
    const list = await call<{ id: string }[]>('GET', '/providers');
    expect(list.some((x) => x.id === 'my-server')).toBe(true);
    expect(list.some((x) => x.id === 'my-server-2')).toBe(false);
    await expect(call('POST', '/providers', { name: 'Bad', api: 'soap', baseUrl: base })).rejects.toThrow(/request format/);
  });

  it('take a context window per model, even when the model id has a dot', async () => {
    await call('PUT', '/config', { windows: [{ ref: 'my-server/tiny-2.5', contextWindow: 48000 }] });
    const info = await call<{ config: { windows: { ref: string; contextWindow: number }[] } }>('GET', '/info');
    expect(info.config.windows).toContainEqual({ ref: 'my-server/tiny-2.5', contextWindow: 48000 });
    expect(rt.catalog.resolve('my-server/tiny-2.5').contextWindow).toBe(48000);
    await call('PUT', '/config', { windows: [{ ref: 'my-server/tiny-2.5', contextWindow: null }] });
    expect(rt.catalog.resolve('my-server/tiny-2.5').contextWindow).not.toBe(48000);
  });

  it('take whether a model reads pictures, by hand, and back to what is known', async () => {
    expect(rt.catalog.resolve('my-server/tiny-2.5').vision).toBe(false);
    await call('PUT', '/config', { visions: [{ ref: 'my-server/tiny-2.5', vision: true }] });
    expect(rt.catalog.resolve('my-server/tiny-2.5').vision).toBe(true);
    const info = await call<{ config: { visions: { ref: string; vision: boolean }[] } }>('GET', '/info');
    expect(info.config.visions).toContainEqual({ ref: 'my-server/tiny-2.5', vision: true });
    await call('PUT', '/config', { visions: [{ ref: 'my-server/tiny-2.5', vision: null }] });
    expect(rt.catalog.resolve('my-server/tiny-2.5').vision).toBe(false);
  });

  it('take models the server does not list, added and removed by hand', async () => {
    type View = { id: string; models: { id: string }[]; added: { id: string; contextWindow: number }[] };
    let p = await call<View>('POST', '/providers/my-server/models', { id: 'org/big-3.1', contextWindow: 64000 });
    expect(p.models.map((m) => m.id)).toContain('org/big-3.1');
    // tiny-2.5 has an entry in the file from the window and pictures set above, but the server lists it: not one added by hand.
    expect(p.added).toEqual([{ id: 'org/big-3.1', contextWindow: 64000 }]);
    expect(rt.catalog.resolve('my-server/org/big-3.1').contextWindow).toBe(64000);
    await expect(call('POST', '/providers/my-server/models', { id: 'has space' })).rejects.toThrow(/without spaces/);
    await expect(call('POST', '/providers/nobody/models', { id: 'm' })).rejects.toThrow(/Unknown provider/);
    p = await call<View>('DELETE', '/providers/my-server/models', { id: 'org/big-3.1' });
    expect(p.added).toEqual([]);
    expect(p.models.map((m) => m.id).sort()).toEqual(['tiny-1', 'tiny-2.5']);
  });
});

describe('remote control', () => {
  it('takes a relay of your own, an https address without a path, and goes back to the default when emptied', async () => {
    type View = { enabled: boolean; relay: string; relaySet: string; relayDefault: string };
    await expect(call('POST', '/remote/enable', { relay: 'http://relay.example.com' })).rejects.toThrow(/https/);
    await expect(call('POST', '/remote/enable', { relay: 'https://relay.example.com/rooms' })).rejects.toThrow(/without a path/);
    let v = await call<View>('POST', '/remote/enable', { relay: 'https://relay.example.com/' });
    expect([v.relay, v.relaySet, v.enabled]).toEqual(['https://relay.example.com', 'https://relay.example.com', false]);
    v = await call<View>('POST', '/remote/enable', { relay: '' });
    expect(v.relaySet).toBe('');
    expect(v.relay).toBe(v.relayDefault);
  });
});

describe('rules', () => {
  it('reads and writes the global rules, the project file and the notes', async () => {
    const q = `?cwd=${encodeURIComponent(project)}`;
    let v = await call<{ global: { exists: boolean; path: string }; project: { path: string; exists: boolean }; memory: { exists: boolean } }>('GET', `/rules${q}`);
    expect(v.global.exists).toBe(false);
    expect(v.project.path.endsWith('/AGENTS.md')).toBe(true);
    v = await call('PUT', '/rules', { which: 'project', cwd: project, content: 'Run npm test before finishing.' });
    expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe('Run npm test before finishing.\n');
    await call('PUT', '/rules', { which: 'global', cwd: project, content: 'Answer in English.' });
    expect(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')).toBe('Answer in English.\n');
    // Emptying Favilla's own file removes it; the project's file is the user's and stays.
    await call('PUT', '/rules', { which: 'global', cwd: project, content: '' });
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false);
    await expect(call('PUT', '/rules', { which: 'secrets', cwd: project, content: 'x' })).rejects.toThrow(/Unknown rules/);
  });
});

describe('the window state', () => {
  it('comes back from ui-state.json, or from the folders of recent sessions when nothing was saved', async () => {
    fs.rmSync(path.join(home, 'ui-state.json'), { force: true });
    // A folder someone works in (outside the temp folder, where test and eval sessions are and are passed over).
    const work = fs.mkdtempSync(path.join(process.cwd(), '.ui-state-test-'));
    try {
      const s = await rt.start({ cwd: work });
      s.setTitle('kept');
      await rt.start({ cwd: project });
      rt.store.flushIndex();
      const first = await call<{ ui: { folder?: string; recent?: string[] } }>('GET', '/info');
      expect(first.ui.folder?.toLowerCase()).toBe(work.toLowerCase());
      expect(first.ui.recent?.map((r) => r.toLowerCase())).not.toContain(project.toLowerCase());
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    await call('PUT', '/ui-state', { folder: 'C:/elsewhere', recent: ['C:/elsewhere'], session: 's1', layout: { sidebar: false, panel: true }, other: 'dropped' });
    const saved = await call<{ ui: Record<string, unknown> }>('GET', '/info');
    expect(saved.ui).toEqual({ folder: 'C:/elsewhere', recent: ['C:/elsewhere'], session: 's1', layout: { sidebar: false, panel: true } });
    // The sidebar's pins and folded folders reach another window the same way; anything but strings is dropped.
    await call('PUT', '/ui-state', { pinned: ['s1', 7], collapsed: ['c:/elsewhere'] });
    const pins = await call<{ ui: Record<string, unknown> }>('GET', '/info');
    expect([pins.ui.pinned, pins.ui.collapsed, pins.ui.folder]).toEqual([['s1'], ['c:/elsewhere'], 'C:/elsewhere']);
  });
});

// A terminal that had the session open went on writing to it after the app deleted it, and left a file of the lines
// written since, with no start (2026-11-06).
describe('deleting a session', () => {
  it('is refused while another Favilla has it open, and done once it has let go', async () => {
    const meta = { id: 'sheld', title: 'held', cwd: project, created: 1, updated: 1, provider: 'p', model: 'm', effort: 'medium' as const, mode: 'build' as const, profile: 'favilla' as const };
    rt.store.create(meta, 'S');
    rt.store.flushIndex();
    const lock = path.join(home, 'sessions', 'sheld.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, beat: Date.now() }));
    await expect(call('DELETE', '/sessions/sheld')).rejects.toThrow(/open in another Favilla/);
    expect(rt.store.metaOf('sheld')).not.toBeNull();
    fs.rmSync(lock);
    await call('DELETE', '/sessions/sheld');
    expect(rt.store.metaOf('sheld')).toBeNull();
  });
});

describe('session mode settings', () => {
  it('refuses an unknown mode on creation and on update, and accepts an absent mode', async () => {
    const p = await call<{ id: string }>('POST', '/providers', { name: 'Mode Test', api: 'openai-chat', baseUrl: base, models: ['m1'] });
    const model = `${p.id}/m1`;
    const post = (route: string, body: unknown) => fetch(`${server.url.replace(/\/$/, '')}/api${route}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const count = rt.store.list().length;
    const refused = await post('/sessions', { model, mode: 'unknown' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'A mode is build or plan.' });
    expect(rt.store.list()).toHaveLength(count);

    type View = { meta: { id: string; title: string; mode: string } };
    const { meta } = await call<View>('POST', '/sessions', { model });
    expect(meta.mode).toBe('build');
    const route = `/sessions/${meta.id}/settings`;
    const invalid = await post(route, { mode: null, title: 'Do not apply' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'A mode is build or plan.' });
    expect(rt.live.get(meta.id)?.meta.title).toBe(meta.title);
    expect((await call<View>('POST', route, { mode: 'plan' })).meta.mode).toBe('plan');
    expect((await call<View>('POST', route, { title: 'Updated' })).meta).toMatchObject({ mode: 'plan', title: 'Updated' });
  });
});
