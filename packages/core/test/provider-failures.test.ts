import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorFromStatus } from '../src/net/http';
import { networkError } from '../src/providers/errors';

// A first run from an empty home (2026-11-13) met a misspelt model name reported as an outage after three tries, a
// refused connection named twice, a retry notice counting to 7 before failing at 3, a key the server turned down
// shown as a green "1 model", and no way to go on after fixing any of it but typing the request again.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-failures-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

const sse = (res: http.ServerResponse, text: string) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// A relay with no channel for the model asked for, the way new-api answers a misspelt name.
let noChannelHits = 0;
const noChannel = http.createServer((req, res) => {
  req.resume();
  if (req.url?.endsWith('/models')) return json(res, 200, { data: [{ id: 'm1' }] });
  noChannelHits++;
  json(res, 503, { error: { message: 'No available channel for model m1-typo under group default (request id: 1)', type: 'new_api_error' } });
});

// A service down for its first three requests, then back.
let flakyHits = 0;
const flaky = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) return json(res, 200, { data: [{ id: 'm1' }] });
    flakyHits++;
    if (flakyHits <= 3) return json(res, 503, { error: { message: 'Service temporarily unavailable' } });
    const sent = JSON.parse(body).messages as { role: string; content: unknown }[];
    sse(res, sent.filter((m) => m.role === 'user').length ? 'Back now.' : 'No question?');
  });
});

// A server that turns down the key for its model list.
const locked = http.createServer((req, res) => {
  req.resume();
  json(res, 401, { error: { message: 'Invalid token' } });
});

const ports: Record<string, number> = {};
beforeAll(async () => {
  for (const [name, server] of Object.entries({ noChannel, flaky, locked })) {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    ports[name] = (server.address() as AddressInfo).port;
  }
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  const provider = (name: string, port: number) => ({ name, api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'flaky/m1',
      tools: 'favilla',
      languageServers: false,
      providers: {
        nochannel: { ...provider('No channel relay', ports.noChannel), models: { 'm1-typo': { contextWindow: 64000, family: 'gpt' } } },
        flaky: provider('Flaky relay', ports.flaky),
        locked: { name: 'Locked', api: 'openai-chat', baseUrl: `http://127.0.0.1:${ports.locked}/v1`, auth: 'none', local: true, discover: 'openai' },
      },
    }),
  );
});

afterAll(async () => {
  for (const s of [noChannel, flaky, locked]) s.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('what a failed request is taken for', () => {
  it('tells a model the provider does not have from a service that is down', () => {
    const kind = (status: number, body: unknown) => errorFromStatus(status, new Headers(), typeof body === 'string' ? body : JSON.stringify(body), 'P').kind;
    expect(kind(503, { error: { message: 'No available channel for model deepseek-v4.1-flsh under group default' } })).toBe('model_not_found');
    expect(kind(404, { error: { message: 'The model `gpt-9` does not exist or you do not have access to it.', code: 'model_not_found' } })).toBe('model_not_found');
    expect(kind(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope' } })).toBe('model_not_found');
    expect(kind(400, { error: { message: 'Model Not Exist' } })).toBe('model_not_found');
    expect(kind(404, { error: { message: 'models/gemini-9 is not found for API version v1beta' } })).toBe('model_not_found');
    expect(kind(404, { error: 'model "qwen9" not found, try pulling it first' })).toBe('model_not_found');
    // Refusals of a setting, which the session answers by changing what it sends, stay what they were.
    expect(kind(400, { error: { message: "'max' is not supported with this model. Supported values are: 'low', 'medium', and 'high'." } })).toBe('invalid_request');
    expect(kind(400, { error: { message: 'reasoning_effort for this model is not supported' } })).toBe('invalid_request');
    expect(kind(400, { error: { message: 'This model does not support system messages' } })).toBe('invalid_request');
    expect(kind(503, { error: { message: 'The server is overloaded' } })).toBe('overloaded');
    expect(kind(404, '404 page not found')).toBe('invalid_request');
  });

  it('a relay with no channel is still tried again when nobody is waiting, and a missing model is not', () => {
    expect(errorFromStatus(503, new Headers(), JSON.stringify({ error: { message: 'No available channel for model x' } }), 'P').retryable).toBe(true);
    expect(errorFromStatus(404, new Headers(), JSON.stringify({ error: { message: 'model: x', code: 'model_not_found' } }), 'P').retryable).toBe(false);
  });

  it('names a refused connection once', () => {
    const e = networkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3634' } }), 'Happy');
    expect(e.message).toBe('Happy: connect ECONNREFUSED 127.0.0.1:3634');
    expect(networkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } }), 'Happy').message).toBe('Happy: UND_ERR_SOCKET other side closed');
  });
});

describe('a failed turn, for the user who is waiting', () => {
  it('reports a model the relay has no channel for at once, and says what kind of failure it was', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true, model: 'nochannel/m1-typo' });
      const ends: { error?: string; errorKind?: string }[] = [];
      s.on((e) => e.type === 'turn.end' && ends.push(e));
      await s.send('Say hello.').catch(() => undefined);
      expect(noChannelHits).toBe(1);
      expect(ends.at(-1)?.errorKind).toBe('model_not_found');
      expect(ends.at(-1)?.error).not.toMatch(/the service may be down/);
    } finally {
      rt.dispose();
    }
  }, 30_000);

  it('counts its retry notices against the three tries it gets, and goes on from where it failed when asked', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true });
      const notices: { key?: string; arg?: string }[] = [];
      const ends: { reason: string; errorKind?: string }[] = [];
      s.on((e) => {
        if (e.type === 'notice' && e.level === 'warn') notices.push(e);
        if (e.type === 'turn.end') ends.push(e);
      });
      await s.send('Say hello.').catch(() => undefined);
      expect(flakyHits).toBe(3);
      expect(notices.map((n) => n.arg)).toEqual(['1/3', '2/3']);
      expect(notices.every((n) => n.key === 'The provider is busy or failing; trying again ({n}).')).toBe(true);
      expect(ends.at(-1)).toMatchObject({ reason: 'error', errorKind: 'overloaded' });
      // The service is back: the retry answers the message already in the history, without sending it again.
      await s.retry();
      expect(ends.at(-1)?.reason).toBe('done');
      const users = s.messages.filter((m) => m.role === 'user' && m.origin === 'user');
      expect(users).toHaveLength(1);
      const last = s.messages.at(-1)!;
      expect(last.role).toBe('assistant');
      expect(last.parts.some((p) => p.type === 'text' && p.text.includes('Back now.'))).toBe(true);
    } finally {
      rt.dispose();
    }
  }, 30_000);
});

describe('a provider just added', () => {
  it('keeps the reason its first model list failed, so the settings can say the key was turned down', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      await rt.catalog.discover('locked', true);
      expect(rt.catalog.providerListing(rt.catalog.provider('locked')).error).toMatch(/401/);
    } finally {
      rt.dispose();
    }
  });
});
