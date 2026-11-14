import type { SettingBasis } from '@favilla/core/types';
import type { SettingsNotice } from '@favilla/core/i18n';
import type {
  BackgroundRun,
  CheckResult,
  ContextReport,
  DiffFile,
  PlanMeter,
  Effort,
  Goal,
  Message,
  Mode,
  PermissionRequest,
  QuestionRequest,
  QueuedInput,
  SessionMeta,
  SessionUsage,
  StreamDraft,
  Todo,
  ToolDisplay,
  ToolResultPart,
} from '@favilla/core/types';

export type { CheckResult, ContextReport, PlanMeter, DiffFile, Effort, Goal, Message, Mode, PermissionRequest, QuestionRequest, QueuedInput, SessionUsage, StreamDraft, Todo, ToolDisplay, ToolResultPart };

export interface ModelView {
  ref: string;
  provider: string;
  id: string;
  name: string;
  family: string;
  contextWindow: number;
  /** The window the provider reports, before an override in the settings. */
  nativeWindow?: number;
  /** Nothing states the window: `nativeWindow` is what Favilla assumes. */
  windowAssumed?: boolean;
  maxOutput: number;
  efforts: Effort[];
  defaultEffort: Effort;
  vision: boolean;
  description?: string;
}

export interface ProviderView {
  basis?: SettingBasis;
  id: string;
  name: string;
  description?: string;
  api: string;
  auth: 'key' | 'none';
  local: boolean;
  /** Answers one request at a time: no summary is written in the background beside the agent's work. */
  serial: boolean;
  baseUrl: string;
  configured: boolean;
  /** Added by the user in the settings, so it can be removed there. */
  custom?: boolean;
  keys: number;
  error?: string;
  models: ModelView[];
  /** Models added by hand because the server does not list them, with the window Favilla takes for each. */
  added?: { id: string; contextWindow: number }[];
}

export interface Info {
  basis?: SettingBasis;
  version: string;
  cwd: string;
  home: string;
  platform: string;
  desktop: boolean;
  config: { model?: string; effort?: Effort; language: string; theme: string; proxy: string; proxyPasswordSaved?: boolean; subagentModel: string; shadowModel?: string; guard: string; webSearch: boolean | 'builtin' | 'provider'; skills: boolean; shell: string; answerFormat: 'structured' | 'plain'; tools: 'auto' | 'favilla' | 'claude' | 'codex'; globalConfig: string; compactAt: number; windows: { ref: string; contextWindow: number }[]; visions: { ref: string; vision: boolean }[]; computer: boolean; lowMemory: boolean; browser: 'fresh' | 'keep' | 'visible' | 'edge' | 'chrome'; browserPath: string; browserFound: boolean };
  settingsNotices?: SettingsNotice[];
  /** The shell agent commands run in, and why when it is not the one asked for. */
  shell?: { name: string; path: string; fallback?: string };
  /** What the window had open last time, kept by the server (ui-state.json). */
  ui?: { folder?: string; recent?: string[]; session?: string; layout?: { sidebar: boolean; panel: boolean }; last?: { model?: string; effort?: Effort }; pinned?: string[]; collapsed?: string[] };
  /** What the installed extensions bring: their settings with the values set, and their words for the cards. */
  extensions?: { name: string; settings: { key: string; label: string; note?: string; options: { value: string; label: string }[]; current: string }[]; strings: Record<string, Record<string, string>> }[];
}

export interface SessionListItem extends SessionMeta {
  live: string | null;
}

export interface SessionView {
  meta: SessionMeta;
  messages: Message[];
  activeStart: number;
  todos: Todo[];
  usage: SessionUsage;
  status: 'idle' | 'running' | 'compacting' | 'waiting';
  /** What a running session is doing besides its own steps: retrying a request, checking its answer. */
  statusDetail?: string;
  /** The user's message while the turn gets it ready, with the brief agent's latest step; null once it is in the conversation. */
  preparing?: { text: string; images: number } | null;
  pending: { permissions: PermissionRequest[]; questions: QuestionRequest[]; plans: { id: string; plan: string }[] };
  /** Messages sent while the agent works, until it reads them. */
  queued?: QueuedInput[];
  /** A model picked while the session works, taking over once it stops. */
  held?: string | null;
  model: ModelView;
  turns: string[];
  /** What is under way, from the server: for a session opened mid-turn (after a reload, or coming back to it). */
  /** Messages Favilla stopped before reading, kept until a window acknowledges receipt. */
  returned?: { id?: string; text: string; images: { mediaType: string; data: string; name?: string }[] }[];
  live?: { draft?: StreamDraft | null; turnStarted: number | null; preparing?: { text: string; images: number } | null; running: { callId: string; name: string; title: string; input: Record<string, unknown>; started: number }[]; children: { callId: string; sessionId: string; model?: string; effort?: string; steps?: { id: string; name: string; input: Record<string, unknown>; started: number; ended?: number; failed?: boolean }[] }[]; background?: BackgroundRun[] };
}

export interface DraftPart {
  kind: 'text' | 'reasoning' | 'tool';
  text: string;
  name?: string;
}

export interface Draft {
  id: string;
  parts: Map<number, DraftPart>;
}

export interface RunningTool {
  callId: string;
  name: string;
  title: string;
  input: Record<string, unknown>;
  started: number;
  output: string;
  sub: string[];
  /** The call's card as it stands, from a tool that shows its work while it runs. */
  display?: ToolDisplay;
}

/** One step of a sub-agent, as its events report it. */
export interface ChildStep {
  id: string;
  name: string;
  title: string;
  input: Record<string, unknown>;
  started: number;
  ended?: number;
  failed?: boolean;
}

/** A sub-agent at work (or done), followed from its events: its steps, what it is doing now, what it used. */
export interface ChildView {
  sessionId: string;
  steps: ChildStep[];
  activity: 'starting' | 'thinking' | 'writing' | 'tool' | 'waiting' | 'done';
  /** When the current activity began. */
  since: number;
  /** The end of what it is thinking, for the line that says so. */
  thought: string;
  tokens: number;
  model?: string;
  effort?: string;
  /** The user stopped it before it finished. */
  stopped?: boolean;
}

export interface McpServerView {
  basis?: SettingBasis;
  name: string;
  state: 'connecting' | 'ready' | 'failed' | 'off';
  tools: string[];
  error?: string;
  /** Its settings; env vars and headers by name only, their values never leave the config file. */
  config: { command: string; args: string[]; env: string[]; cwd: string; enabled: boolean } | { url: string; headers: string[]; enabled: boolean } | null;
}

export interface TurnChanges {
  turn: string;
  /** via: a file tool changed it, or a command did (seen by the folder's snapshots). */
  files: (DiffFile & { via?: 'tool' | 'command' })[];
}
