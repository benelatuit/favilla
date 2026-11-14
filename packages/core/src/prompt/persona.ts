import fs from 'node:fs';
import path from 'node:path';
import { appPath, projectSlug } from '../util/paths';
import { checkSettings, settingBasis, SettingsConflict, type SettingBasis, type SettingPath } from '../config/document';
import { editLibrary, libraryChoice, listLibrary, readLibrary, saveLibraryChoice, type LibraryReport } from './library';

/**
 * Who the user wants the agent to be: a character with a name, a description, a temper and a way of talking, set
 * apart from the rules (what to do) and the voice (how answers are laid out). One library under Favilla's folder;
 * each folder follows the default, uses none, or picks one by name. A character card made for SillyTavern comes in
 * as one: its words, nothing else.
 *
 * A session keeps the persona it started with, as text in its meta, and sub-agents have none.
 */
export interface Persona {
  name: string;
  /** Who the character is. */
  description: string;
  /** Temper, habits and way of talking. */
  personality: string;
  /** The situation the character is in, when it has one. */
  scenario?: string;
  /** Example exchanges, as the card writes them. */
  examples?: string;
  /** The card's file name, when it came from one. */
  from?: string;
  /** A picture of the character kept beside it (avatar.png). */
  avatar?: boolean;
  created: number;
}

export type PersonaChoice = { use: 'global' } | { use: 'none' } | { use: 'library'; name: string };

/** What an import read and what it left out. */
export interface PersonaReport {
  /** Parts of the card Favilla does not use: a lorebook, its own system prompt, greetings. */
  left: string[];
}

const MAX_FIELD = 6000;

const dir = () => appPath('personas');
const fileOf = (name: string) => path.join(dir(), `${encodeURIComponent(name).replace(/\*/g, '%2A')}.json`);
const avatarOf = (name: string) => path.join(dir(), `${encodeURIComponent(name).replace(/\*/g, '%2A')}.png`);
const globalFile = () => path.join(dir(), 'active.choice');
const folderFile = (cwd: string) => path.join(appPath('projects', projectSlug(cwd)), 'persona.choice');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The text chunks of a PNG by keyword (tEXt, and iTXt without compression). */
function pngText(bytes: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 8;
  while (at + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0) out.set(data.toString('latin1', 0, nul), data.toString('latin1', nul + 1));
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0);
      // keyword \0 compression flag, method, language \0 translated keyword \0 text
      if (nul > 0 && data[nul + 1] === 0) {
        const lang = data.indexOf(0, nul + 3);
        const translated = lang >= 0 ? data.indexOf(0, lang + 1) : -1;
        if (translated >= 0) out.set(data.toString('latin1', 0, nul), data.toString('utf8', translated + 1));
      }
    } else if (type === 'IEND') break;
    at += 12 + len;
  }
  return out;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, MAX_FIELD) : '');

/**
 * A SillyTavern character card: a PNG with the card's JSON in a text chunk (ccv3 for version 3, chara for version 2),
 * or the JSON itself (version 1 fields at the top, versions 2 and 3 under data). {{char}} becomes the character's name
 * and {{user}} the user.
 */
export function parseCharacterCard(bytes: Buffer, fileName: string): { persona: Persona; report: PersonaReport; png: boolean } {
  const png = bytes.subarray(0, 8).equals(PNG);
  let raw: unknown;
  try {
    if (png) {
      const chunks = pngText(bytes);
      const b64 = chunks.get('ccv3') ?? chunks.get('chara');
      if (!b64) throw new Error('no card');
      raw = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } else raw = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw new Error(png ? 'This picture holds no character card.' : 'This file is neither a character card picture nor its JSON.');
  }
  const card = raw as Record<string, unknown>;
  const data = (card.data && typeof card.data === 'object' ? card.data : card) as Record<string, unknown>;
  const name = text(data.name) || text(card.name) || fileName.replace(/\.(png|json)$/i, '').trim().slice(0, 80) || 'Persona';
  const cjk = /[一-鿿]/.test(`${data.description ?? ''}${data.personality ?? ''}`);
  const fill = (s: string) => s.replace(/\{\{char\}\}|<BOT>/gi, name).replace(/\{\{user\}\}|<USER>/gi, cjk ? '用户' : 'the user');
  const left: string[] = [];
  const book = data.character_book as { entries?: unknown[] } | undefined;
  if (book?.entries?.length) left.push(`lorebook (${book.entries.length})`);
  if (text(data.system_prompt)) left.push('system prompt');
  if (text(data.post_history_instructions)) left.push('post-history instructions');
  if (text(data.first_mes) || (Array.isArray(data.alternate_greetings) && data.alternate_greetings.length)) left.push('greetings');
  const persona: Persona = {
    name,
    description: fill(text(data.description)),
    personality: fill(text(data.personality)),
    ...(text(data.scenario) ? { scenario: fill(text(data.scenario)) } : {}),
    ...(text(data.mes_example) ? { examples: fill(text(data.mes_example)) } : {}),
    from: fileName,
    created: Date.now(),
  };
  if (!persona.description && !persona.personality) throw new Error('The card has no description or personality to go on.');
  return { persona, report: { left }, png };
}

const personaFields = ['description', 'personality', 'scenario', 'examples'] as const;
function invalidPersona(p: Record<string, unknown>): SettingPath | undefined {
  for (const k of ['name', ...personaFields, 'from']) {
    if ((k === 'name' || p[k] !== undefined) && typeof p[k] !== 'string') return [k];
  }
  if (p.avatar !== undefined && typeof p.avatar !== 'boolean') return ['avatar'];
}

export function listPersonas(report?: LibraryReport): Persona[] {
  return listLibrary(dir(), invalidPersona, report);
}

export function readPersona(name: string): Persona | null {
  return readLibrary(fileOf(name), invalidPersona);
}

export function savePersona(p: Persona): void {
  editLibrary<Persona, void>(fileOf(p.name), invalidPersona, (_, save) => save(p));
}

/** A card, PNG or JSON, into the library. A name imported again is replaced. */
export function importPersona(bytes: Buffer, fileName: string): { persona: Persona; report: PersonaReport } {
  const { persona, report, png } = parseCharacterCard(bytes, fileName);
  editLibrary<Persona, void>(fileOf(persona.name), invalidPersona, (_, save) => {
    if (png) {
      fs.writeFileSync(avatarOf(persona.name), bytes);
      persona.avatar = true;
    } else fs.rmSync(avatarOf(persona.name), { force: true });
    save(persona);
  });
  return { persona, report };
}

export interface PersonaPatch {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  examples?: string;
}

/** A persona written here, or one changed: nothing but these fields can be set. A new name moves it. */
export function writePersona(name: string | null, patch: PersonaPatch, basis?: SettingBasis): Persona {
  const next = (patch.name ?? name ?? '').trim().slice(0, 80);
  if (!next) throw new Error('A persona needs a name.');
  const file = fileOf(name ?? next);
  return editLibrary<Persona, Persona>(file, invalidPersona, (old, save, remove) => {
    if (name && !old) {
      if (basis) throw new SettingsConflict(file);
      throw new Error(`There is no persona named "${name}".`);
    }
    const fields = personaFields.filter((k) => typeof patch[k] === 'string');
    checkSettings(file, basis, old ?? undefined, [...fields, ...(patch.name !== undefined ? ['name'] : [])].map((k) => [k]));
    if (!name && old) throw new Error(`There is a persona named "${next}" already.`);
    const p: Persona = old ? { ...old } : { name: next, description: '', personality: '', created: Date.now() };
    for (const k of fields) {
      const v = patch[k]!.trim().slice(0, MAX_FIELD);
      if (v || k === 'description' || k === 'personality') p[k] = v;
      else delete p[k];
    }
    p.name = next;
    if (old && next !== old.name) {
      const target = fileOf(next);
      if (path.resolve(target).toLowerCase() === path.resolve(file).toLowerCase() && process.platform === 'win32') throw new Error(`There is a persona named "${next}" already.`);
      editLibrary<Persona, void>(target, invalidPersona, (there, keep) => {
        if (there) {
          if (basis) throw new SettingsConflict(target);
          throw new Error(`There is a persona named "${next}" already.`);
        }
        keep(p);
        if (old.avatar && fs.existsSync(avatarOf(old.name))) fs.renameSync(avatarOf(old.name), avatarOf(next));
        if (globalChoice() === old.name) setGlobalChoice(next);
        remove();
      });
    } else save(p);
    return p;
  });
}

export function deletePersona(name: string, basis?: SettingBasis): void {
  const file = fileOf(name);
  editLibrary<Persona, void>(file, invalidPersona, (p, _, remove) => {
    checkSettings(file, basis, p ?? undefined, [[]]);
    remove();
    fs.rmSync(avatarOf(name), { force: true });
    if (globalChoice() === name) setGlobalChoice(null);
  });
}

/** The picture kept for a persona, if it has one. */
export function personaAvatar(name: string): Buffer | null {
  try {
    return fs.readFileSync(avatarOf(name));
  } catch {
    return null;
  }
}

const readGlobalChoice = () => libraryChoice<{ name?: string }>(globalFile(), ['name']);
const readFolderChoice = (cwd: string) => libraryChoice<PersonaChoice>(folderFile(cwd), ['use', 'name']);

export function globalChoice(): string | null {
  return readGlobalChoice().value?.name ?? null;
}

export function setGlobalChoice(name: string | null, basis?: SettingBasis): void {
  saveLibraryChoice(globalFile(), { name }, ['name'], basis);
}

function folderChoiceOf(c: PersonaChoice | null): PersonaChoice {
  return c?.use === 'none' || (c?.use === 'library' && c.name) ? c : { use: 'global' };
}

export function folderChoice(cwd: string): PersonaChoice {
  return folderChoiceOf(readFolderChoice(cwd).value);
}

export function setFolderChoice(cwd: string, choice: PersonaChoice, basis?: SettingBasis): void {
  saveLibraryChoice(folderFile(cwd), choice, ['use', 'name'], basis);
}

export function activePersona(cwd: string): Persona | null {
  const here = folderChoice(cwd);
  if (here.use === 'none') return null;
  const picked = here.use === 'library' ? readPersona(here.name) : null;
  if (picked) return picked;
  const name = globalChoice();
  return name ? readPersona(name) : null;
}

/** What goes into the system prompt: the character in its own words. */
export function personaText(p: Persona): string {
  return [
    `Name: ${p.name}`,
    p.description && `Who ${p.name} is:\n${p.description}`,
    p.personality && `Temper and way of talking:\n${p.personality}`,
    p.scenario && `Situation:\n${p.scenario}`,
    p.examples && `How ${p.name} talks, in examples:\n${p.examples}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function personasView(cwd: string, report?: LibraryReport) {
  const active = activePersona(cwd);
  const global = readGlobalChoice();
  const folder = readFolderChoice(cwd);
  return {
    folder: cwd,
    dir: dir(),
    use: global.value?.name ?? null,
    here: folderChoiceOf(folder.value),
    choices: { global: global.basis, folder: folder.basis },
    items: listPersonas(report).map((p) => ({ ...p, basis: settingBasis(p, [[], ['name'], ...personaFields.map((k) => [k])]) })),
    active: active ? active.name : null,
  };
}
