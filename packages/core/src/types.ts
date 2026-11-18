// Provider-neutral transcript model. Every part keeps whatever a provider needs to
// replay it unchanged (thinking signatures, encrypted reasoning, thought signatures),
// so a conversation can always be sent back exactly as the model produced it.

export type Effort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export const EFFORT_ORDER: Effort[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface Usage {
  /** All prompt tokens of the request, cached ones included. */
  input: number;
  /** Completion tokens, reasoning included. */
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

export interface TextPart {
  type: 'text';
  text: string;
  /** Full text in the blob store when `text` was clipped in context to fit the model's window. */
  textBlob?: string;
  /** Written by the harness (reminders, steering notes), not typed by the user. */
  synthetic?: boolean;
  /** In a note that carries a message the user sent mid-turn: their words as they wrote them. */
  said?: string;
  /** Full mid-turn `said` text in the blob store when `said` was clipped in context to fit the window. */
  saidBlob?: string;
  /** Provider bookkeeping that must travel back with the part (Gemini thought signature, OpenAI item id/phase). */
  meta?: PartMeta;
}

export interface ImagePart {
  type: 'image';
  mediaType: string;
  /** Base64 without a data: prefix; empty while the image waits in the blob store. */
  data: string;
  name?: string;
  width?: number;
  height?: number;
  /** Stable per-session id ("img-01", "img-02", …), assigned on ingress and kept in session.jsonl. */
  id?: string;
  /** Workspace-relative path when read from a project file, so later disk changes can be detected. */
  sourcePath?: string;
  /** SHA-256 of the source file at read time, to distinguish an older snapshot from an overwritten file. */
  sourceSha256?: string;
  /** Pixel crop [x, y, width, height] when opened with `region`. */
  region?: [number, number, number, number];
  /** Concise visual record captured before mid-epoch eviction when active images exceed the hard budget. */
  digest?: string;
  /** Raw pixels intentionally removed from active context (post-summary or budget spill); kept out on reload. */
  stripped?: boolean;
  /** How closely a provider that offers a choice should look; left out, it decides. */
  detail?: 'high';
  /** Id in the blob store, where every image is kept once on disk. */
  blob?: string;
  /** Where the UI loads the image from (views sent to the UI, which get no data). */
  url?: string;
}

export interface ReasoningPart {
  type: 'reasoning';
  /** Visible reasoning or its summary; empty when the provider hides it. */
  text: string;
  provider: string;
  model: string;
  /** Anthropic thinking signature. */
  signature?: string;
  /** Anthropic redacted_thinking payload. */
  redacted?: string;
  /** OpenAI encrypted_content. */
  encrypted?: string;
  /** The completed Responses item for exact replay. Its ciphertext lives only in `encrypted`. */
  responsesItem?: Record<string, unknown>;
  /** OpenAI reasoning item id. */
  itemId?: string;
  /** OpenRouter-style opaque reasoning details, replayed verbatim. */
  details?: unknown[];
  meta?: PartMeta;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Raw argument text as streamed (or the freeform body of a custom tool). */
  raw?: string;
  /** OpenAI custom (freeform) tool call. */
  custom?: boolean;
  parseError?: string;
  /** Its arguments had to be closed by repair: inside a string, or before their last brackets. */
  cut?: 'string' | 'structure';
  meta?: PartMeta;
}

export interface ToolResultPart {
  type: 'tool_result';
  callId: string;
  name: string;
  content: string;
  images?: ImagePart[];
  isError?: boolean;
  /** UI-only structured view of the result. Never sent to a model. */
  display?: ToolDisplay;
  durationMs?: number;
  /** Bounded observations for resume/compaction; not sent as provider tool content. */
  evidence?: ToolEvidence;
  /** Set when the content was moved out of memory (an old turn): its id in the blob store. */
  contentBlob?: string;
  /** Set when a large `display` was moved out of memory the same way. */
  displayBlob?: string;
  /** Cut to a stub to keep the context lean (light compaction); the full text is at contentBlob. */
  pruned?: boolean;
  /** The content shown is a preview of a longer result (in views sent to the UI). */
  truncated?: boolean;
}

export interface FileVersion {
  path: string;
  /** SHA-256 of the bytes; null means absent, undefined means not fingerprinted. */
  digest?: string | null;
}

export interface ReadEvidence extends FileVersion {
  digest: string;
  total: number;
  ranges: [number, number][];
}

export interface ToolEvidence {
  reads?: ReadEvidence[];
  writes?: string[];
  writtenFiles?: FileVersion[];
  failure?: { kind: 'input' | 'environment' | 'assertion' | 'build' | 'interrupted' | 'other'; scope: string; diagnostic: string };
  run?: {
    command: string;
    cwd: string;
    outcome: 'passed' | 'failed' | 'unknown';
    before?: boolean;
    diagnostic?: string;
    logPath?: string;
    inputs: FileVersion[];
  };
}

/** A provider-specific block replayed verbatim to the provider that produced it (e.g. a hosted web search call). */
export interface OpaquePart {
  type: 'opaque';
  provider: string;
  model: string;
  data: unknown;
  /** Short human description for the UI. */
  label?: string;
}

export type Part = TextPart | ImagePart | ReasoningPart | ToolCallPart | ToolResultPart | OpaquePart;

export interface PartMeta {
  provider?: string;
  model?: string;
  /** Gemini thoughtSignature. */
  thoughtSignature?: string;
  /** OpenAI output item id. */
  itemId?: string;
  /** OpenAI message phase (commentary / final_answer). */
  phase?: string;
  [key: string]: unknown;
}

/** `cut`: the connection dropped mid-reply, and what had arrived is kept as the reply (session.ts, kept parts). */
export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'cut' | 'refusal' | 'aborted' | 'error' | 'pause';

/**
 * How the request for one reply went, kept with the reply so a session can say where its waiting went. A record for
 * Favilla and its user: no provider is ever sent it.
 */
export interface RequestWait {
  /** Attempts made, the one that answered included. */
  tries: number;
  /** From the start of the first attempt to the start of the one that answered: failed attempts and the pauses between them. 0 when the first answered. */
  lostMs: number;
  /** The attempt that answered, start to end. */
  ms: number;
  /** In the attempt that answered, until anything at all came from the server; a keep-alive counts. */
  firstByteMs?: number;
  /** In the attempt that answered, until its first text, reasoning or tool-call delta. */
  firstWordMs?: number;
  /** The longest silence between two such deltas, left out under a second. */
  longestGapMs?: number;
  /** The failed attempts, oldest first, the last eight at most. `got` is the characters that had arrived when it failed. */
  failed?: { kind: string; status?: number; ms: number; got: number }[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  parts: Part[];
  time: number;
  /** Where a user-role message came from. */
  origin?: 'user' | 'tool' | 'compaction' | 'harness';
  /** A preset's system prompt inside the conversation: sent as a system message where the provider has those. */
  asSystem?: boolean;
  provider?: string;
  model?: string;
  usage?: Usage;
  stop?: StopReason;
  /** On a reply the main loop asked for: how the request went. */
  wait?: RequestWait;
  error?: string;
  refusal?: string;
  /** Turn this message belongs to (a turn starts with a typed user message). */
  turn?: string;
  /** A copy of recent work placed after a compaction summary so the model keeps it verbatim; the UI shows the original. */
  replay?: boolean;
  /** A housekeeping reply supplements this earlier report instead of replacing it as the turn's answer. */
  supplementTo?: string;
  /** On a compaction summary: the user's messages so far, verbatim, carried into the next compaction. */
  carried?: string[];
  /** On a compaction summary: the context's size before and after (estimated), the rounds kept word for word and the first of them. */
  compacted?: { before: number; after: number; rounds: number; from?: string; bench?: ReadEvidence[] };
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface DiffFile {
  binary?: { before: number; after: number };
  path: string;
  op: 'add' | 'update' | 'delete' | 'move';
  movedTo?: string;
  patch: string;
  added: number;
  removed: number;
}

/** A message as a mail result lists it. */
export interface MailSummaryView {
  id: string;
  date?: string;
  from?: string;
  to?: string;
  subject: string;
  snippet?: string;
  unread: boolean;
  starred: boolean;
  attachments: number;
  labels?: string[];
}

export type ToolDisplay =
  | { kind: 'diff'; files: DiffFile[]; /** The UI got only the start of a long patch. */ clipped?: boolean }
  | {
      kind: 'terminal';
      command: string;
      output: string;
      exitCode: number | null;
      durationMs: number;
      cwd: string;
      background?: string;
      truncated?: boolean;
      logPath?: string;
      timedOut?: boolean;
      /** Why Favilla stopped the command (the computer ran short of memory). */
      stoppedFor?: string;
      /** The UI got only the end of the output. */
      clipped?: boolean;
    }
  | {
      kind: 'file';
      path: string;
      startLine: number;
      lineCount: number;
      totalLines: number;
      preview: string;
      image?: boolean;
      /** An image's width and height, and the part of it that was shown enlarged. */
      size?: [number, number];
      region?: [number, number, number, number];
    }
  | { kind: 'search'; pattern: string; path: string; matches: number; files: number; preview: string }
  | { kind: 'list'; title: string; items: string[]; total: number }
  | { kind: 'todo'; todos: Todo[] }
  | {
      kind: 'task';
      description: string;
      agent: string;
      steps: number;
      tokens: number;
      childSession?: string;
      /** The files the brief let it change (absent: any). */
      files?: string[];
      /** What it changed, as Favilla recorded it. */
      changed?: Pick<DiffFile, 'path' | 'added' | 'removed' | 'binary'>[];
      /** The model and effort it ran with, and how long it took. */
      model?: string;
      effort?: string;
      durationMs?: number;
      /** Started in the background: its report came later, as a message. */
      background?: boolean;
      /** The user stopped it before it finished. */
      stopped?: boolean;
    }
  | {
      kind: 'web';
      url: string;
      status: number;
      bytes: number;
      title?: string;
      /** How the page was read: its site's API, the page, the browser, a PDF, plain text. */
      via?: 'api' | 'page' | 'browser' | 'pdf' | 'text';
      /** Characters of text the page came to. */
      chars?: number;
      /** The date the page states (last change, else publication). */
      date?: string;
    }
  | {
      kind: 'links';
      query: string;
      /** The engines that answered, and how many copy-site results were left out. */
      engines?: string[];
      dropped?: number;
      /** quote: what the opened page says on the query. */
      results: { title: string; url: string; snippet: string; date?: string; quote?: string }[];
    }
  | { kind: 'shot'; url: string; width: number; height: number }
  | {
      kind: 'mail';
      action: 'accounts' | 'search' | 'read' | 'draft' | 'send' | 'mark';
      account: string;
      accounts?: string[];
      folder?: string;
      query?: string;
      total?: number;
      items?: MailSummaryView[];
      message?: MailSummaryView & { cc?: string; body: string; html: boolean; files: { name: string; type: string; size: number; saved?: string }[] };
      /** An email written: what it says, to whom, and whether the user turned it down. */
      preview?: string;
      to?: string[];
      declined?: boolean;
      note?: string;
    }
  | { kind: 'question'; questions: Question[]; answers: Record<string, string> }
  | { kind: 'plan'; plan: string; approved: boolean }
  | { kind: 'goal'; goal: Goal }
  | {
      kind: 'checks';
      results: CheckResult[];
      found: string[];
      /** Run on the code as it was before the session's changes. */
      before?: boolean;
      /** Whether the session's own tests catch its fix, from running them on the code before it. */
      verdict?: { kind: 'catches' | 'pass-before' | 'no-build'; files: string[] };
      incomplete?: boolean;
      /** Explicit, bounded partial-revert checks; never a claim of complete test coverage. */
      probe?: ProbeReport;
    }
  | {
      kind: 'attempts';
      /** How each attempt did: its checks, its change, and whether it was the one kept. */
      attempts: { n: number; passed: number; failed: number; added: number; removed: number; files: number; chosen: boolean; childSession?: string; note?: string }[];
      /** Why the chosen one was chosen. */
      reason?: string;
    }
  | { kind: 'text'; text: string }
  /**
   * Long work in stages, while it runs and once it is done: each stage with its count, what came of it in figures, and
   * the files it wrote. Labels are English text with {n} and {m}, translated by the front end like its own words
   * (an extension brings its translations).
   */
  | { kind: 'stages'; stages: { label: string; done?: number; of?: number; state: 'waiting' | 'on' | 'done' }[]; figures: { label: string; n: number | string; m?: number | string; tone?: 'good' }[]; files?: { label: string; path: string }[]; note?: string };

export interface ProbeReport {
  results: { path: string; line: number; outcome: 'detected' | 'survived' | 'inconclusive'; logPath?: string }[];
  skipped?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** build: the usual; plan: research and propose before changing anything. */
export type Mode = 'build' | 'plan';

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  created: number;
  updated: number;
  provider: string;
  model: string;
  effort: Effort;
  mode: Mode;
  /** Session entered plan mode, so the plan tool stays in `tools` after switching to build. */
  planEnabled?: boolean;
  /** Tools enabled after the initial list, in the order appended to requests. */
  appendedTools?: string[];
  profile: string;
  parentId?: string;
  agent?: string;
  /** The session this one branched from, and the message where it did. */
  branchOf?: { id: string; title: string; message: string };
  /** The session whose file holds this one's first `messages` messages (its history up to the branch point), read from there instead of copied. */
  base?: { id: string; messages: number };
  /** Deleted while branches still read its history: kept on disk for them, out of every list. */
  hidden?: boolean;
  /** The conversations this one replaced, even when their files were no longer needed. */
  replaces?: string[];
  /** What the session is for and how to tell it is done; kept through compaction and checked before stopping. */
  goal?: Goal;
  /** The prompt preset this session keeps a copy of, and the library it came from. */
  preset?: { name: string; scope: 'global' | 'workspace' };
  /** The persona this session keeps, in the words it started with: changing the library later does not reach it. */
  persona?: { name: string; text: string };
  /** Messages sent while it worked that it had not read yet, kept on disk so a crash does not lose them. */
  queued?: { id?: string; text: string; at: number; images?: { id?: string; mediaType: string; blob: string; name?: string; width?: number; height?: number; sourcePath?: string; sourceSha256?: string }[] }[];
  /** The calls whose background sub-agents the user stopped (the latest 50), for a front end opened later. */
  stopped?: string[];
  /** Tool calls whose work went on in the background (the latest 20). */
  tasks?: BackgroundTask[];
  /** How the last turn ended and how many files it changed, for a list that shows the session without opening it. */
  last?: { end: TurnEndReason; files: number };
}

/**
 * A tool call whose work went on in the background (a long-running check), as the session keeps it: so a front end opened later
 * draws its card, and one cut off by a stop of Favilla is told as such when the session opens again.
 */
export interface BackgroundTask {
  callId: string;
  tool: string;
  description: string;
  started: number;
  state: 'running' | 'done' | 'stopped' | 'failed' | 'interrupted';
  /** Its card as it ended. */
  display?: ToolDisplay;
  /** How the agent goes on with it after it was cut off, in the tool's words. */
  resume?: string;
}

export interface GoalCriterion {
  text: string;
  done: boolean;
  /** How it was shown to be met. */
  evidence?: string;
  /** A run Favilla recorded showed it; otherwise it is the agent's word. */
  proved?: boolean;
  /** How a brief says it is checked: looking at the result, a run, or a number. */
  check?: 'look' | 'run' | 'measure';
  /** The maker says it is met; on a brief's goal only the review marks it done. */
  claimed?: boolean;
}

export interface Goal {
  objective: string;
  criteria: GoalCriterion[];
  /** 1-based number of the criterion being worked on now, on long work where the criteria are its milestones. */
  active?: number;
  /** brief: written as part of a brief; the maker works to it and a reviewer marks it. */
  by: 'user' | 'model' | 'brief';
  updated: number;
}

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  durationMs: number;
  /** The lines that say what failed: file:line messages, failing tests, the summary. */
  problems: string[];
  summary?: string;
  logPath?: string;
  timedOut?: boolean;
}

export interface SessionUsage {
  contextTokens: number;
  contextWindow: number;
  compactAt: number;
  totalInput: number;
  totalOutput: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  requests: number;
  /** Subscription plan meters, as a provider last reported them. */
  plan?: PlanUsage;
}

/** One limit of a subscription plan: a window of time and how much of it is used. */
export interface PlanMeter {
  /** The window's length in minutes: 300 is five hours, 10080 a week. */
  minutes: number;
  usedPercent: number;
  /** When the window starts over (ms since the epoch). */
  resetAt?: number;
}

export interface PlanUsage {
  /** The plan's name as the server gives it ("plus", "pro"). */
  type?: string;
  /** The limits the plan has now; a plan without a five-hour limit has only the weekly one. */
  windows: PlanMeter[];
  /** Credits bought or granted beyond the plan, used once a limit is reached. */
  credits?: { balance: number; unlimited: boolean };
  /** When these numbers were read. */
  at: number;
}

/** What a session's context holds now (Session.contextReport). Token counts are scaled to the measured total. */
export interface ContextReport {
  tokens: number;
  window: number;
  /** The window the provider reports, before any override in the settings. */
  nativeWindow: number;
  compactAt: number;
  /** Where light compaction (cutting old tool output to stubs) starts. */
  pruneAt: number;
  parts: { system: number; tools: number; summary: number; conversation: number; reasoning: number; outputs: number; cut: number };
  /** Tool outputs in full, and cut to stubs. */
  outputs: number;
  cut: number;
  compactions: number;
}

export interface PermissionRequest {
  id: string;
  tool: string;
  title: string;
  detail: string;
  reason: string;
  rule: string;
  /** The answer applies only to this action; the card has no session-wide choice. */
  once?: boolean;
}

export type PermissionDecision = 'allow' | 'allow_session' | 'deny';

export interface QuestionRequest {
  id: string;
  questions: Question[];
}

export type TurnEndReason = 'done' | 'aborted' | 'error' | 'max_steps' | 'refusal';

/** A message sent while the agent works, as the composer shows it until the agent reads it. */
export interface ReturnedInput {
  id: string;
  text: string;
  images: ImagePart[];
}

export interface QueuedInput {
  id: string;
  text: string;
  /** How many images go with it. */
  images: number;
  at: number;
}

/** The streamed reply so far, as emitted to a front end that joins it mid-stream. */
export interface StreamDraft {
  messageId: string;
  parts: ({ index: number; text: string } & ({ kind: 'text' | 'reasoning' } | { kind: 'tool'; name: string; id: string }))[];
}

export type AgentEventBody =
  | { type: 'status'; status: 'idle' | 'running' | 'compacting' | 'waiting'; detail?: string }
  | { type: 'message.added'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'stream.start'; messageId: string; model: string }
  // Offsets count UTF-16 code units already emitted for this part, including any prefill lead.
  | { type: 'stream.text'; messageId: string; index: number; delta: string; at: number }
  | { type: 'stream.reasoning'; messageId: string; index: number; delta: string; at: number }
  | { type: 'stream.tool'; messageId: string; index: number; id: string; name: string; delta: string; at: number }
  | { type: 'stream.end'; messageId: string }
  /** A partly streamed response was abandoned (the request is being retried). */
  | { type: 'stream.discard'; messageId: string }
  | { type: 'plan.request'; id: string; plan: string }
  | { type: 'plan.resolved'; id: string; approved: boolean }
  | { type: 'tool.start'; callId: string; name: string; title: string; input: Record<string, unknown> }
  /** display: the call's card as it stands, sent by a tool that shows its work (the latest counts). */
  | { type: 'tool.progress'; callId: string; chunk: string; display?: ToolDisplay }
  | { type: 'tool.end'; callId: string; result: ToolResultPart }
  | { type: 'permission.request'; request: PermissionRequest }
  | { type: 'permission.resolved'; id: string; decision: PermissionDecision }
  | { type: 'question.request'; request: QuestionRequest }
  | { type: 'question.resolved'; id: string }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'usage'; usage: SessionUsage }
  /** pruned: light compaction cut `count` old tool outputs to stubs. */
  | { type: 'compaction'; phase: 'start' | 'end' | 'failed' | 'pruned'; before?: number; after?: number; error?: string; count?: number }
  /** key: the English template the UI translates, with {n} filled from arg; text is the same message in English. */
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string; key?: string; arg?: string }
  | { type: 'turn.start'; turn: string }
  | { type: 'turn.end'; turn: string; reason: TurnEndReason; error?: string; errorKind?: string }
  | { type: 'meta'; meta: SessionMeta }
  | { type: 'session.replaced'; replacement: SessionMeta }
  /**
   * Messages sent while the agent works, waiting for its next step. `returned`: ones it never read (the turn was
   * interrupted or failed), handed back to the composer.
   */
  | { type: 'queue'; items: QueuedInput[]; returned?: ReturnedInput[] }
  /** A model picked while the session works, taking over once it stops; null once it has, or the pick was undone. */
  | { type: 'held'; model: string | null }
  /** The session's model now offers other thinking levels or another window (settings, models.dev, a server's refusal). */
  | { type: 'model'; model: { ref: string; efforts: Effort[]; defaultEffort: Effort; contextWindow: number; nativeWindow?: number } }
  | { type: 'checkpoint'; turn: string; files: string[] }
  /** The sub-agents at work in the background, sent whole whenever one starts or ends; they can outlast the turn. */
  | { type: 'background'; running: BackgroundRun[] }
  /**
   * The user's message while the turn looks up code or compacts, so it shows at once; null once it is in the conversation.
   */
  | { type: 'preparing'; text: string | null; images?: number }
  | { type: 'subagent'; callId: string; event: AgentEvent };

/** A sub-agent at work in the background: the call that started it, its brief's title, its own session. */
export interface BackgroundRun {
  callId: string;
  description: string;
  /** The sub-agent's session; empty for a tool's own work. */
  sessionId: string;
  started: number;
  /** A tool's own work in the background: the tool, and its card as it stands. */
  tool?: string;
  display?: ToolDisplay;
}

export type AgentEvent = AgentEventBody & { sessionId: string };

/** Opaque comparisons for the values a settings form opened with. */
export type SettingBasis = Record<string, string>;
