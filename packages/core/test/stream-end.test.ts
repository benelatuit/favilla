import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adapterFor } from '../src/providers';
import { withoutMarks } from '../src/providers/openai-responses';

// A connection can close cleanly in the middle of a reply. On every protocol that is a failure to retry, never an answer:
// half a reply must not pass for a whole one, and half a tool call must not run. Each stream is what that server sends.
let stream: string[] = [];
const fake = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const line of stream) res.write(`${line}\n\n`);
    res.end();
  });
});
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => {
  fake.close();
});

const send = (api: string, path: string, emit: (ev: { type: string; delta?: string }) => void = () => {}) =>
  adapterFor(api as never).stream(
    {
      model: { id: 'm1', provider: 'fake', quirks: {}, vision: false, efforts: [], family: 'x', maxOutput: 1000 },
      provider: { id: 'fake', name: 'Fake', api, baseUrl: `${base}${path}`, auth: 'key', keys: ['k'], headers: {}, quirks: {}, proxy: false, local: true, enabled: true, settings: {} },
      system: 's',
      tools: [],
      hostedSearch: false,
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Hi' }], time: 0 }],
      effort: 'off',
      maxOutputTokens: 100,
      sessionId: 's',
      turnId: 't',
      turnStart: 0,
      signal: new AbortController().signal,
      options: {},
    } as never,
    emit as never,
  );

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
