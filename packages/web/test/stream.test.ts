import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../src/lib/api';
import type { SessionView } from '../src/lib/types';

const mock = vi.hoisted(() => ({
  event: (_: ServerEvent) => {},
  subscribe: (_: () => void): (() => void) => () => {},
  views: new Map<string, SessionView>(),
  api: vi.fn(),
}));
vi.mock('react', () => ({
  useSyncExternalStore: (subscribe: typeof mock.subscribe, snapshot: () => unknown) => {
    mock.subscribe = subscribe;
    return snapshot();
  },
}));
vi.mock('../src/lib/api', () => ({
  connectEvents: (event: typeof mock.event) => { mock.event = event; return () => {}; },
  api: mock.api,
}));
vi.mock('../src/lib/notify', () => ({ notifyAway: () => {} }));

let store: typeof import('../src/lib/store');
let observed: ReturnType<typeof store.getState>[];
let unsubscribe: () => void;
const e = (body: { type: ServerEvent['type'] } & Record<string, unknown>, sessionId = 's1') => mock.event({ sessionId, time: 0, ...body } as ServerEvent);
const view = (id: string) => ({
  meta: { id, model: 'm1' }, messages: [], status: 'running', activeStart: 0, turns: [],
  pending: { permissions: [], questions: [], plans: [] }, model: { id: 'm1' },
} as unknown as SessionView);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  mock.views = new Map(['s1', 's2'].map((id) => [id, view(id)]));
  mock.api.mockReset().mockImplementation(async (path: string) => {
    if (path === '/info') return { cwd: '/project', config: {} };
    if (path === '/providers' || path.startsWith('/sessions?')) return [];
    return mock.views.get(path.split('/').at(-1)!) ?? {};
  });
  store = await import('../src/lib/store');
  await store.actions.boot();
  store.setState({ activeId: 's1', session: view('s1') });
  store.useStore((s) => s);
  observed = [];
  unsubscribe = mock.subscribe(() => observed.push(store.getState()));
});
afterEach(() => {
  unsubscribe();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('stream batches', () => {
  it('publishes one complete snapshot for interleaved text, reasoning, arguments and tool output', () => {
    e({ type: 'stream.start', messageId: 'm1', model: 'm1' });
    e({ type: 'tool.start', callId: 'c1', name: 'shell', title: 'Tests', input: {} });
    observed.length = 0;
    for (let i = 0; i < 100; i++) {
      e({ type: 'stream.text', messageId: 'm1', index: 0, delta: '文' });
      e({ type: 'stream.reasoning', messageId: 'm1', index: 1, delta: '想' });
      e({ type: 'stream.tool', messageId: 'm1', index: 2, name: 'shell', delta: 'x' });
      e({ type: 'tool.progress', callId: 'c1', chunk: `${i}\n` });
    }
    expect(observed).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(observed).toHaveLength(1);
    const state = store.getState();
    expect(state.drafts.get('m1')?.parts.get(0)?.text).toBe('文'.repeat(100));
    expect(state.drafts.get('m1')?.parts.get(1)?.text).toBe('想'.repeat(100));
    expect(state.drafts.get('m1')?.parts.get(2)).toMatchObject({ name: 'shell', text: 'x'.repeat(100) });
    expect(state.running.get('c1')?.output).toBe(Array.from({ length: 100 }, (_, i) => `${i}\n`).join(''));
  });

  it('keeps text boundaries and the latest tool name when argument fragments omit it', () => {
    e({ type: 'stream.start', messageId: 'm1', model: 'm1' });
    e({ type: 'stream.tool', messageId: 'm1', index: 0, name: 'shell', delta: '{"command":' });
    vi.advanceTimersByTime(50);
    e({ type: 'stream.tool', messageId: 'm1', index: 0, delta: '"echo ok"}' });
    e({ type: 'stream.text', messageId: 'm1', index: 1, delta: 'ready' });
    vi.advanceTimersByTime(50);
    expect(store.getState().drafts.get('m1')?.parts.get(0)).toMatchObject({ name: 'shell', text: '{"command":"echo ok"}' });
    expect(store.getState().drafts.get('m1')?.parts.get(1)?.text).toBe('ready');
  });

  it('flushes before a committed message or discard and never resurrects a finished draft', () => {
    e({ type: 'stream.start', messageId: 'm1', model: 'm1' });
    observed.length = 0;
    e({ type: 'stream.text', messageId: 'm1', index: 0, delta: 'finished' });
    e({ type: 'message.added', message: { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'finished' }], time: 0 } });
    expect(observed).toHaveLength(1);
    expect(observed[0].drafts.size).toBe(0);
    expect(observed[0].session?.messages).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(store.getState().drafts.size).toBe(0);
    expect(store.getState().session?.messages).toHaveLength(1);
    e({ type: 'stream.start', messageId: 'm2', model: 'm1' });
    observed.length = 0;
    e({ type: 'stream.text', messageId: 'm2', index: 0, delta: 'discarded' });
    e({ type: 'stream.discard', messageId: 'm2' });
    vi.advanceTimersByTime(100);
    expect(store.getState().drafts.size).toBe(0);
    expect(observed).toHaveLength(1);
  });

  it('keeps queued pieces in their session when the user switches tabs or starts a new session', async () => {
    e({ type: 'stream.start', messageId: 'm1', model: 'm1' });
    e({ type: 'stream.text', messageId: 'm1', index: 0, delta: 'first' });
    await store.actions.open('s2');
    e({ type: 'stream.start', messageId: 'm2', model: 'm1' }, 's2');
    e({ type: 'stream.text', messageId: 'm2', index: 0, delta: 'second' }, 's2');
    store.actions.newSession();
    vi.advanceTimersByTime(50);
    expect(store.getState().drafts.size).toBe(0);
    await store.actions.open('s1');
    expect(store.getState().drafts.get('m1')?.parts.get(0)?.text).toBe('first');
    await store.actions.open('s2');
    expect(store.getState().drafts.get('m2')?.parts.get(0)?.text).toBe('second');
  });

  it('batches child activity, preserves its ordering and bounds tool output', () => {
    const child = (event: Record<string, unknown>) => e({ type: 'subagent', callId: 'agent1', event: { sessionId: 'child1', time: 0, ...event } });
    child({ type: 'stream.start', messageId: 'm1', model: 'm1' });
    observed.length = 0;
    for (let i = 0; i < 100; i++) child({ type: 'stream.reasoning', messageId: 'm1', index: 0, delta: 'thinking ' });
    vi.advanceTimersByTime(50);
    expect(observed).toHaveLength(1);
    expect(store.getState().children.get('agent1')?.[0]).toMatchObject({ activity: 'thinking', thought: 'thinking '.repeat(100).slice(-600) });
    child({ type: 'stream.text', messageId: 'm1', index: 1, delta: 'answer' });
    child({ type: 'tool.start', callId: 'child-tool', name: 'read', title: 'Read', input: {} });
    expect(store.getState().children.get('agent1')?.[0].activity).toBe('tool');
    e({ type: 'tool.start', callId: 'c1', name: 'shell', title: 'Tests', input: {} });
    for (let i = 0; i < 100; i++) e({ type: 'tool.progress', callId: 'c1', chunk: `${i}:` + 'x'.repeat(1000) });
    vi.advanceTimersByTime(50);
    expect(store.getState().running.get('c1')?.output).toHaveLength(60_000);
    expect(store.getState().running.get('c1')?.output).toMatch(/99:x+$/);
    e({ type: 'turn.end', reason: 'done' });
    vi.advanceTimersByTime(100);
    expect(store.getState().running.size).toBe(0);
    expect(store.getState().drafts.size).toBe(0);
  });

  it('keeps the latest child activity when text and reasoning alternate within a frame', () => {
    const child = (type: 'stream.text' | 'stream.reasoning', delta: string) => e({
      type: 'subagent', callId: 'agent1', event: { type, sessionId: 'child1', messageId: 'm1', index: type === 'stream.text' ? 0 : 1, delta, time: 0 },
    });
    child('stream.text', 'a');
    child('stream.reasoning', 'b');
    child('stream.text', 'c');
    vi.advanceTimersByTime(50);
    expect(store.getState().children.get('agent1')?.[0]).toMatchObject({ activity: 'writing', thought: 'b' });
  });

  it('ignores a refresh response for a session the user has already left', async () => {
    let resolve!: (view: SessionView) => void;
    mock.api.mockImplementationOnce(() => new Promise<SessionView>((r) => { resolve = r; }));
    const refreshing = store.actions.refreshSession();
    await store.actions.open('s2');
    resolve(view('s1'));
    await refreshing;
    expect(store.getState().activeId).toBe('s2');
    expect(store.getState().session?.meta.id).toBe('s2');
  });
});
