import type { Message, ToolCallPart, ToolResultPart } from '../types';
import { estimateMessageTokens } from '../util/tokens';

/**
 * Light compaction: the conversation stays as it is (every user message, every word the model wrote,
 * every tool call), and only tool output that has stopped being useful is cut down to a stub: output a
 * later call superseded (the same file read again, the same command run again) and large output from
 * earlier steps. The full text stays in the blob store, so recall brings any of it back word for word.
 */

export interface PruneItem {
  callId: string;
  /** What the model keeps seeing in place of the output. */
  stub: string;
  /** Length of the output the stub stands for. */
  chars: number;
}

/** Results this long or longer from before the recent steps are cut down even when nothing superseded them. */
const LARGE = 6000;
/** Below this, a superseded result is too small to be worth a stub. */
const SMALL = 800;
const HEAD = 500;

const READS = /^(read|read_file|Read|view_image)$/;
const UNCHANGED = /^\S.* lines \d+-\d+ have not changed since call \S+ showed them/;
const SHELLS = /^(shell|shell_command|Bash)$/;
const SEARCHES = /^(search|Grep|Glob)$/;
const WEB_FETCHES = /^(web_fetch|WebFetch)$/;
const WEB_SEARCHES = /^(web_search|WebSearch)$/;

/**
 * The keys a call's output answers. A later call answers one only with exactly the same key, and a result goes only
 * when every key of it was answered: a read of other lines of a file, or of one file of several, replaces nothing.
 */
function keys(call: ToolCallPart | undefined): string[] {
  if (!call) return [];
  const i = (call.input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  if (READS.test(call.name)) {
    const paths = Array.isArray(i.paths) ? (i.paths as unknown[]).map(String) : [str('path') || str('file_path')];
    const range = i.offset !== undefined || i.limit !== undefined ? `@${String(i.offset ?? '')}+${String(i.limit ?? '')}` : '';
    return paths.filter(Boolean).map((p) => `read:${p.replace(/\\/g, '/')}${range}`);
  }
  if (SHELLS.test(call.name)) {
    const c = Array.isArray(i.command) ? (i.command as unknown[]).join(' ') : str('command');
    return c ? [`cmd:${str('workdir') || str('cwd')}|${c.trim()}`] : [];
  }
  if (SEARCHES.test(call.name)) return [`search:${str('pattern')}|${str('glob')}|${str('path')}`];
  if (call.name === 'check') return [`check:${JSON.stringify(i.only ?? null)}|${str('path')}`];
  // The same page or search asked again (after a compaction, by a model that lost track): the newer answer stands.
  if (WEB_FETCHES.test(call.name)) return str('url') ? [`fetch:${str('url').trim().replace(/#.*$/, '')}|${String(i.start ?? '')}|${str('prompt').trim()}`] : [];
  if (WEB_SEARCHES.test(call.name)) return str('query') ? [`websearch:${str('query').trim()}|${JSON.stringify(i.allowed_domains ?? null)}|${str('recency')}`] : [];
  if (/^(browser|Screenshot|screenshot)$/.test(call.name)) return ['browser'];
  return [];
}

/**
 * Which tool results of `messages[from..]` to cut down. The results of the last `keepRecent` tool rounds
 * are never touched: they are what the model is working with now.
 */
export function planPrune(messages: Message[], from: number, keepRecent: number): PruneItem[] {
  const calls = new Map<string, ToolCallPart>();
  for (let i = from; i < messages.length; i++) for (const p of messages[i].parts) if (p.type === 'tool_call') calls.set(p.id, p);
  // Rounds, newest last: each message that carries tool results.
  const rounds: number[] = [];
  for (let i = from; i < messages.length; i++) if (messages[i].parts.some((p) => p.type === 'tool_result')) rounds.push(i);
  // With no more rounds than that, everything is recent and nothing is cut.
  if (rounds.length <= keepRecent) return [];
  const cutoff = rounds[rounds.length - keepRecent];
  // The newest index at which each key was answered.
  const latest = new Map<string, number>();
  rounds.forEach((i) => {
    for (const p of messages[i].parts) {
      if (p.type !== 'tool_result') continue;
      const call = calls.get(p.callId);
      // A read that failed answers nothing; a command that failed is still the newest word on that command.
      if (p.isError && !SHELLS.test(call?.name ?? '') && call?.name !== 'check') continue;
      // A read that only points back to an earlier one (fs-tools: "have not changed since call X") holds no lines:
      // counted as newer, it cut the very read it points to.
      if (UNCHANGED.test(p.content)) continue;
      for (const k of keys(call)) latest.set(k, i);
    }
  });
  const items: PruneItem[] = [];
  for (const i of rounds) {
    if (i >= cutoff) break;
    for (const p of messages[i].parts) {
      if (p.type !== 'tool_result' || p.pruned) continue;
      const call = calls.get(p.callId);
      const answered = keys(call);
      const superseded = answered.length > 0 && answered.every((k) => (latest.get(k) ?? -1) > i);
      const size = p.content.length;
      const images = p.images?.length ?? 0;
      if (!(superseded && (size >= SMALL || images)) && size < LARGE && !images) continue;
      items.push({ callId: p.callId, chars: size, stub: stubFor(p, superseded, images) });
    }
  }
  return items;
}

/**
 * Whether a round is worth the provider's prompt cache. A round rewrites early messages and the cache keeps only
 * what a request appends, so the next request's whole input is fresh (measured on an OpenAI Responses backend). Near the
 * summary mark a round that keeps the context well under it puts the summary off, word for word. Before that the
 * round has to pay: cached input costs `cachedShare` of fresh input, so it costs (1 - share) of the context once and
 * saves share of what it cuts on every later request, guessed as many again as were made so far.
 */
export function prunePays(o: { context: number; saving: number; compactAt: number; requests: number; cachedShare: number }): boolean {
  if (o.context >= o.compactAt * 0.9 && o.context - o.saving < o.compactAt * 0.75) return true;
  return o.requests * o.cachedShare * o.saving >= (1 - o.cachedShare) * o.context;
}

function stubFor(p: ToolResultPart, superseded: boolean, images: number): string {
  const head = p.content.length > HEAD ? `${p.content.slice(0, p.content.lastIndexOf('\n', HEAD) > 100 ? p.content.lastIndexOf('\n', HEAD) : HEAD)}\n…` : p.content;
  const why = superseded ? 'a later call has newer output' : 'it is from earlier steps';
  const pics = images ? `, ${images} image${images === 1 ? '' : 's'}` : '';
  return `${head}\n[Cut to save context (${p.content.length} chars${pics}; ${why}). recall with call_id ${p.callId} returns it in full.]`;
}

/** A message as a request may carry it: images whose data left memory (pruned or released) are left out. */
export function sendable(m: Message): Message {
  const blank = m.parts.some((p) => (p.type === 'image' && !p.data) || (p.type === 'tool_result' && p.images?.some((i) => !i.data)));
  if (!blank) return m;
  return {
    ...m,
    parts: m.parts.filter((p) => p.type !== 'image' || !!p.data).map((p) => (p.type === 'tool_result' && p.images ? { ...p, images: p.images.filter((i) => !!i.data) } : p)),
  };
}

export const UNSTORED_TOOL_OUTPUT = 'The tool ran, but its output was not stored and its effects may be in place.';

/** What a call that never got its result is answered with, in what is sent. */
export const UNANSWERED = 'Favilla stopped before this call finished (it was closed, stopped or crashed while the call waited or ran), so there is no result. Check the state it would have changed before relying on it.';

/**
 * Every tool call answered in the message right after it, and every result next to its call, as providers require.
 * A history can end in calls that never ran (the process ended while a tool ran) or hold results whose call a summary
 * replaced, and sent as it was, every later request failed with a 400. Only what is sent changes, and as little as
 * that: missing answers go into the message that follows (a new one only where none or an assistant follows), a result
 * without its call becomes a line of text in its place. `at` maps an index of `messages` to its index in the result.
 */
export function pairToolCalls(messages: Message[]): { messages: Message[]; at: (i: number) => number } {
  const out: Message[] = [];
  const index: number[] = [];
  let open: ToolCallPart[] = [];
  const answers = (calls: ToolCallPart[]): ToolResultPart[] => calls.map((c) => ({ type: 'tool_result', callId: c.id, name: c.name, content: UNANSWERED, isError: true }));
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      if (open.length) out.push({ id: `${m.id}:answers`, role: 'user', origin: 'tool', parts: answers(open), time: m.time });
      index[i] = out.length;
      out.push(m);
      open = m.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
      return;
    }
    const asked = new Map(open.map((c) => [c.id, c]));
    open = [];
    const seen = new Set<string>();
    let changed = false;
    const parts = m.parts.map((p) => {
      if (p.type !== 'tool_result') return p;
      if (asked.has(p.callId) && !seen.has(p.callId)) {
        seen.add(p.callId);
        return p;
      }
      changed = true;
      return { type: 'text' as const, text: `[A result of ${p.name} whose call is not shown here: ${p.content.length > 400 ? `${p.content.slice(0, 400)}…` : p.content}]`, synthetic: true };
    });
    const missing = [...asked.values()].filter((c) => !seen.has(c.id));
    index[i] = out.length;
    if (!changed && !missing.length) return void out.push(m);
    // The answers go before the message's other parts, after the results it has.
    const results = parts.filter((p) => p.type === 'tool_result');
    out.push({ ...m, parts: [...results, ...answers(missing), ...parts.filter((p) => p.type !== 'tool_result')] });
  });
  if (open.length) out.push({ id: `${messages.at(-1)?.id ?? 'end'}:answers`, role: 'user', origin: 'tool', parts: answers(open), time: Date.now() });
  return { messages: out, at: (i) => index[i] ?? out.length };
}

/**
 * Most of the user's words a summary carries, newest first; past it the rest stay in the history for recall. A tenth
 * of the window on a large one: a long job's instructions are what a summary loses first, and Codex keeps 64k tokens.
 */
const SAID_CHARS = 16_000;
const SAID_SHARE = 0.1;
const CHARS_PER_TOKEN = 3.5;
const LEFT_OUT = 'Earlier messages are left out here; recall finds them.';

function textOf(m: Message): string {
  return m.parts
    .filter((p) => p.type === 'text' && !p.synthetic)
    .map((p) => (p as { text: string }).text)
    .join('\n')
    .trim();
}

/**
 * Everything the user has said in the active context, oldest first: what earlier summaries carried, then
 * their messages since. The newest are kept whole; when the total runs long, older ones keep their start.
 */
export function userWords(active: Message[], window = 0): string[] {
  const all: string[] = [];
  let leftOut = false;
  for (const m of active) {
    if (m.origin === 'compaction' && m.carried) {
      leftOut ||= m.carried.includes(LEFT_OUT);
      all.push(...m.carried.filter((t) => t !== LEFT_OUT));
    }
    else if (m.role === 'user' && !m.replay) {
      const t = m.origin === 'user' ? textOf(m) : '';
      if (t) all.push(t);
      // What they sent while the agent worked rides in a note beside tool results.
      for (const p of m.parts) if (p.type === 'text' && p.said) all.push(p.said);
    }
  }
  let budget = Math.max(SAID_CHARS, window * SAID_SHARE * CHARS_PER_TOKEN);
  const kept: string[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const t = all[i];
    if (t.length <= budget) {
      kept.unshift(t);
      budget -= t.length;
      continue;
    }
    if (budget > 400) kept.unshift(`${t.slice(0, budget - 40)}… (cut; recall finds the rest)`);
    leftOut ||= i > 0 || budget <= 400;
    break;
  }
  return leftOut ? [LEFT_OUT, ...kept] : kept;
}

/**
 * Rounds of the latest work kept word for word after a summary. From the same summary the next step went where the
 * real work went in 74% of asks with the last 4 rounds, 74% with 8, 85% with 12 and 88% from the whole history (one
 * model, 40 SWE-rebench trajectories asked three times each, 2026-11-05; 12 over 4: 11 points, 3 to 18 at 95%): a summary
 * keeps the facts, rounds keep the thread. Twelve rounds took about 8k tokens there; the window's share caps them
 * where outputs run long.
 */
const TAIL_ROUNDS = 12;

/**
 * The recent work to keep word for word after a summary: whole tool rounds from the end, as many as fit in
 * `maxTokens` (at most TAIL_ROUNDS), starting at an assistant message so calls and their results stay together.
 * When not even the last round fits, it is kept all the same up to twice that room: the next step works from what it
 * just showed (a file, old code from git), and leaving it to the summary had the model fetch it again.
 */
export function tailOf(active: Message[], maxTokens: number): Message[] {
  let start = active.length;
  let tokens = 0;
  let rounds = 0;
  for (let i = active.length - 1; i > 0; i--) {
    const m = active[i];
    if (m.origin === 'compaction') break;
    tokens += estimateMessageTokens(sendable(m));
    if (tokens > maxTokens) break;
    start = i;
    if (m.role === 'assistant' && ++rounds >= TAIL_ROUNDS) break;
  }
  while (start < active.length && active[start].role !== 'assistant') start++;
  if (start < active.length) return active.slice(start);
  let last = active.length - 1;
  while (last > 0 && active[last].role !== 'assistant') last--;
  if (last <= 0 || active.slice(last).some((m) => m.origin === 'compaction')) return [];
  const round = active.slice(last);
  return round.reduce((n, m) => n + estimateMessageTokens(sendable(m)), 0) <= maxTokens * 2 ? round : [];
}

