import { setImmediate as nextTick } from 'node:timers/promises';
import type { Message, ToolDisplay, ToolResultPart } from '../types';
import type { BlobStore } from '../store/blobs';
import { parseDisplay } from '../store/pack';
import { ATTACHED, attachedPart, takePasted, typedPart } from '../prompt/attached';
import type { FindHit, FindResult } from './find-types';

export type { FindHit, FindResult };

/** Non-overlapping matches of `needle` (lower case) in `hay`, case aside. */
function count(hay: string, needle: string): number {
  return countLower(hay.toLowerCase(), needle);
}

function countLower(text: string, needle: string): number {
  let n = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** What the user sent, as stored: their words, then what Favilla attached under them. */
function userText(m: Message): string {
  const first = m.parts[0];
  if (m.parts.length === 1) return first.type === 'text' && !first.synthetic ? first.text : '';
  return m.parts
    .filter((p) => p.type === 'text' && !p.synthetic)
    .map((p) => (p as { text: string }).text)
    .join('\n');
}

/** A message the user sent while the agent worked, as the note that carried it keeps their words. */
function steered(m: Message): string {
  return m.parts
    .filter((p) => p.type === 'text' && p.synthetic && ((p as { said?: string }).said !== undefined || /^The user sent this (message )?while you were working/.test(p.text)))
    .map((p) => (p as { said?: string }).said ?? (p as { text: string }).text.replace(/^[^\n]*\n/, ''))
    .join('\n\n');
}

/** A step's line: the strings of its call (a path, a command, a pattern, a description). */
function callLine(input: Record<string, unknown> | undefined): string {
  return Object.values(input ?? {})
    .map((v) => (typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(' ') : ''))
    .filter(Boolean)
    .join('\n');
}

// Room for several hundred released outputs, without keeping whole conversations in memory.
const CACHE_BYTES = 32 * 1024 * 1024;

class OutputCache {
  private entries = new Map<string, { text: string | null; bytes: number }>();
  private bytes = 0;

  get(key: string, read: () => string | null | undefined): string | null | undefined {
    const known = this.entries.get(key);
    if (known) {
      this.entries.delete(key);
      this.entries.set(key, known);
      return known.text;
    }
    const text = read();
    // An unreadable blob can become readable later. A decoded display without printable text is still known.
    if (text === undefined) return undefined;
    const bytes = 2 * (key.length + (text?.length ?? 0)) + 128;
    if (bytes <= CACHE_BYTES) {
      while (this.bytes + bytes > CACHE_BYTES) {
        const [old, entry] = this.entries.entries().next().value!;
        this.entries.delete(old);
        this.bytes -= entry.bytes;
      }
      this.entries.set(key, { text, bytes });
      this.bytes += bytes;
    }
    return text;
  }
}

const caches = new WeakMap<BlobStore, OutputCache>();

function displayText(display: ToolDisplay | undefined): string | undefined {
  if (display?.kind === 'terminal') return `${display.command}\n${display.output}`;
  if (display?.kind === 'diff') return display.files.map((f) => `${f.movedTo ?? f.path}\n${f.patch}`).join('\n');
  return undefined;
}

/** What a step shows once opened, lowercased for the search. Blob ids already identify immutable content. */
function printed(r: ToolResultPart, blobs: BlobStore, cache: OutputCache): string {
  let display = displayText(r.display)?.toLowerCase();
  const displayId = r.displayBlob;
  if (!r.display && displayId) {
    display = cache.get('display:' + displayId, () => {
      const raw = blobs.text(displayId);
      return raw === null ? undefined : (displayText(parseDisplay(raw))?.toLowerCase() ?? null);
    }) ?? undefined;
  }
  if (display !== undefined) return display;
  const contentId = r.contentBlob;
  if (contentId && (r.pruned || !r.content)) {
    const content = cache.get('content:' + contentId, () => blobs.text(contentId)?.toLowerCase());
    if (content !== undefined && content !== null) return content;
  }
  return r.content.toLowerCase();
}

/**
 * Every place in a session's conversation the words are in, in the order the timeline shows them: what the user
 * wrote (before a compaction too), the answers and thoughts, each step's line and its whole output (outputs the page
 * only has the start of, and ones a compaction moved to disk). Copies of recent work placed after a summary are left
 * out, as the timeline leaves them out. The summaries themselves are not searched yet: their line in the timeline
 * cannot open itself to a match. Case does not matter.
 */
export async function findInSession(messages: Message[], query: string, blobs: BlobStore, max = 5000, signal?: AbortSignal): Promise<FindResult> {
  signal?.throwIfAborted();
  const needle = query.toLowerCase();
  const out: FindResult = { hits: [], total: 0, capped: false };
  if (!needle.trim()) return out;
  let cache = caches.get(blobs);
  if (!cache) caches.set(blobs, (cache = new OutputCache()));
  // New messages during a yield belong to the next search, as they did in the synchronous scan.
  const history = messages.slice();
  const sliceMs = 6;
  let until = performance.now() + sliceMs;
  const pause = async () => {
    await nextTick(undefined, { signal });
    until = performance.now() + sliceMs;
  };
  const results = new Map<string, ToolResultPart>();
  // Answers the harness asked to rewrite in plainer words: the timeline shows only the rewrite.
  const rewritten = new Set<string>();
  for (let i = 0; i < history.length; i++) {
    if (performance.now() >= until) await pause();
    const m = history[i];
    for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);
    const next = history[i + 1];
    if (m.role === 'assistant' && next?.origin === 'harness' && next.parts.some((p) => p.type === 'text' && p.text.includes('Rewrite your last message'))) rewritten.add(m.id);
  }
  const add = (hit: FindHit) => {
    if (!hit.count) return;
    out.total += hit.count;
    if (out.hits.length < max) out.hits.push(hit);
    else out.capped = true;
  };
  for (const m of history) {
    if (performance.now() >= until) await pause();
    if (m.replay) continue;
    if (m.role === 'assistant') {
      for (let i = 0; i < m.parts.length; i++) {
        // The message-level clock check already covers its first part.
        if (i > 0 && performance.now() >= until) await pause();
        const p = m.parts[i];
        if ((p.type === 'reasoning' || (p.type === 'text' && !rewritten.has(m.id))) && p.text.trim()) {
          const n = count(p.text, needle);
          if (n) add({ block: `${m.id}:${i}`, kind: p.type, count: n });
        } else if (p.type === 'tool_call') {
          const r = results.get(p.id);
          const inLine = count(`${p.name}\n${callLine(p.input)}`, needle);
          const inOutput = r ? countLower(printed(r, blobs, cache), needle) : 0;
          if (inLine || inOutput) add({ block: p.id, kind: 'tool', count: inLine + inOutput, ...(inOutput ? { output: true } : {}) });
        }
      }
    } else if (m.origin === 'user') {
      const raw = userText(m);
      if (!raw.includes(ATTACHED)) {
        const n = count(raw, needle);
        if (n) add({ block: m.id, kind: 'user', count: n });
        continue;
      }
      const { text, pastes } = takePasted(raw);
      const files = [...attachedPart(text).matchAll(/<(?:file|folder) path="([^"]+)">/g)].map((x) => x[1]);
      add({ block: m.id, kind: 'user', count: count([typedPart(text), ...files].join('\n'), needle) });
      pastes.forEach((body, paste) => add({ block: m.id, kind: 'user', paste, count: count(body, needle) }));
    } else if (m.origin === 'compaction') {
      // A compaction's summary, the part of it the model wrote (the user's words in it are found where they were said).
      const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
      add({ block: m.id, kind: 'summary', count: count(/<summary>([\s\S]*?)(?:<\/summary>|$)/.exec(text)?.[1] ?? text, needle) });
    }
    else if (m.origin === 'tool') {
      const said = steered(m);
      if (said) add({ block: m.id, kind: 'steer', count: count(said, needle) });
    }
  }
  return out;
}
