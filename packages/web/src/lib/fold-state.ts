import { useCallback, useSyncExternalStore } from 'react';
import { isReadOnlyLookStep } from './steps';
import type { Item, Step } from './timeline';

export interface FoldState {
  /** Explicit user toggle overrides (foldKey -> open). Takes priority over auto-open and auto-collapse. */
  byUser: Readonly<Record<string, boolean>>;
  /** Keys opened automatically by Ctrl+F search navigation. Can still be closed manually by clicking. */
  revealed: Readonly<Record<string, true>>;
  /** Alias key -> canonical key (e.g. settled `p:${callId}` -> draft `p:${msgId}:${index}`). */
  aliases: Readonly<Record<string, string>>;
}

export const EMPTY_FOLD_STATE: FoldState = {
  byUser: {},
  revealed: {},
  aliases: {},
};

export type FoldAction =
  | { type: 'TOGGLE'; key: string; aliasKey?: string; currentOpen: boolean }
  | { type: 'SET'; key: string; aliasKey?: string; open: boolean }
  | { type: 'REVEAL_PATH'; keys: readonly string[] }
  | { type: 'REGISTER_ALIASES'; pairs: readonly (readonly [alias: string, canonical: string])[] }
  | { type: 'CLEAR_REVEALED' };

export function resolveFoldKey(state: FoldState, key: string): string {
  let cur = key;
  for (let depth = 0; depth < 4; depth++) {
    const next = state.aliases[cur];
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}

export function selectIsOpen(state: FoldState, key: string, defaultOpen: boolean, aliasKey?: string): boolean {
  const canonical = resolveFoldKey(state, key);
  const alt = aliasKey && aliasKey !== key ? resolveFoldKey(state, aliasKey) : undefined;

  if (state.byUser[canonical] !== undefined) return state.byUser[canonical];
  if (alt !== undefined && state.byUser[alt] !== undefined) return state.byUser[alt];

  if (state.revealed[canonical]) return true;
  if (alt !== undefined && state.revealed[alt]) return true;

  return defaultOpen;
}

export function foldReducer(state: FoldState, action: FoldAction): FoldState {
  switch (action.type) {
    case 'TOGGLE':
    case 'SET': {
      const open = action.type === 'SET' ? action.open : !action.currentOpen;
      const canonical = resolveFoldKey(state, action.key);
      const alt = action.aliasKey && action.aliasKey !== action.key ? resolveFoldKey(state, action.aliasKey) : undefined;
      const byUser = { ...state.byUser, [canonical]: open };
      if (alt && alt !== canonical) delete byUser[alt];
      let revealed = state.revealed;
      if (!open && (revealed[canonical] || (alt && revealed[alt]))) {
        const nextRevealed = { ...revealed };
        delete nextRevealed[canonical];
        if (alt) delete nextRevealed[alt];
        revealed = nextRevealed;
      }
      const aliases = alt && alt !== canonical && state.aliases[alt] !== canonical ? { ...state.aliases, [alt]: canonical } : state.aliases;
      return { byUser, revealed, aliases };
    }
    case 'REVEAL_PATH': {
      if (!action.keys.length) return state;
      let changed = false;
      const revealed = { ...state.revealed };
      const byUser = { ...state.byUser };
      for (const raw of action.keys) {
        const k = resolveFoldKey(state, raw);
        if (!revealed[k]) {
          revealed[k] = true;
          changed = true;
        }
        if (byUser[k] === false) {
          delete byUser[k];
          changed = true;
        }
      }
      return changed ? { ...state, byUser, revealed } : state;
    }
    case 'REGISTER_ALIASES': {
      if (!action.pairs.length) return state;
      let aliases: Record<string, string> | null = null;
      let byUser: Record<string, boolean> | null = null;
      let revealed: Record<string, true> | null = null;
      for (const [alias, canonical] of action.pairs) {
        if (!alias || !canonical || alias === canonical) continue;
        if ((aliases ?? state.aliases)[alias] !== canonical) {
          aliases ??= { ...state.aliases };
          aliases[alias] = canonical;
        }
        // Migrate any user toggle or search reveal recorded under `alias` before `canonical` was known.
        const curByUser = byUser ?? state.byUser;
        if (curByUser[alias] !== undefined && curByUser[canonical] === undefined) {
          byUser ??= { ...state.byUser };
          byUser[canonical] = byUser[alias];
          delete byUser[alias];
        }
        const curRevealed = revealed ?? state.revealed;
        if (curRevealed[alias] && !curRevealed[canonical]) {
          revealed ??= { ...state.revealed };
          revealed[canonical] = true;
          delete revealed[alias];
        }
      }
      if (!aliases && !byUser && !revealed) return state;
      return {
        byUser: byUser ?? state.byUser,
        revealed: revealed ?? state.revealed,
        aliases: aliases ?? state.aliases,
      };
    }
    case 'CLEAR_REVEALED': {
      if (!Object.keys(state.revealed).length) return state;
      return { ...state, revealed: {} };
    }
  }
}

export type ToolStep = Extract<Step, { kind: 'tool' }>;
export type ThoughtRunRow = { kind: 'run'; key: string; texts: string[]; keys: string[] };
export type StepRow = ThoughtRunRow | Step;
export type LookGroupRow = { kind: 'look'; key: string; anchorKey: string; rows: StepRow[] };
export type ProcessDisplayRow = StepRow | LookGroupRow;

/** Consecutive finished thoughts merge into one ThoughtRun row; live thoughts and tool steps stand on their own. */
export function stepRows(steps: readonly Step[]): StepRow[] {
  const rows: StepRow[] = [];
  for (const s of steps) {
    const last = rows[rows.length - 1];
    if (s.kind === 'reasoning' && !s.live && last?.kind === 'reasoning' && !last.live) {
      rows[rows.length - 1] = { kind: 'run', key: last.key, texts: [last.text, s.text], keys: [last.key, s.key] };
    } else if (s.kind === 'reasoning' && !s.live && last?.kind === 'run') {
      last.texts.push(s.text);
      last.keys.push(s.key);
    } else {
      rows.push(s);
    }
  }
  return rows;
}

export function isLookRowTool(row: StepRow): row is ToolStep {
  return row.kind === 'tool' && isReadOnlyLookStep(row);
}

/**
 * Two or more consecutive strictly read-only tool steps (with finished thoughts between them) collapse into one
 * LookGroup row; trailing thoughts after the last read-only step stay outside to lead into the next action.
 */
export function lookRows(rows: readonly StepRow[]): ProcessDisplayRow[] {
  const out: ProcessDisplayRow[] = [];
  let run: StepRow[] = [];
  const flush = () => {
    const last = run.map((r) => isLookRowTool(r)).lastIndexOf(true);
    const head = run.slice(0, last + 1);
    if (head.filter(isLookRowTool).length >= 2) {
      const first = head[0];
      const anchor = first.kind === 'tool' && first.draftKey ? first.draftKey : first.key;
      out.push({ kind: 'look', key: `look-${first.key}`, anchorKey: `look-${anchor}`, rows: head });
    } else {
      out.push(...head);
    }
    out.push(...run.slice(last + 1));
    run = [];
  };
  for (const r of rows) {
    if (isLookRowTool(r) || (run.length && (r.kind === 'run' || (r.kind === 'reasoning' && !r.live)))) {
      run.push(r);
    } else {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}

export const rowBlockKeys = (rows: readonly StepRow[]): string[] => rows.flatMap((r) => (r.kind === 'run' ? r.keys : [r.key]));

/** Canonical fold key helpers across all 5 timeline fold layers. */
export const foldKey = {
  work: (key: string) => key,
  process: (it: { key: string; anchorKey?: string }) => it.anchorKey ?? it.key,
  look: (row: { key: string; anchorKey?: string }) => row.anchorKey ?? row.key,
  thoughtRun: (key: string) => `thought-run:${key}`,
  thought: (key: string) => `thought:${key}`,
  step: (step: { id: string; draftKey?: string }) => `step:${step.draftKey ?? step.id}`,
  stepById: (callId: string) => `step:${callId}`,
  user: (id: string) => `user:${id}`,
  compaction: (id: string) => `compaction:${id}`,
};

/** True when the reader explicitly opened at least one step or thought inside `steps` (and has not closed it since). */
export function hasUserOpenedStep(state: FoldState, steps: readonly Step[]): boolean {
  if (state === EMPTY_FOLD_STATE) return false;
  let anyOverride = false;
  for (const k in state.byUser) {
    if (state.byUser[k] === true) {
      anyOverride = true;
      break;
    }
  }
  if (!anyOverride) return false;
  for (const s of steps) {
    if (s.kind === 'tool') {
      const k = resolveFoldKey(state, foldKey.step(s));
      if (state.byUser[k] === true) return true;
      if (s.draftKey && s.draftKey !== s.id) {
        const alt = resolveFoldKey(state, foldKey.stepById(s.id));
        if (state.byUser[alt] === true) return true;
      }
    } else {
      if (state.byUser[resolveFoldKey(state, foldKey.thought(s.key))] === true) return true;
      if (state.byUser[resolveFoldKey(state, foldKey.thoughtRun(s.key))] === true) return true;
    }
  }
  return false;
}

/** Collect `(alias -> canonical)` pairs from timeline items when `tool.start` callId and `draftKey` coexist. */
export function extractTimelineAliases(items: readonly Item[]): [string, string][] {
  const pairs: [string, string][] = [];
  const visit = (list: readonly Item[]) => {
    for (const it of list) {
      if (it.kind === 'work') {
        visit(it.items);
      } else if (it.kind === 'process') {
        if (it.anchorKey && it.anchorKey !== it.key) pairs.push([it.key, it.anchorKey]);
        let hasDraft = false;
        for (const s of it.steps) {
          if (s.kind === 'tool' && s.draftKey && s.draftKey !== s.id) {
            pairs.push([`step:${s.id}`, `step:${s.draftKey}`]);
            hasDraft = true;
          }
        }
        if (hasDraft) {
          for (const r of lookRows(stepRows(it.steps))) {
            if (r.kind === 'look' && r.anchorKey !== r.key) pairs.push([r.key, r.anchorKey]);
          }
        }
      }
    }
  };
  visit(items);
  return pairs;
}

function stepRowMatchKeys(row: StepRow, blockKey: string, openStep: boolean): string[] | null {
  if (row.kind === 'run') {
    return row.keys.includes(blockKey) ? [foldKey.thoughtRun(row.key), foldKey.thought(blockKey)] : null;
  }
  if (row.kind === 'reasoning') {
    return row.key === blockKey ? [foldKey.thought(row.key)] : null;
  }
  if (row.key === blockKey || row.id === blockKey || row.draftKey === blockKey) {
    return openStep ? [foldKey.step(row)] : [];
  }
  return null;
}

/**
 * Synchronously computes every nested fold key (WorkFold -> ProcessGroup -> LookGroup -> ThoughtRun -> Thought/Step/User/Compaction)
 * that must open so `blockKey` is mounted in a single render pass during Ctrl+F navigation.
 */
export function computeRevealPath(items: readonly Item[], blockKey: string, opts: { openStep?: boolean } = {}): string[] {
  const { openStep = true } = opts;
  const searchProcess = (it: Extract<Item, { kind: 'process' }>): string[] | null => {
    const pKey = foldKey.process(it);
    for (const row of lookRows(stepRows(it.steps))) {
      if (row.kind === 'look') {
        for (const inner of row.rows) {
          const hit = stepRowMatchKeys(inner, blockKey, openStep);
          if (hit) return [pKey, foldKey.look(row), ...hit];
        }
      } else {
        const hit = stepRowMatchKeys(row, blockKey, openStep);
        if (hit) return [pKey, ...hit];
      }
    }
    return null;
  };

  for (const it of items) {
    if (it.kind === 'work') {
      for (const inner of it.items) {
        if (inner.kind === 'process') {
          const hit = searchProcess(inner);
          if (hit) return [foldKey.work(it.key), ...hit];
        } else if (inner.key === blockKey) {
          return [foldKey.work(it.key)];
        }
      }
    } else if (it.kind === 'process') {
      const hit = searchProcess(it);
      if (hit) return hit;
    } else if (it.kind === 'user' && it.key === blockKey) {
      return [foldKey.user(it.key)];
    } else if (it.kind === 'compaction' && it.key === blockKey) {
      return [foldKey.compaction(it.key)];
    }
  }
  return [];
}

// ── Per-session external store (LRU-capped, zero global store coupling) ────

const MAX_SESSIONS = 64;
const DEFAULT_SESSION_KEY = '__default__';
const states = new Map<string, FoldState>();
const listeners = new Map<string, Set<() => void>>();

function normSession(sessionId?: string): string {
  return sessionId || DEFAULT_SESSION_KEY;
}

function notifySession(sid: string): void {
  const set = listeners.get(sid);
  if (set) for (const fn of set) fn();
}

export function getFoldState(sessionId?: string): FoldState {
  return states.get(normSession(sessionId)) ?? EMPTY_FOLD_STATE;
}

export function dispatchFold(sessionId: string | undefined, action: FoldAction): void {
  const sid = normSession(sessionId);
  const prev = states.get(sid) ?? EMPTY_FOLD_STATE;
  const next = foldReducer(prev, action);
  if (next === prev) return;
  if (states.has(sid)) states.delete(sid);
  states.set(sid, next);
  if (states.size > MAX_SESSIONS) {
    const oldest = states.keys().next().value;
    if (oldest !== undefined && oldest !== sid) states.delete(oldest);
  }
  notifySession(sid);
}

export function toggleFoldOpen(sessionId: string | undefined, key: string, currentOpen: boolean, aliasKey?: string): void {
  dispatchFold(sessionId, { type: 'TOGGLE', key, aliasKey, currentOpen });
}

export function setFoldOpen(sessionId: string | undefined, key: string, open: boolean, aliasKey?: string): void {
  dispatchFold(sessionId, { type: 'SET', key, aliasKey, open });
}

export function revealFoldPath(sessionId: string | undefined, keys: readonly string[]): void {
  dispatchFold(sessionId, { type: 'REVEAL_PATH', keys });
}

export function syncFoldAliases(sessionId: string | undefined, items: readonly Item[]): void {
  const pairs = extractTimelineAliases(items);
  if (pairs.length) dispatchFold(sessionId, { type: 'REGISTER_ALIASES', pairs });
}

export function resetFoldStore(): void {
  const touched = [...states.keys()];
  states.clear();
  for (const sid of touched) notifySession(sid);
}

export function subscribeFold(sessionId: string | undefined, listener: () => void): () => void {
  const sid = normSession(sessionId);
  let set = listeners.get(sid);
  if (!set) {
    set = new Set();
    listeners.set(sid, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (!set!.size) listeners.delete(sid);
  };
}

/**
 * Subscribes a fold container to its resolved boolean state in `sessionId`.
 * Only components whose boolean actually flips re-render on click or search reveal.
 */
export function useFoldOpen(
  sessionId: string | undefined,
  key: string | undefined,
  defaultOpen: boolean | ((state: FoldState) => boolean),
  aliasKey?: string,
): [boolean, () => void, (open: boolean) => void] {
  const subscribe = useCallback((fn: () => void) => (key ? subscribeFold(sessionId, fn) : () => {}), [sessionId, key]);
  const open = useSyncExternalStore(subscribe, () => {
    const state = getFoldState(sessionId);
    const fallback = typeof defaultOpen === 'function' ? defaultOpen(state) : defaultOpen;
    return key ? selectIsOpen(state, key, fallback, aliasKey) : fallback;
  });
  const toggle = useCallback(() => {
    if (key) toggleFoldOpen(sessionId, key, open, aliasKey);
  }, [sessionId, key, open, aliasKey]);
  const set = useCallback(
    (next: boolean) => {
      if (key) setFoldOpen(sessionId, key, next, aliasKey);
    },
    [sessionId, key, aliasKey],
  );
  return [open, toggle, set];
}
