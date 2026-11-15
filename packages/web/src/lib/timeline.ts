import type { Draft, Message, RunningTool, ToolResultPart } from './types';
import { toolTitle } from './steps';
import { foldTurns, type Work } from './turns';

// ── blocks ─────────────────────────────────────────────────────────────────

export type Block =
  | { kind: 'user'; key: string; m: Message }
  | { kind: 'steer'; key: string; text: string }
  | { kind: 'compaction'; key: string; m: Message }
  | { kind: 'text'; key: string; text: string; streaming?: boolean; final?: boolean; ended?: boolean; turn?: string; ledger?: Ledger }
  | { kind: 'reasoning'; key: string; text: string; live?: boolean }
  | { kind: 'tool'; key: string; id: string; draftKey?: string; opaque?: boolean; name: string; title: string; input?: Record<string, unknown>; live?: RunningTool; forming?: string; result?: ToolResultPart }
  | { kind: 'refusal'; key: string; text: string };

export type Step = Extract<Block, { kind: 'tool' | 'reasoning' }>;
export type Item = Exclude<Block, Step> | { kind: 'process'; key: string; anchorKey?: string; steps: Step[] } | Work<Item>;

/** What the user sent while the agent worked: the words kept with the note (`said`), or, in older sessions, the note's text after its first line. */
function steerText(m: Message): string {
  return m.parts
    .filter((p) => p.type === 'text' && p.synthetic && ((p as { said?: string }).said !== undefined || /^The user sent this (message )?while you were working/.test(p.text)))
    .map((p) => (p as { said?: string }).said ?? (p as { text: string }).text.replace(/^[^\n]*\n/, ''))
    .join('\n\n');
}

/** What a turn took and did, from what Favilla recorded: time with the model and with tools, files, checks. */
export interface Ledger {
  ms: number;
  modelMs: number;
  requests: number;
  files: { path: string; added: number; removed: number }[];
  runs: { command: string; state: 'passed' | 'failed' | 'unknown'; before?: boolean; exit: number | null; ms: number }[];
}

/** Each turn's ledger, for turns that ran a tool; plain answers have none. */
function ledgers(messages: Message[]): Map<string, Ledger> {
  const byTurn = new Map<string, Message[]>();
  for (const m of messages) {
    if (!m.turn || m.replay) continue;
    const list = byTurn.get(m.turn);
    if (list) list.push(m);
    else byTurn.set(m.turn, [m]);
  }
  const out = new Map<string, Ledger>();
  for (const [turn, ms] of byTurn) {
    let modelMs = 0;
    let requests = 0;
    const files = new Map<string, { path: string; added: number; removed: number }>();
    const runs: Ledger['runs'] = [];
    let tools = 0;
    ms.forEach((m, i) => {
      if (m.role === 'assistant') {
        requests++;
        if (i > 0) modelMs += Math.max(0, m.time - ms[i - 1].time);
      }
      for (const p of m.parts) {
        if (p.type !== 'tool_result') continue;
        tools++;
        const d = p.display;
        if (d?.kind === 'diff') {
          for (const f of d.files) {
            const cur = files.get(f.path) ?? { path: f.path, added: 0, removed: 0 };
            cur.added += f.added;
            cur.removed += f.removed;
            files.set(f.path, cur);
          }
        } else if (d?.kind === 'terminal' && !d.background) {
          // What the engine concluded, never a second reading of the exit code; only older sessions lack it.
          const run = p.evidence?.run;
          runs.push({ command: d.command, state: run?.outcome ?? (d.exitCode === 0 ? 'passed' : 'failed'), before: run?.before, exit: d.exitCode, ms: d.durationMs });
        } else if (d?.kind === 'checks') for (const r of d.results) runs.push({ command: r.command, state: d.incomplete ? 'unknown' : r.ok ? 'passed' : 'failed', before: d.before, exit: r.ok ? 0 : null, ms: r.durationMs });
      }
    });
    if (!tools) continue;
    out.set(turn, { ms: Math.max(0, ms[ms.length - 1].time - ms[0].time), modelMs, requests, files: [...files.values()], runs });
  }
  return out;
}

/** Answers the harness asked to rewrite: the rewrite follows, and the draft is not shown. */
function asksForRewrite(m: Message | undefined): boolean {
  return m?.origin === 'harness' && m.parts.some((p) => p.type === 'text' && p.text.includes('Rewrite your last message'));
}

function rewrittenAnswers(messages: Message[]): Set<string> {
  const rewritten = new Set<string>();
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && asksForRewrite(messages[i + 1])) rewritten.add(m.id);
  });
  return rewritten;
}

function toBlocks(messages: Message[], { results, running }: TimelineInput, rewritten: ReadonlySet<string>) {
  const out: Block[] = [];
  const calls = new Set<string>();
  const turns = new Set<string>();
  for (const m of messages) {
    // Copies of recent work placed after a compaction summary: the originals are already on screen.
    if (m.replay) continue;
    if (m.turn) turns.add(m.turn);
    if (m.role === 'assistant') {
      m.parts.forEach((p, i) => {
        const key = `${m.id}:${i}`;
        if (p.type === 'reasoning' && p.text.trim()) out.push({ kind: 'reasoning', key, text: p.text });
        else if (p.type === 'text' && p.text.trim() && !rewritten.has(m.id)) out.push({ kind: 'text', key, text: p.text, turn: m.turn, ended: !m.stop || m.stop === 'end' });
        else if (p.type === 'opaque') {
          // The provider's own web search runs on its side; show what it looked up.
          const d = (p.data ?? {}) as { action?: { type?: string; query?: string; queries?: string[]; url?: string; pattern?: string }; name?: string; input?: { query?: string } };
          const a = d.action ?? {};
          const title =
            p.label === 'web_search_call'
              ? a.type === 'open_page'
                ? (a.url ?? '')
                : a.type === 'find_in_page'
                  ? `${a.pattern ?? ''} · ${a.url ?? ''}`
                  : (a.query ?? a.queries?.join(' · ') ?? '')
              : p.label === 'server_tool_use' && d.name === 'web_search'
                ? (d.input?.query ?? '')
                : '';
          if (title) out.push({ kind: 'tool', key, id: key, opaque: true, name: 'web_search', title });
        } else if (p.type === 'tool_call') {
          calls.add(p.id);
          const live = results.has(p.id) ? undefined : running.get(p.id);
          const input = (p.input ?? {}) as Record<string, unknown>;
          out.push({ kind: 'tool', key: p.id, id: p.id, draftKey: key, name: p.name, title: live?.title ?? toolTitle(p.name, input), input, live, result: results.get(p.id) });
        }
      });
      if (m.stop === 'refusal') out.push({ kind: 'refusal', key: `${m.id}:refusal`, text: (m as Message & { refusal?: string }).refusal ?? '' });
    } else if (m.origin === 'compaction') out.push({ kind: 'compaction', key: m.id, m });
    else if (m.origin === 'user') out.push({ kind: 'user', key: m.id, m });
    else if (m.origin === 'tool') {
      const text = steerText(m);
      if (text) out.push({ kind: 'steer', key: m.id, text });
    }
  }
  return { blocks: out, calls, turns };
}

function appendLive(out: Block[], { running, drafts }: TimelineInput, calls: ReadonlySet<string>, settledCalls?: ReadonlySet<string>): void {
  for (const r of running.values()) if (!calls.has(r.callId) && !settledCalls?.has(r.callId)) out.push({ kind: 'tool', key: r.callId, id: r.callId, name: r.name, title: r.title, input: r.input, live: r });
  for (const d of drafts.values()) {
    for (const [i, p] of [...d.parts.entries()].sort((a, b) => a[0] - b[0])) {
      if (!p.text) continue;
      const key = `${d.id}:${i}`;
      if (p.kind === 'reasoning') out.push({ kind: 'reasoning', key, text: p.text, live: true });
      else if (p.kind === 'text') out.push({ kind: 'text', key, text: p.text, streaming: true });
      else if (p.kind === 'tool') out.push({ kind: 'tool', key, id: key, name: p.name ?? 'tool', title: p.name ?? 'tool', forming: p.text });
    }
  }
}

function markAnswers(out: Block[], books: ReadonlyMap<string, Ledger>, live: boolean): void {
  // The last answer of each turn gets the copy action, and the turn's ledger when it did any work. While the last
  // turn is at work, a text with steps after it is a note between them: the ledger had shown under such a note, a
  // turn's figures halfway down it, above the step still running.
  for (let i = out.length - 1, seen = false, last = true, after = false; i >= 0; i--) {
    const b = out[i];
    if (b.kind === 'user') (seen = false), (last = false);
    else if (b.kind === 'tool' || b.kind === 'reasoning') after = true;
    else if (b.kind === 'text' && !seen && !b.streaming) {
      if (!(live && last && after)) {
        b.final = true;
        b.ledger = b.turn ? books.get(b.turn) : undefined;
      }
      seen = true;
    } else if (b.kind === 'text') seen = true;
  }
}

function toItems(blocks: Block[]): Item[] {
  const items: Item[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool' || b.kind === 'reasoning') {
      const last = items[items.length - 1];
      if (last?.kind === 'process') last.steps.push(b);
      else items.push({ kind: 'process', key: `p:${b.key}`, anchorKey: `p:${b.kind === 'tool' && b.draftKey ? b.draftKey : b.key}`, steps: [b] });
    } else items.push(b);
  }
  return items;
}

/** The keys of the blocks an item draws, the ones inside a folded run or turn included. */
export const keysOf = (it: Item): string[] => (it.kind === 'process' ? it.steps.map((s) => s.key) : it.kind === 'work' ? it.items.flatMap(keysOf) : [it.key]);

interface TimelineInput {
  messages: Message[];
  results: Map<string, ToolResultPart>;
  running: Map<string, RunningTool>;
  drafts: Map<string, Draft>;
  live: boolean;
  embedded: boolean;
  sessionId?: string;
}

interface History {
  end: number;
  items: Item[];
  calls: Set<string>;
  turns: Set<string>;
}

export interface TimelineBuild {
  input: TimelineInput;
  history: History;
  books: ReadonlyMap<string, Ledger>;
  rewritten: ReadonlySet<string>;
  items: Item[];
}

function lastUser(messages: Message[], from: number): number {
  for (let i = messages.length - 1; i >= from; i--) {
    const m = messages[i];
    if (!m.replay && m.role !== 'assistant' && m.origin === 'user') return i;
  }
  return -1;
}

function settledThrough(input: TimelineInput, history: History, end: number, books: ReadonlyMap<string, Ledger>, rewritten: ReadonlySet<string>): History {
  if (end === history.end) return history;
  const { blocks, calls, turns } = toBlocks(input.messages.slice(history.end, end), input, rewritten);
  // The next block is a user message. It closes this turn even though it is drawn with the tail.
  markAnswers(blocks, books, false);
  const items = toItems(blocks);
  return {
    end,
    items: history.items.concat(input.embedded ? items : foldTurns(items, true)),
    calls: new Set([...history.calls, ...calls]),
    turns: new Set([...history.turns, ...turns]),
  };
}

function withTail(input: TimelineInput, history: History, books: ReadonlyMap<string, Ledger>, rewritten: ReadonlySet<string>): TimelineBuild {
  const { blocks, calls } = toBlocks(input.messages.slice(history.end), input, rewritten);
  appendLive(blocks, input, calls, history.calls);
  markAnswers(blocks, books, input.live);
  const tail = toItems(blocks);
  return { input, history, books, rewritten, items: history.items.concat(input.embedded ? tail : foldTurns(tail)) };
}

function rebuild(input: TimelineInput): TimelineBuild {
  const books = ledgers(input.messages);
  const rewritten = rewrittenAnswers(input.messages);
  const empty: History = { end: 0, items: [], calls: new Set(), turns: new Set() };
  const history = settledThrough(input, empty, Math.max(0, lastUser(input.messages, 0)), books, rewritten);
  return withTail(input, history, books, rewritten);
}

function historyToolChanged({ input: before, history }: TimelineBuild, { results, running }: TimelineInput): boolean {
  if (before.results !== results) {
    for (const id of history.calls) if (before.results.get(id) !== results.get(id)) return true;
  }
  if (before.running !== running) {
    for (const [id, tool] of before.running) if (history.calls.has(id) && running.get(id) !== tool) return true;
    for (const id of running.keys()) if (history.calls.has(id) && !before.running.has(id)) return true;
  }
  return false;
}

/** The reference build treats the entire conversation as one list, including across the last user boundary. */
export function buildFullTimeline(input: TimelineInput): Item[] {
  const { blocks, calls } = toBlocks(input.messages, input, rewrittenAnswers(input.messages));
  appendLive(blocks, input, calls);
  markAnswers(blocks, ledgers(input.messages), input.live);
  const items = toItems(blocks);
  return input.embedded ? items : foldTurns(items);
}

export function buildTimeline(input: TimelineInput, previous?: TimelineBuild): TimelineBuild {
  if (!previous || previous.input.sessionId !== input.sessionId || previous.input.embedded !== input.embedded || historyToolChanged(previous, input)) return rebuild(input);

  const { history, rewritten, input: before } = previous;
  const { messages } = input;
  if (messages === before.messages) return withTail(input, history, previous.books, rewritten);

  // The store hands out new arrays on appends and on replacements. Compare the prefix only when that array changes.
  const length = before.messages.length;
  if (messages.length <= length || !before.messages.every((m, i) => m === messages[i])) return rebuild(input);
  if (messages.slice(length).some((m) => m.replay || m.origin === 'compaction' || asksForRewrite(m))) return rebuild(input);

  const pending = messages.slice(history.end);
  // Some histories can give two stretches the same turn ID. A ledger then needs both, even across a user message.
  if (pending.some((m) => !m.replay && m.turn && history.turns.has(m.turn))) return rebuild(input);
  const books = new Map([...previous.books, ...ledgers(pending)]);
  const end = Math.max(history.end, lastUser(messages, length));
  return withTail(input, settledThrough(input, history, end, books, rewritten), books, rewritten);
}
