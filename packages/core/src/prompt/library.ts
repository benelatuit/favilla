import fs from 'node:fs';
import path from 'node:path';
import { withFileUpdate, writeFileAtomic } from '../auth/store';
import { checkSettings, readSettingDocument, settingBasis, settingNotice, SettingsError, SettingsFileError, type SettingBasis, type SettingPath } from '../config/document';
import { editSetting, settingChanges } from '../config/edit';
import { settingsWords, type SettingsNotice } from '../i18n';

export type LibraryReport = (file: string, issue?: SettingsNotice) => void;
type Validate = (value: Record<string, unknown>) => SettingPath | undefined;

function document(file: string, validate: Validate, editing = false, report?: LibraryReport) {
  const doc = (() => {
    try {
      return readSettingDocument(file, { editing });
    } catch (e) {
      if (!(e instanceof SettingsFileError)) throw e;
      const issue = e.line && !e.key ? settingNotice(e.source, e.invalidRoot ? settingsWords.libraryValue : settingsWords.library, { line: e.line }) : e.notice('save');
      if (editing) throw new SettingsError(issue);
      report?.(file, issue);
    }
  })();
  if (!doc?.exists) {
    if (doc) report?.(file);
    return null;
  }
  const bad = validate(doc.value);
  if (bad) {
    const issue = settingNotice(doc.source, settingsWords.libraryValue, { line: doc.line(bad) });
    if (editing) throw new SettingsError(issue);
    report?.(file, issue);
    return null;
  }
  report?.(file);
  return doc;
}

export function readLibrary<T>(file: string, validate: Validate, report?: LibraryReport): T | null {
  return document(file, validate, false, report)?.value as T ?? null;
}

export function listLibrary<T extends { name: string }>(dir: string, validate: Validate, report?: LibraryReport): T[] {
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter((name) => name.endsWith('.json')).flatMap((name) => {
    const entry = readLibrary<T>(path.join(dir, name), validate, report);
    return entry ? [entry] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Validate the target under the writer's lock. A damaged entry is never a vacant name. */
export function editLibrary<T, R>(file: string, validate: Validate, edit: (
  current: T | null, save: (next: T, edits?: [SettingPath, unknown][]) => void, remove: () => void,
) => R): R {
  return withFileUpdate(file, (stillHeld) => {
    const doc = document(file, validate, true);
    return edit(doc?.value as T ?? null, (next, edits) => {
      if (!doc) return writeFileAtomic(file, JSON.stringify(next, null, 2), { beforeReplace: stillHeld });
      const text = (edits ?? settingChanges(doc.value, next)).reduce((text, [at, v]) => editSetting(text, at, v), doc.text);
      if (text !== doc.text) writeFileAtomic(file, doc.encode(text), { beforeReplace: stillHeld });
    }, () => { stillHeld(); fs.rmSync(file, { force: true }); });
  });
}

/** A default choice is a setting too, even though it has its own file. */
export function libraryChoice<T>(file: string, keys: string[]) {
  const value = readLibrary<T>(file, () => undefined);
  return { value, basis: settingBasis(value, keys.map((k) => [k])) };
}

export function saveLibraryChoice(file: string, value: Record<string, unknown>, keys: string[], basis?: SettingBasis): void {
  const edits: [SettingPath, unknown][] = keys.map((k) => [[k], value[k]]);
  editLibrary<Record<string, unknown>, void>(file, () => undefined, (old, save) => {
    checkSettings(file, basis, old, edits.map(([at]) => at));
    save(value, edits);
  });
}
