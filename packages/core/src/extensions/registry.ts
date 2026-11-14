import type { FavillaConfig } from '../config/config';
import type { ToolBinding } from '../tools/types';
import { installedExtensions } from './installed';
import { settingOf, type Extension, type ExtensionSetting, type MessageFacts } from './types';

const loaded: Extension[] = [];
let loading: Promise<readonly Extension[]> | null = null;

/** Loads the extensions once, before the first session builds its tools; later calls wait for the same load. */
export function loadExtensions(): Promise<readonly Extension[]> {
  loading ??= installedExtensions().then((list) => {
    for (const e of list) registerExtension(e);
    return loaded;
  });
  return loading;
}

/** An extension made in code (a test's own); one of the same name replaces the one before. */
export function registerExtension(e: Extension): void {
  const at = loaded.findIndex((x) => x.name === e.name);
  if (at >= 0) loaded[at] = e;
  else loaded.push(e);
}

export function extensions(): readonly Extension[] {
  return loaded;
}

/** The main agent's tools with the extensions' put in: each after the tool it names, or at the end. */
export function withExtensionTools(tools: ToolBinding[]): ToolBinding[] {
  const out = [...tools];
  for (const e of loaded)
    for (const t of e.tools ?? []) {
      if (out.some((b) => b.spec.name === t.binding.spec.name)) continue;
      const after = t.after ? out.findIndex((b) => b.spec.name === t.after) : -1;
      out.splice(after >= 0 ? after + 1 : out.length, 0, t.binding);
    }
  return out;
}

/** Whether an extension's tool of this name is listed in short until it is needed. */
export function deferredByExtension(name: string): boolean {
  return loaded.some((e) => e.tools?.some((t) => t.deferred && t.binding.spec.name === name));
}

/** What the extensions make of a message to the main agent: the tools to load with it and the notes to send. */
export function extensionMessage(m: MessageFacts): { load: string[]; notes: string[] } {
  const load: string[] = [];
  const notes: string[] = [];
  for (const e of loaded) {
    const r = e.onMessage?.(m);
    if (r?.load) load.push(...r.load);
    if (r?.notes) notes.push(...r.notes);
  }
  return { load, notes };
}

/** The extensions' settings with their values, and their words, for the settings page and the cards. */
export function extensionInfo(config: FavillaConfig): { name: string; settings: (ExtensionSetting & { current: string })[]; strings: Record<string, Record<string, string>> }[] {
  return loaded.map((e) => ({
    name: e.name,
    settings: (e.settings ?? []).map((s) => {
      const v = settingOf(config, s.key);
      return { ...s, current: v === undefined || v === null ? s.value : String(v) };
    }),
    strings: e.strings ?? {},
  }));
}

/** The config keys the extensions' settings keep, which the settings page may write. */
export function extensionSettingKeys(): string[] {
  return loaded.flatMap((e) => (e.settings ?? []).map((s) => s.key));
}

/** A setting's value as the config should keep it. */
export function extensionSettingValue(key: string, value: unknown): unknown {
  const s = loaded.flatMap((e) => e.settings ?? []).find((x) => x.key === key);
  if (!s || value === undefined || value === null || value === '') return undefined;
  return s.number ? Number(value) : String(value);
}

/** An extension's word in a language, for front ends that do not hold it themselves. */
export function extensionString(lang: string, key: string): string | undefined {
  for (const e of loaded) {
    const s = e.strings?.[lang]?.[key];
    if (s !== undefined) return s;
  }
  return undefined;
}
