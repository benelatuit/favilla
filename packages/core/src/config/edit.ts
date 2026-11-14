import { isDeepStrictEqual } from 'node:util';
import type { SettingPath } from './document';
import { isObject } from './schema';
import { applyEdits, createScanner, findNodeAtLocation, parseTree, type Node } from 'jsonc-parser';

const lineStart = (text: string, at: number) => Math.max(text.lastIndexOf('\n', at - 1), text.lastIndexOf('\r', at - 1)) + 1;
const indentAt = (text: string, at: number) => /^[\t ]*/.exec(text.slice(lineStart(text, at), at))![0];

function indentUnit(text: string, parent: Node): string | undefined {
  const base = indentAt(text, parent.offset);
  const children = parent.children ?? [];
  const line = lineStart(text, parent.offset);
  for (const child of children) {
    if (lineStart(text, child.offset) === line) continue;
    const indent = indentAt(text, child.offset);
    if (indent.startsWith(base) && indent.length > base.length) return indent.slice(base.length);
  }
  for (const child of children) {
    const inner = indentUnit(text, child.type === 'property' ? child.children![1] : child);
    if (inner) return inner;
  }
}

function removeSetting(text: string, property: Node | undefined): string {
  const siblings = property?.parent?.children;
  if (!property || !siblings) return text;
  // Remove the setting and one delimiter, leaving the comments around both intact.
  const scanner = createScanner(text, true);
  scanner.setPosition(property.offset + property.length);
  scanner.scan();
  const previous = siblings[siblings.indexOf(property) - 1];
  if (text[scanner.getTokenOffset()] !== ',' && previous) {
    scanner.setPosition(previous.offset + previous.length);
    scanner.scan();
  }
  const edits = [{ offset: property.offset, length: property.length, content: '' }];
  if (text[scanner.getTokenOffset()] === ',') edits.push({ offset: scanner.getTokenOffset(), length: 1, content: '' });
  return applyEdits(text, edits);
}

/** Format the bytes that belong to the edit. Formatting a JSONC edit can also touch the neighbouring key. */
export function editSetting(text: string, key: SettingPath, value: unknown): string {
  const root = parseTree(text)!;
  const existing = findNodeAtLocation(root, key);
  if (value === undefined) return removeSetting(text, existing?.parent?.type === 'property' ? existing.parent : existing);
  const unit = indentUnit(text, root) ?? '  ';
  const eol = /\r\n|\n|\r/.exec(text)?.[0] ?? '\n';
  const format = (v: unknown, base: string) => JSON.stringify(v, null, '\t').replace(/\n(\t*)/g, (_, tabs: string) => eol + base + unit.repeat(tabs.length));
  let parent = root;
  for (const [i, name] of key.entries()) {
    const child = findNodeAtLocation(parent, [name]);
    if (child?.type === (typeof key[i + 1] === 'number' ? 'array' : 'object') && i + 1 < key.length) {
      parent = child;
      continue;
    }
    const nested = key.slice(i + 1).reduceRight((v, k) => typeof k === 'number' ? [v] : { [k]: v }, value);
    const base = indentAt(text, parent.offset);
    const sibling = parent.children?.findLast((p) => /^[\t ]*$/.test(text.slice(lineStart(text, p.offset), p.offset)));
    const indent = sibling ? indentAt(text, sibling.offset) : base + unit;
    if (child) {
      const property = child.parent?.type === 'property' ? child.parent : child;
      const here = lineStart(text, property.offset) === lineStart(text, parent.offset) ? indent : indentAt(text, property.offset);
      return applyEdits(text, [{ offset: child.offset, length: child.length, content: format(nested, here) }]);
    }
    const close = parent.offset + parent.length - 1;
    const closeLine = lineStart(text, close);
    const ownLine = /^[\t ]*$/.test(text.slice(closeLine, close));
    const at = ownLine ? closeLine : close - /[\t ]*$/.exec(text.slice(closeLine, close))![0].length;
    const last = parent.children?.at(-1);
    const end = last ? last.offset + last.length : 0;
    const scanner = createScanner(text, true);
    scanner.setPosition(end);
    scanner.scan();
    const comma = !!last && text[scanner.getTokenOffset()] === ',';
    const entry = indent + (parent.type === 'array' ? '' : JSON.stringify(name) + ': ') + format(nested, indent) + (comma ? ',' : '');
    const insert = (ownLine ? '' : eol) + entry + eol + (ownLine ? '' : base);
    const edits = [{ offset: at, length: ownLine ? 0 : close - at, content: !comma && end === at ? ',' + insert : insert }];
    if (last && !comma && end !== at) edits.unshift({ offset: end, length: 0, content: ',' });
    return applyEdits(text, edits);
  }
  return text;
}

/** The changes made in the form. Arrays such as command arguments are one field, maps of named values are not. */
export function settingChanges(before: unknown, after: unknown, path: SettingPath = []): [SettingPath, unknown][] {
  if (isDeepStrictEqual(before, after)) return [];
  const a = isObject(before) ? before : undefined;
  const b = isObject(after) ? after : undefined;
  if ((a || b) && (a || before === undefined) && (b || after === undefined)) {
    return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].flatMap((key) => settingChanges(
      a && Object.hasOwn(a, key) ? a[key] : undefined, b && Object.hasOwn(b, key) ? b[key] : undefined, [...path, key],
    ));
  }
  return [[path, after]];
}
