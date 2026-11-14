import { isUtf8 } from 'node:buffer';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { findNodeAtLocation, getNodeValue, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { FORMER_NAME } from '../former-name';
import { stableStringify } from '../util/json';
import type { SettingBasis } from '../types';
import { settingsWords, settingText, type SettingsMessage, type SettingsNotice } from '../i18n';

type Phase = 'start' | 'reload' | 'save';
export type SettingReporter = (notice: SettingsNotice) => void;

export interface SettingSource {
  file: string;
  version(): string;
}

export function settingNotice(source: SettingSource, key: string, vars: SettingsMessage['vars'] = {}, identity = key): SettingsNotice {
  return { id: JSON.stringify([source.file, source.version(), identity, vars]), key, vars: { file: source.file, ...vars } };
}

export class SettingsError extends Error {
  constructor(readonly problem: SettingsMessage) {
    super(settingText(problem));
  }
}

export class SettingsFileError extends SettingsError {
  constructor(readonly source: SettingSource, readonly line?: number, readonly key?: string, readonly invalidRoot = false) {
    super({ key: key ? settingsWords.duplicate : line ? settingsWords.save : settingsWords.unreadable, vars: { file: source.file, ...(line ? { line } : {}), ...(key ? { key } : {}) } });
  }

  notice(phase: Phase): SettingsNotice {
    const word = this.key ? settingsWords.duplicate : this.line ? settingsWords[phase] : settingsWords.unreadable;
    return settingNotice(this.source, word, this.problem.vars, this.line && !this.key ? 'invalid-json' : word);
  }
}

/** The byte order and byte-order mark belong to the file, not to the machine making the edit. */
export function settingsDocument(bytes: Buffer): { text: string; valid: boolean; encode(text: string): Buffer } {
  const big = bytes[0] === 0xfe && bytes[1] === 0xff;
  const utf16 = big || (bytes[0] === 0xff && bytes[1] === 0xfe);
  const mark = utf16 ? 2 : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const encoding = utf16 ? 'utf16le' : 'utf8';
  const data = bytes.subarray(mark);
  const text = (big ? Buffer.from(data.subarray(0, data.length & ~1)).swap16() : data).toString(encoding);
  return {
    text,
    valid: utf16 ? data.length % 2 === 0 : isUtf8(data),
    encode(next) {
      const buf = Buffer.from(next, encoding);
      return Buffer.concat([bytes.subarray(0, mark), big ? buf.swap16() : buf]);
    },
  };
}

const lineOf = (text: string, offset: number) => 1 + (text.slice(0, offset).match(/\r\n|\r|\n/g)?.length ?? 0);

function duplicate(node: Node, path: string[] = []): { key: string; at: number } | undefined {
  const seen = new Set<string>();
  for (const [i, child] of (node.children ?? []).entries()) {
    const name = child.type === 'property' ? String(child.children![0].value) : String(i);
    const here = [...path, name];
    if (seen.has(name)) return { key: here.join('.'), at: child.offset };
    seen.add(name);
    const nested = duplicate(child.type === 'property' ? child.children![1] : child, here);
    if (nested) return nested;
  }
}

export function settingFileVersion(file: string): string {
  try {
    const s = fs.statSync(file, { bigint: true });
    return `${s.ino}:${s.mtimeNs}:${s.ctimeNs}:${s.size}`;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? '';
  }
}

/**
 * Windows refuses to open a file for the moment another process replaces it (writeFileAtomic's rename): EPERM or
 * EBUSY for a few milliseconds. A settings read that failed there had given an empty configuration, a folder's
 * sessions without the providers in it ("Unknown model") until the file changed again.
 */
function readRetrying(file: string): Buffer {
  for (let tries = 0; ; tries++) {
    try {
      return fs.readFileSync(file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (tries >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
}

/**
 * Keys whose value can be the app's own name: its tool set (tools, toolProfile), its own sign-in (credentials), its own
 * browser (browser.use) and its voice. A file saved under the app's former name says that name there; it is read as
 * "favilla", so the choice stands instead of being refused as a value the app does not know. The file keeps its text
 * until that setting is changed.
 */
const OWN_NAME_KEYS = new Set(['tools', 'toolProfile', 'credentials', 'use', 'voice']);

function presentNames(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (FORMER_NAME && v === FORMER_NAME && OWN_NAME_KEYS.has(k)) o[k] = 'favilla';
    else presentNames(v);
  }
}

export function readSettingDocument(file: string, options: { editing?: boolean; credentials?: boolean } = {}) {
  let bytes: Buffer;
  let exists = true;
  let version: string | undefined;
  const source: SettingSource = { file, version: () => version ??= settingFileVersion(file) };
  try {
    bytes = readRetrying(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new SettingsFileError(source);
    exists = false;
    bytes = Buffer.from('{}\n');
  }
  const { text, encode, valid } = settingsDocument(bytes);
  if (options.credentials && !options.editing && valid) {
    // Credential reads are also on the request path. The tree is needed only to locate a problem or an edit.
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return { text, encode, source, exists, value: value as Record<string, unknown>, line: () => 1 };
    } catch {
      // Never return a parser exception, which can quote the input.
    }
  }
  const errors: ParseError[] = [];
  let tree: Node | undefined;
  try {
    tree = parseTree(text, errors, { allowTrailingComma: !options.credentials, disallowComments: options.credentials });
  } catch {
    throw new SettingsFileError(source, lineOf(text, errors[0]?.offset ?? 0));
  }
  if (errors.length || tree?.type !== 'object' || !valid) {
    throw new SettingsFileError(source, lineOf(text, errors[0]?.offset ?? (valid ? tree?.offset ?? text.length : text.length)), undefined, !!tree && !errors.length && valid);
  }
  if (options.editing) {
    const repeated = duplicate(tree);
    if (repeated) {
      // A key written by hand in the credentials file can itself be secret.
      throw new SettingsFileError(source, lineOf(text, repeated.at), options.credentials ? undefined : repeated.key);
    }
  }
  const value = getNodeValue(tree) as Record<string, unknown>;
  if (!options.credentials) presentNames(value);
  return { text, encode, source, exists, value, line: (path: SettingPath) => lineOf(text, findNodeAtLocation(tree, path)?.offset ?? tree.offset) };
}

export type SettingPath = (string | number)[];
export type { SettingBasis } from '../types';

export function settingAt(value: unknown, path: SettingPath): unknown {
  for (const key of path) value = value && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}

// Values that aren't displayed, including passwords, can be compared without sending them to the form.
const stampKey = randomBytes(32);
const stamp = (key: string, value: unknown) => value === undefined ? undefined : createHmac('sha256', stampKey).update(key).update(stableStringify(value)).digest('base64url');

export function settingBasis(value: unknown, paths: SettingPath[]): SettingBasis {
  const basis: SettingBasis = {};
  for (const path of paths) {
    const key = JSON.stringify(path);
    const mark = stamp(key, settingAt(value, path));
    if (mark !== undefined) basis[key] = mark;
  }
  return basis;
}

export class SettingsConflict extends SettingsError {
  constructor(file: string) {
    super({ key: settingsWords.conflict, vars: { file } });
  }
}

/** Compare only the fields being saved, against the same bytes that will be edited. */
export function checkSettings(file: string, basis: SettingBasis | undefined, current: unknown, paths: SettingPath[]): void {
  if (basis === undefined) return;
  for (const path of paths) {
    const key = JSON.stringify(path);
    if (!basis || stamp(key, settingAt(current, path)) !== basis[key]) throw new SettingsConflict(file);
    for (let n = 1; n < path.length; n++) {
      const parent = path.slice(0, n);
      const value = settingAt(current, parent);
      if (value === undefined ? basis[JSON.stringify(parent)] !== undefined : !value || typeof value !== 'object' || Array.isArray(value) !== (typeof path[n] === 'number')) {
        throw new SettingsConflict(file);
      }
    }
  }
}
