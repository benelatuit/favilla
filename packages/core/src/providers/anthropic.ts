import type Anthropic from '@anthropic-ai/sdk';
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk/error';
import type { Message, Part, ReasoningPart, ToolCallPart, Usage } from '../types';
import { emptyUsage } from '../types';
import { proxiedFetch, errorFromStatus, classifyStreamError } from '../net/http';
import { parseToolArgs } from '../util/json';
import { ProviderError, networkError } from './errors';
import { safeToolId } from './shared';
import type { ProviderAdapter, ProviderCall, ProviderResult, StreamEvent } from './types';

/**
 * Claude through the Messages API. The request is append-only by construction: system and tools are
 * frozen per session and history is replayed exactly, thinking blocks and their signatures included,
 * which keeps prompt caching warm and preserved thinking valid.
 */
export class AnthropicAdapter implements ProviderAdapter {
  private clients = new Map<string, Anthropic>();

  private async client(call: ProviderCall, key: string | undefined): Promise<Anthropic> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { id, baseUrl, proxy, headers } = call.provider;
    const cacheKey = JSON.stringify([id, key, baseUrl, proxy, headers]);
    let c = this.clients.get(cacheKey);
    if (!c) {
      c = new Anthropic({
        ...(key ? { apiKey: key } : {}),
        baseURL: call.provider.baseUrl || undefined,
        fetch: proxiedFetch(call.provider.proxy),
        maxRetries: 0,
        timeout: 20 * 60_000,
        defaultHeaders: call.provider.headers,
      });
      this.clients.set(cacheKey, c);
    }
    return c;
  }

  async stream(call: ProviderCall, emit: (e: StreamEvent) => void): Promise<ProviderResult> {
    try {
      return await this.run(call, emit, false);
    } catch (e) {
      // Preserved-thinking mismatch (history changed under a signed block): retry once without thinking.
      if (e instanceof ProviderError && e.kind === 'invalid_request' && /signature/i.test(e.message) && /thinking/i.test(e.message)) {
        return this.run(call, emit, true);
      }
      throw e;
    }
  }

  private async run(call: ProviderCall, emit: (e: StreamEvent) => void, stripThinking: boolean): Promise<ProviderResult> {
    const { model } = call;
    const key = call.provider.keys[0];
    const client = await this.client(call, key);
    const betas: string[] = [];
    const body: Record<string, unknown> = {
      model: model.id,
      max_tokens: call.maxOutputTokens,
      system: [{ type: 'text', text: call.system, ...(call.system ? { cache_control: { type: 'ephemeral' } } : {}) }],
      messages: toAnthropicMessages(call.messages, call.provider.id, stripThinking, model.vision),
      cache_control: { type: 'ephemeral' },
    };
    if (call.tools.length) {
      body.tools = call.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        eager_input_streaming: true,
      }));
      body.tool_choice = { type: call.toolChoice ?? 'auto' };
    }
    if (call.hostedSearch) body.tools = [...((body.tools as unknown[]) ?? []), { type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];
    const toolList = body.tools as Record<string, unknown>[] | undefined;
    if (toolList?.length) toolList[toolList.length - 1].cache_control = { type: 'ephemeral' };
    applyThinking(body, call);
    if (/claude-(fable-5-1|opus-5-5|opus-5$|sonnet-5-5)/.test(model.id) && call.provider.baseUrl.includes('api.anthropic.com')) {
      body.fallbacks = 'default';
      betas.push('server-side-fallback-2026-07-01');
    }

    const parts: Part[] = [];
    const usage: Usage = emptyUsage();
    let stop: ProviderResult['stop'] = 'end';
    let refusal: string | undefined;
    const blockIndex = new Map<number, number>();

    try {
      const stream = client.beta.messages.stream({ ...(body as any), ...(betas.length ? { betas } : {}) }, { signal: call.signal });
      // The server said the reply is over. A connection can also close cleanly halfway through one.
      let ended = false;
      for await (const ev of stream as AsyncIterable<any>) {
        // Any event, pings and thinking out of sight included, shows the stream is open.
        emit({ type: 'alive' });
        switch (ev.type) {
          case 'message_start': {
            const u = ev.message?.usage ?? {};
            usage.cacheRead = u.cache_read_input_tokens ?? 0;
            usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
            usage.input = (u.input_tokens ?? 0) + usage.cacheRead + usage.cacheWrite;
            break;
          }
          case 'content_block_start': {
            const b = ev.content_block;
            const idx = parts.length;
            blockIndex.set(ev.index, idx);
            if (b.type === 'text') parts.push({ type: 'text', text: b.text ?? '' });
            else if (b.type === 'thinking') parts.push(reasoning(call, b.thinking ?? '', b.signature));
            else if (b.type === 'redacted_thinking') parts.push({ ...reasoning(call, ''), redacted: b.data });
            else if (b.type === 'tool_use') {
              parts.push({ type: 'tool_call', id: b.id, name: b.name, input: {}, raw: '' });
              emit({ type: 'tool', index: idx, id: b.id, name: b.name, delta: '' });
            } else parts.push({ type: 'opaque', provider: call.provider.id, model: model.id, data: b, label: b.type });
            break;
          }
          case 'content_block_delta': {
            const idx = blockIndex.get(ev.index);
            if (idx === undefined) break;
            const part = parts[idx];
            const d = ev.delta;
            if (d.type === 'text_delta' && part.type === 'text') {
              part.text += d.text;
              emit({ type: 'text', index: idx, delta: d.text });
            } else if (d.type === 'thinking_delta' && part.type === 'reasoning') {
              part.text += d.thinking;
              emit({ type: 'reasoning', index: idx, delta: d.thinking });
            } else if (d.type === 'signature_delta' && part.type === 'reasoning') {
              part.signature = (part.signature ?? '') + d.signature;
            } else if (d.type === 'input_json_delta' && part.type === 'tool_call') {
              part.raw = (part.raw ?? '') + d.partial_json;
              emit({ type: 'tool', index: idx, id: part.id, name: part.name, delta: d.partial_json });
            }
            break;
          }
          case 'content_block_stop': {
            const idx = blockIndex.get(ev.index);
            const part = idx === undefined ? undefined : parts[idx];
            if (part?.type === 'tool_call') finishToolCall(part);
            break;
          }
          case 'error':
            throw streamError(ev, call.provider.id);
          case 'message_delta': {
            const u = ev.usage ?? {};
            if (u.output_tokens != null) usage.output = u.output_tokens;
            if (u.input_tokens != null || u.cache_read_input_tokens != null) {
              usage.cacheRead = u.cache_read_input_tokens ?? usage.cacheRead;
              usage.cacheWrite = u.cache_creation_input_tokens ?? usage.cacheWrite;
              usage.input = (u.input_tokens ?? usage.input - usage.cacheRead - usage.cacheWrite) + usage.cacheRead + usage.cacheWrite;
            }
            const reason = ev.delta?.stop_reason;
            if (reason) ended = true;
            if (reason === 'tool_use') stop = 'tool_use';
            else if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') stop = 'max_tokens';
            else if (reason === 'refusal') {
              stop = 'refusal';
              refusal = ev.delta?.stop_details?.explanation ?? ev.delta?.stop_details?.category ?? 'The model declined this request.';
            } else if (reason === 'pause_turn') stop = 'pause';
            else if (reason) stop = 'end';
            break;
          }
        }
      }
      if (!ended) throw new ProviderError('network', `${call.provider.name}: the connection closed before the reply ended.`);
    } catch (e) {
      if (call.signal.aborted) return finalize(parts, usage, 'aborted');
      throw mapError(e, call.provider.id);
    }
    return { ...finalize(parts, usage, stop), refusal };
  }
}

function reasoning(call: ProviderCall, text: string, signature?: string): ReasoningPart {
  return { type: 'reasoning', text, provider: call.provider.id, model: call.model.id, signature: signature || undefined };
}

function finishToolCall(part: ToolCallPart): void {
  const parsed = parseToolArgs(part.raw ?? '');
  part.input = parsed.value;
  if (parsed.error) part.parseError = parsed.error;
  if (parsed.cut) part.cut = parsed.cut;
}

function finalize(parts: Part[], usage: Usage, stop: ProviderResult['stop']): ProviderResult {
  const kept = parts.filter((p) => {
    if (p.type === 'reasoning') return !!(p.signature || p.redacted);
    if (p.type === 'text') return p.text.length > 0;
    return true;
  });
  for (const p of kept) if (p.type === 'tool_call' && p.raw !== undefined && !Object.keys(p.input).length && p.raw) finishToolCall(p);
  if (stop === 'end' && kept.some((p) => p.type === 'tool_call')) stop = 'tool_use';
  return { parts: kept, usage, stop };
}

/** Whether a request at this effort thinks; one that does cannot continue from a prefill. */
export function thinksAt(model: ProviderCall['model'], effort: ProviderCall['effort']): boolean {
  return effort !== 'off' || ((model.quirks.anthropicThinking ?? 'adaptive') !== 'budget' && !model.efforts.includes('off'));
}

function applyThinking(body: Record<string, unknown>, call: ProviderCall): void {
  const { model, effort } = call;
  const style = model.quirks.anthropicThinking ?? 'adaptive';
  if (style === 'budget') {
    if (effort === 'off') return;
    const budget = { minimal: 2048, low: 4096, medium: 10_000, high: 24_000, xhigh: 32_000, max: 48_000, ultra: 48_000, off: 0 }[effort];
    const maxTokens = Math.max(call.maxOutputTokens, budget + 8192);
    body.max_tokens = Math.min(maxTokens, model.maxOutput);
    body.thinking = { type: 'enabled', budget_tokens: Math.min(budget, (body.max_tokens as number) - 4096) };
    return;
  }
  if (effort === 'off' && model.efforts.includes('off')) {
    body.thinking = { type: 'disabled' };
    return;
  }
  const level = effort === 'off' || effort === 'minimal' ? 'low' : effort === 'ultra' ? 'max' : effort;
  body.thinking = { type: 'adaptive', display: model.thinkingDisplay ?? 'summarized' };
  body.output_config = { effort: level };
}

/** Convert the transcript to Messages API turns. Reasoning from other providers cannot be replayed and is left out. */
export function toAnthropicMessages(messages: Message[], providerId: string, stripThinking = false, vision = true): unknown[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  let afterPreset = false;
  for (const m of messages) {
    const content: unknown[] = [];
    if (m.role === 'user') {
      const results = m.parts.filter((p) => p.type === 'tool_result');
      const rest = m.parts.filter((p) => p.type !== 'tool_result');
      for (const p of results) {
        if (p.type !== 'tool_result') continue;
        const hasImg = p.images?.some((img) => img.data);
        const note = hasImg && !vision && !/cannot (?:view|see) (?:them|images)/i.test(p.content) ? '\n(Images were omitted because this model cannot view them.)' : '';
        const blocks: unknown[] = [{ type: 'text', text: `${p.content || '(no output)'}${note}` }];
        if (vision) for (const img of p.images ?? []) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
        content.push({ type: 'tool_result', tool_use_id: safeToolId(p.callId), content: blocks, ...(p.isError ? { is_error: true } : {}) });
      }
      for (const p of rest) {
        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
        else if (p.type === 'image') {
          if (vision) content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
          else content.push({ type: 'text', text: `[image${p.name ? ` ${p.name}` : ''} omitted: this model cannot see images]` });
        }
      }
    } else {
      for (const p of m.parts) {
        if (p.type === 'reasoning') {
          if (stripThinking || p.provider !== providerId) continue;
          if (p.redacted) content.push({ type: 'redacted_thinking', data: p.redacted });
          else if (p.signature) content.push({ type: 'thinking', thinking: p.text, signature: p.signature });
        } else if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
        else if (p.type === 'tool_call') content.push({ type: 'tool_use', id: safeToolId(p.id), name: p.name, input: p.input ?? {} });
        else if (p.type === 'opaque' && p.provider === providerId) content.push(p.data);
      }
    }
    if (!content.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      // A preset's assistant prompt ahead of a reply: the reply's thinking still has to open the turn.
      const thinks = (c: unknown) => /thinking$/.test((c as { type: string }).type);
      if (afterPreset && m.role === 'assistant') prev.content.unshift(...content.filter(thinks));
      prev.content.push(...(afterPreset && m.role === 'assistant' ? content.filter((c) => !thinks(c)) : content));
    } else out.push({ role: m.role, content });
    afterPreset = m.role === 'assistant' && m.origin === 'harness';
  }
  return out;
}

function streamError(raw: unknown, provider: string, fallback = 'stream error', headerRetryMs?: number, apiType?: string | null): ProviderError {
  const inner = typeof raw === 'object' && raw !== null ? ((raw as any).error ?? raw) : raw;
  const detail = typeof inner === 'string' ? inner : (inner?.message ?? (raw as any)?.message ?? fallback);
  const code = (typeof inner === 'object' && inner !== null ? (inner.type ?? inner.code ?? (raw as any)?.code) : undefined) ?? apiType ?? undefined;
  const codeStr = code != null ? String(code) : undefined;
  const text = typeof raw === 'string' ? raw : `${detail}\n${JSON.stringify(raw ?? '')}`;
  const classified = classifyStreamError(text, codeStr);
  const kind =
    classified.kind !== 'server'
      ? classified.kind
      : codeStr === 'authentication_error' || codeStr === 'permission_error'
        ? 'auth'
        : codeStr === 'invalid_request_error'
          ? 'invalid_request'
          : 'server';
  return new ProviderError(kind, `${provider}: ${detail}`, { retryAfterMs: headerRetryMs ?? classified.retryAfterMs });
}

function mapError(e: unknown, provider: string): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof APIUserAbortError) return new ProviderError('aborted', 'Aborted', { retryable: false });
  if (e instanceof APIConnectionError) return networkError(e, provider);
  if (e instanceof APIError) {
    const ra = Number((e.headers as any)?.get?.('retry-after'));
    const raMs = Number((e.headers as any)?.get?.('retry-after-ms'));
    const retryAfterMs = Number.isFinite(raMs) && raMs > 0 ? raMs : Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
    if (!e.status || e.status === 200) return streamError(e.error, provider, e.message, retryAfterMs, (e as any).type);
    return errorFromStatus(e.status, e.headers ?? new Headers(), e.error ? JSON.stringify(e.error) : e.message, provider);
  }
  return networkError(e, provider);
}
