import type { Dispatcher } from 'undici';
import { afterEach, expect, it, vi } from 'vitest';

const { agent, proxyAgent, proxyDispatch } = vi.hoisted(() => ({
  agent: vi.fn<(options: { headersTimeout: number; bodyTimeout: number }) => void>(),
  proxyAgent: vi.fn<(options: { headersTimeout: number; bodyTimeout: number }) => void>(),
  proxyDispatch: vi.fn<Dispatcher.Dispatch>().mockReturnValue(true),
}));
vi.mock('undici', () => ({
  Agent: class { constructor(options: Parameters<typeof agent>[0]) { agent(options); } },
  ProxyAgent: class {
    constructor(options: Parameters<typeof proxyAgent>[0]) { proxyAgent(options); }
    compose(interceptor: Dispatcher.DispatcherComposeInterceptor) { return { dispatch: interceptor(proxyDispatch) }; }
  },
  fetch: vi.fn(),
  request: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([undefined, '1800000'])('keeps direct and proxy transport timeouts past the stream watch (override %s)', async (override) => {
  vi.stubEnv('FAVILLA_STALL_MS', override);
  vi.resetModules();
  const { getDispatcher } = await import('../src/net/http');
  getDispatcher();
  const proxy = getDispatcher('http://127.0.0.1:9');
  const stall = Number(override) || 25 * 60_000;
  for (const ctor of [agent, proxyAgent]) {
    expect(ctor).toHaveBeenCalledTimes(1);
    const [options] = ctor.mock.calls[0];
    expect(options.headersTimeout).toBeGreaterThan(stall);
    expect(options.bodyTimeout).toBeGreaterThan(stall);
  }
  proxy.dispatch({ origin: 'http://127.0.0.1:9', path: '/v1', method: 'GET' }, {});
  const [request] = proxyDispatch.mock.calls[0];
  expect(request.headersTimeout).toBeGreaterThan(stall);
  expect(request.bodyTimeout).toBeGreaterThan(stall);
});
