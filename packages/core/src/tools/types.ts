import type { Goal, ImagePart, Message, Mode, PermissionDecision, Question, Todo, ToolDisplay } from '../types';
import type { BlobStore } from '../store/blobs';
import type { ModelInfo } from '../catalog/catalog';
import type { FavillaConfig } from '../config/config';
import type { ToolSpec } from '../providers/types';
import type { FileTracker } from './filestate';
import type { ShellInfo } from './shell';
import type { JobManager } from './jobs';
import type { Checkpoints } from '../agent/checkpoints';
import type { BrowserSession } from './browser';
import type { DesktopSession } from './desktop';
import type { LanguageServers } from './lsp';

export interface SubagentResult {
  text: string;
  steps: number;
  tokens: number;
  sessionId: string;
  error?: string;
  /** Files the sub-agent changed, with lines added and removed. */
  changed?: { path: string; added: number; removed: number }[];
  /** The model and effort it ran with, and how long it took. */
  model?: string;
  effort?: string;
  durationMs?: number;
  /** Started in the background: the report comes later, as a message. */
  background?: boolean;
  /** The user stopped it before it finished. */
  stopped?: boolean;
}

/** One sub-agent of a tool's own work (see ToolContext.agents). */
export interface ToolAgentJob {
  description: string;
  prompt: string;
  agent: 'general' | 'explore';
  /** The files a general one may change. */
  files?: string[];
  /** What every sub-agent of the call reads first, as a message of its own, so the provider's cache serves it. */
  prelude?: string;
  /** At least this effort: a session set higher keeps its own. */
  effort?: string;
}

export interface ToolAgents {
  run(job: ToolAgentJob, key: string, stop?: AbortSignal): Promise<SubagentResult>;
  /** One at work in `dir`, a copy of the project made for it: it may change anything there, nothing reaches the session's files. */
  inCopy(job: { description: string; prompt: string; prelude?: string }, dir: string, key: string, stop?: AbortSignal): Promise<SubagentResult>;
}

/** What a tool's work in the background has in place of its call's: its own stop, its card, its sub-agents. */
export interface BackgroundWork {
  signal: AbortSignal;
  show: (display: ToolDisplay) => void;
  progress: (chunk: string) => void;
  agents?: ToolAgents;
}

export interface SessionImageSnapshot {
  id: string;
  blob: string;
  mediaType: string;
  name?: string;
  width?: number;
  height?: number;
  bytes?: number;
  origin: 'user' | 'tool';
  toolName?: string;
  callId?: string;
  sourcePath?: string;
  sourceSha256?: string;
  digest?: string;
  virtualPath: string;
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  callId: string;
  turn: string;
  signal: AbortSignal;
  model: ModelInfo;
  config: FavillaConfig;
  shell: ShellInfo;
  mode: Mode;
  /** Most characters a tool result may hand to the model. */
  outputChars: number;
  /** Folder for full outputs too long to return. */
  outputDir: string;
  files: FileTracker;
  checkpoints: Checkpoints;
  jobs: JobManager;
  /**
   * Someone has this session open (the desktop app, the terminal UI, the web page): a background command's end wakes
   * it, and a wait in the foreground keeps that person from talking to the agent. False for headless runs.
   */
  interactive?: boolean;
  /** The session's browser, started on first use; null when no Chrome, Edge or Chromium was found. */
  browser?: () => BrowserSession | null;
  /** The session's hands on the desktop; absent when the user has not turned computer control on. */
  desktop?: () => DesktopSession | null;
  /** The session's language servers (type errors, definitions, references). */
  languageServers?: () => LanguageServers | null;
  /** The session's whole history, before compactions included (recall). */
  history?: () => Message[];
  /** Whether a call's output is still in the model's context, word for word (not compacted or cut). */
  inContext?: (callId: string) => boolean;
  blobs?: BlobStore;
  /** Look up a registered virtual session image (`img-NN`); `markReopened` refreshes its active recency. */
  sessionImage?: (id: string, markReopened?: boolean) => SessionImageSnapshot | null;
  /** All images registered in this session (and parent session if any), oldest first. */
  sessionImages?: () => SessionImageSnapshot[];
  /** Surface-matched call syntax for reopening a virtual image path with the session's read tool. */
  readImageCallHint?: (virtualPath: string) => string;
  progress: (chunk: string) => void;
  /** The call's card as it stands while it runs (the stages of long work); each one replaces the one before. */
  show?: (display: ToolDisplay) => void;
  setTodos: (todos: Todo[]) => void;
  goal: () => Goal | undefined;
  setGoal: (goal: Goal | undefined) => void;
  makeBrief: (request: string) => Promise<ToolOutput>;
  /** The full instructions of tools the session lists in short (load_tools); the tool list itself never changes. */
  loadTools?: (names: string[]) => { loaded: string[]; unknown: string[]; text: string };
  /** Ask the user; resolves null when nobody can answer (headless runs). */
  ask: (questions: Question[]) => Promise<Record<string, string> | null>;
  /** Ask the user to approve a plan; null when nobody can answer. */
  approvePlan: (plan: string) => Promise<{ approved: boolean; feedback?: string } | null>;
  setMode: (mode: Mode) => void;
  runSubagent: (opts: { description: string; prompt: string; agent: string; files?: string[]; model?: string; effort?: string; background?: boolean; cacheGroup?: string; prelude?: string }) => Promise<SubagentResult>;
  /**
   * Sub-agents a tool runs as part of its own work, several at once, each under its own `key` of the call; they share
   * one prompt cache key, and `stop` ends one early. The main agent only.
   */
  agents?: ToolAgents;
  /**
   * Long work that need not hold the turn up, where someone has the session open: the call returns at once with a
   * line for the agent, the work goes on with a stop of its own (the user's stop reaches it), and its result comes
   * back as a message that wakes the session once nothing else is out. Absent in headless runs and sub-agents: there
   * the tool does the work in the call.
   */
  inBackground?: (o: { description: string; resume?: string; work: (bg: BackgroundWork) => Promise<ToolOutput> }) => ToolOutput;
  /** Solve a task several ways at once in copies of the repository and keep the best (see Session.runAttempts). */
  runAttempts?: (opts: { task: string; count: number; check?: string }) => Promise<{ content: string; isError?: boolean; display?: ToolDisplay }>;
  /** null when this agent may change the file; otherwise why not (a sub-agent outside the files of its brief). */
  mayChange?: (abs: string) => string | null;
  /**
   * Ask the user to approve one outward-facing act (sending an email), showing what will happen. Asked even when
   * command approvals are off; "allow_session" approves the same kind of act for the rest of the session.
   */
  confirm?: (r: { title: string; detail: string; reason: string; rule: string }) => Promise<PermissionDecision>;
  /** Run a short side request on a small model (web page extraction). Absent when side requests are off. */
  extract?: (instruction: string, content: string) => Promise<string>;
  proxy: string | false;
}

export interface ToolOutput {
  content: string;
  images?: ImagePart[];
  isError?: boolean;
  display?: ToolDisplay;
}

export type ToolKind = 'read' | 'write' | 'edit' | 'patch' | 'shell' | 'job' | 'grep' | 'glob' | 'todo' | 'task' | 'web' | 'ask' | 'plan' | 'mcp' | 'goal' | 'check' | 'mail' | 'draw';

export interface ToolDef<I = any> {
  kind: ToolKind;
  /** Reads only: may run in parallel and is allowed in plan mode. */
  readOnly: boolean;
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>;
  /** One line describing the call, for the UI and permission prompts. */
  title(input: I, cwd: string): string;
}

/** A tool as one model family sees it: its name, schema and how its arguments map to the shared implementation. */
export interface ToolBinding {
  spec: ToolSpec;
  def: ToolDef;
  normalize(args: Record<string, unknown>): unknown;
}

export class ToolInputError extends Error {}

export function str(args: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolInputError(`Missing required parameter "${key}".`);
    return undefined;
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new ToolInputError(`Parameter "${key}" must be a string.`);
}

export function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new ToolInputError(`Parameter "${key}" must be a number.`);
  return n;
}

export function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return undefined;
}
