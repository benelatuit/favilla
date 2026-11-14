import type { Effort, Message, Part, StopReason, Usage } from '../types';
import type { ModelInfo, ResolvedProvider } from '../catalog/catalog';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
  /** OpenAI freeform tool (plain-text input constrained by a grammar), e.g. apply_patch. */
  freeform?: { syntax: 'lark' | 'regex'; definition: string };
}

export interface CallOptions {
  verbosity?: 'low' | 'medium' | 'high';
}

export interface ProviderCall {
  model: ModelInfo;
  provider: ResolvedProvider;
  /** Frozen for the whole session so caches and thinking signatures stay valid. */
  system: string;
  tools: ToolSpec[];
  messages: Message[];
  effort: Effort;
  maxOutputTokens: number;
  sessionId: string;
  turnId: string;
  /** Index into `messages` of the user message that started the current turn. */
  turnStart: number;
  signal: AbortSignal;
  toolChoice?: 'auto' | 'none';
  options?: CallOptions;
  /** Offer the provider's own web search tool (OpenAI Responses, Anthropic). Fixed per session like the tools. */
  hostedSearch?: boolean;
  /** Sites the hosted search leaves out (copy sites), while the provider takes the filter. */
  hostedSearchBlocked?: string[];
  /**
   * main: a step of the session's own loop. Those follow one another, so a provider may chain them on one
   * connection and send only what is new; anything else (a summary, a check) goes on its own.
   */
  channel?: 'main';
  /** Sessions that send the same long prefix (the sub-agents of one tool call) share this as the prompt cache key. */
  cacheKey?: string;
}

export type StreamEvent =
  | { type: 'text'; index: number; delta: string }
  | { type: 'reasoning'; index: number; delta: string }
  | { type: 'tool'; index: number; id: string; name: string; delta: string }
  | { type: 'meta'; key: string; value: unknown }
  /** The connection is open and the server is there, though nothing was written: a model thinking out of sight. */
  | { type: 'alive' };

export interface ProviderResult {
  parts: Part[];
  usage: Usage;
  stop: StopReason;
  refusal?: string;
}

export interface ProviderAdapter {
  stream(call: ProviderCall, emit: (e: StreamEvent) => void): Promise<ProviderResult>;
}
