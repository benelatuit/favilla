import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSession, browserTool } from '../src/tools/browser';
import type { ToolContext } from '../src/tools/types';

// A socket that never emits close or answers: cleanup must not depend on another event arriving.
type Transport = {
  ws: { send: (text: string) => void; close: () => void };
  pending: Map<number, unknown>;
  loadWaiters: (() => void)[];
  send: (method: string, params?: Record<string, unknown>, session?: string | false, limitMs?: number) => Promise<unknown>;
  receive: (message: unknown) => void;
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});
const browser = () => {
  vi.useFakeTimers();
  const session = new BrowserSession('', false);
  const transport = session as unknown as Transport;
  transport.ws = { send: () => {}, close: () => {} };
  return { session, transport };
};

describe('browser command lifecycle', () => {
  it.each([
    { confine: true, interactive: true },
    { confine: true, interactive: false },
    { confine: false, interactive: false },
    { confine: false, interactive: undefined },
    { confine: false, interactive: true },
  ])('honors show only for an interactive, unconfined caller: %j', async ({ confine, interactive }) => {
    const { session } = browser();
    const visible = vi.spyOn(session, 'setVisible');
    // Fail before launching a process: even the allowed-window case cannot open one in this test.
    vi.spyOn(session, 'start').mockRejectedValue(new Error('mock browser'));
    vi.spyOn(session, 'evaluate').mockRejectedValue(new Error('mock browser'));
    const ctx = { config: { confine }, interactive, signal: new AbortController().signal, model: { vision: false }, browser: () => session } as unknown as ToolContext;
    const pending = browserTool.execute({ show: true }, ctx);
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;
    const allowed = interactive && !confine;
    expect(visible).toHaveBeenCalledExactlyOnceWith(!!allowed);
    expect(result.content).toContain(allowed ? 'opened the browser as a window' : 'ignored show');
    session.close();
  });

  it('does not start a browser for an already cancelled operation', async () => {
    const { session } = browser();
    const start = vi.spyOn(session, 'start');
    const controller = new AbortController();
    controller.abort();
    const ctx = { signal: controller.signal, browser: () => session } as unknown as ToolContext;
    await expect(browserTool.execute({}, ctx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(start).not.toHaveBeenCalled();
    session.close();
  });

  it('removes a request and its timer when sending throws', async () => {
    const { session, transport } = browser();
    transport.ws.send = () => { throw new Error('socket closed while sending'); };
    await expect(transport.send('Runtime.evaluate')).rejects.toThrow('socket closed while sending');
    expect(transport.pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    session.close();
  });

  it('rejects pending commands immediately when the session closes', async () => {
    const { session, transport } = browser();
    let failure: unknown;
    void transport.send('Runtime.evaluate').catch((e) => { failure = e; });
    session.close();
    await Promise.resolve();
    expect(failure).toBeInstanceOf(Error);
    expect(transport.pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out exactly once and ignores a late response', async () => {
    const { session, transport } = browser();
    const waiting = transport.send('Runtime.evaluate', {}, false, 100).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toContain('did not answer Runtime.evaluate');
    expect(transport.pending.size).toBe(0);
    transport.receive({ id: 1, result: { value: 'late' } });
    expect(vi.getTimerCount()).toBe(0);
    session.close();
  });

  it.each(['loaded', 'closed', 'failed', 'aborted'])('cleans up navigation waiters when %s', async (ending) => {
    const { session, transport } = browser();
    const controller = new AbortController();
    const work = session.withSignal(controller.signal, () => session.open('http://fixture.test')).then(
      () => 'loaded',
      (e: Error) => e.name === 'AbortError' ? e.name : e.message,
    );
    transport.receive({ id: 1, result: ending === 'failed' ? { errorText: 'navigation failed' } : {} });
    await Promise.resolve();
    if (ending === 'loaded') transport.receive({ method: 'Page.loadEventFired' });
    if (ending === 'closed') session.close();
    if (ending === 'aborted') controller.abort();
    expect(await work).toMatch(ending === 'loaded' ? /^loaded$/ : ending === 'closed' ? /browser closed/ : ending === 'failed' ? /navigation failed/ : /AbortError/);
    expect(transport.loadWaiters).toHaveLength(0);
    expect(transport.pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    session.close();
  });

});
