import type { Effort, Message, Part, ReasoningPart, ToolCallPart, Usage } from '../types';
import { EFFORT_ORDER, emptyUsage } from '../types';
import { http, readSse, errorFromResponse, isContextOverflow } from '../net/http';
import { parseToolArgs } from '../util/json';
import { newId } from '../util/id';
import { ProviderError, networkError } from './errors';
import { dataUrl, imageDetail, plainSchema, USER_AGENT } from './shared';
import type { ProviderAdapter, ProviderCall, ProviderResult, StreamEvent } from './types';

/**
 * OpenAI-compatible Chat Completions: DeepSeek, Qwen, Kimi, GLM, MiniMax, OpenRouter, xAI and
 * local servers (llama.cpp, vLLM, Ollama, LM Studio). Each family stores its reasoning differently
 * and wants it back differently; the model's quirks decide both.
 */
export class OpenAIChatAdapter implements ProviderAdapter {
  async stream(call: ProviderCall, emit: (e: StreamEvent) => void): Promise<ProviderResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': USER_AGENT, ...call.provider.headers };
    const key = call.provider.keys[0];
    if (key) headers.Authorization = `Bearer ${key}`;
    else if (call.provider.auth === 'key') throw new ProviderError('auth', `${call.provider.name}: no API key configured`, { retryable: false });
    let res: Response;
    try {
      res = await http(`${call.provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildChatBody(call)),
        signal: call.signal,
        proxy: call.provider.proxy,
      });
    } catch (e) {
      throw networkError(e, call.provider.name);
    }
    if (!res.ok) throw await errorFromResponse(res, call.provider.name);
    return consume(call, res, emit);
  }
}

export function buildChatBody(call: ProviderCall): Record<string, unknown> {
  const q = call.model.quirks;
  const body: Record<string, unknown> = {
    model: call.model.apiId ?? call.model.id,
    messages: toChatMessages(call),
    stream: true,
  };
  if (q.streamUsage !== false) body.stream_options = { include_usage: true };
  body[q.maxTokensField ?? 'max_tokens'] = call.maxOutputTokens;
  if (call.tools.length) {
    body.tools = call.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.freeform ? { type: 'object', properties: { input: { type: 'string', description: 'The full patch text' } }, required: ['input'] } : plainSchema(t.parameters),
        ...(q.strictTools ? { strict: true } : {}),
      },
    }));
    body.tool_choice = call.toolChoice ?? 'auto';
    body.parallel_tool_calls = true;
  }
  applyThinking(body, call);
  if (call.provider.local) body.cache_prompt = true;
  return body;
}

function applyThinking(body: Record<string, unknown>, call: ProviderCall): void {
  const { quirks, efforts } = call.model;
  if (!efforts.length) return;
  const on = call.effort !== 'off';
  // Levels beyond plain on and off (from the provider, models.dev or the server's own refusal): send the level itself.
  const graded = efforts.filter((e) => e !== 'off').length > 1;
  const level = wireLevel(call.effort, efforts);
  switch (quirks.thinkingParam) {
    case 'deepseek':
    case 'glm':
      body.thinking = { type: on ? 'enabled' : 'disabled' };
      if (on && graded) body.reasoning_effort = level;
      break;
    case 'qwen':
      body.enable_thinking = on;
      break;
    case 'llamacpp':
      body.chat_template_kwargs = { enable_thinking: on };
      break;
    case 'openrouter':
      body.reasoning = on ? { effort: level } : { enabled: false };
      break;
    default:
      // The OpenAI field, which OpenAI-compatible servers and relays take: for 'openai' models always, for the rest
      // when the model is known to have levels.
      if (!graded && quirks.thinkingParam !== 'openai') break;
      if (on) body.reasoning_effort = level;
      else if (efforts.includes('off')) body.reasoning_effort = 'none';
      break;
  }
}

/** The level under the name the wire takes: the one asked for when the model lists it, else the nearest below it. */
function wireLevel(effort: Effort, efforts: Effort[]): string {
  const rank = (e: Effort) => EFFORT_ORDER.indexOf(e);
  const levels: Effort[] = efforts.filter((e) => e !== 'off').sort((a, b) => rank(a) - rank(b));
  const pick = levels.includes(effort) ? effort : (levels.filter((e) => rank(e) <= rank(effort)).pop() ?? levels[0] ?? effort);
  return pick === 'ultra' ? 'max' : pick;
}

/** Transcript to chat messages, echoing reasoning the way the model family expects. */
export function toChatMessages(call: ProviderCall): unknown[] {
  const { quirks } = call.model;
  const echo = quirks.reasoningEcho ?? 'turn';
  const field = quirks.reasoningField ?? 'reasoning_content';
  const out: Record<string, unknown>[] = [{ role: 'system', content: call.system }];

  call.messages.forEach((m, index) => {
    if (m.role === 'user') {
      const content: unknown[] = [];
      const extraImages: unknown[] = [];
      for (const p of m.parts) {
        if (p.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: p.callId, content: p.content || '(no output)' });
          if (p.images?.length && call.model.vision) for (const img of p.images) extraImages.push({ type: 'image_url', image_url: { url: dataUrl(img), ...imageDetail(img) } });
        } else if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
        else if (p.type === 'image') {
          if (call.model.vision) content.push({ type: 'image_url', image_url: { url: dataUrl(p), ...imageDetail(p) } });
          else content.push({ type: 'text', text: `[image ${p.name ?? ''} omitted: this model cannot see images]` });
        }
      }
      if (extraImages.length) content.unshift({ type: 'text', text: 'Images returned by the tool calls above:' }, ...extraImages);
      if (content.length) {
        const onlyText = content.every((c) => (c as { type: string }).type === 'text');
        out.push({ role: m.asSystem ? 'system' : 'user', content: onlyText ? content.map((c) => (c as { text: string }).text).join('\n\n') : content });
      }
      return;
    }

    const msg: Record<string, unknown> = { role: 'assistant' };
    let text = '';
    const reasoning: ReasoningPart[] = [];
    const calls: ToolCallPart[] = [];
    for (const p of m.parts) {
      if (p.type === 'text') text += p.text;
      else if (p.type === 'reasoning') reasoning.push(p);
      else if (p.type === 'tool_call') calls.push(p);
    }
    const sendReasoning = echo === 'all' || (echo === 'turn' && index >= call.turnStart);
    if (sendReasoning && reasoning.length) {
      if (field === 'reasoning_details') {
        const details = reasoning.flatMap((r) => r.details ?? []);
        if (details.length) msg.reasoning_details = details;
      } else {
        const joined = reasoning.map((r) => r.text).filter(Boolean).join('\n\n');
        if (joined) {
          if (field === 'think_tags') text = `<think>\n${joined}\n</think>\n\n${text}`;
          else msg[field] = joined;
        }
      }
    }
    msg.content = text || (calls.length ? null : '');
    if (calls.length) {
      msg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.custom ? JSON.stringify({ input: c.raw ?? '' }) : c.raw || JSON.stringify(c.input ?? {}) },
      }));
    }
    out.push(msg);
  });
  return out;
}

/** Splits `<think>…</think>` at the start of streamed content into reasoning. */
export class ThinkSplitter {
  private mode: 'start' | 'think' | 'text' = 'start';
  private pending = '';

  push(delta: string): { reasoning: string; text: string } {
    let reasoning = '';
    let text = '';
    this.pending += delta;
    while (this.pending) {
      if (this.mode === 'start') {
        const trimmed = this.pending.replace(/^\s+/, '');
        if (!trimmed) return { reasoning, text };
        if ('<think>'.startsWith(trimmed) && trimmed.length < 7) return { reasoning, text };
        if (trimmed.startsWith('<think>')) {
          this.mode = 'think';
          this.pending = trimmed.slice(7);
        } else {
          this.mode = 'text';
        }
      } else if (this.mode === 'think') {
        const end = this.pending.indexOf('</think>');
        if (end >= 0) {
          reasoning += this.pending.slice(0, end);
          this.pending = this.pending.slice(end + 8).replace(/^\s+/, '');
          this.mode = 'text';
        } else {
          const keep = partialSuffix(this.pending, '</think>');
          reasoning += this.pending.slice(0, this.pending.length - keep);
          this.pending = this.pending.slice(this.pending.length - keep);
          return { reasoning, text };
        }
      } else {
        text += this.pending;
        this.pending = '';
      }
    }
    return { reasoning, text };
  }

  flush(): { reasoning: string; text: string } {
    const rest = this.pending;
    this.pending = '';
    return this.mode === 'think' ? { reasoning: rest, text: '' } : { reasoning: '', text: rest };
  }
}

function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(s.length - n))) return n;
  return 0;
}

async function consume(call: ProviderCall, res: Response, emit: (e: StreamEvent) => void): Promise<ProviderResult> {
  const parts: Part[] = [];
  const usage: Usage = emptyUsage();
  let stop: ProviderResult['stop'] = 'end';
  // The server said the reply is over. A connection can also close cleanly halfway through one.
  let ended = false;
  let reasoningIdx = -1;
  let textIdx = -1;
  const toolIdx = new Map<number, number>();
  const details = new Map<number, Record<string, unknown>>();
  const splitter = new ThinkSplitter();

  const addReasoning = (delta: string) => {
    if (!delta) return;
    if (reasoningIdx < 0 || (textIdx > reasoningIdx && parts[textIdx]?.type === 'text')) {
      reasoningIdx = parts.length;
      parts.push({ type: 'reasoning', text: '', provider: call.provider.id, model: call.model.id });
    }
    (parts[reasoningIdx] as ReasoningPart).text += delta;
    emit({ type: 'reasoning', index: reasoningIdx, delta });
  };
  const addText = (delta: string) => {
    if (!delta) return;
    if (textIdx < 0) {
      textIdx = parts.length;
      parts.push({ type: 'text', text: '' });
    }
    (parts[textIdx] as { text: string }).text += delta;
    emit({ type: 'text', index: textIdx, delta });
  };

  try {
    for await (const sse of readSse(res.body!, call.signal, () => emit({ type: 'alive' }))) {
      if (sse.data === '[DONE]') ended = true;
      if (!sse.data || sse.data === '[DONE]') continue;
      let chunk: any;
      try {
        chunk = JSON.parse(sse.data);
      } catch {
        continue;
      }
      if (chunk.error) {
        const msg = `${call.provider.name}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`;
        throw new ProviderError(isContextOverflow(msg) ? 'context_overflow' : 'server', msg);
      }
      if (chunk.usage) readUsage(usage, chunk.usage);
      if (chunk.timings) {
        if (chunk.timings.cache_n != null) usage.cacheRead = chunk.timings.cache_n;
        emit({ type: 'meta', key: 'timings', value: chunk.timings });
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? choice.message ?? {};
      const r = d.reasoning_content ?? d.reasoning ?? (typeof d.thinking === 'string' ? d.thinking : undefined);
      if (typeof r === 'string') addReasoning(r);
      if (Array.isArray(d.reasoning_details)) {
        for (const frag of d.reasoning_details) {
          const i = typeof frag.index === 'number' ? frag.index : details.size;
          const cur = details.get(i);
          if (!cur) details.set(i, { ...frag });
          else for (const k of ['text', 'summary', 'data'] as const) if (typeof frag[k] === 'string') cur[k] = String(cur[k] ?? '') + frag[k];
          if (cur && frag.signature) cur.signature = frag.signature;
          const visible = frag.text ?? frag.summary;
          if (typeof visible === 'string' && r === undefined) addReasoning(visible);
        }
      }
      if (typeof d.content === 'string' && d.content) {
        const split = splitter.push(d.content);
        addReasoning(split.reasoning);
        addText(split.text);
      }
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : toolIdx.size;
        let idx = toolIdx.get(i);
        if (idx === undefined) {
          idx = parts.length;
          toolIdx.set(i, idx);
          parts.push({ type: 'tool_call', id: tc.id || `call_${newId()}`, name: tc.function?.name ?? '', input: {}, raw: '' });
        }
        const part = parts[idx] as ToolCallPart;
        if (tc.id && !part.raw) part.id = tc.id;
        if (tc.function?.name && !part.name) part.name = tc.function.name;
        const argDelta = typeof tc.function?.arguments === 'string' ? tc.function.arguments : tc.function?.arguments ? JSON.stringify(tc.function.arguments) : '';
        part.raw += argDelta;
        emit({ type: 'tool', index: idx, id: part.id, name: part.name, delta: argDelta });
      }
      if (choice.finish_reason) {
        ended = true;
        const f = choice.finish_reason;
        stop = f === 'length' ? 'max_tokens' : f === 'content_filter' ? 'refusal' : f === 'tool_calls' || f === 'function_call' ? 'tool_use' : 'end';
      }
    }
    if (!ended) throw new ProviderError('network', `${call.provider.name}: the connection closed before the reply ended.`);
  } catch (e) {
    if (call.signal.aborted) return { parts: finish(call, parts, details, splitter), usage, stop: 'aborted' };
    if (e instanceof ProviderError) throw e;
    throw networkError(e, call.provider.name);
  }
  const kept = finish(call, parts, details, splitter);
  if (stop !== 'max_tokens' && stop !== 'refusal') stop = kept.some((p) => p.type === 'tool_call') ? 'tool_use' : 'end';
  return { parts: kept, usage, stop };
}

function finish(call: ProviderCall, parts: Part[], details: Map<number, Record<string, unknown>>, splitter: ThinkSplitter): Part[] {
  const rest = splitter.flush();
  if (rest.text) {
    const t = parts.find((p) => p.type === 'text') as { text: string } | undefined;
    if (t) t.text += rest.text;
    else parts.push({ type: 'text', text: rest.text });
  }
  if (details.size) {
    const arr = [...details.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    let r = parts.find((p) => p.type === 'reasoning') as ReasoningPart | undefined;
    // Opaque details with no readable text are still the reasoning, and the next request needs them back.
    if (!r) parts.unshift((r = { type: 'reasoning', text: '', provider: call.provider.id, model: call.model.id }));
    r.details = arr;
  }
  for (const p of parts) {
    if (p.type !== 'tool_call') continue;
    const parsed = parseToolArgs(p.raw ?? '');
    p.input = parsed.value;
    if (parsed.error) p.parseError = parsed.error;
    if (parsed.cut) p.cut = parsed.cut;
    if (!p.name) p.parseError = 'Tool call without a name';
  }
  return parts.filter((p) => (p.type === 'text' ? p.text.trim().length > 0 : p.type === 'reasoning' ? !!(p.text || p.details) : true));
}

function readUsage(usage: Usage, u: any): void {
  usage.input = u.prompt_tokens ?? usage.input;
  usage.output = u.completion_tokens ?? usage.output;
  usage.cacheRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? usage.cacheRead;
  usage.reasoning = u.completion_tokens_details?.reasoning_tokens ?? usage.reasoning;
}

export type { Message };
