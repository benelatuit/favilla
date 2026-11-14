import { useSyncExternalStore } from 'react';
import type { FindHit, FindResult } from '@favilla/core/server/find-types';
import type { Message } from './types';
import { api } from './api';
import { getState } from './store';

export type { FindHit };

/**
 * Finding words in the open conversation (Ctrl+F). The engine searches the whole session, whole outputs included;
 * the page walks the matches in the order the timeline shows them, opening what holds the current one.
 */
export interface FindState {
  open: boolean;
  query: string;
  hits: FindHit[];
  total: number;
  capped: boolean;
  /** The current match: which hit, and which match within it. */
  at: { hit: number; n: number } | null;
  busy: boolean;
  /** Counts the times the bar was asked for: asked again while open, it takes the keys and selects its words. */
  asked: number;
}

/**
 * A part of the timeline to bring into view: by find (opening the step or thought that holds the match) or by the
 * outline (a message of the user's). `nonce` tells one request from the next for the same part.
 */
interface Reveal {
  block: string;
  open: boolean;
  nonce: number;
  paste?: number;
}

const CLOSED: FindState = { open: false, query: '', hits: [], total: 0, capped: false, at: null, busy: false, asked: 0 };
let state: FindState = CLOSED;
let reveal: Reveal | null = null;
let nonce = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function getFind(): FindState {
  return state;
}

/** Select from the find state and the part being brought into view; the selector should return a plain value. */
export function useFind<T>(select: (f: FindState, r: Reveal | null) => T): T {
  return useSyncExternalStore(subscribe, () => select(state, reveal));
}

function set(patch: Partial<FindState>): void {
  state = { ...state, ...patch };
  emit();
}

/** Bring a part of the timeline into view; `open` also opens the step or thought that holds it. */
function revealBlock(block: string, open = false, paste?: number): void {
  reveal = { block, open, nonce: ++nonce, ...(paste === undefined ? {} : { paste }) };
  emit();
}

/** Whether `block` is being brought into view: the request's nonce, or 0. */
export const revealNonce = (r: Reveal | null, blocks: string | string[]): number => (r && (typeof blocks === 'string' ? r.block === blocks : blocks.includes(r.block)) ? r.nonce : 0);

export function openFind(): void {
  set({ open: true, asked: state.asked + 1 });
}

/** Close the bar; the words stay for the next time it opens, as a browser's find keeps them. */
export function closeFind(): void {
  clearTimeout(timer);
  pending?.abort();
  seq++;
  state = { ...CLOSED, query: state.query, asked: state.asked };
  reveal = null;
  emit();
}

/**
 * The parts of a conversation in the order the timeline draws them, by the names find uses: a message's id, an
 * answer's or thought's `messageId:part`, a step's call id.
 */
export function blockOrder(messages: Message[]): Map<string, number> {
  const order = new Map<string, number>();
  for (const m of messages) {
    if (m.replay) continue;
    if (m.role === 'assistant') {
      m.parts.forEach((p, i) => {
        if (p.type === 'tool_call') order.set(p.id, order.size);
        else if (p.type === 'text' || p.type === 'reasoning') order.set(`${m.id}:${i}`, order.size);
      });
    } else order.set(m.id, order.size);
  }
  return order;
}

/**
 * Where a new search starts: at the first match from the part on screen down, as a browser's find does, or at the
 * last match when there is none below (the usual place in a conversation is its end).
 */
export function startAt(hits: FindHit[], order: Map<string, number>, onScreen: string | null): number {
  if (!hits.length) return -1;
  const from = onScreen === null ? undefined : order.get(onScreen);
  if (from === undefined) return hits.length - 1;
  const i = hits.findIndex((h) => (order.get(h.block) ?? Infinity) >= from);
  return i < 0 ? hits.length - 1 : i;
}

/** The position of the current match among all of them, counted from 1. */
export function position(f: FindState): number {
  if (!f.at) return 0;
  let n = f.at.n + 1;
  for (let i = 0; i < f.at.hit; i++) n += f.hits[i].count;
  return n;
}

/** The next or previous match, round the ends. */
export function step(f: FindState, dir: 1 | -1): FindState['at'] {
  if (!f.hits.length) return null;
  if (!f.at) return { hit: dir > 0 ? 0 : f.hits.length - 1, n: dir > 0 ? 0 : f.hits[f.hits.length - 1].count - 1 };
  const { hit, n } = f.at;
  if (dir > 0) return n + 1 < f.hits[hit].count ? { hit, n: n + 1 } : { hit: (hit + 1) % f.hits.length, n: 0 };
  if (n > 0) return { hit, n: n - 1 };
  const prev = (hit - 1 + f.hits.length) % f.hits.length;
  return { hit: prev, n: f.hits[prev].count - 1 };
}

function go(at: FindState['at']): void {
  set({ at });
  const h = at ? state.hits[at.hit] : undefined;
  if (h) revealBlock(h.block, !!h.output, h.paste);
}

interface CurrentMatch {
  block: string;
  n: number;
  paste?: number;
}

export function currentMatch(f: FindState): CurrentMatch | null {
  const h = f.at && f.hits[f.at.hit];
  return h && f.at ? { block: h.block, paste: h.paste, n: f.at.n } : null;
}

export function findNext(dir: 1 | -1): void {
  if (state.hits.length) go(step(state, dir));
}

let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: AbortController | undefined;

/**
 * Search for `query`, a moment after the last key: the engine answers with every place it is in. `onScreen` names
 * the part of the conversation in view, where the walk starts; with `keep`, the walk stays where it was (the same
 * search again as the conversation grows).
 */
export function search(query: string, onScreen: () => string | null, keep = false): void {
  set({ query, busy: !!query.trim() });
  clearTimeout(timer);
  pending?.abort();
  const id = getState().activeId;
  if (!query.trim() || !id) {
    seq++;
    set({ hits: [], total: 0, capped: false, at: null, busy: false });
    return;
  }
  const mine = ++seq;
  timer = setTimeout(() => {
    const controller = new AbortController();
    pending = controller;
    api<FindResult>(`/sessions/${id}/find?q=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then((r) => {
        if (mine !== seq || !state.open) return;
        const before = keep && state.at ? state.hits[state.at.hit] : undefined;
        state = { ...state, hits: r.hits, total: r.total, capped: r.capped, busy: false };
        if (before) {
          const same = r.hits.findIndex((h) => h.block === before.block && h.paste === before.paste);
          if (same >= 0) return set({ at: { hit: same, n: Math.min(state.at!.n, r.hits[same].count - 1) } });
        }
        const first = startAt(r.hits, blockOrder(getState().session?.messages ?? []), onScreen());
        go(first < 0 ? null : { hit: first, n: 0 });
      })
      .catch(() => mine === seq && set({ hits: [], total: 0, capped: false, at: null, busy: false }))
      .finally(() => { if (pending === controller) pending = undefined; });
  }, 140);
}

// ── the matches on the page ───────────────────────────────────────────────

const SKIP = 'textarea, input, script, style, [data-find-skip]';
const PASTE = '[data-find-paste]';

/**
 * The matches of `needle` in the text under `root`, as ranges. Text split over several nodes (highlighted code, a
 * bold word in a sentence) is matched as one string, so a match may span nodes; parts marked data-find-skip (a
 * turn's ledger, labels) are not searched, as the engine does not search them.
 */
function rangesIn(root: Element, needle: string): Range[] {
  const q = needle.toLowerCase();
  if (!q.trim()) return [];
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const paste = root.matches(PASTE);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) || (!paste && n.parentElement?.closest(PASTE)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push(n);
    starts.push(text.length);
    text += n.data;
  }
  const lower = text.toLowerCase();
  const out: Range[] = [];
  // The node holding character `at`: the last one starting at or before it.
  const nodeAt = (at: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
    const a = nodeAt(at);
    const b = nodeAt(at + q.length - 1);
    const r = document.createRange();
    r.setStart(nodes[a], at - starts[a]);
    r.setEnd(nodes[b], at + q.length - starts[b]);
    out.push(r);
  }
  return out;
}

const supported = () => typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && 'highlights' in CSS;

let matchCards = new Set<Element>();

function layOutMatches(cards: Set<Element>): void {
  for (const card of matchCards) if (!cards.has(card)) card.classList.remove('has-find-matches');
  for (const card of cards) card.classList.add('has-find-matches');
  matchCards = cards;
}

/**
 * Mark every match on the page and the current one apart (the CSS highlight API: the page's nodes are not touched,
 * so React's are left as they are). Returns the current match's range, once its part is on the page.
 */
export function paint(scope: Element | null, needle: string, current: CurrentMatch | null): Range | null {
  if (!supported()) return null;
  const all: Range[] = [];
  const cards = new Set<Element>();
  let now: Range | null = null;
  if (scope && needle.trim()) {
    const mark = (root: HTMLElement) => {
      const ranges = rangesIn(root, needle);
      if (ranges.length) {
        all.push(...ranges);
        // A match inside a fold or tool output needs its whole timeline card laid out before it can be placed.
        let card: Element = root;
        while (card.parentElement && card.parentElement !== scope) card = card.parentElement;
        if (card.parentElement === scope) cards.add(card);
      }
      return ranges;
    };
    for (const root of scope.querySelectorAll<HTMLElement>('[data-find]')) {
      const ranges = mark(root);
      if (current && current.paste === undefined && root.dataset.find === current.block && ranges.length) now = ranges[Math.min(current.n, ranges.length - 1)];
    }
    for (const root of scope.querySelectorAll<HTMLElement>(PASTE)) {
      const ranges = mark(root);
      if (current && Number(root.dataset.findPaste) === current.paste && root.closest<HTMLElement>('[data-find]')?.dataset.find === current.block && ranges.length) {
        now = ranges[Math.min(current.n, ranges.length - 1)];
      }
    }
  }
  layOutMatches(cards);
  CSS.highlights.set('favilla-find', new Highlight(...all));
  if (now) CSS.highlights.set('favilla-find-now', new Highlight(now));
  else CSS.highlights.delete('favilla-find-now');
  return now;
}

export function unpaint(): void {
  layOutMatches(new Set());
  if (!supported()) return;
  CSS.highlights.delete('favilla-find');
  CSS.highlights.delete('favilla-find-now');
}

/**
 * Bring a part of the conversation to the top of the view once it is drawn (the outline's jump), and mark it a
 * moment so the eye finds it. A second look a few frames later corrects for the parts above it that were drawn
 * only as they came near.
 */
export function showBlock(block: string): void {
  revealBlock(block);
  let frames = 0;
  const place = (el: HTMLElement) => {
    const view = document.querySelector<HTMLElement>('.main .scroll');
    if (view) view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top - 16;
  };
  const tick = () => {
    const el = document.querySelector<HTMLElement>(`.main .timeline [data-find="${CSS.escape(block)}"]`);
    if (!el) {
      if (++frames < 60) requestAnimationFrame(tick);
      return;
    }
    place(el);
    setTimeout(() => place(el), 120);
    el.classList.remove('is-shown');
    void el.offsetWidth;
    el.classList.add('is-shown');
    setTimeout(() => el.classList.remove('is-shown'), 1600);
  };
  requestAnimationFrame(tick);
}
