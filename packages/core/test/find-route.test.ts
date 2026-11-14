import { expect, it, vi } from 'vitest';
import type { Runtime } from '../src/runtime';
import { startServer } from '../src/server/server';

const finder = vi.hoisted(() => vi.fn());
vi.mock('../src/server/find', () => ({ findInSession: finder }));

function deferredSignal() {
  let resolve!: (signal: AbortSignal) => void;
  const promise = new Promise<AbortSignal>((ready) => { resolve = ready; });
  return { promise, resolve };
}

it('cancels a search when its window drops it, and not for another window searching the same session', async () => {
  const session = { messages: [] };
  const runtime = {
    config: {},
    get: async () => session,
    store: { blobs: {} },
    subscribe: () => () => {},
    catalog: { discoverAll: async () => {}, refreshRegistry: async () => false },
    mcp: { start: async () => {} },
    settingsNotices: [], subscribeSettings: () => () => {},
  } as unknown as Runtime;
  const server = await startServer({ runtime, token: 'find-test' });
  const result = { hits: [], total: 0, capped: false };
  let reached = deferredSignal();
  let release = () => {};
  finder.mockImplementation((_messages, query, _blobs, _max, signal: AbortSignal) => {
    if (query === 'new') return result;
    reached.resolve(signal);
    if (!signal) return result;
    return new Promise((resolve, reject) => {
      release = () => resolve(result);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const search = (id: string, query: string, signal?: AbortSignal) => fetch(`${server.url}api/sessions/${id}/find?q=${query}`, {
    headers: { Authorization: 'Bearer find-test' }, signal,
  });
  try {
    const first = search('one', 'old');
    const firstSignal = await reached.promise;
    expect(firstSignal).toBeDefined();
    expect(await (await search('other', 'new')).json()).toEqual(result);
    expect(firstSignal.aborted).toBe(false);
    expect(await (await search('one', 'new')).json()).toEqual(result);
    expect(firstSignal.aborted).toBe(false);
    release();
    expect(await (await first).json()).toEqual(result);

    reached = deferredSignal();
    const client = new AbortController();
    const disconnected = search('one', 'old', client.signal).catch((e: Error) => e);
    const secondSignal = await reached.promise;
    client.abort();
    expect(await disconnected).toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(secondSignal.aborted).toBe(true));
  } finally {
    await server.close();
  }
});
