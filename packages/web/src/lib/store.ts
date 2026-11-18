import type { SettingBasis } from '@favilla/core/types';
import { useSyncExternalStore } from 'react';
import { fill, resolveLang, translate } from './i18n';
import { notifyAway } from './notify';
import { stepFailed, toolTitle } from './steps';
import { moveComposerDraft } from './composer-draft';
import { ApiError, api, connectEvents, type EventConnection, type ServerEvent } from './api';
import type { BackgroundRun, SessionMeta } from '@favilla/core/types';
import { settingText, type SettingsNotice } from '@favilla/core/i18n';
import type { ChildView, Draft, DraftPart, Effort, Info, Mode, ProviderView, RunningTool, SessionListItem, SessionView, StreamDraft, TurnChanges } from './types';
import type { MenuEntry } from '../components/ui/Menu';
import type { UpdateView } from '@favilla/core/update/view';
import { refreshUpdate } from './update';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
  load?: () => void;
}

export interface DialogState {
  title: string;
  body?: string;
  confirm: string;
  cancel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

/** A page of the settings. */
export type SettingsPage = 'general' | 'appearance' | 'providers' | 'models' | 'rules' | 'personas' | 'presets' | 'tools' | 'mcp' | 'mail' | 'remote' | 'usage' | 'storage';

export interface UiState {
  /** Docked on wide windows; a drawer on narrow ones. */
  sidebar: boolean;
  panel: boolean;
  panelTab: 'preview' | 'changes' | 'context' | 'outline';
  /** The settings: open where they were left (true), or open on a page that a link elsewhere names. */
  settings: boolean | SettingsPage;
  palette: boolean;
  /** The browser's folder browser (the desktop app uses the system dialog). */
  picker: boolean;
  dialog: DialogState | null;
  menu: { x: number; y: number; entries: MenuEntry[] } | null;
  /** The session whose title is being edited in the sidebar. */
  renaming: string | null;
  /** The id of the user message being edited in place, to be sent again in a new branch. */
  editing: string | null;
  /** Pictures open in the full-screen viewer, which one is shown, and which opening this is (each starts afresh). */
  viewer: { images: ViewerImage[]; index: number; opened: number } | null;
  /** A file an answer named, open in the file view at its lines; a relative path is the session's project's. */
  fileView: { path: string; line?: number; end?: number; session?: string } | null;
  /** A sub-agent's whole conversation, open in a sheet over the timeline. */
  sheet: { sessionId: string; title: string } | null;
  /** Every file one turn changed, open in a sheet at one of them. */
  changesView: { session: string; turn: string; file?: string } | null;
}

/** Choices made before a session exists; they apply to the session the first message creates. */
export interface DraftOptions {
  model?: string;
  effort?: Effort;
  mode?: Mode;
}

export interface State {
  info: Info | null;
  providers: ProviderView[];
  sessions: SessionListItem[];
  folder: string;
  recent: string[];
  /** Sessions kept at the top of the sidebar, newest pin first. */
  pinned: string[];
  /** Folders folded in the sidebar, by folderKey. */
  collapsed: string[];
  activeId: string | null;
  session: SessionView | null;
  drafts: Map<string, Draft>;
  draftTails: DraftTails;
  running: Map<string, RunningTool>;
  /** The sub-agents of the open session's calls, by call id, followed while they work and kept after. */
  children: Map<string, ChildView[]>;
  /** The open session's sub-agents at work in the background; they can outlast its turn. */
  background: BackgroundRun[];
  connection: import('./api').ConnectionState;
  toasts: Toast[];
  loading: boolean;
  /**
   * At start, from the first frame until the session the window had open is back or found gone: the welcome page
   * stands in for it meanwhile and leaves out what it would add (the folder's sessions and branch).
   */
  reopening: boolean;
  /** What the update feed says and how far a download has come (core/src/update/updater.ts); null until the server says. */
  update: UpdateView | null;
  /** Tool results of the open session by call id (for pairing calls with results). */
  results: Map<string, import('./types').ToolResultPart>;
  ui: UiState;
  draft: DraftOptions;
  /** When the current turn started, for the elapsed time shown while the agent works. */
  turnStarted: number | null;
  /** Why the open session's last turn ended on an error, and what kind of failure it was, until the next one starts. */
  failed: Failure | null;
  /** What is under way in the sessions that are not open, so going back to one loses nothing. */
  lives: Map<string, Live>;
  /** Messages the agent never read (the turn was interrupted or failed), for the composer to take back in. */
  returned: { items: { text: string; images: { mediaType: string; data: string; name?: string }[] }[]; at: number } | null;
}

/** A picture for the viewer: where it loads from, its name, and where it came from. */
export interface ViewerImage {
  src: string;
  name: string;
  caption?: string;
}

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The keys the server keeps too (ui-state.json): the page's own storage belongs to its address, and the desktop app's address can change. */
const SERVER_KEYS: Record<string, string> = { 'favilla.folder': 'folder', 'favilla.recent': 'recent', 'favilla.session': 'session', 'favilla.layout': 'layout', 'favilla.last': 'last', 'favilla.pinned': 'pinned', 'favilla.collapsed': 'collapsed' };
let uiPatch: Record<string, unknown> = {};
let uiTimer: ReturnType<typeof setTimeout> | null = null;

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
  const field = SERVER_KEYS[key];
  if (!field) return;
  uiPatch[field] = value;
  if (uiTimer) clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    const body = uiPatch;
    uiPatch = {};
    api('/ui-state', { method: 'PUT', body }).catch(() => {});
  }, 300);
}

const layout = stored<{ sidebar: boolean; panel: boolean }>('favilla.layout', { sidebar: true, panel: false });

/**
 * The model and effort the user last worked with: a new session starts with them (the settings' defaults only
 * until there is a last one). Kept by the server too, as the page's storage can be a new one.
 */
let lastPick: DraftOptions = stored<DraftOptions>('favilla.last', {});

function noteLast(model?: string, effort?: Effort): void {
  const next = { ...lastPick, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  if (next.model === lastPick.model && next.effort === lastPick.effort) return;
  lastPick = next;
  store('favilla.last', lastPick);
}

/** What a new session starts with: the last pick, less a model no configured provider has any more. */
function startPick(): DraftOptions {
  const known = state.providers.some((p) => p.configured && p.models.some((m) => m.ref === lastPick.model));
  return { ...(known ? { model: lastPick.model } : {}), ...(lastPick.effort ? { effort: lastPick.effort } : {}) };
}

let state: State = {
  info: null,
  providers: [],
  sessions: [],
  folder: '',
  recent: stored<string[]>('favilla.recent', []),
  pinned: stored<string[]>('favilla.pinned', []),
  collapsed: stored<string[]>('favilla.collapsed', []),
  activeId: null,
  session: null,
  drafts: new Map(),
  draftTails: new Map(),
  running: new Map(),
  children: new Map(),
  background: [],
  connection: 'connecting',
  toasts: [],
  loading: true,
  reopening: false,
  update: null,
  results: new Map(),
  ui: { sidebar: layout.sidebar, panel: layout.panel, panelTab: 'changes', settings: false, palette: false, picker: false, dialog: null, menu: null, renaming: null, editing: null, viewer: null, fileView: null, sheet: null, changesView: null },
  draft: {},
  turnStarted: null,
  failed: null,
  lives: new Map(),
  returned: null,
};

const listeners = new Set<() => void>();
let batching = 0;
let changed = false;
const emit = () => {
  if (batching) { changed = true; return; }
  changed = false;
  listeners.forEach((l) => l());
};

/** A frame is one snapshot: subscribers must not see every intermediate map or a half-committed message. */
function batch(fn: () => void): void {
  batching++;
  try {
    fn();
  } finally {
    if (--batching === 0 && changed) emit();
  }
}

let events: EventConnection | undefined;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const before = state.activeId;
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  if (before !== state.activeId) events?.follow?.(state.activeId);
  emit();
}

export function getState(): State {
  return state;
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

export function setUi(patch: Partial<UiState>): void {
  setState((s) => ({ ui: { ...s.ui, ...patch } }));
  // Only the docked layout of a wide window is remembered; drawers on small screens start closed.
  if (('sidebar' in patch || 'panel' in patch) && window.matchMedia('(min-width: 1180px)').matches) store('favilla.layout', { sidebar: state.ui.sidebar, panel: state.ui.panel });
}

/** The app's own confirmation dialog; resolves to true when confirmed. */
export function confirmDialog(opts: { title: string; body?: string; confirm: string; cancel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    setUi({
      dialog: {
        ...opts,
        resolve: (ok) => {
          setUi({ dialog: null });
          resolve(ok);
        },
      },
    });
  });
}

let toastSeq = 0;
export function toast(text: string, level: Toast['level'] = 'info', load?: () => void): void {
  const id = ++toastSeq;
  setState((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, level, text, load }].slice(-4) }));
  if (!load) setTimeout(() => dismissToast(id), level === 'error' ? 9000 : 4500);
}

export function settingSaveError(error: unknown, load: () => void | Promise<void> = () => actions.loadSettings()): void {
  const retry = error instanceof ApiError && error.settingsConflict
    ? () => { void Promise.resolve().then(load).catch((e) => toast((e as Error).message, 'error')); } : undefined;
  toast((error as Error).message, 'error', retry);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

const shownSettings = new Set<string>();

function showSettings(notices: readonly SettingsNotice[] = []): void {
  const lang = resolveLang(state.info?.config.language);
  for (const note of notices) {
    if (shownSettings.has(note.id)) continue;
    shownSettings.add(note.id);
    toast(settingText(note, (key) => translate(lang, key)), 'error');
  }
}

function updateInfo(info: Info): void {
  setState({ info });
  showSettings(info.settingsNotices);
}

const receivedInputs = new Set<string>();

function returnToComposer(items: NonNullable<SessionView['returned']>, sessionId?: string): Partial<Pick<State, 'returned'>> {
  const ids = items.flatMap((p) => p.id ? [p.id] : []);
  const fresh = items.filter((p) => {
    if (!p.id) return true;
    if (receivedInputs.has(p.id)) return false;
    receivedInputs.add(p.id);
    if (receivedInputs.size > 4096) receivedInputs.delete(receivedInputs.values().next().value!);
    return true;
  });
  // A view and a replay can both carry the input. Acknowledge after putting it back, even if we already saw it.
  if (sessionId && ids.length) queueMicrotask(() => {
    void api(`/sessions/${sessionId}/returned`, { body: { ids } }).catch(() => {});
  });
  return fresh.length ? { returned: { items: [...(state.returned?.items ?? []), ...fresh.map(({ text, images }) => ({ text, images }))], at: Date.now() } } : {};
}

type HeldPart = DraftPart & { at: number };
type DraftTails = Map<string, Map<number, HeldPart>>;

/** What is under way in one session: messages being written, tools running, its sub-agents, the turn's start. */
export interface Live {
  drafts: Map<string, Draft>;
  draftTails: DraftTails;
  running: Map<string, RunningTool>;
  children: Map<string, ChildView[]>;
  background: BackgroundRun[];
  turnStarted: number | null;
  /**
   * Why the last turn ended on an error, or that it was stopped, until the next one starts. The toast that says it
   * goes after a few seconds; this keeps a line at the end of the conversation, where a message with no reply and no
   * reason had stood.
   */
  failed: Failure | null;
}

/**
 * A turn's failure: the provider's own words, and its kind (auth, network, model_not_found…) when a provider failed.
 * A turn the user stopped is kind 'aborted' with no words.
 */
export type Failure = { text: string; kind?: string };

const EMPTY_LIVE = (): Live => ({ drafts: new Map(), draftTails: new Map(), running: new Map(), children: new Map(), background: [], turnStarted: null, failed: null });

type SessionEvent = Extract<ServerEvent, { sessionId: string }>;

interface SessionObserver {
  id: string;
  event: (event: SessionEvent) => void;
  reconnect: () => void;
}

const sessionObservers = new Set<SessionObserver>();

/** An open sheet sees its session's events, including ones relayed through a parent. */
export function observeSession(observer: SessionObserver): () => void {
  sessionObservers.add(observer);
  return () => sessionObservers.delete(observer);
}

/** The events that change what is under way; they are kept for every session, open or not. */
const LIVE_EVENTS = new Set(['stream.start', 'stream.text', 'stream.reasoning', 'stream.tool', 'stream.discard', 'message.added', 'tool.start', 'tool.progress', 'tool.end', 'subagent', 'background', 'turn.start', 'turn.end']);

const liveOf = (s: State): Live => ({ drafts: s.drafts, draftTails: s.draftTails, running: s.running, children: s.children, background: s.background, turnStarted: s.turnStarted, failed: s.failed });

/** The message a turn is getting ready: from its events, or from what the server said when the session was opened. */
export const preparingOf = (v?: SessionView | null): SessionView['preparing'] => (v?.preparing !== undefined ? v.preparing : (v?.live?.preparing ?? null));

/** What is under way in a session, open or not. */
const liveIn = (s: State, id: string): Live => (id === s.activeId ? liveOf(s) : (s.lives.get(id) ?? EMPTY_LIVE()));

/** The sessions' records with the open one's kept in, for a switch away from it. */
function stash(): Map<string, Live> {
  const lives = new Map(state.lives);
  if (state.activeId) lives.set(state.activeId, liveOf(state));
  return lives;
}

function selectSession(id: string, replaced?: string) {
  const lives = stash();
  const kept = lives.get(id) ?? EMPTY_LIVE();
  lives.delete(id);
  if (replaced) lives.delete(replaced);
  store('favilla.session', id);
  return { activeId: id, ...kept, lives };
}

/** Keep the progress we saw for calls the server still has, and respect starts and ends since asking for the view. */
function withServerLive(view: SessionView, s: Live, request?: ViewRequest): Partial<Live> {
  const live = view.live;
  if (!live && view.status !== 'idle') return { turnStarted: s.turnStarted ?? Date.now() };
  const running = request?.turnEnded ? s.running : new Map<string, RunningTool>();
  if (!request?.turnEnded) {
    for (const r of live?.running ?? []) running.set(r.callId, s.running.get(r.callId) ?? { ...r, output: '', sub: [] });
    for (const id of request?.tools.keys() ?? []) {
      const current = s.running.get(id);
      if (current) running.set(id, current);
      else running.delete(id);
    }
  }
  const children = new Map(s.children);
  for (const c of live?.children ?? []) {
    const list = children.get(c.callId) ?? [];
    // Coming back mid-run, the server says what it has done so far and what it runs on; events add the rest.
    const done = (c.steps ?? []).map((x) => ({ ...x, title: toolTitle(x.name, x.input) }));
    const known = list.find((x) => x.sessionId === c.sessionId);
    if (!known) children.set(c.callId, [...list, { sessionId: c.sessionId, steps: done, activity: 'tool', since: Date.now(), thought: '', tokens: 0, model: c.model, effort: c.effort }]);
    else
      children.set(
        c.callId,
        list.map((x) => (x === known ? { ...x, steps: done.length > x.steps.length ? done : x.steps, model: x.model ?? c.model, effort: x.effort ?? c.effort } : x)),
      );
  }
  return {
    running, children,
    background: request?.backgroundChanged ? s.background : (live?.background ?? []),
    turnStarted: request?.turnChanged ? s.turnStarted : (live?.turnStarted ?? null),
  };
}

type StreamPiece = Extract<ServerEvent, { type: 'stream.text' | 'stream.reasoning' | 'stream.tool' }>;

function replaceTails(tails: DraftTails, id: string, held?: Map<number, HeldPart>): DraftTails {
  if (!held?.size && !tails.has(id)) return tails;
  const next = new Map(tails);
  if (held?.size) next.set(id, held);
  else next.delete(id);
  return next;
}

function holdPart(before: HeldPart | undefined, piece: HeldPart): HeldPart {
  if (!before) return piece;
  const [first, last] = before.at <= piece.at ? [before, piece] : [piece, before];
  const end = first.at + first.text.length;
  // With two holes, keep the later run: the next view must reach it before recovery is complete.
  if (end < last.at) return last;
  return { ...last, at: first.at, text: first.text + last.text.slice(end - last.at), name: last.name ?? first.name };
}

function appendTail(shown: DraftPart, tail: HeldPart): DraftPart {
  const rest = tail.text.slice(shown.text.length - tail.at);
  return { ...shown, text: shown.text + rest, name: rest ? tail.name ?? shown.name : shown.name ?? tail.name };
}

function mergeDraftParts(draft: Draft, snapshot: StreamDraft['parts'], tails?: Map<number, HeldPart>) {
  const parts = new Map(draft.parts);
  for (const p of snapshot) {
    const shown = parts.get(p.index);
    if (!shown || p.text.length > shown.text.length) parts.set(p.index, { kind: p.kind, text: p.text, name: p.kind === 'tool' ? p.name : undefined });
  }
  const held = new Map(tails);
  for (const [index, tail] of held) {
    const shown = parts.get(index) ?? { kind: tail.kind, text: '' };
    if (tail.at > shown.text.length) continue;
    parts.set(index, appendTail(shown, tail));
    held.delete(index);
  }
  return { draft: { ...draft, parts }, held };
}

function applyStreamPiece(l: Live, e: StreamPiece): Live {
  const { messageId, index, at } = e;
  const draft = l.drafts.get(messageId);
  const kind = e.type === 'stream.text' ? 'text' : e.type === 'stream.reasoning' ? 'reasoning' : 'tool';
  const shown = draft?.parts.get(index) ?? { kind, text: '' };
  const name = e.type === 'stream.tool' ? e.name ?? shown.name : shown.name;
  const tails = l.draftTails.get(messageId);
  if (at !== undefined && (!draft || at > shown.text.length)) {
    const held = new Map(tails);
    held.set(index, holdPart(held.get(index), { at, kind, text: e.delta, name }));
    return { ...l, draftTails: replaceTails(l.draftTails, messageId, held) };
  }
  if (!draft) return l;

  let part: DraftPart = { ...shown, text: shown.text + (at === undefined ? e.delta : e.delta.slice(shown.text.length - at)), name };
  let draftTails = l.draftTails;
  const tail = tails?.get(index);
  if (at !== undefined && tail && tail.at <= part.text.length) {
    part = appendTail(part, tail);
    const held = new Map(tails);
    held.delete(index);
    draftTails = replaceTails(draftTails, messageId, held);
  }
  const parts = new Map(draft.parts);
  parts.set(index, part);
  const drafts = new Map(l.drafts);
  drafts.set(messageId, { ...draft, parts });
  return { ...l, drafts, draftTails };
}

function removeDraft(l: Live, id: string): Live {
  const drafts = new Map(l.drafts);
  drafts.delete(id);
  return { ...l, drafts, draftTails: replaceTails(l.draftTails, id) };
}

/** How one event changes what is under way in its session. */
function applyLive(l: Live, e: ServerEvent): Live {
  switch (e.type) {
    case 'stream.start': {
      // The HTTP view can arrive before the event announcing the very same draft.
      if (l.drafts.has(e.messageId)) return l;
      const drafts = new Map(l.drafts);
      const fresh = { id: e.messageId, parts: new Map<number, DraftPart>() };
      const tails = l.draftTails.get(e.messageId);
      if (!tails) {
        drafts.set(e.messageId, fresh);
        return { ...l, drafts };
      }
      const { draft, held } = mergeDraftParts(fresh, [], tails);
      drafts.set(e.messageId, draft);
      return { ...l, drafts, draftTails: replaceTails(l.draftTails, e.messageId, held) };
    }
    case 'stream.text':
    case 'stream.reasoning':
    case 'stream.tool':
      return applyStreamPiece(l, e);
    case 'stream.discard':
      return removeDraft(l, e.messageId);
    case 'message.added':
      if (e.message.role !== 'assistant' || (!l.drafts.has(e.message.id) && !l.draftTails.has(e.message.id))) return l;
      return removeDraft(l, e.message.id);
    case 'tool.start': {
      const running = new Map(l.running);
      running.set(e.callId, { callId: e.callId, name: e.name, title: e.title, input: e.input, started: Date.now(), output: '', sub: [] });
      return { ...l, running };
    }
    case 'tool.progress': {
      const r = l.running.get(e.callId);
      if (!r) return l;
      const running = new Map(l.running);
      running.set(e.callId, { ...r, output: (r.output + e.chunk).slice(-60_000), display: e.display ?? r.display });
      return { ...l, running };
    }
    case 'tool.end': {
      if (!l.running.has(e.callId)) return l;
      const running = new Map(l.running);
      running.delete(e.callId);
      return { ...l, running };
    }
    case 'turn.start':
      return { ...l, turnStarted: Date.now(), failed: null };
    case 'turn.end':
      return { ...l, running: new Map(), drafts: new Map(), draftTails: new Map(), turnStarted: null, failed: e.reason === 'error' && e.error ? { text: e.error, kind: e.errorKind } : e.reason === 'aborted' ? { text: '', kind: 'aborted' } : null };
    case 'background':
      return { ...l, background: e.running };
    case 'subagent': {
      const ev = e.event;
      const now = Date.now();
      const list = [...(l.children.get(e.callId) ?? [])];
      let i = list.findIndex((c) => c.sessionId === ev.sessionId);
      if (i < 0) {
        list.push({ sessionId: ev.sessionId, steps: [], activity: 'starting', since: now, thought: '', tokens: 0 });
        i = list.length - 1;
      }
      const c = { ...list[i] };
      const become = (a: ChildView['activity']) => {
        if (c.activity !== a) {
          c.activity = a;
          c.since = now;
        }
      };
      switch (ev.type) {
        case 'stream.start':
          become('thinking');
          c.thought = '';
          // Its requests name the model alone; keep the provider when it is already known.
          if (!c.model?.endsWith(`/${ev.model}`)) c.model = ev.model;
          break;
        case 'stream.reasoning':
          become('thinking');
          c.thought = (c.thought + ev.delta).slice(-600);
          break;
        case 'stream.text':
          become('writing');
          break;
        case 'tool.start':
          c.steps = [...c.steps, { id: ev.callId, name: ev.name, title: ev.title, input: ev.input, started: now }].slice(-200);
          c.activity = 'tool';
          c.since = now;
          break;
        case 'tool.end': {
          const failed = stepFailed(ev.result);
          c.steps = c.steps.map((x) => (x.id === ev.callId ? { ...x, ended: now, failed } : x));
          if (!c.steps.some((x) => !x.ended)) become('thinking');
          break;
        }
        case 'usage':
          c.tokens = ev.usage.totalInput + ev.usage.totalOutput;
          break;
        case 'status':
          if (ev.status === 'waiting') become('waiting');
          else if (ev.status === 'idle') become('done');
          break;
        case 'turn.end':
          // Stopped by the user, from here or with the whole session.
          if (ev.reason === 'aborted') c.stopped = true;
          break;
        case 'subagent':
          // Its own sub-agents report through it: it is busy with a step meanwhile.
          become('tool');
          break;
        default:
          break;
      }
      list[i] = c;
      const children = new Map(l.children);
      children.set(e.callId, list);
      const r = l.running.get(e.callId);
      if (!r || ev.type !== 'tool.start') return { ...l, children };
      const running = new Map(l.running);
      running.set(e.callId, { ...r, sub: [...r.sub, ev.title].slice(-8) });
      return { ...l, children, running };
    }
    default:
      return l;
  }
}

function indexResults(view: SessionView): Map<string, import('./types').ToolResultPart> {
  const m = new Map();
  for (const msg of view.messages) for (const p of msg.parts) if (p.type === 'tool_result') m.set(p.callId, p);
  return m;
}

interface ViewRequest {
  promise: Promise<void>;
  opening: boolean;
  again: boolean;
  latestDraft?: string;
  retired: Set<string>;
  committed: Set<string>;
  turnEnded: boolean;
  turnChanged: boolean;
  backgroundChanged: boolean;
  tools: Map<string, import('./types').ToolResultPart | undefined>;
  status?: Pick<SessionView, 'status' | 'statusDetail'>;
}

const viewRequests = new Map<string, ViewRequest>();

/** A view in flight can describe work the event stream has already moved past. */
function observeViewEvent(request: ViewRequest, e: ServerEvent): void {
  if (e.type === 'status') request.status = { status: e.status, statusDetail: e.detail };
  if (e.type === 'tool.start') request.tools.set(e.callId, undefined);
  if (e.type === 'tool.end') request.tools.set(e.callId, e.result);
  if (e.type === 'background') request.backgroundChanged = true;
  if (e.type === 'message.added') request.committed.add(e.message.id);
  if (e.type === 'turn.start' || e.type === 'turn.end') request.turnChanged = true;
  if (e.type === 'stream.start' || ('at' in e && e.at !== undefined)) {
    if (!request.retired.has(e.messageId)) request.latestDraft = e.messageId;
  } else if (e.type === 'turn.end') {
    request.turnEnded = true;
    request.latestDraft = undefined;
  } else if (e.type === 'stream.discard' || (e.type === 'message.added' && e.message.role === 'assistant')) {
    const id = e.type === 'stream.discard' ? e.messageId : e.message.id;
    request.retired.add(id);
    if (request.latestDraft === id) request.latestDraft = undefined;
  }
}

function mergeServerDraft(live: Live, view: StreamDraft | null, latest?: string): Pick<Live, 'drafts' | 'draftTails'> {
  const id = latest ?? view?.messageId;
  if (!id) return { drafts: new Map(), draftTails: new Map() };
  let draft = live.drafts.get(id);
  let held = live.draftTails.get(id);
  if (view?.messageId === id) {
    ({ draft, held } = mergeDraftParts(draft ?? { id, parts: new Map() }, view.parts, held));
  }
  return { drafts: new Map(draft ? [[id, draft]] : []), draftTails: new Map(held?.size ? [[id, held]] : []) };
}

function requestSessionView(id: string, opening = false): Promise<void> {
  const pending = viewRequests.get(id);
  if (pending) {
    pending.opening ||= opening;
    return pending.promise;
  }
  const request: ViewRequest = { promise: Promise.resolve(), opening, again: false, retired: new Set(), committed: new Set(), turnEnded: false, turnChanged: false, backgroundChanged: false, tools: new Map() };
  let applied = false;
  request.promise = api<SessionView>(`/sessions/${id}`).then((view) => {
    if (state.activeId !== id) return;
    batch(() => {
      const snapshot = view.live?.draft;
      if (snapshot !== undefined && gathered.size) flushGathered(id);
      const obsolete = snapshot && (request.retired.has(snapshot.messageId) || (request.turnEnded && snapshot.messageId !== request.latestDraft));
      const draft = snapshot === undefined ? {} : mergeServerDraft(state, obsolete ? null : snapshot, request.latestDraft);
      // A message already received over SSE must not disappear when an older view arrives.
      const missingCommit = [...request.committed].some((id) => !view.messages.some((m) => m.id === id));
      const keepView = missingCommit && state.session?.meta.id === id;
      if (!keepView) {
        const results = indexResults(view);
        for (const [id, result] of request.tools) if (result && !results.has(id)) results.set(id, result);
        setState({ session: request.status ? { ...view, ...request.status } : view, results, ...withServerLive(view, state, request) });
      }
      const returned = view.returned?.filter((p) => request.opening || p.id);
      setState({ ...draft, ...(returned?.length ? returnToComposer(returned, id) : {}) });
      request.again ||= missingCommit;
      if (snapshot !== undefined) {
        request.again ||= !!obsolete || state.draftTails.size > 0
          || (request.latestDraft !== undefined && request.latestDraft !== snapshot?.messageId);
      }
    });
    applied = true;
  }).finally(() => {
    viewRequests.delete(id);
    if (applied && request.again && state.activeId === id) requestSessionView(id).catch(() => {});
  });
  viewRequests.set(id, request);
  return request.promise;
}

/**
 * A change to a session this window only reads, from its event stream: the messages saved since, appended once
 * each, with its plan, usage and meta. A session the other process let go stays read-only until it is opened here
 * by hand: a headless run that resumes it next would find it held by this window and stop.
 */
export function applyFollow(id: string, c: import('./types').FollowChange): void {
  const view = state.session;
  if (!view || view.meta.id !== id || !view.following) return;
  if (c.reset) {
    requestSessionView(id).catch(() => {});
    return;
  }
  const have = new Set(view.messages.map((m) => m.id));
  const added = c.added.filter((m) => !have.has(m.id));
  let results = state.results;
  if (added.length) {
    results = new Map(results);
    for (const m of added) for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);
  }
  const live = c.following.holder !== null ? 'running' : null;
  setState((st) => ({
    session: { ...view, meta: c.meta, messages: added.length ? [...view.messages, ...added] : view.messages, activeStart: c.activeStart, todos: c.todos, usage: c.usage, following: c.following },
    results,
    sessions: st.sessions.map((x) => (x.id === id ? { ...x, title: c.meta.title, updated: c.meta.updated, live } : x)),
  }));
}

function requestHeldDraft(): void {
  const id = state.activeId;
  if (id && state.draftTails.size && !viewRequests.has(id)) requestSessionView(id).catch(() => {});
}

/** Replace the row in place in each window, including one that already saw activity in the new session. */
function replaceSessionRow(id: string, replacement: Pick<SessionMeta, 'id'> & Partial<SessionMeta>): boolean {
  const previous = state.sessions.find((s) => s.id === id);
  const existing = state.sessions.find((s) => s.id === replacement.id);
  if (!previous) return !!existing;
  const activity = liveIn(state, replacement.id);
  const live = existing?.live ?? (activity.turnStarted !== null || activity.background.length ? 'running' : null);
  const row = { ...previous, ...replacement, ...existing, updated: previous.updated, live };
  setState({ sessions: state.sessions.filter((s) => s.id !== replacement.id).map((s) => s.id === id ? row : s) });
  return true;
}

async function followReplacement(id: string, replacement: Pick<SessionMeta, 'id'> & Partial<SessionMeta>): Promise<void> {
  batch(() => {
    replaceSessionRow(id, replacement);
    moveComposerDraft(id, replacement.id);
    if (state.activeId === id) {
      // Leave the conversation mounted while the new view arrives: it holds the user's composer.
      setState({ ...selectSession(replacement.id, id), ui: { ...state.ui, editing: null } });
    }
  });
  if (state.activeId !== replacement.id) return;
  if (state.session?.meta.id !== replacement.id) await requestSessionView(replacement.id, true);
  const view = state.session;
  if (view?.meta.id === replacement.id && state.sessions.some((row) => row.id === replacement.id)) {
    setState({ sessions: state.sessions.map((row) => row.id === replacement.id ? { ...row, ...view.meta, updated: row.updated } : row) });
  }
}

/** A list fetched after a disconnect can be the first news that an old row was replaced. */
function placeReplacements(sessions: SessionListItem[], before: SessionListItem[]): SessionListItem[] {
  const slots = new Map(before.map((row, index) => [row.id, index]));
  const moved = sessions.flatMap((row) => {
    const id = row.replaces?.findLast((id) => slots.has(id));
    return id === undefined ? [] : [{ row, index: slots.get(id)! }];
  });
  if (!moved.length) return sessions;
  const rows = sessions.filter((row) => !moved.some((m) => m.row === row));
  for (const { row, index } of moved.sort((a, b) => a.index - b.index)) {
    rows.splice(index, 0, { ...row, updated: before[index].updated });
  }
  return rows;
}

/**
 * A folder for comparing paths: one kind of separator, no trailing one, case aside (as the server compares them).
 */
/** How many sessions the sidebar lists, newest first, across every folder. */
const SESSION_LIMIT = 800;

export const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The folders listed in the sidebar, in the order they were first opened, newest first. A folder already there keeps
 * its place: moving it to the top each time a session in it was opened made the list jump about under the pointer.
 */
function remember(folder: string): string[] {
  if (state.recent.some((f) => folderKey(f) === folderKey(folder))) return state.recent;
  const recent = [folder, ...state.recent].slice(0, 16);
  store('favilla.recent', recent);
  return recent;
}

// ── actions ────────────────────────────────────────────────────────────────

export const actions = {
  async boot(): Promise<void> {
    events?.();
    const incompleteViews = new Set<string>();
    events = connectEvents(onEvent, (connection, resumed) => {
      setState({ connection });
      if (connection !== 'open') return;
      for (const observer of sessionObservers) observer.reconnect();
      if (!state.loading) actions.loadSessions().catch(() => {});
      const needsView = !!state.activeId && incompleteViews.has(state.activeId);
      incompleteViews.clear();
      if (resumed && !needsView) {
        if (gathered.size) flushGathered();
        requestHeldDraft();
        return;
      }
      const id = state.activeId;
      if (id) {
        const pending = viewRequests.get(id);
        // A view taken before the connection joined can miss pieces even when no later delta exposes the gap.
        if (pending) pending.again = true;
        const ready = pending ? pending.promise.then(() => viewRequests.get(id)?.promise) : actions.refreshSession();
        return ready.then(() => true, () => false);
      }
    }, {
      session: state.activeId,
      replay(events) {
        batch(() => {
          for (const e of events) {
            // These events announce a history change but do not carry the rewritten parts of the view.
            if (e.type === 'message.updated' || (e.type === 'compaction' && (e.phase === 'end' || e.phase === 'pruned'))) incompleteViews.add(e.sessionId);
            onEvent(e, true);
          }
          if (gathered.size) flushGathered();
        });
      },
      draft(id, draft) {
        if (id !== state.activeId) return;
        batch(() => {
          if (gathered.size) flushGathered(id);
          const request = viewRequests.get(id);
          if (request?.retired.has(draft.messageId)) return;
          if (request) request.latestDraft = draft.messageId;
          setState(mergeServerDraft(state, draft));
        });
        requestHeldDraft();
      },
    });
    const [info, providers] = await Promise.all([api<Info>('/info'), api<ProviderView[]>('/providers')]);
    // The server's state also reaches another window. Use it for keys this window has never saved.
    const ui = info.ui ?? {};
    const folder = stored('favilla.folder', ui.folder ?? '') || info.cwd;
    setState({ recent: stored('favilla.recent', ui.recent ?? []), pinned: stored('favilla.pinned', ui.pinned ?? []), collapsed: stored('favilla.collapsed', ui.collapsed ?? []) });
    const layout = stored('favilla.layout', ui.layout);
    if (layout && window.matchMedia('(min-width: 1180px)').matches) setState((s) => ({ ui: { ...s.ui, ...layout } }));
    lastPick = stored<DraftOptions>('favilla.last', ui.last ?? {});
    const last = stored('favilla.session', ui.session ?? '');
    setState({ info, providers, folder, recent: remember(folder), loading: false, reopening: !!last });
    // Not waited for: a server from before the update check answers 404, and the page works the same without it.
    void refreshUpdate();
    showSettings(info.settingsNotices);
    setState({ draft: startPick() });
    store('favilla.folder', folder);
    try {
      await actions.loadSessions();
      if (last && state.sessions.some((s) => s.id === last)) await actions.open(last);
    } finally {
      if (state.reopening) setState({ reopening: false });
    }
  },

  async loadSessions(): Promise<void> {
    const positions = state.sessions;
    for (;;) {
      const before = state.sessions;
      // Every folder's: the sidebar lists them by folder, and a session at work anywhere shows there.
      const sessions = await api<SessionListItem[]>(`/sessions?limit=${SESSION_LIMIT}`);
      // An event may have changed the list after the server made its snapshot.
      if (state.sessions !== before) continue;
      setState({ sessions: placeReplacements(sessions, positions) });
      return;
    }
  },

  async loadProviders(): Promise<void> {
    setState({ providers: await api<ProviderView[]>('/providers') });
  },

  async loadSettings(): Promise<void> {
    await Promise.all([api<Info>('/info').then(updateInfo), actions.loadProviders()]);
  },

  async setConfig(patch: Record<string, unknown>, basis: SettingBasis | undefined = state.info?.basis): Promise<void> {
    await api('/config', { method: 'PUT', body: { ...patch, basis } });
    updateInfo(await api<Info>('/info'));
  },

  async setFolder(folder: string): Promise<void> {
    store('favilla.folder', folder);
    store('favilla.session', '');
    setState({ folder, recent: remember(folder), activeId: null, session: null, ...EMPTY_LIVE(), lives: stash(), draft: startPick() });
    await actions.loadSessions();
  },

  forgetFolder(folder: string): void {
    const recent = state.recent.filter((f) => folderKey(f) !== folderKey(folder));
    store('favilla.recent', recent);
    setState({ recent });
  },

  /** Fold or unfold a folder in the sidebar. */
  fold(folder: string, folded: boolean): void {
    const key = folderKey(folder);
    const collapsed = folded ? [...new Set([...state.collapsed, key])] : state.collapsed.filter((k) => k !== key);
    store('favilla.collapsed', collapsed);
    setState({ collapsed });
  },

  pin(id: string, pinned: boolean): void {
    const list = pinned ? [id, ...state.pinned.filter((p) => p !== id)] : state.pinned.filter((p) => p !== id);
    store('favilla.pinned', list);
    setState({ pinned: list });
  },

  async open(id: string): Promise<void> {
    // A session in another folder makes that folder the current one: a new session, the files and the rules follow it.
    const cwd = state.sessions.find((s) => s.id === id)?.cwd;
    if (cwd && folderKey(cwd) !== folderKey(state.folder)) {
      store('favilla.folder', cwd);
      setState({ folder: cwd, recent: remember(cwd) });
    }
    setState(selectSession(id));
    await requestSessionView(id, true);
  },

  /** Leave the open session; the next message starts a new one in the current folder. */
  newSession(): void {
    store('favilla.session', '');
    setState({ activeId: null, session: null, ...EMPTY_LIVE(), lives: stash(), draft: startPick() });
  },

  async refreshSession(): Promise<void> {
    const id = state.activeId;
    if (!id) return;
    await requestSessionView(id);
  },

  /**
   * Branch the open session at a message and switch to the branch. With `text`, the message is sent again,
   * changed, in the branch; `undo` first puts back the files the session changed from that point on; `replace`
   * drops the conversation after that point, the branch taking the session's place.
   */
  async fork(message: string, where: 'before' | 'after', opts: { undo?: boolean; text?: string; replace?: boolean } = {}): Promise<string[]> {
    const id = state.activeId;
    if (!id) return [];
    const view = await api<SessionView & { restored?: string[] }>(`/sessions/${id}/fork`, { body: { message, where, undo: !!opts.undo, text: opts.text, replace: !!opts.replace } });
    let placed = false;
    batch(() => {
      if (opts.replace) {
        placed = replaceSessionRow(id, view.meta);
        moveComposerDraft(id, view.meta.id);
      }
      if (state.activeId !== id) return;
      const known = state.lives.has(view.meta.id);
      const selected = selectSession(view.meta.id, opts.replace ? id : undefined);
      const snapshot = view.live?.draft;
      const draft = snapshot && (!known || selected.drafts.has(snapshot.messageId) || selected.draftTails.has(snapshot.messageId))
        ? mergeServerDraft(selected, snapshot)
        : {};
      setState({
        ...selected, ...(!known ? withServerLive(view, selected) : {}), ...draft,
        session: view, results: indexResults(view), ui: { ...state.ui, editing: null },
      });
      // With events already received, a different draft in the fork view can be older than them.
      if (snapshot && !state.drafts.has(snapshot.messageId)) requestSessionView(view.meta.id).catch(() => {});
    });
    requestHeldDraft();
    if (!placed) await actions.loadSessions();
    return view.restored ?? [];
  },

  async create(): Promise<string> {
    const view = await api<SessionView>('/sessions', { body: { cwd: state.folder, ...state.draft } });
    moveComposerDraft(null, view.meta.id);
    setState({ activeId: view.meta.id, session: view, results: indexResults(view), ...EMPTY_LIVE(), lives: stash(), draft: {} });
    store('favilla.session', view.meta.id);
    await actions.loadSessions();
    return view.meta.id;
  },

  async send(text: string, images: { mediaType: string; data: string; name: string }[] = [], restore?: () => void): Promise<void> {
    let id = state.activeId;
    if (!id) id = await actions.create();
    try {
      await api(`/sessions/${id}/send`, { body: { text, images } });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 410 || !e.replacementId) throw e;
      // The composer can restore its original chips, without taking apart the text sent over the wire.
      const moved = followReplacement(id, { id: e.replacementId }).catch(() => {});
      if (restore) restore();
      else setState(returnToComposer([{ text, images }]));
      await moved;
      return;
    }
    // What the user just worked with is what the next new session starts with.
    const meta = state.session?.meta.id === id ? state.session.meta : null;
    if (meta) noteLast(`${meta.provider}/${meta.model}`, meta.effort);
  },

  /** Go on after a failed turn, from where it stopped: the message is in the history already. */
  async retry(): Promise<void> {
    if (!state.activeId) return;
    await api(`/sessions/${state.activeId}/retry`, { body: {} });
  },

  /** Take back a message sent while the agent works; null once the agent has read it. */
  async unqueue(qid: string): Promise<{ text: string; images: { mediaType: string; data: string; name?: string }[] } | null> {
    if (!state.activeId) return null;
    const r = await api<{ ok: boolean; text?: string; images?: { mediaType: string; data: string; name?: string }[] }>(`/sessions/${state.activeId}/unqueue`, { body: { id: qid } });
    return r.ok ? { text: r.text ?? '', images: r.images ?? [] } : null;
  },

  /** Change the open session's model, effort, mode or title; before a session exists, remember the choice. */
  async settings(patch: Record<string, unknown>): Promise<void> {
    if (typeof patch.model === 'string' || typeof patch.effort === 'string') noteLast(patch.model as string | undefined, patch.effort as Effort | undefined);
    if (!state.activeId) {
      setState((s) => ({ draft: { ...s.draft, ...(patch as DraftOptions) } }));
      return;
    }
    const id = state.activeId;
    const view = await api<SessionView>(`/sessions/${id}/settings`, { body: patch });
    if (state.activeId === id) setState({ session: view });
  },

  async rename(id: string, title: string): Promise<void> {
    const view = await api<SessionView>(`/sessions/${id}/settings`, { body: { title } });
    setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: view.meta.title } : x)),
      session: s.session?.meta.id === id ? { ...s.session, meta: view.meta } : s.session,
    }));
  },

  async compact(): Promise<void> {
    if (state.activeId) await api(`/sessions/${state.activeId}/compact`, { body: {} });
  },

  /** Restore the files the last turn with changes touched. Resolves to the number of files restored. */
  async undoLast(): Promise<number> {
    if (!state.activeId) return 0;
    const changes = await api<TurnChanges[]>(`/sessions/${state.activeId}/changes`);
    const last = [...changes].reverse().find((c) => c.files.length);
    if (!last) return 0;
    await api(`/sessions/${state.activeId}/undo`, { body: { turn: last.turn } });
    await actions.refreshSession();
    return last.files.length;
  },

  /** Stop everything the open session runs: its turn and every sub-agent, the background ones too. */
  abort: () => state.activeId && api(`/sessions/${state.activeId}/abort`, { body: {} }),
  /** Stop one sub-agent of the open session; the agent that started it goes on. */
  stopChild: (child: string) => state.activeId && api(`/sessions/${state.activeId}/stop-child`, { body: { child } }),
  permission: (id: string, decision: string) => state.activeId && api(`/sessions/${state.activeId}/permission`, { body: { id, decision } }),
  answer: (id: string, answers: Record<string, string> | null) => state.activeId && api(`/sessions/${state.activeId}/answer`, { body: { id, answers } }),
  plan: (id: string, approved: boolean, feedback?: string) => state.activeId && api(`/sessions/${state.activeId}/plan`, { body: { id, approved, feedback } }),

  async remove(id: string): Promise<void> {
    await api(`/sessions/${id}`, { method: 'DELETE' });
    if (state.activeId === id) actions.newSession();
    if (state.pinned.includes(id)) actions.pin(id, false);
    await actions.loadSessions();
  },
};

// ── event reducer ──────────────────────────────────────────────────────────

/**
 * Streamed pieces (a few characters each, dozens a second from every running session at once) are gathered and
 * applied together every 50 ms: one by one, each piece re-rendered the window and re-read the whole reply's
 * markdown, so more threads at work and longer replies made everything slower. Pieces of each part are joined
 * across interleaved streams; other events flush them first. Subscribers see one complete snapshot per batch.
 */
const PIECES = new Set(['stream.text', 'stream.reasoning', 'stream.tool', 'tool.progress']);
type Delta = StreamPiece | Extract<ServerEvent, { type: 'tool.progress' }>;
type Piece = Delta | (Extract<ServerEvent, { type: 'subagent' }> & { event: Delta });
let gathered = new Map<string, Piece[]>();
let gatherTimer: ReturnType<typeof setTimeout> | null = null;

const pieceOf = (e: Piece): Delta => e.type === 'subagent' ? e.event : e;

function joinPiece(before: Delta, after: Delta): Delta | undefined {
  if (before.type === 'tool.progress' && after.type === 'tool.progress') return { ...after, chunk: (before.chunk + after.chunk).slice(-60_000), display: after.display ?? before.display };
  if (before.type !== 'tool.progress' && after.type !== 'tool.progress') {
    if (after.at !== (before.at === undefined ? undefined : before.at + before.delta.length)) return;
    const delta = before.delta + after.delta;
    const offset = before.at === undefined ? {} : { at: before.at };
    if (after.type === 'stream.tool') return { ...after, ...offset, delta, name: after.name ?? (before.type === 'stream.tool' ? before.name : undefined) };
    return { ...after, ...offset, delta };
  }
}

function flushGathered(draftSession?: string): void {
  let pending: Iterable<Piece[]> = gathered.values();
  if (draftSession === undefined) gathered = new Map();
  else {
    // Reconcile the view with its queued deltas without advancing unrelated cards or sessions.
    const drafts: Piece[][] = [];
    for (const [key, pieces] of gathered) {
      const first = pieces[0];
      if (first.sessionId !== draftSession || first.type === 'subagent' || first.type === 'tool.progress') continue;
      gathered.delete(key);
      drafts.push(pieces);
    }
    pending = drafts;
  }
  if (!gathered.size) {
    if (gatherTimer !== null) clearTimeout(gatherTimer);
    gatherTimer = null;
  }
  batch(() => { for (const pieces of pending) for (const e of pieces) applyEvent(e); });
}

function onEvent(e: ServerEvent, replayed = false): void {
  if (PIECES.has(e.type) || (e.type === 'subagent' && PIECES.has(e.event.type))) {
    const piece = e as Piece;
    const d = pieceOf(piece);
    const key = JSON.stringify([piece.sessionId, piece.type === 'subagent' ? piece.callId : null, d.sessionId, d.type,
      d.type === 'tool.progress' ? d.callId : d.messageId, d.type === 'tool.progress' ? null : d.index]);
    const pieces = gathered.get(key) ?? [];
    const previous = pieces.at(-1);
    const joined = previous && joinPiece(pieceOf(previous), d);
    if (joined) pieces[pieces.length - 1] = piece.type === 'subagent' ? { ...piece, event: joined } : joined;
    else pieces.push(piece);
    // Last occurrence order preserves child activity when reasoning and text alternate in the same frame.
    gathered.delete(key);
    gathered.set(key, pieces);
    // Present the start of a text part in the open reply on the next task. Keep coalescing bursts,
    // including anything else arriving in this task, and keep the usual cadence for later text.
    const first = !replayed && !previous && e.type === 'stream.text' && e.sessionId === state.activeId
      && (e.at ?? 0) === 0 && !!e.delta && state.drafts.get(e.messageId)?.parts.has(e.index) === false;
    if (first && gatherTimer !== null) {
      clearTimeout(gatherTimer);
      gatherTimer = null;
    }
    gatherTimer ??= setTimeout(() => {
      flushGathered();
      requestHeldDraft();
    }, first ? 0 : 50);
    return;
  }
  batch(() => {
    if (gathered.size) flushGathered();
    applyEvent(e, replayed);
  });
  if (!replayed) requestHeldDraft();
}

function applyEvent(e: ServerEvent, replayed = false): void {
  if (e.type === 'server.settings') {
    if (!state.loading) showSettings([e.notice]);
    return;
  }
  if (e.type === 'server.update') {
    setState({ update: e.update });
    return;
  }
  if (e.type === 'server.config') {
    // Settings can change from elsewhere (another window, `favilla config`): take theme, language and defaults too.
    actions.loadProviders().catch(() => {});
    api<Info>('/info')
      .then(updateInfo)
      .catch(() => {});
    // Checking may have been turned on or off.
    if (state.update) void refreshUpdate();
    return;
  }
  if (e.type === 'session.replaced') {
    followReplacement(e.sessionId, e.replacement).catch(() => {});
    return;
  }
  if (sessionObservers.size) {
    let event: SessionEvent = e;
    for (;;) {
      for (const observer of sessionObservers) if (observer.id === event.sessionId) observer.event(event);
      if (event.type !== 'subagent') break;
      event = event.event;
    }
  }
  const request = viewRequests.get(e.sessionId);
  if (request) observeViewEvent(request, e);
  const s = state;
  notifyAway(e, s.sessions, s.info?.config.language, (id) => void actions.open(id));
  if (e.type === 'meta') {
    setState((st) => ({ sessions: st.sessions.map((x) => (x.id === e.meta.id ? { ...x, ...e.meta } : x)) }));
  }
  if (e.type === 'turn.end' || e.type === 'turn.start') {
    // Sub-agents still at work in the background keep the session marked as working after its turn.
    const live = e.type === 'turn.start' || liveIn(s, e.sessionId).background.length ? 'running' : null;
    setState((st) => ({ sessions: st.sessions.map((x) => (x.id === e.sessionId ? { ...x, live, updated: Date.now() } : x)) }));
    if (e.type === 'turn.start' && !s.sessions.some((x) => x.id === e.sessionId)) actions.loadSessions().catch(() => {});
  }
  // Waiting on an approval or a question shows in the list, so the session is found from another one, and so does
  // compacting. Plain running is left to the turn's start and end, which mark it already.
  if (e.type === 'status') {
    const was = s.sessions.find((x) => x.id === e.sessionId)?.live;
    const marked = was === 'waiting' || was === 'compacting';
    const live =
      e.status === 'waiting' || e.status === 'compacting' ? e.status
      : !marked ? was
      : e.status === 'running' || liveIn(s, e.sessionId).background.length ? 'running'
      : null;
    if (was !== undefined && live !== was) setState((st) => ({ sessions: st.sessions.map((x) => (x.id === e.sessionId ? { ...x, live: live ?? null } : x)) }));
  }
  if (e.type === 'background') {
    const live = e.running.length || liveIn(s, e.sessionId).turnStarted !== null ? 'running' : null;
    setState((st) => ({ sessions: st.sessions.map((x) => (x.id === e.sessionId ? { ...x, live } : x)) }));
  }
  if (LIVE_EVENTS.has(e.type) && e.sessionId) {
    if (e.sessionId === s.activeId) setState(applyLive(liveOf(s), e));
    else {
      const before = s.lives.get(e.sessionId);
      const after = applyLive(before ?? EMPTY_LIVE(), e);
      if (after !== before) setState({ lives: new Map(s.lives).set(e.sessionId, after) });
    }
  }
  if (!s.session || e.sessionId !== s.session.meta.id) return;
  const view = s.session;
  switch (e.type) {
    case 'status':
      setState({ session: { ...view, status: e.status, statusDetail: e.detail } });
      break;
    case 'preparing':
      setState({ session: { ...view, preparing: e.text === null ? null : { text: e.text, images: e.images ?? 0 } } });
      break;
    case 'message.added': {
      // The HTTP view can overtake the stream and already have this message.
      if (view.messages.some((m) => m.id === e.message.id)) break;
      const results = new Map(s.results);
      for (const p of e.message.parts) if (p.type === 'tool_result') results.set(p.callId, p);
      const activeStart = e.message.origin === 'compaction' ? view.messages.length : view.activeStart;
      setState({ session: { ...view, messages: [...view.messages, e.message], activeStart }, results });
      break;
    }
    case 'tool.end': {
      const results = new Map(s.results);
      results.set(e.callId, e.result);
      setState({ results });
      break;
    }
    case 'permission.request':
      if (replayed && view.pending.permissions.some((p) => p.id === e.request.id)) break;
      setState({ session: { ...view, pending: { ...view.pending, permissions: [...view.pending.permissions, e.request] } } });
      break;
    case 'permission.resolved':
      setState({ session: { ...view, pending: { ...view.pending, permissions: view.pending.permissions.filter((p) => p.id !== e.id) } } });
      break;
    case 'question.request':
      if (replayed && view.pending.questions.some((q) => q.id === e.request.id)) break;
      setState({ session: { ...view, pending: { ...view.pending, questions: [...view.pending.questions, e.request] } } });
      break;
    case 'question.resolved':
      setState({ session: { ...view, pending: { ...view.pending, questions: view.pending.questions.filter((q) => q.id !== e.id) } } });
      break;
    case 'plan.request':
      if (replayed && view.pending.plans.some((p) => p.id === e.id)) break;
      setState({ session: { ...view, pending: { ...view.pending, plans: [...view.pending.plans, { id: e.id, plan: e.plan }] } } });
      break;
    case 'plan.resolved':
      setState({ session: { ...view, pending: { ...view.pending, plans: view.pending.plans.filter((p) => p.id !== e.id) } } });
      break;
    case 'todos':
      setState({ session: { ...view, todos: e.todos } });
      break;
    case 'usage':
      setState({ session: { ...view, usage: e.usage } });
      break;
    case 'meta':
      setState({ session: { ...view, meta: e.meta } });
      if (e.meta.model !== view.model.id) actions.refreshSession().catch(() => {});
      break;
    case 'checkpoint':
      setState({ session: { ...view, turns: view.turns.includes(e.turn) ? view.turns : [...view.turns, e.turn] } });
      break;
    case 'notice': {
      const text = e.key ? fill(translate(resolveLang(state.info?.config.language), e.key), e.arg ?? '') : e.text;
      toast(text, e.level);
      // A retry notice ("trying again (2/3)") speaks for the turn under way: it goes when the turn ends.
      if (e.key && /^\d+\/\d+$/.test(e.arg ?? '')) retryToasts.add(text);
      break;
    }
    case 'held':
      setState({ session: { ...view, held: e.model } });
      break;
    case 'queue':
      setState({ session: { ...view, queued: e.items }, ...(e.returned?.length ? returnToComposer(e.returned, e.sessionId) : {}) });
      break;
    case 'model':
      // Other thinking levels or another window for the same model: the composer and the ruler follow.
      if (e.model.ref === view.model.ref) setState({ session: { ...view, model: { ...view.model, ...e.model } } });
      break;
    case 'compaction':
      if (e.phase === 'failed' && e.error) toast(fill(translate(resolveLang(state.info?.config.language), 'Compaction failed: {n}'), e.error ?? ''), 'warn');
      if (e.phase === 'pruned') toast(fill(translate(resolveLang(state.info?.config.language), 'Trimmed {n} old tool outputs to keep the context lean; recall brings any of them back.'), e.count ?? 0), 'info');
      break;
    case 'turn.end':
      // Said once, at the end of the conversation (Timeline's Failed): the same words in a toast at the top covered
      // the header on a phone, and the next reply when it came within the toast's time.
      // A retry notice left over from the last try had stood beside the failure line for a second or more.
      setState((x) => ({ toasts: x.toasts.filter((t) => !retryToasts.has(t.text) && !(e.reason === 'error' && t.text === e.error)) }));
      retryToasts.clear();
      break;
  }
}

/** The texts of the retry notices shown during the open session's turn, cleared when it ends. */
const retryToasts = new Set<string>();
