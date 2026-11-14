import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, vi } from 'vitest';
import { api, connectEvents } from '../src/lib/api';
import { settingsWords } from '@favilla/core/i18n';

class Source {
  static all: Source[] = [];
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (message: MessageEvent) => void;
  private listeners = new Map<string, (message: MessageEvent) => void>();

  constructor(readonly url: string) { Source.all.push(this); }
  close() {}
  addEventListener(name: string, listener: (message: MessageEvent) => void) { this.listeners.set(name, listener); }
  send(name: string, data: unknown, lastEventId = '') {
    const receive = name === 'message' ? this.onmessage : this.listeners.get(name);
    receive?.({ data: JSON.stringify(data), lastEventId } as MessageEvent);
  }
}

beforeEach(() => {
  Source.all = [];
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', Source);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('only advances the cursor when the whole replay has been applied', async () => {
  const replay = vi.fn(), onState = vi.fn();
  const stop = connectEvents(() => {}, onState, { session: 'a', draft: () => {}, replay });
  const first = Source.all[0];
  first.send('replay', {});
  first.send('ready', { resumed: false }, 'server.2');
  await Promise.resolve();
  first.onerror?.();
  await vi.advanceTimersByTimeAsync(500);

  const second = Source.all[1];
  const query = (s: Source) => new URL(s.url, 'http://127.0.0.1').searchParams;
  assert.equal(query(second).get('after'), 'server.2');
  const missed = { type: 'turn.start', sessionId: 'a', turn: 'one' };
  second.send('replay', {});
  second.send('message', missed, 'server.3');
  second.onerror?.();
  await vi.advanceTimersByTimeAsync(1000);

  const third = Source.all[2];
  assert.equal(query(third).get('after'), 'server.2');
  assert.equal(replay.mock.calls.length, 0);
  third.send('replay', {});
  third.send('message', missed, 'server.3');
  third.send('ready', { resumed: true }, 'server.3');
  assert.deepEqual(replay.mock.calls, [[[missed]]]);
  assert.deepEqual(onState.mock.lastCall, ['open', true]);
  stop();
});

it('reconnects with its cursor even if the status probe never answers', async () => {
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })));
  const stop = connectEvents(() => {}, () => {}, { session: 'a', draft: () => {}, replay: () => {} });
  try {
    const first = Source.all[0];
    first.send('replay', {});
    first.send('ready', { resumed: false }, 'server.2');
    await Promise.resolve();
    first.onerror?.();
    await vi.advanceTimersByTimeAsync(8000);
    assert.equal(Source.all.length, 2);
    assert.equal(new URL(Source.all[1].url, 'http://127.0.0.1').searchParams.get('after'), 'server.2');
  } finally {
    stop();
  }
});

it('changes interest on the same connection and ignores a stale draft', async () => {
  const draft = vi.fn();
  const stop = connectEvents(() => {}, () => {}, { session: 'a', draft, replay: () => {} });
  const source = Source.all[0];
  source.send('replay', {});
  source.send('ready', { resumed: false }, 'server.2');
  await Promise.resolve();

  stop.follow?.('b');
  stop.follow?.('c');
  const snapshot = { messageId: 'reply', parts: [{ index: 0, kind: 'text', text: 'Before opening.' }] };
  source.send('draft', { version: 1, session: 'b', draft: snapshot });
  source.send('draft', { version: 2, session: 'c', draft: snapshot });
  assert.deepEqual(draft.mock.calls, [['c', snapshot]]);
  assert.equal(Source.all.length, 1);
  assert.deepEqual(vi.mocked(fetch).mock.calls.map(([, request]) => [request?.method, JSON.parse(String(request?.body))]), [
    ['PUT', { version: 1, session: 'b' }],
    ['PUT', { version: 2, session: 'c' }],
  ]);
  stop();
});


it('shows a settings issue once per version and localizes a refused save', async () => {
  const { actions, getState } = await import('../src/lib/store');
  const vars = { file: '/fixture/config.json', line: 3 };
  const notice = { id: 'file-version-one', key: settingsWords.start, vars };
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (url === '/api/info') return Response.json({ cwd: '/fixture', config: { language: 'zh-CN' }, settingsNotices: [notice] });
    if (url === '/api/config' && init?.method === 'PUT') return Response.json({ problem: { key: settingsWords.save, vars } }, { status: 400 });
    return Response.json([]);
  });
  await actions.boot();
  const first = getState().toasts.at(-1);
  assert.equal(first?.text, '/fixture/config.json 第 3 行的 JSON 无效。修好之前，Favilla 使用默认设置。');
  Source.all[0].send('message', { type: 'server.settings', notice });
  assert.equal(getState().toasts.at(-1), first);
  Source.all[0].send('message', { type: 'server.settings', notice: { ...notice, id: 'file-version-two' } });
  assert.notEqual(getState().toasts.at(-1)?.id, first?.id);
  await assert.rejects(api('/config', { method: 'PUT', body: { theme: 'kiln' } }), /第 3 行的 JSON 无效。请修好后再保存。/);
});
