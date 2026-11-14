/**
 * What models.dev (an open catalogue of models and the providers that serve them, kept by the OpenCode project)
 * says about a model: the thinking levels it takes and its context window. Favilla keeps a slim copy of only those
 * fields, refreshed every few days in the background, and uses it where the provider itself says nothing, so a
 * model served through any relay gets its real levels without anyone listing them by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Effort } from '../types';
import { EFFORT_ORDER } from '../types';
import { isObject } from '../config/schema';
import { http } from '../net/http';
import { writeFileAtomic } from '../auth/store';
import { appPath, ensureDir } from '../util/paths';

export const REGISTRY_URL = 'https://models.dev/api.json';

/** One model as the slim copy keeps it. */
export interface SlimModel {
  /** Levels of an effort setting, on Favilla's scale ('none' read as 'off'). */
  e?: Effort[];
  /** Thinking can be switched on and off. */
  t?: true;
  /** Thinking is set by a token budget. */
  b?: true;
  /** The model does not think. */
  n?: true;
  /** It thinks, and nothing about it can be set. */
  x?: true;
  /** Context window in tokens. */
  c?: number;
  /** "vendor/model" this entry serves. */
  k?: string;
  /** It reads pictures (models.dev lists image among its inputs). */
  i?: true;
}

/** The slim copy's format: a copy in an older one is fetched again (version 2 keeps which models read pictures). */
export const SLIM_VERSION = 2;

export interface SlimRegistry {
  v?: number;
  fetched: number;
  providers: Record<string, { api?: string; models: Record<string, SlimModel> }>;
}

export interface RegistryHit {
  /** Levels of the effort setting ('off' when it takes "none"); empty when nothing can be set; absent when the catalogue does not say. */
  efforts?: Effort[];
  /** Thinking has its own on-off switch besides the levels. */
  toggle?: boolean;
  context?: number;
  /** It reads pictures; absent when the catalogue does not say. */
  vision?: boolean;
}

const LEVELS = new Set<string>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function level(v: unknown): Effort | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  if (s === 'none' || s === 'off') return 'off';
  return LEVELS.has(s) ? (s as Effort) : undefined;
}

function ordered(list: Effort[]): Effort[] {
  return [...new Set(list)].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

/** The catalogue cut down to what Favilla reads; anything of another shape is left out. */
export function slimRegistry(raw: unknown, now = Date.now()): SlimRegistry {
  const providers: SlimRegistry['providers'] = {};
  if (!raw || typeof raw !== 'object') return { v: SLIM_VERSION, fetched: now, providers };
  for (const [pid, p] of Object.entries(raw as Record<string, unknown>)) {
    const prov = p as { api?: unknown; models?: unknown };
    if (!prov || typeof prov !== 'object' || !prov.models || typeof prov.models !== 'object') continue;
    const models: Record<string, SlimModel> = {};
    for (const [mid, m] of Object.entries(prov.models as Record<string, unknown>)) {
      const model = m as { reasoning?: unknown; reasoning_options?: unknown; limit?: { context?: unknown }; canonical_model_id?: unknown; modalities?: { input?: unknown } };
      if (!model || typeof model !== 'object') continue;
      const s: SlimModel = {};
      if (model.reasoning === false) s.n = true;
      else if (Array.isArray(model.reasoning_options)) {
        for (const o of model.reasoning_options as { type?: unknown; values?: unknown }[]) {
          if (o?.type === 'toggle') s.t = true;
          else if (o?.type === 'budget_tokens') s.b = true;
          else if (o?.type === 'effort' && Array.isArray(o.values)) {
            const e = o.values.map(level).filter((x): x is Effort => !!x);
            if (e.length) s.e = ordered(e);
          }
        }
        if (model.reasoning === true && !model.reasoning_options.length) s.x = true;
      }
      const ctx = Number(model.limit?.context);
      if (Number.isFinite(ctx) && ctx >= 1024) s.c = Math.round(ctx);
      if (typeof model.canonical_model_id === 'string' && model.canonical_model_id.includes('/')) s.k = model.canonical_model_id.toLowerCase();
      if (Array.isArray(model.modalities?.input) && model.modalities.input.includes('image')) s.i = true;
      if (Object.keys(s).length) models[mid.toLowerCase()] = s;
    }
    providers[pid.toLowerCase()] = { ...(typeof prov.api === 'string' ? { api: prov.api } : {}), models };
  }
  return { v: SLIM_VERSION, fetched: now, providers };
}

/** How a slim entry's thinking is steered, or nothing when it says nothing usable. */
function steering(s: SlimModel): Pick<RegistryHit, 'efforts' | 'toggle'> | undefined {
  if (s.n || s.x) return { efforts: [] };
  if (s.e) return s.t ? { efforts: s.e, toggle: true } : { efforts: s.e };
  if (s.t && !s.b) return { efforts: ['high'], toggle: true };
  return undefined;
}

/** Host and path, without a trailing "/v1": the same endpoint written two ways compares equal. */
function endpoint(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '');
  } catch {
    return undefined;
  }
}

/** Favilla's names for first-party providers the catalogue lists under another name. */
const ALIASES: Record<string, string> = { gemini: 'google' };

export class Registry {
  private byTail?: Map<string, SlimModel[]>;
  /** Each address's entry, the first listed for it. */
  private byEndpoint?: Map<string, SlimRegistry['providers'][string]>;
  /**
   * The entry found for each provider asked about. Every model of a provider asks for the same one: a relay serving
   * 913 models had the catalogue's hundred addresses parsed for each, 0.6 s of every session start (2026-11-07).
   */
  private matched = new Map<string, SlimRegistry['providers'][string] | undefined>();

  constructor(readonly data: SlimRegistry) {}

  /** The catalogue's entry for this provider: by its address, else, for a first-party API listed without one, by name. */
  private provider(p: { id: string; baseUrl: string }): SlimRegistry['providers'][string] | undefined {
    const key = `${p.id}\n${p.baseUrl}`;
    if (this.matched.has(key)) return this.matched.get(key);
    const want = endpoint(p.baseUrl);
    if (!this.byEndpoint) {
      this.byEndpoint = new Map();
      for (const x of Object.values(this.data.providers)) {
        const at = endpoint(x.api);
        if (at !== undefined && !this.byEndpoint.has(at)) this.byEndpoint.set(at, x);
      }
    }
    const exact = want ? this.byEndpoint.get(want) : undefined;
    const named = this.data.providers[ALIASES[p.id] ?? p.id];
    const found = exact ?? (named && !named.api ? named : undefined);
    this.matched.set(key, found);
    return found;
  }

  /** Every entry for a model id, under any provider ("vendor/model" ids by their last part). */
  private entries(tail: string): SlimModel[] {
    if (!this.byTail) {
      this.byTail = new Map();
      for (const prov of Object.values(this.data.providers)) {
        for (const [id, m] of Object.entries(prov.models)) {
          const key = id.slice(id.lastIndexOf('/') + 1);
          const list = this.byTail.get(key);
          if (list) list.push(m);
          else this.byTail.set(key, [m]);
        }
      }
    }
    return this.byTail.get(tail) ?? [];
  }

  /**
   * What the catalogue says about a model on a provider: the provider's own entry when it is listed; otherwise
   * the vendor's entry for the model (found through any entry that names it); otherwise what most entries say.
   */
  lookup(p: { id: string; baseUrl: string }, modelId: string): RegistryHit | undefined {
    const id = modelId.toLowerCase();
    const tail = id.slice(id.lastIndexOf('/') + 1);
    const own = this.provider({ id: p.id.toLowerCase(), baseUrl: p.baseUrl });
    const direct = own?.models[id] ?? own?.models[tail];
    // models.dev lists every model's inputs, so an entry without image is one that reads none.
    const mine = direct ? { ...steering(direct), context: direct.c, vision: !!direct.i } : undefined;
    if (mine?.efforts) return mine;
    const elsewhere = this.elsewhere(tail);
    if (!mine && !elsewhere) return undefined;
    return { efforts: elsewhere?.efforts, toggle: elsewhere?.toggle, context: mine?.context ?? elsewhere?.context, vision: mine?.vision ?? elsewhere?.vision };
  }

  /** The vendor's own entry for a model, found through any entry that names it; else what most entries say. */
  private elsewhere(tail: string): RegistryHit | undefined {
    const others = this.entries(tail);
    if (!others.length) return undefined;
    for (const m of others) {
      if (!m.k) continue;
      const cut = m.k.indexOf('/');
      const vendor = this.data.providers[m.k.slice(0, cut)]?.models[m.k.slice(cut + 1)];
      if (vendor && (steering(vendor) || vendor.c)) return { ...steering(vendor), context: vendor.c, vision: !!vendor.i };
    }
    return {
      ...mostCommon(others.map(steering).filter((x): x is NonNullable<typeof x> => !!x)),
      context: mostCommon(others.map((m) => m.c).filter((c): c is number => !!c)),
      // Served with pictures anywhere, the model reads them.
      vision: others.some((m) => m.i),
    };
  }
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<string, { v: T; n: number }>();
  for (const v of values) {
    const key = JSON.stringify(v);
    const c = counts.get(key);
    if (c) c.n++;
    else counts.set(key, { v, n: 1 });
  }
  let best: { v: T; n: number } | undefined;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.v;
}

export function registryFile(): string {
  return appPath('cache', 'models-dev.json');
}

export function readRegistry(): SlimRegistry | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(registryFile(), 'utf8')) as SlimRegistry;
    if (!Number.isFinite(data?.fetched) || data.v !== SLIM_VERSION || !isObject(data.providers)) return undefined;
    for (const p of Object.values(data.providers)) {
      if (!isObject(p) || (p.api !== undefined && typeof p.api !== 'string') || !isObject(p.models)) return undefined;
      if (Object.values(p.models).some((m) => !isObject(m)
        || (m.e !== undefined && (!Array.isArray(m.e) || !m.e.every((e) => EFFORT_ORDER.includes(e))))
        || (m.k !== undefined && typeof m.k !== 'string')
        || (m.c !== undefined && !Number.isFinite(m.c))
        || ['t', 'b', 'n', 'x', 'i'].some((key) => m[key] !== undefined && m[key] !== true))) return undefined;
    }
    return data;
  } catch {
    return undefined;
  }
}

/** Download the catalogue and keep the slim copy on disk. */
export async function fetchRegistry(proxy: string | false, signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<SlimRegistry> {
  const file = registryFile();
  const res = await http(REGISTRY_URL, { proxy, signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`models.dev -> ${res.status}`);
  if (Number(res.headers.get('content-length')) > 64 * 1024 * 1024) throw new Error('models.dev: the catalogue is larger than expected');
  const slim = slimRegistry(await res.json());
  if (Object.keys(slim.providers).length < 5) throw new Error('models.dev: the catalogue came back nearly empty');
  ensureDir(path.dirname(file));
  writeFileAtomic(file, JSON.stringify(slim));
  return slim;
}
