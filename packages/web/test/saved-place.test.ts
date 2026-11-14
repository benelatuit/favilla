import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Info } from '../src/lib/types';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: mock.api, connectEvents: () => () => {} }));
vi.mock('../src/lib/notify', () => ({ notifyAway: () => {} }));

const server: NonNullable<Info['ui']> = {
  folder: '/phone', session: 'phone', recent: ['/phone', '/shared'],
  layout: { sidebar: true, panel: false }, last: { model: 'p/phone', effort: 'high' },
};
let local: Map<string, string>;

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
    if (route === '/info') return { cwd: '/project', config: {}, ui: server };
    if (route === '/providers') return [{ configured: true, models: [{ ref: 'p/phone' }, { ref: 'p/desk' }] }];
    // Every folder's sessions, as the sidebar asks for them.
    if (route.startsWith('/sessions?')) return [{ id: 'desk', cwd: '/desk' }, { id: 'phone', cwd: '/phone' }];
    if (route.startsWith('/sessions/')) {
      const id = route.split('/').at(-1);
      return { meta: { id }, messages: [], status: 'idle' };
    }
    return {};
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const remember = (key: string, value: unknown) => local.set('favilla.' + key, JSON.stringify(value));

it('uses this window’s own folder, session, recent folders, layout, and last model before the shared copy', async () => {
  remember('folder', '/desk');
  remember('session', 'desk');
  remember('recent', ['/older']);
  remember('layout', { sidebar: false, panel: true });
  remember('last', { model: 'p/desk', effort: 'low' });
  const { actions, getState } = await import('../src/lib/store');
  await actions.boot();
  const s = getState();
  expect([s.folder, s.activeId]).toEqual(['/desk', 'desk']);
  expect(s.recent).toEqual(['/desk', '/older']);
  expect([s.ui.sidebar, s.ui.panel]).toEqual([false, true]);
  expect(s.draft).toEqual({ model: 'p/desk', effort: 'low' });
});

it('uses the shared copy on a fresh window and remembers an explicitly cleared session', async () => {
  const { actions, getState } = await import('../src/lib/store');
  await actions.boot();
  expect([getState().folder, getState().activeId]).toEqual(['/phone', 'phone']);
  expect(getState().recent).toEqual(server.recent);
  expect(getState().draft).toEqual(server.last);

  await actions.setFolder('/desk');
  expect(local.get('favilla.session')).toBe(JSON.stringify(''));
  remember('folder', '/phone'); // The shared session would be valid in this folder.
  await actions.boot();
  expect(getState().activeId).toBeNull();
});
