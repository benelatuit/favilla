import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettingDocument, settingNotice, settingsDocument, SettingsFileError, type SettingReporter, type SettingSource, checkSettings, type SettingBasis, type SettingPath } from './document';
import { editSetting } from './edit';
import { checkedSettings, isObject } from './schema';
import { settingsWords, type Language } from '../i18n';
import { withFileUpdate, writeFileAtomic } from '../auth/store';
import type { Effort } from '../types';
import type { McpServerConfig } from '../mcp/hub';
import { appPath } from '../util/paths';

export type ApiKind = 'anthropic' | 'openai-responses' | 'openai-chat' | 'gemini';
export type DiscoverKind = 'anthropic' | 'openai' | 'gemini' | 'llamacpp' | 'ollama' | false;
export type ToolProfileName = 'claude' | 'codex' | 'favilla';

export interface Quirks {
  /** Where a compatible API puts reasoning text in responses. */
  reasoningField?: 'reasoning_content' | 'reasoning' | 'reasoning_details' | 'think_tags';
  /** Which reasoning to send back: none, the current turn's tool loop, or everything. */
  reasoningEcho?: 'none' | 'turn' | 'all';
  /** How to switch thinking on for a compatible API. */
  thinkingParam?: 'none' | 'deepseek' | 'qwen' | 'glm' | 'llamacpp' | 'openrouter' | 'openai' | 'moonshot';
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  streamUsage?: boolean;
  /** Provider rejects image parts in tool results. */
  noToolImages?: boolean;
  /** Provider wants `strict` on function tools. */
  strictTools?: boolean;
  /** Anthropic thinking style: adaptive + effort (current models) or a token budget (older ones). */
  anthropicThinking?: 'adaptive' | 'budget';
  /** Gemini thinking control: thinkingLevel (Gemini 3+), thinkingBudget (2.x) or none. */
  geminiThinking?: 'level' | 'budget' | 'none';
  /** The model continues a trailing assistant message instead of answering it, so a prefill can be sent as one. */
  prefill?: boolean;
  /** Changing tool_choice (to 'none' for a summary) misses the conversation's prompt cache. */
  toolChoiceBreaksCache?: boolean;
}

export interface Pricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelSettings {
  name?: string;
  family?: string;
  contextWindow?: number;
  maxOutput?: number;
  efforts?: Effort[];
  defaultEffort?: Effort;
  vision?: boolean;
  toolProfile?: ToolProfileName;
  pricing?: Pricing;
  quirks?: Quirks;
  hidden?: boolean;
  description?: string;
  /** Anthropic only: send `display` for thinking ("summarized", "omitted", "updates"). */
  thinkingDisplay?: string;
}

export interface ProviderSettings {
  name?: string;
  api?: ApiKind;
  baseUrl?: string;
  /** Literal key, or "env:NAME" to read one variable. */
  apiKey?: string;
  apiKeys?: string[];
  /** Environment variables that may hold the key (comma-separated lists are split). */
  env?: string[];
  /** A dotenv file holding the key variables. */
  keyFile?: string;
  headers?: Record<string, string>;
  /** Proxy URL for this provider, or false to connect directly. */
  proxy?: string | false;
  auth?: 'key' | 'none';
  discover?: DiscoverKind;
  models?: Record<string, ModelSettings>;
  quirks?: Quirks;
  local?: boolean;
  /**
   * How many requests the server answers at once. A local one is taken as one unless this says more (a model running
   * on this computer usually is; a proxy on it to a cloud service is not): with one, the summary is not written in
   * the background and pages are not read with the same model, since either would wait ahead of the agent's next step.
   */
  slots?: number;
  enabled?: boolean;
  description?: string;
}

export interface FavillaConfig {
  /** Default model as "provider/model". */
  model?: string;
  effort?: Effort;
  /** Cheaper model for titles and web-page extraction. */
  smallModel?: string;
  subagentModel?: string;
  /**
   * Shadow tests: for a fix in a Go project, a model of another family writes tests of the request from the request
   * alone while the work goes on, and they run on the change before the turn ends (off unless a model is named).
   */
  shadowTests?: { model: string; effort?: Effort };
  providers?: Record<string, ProviderSettings>;
  /** HTTPS proxy for remote providers (local ones always connect directly). */
  proxy?: string;
  guard?: { mode?: 'confirm' | 'block' | 'off'; allow?: string[]; deny?: string[] };
  /** limit: use at most this many tokens of any model's window, so compaction comes sooner (benchmarks of long work). */
  context?: { compactAt?: number; toolOutputShare?: number; limit?: number };
  shell?: string;
  instructions?: string[] | string;
  language?: 'auto' | Language;
  theme?: string;
  /** How Favilla writes its answers: a file in assets/prompts/voices (favilla unless set). */
  voice?: string;
  /** How answers are laid out: labelled parts, lists and tables where they help (structured, the default), or short paragraphs only (plain). */
  answerFormat?: 'structured' | 'plain';
  maxSteps?: number;
  bashTimeoutMs?: number;
  autoCompact?: boolean;
  checkpoints?: boolean;
  /** Snapshots of the whole folder at each turn's start and end (agent/shadow.ts), so commands' changes undo too; on unless false. */
  folderSnapshots?: boolean;
  /** Skill folders to list for the model (each a folder with SKILL.md); false turns skills off. */
  skills?: boolean | string[];
  /** Web search for the model: the provider's own where it has one, a built-in search elsewhere. */
  webSearch?: boolean | 'provider' | 'builtin';
  /**
   * Favilla's own search: which engines to ask (duckduckgo and bing need nothing; brave needs braveKey, searxng
   * a SearXNG address), sites never shown (added to the built-in list of copy sites) and sites ranked first.
   */
  search?: { engines?: string[]; braveKey?: string; searxng?: string; blocked?: string[]; preferred?: string[] };
  /**
   * Read models.dev (refreshed every few days) for the thinking levels and context windows of models whose
   * provider does not report them. Off: the built-in family guesses only.
   */
  modelRegistry?: boolean;
  /** Tool surface for every model: favilla (its own, the default), claude or codex style; auto picks per model family. */
  tools?: ToolProfileName | 'auto';
  /** Chrome, Chromium or Edge for the screenshot tool (found on its own when unset). */
  browserPath?: string;
  /** The agent's browser: a window on screen or headless, and whether its profile (logins) is kept between sessions. */
  /** use: the agent's browser is Favilla's own (default), or the user's own Edge or Chrome as it is open, attached to. */
  browser?: { visible?: boolean; keepLogins?: boolean; use?: 'favilla' | 'edge' | 'chrome' };
  /** Language servers for type errors after edits, definitions and references (default on where one is found). */
  languageServers?: boolean;
  /** After tests pass, run the test files the session changed on the code as it was before its changes, and say whether they catch the fix (off: it runs the tests twice; default on). */
  beforeTests?: boolean;
  /** Nothing the agent runs may touch a path outside its folder: for models reached through someone else's relay (FAVILLA_CONFINE=1). */
  confine?: boolean;
  /** Stop a command Favilla runs when the computer runs short of memory while it runs (default on). Global only: a cloned repository cannot turn it off. */
  memoryGuard?: boolean;
  /** Let the model see and use this computer's desktop (screenshots, mouse, keyboard). Off unless the user turns it on. */
  computer?: boolean;
  /** MCP servers whose tools the model gets: a command (stdio) or a url (streamable HTTP or SSE). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Extra instructions appended to every system prompt. */
  systemAppend?: string;
  /**
   * The desktop app. hardwareAcceleration: false draws the window without the graphics card (low-memory mode:
   * about 90 MB less, animations and scrolling may be less smooth); it takes effect at the next start.
   */
  desktop?: { hardwareAcceleration?: boolean };
  /** Sessions and their pictures, outputs and snapshots are sealed at rest under this account's key (on unless false). */
  storage?: { encrypt?: boolean };
  /**
   * Remote control from paired phones through a relay (remote/link.ts). Off unless turned on; global only. While it is
   * on, the desktop app keeps the computer awake when work runs or waits for an answer; `awake` keeps it awake the
   * whole time, so a phone can always reach it. `lan` (on unless false) also lets phones on the same network connect
   * to this computer directly (remote/lan.ts), on `lanPort` or the next free port after it.
   */
  remote?: { enabled?: boolean; relay?: string; awake?: boolean; lan?: boolean; lanPort?: number };
  /** Asking the update feed this build names for a newer version (update/updater.ts). On unless set to false. */
  updates?: { check?: boolean };
}

export const DEFAULTS: Required<Pick<FavillaConfig, 'effort' | 'maxSteps' | 'bashTimeoutMs' | 'autoCompact' | 'checkpoints' | 'instructions' | 'tools'>> & {
  context: Required<NonNullable<FavillaConfig['context']>>;
} = {
  effort: 'high',
  maxSteps: 400,
  bashTimeoutMs: 120_000,
  autoCompact: true,
  checkpoints: true,
  // Favilla's own surface: on gpt-6-luna it solved as much as the shell-and-patch one with fewer tokens and steps.
  tools: 'favilla',
  instructions: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'],
  // 256k sweet spot on 1M-window models: matches 400k task delivery while saving ~15% billed tokens and ~18% wall time,
  // and stays well clear of relay ~518k KV-cache eviction cliffs. Set context.limit to a larger figure or 0 for full window.
  context: { compactAt: 0.82, toolOutputShare: 0.08, limit: 256_000 },
};

export function globalConfigPath(): string {
  return appPath('config.json');
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, '.favilla', 'config.json');
}

/**
 * A folder's own config, unless that file is the user's config: in the home folder .favilla/config.json is the global
 * file itself (or, with FAVILLA_HOME elsewhere, a config that is not this run's).
 */
function folderConfig(cwd: string, options?: ConfigRead) {
  const target = projectConfigPath(cwd);
  const file = path.resolve(target).toLowerCase();
  const own = [globalConfigPath(), path.join(os.homedir(), '.favilla', 'config.json')].map((f) => path.resolve(f).toLowerCase());
  return own.includes(file) ? { config: {} as FavillaConfig } : readJsonc(target, options);
}

export function settingsText(file: string): string {
  return settingsDocument(fs.readFileSync(file)).text;
}

export interface ConfigRead {
  report: SettingReporter;
  reload?: boolean;
  modelSource?: SettingSource;
  global?: Record<string, unknown>;
}

function readJsonc(file: string, options?: ConfigRead): { config: FavillaConfig; source?: SettingSource; raw?: Record<string, unknown> } {
  try {
    const { value, source } = readSettingDocument(file);
    const config = checkedSettings(value, (key) => options?.report(settingNotice(source, settingsWords.value, { key })));
    return { config, source, raw: value };
  } catch (e) {
    if (!(e instanceof SettingsFileError) || options?.reload) throw e;
    options?.report(e.notice('start'));
    return { config: {} };
  }
}

export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

let lastGlobal: { file: string; config: FavillaConfig } | undefined;

function readGlobal(options?: ConfigRead) {
  const file = globalConfigPath();
  const current = readJsonc(file, options);
  if (current.source) lastGlobal = { file, config: current.config };
  // A file that could not be read (open in an editor writing it in place, mid-save) is not a file of no settings:
  // what it last said stands, as a reload keeps it. A folder opened then had kept no providers for good.
  else if (lastGlobal?.file === file) return { ...current, config: lastGlobal.config };
  return current;
}

/** The global config file alone, without a project's settings or the environment's. */
export function loadGlobalConfigRaw(): FavillaConfig {
  const current = readGlobal();
  return current.source ? current.config : lastGlobal?.file === globalConfigPath() ? lastGlobal.config : {};
}

/**
 * What a project's .favilla/config.json may set: the models and efforts it wants and how the agent works in it.
 * A repository someone else wrote cannot send this user's keys or conversation elsewhere (providers, proxy,
 * search), run programs (mcpServers, shell, browserPath), reach the desktop or the browser's logins, or turn
 * approvals off (guard); those stay in the user's own ~/.favilla/config.json.
 */
const PROJECT_KEYS = new Set(['model', 'effort', 'smallModel', 'subagentModel', 'shadowTests', 'context', 'instructions', 'language', 'theme', 'voice', 'answerFormat', 'maxSteps', 'bashTimeoutMs', 'autoCompact', 'checkpoints', 'skills', 'webSearch', 'tools', 'languageServers', 'beforeTests', 'systemAppend']);

function projectPart(p: FavillaConfig): FavillaConfig {
  return Object.fromEntries(Object.entries(p).filter(([k]) => PROJECT_KEYS.has(k))) as FavillaConfig;
}

/** Settings taken out (2026-11-04: end-of-turn checks, siblings, forks; 2026-11-06: server, never read): Favilla reads them nowhere, so a file that still has them gets no word. */
const RETIRED_KEYS = new Set(['endChecks', 'plainAnswers', 'checkCoverage', 'learn', 'tidyCheck', 'shapeCheck', 'pageAudit', 'designReview', 'siblings', 'forks', 'server', 'wishBudgetMinutes']);

/** The keys of a project's config that Favilla leaves out (see PROJECT_KEYS), to tell the user. */
export function ignoredProjectKeys(cwd: string): string[] {
  try {
    return Object.keys(folderConfig(cwd).config).filter((k) => !PROJECT_KEYS.has(k) && !RETIRED_KEYS.has(k));
  } catch {
    return [];
  }
}

/** The model that writes shadow tests, if any: config shadowTests, or FAVILLA_SHADOW_MODEL for runs. */
export function shadowTestsModel(config: FavillaConfig): { model: string; effort?: Effort } | null {
  const shadowModel = process.env.FAVILLA_SHADOW_MODEL;
  const shadowEffort = process.env.FAVILLA_SHADOW_EFFORT;
  if (shadowModel === '0') return null;
  if (shadowModel) return { model: shadowModel, effort: (shadowEffort as Effort | undefined) ?? config.shadowTests?.effort };
  return config.shadowTests?.model ? config.shadowTests : null;
}

/** Global config, then the project's .favilla/config.json, then environment overrides. */
export function loadConfig(cwd?: string, options?: ConfigRead): FavillaConfig {
  const global = readGlobal(options);
  const project = cwd ? folderConfig(cwd, options) : undefined;
  const cfg = project ? deepMerge(global.config, projectPart(project.config)) : { ...global.config };
  const envModel = process.env.FAVILLA_MODEL;
  const envProxy = process.env.FAVILLA_PROXY;
  if (options) {
    options.global = global.raw;
    options.modelSource = envModel ? undefined : project?.config.model ? project.source : global.source;
  }
  if (envModel) cfg.model = envModel;
  if (envProxy) cfg.proxy = envProxy;
  if (process.env.FAVILLA_CONFINE === '1') cfg.confine = true;
  // Benchmarks and scripts can switch web search (off, builtin, provider), skills (0) and the tool surface per run.
  const search = process.env.FAVILLA_WEB_SEARCH;
  if (search) cfg.webSearch = search === 'off' || search === '0' ? false : search === 'builtin' || search === 'provider' ? search : true;
  if (process.env.FAVILLA_SKILLS === '0') cfg.skills = false;
  const tools = process.env.FAVILLA_TOOLS;
  if (tools === 'favilla' || tools === 'claude' || tools === 'codex' || tools === 'auto') cfg.tools = tools;
  const rawLimit = process.env.FAVILLA_CONTEXT_LIMIT;
  const limit = Number(rawLimit);
  if (rawLimit !== undefined && rawLimit.trim() !== '' && Number.isFinite(limit) && (limit === 0 || limit >= 4096)) cfg.context = { ...cfg.context, limit };
  return cfg;
}

/**
 * A dotted key as a path into `obj`. Model ids hold dots themselves (gpt-6.1-sol): where `obj` has a key spelled with
 * dots, the longest one that fits is taken whole; past what exists, every dot separates, and a part in double quotes
 * keeps its dots (providers.relay.models."gpt-6.1-sol".contextWindow). `favilla config` had split such an id in two and
 * read nothing, or written the setting under keys of its own.
 */
export function keyPath(obj: unknown, dotted: string): string[] {
  const parts: { text: string; quoted: boolean }[] = [];
  for (const m of dotted.matchAll(/"([^"]*)"|([^.]+)/g)) parts.push(m[1] !== undefined ? { text: m[1], quoted: true } : { text: m[2], quoted: false });
  const out: string[] = [];
  let node = obj;
  for (let i = 0; i < parts.length; ) {
    const here = node && typeof node === 'object' ? (node as Record<string, unknown>) : null;
    let take = 1;
    if (here && !parts[i].quoted) {
      for (let j = parts.length; j > i + 1; j--) {
        const run = parts.slice(i, j);
        if (run.every((p) => !p.quoted) && Object.hasOwn(here, run.map((p) => p.text).join('.'))) {
          take = j - i;
          break;
        }
      }
    }
    const key = parts
      .slice(i, i + take)
      .map((p) => p.text)
      .join('.');
    out.push(key);
    node = here && Object.hasOwn(here, key) ? here[key] : undefined;
    i += take;
  }
  return out;
}

/**
 * Update keys of the global config file, keeping the user's comments and layout. Keys are dotted paths;
 * `paths` takes paths whose parts may contain dots themselves (model ids such as "gpt-6.1-sol").
 */
export function updateGlobalConfig(changes: Record<string, unknown> | ((current: FavillaConfig) => Record<string, unknown>), paths: [SettingPath, unknown][] = [], basis?: SettingBasis): void {
  const file = globalConfigPath();
  withFileUpdate(file, (stillHeld) => {
    let { text, encode, value } = readSettingDocument(file, { editing: true });
    const patch = typeof changes === 'function' ? changes(value as FavillaConfig) : changes;
    const edits: [SettingPath, unknown][] = [...Object.entries(patch).map(([k, v]): [SettingPath, unknown] => [k.split('.'), v]), ...paths];
    checkSettings(file, basis, value, edits.map(([key]) => key));
    const before = text;
    for (const [key, value] of edits) text = editSetting(text, key, value);
    if (text !== before) writeFileAtomic(file, encode(text), { own: true, beforeReplace: stillHeld });
  });
}
