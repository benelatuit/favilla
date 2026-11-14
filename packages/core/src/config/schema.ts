import type { FavillaConfig, ModelSettings, Pricing, ProviderSettings, Quirks } from './config';
import { EFFORT_ORDER } from '../types';
import { LANGUAGES } from '../i18n';
import builtinProviders from '../catalog/providers.json';

type ObjectValue = Record<string, unknown>;
type BadKey = (key: string) => void;
type Rule = (value: unknown, key: string, bad: BadKey) => unknown;

export const isObject = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);

const check = (accept: (value: unknown) => boolean): Rule => (value, key, bad) => {
  if (accept(value)) return value;
  bad(key);
  return undefined;
};

const string = check((v) => typeof v === 'string');
const number = check((v) => typeof v === 'number' && Number.isFinite(v));
const boolean = check((v) => typeof v === 'boolean');
const oneOf = (...values: unknown[]) => check((v) => values.includes(v));
const stringsOnly = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const strings = check(stringsOnly);
const effort = oneOf(...EFFORT_ORDER);
const efforts = check((v) => Array.isArray(v) && v.every((x) => EFFORT_ORDER.includes(x)));
const profile = oneOf('claude', 'codex', 'favilla');

export function isHttpAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
  try {
    return !!new URL(value).hostname;
  } catch {
    return false;
  }
}

const address = check(isHttpAddress);
const child = (parent: string, key: string) => parent ? parent + '.' + key : key;

function fields(rules: Record<string, Rule>): Rule {
  return (value, key, bad) => {
    if (!isObject(value)) return bad(key), undefined;
    const out = { ...value };
    for (const [name, rule] of Object.entries(rules)) {
      if (!Object.hasOwn(value, name)) continue;
      const next = rule(value[name], child(key, name), bad);
      if (next === undefined) delete out[name];
      else out[name] = next;
    }
    return out;
  };
}

function entries(rule: Rule, privateKeys = false): Rule {
  return (value, key, bad) => {
    if (!isObject(value)) return bad(key), undefined;
    return Object.fromEntries(Object.entries(value).flatMap(([name, v]) => {
      const next = rule(v, privateKeys ? key : child(key, name), bad);
      return next === undefined ? [] : [[name, next]];
    }));
  };
}

const quirks = fields({
  reasoningField: oneOf('reasoning_content', 'reasoning', 'reasoning_details', 'think_tags'),
  reasoningEcho: oneOf('none', 'turn', 'all'),
  thinkingParam: oneOf('none', 'deepseek', 'qwen', 'glm', 'llamacpp', 'openrouter', 'openai', 'moonshot'),
  maxTokensField: oneOf('max_tokens', 'max_completion_tokens'),
  streamUsage: boolean,
  noToolImages: boolean,
  strictTools: boolean,
  anthropicThinking: oneOf('adaptive', 'budget'),
  geminiThinking: oneOf('level', 'budget', 'none'),
  prefill: boolean,
  toolChoiceBreaksCache: boolean,
} satisfies Record<keyof Quirks, Rule>);

const pricing = fields({ input: number, output: number, cacheRead: number, cacheWrite: number } satisfies Record<keyof Pricing, Rule>);
const model = fields({
  name: string, family: string, contextWindow: number, maxOutput: number, efforts, defaultEffort: effort, vision: boolean,
  toolProfile: profile, pricing, quirks, hidden: boolean, description: string, thinkingDisplay: string,
} satisfies Record<keyof ModelSettings, Rule>);
const provider = fields({
  name: string, api: oneOf('anthropic', 'openai-responses', 'openai-chat', 'gemini'), baseUrl: address,
  apiKey: string, apiKeys: strings, env: strings, keyFile: string, headers: entries(string),
  proxy: check((v) => typeof v === 'string' || v === false), auth: oneOf('key', 'none'),
  discover: oneOf('anthropic', 'openai', 'gemini', 'llamacpp', 'ollama', false),
  models: entries(model), quirks, local: boolean, slots: number, enabled: boolean, description: string,
} satisfies Record<keyof ProviderSettings, Rule>);
const mcpFields = fields({
  url: address, command: string, args: strings, env: entries(string), headers: entries(string), cwd: string, enabled: boolean, timeoutMs: number,
});
const mcp: Rule = (value, key, bad) => {
  const next = mcpFields(value, key, bad) as ObjectValue | undefined;
  if (!next) return undefined;
  if (next.url || next.command) return next;
  if (isObject(value) && !('url' in value || 'command' in value)) bad(key);
  return undefined;
};
const mailServer = fields({ host: string, port: number, secure: boolean });
const mailAccount = fields({ address: string, name: string, user: string, provider: string, imap: mailServer, smtp: mailServer });
const accounts: Rule = (value, key, bad) => {
  if (!Array.isArray(value)) return bad(key), undefined;
  return value.map((v, i) => mailAccount(v, child(key, String(i)), bad)).filter((v) => v !== undefined);
};

const settings = fields({
  model: string, effort, smallModel: string, subagentModel: string, shadowTests: fields({ model: string, effort }),
  providers: entries(provider), proxy: string,
  guard: fields({ mode: oneOf('confirm', 'block', 'off'), allow: strings, deny: strings }),
  context: fields({ compactAt: number, toolOutputShare: number, limit: number }), shell: string, instructions: check((v) => typeof v === 'string' || stringsOnly(v)),
  language: oneOf('auto', ...LANGUAGES), theme: string, voice: string, answerFormat: oneOf('structured', 'plain'),
  maxSteps: number, bashTimeoutMs: number, autoCompact: boolean, checkpoints: boolean, folderSnapshots: boolean,
  skills: check((v) => typeof v === 'boolean' || stringsOnly(v)), webSearch: oneOf(true, false, 'provider', 'builtin'),
  search: fields({ engines: strings, braveKey: string, searxng: string, blocked: strings, preferred: strings }),
  modelRegistry: boolean, tools: oneOf('auto', 'favilla', 'claude', 'codex'), browserPath: string,
  browser: fields({ visible: boolean, keepLogins: boolean, use: oneOf('favilla', 'edge', 'chrome') }),
  languageServers: boolean, beforeTests: boolean, confine: boolean, memoryGuard: boolean, computer: boolean,
  mcpServers: entries(mcp), systemAppend: string, desktop: fields({ hardwareAcceleration: boolean }), storage: fields({ encrypt: boolean }),
  remote: fields({ enabled: boolean, relay: string, awake: boolean }),
  mail: fields({ accounts, default: string, sendWithoutAsking: boolean }),
} satisfies Record<keyof FavillaConfig | 'mail', Rule>);

export function checkedSettings(value: ObjectValue, bad: BadKey): FavillaConfig {
  const config = settings(value, '', bad) as FavillaConfig;
  for (const [id, p] of Object.entries(config.providers ?? {})) {
    if (!p.baseUrl && !Object.hasOwn(builtinProviders, id)) bad('providers.' + id + '.baseUrl');
  }
  return config;
}

const credentials = fields({
  keys: entries(string, true),
  mail: entries(string, true),
});

export function checkedCredentials(value: ObjectValue, bad: BadKey): ObjectValue {
  return credentials(value, '', bad) as ObjectValue;
}
