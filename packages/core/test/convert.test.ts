import { describe, expect, it } from 'vitest';
import type { Message } from '../src/types';
import type { ModelInfo, ResolvedProvider } from '../src/catalog/catalog';
import type { ProviderCall } from '../src/providers/types';
import { toAnthropicMessages } from '../src/providers/anthropic';
import { toResponsesInput, buildBody } from '../src/providers/openai-responses';
import { toChatMessages, ThinkSplitter } from '../src/providers/openai-chat';
import { toGeminiContents } from '../src/providers/gemini';
import { sendable } from '../src/context/prune';

const t = 0;
const user = (text: string, extra: Partial<Message> = {}): Message => ({ id: 'u', role: 'user', origin: 'user', parts: [{ type: 'text', text }], time: t, ...extra });

it('keeps internal evidence out of provider payloads and preserves the tool content', () => {
  const history: Message[] = [
    user('Read it.'),
    { id: 'a', role: 'assistant', time: t, parts: [{ type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a.ts' } }] },
    { id: 'r', role: 'user', time: t, parts: [{ type: 'tool_result', callId: 'c1', name: 'read', content: 'actual tool content', evidence: { reads: [{ path: 'a.ts', digest: 'INTERNAL-DIGEST', total: 8, ranges: [[1, 2]] }] } }] },
  ];
  const model = { id: 'm', vision: false, quirks: {} } as ModelInfo;
  const outputs = [
    toAnthropicMessages(history, 'anthropic'),
    toResponsesInput(history, 'openai'),
    toChatMessages({ model, system: 'S', messages: history, turnStart: 0 } as ProviderCall),
    toGeminiContents(history, 'gemini'),
  ];
  for (const out of outputs) {
    expect(JSON.stringify(out)).toContain('actual tool content');
    expect(JSON.stringify(out)).not.toContain('INTERNAL-DIGEST');
  }
});

it('sends a picture at the detail it asks for, and says nothing when it asks for none', () => {
  const picture = (detail?: 'high') => ({ type: 'image' as const, mediaType: 'image/png', data: 'AA', ...(detail ? { detail } : {}) });
  const history: Message[] = [
    { id: 'a', role: 'assistant', time: t, parts: [{ type: 'tool_call', id: 'c1', name: 'browser', input: {} }] },
    { id: 'r', role: 'user', origin: 'tool', time: t, parts: [{ type: 'tool_result', callId: 'c1', name: 'browser', content: 'page', images: [picture('high')] }] },
    { id: 'u', role: 'user', origin: 'user', time: t, parts: [picture()] },
  ];
  const responses = (toResponsesInput(history, 'openai') as any[]).flatMap((i) => i.content ?? []).filter((c) => c.type === 'input_image');
  expect(responses.map((c) => c.detail)).toEqual(['high', undefined]);
  const model = { id: 'm', vision: true, quirks: {} } as ModelInfo;
  const chat = (toChatMessages({ model, system: 'S', messages: history, turnStart: 0 } as ProviderCall) as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'image_url');
  expect(chat.map((c) => c.image_url.detail)).toEqual(['high', undefined]);
});

it('omits pictures with text notes across all four adapters when vision is false, keeping replayed reasoning intact', () => {
  const history: Message[] = [
    {
      id: 'u1',
      role: 'user',
      origin: 'user',
      time: t,
      parts: [
        { type: 'text', text: 'check screenshot' },
        { type: 'image', mediaType: 'image/png', data: 'U0VDUkVU', name: 'spec.png' },
      ],
    },
    {
      id: 'a1',
      role: 'assistant',
      time: t,
      parts: [
        { type: 'reasoning', text: 'claude-think', provider: 'anthropic', model: 'claude-opus-5-5', signature: 'SIG_EXACT' },
        { type: 'reasoning', text: '', provider: 'anthropic', model: 'claude-opus-5-5', redacted: 'RED_EXACT' },
        { type: 'reasoning', text: 'gpt-sum', provider: 'openai', model: 'gpt-6-luna', encrypted: 'ENC_EXACT', itemId: 'rs_exact' },
        { type: 'reasoning', text: 'chat-think', provider: 'chatp', model: 'blind-chat' },
        { type: 'reasoning', text: 'gem-think', provider: 'gemini', model: 'gem-blind', meta: { thoughtSignature: 'TS_EXACT' } },
        { type: 'tool_call', id: 'c1', name: 'browser', input: {}, raw: '{}', meta: { model: 'gem-blind', thoughtSignature: 'TS_CALL' } },
      ],
    },
    {
      id: 'r1',
      role: 'user',
      origin: 'tool',
      time: t,
      parts: [
        {
          type: 'tool_result',
          callId: 'c1',
          name: 'browser',
          content: 'Image page.png is attached.',
          images: [{ type: 'image', mediaType: 'image/png', data: 'UElYRUxT', name: 'page.png' }],
        },
      ],
    },
  ];

  const anth = toAnthropicMessages(history, 'anthropic', false, false) as any[];
  expect(JSON.stringify(anth)).not.toContain('U0VDUkVU');
  expect(JSON.stringify(anth)).not.toContain('UElYRUxT');
  expect(JSON.stringify(anth)).toContain('[image spec.png omitted: this model cannot see images]');
  expect(JSON.stringify(anth)).toContain('(Images were omitted because this model cannot view them.)');
  expect(anth[1].content[0]).toEqual({ type: 'thinking', thinking: 'claude-think', signature: 'SIG_EXACT' });
  expect(anth[1].content[1]).toEqual({ type: 'redacted_thinking', data: 'RED_EXACT' });

  const resp = toResponsesInput(history, 'openai', false) as any[];
  expect(JSON.stringify(resp)).not.toContain('U0VDUkVU');
  expect(JSON.stringify(resp)).not.toContain('UElYRUxT');
  expect(JSON.stringify(resp)).toContain('[image spec.png omitted: this model cannot see images]');
  expect(JSON.stringify(resp)).toContain('(Images were omitted because this model cannot view them.)');
  expect(resp.filter((i) => i.type === 'reasoning')).toEqual([
    { type: 'reasoning', id: 'rs_exact', summary: [{ type: 'summary_text', text: 'gpt-sum' }], encrypted_content: 'ENC_EXACT' },
  ]);

  const chatModel = { id: 'blind-chat', vision: false, quirks: { reasoningEcho: 'all', reasoningField: 'reasoning_content' } } as unknown as ModelInfo;
  const chat = toChatMessages({ model: chatModel, system: 'S', messages: history, turnStart: 0 } as unknown as ProviderCall) as any[];
  expect(JSON.stringify(chat)).not.toContain('U0VDUkVU');
  expect(JSON.stringify(chat)).not.toContain('UElYRUxT');
  expect(JSON.stringify(chat)).toContain('[image spec.png omitted: this model cannot see images]');
  expect(JSON.stringify(chat)).toContain('(Images were omitted because this model cannot view them.)');
  expect(chat.find((m) => m.role === 'assistant').reasoning_content).toContain('chat-think');

  const gem = toGeminiContents(history, 'gem-blind', false) as any[];
  expect(JSON.stringify(gem)).not.toContain('U0VDUkVU');
  expect(JSON.stringify(gem)).not.toContain('UElYRUxT');
  expect(JSON.stringify(gem)).toContain('[image spec.png omitted: this model cannot see images]');
  expect(JSON.stringify(gem)).toContain('(Images were omitted because this model cannot view them.)');
  expect(gem[1].parts[0]).toEqual({ text: 'gem-think', thought: true, thoughtSignature: 'TS_EXACT' });
  expect(gem[1].parts[1].thoughtSignature).toBe('TS_CALL');
});

describe('Anthropic replay', () => {
  const history: Message[] = [
    user('fix it'),
    {
      id: 'a1',
      role: 'assistant',
      time: t,
      parts: [
        { type: 'reasoning', text: 'thinking...', provider: 'anthropic', model: 'claude-opus-5-5', signature: 'SIG1' },
        { type: 'reasoning', text: '', provider: 'anthropic', model: 'claude-opus-5-5', redacted: 'RED' },
        { type: 'reasoning', text: 'from gpt', provider: 'openai', model: 'gpt-6-luna', encrypted: 'ENC' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_call', id: 'call:1', name: 'Read', input: { file_path: 'a.ts' } },
      ],
    },
    {
      id: 'r1',
      role: 'user',
      origin: 'tool',
      time: t,
      parts: [
        { type: 'text', text: '<harness-note>note</harness-note>', synthetic: true },
        { type: 'tool_result', callId: 'call:1', name: 'Read', content: 'body' },
      ],
    },
  ];

  it('replays thinking blocks with their signatures, unchanged and in order', () => {
    const out = toAnthropicMessages(history, 'anthropic') as any[];
    const assistant = out[1].content;
    expect(assistant[0]).toEqual({ type: 'thinking', thinking: 'thinking...', signature: 'SIG1' });
    expect(assistant[1]).toEqual({ type: 'redacted_thinking', data: 'RED' });
    expect(assistant.some((b: any) => b.thinking === 'from gpt')).toBe(false);
    expect(assistant[3]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'Read' });
  });

  it('puts tool results first in the user turn and keeps ids consistent', () => {
    const out = toAnthropicMessages(history, 'anthropic') as any[];
    expect(out[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
    expect(out[2].content[1]).toMatchObject({ type: 'text' });
  });

  it('can strip all thinking for the one-time recovery path', () => {
    const out = toAnthropicMessages(history, 'anthropic', true) as any[];
    expect(out[1].content.some((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking')).toBe(false);
  });
});

describe('several tool calls in one reply', () => {
  const parallel: Message[] = [
    user('look around'),
    {
      id: 'a1',
      role: 'assistant',
      time: t,
      parts: [
        { type: 'reasoning', text: 'both files', provider: 'anthropic', model: 'claude-opus-5-5', signature: 'SIG' },
        { type: 'tool_call', id: 'c1', name: 'Read', input: { file_path: 'a.ts' }, raw: '{"file_path":"a.ts"}' },
        { type: 'tool_call', id: 'c2', name: 'Grep', input: { pattern: 'x' }, raw: '{"pattern":"x"}' },
        { type: 'tool_call', id: 'c3', name: 'Read', input: { file_path: 'b.ts' }, raw: '{"file_path":"b.ts"}' },
      ],
    },
    {
      id: 'r1',
      role: 'user',
      origin: 'tool',
      time: t,
      parts: [
        { type: 'tool_result', callId: 'c1', name: 'Read', content: 'A' },
        { type: 'tool_result', callId: 'c2', name: 'Grep', content: 'G' },
        { type: 'tool_result', callId: 'c3', name: 'Read', content: 'B' },
        { type: 'text', text: '<harness-note>note</harness-note>', synthetic: true },
      ],
    },
  ];

  it('Anthropic: one assistant turn with every tool_use, then one user turn with every result in order', () => {
    const out = toAnthropicMessages(parallel, 'anthropic') as any[];
    expect(out).toHaveLength(3);
    expect(out[1].content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id)).toEqual(['c1', 'c2', 'c3']);
    expect(out[1].content[0]).toEqual({ type: 'thinking', thinking: 'both files', signature: 'SIG' });
    const text = (c: any) => (Array.isArray(c) ? c.map((x: any) => x.text).join('') : c);
    expect(out[2].content.filter((b: any) => b.type === 'tool_result').map((b: any) => [b.tool_use_id, text(b.content)])).toEqual([
      ['c1', 'A'],
      ['c2', 'G'],
      ['c3', 'B'],
    ]);
  });

  it('OpenAI chat (DeepSeek and the like): one assistant message with every tool call, a tool message per result', () => {
    const model = { id: 'deepseek-v4.1-flash', vision: false, quirks: { reasoningEcho: 'turn', reasoningField: 'reasoning_content' }, efforts: ['off', 'high'] } as unknown as ModelInfo;
    const out = toChatMessages({ model, system: 'S', messages: parallel, turnStart: 0 } as unknown as ProviderCall) as any[];
    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant.tool_calls.map((c: any) => [c.id, c.function.name, c.function.arguments])).toEqual([
      ['c1', 'Read', '{"file_path":"a.ts"}'],
      ['c2', 'Grep', '{"pattern":"x"}'],
      ['c3', 'Read', '{"file_path":"b.ts"}'],
    ]);
    expect(out.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content])).toEqual([
      ['c1', 'A'],
      ['c2', 'G'],
      ['c3', 'B'],
    ]);
  });

  it('merges consecutive turns of one role', () => {
    const out = toAnthropicMessages([user('a'), user('b')], 'anthropic') as any[];
    expect(out).toHaveLength(1);
    expect(out[0].content).toHaveLength(2);
  });
});

describe('OpenAI Responses replay', () => {
  const history: Message[] = [
    user('go'),
    {
      id: 'a1',
      role: 'assistant',
      time: t,
      parts: [
        { type: 'reasoning', text: 'summary', provider: 'openai', model: 'gpt-6-luna', encrypted: 'ENC', itemId: 'rs_1' },
        { type: 'reasoning', text: 'claude thought', provider: 'anthropic', model: 'x', signature: 'S' },
        { type: 'text', text: 'Patching.', meta: { itemId: 'msg_1', phase: 'commentary' } },
        { type: 'tool_call', id: 'call_9', name: 'apply_patch', input: { input: '*** Begin Patch' }, raw: '*** Begin Patch', custom: true },
        { type: 'tool_call', id: 'call_10', name: 'shell_command', input: { command: 'ls' }, raw: '{"command":"ls"}' },
      ],
    },
    {
      id: 'r1',
      role: 'user',
      origin: 'tool',
      time: t,
      parts: [
        { type: 'tool_result', callId: 'call_9', name: 'apply_patch', content: 'Success.' },
        { type: 'tool_result', callId: 'call_10', name: 'shell_command', content: 'a.ts' },
      ],
    },
  ];

  it('echoes reasoning items with encrypted content and drops foreign reasoning', () => {
    const items = toResponsesInput(history, 'openai') as any[];
    const reasoning = items.filter((i) => i.type === 'reasoning');
    expect(reasoning).toEqual([{ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'summary' }], encrypted_content: 'ENC' }]);
  });

  it('keeps message phase, custom tool calls and their outputs', () => {
    const items = toResponsesInput(history, 'openai') as any[];
    expect(items.find((i) => i.type === 'message' && i.role === 'assistant')).toMatchObject({ id: 'msg_1', phase: 'commentary' });
    expect(items.find((i) => i.type === 'custom_tool_call')).toMatchObject({ call_id: 'call_9', input: '*** Begin Patch' });
    expect(items.find((i) => i.type === 'custom_tool_call_output')).toMatchObject({ call_id: 'call_9' });
    expect(items.find((i) => i.type === 'function_call_output')).toMatchObject({ call_id: 'call_10', output: 'a.ts' });
  });

  it('builds a stateless request that asks for encrypted reasoning', () => {
    const call = {
      model: { id: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] } as unknown as ModelInfo,
      provider: { id: 'openai' } as ResolvedProvider,
      system: 'S',
      tools: [{ name: 'apply_patch', description: 'd', parameters: {}, freeform: { syntax: 'lark', definition: 'start: x' } }],
      messages: history,
      effort: 'medium',
      maxOutputTokens: 1000,
      sessionId: 'sess',
      turnId: 't',
      turnStart: 0,
      signal: new AbortController().signal,
    } as ProviderCall;
    const body = buildBody(call) as any;
    expect(body.store).toBe(false);
    expect(body.include).toContain('reasoning.encrypted_content');
    // Without a cache key of its own the session's id keeps the prompt cache across its requests.
    expect(body.prompt_cache_key).toBe('sess');
    expect(body.max_output_tokens).toBe(1000);
    expect(body.tools[0]).toMatchObject({ type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark' } });
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(body.tools.some((t: { type: string }) => t.type === 'web_search')).toBe(false);
    const searching = buildBody({ ...call, hostedSearch: true }) as any;
    expect(searching.tools.at(-1)).toEqual({ type: 'web_search' });
    // Copy sites are left out of the hosted search while the provider takes the filter.
    const filtered = buildBody({ ...call, hostedSearch: true, hostedSearchBlocked: ['qastack.com', 'it-swarm.com'] }) as any;
    expect(filtered.tools.at(-1)).toEqual({ type: 'web_search', filters: { blocked_domains: ['qastack.com', 'it-swarm.com'] } });
  });

  it('replays the provider\'s own web search calls as they came', () => {
    const search = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'vite proxy' } };
    const msgs: Message[] = [
      { id: 'u', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'look it up' }], time: 0 },
      { id: 'a', role: 'assistant', parts: [{ type: 'opaque', provider: 'openai', model: 'gpt-6-luna', data: search, label: 'web_search_call' }, { type: 'text', text: 'Found it.' }], time: 0 },
    ];
    const items = toResponsesInput(msgs, 'openai') as any[];
    expect(items).toContainEqual(search);
    expect(toResponsesInput(msgs, 'azure') as any[]).not.toContainEqual(search);
  });
});

describe('Chat Completions reasoning echo', () => {
  const model = (quirks: object) => ({ id: 'm', vision: false, quirks, efforts: ['off', 'high'] }) as unknown as ModelInfo;
  const history: Message[] = [
    user('first'),
    { id: 'a0', role: 'assistant', time: t, parts: [{ type: 'reasoning', text: 'old turn', provider: 'p', model: 'm' }, { type: 'text', text: 'done' }] },
    user('second'),
    {
      id: 'a1',
      role: 'assistant',
      time: t,
      parts: [
        { type: 'reasoning', text: 'this turn', provider: 'p', model: 'm' },
        { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'ls' }, raw: '{"command":"ls"}' },
      ],
    },
    { id: 'r1', role: 'user', origin: 'tool', time: t, parts: [{ type: 'tool_result', callId: 'c1', name: 'Bash', content: 'x' }] },
  ];
  const call = (quirks: object) => ({ model: model(quirks), system: 'S', messages: history, turnStart: 2 }) as unknown as ProviderCall;

  it('"turn" sends back only the current turn\'s reasoning', () => {
    const msgs = toChatMessages(call({ reasoningEcho: 'turn', reasoningField: 'reasoning_content' })) as any[];
    const assistants = msgs.filter((m) => m.role === 'assistant');
    expect(assistants[0].reasoning_content).toBeUndefined();
    expect(assistants[1].reasoning_content).toBe('this turn');
    expect(assistants[1].tool_calls[0]).toMatchObject({ id: 'c1', function: { name: 'Bash' } });
  });

  it('"all" with think tags inlines reasoning into content', () => {
    const msgs = toChatMessages(call({ reasoningEcho: 'all', reasoningField: 'think_tags' })) as any[];
    expect(msgs.find((m) => m.role === 'assistant').content).toBe('<think>\nold turn\n</think>\n\ndone');
  });

  it('"none" sends no reasoning', () => {
    const msgs = toChatMessages(call({ reasoningEcho: 'none' })) as any[];
    expect(msgs.some((m) => m.reasoning_content)).toBe(false);
  });

  it('splits <think> blocks streamed in pieces', () => {
    const s = new ThinkSplitter();
    const parts = ['<thi', 'nk>step one', ' step two</th', 'ink>\n\nAnswer', ' here'].map((d) => s.push(d));
    const end = s.flush();
    expect(parts.map((p) => p.reasoning).join('') + end.reasoning).toBe('step one step two');
    expect(parts.map((p) => p.text).join('') + end.text).toBe('Answer here');
  });

  it('leaves ordinary text that merely mentions think tags alone', () => {
    const s = new ThinkSplitter();
    const a = s.push('Use the <think> tag like this');
    expect(a.text + s.flush().text).toBe('Use the <think> tag like this');
  });
});

describe('Gemini replay', () => {
  const history: Message[] = [
    user('go'),
    {
      id: 'a1',
      role: 'assistant',
      time: t,
      parts: [
        { type: 'reasoning', text: 'plan', provider: 'gemini', model: 'gemini-3.8-flash', meta: { thoughtSignature: 'TS0' } },
        { type: 'tool_call', id: 'gem_1', name: 'Read', input: { file_path: 'a' }, meta: { model: 'gemini-3.8-flash', thoughtSignature: 'TS1' } },
        { type: 'tool_call', id: 'gem_2', name: 'Read', input: { file_path: 'b' }, meta: { model: 'gemini-3.8-flash' } },
        { type: 'text', text: '', meta: { model: 'gemini-3.8-flash', thoughtSignature: 'TS2' } },
      ],
    },
    {
      id: 'r1',
      role: 'user',
      origin: 'tool',
      time: t,
      parts: [
        { type: 'tool_result', callId: 'gem_1', name: 'Read', content: 'A' },
        { type: 'tool_result', callId: 'gem_2', name: 'Read', content: 'B' },
      ],
    },
  ];

  it('returns each part with its own thought signature', () => {
    const contents = toGeminiContents(history, 'gemini-3.8-flash') as any[];
    const model = contents[1].parts;
    expect(model[0]).toEqual({ text: 'plan', thought: true, thoughtSignature: 'TS0' });
    expect(model[1].thoughtSignature).toBe('TS1');
    expect(model[2].thoughtSignature).toBe('skip_thought_signature_validator');
    expect(model[3]).toEqual({ text: '', thoughtSignature: 'TS2' });
    expect(contents[2].parts.map((p: any) => p.functionResponse.name)).toEqual(['Read', 'Read']);
  });

  it('uses the placeholder signature for calls made by another model', () => {
    const contents = toGeminiContents(history, 'gemini-4-argon') as any[];
    const parts = contents[1].parts;
    expect(parts.some((p: any) => p.thought)).toBe(false);
    expect(parts.filter((p: any) => p.functionCall).every((p: any) => p.thoughtSignature === 'skip_thought_signature_validator')).toBe(true);
  });
});

it('strips evicted image bytes via sendable while replaying reasoning signatures and encrypted content untouched across all four adapters', () => {
  const rawHistory: Message[] = [
    {
      id: 'u1',
      role: 'user',
      origin: 'user',
      time: t,
      parts: [
        { type: 'text', text: 'Match this mockup.' },
        { type: 'image', id: 'img-01', mediaType: 'image/png', data: '', stripped: true, name: 'mockup.png' },
        {
          type: 'text',
          text: '[image img-01 (mockup.png) stripped from active context — reopen via read(paths=[".favilla/images/img-01.png"]) (virtual path in read only, not shell)]',
          synthetic: true,
        },
      ],
    },
    {
      id: 'a1',
      role: 'assistant',
      time: t,
      parts: [
        { type: 'reasoning', text: 'anth-thought', provider: 'anthropic', model: 'claude-opus-5-5', signature: 'SIG_STRIP_1' },
        { type: 'reasoning', text: '', provider: 'anthropic', model: 'claude-opus-5-5', redacted: 'RED_STRIP_1' },
        { type: 'reasoning', text: 'resp-summary', provider: 'openai', model: 'gpt-6-luna', encrypted: 'ENC_STRIP_1', itemId: 'rs_strip_1' },
        { type: 'reasoning', text: 'chat-reasoning', provider: 'chatp', model: 'vision-chat' },
        { type: 'reasoning', text: 'gem-thought', provider: 'gemini', model: 'gem-vision', meta: { thoughtSignature: 'TS_STRIP_0' } },
        { type: 'tool_call', id: 'c_shot', name: 'browser', input: { url: 'http://127.0.0.1:5173' }, raw: '{"url":"http://127.0.0.1:5173"}', meta: { model: 'gem-vision', thoughtSignature: 'TS_STRIP_CALL' } },
      ],
    },
    {
      id: 'r1',
      role: 'user',
      origin: 'tool',
      time: t,
      parts: [
        {
          type: 'tool_result',
          callId: 'c_shot',
          name: 'browser',
          content: 'Captured page.\n[1 picture (img-02) let go to save context; reopen via read(paths=[".favilla/images/img-02.png"]).]',
          images: [{ type: 'image', id: 'img-02', mediaType: 'image/png', data: '', stripped: true }, { type: 'image', id: 'img-03', mediaType: 'image/png', data: 'TElWRV9QTkc=' }],
        },
      ],
    },
  ];
  const history = rawHistory.map(sendable);

  const anth = toAnthropicMessages(history, 'anthropic') as any[];
  expect(JSON.stringify(anth)).toContain('.favilla/images/img-01.png');
  expect(JSON.stringify(anth)).toContain('TElWRV9QTkc=');
  expect(anth[0].content.some((b: any) => b.type === 'image')).toBe(false);
  expect(anth[1].content[0]).toEqual({ type: 'thinking', thinking: 'anth-thought', signature: 'SIG_STRIP_1' });
  expect(anth[1].content[1]).toEqual({ type: 'redacted_thinking', data: 'RED_STRIP_1' });

  const resp = toResponsesInput(history, 'openai') as any[];
  expect(JSON.stringify(resp)).toContain('.favilla/images/img-01.png');
  expect(JSON.stringify(resp)).toContain('TElWRV9QTkc=');
  expect(resp.filter((i) => i.type === 'reasoning')).toEqual([
    { type: 'reasoning', id: 'rs_strip_1', summary: [{ type: 'summary_text', text: 'resp-summary' }], encrypted_content: 'ENC_STRIP_1' },
  ]);

  const chatModel = { id: 'vision-chat', vision: true, quirks: { reasoningEcho: 'all', reasoningField: 'reasoning_content' } } as unknown as ModelInfo;
  const chat = toChatMessages({ model: chatModel, system: 'S', messages: history, turnStart: 0 } as unknown as ProviderCall) as any[];
  expect(JSON.stringify(chat)).toContain('.favilla/images/img-01.png');
  expect(JSON.stringify(chat)).toContain('TElWRV9QTkc=');
  expect(chat.find((m) => m.role === 'assistant').reasoning_content).toContain('chat-reasoning');

  const gem = toGeminiContents(history, 'gem-vision') as any[];
  expect(JSON.stringify(gem)).toContain('.favilla/images/img-01.png');
  expect(JSON.stringify(gem)).toContain('TElWRV9QTkc=');
  expect(gem[1].parts[0]).toEqual({ text: 'gem-thought', thought: true, thoughtSignature: 'TS_STRIP_0' });
  expect(gem[1].parts[1].thoughtSignature).toBe('TS_STRIP_CALL');
});
