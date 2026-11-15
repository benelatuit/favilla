import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useBoxMetrics, useCursor, useInput, usePaste } from 'ink';
import type { DOMElement } from 'ink';
import { attach, pastedBlock, type ImagePart } from '@favilla/core';
import { borders, paint } from './theme';
import { t } from './i18n';
import { clip, cols, graphemes, layoutInput, offsetAt } from './text';
import { imageFile, pastedImagePaths, readClipboardImage } from './clipboard';

export interface Suggestion {
  label: string;
  detail?: string;
  /** Replaces the current token. */
  insert: string;
}

/** Text put into the editor from outside: a message taken back from the queue, one to edit and send again. */
export interface Seed {
  text: string;
  images?: ImagePart[];
  nonce: number;
}

interface EditorProps {
  active: boolean;
  width: number;
  placeholder: string;
  history: string[];
  cwd: string;
  seed?: Seed;
  onSubmit: (text: string, images: ImagePart[]) => void;
  /** Esc with nothing else to close; `empty` says whether the input is empty. */
  onEscape: (empty: boolean) => void;
  onCtrlC: () => void;
  onShiftTab?: () => void;
  onTranscript?: () => void;
  /** ↑ in an empty input: true when the app used it (to take back a queued message). */
  onUpEmpty?: () => boolean;
  /** Edit the text in $VISUAL / $EDITOR; null when nothing came back. */
  onExternalEdit?: (text: string) => Promise<string | null>;
  onNotice: (level: 'info' | 'warn' | 'error', text: string) => void;
  suggest: (text: string, cursor: number) => Suggestion[];
  /** Rows of input shown at most; longer text scrolls. */
  maxRows?: number;
}

/** Token under the cursor that a suggestion replaces (`/cmd` at the start, or `@path`). */
export function currentToken(text: string, cursor: number): { start: number; token: string } {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  return { start, token: text.slice(start, cursor) };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `[Image #2]` in the text stands for the second image; deleting the token drops the image. */
const imageTokenRe = (): RegExp => new RegExp(`\\[(?:Image|图片|${escapeRe(t('Image'))}) #(\\d+)\\]`, 'g');
/** A long paste shown as `[Pasted #1 · 120 lines]`: sent in full after the words, which keep a `[Pasted text 1]` where it stood. */
const pasteTokenRe = (): RegExp => new RegExp(`\\[(?:Pasted|粘贴|已粘贴|${escapeRe(t('Pasted'))}) #(\\d+) · [^\\]]+\\]`, 'g');
const LONG_PASTE_LINES = 8;
const LONG_PASTE_CHARS = 1200;

export const imageToken = (n: number): string => `[${t('Image')} #${n}]`;
export const pasteToken = (n: number, lines: number): string => `[${t('Pasted')} #${n} · ${t('{n} lines', { n: lines })}]`;

/**
 * The images whose tokens are still in the text, in the order they appear, and the text as it is sent: each long
 * paste named where its token stood and attached whole after the words, so the model can tell the two apart.
 */
export function resolveInput(text: string, images: Map<number, ImagePart>, pastes: Map<number, string>): { text: string; images: ImagePart[] } {
  const used: ImagePart[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(imageTokenRe())) {
    const n = Number(m[1]);
    const img = images.get(n);
    if (img && !seen.has(n)) {
      seen.add(n);
      used.push(img);
    }
  }
  const blocks: string[] = [];
  const order = new Map<number, number>();
  const words = text.replace(pasteTokenRe(), (tok, n: string) => {
    const pasted = pastes.get(Number(n));
    if (pasted === undefined) return tok;
    // The same token twice is one paste, attached once.
    if (!order.has(Number(n))) {
      order.set(Number(n), blocks.length + 1);
      blocks.push(pastedBlock(pasted, blocks.length + 1));
    }
    return `[Pasted text ${order.get(Number(n))}]`;
  });
  return { text: attach(words, blocks), images: used };
}

function wordLeft(text: string, i: number): number {
  let j = i;
  while (j > 0 && /\s/.test(text[j - 1])) j--;
  while (j > 0 && !/\s/.test(text[j - 1])) j--;
  return j;
}

function wordRight(text: string, i: number): number {
  let j = i;
  while (j < text.length && /\s/.test(text[j])) j++;
  while (j < text.length && !/\s/.test(text[j])) j++;
  return j;
}

/** The grapheme before / after an offset, so a cursor step never splits an emoji or a combined character. */
function prevStop(text: string, i: number): number {
  let last = 0;
  for (const g of graphemes(text)) {
    if (g.index >= i) break;
    last = g.index;
  }
  return last;
}
function nextStop(text: string, i: number): number {
  for (const g of graphemes(text)) if (g.index > i) return g.index;
  return text.length;
}

/** A token the cursor sits right after (or inside), removed as a whole by backspace. */
function tokenBefore(text: string, cursor: number): { start: number; end: number } | null {
  for (const re of [imageTokenRe(), pasteTokenRe()]) {
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (cursor > start && cursor <= end) return { start, end };
    }
  }
  return null;
}

function colour(row: string): string {
  return row
    .replace(imageTokenRe(), (m) => paint('violet', m))
    .replace(pasteTokenRe(), (m) => paint('violet', m))
    .replace(/(^|\s)(@\S+)/g, (_, a: string, b: string) => `${a}${paint('blue', b)}`);
}

export function Editor(p: EditorProps) {
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const [histIndex, setHistIndex] = useState(-1);
  const [sel, setSel] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [search, setSearch] = useState<{ query: string; skip: number } | null>(null);
  const [reading, setReading] = useState(false);
  const draft = useRef('');
  const images = useRef(new Map<number, ImagePart>());
  const pastes = useRef(new Map<number, string>());
  const seq = useRef(0);
  const ref = useRef<DOMElement>(null);
  const box = useBoxMetrics(ref);
  const { setCursorPosition } = useCursor();
  const suggestions = p.active && !hidden && !search ? p.suggest(text, cursor) : [];

  useEffect(() => {
    setSel(0);
    setHidden(false);
  }, [text]);

  const set = (s: string, c: number) => {
    setText(s);
    setCursor(Math.max(0, Math.min(c, s.length)));
  };
  const insertAt = (s: string, at: string, c: number) => set(s.slice(0, c) + at + s.slice(c), c + at.length);
  const insert = (s: string) => insertAt(text, s, cursor);

  const addImages = (list: ImagePart[], base = text, at = cursor) => {
    let s = base;
    let c = at;
    for (const img of list) {
      const n = ++seq.current;
      images.current.set(n, img);
      const tok = `${c > 0 && !/\s$/.test(s.slice(0, c)) ? ' ' : ''}${imageToken(n)} `;
      s = s.slice(0, c) + tok + s.slice(c);
      c += tok.length;
    }
    set(s, c);
  };

  // Text from outside replaces what is typed (the app asks only when the input is empty or the user chose it).
  useEffect(() => {
    if (!p.seed) return;
    images.current.clear();
    pastes.current.clear();
    setHistIndex(-1);
    if (p.seed.images?.length) addImages(p.seed.images, p.seed.text, p.seed.text.length);
    else set(p.seed.text, p.seed.text.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.seed?.nonce]);

  const pasteImage = async () => {
    if (reading) return;
    setReading(true);
    const r = await readClipboardImage();
    setReading(false);
    if ('image' in r) return addImages([r.image]);
    if ('files' in r) {
      const found = r.files.map((f) => imageFile(f));
      const ok = found.filter((x): x is ImagePart => !!x && 'data' in x);
      const big = found.filter((x): x is { error: string } => !!x && 'error' in x);
      if (big.length) p.onNotice('warn', t('Images over 4.5 MB are left out: {n}', { n: big.map((b) => b.error).join(', ') }));
      if (ok.length) return addImages(ok);
      if (!big.length) p.onNotice('info', t('The copied files are not pictures.'));
      return;
    }
    if ('error' in r) return p.onNotice('warn', t('Could not read the clipboard: {n}', { n: r.error }));
    p.onNotice('info', t('No picture on the clipboard. Copy a screenshot or an image first.'));
  };

  usePaste(
    (pasted) => {
      const clean = pasted.replace(/\r\n?/g, '\n');
      const paths = pastedImagePaths(clean, p.cwd);
      if (paths) {
        const found = paths.map((f) => imageFile(f)).filter((x): x is ImagePart => !!x && 'data' in x);
        if (found.length === paths.length) return addImages(found);
      }
      const lines = clean.split('\n').length;
      if (lines > LONG_PASTE_LINES || clean.length > LONG_PASTE_CHARS) {
        const n = pastes.current.size + 1;
        pastes.current.set(n, clean);
        return insert(`${pasteToken(n, lines)} `);
      }
      insert(clean);
    },
    { isActive: p.active && !search },
  );

  const searchMatches = (q: string) => {
    const out: string[] = [];
    for (let i = p.history.length - 1; i >= 0; i--) if (!q || p.history[i].toLowerCase().includes(q.toLowerCase())) out.push(p.history[i]);
    return out;
  };

  const innerWidth = Math.max(10, p.width - 6);
  const lay = useMemo(() => layoutInput(text, cursor, innerWidth), [text, cursor, innerWidth]);

  const submit = () => {
    if (!text.trim()) return;
    const r = resolveInput(text, images.current, pastes.current);
    p.onSubmit(r.text, r.images);
    draft.current = '';
    images.current.clear();
    pastes.current.clear();
    setHistIndex(-1);
    set('', 0);
  };

  useInput(
    (input, key) => {
      if (search) {
        if (key.escape || (key.ctrl && input === 'g') || (key.ctrl && input === 'c')) return setSearch(null);
        if (key.return || key.tab) {
          const m = searchMatches(search.query)[search.skip];
          setSearch(null);
          if (m) set(m, m.length);
          return;
        }
        if (key.ctrl && input === 'r') return setSearch({ ...search, skip: Math.min(search.skip + 1, Math.max(0, searchMatches(search.query).length - 1)) });
        if (key.backspace || key.delete) return setSearch({ query: search.query.slice(0, prevStop(search.query, search.query.length)), skip: 0 });
        if (input && !key.ctrl && !key.meta) return setSearch({ query: search.query + input, skip: 0 });
        return;
      }
      if (key.ctrl && input === 'c') return p.onCtrlC();
      if (key.escape) {
        if (suggestions.length) return setHidden(true);
        return p.onEscape(!text.length);
      }
      if (key.tab && key.shift) return p.onShiftTab?.();
      if (key.tab) {
        if (suggestions.length) {
          const s = suggestions[Math.min(sel, suggestions.length - 1)];
          const { start } = currentToken(text, cursor);
          set(text.slice(0, start) + s.insert + text.slice(cursor), start + s.insert.length);
        }
        return;
      }
      if ((key.meta && input === 'v') || (key.ctrl && input === 'v')) return void pasteImage();
      if (key.ctrl && input === 'r') return setSearch({ query: '', skip: 0 });
      if (key.ctrl && input === 't') return p.onTranscript?.();
      if (key.ctrl && input === 'g' && p.onExternalEdit) {
        void p.onExternalEdit(text).then((s) => s !== null && set(s, s.length));
        return;
      }
      if (key.return) {
        const tok = currentToken(text, cursor).token;
        if (suggestions.length && tok.length > 1 && text.startsWith('/') && !text.includes(' ')) {
          const s = suggestions[Math.min(sel, suggestions.length - 1)];
          if (s.insert.trim() !== text.trim()) return set(s.insert, s.insert.length);
        }
        if (suggestions.length && tok.startsWith('@')) {
          const s = suggestions[Math.min(sel, suggestions.length - 1)];
          const { start } = currentToken(text, cursor);
          return set(text.slice(0, start) + s.insert + text.slice(cursor), start + s.insert.length);
        }
        if (key.shift || key.meta) return insert('\n');
        if (cursor > 0 && text[cursor - 1] === '\\') return set(`${text.slice(0, cursor - 1)}\n${text.slice(cursor)}`, cursor);
        return submit();
      }
      if (key.ctrl && input === 'j') return insert('\n');
      if (key.upArrow) {
        if (suggestions.length) return setSel((s) => (s - 1 + suggestions.length) % suggestions.length);
        if (lay.row > 0) return set(text, offsetAt(lay.rows[lay.row - 1], lay.col));
        if (!text && p.onUpEmpty?.()) return;
        if (!p.history.length) return;
        const next = Math.min(histIndex + 1, p.history.length - 1);
        if (histIndex === -1) draft.current = text;
        setHistIndex(next);
        const h = p.history[p.history.length - 1 - next];
        return set(h, h.length);
      }
      if (key.downArrow) {
        if (suggestions.length) return setSel((s) => (s + 1) % suggestions.length);
        if (lay.row < lay.rows.length - 1) return set(text, offsetAt(lay.rows[lay.row + 1], lay.col));
        if (histIndex < 0) return;
        if (histIndex === 0) {
          setHistIndex(-1);
          return set(draft.current, draft.current.length);
        }
        const next = histIndex - 1;
        setHistIndex(next);
        const h = p.history[p.history.length - 1 - next];
        return set(h, h.length);
      }
      if (key.leftArrow) return set(text, key.ctrl || key.meta ? wordLeft(text, cursor) : prevStop(text, cursor));
      if (key.rightArrow) return set(text, key.ctrl || key.meta ? wordRight(text, cursor) : nextStop(text, cursor));
      if (key.home || (key.ctrl && input === 'a')) return set(text, lay.rows[lay.row].start);
      if (key.end || (key.ctrl && input === 'e')) return set(text, lay.rows[lay.row].end);
      if (key.ctrl && input === 'u') {
        const ls = text.lastIndexOf('\n', cursor - 1) + 1;
        return set(text.slice(0, ls) + text.slice(cursor), ls);
      }
      if (key.ctrl && input === 'k') {
        const le = text.indexOf('\n', cursor);
        return set(text.slice(0, cursor) + text.slice(le === -1 ? text.length : le), cursor);
      }
      if (key.ctrl && input === 'w') {
        const w = wordLeft(text, cursor);
        return set(text.slice(0, w) + text.slice(cursor), w);
      }
      if (key.backspace) {
        if (cursor === 0) return;
        const tok = tokenBefore(text, cursor);
        if (tok) return set(text.slice(0, tok.start) + text.slice(tok.end), tok.start);
        const w = key.ctrl || key.meta ? wordLeft(text, cursor) : prevStop(text, cursor);
        return set(text.slice(0, w) + text.slice(cursor), w);
      }
      if (key.delete) {
        if (cursor >= text.length) return;
        return set(text.slice(0, cursor) + text.slice(nextStop(text, cursor)), cursor);
      }
      if (input && !key.ctrl && !key.meta) insert(input.replace(/\r\n?/g, '\n'));
    },
    { isActive: p.active },
  );

  // Rows shown: the cursor's row stays in view when the text is longer than the box.
  const max = p.maxRows ?? 12;
  const top = Math.max(0, Math.min(lay.row - max + 1, lay.rows.length - max));
  const visible = lay.rows.slice(top, top + max);

  // The terminal's own cursor goes where the text cursor is, so an input method shows its candidates there
  // (border and padding take two columns, the prompt two more). Ink reads the position when this render commits.
  if (!p.active || !box.hasMeasured) setCursorPosition(undefined);
  else if (search) setCursorPosition({ x: 2 + cols(`${t('history')}: ${search.query}`), y: box.top + 1 });
  else setCursorPosition({ x: 4 + lay.col, y: box.top + 1 + (lay.row - top) });

  let body: string;
  if (search) {
    const m = searchMatches(search.query)[search.skip];
    body = `${paint('violet', `${t('history')}: `)}${search.query}${'  '}${m ? paint('muted', clip(m.replace(/\s+/g, ' '), innerWidth - cols(search.query) - 12)) : paint('faint', t('no match'))}`;
  } else if (!text) body = paint('faint', clip(p.placeholder, innerWidth));
  else body = visible.map((r) => colour(r.text)).join('\n');

  const prefix = search ? '' : visible.map((_, i) => (i === 0 && top === 0 ? paint('blue', '› ') : '  ')).join('\n');
  return (
    <Box ref={ref} flexDirection="column">
      <Box borderStyle="round" borderColor={p.active ? borders.active : borders.idle} paddingX={1} width={p.width}>
        {!search && <Text>{prefix || paint('blue', '› ')}</Text>}
        <Box flexGrow={1}>
          <Text wrap="truncate-end">{body}</Text>
        </Box>
      </Box>
      {top > 0 || top + max < lay.rows.length ? <Text>{paint('faint', `  ${t('lines {a}-{b} of {n}', { a: top + 1, b: top + visible.length, n: lay.rows.length })}`)}</Text> : null}
      {reading && <Text>{paint('faint', `  ${t('Reading the clipboard…')}`)}</Text>}
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingX={2}>
          {suggestions.slice(0, 8).map((s, i) => (
            <Text key={s.label} wrap="truncate-end">
              {i === sel ? paint('blue', `▸ ${s.label}`) : paint('muted', `  ${s.label}`)}
              {s.detail ? paint('faint', `  ${s.detail}`) : ''}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
