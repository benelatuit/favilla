import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from '../package.json';
import type { ProviderCall } from '../src/providers/types';

// Relays behind Cloudflare refuse a request whose User-Agent is undici's own as a bot (403): every model request and
// the model list carry Favilla's name and version unless the provider's settings name another.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-headers-'));
process.env.FAVILLA_HOME = home;
const { Catalog } = await import('../src/catalog/catalog');
const { OpenAIChatAdapter } = await import('../src/providers/openai-chat');
const { OpenAIResponsesAdapter } = await import('../src/providers/openai-responses');
const { GeminiAdapter } = await import('../src/providers/gemini');

const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url ?? '', headers: req.headers });
  req.resume();
  // A refusal ends each call at once; only what was sent is looked at.
  res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'refused by the Favilla test server' } }));
});
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const ua = `favilla/${pkg.version}`;
const relay = (api: 'openai-chat' | 'openai-responses' | 'gemini', headers?: Record<string, string>, route = '/v1') =>
  new Catalog({ modelRegistry: false, providers: { relay: { api, baseUrl: `${base}${route}`, apiKey: 'test-key', local: true, discover: 'openai', ...(headers ? { headers } : {}) } } });

async function send(api: 'openai-chat' | 'openai-responses' | 'gemini', headers?: Record<string, string>) {
  const catalog = relay(api, headers);
  const call = {
    model: catalog.resolve('relay/m1'),
    provider: catalog.provider('relay'),
    system: 'test',
    tools: [],
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    effort: 'low',
    maxOutputTokens: 64,
    sessionId: 's1',
    turnId: 't1',
    turnStart: 0,
    signal: AbortSignal.timeout(10_000),
  } as unknown as ProviderCall;
  const adapter = api === 'openai-chat' ? new OpenAIChatAdapter() : api === 'openai-responses' ? new OpenAIResponsesAdapter() : new GeminiAdapter();
  seen.length = 0;
  await adapter.stream(call, () => {}).catch(() => {});
  expect(seen.length).toBeGreaterThan(0);
  return seen[0].headers;
}

describe('the User-Agent of a model request', () => {
  it.each(['openai-chat', 'openai-responses', 'gemini'] as const)('is favilla/<version> on %s', async (api) => {
    expect((await send(api))['user-agent']).toBe(ua);
  });

  it('is the one the provider settings name, when they name one', async () => {
    expect((await send('openai-chat', { 'User-Agent': 'my-client/2' }))['user-agent']).toBe('my-client/2');
  });

  it('is sent with the model list too', async () => {
    const catalog = relay('openai-chat');
    seen.length = 0;
    await catalog.discover('relay', true);
    expect(seen.find((s) => s.url.endsWith('/models'))?.headers['user-agent']).toBe(ua);
  });
});

describe('OpenRouter', () => {
  it('names the app by default, and a user can name another', () => {
    expect(new Catalog({ modelRegistry: false }).provider('openrouter').headers).toMatchObject({ 'X-Title': 'Favilla', 'HTTP-Referer': expect.stringContaining('favilla') });
    expect(new Catalog({ modelRegistry: false, providers: { openrouter: { headers: { 'X-Title': 'Mine' } } } }).provider('openrouter').headers['X-Title']).toBe('Mine');
  });

  it('keeps those names readable in an error, while a header that may hold a secret is still hidden', async () => {
    // The error names the address: a header value found in it is masked unless the header only names the client.
    const catalog = relay('openai-chat', { 'X-Title': 'Favilla', 'X-Relay-Secret': 'models' }, '/Favilla/v1');
    await catalog.discover('relay', true);
    const error = catalog.discoveryError('relay') ?? '';
    expect(error).toContain('/Favilla/');
    expect(error).not.toContain('models');
  });
});
