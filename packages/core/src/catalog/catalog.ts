import fs from 'node:fs';
import path from 'node:path';
import type { Effort } from '../types';
import { EFFORT_ORDER } from '../types';
import type { ApiKind, FavillaConfig, ModelSettings, Pricing, ProviderSettings, Quirks, ToolProfileName } from '../config/config';
import { isObject } from '../config/schema';
import { DEFAULTS, deepMerge } from '../config/config';

/** The configured tool surface for every model, or undefined for each family's own (auto). */
function surface(tools: ToolProfileName | 'auto'): ToolProfileName | undefined {
  return tools === 'auto' ? undefined : tools;
}
import { envProxy, http } from '../net/http';
import { addressView, redactSecrets } from '../net/address';
import { readAuthFile, writeFileAtomic, type AuthFile } from '../auth/store';
import { appPath, ensureDir } from '../util/paths';
import { debug } from '../util/log';
import { Registry, fetchRegistry, readRegistry, type RegistryHit } from './registry';
import builtinProviders from './providers.json';
import { PUBLIC_HEADERS, USER_AGENT } from '../providers/shared';
import families from './families.json';

export interface ModelInfo {
  ref: string;
  provider: string;
  id: string;
  /** The id the server expects when it differs from `id` (llama.cpp reports the model file's full path). */
  apiId?: string;
  name: string;
  family: string;
  contextWindow: number;
  /** The window the provider or the family defaults give, before an override in the settings. */
  nativeWindow?: number;
  /** Nothing states the window (not the server, not models.dev, not the model's name): `nativeWindow` is a guess. */
  windowAssumed?: boolean;
  maxOutput: number;
  efforts: Effort[];
  defaultEffort: Effort;
  vision: boolean;
  toolProfile: ToolProfileName;
  pricing?: Pricing;
  quirks: Quirks;
  description?: string;
  hidden?: boolean;
  thinkingDisplay?: string;
  discovered: boolean;
}

export interface ResolvedProvider {
  id: string;
  name: string;
  description?: string;
  api: ApiKind;
  baseUrl: string;
  auth: 'key' | 'none';
  keys: string[];
  headers: Record<string, string>;
  proxy: string | false;
  discover: ProviderSettings['discover'];
  quirks: Quirks;
  local: boolean;
  /** Answers one request at a time (see ProviderSettings.slots): nothing is sent beside the agent's own requests. */
  serial: boolean;
  enabled: boolean;
  settings: ProviderSettings;
}

interface DiscoveredModel {
  id: string;
  apiId?: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  efforts?: Effort[];
  defaultEffort?: Effort;
  vision?: boolean;
  description?: string;
  hidden?: boolean;
  family?: string;
}

function readCache<T>(file: string): Record<string, T> {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(value)) return value as Record<string, T>;
  } catch {
    // A cache can be replaced the next time its source has an answer.
  }
  return {};
}

interface DiscoveryCache {
  fetched: number;
  models: DiscoveredModel[];
  error?: string;
}

/** A provider's listed models by id and by the id the server answers to, in list order. */
interface DiscoveryIndex {
  byId: Map<string, DiscoveredModel>;
  byApiId: Map<string, DiscoveredModel[]>;
}

const REMOTE_TTL = 12 * 3600_000;
const LOCAL_TTL = 60_000;
const SUPPORTED_EFFORTS = new Set<Effort>(EFFORT_ORDER.filter((e) => e !== 'ultra'));
/** How long the copy of models.dev is used before it is fetched again, and how long to wait after a failed fetch. */
const REGISTRY_TTL = 3 * 24 * 3600_000;
const REGISTRY_RETRY = 3600_000;
/** Levels a server named in a refusal hold for a month; then the catalogue and the provider are believed again. */
const LEARNED_TTL = 30 * 24 * 3600_000;
/** A window learned from a refusal is asked again after a week: what a relay lets through changes, and a wrong small figure costs every session until then. */
const WINDOW_TTL = 7 * 24 * 3600_000;

interface LearnedEfforts {
  efforts: Effort[];
  at: number;
}

interface FamilyRule extends ModelSettings {
  match: string;
  family: string;
}

const FAMILY_RULES: { re: RegExp; rule: FamilyRule }[] = (families as FamilyRule[]).map((rule) => ({ re: new RegExp(rule.match, 'i'), rule }));

export function familyDefaults(modelId: string): FamilyRule {
  const id = modelId.toLowerCase();
  return FAMILY_RULES.find(({ re }) => re.test(id))!.rule;
}

function parseDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    /* missing file */
  }
  return out;
}

function splitKeys(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Whether a provider ships with Favilla (so it can be turned off, not removed). */
export function isBuiltinProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(builtinProviders, id);
}

export class Catalog {
  private discovered = new Map<string, DiscoveryCache>();
  /** Built once per list: a model's details were looked up by walking the whole list, twice a model. */
  private indexes = new WeakMap<DiscoveryCache, DiscoveryIndex>();
  private inflight = new Map<string, Promise<DiscoveredModel[]>>();
  private registry?: Registry | null;
  private registryJob?: Promise<boolean>;
  private registryFailed = 0;
  private learned?: Record<string, LearnedEfforts>;
  private windows?: Record<string, { window: number; at: number }>;

  constructor(public config: FavillaConfig) {}

  /**
   * This catalogue under one folder's settings (its .favilla/config.json: the model it starts with, its tool surface).
   * What was found out about providers and models stays shared, so a folder does not ask the providers again.
   */
  withConfig(config: FavillaConfig): Catalog {
    const view = Object.create(this) as Catalog;
    // Read through to this catalogue's maps; the values it replaces whole are passed through too, so every view and
    // this one see the same.
    for (const k of ['registry', 'registryJob', 'registryFailed', 'learned', 'windows'] as const) {
      Object.defineProperty(view, k, { get: () => this[k], set: (v) => void (this[k] = v), enumerable: false });
    }
    view.config = config;
    return view;
  }

  /** Built-in providers merged with the user's provider settings. */
  providers(auth = readAuthFile()): ResolvedProvider[] {
    // The key file read once for all of them: once a provider, and a provider looked up once a model, it was read and
    // parsed some 300 times for one list of models (2026-11-07).
    return Object.entries(this.mergedProviders()).map(([id, s]) => this.resolveProvider(id, s, auth));
  }

  private mergedProviders(): Record<string, ProviderSettings> {
    return deepMerge(builtinProviders as Record<string, ProviderSettings>, this.config.providers ?? {});
  }

  /** One provider, resolved alone. */
  provider(id: string): ResolvedProvider {
    const merged = this.mergedProviders();
    if (!Object.prototype.hasOwnProperty.call(merged, id)) throw new Error(`Unknown provider "${id}"`);
    return this.resolveProvider(id, merged[id], readAuthFile());
  }

  private resolveProvider(id: string, s: ProviderSettings, authFile: AuthFile): ResolvedProvider {
    const auth = s.auth ?? 'key';
    const keys: string[] = [];
    if (auth === 'key') {
      if (s.apiKey) keys.push(...(s.apiKey.startsWith('env:') ? splitKeys(process.env[s.apiKey.slice(4)]) : [s.apiKey]));
      if (s.apiKeys) keys.push(...s.apiKeys);
      const fileVars = s.keyFile ? parseDotenv(s.keyFile) : {};
      for (const name of s.env ?? []) keys.push(...splitKeys(process.env[name] ?? fileVars[name]));
      const stored = authFile.keys?.[id];
      if (typeof stored === 'string') keys.push(...splitKeys(stored));
    }
    const local = !!s.local;
    const proxy = s.proxy === false ? false : typeof s.proxy === 'string' ? s.proxy : local ? false : (this.config.proxy ?? envProxy() ?? false);
    return {
      id,
      name: s.name ?? id,
      description: s.description,
      api: s.api ?? 'openai-chat',
      baseUrl: (s.baseUrl ?? '').replace(/\/+$/, ''),
      auth,
      keys: [...new Set(keys)],
      headers: s.headers ?? {},
      proxy,
      discover: s.discover ?? false,
      quirks: s.quirks ?? {},
      local,
      serial: s.slots !== undefined ? s.slots <= 1 : local,
      enabled: s.enabled !== false,
      settings: s,
    };
  }

  /** Whether the provider has what it needs to make a request (credentials, or none needed). */
  canRequest(p: ResolvedProvider): boolean {
    if (!p.enabled || !p.baseUrl) return false;
    if (p.auth === 'none') return true;
    return p.keys.length > 0;
  }

  /** Usable: credentials in place, and for keyless local servers, actually serving models. */
  isConfigured(p: ResolvedProvider): boolean {
    if (!this.canRequest(p)) return false;
    return p.auth !== 'none' || this.modelsOf(p, this.loadDiscovery(p.id)).length > 0;
  }

  /** Ask every provider that can be reached which models it serves (local servers fail fast when down). */
  async discoverAll(force = false): Promise<void> {
    await Promise.all(this.providers().filter((p) => this.canRequest(p)).map((p) => this.discover(p.id, force).catch(() => [])));
  }

  /** Every model of the providers that can be used now (signed in, or a local server that answers). */
  usableModels(): ModelInfo[] {
    return this.providers()
      .filter((p) => this.isConfigured(p))
      .flatMap((p) => this.modelsOf(p, this.loadDiscovery(p.id)));
  }

  /** All known models of a provider (built-in, discovered, configured). */
  models(providerId: string): ModelInfo[] {
    return this.modelsOf(this.provider(providerId), this.loadDiscovery(providerId));
  }

  /**
   * What the provider list shows of one provider, from one look at its discovery. A provider whose cache file is
   * missing was asked for it again for every model, three times over: 3,004 reads for 1,000 configured models.
   */
  providerListing(p: ResolvedProvider): { configured: boolean; models: ModelInfo[]; error?: string } {
    const discovery = this.loadDiscovery(p.id);
    const models = this.modelsOf(p, discovery);
    const configured = this.canRequest(p) && (p.auth !== 'none' || models.length > 0);
    return { configured, models, error: this.discoveryProblem(p, discovery?.error) };
  }

  private modelsOf(p: ResolvedProvider, disc: DiscoveryCache | undefined): ModelInfo[] {
    const ids = new Set<string>(Object.keys(p.settings.models ?? {}));
    for (const m of disc?.models ?? []) ids.add(m.id);
    if (!ids.size) return [];
    const index = this.discoveryIndex(disc);
    return [...ids].map((id) => this.modelInfo(p, id, index)).filter((m) => !m.hidden);
  }

  private discoveryIndex(cache: DiscoveryCache | undefined): DiscoveryIndex | undefined {
    if (!cache) return undefined;
    let index = this.indexes.get(cache);
    if (!index) {
      index = { byId: new Map(), byApiId: new Map() };
      for (const m of cache.models) {
        if (!index.byId.has(m.id)) index.byId.set(m.id, m);
        if (m.apiId === undefined) continue;
        const same = index.byApiId.get(m.apiId);
        if (same) same.push(m);
        else index.byApiId.set(m.apiId, [m]);
      }
      this.indexes.set(cache, index);
    }
    return index;
  }

  private modelInfo(p: ResolvedProvider, id: string, index: DiscoveryIndex | undefined): ModelInfo {
    const alias = index?.byApiId.get(id)?.find((m) => m.id !== id);
    if (alias) return this.modelInfo(p, alias.id, index);
    const fam = familyDefaults(id);
    const disc = index?.byId.get(id);
    const configured = p.settings.models?.[id] ?? {};
    const quirks: Quirks = { ...(fam.quirks ?? {}), ...p.quirks, ...(configured.quirks ?? {}) };
    // Where the provider says nothing, what models.dev says about the model (on this provider, or from its vendor).
    const reg = disc?.efforts && disc.contextWindow ? undefined : this.loadRegistry()?.lookup(p, id);
    const learned = this.learnedEfforts(`${p.id}/${id}`);
    // A model nobody describes: not the settings, not the server, not models.dev, not its name. It used to get
    // 32768 everywhere, a quarter of the smallest window any named family has: a new model on a hosted endpoint or
    // a relay compacted every few requests with nothing to say why (one ran in 32k beside its siblings' 131k). There
    // it is far more often a new large model than a small one, and a window set too large is learned from the
    // server's first refusal (the session plans a tenth under what was refused). A local engine keeps the small
    // figure: it cuts a prompt that does not fit without a word.
    // Once its server has refused a request for size, what that showed stands in for the guess (learnWindow).
    const undescribed = this.learnedWindow(`${p.id}/${id}`) ?? (p.discover === 'ollama' || p.discover === 'llamacpp' ? 32768 : 128_000);
    let efforts = (configured.efforts ?? learned ?? disc?.efforts ?? offered(reg, p.api, quirks) ?? fam.efforts ?? []).filter((e) => SUPPORTED_EFFORTS.has(e));
    const defaultEffort = configured.defaultEffort ?? disc?.defaultEffort ?? fam.defaultEffort ?? 'high';
    if (efforts.length && !efforts.includes(defaultEffort) && defaultEffort !== 'off') efforts = efforts;
    return {
      ref: `${p.id}/${id}`,
      provider: p.id,
      id,
      apiId: disc?.apiId,
      name: configured.name ?? disc?.name ?? prettyName(id),
      family: configured.family ?? disc?.family ?? fam.family,
      contextWindow: configured.contextWindow ?? disc?.contextWindow ?? reg?.context ?? fam.contextWindow ?? undescribed,
      nativeWindow: disc?.contextWindow ?? reg?.context ?? fam.contextWindow ?? undescribed,
      ...(disc?.contextWindow ?? reg?.context ?? fam.contextWindow ? {} : { windowAssumed: true }),
      maxOutput: configured.maxOutput ?? disc?.maxOutput ?? fam.maxOutput ?? 8192,
      efforts,
      defaultEffort,
      // What the catalogue says too when the provider described the rest: a relay lists no inputs.
      vision: configured.vision ?? disc?.vision ?? (reg ?? this.loadRegistry()?.lookup(p, id))?.vision ?? fam.vision ?? false,
      toolProfile: configured.toolProfile ?? surface(this.config.tools ?? DEFAULTS.tools) ?? fam.toolProfile ?? 'claude',
      pricing: configured.pricing,
      quirks,
      description: configured.description ?? disc?.description,
      hidden: configured.hidden ?? disc?.hidden,
      thinkingDisplay: configured.thinkingDisplay,
      discovered: !!disc,
    };
  }

  /**
   * Resolve "provider/model", a bare model id, or the configured default.
   * Unknown ids on a known provider are allowed: family rules supply sensible limits.
   */
  resolve(ref?: string): ModelInfo {
    const want = ref || this.config.model;
    if (!want) {
      const first = this.firstUsable();
      if (!first) throw new Error(`No model configured. Sign in with \`favilla login\`, set an API key, or set "model" in ${appPath('config.json')}.`);
      return first;
    }
    const found = this.findModel(want);
    if (found) return this.modelInfo(found.provider, found.id, this.discoveryIndex(found.discovery));
    throw new Error(`Unknown model "${want}". Use provider/model, e.g. openai/gpt-6-luna.`);
  }

  private findModel(want: string): { provider: ResolvedProvider; id: string; discovery?: DiscoveryCache } | undefined {
    const slash = want.indexOf('/');
    const providers = this.providers();
    if (slash > 0) {
      const provider = providers.find((p) => p.id === want.slice(0, slash));
      if (provider) return { provider, id: want.slice(slash + 1), discovery: this.loadDiscovery(provider.id) };
    }
    for (const provider of providers) {
      const discovery = this.loadDiscovery(provider.id);
      if (provider.settings.models?.[want] || discovery?.models.some((m) => m.id === want)) return { provider, id: want, discovery };
    }
  }

  /** Unlisted models on a known relay are usable. */
  defaultAvailable(): boolean {
    if (!this.config.model) return true;
    const found = this.findModel(this.config.model);
    return !!found?.provider.enabled && !!found.provider.baseUrl;
  }

  private firstUsable(): ModelInfo | undefined {
    for (const p of this.providers()) {
      if (!this.isConfigured(p)) continue;
      const models = this.models(p.id);
      if (models.length) return models[0];
    }
    return undefined;
  }

  private cacheFile(providerId: string): string {
    return appPath('cache', `models-${providerId}.json`);
  }

  private loadDiscovery(providerId: string): DiscoveryCache | undefined {
    let c = this.discovered.get(providerId);
    if (!c) {
      try {
        c = JSON.parse(fs.readFileSync(this.cacheFile(providerId), 'utf8')) as DiscoveryCache;
        if (!Number.isFinite(c?.fetched) || !Array.isArray(c.models) || (c.error !== undefined && typeof c.error !== 'string')
          || c.models.some((m) => typeof m?.id !== 'string'
            || (m.efforts != null && (!Array.isArray(m.efforts) || m.efforts.some((e) => !SUPPORTED_EFFORTS.has(e))))
            || [m.apiId, m.name, m.description, m.family].some((v) => v !== undefined && typeof v !== 'string')
            || [m.contextWindow, m.maxOutput].some((v) => v !== undefined && !Number.isFinite(v))
            || [m.vision, m.hidden].some((v) => v !== undefined && typeof v !== 'boolean')
            || (m.defaultEffort !== undefined && !SUPPORTED_EFFORTS.has(m.defaultEffort)))) return undefined;
        this.discovered.set(providerId, c);
      } catch {
        return undefined;
      }
    }
    return c;
  }

  /** Ask the provider which models it serves; cached on disk. */
  async discover(providerId: string, force = false): Promise<ModelInfo[]> {
    const p = this.provider(providerId);
    if (!p.discover || !this.canRequest(p)) return this.models(providerId);
    const file = this.cacheFile(providerId);
    const cached = this.loadDiscovery(providerId);
    const ttl = p.local ? LOCAL_TTL : REMOTE_TTL;
    if (!force && cached && Date.now() - cached.fetched < ttl && !cached.error) return this.models(providerId);
    let job = this.inflight.get(providerId);
    if (!job) {
      job = runDiscovery(p, this).finally(() => this.inflight.delete(providerId));
      this.inflight.set(providerId, job);
    }
    try {
      const models = await job;
      const entry: DiscoveryCache = { fetched: Date.now(), models };
      this.discovered.set(providerId, entry);
      ensureDir(path.dirname(file));
      writeFileAtomic(file, JSON.stringify(entry, null, 1));
    } catch (e) {
      const error = this.discoveryProblem(p, (e as Error).message);
      debug('catalog', `discovery failed for ${providerId}`, error);
      // Kept in memory with no models when nothing was listed before: a new provider whose key the server turns
      // down says so instead of showing only the models typed in by hand as if they had been checked.
      this.discovered.set(providerId, cached ? { ...cached, error } : { fetched: 0, models: [], error });
    }
    return this.models(providerId);
  }

  private discoveryProblem(p: ResolvedProvider, error?: string): string | undefined {
    if (!error) return error;
    return redactSecrets(error, [...p.keys, ...Object.entries(p.headers).filter(([k]) => !PUBLIC_HEADERS.has(k.toLowerCase())).map(([, v]) => v), ...addressView(p.baseUrl, true).hidden, ...addressView(p.proxy || '').hidden]);
  }

  discoveryError(providerId: string): string | undefined {
    const error = this.loadDiscovery(providerId)?.error;
    return error ? this.discoveryProblem(this.provider(providerId), error) : error;
  }

  private loadRegistry(): Registry | undefined {
    if (this.config.modelRegistry === false) return undefined;
    if (this.registry === undefined) {
      const data = readRegistry();
      this.registry = data ? new Registry(data) : null;
    }
    return this.registry ?? undefined;
  }

  /**
   * Fetch models.dev again when the copy is a few days old (or missing). Resolves true when it changed, so
   * open sessions and the model lists can take the new levels; never throws.
   */
  refreshRegistry(force = false): Promise<boolean> {
    if (this.config.modelRegistry === false) return Promise.resolve(false);
    const current = this.loadRegistry();
    if (!force && current && Date.now() - current.data.fetched < REGISTRY_TTL) return Promise.resolve(false);
    if (!force && Date.now() - this.registryFailed < REGISTRY_RETRY) return Promise.resolve(false);
    this.registryJob ??= fetchRegistry(this.config.proxy ?? envProxy() ?? false)
      .then((data) => {
        this.registry = new Registry(data);
        return true;
      })
      .catch((e) => {
        this.registryFailed = Date.now();
        debug('catalog', 'models.dev fetch failed', String(e));
        return false;
      })
      .finally(() => {
        this.registryJob = undefined;
      });
    return this.registryJob;
  }

  private learnedFile(): string {
    return appPath('cache', 'efforts-learned.json');
  }

  private learnedEfforts(ref: string): Effort[] | undefined {
    this.learned ??= readCache(this.learnedFile());
    const hit = this.learned[ref];
    return hit && Number.isFinite(hit.at) && Date.now() - hit.at < LEARNED_TTL && Array.isArray(hit.efforts) && hit.efforts.every((e) => SUPPORTED_EFFORTS.has(e)) ? hit.efforts : undefined;
  }

  private windowsFile(): string {
    return appPath('cache', 'windows-learned.json');
  }

  private learnedWindow(ref: string): number | undefined {
    this.windows ??= readCache(this.windowsFile());
    const hit = this.windows[ref];
    return hit && Number.isFinite(hit.at) && Date.now() - hit.at < WINDOW_TTL && Number.isFinite(hit.window) && hit.window > 8192 ? hit.window : undefined;
  }

  /**
   * Keep the window a server's refusal showed for a model whose window nothing states, so the next session plans
   * for it from its first request instead of running into the same refusal. Only ever smaller than what stands,
   * and only for such a model: where someone states a window, one refusal does not outweigh them past the session.
   */
  learnWindow(ref: string, window: number): void {
    const known = this.learnedWindow(ref);
    if (!(window > 8192) || (known !== undefined && known <= window)) return;
    this.windows = { ...this.windows, [ref]: { window: Math.floor(window), at: Date.now() } };
    try {
      ensureDir(path.dirname(this.windowsFile()));
      writeFileAtomic(this.windowsFile(), JSON.stringify(this.windows, null, 1));
    } catch (e) {
      debug('catalog', 'could not keep a learned window', String(e));
    }
  }

  /** Keep the levels a server said a model takes (empty: it takes no level at all), ahead of every other source. */
  learnEfforts(ref: string, efforts: Effort[]): void {
    this.learnedEfforts(ref);
    this.learned = { ...this.learned, [ref]: { efforts: efforts.filter((e) => SUPPORTED_EFFORTS.has(e)), at: Date.now() } };
    try {
      ensureDir(path.dirname(this.learnedFile()));
      writeFileAtomic(this.learnedFile(), JSON.stringify(this.learned, null, 1));
    } catch (e) {
      debug('catalog', 'could not keep learned efforts', String(e));
    }
  }
}

/** Chat-completions switches Favilla knows how to send; elsewhere the adapter turns thinking off its own way. */
const CHAT_SWITCHES = ['deepseek', 'glm', 'qwen', 'llamacpp', 'openrouter'];

/**
 * The levels to offer from what models.dev says: "off" for an on-off switch only where Favilla can send that switch,
 * and nothing when a single level is all there would be to pick.
 */
function offered(reg: RegistryHit | undefined, api: ApiKind, quirks: Quirks): Effort[] | undefined {
  if (!reg?.efforts) return undefined;
  const canSwitch = reg.toggle && (api !== 'openai-chat' || CHAT_SWITCHES.includes(quirks.thinkingParam ?? ''));
  const all = canSwitch ? ['off' as Effort, ...reg.efforts.filter((e) => e !== 'off')] : reg.efforts;
  return all.length > 1 ? all : [];
}

function prettyName(id: string): string {
  const base = id.split(/[\\/]/).pop()!.replace(/\.gguf$/i, '');
  return base;
}

async function getJson(url: string, p: ResolvedProvider, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<any> {
  const res = await http(url, { headers: { 'User-Agent': USER_AGENT, ...p.headers, ...headers }, proxy: p.proxy, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const NON_CHAT = /embed|tts|whisper|dall-e|image|imagen|audio|realtime|moderation|transcri|search-preview|veo|lyria|aqa|robotics|computer-use|deep-research|nano-banana|antigravity|live|native-audio|omni/i;

function normEfforts(list: unknown): Effort[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out = list.map((x) => (typeof x === 'string' ? x : (x as { effort?: string }).effort)).filter((x): x is Effort => !!x && SUPPORTED_EFFORTS.has(x as Effort));
  return out.length ? out : undefined;
}

async function runDiscovery(p: ResolvedProvider, catalog: Catalog): Promise<DiscoveredModel[]> {
  const key = p.keys[0];
  switch (p.discover) {
    case 'anthropic': {
      const j = await getJson(`${p.baseUrl}/v1/models?limit=100`, p, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
      return (j.data ?? []).map((m: any) => ({
        id: m.id,
        name: m.display_name,
        contextWindow: m.max_input_tokens,
        maxOutput: m.max_tokens,
      }));
    }
    case 'gemini': {
      const j = await getJson(`${p.baseUrl}/models?pageSize=200`, p, { 'x-goog-api-key': key });
      return (j.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent') && !NON_CHAT.test(m.name))
        .map((m: any) => ({
          id: String(m.name).replace(/^models\//, ''),
          name: m.displayName,
          description: m.description,
          contextWindow: m.inputTokenLimit,
          maxOutput: m.outputTokenLimit,
        }));
    }
    case 'llamacpp': {
      const origin = p.baseUrl.replace(/\/v1$/, '');
      const [props, list] = await Promise.all([getJson(`${origin}/props`, p, {}, 4000).catch(() => null), getJson(`${p.baseUrl}/models`, p, {}, 4000)]);
      const nCtx: number | undefined = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
      const vision = props?.modalities?.vision;
      const name = props?.model_path ? prettyName(String(props.model_path)) : undefined;
      return (list.data ?? []).map((m: any) => {
        // A model loaded by path is listed under that path; refer to it by its file name instead.
        const short = /[\\/]|\.gguf$/i.test(m.id) ? prettyName(m.id) : m.id;
        return {
          id: short,
          apiId: short !== m.id ? m.id : undefined,
          name: name ?? prettyName(m.id),
          contextWindow: nCtx ?? m.meta?.n_ctx_train,
          vision: typeof vision === 'boolean' ? vision : undefined,
        };
      });
    }
    case 'ollama': {
      const origin = p.baseUrl.replace(/\/v1$/, '');
      const tags = await getJson(`${origin}/api/tags`, p, {}, 4000);
      return (tags.models ?? []).map((m: any) => ({ id: m.name, name: m.name }));
    }
    case 'openai': {
      const j = await getJson(`${p.baseUrl}/models`, p, key ? { Authorization: `Bearer ${key}` } : {});
      return (j.data ?? [])
        .filter((m: any) => !NON_CHAT.test(m.id))
        .map((m: any) => ({ id: m.id, contextWindow: m.context_length ?? m.context_window ?? m.max_model_len, name: m.name }));
    }
    default:
      return [];
  }
}
