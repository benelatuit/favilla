import assert from 'node:assert/strict';
import { beforeEach, it, vi } from 'vitest';
import type { FollowChange, Message, SessionListItem, SessionView } from '../src/lib/types';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  api: mock.api,
  connectEvents: () => () => {},
}));
vi.mock('../src/lib/notify', () => ({ notifyAway: () => {} }));

let store: typeof import('../src/lib/store');
const views = new Map<string, SessionView>();

const msg = (id: string, role: Message['role'] = 'assistant'): Message => ({ id, role, parts: [{ type: 'text', text: id }], time: 1 }) as Message;

function view(id: string, following?: SessionView['following']): SessionView {
  return {
    meta: { id, cwd: '/project', title: id, updated: 123, model: 'm1' },
    messages: [msg(`${id}-1`, 'user')], status: 'idle', activeStart: 0, turns: [], model: { id: 'm1' },
    pending: { permissions: [], questions: [], plans: [] },
    live: null,
    ...(following ? { following } : {}),
  } as unknown as SessionView;
}

function change(id: string, added: Message[], holder: number | null, reset = false): FollowChange {
  return { meta: { ...views.get(id)!.meta, title: 'Now titled', updated: 456 }, added, reset, activeStart: 0, todos: [], usage: undefined, following: { holder } } as unknown as FollowChange;
}

const calls = () => mock.api.mock.calls.map(([p, init]) => `${init?.method ?? 'GET'} ${p}`);

beforeEach(async () => {
  vi.resetModules();
  views.clear();
  views.set('held', view('held', { holder: 4242 }));
  views.set('own', view('own'));
  const rows: SessionListItem[] = [...views.values()].map((v) => ({ ...v.meta, live: null }) as SessionListItem);
  mock.api.mockReset().mockImplementation(async (path: string) => {
    if (path === '/info') return { cwd: '/project', config: {} };
    if (path.startsWith('/sessions?')) return rows;
    return views.get(path.split('/').at(-1)!) ?? [];
  });
  store = await import('../src/lib/store');
  await store.actions.boot();
  await store.actions.open('held');
  mock.api.mockClear();
});

it('adds what the other process saved, once, and keeps the sidebar row with it', () => {
  store.applyFollow('held', change('held', [msg('held-1', 'user'), msg('held-2')], 4242));
  store.applyFollow('held', change('held', [msg('held-2')], 4242));
  const s = store.getState();
  assert.deepEqual(s.session?.messages.map((m) => m.id), ['held-1', 'held-2']);
  assert.equal(s.session?.meta.title, 'Now titled');
  const row = s.sessions.find((r) => r.id === 'held')!;
  assert.equal(row.live, 'running');
  assert.equal(row.title, 'Now titled');
  assert.deepEqual(calls(), []);
});

it('does not open the session here when the other process lets go', () => {
  store.applyFollow('held', change('held', [], null));
  const s = store.getState();
  assert.deepEqual(s.session?.following, { holder: null });
  assert.equal(s.sessions.find((r) => r.id === 'held')!.live, null);
  assert.deepEqual(calls(), []);
});

it('loads the view again when the file started over, and leaves a session it does not follow alone', async () => {
  store.applyFollow('held', change('held', [], 4242, true));
  assert.deepEqual(calls(), ['GET /sessions/held']);

  await store.actions.open('own');
  const before = store.getState().session;
  store.applyFollow('own', change('own', [msg('own-2')], 4242));
  assert.strictEqual(store.getState().session, before);
});
