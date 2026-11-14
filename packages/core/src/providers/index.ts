import type { ApiKind } from '../config/config';
import { AnthropicAdapter } from './anthropic';
import { GeminiAdapter } from './gemini';
import { OpenAIChatAdapter } from './openai-chat';
import { OpenAIResponsesAdapter } from './openai-responses';
import type { ProviderAdapter } from './types';

const adapters = new Map<ApiKind, ProviderAdapter>();

export function adapterFor(api: ApiKind): ProviderAdapter {
  let a = adapters.get(api);
  if (!a) {
    a =
      api === 'anthropic'
        ? new AnthropicAdapter()
        : api === 'openai-responses'
          ? new OpenAIResponsesAdapter()
          : api === 'gemini'
            ? new GeminiAdapter()
            : new OpenAIChatAdapter();
    adapters.set(api, a);
  }
  return a;
}

/** Start every adapter afresh (their connections and what they learnt about the servers), for tests. */
export function resetAdapters(): void {
  adapters.clear();
}

export * from './types';
export * from './errors';
