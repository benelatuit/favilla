import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, vi } from 'vitest';
import { ApiError, type ConnectionState, type ServerEvent } from '../src/lib/api';
import type { SessionListItem, SessionView, ToolResultPart } from '../src/lib/types';
import { withAttached } from '../src/lib/paste';

const mock = vi.hoisted(() => ({
  event: (_: ServerEvent) => {},
  connection: (_: ConnectionState, _resumed?: boolean) => {},
  replay: (_: ServerEvent[]) => {},
  api: vi.fn(),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  api: mock.api,
  connectEvents: (event: typeof mock.event, connection: typeof mock.connection, window: { replay: typeof mock.replay }) => {
    mock.event = event;
    mock.connection = connection;
    mock.replay = window.replay;
    return () => {};
  },
}));
vi.mock('../src/lib/notify', () => ({ notifyAway: () => {} }));

let store: typeof import('../src/lib/store');
let rows: SessionListItem[];
const views = new Map<string, SessionView>();
const deferred = <T>() => Promise.withResolvers<T>();

function view(id: string, status: SessionView['status'] = 'idle'): SessionView {
  return {
    meta: { id, cwd: '/project', title: id, updated: 123, model: 'm1' },
    messages: [], status, activeStart: 0, turns: [], model: { id: 'm1' },
    pending: { permissions: [], questions: [], plans: [] },
    live: { draft: null, turnStarted: status === 'idle' ? null : 456, running: [], children: [], background: [] },
  } as unknown as SessionView;
}

function replacement() {
  mock.event({ type: 'session.replaced', sessionId: 'a', replacement: views.get('b')!.meta } as ServerEvent);
}

const row = (id: string, live: string | null = null): SessionListItem => ({ ...views.get(id)!.meta, live });
const ids = () => store.getState().sessions.map((r) => r.id);

function pendingRoute<T>(route: string) {
  const response = deferred<T>();
  const fallback = mock.api.getMockImplementation()!;
  mock.api.mockImplementation((path, init) => path === route ? response.promise : fallback(path, init));
  return response;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  views.clear();
  for (const id of ['a', 'b', 'c', 'd']) views.set(id, view(id));
  rows = [row('d'), row('a'), row('c')];
  mock.api.mockReset().mockImplementation(async (path: string) => {
    if (path === '/info') return { cwd: '/project', config: {} };
    if (path.startsWith('/sessions?')) return rows;
    return views.get(path.split('/').at(-1)!) ?? [];
  });
  store = await import('../src/lib/store');
  await store.actions.boot();
  await store.actions.open('a');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const attachment = { mediaType: 'image/png', data: 'aW1hZ2U=', name: 'test.png' };

it('moves an open window to the replacement in place and keeps the composer mounted with its input', async () => {
  // The composer owns the local input. A non-null session keeps it mounted while the new view is pending.
  const returned = { items: [{ text: 'A draft in the composer', images: [attachment] }], at: 1 };
  store.setState({ returned });
  const fresh = pendingRoute<SessionView>('/sessions/b');
  replacement();

  assert.equal(store.getState().activeId, 'b');
  assert.ok(store.getState().session);
  assert.deepEqual(ids(), ['d', 'b', 'c']);
  assert.strictEqual(store.getState().returned, returned);

  fresh.resolve(views.get('b')!);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(store.getState().session?.meta.id, 'b');
  assert.strictEqual(store.getState().returned, returned);
  assert.deepEqual(ids(), ['d', 'b', 'c']);
});

it('returns a refused send and its attachments to the composer after a missed replacement event', async () => {
  const b = views.get('b')!;
  const unread = { text: 'Also unread.', images: [] };
  views.set('b', { ...b, meta: { ...b.meta, replaces: ['a'] }, returned: [unread] });
  rows = [row('b'), row('d'), row('c')];
  mock.connection('open');
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(store.getState().activeId, 'a');
  assert.deepEqual(ids(), ['d', 'b', 'c']);

  const refused = pendingRoute<never>('/sessions/a/send');
  const text = withAttached('Keep these words.', [], ['Pasted text.']);
  const sent = store.actions.send(text, [attachment]);
  refused.reject(new ApiError(410, 'This session was replaced.', 'b'));
  await sent;

  assert.equal(store.getState().activeId, 'b');
  assert.equal(store.getState().session?.meta.id, 'b');
  assert.deepEqual(ids(), ['d', 'b', 'c']);
  assert.deepEqual(store.getState().returned?.items, [{ text, images: [attachment] }, unread]);
  assert.equal(mock.api.mock.calls.some(([path]) => path === '/sessions/b/send'), false);
});

it('clears missed tool and turn completions from the open view and the session list on reconnect', async () => {
  mock.connection('open');
  await vi.advanceTimersByTimeAsync(0);
  mock.event({ type: 'turn.start', sessionId: 'a', turn: 'ta' });
  mock.event({ type: 'tool.start', sessionId: 'a', callId: 'read', name: 'read', title: 'Read', input: {} });
  mock.event({ type: 'status', sessionId: 'a', status: 'running' });
  mock.event({ type: 'turn.start', sessionId: 'c', turn: 'tc' });
  assert.ok(store.getState().running.has('read'));
  assert.ok(store.getState().turnStarted !== null);
  assert.equal(store.getState().session?.status, 'running');
  assert.deepEqual(store.getState().sessions.map((r) => r.live), [null, 'running', 'running']);

  mock.connection('closed');
  // While disconnected the tool and both turns end. The server's view and list reflect that.
  views.set('a', view('a'));
  rows = [row('d'), row('a'), row('c')];
  mock.connection('open');
  await vi.advanceTimersByTimeAsync(0);

  assert.equal(store.getState().session?.status, 'idle');
  assert.deepEqual({
    running: [...store.getState().running.keys()],
    turnStarted: store.getState().turnStarted,
    list: store.getState().sessions.map((r) => r.live),
  }, { running: [], turnStarted: null, list: [null, null, null] });
});

it('applies a missed draft tail in order without fetching the session again on replay', async () => {
  mock.event({ type: 'turn.start', sessionId: 'a', turn: 'ta' });
  mock.event({ type: 'stream.start', sessionId: 'a', messageId: 'reply', model: 'm1' });
  mock.event({ type: 'stream.text', sessionId: 'a', messageId: 'reply', index: 0, at: 0, delta: 'Before' });
  await vi.advanceTimersByTimeAsync(50);
  assert.equal(shown(), 'Before');
  mock.connection('closed');
  mock.api.mockClear();

  mock.replay([
    { type: 'stream.text', sessionId: 'a', messageId: 'reply', index: 0, at: 6, delta: ', missed' },
    { type: 'stream.text', sessionId: 'a', messageId: 'reply', index: 0, at: 14, delta: ', after.' },
  ]);
  mock.connection('open', true);
  await vi.advanceTimersByTimeAsync(0);

  assert.equal(shown(), 'Before, missed, after.');
  assert.equal(mock.api.mock.calls.some(([path]) => path === '/sessions/a'), false);
  assert.equal(mock.api.mock.calls.some(([path]) => path.startsWith('/sessions?')), true);
});

it.each(['live', 'replayed'])('does not add a %s message again when an HTTP view already included it', async (delivery) => {
  const message = { id: 'done', role: 'assistant', time: 1, parts: [{ type: 'text', text: 'Done.' }] } as const;
  views.set('a', { ...view('a'), messages: [message] } as SessionView);
  await store.actions.refreshSession();
  const event = { type: 'message.added', sessionId: 'a', message } as ServerEvent;
  if (delivery === 'replayed') mock.replay([event]);
  else mock.event(event);
  assert.deepEqual(store.getState().session?.messages.map((m) => m.id), ['done']);
});

it('keeps a user message that arrived while the reconnect view was in flight', async () => {
  mock.connection('closed');
  const fresh = pendingRoute<SessionView>('/sessions/a');
  mock.connection('open', false);
  const message = { id: 'sent', role: 'user', time: 1, parts: [{ type: 'text', text: 'Sent.' }] } as const;
  mock.event({ type: 'message.added', sessionId: 'a', message } as ServerEvent);
  assert.deepEqual(store.getState().session?.messages.map((m) => m.id), ['sent']);
  mock.api.mockResolvedValueOnce({ ...view('a'), messages: [message] });
  fresh.resolve(view('a'));
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(store.getState().session?.messages.map((m) => m.id), ['sent']);
});

it('refreshes after replaying a history change whose event has no rewritten parts', async () => {
  mock.connection('closed');
  views.set('a', { ...view('a'), activeStart: 2 });
  mock.api.mockClear();

  mock.replay([{ type: 'compaction', sessionId: 'a', phase: 'end', before: 400, after: 100 }]);
  mock.connection('open', true);
  await vi.advanceTimersByTimeAsync(0);

  assert.equal(store.getState().session?.activeStart, 2);
  assert.equal(mock.api.mock.calls.filter(([path]) => path === '/sessions/a').length, 1);
});

it('keeps tool results and turn completions received while reconnect snapshots are in flight', async () => {
  mock.event({ type: 'turn.start', sessionId: 'a', turn: 'ta' });
  mock.event({ type: 'tool.start', sessionId: 'a', callId: 'read', name: 'read', title: 'Read', input: {} });
  const previous = { ...view('a', 'running') };
  previous.live!.running = [{ callId: 'read', name: 'read', title: 'Read', input: {}, started: 1 }];
  const oldRows = [row('d'), row('a', 'running'), row('c')];
  const fresh = pendingRoute<SessionView>('/sessions/a');
  const list = deferred<SessionListItem[]>();
  const fallback = mock.api.getMockImplementation()!;
  mock.api.mockImplementationOnce((path, init) => path.startsWith('/sessions?') ? list.promise : fallback(path, init));

  mock.connection('closed');
  mock.connection('open');
  const result: ToolResultPart = { type: 'tool_result', callId: 'read', name: 'read', content: 'Done.' };
  mock.event({ type: 'tool.end', sessionId: 'a', callId: 'read', result });
  mock.event({ type: 'status', sessionId: 'a', status: 'idle' });
  mock.event({ type: 'turn.end', sessionId: 'a', turn: 'ta', reason: 'done' });
  fresh.resolve(previous);
  list.resolve(oldRows);
  await vi.advanceTimersByTimeAsync(0);

  assert.equal(store.getState().session?.status, 'idle');
  assert.equal(store.getState().running.size, 0);
  assert.strictEqual(store.getState().results.get('read'), result);
  assert.equal(store.getState().turnStarted, null);
  assert.equal(store.getState().sessions.find((r) => r.id === 'a')?.live, null);
});

function piece(at: number, delta: string) {
  mock.event({ type: 'stream.text', sessionId: 'b', messageId: 'reply', index: 0, delta, at });
  vi.advanceTimersByTime(50);
}

const shown = () => store.getState().drafts.get('reply')?.parts.get(0)?.text;

it('keeps the fork draft received before the HTTP answer and extends it with later pieces', async () => {
  const response = pendingRoute<SessionView>('/sessions/a/fork');
  const fork = store.actions.fork('question', 'before', { text: 'Asked again.', replace: true });
  mock.event({ type: 'turn.start', sessionId: 'b', turn: 'tb' });
  mock.event({ type: 'stream.start', sessionId: 'b', messageId: 'reply', model: 'm1' });
  piece(0, 'First ');
  assert.equal(store.getState().lives.get('b')?.drafts.get('reply')?.parts.get(0)?.text, 'First ');

  rows = [row('b', 'running'), row('d'), row('c')];
  response.resolve(view('b', 'running'));
  await fork;
  assert.equal(store.getState().activeId, 'b');
  assert.equal(shown(), 'First ');
  piece(6, 'words.');
  assert.equal(shown(), 'First words.');
});

it('updates the list without pulling the user back after they leave during a fork', async () => {
  const response = pendingRoute<SessionView>('/sessions/a/fork');
  const fork = store.actions.fork('question', 'before', { text: 'Asked again.' });
  await store.actions.open('c');
  rows = [row('b'), ...rows];
  response.resolve(views.get('b')!);
  await fork;

  assert.equal(store.getState().activeId, 'c');
  assert.equal(store.getState().session?.meta.id, 'c');
  assert.deepEqual(ids(), ['b', 'd', 'a', 'c']);
});


it('returns input once when both a replay and the session view carry it', async () => {
  const returned = [{ id: 'input-one', text: 'Keep this.', images: [] }];
  mock.replay([{ type: 'queue', sessionId: 'a', items: [], returned } as ServerEvent]);
  views.set('a', { ...view('a'), returned });
  await store.actions.refreshSession();
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(store.getState().returned?.items, [{ text: 'Keep this.', images: [] }]);
  assert.ok(mock.api.mock.calls.some(([route, init]) => route === '/sessions/a/returned' && init?.body.ids.includes('input-one')));
});
