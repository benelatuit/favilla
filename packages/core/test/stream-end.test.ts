import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSse } from '../src/net/http';
import { adapterFor, resetAdapters } from '../src/providers';
import { withoutMarks } from '../src/providers/openai-responses';
import type { Message } from '../src/types';

// A connection can close cleanly in the middle of a reply. On every protocol that is a failure to retry, never an answer:
// half a reply must not pass for a whole one, and half a tool call must not run. Each stream is what that server sends.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-stream-end-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');

let stream: string[] = [];
let customHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) | null = null;
const heldSockets = new Set<Socket>();

const fake = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (customHandler) {
      const h = customHandler;
      customHandler = null;
      void h(req, res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const line of stream) res.write(`${line}\n\n`);
    res.end();
  });
});

let base = '';
beforeAll(async () => {
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(async () => {
  resetAdapters();
  await new Promise<void>((resolve, reject) => fake.close((err) => (err ? reject(err) : resolve())));
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface SendOverrides {
  channel?: 'main' | 'side';
  messages?: Message[];
  settings?: Record<string, unknown>;
  signal?: AbortSignal;
}

const send = (api: string, pathSuffix: string, emit: (ev: { type: string; delta?: string }) => void = () => {}, over: SendOverrides = {}) =>
  adapterFor(api as never).stream(
    {
      model: { id: 'm1', provider: 'fake', quirks: {}, vision: false, efforts: [], family: 'x', maxOutput: 1000 },
      provider: {
        id: 'fake',
        name: 'Fake',
        api,
        baseUrl: `${base}${pathSuffix}`,
        auth: 'key',
        keys: ['k'],
        headers: {},
        quirks: {},
        proxy: false,
        local: true,
        enabled: true,
        settings: over.settings ?? {},
      },
      system: 's',
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      hostedSearch: false,
      messages: over.messages ?? [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Hi' }], time: 0 }],
      effort: 'off',
      maxOutputTokens: 100,
      sessionId: 's',
      turnId: 't',
      turnStart: 0,
      channel: over.channel,
      signal: over.signal ?? new AbortController().signal,
      options: {},
    } as never,
    emit as never,
  );

/** Hold an HTTP SSE stream open after writing frames so only client-side termination ends it promptly. */
function holdStream(writeFrames: (write: (frame: string) => void) => void | Promise<void>) {
  let serverEnded = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  customHandler = async (req, res) => {
    const sock = req.socket;
    heldSockets.add(sock);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const timer = setTimeout(() => {
      serverEnded = true;
      if (!res.writableEnded) res.end();
    }, 800);
    const onClose = () => {
      clearTimeout(timer);
      heldSockets.delete(sock);
      resolveClosed();
    };
    res.once('close', onClose);
    sock.once('close', onClose);
    await writeFrames((frame) => {
      if (!res.destroyed) res.write(`${frame}\n\n`);
    });
  };
  return {
    get serverEnded() {
      return serverEnded;
    },
    closed,
  };
}

const closedEarly = /closed before the reply ended|ended|closed|network|terminated/i;

describe('a reply that stops with the connection', () => {
  const text = (t: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })}`;

  it('Chat: no finish reason and no [DONE] is a failure; either one is an end', async () => {
    stream = [text('half a')];
    await expect(send('openai-chat', '/v1')).rejects.toThrow(closedEarly);
    stream = [text('whole'), `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`];
    expect((await send('openai-chat', '/v1')).stop).toBe('end');
    stream = [text('whole'), 'data: [DONE]'];
    expect((await send('openai-chat', '/v1')).stop).toBe('end');
  });

  it('Responses: no response.completed is a failure', async () => {
    const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}`;
    const added = sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'i', role: 'assistant', content: [] } });
    const delta = sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'half a' });
    stream = [added, delta];
    await expect(send('openai-responses', '/v1')).rejects.toThrow(closedEarly);
    stream = [added, delta, sse({ type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } })];
    expect((await send('openai-responses', '/v1')).stop).toBe('end');
  });

  it("Responses: the hosted search's marks reach neither the text shown nor the text kept; an entity keeps its name", async () => {
    const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}`;
    const delta = (d: string) => sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: d });
    const said = 'Made by entity["company","OpenAI"], it shipped in 2026. citeturn576729search0turn272430search0 More.';
    stream = [
      sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'i', role: 'assistant', content: [] } }),
      // A mark split across deltas is held until it closes.
      ...['Made by enti', 'ty["company","OpenAI"], it shipped in 2026. citeturn5767', '29search0turn272430search0 More.'].map(delta),
      sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'i', role: 'assistant', content: [{ type: 'output_text', text: said }] } }),
      sse({ type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } }),
    ];
    let live = '';
    const result = await send('openai-responses', '/v1', (ev) => {
      if (ev.type === 'text') live += ev.delta;
    });
    const kept = result.parts.find((p: { type: string }) => p.type === 'text') as { text: string };
    expect(kept.text).toBe('Made by OpenAI, it shipped in 2026. More.');
    expect(live).not.toMatch(/[-]|cite|turn\d/);
    expect(live).toMatch(/^Made by OpenAI, it shipped in 2026\. +More\.$/);
  });

  it('Responses: a citation whose private-use characters were lost goes too', () => {
    expect(withoutMarks('Fixed in 0.9. citeturn576729search0turn272430search0 Next.')).toBe('Fixed in 0.9. Next.');
    expect(withoutMarks('The cited turn of events')).toBe('The cited turn of events');
  });

  it('Anthropic: no stop reason is a failure', async () => {
    const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}`;
    const start = [
      sse({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'm1', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half a' } }),
    ];
    stream = start;
    await expect(send('anthropic', '')).rejects.toThrow();
    stream = [...start, sse({ type: 'content_block_stop', index: 0 }), sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }), sse({ type: 'message_stop' })];
    expect((await send('anthropic', '')).stop).toBe('end');
  });

  it('Gemini: no finish reason is a failure', async () => {
    const part = (t: string, finishReason?: string) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: t }] }, ...(finishReason ? { finishReason } : {}) }] })}`;
    stream = [part('half a')];
    await expect(send('gemini', '')).rejects.toThrow(closedEarly);
    stream = [part('whole', 'STOP')];
    expect((await send('gemini', '')).stop).toBe('end');
  });
});

describe('a reply whose terminal frame arrives before HTTP EOF', () => {
  it('readSse: breaking early cancels the reader and unlocks the stream', async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: first\n\ndata: second\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const seen: string[] = [];
    for await (const ev of readSse(body)) {
      seen.push(ev.data);
      break;
    }
    expect(seen).toEqual(['first']);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it('Chat: finishes on [DONE] without waiting for EOF, keeps usage after finish_reason, and closes the open stream', async () => {
    const held = holdStream(async (write) => {
      write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Answer.' } }] })}`);
      write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null })}`);
      // Separate tick so breaking on finish_reason would miss the trailing usage chunk.
      await new Promise((r) => setTimeout(r, 20));
      write(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 18,
            prompt_tokens_details: { cached_tokens: 64 },
            completion_tokens_details: { reasoning_tokens: 6 },
          },
        })}`,
      );
      write('data: [DONE]');
    });

    const result = await send('openai-chat', '/v1');
    expect(held.serverEnded).toBe(false);
    expect(result.stop).toBe('end');
    expect(result.parts).toEqual([{ type: 'text', text: 'Answer.' }]);
    expect(result.usage).toEqual({ input: 120, output: 18, cacheRead: 64, cacheWrite: 0, reasoning: 6 });

    await held.closed;
    expect(held.serverEnded).toBe(false);
    expect(heldSockets.size).toBe(0);
  });

  it('Responses HTTP: finishes on response.completed and response.incomplete without waiting for EOF, and closes the open stream', async () => {
    const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}`;
    const msgAdded = sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } });
    const msgDelta = (t: string) => sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: t });
    const msgDone = (t: string) => sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: t }] } });

    // 1. response.completed over standard fetch (auth: 'key').
    const heldCompleted = holdStream((write) => {
      write(msgAdded);
      write(msgDelta('Complete.'));
      write(msgDone('Complete.'));
      write(
        sse({
          type: 'response.completed',
          response: {
            id: 'r_ok',
            status: 'completed',
            output: [],
            usage: { input_tokens: 80, output_tokens: 9, input_tokens_details: { cached_tokens: 32 }, output_tokens_details: { reasoning_tokens: 4 } },
          },
        }),
      );
    });
    const completed = await send('openai-responses', '/v1');
    expect(heldCompleted.serverEnded).toBe(false);
    expect(completed.stop).toBe('end');
    expect(completed.parts).toEqual([{ type: 'text', text: 'Complete.', meta: { itemId: 'm1', phase: undefined } }]);
    expect(completed.usage).toEqual({ input: 80, output: 9, cacheRead: 32, cacheWrite: 0, reasoning: 4 });
    await heldCompleted.closed;
    expect(heldCompleted.serverEnded).toBe(false);
    expect(heldSockets.size).toBe(0);

    // 2. response.incomplete (max_output_tokens and content_filter) over HTTP.
    for (const [reason, expectedStop] of [
      ['max_output_tokens', 'max_tokens'],
      ['content_filter', 'refusal'],
    ] as const) {
      const heldInc = holdStream((write) => {
        write(msgAdded);
        write(msgDelta('Cut.'));
        write(
          sse({
            type: 'response.incomplete',
            response: {
              id: `r_${reason}`,
              status: 'incomplete',
              incomplete_details: { reason },
              output: [],
              usage: { input_tokens: 50, output_tokens: 100 },
            },
          }),
        );
      });
      const inc = await send('openai-responses', '/v1');
      expect(heldInc.serverEnded).toBe(false);
      expect(inc.stop).toBe(expectedStop);
      expect(inc.usage).toEqual({ input: 50, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
      await heldInc.closed;
      expect(heldInc.serverEnded).toBe(false);
      expect(heldSockets.size).toBe(0);
    }

    // 3. [DONE] without response.completed still fails immediately rather than waiting for EOF.
    const heldTruncated = holdStream((write) => {
      write(msgAdded);
      write(msgDelta('Half'));
      write('data: [DONE]');
    });
    await expect(send('openai-responses', '/v1')).rejects.toThrow(closedEarly);
    expect(heldTruncated.serverEnded).toBe(false);
    await heldTruncated.closed;
    expect(heldSockets.size).toBe(0);
  });

});
