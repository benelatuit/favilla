import assert from 'node:assert/strict';
import { it, vi } from 'vitest';
import type { ServerEvent } from '../src/lib/api';
import { buildFullTimeline, buildTimeline, keysOf, type Item, type TimelineBuild } from '../src/lib/timeline';
import type { Message, SessionView, ToolResultPart } from '../src/lib/types';
import { drawn, TAIL, toShow } from '../src/lib/window';

const mock = vi.hoisted(() => ({
  event: (_: ServerEvent) => {},
  views: new Map<string, SessionView>(),
}));

vi.mock('../src/lib/api', () => ({
  connectEvents: (event: typeof mock.event) => { mock.event = event; return () => {}; },
  api: async (path: string) => {
    if (path === '/info') return { cwd: '/project', config: {} };
    if (path === '/providers' || path.startsWith('/sessions?')) return [];
    return mock.views.get(path.split('/').at(-1)!) ?? {};
  },
}));
vi.mock('../src/lib/notify', () => ({ notifyAway: () => {} }));

function result(callId: string, content = 'done'): ToolResultPart {
  return {
    type: 'tool_result', callId, name: 'shell', content,
    display: { kind: 'terminal', command: 'pnpm typecheck', output: content, exitCode: 0, durationMs: 4, cwd: '/project' },
  };
}

function history(id: string): Message[] {
  return Array.from({ length: 500 }, (_, i): Message[] => {
    const turn = id + '-t' + i;
    const callId = turn + '-call';
    return [
      { id: turn + '-user', turn, time: 100 * i, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Question ' + i }] },
      { id: turn + '-work', turn, time: 100 * i + 10, role: 'assistant', stop: 'tool_use',
        parts: [{ type: 'tool_call', id: callId, name: 'shell', input: { command: 'pnpm typecheck' } }] },
      { id: turn + '-result', turn, time: 100 * i + 20, role: 'user', origin: 'tool', parts: [result(callId)] },
      { id: turn + '-answer', turn, time: 100 * i + 30, role: 'assistant', stop: 'end', parts: [{ type: 'text', text: 'Answer 答复 ' + i }] },
    ];
  }).flat();
}

function view(id: string, messages: Message[]): SessionView {
  return {
    meta: { id, model: 'm1' }, messages, status: 'idle', activeStart: 0, turns: [], model: { id: 'm1' },
    pending: { permissions: [], questions: [], plans: [] },
  } as unknown as SessionView;
}

function findWindow(items: Item[], key: string) {
  const index = items.findIndex((item) => keysOf(item).includes(key));
  return index < 0 ? null : drawn(items, toShow(items, TAIL, index));
}

it('matches the full timeline after every event in a long conversation', async () => {
  vi.useFakeTimers();
  try {
    const store = await import('../src/lib/store');
    const original = history('s1');
    mock.views.set('s1', view('s1', original));
    mock.views.set('s2', view('s2', history('s2')));
    await store.actions.boot();
    await store.actions.open('s1');

    let current: TimelineBuild | undefined;
    const oldCall = 's1-t0-call';
    const turn = 's1-live';
    const callIds = ['first', 'second', 'third'];
    const check = (where: string) => {
      const { session, results, running, drafts } = store.getState();
      assert.ok(session);
      const input = { messages: session.messages, results, running, drafts, live: session.status !== 'idle', embedded: false, sessionId: session.meta.id };
      current = buildTimeline(input, current);
      const full = buildFullTimeline(input);
      assert.deepStrictEqual(current.items, full, where);
      for (const key of [oldCall, 'second', 'steer', 'final:0']) {
        assert.deepStrictEqual(findWindow(current.items, key), findWindow(full, key), where + ' find ' + key);
      }
      return current;
    };
    const emit = (event: { type: ServerEvent['type'] } & Record<string, unknown>) => {
      mock.event({ sessionId: 's1', time: Date.now(), ...event } as ServerEvent);
      vi.advanceTimersByTime(50);
      return check(event.type);
    };
    const add = (message: Omit<Message, 'time'>) => emit({ type: 'message.added', message: { time: Date.now(), ...message } });


    const opened = check('open').items;
    assert.ok(opened.some((item) => item.kind === 'work' && keysOf(item).includes(oldCall)));
    assert.ok(opened.some((item) => item.kind === 'text' && item.ledger?.runs[0]?.command === 'pnpm typecheck'));
    emit({ type: 'turn.start', turn });
    emit({ type: 'status', status: 'running' });
    add({ id: 'ask', turn, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Make it.' }] });
    emit({ type: 'stream.start', messageId: 'work', model: 'm1' });
    for (let i = 0; i < 100; i++) {
      const built = emit({ type: 'stream.text', messageId: 'work', index: 0, delta: 'Thinking. ' });
      assert.equal(built.items[1], opened[1]);
    }
    const calls = callIds.map((id, i) => {
      emit({ type: 'stream.tool', messageId: 'work', index: i + 1, name: 'shell', delta: '{"command":"pnpm typecheck"}' });
      return { type: 'tool_call' as const, id, name: 'shell', input: { command: 'pnpm typecheck' } };
    });
    add({ id: 'work', turn, role: 'assistant', stop: 'tool_use', parts: [{ type: 'text', text: 'Thinking. '.repeat(100) }, ...calls] });
    for (const call of calls) {
      emit({ type: 'tool.start', callId: call.id, name: call.name, title: 'Check', input: call.input });
      emit({ type: 'tool.progress', callId: call.id, chunk: 'checking\n' });
    }
    emit({ type: 'tool.end', callId: 'first', result: result('first') });
    add({ id: 'steer', turn, role: 'user', origin: 'tool',
      parts: [{ type: 'text', synthetic: true, text: 'The user sent this while you were working:\nKeep going.' }] });
    emit({ type: 'stream.start', messageId: 'final', model: 'm1' });
    for (let i = 100; i < 400; i++) {
      if (i === 175) emit({ type: 'tool.end', callId: 'second', result: result('second', 'arrived after text') });
      if (i === 250) {
        const previous = current!.items[1];
        const built = emit({ type: 'tool.end', callId: oldCall, result: result(oldCall, 'old call result') });
        assert.notEqual(built.items[1], previous);
      }
      emit({ type: 'stream.text', messageId: 'final', index: 0, delta: 'Result. ' });
    }
    emit({ type: 'tool.end', callId: 'third', result: result('third') });
    add({ id: 'results', turn, role: 'user', origin: 'tool', parts: callIds.map((id) => result(id)) });
    add({ id: 'final', turn, role: 'assistant', stop: 'end', parts: [{ type: 'text', text: 'Result. '.repeat(300) }] });
    emit({ type: 'turn.end', reason: 'done' });
    emit({ type: 'status', status: 'idle' });

    mock.views.set('s1', view('s1', original.slice(0, -4)));
    await store.actions.refreshSession();
    check('rewind');
    const last = original.at(-4)!;
    add({ ...last, id: 'edited', parts: [{ type: 'text', text: 'Edited and sent again.' }] });
    add({ id: 'summary', turn, role: 'user', origin: 'compaction', parts: [{ type: 'text', text: 'Summary of earlier work.' }] });
    add({ ...original[1], replay: true });
    const beforeSwitch = store.getState().session!;
    mock.views.set('s1', beforeSwitch);
    await store.actions.open('s2');
    check('switch session');
    await store.actions.open('s1');
    assert.deepStrictEqual(check('switch back').items, buildFullTimeline({
      messages: beforeSwitch.messages, results: store.getState().results, running: new Map(), drafts: new Map(), live: false, embedded: false,
    }));
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}, 30_000);
