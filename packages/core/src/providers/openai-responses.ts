import { debug } from '../util/log';
import type { Message, Part, ReasoningPart, ToolCallPart, Usage } from '../types';
import { emptyUsage } from '../types';
import { http, readSse, errorFromResponse, errorFromStatus, isContextOverflow } from '../net/http';
import { parseToolArgs } from '../util/json';
import { ProviderError, networkError } from './errors';
import { dataUrl, imageDetail, USER_AGENT } from './shared';
import type { ProviderAdapter, ProviderCall, ProviderResult, StreamEvent, ToolSpec } from './types';

/**
 * OpenAI Responses API, with an API key.
 * Runs stateless (store: false) and replays reasoning items with their encrypted content,
 * so the model keeps its chain of thought across tool calls without server-side storage.
 */
export class OpenAIResponsesAdapter implements ProviderAdapter {
  async stream(call: ProviderCall, emit: (e: StreamEvent) => void): Promise<ProviderResult> {
    const key = call.provider.keys[0];
    if (!key) throw new ProviderError('auth', `${call.provider.name}: no API key configured`, { retryable: false });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': USER_AGENT,
      ...call.provider.headers,
      Authorization: `Bearer ${key}`,
    };
    let res: Response;
    try {
      res = await http(`${call.provider.baseUrl}/responses`, { method: 'POST', headers, body: JSON.stringify(buildBody(call)), signal: call.signal, proxy: call.provider.proxy });
    } catch (e) {
      throw networkError(e, call.provider.name);
    }
    if (!res.ok) throw await errorFromResponse(res, call.provider.name);
    const result = await this.consume(call, res, emit);
    debug('responses', 'http usage', { channel: call.channel, input: result.usage.input, cached: result.usage.cacheRead });
    return result;
  }

  private async consume(call: ProviderCall, res: Response, emit: (e: StreamEvent) => void): Promise<ProviderResult> {
    async function* events(): AsyncGenerator<any> {
      for await (const sse of readSse(res.body!, call.signal, () => emit({ type: 'alive' }))) {
        if (!sse.data || sse.data === '[DONE]') continue;
        try {
          yield JSON.parse(sse.data);
        } catch {
          continue;
        }
      }
    }
    return this.consumeEvents(call, events(), emit);
  }

  /** Response events to parts, streamed to `emit` as they come. */
  private async consumeEvents(call: ProviderCall, events: AsyncIterable<any>, emit: (e: StreamEvent) => void): Promise<ProviderResult> {
    const parts: Part[] = [];
    const byOutput = new Map<number, number>();
    // The text each part has shown so far, its search marks left out (withoutMarks).
    const shown = new Map<number, string>();
    const usage: Usage = emptyUsage();
    let stop: ProviderResult['stop'] = 'end';
    let refusal: string | undefined;
    const partFor = (outputIndex: number): Part | undefined => {
      const i = byOutput.get(outputIndex);
      return i === undefined ? undefined : parts[i];
    };

    try {
      // The server said the reply is over. A connection can also close cleanly halfway through one.
      let ended = false;
      for await (const ev of events) {
        switch (ev.type) {
          case 'response.output_item.added': {
            const item = ev.item;
            const idx = parts.length;
            byOutput.set(ev.output_index, idx);
            if (item.type === 'reasoning') parts.push({ type: 'reasoning', text: '', provider: call.provider.id, model: call.model.id, itemId: item.id });
            else if (item.type === 'message') parts.push({ type: 'text', text: '', meta: { itemId: item.id, phase: item.phase } });
            else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
              parts.push({ type: 'tool_call', id: item.call_id, name: item.name, input: {}, raw: '', custom: item.type === 'custom_tool_call', meta: { itemId: item.id } });
              emit({ type: 'tool', index: idx, id: item.call_id, name: item.name, delta: '' });
            } else parts.push({ type: 'opaque', provider: call.provider.id, model: call.model.id, data: item, label: item.type });
            break;
          }
          case 'response.output_text.delta': {
            const p = partFor(ev.output_index);
            if (p?.type === 'text') {
              p.text += ev.delta;
              const index = byOutput.get(ev.output_index)!;
              const before = shown.get(index) ?? '';
              const now = shownSoFar(p.text);
              shown.set(index, now);
              if (now.length > before.length && now.startsWith(before)) emit({ type: 'text', index, delta: now.slice(before.length) });
            }
            break;
          }
          case 'response.refusal.delta': {
            refusal = (refusal ?? '') + ev.delta;
            break;
          }
          case 'response.reasoning_summary_part.added': {
            const p = partFor(ev.output_index);
            if (p?.type === 'reasoning' && p.text) {
              p.text += '\n\n';
              emit({ type: 'reasoning', index: byOutput.get(ev.output_index)!, delta: '\n\n' });
            }
            break;
          }
          case 'response.reasoning_summary_text.delta':
          case 'response.reasoning_text.delta': {
            const p = partFor(ev.output_index);
            if (p?.type === 'reasoning') {
              p.text += ev.delta;
              emit({ type: 'reasoning', index: byOutput.get(ev.output_index)!, delta: ev.delta });
            }
            break;
          }
          case 'response.function_call_arguments.delta':
          case 'response.custom_tool_call_input.delta': {
            const p = partFor(ev.output_index);
            if (p?.type === 'tool_call') {
              p.raw = (p.raw ?? '') + ev.delta;
              emit({ type: 'tool', index: byOutput.get(ev.output_index)!, id: p.id, name: p.name, delta: ev.delta });
            }
            break;
          }
          case 'response.output_item.done': {
            const idx = byOutput.get(ev.output_index);
            const item = ev.item;
            if (idx === undefined) break;
            parts[idx] = finishItem(parts[idx], item, call);
            break;
          }
          case 'response.completed':
          case 'response.incomplete': {
            ended = true;
            const r = ev.response ?? {};
            readUsage(usage, r.usage);
            const reason = r.incomplete_details?.reason;
            if (ev.type === 'response.incomplete') stop = reason === 'content_filter' ? 'refusal' : 'max_tokens';
            break;
          }
          case 'response.failed': {
            const err = ev.response?.error ?? {};
            throw failure(err.code, err.message, call);
          }
          case 'error': {
            throw failure(ev.code ?? ev.error?.code, ev.message ?? ev.error?.message, call);
          }
        }
      }
      if (!ended) throw new ProviderError('network', `${call.provider.name}: the connection closed before the reply ended.`);
    } catch (e) {
      if (call.signal.aborted) return { parts: clean(parts), usage, stop: 'aborted' };
      if (e instanceof ProviderError) throw e;
      throw networkError(e, call.provider.name);
    }
    const kept = clean(parts);
    if (refusal && !kept.some((p) => p.type === 'text')) stop = 'refusal';
    if (stop === 'end' && kept.some((p) => p.type === 'tool_call')) stop = 'tool_use';
    return { parts: kept, usage, stop, refusal };
  }
}

function finishItem(part: Part, item: any, call: ProviderCall): Part {
  if (item.type === 'reasoning' && part.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.map((s: any) => s.text).join('\n\n') : '';
    return { ...part, text: part.text || summary, encrypted: item.encrypted_content ?? undefined, itemId: item.id };
  }
  if (item.type === 'message' && part.type === 'text') {
    const text = withoutMarks((item.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join(''));
    return { ...part, text: text || part.text, meta: { ...part.meta, itemId: item.id, phase: item.phase } };
  }
  if ((item.type === 'function_call' || item.type === 'custom_tool_call') && part.type === 'tool_call') {
    const raw = item.type === 'function_call' ? (item.arguments ?? part.raw ?? '') : (item.input ?? part.raw ?? '');
    const done: ToolCallPart = { ...part, id: item.call_id ?? part.id, name: item.name ?? part.name, raw };
    if (item.type === 'function_call') {
      const parsed = parseToolArgs(raw);
      done.input = parsed.value;
      if (parsed.error) done.parseError = parsed.error;
      if (parsed.cut) done.cut = parsed.cut;
    } else {
      done.input = { input: raw };
    }
    return done;
  }
  if (part.type === 'opaque') return { ...part, data: item };
  return part;
}

/**
 * OpenAI hosted search can leave its marks in the answer text: "citeturn0search0" for a
 * citation, and entity, navlist, image_group and others, which only OpenAI's own pages turn into chips. Shown as they
 * are they read "citeturn576729search0turn272430search0" (2026-11-03). An entity mark keeps its name; the others go,
 * with the space before them unless the text has already been shown with it.
 */
const MARK = /(\s?)([a-z_]+)([^]*)/g;
/** A citation whose private-use characters were lost on the way. */
const BARE_CITE = /\s?cite(?:turn\d+[a-z_]+\d+)+/g;

export function withoutMarks(text: string, keepSpace = false): string {
  if (!text.includes('') && !text.includes('citeturn')) return text;
  const marked = text.replace(MARK, (_all, space: string, kind: string, body: string) => {
    const kept = keepSpace ? space : '';
    if (kind !== 'entity') return kept;
    try {
      const name = JSON.parse(body)[1];
      return typeof name === 'string' ? `${space}${name}` : kept;
    } catch {
      return kept;
    }
  });
  return keepSpace ? marked : marked.replace(BARE_CITE, '');
}

/** What a stream may show of its text so far: a mark still open at the end waits for its close. */
function shownSoFar(text: string): string {
  const open = text.lastIndexOf('');
  return withoutMarks(open >= 0 && text.indexOf('', open) < 0 ? text.slice(0, open) : text, true);
}

function clean(parts: Part[]): Part[] {
  return parts.filter((p) => {
    if (p.type === 'text') p.text = withoutMarks(p.text);
    if (p.type === 'text') return p.text.length > 0;
    if (p.type === 'reasoning') return !!(p.encrypted || p.text);
    return true;
  });
}

function readUsage(usage: Usage, u: any): void {
  if (!u) return;
  usage.input = u.input_tokens ?? 0;
  usage.cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
  usage.cacheWrite = u.input_tokens_details?.cache_write_tokens ?? 0;
  usage.output = u.output_tokens ?? 0;
  usage.reasoning = u.output_tokens_details?.reasoning_tokens ?? 0;
}

function failure(code: string | undefined, message: string | undefined, call: ProviderCall): ProviderError {
  const msg = `${call.provider.name}: ${message ?? code ?? 'request failed'}`;
  if (code === 'context_length_exceeded' || isContextOverflow(msg)) return new ProviderError('context_overflow', msg);
  if (code === 'rate_limit_exceeded') return new ProviderError('rate_limit', msg);
  if (code === 'insufficient_quota' || code === 'usage_limit_reached') return new ProviderError('quota', msg, { retryable: false });
  if (code === 'server_error' || code === 'overloaded') return new ProviderError('server', msg);
  if (code === 'invalid_prompt' || code === 'invalid_request_error') return new ProviderError('invalid_request', msg);
  return new ProviderError('server', msg);
}

function mapEffort(call: ProviderCall): string | undefined {
  const e = call.effort;
  if (e === 'off') return call.model.efforts.includes('off') ? 'none' : undefined;
  if (e === 'ultra') return 'max';
  return e;
}

export function buildBody(call: ProviderCall): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: call.model.id,
    instructions: call.system,
    input: toResponsesInput(call.messages, call.provider.id, call.model.vision),
    tools: [...call.tools.map(toResponsesTool), ...(call.hostedSearch ? [{ type: 'web_search', ...(call.hostedSearchBlocked?.length ? { filters: { blocked_domains: call.hostedSearchBlocked } } : {}) }] : [])],
    tool_choice: call.toolChoice ?? 'auto',
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    // One key per session: every request of a conversation lands on the same cache.
    prompt_cache_key: call.cacheKey ?? call.sessionId,
  };
  const effort = mapEffort(call);
  if (effort && call.model.efforts.length) body.reasoning = { effort, summary: 'auto' };
  const verbosity = call.options?.verbosity;
  if (verbosity) body.text = { verbosity };
  body.max_output_tokens = call.maxOutputTokens;
  return body;
}

function toResponsesTool(t: ToolSpec): unknown {
  if (t.freeform) {
    return { type: 'custom', name: t.name, description: t.description, format: { type: 'grammar', syntax: t.freeform.syntax, definition: t.freeform.definition } };
  }
  return { type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false };
}

/** Transcript to Responses input items, replaying this provider's reasoning items verbatim. */
export function toResponsesInput(messages: Message[], providerId: string, vision = true): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const userContent: unknown[] = [];
      const followImages: unknown[] = [];
      for (const p of m.parts) {
        if (p.type === 'tool_result') {
          const custom = isCustomCall(messages, p.callId);
          const hasImg = p.images?.some((img) => img.data);
          const note = hasImg && !vision && !/cannot (?:view|see) (?:them|images)/i.test(p.content) ? '\n(Images were omitted because this model cannot view them.)' : '';
          items.push({ type: custom ? 'custom_tool_call_output' : 'function_call_output', call_id: p.callId, output: `${p.content || '(no output)'}${note}` });
          if (vision) for (const img of p.images ?? []) followImages.push({ type: 'input_image', image_url: dataUrl(img), ...imageDetail(img) });
        } else if (p.type === 'text' && p.text) userContent.push({ type: 'input_text', text: p.text });
        else if (p.type === 'image') {
          if (vision) userContent.push({ type: 'input_image', image_url: dataUrl(p), ...imageDetail(p) });
          else userContent.push({ type: 'input_text', text: `[image${p.name ? ` ${p.name}` : ''} omitted: this model cannot see images]` });
        }
      }
      if (followImages.length) userContent.unshift({ type: 'input_text', text: 'Images returned by the tool calls above:' }, ...followImages);
      if (userContent.length) items.push({ type: 'message', role: m.asSystem ? 'developer' : 'user', content: userContent });
      continue;
    }
    for (const p of m.parts) {
      if (p.type === 'reasoning') {
        if (p.provider !== providerId || !p.encrypted) continue;
        items.push({
          type: 'reasoning',
          ...(p.itemId ? { id: p.itemId } : {}),
          summary: p.text ? [{ type: 'summary_text', text: p.text }] : [],
          encrypted_content: p.encrypted,
        });
      } else if (p.type === 'text' && p.text) {
        const meta = p.meta ?? {};
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: p.text }],
          ...(typeof meta.itemId === 'string' ? { id: meta.itemId } : {}),
          ...(meta.phase ? { phase: meta.phase } : {}),
        });
      } else if (p.type === 'tool_call') {
        const itemId = typeof p.meta?.itemId === 'string' ? p.meta.itemId : undefined;
        if (p.custom) items.push({ type: 'custom_tool_call', call_id: p.id, name: p.name, input: p.raw ?? String(p.input.input ?? ''), ...(itemId ? { id: itemId } : {}) });
        else items.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: p.raw || JSON.stringify(p.input ?? {}), ...(itemId ? { id: itemId } : {}) });
      } else if (p.type === 'opaque' && p.provider === providerId) {
        items.push(p.data);
      }
    }
  }
  return items;
}

function isCustomCall(messages: Message[], callId: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const p of messages[i].parts) if (p.type === 'tool_call' && p.id === callId) return !!p.custom;
  }
  return false;
}

export type { ReasoningPart };
