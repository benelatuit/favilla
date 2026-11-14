import fs from 'node:fs';
import path from 'node:path';
import type { Message } from '../types';
import { stableStringify } from '../util/json';
import { appPath, projectSlug } from '../util/paths';
import { checkSettings, settingBasis, SettingsConflict, type SettingBasis, type SettingPath } from '../config/document';
import { editLibrary, libraryChoice, listLibrary, readLibrary, saveLibraryChoice, type LibraryReport } from './library';

/**
 * Prompt presets as SillyTavern exports them. What comes in is the prompts, which layer and role each belongs to,
 * and the prefill. Nothing else does: a preset also holds temperatures, model names, reverse proxies and proxy
 * passwords, and those are never read.
 *
 * A preset never enters a session's history. Its leading system prompts join the system prompt; the rest is placed
 * into each request as it goes out, so the record stays what was said. A session keeps the copy it started with, and
 * sub-agents have none.
 */
export type PresetRole = 'system' | 'user' | 'assistant';

export interface PresetEntry {
  id: string;
  name: string;
  role: PresetRole;
  content: string;
  enabled: boolean;
  /** before: ahead of the conversation; after: behind it; depth: inside it, `depth` messages from the end. */
  place: 'before' | 'after' | 'depth';
  depth?: number;
  order?: number;
}

export interface Preset {
  name: string;
  format: 'sillytavern';
  entries: PresetEntry[];
  prefill?: string;
  /** What {{user}} and {{char}} stand for. */
  user?: string;
  char?: string;
  imported: number;
}

export interface PresetReport {
  entries: number;
  off: number;
  /** Markers for what Favilla has no equivalent of (character cards, world info): left out. */
  markers: string[];
  /** Macros in the prompts that Favilla does not know: they go out as they are written. */
  macros: string[];
  /** Macros for what a character card would fill in: with no card they come out empty. */
  blank: string[];
}

export type PresetScope = 'global' | 'workspace';

/**
 * What a folder uses: the global choice, none, a preset of the one library by name (no copy kept per folder), or
 * a copy of its own (how folders kept presets before there was one library).
 */
export type WorkspaceChoice = { use: 'global' } | { use: 'none' } | { use: 'library'; name: string } | { use: 'own'; name: string };

const KNOWN_MACROS = new Set(['user', 'char', 'trim', 'noop', 'newline', 'random', 'pick', 'roll', 'date', 'time', 'weekday', 'isodate', 'isotime', 'setvar', 'getvar', 'addvar', 'incvar', 'decvar', 'setglobalvar', 'getglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar', 'lastmessage', 'lastusermessage', 'lastcharmessage', 'model']);
const BLANK_MACROS = new Set(['description', 'personality', 'scenario', 'persona', 'mesexamples', 'mesexamplesraw', 'charprompt', 'charinstruction', 'charjailbreak', 'chardepthprompt', 'charcreatornotes', 'charversion', 'wibefore', 'wiafter', 'loreoutlet', 'group', 'charifnotgroup', 'groupnotmuted', 'notchar']);
/** SillyTavern's id for the order used when no character is chosen. */
const GLOBAL_ORDER = 100001;

function macroNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const body = m[1].trim();
    if (body.startsWith('//')) continue;
    const name = /^[a-zA-Z_]+/.exec(body)?.[0]?.toLowerCase();
    if (name) out.push(name);
  }
  return out;
}

/** A SillyTavern chat-completion preset as Favilla keeps it. Throws with a plain reason when the file is not one. */
export function parseTavernPreset(raw: unknown, name: string): { preset: Preset; report: PresetReport } {
  const src = raw as { prompts?: unknown; prompt_order?: unknown; assistant_prefill?: unknown };
  if (!src || typeof src !== 'object' || !Array.isArray(src.prompts)) throw new Error('This is not a SillyTavern chat-completion preset: it has no prompts list.');
  const prompts = new Map<string, Record<string, unknown>>();
  for (const p of src.prompts as Record<string, unknown>[]) if (p && typeof p.identifier === 'string') prompts.set(p.identifier, p);
  const orders = Array.isArray(src.prompt_order) ? (src.prompt_order as { character_id?: number; order?: { identifier: string; enabled?: boolean }[] }[]) : [];
  const chosen = orders.find((o) => o.character_id === GLOBAL_ORDER && Array.isArray(o.order)) ?? [...orders].reverse().find((o) => Array.isArray(o.order));
  // A preset with no order lists its prompts in their own order, all on.
  const order = chosen?.order ?? [...prompts.keys()].map((identifier) => ({ identifier, enabled: true }));
  const entries: PresetEntry[] = [];
  const markers: string[] = [];
  let pastChat = false;
  for (const o of order) {
    const p = prompts.get(o.identifier);
    if (!p) continue;
    if (o.identifier === 'chatHistory') {
      pastChat = true;
      continue;
    }
    if (p.marker) {
      if (o.enabled !== false) markers.push(String(p.name ?? o.identifier));
      continue;
    }
    const content = typeof p.content === 'string' ? p.content : '';
    if (!content.trim()) continue;
    const role: PresetRole = p.role === 'user' ? 'user' : p.role === 'assistant' || p.role === 'model' ? 'assistant' : 'system';
    const inChat = Number(p.injection_position) === 1;
    entries.push({
      id: o.identifier,
      name: typeof p.name === 'string' && p.name ? p.name : o.identifier,
      role,
      content,
      enabled: o.enabled !== false,
      place: inChat ? 'depth' : pastChat ? 'after' : 'before',
      ...(inChat ? { depth: Math.max(0, Math.round(Number(p.injection_depth ?? 4))), order: Number(p.injection_order ?? 100) } : {}),
    });
  }
  const prefill = typeof src.assistant_prefill === 'string' && src.assistant_prefill.trim() ? src.assistant_prefill : undefined;
  const named = [...new Set(entries.flatMap((e) => macroNames(e.content)).concat(prefill ? macroNames(prefill) : []))];
  return {
    preset: { name, format: 'sillytavern', entries, ...(prefill ? { prefill } : {}), imported: Date.now() },
    report: {
      entries: entries.length,
      off: entries.filter((e) => !e.enabled).length,
      markers,
      macros: named.filter((n) => !KNOWN_MACROS.has(n) && !BLANK_MACROS.has(n)),
      blank: named.filter((n) => BLANK_MACROS.has(n)),
    },
  };
}

export interface MacroContext {
  user: string;
  char: string;
  /** Stable for a session: {{random}} picks the same thing each request, which keeps the provider's cache. */
  seed: string;
  now: number;
  /** {{setvar}} in one prompt is read by {{getvar}} in a later one of the same request. */
  vars: Map<string, string>;
  model?: string;
  lastUser?: string;
  lastChar?: string;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** SillyTavern's macros, the ones that mean something without a character card. Others stay as they are written. */
export function renderMacros(text: string, c: MacroContext): string {
  const { vars } = c;
  let picks = 0;
  const draw = () => hash(`${c.seed}:${hash(text)}:${picks++}`);
  const choose = (list: string[]) => list[draw() % list.length] ?? '';
  const d = new Date(c.now);
  const iso = d.toISOString();
  const one = (body: string, whole: string): string => {
    const m = /^([a-zA-Z_]+)(?:\s*(::|:)\s*|\s+|$)([\s\S]*)$/.exec(body.trim());
    if (!m) return whole;
    const name = m[1].toLowerCase();
    if (BLANK_MACROS.has(name)) return '';
    const rest = m[3] ?? '';
    const args = m[2] === '::' ? rest.split('::') : rest.split(',').map((x) => x.trim());
    const value = m[2] === '::' ? args.slice(1).join('::') : (args[1] ?? '');
    const num = (k: string) => Number(vars.get(k) ?? 0) || 0;
    switch (name) {
      case 'user':
        return c.user;
      case 'char':
        return c.char;
      case 'noop':
        return '';
      case 'newline':
        return '\n';
      case 'random':
      case 'pick':
        return choose(args);
      case 'roll': {
        const r = /^(\d*)d(\d+)$/i.exec(rest.trim()) ?? /^()(\d+)$/.exec(rest.trim());
        if (!r) return whole;
        let total = 0;
        for (let i = 0; i < Math.max(1, Number(r[1]) || 1); i++) total += 1 + draw() % Math.max(1, Number(r[2]));
        return String(total);
      }
      case 'date':
        return d.toLocaleDateString();
      case 'time':
        return d.toLocaleTimeString();
      case 'weekday':
        return d.toLocaleDateString(undefined, { weekday: 'long' });
      case 'isodate':
        return iso.slice(0, 10);
      case 'isotime':
        return iso.slice(11, 16);
      case 'setvar':
      case 'setglobalvar':
        vars.set(args[0], value);
        return '';
      case 'getvar':
      case 'getglobalvar':
        return vars.get(args[0]) ?? '';
      case 'addvar':
      case 'addglobalvar': {
        const by = Number(value);
        vars.set(args[0], value && Number.isFinite(by) ? String(num(args[0]) + by) : `${vars.get(args[0]) ?? ''}${value}`);
        return '';
      }
      case 'incvar':
      case 'incglobalvar':
        vars.set(args[0], String(num(args[0]) + 1));
        return vars.get(args[0])!;
      case 'decvar':
      case 'decglobalvar':
        vars.set(args[0], String(num(args[0]) - 1));
        return vars.get(args[0])!;
      case 'lastusermessage':
        return c.lastUser ?? '';
      case 'lastcharmessage':
        return c.lastChar ?? '';
      case 'lastmessage':
        return c.lastUser ?? c.lastChar ?? '';
      case 'model':
        return c.model ?? '';
      default:
        return whole;
    }
  };
  let out = text.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
  // Inside out, so a macro can stand in another's argument; one left as it is is set aside until the end.
  const kept: string[] = [];
  for (let pass = 0; pass < 6 && /\{\{/.test(out); pass++) {
    const before = out;
    out = out.replace(/\{\{([^{}]*)\}\}/g, (whole, body: string) => {
      if (body.trim().toLowerCase() === 'trim') return '\u0001';
      const done = one(body, whole);
      if (done !== whole) return done;
      kept.push(whole);
      return `\u0002${kept.length - 1}\u0003`;
    });
    if (out === before) break;
  }
  out = out.replace(/\s*\u0001\s*/g, '');
  return out.replace(/\u0002(\d+)\u0003/g, (_, i: string) => kept[Number(i)]);
}

const text = (m: Message) => m.parts.filter((p) => p.type === 'text' && !(p as { synthetic?: boolean }).synthetic).map((p) => (p as { text: string }).text).join('\n');

/** The context macros render in, from the conversation as it stands. */
export function macroContext(preset: Preset, seed: string, now: number, model: string, messages: Message[]): MacroContext {
  const lastOf = (want: (m: Message) => boolean) => {
    for (let i = messages.length - 1; i >= 0; i--) if (want(messages[i]) && text(messages[i])) return text(messages[i]);
    return undefined;
  };
  return {
    user: preset.user?.trim() || 'User',
    char: preset.char?.trim() || 'Assistant',
    seed,
    now,
    vars: new Map(),
    model,
    lastUser: lastOf((m) => m.role === 'user' && m.origin === 'user'),
    lastChar: lastOf((m) => m.role === 'assistant'),
  };
}

const ahead = (p: Preset) => p.entries.filter((e) => e.enabled && e.place === 'before');

/** The system prompts that open the preset: they go where SillyTavern puts them, in the system prompt, in their order. */
function leading(p: Preset): PresetEntry[] {
  const list = ahead(p);
  const stop = list.findIndex((e) => e.role !== 'system');
  return stop < 0 ? list : list.slice(0, stop);
}

/** What the preset adds to the system prompt. */
export function presetSystem(preset: Preset, c: MacroContext): string {
  return leading(preset)
    .map((e) => renderMacros(e.content, c).trim())
    .filter(Boolean)
    .join('\n\n');
}

/** What the preset adds to a request beside the system prompt, as text, for the context estimate. */
export function presetBulk(preset: Preset): string {
  const inSystem = new Set(leading(preset));
  return preset.entries.filter((e) => e.enabled && !inSystem.has(e)).map((e) => e.content).join('\n') + (preset.prefill ?? '');
}

function injected(role: PresetRole, content: string, n: number): Message {
  return { id: `preset-${n}`, role: role === 'assistant' ? 'assistant' : 'user', origin: 'harness', ...(role === 'system' ? { asSystem: true } : {}), parts: [{ type: 'text', text: content, synthetic: true }], time: 0 };
}

/** A message of the chat itself, as SillyTavern counts them: what the user wrote, a finished reply, a summary. */
function isChat(m: Message): boolean {
  if (m.role === 'user') return m.origin === undefined || m.origin === 'user' || m.origin === 'compaction';
  return m.parts.some((p) => p.type === 'text' && p.text) && !m.parts.some((p) => p.type === 'tool_call');
}

export interface PlaceOptions {
  /** The model truly continues a trailing assistant message; otherwise the prefill is asked for in words. */
  continues: boolean;
  /** The provider refuses system messages inside the conversation: they go as user messages. */
  flatSystem?: boolean;
}

export interface Placed {
  messages: Message[];
  /** Text the model is continuing from, which the stored reply has to start with. */
  continued?: string;
}

/**
 * A request's messages with the preset in them, placed as SillyTavern places its prompts: user and assistant prompts
 * from ahead of the chat at its start, those from behind it after its latest message, in-chat prompts `depth` chat
 * messages back; at one depth the highest order and system sit nearest the end.
 *
 * Depth counts the chat, never an agent's tool rounds, and everything stays where it is through a turn. So a prompt
 * cannot fall between a tool call and its result, and the request grows at its end through the whole turn, which is
 * what the provider's cache and the Responses socket live on. The list passed in is not changed.
 */
export function placePreset(messages: Message[], preset: Preset, c: MacroContext, o: PlaceOptions): Placed {
  const on = preset.entries.filter((e) => e.enabled);
  const system = new Set(leading(preset));
  let n = 0;
  const make = (role: PresetRole, content: string) => injected(role === 'system' && o.flatSystem ? 'user' : role, content, n++);
  const render = (e: PresetEntry) => renderMacros(e.content, c).trim();
  const each = (list: PresetEntry[]) =>
    list.flatMap((e) => {
      const text = render(e);
      return text ? [make(e.role, text)] : [];
    });

  const chat = messages.flatMap((m, i) => (isChat(m) ? [i] : []));
  const newest = chat.at(-1) ?? messages.length - 1;
  /** What goes right behind a message, by its index; -1 is ahead of them all. */
  const slots = new Map<number, Message[]>();
  const put = (at: number, list: Message[]) => slots.set(at, [...(slots.get(at) ?? []), ...list]);
  const depths = [...new Set(on.filter((e) => e.place === 'depth').map((e) => e.depth ?? 0))].sort((a, b) => b - a);
  for (const d of depths) {
    const here = on.filter((e) => e.place === 'depth' && (e.depth ?? 0) === d);
    const orders = [...new Set(here.map((e) => e.order ?? 100))].sort((a, b) => a - b);
    const group: Message[] = [];
    for (const order of orders) {
      for (const role of ['assistant', 'user', 'system'] as const) {
        const joined = here.filter((e) => (e.order ?? 100) === order && e.role === role).map(render).filter(Boolean).join('\n');
        if (joined) group.push(make(role, joined));
      }
    }
    put(chat[chat.length - 1 - d] ?? -1, group);
  }

  // Behind the latest message of the chat. An assistant prompt at the very end is a prefill by another name.
  const end = [...(slots.get(newest) ?? []), ...each(on.filter((e) => e.place === 'after'))];
  const fill: string[] = preset.prefill ? [renderMacros(preset.prefill, c)] : [];
  const replying = messages[newest]?.role === 'user';
  if (replying) while (end.at(-1)?.role === 'assistant') fill.unshift((end.pop()!.parts[0] as { text: string }).text);
  const prefill = replying ? fill.join('\n\n').trimEnd() : '';
  const started = messages.slice(newest + 1).some((m) => m.role === 'assistant');
  if (prefill && !o.continues) end.push(make('user', `Your reply to this message begins with exactly the following text; write it first and go on from it.\n\n${prefill}`));
  slots.set(newest, end);

  const out: Message[] = [...(slots.get(-1) ?? [])];
  messages.forEach((m, i) => out.push(m, ...(slots.get(i) ?? [])));
  const head = each(ahead(preset).filter((e) => !system.has(e)));
  if (head[0]?.role === 'assistant') head.unshift(make('user', 'Start.'));
  const continued = prefill && o.continues && !started ? prefill : undefined;
  if (continued) out.push(make('assistant', continued));
  return { messages: [...head, ...out], ...(continued ? { continued } : {}) };
}

// ---------- where presets live ----------

/** Every project's library is its own, under Favilla's folder: never in the repository, never seen from another folder. */
const dirOf = (scope: PresetScope, cwd: string) => (scope === 'global' ? appPath('presets') : appPath('projects', projectSlug(cwd), 'presets'));
const fileOf = (scope: PresetScope, cwd: string, name: string) => path.join(dirOf(scope, cwd), `${encodeURIComponent(name).replace(/\*/g, '%2A')}.json`);
const choiceFile = (scope: PresetScope, cwd: string) => path.join(dirOf(scope, cwd), 'active.choice');

function invalidPreset(p: Record<string, unknown>): SettingPath | undefined {
  if (typeof p.name !== 'string') return ['name'];
  for (const k of ['user', 'char', 'prefill']) if (p[k] !== undefined && typeof p[k] !== 'string') return [k];
  if (!Array.isArray(p.entries)) return ['entries'];
  for (const [i, e] of p.entries.entries()) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return ['entries', i];
    for (const k of ['id', 'name', 'content']) if (typeof e[k] !== 'string') return ['entries', i, k];
    if (typeof e.enabled !== 'boolean') return ['entries', i, 'enabled'];
    if (!['system', 'user', 'assistant'].includes(e.role)) return ['entries', i, 'role'];
    if (!['before', 'after', 'depth'].includes(e.place)) return ['entries', i, 'place'];
    for (const k of ['order', 'depth']) if (e[k] !== undefined && !Number.isFinite(e[k])) return ['entries', i, k];
  }
}

export function listPresets(scope: PresetScope, cwd: string, report?: LibraryReport): Preset[] {
  return listLibrary(dirOf(scope, cwd), invalidPreset, report);
}

export function readPreset(scope: PresetScope, cwd: string, name: string): Preset | null {
  return readLibrary(fileOf(scope, cwd, name), invalidPreset);
}

export function savePreset(scope: PresetScope, cwd: string, preset: Preset): void {
  editLibrary<Preset, void>(fileOf(scope, cwd, preset.name), invalidPreset, (_, save) => save(preset));
}

/** Bring a SillyTavern preset file into one library. Importing a name again replaces it and keeps its {{user}} and {{char}}. */
export function importPreset(scope: PresetScope, cwd: string, text: string, name: string): { preset: Preset; report: PresetReport } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not JSON, so it is not a SillyTavern preset.');
  }
  const clean = name.replace(/\.json$/i, '').trim().slice(0, 80) || 'Preset';
  const out = parseTavernPreset(raw, clean);
  editLibrary<Preset, void>(fileOf(scope, cwd, clean), invalidPreset, (old, save) => {
    if (old?.user) out.preset.user = old.user;
    if (old?.char) out.preset.char = old.char;
    save(out.preset);
  });
  return out;
}

export interface PresetPatch {
  user?: string;
  char?: string;
  prefill?: string;
  entries?: { id: string; enabled: boolean }[];
}

const entriesById = (p: Preset) => ({ entriesById: Object.fromEntries(p.entries.map((e) => [e.id, { enabled: e.enabled }])) });

/** Change what a preset says; nothing but these fields can be set. */
export function updatePreset(scope: PresetScope, cwd: string, name: string, patch: PresetPatch, basis?: SettingBasis): Preset {
  const file = fileOf(scope, cwd, name);
  return editLibrary<Preset, Preset>(file, invalidPreset, (p, save) => {
    if (!p) {
      if (basis) throw new SettingsConflict(file);
      throw new Error(`There is no preset named "${name}" here.`);
    }
    const edits: [SettingPath, unknown][] = [];
    const next = { ...p, entries: p.entries.map((e) => ({ ...e })) };
    for (const k of ['user', 'char', 'prefill'] as const) {
      const v = patch[k];
      if (typeof v !== 'string') continue;
      edits.push([[k], v.trim() ? v : undefined]);
      if (v.trim()) next[k] = v;
      else delete next[k];
    }
    checkSettings(file, basis, p, edits.map(([at]) => at));
    for (const e of patch.entries ?? []) {
      if (typeof e.enabled !== 'boolean') continue;
      checkSettings(file, basis, entriesById(p), [['entriesById', e.id, 'enabled']]);
      const index = next.entries.findIndex((x) => x.id === e.id);
      if (index < 0) continue;
      next.entries[index].enabled = e.enabled;
      edits.push([['entries', index, 'enabled'], e.enabled]);
    }
    save(next, edits);
    return next;
  });
}

/** Copy a preset into the other library. From then on they are two presets: changing one leaves the other alone. */
export function copyPreset(from: PresetScope, cwd: string, name: string): void {
  const p = readPreset(from, cwd, name);
  if (!p) throw new Error(`There is no preset named "${name}" here.`);
  savePreset(from === 'global' ? 'workspace' : 'global', cwd, p);
}

export function deletePreset(scope: PresetScope, cwd: string, name: string, basis?: SettingBasis): void {
  const file = fileOf(scope, cwd, name);
  editLibrary<Preset, void>(file, invalidPreset, (p, _, remove) => {
    checkSettings(file, basis, p ?? undefined, [[]]);
    remove();
  });
  if (scope === 'global' && globalChoice() === name) setGlobalChoice(null);
  const c = workspaceChoice(cwd);
  if (scope === 'workspace' && c.use === 'own' && c.name === name) setWorkspaceChoice(cwd, { use: 'global' });
}

const readGlobalChoice = () => libraryChoice<{ name?: string }>(choiceFile('global', ''), ['name']);
const readWorkspaceChoice = (cwd: string) => libraryChoice<WorkspaceChoice>(choiceFile('workspace', cwd), ['use', 'name']);

export function globalChoice(): string | null {
  return readGlobalChoice().value?.name ?? null;
}

export function setGlobalChoice(name: string | null, basis?: SettingBasis): void {
  saveLibraryChoice(choiceFile('global', ''), { name }, ['name'], basis);
}

function workspaceChoiceOf(c: WorkspaceChoice | null): WorkspaceChoice {
  if (c?.use === 'none' || c?.use === 'global' || ((c?.use === 'own' || c?.use === 'library') && c.name)) return c;
  return { use: 'global' };
}

export function workspaceChoice(cwd: string): WorkspaceChoice {
  return workspaceChoiceOf(readWorkspaceChoice(cwd).value);
}

export function setWorkspaceChoice(cwd: string, choice: WorkspaceChoice, basis?: SettingBasis): void {
  saveLibraryChoice(choiceFile('workspace', cwd), choice, ['use', 'name'], basis);
}

export interface ActivePreset {
  preset: Preset;
  scope: PresetScope;
}

/** One library as the settings show it: each prompt says the layer it goes into. */
function libraryView(scope: PresetScope, cwd: string, report?: LibraryReport) {
  return listPresets(scope, cwd, report).map((p) => {
    const system = new Set(leading(p));
    const basis = { ...settingBasis(p, [[], ['user'], ['char'], ['prefill']]), ...settingBasis(entriesById(p), p.entries.map((e) => ['entriesById', e.id, 'enabled'])) };
    return { ...p, basis, entries: p.entries.map((e) => ({ ...e, layer: system.has(e) ? ('system' as const) : e.place })) };
  });
}

export function presetsView(cwd: string, report?: LibraryReport) {
  const active = activePreset(cwd);
  const global = readGlobalChoice();
  const workspace = readWorkspaceChoice(cwd);
  return {
    folder: cwd,
    global: { dir: dirOf('global', cwd), use: global.value?.name ?? null, basis: global.basis, items: libraryView('global', cwd, report) },
    workspace: { dir: dirOf('workspace', cwd), use: workspaceChoiceOf(workspace.value), basis: workspace.basis, items: libraryView('workspace', cwd, report) },
    active: active ? { name: active.preset.name, scope: active.scope } : null,
  };
}

/** The same preset, whatever it is called and whenever it was imported. */
const sameText = (a: Preset, b: Preset) => stableStringify({ ...a, name: '', imported: 0 }) === stableStringify({ ...b, name: '', imported: 0 });

/**
 * Move a folder's own copy into the one library, so every folder can pick it without importing it again. A copy
 * the library already holds word for word is only dropped; a different one with a library preset's name keeps
 * both, the copy under the folder's name. A folder that used the copy then uses it from the library.
 */
export function moveToLibrary(cwd: string, name: string): string {
  const own = readPreset('workspace', cwd, name);
  if (!own) throw new Error(`There is no preset named "${name}" here.`);
  const base = `${name} (${path.basename(cwd) || 'folder'})`;
  let target = name;
  let there = readPreset('global', cwd, target);
  for (let n = 1; there && !sameText(there, own); n++) {
    target = n === 1 ? base : `${base} ${n}`;
    there = readPreset('global', cwd, target);
  }
  if (!there) savePreset('global', cwd, { ...own, name: target });
  fs.rmSync(fileOf('workspace', cwd, name), { force: true });
  const c = workspaceChoice(cwd);
  if (c.use === 'own' && c.name === name) setWorkspaceChoice(cwd, { use: 'library', name: target });
  return target;
}

/** The preset a new session in this folder uses, and where it came from. */
export function activePreset(cwd: string): ActivePreset | null {
  const here = workspaceChoice(cwd);
  if (here.use === 'none') return null;
  if (here.use === 'own') {
    const preset = readPreset('workspace', cwd, here.name);
    return preset ? { preset, scope: 'workspace' } : null;
  }
  // A library preset picked by name; deleted since, the folder follows the global choice again.
  const picked = here.use === 'library' ? readPreset('global', cwd, here.name) : null;
  if (picked) return { preset: picked, scope: 'global' };
  const name = globalChoice();
  const preset = name ? readPreset('global', cwd, name) : null;
  return preset ? { preset, scope: 'global' } : null;
}
