import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  AgentEvent,
  AgentEventBody,
  BackgroundRun,
  BackgroundTask,
  ContextReport,
  Effort,
  ImagePart,
  Goal,
  Message,
  Mode,
  Part,
  PermissionDecision,
  PermissionRequest,
  Question,
  QuestionRequest,
  RequestWait,
  SessionMeta,
  SessionUsage,
  StreamDraft,
  TextPart,
  Todo,
  ToolCallPart,
  ToolDisplay,
  ToolResultPart,
  FileVersion,
  TurnEndReason,
  QueuedInput,
  ReturnedInput,
  Usage,
  ToolEvidence,
} from '../types';
import { EFFORT_ORDER } from '../types';
import type { Catalog, ModelInfo } from '../catalog/catalog';
import type { FavillaConfig } from '../config/config';
import { DEFAULTS, ignoredProjectKeys, shadowTestsModel } from '../config/config';
import { adapterFor } from '../providers';
import { thinksAt } from '../providers/anthropic';
import { ProviderError, effortRefusal, type EffortRefusal } from '../providers/errors';
import type { ProviderCall, ProviderResult, StreamEvent, ToolSpec } from '../providers/types';
import { STALL_DEEP_MS } from '../net/http';
import { buildTools, loadToolsBinding, modelsByProvider } from '../tools/profiles';
import { deferredByExtension, extensionMessage, loadExtensions } from '../extensions/registry';
import type { BackgroundWork, SessionImageSnapshot, ToolAgents, ToolBinding, ToolContext, ToolOutput, SubagentResult } from '../tools/types';
import { ToolInputError } from '../tools/types';
import { FileTracker, describeCoverage, fileDigest } from '../tools/filestate';
import { workbench } from '../context/bench';
import { Claims } from './claims';
import { searchCode } from '../tools/codesearch';
import { applyPatch, copyChanges, gitRoot, makeCopy, patchFiles, removeCopy, scoreCopy, type Copy, type Score } from './attempts';
import { checkShadow, removeShadow, shadowFiles, shadowKind, shadowNote, shadowRunner, trustShadow, type ShadowTests } from './shadow-tests';
import { RepeatWatch } from './repeat';
import { evidenceSummary, observeOutcome, recordedEvidence, recoveryNote, restoreReads, snapshotVersions } from './evidence';
import { asksForInterface, asksForPage, asksForRedesign, asksForWorkScreen, asksToFix, asksToMake, namesInterface, withoutProhibitions, runsSomething, changesProject, isCheckCommand, looksLikePlan, namesCode, asksForAgents, languageOf, statesStandingRule, asksAboutMail, asksForDocuments, asksForWrittenDoc, DOCUMENT_FILE, WRITTEN_DOC_FILE, PROSE_DOC_FILE, CODE_FILE, checkDocumentProse, docStyleNote } from './turn-checks';
import { execFile } from 'node:child_process';
import { makeDiff } from '../tools/diffutil';
import { JobManager, type Job as BackgroundJob } from '../tools/jobs';
import { detectShell, type ShellInfo } from '../tools/shell';
import { ripgrepPath } from '../tools/ripgrep';
import { checkCommand, outsideArgs, outsidePath } from '../guard/guard';
import { checkCatastrophe, checkFileCatastrophe, explicitlyRequested, type Catastrophe } from '../guard/catastrophe';
import { catastropheRefusal } from '../guard/i18n';
import { mailAccounts } from '../mail/accounts';
import { activePersona, personaText, type Persona } from '../prompt/persona';
import { activePreset, macroContext, placePreset, presetBulk, presetSystem, type ActivePreset } from '../prompt/preset';
import { buildSystemPrompt, dealAppStyles, dealDirections, designGuide, fill, hasInterface, promptAsset, scratchDir } from '../prompt/system';
import { discoverSkills } from '../prompt/skills';
import { FACTS_START, inGitRepo, isCodeProject, projectFacts } from '../prompt/env';
import { blobRefs, fullText, release } from '../store/pack';
import { hasNotebooks } from '../tools/notebook';
import type { McpHub } from '../mcp/hub';
import { computeBudget, type Budget } from '../context/budget';
import { SessionStore } from '../store/sessions';
import { logTokens, tokens, type TokenEntry } from '../store/token-log';
import { Checkpoints, type Change } from './checkpoints';
import { Shadow } from './shadow';
import { newId } from '../util/id';
import { Deferred, isAbortError, sleep } from '../util/async';
import { Calibrator, estimateImageTokens, estimateInboundTokens, estimateMessageTokens, estimatePartTokens, estimateTokens } from '../util/tokens';
import { parseToolArgs, stableStringify } from '../util/json';
import { displayPath, appPath, assetsDir, normalizeForCompare, projectSlug, resolvePath, toForward } from '../util/paths';
import { cleanTerminal, oneLine } from '../util/text';
import { sessionTitle, titleWithFile } from './title';
import { formatGoal, openCriteria } from '../tools/goal';
import { filterPruneByPrefixCut, pairToolCalls, planPrune, prunePays, sendable, tailOf, UNANSWERED, UNSTORED_TOOL_OUTPUT, userWords, type PruneItem } from '../context/prune';
import type { PrefixCacheContext } from '../context/cache-cut';
import { workRecord } from '../context/record';
import {
  findVirtualImageRefs,
  fitPictures,
  formatReadImageCall,
  imageBudget,
  learnPictureBudget,
  PICTURE_FLOOR,
  pictureBudget,
  pictureBytes,
  pictureCount,
  planSessionImages,
  providerMaxImages,
  virtualImagePath,
} from '../context/images';
import { imageSize, normalizeImagePart } from '../tools/image';
import { BrowserSession, findBrowser, userBrowserDir } from '../tools/browser';
import { keepPrivate } from '../tools/outbound';
import { aboutVideoText, asksForArt, asksForFilm, asksForMusic, BRIEF_REVIEWS, briefPrompt, drawLook, lookNote, looksPrompt, parseBrief, parseLooks, parseReview, reviewPrompt, skillTexts, visualAsk, type Looks } from './brief';
import { BRIEF_TITLE } from '../tools/brief';
import { taskTool } from '../tools/agent-tools';
import { reviewTool } from '../tools/review';
import { COPY_SITES } from '../tools/websearch';
import { DesktopSession } from '../tools/desktop';
import { LanguageServers } from '../tools/lsp';
import { envProxy } from '../net/http';
import { debug } from '../util/log';
import { timedSync } from '../util/slow';

/** One call a session made, as its progress shows it. */
export interface SessionStep {
  id: string;
  name: string;
  input: Record<string, unknown>;
  started: number;
  ended?: number;
  failed?: boolean;
}

export interface SessionDeps {
  catalog: Catalog;
  config: FavillaConfig;
  store: SessionStore;
  /** MCP servers shared by the runtime's sessions. */
  mcp?: McpHub;
}

export interface StartOptions {
  cwd: string;
  model?: string;
  effort?: Effort;
  mode?: Mode;
  /** A window can open before the project facts needed by the first request are ready. */
  deferProjectFacts?: boolean;
  /** A person can answer permission prompts and questions. */
  interactive?: boolean;
  /** Unattended run: adds the autonomy instructions to the system prompt. */
  autonomous?: boolean;
  role?: 'main' | 'explore' | 'general';
  parent?: Session;
  /** A general sub-agent's files (paths, folders, globs); null: it may change any. */
  claim?: string[] | null;
  /** A sub-agent working in a copy of the repository: its own undo history, not its parent's. */
  isolated?: boolean;
  title?: string;
  /** A branch keeps the preset of the session it came from; otherwise the folder's choice holds. */
  preset?: ActivePreset | null;
  /** Sessions that send the same long prefix (the sub-agents of one tool call) share this as the prompt cache key. */
  cacheGroup?: string;
}

/** A request's shadow tests while they are written and after (see Session.shadowRun). */
type ShadowRun = { turn: string; result: Promise<ShadowTests | null>; placed: string[]; stop: () => void; signal: AbortSignal; done: boolean; deferred: boolean };

/**
 * Tools the main session lists in short until it loads them: rarely needed, and their definitions are long. Not
 * recall: after a compaction it is how the details come back, its definition is short, and a stub that says to load
 * it first stood between the model and it (2026-11-06). Not review or symbols, whose stubs came to more than their
 * whole definitions, nor remember, a general assistant's memory, called directly in 32 of 32 eval sessions that used
 * it (2026-11-06). Mail is: its definition was the longest after agent's (1.7k characters) in every request of a user
 * with a mailbox, coding or not, and it named their addresses to every provider (2026-11-07).
 */
const DEFERRED_TOOLS = new Set(['paint', 'browser', 'watch', 'music', 'film', 'attempts', 'mail']);
const deferred = (name: string) => DEFERRED_TOOLS.has(name) || deferredByExtension(name);
/**
 * What each held-back tool is for, in one whole line. The first sentence of its definition, cut at 140 characters,
 * left fragments in every system prompt ("a textur e for each );", 2026-11-06).
 */
const BRIEFS: Record<string, string> = {
  browser: 'Uses web pages like a person: opens, clicks, types, reads and screenshots your pages and sites on the web.',
  paint: 'Paints pictures by hand (illustrations, scenes, textures) and cuts a picture out of its ground.',
  music: 'Writes and renders music from a score in bars, and reports bar by bar what it sounds like.',
  film: 'Renders a video from an animation page you write, frame by frame, with its sound.',
  watch: 'Watches a rendered video as a viewer would: freezes, jumps, moves too fast, sound off its hits.',
  // When to reach for it lived in every tools prompt as a line of its own; it is said here once.
  attempts: 'Solves one hard, test-checked code change several ways at once in git worktrees and keeps the best: for a tricky bug, an algorithm or edge cases a first try often gets wrong, or after two failed tries. Costs as many times the tokens as attempts.',
  mail: "Searches, reads and sorts the user's email and writes it; an email goes only after the user approves it.",
};
/** Words of a brief's chosen look that make it hand-made: such a film is painted, not drawn in code. */
/** An answer that says something was noted for later. */
const CLAIMS_NOTE = /记下了|记住了|已记下|已经记下|已记住|记到了|noted (?:it|that|for)|I(?:'ll| will) remember|I've noted|saved (?:it|that) as a note/i;
// A turn of work that ends by asking leave to go on, or by saying what it will do next: the user is left to send
// "继续". GPT-5.6 Sol did so after 2 of its 18 finished working turns in real sessions (2026-11-06).
const ASKS_TO_GO_ON = /要我继续|要继续吗|是否继续|继续吗|需要我继续|要不要我|我可以接着|等你确认|你确认后|确认后我|\b(?:shall i|should i (?:continue|proceed|go ahead)|would you like me to|do you want me to|want me to (?:continue|go on|proceed))\b/i;
const SAYS_NEXT = /接下来我(?:会|就|来|再|先)|下一步我(?:会|就|来|再)|我(?:接着|马上|这就|随后)(?:去|来|会|就)|\b(?:next,? i(?:'ll| will)|i(?:'ll| will) (?:now|next|then) )/i;

const HAND_MADE = /手书|手绘|手描|手作|水彩|水墨|水粉|油画|彩铅|蜡笔|版画|孔版|纸|hand-?drawn|hand-?made|painted|paint|watercolou?r|gouache|pastel|charcoal|ink\b|risograph|paper|tegaki/i;

/** A held-back tool's line: its own brief, or an extension's first sentence, cut at a word when long. */
export function briefOf(spec: Pick<ToolSpec, 'name' | 'description'>): string {
  if (BRIEFS[spec.name]) return BRIEFS[spec.name];
  const first = (spec.description.split(/(?<=[.。])\s*/)[0] ?? '').trim();
  if (first.length <= 120) return first;
  const cut = first.slice(0, 120);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 60)).trimEnd()}…`;
}

/** A JSON schema without its descriptions and examples: the names, types, enums and what is required. */
function bareSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(bareSchema);
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'description' || k === 'examples') continue;
    out[k] = k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([name, prop]) => [name, bareSchema(prop)])) : bareSchema(v);
  }
  return out;
}

/**
 * A held-back tool as every request lists it: its first sentence and its bare parameters. The list never changes in
 * a session: a provider's prompt cache starts with it, and one tool added halfway made the next request's whole input
 * uncached (measured on an OpenAI Responses backend). load_tools gives the rest, at the end of the conversation.
 */
function stubSpec(spec: ToolSpec): ToolSpec {
  return { ...spec, description: `${briefOf(spec)} Listed in short: load_tools gives its full instructions.`, parameters: bareSchema(spec.parameters) as ToolSpec['parameters'] };
}
const MAX_RETRIES = 7;
/** Tries for a rate limit: with the waits doubling to 90 s, about ten minutes; FAVILLA_RATE_LIMIT_RETRIES for runs that can wait longer. */
const RATE_LIMIT_RETRIES = Math.max(1, Number(process.env.FAVILLA_RATE_LIMIT_RETRIES) || 12);
/**
 * How many times a failed request is tried. A rate limit passes with time, so it is waited out longest. So is an outage
 * when nobody is waiting (an autonomous run, a headless run, a sub-agent): a relay cut a third of its requests
 * at 30 s for hours on 2026-11-06, and seven tries (about three minutes) ended 10 of 16 eval runs before their work.
 */
export function triesFor(kind: string, present: boolean): number {
  const outage = kind === 'overloaded' || kind === 'server' || kind === 'network' || kind === 'stream_stalled';
  return kind === 'rate_limit' || (!present && outage) ? RATE_LIMIT_RETRIES : MAX_RETRIES;
}
/** Tries before an unreachable provider is reported to a user who is waiting (about ten seconds). */
const PRESENT_RETRIES = 2;
/** What a retry notice says, by the kind of failure, as keys an interface translates; {n} is the try of how many. */
const RETRY_NOTICES: Record<string, string> = {
  network: 'Lost the connection to the provider; trying again ({n}).',
  stream_stalled: 'The reply stopped coming; trying again ({n}).',
  rate_limit: 'The provider is limiting requests; trying again ({n}).',
  overloaded: 'The provider is busy or failing; trying again ({n}).',
  server: 'The provider is busy or failing; trying again ({n}).',
  model_not_found: 'The provider has no route to this model just now; trying again ({n}).',
};
/**
 * A stream given up as dead: nothing at all from the server (no word, no keep-alive, no answered ping) this long.
 * Servers that show a model's thinking, and sockets that answer pings, keep it from firing while the model thinks;
 * a plain HTTP stream of a model that keeps its thoughts to itself can be silent for many minutes at high effort.
 */
const STALL_MS = Number(process.env.FAVILLA_STALL_MS) || 8 * 60_000;
/** Characters of a reply that make it worth keeping when the connection drops (a blip early on is simply asked again). */
const KEEP_CUT_AT = 1500;
/** However alive the connection, a reply with not a word for this long is asked for again. */
const WORDLESS_MS = Number(process.env.FAVILLA_WORDLESS_MS) || 45 * 60_000;

function isStreamWord(e: StreamEvent): boolean {
  return e.type === 'text' || e.type === 'reasoning' || e.type === 'tool';
}

/** A keep-alive only winds back the shorter clock. */
function watchStreamSilence(deep: boolean, giveUp: () => void) {
  let stall: NodeJS.Timeout | undefined;
  let wordless: NodeJS.Timeout | undefined;
  return {
    touch(word: boolean) {
      // A streamed reply moves the deadlines many times, but the callbacks stay the same.
      stall = stall?.refresh() ?? setTimeout(giveUp, deep ? STALL_DEEP_MS : STALL_MS);
      if (word) wordless = wordless?.refresh() ?? setTimeout(giveUp, WORDLESS_MS);
    },
    close() {
      clearTimeout(stall);
      clearTimeout(wordless);
      stall = wordless = undefined;
    },
  };
}

/**
 * The part of a new file that arrived before the connection dropped, as a write of its complete lines: twenty or
 * more, the line the cut fell in left out. Only when the cut fell in the content, its path whole before it: arguments
 * come in any order, and a path cut off would make a file of the wrong name. Never for a file that exists, whose old
 * text a half would replace. Favilla's write names the file path, Claude's Write file_path.
 */
function keptLines(kind: string, call: ToolCallPart, cwd: string): { input: Record<string, unknown>; lines: number } | null {
  const input = call.input ?? {};
  const key = typeof input.path === 'string' ? 'path' : typeof input.file_path === 'string' ? 'file_path' : null;
  if (kind !== 'write' || !key || typeof input.content !== 'string') return null;
  const raw = call.raw ?? '';
  const pathAt = raw.search(new RegExp(`"${key}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`));
  const contentAt = raw.search(/"content"\s*:\s*"/);
  if (pathAt < 0 || contentAt < 0 || pathAt > contentAt) return null;
  if (fs.existsSync(resolvePath(cwd, input[key] as string))) return null;
  const end = input.content.lastIndexOf('\n');
  const content = end < 0 ? '' : input.content.slice(0, end + 1);
  const lines = content.split('\n').length - 1;
  return lines >= 20 ? { input: { ...input, content }, lines } : null;
}
/**
 * Silence long enough for the working line to say the model is thinking out of sight. At high effort and above a
 * model thinks for minutes before its first word (GPT-6.1 Sol at max: 2 min 13 s, 2026-11-02).
 */
const QUIET_MS = Number(process.env.FAVILLA_QUIET_MS) || 60_000;
const QUIET_DEEP_MS = Number(process.env.FAVILLA_QUIET_MS) || 3 * 60_000;
/** Calls of its own that look at the work before the agent may start a sub-agent, and sub-agents a turn after that. */
const LOOK_FIRST = 3;
const AGENTS_PER_TURN = 2;
/** Tool kinds that hand work out or keep books, not look at the work. */
const NOT_LOOKING = new Set(['task', 'todo', 'goal', 'ask', 'plan', 'note']);
/** On a long run without the user, the goal comes back into view this often (tool rounds). */
const GOAL_EVERY = 25;
/** A task this long without a goal is asked to set one, once a turn. Sooner, short tasks spend requests on bookkeeping. */
const GOAL_ASK_AFTER = 30;
/** Light compaction starts once the context is this full, and waits for this much growth between rounds. */
const PRUNE_AT = 0.5;
const PRUNE_GROWTH = 0.08;
/** The tool rounds light compaction never touches: what the model is working with now. */
const KEEP_ROUNDS = 6;
/**
 * A headless browser the agent has not used for this long, with the session between turns, is closed: each held
 * about 170 to 190 MB until its session left memory. The next browser or paint call starts one again.
 */
const BROWSER_IDLE_MS = Number(process.env.FAVILLA_BROWSER_IDLE_MS) || 3 * 60_000;
/** The background summary starts at this share of the compaction mark, so it is ready when the mark is reached. */
const DRAFT_AT = 0.75;
/** Most a turn waits at the window limit on a background summary before dropping that connection and compacting fresh. */
const DRAFT_WAIT_MS = () => Number(process.env.FAVILLA_DRAFT_WAIT_MS) || 30_000;

interface PendingInput extends ReturnedInput {
  at: number;
  carried?: true;
}

/** Effort a model supports that is closest to the wish, preferring the lower side. */
export function fitEffort(model: ModelInfo, wish: Effort | undefined): Effort {
  const want = wish ?? model.defaultEffort;
  if (!model.efforts.length) return want;
  if (model.efforts.includes(want)) return want;
  const order = EFFORT_ORDER;
  const wi = order.indexOf(want);
  const sorted = [...model.efforts].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const lower = sorted.filter((e) => order.indexOf(e) <= wi).pop();
  return lower ?? sorted[0];
}

export class Session {
  readonly id: string;
  meta: SessionMeta;
  messages: Message[] = [];
  activeStart = 0;
  todos: Todo[] = [];
  usage: SessionUsage;
  status: 'idle' | 'running' | 'compacting' | 'waiting' = 'idle';
  steps = 0;

  /** Keep the report and any later qualification about notes; both messages stay in the append-only history. */
  get answer(): string {
    const last = this.messages.findLast((m) => m.role === 'assistant' && !m.replay && m.parts.some((p) => p.type === 'text'));
    const report = last?.supplementTo ? this.messages.find((m) => m.id === last.supplementTo) ?? last : last;
    const text = (m: Message | undefined) => m?.parts.flatMap((p) => p.type === 'text' ? [p.text] : []).join('') ?? '';
    return report === last ? text(report) : [text(report), text(last)].filter(Boolean).join('\n\n');
  }

  readonly files = new FileTracker();
  readonly shell: ShellInfo;
  readonly checkpoints: Checkpoints;
  readonly jobs: JobManager;

  private model!: ModelInfo;
  private budget!: Budget;
  private system = '';
  private bindings: ToolBinding[] = [];
  private specs: ToolSpec[] = [];
  /** Held-back tools whose full instructions the session has had (load_tools, a direct call, or a request that needs them). */
  private loadedTools = new Set<string>();
  /** Web search for this session: the provider's own, Favilla's, or none. Fixed with the tools. */
  private search: 'hosted' | 'client' | 'off' = 'off';
  private listeners = new Set<(e: AgentEvent) => void>();
  private controller: AbortController | null = null;
  private compactionController: AbortController | null = null;
  private turn = '';
  private pending: PendingInput[] = [];
  /** Messages left unread when Favilla last stopped, for the front end to give back. */
  private unread: PendingInput[] = [];
  private callIds?: Set<string>;
  private ranTools = new WeakSet<ToolResultPart>();
  private notes: string[] = [];
  /** The session's own copy of its preset; only the main agent of a session has one. */
  private preset: ActivePreset | null = null;
  private presetTokens = 0;
  private prefillRefused = false;
  private systemRefused = false;
  /** The provider's hosted search refused the blocked-domains filter once: it is sent without it. */
  private searchFilterRefused = false;
  private permissionWaits = new Map<string, Deferred<PermissionDecision>>();
  private questionWaits = new Map<string, Deferred<Record<string, string> | null>>();
  private planWaits = new Map<string, Deferred<{ approved: boolean; feedback?: string }>>();
  private open = { permissions: new Map<string, PermissionRequest>(), questions: new Map<string, QuestionRequest>(), plans: new Map<string, { id: string; plan: string }>() };
  private sessionAllows = new Set<string>();
  private scratchDatabases = new Set<string>();
  /** Said to the user when the first turn starts (nobody is listening before). */
  private startNotes: string[] = [];
  private children = new Set<Session>();
  /** Each live sub-agent's call, and the card its steps belong to if that is a different call. */
  private childCalls = new Map<Session, { callId: string; cardCallId?: string }>();
  /** Sub-agents running in the background, by the call that started them. */
  private background = new Map<string, { description: string; child: Session; started: number; wakes: boolean }>();
  /** Tools' own work in the background (ctx.inBackground), by its call. */
  private tasks = new Map<string, { tool: string; description: string; started: number; controller: AbortController; display?: ToolDisplay }>();
  /**
   * Their reports, waiting for the next step, the user's next message, or a turn of their own once the last one is
   * in. `wakes` is false for what the user stopped, and for every report that was waiting when they stopped the
   * session: none of those starts a turn on its own.
   */
  private backgroundDone: { callId: string; description: string; text: string; stopped: boolean; wakes: boolean; job?: string; tool?: string }[] = [];
  /** Calls whose sub-agents the user stopped: their reports say so. */
  private stoppedCalls = new Set<string>();
  /** Commands seen by a stop still report when they exit, without waking the session. */
  private jobsAtStop = new WeakSet<BackgroundJob>();
  /** Tool calls under way, for a front end that opens the session mid-turn. */
  private runningTools = new Map<string, { callId: string; name: string; title: string; input: unknown; started: number; display?: ToolDisplay }>();
  /** When the turn under way began; null between turns. */
  private turnStartedAt: number | null = null;
  /** The folder's snapshot as this turn found it, being taken; then, after the turn, the one as it left it. */
  private pointTaken: Promise<void> | null = null;
  private pointEnd: Promise<unknown> = Promise.resolve();
  private calibrator = new Calibrator();
  private anchorTokens = 0;
  private sinceAnchor = 0;
  private callHistory: string[] = [];
  private editFailures = new Map<string, number>();
  private browserSession: BrowserSession | null = null;
  private browserUsedAt = 0;
  private browserIdle?: NodeJS.Timeout;
  /** The browser settings the browser session started with. */
  private browserMode = '';
  private desktopSession: DesktopSession | null = null;
  private lsp: LanguageServers | null = null;
  /** Tool rounds since the user last wrote, for the reminder of the goal on long runs. */
  private roundsSinceUser = 0;
  private goalAsked = false;
  /** Replies of this turn that only kept track of the work and were told so. */
  private trackedAlone = 0;
  /** This turn's plan went to the user: what comes after it is no plan to show again. */
  private planPresented = false;
  /** Files changed earlier in this reply, whose type errors are read after its last change. */
  private changedInReply: string[] = [];
  /** The note that a passing run may be the end of the work: once a turn. */
  /** The finish notes of this turn: how many, and the list of changed files the last one carried. */
  private finishNotes = 0;
  private finishNoteList = '';
  private docStyleChecks = new Map<string, number>();
  /**
   * The latest request's shadow tests: written by another model in a copy while the work goes on. `done` once the
   * tester is; `deferred` when the turn ended before it was, so they run when it is and a failure wakes the session;
   * `placed`, the test files put in the working tree when one failed, taken out when the turn that read them ends.
   */
  private shadowRun: ShadowRun | null = null;
  /** Stopped shadow runs may still be removing their test files after shadowRun is cleared. */
  private shadowWork = new Set<Promise<void>>();
  /** The design guide was added to a message (the system prompt lacked it). */
  private designNoted = false;
  private engineeringNoted = false;
  private documentsNoted = false;
  private writingDocsNoted = false;
  /** The folder's facts as gathered when the session started (env.ts projectFacts), for its first message. */
  private facts?: string;
  private factsJob?: Promise<string>;
  /** The notes extensions send once a session that have been sent (MessageFacts.once). */
  private noted = new Set<string>();
  /** The paint tool has run in this session; and the note that a film was drawn in code was given. */
  private painted = false;
  private codeFilmNoted = false;
  /** The bar and the request a fresh reviewer needs, with the number of reviews this brief has had. */
  private brief: { request: string; text: string; reviews: number } | null = null;
  /** The user's message while the turn gets it ready, before it is in the conversation (see the preparing event). */
  private preparing: { text: string; images: number } | null = null;
  /** A compaction asked for by hand while a turn ran: done at the turn's next step, or right after it. */
  private compactAsked: Deferred<boolean> | null = null;
  /**
   * The summary written in the background ahead of the compaction mark: what it covers (messages before `upTo`,
   * from the context that started at `activeStart`) and its text once written (null if it failed). See maybeDraft.
   */
  private draft: {
    upTo: number;
    activeStart: number;
    startedAt: number;
    controller: AbortController;
    body: string | null | undefined;
    done: Promise<void>;
  } | null = null;
  /** Sub-agents the agent started through its agent tool this turn. */
  private turnAgents = 0;
  private compactedAt = 0;
  /** Context size right after the last light compaction, and the main requests made by then. */
  private prunedAt = 0;
  private prunedRequests = 0;
  /** Requests of the session's own conversation, side calls and sub-agents left out. */
  private mainRequests = 0;
  private running: Promise<void> | null = null;
  /** How the last turn ended: a sub-agent stopped as it finished on its own still counts as finished. */
  private lastEnd: TurnEndReason | null = null;
  /** A name made from a first message that said little ("fix it"): the end of that turn may add the file it changed. */
  private vagueTitle: { title: string; turn: string } | null = null;
  /** A model the user picked while a turn ran: it takes over as soon as the session stops, the turn done or stopped. */
  private heldModel: string | null = null;
  /** Why the last turn ended in an error: a sub-agent's turn catches it, so its caller hears it from here. */
  private lastError: string | null = null;
  private disposed = false;
  private interactive: boolean;
  private readonly cacheGroup?: string;
  private readonly autonomous: boolean;
  private readonly role: 'main' | 'explore' | 'general';
  private readonly parent?: Session;
  /** Files the running sub-agents hold, shared by a session and its sub-agents. */
  private readonly claims: Claims;
  private readonly claim?: string[] | null;
  /** Stable per-session registry of every image (`img-01`, `img-02`, …) and its `BlobStore` snapshot. */
  private readonly imageRegistry = new Map<string, SessionImageSnapshot>();
  /** Message index at which each `img-NN` was most recently reopened via `read` / `recall`. */
  private readonly imageReopenedAt = new Map<string, number>();
  private nextImageNum = 1;

  private constructor(
    private readonly deps: SessionDeps,
    meta: SessionMeta,
    opts: StartOptions,
  ) {
    this.id = meta.id;
    this.meta = meta;
    this.interactive = !!opts.interactive;
    this.autonomous = !!opts.autonomous;
    this.role = opts.role ?? 'main';
    this.parent = opts.parent;
    this.claims = opts.parent ? opts.parent.claims : new Claims(meta.cwd);
    this.claim = opts.claim;
    this.cacheGroup = opts.cacheGroup;
    this.shell = detectShell(deps.config.shell);
    ripgrepPath();
    const dataDir = deps.store.dataDir(meta);
    const keep = deps.config.checkpoints ?? DEFAULTS.checkpoints;
    // A session of the user's own also snapshots its folder, so what commands change can be undone too; sub-agents
    // work inside their parent's turns, and attempts in worktrees of their own.
    const shadow = !opts.parent && keep && deps.config.folderSnapshots !== false && process.env.FAVILLA_FOLDER_SNAPSHOTS !== '0' ? new Shadow(meta.cwd, appPath('projects', projectSlug(meta.cwd), 'shadow.git')) : null;
    this.checkpoints = opts.parent && !opts.isolated ? opts.parent.checkpoints : new Checkpoints(path.join(dataDir, 'checkpoints'), deps.store.blobs, keep, shadow);
    this.jobs = new JobManager(this.shell, path.join(dataDir, 'jobs'));
    this.jobs.onEnd((job) => this.jobEnded(job));
    this.usage = { contextTokens: 0, contextWindow: 0, compactAt: 0, totalInput: 0, totalOutput: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
  }

  private get config(): FavillaConfig {
    return this.deps.config;
  }

  private get dataDir(): string {
    return this.deps.store.dataDir(this.meta);
  }

  static async start(deps: SessionDeps, opts: StartOptions): Promise<Session> {
    await loadExtensions();
    const model = deps.catalog.resolve(opts.model);
    const now = Date.now();
    const meta: SessionMeta = {
      id: newId('s'),
      title: opts.title ?? '',
      cwd: path.resolve(opts.cwd),
      created: now,
      updated: now,
      provider: model.provider,
      model: model.id,
      effort: fitEffort(model, opts.effort ?? deps.config.effort),
      mode: opts.mode ?? 'build',
      profile: model.toolProfile,
      parentId: opts.parent?.id,
      agent: opts.role && opts.role !== 'main' ? opts.role : undefined,
    };
    const s = new Session(deps, meta, opts);
    if ((opts.role ?? 'main') === 'main' && !opts.parent) {
      s.usePreset(opts.preset !== undefined ? opts.preset : activePreset(meta.cwd));
      s.usePersona(activePersona(meta.cwd));
    }
    // Gather the same facts at creation, while the system prompt is built. A new window can use the session
    // before Git answers; the first turn joins this same job when it needs its note.
    const modelReady = s.applyModel(model, true);
    const factsReady = s.gatherFacts();
    if (opts.deferProjectFacts) {
      // A window may never send the first message that would join this job.
      void factsReady.catch(() => {});
      await modelReady.catch(async (error) => {
        await factsReady.catch(() => {});
        throw error;
      });
    } else await Promise.all([modelReady, factsReady]);
    deps.store.locks.take(s.id);
    try {
      deps.store.create(s.meta, s.system);
      if (s.preset) deps.store.savePreset(s.meta, s.preset);
    } catch (e) {
      deps.store.locks.release(s.id);
      throw e;
    }
    const ignored = opts.parent ? [] : ignoredProjectKeys(meta.cwd);
    if (ignored.length) s.startNotes.push(`This project's .favilla/config.json sets ${ignored.join(', ')}: Favilla takes those only from your own ~/.favilla/config.json, so a repository cannot move your keys, run programs or turn approvals off.`);
    return s;
  }

  /**
   * A new session that continues from another's history up to a message: `before` stops just ahead of it (to send
   * it again, changed), `after` takes it and the rest of its turn. The history is read from the source's file, so
   * both sessions stay append-only and the source is untouched; files on disk are left as they are.
   */
  static async fork(deps: SessionDeps, src: Session, messageId: string, where: 'before' | 'after', opts: Omit<StartOptions, 'cwd'> = {}): Promise<Session> {
    const at = src.messages.findIndex((m) => m.id === messageId);
    if (at < 0) throw new Error('That message is not in this session.');
    let end = where === 'before' ? at : at + 1;
    if (where === 'after') while (end < src.messages.length && !(src.messages[end].role === 'user' && src.messages[end].origin === 'user')) end++;
    // A branch is opened where its source was, by the same person: it asks them questions and plans as the source did
    // (the runtime's defaults made every branch think nobody was there, so its questions went unasked).
    const s = await Session.start(deps, { ...opts, cwd: src.meta.cwd, model: `${src.meta.provider}/${src.meta.model}`, effort: src.meta.effort, mode: src.meta.mode, title: src.meta.title, preset: src.preset, interactive: src.interactive, autonomous: src.autonomous, deferProjectFacts: false });
    // The history up to the branch point stays in the source's file, which keeps its messages in order: the branch's
    // file names them in one line instead of holding every one again (37 branches took 16 MB, a fifth of all sessions
    // on disk, 2026-11-05), and a long session branches at once. A branch point inside what the source reads from its
    // own source is read from there, so a message sent again and again in place does not pile up files to read.
    let base = { id: src.id, messages: end };
    for (let up = src.meta.base; up && end <= up.messages; up = deps.store.metaOf(up.id)?.base) base = { id: up.id, messages: end };
    const copies = src.messages.slice(0, end).map((m) => structuredClone(m));
    const branchOf = { id: src.id, title: src.meta.title, message: messageId };
    // Past eight files to read through, the history is written into this file again and the chain starts over.
    const chained = end > 0 && deps.store.baseDepth(base.id) < 8;
    if (chained) deps.store.saveBase(s.meta, base);
    else for (const m of copies) deps.store.saveMessage(s.meta, m);
    s.meta = { ...s.meta, ...(chained ? { base } : {}), branchOf };
    deps.store.saveMeta(s.meta);
    s.messages.push(...copies);
    // The turns it keeps can still be undone here: sent again in place, the source goes, and its restore points went
    // with it.
    s.checkpoints.adopt(src.checkpoints, new Set(copies.flatMap((m) => (m.turn ? [m.turn] : []))));
    copies.forEach((m, i) => {
      if (m.origin === 'compaction') s.activeStart = i;
    });
    // The compaction and the outputs cut short among the messages read are written here, as the branch has them now:
    // what the source does later is its own.
    if (s.activeStart) deps.store.saveCompaction(s.meta, s.activeStart);
    if (chained) deps.store.savePrune(s.meta, copies.flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool_result' && p.pruned && p.contentBlob ? [{ callId: p.callId, stub: p.content, blob: p.contentBlob }] : []))));
    // A goal set before the branch point still describes the work; one set later belongs to the other branch.
    timedSync('reads restored', () => s.restoreEvidence());
    const cutTime = src.messages[end - 1]?.time ?? 0;
    if (src.meta.goal && src.meta.goal.updated <= cutTime) {
      const goal = structuredClone(src.meta.goal);
      if (goal.by === 'brief') goal.by = 'model';
      s.setGoal(goal);
    }
    s.anchorTokens = s.estimatePrefix() + s.active().reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0);
    s.sinceAnchor = 0;
    s.refreshUsage();
    return s;
  }

  /** The turn after the one `messageId` belongs to, if there is one: where a branch after that message diverges. */
  turnAfter(messageId: string): string | undefined {
    const at = this.messages.findIndex((m) => m.id === messageId);
    const own = this.messages[at]?.turn;
    return this.messages.slice(at + 1).find((m) => m.turn && m.turn !== own)?.turn;
  }

  /** Stop the turn and background agent work, and wait for their cleanup. Shell jobs can keep running. */
  async stop(): Promise<void> {
    const draft = this.draft;
    const shadows = [...this.shadowWork];
    this.abort();
    await Promise.allSettled([this.running, draft?.done, ...shadows]);
    await this.settled();
  }

  static async open(deps: SessionDeps, id: string, opts: Omit<StartOptions, 'cwd'> = {}): Promise<Session> {
    await loadExtensions();
    // Read letting the thread go: a long session took the desktop engine half a second, and others wait meanwhile.
    const rec = await deps.store.loadAsync(id);
    if (!rec) throw new Error(`Session ${id} not found`);
    const s = new Session(deps, rec.meta, { ...opts, cwd: rec.meta.cwd });
    s.releaseBriefGoal();
    s.messages = rec.messages;
    s.restoreImages();
    timedSync('reads restored', () => s.restoreEvidence());
    s.activeStart = Math.min(rec.activeStart, rec.messages.length);
    s.todos = rec.todos;
    if (rec.usage) s.usage = rec.usage;
    s.usePreset(rec.preset ?? null);
    let model: ModelInfo;
    try {
      model = deps.catalog.resolve(opts.model ?? `${rec.meta.provider}/${rec.meta.model}`);
    } catch {
      model = deps.catalog.resolve(opts.model);
    }
    s.model = model;
    s.system = rec.system;
    s.rebuildTools();
    s.budget = computeBudget(model, deps.config);
    const sameModel = Boolean(rec.system && model.provider === rec.meta.provider && model.id === rec.meta.model);
    if (!s.system || !sameModel) await s.applyModel(model, false);
    const rawActive = s.estimatePrefix() + s.active().reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0);
    if (sameModel && rec.usage && rec.usage.requests > 0 && rec.usage.contextTokens > 0 && rec.usage.contextTokens <= s.budget.window * 2) {
      s.calibrator.observe(rawActive, rec.usage.contextTokens);
      s.calibrator.observe(rawActive, rec.usage.contextTokens);
      s.anchorTokens = rec.usage.contextTokens;
    } else {
      s.anchorTokens = rawActive;
    }
    // A history that ends in calls with no results (Favilla was closed or crashed while a tool ran) gets them now, at
    // its end, so it is whole again.
    const last = s.messages.at(-1);
    const unanswered = last?.role === 'assistant' ? last.parts.filter((p): p is ToolCallPart => p.type === 'tool_call') : [];
    if (unanswered.length) s.push({ ...s.resultsMessage(unanswered.map((c) => s.cancelled(c, UNANSWERED)), []), turn: last!.turn });
    s.refreshUsage();
    // Messages that were waiting when Favilla stopped: nobody read them, so they go back to whoever opens it.
    s.unread = (rec.meta.queued ?? []).map((q, i) => ({
      id: q.id ?? `${id}:queued:${q.at}:${i}`,
      at: q.at,
      text: q.text,
      images: (q.images ?? []).flatMap((img) => {
        const data = deps.store.blobs.get(img.blob);
        return data
          ? [
              {
                type: 'image' as const,
                ...(img.id ? { id: img.id } : {}),
                mediaType: img.mediaType,
                data: data.toString('base64'),
                blob: img.blob,
                ...(img.name ? { name: img.name } : {}),
                ...(img.width && img.height ? { width: img.width, height: img.height } : {}),
                ...(img.sourcePath ? { sourcePath: img.sourcePath } : {}),
                ...(img.sourceSha256 ? { sourceSha256: img.sourceSha256 } : {}),
              },
            ]
          : [];
      }),
    }));
    // Work that was going on in the background when Favilla stopped is gone: its card says so, and the agent hears how
    // to go on with it, in the tool's words, with the next message.
    const cut = (s.meta.tasks ?? []).filter((t) => t.state === 'running');
    if (cut.length) {
      s.meta = { ...s.meta, tasks: s.meta.tasks!.map((t) => (t.state === 'running' ? { ...t, state: 'interrupted' as const } : t)) };
      deps.store.saveMeta(s.meta);
      if (s.role === 'main') s.notes.push(cut.map((t) => `The ${t.tool} call "${t.description}" was cut off in the background when Favilla stopped.${t.resume ? ` ${t.resume}` : ''}`).join('\n'));
    }
    return s;
  }

  private restoreEvidence(): void {
    const stale = restoreReads(this.files, this.messages);
    if (stale.length) this.notes.push(`Stored reads are stale: ${stale.slice(-12).map((p) => displayPath(this.meta.cwd, p)).join(', ')}. Read the current source before relying on those lines.`);
    const runs = evidenceSummary(this.messages, this.meta.cwd, true);
    if (runs) this.notes.push(runs);
  }

  /** Deterministically rebuild the session's `ImageRegistry` from saved non-replay messages on reload. */
  private restoreImages(): void {
    this.imageRegistry.clear();
    this.imageReopenedAt.clear();
    this.nextImageNum = 1;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.replay) continue;
      for (const p of m.parts) {
        const list: { img: ImagePart; origin: 'user' | 'tool'; toolName?: string; callId?: string }[] =
          p.type === 'image'
            ? [{ img: p, origin: 'user' }]
            : p.type === 'tool_result'
              ? (p.images ?? []).map((img) => ({ img, origin: 'tool' as const, toolName: p.name, callId: p.callId }))
              : [];
        for (const { img, origin, toolName, callId } of list) {
          if (img.id) {
            const parsed = /^img-(\d+)$/i.exec(img.id);
            if (parsed) this.nextImageNum = Math.max(this.nextImageNum, Number(parsed[1]) + 1);
          } else if (img.blob) {
            img.id = this.allocImageId();
          }
          if (!img.id || !img.blob) continue;
          const id = img.id.toLowerCase();
          if (this.imageRegistry.has(id)) {
            if (origin === 'tool') this.imageReopenedAt.set(id, i);
            const cur = this.imageRegistry.get(id)!;
            if (img.digest && !cur.digest) cur.digest = img.digest;
            continue;
          }
          let bytes: number | undefined;
          let width = img.width;
          let height = img.height;
          if (!width || !height) {
            const raw = this.deps.store.blobs.get(img.blob);
            if (raw) {
              bytes = raw.length;
              const sz = imageSize(raw);
              if (sz) {
                width = sz.width;
                height = sz.height;
                img.width = width;
                img.height = height;
              }
            }
          }
          this.imageRegistry.set(id, {
            id,
            blob: img.blob,
            mediaType: img.mediaType,
            name: img.name,
            width,
            height,
            bytes,
            origin,
            toolName,
            callId,
            sourcePath: img.sourcePath,
            sourceSha256: img.sourceSha256,
            digest: img.digest,
            virtualPath: virtualImagePath(id, img.mediaType),
          });
        }
      }
    }
  }

  private allocImageId(): string {
    return `img-${String(this.nextImageNum++).padStart(2, '0')}`;
  }

  private readImageCallHint(virtualPath: string, withRegionHint = false): string {
    return formatReadImageCall(this.specs.map((s) => s.name), virtualPath, withRegionHint);
  }

  private lookupSessionImage(id: string, markReopened = false): SessionImageSnapshot | null {
    const key = id.toLowerCase();
    const hit = this.imageRegistry.get(key) ?? this.parent?.lookupSessionImage(key, false) ?? null;
    if (hit && markReopened) this.imageReopenedAt.set(hit.id, this.messages.length);
    return hit;
  }

  private allSessionImages(): SessionImageSnapshot[] {
    const merged = new Map<string, SessionImageSnapshot>();
    if (this.parent) {
      for (const s of this.parent.allSessionImages()) merged.set(s.id, s);
    }
    for (const [k, v] of this.imageRegistry) merged.set(k, v);
    return [...merged.values()];
  }

  /** Normalize, store in `BlobStore`, assign `img-NN`, and prepend a synthetic 1-line reopen header for user images. */
  private async registerUserImages(imgs: ImagePart[]): Promise<Part[]> {
    if (!imgs.length) return [];
    const normalized: ImagePart[] = [];
    const labels: string[] = [];
    for (const rawImg of imgs) {
      const img = await normalizeImagePart(rawImg);
      const rawBytes = img.data ? Buffer.from(img.data, 'base64') : null;
      if (rawBytes && !img.blob) img.blob = this.deps.store.blobs.put(rawBytes, false);
      const id = (img.id ?? this.allocImageId()).toLowerCase();
      img.id = id;
      const vpath = virtualImagePath(id, img.mediaType);
      if (img.blob) {
        this.imageRegistry.set(id, {
          id,
          blob: img.blob,
          mediaType: img.mediaType,
          name: img.name,
          width: img.width,
          height: img.height,
          bytes: rawBytes?.length,
          origin: 'user',
          sourcePath: img.sourcePath,
          sourceSha256: img.sourceSha256,
          digest: img.digest,
          virtualPath: vpath,
        });
      }
      const dims = img.width && img.height ? `${img.width}×${img.height}` : img.mediaType;
      labels.push(`[${id}${img.name ? ` "${img.name}"` : ''} (${dims}) | reopen: ${this.readImageCallHint(vpath, imgs.length === 1)}]`);
      normalized.push(img);
    }
    const readName = this.toolName('read');
    const zoomHint = normalized.length > 1 ? '; pass region=[x,y,w,h] to zoom' : '';
    return [
      {
        type: 'text',
        text: `Attached session image${normalized.length === 1 ? '' : 's'} (virtual path${normalized.length === 1 ? '' : 's'} — ${readName} tool only, not on disk or in shell${zoomHint}): ${labels.join('; ')}`,
        synthetic: true,
      },
      ...normalized,
    ];
  }

  /** Normalize, store in `BlobStore`, and register tool-produced images (preserving `img-NN` when reopening a snapshot). */
  private async registerToolImages(call: ToolCallPart, imgs: ImagePart[]): Promise<string> {
    const entries: { id: string; vpath: string }[] = [];
    for (let i = 0; i < imgs.length; i++) {
      const norm = await normalizeImagePart(imgs[i]);
      const rawBytes = norm.data ? Buffer.from(norm.data, 'base64') : null;
      if (rawBytes && !norm.blob) norm.blob = this.deps.store.blobs.put(rawBytes, false);
      const existingId = norm.id?.toLowerCase();
      if (existingId && this.lookupSessionImage(existingId, false)) {
        norm.id = existingId;
        this.imageReopenedAt.set(existingId, this.messages.length);
        imgs[i] = norm;
        continue;
      }
      const id = (existingId ?? this.allocImageId()).toLowerCase();
      norm.id = id;
      const vpath = virtualImagePath(id, norm.mediaType);
      if (norm.blob) {
        this.imageRegistry.set(id, {
          id,
          blob: norm.blob,
          mediaType: norm.mediaType,
          name: norm.name,
          width: norm.width,
          height: norm.height,
          bytes: rawBytes?.length,
          origin: 'tool',
          toolName: call.name,
          callId: call.id,
          sourcePath: norm.sourcePath,
          sourceSha256: norm.sourceSha256,
          digest: norm.digest,
          virtualPath: vpath,
        });
      }
      entries.push({ id, vpath });
      imgs[i] = norm;
    }
    if (!entries.length) return '';
    const readName = this.toolName('read');
    if (entries.length === 1) {
      const { id, vpath } = entries[0];
      return `[Session image ${id} — virtual path (${readName} tool only, not a file on disk or in shell): ${this.readImageCallHint(vpath, true)}]`;
    }
    const items = entries.map(({ id, vpath }) => `${id}: ${this.readImageCallHint(vpath, false)}`).join('; ');
    return `[Session images — virtual paths (${readName} tool only, not files on disk or in shell; pass region=[x,y,w,h] to zoom): ${items}]`;
  }

  /** Fit outbound messages to the provider's learned byte limit, image count cap, and Anthropic's >20-image 2000px rule. */
  private fitOutboundPictures(messages: Message[]): Message[] | Promise<Message[]> {
    const api = this.deps.catalog.provider(this.model.provider).api;
    const fitted = fitPictures(messages, pictureBudget(this.model.provider), {
      maxImages: providerMaxImages(api),
      readCallHint: (v) => this.readImageCallHint(v),
    });
    const needsAnthropicScale =
      api === 'anthropic' &&
      pictureCount(fitted) > 20 &&
      fitted.some((m) =>
        m.parts.some(
          (p) =>
            (p.type === 'image' && p.data && Math.max(p.width ?? 0, p.height ?? 0) > 2000) ||
            (p.type === 'tool_result' && p.images?.some((img) => img.data && Math.max(img.width ?? 0, img.height ?? 0) > 2000)),
        ),
      );
    if (!needsAnthropicScale) return fitted;
    return (async () => {
      const scaled: Message[] = [];
      for (const m of fitted) {
        let changed = false;
        const parts: Part[] = [];
        for (const p of m.parts) {
          if (p.type === 'image' && p.data && Math.max(p.width ?? 0, p.height ?? 0) > 2000) {
            parts.push(await normalizeImagePart(p, { maxSide: 2000 }));
            changed = true;
          } else if (p.type === 'tool_result' && p.images?.some((img) => img.data && Math.max(img.width ?? 0, img.height ?? 0) > 2000)) {
            const imgs: ImagePart[] = [];
            for (const img of p.images) {
              imgs.push(img.data && Math.max(img.width ?? 0, img.height ?? 0) > 2000 ? await normalizeImagePart(img, { maxSide: 2000 }) : img);
            }
            parts.push({ ...p, images: imgs });
            changed = true;
          } else {
            parts.push(p);
          }
        }
        scaled.push(changed ? { ...m, parts } : m);
      }
      return scaled;
    })();
  }

  /**
   * Before mid-epoch eviction removes raw pixels of overflowing images that have not been summarized yet, capture a
   * concise structured text digest in one toolless vision call so no image ever leaves context unrecorded.
   */
  private async extractImageFacts(evicting: ImagePart[], signal?: AbortSignal): Promise<void> {
    if (!this.model.vision || !evicting.length) return;
    const real = evicting.filter((img) => img.data && img.id && !img.digest && imageSize(Buffer.from(img.data, 'base64')));
    if (!real.length) return;
    try {
      const parts: Part[] = [
        {
          type: 'text',
          text: 'Record concise factual notes for each image below so its details remain searchable after raw pixels leave context. Output one line per image starting with `[img-NN]` containing visible text, identifiers/codes, exact numbers/units, hex/RGB colors, chart/table readings, and UI errors.',
          synthetic: true,
        },
      ];
      for (const img of real) {
        parts.push({ type: 'text', text: `[${img.id}${img.name ? ` "${img.name}"` : ''}]`, synthetic: true }, img);
      }
      const askMsg: Message = { id: newId('m'), role: 'user', parts, time: Date.now() };
      const linked = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      const call = this.providerCall([askMsg], linked, {
        maxOutputTokens: 1024,
        turnStart: 0,
        toolChoice: 'none',
        system: 'You transcribe exact visual facts (text, IDs, numbers, colors, UI state) concisely, one `[img-NN]` line per image.',
        tools: [],
        hostedSearch: false,
      });
      const res = await adapterFor(call.provider.api).stream({ ...call, signal: linked }, () => {});
      this.recordUsage(res.usage, 0);
      const text = res.parts.filter((p): p is TextPart => p.type === 'text').map((p) => p.text).join('\n').trim();
      if (!text) return;
      for (const img of real) {
        const id = img.id!;
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = new RegExp(`^\\s*(?:[-*]\\s*)?\\[?${escaped}\\]?\\s*[:\\-—]?\\s*(.+)$`, 'im').exec(text);
        const digest = oneLine(m ? m[1] : (real.length === 1 ? text : ''), 420);
        if (digest) {
          img.digest = digest;
          const reg = this.imageRegistry.get(id.toLowerCase());
          if (reg) reg.digest = digest;
        }
      }
    } catch (e) {
      debug('compaction', 'pre-eviction image digest skipped', String(e));
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  on(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(body: AgentEventBody): void {
    const e = { ...body, sessionId: this.id } as AgentEvent;
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        debug('session', 'listener failed', String(err));
      }
    }
  }

  /** What the status is doing, when it says more than its name (checking, retrying, thinking out of sight). */
  private statusDetail: string | undefined;

  private setStatus(status: Session['status'], detail?: string): void {
    this.status = status;
    this.statusDetail = detail;
    this.emit({ type: 'status', status, detail });
  }

  // ── model, tools, prompt ──────────────────────────────────────────────────

  private streamDraft: { messageId: string; parts: Map<number, StreamDraft['parts'][number]> } | null = null;

  /** What is under way, for a front end that opens the session mid-turn: after a reload, or coming back to it. */
  liveState(): { draft: StreamDraft | null; turnStarted: number | null; preparing: { text: string; images: number } | null; running: { callId: string; name: string; title: string; input: unknown; started: number; display?: ToolDisplay }[]; children: { callId: string; sessionId: string; model: string; effort?: Effort; steps: SessionStep[] }[]; background: BackgroundRun[] } {
    return {
      draft: this.streamDraft && { messageId: this.streamDraft.messageId, parts: [...this.streamDraft.parts.values()] },
      turnStarted: this.turnStartedAt,
      preparing: this.preparing,
      running: [...this.runningTools.values()],
      children: [...this.childCalls].map(([c, { callId, cardCallId }]) => ({ callId: cardCallId ?? callId, sessionId: c.id, model: `${c.meta.provider}/${c.meta.model}`, effort: c.meta.effort, steps: c.stepsSoFar() })),
      background: this.backgroundRuns(),
    };
  }

  /** The sub-agents at work in the background, oldest first, then the tools' own work there. */
  backgroundRuns(): BackgroundRun[] {
    return [
      ...[...this.background].map(([callId, b]) => ({ callId, description: b.description, sessionId: b.child.id, started: b.started })),
      ...[...this.tasks].map(([callId, t]) => ({ callId, description: t.description, sessionId: '', started: t.started, tool: t.tool, ...(t.display ? { display: t.display } : {}) })),
    ];
  }

  private emitBackground(): void {
    this.emit({ type: 'background', running: this.backgroundRuns() });
  }

  /** Every call this session made, when it ran and whether it failed: a sub-agent's progress for a front end that comes back mid-run. */
  stepsSoFar(): SessionStep[] {
    const ends = new Map<string, { at: number; failed: boolean }>();
    for (const m of this.messages)
      for (const p of m.parts) if (p.type === 'tool_result') ends.set(p.callId, { at: m.time, failed: !!p.isError || (p.display?.kind === 'terminal' && !!p.display.exitCode) });
    const steps: SessionStep[] = [];
    for (const m of this.messages)
      for (const p of m.parts) {
        if (p.type !== 'tool_call') continue;
        const end = ends.get(p.id);
        steps.push({ id: p.id, name: p.name, input: p.input ?? {}, started: m.time, ...(end ? { ended: end.at, failed: end.failed } : {}) });
      }
    return steps.slice(-200);
  }

  /** A sub-agent of this session (at any depth) that is still running, by id. */
  descendant(id: string): Session | undefined {
    for (const c of this.children) {
      if (c.id === id) return c;
      const deeper = c.descendant(id);
      if (deeper) return deeper;
    }
    return undefined;
  }

  get modelInfo(): ModelInfo {
    return this.model;
  }

  get toolSpecs(): ToolSpec[] {
    return this.specs;
  }

  get systemPrompt(): string {
    return this.system;
  }

  private searchMode(model: ModelInfo): 'hosted' | 'client' | 'off' {
    const choice = this.config.webSearch;
    if (choice === false) return 'off';
    if (choice === 'builtin') return 'client';
    const api = this.deps.catalog.provider(model.provider).api;
    // OpenAI's Responses API always offers web_search; Anthropic's needs an organisation setting, so it is opt-in.
    if (api === 'openai-responses' || (choice === 'provider' && api === 'anthropic')) return 'hosted';
    return 'client';
  }

  private rebuildTools(): void {
    this.search = this.searchMode(this.model);
    this.bindings = buildTools(this.model.toolProfile, {
      shell: this.shell,
      cwd: this.meta.cwd,
      timeoutMs: this.config.bashTimeoutMs ?? DEFAULTS.bashTimeoutMs,
      vision: this.model.vision,
      role: this.role,
      search: this.search,
      screenshot: !!findBrowser(this.config.browserPath),
      git: inGitRepo(this.meta.cwd),
      code: isCodeProject(this.meta.cwd),
      notebooks: hasNotebooks(this.meta.cwd),
      computer: this.computerOn,
      mail: this.role === 'main' ? mailAccounts(this.config).map((a) => a.address) : undefined,
    });
    // MCP tools of the servers ready now; research sub-agents get only the ones that declare they only read.
    if (this.deps.mcp) this.bindings.push(...this.deps.mcp.bindings(this.role === 'explore'));
    if (this.defersTools()) this.bindings.push(loadToolsBinding());
    this.specs = this.visibleSpecs();
  }

  /** The main session lists rarely used tools in short until it loads them (FAVILLA_DEFER_TOOLS=0 sends them whole). */
  private defersTools(): boolean {
    return this.role === 'main' && process.env.FAVILLA_DEFER_TOOLS !== '0';
  }

  /** The tools every request of the session carries, the held-back ones in short. Loading one never changes them. */
  private visibleSpecs(): ToolSpec[] {
    const defer = this.defersTools();
    return this.bindings.map((b) => (defer && deferred(b.spec.name) ? stubSpec(b.spec) : b.spec));
  }

  /** Tools' whole definitions, as load_tools gives them: what each does and its parameters, described. */
  private toolInstructions(names: string[]): string {
    return names
      .map((n) => this.binding(n)?.spec)
      .filter((s): s is ToolSpec => !!s)
      .map((s) => `## ${s.name}\n${s.description}\nParameters (JSON schema): ${JSON.stringify(s.parameters)}`)
      .join('\n\n');
  }

  /** Held-back tools' full instructions, to go at the end of the conversation; the tool list stays as it is. */
  private loadTools(names: string[]): { loaded: string[]; unknown: string[]; text: string } {
    const loaded: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      const b = this.binding(name);
      if (!b) unknown.push(name);
      else {
        this.loadedTools.add(b.spec.name);
        loaded.push(b.spec.name);
      }
    }
    return { loaded, unknown, text: this.toolInstructions(loaded) };
  }

  /** How documents, sheets and data are made, once, for a session whose system prompt does not carry it (a folder of code). */
  private noteDocuments(): void {
    if (this.documentsNoted || this.system.includes('# Documents, data and pictures')) return;
    this.documentsNoted = true;
    this.notes.push(promptAsset('documents'));
  }

  /** How standalone prose documents and reports are written, once, when not already in the system prompt. */
  private noteWritingDocs(): void {
    if (this.writingDocsNoted || this.system.includes('# Standalone documents and reports')) return;
    this.writingDocsNoted = true;
    this.notes.push(promptAsset('writing-docs'));
  }

  /**
   * The folder's facts are where the model reads them: in a note or summary of the active history, or in the system
   * prompt of a session begun before they moved out of it.
   */
  private factsShown(): boolean {
    if (this.system.includes(`\n${FACTS_START}`)) return true;
    return this.active().some((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.synthetic && factsIn(p.text) !== undefined));
  }

  private async gatherFacts(): Promise<string> {
    return (this.factsJob ??= projectFacts({ cwd: this.meta.cwd, scratch: this.role === 'main' ? scratchDir(this.meta.cwd) : undefined })
      .then((facts) => (this.facts = facts), (error) => {
        this.factsJob = undefined;
        throw error;
      }));
  }

  /** A server closing its windows also waits for any facts jobs it started. */
  get projectFactsReady(): Promise<string> | undefined {
    return this.factsJob;
  }

  /** The folder's facts as the history gave them, else as gathered at the start, else as the folder is now. */
  private async folderFacts(): Promise<string> {
    return this.givenFacts() ?? this.gatherFacts();
  }

  /** The facts the history gave, read back for a session opened again. */
  private givenFacts(): string | undefined {
    for (const m of this.messages) {
      for (const p of m.parts) {
        const facts = p.type === 'text' && p.synthetic ? factsIn(p.text) : undefined;
        if (facts !== undefined) return facts;
      }
    }
    return undefined;
  }

  /** The held-back tools, each with its brief, for the system prompt. */
  private deferredList(): { name: string; line: string }[] {
    if (!this.defersTools()) return [];
    return this.bindings.filter((b) => deferred(b.spec.name)).map((b) => ({ name: b.spec.name, line: briefOf(b.spec) }));
  }

  private async applyModel(model: ModelInfo, fresh: boolean): Promise<void> {
    this.model = model;
    this.budget = computeBudget(model, this.config);
    this.rebuildTools();
    const skills = this.config.skills === false ? [] : discoverSkills(this.meta.cwd, Array.isArray(this.config.skills) ? this.config.skills : []);
    this.system = await buildSystemPrompt({
      cwd: this.meta.cwd,
      model,
      shell: this.shell,
      config: this.config,
      role: this.role,
      autonomous: this.autonomous,
      search: this.search,
      screenshot: this.bindings.some((b) => b.spec.name === 'browser'),
      deferred: this.deferredList(),
      tools: this.bindings.map((b) => b.spec.name),
      skills,
      persona: this.meta.persona,
      preset: this.preset ? { name: this.preset.preset.name, text: presetSystem(this.preset.preset, macroContext(this.preset.preset, this.id, Date.now(), model.id, this.messages)) } : undefined,
    });
    this.meta = { ...this.meta, provider: model.provider, model: model.id, profile: model.toolProfile, effort: fitEffort(model, this.meta.effort) };
    if (!fresh) {
      this.deps.store.saveSystem(this.meta, this.system);
      this.deps.store.saveMeta(this.meta);
    }
    this.anchorTokens = this.estimatePrefix() + this.active().reduce((n, m) => n + estimateMessageTokens(m), 0);
    this.sinceAnchor = 0;
    this.refreshUsage();
  }

  /** The model picked while a turn runs, waiting for the session to stop; null when none waits. */
  get held(): string | null {
    return this.heldModel;
  }

  /**
   * Switch models. A different tool family first compacts the history so no stale tool calls are replayed. Picked
   * while the session works, the model waits ('held') and takes over once it stops, finished or stopped by the user,
   * before any message sent meanwhile runs: the pick had been refused with "wait", and remembered nowhere.
   */
  async setModel(ref: string): Promise<'switched' | 'held' | 'same'> {
    const next = this.deps.catalog.resolve(ref);
    if (this.running || this.status !== 'idle') {
      this.holdModel(next.ref === this.model.ref ? null : next.ref);
      return this.heldModel ? 'held' : 'same';
    }
    this.holdModel(null);
    if (next.ref === this.model.ref) return 'same';
    await this.switchModel(next, 'done');
    return 'switched';
  }

  private holdModel(ref: string | null): void {
    if (this.heldModel === ref) return;
    this.heldModel = ref;
    this.emit({ type: 'held', model: ref });
  }

  /** Put the model in; `reason` is how the turn before it ended, which decides what happens to messages sent meanwhile. */
  private switchModel(next: ModelInfo, reason: TurnEndReason): Promise<void> {
    this.dropDraft();
    // Held as a turn is: a message sent during the switch's compaction waits for the new model.
    const work = (async () => {
      if (next.toolProfile !== this.model.toolProfile && this.active().length > 1 && !(await this.compactNow('switch'))) {
        throw new Error('Cannot switch models because compaction did not finish.');
      }
      await this.applyModel(next, false);
      this.emit({ type: 'meta', meta: this.meta });
    })();
    this.running = work
      .then(
        () => reason,
        () => 'error' as const,
      )
      .finally(() => {
        this.running = null;
      })
      .then((ended) => this.switchHeld(ended) ?? this.carryOver(ended) ?? this.wake());
    return work;
  }

  /** The model picked while the session worked, put in before anything that waits; undefined when none was picked. */
  private switchHeld(reason: TurnEndReason): Promise<void> | undefined {
    const ref = this.heldModel;
    if (!ref || this.disposed) return undefined;
    this.holdModel(null);
    let next: ModelInfo;
    try {
      next = this.deps.catalog.resolve(ref);
    } catch (e) {
      this.emit({ type: 'notice', level: 'error', text: (e as Error).message });
      return undefined;
    }
    if (next.ref === this.model.ref) return undefined;
    const work = this.switchModel(next, reason);
    work.catch((e) => this.emit({ type: 'notice', level: 'error', text: (e as Error).message }));
    return this.running ?? undefined;
  }

  /** Rebuild the system prompt from the instruction files and settings as they are now; the provider's cache starts over once. */
  async reloadRules(): Promise<void> {
    if (this.role === 'main' && !this.meta.parentId) {
      this.usePreset(activePreset(this.meta.cwd));
      this.usePersona(activePersona(this.meta.cwd));
      this.deps.store.savePreset(this.meta, this.preset);
    }
    await this.applyModel(this.model, false);
    this.notes.push('Your instructions were reloaded from the user\'s rule files; follow the updated ones from here on.');
  }

  /**
   * Settings changed: take the model's window and the compaction mark from them now. The system prompt and
   * tools stay as they are, so the provider's cache stays warm.
   */
  applySettings(): void {
    let fresh: ModelInfo | undefined;
    try {
      fresh = this.deps.catalog.resolve(this.model.ref);
    } catch {
      // The model left the catalog (provider removed): keep what the session has.
    }
    if (fresh) {
      const before = this.model;
      this.model = { ...this.model, contextWindow: fresh.contextWindow, nativeWindow: fresh.nativeWindow, windowAssumed: fresh.windowAssumed, efforts: fresh.efforts, defaultEffort: fresh.defaultEffort };
      if (before.contextWindow !== fresh.contextWindow || before.efforts.join() !== fresh.efforts.join()) this.emitModel();
      const effort = fitEffort(this.model, this.meta.effort);
      if (effort !== this.meta.effort) {
        this.meta = { ...this.meta, effort };
        this.deps.store.saveMeta(this.meta);
        this.emit({ type: 'meta', meta: this.meta });
      }
    }
    this.budget = computeBudget(this.model, this.config);
    this.refreshUsage();
  }

  private emitModel(): void {
    const m = this.model;
    this.emit({ type: 'model', model: { ref: m.ref, efforts: m.efforts, defaultEffort: m.defaultEffort, contextWindow: m.contextWindow, nativeWindow: m.nativeWindow } });
  }

  /**
   * A server refused the thinking level it was sent. Keep what it takes for this model (for every later session
   * too), move this session to the nearest of those, and say so once.
   */
  private takeEffortRefusal(refusal: EffortRefusal, sent: Effort): void {
    // Switching thinking off goes through its own field on these servers, untouched by a refused level.
    const toggle = this.model.efforts.includes('off') && ['deepseek', 'glm', 'qwen', 'llamacpp'].includes(this.model.quirks.thinkingParam ?? '');
    const efforts: Effort[] =
      refusal.kind === 'levels'
        ? [...new Set<Effort>([...(toggle && sent !== 'off' ? (['off'] as Effort[]) : []), ...refusal.levels])]
        : refusal.kind === 'level'
          ? this.model.efforts.filter((e) => e !== sent)
          : toggle
            ? ['off', 'high']
            : [];
    this.deps.catalog.learnEfforts(this.model.ref, efforts);
    this.model = { ...this.model, efforts };
    this.emitModel();
    const effort = fitEffort(this.model, this.meta.effort);
    if (effort !== this.meta.effort) {
      this.meta = { ...this.meta, effort };
      this.deps.store.saveMeta(this.meta);
      this.emit({ type: 'meta', meta: this.meta });
    }
    if (efforts.length) {
      const now = fitEffort(this.model, sent);
      this.emit({ type: 'notice', level: 'info', text: `${this.model.name} does not take effort ${sent}; using ${now} (it takes ${efforts.join(', ')}).`, key: 'This model does not take effort {n}; switched to the nearest level it takes.', arg: sent });
    } else {
      this.emit({ type: 'notice', level: 'info', text: `${this.model.name} takes no effort setting; sending without one.`, key: 'This model takes no effort setting; sending without one.' });
    }
  }

  /**
   * What the context holds now, by kind, in tokens scaled to the measured total: the fixed prefix (system
   * prompt, tool definitions), the summary of earlier work, the conversation, reasoning carried between
   * steps, tool output in full and tool output cut to stubs. Also which lines of which files were read.
   */
  contextReport(): ContextReport {
    const parts = { system: estimateTokens(this.system), tools: estimateTokens(JSON.stringify(this.specs)), summary: 0, conversation: 0, reasoning: 0, outputs: 0, cut: 0 };
    let outputs = 0;
    let cut = 0;
    for (const m of this.active()) {
      const sent = sendable(m);
      for (const p of sent.parts) {
        const n = estimatePartTokens(p);
        if (p.type === 'tool_result') {
          if (p.pruned) {
            parts.cut += n;
            cut++;
          } else {
            parts.outputs += n;
            outputs++;
          }
        } else if (p.type === 'reasoning') parts.reasoning += n;
        else if (m.origin === 'compaction') parts.summary += n;
        else parts.conversation += n;
      }
    }
    const sum = Object.values(parts).reduce((a, b) => a + b, 0);
    const scale = sum > 0 ? this.contextTokens / sum : 1;
    const scaled = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * scale)])) as ContextReport['parts'];
    return {
      tokens: this.contextTokens,
      window: this.budget.window,
      // An assumed window is not the provider's: the report then names no second figure beside the one in use.
      nativeWindow: this.model.windowAssumed ? this.budget.window : this.model.nativeWindow ?? this.budget.window,
      compactAt: this.budget.compactAt,
      pruneAt: Math.round(this.budget.window * PRUNE_AT),
      parts: scaled,
      outputs,
      cut,
      compactions: this.messages.filter((m) => m.origin === 'compaction').length,
    };
  }

  setEffort(effort: Effort): void {
    this.meta = { ...this.meta, effort: fitEffort(this.model, effort) };
    this.deps.store.saveMeta(this.meta);
    this.emit({ type: 'meta', meta: this.meta });
  }

  setMode(mode: Mode): void {
    if (mode === this.meta.mode) return;
    this.meta = { ...this.meta, mode };
    this.notes.push(this.modeNote(mode));
    this.deps.store.saveMeta(this.meta);
    this.emit({ type: 'meta', meta: this.meta });
  }

  private modeNote(mode: Mode): string {
    if (mode === 'plan') return `Plan mode is now on. Research and design only: do not edit files or change system state. When the plan is ready, present it for approval with ${this.toolName('plan')}.`;
    return 'Build mode is now on: you may edit files and run commands, and the user is back to answer questions.';
  }

  /** The session's goal (the model's goal tool, or the user from a front end); undefined clears it. */
  setGoal(goal: Goal | undefined): void {
    this.meta = { ...this.meta, goal };
    this.deps.store.saveMeta(this.meta);
    this.emit({ type: 'meta', meta: this.meta });
  }

  private releaseBriefGoal(): void {
    const goal = this.meta.goal;
    if (goal?.by === 'brief') this.setGoal({ ...goal, by: 'model' });
  }

  private releaseBriefForUserInput(text: string): void {
    // In build mode the user is present: their next message can be a new request or a change a locked bar would block.
    const goingOn = /^\s*(?:continue|go on|keep going|继续|接着|继续吧|接着做)\s*[.!。！]*\s*$/i.test(text);
    if (this.role === 'main' && !goingOn) this.releaseBriefGoal();
  }

  /** A goal the user states: its objective, and criteria if they gave any (the model can add them). */
  setUserGoal(objective: string, criteria: string[] = []): void {
    const text = objective.trim();
    if (!text) return this.setGoal(undefined);
    // Editing keeps what was already met: a criterion with unchanged text keeps its state and evidence.
    const before = new Map((this.meta.goal?.criteria ?? []).map((c) => [c.text, c]));
    const list = criteria.map((c) => c.trim()).filter(Boolean);
    this.setGoal({
      objective: text,
      criteria: list.map((t) => ({ ...(before.get(t) ?? { done: false }), text: t })),
      by: 'user',
      updated: Date.now(),
    });
  }

  setTitle(title: string): void {
    this.meta = { ...this.meta, title };
    this.deps.store.saveMeta(this.meta);
    this.emit({ type: 'meta', meta: this.meta });
  }

  // ── context accounting ───────────────────────────────────────────────────

  active(): Message[] {
    return this.messages.slice(this.activeStart);
  }

  private estimatePrefix(): number {
    return estimateTokens(this.system) + estimateTokens(JSON.stringify(this.specs)) + this.presetTokens;
  }

  /** Who the user wants the agent to be, kept as the words it starts with. */
  private usePersona(chosen: Persona | null): void {
    this.meta = { ...this.meta, persona: chosen ? { name: chosen.name, text: personaText(chosen) } : undefined };
  }

  private usePreset(chosen: ActivePreset | null): void {
    this.preset = chosen;
    this.presetTokens = chosen ? estimateTokens(presetBulk(chosen.preset)) : 0;
    this.meta = { ...this.meta, preset: chosen ? { name: chosen.preset.name, scope: chosen.scope } : undefined };
  }

  /** Whether this model truly goes on from a trailing assistant message, at this effort. */
  private continuesPrefill(): boolean {
    if (this.prefillRefused) return false;
    const { api } = this.deps.catalog.provider(this.model.provider);
    if (api === 'anthropic') return !thinksAt(this.model, this.meta.effort);
    return api === 'openai-chat' && !!this.model.quirks.prefill;
  }

  /** The messages of a request of the session's own loop: its history with the preset placed in it, and only there. */
  private placed(messages: Message[]): { messages: Message[]; turnStart: number; continued?: string } {
    const turnStart = this.turnStartIndex();
    if (!this.preset) return { messages, turnStart };
    const { preset } = this.preset;
    const place = placePreset(messages, preset, macroContext(preset, this.id, Date.now(), this.model.id, messages), { continues: this.continuesPrefill(), flatSystem: this.systemRefused });
    return { ...place, turnStart: Math.max(0, place.messages.indexOf(messages[turnStart])) };
  }

  get contextTokens(): number {
    return this.anchorTokens + this.calibrator.adjust(this.sinceAnchor);
  }

  private refreshUsage(): void {
    this.usage = { ...this.usage, contextTokens: this.contextTokens, contextWindow: this.budget.window, compactAt: this.budget.compactAt };
    this.emit({ type: 'usage', usage: this.usage });
  }

  /**
   * Fold a response's usage into the totals. For main-conversation requests (`estimatedInput` > 0)
   * the reported prompt size becomes the new anchor; what is appended afterwards is estimated.
   * `model` is the one that answered, which a side request can have chosen apart from the session's; every request
   * goes to the token log (Settings > Usage) with it.
   */
  private recordUsage(u: Usage, estimatedInput: number, model: ModelInfo = this.model, kind: 'main' | 'side' = 'side', timing?: Pick<TokenEntry, 'ms' | 'waitMs' | 'hidden'>): void {
    const p = model.pricing;
    const uncached = Math.max(0, u.input - u.cacheRead - u.cacheWrite);
    const cost = p ? (uncached * p.input + u.cacheRead * (p.cacheRead ?? p.input * 0.1) + u.cacheWrite * (p.cacheWrite ?? p.input * 1.25) + u.output * p.output) / 1e6 : 0;
    const t = tokens(u);
    logTokens({ at: Date.now(), session: this.meta.id, ...(this.meta.parentId ? { parent: this.meta.parentId } : {}), cwd: this.meta.cwd, provider: model.provider, model: model.id, kind, ...t, cost, ...(t.input + t.output === 0 ? { unreported: true as const } : {}), ...timing });
    this.usage = {
      ...this.usage,
      totalInput: this.usage.totalInput + u.input,
      totalOutput: this.usage.totalOutput + u.output,
      cacheRead: this.usage.cacheRead + u.cacheRead,
      cacheWrite: this.usage.cacheWrite + u.cacheWrite,
      cost: this.usage.cost + cost,
      requests: this.usage.requests + 1,
    };
    if (u.input > 0 && estimatedInput > 0) {
      this.calibrator.observe(estimatedInput, u.input);
      this.anchorTokens = u.input;
      this.sinceAnchor = 0;
      this.mainRequests++;
    }
  }

  /** What a cached input token costs against a fresh one; 1 while nothing has come from a cache, as nothing is lost. */
  private cachedShare(): number {
    if (!this.usage.cacheRead) return 1;
    const p = this.model.pricing;
    return p?.cacheRead != null && p.input > 0 ? p.cacheRead / p.input : 0.1;
  }

  /** A sub-agent's requests and tokens are this session's too: otherwise what a task cost stays out of every total. */
  private addUsage(child: Session): void {
    const u = this.usage;
    const c = child.usage;
    this.usage = { ...u, totalInput: u.totalInput + c.totalInput, totalOutput: u.totalOutput + c.totalOutput, cacheRead: u.cacheRead + c.cacheRead, cacheWrite: u.cacheWrite + c.cacheWrite, cost: u.cost + c.cost, requests: u.requests + c.requests };
  }

  private push(m: Message, read: readonly PendingInput[] = []): void {
    const consumed = read.length ? read.map((p) => p.id) : undefined;
    let saved = m;
    for (;;) {
      try {
        this.deps.store.saveMessage(this.meta, saved, consumed);
        break;
      } catch (error) {
        if (saved !== m) {
          // Both writes failed. Keep the results we learned in this process, leaving input in the queue.
          this.remember({ ...m, parts: m.parts.filter((p) => p.type === 'tool_result') });
          throw error;
        }
        if (this.deps.store.messageSaved(this.meta, m.id)) break;
        if (m.origin !== 'tool') throw error;
        const parts = m.parts.map((p) => p.type === 'tool_result' && this.ranTools.has(p)
          ? this.cancelled({ id: p.callId, name: p.name }, UNSTORED_TOOL_OUTPUT)
          : p);
        saved = { ...m, parts };
      }
    }
    this.remember(saved);
    if (consumed) {
      const ids = new Set(consumed);
      this.pending = this.pending.filter((p) => !ids.has(p.id));
      const queued = this.meta.queued?.filter((p) => !p.id || !ids.has(p.id));
      this.meta = { ...this.meta, queued: queued?.length ? queued : undefined };
      this.emit({ type: 'queue', items: this.queued });
    }
    this.meta = { ...this.meta, updated: Date.now() };
    this.deps.store.touch(this.meta);
    this.emit({ type: 'message.added', message: saved });
  }

  private remember(m: Message): void {
    this.messages.push(m);
    this.sinceAnchor += estimateMessageTokens(m);
  }

  // ── turns ────────────────────────────────────────────────────────────────

  get busy(): boolean {
    return this.status !== 'idle';
  }

  /**
   * Send a user message. While a turn runs, the message waits for the agent's next step, shown in the composer
   * and open to being taken back until then.
   */
  send(text: string, images: ImagePart[] = []): Promise<void> {
    // The stop is over once the user writes again: a command still running from before may end a later wait.
    this.jobsAtStop = new WeakSet();
    if (this.running) {
      this.pending.push({ id: newId('q'), text, images, at: Date.now() });
      this.emitQueue();
      return this.running;
    }
    return this.startTurn(text, images);
  }

  /**
   * The user's retry after a turn that failed (a key fixed, another model picked, a service back up): the work goes on
   * from where the failure left it, with a note. Their message is already in the history, so it is not sent again.
   */
  retry(): Promise<void> | undefined {
    if (this.running) return undefined;
    this.jobsAtStop = new WeakSet();
    return this.startTurn('The last request failed before an answer came. Carry on from where you stopped.', [], 'harness');
  }

  private startTurn(text: string, images: ImagePart[], origin: 'user' | 'harness' = 'user', read?: PendingInput[]): Promise<void> {
    this.running = this.runTurn(text, images, origin, read)
      .finally(() => {
        this.running = null;
      })
      .then((reason) => this.afterTurn(reason));
    return this.running;
  }

  /** After a turn: a compaction asked for during it that its steps did not reach, then what waits and wakes. */
  private afterTurn(reason: TurnEndReason): Promise<void> | undefined {
    const asked = this.compactAsked;
    if (this.disposed) return;
    if (!asked) return this.switchHeld(reason) ?? this.carryOver(reason) ?? this.wake();
    this.compactAsked = null;
    const run = this.compactNow('manual');
    run.then((ok) => asked.resolve(ok), () => asked.resolve(false));
    this.running = run
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.running = null;
      })
      .then(() => this.switchHeld(reason) ?? this.carryOver(reason) ?? this.wake());
    return this.running;
  }

  /**
   * Where the words of a request sit in the code, found before the first request. The opening steps of a task are
   * mostly these searches, with words from the task itself, so this saves requests instead of adding one.
   */
  private async lookAhead(text: string, signal: AbortSignal): Promise<string | null> {
    try {
      const { hits } = await searchCode(this.meta.cwd, text, { limit: 8, signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
      if (!hits.length) return null;
      return `Where this request's words appear in the code, by word search, so a lead and no more:\n${hits.map((h) => `${h.file}:${h.line}  ${oneLine(h.head, 110)}`).join('\n')}`;
    } catch (e) {
      debug('prefetch', 'no lookup', String(e));
      return null;
    }
  }

  /** Resolves once no turn runs, no background sub-agent is out and no report is about to start a turn: a run that exits sooner would kill them. */
  async settled(): Promise<void> {
    while (this.running || this.background.size || this.tasks.size || this.backgroundDone.some((d) => d.wakes) || this.shadowRun?.deferred) await (this.running ?? new Promise((resolve) => setTimeout(resolve, 200)));
  }

  /** A background command the agent has read to its end since it ended needs no report of its own. */
  private dropSeenJobs(): void {
    this.backgroundDone = this.backgroundDone.filter((d) => !d.job || !this.jobs.get(d.job)?.seenEnd);
  }

  /** The reports of background sub-agents and commands that came in, as one note, with what still runs; the list empties. */
  private takeBackgroundReports(): string {
    this.dropSeenJobs();
    const reports = this.backgroundDone
      .splice(0)
      .map((d) =>
        d.job
          ? d.text
          : d.tool
            ? d.stopped
              ? `The ${d.tool} call "${d.description}" in the background was stopped by the user.\n${d.text}`
              : `The ${d.tool} call "${d.description}" in the background has finished. Its result:\n${d.text}`
            : d.stopped
              ? `The background sub-agent "${d.description}" was stopped by the user.\n${d.text}`
              : `The background sub-agent "${d.description}" has finished. Its report:\n${d.text}`,
      );
    const still = [...this.background.values(), ...this.tasks.values()].map((b) => `"${b.description}"`);
    return [...reports, ...(still.length ? [`Still running in the background: ${still.join(', ')}.`] : [])].join('\n\n');
  }

  /**
   * An idle session whose background sub-agents are all in: one turn of its own, to carry on with the work they were
   * part of. It waits for the last one, so the agent is not woken once per report; what the user stopped wakes nothing.
   */
  private wake(): Promise<void> | undefined {
    this.dropSeenJobs();
    if (this.running || this.background.size || this.tasks.size || this.disposed || !this.backgroundDone.some((d) => d.wakes)) return undefined;
    const text = `${this.takeBackgroundReports()}\n\nCarry on with the work this was part of. If nothing is left to do, tell the user in a few lines what came of it.`;
    return this.startTurn(text, [], 'harness');
  }

  /** A background sub-agent is done: its report goes to the next step, or into a turn of its own once the last one is in. */
  private reportBackground(callId: string, description: string, r: SubagentResult): void {
    const wakes = this.background.get(callId)?.wakes === true;
    this.background.delete(callId);
    if (this.disposed) return;
    const text = r.error ? `It failed: ${r.error}${r.text ? `\nWhat it reported before that:\n${r.text}` : ''}` : r.text || '(no report)';
    this.backgroundDone.push({ callId, description, text, stopped: !!r.stopped, wakes: wakes && !r.stopped });
    this.emitBackground();
    // The user knows what they stopped; only what ends on its own is announced.
    if (!r.stopped) this.emit({ type: 'notice', level: 'info', text: `The background sub-agent "${description}" is done.`, key: 'The background sub-agent "{n}" is done.', arg: description });
    void this.wake();
  }

  /**
   * A background command the agent started has ended on its own, in a session someone has open: its exit code and last
   * lines go to the next step, and an idle session is woken by them, so the agent can start a build, a test run or a
   * download, carry on or end its turn, and pick it up when it is done, instead of waiting with sleep while the user
   * cannot talk to it. A headless run ends with its turn and is left as it was; what the agent stopped says nothing.
   */
  private jobEnded(job: BackgroundJob): void {
    if (this.disposed || job.killed || !this.interactive || this.role !== 'main' || this.parent) return;
    const lines = cleanTerminal(job.buffer).replace(/\s+$/, '').split('\n').slice(-40).join('\n');
    const tail = lines.length > 4000 ? `…${lines.slice(-4000)}` : lines;
    const text = `The background command ${job.id} ended with exit code ${job.exitCode ?? 'none'} after ${Math.round((Date.now() - job.started) / 1000)} s: ${oneLine(job.command, 160)}${tail ? `\nIts last output:\n${tail}` : ''}`;
    this.backgroundDone.push({ callId: job.id, description: job.id, text, stopped: false, wakes: !this.jobsAtStop.has(job), job: job.id });
    this.emit({ type: 'notice', level: 'info', text: `Background job ${job.id} ended.`, key: 'Background job {n} ended.', arg: job.id });
    void this.wake();
  }

  /**
   * A tool's work in the background (ctx.inBackground): the call returns at once with a line for the agent; the work
   * goes on with a stop of its own, which the user's stop reaches; its card is sent as it changes; its result comes
   * back as a background sub-agent's report does. The session keeps a record of it beside the conversation.
   */
  private startTask(call: ToolCallPart, o: { description: string; resume?: string; work: (bg: BackgroundWork) => Promise<ToolOutput> }): ToolOutput {
    const controller = new AbortController();
    const task = { tool: call.name, description: o.description, started: Date.now(), controller, display: undefined as ToolDisplay | undefined };
    this.tasks.set(call.id, task);
    this.keepTask({ callId: call.id, tool: call.name, description: o.description, started: task.started, state: 'running', ...(o.resume ? { resume: o.resume } : {}) });
    this.emitBackground();
    const show = (display: ToolDisplay) => {
      task.display = display;
      this.emitBackground();
    };
    const end = (r: ToolOutput) => this.endTask(call.id, r, controller.signal.aborted);
    // Its lines of progress have no card to go to: the card it shows says where it is.
    o.work({ signal: controller.signal, show, progress: () => {}, agents: this.role === 'main' ? this.toolAgents(call.id, controller.signal) : undefined }).then(end, (e) => end({ content: `It failed: ${(e as Error).message}`, isError: true }));
    return {
      content: `Running in the background as "${o.description}". Its result comes back as a message when it is done, and you are woken with it. Go on with work that does not need it; do not do its work yourself meanwhile. When nothing else is left for you, end your turn with a line to the user on what is still running.`,
      display: { kind: 'stages', stages: [], figures: [] },
    };
  }

  private endTask(callId: string, r: ToolOutput, stopped: boolean): void {
    const task = this.tasks.get(callId);
    if (!task) return;
    this.tasks.delete(callId);
    if (this.disposed) return;
    this.backgroundDone.push({ callId, description: task.description, text: r.content, stopped, wakes: !stopped, tool: task.tool });
    const was = this.meta.tasks?.find((t) => t.callId === callId);
    this.keepTask({ callId, tool: task.tool, description: task.description, started: task.started, ...(was?.resume ? { resume: was.resume } : {}), state: stopped ? 'stopped' : r.isError ? 'failed' : 'done', ...((r.display ?? task.display) ? { display: r.display ?? task.display } : {}) });
    this.emitBackground();
    if (!stopped) this.emit({ type: 'notice', level: 'info', text: `Done in the background: ${task.description}`, key: 'Done in the background: {n}', arg: task.description });
    void this.wake();
  }

  /** A background task's record in the session's meta, the latest 20 kept, for a front end opened later. */
  private keepTask(t: BackgroundTask): void {
    this.meta = { ...this.meta, tasks: [...(this.meta.tasks ?? []).filter((x) => x.callId !== t.callId), t].slice(-20) };
    this.deps.store.saveMeta(this.meta);
    this.emit({ type: 'meta', meta: this.meta });
  }

  /**
   * A sub-agent's events, passed up under the call that started it. The output of its commands stays with it: no
   * front end shows that live (a sub-agent's sheet reads its session), and one long run's sub-agents sent 44 MB of it to
   * the window in one turn, 93% of its event stream (2026-11-04). A card a tool shows meanwhile is still passed up.
   */
  private relay(callId: string): (e: AgentEvent) => void {
    return (e) => {
      if (e.type === 'tool.progress') {
        if (e.display) this.emit({ type: 'subagent', callId, event: { ...e, chunk: '' } });
        return;
      }
      this.emit({ type: 'subagent', callId, event: e });
    };
  }

  /** Messages waiting for the agent's next step. */
  get queued(): QueuedInput[] {
    return this.pending.map((p) => ({ id: p.id, text: p.text, images: p.images.length, at: p.at }));
  }

  /** Take back a message the agent has not read yet (to drop it, or to edit and send again); undefined once read. */
  withdraw(id: string): { text: string; images: ImagePart[] } | undefined {
    const i = this.pending.findIndex((p) => p.id === id && !p.carried);
    if (i < 0) return undefined;
    const [p] = this.pending.splice(i, 1);
    this.emitQueue();
    return { text: p.text, images: p.images };
  }

  private donePreparing(): void {
    if (!this.preparing) return;
    this.preparing = null;
    this.emit({ type: 'preparing', text: null });
  }

  private emitQueue(returned?: PendingInput[]): void {
    if (returned?.length) this.unread.push(...returned);
    try {
      this.saveQueue(this.unread);
    } catch (e) {
      debug('store', 'queued input not written', String(e));
    }
    this.emit({ type: 'queue', items: this.queued, ...(returned?.length ? { returned: returned.map(({ id, text, images }) => ({ id, text, images })) } : {}) });
  }

  private saveQueue(unread: readonly PendingInput[]): void {
    // The unread ones stay on disk until a front end receives them. A saved message consumes its own inputs.
    const all = [...unread, ...this.pending];
    if (all.length === (this.meta.queued?.length ?? 0) && all.every((p, i) => p.id === this.meta.queued?.[i]?.id)) return;
    const queued = all.map((p) => ({
      id: p.id,
      text: p.text,
      at: p.at,
      ...(p.images.length
        ? {
            images: p.images.map((img) => ({
              ...(img.id ? { id: img.id } : {}),
              mediaType: img.mediaType,
              blob: (img.blob ??= this.deps.store.blobs.put(Buffer.from(img.data, 'base64'), false)),
              ...(img.name ? { name: img.name } : {}),
              ...(img.width && img.height ? { width: img.width, height: img.height } : {}),
              ...(img.sourcePath ? { sourcePath: img.sourcePath } : {}),
              ...(img.sourceSha256 ? { sourceSha256: img.sourceSha256 } : {}),
            })),
          }
        : {}),
    }));
    const meta = { ...this.meta, queued: queued.length ? queued : undefined };
    this.deps.store.saveMeta(meta);
    this.meta = meta;
  }

  unreadInputs(): ReturnedInput[] {
    return this.unread.map(({ id, text, images }) => ({ id, text, images }));
  }

  acknowledgeInputs(ids: readonly string[]): void {
    const unread = this.unread.filter((p) => !ids.includes(p.id));
    if (unread.length === this.unread.length) return;
    this.saveQueue(unread);
    this.unread = unread;
  }

  /** The terminal can acknowledge its own input without a trip through the event connection. */
  takeUnread(): ReturnedInput[] {
    const out = this.unreadInputs();
    try { this.acknowledgeInputs(out.map((p) => p.id)); } catch (e) { debug('store', 'input acknowledgement not written', String(e)); }
    return out;
  }

  /**
   * Messages that came after the agent's last step: after a turn that ended on its own they start the next one;
   * after an interruption or an error they go back to the composer, to send again or drop.
   */
  private carryOver(reason: TurnEndReason): Promise<void> | undefined {
    if (!this.pending.length) return undefined;
    if (reason === 'aborted' || reason === 'error') {
      this.emitQueue(this.pending.splice(0));
      return undefined;
    }
    const left = this.pending.slice();
    for (const input of left) input.carried = true;
    this.jobsAtStop = new WeakSet();
    return this.startTurn(left.map((p) => p.text).join('\n\n'), left.flatMap((p) => p.images), 'user', left);
  }

  /**
   * The user's stop: the turn, every sub-agent (the ones in the background too) and every wait on the user end at
   * once. Nothing that was running starts a turn afterwards; what it reported comes with the next message.
   */
  abort(): void {
    for (const { callId } of this.childCalls.values()) this.stoppedCalls.add(callId);
    for (const d of this.backgroundDone) d.wakes = false;
    for (const b of this.background.values()) b.wakes = false;
    for (const job of this.jobs.list()) this.jobsAtStop.add(job);
    this.compactAsked?.resolve(false);
    this.compactAsked = null;
    if (this.compactionController && !this.controller) this.carryOver('aborted');
    // A stop reaches the shadow tester too, between turns as well: nothing it finds wakes the session after it.
    if (this.shadowRun && !this.shadowRun.placed.length) {
      this.shadowRun.stop();
      this.shadowRun = null;
    }
    this.controller?.abort();
    this.compactionController?.abort();
    // A summary still being written stops with the rest; a finished one is kept, so the mark does not hold the next
    // turn while it is written again.
    if (this.draft && this.draft.body === undefined) this.dropDraft();
    for (const c of this.children) c.abort();
    for (const t of this.tasks.values()) t.controller.abort();
    for (const [id, d] of this.permissionWaits) {
      d.resolve('deny');
      this.permissionWaits.delete(id);
    }
    for (const [id, d] of this.questionWaits) {
      d.resolve(null);
      this.questionWaits.delete(id);
    }
    for (const [id, d] of this.planWaits) {
      d.resolve({ approved: false, feedback: 'Interrupted.' });
      this.planWaits.delete(id);
    }
  }

  /** A front end has this session open: however it was loaded first, someone is there to answer and approve. */
  attend(): void {
    if (this.role === 'main' && !this.parent && !this.autonomous) this.interactive = true;
  }

  /**
   * Stops one sub-agent, at any depth, and leaves the rest running: the agent that started it hears that the user
   * stopped it and goes on. True when it was found.
   */
  stopChild(sessionId: string): boolean {
    for (const [c, { callId }] of this.childCalls) {
      if (c.id === sessionId) {
        this.stoppedCalls.add(callId);
        c.abort();
        return true;
      }
      if (c.stopChild(sessionId)) return true;
    }
    return false;
  }

  private takeNotes(): TextPart[] {
    const parts = this.notes.map((text) => ({ type: 'text' as const, text: `<harness-note>${text}</harness-note>`, synthetic: true }));
    this.notes = [];
    return parts;
  }

  private async runTurn(text: string, images: ImagePart[], origin: 'user' | 'harness', read: readonly PendingInput[] = []): Promise<TurnEndReason> {
    const turn = newId('t');
    this.turn = turn;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.setStatus('running');
    this.emit({ type: 'turn.start', turn });
    this.turnStartedAt = Date.now();
    for (const text of this.startNotes.splice(0)) this.emit({ type: 'notice', level: 'warn', text });
    let reason: TurnEndReason = 'done';
    let error: string | undefined;
    let errorKind: string | undefined;
    let joiningFacts = false;
    let inputSaved = false;
    try {
      this.maybePrune();
      const dropStart = this.maybeDropImages(signal);
      if (dropStart) await dropStart;
      // A compaction before the message joins the conversation can take minutes: the message shows at once, and a
      // stop meanwhile hands it back (it used to be lost: in no history, no composer, no queue).
      const incomingTokens = origin === 'user' || origin === 'harness' ? this.incomingEstimate(text, images) : 0;
      const compacting = this.shouldCompact(incomingTokens);
      if (compacting && origin === 'user') {
        this.preparing = { text, images: images.length };
        this.emit({ type: 'preparing', text, images: images.length });
      }
      if (compacting && !(await this.useDraft(incomingTokens))) await this.compactNow('auto', incomingTokens);
      signal.throwIfAborted();
      if (!this.meta.title && this.role === 'main' && origin === 'user') {
        const named = sessionTitle(text);
        this.setTitle(named.title);
        if (named.vague) this.vagueTitle = { title: named.title, turn };
      }
      // The request is the user's own: an email or a page made from it should not repeat it word for word.
      if (this.role === 'main' && origin === 'user') keepPrivate(this.checkpoints, { asked: text });
      // Held-back tools a request plainly needs come loaded with it, as a note on the message, by what it makes: the
      // browser for something people look at, paint for artwork and for a page that persuades (not for every screen,
      // chart or button), film, watch and music for a film to be made (not for writing about one), music for a piece.
      // Read without what the request rules out ("no … web pages"), and a repair is not a request for a new look.
      // A game, a button or an animation is a look only where there is one or nothing yet: in a module of code without
      // an interface it is what the program models (a curling score, a board game's winner).
      const asked = withoutProhibitions(text);
      const fixing = asksToFix(asked);
      const making = asksToMake(asked);
      const looked = !fixing && (namesInterface(asked) || (asksForInterface(asked) && (hasInterface(this.meta.cwd) || !isCodeProject(this.meta.cwd))));
      const videoText = aboutVideoText(asked);
      const moving = asksForFilm(asked) && making && !videoText && !fixing;
      const pictured = (asksForArt(asked) && !fixing && !(asksForFilm(asked) && videoText)) || (looked && asksForPage(asked)) || moving;
      // What extensions make of a message: tools of theirs to load with it here, and notes that come with it below.
      const extra =
        this.role === 'main' && origin === 'user'
          ? extensionMessage({ text, mode: this.meta.mode, config: this.config, called: (tool) => this.messages.some((m) => m.parts.some((p) => p.type === 'tool_call' && p.name === tool)), once: (key) => !this.noted.has(key) && !!this.noted.add(key) })
          : { load: [], notes: [] };
      if (this.defersTools() && origin === 'user') {
        const needed = [...(looked || pictured || this.system.includes('# Interfaces') ? ['browser'] : []), ...(pictured ? ['paint'] : []), ...(moving ? ['film', 'watch', 'music'] : []), ...(asksForMusic(asked) && !fixing && !moving ? ['music'] : []), ...(asksAboutMail(asked) ? ['mail'] : []), ...extra.load].filter((n) => !this.loadedTools.has(n) && this.binding(n));
        // Said as loaded: 17 of 38 load_tools calls in the evals loaded again what this note had just given (2026-11-06).
        if (needed.length) this.notes.push(`Loaded for this request, no load_tools call needed: the full instructions of ${needed.join(', ')}.\n\n${this.loadTools(needed).text}`);
      }
      // Something people will look at, asked for where nothing has an interface yet (a new game in an empty folder):
      // the design guide comes with the message, once, since the system prompt has it only for projects with one.
      // Asked for a new look, here or anywhere, art directions drawn at random come with it. This sits before the plan
      // note so the same design guidance reaches the maker even when work starts in plan mode.
      if (this.role === 'main' && origin === 'user' && !this.designNoted) {
        const fresh = !this.system.includes('# Interfaces') && looked;
        const restyle = asksForRedesign(asked);
        if (fresh || restyle) {
          this.designNoted = true;
          if (fresh) this.notes.push(designGuide(this.bindings.some((b) => b.spec.name === 'browser') ? 'browser' : undefined, this.model.vision));
          // A page that persuades gets art directions; a screen people work in gets styles made for that.
          if ((restyle || asksToMake(text)) && process.env.FAVILLA_DIRECTIONS !== '0') {
            const dealt = asksForWorkScreen(text) ? dealAppStyles(`${this.id}:${text}`) : dealDirections(`${this.id}:${text}`);
            this.notes.push(dealt);
            // What was drawn is named for Favilla and the model: a page that shows the name has leaked it.
            keepPrivate(this.checkpoints, { names: [...dealt.matchAll(/^## (.+?)(?: \([^)]*\))?$/gm)].map((m) => m[1]) });
          }
        }
      }
      // A folder of code has no rules for documents and data in its system prompt: they come once, with a request for
      // a document, a sheet, a chart or a translation, or with the first such file read or written (below).
      if (this.role === 'main' && origin === 'user' && asksForDocuments(asked)) this.noteDocuments();
      if (this.role === 'main' && origin === 'user' && asksForWrittenDoc(asked)) this.noteWritingDocs();
      this.notes.push(...extra.notes);
      // The answer rules' examples are Chinese: under them DeepSeek wrote one English task's final report in ten in
      // Chinese, after notes in English all the way. The last answers of such sessions asked again with the message's
      // language named beside it: 0 of 36 in Chinese, 18 of 33 without (DeepSeek v4.1 flash, 2026-11-05).
      if (this.role === 'main' && origin === 'user') {
        const lang = languageOf(text);
        // Messages only: code and its comments keep the project's own language.
        // Text for other people keeps its readers' language, or a Chinese request for an English reply gets a Chinese one.
        if (lang) this.notes.push(`The user writes in ${lang}: write your messages to them in ${lang}, your final report included. What you write for other people (an email, a post, a comment, a commit, a page) is in its readers' language. No dashes (——, —, –) in your messages or in text you compose for others; text you translate, quote or edit keeps its own punctuation.`);
      }
      // Something said to hold beyond this task is kept: the rules alone left a project's rules unsaved every time.
      if (this.role === 'main' && origin === 'user' && statesStandingRule(text)) this.notes.push(`This message says something meant to hold beyond this task. Before you finish, keep it with ${this.toolName('remember')}: scope project for a rule or fact about this project or repository, scope global for how the user wants things done wherever they work. Leave out what a saved note already says, and keys or passwords.`);
      const lookingAhead = this.role === 'main' && origin === 'user' && process.env.FAVILLA_PREFETCH !== '0' && namesCode(text);
      if (lookingAhead && !this.preparing) {
        this.preparing = { text, images: images.length };
        this.emit({ type: 'preparing', text, images: images.length });
      }
      if (this.meta.mode === 'plan' && this.role === 'main' && origin === 'user') this.notes.push(fill(promptAsset('plan'), { ask: this.toolName('ask'), exit_plan: this.toolName('plan') }));
      if (lookingAhead) {
        const found = await this.lookAhead(text, signal);
        signal.throwIfAborted();
        if (found) this.notes.push(found);
      }
      // Reports that came in while nothing ran and started no turn (what the user stopped): they come with this message.
      if (this.backgroundDone.length) this.notes.push(this.takeBackgroundReports());
      // The folder's facts open the session's first message, and the next one whenever the history lacks them.
      if (!this.factsShown()) {
        joiningFacts = true;
        const facts = await this.folderFacts();
        // A session can be closed and its history removed before this first turn writes anything.
        if (this.disposed) signal.throwIfAborted();
        joiningFacts = false;
        this.notes.unshift(facts);
      }
      const registeredImages = images.length ? await this.registerUserImages(images) : [];
      const noteParts = this.takeNotes();
      const extraPartTokens = this.calibrator.adjust(
        [...noteParts, ...registeredImages].reduce((n, p) => n + estimatePartTokens(p), 0),
      );
      const userBody: TextPart =
        origin === 'harness'
          ? { type: 'text', text: `<harness-note>${text}</harness-note>`, synthetic: true }
          : (() => {
              const fitted = this.fitInboundText(text, extraPartTokens, this.messages.length);
              return { type: 'text', text: fitted.text, ...(fitted.textBlob ? { textBlob: fitted.textBlob } : {}) };
            })();
      const userMsg: Message = {
        id: newId('m'),
        role: 'user',
        origin,
        parts: [...noteParts, userBody, ...registeredImages],
        time: Date.now(),
        turn,
      };
      if (origin === 'user') this.releaseBriefForUserInput(text);
      this.push(userMsg, read);
      inputSaved = true;
      if (origin === 'user') this.scratchDatabases.clear();
      this.donePreparing();
      // The folder as this turn finds it, taken while the model reads the message; tools wait for it.
      this.pointTaken = this.checkpoints.begin(turn).catch((e) => debug('checkpoints', 'snapshot failed', String(e)));
      this.roundsSinceUser = 0;
      this.goalAsked = false;
      this.trackedAlone = 0;
      this.planPresented = false;
      this.finishNotes = 0;
      this.finishNoteList = '';
      this.docStyleChecks.clear();
      this.turnAgents = 0;
      if (origin === 'user') {
        // A new request makes the last one's tests stale.
        if (this.shadowRun && this.shadowRun.turn !== turn && !this.shadowRun.placed.length) {
          this.shadowRun.stop();
          this.shadowRun = null;
        }
        if (fixing) this.startShadowTests(text);
      }
      reason = await this.loop(signal);
    } catch (e) {
      if (isAbortError(e) || signal.aborted) reason = 'aborted';
      else {
        reason = 'error';
        error = (e as Error).message;
        errorKind = e instanceof ProviderError ? e.kind : undefined;
        this.emit({ type: 'notice', level: 'error', text: error });
      }
    } finally {
      // Stopped or failed while it was being got ready: the message goes back to the composer, as an unread one does.
      this.donePreparing();
      if (!read.length && !inputSaved && origin === 'user' && !this.disposed) this.emitQueue([{ id: newId('q'), at: Date.now(), text, images }]);
      for (const input of read) delete input.carried;
      this.controller = null;
      this.lastEnd = reason;
      this.lastError = reason === 'error' ? (error ?? 'the turn ended in an error') : null;
      // Shadow tests leave before the folder's end of turn is taken: they were never the agent's change. A tester
      // still writing them for this turn goes on when they are to run later (deferred), and stops otherwise.
      if (this.shadowRun?.placed.length) {
        removeShadow(this.shadowRun.placed);
        this.shadowRun = null;
      } else if (this.shadowRun?.turn === turn && !this.shadowRun.deferred) {
        this.shadowRun.stop();
        this.shadowRun = null;
      }
      if (!this.disposed || !joiningFacts) {
        try {
          this.deps.store.saveUsage(this.meta, this.usage);
          await this.deps.store.flushIndexAsync();
        } catch (e) {
          debug('store', 'turn usage or index not written', String(e));
        }
      }
      const changed = this.checkpoints.files(turn);
      if (changed.length) this.emit({ type: 'checkpoint', turn, files: changed.map((f) => displayPath(this.meta.cwd, f)) });
      // A name the user has not changed since it was made gets the file the turn worked on.
      if (this.vagueTitle?.turn === turn) {
        if (changed.length && this.meta.title === this.vagueTitle.title) this.setTitle(titleWithFile(this.meta.title, changed[0]));
        this.vagueTitle = null;
      }
      // The folder as the turn leaves it: what commands changed joins the turn's changes once it is taken.
      const taken = this.pointTaken;
      this.pointTaken = null;
      if (taken)
        this.pointEnd = taken
          .then(() => this.checkpoints.end(turn))
          .then((seen) => {
            const all = this.checkpoints.files(turn);
            if (seen.length && all.length > changed.length) this.emit({ type: 'checkpoint', turn, files: all.map((f) => displayPath(this.meta.cwd, f)) });
          })
          .catch((e) => debug('checkpoints', 'snapshot failed', String(e)));
      this.turnStartedAt = null;
      this.runningTools.clear();
      this.setStatus('idle');
      this.closeBrowserWhenIdle();
      this.emit({ type: 'turn.end', turn, reason, error, errorKind });
    }
    return reason;
  }


  private turnStartIndex(): number {
    const a = this.active();
    for (let i = a.length - 1; i >= 0; i--) if (a[i].role === 'user' && (a[i].origin === 'user' || a[i].origin === 'compaction')) return i;
    return 0;
  }

  private async loop(signal: AbortSignal): Promise<TurnEndReason> {
    const maxSteps = this.role === 'explore' ? 80 : (this.config.maxSteps ?? DEFAULTS.maxSteps);
    let continuations = 0;
    // Replies kept after a dropped connection and asked to go on, in this turn (a relay that keeps dropping).
    let cutContinuations = 0;
    let repeats = 0;
    let textToolNudged = false;
    let emptyNudged = false;
    let memoryNudged = false;
    let stallNudged = false;
    let goalNudges = 0;
    let shadowChecked = false;
    // The turn's latest answer, and whether the note Favilla added after it asked only for bookkeeping (marking the
    // criteria): then a reply that does just that needs no new answer.
    let answer: string | undefined;
    let answerMessageId: string | undefined;
    let memoryReplyTo: string | undefined;
    let bookkeepingNote = false;
    let planCarded = false;
    const note = (text: string, bookkeeping = false) => {
      memoryReplyTo = undefined;
      this.push(this.harnessMessage(text));
      bookkeepingNote = bookkeeping;
    };
    /** What an answer goes through before the turn may end; true when it sent the model back to work. */
    const endChecks = async (text: string): Promise<boolean> => {
      // Reports of background sub-agents that came in during the last step: read before the turn ends.
      if (this.backgroundDone.length && this.role === 'main') {
        note(`${this.takeBackgroundReports()}\nTake it into account before you finish.`);
        return true;
      }
      // Sub-agents still at work in the background: this answer is a pause, and the checks made for finished work wait
      // for the turn their reports start (or the coverage check sends the agent back to work it handed out).
      if (this.background.size && this.role === 'main' && !this.pending.length) return false;
      // Plan mode ends in something the user can approve. A plan written out as an answer gets the same card, with no
      // request to the model. With nobody to ask it is the answer: a plan run on its own ends with its plan.
      if (!planCarded && !this.planPresented && this.meta.mode === 'plan' && this.role === 'main' && !this.pending.length && looksLikePlan(text)) {
        planCarded = true;
        const verdict = await this.requestPlanApproval(text);
        // Stopped while the card waited: the user gave no verdict, so none goes into the history ("Their feedback:
        // Interrupted." read as the user's words).
        if (signal.aborted) return false;
        if (verdict?.approved) {
          this.setMode('build');
          note(`The user approved the plan in your last message. Plan mode is off: you can now edit files and run commands. Work through the plan.${verdict.feedback ? `\nUser notes: ${verdict.feedback}` : ''}`);
          return true;
        }
        if (verdict?.feedback) {
          note(`The user did not approve the plan yet. Stay in plan mode and revise it.\nTheir feedback: ${verdict.feedback}`);
          return true;
        }
      }
      // Shadow tests, once a turn: what another model wrote from the request alone runs on the change, and a failing
      // test sends the work back with what it printed. Nobody waits for the tester: when it is not done, its tests run
      // when it is, and a failure wakes the session (waiting cost a live run from 2 minutes to 17).
      if (this.shadowRun?.turn === this.turn && !shadowChecked && this.role === 'main' && !this.pending.length && this.checkpoints.files(this.turn).length) {
        shadowChecked = true;
        if (!this.shadowRun.done) {
          this.shadowRun.deferred = true;
          this.emit({ type: 'notice', level: 'info', text: 'The shadow tests are still being written: they run on the change when they are ready.', key: 'The shadow tests are still being written: they run on the change when they are ready.' });
        } else {
          const found = await this.checkShadowTests(signal);
          if (found) {
            note(found);
            return true;
          }
        }
      }
      // The maker's claims become verdicts only when a fresh reviewer judges the result itself.
      const g = this.meta.goal;
      const brief = this.brief;
      if (g?.by === 'brief' && brief && this.role === 'main' && !this.pending.length && !this.tasks.size && brief.reviews < BRIEF_REVIEWS) {
        const n = ++brief.reviews;
        const last = n === BRIEF_REVIEWS;
        // Paths only: the files' contents before and after are not needed to name them.
        const changed = [...new Set(this.checkpoints.turns().flatMap((t) => this.checkpoints.files(t).map((f) => displayPath(this.meta.cwd, f))))];
        this.emit({ type: 'notice', level: 'info', text: `A reviewer checks the result against the brief (${n} of ${BRIEF_REVIEWS}).`, key: 'A reviewer checks the result against the brief ({n} of 2).', arg: String(n) });
        try {
          const r = await this.runSubagent({ description: `Review the result (${n} of ${BRIEF_REVIEWS})`, prompt: reviewPrompt(brief.request, brief.text, g, changed, scratchDir(this.meta.cwd)), agent: 'explore' }, `brief-review-${Date.now()}`, signal);
          // The user can replace the goal in settings while the reviewer is at work.
          if (!r.error && !signal.aborted && this.meta.goal === g) {
            const { verdicts, gaps } = parseReview(r.text);
            const judged = structuredClone(g);
            judged.criteria.forEach((c, i) => {
              const v = verdicts.get(i + 1);
              if (!v) return;
              c.done = v.pass;
              c.proved = v.pass;
              c.claimed = false;
              c.evidence = v.why;
            });
            const failing = judged.criteria.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => !c.done);
            if (!failing.length || last) judged.by = 'model';
            judged.updated = Date.now();
            this.setGoal(judged);
            if (failing.length) {
              note(`A reviewer who has not seen your work checked it on the result itself (review ${n} of ${BRIEF_REVIEWS}). Not met:\n${failing.map(({ c, n }) => `${n}. ${c.text} | ${c.evidence ?? 'no verdict'}`).join('\n')}${gaps ? `\n\nThe biggest gaps:\n${gaps}` : ''}\n\n${last ? 'That was the last review. Close what you can, then report and say plainly what is still not met.' : 'Close them, then finish: the review runs again.'}`);
              return true;
            }
          }
        } finally {
          // Even a last review that could not give a verdict ends the brief's hold on the goal.
          if (last && this.meta.goal === g) this.releaseBriefGoal();
        }
      }
      // A lasting rule the user stated, or "noted" in the answer, and no note saved this turn: one word to keep it.
      // A model answered "以后都用中文回你，记下了。" and saved nothing, twice of two (2026-11-05).
      const claims = CLAIMS_NOTE.test(text);
      if (!memoryNudged && this.role === 'main' && !this.pending.length && (claims || statesStandingRule(this.turnUserText())) && !this.turnCalled(this.toolName('remember'))) {
        memoryNudged = true;
        note(`The user's message says something meant to hold beyond this task${claims ? ', and your answer says it is noted' : ''}, but no note was saved this turn. Save it now with ${this.toolName('remember')}, in the scope it is true in (project or global), and replace a saved note it contradicts; or say in one line that a saved note already holds it or that it was only for this task.`, true);
        memoryReplyTo = answerMessageId;
        return true;
      }
      // A turn of work that ends asking leave to go on, or announcing its next step: one word to go on, so the user is not
      // left to send "继续". A question that is the user's to answer comes back as one line and ends the turn.
      const tail = text.slice(-400);
      if (!stallNudged && this.role === 'main' && !this.pending.length && this.meta.mode !== 'plan' && this.turnWorked() && (ASKS_TO_GO_ON.test(tail) || SAYS_NEXT.test(tail))) {
        stallNudged = true;
        note(
          'Your answer asks whether to go on, or says what you will do next. That work is yours to do now: do it, then report. Stop for the user only for what they alone can decide, a matter of taste, money, a step that cannot be undone or facts only they have, and then name it in one line.',
        );
        return true;
      }
      // On a run of its own, the agent's own open criteria still get a word. A brief's goal
      // has its reviews instead.
      const open = openCriteria(this.meta.goal);
      if (open.length && this.meta.goal?.by !== 'brief' && this.role === 'main' && !this.pending.length && this.autonomous && goalNudges < 2) {
        goalNudges++;
        note(
          `Your criteria still have open items:\n${open.map((c) => `${c.n}. ${c.text}`).join('\n')}\nFinish them, and mark the ones you have met with ${this.toolName('goal')}. If the user's latest message only asked something or changed course, or a criterion cannot be met now, say so in a line instead.`,
          true,
        );
        return true;
      }
      if (this.pending.length) {
        const p = this.pending.slice();
        for (const input of p) this.releaseBriefForUserInput(input.text);
        const qNotes = this.takeNotes();
        let runningExtra = this.calibrator.adjust(qNotes.reduce((n, part) => n + estimatePartTokens(part), 0));
        const queuedParts: Part[] = [...qNotes];
        const msgIndex = this.messages.length;
        for (const x of p) {
          const reg = x.images.length ? await this.registerUserImages(x.images) : [];
          runningExtra += this.calibrator.adjust(reg.reduce((n, part) => n + estimatePartTokens(part), 0));
          const fitted = this.fitInboundText(x.text, runningExtra, msgIndex);
          const textPart: TextPart = { type: 'text', text: fitted.text, ...(fitted.textBlob ? { textBlob: fitted.textBlob } : {}) };
          runningExtra += this.calibrator.adjust(estimatePartTokens(textPart));
          queuedParts.push(textPart, ...reg);
        }
        this.push({
          id: newId('m'),
          role: 'user',
          origin: 'user',
          parts: queuedParts,
          time: Date.now(),
          turn: this.turn,
        }, p);
        this.roundsSinceUser = 0;
        bookkeepingNote = false;
        return true;
      }
      return false;
    };
    for (let step = 0; ; step++) {
      if (signal.aborted) return 'aborted';
      if (step >= maxSteps) {
        this.emit({ type: 'notice', level: 'warn', text: `Stopped after ${maxSteps} steps.` });
        return 'max_steps';
      }
      this.maybePrune();
      const dropStart = this.maybeDropImages(signal);
      if (dropStart) await dropStart;
      this.maybeDraft();
      // A compaction asked for by hand during the turn runs here, between steps, where every call has its result.
      // On the first step of a user turn (`roundsSinceUser === 0`), let the model read the new message once before
      // mid-turn auto-compaction unless the prompt already crosses `hardLimit`.
      const asked = this.compactAsked;
      const hardLimit = this.budget.window - this.budget.maxOutput;
      if (asked) {
        this.compactAsked = null;
        asked.resolve(await this.compactNow('manual'));
      } else if ((this.roundsSinceUser > 0 || this.contextTokens > hardLimit) && this.shouldCompact() && !(await this.useDraft())) await this.compactNow('auto');

      const askedBookkeeping = bookkeepingNote;
      bookkeepingNote = false;
      const res = await this.callModel(signal);
      this.steps++;
      if (res.repeating !== undefined) {
        // The looping reply was dropped whole: none of it reaches the history, and the model hears why.
        if (++repeats > 2) {
          this.emit({ type: 'notice', level: 'warn', text: 'Stopped: the model kept falling into repeating the same text.', key: 'Stopped: the model kept falling into repeating the same text.' });
          return 'error';
        }
        this.emit({ type: 'notice', level: 'warn', text: 'The model began repeating the same text over and over; that reply was stopped and dropped.', key: 'The model began repeating the same text over and over; that reply was stopped and dropped.' });
        this.push(this.harnessMessage(`Your last reply was stopped and dropped: it began repeating the same text over and over (${JSON.stringify(oneLine(res.repeating, 80))}). Do that step again without the repetition; where many similar lines are needed, write a few, or generate them with a short script.`));
        continue;
      }
      const calls = res.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
      this.reserveCallIds(calls);
      // A new user message or actual work needs a fresh report; a reply about saved notes does not.
      if (this.pending.length || calls.some((c) => !this.bookkeeping(c))) memoryReplyTo = undefined;
      const assistant: Message = {
        id: res.messageId,
        role: 'assistant',
        parts: res.parts,
        time: Date.now(),
        provider: this.model.provider,
        model: this.model.id,
        usage: res.usage,
        stop: res.stop,
        ...(res.wait ? { wait: res.wait } : {}),
        refusal: res.refusal,
        turn: this.turn,
        ...(memoryReplyTo ? { supplementTo: memoryReplyTo } : {}),
      };
      if (res.parts.length || res.stop === 'refusal') this.push(assistant);
      this.refreshUsage();

      if (res.stop === 'aborted') {
        if (calls.length) this.push(this.resultsMessage(calls.map((c) => this.cancelled(c, 'Interrupted by the user before it ran.')), []));
        return 'aborted';
      }
      if (res.stop === 'refusal') {
        this.emit({ type: 'notice', level: 'warn', text: `The model declined: ${res.refusal ?? 'no reason given'}` });
        return 'refusal';
      }
      if (res.stop === 'pause') continue;

      if (!calls.length) {
        const text = res.parts.filter((p) => p.type === 'text').map((p) => (p as TextPart).text).join('');
        if (res.stop === 'cut') {
          // A reply the connection cut is never the answer: it goes on, or the turn ends saying it was cut.
          if (cutContinuations < 4) {
            cutContinuations++;
            this.push(this.harnessMessage('The connection dropped while your reply was being written; what arrived is kept above. Continue exactly where it stopped, without repeating anything.'));
            continue;
          }
          this.emit({ type: 'notice', level: 'error', text: 'The connection kept dropping in the middle of the reply; what arrived is kept above. Send a message to go on.', key: 'The connection kept dropping in the middle of the reply; what arrived is kept above. Send a message to go on.' });
          return 'error';
        }
        if (res.stop === 'max_tokens' && continuations < 2) {
          continuations++;
          this.push(this.harnessMessage('Your reply hit the output limit. Continue exactly where it stopped, without repeating anything.'));
          continue;
        }
        const frontier = ['claude', 'gpt', 'gemini'].includes(this.model.family);
        if (!textToolNudged && !frontier && /<tool_call>|<function=|"(name|tool)"\s*:\s*"[A-Za-z_]+"\s*,\s*"(arguments|parameters|input)"/.test(text)) {
          textToolNudged = true;
          this.push(this.harnessMessage('Your last message contains a tool call written as text, so it did not run. Call tools through the tool-calling interface.'));
          continue;
        }
        if (!text.trim() && !emptyNudged) {
          emptyNudged = true;
          this.push(this.harnessMessage('Your last response was empty. Continue the task: call a tool, or give your final answer.'));
          continue;
        }
        if (!memoryReplyTo) {
          answer = text;
          answerMessageId = assistant.id;
        }
        if (await endChecks(answer ?? text)) continue;
        return 'done';
      }

      const results = await this.executeTools(calls, signal, res.stop === 'max_tokens' ? 'limit' : res.stop === 'cut' ? 'connection' : false);
      const extras: Part[] = [...this.takeNotes()];
      if (this.backgroundDone.length) extras.push({ type: 'text', text: this.takeBackgroundReports(), synthetic: true });
      // Interrupted: the model will not see this step's results, so waiting messages go back to the user instead.
      const finish = signal.aborted ? null : await this.finishNote(results);
      const read = signal.aborted ? [] : this.pending.slice();
      let midExtra = this.calibrator.adjust(
        [...results, ...extras].reduce((n, part) => n + estimatePartTokens(part), 0),
      );
      const midMsgIndex = this.messages.length;
      for (const p of read) {
        this.releaseBriefForUserInput(p.text);
        // Read as the user means it: a question on the way is answered and the work goes on, but "tell me first" waits,
        // since the user wants the plan before the change, and a stop keeps what is done (measured: told only to go on,
        // the agent explained and carried on editing; told "先别改代码", it undid its edits).
        const reg = p.images.length ? await this.registerUserImages(p.images) : [];
        midExtra += this.calibrator.adjust(reg.reduce((n, part) => n + estimatePartTokens(part), 0)) + 90;
        const fitted = this.fitInboundText(p.text, midExtra, midMsgIndex);
        const notePart: TextPart = {
          type: 'text',
          text: `The user sent this while you were working. Take it as they mean it. A question asked on the way: answer it in a sentence or two and go on with the work. New information or a change of plan: follow it and go on. Told to stop, wait or hold off, or asked to explain something before you do it ("先说说你打算怎么改"): stop there without undoing what is done unless they ask for that, answer, say where things stand, and wait for their word.\n${fitted.text}`,
          synthetic: true,
          said: fitted.text,
          ...(fitted.textBlob ? { saidBlob: fitted.textBlob } : {}),
        };
        midExtra += this.calibrator.adjust(estimatePartTokens(notePart));
        extras.push(notePart, ...reg);
      }
      extras.push(...this.reminders(calls, results, askedBookkeeping));
      if (finish) extras.push(finish);
      this.push(this.resultsMessage(results, extras), read);
      if (signal.aborted) return 'aborted';
      if (this.looping()) {
        this.emit({ type: 'notice', level: 'warn', text: 'Stopped: the agent kept repeating the same action.' });
        return 'error';
      }
      // Asked at the end of the turn only to mark criteria or save a lesson, and the model did just that without a
      // word: its answer from before the note stands, so the remaining checks run on it instead of asking again.
      const said = res.parts.some((p) => p.type === 'text' && p.text.trim());
      if (askedBookkeeping && answer !== undefined && (memoryReplyTo || !said) && !read.length && calls.every((c) => this.bookkeeping(c)) && results.every((r) => !r.isError)) {
        if (await endChecks(answer)) continue;
        return 'done';
      }
    }
  }

  /** Whether a tool of this name was called since the user's latest message. */
  private turnCalled(name: string): boolean {
    let from = this.messages.length - 1;
    while (from > 0 && !(this.messages[from].role === 'user' && this.messages[from].origin === 'user')) from--;
    return this.messages.slice(from).some((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'tool_call' && p.name === name));
  }

  /** Whether the agent called any tool since the user's latest message. */
  private turnWorked(): boolean {
    let from = this.messages.length - 1;
    while (from > 0 && !(this.messages[from].role === 'user' && this.messages[from].origin === 'user')) from--;
    return this.messages.slice(from).some((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'tool_call'));
  }

  /** What the user wrote in this turn. */
  private turnUserText(): string {
    return this.messages
      .filter((m) => m.turn === this.turn && m.role === 'user' && m.origin === 'user')
      .flatMap((m) => m.parts)
      .map((p) => (p.type === 'text' && !p.synthetic ? fullText(p, this.deps.store.blobs) : ''))
      .join('\n');
  }

  private languageServers(): LanguageServers | null {
    if (this.config.languageServers === false) return null;
    return (this.lsp ??= new LanguageServers(this.meta.cwd));
  }

  /**
   * After an edit, the type errors the language server now sees in the changed files (when no syntax error was
   * found already); after a read, the server for the file is started, so the first check does not wait.
   */
  /** The files a call names. */
  private filesOf(input: any): string[] {
    return typeof input?.path === 'string'
      ? [resolvePath(this.meta.cwd, input.path)]
      : Array.isArray(input?.paths)
        ? input.paths.map((p: string) => resolvePath(this.meta.cwd, String(p).replace(/:\d+(?:-\d+)?$/, '')))
        : typeof input?.patch === 'string'
          ? [...input.patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((m: RegExpMatchArray) => resolvePath(this.meta.cwd, m[1].trim()))
          : [];
  }

  private async typeCheck(kind: string, input: any, content: string): Promise<string> {
    const earlier = this.changedInReply.splice(0);
    const servers = this.languageServers();
    if (!servers) return '';
    const files = [...new Set([...earlier, ...this.filesOf(input)])];
    const covered = files.filter((f) => servers.covers(f)).slice(0, 4);
    if (!covered.length) return '';
    if (kind === 'read') {
      for (const f of covered) servers.warm(f);
      return '';
    }
    if (!(kind === 'write' || kind === 'edit' || kind === 'patch') || content.includes('Syntax errors in')) return '';
    const notes: string[] = [];
    for (const f of covered) {
      const r = await servers.errors(f, 4000);
      if (!r) continue;
      const shown = displayPath(this.meta.cwd, f);
      if (!r.diagnostics.length) notes.push(`${r.server}: no errors in ${shown}.`);
      else
        notes.push(
          `${r.server} reports ${r.diagnostics.length} error${r.diagnostics.length === 1 ? '' : 's'} in ${shown} now:\n${r.diagnostics
            .slice(0, 8)
            .map((d) => `  ${d.line}:${d.column} ${d.message}`)
            .join('\n')}${r.diagnostics.length > 8 ? `\n  … ${r.diagnostics.length - 8} more` : ''}`,
        );
    }
    return notes.length ? `\n\n${notes.join('\n')}` : '';
  }

  /** Computer control: only when the user turned it on, on Windows, and never in a confined run, whose agent is
   *  under test and must not drive the user's desktop (the browser follows the same rule below). */
  private get computerOn(): boolean {
    return !!this.config.computer && process.platform === 'win32' && !this.config.confine;
  }

  /** Headless tools (including paint) cannot inherit a window or attach to an interactive browser profile. */
  private get browserSettings(): NonNullable<FavillaConfig['browser']> {
    return this.interactive && !this.config.confine ? this.config.browser ?? {} : {};
  }

  /** The session's browser, started on first use and closed with the session. */
  private browser(): BrowserSession | null {
    const b = this.browserSettings;
    // Settings changed since this session's browser started (keep logins turned on, a window asked for, another
    // browser or proxy): the next browser call starts one the new way instead of keeping the old.
    const mode = JSON.stringify([!!b.visible, !!b.keepLogins, b.use ?? 'favilla', this.config.browserPath ?? '', this.config.proxy ?? '']);
    this.browserUsedAt = Date.now();
    if (this.browserSession && this.browserMode === mode) return this.browserSession;
    this.browserSession?.close();
    this.browserSession = null;
    this.browserMode = mode;
    // The user's own Edge or Chrome, as they have it open: attached to, never started.
    const attachDir = b.use === 'edge' || b.use === 'chrome' ? userBrowserDir(b.use) : undefined;
    const exe = findBrowser(this.config.browserPath);
    if (!exe && !attachDir) return null;
    return (this.browserSession = new BrowserSession(exe ?? '', this.config.proxy ?? envProxy() ?? false, {
      visible: !!b.visible,
      // Favilla's own profile, never the user's: signing in there once is remembered for later sessions.
      profileDir: b.keepLogins || b.visible ? appPath('browser-profile') : undefined,
      downloadDir: path.join(this.dataDir, 'downloads'),
      attachDir,
    }));
  }

  /**
   * Close the agent's own headless browser once it has gone unused for a while between turns. A window on screen
   * (the user may be looking at it) and the user's own Edge or Chrome (only tabs of ours are in it) are left alone.
   */
  private closeBrowserWhenIdle(): void {
    clearTimeout(this.browserIdle);
    const b = this.browserSettings;
    if (!this.browserSession || b.visible || b.use === 'edge' || b.use === 'chrome') return;
    const wait = Math.max(1000, this.browserUsedAt + BROWSER_IDLE_MS - Date.now());
    this.browserIdle = setTimeout(() => {
      if (this.status !== 'idle' || !this.browserSession) return;
      if (Date.now() - this.browserUsedAt < BROWSER_IDLE_MS) return this.closeBrowserWhenIdle();
      this.browserSession.close();
      this.browserSession = null;
      debug('browser', 'closed an idle headless browser', this.id);
    }, wait);
    this.browserIdle.unref?.();
  }

  /** The name this session's tool surface gives a kind of tool (the goal tool is "goal" everywhere today). */
  private toolName(kind: string): string {
    return this.bindings.find((b) => b.def.kind === kind)?.spec.name ?? kind;
  }

  private harnessMessage(text: string): Message {
    return { id: newId('m'), role: 'user', origin: 'harness', parts: [{ type: 'text', text: `<harness-note>${text}</harness-note>`, synthetic: true }], time: Date.now(), turn: this.turn };
  }

  private resultsMessage(results: ToolResultPart[], extras: Part[]): Message {
    return { id: newId('m'), role: 'user', origin: 'tool', parts: [...results, ...extras], time: Date.now(), turn: this.turn };
  }

  /** A provider may reuse an id, even within one reply. Keep the first and give every other call its own result key. */
  private reserveCallIds(calls: ToolCallPart[]): void {
    if (!calls.length) return;
    const used = this.callIds ??= new Set(this.messages.flatMap((m) => m.parts.flatMap((p) => p.type === 'tool_call' ? [p.id] : [])));
    const incoming = new Set(calls.map((c) => c.id));
    for (const call of calls) {
      if (used.has(call.id)) {
        do { call.id = newId('call_'); } while (used.has(call.id) || incoming.has(call.id));
        // The provider's item still names the original call id. A rewritten call must be sent as a fresh item.
        if (call.meta?.itemId) delete call.meta.itemId;
      }
      used.add(call.id);
    }
  }

  private cancelled(call: Pick<ToolCallPart, 'id' | 'name'>, why: string): ToolResultPart {
    return { type: 'tool_result', callId: call.id, name: call.name, content: why, isError: true };
  }

  // ── model calls ──────────────────────────────────────────────────────────

  private providerCall(messages: Message[], signal: AbortSignal, overrides: Partial<ProviderCall> = {}): ProviderCall {
    const provider = this.deps.catalog.provider(this.model.provider);
    // Every call answered and every result beside its call, in what is sent (see pairToolCalls).
    const paired = pairToolCalls(messages);
    const desiredMaxOut = overrides.maxOutputTokens ?? this.budget.maxOutput;
    let maxOutputTokens = desiredMaxOut;
    if (provider.api !== 'anthropic') {
      const msgTok = paired.messages.reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0);
      const baseEst =
        overrides.system !== undefined
          ? estimateTokens(overrides.system) + this.calibrator.adjust(msgTok)
          : this.estimatePrefix() + this.calibrator.adjust(msgTok);
      const liveEst =
        overrides.system === undefined && messages.length >= this.active().length
          ? this.contextTokens + (messages.length > this.active().length ? this.calibrator.adjust(estimateMessageTokens(messages.at(-1)!)) : 0)
          : 0;
      const estInput = Math.max(baseEst, liveEst);
      const unanchoredMargin = overrides.system === undefined ? Math.ceil(this.calibrator.adjust(this.sinceAnchor) * 0.25) : 0;
      const safety = Math.max(1024, Math.floor(this.budget.window * 0.02)) + unanchoredMargin;
      const room = Math.max(1024, this.budget.window - estInput - safety);
      maxOutputTokens = Math.min(desiredMaxOut, room);
    }
    return {
      model: this.model,
      provider,
      system: this.system,
      tools: this.specs,
      hostedSearch: this.search === 'hosted',
      // Copy sites left out of the hosted search too, until the provider says it does not take the filter.
      ...(this.search === 'hosted' && !this.searchFilterRefused ? { hostedSearchBlocked: COPY_SITES } : {}),
      messages: paired.messages.map(sendable),
      // The level the user set, on every request: a level changed mid-turn costs the whole prompt cache, and the
      // owner sets it by hand when a job needs more (2026-11-02).
      effort: this.meta.effort,
      sessionId: this.id,
      cacheKey: this.cacheGroup,
      turnId: this.turn || this.id,
      signal,
      ...overrides,
      maxOutputTokens,
      turnStart: paired.at(overrides.turnStart ?? this.turnStartIndex()),
    };
  }

  /** One model request with streaming, retries, stall detection and overflow recovery. */
  private async callModel(signal: AbortSignal): Promise<ProviderResult & { messageId: string; repeating?: string; cutAt?: number; wait?: RequestWait }> {
    let overflowHandled = false;
    let effortHandled = false;
    let cutNoted = false;
    let shrinks = 0;
    let firstBegan = 0;
    const failed: NonNullable<RequestWait['failed']> = [];
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      // How much of this reply came before a failure, and when it began: a long reply cut off is not a blip.
      let got = 0;
      const began = Date.now();
      if (attempt === 0) firstBegan = began;
      let firstByteMs: number | undefined;
      let firstWordMs: number | undefined;
      let lastWordMs: number | undefined;
      let longestGapMs = 0;
      // Whether the reasoning came as words: when it did not, its tokens took their time before the first word.
      let thought = false;
      const requestWait = (): RequestWait => ({
        tries: attempt + 1,
        lostMs: began - firstBegan,
        ms: Date.now() - began,
        ...(firstByteMs !== undefined ? { firstByteMs } : {}),
        ...(firstWordMs !== undefined ? { firstWordMs } : {}),
        ...(longestGapMs >= 1000 ? { longestGapMs } : {}),
        ...(failed.length ? { failed: failed.slice(-8) } : {}),
      });
      const messageId = newId('m');
      const local = new AbortController();
      const linked = AbortSignal.any([signal, local.signal]);
      const watch = new RepeatWatch();
      let repeating: string | null = null;
      const looped = (key: string, delta: string) => {
        if (repeating === null && (repeating = watch.add(key, delta)) !== null) local.abort();
      };
      const dropped = () => {
        this.emit({ type: 'stream.discard', messageId });
        return { parts: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, stop: 'max_tokens' as const, messageId, repeating: repeating! };
      };
      let stalled = false;
      // What has arrived of this reply, part by part, so a dropped connection need not throw it away (keptParts).
      const sofar = new Map<string, { type: 'text' | 'reasoning' | 'tool'; text: string; id?: string; name?: string }>();
      // Alongside the silence watch, the working line says when the model thinks out of sight. No pop-up.
      let hush: NodeJS.Timeout | undefined;
      let hushed = false;
      const deep = EFFORT_ORDER.indexOf(this.meta.effort) >= EFFORT_ORDER.indexOf('high');
      const quiet = deep ? QUIET_DEEP_MS : QUIET_MS;
      const silence = watchStreamSilence(deep, () => {
        stalled = true;
        local.abort();
      });
      const touch = (word: boolean) => {
        silence.touch(word);
        if (!word) return;
        if (hushed) {
          hushed = false;
          if (this.status === 'running' && this.statusDetail === 'thinking') this.setStatus('running');
        }
        hush = hush?.refresh() ?? setTimeout(() => {
          hushed = true;
          if (this.status === 'running' && !this.statusDetail) this.setStatus('running', 'thinking');
        }, quiet);
      };
      const quietDone = () => {
        silence.close();
        clearTimeout(hush);
        hush = undefined;
        if (hushed && this.status === 'running' && this.statusDetail === 'thinking') this.setStatus('running');
      };
      touch(true);
      const draft = { messageId, parts: new Map<number, StreamDraft['parts'][number]>() };
      this.streamDraft = draft;
      let messages: Message[] | undefined;
      let placed: ReturnType<Session['placed']> | undefined;
      try {
        this.emit({ type: 'stream.start', messageId, model: this.model.id });
        // Pictures past what this provider takes leave the request, the oldest first (a session full of screenshots).
        const outPics = this.fitOutboundPictures(this.active());
        messages = Array.isArray(outPics) ? outPics : await outPics;
        const estimated = this.estimatePrefix() + messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
        placed = this.placed(messages);
        // The reply goes on from a prefill, so what was said starts with it.
        let lead = placed.continued ?? '';
        const res = await adapterFor(this.deps.catalog.provider(this.model.provider).api).stream(this.providerCall(placed.messages, linked, { channel: 'main', turnStart: placed.turnStart }), (e) => {
          const elapsed = Date.now() - began;
          firstByteMs ??= elapsed;
          const word = isStreamWord(e);
          if (word) {
            firstWordMs ??= elapsed;
            if (lastWordMs !== undefined) longestGapMs = Math.max(longestGapMs, elapsed - lastWordMs);
            lastWordMs = elapsed;
          }
          touch(word);
          if (e.type === 'alive') return;
          if ('delta' in e && typeof e.delta === 'string') got += e.delta.length;
          if (e.type === 'text' || e.type === 'reasoning' || e.type === 'tool') {
            const key = `${e.type}:${e.index}`;
            const kept = sofar.get(key) ?? { type: e.type, text: '' };
            kept.text += e.delta;
            if (e.type === 'tool') {
              if (e.id) kept.id = e.id;
              if (e.name) kept.name = e.name;
            }
            sofar.set(key, kept);
            // The view records exactly what the front end sees, including the lead that sofar leaves out.
            const shown = draft.parts.get(e.index);
            const before = shown?.text ?? '';
            const delta = e.type === 'text' ? lead + e.delta : e.delta;
            const part = { index: e.index, text: before + delta };
            // A piece that comes without the call's name or id keeps the ones an earlier piece gave, as sofar does.
            const call = shown?.kind === 'tool' ? shown : undefined;
            draft.parts.set(e.index, e.type === 'tool' ? { ...part, kind: e.type, id: e.id || (call?.id ?? ''), name: e.name || (call?.name ?? '') } : { ...part, kind: e.type });
            const piece = { messageId, index: e.index, at: before.length, delta };
            if (e.type === 'text') {
              this.emit({ type: 'stream.text', ...piece });
              lead = '';
            } else if (e.type === 'reasoning') {
              thought ||= e.delta.length > 0;
              this.emit({ type: 'stream.reasoning', ...piece });
            }
            else this.emit({ type: 'stream.tool', ...piece, id: e.id, name: e.name });
            looped(key, e.delta);
          } else if (e.type === 'meta' && e.key === 'plan') this.usage = { ...this.usage, plan: e.value as SessionUsage['plan'] };
        });
        this.streamDraft = null;
        quietDone();
        if (repeating !== null && !signal.aborted) return dropped();
        if (stalled && !signal.aborted) throw new ProviderError('stream_stalled', 'The response stalled; retrying.');
        this.emit({ type: 'stream.end', messageId });
        // How long it took, for the speed on Settings > Usage: tokens over the time from the first word to the end.
        const timing = { ms: Date.now() - began, ...(firstWordMs !== undefined ? { waitMs: firstWordMs } : {}), ...(res.usage.reasoning > 0 && !thought ? { hidden: true as const } : {}) };
        this.recordUsage(res.usage, estimated, this.model, 'main', timing);
        if (placed.continued) {
          const first = res.parts.find((p): p is TextPart => p.type === 'text');
          if (first) first.text = placed.continued + first.text;
          else res.parts.unshift({ type: 'text', text: placed.continued });
        }
        return { ...res, messageId, ...(res.stop === 'aborted' ? {} : { wait: requestWait() }) };
      } catch (e) {
        this.streamDraft = null;
        quietDone();
        if (!messages || !placed) throw e;
        if (repeating !== null && !signal.aborted) return dropped();
        if (signal.aborted) {
          this.emit({ type: 'stream.discard', messageId });
          return { parts: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, stop: 'aborted', messageId };
        }
        // A stream Favilla gave up as dead ends in whatever the adapter makes of the abort (an "aborted" error that is
        // never tried again): it is a stall, and a stall is asked again.
        const err = stalled ? new ProviderError('stream_stalled', 'The response stalled; retrying.', { retryable: true }) : e instanceof ProviderError ? e : new ProviderError('unknown', (e as Error).message, { retryable: false });
        debug('provider', `${this.model.provider}/${this.model.id} attempt ${attempt + 1} failed`, { kind: err.kind, status: err.status, message: err.message });
        // A connection dropped well into a reply: what arrived is kept as a reply cut short, and the turn goes on from
        // it (the text continued, complete calls run, a new file's complete lines written), where it was all thrown away
        // and asked again: on one relay, 39 of 1,275 eval sessions since 2026-11-01 lost long replies so, 14,800
        // characters each on average, and a relay that drops long streams drops the next try at the same length.
        if ((err.kind === 'network' || err.kind === 'unknown' || err.kind === 'stream_stalled') && got >= KEEP_CUT_AT) {
          const parts = this.keptParts(sofar, placed.continued);
          if (parts) {
            this.emit({ type: 'stream.end', messageId });
            return { parts, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, stop: 'cut', messageId, cutAt: got, wait: requestWait() };
          }
        }
        failed.push({ kind: err.kind, ...(err.status !== undefined ? { status: err.status } : {}), ms: Date.now() - began, got });
        this.emit({ type: 'stream.discard', messageId });
        if (err.kind === 'context_overflow' && !overflowHandled) {
          overflowHandled = true;
          // The server took less than the window this model is set to: plan for a tenth under what it refused,
          // for the rest of the session, so the next turns compact in time instead of hitting the wall again.
          const refused = this.contextTokens;
          const learned = Math.floor(refused * 0.9);
          if (learned > 8192 && learned < this.budget.window) {
            // A window that was only assumed, and not set by hand over the guess: later sessions start from this.
            if (this.model.windowAssumed && this.model.contextWindow === this.model.nativeWindow) this.deps.catalog.learnWindow(this.model.ref, learned);
            this.model = { ...this.model, contextWindow: learned };
            this.budget = computeBudget(this.model, this.config);
            this.refreshUsage();
          }
          this.emit({ type: 'notice', level: 'warn', text: 'The conversation no longer fits the context window; compacting.' });
          await this.compactNow('overflow');
          continue;
        }
        // A body refused for its size: the same request would be refused again. Its pictures are halved for this
        // provider from now on, as many times as that helps; when pictures are not what makes it large, the
        // conversation is compacted, once.
        if (err.kind === 'too_large' && shrinks < 4) {
          shrinks++;
          const carried = pictureBytes(messages);
          if (carried > PICTURE_FLOOR) {
            const budget = learnPictureBudget(this.model.provider, carried);
            this.emit({ type: 'notice', level: 'warn', text: `The request was too large for ${this.model.provider}; older pictures stay out of its requests from now on (at most ${(budget / 1e6).toFixed(1)} MB of them).`, key: 'The request was too large for this provider; older pictures stay out of its requests from now on.' });
            continue;
          }
          if (!overflowHandled) {
            overflowHandled = true;
            this.emit({ type: 'notice', level: 'warn', text: 'The request was too large for this provider; compacting.', key: 'The request was too large for this provider; compacting.' });
            await this.compactNow('overflow');
            continue;
          }
        }
        if (err.kind === 'invalid_request' && placed.continued && !this.prefillRefused && /prefill|must end with a user|final .?assistant|trailing assistant|ends? with an? assistant/i.test(`${err.message}\n${err.body ?? ''}`)) {
          this.prefillRefused = true;
          this.emit({ type: 'notice', level: 'info', text: 'This model does not continue from a prefill; it is asked to begin with that text instead.', key: 'This model does not continue from a prefill; it is asked to begin with that text instead.' });
          continue;
        }
        if (err.kind === 'invalid_request' && this.search === 'hosted' && !this.searchFilterRefused && /filters|blocked_domains/i.test(`${err.message}\n${err.body ?? ''}`)) {
          this.searchFilterRefused = true;
          debug('provider', 'the hosted search does not take blocked_domains: sent without it from now on', { message: err.message });
          continue;
        }
        if (err.kind === 'invalid_request' && !this.systemRefused && placed.messages.some((m) => m.asSystem) && /system|developer/i.test(`${err.message}\n${err.body ?? ''}`)) {
          this.systemRefused = true;
          this.emit({ type: 'notice', level: 'info', text: 'This provider takes no system messages inside a conversation; the preset\'s go as user messages.', key: 'This provider takes no system messages inside a conversation; the preset\'s go as user messages.' });
          continue;
        }
        if (err.kind === 'invalid_request' && !effortHandled && this.model.efforts.length) {
          const sent = this.meta.effort;
          const refusal = effortRefusal(`${err.message}\n${err.body ?? ''}`, sent === 'off' ? ['none', 'off'] : [sent === 'ultra' ? 'max' : sent]);
          if (refusal) {
            effortHandled = true;
            this.takeEffortRefusal(refusal, sent);
            continue;
          }
        }
        // With the user here, a provider that is down is reported after a few quick tries: a relay that went down on
        // 2026-11-02 took 184 s of retries for each request to fail. Nobody waits on an autonomous run, a
        // headless run or a sub-agent, so those keep trying; so does a server that says how long to wait.
        const present = this.interactive && !this.autonomous && this.role === 'main';
        const outage = err.kind === 'overloaded' || err.kind === 'server' || err.kind === 'network' || err.kind === 'stream_stalled';
        if (present && err.kind === 'model_not_found') throw new ProviderError(err.kind, err.message, { status: err.status, retryable: false });
        if (err.retryable && present && outage && !err.retryAfterMs && attempt >= PRESENT_RETRIES) {
          throw new ProviderError(err.kind, `${err.message} (no answer after ${attempt + 1} tries: the service may be down; try again in a while or pick another model)`, { status: err.status, retryable: false });
        }
        // A rate limit passes with time (a relay's tokens per minute), so it is waited out longer than other failures:
        // seven tries (about three minutes) ended 2 of 10 tasks on a relay that turned away half its requests (2026-11-04).
        // An outage is too, with nobody waiting (triesFor).
        const most = triesFor(err.kind, present);
        if (!err.retryable || attempt >= most) throw err;
        // A connection cut after a long reply (a relay that drops long streams: a request on 2026-11-02 wrote one big
        // script seven times over, 36k tokens, and every try was cut) is not tried the same way again: the model is
        // told once to write in parts.
        if (!cutNoted && (err.kind === 'network' || err.kind === 'unknown' || err.kind === 'stream_stalled') && (got > 4000 || Date.now() - began > 90_000)) {
          cutNoted = true;
          this.push(this.harnessMessage(`The connection was cut while your last reply was being written (${got} characters in, ${Math.round((Date.now() - began) / 1000)} s): this provider drops replies that run long. Keep each reply short. Write a big file in parts of about 150 lines: create it with the first part, then add the rest with edits, one part per call.`));
        }
        // A dropped connection is tried again at once and without a notice: a blip is not news. Only a second
        // failure in a row, or a server that says to wait, is shown.
        const quiet = attempt === 0 && (err.kind === 'network' || err.kind === 'stream_stalled') && !err.retryAfterMs;
        const delay = quiet ? 300 : Math.min(err.retryAfterMs ?? 1500 * 2 ** attempt, 90_000) + Math.random() * 500;
        // Counted against the tries this request gets: a user waiting on a provider that is down had read "(2/7)" and
        // then a failure after three.
        const tries = present && outage && !err.retryAfterMs ? PRESENT_RETRIES + 1 : most + 1;
        const shown = `${attempt + 1}/${tries}`;
        if (!quiet) this.emit({ type: 'notice', level: 'warn', text: `${err.message} — retrying in ${Math.round(delay / 1000)}s (${shown}).`, key: RETRY_NOTICES[err.kind] ?? RETRY_NOTICES.server, arg: shown });
        this.setStatus('running', 'retrying');
        await sleep(delay, signal);
      }
    }
  }

  /**
   * What had arrived of a reply when its connection dropped, as the parts of a reply cut short: its text, its tool
   * calls (their arguments closed by repair and marked cut where they stopped) and, where the API takes reasoning
   * back as plain text, its reasoning. Null when the reasoning came with a signature or an encrypted body, which a
   * cut cannot give back, and when nothing worth keeping arrived: the request is then asked again as before.
   */
  private keptParts(sofar: Map<string, { type: 'text' | 'reasoning' | 'tool'; text: string; id?: string; name?: string }>, continued?: string): Part[] | null {
    const api = this.deps.catalog.provider(this.model.provider).api;
    const plainReasoning = api === 'openai-chat' && (this.model.quirks.reasoningField ?? 'reasoning_content') !== 'reasoning_details';
    // Elsewhere a model that reasons may have sent its reasoning as a signed or encrypted body with no words to see,
    // which the next request must carry back whole: nothing of its reply is kept.
    if (!plainReasoning && this.model.efforts.length && this.meta.effort !== 'off') return null;
    const parts: Part[] = [];
    let lead = continued ?? '';
    for (const s of sofar.values()) {
      if (s.type === 'reasoning') {
        if (!s.text) continue;
        if (!plainReasoning) return null;
        parts.push({ type: 'reasoning', text: s.text, provider: this.model.provider, model: this.model.id });
      } else if (s.type === 'text') {
        const text = lead + s.text;
        lead = '';
        if (text.trim()) parts.push({ type: 'text', text });
      } else if (s.id && s.name) {
        const parsed = parseToolArgs(s.text);
        parts.push({ type: 'tool_call', id: s.id, name: s.name, input: parsed.value, raw: s.text, ...(parsed.error ? { parseError: parsed.error } : {}), ...(parsed.cut ? { cut: parsed.cut } : {}) });
      }
    }
    return parts.some((p) => p.type === 'text' || p.type === 'tool_call') ? parts : null;
  }

  // ── tools ────────────────────────────────────────────────────────────────

  private binding(name: string): ToolBinding | undefined {
    return this.bindings.find((b) => b.spec.name === name) ?? this.bindings.find((b) => b.spec.name.toLowerCase() === name.toLowerCase());
  }

  /** `truncated`: the reply these calls came in was cut short, by the output limit or by a dropped connection. */
  private async executeTools(calls: ToolCallPart[], signal: AbortSignal, truncated: 'limit' | 'connection' | false): Promise<ToolResultPart[]> {
    // Nothing changes the folder before its snapshot for this turn is taken.
    if (this.pointTaken) await this.pointTaken;
    const results: ToolResultPart[] = new Array(calls.length);
    let i = 0;
    while (i < calls.length) {
      if (signal.aborted) {
        for (let k = i; k < calls.length; k++) results[k] = this.cancelled(calls[k], 'Interrupted by the user before it ran.');
        break;
      }
      if (this.parallelSafe(calls[i])) {
        let j = i;
        // One check to a batch: two test runs at once would compete for the same ports, caches and cores. Four
        // sub-agents, like the background limit: past that they queue on the provider and only cost more.
        let checks = 0;
        let agents = 0;
        const full = (c: ToolCallPart) => {
          const kind = this.binding(c.name)?.def.kind;
          return (kind === 'check' && checks++ > 0) || (kind === 'task' && agents++ >= 4);
        };
        while (j < calls.length && this.parallelSafe(calls[j]) && !full(calls[j])) j++;
        const batch = calls.slice(i, j);
        const out = await Promise.all(batch.map((c) => this.runTool(c, signal, truncated)));
        out.forEach((r, k) => (results[i + k] = r));
        i = j;
      } else {
        // Several changes in one reply: type errors are read once, after the last, when the files are as meant.
        results[i] = await this.runTool(calls[i], signal, truncated, this.changesFiles(calls[i]) && i + 1 < calls.length && this.changesFiles(calls[i + 1]));
        i++;
      }
    }
    return results;
  }

  /**
   * Calls that keep track of the work without doing any: ticking the goal's criteria, the plan, saved notes. A goal
   * call that sets a new objective or new criteria plans more work, so it is not one of them.
   */
  private bookkeeping(call: ToolCallPart): boolean {
    const kind = this.binding(call.name)?.def.kind;
    if (kind === 'todo') return true;
    if (kind !== 'goal') return false;
    const input = (call.input ?? {}) as { objective?: unknown; criteria?: unknown; clear?: unknown };
    return !input.objective && !(Array.isArray(input.criteria) && input.criteria.length) && !input.clear;
  }

  private changesFiles(call: ToolCallPart): boolean {
    return ['write', 'edit', 'patch'].includes(this.binding(call.name)?.def.kind ?? '');
  }

  /** Reads, searches, fetches and research sub-agents run concurrently; anything that changes state runs alone, in order. */
  private parallelSafe(call: ToolCallPart): boolean {
    const b = this.binding(call.name);
    if (!b || b.def.kind === 'ask' || b.def.kind === 'plan') return false;
    // The project's checks run its tests without touching the sources, so the final check and the review of the
    // change can run at the same time instead of one after the other.
    if (b.def.kind === 'check' || b.def === reviewTool) return true;
    if (b.def.kind === 'task') {
      // A general sub-agent beside others needs its files named: its claim keeps them off those. Without a list it
      // claims everything, and attempts merge into the working tree, so those run alone.
      try {
        const task = b.normalize((call.input ?? {}) as Record<string, unknown>) as { agent?: string; files?: string[] };
        return task.agent === 'explore' || (task.agent === 'general' && !!task.files?.length);
      } catch {
        return false;
      }
    }
    // A web tool may control the shared browser page; its explicit mutability wins over the kind.
    return b.def.readOnly;
  }

  private async runTool(call: ToolCallPart, signal: AbortSignal, truncated: 'limit' | 'connection' | false, moreChanges = false): Promise<ToolResultPart> {
    const started = Date.now();
    const b = this.binding(call.name);
    // A held-back tool called before it was loaded runs all the same; its full instructions come with its first result.
    const firstUse = !!b && this.defersTools() && deferred(b.spec.name) && !this.loadedTools.has(b.spec.name);
    if (firstUse) this.loadedTools.add(b.spec.name);
    let inputs: FileVersion[] = [];
    let input: any;
    // A new file whose writing the connection cut off: its complete lines, written (keptLines).
    let kept: { input: Record<string, unknown>; lines: number } | null = null;
    let ran = false;
    const finish = (r: Omit<ToolResultPart, 'type' | 'callId' | 'name'>, seen?: ToolEvidence): ToolResultPart => {
      const result: ToolResultPart = { type: 'tool_result', callId: call.id, name: call.name, durationMs: Date.now() - started, ...r };
      if (kept && !result.isError) result.content += `\nThe connection dropped while you were writing this file: its first ${kept.lines} complete lines are written, and nothing after them. Add the rest from line ${kept.lines + 1} with edits, about 150 lines per call.`;
      result.evidence = seen ?? observeOutcome(b?.def.kind ?? 'unknown', input ?? call.input ?? {}, result, this.meta.cwd, inputs);
      const reads = this.files.shownBy(call.id);
      if (reads.length) result.evidence.reads = reads;
      if (b) this.trackOutcome(call, b, input ?? {}, result);
      if (result.images?.length && !this.model.vision) {
        result.images = undefined;
        result.content += '\n(Images were omitted because this model cannot view them.)';
      }
      // Each picture gets a short name an answer can show it by (![the page on a phone](pic:3f9a2c1b7d4e)): the app
      // draws it there. The name is the start of its id in the blob store, where it goes now so the answer finds it.
      const names = (result.images ?? []).flatMap((img) => {
        if (!img.blob && img.data) img.blob = this.deps.store.blobs.put(Buffer.from(img.data, 'base64'), false);
        return img.blob ? [`pic:${img.blob.slice(0, 12)}`] : [];
      });
      if (names.length) result.content += `\n(${names.length > 1 ? 'Pictures' : 'Picture'} ${names.join(', ')})`;
      if (firstUse && b) result.content += `\n\nThe full instructions of ${b.spec.name}, for your next calls:\n\n${this.toolInstructions([b.spec.name])}`;
      if (ran) this.ranTools.add(result);
      this.runningTools.delete(call.id);
      this.emit({ type: 'tool.end', callId: call.id, result });
      return result;
    };
    let title = call.name;
    try {
      if (!b) throw new ToolInputError(`Unknown tool "${call.name}". Available tools: ${this.specs.map((s) => s.name).join(', ')}.`);
      const cutBy = truncated === 'connection' ? 'the connection dropping mid-reply' : 'the output limit';
      if (call.parseError) {
        throw new ToolInputError(
          truncated
            ? `This tool call was cut off by ${cutBy}, so its arguments are incomplete. Send it again with less content per call (for large files, write them in parts).`
            : `${call.parseError}. Send the call again with valid JSON arguments.`,
        );
      }
      // A new file cut off while it was being written keeps its complete lines: the rest is added after them, where
      // the whole file was asked for again (and a relay that drops long replies dropped it again at the same length).
      kept = truncated && call.cut === 'string' ? keptLines(b.def.kind, call, this.meta.cwd) : null;
      if (kept) call = { ...call, input: kept.input, cut: undefined };
      // Repair closed what arrived before the reply was cut. A read can use that; a write would store half a file.
      if (call.cut && !b.def.readOnly && (call.cut === 'string' || truncated)) {
        throw new ToolInputError(
          truncated
            ? `This tool call was cut off by ${cutBy}, so it did not run. Send it again with less content per call (for large files, write them in parts).`
            : 'This tool call ended in the middle of a value, so it did not run. Send it again in full.',
        );
      }
      input = b.normalize(call.input ?? {});
      title = b.def.title(input, this.meta.cwd);
    } catch (e) {
      this.emit({ type: 'tool.start', callId: call.id, name: call.name, title, input: call.input ?? {} });
      return finish({ content: e instanceof ToolInputError ? e.message : `Invalid arguments: ${(e as Error).message}`, isError: true });
    }
    this.emit({ type: 'tool.start', callId: call.id, name: call.name, title, input: call.input ?? {} });
    this.runningTools.set(call.id, { callId: call.id, name: call.name, title, input: call.input ?? {}, started });

    // Non-read tools touching a registered `.favilla/images/img-NN.*` (where no real file exists on disk) get a
    // crisp 1-line pointer to the session's read tool instead of failing with ENOENT or writing temp files.
    if (b.def.kind !== 'read' && b.spec.name !== 'recall') {
      const virtualRefs = findVirtualImageRefs(call.input ?? input, this.meta.cwd, (id) => !!this.lookupSessionImage(id, false));
      if (virtualRefs.length) {
        const hit = virtualRefs[0];
        return finish({
          content: `${hit.virtualPath} is a virtual session image snapshot, not a file on disk. Open it with ${this.readImageCallHint(hit.virtualPath, true)} instead of ${call.name}.`,
          isError: true,
        });
      }
    }

    const planning = this.meta.mode === 'plan' || this.parent?.meta.mode === 'plan';
    if (planning && (['write', 'edit', 'patch'].includes(b.def.kind) || (b.def.kind === 'mcp' && !b.def.readOnly))) {
      return finish({ content: 'Plan mode is on, so files cannot be changed yet. Finish the plan and present it for approval first.', isError: true });
    }
    if (planning && b.def.kind === 'shell' && typeof input.command === 'string') {
      const change = changesProject(input.command);
      if (change) return finish({ content: `Plan mode is on, so this was not run: it ${change}. Tests, builds and commands that only look are fine; the rest waits for an approved plan.`, isError: true });
    }
    if (this.config.confine) {
      const workdir = typeof input.workdir === 'string' ? path.resolve(this.meta.cwd, input.workdir) : this.meta.cwd;
      // The project's scratch folder is Favilla's own, and the prompt sends one-off scripts, logs and downloads there: a
      // confined run that refused it was told two opposite things. The skills Favilla ships are read where they are, with
      // the file tools that only look.
      const room = [scratchDir(this.meta.cwd)];
      const also = b.def.readOnly ? [...room, path.join(assetsDir(), 'skills')] : room;
      const outside =
        b.def.kind === 'shell' && typeof input.command === 'string'
          ? (outsideArgs({ workdir: input.workdir }, this.meta.cwd, this.meta.cwd, room) ?? outsidePath(input.command, workdir, this.meta.cwd, room))
          : outsideArgs(input ?? {}, this.meta.cwd, this.meta.cwd, also);
      if (outside) return finish({ content: `This run stays inside its folder (${this.meta.cwd}), and ${outside} is outside it, so this was not run. Work with what is in the folder; a skill's SKILL.md is read with the read tool.`, isError: true });
    }
    const catastropheContext = {
      cwd: input.workdir ? resolvePath(this.meta.cwd, input.workdir) : this.meta.cwd,
      workspace: this.meta.cwd,
    };
    const effects = b.def.kind === 'shell' && typeof input.command === 'string' ? checkCatastrophe(input.command, catastropheContext) : null;
    const catastrophes = (effects?.risks ?? checkFileCatastrophe(b.def.kind, input, catastropheContext)).filter((r) => !(r.databaseKey && this.scratchDatabases.has(r.databaseKey)));
    let answered = false;
    if (catastrophes.length) {
      const decided = await this.decideCatastrophe(catastrophes, { tool: call.name, title, detail: input.command ?? input.patch ?? input.path });
      if (decided.refusal) return finish({ content: decided.refusal, isError: true });
      answered = decided.asked;
    }
    // The user has just answered for this exact action on the backstop's card: an ordinary approval would ask twice.
    // When their own words let it through instead, the approvals decide as they always do: the backstop never widens them.
    if (!answered && b.def.kind === 'shell' && typeof input.command === 'string') {
      const verdict = checkCommand(input.command, {
        cwd: input.workdir ? path.resolve(this.meta.cwd, input.workdir) : this.meta.cwd,
        workspace: this.meta.cwd,
        allow: this.config.guard?.allow,
        deny: this.config.guard?.deny,
        own: [scratchDir(this.meta.cwd)],
        shell: this.shell.kind === 'cmd' ? 'cmd' : this.shell.kind === 'pwsh' || this.shell.kind === 'powershell' ? 'powershell' : 'posix',
      });
      if (verdict.action === 'confirm') {
        const decision = await this.requestPermission({ tool: call.name, title, detail: input.command, reason: verdict.reason ?? '', rule: verdict.rule ?? 'guard' });
        if (decision === 'deny') {
          return finish({ content: `The user did not allow this command (${verdict.reason}). Don't run it; find another way or ask the user.`, isError: true });
        }
      }
    }

    const ctx = this.toolContext(call, signal);
    // Source text is the densest context there is: reads get a larger share than logs and listings.
    if (b.def.kind === 'read') ctx.outputChars = this.budget.readChars;
    if (b.def.kind === 'check' || (b.def.kind === 'shell' && runsSomething(String(input.command ?? '')))) {
      inputs = snapshotVersions([...this.files.recent(24), ...this.checkpoints.originals().keys()]);
    }
    try {
      signal.throwIfAborted();
      ran = true;
      const out = await b.def.execute(input, ctx);
      const imgNote = out.images?.length && this.model.vision ? await this.registerToolImages(call, out.images) : '';
      if (effects && !out.isError && out.display?.kind === 'terminal' && out.display.exitCode === 0 && !out.display.background) {
        for (const key of effects.created) this.scratchDatabases.add(key);
        for (const key of effects.dropped) this.scratchDatabases.delete(key);
      }
      if (moreChanges && !out.isError) this.changedInReply.push(...this.filesOf(input));
      const typed = out.isError || moreChanges ? '' : await this.typeCheck(b.def.kind, input, out.content);
      // One reading of what happened, for the goal, the record and every front end.
      const seen = observeOutcome(b.def.kind, input ?? {}, out, this.meta.cwd, inputs);
      const met = this.markMet(call, b, out, seen);
      const regSuffix = imgNote ? `\n${imgNote}` : '';
      return finish({ content: out.content + regSuffix + typed + met, images: out.images, isError: out.isError, display: out.display }, seen);
    } catch (e) {
      if (signal.aborted) return finish({ content: 'Interrupted by the user.', isError: true });
      debug('tool', `${call.name} threw`, String((e as Error).stack ?? e));
      return finish({ content: `Tool error: ${(e as Error).message}`, isError: true });
    }
  }

  /**
   * The goal criteria a run names in meets: marked met, with the run as evidence, only when it passed. Marking
   * them in the same call saves the model a request after every check just to tick its list.
   */
  private markMet(call: ToolCallPart, b: ToolBinding, out: { isError?: boolean; display?: ToolResultPart['display'] }, seen: ToolEvidence): string {
    const raw = (call.input as Record<string, unknown> | undefined)?.meets;
    const asked = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!asked.length || !(b.spec.parameters as { properties?: Record<string, unknown> }).properties?.meets) return '';
    const goal = this.meta.goal;
    if (!goal?.criteria.length) return '\n(meets: no goal criteria are set, so nothing was marked.)';
    if (out.isError) return `\n(Goal criteria ${asked.join(', ')} stay open: this did not pass.)`;
    // A run that printed failures, was cut short, went to the background or ran on the old code is not this work passing.
    if (seen.failure || (seen.run && seen.run.outcome !== 'passed')) return `\n(Goal criteria ${asked.join(', ')} stay open: this did not pass.)`;
    if (seen.run?.before) return `\n(Goal criteria ${asked.join(', ')} stay open: this ran on the code before the changes.)`;
    const d = out.display;
    if (b.def.kind === 'check' && (d?.kind !== 'checks' || !d.results.length || d.incomplete || d.probe && (!d.probe.results.length || d.probe.skipped || d.probe.results.some((r) => r.outcome !== 'detected')))) {
      return `\n(Goal criteria ${asked.join(', ')} stay open: the requested checks or sensitivity sample did not establish them.)`;
    }
    const evidence =
      d?.kind === 'checks' ? `${d.before ? 'Before-code: ' : ''}${d.results.map((r) => r.command).join('; ')} passed${d.probe ? '; sampled reversions detected' : ''}` : d?.kind === 'terminal' ? `${d.command} exited 0` : call.name;
    const next = structuredClone(goal);
    const missing = asked.filter((n) => !next.criteria[n - 1]);
    for (const n of asked) {
      const c = next.criteria[n - 1];
      if (c) Object.assign(c, { done: true, evidence: oneLine(evidence, 200), proved: true });
    }
    next.updated = Date.now();
    this.setGoal(next);
    const open = openCriteria(next);
    const marked = asked.filter((n) => !missing.includes(n));
    return `\n(Goal: ${marked.length ? `marked ${marked.join(', ')} met` : 'nothing marked'}${missing.length ? `; there is no criterion ${missing.join(', ')}` : ''}. ${open.length ? `Still open: ${open.map((c) => c.n).join(', ')}.` : 'Every criterion is met.'})`;
  }

  private toolContext(call: ToolCallPart, signal: AbortSignal): ToolContext {
    const config = this.config;
    return {
      cwd: this.meta.cwd,
      sessionId: this.id,
      callId: call.id,
      turn: this.parent ? this.parent.turn : this.turn,
      signal,
      model: this.model,
      config,
      shell: this.shell,
      mode: this.meta.mode,
      outputChars: this.budget.toolOutputChars,
      outputDir: path.join(this.dataDir, 'outputs'),
      files: this.files,
      checkpoints: this.checkpoints,
      jobs: this.jobs,
      interactive: this.interactive && this.role === 'main' && !this.parent,
      // Long work goes on in the background only where someone is there to be woken by its result.
      inBackground: this.interactive && this.role === 'main' && !this.parent ? (o) => this.startTask(call, o) : undefined,
      proxy: config.proxy ?? envProxy() ?? false,
      progress: (chunk) => this.emit({ type: 'tool.progress', callId: call.id, chunk }),
      // Kept with the running call too, so a front end that opens the session mid-call sees the card as it stands.
      show: (display) => {
        const r = this.runningTools.get(call.id);
        if (r) r.display = display;
        this.emit({ type: 'tool.progress', callId: call.id, chunk: '', display });
      },
      confirm: (r) => this.requestPermission({ ...r, tool: call.name }, { always: true }),
      setTodos: (todos) => {
        this.todos = todos;
        this.deps.store.saveTodos(this.meta, todos);
        this.emit({ type: 'todos', todos });
      },
      browser: () => this.browser(),
      desktop: () => (this.computerOn ? (this.desktopSession ??= new DesktopSession()) : null),
      languageServers: () => this.languageServers(),
      history: () => this.messages,
      // A sub-agent changes only its files; the agent that sent sub-agents to the background leaves theirs alone.
      mayChange: this.role === 'general' && this.claim ? (abs) => this.claims.check(this.claim ?? null, abs) : (abs) => (this.background.size ? this.claims.heldElsewhere(abs, new Set(this.background.keys())) : null),
      inContext: (id) => this.active().some((m) => m.parts.some((p) => p.type === 'tool_result' && p.callId === id && !p.pruned && !p.isError)),
      blobs: this.deps.store.blobs,
      sessionImage: (id, markReopened) => this.lookupSessionImage(id, markReopened),
      sessionImages: () => this.allSessionImages(),
      readImageCallHint: (vpath) => this.readImageCallHint(vpath, true),
      goal: () => this.meta.goal,
      setGoal: (goal) => this.setGoal(goal),
      makeBrief: (request) => this.makeBrief(request, call.id, signal),
      loadTools: (names) => this.loadTools(names),
      ask: (questions) => this.askUser(questions),
      approvePlan: (plan) => {
        this.planPresented = true;
        return this.requestPlanApproval(plan);
      },
      setMode: (mode) => this.setMode(mode),
      // Only the agent tool hands work out at the agent's own choice; a review's reader is the review itself.
      runSubagent: (o) => (this.binding(call.name)?.def === taskTool ? this.delegate(o, call.id, signal) : this.runSubagent(o, call.id, signal)),
      agents: this.role === 'main' ? this.toolAgents(call.id, signal) : undefined,
      runAttempts: this.role === 'main' ? (o) => this.runAttempts(o, call.id, signal) : undefined,
      extract: this.extractor(),
    };
  }

  /**
   * A tool's own sub-agents, under its call: they share one prompt cache key, the call's id, so the text that opens
   * every brief is paid for once. An effort a job asks for is a floor: a session set higher keeps its own.
   */
  private toolAgents(callId: string, signal: AbortSignal): ToolAgents {
    const until = (stop?: AbortSignal) => (stop ? AbortSignal.any([signal, stop]) : signal);
    return {
      run: (job, key, stop) =>
        this.runSubagent({ description: job.description, prompt: job.prompt, agent: job.agent, files: job.files, cacheGroup: callId, prelude: job.prelude, effort: job.effort && EFFORT_ORDER.indexOf(this.meta.effort) > EFFORT_ORDER.indexOf(job.effort as Effort) ? this.meta.effort : job.effort }, `${callId}#${key}`, until(stop)),
      inCopy: (job, dir, key, stop) => this.runInCopy({ description: job.description, prompt: job.prompt, prelude: job.prelude }, dir, `${callId}#${key}`, until(stop)),
    };
  }

  private trackOutcome(call: ToolCallPart, b: ToolBinding, input: any, result: ToolResultPart): void {
    const isError = !!result.isError;
    this.callHistory.push(`${call.name}:${stableStringify(call.input)}:${isError ? 'err' : 'ok'}`);
    if (this.callHistory.length > 30) this.callHistory.shift();
    if (b.def.kind === 'draw' && call.name === 'paint') this.painted = true;
    // A film encoded from frames the paint tool never touched was drawn in code (the luna film, 2026-11-02): once,
    // and only when the brief chose a hand-made look. A look made of code (type, interfaces, maths) is drawn in code: the
    // best-liked Claude films of 2026-11 were drawn so, frame by frame, and the note led the maker to paint clay.
    const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : '';
    const chosenLook = /^KIND:.*$/m.exec(this.brief?.text ?? '')?.[0] ?? '';
    if (!isError && b.def.kind === 'shell' && this.brief && !this.painted && !this.codeFilmNoted && HAND_MADE.test(chosenLook) && /\bffmpeg\b/.test(command) && /\.(mp4|webm|mov|mkv)\b/i.test(command)) {
      this.codeFilmNoted = true;
      this.notes.push('This film was encoded from frames drawn in code, though the brief chose a hand-made look: the paint tool has not been used. The motion skill asks for plates painted with the paint tool (hand-drawn media, transparent grounds) composited per frame. Paint the key art, then render again.');
    }
    if ((b.def.kind === 'edit' || b.def.kind === 'patch') && typeof input.path === 'string') {
      const key = input.path;
      this.editFailures.set(key, isError ? (this.editFailures.get(key) ?? 0) + 1 : 0);
    }
    // A folder that did not look like code when the session began has no engineering standards in its system prompt:
    // they come once, with the first code file written. A script in the scratch folder is no code of the project's: any
    // write had brought them, a todo list or a sheet's helper script included (2026-11-07).
    const scratch = normalizeForCompare(scratchDir(this.meta.cwd));
    const diffFiles = !isError && result.display?.kind === 'diff' ? result.display.files.map((f) => resolvePath(this.meta.cwd, f.path)) : [];
    const shellDocs: string[] = [];
    if (!isError && b.def.kind === 'shell' && command && changesProject(command) !== null) {
      const beganAt = this.runningTools.get(call.id)?.started ?? (Date.now() - (result.durationMs ?? 0));
      const baseDir = typeof input.workdir === 'string' ? resolvePath(this.meta.cwd, input.workdir) : this.meta.cwd;
      for (const m of command.matchAll(/[\w./-]+\.(?:md|mdx|rst|adoc)\b/gi)) {
        const cand = resolvePath(baseDir, m[0]);
        try {
          if (fs.statSync(cand).mtimeMs >= beganAt - 100) shellDocs.push(cand);
        } catch {}
      }
    }
    const written = [...new Set([...(result.evidence?.writes ?? []), ...diffFiles, ...shellDocs])].filter((f) => !normalizeForCompare(resolvePath(this.meta.cwd, f)).startsWith(scratch));
    if (!isError && this.role === 'main' && written.some((f) => CODE_FILE.test(f)) && !this.engineeringNoted && !this.system.includes('# Engineering standards')) {
      this.engineeringNoted = true;
      this.notes.push(promptAsset('engineering'));
    }
    if (!isError && this.role === 'main' && [...written, ...(result.evidence?.reads ?? []).map((r) => r.path)].some((f) => DOCUMENT_FILE.test(f))) this.noteDocuments();
    if (!isError && this.role === 'main' && written.some((f) => WRITTEN_DOC_FILE.test(f))) this.noteWritingDocs();
    if (!isError && this.role === 'main' && process.env.FAVILLA_DOC_STYLE_CHECK !== '0' && !result.content.includes('The connection dropped while you were writing this file:')) {
      for (const f of written) {
        if (PROSE_DOC_FILE.test(f)) this.checkWrittenDocument(resolvePath(this.meta.cwd, f));
      }
    }
  }

  private docSourceCorpus(docAbsPath: string): string {
    const normDoc = normalizeForCompare(docAbsPath);
    const base = path.basename(docAbsPath).toLowerCase();
    const touchesDoc = new Set<string>();
    let firstWriteIdx = this.messages.length;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role !== 'assistant') continue;
      for (const p of m.parts) {
        if (p.type !== 'tool_call') continue;
        const kind = this.binding(p.name)?.def.kind;
        const byPath = this.filesOf(p.input).some((f) => normalizeForCompare(f) === normDoc);
        const cmd = typeof (p.input as { command?: unknown })?.command === 'string' ? String((p.input as { command?: string }).command) : '';
        const byShell = kind === 'shell' && cmd.toLowerCase().includes(base);
        if (byPath || byShell) {
          touchesDoc.add(p.id);
          if ((kind === 'write' || kind === 'edit' || kind === 'patch' || (byShell && changesProject(cmd) !== null)) && i < firstWriteIdx) {
            firstWriteIdx = i;
          }
        }
      }
    }
    const chunks: string[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      for (const p of m.parts) {
        if (m.role === 'user' && m.origin === 'user' && p.type === 'text' && !p.synthetic) {
          chunks.push(p.text);
        } else if (p.type === 'tool_result' && !p.isError && (i < firstWriteIdx || !touchesDoc.has(p.callId))) {
          chunks.push(p.content);
          if (p.display?.kind === 'terminal') chunks.push(p.display.output);
        }
      }
    }
    return chunks.join('\n');
  }

  private checkWrittenDocument(docAbsPath: string): void {
    const rel = toForward(path.relative(this.meta.cwd, docAbsPath));
    if (rel.startsWith('..') || /(?:^|\/)\./.test(rel) || /(?:^|\/)(?:__tests__|__snapshots__|fixtures?|testdata)(?:\/|$)/i.test(rel)) return;
    if (/^(?:AGENTS|CLAUDE)\.md$/i.test(path.basename(docAbsPath))) return;
    const key = normalizeForCompare(docAbsPath);
    const used = this.docStyleChecks.get(key) ?? 0;
    if (used >= 2) return;
    let docText = '';
    try {
      docText = fs.readFileSync(docAbsPath, 'utf8');
    } catch {
      return;
    }
    if (docText.length < 80) return;
    const sentences = checkDocumentProse(docText, this.docSourceCorpus(docAbsPath), 8);
    if (!sentences.length) return;
    this.docStyleChecks.set(key, used + 1);
    this.notes.push(docStyleNote(displayPath(this.meta.cwd, docAbsPath), sentences));
  }

  /**
   * Whether this turn changed a file of the project. A probe script in the scratch folder is no change to it: the
   * finish note told a session its change had passed when all it had written was scratch/repro.py and the tests it
   * ran were the project's own, as they were (2026-11-10, deepseek-v4.1-flash).
   */
  private changedProject(): boolean {
    const scratch = normalizeForCompare(scratchDir(this.meta.cwd));
    return this.checkpoints.files(this.turn).some((f) => !normalizeForCompare(resolvePath(this.meta.cwd, f)).startsWith(scratch));
  }

  /**
   * A word when a run of the project's checks passes after a change to it, at no request. Most of a task's time comes
   * after its tests first pass, and much of that goes on finding out what the folder now holds: in 21 runs of the
   * field suite (2026-11-10) the sessions ran `git status --short` or `git diff --stat` 25 times after their last
   * change and removed their probe scripts in a third of them. So the note carries what git counts as changed (the
   * session's own files outside a repository), and says the scratch folder is not theirs to clear. It comes again,
   * three times a turn at most, when a later run passes with that list changed: the first pass of a request in
   * several parts is not the last, and the note that came then described a folder that has since moved on.
   */
  private async finishNote(results: ToolResultPart[]): Promise<TextPart | null> {
    if (this.role !== 'main' || this.finishNotes >= 3 || process.env.FAVILLA_FINISH_NOTE === '0' || this.meta.mode !== 'build') return null;
    if (!results.some((r) => r.evidence?.run?.outcome === 'passed' && !r.evidence.run.before && isCheckCommand(r.evidence.run.command))) return null;
    if (!this.changedProject() || openCriteria(this.meta.goal).length) return null;
    const cwd = this.meta.cwd;
    const status = await new Promise<string | null>((resolve) => {
      execFile('git', ['status', '--short', '--', '.'], { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 5000, windowsHide: true }, (e, out) => resolve(e ? null : out));
    });
    const scratch = normalizeForCompare(scratchDir(cwd));
    const lines =
      status !== null
        ? status.split('\n').filter((l) => l.trim())
        : [...new Set(this.checkpoints.files(this.turn))].filter((f) => !normalizeForCompare(resolvePath(cwd, f)).startsWith(scratch)).map((f) => path.relative(cwd, resolvePath(cwd, f)).split(path.sep).join('/')).sort();
    const list = (lines.length > 24 ? [...lines.slice(0, 24), `… ${lines.length - 24} more`] : lines).join('\n');
    if (this.finishNotes && list === this.finishNoteList) return null;
    const first = !this.finishNotes;
    this.finishNotes++;
    this.finishNoteList = list;
    const holds = !list ? ' ' : `\n${status !== null ? 'Changed in the folder now (git status --short):' : 'Files you changed:'}\n${list}\n`;
    const text = `${first ? 'That run passed after your change.' : 'That run passed after your later changes.'}${holds}${first ? 'What is in the scratch folder can stay: Favilla clears it. ' : ''}If this covers what was asked, finish now with a short report.`;
    return { type: 'text', text: `<harness-note>${text}</harness-note>`, synthetic: true };
  }

  private repeats(): number {
    const last = this.callHistory[this.callHistory.length - 1];
    if (!last) return 0;
    return this.callHistory.slice(-8).filter((x) => x === last).length;
  }

  private looping(): boolean {
    return this.repeats() >= 6;
  }

  /** Short notes appended after tool results; earlier ones stay in place so the prefix never changes. */
  private reminders(calls: ToolCallPart[], results: ToolResultPart[], askedToTrack = false): TextPart[] {
    const out: string[] = [];
    // A reply that only kept track of the work (criteria set or marked, the plan, a saved note) took a request of its
    // own, which on a slow model is half a minute in which nothing moved. In three weeks of sessions gpt-6.1-sol spent
    // 33 of 250 requests so and gpt-6-luna 256 of 1359, DeepSeek 13 of 6565, nearly all of them unprompted. Said where
    // it happens and twice a turn at most; not when Favilla's own note at the end of a turn asked for just that.
    if (!askedToTrack && this.trackedAlone < 2 && calls.length > 0 && calls.every((c) => ['goal', 'todo'].includes(this.binding(c.name)?.def.kind ?? '')) && results.every((r) => !r.isError)) {
      this.trackedAlone++;
      out.push("That reply only kept track of the work, so it took a request of its own. Send such calls in the same response as the step's other calls: criteria with your first reads, a mark with the run that shows it or with the next step.");
    }
    if (results.some((r) => r.evidence?.failure)) {
      const previous = recordedEvidence(this.messages.filter((m) => m.turn === this.turn)).map((r) => r.evidence);
      for (const r of results) {
        if (!r.evidence) continue;
        const note = recoveryNote(previous, r.evidence);
        if (note) out.push(note);
        previous.push(r.evidence);
      }
    } else if (this.repeats() >= 3) out.push('You have made the same call with the same outcome several times. Stop and reconsider: re-read the error, check your assumptions, and try a different approach.');
    for (const [file, n] of this.editFailures) {
      if (n >= 2) {
        out.push(`Edits to ${file} failed ${n} times in a row. Read the file again and base the next edit on its exact current content.`);
        this.editFailures.set(file, 0);
      }
    }
    this.roundsSinceUser++;
    const goal = this.meta.goal;
    if (this.role === 'main' && goal && this.roundsSinceUser % GOAL_EVERY === 0) {
      const open = openCriteria(goal);
      out.push(`Criteria check after ${this.roundsSinceUser} steps: ${goal.objective}${open.length ? ` Still open: ${open.map((c) => `${c.n}. ${c.text}`).join('; ')}.` : ' Every criterion is met: finish up.'} Keep to it; note unrelated findings for your final answer instead of pursuing them.`);
    }
    if (this.role === 'main' && !goal && !this.goalAsked && this.roundsSinceUser >= GOAL_ASK_AFTER && this.bindings.some((b) => b.def.kind === 'goal')) {
      this.goalAsked = true;
      out.push(`This task has taken ${this.roundsSinceUser} steps. If more remain, call the ${this.toolName('goal')} tool with the objective and checkable statements of done, so they stay in view through a long session, in the same response as your next step's calls.`);
    }
    if (results.some((r) => r.content.length > this.budget.toolOutputChars * 0.9) && this.budget.window <= 65_536) {
      out.push('That output was large for your context window. Narrow later reads and searches.');
    }
    return out.map((text) => ({ type: 'text', text: `<harness-note>${text}</harness-note>`, synthetic: true }));
  }

  // ── people in the loop ───────────────────────────────────────────────────

  /** `always`: asked even when the user turned command approvals off (an email about to be sent). */
  async requestPermission(r: Omit<PermissionRequest, 'id'>, opts: { always?: boolean } = {}, asker: Session = this): Promise<PermissionDecision> {
    if (this.config.guard?.mode === 'off' && !opts.always) return 'allow';
    if (this.sessionAllows.has(r.rule)) return 'allow';
    if (this.parent) return this.parent.requestPermission(r, opts, asker);
    if (!this.interactive) return 'deny';
    const decision = await this.showPermission(r, asker);
    if (decision === 'allow_session') this.sessionAllows.add(r.rule);
    return decision;
  }

  /** This decision never reads or writes approval settings, including remembered answers. */
  private async decideCatastrophe(risks: Catastrophe[], card: Pick<PermissionRequest, 'tool' | 'title' | 'detail'>): Promise<{ refusal?: string; asked: boolean }> {
    // A delegated brief is the model's text. Only the root session's latest human request can authorize this.
    let owner: Session = this;
    while (owner.parent) owner = owner.parent;
    const request = owner.messages.findLast((m) => m.role === 'user' && m.origin === 'user' && !m.asSystem);
    const said = request?.parts.flatMap((p) => p.type === 'text' && !p.synthetic ? [p.text] : []).join('\n') ?? '';
    const needsAnswer = risks.filter((r) => !explicitlyRequested(said, r, { cwd: owner.meta.cwd, workspace: owner.meta.cwd }));
    if (!needsAnswer.length) return { asked: false };
    const reason = needsAnswer.map((r) => r.reason).join('\n');
    const decision = await this.confirmCatastrophe({ ...card, reason, rule: 'catastrophe', once: true });
    return decision === 'deny' ? { refusal: catastropheRefusal(reason), asked: true } : { asked: true };
  }

  private async confirmCatastrophe(r: Omit<PermissionRequest, 'id'>, asker: Session = this): Promise<PermissionDecision> {
    if (this.parent) return this.parent.confirmCatastrophe(r, asker);
    if (!this.interactive) return 'deny';
    return this.showPermission(r, asker);
  }

  private async showPermission(r: Omit<PermissionRequest, 'id'>, asker: Session): Promise<PermissionDecision> {
    const request: PermissionRequest = { ...r, id: newId('p') };
    const d = new Deferred<PermissionDecision>();
    this.permissionWaits.set(request.id, d);
    // A sub-agent stopped on its own while its question waits here: the question is withdrawn and its card closes
    // (it used to stay open, and the sub-agent ran on until someone answered).
    const stopped = asker === this ? undefined : asker.controller?.signal;
    const withdraw = () => {
      if (this.permissionWaits.delete(request.id)) d.resolve('deny');
    };
    stopped?.addEventListener('abort', withdraw, { once: true });
    if (stopped?.aborted) withdraw();
    this.open.permissions.set(request.id, request);
    const prev = this.status;
    this.setStatus('waiting', 'permission');
    this.emit({ type: 'permission.request', request });
    const answer = await d.promise;
    const decision = r.once && answer === 'allow_session' ? 'allow' : answer;
    stopped?.removeEventListener('abort', withdraw);
    this.open.permissions.delete(request.id);
    this.emit({ type: 'permission.resolved', id: request.id, decision });
    if (this.status === 'waiting') this.setStatus(prev === 'waiting' ? 'running' : prev);
    return decision;
  }

  /** Something needs this session to stay loaded: a turn, a request waiting for the user, a background job or sub-agent. */
  inUse(): boolean {
    const p = this.pendingRequests();
    return this.busy || this.jobs.list().length > 0 || this.background.size > 0 || this.tasks.size > 0 || this.backgroundDone.some((d) => d.wakes) || p.permissions.length + p.questions.length + p.plans.length > 0;
  }

  /** Requests still waiting for the user, so a reconnecting front end can show them again. */
  pendingRequests(): { permissions: PermissionRequest[]; questions: QuestionRequest[]; plans: { id: string; plan: string }[] } {
    return { permissions: [...this.open.permissions.values()], questions: [...this.open.questions.values()], plans: [...this.open.plans.values()] };
  }

  respondPermission(id: string, decision: PermissionDecision): boolean {
    const d = this.permissionWaits.get(id);
    if (!d) return [...this.children].some((c) => c.respondPermission(id, decision));
    this.permissionWaits.delete(id);
    d.resolve(decision);
    return true;
  }

  private async makeBrief(request: string, callId: string, signal: AbortSignal): Promise<ToolOutput> {
    let files: string[];
    try {
      files = fs.readdirSync(this.meta.cwd).filter((f) => !/^(?:\.git|node_modules)$/.test(f));
    } catch {
      files = [];
    }
    // When the looks call fails the brief goes on without a drawn look.
    const listed = visualAsk(request) ? await this.briefLooks(request, signal) : null;
    signal.throwIfAborted();
    const drawn = listed ? drawLook(`${this.id}:${request}`, listed.looks) : null;
    const look = listed && drawn ? lookNote(listed.fixed, drawn) : null;
    const prompt = briefPrompt(request, { cwd: this.meta.cwd, files, look });
    const r = await this.runSubagent({ description: BRIEF_TITLE, prompt, agent: 'explore' }, `brief-${callId}`, signal, callId)
      .catch((e): SubagentResult => ({ text: '', steps: 0, tokens: 0, sessionId: '', error: (e as Error).message }));
    signal.throwIfAborted();
    const goalToolName = this.toolName('goal');
    const display: ToolDisplay | undefined = r.sessionId
      ? { kind: 'task', description: BRIEF_TITLE, agent: 'brief', steps: r.steps, tokens: r.tokens, childSession: r.sessionId }
      : undefined;
    if (r.error) return { content: `The brief failed: ${r.error}. Go on from the request itself and write your own criteria with ${goalToolName}.`, isError: true, display };
    const brief = parseBrief(r.text);
    if (!brief) return { content: `The agent's reply did not have a brief's form, so no criteria were set. What it wrote:\n${r.text}\n\nUse what holds, and write your own criteria with ${goalToolName}.`, display };
    this.brief = { request, text: brief.text, reviews: 0 };
    this.setGoal({ objective: brief.objective, criteria: brief.criteria.map((c) => ({ ...c, done: false })), by: 'brief', updated: Date.now() });
    const skills = brief.skills.length ? skillTexts(this.meta.cwd, brief.skills) : '';
    return { content: fill(promptAsset('brief-made'), { goal: goalToolName, brief: skills ? `${brief.text}\n\n${skills}` : brief.text }), display };
  }

  /** Eight looks from the request's own world, from one quick call without tools; null when the call fails or lists none. */
  private async briefLooks(text: string, signal: AbortSignal): Promise<Looks | null> {
    const ask: Message = { id: newId('m'), role: 'user', parts: [{ type: 'text', text: looksPrompt(text) }], time: Date.now() };
    // Room for a reasoning model's thinking: DeepSeek spent about 3000 tokens on it before the list.
    const call = this.providerCall([ask], signal, { system: 'You choose how things people look at should look.', tools: [], hostedSearch: false, toolChoice: 'none', maxOutputTokens: Math.min(this.budget.maxOutput, 16_000) });
    const deep = EFFORT_ORDER.indexOf(call.effort) >= EFFORT_ORDER.indexOf('high');
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const local = new AbortController();
      const linked = AbortSignal.any([signal, local.signal]);
      const silence = watchStreamSilence(deep, () => local.abort());
      let delay: number;
      try {
        silence.touch(true);
        const res = await adapterFor(call.provider.api).stream({ ...call, signal: linked }, (e) => silence.touch(isStreamWord(e)));
        linked.throwIfAborted();
        this.recordUsage(res.usage, 0);
        const listed = parseLooks(res.parts.filter((p) => p.type === 'text').map((p) => (p as TextPart).text).join(''));
        return listed.looks.length ? listed : null;
      } catch (e) {
        if (signal.aborted) throw e;
        // A silent connection can spend the whole budget again; the brief can proceed without a look.
        if (local.signal.aborted) return null;
        const err = e as ProviderError;
        if (!(err instanceof ProviderError) || !err.retryable || attempt >= 1) return null;
        delay = Math.min(err.retryAfterMs ?? 2000, 30_000);
      } finally {
        silence.close();
      }
      await sleep(delay, signal);
    }
  }

  private async askUser(questions: Question[]): Promise<Record<string, string> | null> {
    if (this.parent || !this.interactive) return null;
    const id = newId('q');
    const d = new Deferred<Record<string, string> | null>();
    this.questionWaits.set(id, d);
    this.open.questions.set(id, { id, questions });
    this.setStatus('waiting', 'question');
    this.emit({ type: 'question.request', request: { id, questions } });
    const answers = await d.promise;
    this.open.questions.delete(id);
    this.emit({ type: 'question.resolved', id });
    this.setStatus('running');
    return answers;
  }

  answerQuestion(id: string, answers: Record<string, string> | null): boolean {
    const d = this.questionWaits.get(id);
    if (!d) return false;
    this.questionWaits.delete(id);
    d.resolve(answers);
    return true;
  }

  private async requestPlanApproval(plan: string): Promise<{ approved: boolean; feedback?: string } | null> {
    if (this.parent || !this.interactive) return null;
    const id = newId('a');
    const d = new Deferred<{ approved: boolean; feedback?: string }>();
    this.planWaits.set(id, d);
    this.open.plans.set(id, { id, plan });
    this.setStatus('waiting', 'plan');
    this.emit({ type: 'plan.request', id, plan });
    const verdict = await d.promise;
    this.open.plans.delete(id);
    this.emit({ type: 'plan.resolved', id, approved: verdict.approved });
    this.setStatus('running');
    return verdict;
  }

  respondPlan(id: string, approved: boolean, feedback?: string): boolean {
    const d = this.planWaits.get(id);
    if (!d) return false;
    this.planWaits.delete(id);
    d.resolve({ approved, feedback });
    return true;
  }

  // ── sub-agents and side requests ─────────────────────────────────────────

  /** The models a sub-agent can be given: those of the providers that can be used now. */
  /**
   * The model a sub-agent runs on: the one asked for (a provider/model ref, or the id or name of a model of a
   * provider in use), else the configured sub-agent model, else this session's own.
   */
  private subagentModel(asked?: string): ModelInfo {
    const want = asked?.trim();
    if (!want) return this.deps.catalog.resolve(this.config.subagentModel || this.model.ref);
    const usable = this.deps.catalog.usableModels();
    const lower = want.toLowerCase();
    const hit = usable.find((m) => m.ref.toLowerCase() === lower) ?? usable.find((m) => m.id.toLowerCase() === lower) ?? usable.find((m) => m.name.toLowerCase() === lower);
    if (hit) return hit;
    // A model a provider in use has not listed may still be served by it.
    if (want.includes('/')) {
      try {
        const m = this.deps.catalog.resolve(want);
        if (this.deps.catalog.isConfigured(this.deps.catalog.provider(m.provider))) return m;
      } catch {
        /* the message below */
      }
      // The right model under a provider name that does not exist ("new-provider/deepseek-v4.1-flash"): the one
      // model of that id, when only one provider has it.
      const id = lower.slice(lower.lastIndexOf('/') + 1);
      const same = usable.filter((m) => m.id.toLowerCase() === id);
      if (same.length === 1) return same[0];
    }
    throw new Error(`no model "${want}" is available. Sub-agents can run on: ${modelsByProvider(usable.map((m) => m.ref), 12) || this.model.ref}.`);
  }

  /**
   * The sub-agents the agent starts itself, through its agent tool. Each starts from nothing and reads again what its
   * parent would: in the evals a task with one took two to three times as long and passed no more often, and the
   * parent read again 46% of the files an explore agent was first to read (2026-10-31). So the agent looks at the work
   * itself first and starts few in a turn; a user who asks for sub-agents or parallel work lifts both.
   */
  private async delegate(o: Parameters<Session['runSubagent']>[0], callId: string, signal: AbortSignal): Promise<SubagentResult> {
    const refuse = (error: string): SubagentResult => ({ text: '', steps: 0, tokens: 0, sessionId: '', error });
    if (this.role === 'main' && !asksForAgents(this.turnUserText())) {
      if (this.turnLooks() < LOOK_FIRST)
        return refuse('look at the work yourself first (read, search, run something): on a focused job you are faster. Hand over a part only once you know it is separate, with its own files or its own question, and big enough to be worth a report.');
      if (this.turnAgents >= AGENTS_PER_TURN) return refuse(`${AGENTS_PER_TURN} sub-agents already ran this turn. Do the rest yourself: what each one learns comes back only as a report.`);
    }
    this.turnAgents++;
    return this.runSubagent(o, callId, signal);
  }

  /** Calls the agent made in this turn before its latest reply that look at the work: reading, searching, running. */
  private turnLooks(): number {
    const turn = this.active().slice(this.turnStartIndex());
    const latest = turn.map((m) => m.role).lastIndexOf('assistant');
    let n = 0;
    turn.forEach((m, i) => {
      if (m.role !== 'assistant' || i === latest) return;
      for (const p of m.parts) if (p.type === 'tool_call' && !NOT_LOOKING.has(this.binding(p.name)?.def.kind ?? 'other')) n++;
    });
    return n;
  }

  /**
   * A sub-agent: a session of its own that starts from its brief, with a system prompt of its own. Starting them as
   * forks of the conversation (its prefix, from cache) halved the uncached input but read 50% more in all and was no
   * faster on the batch suite (2026-11-03), so that was taken out.
   */
  private async runSubagent(o: { description: string; prompt: string; agent: string; files?: string[]; model?: string; effort?: string; background?: boolean; cacheGroup?: string; prelude?: string }, callId: string, signal: AbortSignal, cardCallId?: string): Promise<SubagentResult> {
    // After a stop nothing new starts (an aborted signal fires no more events, so a sub-agent started now would run on).
    if (signal.aborted) return { text: '', steps: 0, tokens: 0, sessionId: '', error: 'the user stopped the turn before this sub-agent started', stopped: true };
    const role = o.agent === 'general' ? 'general' : 'explore';
    if (role === 'general' && this.meta.mode === 'plan') return { text: '', steps: 0, tokens: 0, sessionId: '', error: 'Plan mode is on, so nothing may change files yet: use an explore sub-agent, or present the plan first.' };
    // In the background (the main agent goes on meanwhile): a general one names its files, which then stay its
    // own, so the two never edit the same file; at most four at a time.
    const background = !!o.background && this.role === 'main';
    if (background && role === 'general' && !o.files?.length)
      return { text: '', steps: 0, tokens: 0, sessionId: '', error: 'a general sub-agent in the background must name the files it may change (files), so you can go on with the others meanwhile' };
    if (background && this.background.size >= 4) return { text: '', steps: 0, tokens: 0, sessionId: '', error: 'four sub-agents are already running in the background: wait for a report first' };
    let childModel: ModelInfo;
    try {
      childModel = this.subagentModel(o.model);
    } catch (e) {
      return { text: '', steps: 0, tokens: 0, sessionId: '', error: (e as Error).message };
    }
    // An effort asked for is kept (fitted to what the model offers); otherwise research runs at most at medium.
    const asked = EFFORT_ORDER.includes(o.effort as Effort) ? (o.effort as Effort) : undefined;
    const effort = fitEffort(childModel, asked ?? (role === 'explore' && EFFORT_ORDER.indexOf(this.meta.effort) > EFFORT_ORDER.indexOf('medium') ? 'medium' : this.meta.effort));
    const started = Date.now();
    // A sub-agent that changes files holds them while it works; one whose files could overlap waits for it.
    const claim = role === 'general' ? (o.files?.length ? o.files : null) : undefined;
    if (claim !== undefined) {
      const wait = (holder: string) => this.emit({ type: 'tool.progress', callId, chunk: `Waiting for the sub-agent "${holder}" to finish with files this one may change.\n` });
      await this.claims.acquire(callId, o.description, claim, wait, signal);
    }
    // Where its record starts: a background one can outlive this turn, and its shell commands show only in git.
    const earlierTurns = this.checkpoints.turns().filter((t) => t !== this.turn).length;
    const treeBefore = role === 'general' ? await changedInTree(this.meta.cwd) : null;
    const child = await Session.start(this.deps, { cwd: this.meta.cwd, model: childModel.ref, effort, role, parent: this, title: o.description, claim, cacheGroup: o.cacheGroup ?? `${this.cacheGroup ?? this.id}:${role}` });
    // What a group of sub-agents all read first is a message of its own before the brief: the backend serves a request
    // from cache up to the end of any message the session sent before, so every one after the first starts from cache.
    if (o.prelude) child.push({ id: newId('m'), role: 'user', origin: 'user', parts: [{ type: 'text', text: o.prelude }], time: Date.now(), turn: newId('t') });
    this.children.add(child);
    this.childCalls.set(child, { callId, cardCallId });
    const off = child.on(this.relay(cardCallId ?? callId));
    const onAbort = () => child.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const run = async (): Promise<SubagentResult> => {
      try {
        const files = claim ? `\n\nFiles you may change: ${claim.join(', ')}. Your edit tools refuse other files, and your commands must leave them alone too; if the work needs one, say so in your report.` : '';
        // Stopped while it was being set up: its turn never starts.
        if (!signal.aborted && !this.stoppedCalls.has(callId)) await child.send(`${o.prompt}${files}`);
        const last = [...child.messages].reverse().find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text'));
        const text = last ? last.parts.filter((p) => p.type === 'text').map((p) => (p as TextPart).text).join('') : '';
        const facts = this.subagentFacts(child, earlierTurns, treeBefore, treeBefore && (await changedInTree(this.meta.cwd)));
        // A stop that came as it finished on its own leaves a finished report.
        const stopped = this.stoppedCalls.delete(callId) && child.lastEnd !== 'done';
        return {
          text: stopped
            ? `The user stopped this sub-agent after ${child.steps} step${child.steps === 1 ? '' : 's'}, before it finished.${text ? ` Its last message:\n${text}` : ''}${facts.note}\nDo not start it again unless the user asks; go on with the rest.`
            : `${text || `(The sub-agent stopped after ${child.steps} steps without a report.)`}${facts.note}`,
          steps: child.steps,
          tokens: child.usage.totalInput + child.usage.totalOutput,
          sessionId: child.id,
          changed: facts.changed,
          model: childModel.ref,
          effort,
          durationMs: Date.now() - started,
          ...(stopped ? { stopped: true } : {}),
          // Its turn ended in an error it caught itself: three sub-agents of one tool call ended so, unseen (2026-11-03).
          ...(!stopped && child.lastError ? { error: child.lastError } : {}),
        };
      } catch (e) {
        return { text: '', steps: child.steps, tokens: 0, sessionId: child.id, error: (e as Error).message, model: childModel.ref, effort, durationMs: Date.now() - started, ...(this.stoppedCalls.delete(callId) ? { stopped: true } : {}) };
      } finally {
        signal.removeEventListener('abort', onAbort);
        off();
        this.children.delete(child);
        this.childCalls.delete(child);
        this.addUsage(child);
        child.dispose();
        if (claim !== undefined) this.claims.release(callId);
      }
    };
    if (!background) return run();
    this.background.set(callId, { description: o.description, child, started, wakes: true });
    this.emitBackground();
    void run().then((r) => {
      // Its call's result was written when it started; that it was stopped is kept beside the session instead.
      if (r.stopped && !this.disposed) {
        this.meta = { ...this.meta, stopped: [...(this.meta.stopped ?? []), callId].slice(-50) };
        this.deps.store.saveMeta(this.meta);
      }
      this.reportBackground(callId, o.description, r);
    });
    return {
      text: `Running in the background as "${o.description}" (${childModel.ref}). Its report comes back as a message when it is done. Go on with work that does not need it${claim ? `, and leave ${claim.join(', ')} to it until then` : ''}; do not do its part yourself. When nothing else is left for you, end your turn with a line to the user on what is still running: you are woken with the reports once every background sub-agent is in.`,
      steps: 0,
      tokens: 0,
      sessionId: child.id,
      model: childModel.ref,
      effort,
      background: true,
    };
  }

  /**
   * A sub-agent at work in `cwd`, a copy of the project made for it (by a tool that proves something there): it may change anything there,
   * nothing it does reaches this session's files, and whoever made the copy reads what it left.
   */
  private async runInCopy(o: { description: string; prompt: string; prelude?: string }, cwd: string, callId: string, signal: AbortSignal): Promise<SubagentResult> {
    if (signal.aborted) return { text: '', steps: 0, tokens: 0, sessionId: '', error: 'the user stopped the turn before this sub-agent started', stopped: true };
    const model = this.subagentModel();
    const effort = fitEffort(model, this.meta.effort);
    const started = Date.now();
    const child = await Session.start(this.deps, { cwd, model: model.ref, effort, role: 'general', parent: this, title: o.description, isolated: true, cacheGroup: `${this.cacheGroup ?? this.id}:general` });
    this.children.add(child);
    this.childCalls.set(child, { callId });
    const off = child.on(this.relay(callId));
    const onAbort = () => child.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (o.prelude) child.push({ id: newId('m'), role: 'user', origin: 'user', parts: [{ type: 'text', text: o.prelude }], time: Date.now(), turn: newId('t') });
      if (!signal.aborted && !this.stoppedCalls.has(callId)) await child.send(o.prompt);
      const last = [...child.messages].reverse().find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text'));
      const text = last ? last.parts.filter((p) => p.type === 'text').map((p) => (p as TextPart).text).join('') : '';
      const stopped = this.stoppedCalls.delete(callId) && child.lastEnd !== 'done';
      return { text, steps: child.steps, tokens: child.usage.totalInput + child.usage.totalOutput, sessionId: child.id, model: model.ref, effort, durationMs: Date.now() - started, ...(stopped ? { stopped: true } : {}), ...(!stopped && child.lastError ? { error: child.lastError } : {}) };
    } catch (e) {
      return { text: '', steps: child.steps, tokens: 0, sessionId: child.id, error: (e as Error).message, model: model.ref, effort, durationMs: Date.now() - started };
    } finally {
      signal.removeEventListener('abort', onAbort);
      off();
      this.children.delete(child);
      this.childCalls.delete(child);
      this.addUsage(child);
      child.dispose();
    }
  }

  /**
   * Several attempts at one task at once, each a sub-agent in its own copy of the repository. Each copy is
   * scored with the project's checks (or the given command); among the best a judge picks when it has to,
   * and the chosen change is applied to the working tree as part of this turn, so it can be undone. The
   * copies are removed; every attempt's patch is kept beside the session.
   */
  /**
   * Shadow tests for this turn's request when they are asked for (config shadowTests) and can help: a fix, in build
   * mode, in a project whose tests run test by test (Go, node --test, vitest, jest, pytest), by a model of another
   * family than this one, since a model's own tests share its blind spots.
   * The tester works in a copy of the project as it is now, so nothing it writes reaches the working tree on its own.
   * It runs beside the turn and may outlive it (see endChecks); a stop, the next request or the session's end stops it.
   */
  private startShadowTests(text: string): void {
    const want = shadowTestsModel(this.config);
    if (!want || this.role !== 'main' || this.meta.mode !== 'build') return;
    const root = gitRoot(this.meta.cwd);
    const kind = root ? shadowKind(root) : null;
    if (!root || !kind) return;
    let model: ModelInfo;
    try {
      model = this.deps.catalog.resolve(want.model);
    } catch {
      return;
    }
    if (model.family === this.model.family) return;
    const turn = this.turn;
    const stopper = new AbortController();
    const result = (async (): Promise<ShadowTests | null> => {
      const copy = makeCopy(root, path.join(this.dataDir, 'shadow', turn));
      let child: Session | null = null;
      try {
        // Low unless set: DeepSeek's tests at low caught 48% of luna's failing fixes against 35% at high, in less time.
        child = await Session.start(this.deps, { cwd: copy.dir, model: model.ref, effort: want.effort ?? 'low', role: 'general', parent: this, title: 'Shadow tests', isolated: true, cacheGroup: `${this.cacheGroup ?? this.id}:shadow` });
        const tester = child;
        stopper.signal.addEventListener('abort', () => tester.abort(), { once: true });
        // Go keeps the prompt it was measured with; the other runners share one, and Python has its own names.
        const ask = kind === 'go' ? 'shadow-tests' : kind === 'pytest' ? 'shadow-tests-py' : 'shadow-tests-js';
        if (!stopper.signal.aborted) await tester.send(fill(promptAsset(ask), { request: text, ...shadowRunner(kind) }));
        if (stopper.signal.aborted) return null;
        return await trustShadow(copy.dir, shadowFiles(copy.dir, copyChanges(copy).files.map((f) => f.path), kind), stopper.signal, kind);
      } finally {
        if (child) {
          this.addUsage(child);
          child.dispose();
        }
        removeCopy(root, copy);
      }
    })().catch((e) => {
      debug('shadow', 'the shadow tests were not written', String(e));
      return null;
    });
    const run: ShadowRun = { turn, result, placed: [], stop: () => stopper.abort(), signal: stopper.signal, done: false, deferred: false };
    this.shadowRun = run;
    const work = result.then(async () => {
      run.done = true;
      if (run.deferred && this.shadowRun === run) await this.shadowLate(run);
    });
    this.shadowWork.add(work);
    const done = () => { this.shadowWork.delete(work); };
    void work.then(done, done);
    this.emit({ type: 'notice', level: 'info', text: `${model.ref} writes shadow tests of this request from the request alone.`, key: '{n} writes shadow tests of this request from the request alone.', arg: model.ref });
  }

  /** The turn's shadow tests, written, run on its change: the note that sends the work back, or null when they pass or none can be trusted. */
  private async checkShadowTests(signal: AbortSignal): Promise<string | null> {
    const run = this.shadowRun;
    if (!run) return null;
    const set = await run.result;
    if (!set || signal.aborted) return null;
    this.setStatus('running', 'shadow-tests');
    const r = await checkShadow(this.meta.cwd, set, signal);
    run.placed = r.placed;
    if (!r.failing.length && !r.unbuilt) return null;
    return shadowNote(r, (abs) => displayPath(this.meta.cwd, abs));
  }

  /**
   * Shadow tests written after their turn ended: they run on the change as it was left, and a failure goes in as a
   * report, which wakes an idle session (or is read by the turn under way, as a background sub-agent's is).
   */
  private async shadowLate(run: ShadowRun): Promise<void> {
    try {
      const set = await run.result;
      if (!set || this.disposed || this.shadowRun !== run) return;
      const r = await checkShadow(this.meta.cwd, set, run.signal);
      if (this.shadowRun !== run) return removeShadow(r.placed);
      if (!r.failing.length && !r.unbuilt) return;
      run.placed = r.placed;
      this.backgroundDone.push({ callId: `shadow-${run.turn}`, description: 'Shadow tests', text: shadowNote(r, (abs) => displayPath(this.meta.cwd, abs)), stopped: false, wakes: true });
      this.emit({ type: 'notice', level: 'info', text: 'The shadow tests failed on the change: the work goes on.', key: 'The shadow tests failed on the change: the work goes on.' });
    } catch (e) {
      debug('shadow', 'the shadow tests did not run', String(e));
    } finally {
      // Settled once its report is in (or there is none): the run waits for the turn it starts from here.
      run.deferred = false;
      if (this.shadowRun === run && !run.placed.length) this.shadowRun = null;
      void this.wake();
    }
  }

  private async runAttempts(o: { task: string; count: number; check?: string }, callId: string, signal: AbortSignal): Promise<{ content: string; isError?: boolean; display?: ToolDisplay }> {
    if (this.meta.mode === 'plan') return { content: 'Plan mode is on, so files cannot be changed yet. Finish the plan and present it for approval first.', isError: true };
    const root = gitRoot(this.meta.cwd);
    if (!root) return { content: 'Parallel attempts need a git repository: each attempt works in a git worktree of it.', isError: true };
    const base = path.join(this.dataDir, 'attempts');
    const copies: Copy[] = [];
    try {
      for (let i = 1; i <= o.count; i++) copies.push(makeCopy(root, path.join(base, `${callId}-${i}`)));
    } catch (e) {
      for (const c of copies) removeCopy(root, c);
      return { content: `Could not make the copies: ${(e as Error).message}`, isError: true };
    }
    const brief = (i: number) =>
      `${o.task}\n\nYou are attempt ${i} of ${o.count}: each attempt works alone in its own copy of the repository, and the one that does the task best, judged by the project's checks${o.check ? ` (\`${o.check}\`)` : ''}, is kept. Make the change completely, run the checks or tests yourself until they pass, and finish with a short report of what you changed. Installed dependencies are shared with the original copy: do not install, remove or upgrade packages.`;
    const model = this.deps.catalog.resolve(this.config.subagentModel || this.model.ref);
    const runs = copies.map(async (copy, i) => {
      // A start that fails or a stop during it ends this attempt alone; thrown out of here, it skipped the removal of
      // the copies below and left git worktrees behind.
      if (signal.aborted) return { childSession: '', report: '' };
      let child: Session;
      try {
        child = await Session.start(this.deps, { cwd: copy.dir, model: model.ref, effort: this.meta.effort, role: 'general', parent: this, title: `Attempt ${i + 1}`, isolated: true, cacheGroup: `${this.cacheGroup ?? this.id}:general` });
      } catch (e) {
        debug('attempts', `attempt ${i + 1} did not start`, String(e));
        return { childSession: '', report: '' };
      }
      this.children.add(child);
      this.childCalls.set(child, { callId });
      const off = child.on(this.relay(callId));
      const onAbort = () => child.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (!signal.aborted) await child.send(brief(i + 1));
      } catch (e) {
        debug('attempts', `attempt ${i + 1} failed`, String(e));
      } finally {
        signal.removeEventListener('abort', onAbort);
        off();
        this.children.delete(child);
        this.childCalls.delete(child);
        this.addUsage(child);
        child.dispose();
      }
      const last = [...child.messages].reverse().find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text'));
      return { childSession: child.id, report: last ? last.parts.filter((p) => p.type === 'text').map((p) => (p as TextPart).text).join('') : '' };
    });
    const done = await Promise.all(runs);
    const scored: { n: number; copy: Copy; score: Score; patch: string; files: { path: string; added: number; removed: number }[]; report: string; childSession: string }[] = [];
    try {
      for (const [i, copy] of copies.entries()) {
        if (signal.aborted) break;
        const { patch, files } = copyChanges(copy);
        fs.writeFileSync(path.join(base, `${callId}-${i + 1}.patch`), patch);
        // The model can supply a shell command for scoring, too; decide it for each copy where it will run.
        if (patch.trim() && o.check) {
          const { risks } = checkCatastrophe(o.check, { cwd: copy.dir, workspace: copy.dir });
          if (risks.length) {
            const { refusal } = await this.decideCatastrophe(risks, { tool: 'attempts', title: o.check, detail: o.check });
            if (refusal) return { content: refusal, isError: true };
          }
        }
        const score = patch.trim() ? await scoreCopy(copy.dir, this.shell, o.check, signal, path.join(base, 'logs')) : { passed: 0, failed: 0, results: [] };
        scored.push({ n: i + 1, copy, score, patch, files, report: done[i].report, childSession: done[i].childSession });
      }
    } finally {
      for (const c of copies) removeCopy(root, c);
    }
    if (signal.aborted) return { content: 'Stopped before the attempts were compared.', isError: true };
    // The best: the most checks passed, then the fewest failed, then the smaller change.
    const size = (s: (typeof scored)[number]) => s.files.reduce((n, f) => n + f.added + f.removed, 0);
    const ranked = scored.filter((s) => s.patch.trim()).sort((a, b) => b.score.passed - a.score.passed || a.score.failed - b.score.failed || size(a) - size(b));
    let chosen = ranked[0];
    let reason = chosen ? (ranked.length > 1 && (ranked[1].score.passed < chosen.score.passed || ranked[1].score.failed > chosen.score.failed) ? 'it passed the most checks' : 'the only attempt with a change') : '';
    const tied = chosen ? ranked.filter((s) => s.score.passed === chosen!.score.passed && s.score.failed === chosen!.score.failed) : [];
    if (tied.length > 1) {
      const verdict = await this.judgeAttempts(o.task, tied, signal).catch(() => null);
      chosen = tied.find((t) => t.n === verdict?.n) ?? tied[0];
      reason = verdict?.why ?? 'its checks passed with the smallest change';
    }
    const lines = scored.map((s) => `#${s.n}: ${s.patch.trim() ? `${s.score.passed} of ${s.score.passed + s.score.failed} checks passed${s.score.failed ? ` (failing: ${s.score.results.filter((r) => !r.ok).map((r) => r.name).join(', ')})` : ''}, ${s.files.length} file${s.files.length === 1 ? '' : 's'} +${s.files.reduce((n, f) => n + f.added, 0)} -${s.files.reduce((n, f) => n + f.removed, 0)}` : 'no change'}${s === chosen ? '  ← kept' : ''}`);
    const display: ToolDisplay = {
      kind: 'attempts',
      attempts: scored.map((s) => ({ n: s.n, passed: s.score.passed, failed: s.score.failed, added: s.files.reduce((n, f) => n + f.added, 0), removed: s.files.reduce((n, f) => n + f.removed, 0), files: s.files.length, chosen: s === chosen, childSession: s.childSession, note: s.patch.trim() ? undefined : 'no change' })),
      reason: chosen ? reason : undefined,
    };
    if (!chosen) return { content: `None of the ${o.count} attempts changed anything.\n${lines.join('\n')}`, isError: true, display };
    // Into the working tree, as part of this turn: the files are captured first, so the turn can be undone.
    for (const f of patchFiles(root, chosen.patch)) this.checkpoints.capture(this.turn, f);
    try {
      applyPatch(root, chosen.patch);
    } catch (e) {
      return { content: `Attempt #${chosen.n} was the best, but its change did not apply to the working tree: ${(e as Error).message}\nIts patch: ${path.join(base, `${callId}-${chosen.n}.patch`)}\n${lines.join('\n')}`, isError: true, display };
    }
    for (const f of patchFiles(root, chosen.patch)) this.files.forget(f);
    const ok = chosen.score.failed === 0 && chosen.score.passed > 0;
    return {
      content: [
        `${o.count} attempts ran; #${chosen.n} was kept (${reason}) and its change is now in the working tree${ok ? '' : ', though not all of its checks passed'}:`,
        ...lines,
        `Files changed: ${chosen.files.map((f) => `${f.path} (+${f.added} -${f.removed})`).join(', ')}.`,
        chosen.report ? `Its report:\n${oneLine(chosen.report, 1500)}` : '',
        `Every attempt's patch is saved in ${base}. Read the changed files before building on them.`,
      ]
        .filter(Boolean)
        .join('\n'),
      display,
    };
  }

  /** Which of equally scored attempts does the task best, by a short side request; null when it cannot say. */
  private async judgeAttempts(task: string, tied: { n: number; patch: string; report: string }[], signal: AbortSignal): Promise<{ n: number; why: string } | null> {
    const provider = this.deps.catalog.provider(this.model.provider);
    const msg: Message = {
      id: newId('m'),
      role: 'user',
      parts: [
        {
          type: 'text',
          text: `The task:\n<task>\n${task.slice(0, 6000)}\n</task>\n\n${tied.map((t) => `<attempt n="${t.n}">\n<report>${t.report.slice(0, 1500)}</report>\n<patch>\n${t.patch.slice(0, 14000)}\n</patch>\n</attempt>`).join('\n\n')}\n\nThese attempts passed the same checks. Which one does the task best: complete, correct on edge cases, fitting the code around it, no needless changes? Answer with two lines: WINNER: <n>, and WHY: <one sentence>.`,
        },
      ],
      time: Date.now(),
    };
    const res = await adapterFor(provider.api).stream(
      {
        model: this.model,
        provider,
        system: 'You judge code changes made for the same task and pick the best one. Be concrete.',
        tools: [],
        messages: [msg],
        effort: fitEffort(this.model, 'medium'),
        maxOutputTokens: 2000,
        sessionId: `${this.id}-judge`,
        turnId: newId('x'),
        turnStart: 0,
        signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
      },
      () => {},
    );
    this.recordUsage(res.usage, 0);
    const text = res.parts.filter((p) => p.type === 'text').map((p) => (p as TextPart).text).join('');
    const n = Number(/WINNER:\s*#?(\d+)/i.exec(text)?.[1]);
    return Number.isFinite(n) ? { n, why: oneLine(/WHY:\s*(.+)/i.exec(text)?.[1] ?? 'the judge preferred it', 240) } : null;
  }

  /**
   * What a sub-agent did, as Favilla recorded it rather than as it reported it: the files it changed, with
   * lines added and removed, and the commands it ran with their exit codes. Appended to its report.
   */
  private subagentFacts(child: Session, earlierTurns: number, treeBefore: Map<string, number> | null, treeAfter: Map<string, number> | null): { note: string; changed: { path: string; added: number; removed: number }[] } {
    const written = new Set(child.files.written().map((p) => path.resolve(p).toLowerCase()));
    const changed = this.checkpoints
      .changesAfter(earlierTurns)
      .filter((c) => written.has(path.resolve(c.path).toLowerCase()))
      .map((c) => {
        const d = makeDiff(displayPath(this.meta.cwd, c.path), c.before, c.after, c.before === null ? 'add' : c.after === null ? 'delete' : 'update');
        return { path: d.path, added: d.added, removed: d.removed };
      });
    const commands: string[] = [];
    for (const m of child.messages) {
      for (const p of m.parts) {
        if (p.type !== 'tool_result' || !p.display) continue;
        if (p.display.kind === 'terminal') commands.push(`\`${oneLine(p.display.command, 120)}\` exit ${p.display.exitCode ?? (p.display.timedOut ? 'timed out' : 'none')}`);
        if (p.display.kind === 'checks') for (const r of p.display.results) commands.push(`\`${oneLine(r.command, 120)}\` ${r.ok ? 'passed' : 'failed'}`);
      }
    }
    // Git sees what the edit tools do not: formatters, generators, `sed -i`, and work by anyone else in the meantime.
    const known = new Set(changed.map((c) => toForward(c.path)));
    const others = treeBefore && treeAfter ? [...treeAfter].filter(([f, at]) => treeBefore.get(f) !== at && !known.has(f)).map(([f]) => f) : [];
    const lines: string[] = [];
    if (changed.length) lines.push(`Files it changed: ${changed.map((c) => `${c.path} (+${c.added} -${c.removed})`).join(', ')}.`);
    if (others.length) lines.push(`Also changed while it ran, by its commands or other work: ${others.slice(0, 12).join(', ')}${others.length > 12 ? ` (and ${others.length - 12} more)` : ''}.`);
    if (!changed.length && !others.length && child.role === 'general') lines.push(treeBefore && treeAfter ? 'It changed no files.' : 'Its edit tools changed no files; what its commands wrote is not recorded, since this is not a git repository.');
    if (commands.length) lines.push(`Commands it ran: ${commands.slice(-8).join('; ')}${commands.length > 8 ? ` (and ${commands.length - 8} earlier)` : ''}.`);
    return { note: lines.length ? `\n\n[Recorded by Favilla] ${lines.join(' ')}` : '', changed };
  }

  /** Page extraction for web fetches on a small model; skipped for single-slot servers to keep their cache. */
  private extractor(): ToolContext['extract'] {
    const provider = this.deps.catalog.provider(this.model.provider);
    const ref = this.config.smallModel;
    if (!ref && provider.serial) return undefined;
    return async (instruction, content) => {
      const model = ref ? this.deps.catalog.resolve(ref) : this.model;
      const p = this.deps.catalog.provider(model.provider);
      const msg: Message = {
        id: newId('m'),
        role: 'user',
        parts: [{ type: 'text', text: `Page content:\n\n${content}\n\n---\n${instruction}\nAnswer from the page only; quote exact values, code and names. If the page does not contain it, say so.` }],
        time: Date.now(),
      };
      const res = await adapterFor(p.api).stream(
        {
          model,
          provider: p,
          system: 'You extract information from web pages for an agent. Be concise and exact.',
          tools: [],
          messages: [msg],
          effort: fitEffort(model, 'low'),
          maxOutputTokens: 4000,
          sessionId: `${this.id}-extract`,
          turnId: newId('x'),
          turnStart: 0,
          signal: AbortSignal.timeout(120_000),
        },
        () => {},
      );
      this.recordUsage(res.usage, 0, model);
      return res.parts.filter((x) => x.type === 'text').map((x) => (x as TextPart).text).join('').trim();
    };
  }

  // ── compaction ───────────────────────────────────────────────────────────

  /**
   * Light compaction (context/prune.ts): once the context is half full, tool output that a later call
   * superseded or that is large and from earlier steps is cut to stubs, everything else stays word for
   * word. Each round costs the provider's whole prompt cache (one long session lost 260k tokens to two rounds
   * in a row), so it waits for real growth and a real saving, and then has to pay for the cache (prunePays).
   */
  private prefixCacheContext(defaultSteps: number): PrefixCacheContext {
    const epochSteps = Math.max(1, this.mainRequests - this.prunedRequests);
    const baseline = Math.max(this.estimatePrefix(), this.compactedAt, this.prunedAt);
    const epochGrowth = Math.max(0, this.contextTokens - baseline);
    return {
      cachedShare: this.cachedShare(),
      remainingSteps: defaultSteps,
      contextTokens: this.contextTokens,
      compactAt: this.budget.compactAt,
      avgStepGrowth: Math.max(1500, Math.floor(epochGrowth / epochSteps)),
      tokenScale: this.calibrator.factor,
    };
  }

  private maybePrune(): boolean {
    if (this.config.autoCompact === false || this.role !== 'main') return false;
    const w = this.budget.window;
    if (this.contextTokens < w * PRUNE_AT || this.contextTokens - this.prunedAt < w * PRUNE_GROWTH) return false;
    const allItems = planPrune(this.messages, this.activeStart, KEEP_ROUNDS);
    if (!allItems.length) return false;
    const fullSaving = allItems.reduce((n, it) => n + it.chars - it.stub.length, 0) / 3.5;
    if (fullSaving < w * 0.04 || this.contextTokens - fullSaving >= this.budget.compactAt) return false;
    const cache = this.prefixCacheContext(18);
    const runwaySteps = Math.max(1, Math.floor(Math.max(0, this.budget.compactAt - (this.contextTokens - fullSaving)) / (cache.avgStepGrowth ?? 2500)));
    const requests = Math.min(18, runwaySteps, Math.max(1, this.mainRequests - this.prunedRequests));
    const cachedShare = cache.cachedShare;
    if (!prunePays({ context: this.contextTokens, saving: fullSaving, compactAt: this.budget.compactAt, requests, cachedShare })) return false;
    const cut = filterPruneByPrefixCut(this.messages, this.activeStart, allItems, { ...cache, remainingSteps: requests });
    if (cut) {
      const cutSaving = cut.items.reduce((n, it) => n + it.chars - it.stub.length, 0) / 3.5;
      if (cutSaving >= w * 0.04 && prunePays({ context: this.contextTokens, saving: cutSaving, compactAt: this.budget.compactAt, requests, cachedShare, invalidated: cut.invalidatedTokens })) {
        this.applyPrune(cut.items);
        return true;
      }
    }
    this.applyPrune(allItems);
    return true;
  }

  private applyPrune(items: PruneItem[]): void {
    const stubs = new Map(items.map((i) => [i.callId, i.stub]));
    const count = this.saveToolStubs(stubs, 'replace');
    if (!count) return;
    this.dropDraft();
    this.prunedAt = this.contextTokens;
    this.prunedRequests = this.mainRequests;
    this.refreshUsage();
    this.emit({ type: 'compaction', phase: 'pruned', after: this.contextTokens, count });
  }

  /** Keep the original result and pictures available to recall before replacing what the model carries. */
  private saveToolStubs(notes: Map<string, string>, how: 'replace' | 'append'): number {
    const saved: { callId: string; stub: string; blob: string }[] = [];
    for (const m of this.active()) {
      for (const p of m.parts) {
        if (p.type !== 'tool_result' || (how === 'replace' && p.pruned)) continue;
        const note = notes.get(p.callId);
        if (note === undefined) continue;
        const stub = how === 'append' ? `${p.content}\n${note}` : note;
        const blob = p.contentBlob ?? this.deps.store.blobs.put(p.content);
        p.contentBlob = blob;
        p.content = stub;
        p.pruned = true;
        for (const img of p.images ?? []) {
          if (img.data && !img.blob) img.blob = this.deps.store.blobs.put(Buffer.from(img.data, 'base64'), false);
          img.data = '';
          img.stripped = true;
        }
        saved.push({ callId: p.callId, stub, blob });
      }
    }
    if (!saved.length) return 0;
    this.deps.store.savePrune(this.meta, saved);
    this.anchorTokens = this.estimatePrefix() + this.active().reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0);
    this.sinceAnchor = 0;
    return saved.length;
  }

  private sessionImageDiskStatus(s: SessionImageSnapshot): string {
    if (!s.sourcePath || !s.sourceSha256) return '';
    const abs = resolvePath(this.meta.cwd, s.sourcePath);
    try {
      if (!fs.existsSync(abs)) return `, deleted from disk since snapshot ("${s.sourcePath}")`;
      const cur = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      if (cur !== s.sourceSha256) return `, modified on disk since snapshot (v1 snapshot in ${s.virtualPath}; current disk file at "${s.sourcePath}")`;
    } catch {
      /* ignore stat errors */
    }
    return '';
  }

  private sessionImagesManifest(): string {
    const list = this.allSessionImages();
    if (!list.length) return '';
    const lines = list.map((s) => {
      const src = s.sourcePath ? `file "${s.sourcePath}"` : s.origin === 'user' ? `user${s.name ? ` "${s.name}"` : ''}` : `tool ${s.toolName ?? 'image'}${s.name ? ` "${s.name}"` : ''}`;
      const dims = s.width && s.height ? `${s.width}×${s.height}` : s.mediaType;
      const kb = s.bytes ? `, ${Math.max(1, Math.round(s.bytes / 1024))} KB` : '';
      const disk = this.sessionImageDiskStatus(s);
      const digest = s.digest ? ` | captured notes: ${s.digest}` : '';
      return `- [${s.id}] ${src} (${dims}${kb}${disk}) | reopen: ${s.virtualPath}${digest}`;
    });
    return `<session_images>\nEvery image registered in this session (raw pixels leave context after this summary; preserve key visual facts per [img-NN] in an "Images" section inside <summary>):\n${lines.join('\n')}\n</session_images>`;
  }

  private sessionImagesDirectory(): string {
    const list = this.allSessionImages();
    if (!list.length) return '';
    const readName = this.toolName('read');
    const lines = list.map((s) => {
      const src = s.sourcePath ? `file "${s.sourcePath}"` : s.origin === 'user' ? `user${s.name ? ` "${s.name}"` : ''}` : `tool ${s.toolName ?? 'image'}${s.name ? ` "${s.name}"` : ''}`;
      const dims = s.width && s.height ? `${s.width}×${s.height}` : s.mediaType;
      const kb = s.bytes ? `, ${Math.max(1, Math.round(s.bytes / 1024))} KB` : '';
      const disk = this.sessionImageDiskStatus(s);
      const digest = s.digest ? ` | notes: ${s.digest}` : '';
      return `- [${s.id}] ${src} (${dims}${kb}${disk}) — open with ${this.readImageCallHint(s.virtualPath, true)}${digest}`;
    });
    return `Session images (raw pixels removed after summary; user attachments and earlier image reads are kept in the session store, not written to disk or temp folders — virtual paths below exist ONLY in the ${readName} tool, not on disk or in shell):\n${lines.join('\n')}`;
  }

  /**
   * Pictures past the unified window/provider budget are let go (context/images.ts): superseded views drop cleanly,
   * and any non-superseded overflow gets a concise visual digest before its raw bytes leave active context.
   */
  private maybeDropImages(signal?: AbortSignal): void | Promise<void> {
    const api = this.deps.catalog.provider(this.model.provider).api;
    const budget = imageBudget(this.budget.window, this.model.provider, api);
    const opts = {
      reopenedAt: this.imageReopenedAt,
      readCallHint: (v: string) => this.readImageCallHint(v),
      cache: this.prefixCacheContext(10),
    };
    const initial = planSessionImages(this.messages, this.activeStart, budget, opts);
    if (!initial.toolDrops.length && !initial.userDrops.length) return;

    const applyDrops = (planned: ReturnType<typeof planSessionImages>) => {
      let changed = false;
      if (planned.toolDrops.length) {
        const captions = new Map(planned.toolDrops.map((d) => [d.callId, d.caption]));
        if (this.saveToolStubs(captions, 'append')) changed = true;
      }
      if (planned.userDrops.length) {
        for (const u of planned.userDrops) {
          const m = this.messages[u.messageIndex];
          if (!m) continue;
          const img = u.image;
          if (img.data && !img.blob) img.blob = this.deps.store.blobs.put(Buffer.from(img.data, 'base64'), false);
          img.data = '';
          img.stripped = true;
          m.parts.push({ type: 'text', text: u.caption, synthetic: true });
          changed = true;
        }
        if (changed) {
          this.anchorTokens = this.estimatePrefix() + this.active().reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0);
          this.sinceAnchor = 0;
        }
      }
      if (changed) this.refreshUsage();
    };

    const unsupersededCalls = new Set(initial.toolDrops.filter((d) => !d.superseded).map((d) => d.callId));
    const needDigest: ImagePart[] = [];
    if (unsupersededCalls.size) {
      for (const m of this.active()) {
        for (const p of m.parts) {
          if (p.type === 'tool_result' && unsupersededCalls.has(p.callId)) {
            for (const img of p.images ?? []) if (img.data && !img.digest) needDigest.push(img);
          }
        }
      }
    }
    for (const u of initial.userDrops) if (u.image.data && !u.image.digest) needDigest.push(u.image);
    if (!needDigest.length) {
      applyDrops(initial);
      return;
    }
    return (async () => {
      await this.extractImageFacts(needDigest, signal);
      applyDrops(planSessionImages(this.messages, this.activeStart, budget, opts));
    })();
  }

  /** Maximum prompt tokens left for active context + new user turn after reserving output tokens and a 2% tokenizer margin. */
  private safeInputCeiling(): number {
    const safety = Math.max(512, Math.floor(this.budget.window * 0.02));
    return Math.max(1024, this.budget.window - this.budget.maxOutput - safety);
  }

  /** Estimated prompt tokens an incoming turn will add (text, attached images, and fixed message/note framing). */
  private incomingEstimate(text: string, images: ImagePart[]): number {
    const imgTokens = images.reduce((n, img) => n + estimateImageTokens(img), 0);
    const textTokens = Math.max(this.calibrator.adjust(estimateTokens(text)), estimateInboundTokens(text));
    return textTokens + this.calibrator.adjust(imgTokens + 160);
  }

  /**
   * When a single inbound user message would push the prompt past `safeInputCeiling()` even after pre-compacting prior
   * turns (or on Turn 1 when nothing can be compacted yet), store 100% of the unmodified text in `BlobStore` (`textBlob`)
   * so `recall` and `userWords` keep every character, and clip the in-context text (`75% head + recall marker + 25% tail`).
   */
  private fitInboundText(rawText: string, extraTokens: number, messageIndex: number): { text: string; textBlob?: string } {
    if (!rawText) return { text: rawText };
    const estText = (s: string) => Math.max(this.calibrator.adjust(estimateTokens(s)), estimateInboundTokens(s));
    const estRaw = estText(rawText);
    const rawActive = this.estimatePrefix() + this.active().reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0);
    // On Turn 1 (before Calibrator observes a provider response), `estimatePrefix()` (~chars/3.8) undercounts JSON
    // tool schemas by ~4k tokens on DeepSeek/cl100k; include `estimateInboundTokens` on the static prefix whenever the
    // incoming turn is large enough to approach the ceiling so tool-schema growth deducts 1-for-1 from `availTokens`.
    const inboundActive =
      estRaw > 4_096
        ? estimateInboundTokens(this.system) +
          estimateInboundTokens(JSON.stringify(this.specs)) +
          this.presetTokens +
          this.active().reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0)
        : 0;
    const usedTokens = Math.max(this.contextTokens, this.calibrator.adjust(rawActive), inboundActive) + extraTokens + 64;
    const hardAvail = Math.max(256, this.safeInputCeiling() - usedTokens);
    if (estRaw <= hardAvail) return { text: rawText };

    // Leave 20% working runway below `compactAt` (~21k tokens on a 128k window) when clipping an oversized message so
    // a full-size `recall` (~8k dense tokens) plus several read/edit/shell steps reuse the cached prefix without
    // immediately crossing `compactAt`.
    const clipCeiling =
      this.config.autoCompact === false
        ? this.safeInputCeiling()
        : Math.min(this.safeInputCeiling(), Math.floor(this.budget.compactAt * 0.8));
    const availTokens = Math.max(256, clipCeiling - usedTokens);
    const textBlob = this.deps.store.blobs.put(rawText);
    const charsPerToken = rawText.length / Math.max(1, estRaw);
    const recallName = this.toolName('recall');
    const leadingTrim = rawText.length - rawText.trimStart().length;
    const buildClipped = (budgetChars: number): string => {
      const markerReserve = 220;
      const bodyBudget = Math.max(160, budgetChars - markerReserve);
      const headLen = Math.min(rawText.length, Math.max(120, Math.floor(bodyBudget * 0.75)));
      const tailLen = Math.min(rawText.length - headLen, Math.max(40, bodyBudget - headLen));
      const omitted = rawText.length - headLen - tailLen;
      if (omitted <= 0) return rawText;
      const recallFrom = Math.max(0, headLen - leadingTrim);
      const marker = `\n\n[… ${omitted} chars omitted so this message fits the context window; the full ${rawText.length}-char message is saved in session history — call ${recallName} with message=${messageIndex}, from=${recallFrom} (or message=${messageIndex}, query="...") to read any omitted part …]\n\n`;
      return `${rawText.slice(0, headLen)}${marker}${tailLen > 0 ? rawText.slice(rawText.length - tailLen) : ''}`;
    };

    let targetChars = Math.max(320, Math.floor(availTokens * charsPerToken * 0.96));
    let clipped = buildClipped(targetChars);
    for (let pass = 0; pass < 4; pass++) {
      const est = estText(clipped);
      if (est <= availTokens || targetChars <= 320) break;
      targetChars = Math.max(320, Math.floor(targetChars * (availTokens / est) * 0.96));
      clipped = buildClipped(targetChars);
    }
    return clipped.length < rawText.length ? { text: clipped, textBlob } : { text: rawText };
  }

  private shouldCompact(incomingTokens = 0): boolean {
    const minActive = incomingTokens > 0 ? 2 : 3;
    if (this.active().length < minActive) return false;
    const hardLimit = this.budget.window - this.budget.maxOutput;
    const projected = this.contextTokens + incomingTokens;
    if (this.config.autoCompact === false) return projected > hardLimit;
    if (projected <= this.budget.compactAt) return false;
    // Right after a compaction the context can still sit near the mark on a small window;
    // wait for real growth instead of summarizing the summary every step.
    const grown = projected - this.compactedAt > Math.max(2000, this.budget.compactAt * 0.2);
    return grown || projected > hardLimit;
  }

  /**
   * Compact by hand (or for a model switch). While a turn runs it waits for that turn's next step, where every call
   * has its result: compacting beside a running tool left a call without its result and every later request failed,
   * and a summary written beside a turn left out what that turn added. Idle, it holds the session as a turn does,
   * so a message sent meanwhile waits for it and goes after the summary.
   */
  compact(reason: 'manual' | 'switch' = 'manual'): Promise<boolean> {
    if (this.running) {
      this.compactAsked ??= new Deferred<boolean>();
      return this.compactAsked.promise;
    }
    const run = this.compactNow(reason).finally(() => {
      this.running = null;
    });
    this.running = run
      .then(
        () => undefined,
        () => undefined,
      )
      // A model picked during the compaction waits for it as for a turn, then takes over.
      .then(() => this.afterTurn('done'));
    return run;
  }

  /**
   * Summarize the conversation and continue from the summary alone. The summary request reuses the
   * exact conversation prefix (same system prompt, tools and messages), so it is served from cache.
   */
  private async compactNow(reason: 'auto' | 'manual' | 'overflow' | 'switch', incomingTokens = 0): Promise<boolean> {
    // A summary of this context written in the background is of no use once it is summarized here.
    this.dropDraft();
    const active = this.active();
    if (active.length < 2 || this.controller?.signal.aborted) return false;
    const controller = new AbortController();
    this.compactionController = controller;
    const signal = this.controller ? AbortSignal.any([this.controller.signal, controller.signal]) : controller.signal;
    const before = this.contextTokens;
    const prevStatus = this.status;
    try {
      this.setStatus('compacting');
      this.emit({ type: 'compaction', phase: 'start', before });
      // A session opened before its facts arrived can be compacted before its first turn. The summary needs the same note.
      if (this.facts === undefined && this.factsJob) await this.factsJob;
      signal.throwIfAborted();
      // The recent work goes after the summary word for word (not after a model switch, whose tools have other names);
      // when pre-compacting ahead of a large incoming user turn, tighten the kept tail so the new turn fits unclipped.
      const defaultTailBudget = this.budget.window * (reason === 'overflow' ? 0.08 : 0.15);
      const summaryReserve = Math.max(4000, Math.floor(this.budget.window * 0.12));
      const tailBudget =
        incomingTokens > 0
          ? Math.max(0, Math.min(defaultTailBudget, this.safeInputCeiling() - incomingTokens - summaryReserve))
          : defaultTailBudget;
      const tail = reason === 'switch' || tailBudget <= 0 ? [] : tailOf(active, tailBudget);
      const { ask, record, evidence } = this.summaryAsk();
      const instruction: Message = { id: newId('m'), role: 'user', origin: 'harness', parts: [{ type: 'text', text: ask, synthetic: true }], time: Date.now() };
      let summary: string;
      try {
        const askTokens = Math.max(this.calibrator.adjust(estimateMessageTokens(instruction)), estimateInboundTokens(ask) + 8);
        const reuseCeiling = this.budget.window - Math.max(4_096, Math.floor(this.budget.window * 0.04));
        const canReuseFull = reason !== 'overflow' && before + askTokens < reuseCeiling;
        const slicedReuse = !canReuseFull && reason !== 'overflow' ? this.slicedReuseMessages(active, ask, askTokens) : null;
        const reuseMsgs = canReuseFull ? [...active, instruction] : slicedReuse;
        let res = reuseMsgs
          ? await this.summaryRequest(reuseMsgs, signal, true)
          : await this.summaryRequest([this.transcriptMessage(active, ask)], signal, false);
        // A reply that is no summary (the model went on with the work, wrote a tool call as text, or said it had summarized
        // "above": about 4 in 100 compactions of one model on 2026-11-05, each leaving the next context with nothing) is asked
        // again the way that cannot be taken for the work: the conversation as one transcript, with no tools.
        if (reuseMsgs && !isSummary(res)) res = await this.summaryRequest([this.transcriptMessage(active, ask)], signal, false);
        summary = res;
      } catch {
        signal.throwIfAborted();
        summary = await this.summaryRequest([this.transcriptMessage(active, ask)], signal, false);
      }
      signal.throwIfAborted();
      const body = summaryBody(summary);
      if (!body) {
        this.emit({ type: 'compaction', phase: 'failed', error: 'empty summary' });
        return false;
      }
      this.installSummary(body, {
        said: userWords(this.messages, this.budget.window, this.deps.store.blobs),
        tail,
        record,
        evidence,
        before,
        resume: prevStatus === 'running',
        summarizedUpTo: this.messages.length,
      });
      return true;
    } catch (e) {
      // The user's own stop is no failure to tell them of: the phase ends without a message.
      this.emit({ type: 'compaction', phase: 'failed', ...(signal.aborted ? {} : { error: (e as Error).message }) });
      if (reason === 'overflow') throw e;
      return false;
    } finally {
      this.compactionController = null;
      this.setStatus(prevStatus === 'compacting' ? 'running' : prevStatus);
    }
  }

  /**
   * What the summary request is told: the summary prompt, Favilla's record of the reads and the evidence so far. Not
   * which rounds stay word for word: a summary of only the part before them (pi's way) put the next step right 72.6%
   * of the time against 78.6% for one of everything (2026-11-05), and saying which rounds stay asks
   * for the same.
   */
  private summaryAsk(): { ask: string; record: string; evidence: string } {
    // Favilla's own record of which lines each read showed for files unchanged since (recordWrite clears edited files):
    // the summary must not claim more, and the next context gets it as fact.
    const read = this.files.coverage().map((c) => `${displayPath(this.meta.cwd, c.path)}: ${describeCoverage(c.ranges, c.total)}`);
    const record = read.length
      ? `Favilla's record of what your reads showed (exact for files unchanged since they were read; edited files are in the work record, and lines marked not read were never shown to you):\n${read.map((r) => `- ${r}`).join('\n')}`
      : '';
    const evidence = evidenceSummary(this.messages, this.meta.cwd);
    const images = this.sessionImagesManifest();
    const hasPriorSummary = this.active()[0]?.origin === 'compaction';
    const carryForward = hasPriorSummary
      ? '\n\nAn earlier <summary> appears at the start of this context. Carry forward into the new <summary> every still-relevant exact number, identifier, setting, revision chain (old -> new), [img-NN] image note, and finding from removed code or one-time command output; update items that later work superseded rather than dropping earlier context.'
      : '';
    const ask = `${promptAsset('compact')}${carryForward}${images ? `\n\n${images}` : ''}${record ? `\n\n${record}\nState in the summary which parts you have not read; do not describe them, or names in them, as known.` : ''}${evidence ? `\n\n${evidence}` : ''}`;
    return { ask, record, evidence };
  }

  /** Preserve `[img-NN]` factual lines from an earlier `<summary>` if a later compaction summary omitted that image id. */
  private withCarriedImageNotes(body: string): string {
    const prev = this.active()[0];
    if (!prev || prev.origin !== 'compaction') return body;
    const prevText = prev.parts.find((p): p is TextPart => p.type === 'text')?.text ?? '';
    const prevSummary = /<summary>\n?([\s\S]*?)\n?<\/summary>/.exec(prevText)?.[1];
    if (!prevSummary) return body;
    const carriedLines: string[] = [];
    const seenIds = new Set<string>();
    for (const rawLine of prevSummary.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const matches = [...line.matchAll(/\[(img-\d+)\]/gi)].map((m) => m[1].toLowerCase());
      if (!matches.length) continue;
      const missing = matches.filter((id) => !seenIds.has(id) && !new RegExp(`\\b${id.replace('-', '\\-')}\\b`, 'i').test(body));
      if (!missing.length) continue;
      for (const id of missing) seenIds.add(id);
      carriedLines.push(line.startsWith('-') || line.startsWith('*') ? line : `- ${line}`);
    }
    return carriedLines.length ? `${body}\n\nCarried image notes:\n${carriedLines.join('\n')}` : body;
  }

  /**
   * Continue from a summary: it goes in as one message, then `tail` word for word (copies, so the history stays
   * append-only), and what the model no longer sees leaves memory.
   */
  private installSummary(body: string, o: { said: string[]; tail: Message[]; record: string; evidence: string; before: number; resume: boolean; summarizedUpTo?: number; text?: string }): void {
    // Reads in the kept rounds, whole there: the files they showed, unchanged since, stay read after the summary. Every
    // file's read state had been dropped and the model told to read the recent ones again, though their text could
    // sit in the rounds right below (2026-11-06).
    // Favilla's own compaction only: under another agent's (evals) the read state goes as it always did.
    const own = o.text === undefined;
    const shownInTail = own ? o.tail.flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool_result' && !p.pruned && p.evidence?.reads ? p.evidence.reads.map((r) => ({ r, callId: p.callId })) : []))) : [];
    const stillShown = new Set(shownInTail.filter(({ r }) => fileDigest(r.path) === r.digest).map(({ r }) => normalizeForCompare(r.path)));
    // Files the kept rounds wrote, unchanged since: as editable after the summary as before it. A read followed by an
    // edit there had left the file listed for reading again, the read no longer matching it.
    const writtenInTail = own
      ? [
          ...new Set(
            o.tail.flatMap((m) =>
              m.parts.flatMap((p) => {
                if (p.type !== 'tool_result' || p.pruned) return [];
                const evWrites = p.evidence?.writes ?? [];
                const diffWrites = p.display?.kind === 'diff' ? p.display.files.map((f) => resolvePath(this.meta.cwd, f.path)) : [];
                return [...evWrites, ...diffWrites];
              }),
            ),
          ),
        ].filter((f) => this.files.checkEditable(f) === null)
      : [];
    for (const f of writtenInTail) stillShown.add(normalizeForCompare(f));
    const fresh = this.files.recent(10).filter((f) => !stillShown.has(normalizeForCompare(f)));
    // The newest two of them, small ones, come back whole as they are now (context/bench.ts); the rest are named.
    const bench = own ? workbench([...fresh].reverse(), Math.min(24_000, this.budget.window * 0.24)) : [];
    const onBench = new Set(bench.map((b) => normalizeForCompare(b.path)));
    const recent = fresh.filter((f) => !onBench.has(normalizeForCompare(f))).map((f) => displayPath(this.meta.cwd, f));
    // What the whole session did up to the kept rounds, from its calls: exact where the summary can forget (record.ts).
    const upTo = o.tail.length ? this.messages.indexOf(o.tail[0]) : this.messages.length;
    const work = workRecord(this.messages.slice(0, upTo < 0 ? this.messages.length : upTo), {
      clean: (p) => displayPath(this.meta.cwd, resolvePath(this.meta.cwd, p)),
      exists: (p) => fs.existsSync(resolvePath(this.meta.cwd, p)),
      // Outputs an earlier compaction or pruning took from memory are read back from where they are kept.
      text: (r) => (r.contentBlob && (r.pruned || !r.content) ? (this.deps.store.blobs.text(r.contentBlob) ?? r.content) : r.content),
    });
    const plan = this.todos.length ? `\n\nCurrent plan:\n${this.todos.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n')}` : '';
    const imagesDirectory = own ? this.sessionImagesDirectory() : '';
    const effectiveBody = own ? this.withCarriedImageNotes(body) : body;
    // Another agent's compaction (evals only) goes in as that agent writes it, with nothing of Favilla's beside it.
    const text = o.text ?? [
      'This session continues an earlier conversation that filled the context window. The summary below is everything you have from it.',
      `<summary>\n${effectiveBody}\n</summary>`,
      // The user's own words survive every compaction verbatim, carried from one summary to the next.
      o.said.length ? `Everything the user has said so far, verbatim (oldest first; the last is the most recent):\n${o.said.map((t) => `<message>\n${t}\n</message>`).join('\n')}` : '',
      imagesDirectory,
      // A summary written in the background covers the work up to where it was begun, and the rounds after it may have
      // taken its next step already.
      o.tail.length ? 'The messages after this one are your most recent work, kept word for word. They are newer than the summary: where they differ from it (a next step already taken, a failure since fixed), they are right.' : '',
      o.record ? `${o.record}\nWhat the summary says about those lines is what you learned from them; read again only when you need their exact text. Where the summary and this record disagree, the record is right: read the lines marked not read before relying on them.` : '',
      work,
      // Named so the model knows its picture of them is the summary's, with no order to read them: Favilla's edit works
      // from the exact text it replaces, and reading each first was most of the reads after a compaction (2026-11-06).
      bench.length ? `The files the work was on, as they are now, whole and numbered as a read shows them:\n\n${bench.map((b) => `${displayPath(this.meta.cwd, b.path)}\n${b.text}`).join('\n\n')}` : '',
      recent.length ? `Files touched recently whose text is not in the kept messages: ${recent.join(', ')}` : '',
      // Said here, where it matters, rather than in every request's system prompt.
      `An edit works from the exact text it replaces and shows the nearest lines when that text does not match, so an edit can go first; read a file again when you need its exact text. For an exact detail from earlier (an error, a path, the user's words, a tool's full output), use ${this.toolName('recall')} instead of guessing.`,
      o.evidence,
      this.meta.goal ? formatGoal(this.meta.goal) : '',
      plan.trim(),
      o.resume ? 'Continue the work from where it stopped, without asking the user to repeat anything.' : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    // Raw image pixels are never re-attached onto summaryMsg: every summarized image is documented in <summary> and
    // reopened on demand from BlobStore via its virtual `.favilla/images/img-NN.*` path.
    // The folder's facts open the summary as they opened the session, under another agent's compaction too: the system
    // prompt that carried them before does not.
    const folder = this.givenFacts() ?? this.facts;
    const summaryMsg: Message = {
      id: newId('m'),
      role: 'user',
      origin: 'compaction',
      parts: [{ type: 'text', text: `${folder ? `${folder}\n\n` : ''}${text}`, synthetic: true }],
      time: Date.now(),
      turn: this.turn || undefined,
      carried: o.said,
    };
    const summarizedCut = o.summarizedUpTo ?? this.messages.length;
    const lastIdx = this.messages.length - 1;
    const trailingUnansweredUser =
      lastIdx >= 0 && this.messages[lastIdx].role === 'user' && this.messages[lastIdx].origin === 'user' ? lastIdx : -1;
    // Copies, so the history stays append-only; already-summarized images (`< summarizedCut`) shed their raw bytes here
    // while any newer post-draft images (`>= summarizedCut`) keep theirs intact.
    const copies = o.tail.map((m): Message => {
      const origIdx = this.messages.indexOf(m);
      const copy: Message = { ...structuredClone(m), id: newId('m'), replay: true };
      if (own && origIdx >= 0 && origIdx < summarizedCut && origIdx !== trailingUnansweredUser) {
        const strippedIds: string[] = [];
        for (const p of copy.parts) {
          if (p.type === 'image' && p.data) {
            if (!p.blob) p.blob = this.deps.store.blobs.put(Buffer.from(p.data, 'base64'), false);
            p.data = '';
            p.stripped = true;
            if (p.id) strippedIds.push(p.id);
          } else if (p.type === 'tool_result' && p.images?.some((img) => img.data)) {
            const ids: string[] = [];
            for (const img of p.images) {
              if (!img.data) continue;
              if (!img.blob) img.blob = this.deps.store.blobs.put(Buffer.from(img.data, 'base64'), false);
              img.data = '';
              img.stripped = true;
              if (img.id) ids.push(img.id);
            }
            if (ids.length) {
              const hints = ids.map((id) => {
                const snap = this.lookupSessionImage(id, false);
                return snap ? `${id} via ${this.readImageCallHint(snap.virtualPath)}` : id;
              });
              p.content += `\n[Raw pixels removed after compaction; reopen ${hints.join(', ')}.]`;
            }
          }
        }
        if (strippedIds.length) {
          const hints = strippedIds.map((id) => {
            const snap = this.lookupSessionImage(id, false);
            return snap ? `${id} via ${this.readImageCallHint(snap.virtualPath)}` : id;
          });
          copy.parts.push({ type: 'text', text: `[Raw pixels removed after compaction; reopen ${hints.join(', ')}.]`, synthetic: true });
        }
      }
      return copy;
    });
    // What the compaction did, in numbers a front end shows on its line: the size it left is estimated like the anchor below.
    const keptTokens = copies.reduce((n, c) => n + estimateMessageTokens(sendable(c)), 0);
    summaryMsg.compacted = { before: o.before, after: 0, rounds: o.tail.filter((m) => m.role === 'assistant').length, ...(o.tail[0] ? { from: o.tail[0].id } : {}) };
    summaryMsg.compacted.after = Math.round(this.estimatePrefix() + estimateMessageTokens(summaryMsg) + keptTokens);
    this.messages.push(summaryMsg);
    this.deps.store.saveMessage(this.meta, summaryMsg);
    this.activeStart = this.messages.length - 1;
    this.deps.store.saveCompaction(this.meta, this.activeStart);
    for (const c of copies) {
      this.messages.push(c);
      this.deps.store.saveMessage(this.meta, c);
    }
    // What the model no longer sees leaves memory: long outputs and images stay on disk, the UI shows previews.
    const old = this.messages.slice(0, this.activeStart);
    for (const m of old) release(m, this.deps.store.blobs);
    this.deps.store.saveReleased(this.meta, old.flatMap(blobRefs));
    this.emit({ type: 'message.added', message: summaryMsg });
    // Every file's text went with the summary (the 50 latest had been forgotten, older ones left as read), save what the
    // kept rounds show.
    this.files.forgetAll();
    for (const { r, callId } of shownInTail) this.files.keepShown(r, callId);
    for (const f of writtenInTail) this.files.recordWrite(f);
    for (const b of bench) {
      this.files.recordRead(b.path);
      this.files.recordShown(b.path, summaryMsg.id, 1, b.lines, b.lines);
    }
    this.callHistory = [];
    this.anchorTokens = this.estimatePrefix() + estimateMessageTokens(summaryMsg) + copies.reduce((n, c) => n + estimateMessageTokens(sendable(c)), 0);
    this.sinceAnchor = 0;
    this.compactedAt = this.contextTokens;
    this.prunedAt = 0;
    this.prunedRequests = this.mainRequests;
    this.refreshUsage();
    this.emit({ type: 'compaction', phase: 'end', before: o.before, after: this.contextTokens });
  }

  /**
   * Past three quarters of the way to the compaction mark, the summary is written in the background from the
   * conversation as it stands; the agent works on meanwhile. At the mark it is ready: it covers everything up to
   * where it was taken, and what came after goes in word for word, so nothing is lost and nobody waits for the
   * summary (mid-turn compactions took minutes while the agent stood still).
   */
  private maybeDraft(): void {
    if (this.draft || this.role !== 'main' || this.config.autoCompact === false) return;
    // A server that answers one request at a time (most local ones) would queue the summary, up to 16k tokens, ahead
    // of the agent's next step. A local proxy to a cloud service says it takes more (slots in its settings).
    if (this.deps.catalog.provider(this.model.provider).serial) return;
    // Before the mark only: at or past it there is no time to write one ahead, and compaction runs as usual.
    if (this.contextTokens < this.budget.compactAt * DRAFT_AT || this.contextTokens >= this.budget.compactAt) return;
    // Right after a compaction the context may still sit near the mark on a small window: wait for real growth.
    if (this.compactedAt && this.contextTokens - this.compactedAt < Math.max(2000, this.budget.compactAt * 0.2)) return;
    const active = this.active();
    if (active.length < 4) return;
    const { ask } = this.summaryAsk();
    const instruction: Message = { id: newId('m'), role: 'user', origin: 'harness', parts: [{ type: 'text', text: ask, synthetic: true }], time: Date.now() };
    const controller = new AbortController();
    const draft: NonNullable<Session['draft']> = { upTo: this.messages.length, activeStart: this.activeStart, startedAt: Date.now(), controller, body: undefined, done: Promise.resolve() };
    draft.done = this.summaryRequest([...active, instruction], controller.signal, true).then(
      (text) => {
        // No summary in the reply: no draft, and the compaction at the mark writes one the usual way.
        draft.body = isSummary(text) ? summaryBody(text) : null;
      },
      (e) => {
        draft.body = null;
        debug('compaction', 'background summary failed', String(e));
      },
    );
    this.draft = draft;
    debug('compaction', 'background summary started', { tokens: this.contextTokens, mark: this.budget.compactAt });
  }

  private dropDraft(): void {
    this.draft?.controller.abort();
    this.draft = null;
  }

  /**
   * At the compaction mark: the background summary, used. True when the context was compacted with it, or when it
   * is still being written and there is room to go on working until it is; false when there is none to use (or
   * what came after it no longer fits), so the caller compacts the usual way.
   */
  private async useDraft(incomingTokens = 0): Promise<boolean> {
    const d = this.draft;
    if (!d) return false;
    if (d.activeStart !== this.activeStart) {
      this.dropDraft();
      return false;
    }
    // Room to keep working while it is written: the window less what a step's reply needs (the mark itself sits
    // a whole maximum reply below the window, which steps never use).
    const room = this.budget.window - Math.min(this.budget.maxOutput, 16_000) - this.budget.window * 0.03;
    if (d.body === undefined && this.contextTokens + incomingTokens < room) return true;
    const tail = this.messages.slice(d.upTo);
    const tailTokens = this.calibrator.adjust(tail.reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0));
    const tailCap = this.budget.window * 0.22;
    const maxTailTokens =
      incomingTokens > 0
        ? Math.max(0, Math.min(tailCap, this.safeInputCeiling() - incomingTokens - Math.max(4000, Math.floor(this.budget.window * 0.12))))
        : tailCap;
    // The work since the snapshot must start with a reply and fit comfortably; never wait on a draft that cannot fit.
    if (!tail.length || tail[0].role !== 'assistant' || tailTokens > maxTailTokens) {
      this.dropDraft();
      return false;
    }
    const prevStatus = this.status;
    const before = this.contextTokens;
    try {
      if (d.body === undefined) {
        const budgetMs = DRAFT_WAIT_MS();
        const waitMs = Math.max(Math.min(5_000, budgetMs), budgetMs - (Date.now() - d.startedAt));
        this.setStatus('compacting');
        let timer: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([
          d.done.then(() => false),
          new Promise<boolean>((r) => (timer = setTimeout(() => r(true), waitMs))),
        ]);
        clearTimeout(timer);
        if (timedOut && d.body === undefined) {
          debug('compaction', 'background summary timed out; compacting fresh', { waitMs, before });
          this.dropDraft();
          return false;
        }
        if (d.controller.signal.aborted || this.controller?.signal.aborted) return false;
      }
      this.draft = null;
      if (!d.body || this.controller?.signal.aborted) return false;
      // The user's words as they stand now: what they said while the draft was written is not in the draft.
      // Favilla's record of the reads and the evidence as they stand now: the draft's were taken when it began, and a file
      // changed in the rounds since was still in its record as read and unchanged.
      const said = userWords(this.messages, this.budget.window, this.deps.store.blobs);
      const now = this.summaryAsk();
      const estPostInstall =
        this.calibrator.adjust(
          this.estimatePrefix() +
            estimateTokens(d.body) +
            estimateTokens(said.join('\n')) +
            estimateTokens(now.record) +
            estimateTokens(now.evidence),
        ) + tailTokens;
      if (estPostInstall > this.budget.compactAt * 0.72 && before - estPostInstall < this.budget.compactAt * 0.25) {
        debug('compaction', 'background summary leaves too little headroom; compacting fresh', { before, estPostInstall, mark: this.budget.compactAt });
        return false;
      }
      this.emit({ type: 'compaction', phase: 'start', before });
      this.installSummary(d.body, {
        said,
        tail,
        record: now.record,
        evidence: now.evidence,
        before,
        resume: prevStatus === 'running',
        summarizedUpTo: d.upTo,
      });
      debug('compaction', 'background summary used', { before, after: this.contextTokens, kept: tail.length });
      return true;
    } finally {
      if (this.status === 'compacting' && prevStatus !== 'compacting') this.setStatus(prevStatus);
    }
  }

  private async summaryRequest(messages: Message[], signal: AbortSignal, reuse: boolean, o: { system?: string; maxOutputTokens?: number; usable?: (text: string) => boolean } = {}): Promise<string> {
    // Where tool_choice: 'none' misses the provider's prompt cache, ask first with the main loop's own prefix; any
    // reply that carries tool calls or no summary is discarded without running anything and falls back once to 'none'.
    if (reuse && this.model.quirks.toolChoiceBreaksCache) {
      const first = await this.sendSummary(messages, signal, true, undefined, o);
      if ((o.usable ?? isSummary)(first)) return first;
      debug('compaction', 'summary fallback to tool_choice: none', { model: this.model.id, chars: first.length });
    }
    return this.sendSummary(messages, signal, reuse, 'none', o);
  }

  private async sendSummary(messages: Message[], signal: AbortSignal, reuse: boolean, toolChoice: 'auto' | 'none' | undefined, o: { system?: string; maxOutputTokens?: number }): Promise<string> {
    // The pictures the main requests carry, no more: the same prefix, and no body the provider refuses for its size.
    const outPics = this.fitOutboundPictures(messages);
    const fitted = Array.isArray(outPics) ? outPics : await outPics;
    let turnStart = 0;
    for (let i = fitted.length - 1; i >= 0; i--) {
      if (fitted[i].role === 'user' && (fitted[i].origin === 'user' || fitted[i].origin === 'compaction')) {
        turnStart = i;
        break;
      }
    }
    const activeRaw = this.estimatePrefix() + this.active().reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0);
    const effectiveScale = activeRaw > 0 ? Math.max(this.calibrator.factor, this.contextTokens / activeRaw) : this.calibrator.factor;
    const rawFitted = (reuse ? this.estimatePrefix() : 512) + fitted.reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0);
    const lastFittedMsg = fitted[fitted.length - 1];
    const lastDenseTokens = lastFittedMsg
      ? lastFittedMsg.parts.reduce((n, p) => n + (p.type === 'text' ? estimateInboundTokens(p.text) : 0), 8)
      : 0;
    const lastFittedTokens = lastFittedMsg
      ? Math.max(Math.ceil(estimateMessageTokens(lastFittedMsg) * effectiveScale), lastDenseTokens)
      : 0;
    const estSummaryInput = reuse
      ? fitted.length > this.active().length
        ? Math.max(this.contextTokens + lastFittedTokens, Math.ceil(rawFitted * effectiveScale))
        : Math.ceil((rawFitted - (lastFittedMsg ? estimateMessageTokens(sendable(lastFittedMsg)) : 0)) * effectiveScale) + lastFittedTokens
      : Math.max(this.calibrator.adjust(rawFitted), lastDenseTokens + 512);
    const summarySafety = Math.max(512, Math.floor(this.budget.window * 0.01));
    const availSummaryOut = Math.max(2_048, this.budget.window - estSummaryInput - summarySafety);
    const call = this.providerCall(fitted, signal, {
      maxOutputTokens: Math.min(this.budget.maxOutput, o.maxOutputTokens ?? 16_000, availSummaryOut),
      turnStart,
      ...(toolChoice ? { toolChoice } : {}),
      ...(reuse ? {} : { system: o.system ?? 'You write precise hand-off summaries of coding sessions.', tools: [], hostedSearch: false }),
    });
    const deep = EFFORT_ORDER.indexOf(call.effort) >= EFFORT_ORDER.indexOf('high');
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const local = new AbortController();
      const linked = AbortSignal.any([signal, local.signal]);
      const silence = watchStreamSilence(deep, () => local.abort());
      let delay: number;
      try {
        silence.touch(true);
        const res = await adapterFor(call.provider.api).stream({ ...call, signal: linked }, (e) => silence.touch(isStreamWord(e)));
        linked.throwIfAborted();
        if (res.stop === 'aborted') throw new ProviderError('aborted', 'Aborted');
        this.recordUsage(res.usage, 0);
        if (res.stop === 'tool_use' || res.parts.some((p) => p.type === 'tool_call')) return '';
        const text = res.parts.filter((p) => p.type === 'text').map((p) => (p as TextPart).text).join('');
        // A summary the limit cut still beats none, but the next context has to know where it stops.
        return res.stop === 'max_tokens' ? `${text.replace(/<\/summary>\s*$/, '')}\n\n[The summary stops here: the output limit cut it. recall finds the details.]` : text;
      } catch (e) {
        signal.throwIfAborted();
        // A local cancellation from the watch is a failed attempt even if the adapter returned a partial reply.
        const err = local.signal.aborted ? new ProviderError('stream_stalled', 'The response stalled; retrying.') : e;
        if (!(err instanceof ProviderError) || !err.retryable || attempt >= 4) throw err;
        delay = Math.min(err.retryAfterMs ?? 2000 * 2 ** attempt, 60_000);
      } finally {
        silence.close();
      }
      await sleep(delay, signal);
    }
  }

  /**
   * When `active` as a whole outgrew the reuse ceiling (e.g. a late step produced a huge output or reply),
   * keep the longest complete-round prefix `active.slice(0, cut)` that fits inside 70% of the window so
   * `[system + tools + active[0..cut-1]]` still hits the provider's prompt cache, and render only `active.slice(cut)`
   * as a bounded plain-text excerpt inside the summary instruction.
   */
  private slicedReuseMessages(active: Message[], ask: string, askTokens: number): Message[] | null {
    const prefixBudget = Math.floor(this.budget.window * 0.7) - askTokens;
    if (prefixBudget < 4_096) return null;
    const weightOf = (m: Message): number => {
      const sendM = sendable(m);
      const denseTextTokens = sendM.parts.reduce(
        (n, p) =>
          n +
          (p.type === 'text'
            ? estimateInboundTokens(p.text)
            : p.type === 'tool_result'
              ? estimateInboundTokens(p.content)
              : 0),
        4,
      );
      return Math.max(this.calibrator.adjust(estimateMessageTokens(sendM)), denseTextTokens);
    };
    const baseWeight = this.calibrator.adjust(this.estimatePrefix());
    const weights = active.map(weightOf);
    const totalEst = baseWeight + weights.reduce((a, b) => a + b, 0);
    const anchorScale = totalEst > 0 ? Math.max(1, this.contextTokens / totalEst) : 1;

    let running = Math.ceil(baseWeight * anchorScale);
    let bestCut = 0;
    for (let i = 0; i < active.length - 1; i++) {
      running += Math.ceil(weights[i] * anchorScale);
      if (running > prefixBudget) break;
      if (!active[i + 1].parts.some((p) => p.type === 'tool_result')) {
        bestCut = i + 1;
      }
    }
    if (bestCut < 2) return null;
    const tailBudgetTokens = Math.max(2_048, Math.floor(this.budget.window * 0.12));
    const tailExcerpt = this.renderTranscriptBody(active.slice(bestCut), Math.floor(tailBudgetTokens * 2.8), tailBudgetTokens);
    const wrappedAsk = `The final steps below were trimmed to plain text so this request fits the context window:\n\n<recent-steps>\n${tailExcerpt}\n</recent-steps>\n\n${ask}`;
    const instruction: Message = {
      id: newId('m'),
      role: 'user',
      origin: 'harness',
      parts: [{ type: 'text', text: wrappedAsk, synthetic: true }],
      time: Date.now(),
    };
    return [...active.slice(0, bestCut), instruction];
  }

  /** Render `messages` as bounded plain-text lines, enforcing both a character limit and an optional structural token ceiling. */
  private renderTranscriptBody(messages: Message[], limit: number, maxTokensBudget?: number): string {
    const per = Math.max(400, Math.floor(limit / Math.max(1, messages.length) / 2));
    // An earlier compaction's message is the whole of the work before it: it goes in whole and first, and the cut for
    // length falls on the rest. Cut like any note, it had lost its second half, the user's words and the work record
    // among it, and the omission at the start fell on it first.
    const earlier: string[] = [];
    const lines: string[] = [];
    for (const m of messages) {
      for (const p of m.parts) {
        if (p.type === 'text' && m.origin === 'compaction') earlier.push(`EARLIER SUMMARY: ${summaryAndWords(p.text)}`);
        else if (p.type === 'text') {
          const full = fullText(p, this.deps.store.blobs);
          const shown = full.length > per * 3 ? `${full.slice(0, per * 2)}…${full.slice(-per)}` : full;
          lines.push(`${m.role === 'user' ? (p.synthetic ? 'NOTE' : 'USER') : 'ASSISTANT'}: ${shown}`);
        } else if (p.type === 'image') {
          const dims = p.width && p.height ? `${p.width}×${p.height}` : p.mediaType;
          lines.push(`USER IMAGE [${p.id ?? p.name ?? 'image'}] (${dims})${p.digest ? `: ${p.digest}` : ''}`);
        } else if (p.type === 'tool_call') lines.push(`TOOL CALL ${p.name}: ${oneLine(p.raw ?? JSON.stringify(p.input), 600)}`);
        else if (p.type === 'tool_result') {
          const imgs = p.images?.length ? ` [images: ${p.images.map((i) => `${i.id ?? i.name ?? 'image'}${i.digest ? ` (${i.digest})` : ''}`).join(', ')}]` : '';
          lines.push(`TOOL RESULT ${p.name}${p.isError ? ' (error)' : ''}${imgs}: ${p.content.length > per ? `${p.content.slice(0, per / 2)}…${p.content.slice(-per / 2)}` : p.content}`);
        }
      }
    }
    // Bounded, so an overflow compaction cannot overflow again with it: the rest always gets four tenths.
    let head = earlier.join('\n');
    if (head.length > limit * 0.6) head = `${head.slice(0, Math.floor(limit * 0.6))}…`;
    let text = lines.join('\n');
    const room = Math.max(400, limit - head.length);
    if (text.length > room) text = `…(earliest part omitted)…\n${text.slice(text.length - room)}`;
    let combined = head ? `${head}\n${text}` : text;
    if (maxTokensBudget && maxTokensBudget > 512) {
      const est = estimateInboundTokens(combined);
      if (est > maxTokensBudget) {
        const keepChars = Math.max(600, Math.floor(combined.length * (maxTokensBudget / est) * 0.94));
        if (head && head.length < keepChars * 0.6) {
          const restKeep = Math.max(300, keepChars - head.length);
          combined = `${head}\n…(earliest part omitted)…\n${text.slice(Math.max(0, text.length - restKeep))}`;
        } else {
          combined = `…(earliest part omitted)…\n${combined.slice(Math.max(0, combined.length - keepChars))}`;
        }
      }
    }
    return combined;
  }

  /** The conversation rendered as plain text with long outputs cut, for summarizing when it no longer fits. */
  private transcriptMessage(messages: Message[], ask: string): Message {
    const limit = Math.floor(Math.max(this.budget.window * 0.5, this.budget.window - 20_000) * 3.2);
    const text = this.renderTranscriptBody(messages, limit, Math.floor(this.budget.window * 0.76));
    return {
      id: newId('m'),
      role: 'user',
      parts: [{ type: 'text', text: `Here is a transcript of a coding session between a user and an AI agent.\n\n<transcript>\n${text}\n</transcript>\n\n${ask}` }],
      time: Date.now(),
    };
  }

  // ── undo ─────────────────────────────────────────────────────────────────

  /** Restore files changed by `turn` and every later turn, once the last turn's snapshot is in. */
  async undoFiles(turn: string): Promise<string[]> {
    const checkIdle = () => {
      if (this.busy) throw new Error('Wait for the current turn to finish.');
      if (this.background.size || this.tasks.size || this.shadowWork.size) throw new Error('Wait for background work to finish or stop it before undoing file changes.');
    };
    checkIdle();
    await this.pointEnd;
    checkIdle();
    const restored = this.checkpoints.revertFrom(turn);
    for (const f of restored) this.files.forget(f);
    if (restored.length) this.notes.push(`The user reverted file changes: ${restored.map((f) => displayPath(this.meta.cwd, f)).join(', ')}. Read files again before relying on earlier content.`);
    return restored;
  }

  /**
   * What a restore point would put back: the files whose content now differs from before the turn. A file made and
   * removed since (a scratch script) or changed back has nothing to put back, and showed as an empty +0 −0 row.
   */
  turnChanges(turn: string) {
    return this.shown(this.checkpoints.changes(turn));
  }

  /** `turnChanges` without holding the thread on the folder's snapshots: for the app, which asks after every turn. */
  async turnChangesAsync(turn: string) {
    return this.shown(await this.checkpoints.changesAsync(turn));
  }

  private shown(changes: Change[]) {
    return changes.filter((c) => c.before !== c.after).map((c) => ({ ...c, path: displayPath(this.meta.cwd, c.path) }));
  }

  /**
   * Before the process ends: the running turn stops and ends cleanly (its calls answered, waiting messages kept) and
   * background jobs are ended, within `ms`. Closing without this left a call with no result, and every later request
   * of the session failed.
   */
  async wind(ms = 3000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((r) => (timer = setTimeout(r, ms)));
    await Promise.race([Promise.all([this.stop(), this.jobs.disposeAll()]), late]);
    clearTimeout(timer);
  }

  dispose(): void {
    this.disposed = true;
    this.deps.store.locks.release(this.id);
    clearTimeout(this.browserIdle);
    this.dropDraft();
    this.abort();
    void this.jobs.disposeAll();
    this.browserSession?.close();
    this.browserSession = null;
    this.desktopSession?.close();
    this.desktopSession = null;
    this.lsp?.close();
    this.lsp = null;
    this.listeners.clear();
  }
}

/** What git counts as changed under `cwd`, with modification times; null outside a repository or when it is too slow. */
async function changedInTree(cwd: string): Promise<Map<string, number> | null> {
  const git = (args: string[]) =>
    new Promise<string | null>((resolve) => {
      execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 5000, windowsHide: true }, (e, out) => resolve(e ? null : out));
    });
  const [prefix, status] = await Promise.all([git(['rev-parse', '--show-prefix']), git(['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', '--', '.'])]);
  if (prefix === null || status === null) return null;
  const marks = new Map<string, number>();
  // Status paths start at the repository's root.
  for (const entry of status.split('\0').filter(Boolean).slice(0, 20_000)) {
    const file = entry.slice(3 + prefix.trim().length);
    let at = 0;
    try {
      at = fs.statSync(path.join(cwd, file)).mtimeMs;
    } catch {
      /* deleted: stays 0 */
    }
    marks.set(file, at);
  }
  return marks;
}

/** The summary inside <summary> tags (or the whole reply when the tags are missing). */
/** A reply that holds a summary: its tags round a real body, and no tool call written out as text. */
/**
 * An earlier compaction's message as a transcript carries it: its summary and the user's words. Favilla's record of the
 * reads, the work record and the evidence after them are written again, over the whole session, by the compaction
 * under way, and twice over they only took room.
 */
function summaryAndWords(text: string): string {
  const ends = ["\n\nSession images (", "\n\nThe messages after this one are your most recent work", "\n\nFavilla's record of what your reads showed", '\n\nWhat the work before this point did', '\n\nFiles touched recently', '\n\nRecorded observations']
    .map((m) => text.indexOf(m))
    .filter((i) => i >= 0);
  return ends.length ? text.slice(0, Math.min(...ends)) : text;
}

/** The folder's facts a note or a summary opens with (prompt/env.ts projectFacts); undefined when it opens with none. */
function factsIn(text: string): string | undefined {
  const body = text.startsWith('<harness-note>') ? text.slice('<harness-note>'.length) : text;
  if (!body.startsWith(FACTS_START)) return undefined;
  // A note holds them alone; in a summary the rest follows a blank line, and the facts have none.
  const end = body.indexOf('\n\n');
  return (end < 0 ? body : body.slice(0, end)).replace(/<\/harness-note>$/, '');
}

export function isSummary(text: string): boolean {
  const body = /<summary>([\s\S]*?)(<\/summary>|$)/.exec(text)?.[1] ?? '';
  return /<summary>/.test(text) && body.trim().length >= 20 && !/<\|open\|>\s*tools|<tool_call>|<function_calls>/.test(body);
}

function summaryBody(text: string): string {
  const m = /<summary>([\s\S]*?)(<\/summary>|$)/.exec(text);
  return (m ? m[1] : text).trim();
}
