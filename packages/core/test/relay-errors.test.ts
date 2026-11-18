import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adapterFor } from '../src/providers';
import { ProviderError } from '../src/providers/errors';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-relay-errors-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

let anthropicResponder: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void = (_req, _body, res) => res.end();
let geminiResponder: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void = (_req, _body, res) => res.end();

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.startsWith('/v1/messages')) return anthropicResponder(req, body, res);
    if (req.url?.includes(':streamGenerateContent')) return geminiResponder(req, body, res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
});

const { createRuntime } = await import('../src/runtime');
let base = '';
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'ant-relay/claude-sonnet-4-6',
      tools: 'favilla',
      languageServers: false,
      providers: {
        'ant-relay': {
          name: 'Anthropic Relay',
          api: 'anthropic',
          baseUrl: base,
          apiKey: 'test-ant-key',
          local: true,
          models: {
            'claude-sonnet-4-6': {
              contextWindow: 200_000,
              maxOutput: 16_384,
              family: 'claude',
              efforts: ['off', 'low', 'medium', 'high'],
            },
          },
        },
        'gem-relay': {
          name: 'Gemini Relay',
          api: 'gemini',
          baseUrl: `${base}/v1beta`,
          apiKey: 'test-gem-key',
          local: true,
          models: {
            'gemini-3.8-flash': {
              contextWindow: 200_000,
              maxOutput: 16_384,
              family: 'gemini',
              efforts: ['off', 'low', 'medium', 'high'],
            },
          },
        },
      },
    }),
  );
  rt = createRuntime(project, { interactive: true });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const antSse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function sendDirect(api: 'anthropic' | 'gemini', subPath: string) {
  return adapterFor(api).stream(
    {
      model: { id: 'm1', provider: 'relay', quirks: {}, vision: false, efforts: [], family: 'x', maxOutput: 1000 },
      provider: {
        id: 'relay',
        name: 'Relay',
        api,
        baseUrl: `${base}${subPath}`,
        auth: 'key',
        keys: ['test-key'],
        headers: {},
        quirks: {},
        proxy: false,
        local: true,
        enabled: true,
        settings: {},
      },
      system: 's',
      tools: [],
      hostedSearch: false,
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Hi' }], time: 0 }],
      effort: 'off',
      maxOutputTokens: 128,
      sessionId: 's',
      turnId: 't',
      turnStart: 0,
      signal: new AbortController().signal,
      options: {},
    } as never,
    () => {},
  );
}

const lastText = (s: { messages: { role: string; parts: { type: string; text?: string }[] }[] }) =>
  [...s.messages]
    .reverse()
    .find((m) => m.role === 'assistant')
    ?.parts.filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('') ?? '';

describe('SSE 200 in-stream rate limits from Anthropic and Gemini relays', () => {
  it('classifies Anthropic SSE 200 rate_limit_error events as retryable rate_limit with parsed reset delay', async () => {
    anthropicResponder = (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        antSse('error', {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Number of request tokens has exceeded your per-minute rate limit. Please try again in 25ms.',
          },
        }),
      );
      res.end();
    };
    const err1 = await sendDirect('anthropic', '').catch((e) => e);
    expect(err1).toBeInstanceOf(ProviderError);
    expect(err1).toMatchObject({ kind: 'rate_limit', retryable: true, retryAfterMs: 25 });

    // Even when the message text itself says nothing about "rate limit", error.type = rate_limit_error still classifies it.
    anthropicResponder = (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        antSse('error', {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Upstream channel throttled.' },
        }),
      );
      res.end();
    };
    const err2 = await sendDirect('anthropic', '').catch((e) => e);
    expect(err2).toBeInstanceOf(ProviderError);
    expect(err2).toMatchObject({ kind: 'rate_limit', retryable: true });

    // A relay sending the error JSON on event: message is also classified as rate_limit.
    anthropicResponder = (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        antSse('message', {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Channel busy, please retry in 15ms.' },
        }),
      );
      res.end();
    };
    const err3 = await sendDirect('anthropic', '').catch((e) => e);
    expect(err3).toBeInstanceOf(ProviderError);
    expect(err3).toMatchObject({ kind: 'rate_limit', retryable: true, retryAfterMs: 15 });
  });

  it('classifies Gemini SSE 200 429 RESOURCE_EXHAUSTED payloads as retryable rate_limit with RetryInfo delay', async () => {
    geminiResponder = (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          error: {
            code: 429,
            message: 'Resource has been exhausted (e.g. check quota).',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.02s' }],
          },
        })}\n\n`,
      );
      res.end();
    };
    const err1 = await sendDirect('gemini', '/v1beta').catch((e) => e);
    expect(err1).toBeInstanceOf(ProviderError);
    expect(err1).toMatchObject({ kind: 'rate_limit', retryable: true, status: 429, retryAfterMs: 20 });

    geminiResponder = (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          error: {
            code: 429,
            message: "Quota exceeded for quota metric 'Generate Content API requests per minute'.",
            status: 'RESOURCE_EXHAUSTED',
          },
        })}\n\n`,
      );
      res.end();
    };
    const err2 = await sendDirect('gemini', '/v1beta').catch((e) => e);
    expect(err2).toBeInstanceOf(ProviderError);
    expect(err2).toMatchObject({ kind: 'rate_limit', retryable: true, status: 429 });
  });

  it('waits out Anthropic SSE 200 rate_limit_error in an interactive session while replaying signed thinking intact', async () => {
    let calls = 0;
    const seenBodies: any[] = [];
    anthropicResponder = (_req, body, res) => {
      calls++;
      seenBodies.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (calls === 1) {
        res.write(
          antSse('message_start', {
            type: 'message_start',
            message: { id: 'm1', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } },
          }),
        );
        res.write(antSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }));
        res.write(antSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan turn 1' } }));
        res.write(antSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG_ANT_TURN1' } }));
        res.write(antSse('content_block_stop', { type: 'content_block_stop', index: 0 }));
        res.write(antSse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'RED_ANT_TURN1' } }));
        res.write(antSse('content_block_stop', { type: 'content_block_stop', index: 1 }));
        res.write(antSse('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }));
        res.write(antSse('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'First answer.' } }));
        res.write(antSse('content_block_stop', { type: 'content_block_stop', index: 2 }));
        res.write(antSse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }));
        res.write(antSse('message_stop', { type: 'message_stop' }));
        return void res.end();
      }
      if (calls <= 5) {
        res.write(
          antSse('message_start', {
            type: 'message_start',
            message: { id: `m_${calls}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } },
          }),
        );
        res.write(antSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        res.write(antSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial draft.' } }));
        res.write(
          antSse('error', {
            type: 'error',
            error: { type: 'rate_limit_error', message: 'This request would exceed the rate limit. Please try again in 10ms.' },
          }),
        );
        return void res.end();
      }
      res.write(
        antSse('message_start', {
          type: 'message_start',
          message: { id: 'm6', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } },
        }),
      );
      res.write(antSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      res.write(antSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered Anthropic.' } }));
      res.write(antSse('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(antSse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }));
      res.write(antSse('message_stop', { type: 'message_stop' }));
      res.end();
    };

    const s = await rt.start({ cwd: project, interactive: true, model: 'ant-relay/claude-sonnet-4-6', effort: 'low' });
    const notices: { key?: string }[] = [];
    s.on((e) => {
      if (e.type === 'notice' && e.level === 'warn') notices.push(e);
    });
    await s.send('Step 1.');
    expect(lastText(s)).toBe('First answer.');

    const started = Date.now();
    await s.send('Step 2.');
    expect(calls).toBe(6);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(lastText(s)).toBe('Recovered Anthropic.');
    expect(notices.length).toBe(4);
    expect(notices.every((n) => n.key === 'The provider is limiting requests; trying again ({n}).')).toBe(true);

    for (const reqBody of seenBodies.slice(1)) {
      const assistantTurn = reqBody.messages.find((m: any) => m.role === 'assistant');
      expect(assistantTurn.content[0]).toEqual({ type: 'thinking', thinking: 'plan turn 1', signature: 'SIG_ANT_TURN1' });
      expect(assistantTurn.content[1]).toEqual({ type: 'redacted_thinking', data: 'RED_ANT_TURN1' });
    }
  }, 30_000);

  it('waits out Gemini SSE 200 429 RESOURCE_EXHAUSTED past the 3-try outage cap in an interactive session and replays thoughtSignatures', async () => {
    let calls = 0;
    const seenBodies: any[] = [];
    geminiResponder = (_req, body, res) => {
      calls++;
      seenBodies.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (calls === 1) {
        res.write(
          `data: ${JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { text: 'gem plan 1', thought: true, thoughtSignature: 'TS_GEM_THOUGHT_1' },
                    { text: 'First Gemini.', thoughtSignature: 'TS_GEM_TEXT_1' },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
          })}\n\n`,
        );
        return void res.end();
      }
      if (calls <= 5) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              code: 429,
              message: 'Resource has been exhausted (e.g. check quota).',
              status: 'RESOURCE_EXHAUSTED',
              details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' }],
            },
          })}\n\n`,
        );
        return void res.end();
      }
      res.write(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Recovered Gemini.' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4 },
        })}\n\n`,
      );
      res.end();
    };

    const s = await rt.start({ cwd: project, interactive: true, model: 'gem-relay/gemini-3.8-flash', effort: 'low' });
    const notices: { key?: string }[] = [];
    s.on((e) => {
      if (e.type === 'notice' && e.level === 'warn') notices.push(e);
    });
    await s.send('Step 1.');
    expect(lastText(s)).toBe('First Gemini.');

    const started = Date.now();
    await s.send('Step 2.');
    expect(calls).toBe(6);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(lastText(s)).toBe('Recovered Gemini.');
    expect(notices.length).toBe(4);
    expect(notices.every((n) => n.key === 'The provider is limiting requests; trying again ({n}).')).toBe(true);

    for (const reqBody of seenBodies.slice(1)) {
      const modelTurn = reqBody.contents.find((c: any) => c.role === 'model');
      expect(modelTurn.parts[0]).toEqual({ text: 'gem plan 1', thought: true, thoughtSignature: 'TS_GEM_THOUGHT_1' });
      expect(modelTurn.parts[1]).toEqual({ text: 'First Gemini.', thoughtSignature: 'TS_GEM_TEXT_1' });
    }
  }, 30_000);
});
