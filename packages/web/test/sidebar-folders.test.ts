import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: mock.api, connectEvents: () => () => {} }));
vi.mock('../src/lib/notify', () => ({ notifyAway: () => {} }));

let local: Map<string, string>;
const rows = [
  { id: 'a1', cwd: 'C:\\work\\alpha', title: 'One' },
  { id: 'b1', cwd: 'C:/work/beta/', title: 'Two' },
];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  local = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
  });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
  mock.api.mockReset().mockImplementation(async (route: string) => {
    if (route === '/info') return { cwd: 'C:\\work\\alpha', config: {}, ui: {} };
    if (route === '/providers') return [];
    if (route.startsWith('/sessions?')) return rows;
    if (route.startsWith('/sessions/')) return { meta: { id: route.split('/').at(-1) }, messages: [], status: 'idle' };
    return {};
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('lists every folder’s sessions and compares folders whatever their separators and case', async () => {
  const { actions, folderKey, getState } = await import('../src/lib/store');
  await actions.boot();
  expect(mock.api.mock.calls.some(([route]) => /^\/sessions\?limit=\d+$/.test(route))).toBe(true);
  expect(getState().sessions.map((s) => s.id)).toEqual(['a1', 'b1']);
  expect(folderKey('C:\\Work\\Beta\\')).toBe(folderKey('c:/work/beta'));
});

it('makes a session’s folder the current one when it is opened, without moving the folders already listed', async () => {
  const { actions, getState } = await import('../src/lib/store');
  await actions.boot();
  await actions.open('b1');
  expect(getState().folder).toBe('C:/work/beta/');
  expect(getState().recent).toEqual(['C:/work/beta/', 'C:\\work\\alpha']);
  await actions.open('a1');
  // Alpha was already listed: it keeps its place under beta.
  expect(getState().folder).toBe('C:\\work\\alpha');
  expect(getState().recent).toEqual(['C:/work/beta/', 'C:\\work\\alpha']);
  expect(local.get('favilla.folder')).toBe(JSON.stringify('C:\\work\\alpha'));
});

it('keeps pins and folded folders, and drops the pin of a deleted session', async () => {
  const { actions, getState } = await import('../src/lib/store');
  await actions.boot();
  actions.pin('a1', true);
  actions.pin('b1', true);
  expect(getState().pinned).toEqual(['b1', 'a1']);
  actions.pin('b1', false);
  expect(getState().pinned).toEqual(['a1']);
  actions.fold('C:\\Work\\Beta\\', true);
  actions.fold('c:/work/beta', true);
  expect(getState().collapsed).toEqual(['c:/work/beta']);
  actions.fold('C:/work/beta', false);
  expect(getState().collapsed).toEqual([]);
  await actions.remove('a1');
  expect(getState().pinned).toEqual([]);
  expect(local.get('favilla.pinned')).toBe(JSON.stringify([]));
});
