import type { Message, Part, ToolCallPart, Usage } from '../types';
import { emptyUsage } from '../types';
import { http, readSse, errorFromResponse, classifyStreamError } from '../net/http';
import { newId } from '../util/id';
import { ProviderError, networkError } from './errors';
import { toGeminiSchema, USER_AGENT } from './shared';
import type { ProviderAdapter, ProviderCall, ProviderResult, StreamEvent } from './types';

/** Google's documented placeholder for function calls that carry no thought signature (e.g. from another model). */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

/**
 * Gemini generateContent. Thought signatures ride on individual parts (function calls, text, thoughts)
 * and must come back on exactly those parts, in order, for the same model; this adapter keeps every
 * part's signature in its meta and rebuilds the model turns part for part.
 */
export class GeminiAdapter implements ProviderAdapter {
  private keyIndex = new Map<string, number>();
  private schemaMode = new Map<string, 'json' | 'openapi'>();

  async stream(call: ProviderCall, emit: (e: StreamEvent) => void): Promise<ProviderResult> {
    const keys = call.provider.keys;
    if (!keys.length) throw new ProviderError('auth', `${call.provider.name}: no API key configured`, { retryable: false });
    let lastError: ProviderError | undefined;
    for (let attempt = 0; attempt < keys.length + 1; attempt++) {
      const i = (this.keyIndex.get(call.provider.id) ?? 0) % keys.length;
      const mode = this.schemaMode.get(call.provider.id) ?? 'json';
      let res: Response;
      try {
        res = await http(`${call.provider.baseUrl}/models/${encodeURIComponent(call.model.id)}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, 'x-goog-api-key': keys[i], ...call.provider.headers },
          body: JSON.stringify(buildBody(call, mode)),
          signal: call.signal,
          proxy: call.provider.proxy,
        });
      } catch (e) {
        throw networkError(e, call.provider.name);
      }
      if (res.ok) return consume(call, res, emit);
      const err = await errorFromResponse(res, call.provider.name);
      lastError = err;
      if ((err.kind === 'rate_limit' || err.kind === 'quota') && keys.length > 1) {
        this.keyIndex.set(call.provider.id, i + 1);
        continue;
      }
      if (err.kind === 'invalid_request' && mode === 'json' && /parametersJsonSchema|parameters_json_schema|Unknown name/i.test(err.message)) {
        this.schemaMode.set(call.provider.id, 'openapi');
        continue;
      }
      throw err;
    }
    throw lastError ?? new ProviderError('rate_limit', `${call.provider.name}: all keys are rate limited`);
  }
}

function buildBody(call: ProviderCall, mode: 'json' | 'openapi'): Record<string, unknown> {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: call.system }] },
    contents: toGeminiContents(call.messages, call.model.id, call.model.vision),
    generationConfig: { maxOutputTokens: call.maxOutputTokens, ...thinkingConfig(call) },
  };
  if (call.tools.length) {
    body.tools = [
      {
        functionDeclarations: call.tools.map((t) => {
          const params = t.freeform ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } : t.parameters;
          return mode === 'json'
            ? { name: t.name, description: t.description, parametersJsonSchema: params }
            : { name: t.name, description: t.description, parameters: toGeminiSchema(params) };
        }),
      },
    ];
    body.toolConfig = { functionCallingConfig: { mode: call.toolChoice === 'none' ? 'NONE' : 'AUTO' } };
  }
  return body;
}

export function thinkingConfig(call: ProviderCall): Record<string, unknown> {
  const style = call.model.quirks.geminiThinking ?? 'level';
  if (style === 'none' || !call.model.efforts.length) return {};
  const e = call.effort;
  if (style === 'budget') {
    const budget = { off: 0, minimal: 512, low: 2048, medium: 8192, high: -1, xhigh: -1, max: -1, ultra: -1 }[e];
    return { thinkingConfig: { thinkingBudget: budget, includeThoughts: budget !== 0 } };
  }
  // EXTRA_HIGH only where the model lists it (see geminiEfforts); a model that stops at HIGH gets HIGH for anything above.
  const top = call.model.efforts.includes('xhigh') && (e === 'xhigh' || e === 'max' || e === 'ultra') ? 'extra_high' : 'high';
  const level = e === 'off' || e === 'minimal' ? 'minimal' : e === 'low' ? 'low' : e === 'medium' ? 'medium' : top;
  return { thinkingConfig: { thinkingLevel: level, includeThoughts: true } };
}

/** Transcript to Gemini contents. Parts from this model are echoed with their signatures. */
export function toGeminiContents(messages: Message[], modelId: string, vision = true): unknown[] {
  const contents: { role: string; parts: unknown[] }[] = [];
  const callNames = new Map<string, string>();
  for (const m of messages) {
    const parts: unknown[] = [];
    if (m.role === 'user') {
      const trailing: unknown[] = [];
      for (const p of m.parts) {
        if (p.type === 'tool_result') {
          const fnId = p.callId.startsWith('gem_') ? undefined : p.callId;
          const hasImg = p.images?.some((img) => img.data);
          const note = hasImg && !vision && !/cannot (?:view|see) (?:them|images)/i.test(p.content) ? '\n(Images were omitted because this model cannot view them.)' : '';
          const text = `${p.content || '(no output)'}${note}`;
          parts.push({
            functionResponse: {
              name: callNames.get(p.callId) ?? p.name,
              ...(fnId ? { id: fnId } : {}),
              response: p.isError ? { error: text } : { output: text },
            },
          });
          if (vision) for (const img of p.images ?? []) trailing.push({ inlineData: { mimeType: img.mediaType, data: img.data } });
        } else if (p.type === 'text' && p.text) trailing.push({ text: p.text });
        else if (p.type === 'image') {
          if (vision) trailing.push({ inlineData: { mimeType: p.mediaType, data: p.data } });
          else trailing.push({ text: `[image${p.name ? ` ${p.name}` : ''} omitted: this model cannot see images]` });
        }
      }
      parts.push(...trailing);
    } else {
      for (const p of m.parts) {
        const sig = p.type !== 'image' && p.type !== 'tool_result' && 'meta' in p ? (p.meta?.thoughtSignature as string | undefined) : undefined;
        const sameModel = (p.type === 'reasoning' ? p.model : (p as { meta?: { model?: string } }).meta?.model) === modelId;
        if (p.type === 'reasoning') {
          if (p.model === modelId && (p.text || sig)) parts.push({ text: p.text, thought: true, ...(sig ? { thoughtSignature: sig } : {}) });
        } else if (p.type === 'text' && (p.text || (sig && sameModel))) {
          parts.push({ text: p.text, ...(sig && sameModel ? { thoughtSignature: sig } : {}) });
        } else if (p.type === 'tool_call') {
          callNames.set(p.id, p.name);
          const fnId = p.id.startsWith('gem_') ? undefined : p.id;
          parts.push({
            functionCall: { name: p.name, args: p.custom ? { input: p.raw ?? '' } : (p.input ?? {}), ...(fnId ? { id: fnId } : {}) },
            thoughtSignature: sig && sameModel ? sig : SKIP_SIGNATURE,
          });
        }
      }
    }
    if (!parts.length) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

async function consume(call: ProviderCall, res: Response, emit: (e: StreamEvent) => void): Promise<ProviderResult> {
  const parts: Part[] = [];
  const usage: Usage = emptyUsage();
  let stop: ProviderResult['stop'] = 'end';
  let refusal: string | undefined;
  const modelId = call.model.id;

  try {
    // The server said the reply is over. A connection can also close cleanly halfway through one.
    let ended = false;
    for await (const sse of readSse(res.body!, call.signal, () => emit({ type: 'alive' }))) {
      if (!sse.data) continue;
      let ev: any;
      try {
        ev = JSON.parse(sse.data);
      } catch {
        continue;
      }
      const rawErr = ev.error ?? (Array.isArray(ev) ? ev[0]?.error : ev.type === 'error' ? ev : undefined);
      if (rawErr) {
        const detail = typeof rawErr === 'string' ? rawErr : (rawErr.message ?? rawErr.status ?? 'stream error');
        const codes =
          typeof rawErr === 'object' && rawErr !== null
            ? [rawErr.code, rawErr.status, rawErr.type].filter((x) => typeof x === 'string' || typeof x === 'number').join(' ')
            : undefined;
        const text = typeof rawErr === 'string' ? rawErr : `${detail}\n${JSON.stringify(rawErr)}`;
        const { kind, retryAfterMs } = classifyStreamError(text, codes || undefined);
        const status = typeof rawErr === 'object' && typeof rawErr?.code === 'number' ? rawErr.code : undefined;
        throw new ProviderError(kind, `${call.provider.name}: ${detail}`, { status, retryAfterMs });
      }
      const um = ev.usageMetadata;
      if (um) {
        usage.input = um.promptTokenCount ?? usage.input;
        usage.cacheRead = um.cachedContentTokenCount ?? usage.cacheRead;
        usage.reasoning = um.thoughtsTokenCount ?? usage.reasoning;
        usage.output = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
      }
      if (ev.promptFeedback?.blockReason) {
        stop = 'refusal';
        refusal = `Blocked: ${ev.promptFeedback.blockReason}`;
      }
      const cand = ev.candidates?.[0];
      if (!cand) continue;
      for (const gp of cand.content?.parts ?? []) {
        const sig: string | undefined = gp.thoughtSignature;
        if (gp.functionCall) {
          const id = gp.functionCall.id || `gem_${newId()}`;
          const part: ToolCallPart = {
            type: 'tool_call',
            id,
            name: gp.functionCall.name,
            input: gp.functionCall.args ?? {},
            raw: JSON.stringify(gp.functionCall.args ?? {}),
            meta: { model: modelId, ...(sig ? { thoughtSignature: sig } : {}) },
          };
          parts.push(part);
          emit({ type: 'tool', index: parts.length - 1, id, name: part.name, delta: part.raw ?? '' });
          continue;
        }
        if (typeof gp.text !== 'string') {
          if (sig) attachSignature(parts, sig);
          continue;
        }
        const last = parts[parts.length - 1];
        if (gp.thought) {
          if (last?.type === 'reasoning' && !last.meta?.thoughtSignature) {
            last.text += gp.text;
            if (sig) last.meta = { ...last.meta, thoughtSignature: sig };
          } else parts.push({ type: 'reasoning', text: gp.text, provider: call.provider.id, model: modelId, meta: sig ? { thoughtSignature: sig } : {} });
          emit({ type: 'reasoning', index: parts.length - 1, delta: gp.text });
        } else {
          if (last?.type === 'text' && !last.meta?.thoughtSignature) {
            last.text += gp.text;
            if (sig) last.meta = { ...last.meta, thoughtSignature: sig };
          } else parts.push({ type: 'text', text: gp.text, meta: { model: modelId, ...(sig ? { thoughtSignature: sig } : {}) } });
          emit({ type: 'text', index: parts.length - 1, delta: gp.text });
        }
      }
      const f = cand.finishReason;
      if (f) ended = true;
      if (f === 'MAX_TOKENS') stop = 'max_tokens';
      else if (f && /SAFETY|RECITATION|PROHIBITED|BLOCKLIST|SPII|IMAGE_SAFETY/.test(f)) {
        stop = 'refusal';
        refusal = `Stopped by the provider (${f})`;
      } else if (f === 'MALFORMED_FUNCTION_CALL' || f === 'UNEXPECTED_TOOL_CALL') {
        throw new ProviderError('server', `${call.provider.name}: the model produced a malformed tool call (${f})`);
      }
    }
    if (!ended) throw new ProviderError('network', `${call.provider.name}: the connection closed before the reply ended.`);
  } catch (e) {
    if (call.signal.aborted) return { parts: tidy(parts), usage, stop: 'aborted' };
    if (e instanceof ProviderError) throw e;
    throw networkError(e, call.provider.name);
  }
  const kept = tidy(parts);
  if (stop === 'end' && kept.some((p) => p.type === 'tool_call')) stop = 'tool_use';
  return { parts: kept, usage, stop, refusal };
}

function attachSignature(parts: Part[], sig: string): void {
  const last = parts[parts.length - 1];
  if (last && (last.type === 'text' || last.type === 'reasoning' || last.type === 'tool_call')) last.meta = { ...last.meta, thoughtSignature: sig };
}

function tidy(parts: Part[]): Part[] {
  return parts.filter((p) => (p.type === 'text' ? p.text.length > 0 || !!p.meta?.thoughtSignature : true));
}

export { errorFromResponse };
