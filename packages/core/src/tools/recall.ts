import type { Message, TextPart } from '../types';
import type { BlobStore } from '../store/blobs';
import { fullContent, fullSaid, fullText } from '../store/pack';
import { oneLine } from '../util/text';
import type { ToolDef } from './types';

export interface RecallInput {
  /** A tool call's id: its full output, however much of it was cut or summarized. */
  callId?: string;
  /** 0-based message index (#N as shown in recall search results or cut-message notices) to read in full. */
  message?: number;
  /** With callId or message: the character offset to start from, for text too long to come back at once. */
  from?: number;
  /** Words or a regex to find in everything said and returned in this session (or within call_id / message). */
  query?: string;
}

const MAX_HITS = 12;
const MAX_WINDOWS_PER_PART = 3;
const AROUND = 220;

/**
 * Nothing in a session is lost to compaction: the full history stays on disk. recall returns a tool
 * call's complete output by its id, a message's complete text by its #N index, or finds words in
 * everything the user and the model said and every tool returned, including what was summarized or
 * cut to save context, so exact details come back as they were instead of being guessed.
 */
function compileQuery(query: string, global = false): RegExp {
  const flags = global ? 'gi' : 'i';
  try {
    return new RegExp(query, flags);
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}

interface MatchWindow {
  start: number;
  end: number;
  matchAt: number;
}

function findMatchWindows(text: string, query: string, around: number, maxWindows: number): { windows: MatchWindow[]; totalMatches: number; nextAt?: number } {
  if (!text) return { windows: [], totalMatches: 0 };
  const re = compileQuery(query, true);
  const windows: MatchWindow[] = [];
  let totalMatches = 0;
  let nextAt: number | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const at = m.index;
    const matchEnd = at + Math.max(1, m[0].length);
    if (m[0].length === 0) re.lastIndex = at + 1;
    totalMatches++;
    const prev = windows.at(-1);
    if (prev && at <= prev.end + 40) {
      prev.end = Math.min(text.length, Math.max(prev.end, matchEnd + around));
      continue;
    }
    if (windows.length < maxWindows) {
      windows.push({
        start: Math.max(0, at - around),
        end: Math.min(text.length, matchEnd + around),
        matchAt: at,
      });
    } else if (nextAt === undefined) {
      nextAt = at;
    }
    if (totalMatches >= 60) break;
  }
  return { windows, totalMatches, nextAt };
}

function messageLabel(m: Message): string {
  if (m.role === 'assistant') return 'assistant';
  if (m.origin === 'compaction') return 'summary';
  if (m.origin === 'tool') return m.parts.some((p) => p.type === 'text' && p.said !== undefined) ? 'user (mid-turn)' : 'tool results';
  if (m.origin === 'harness') return 'note';
  return 'user';
}

/**
 * Full unclipped text of message `#index`. For user messages (`origin === 'user'` or mid-turn `said`), returns the
 * user's own non-synthetic text so `from=K` offsets printed by `userWords` and `fitInboundText` align to the exact character.
 */
function renderMessageBody(m: Message, blobs: BlobStore): string {
  if (m.role === 'user' && m.origin === 'user') {
    const userParts = m.parts.filter((p): p is TextPart => p.type === 'text' && !p.synthetic).map((p) => fullText(p, blobs));
    const joined = userParts.join('\n').trim();
    if (joined) return joined;
  }
  if (m.role === 'user' && m.origin === 'tool') {
    const saidParts = m.parts
      .filter((p): p is TextPart => p.type === 'text' && p.said !== undefined)
      .map((p) => (fullSaid(p, blobs) ?? p.said ?? '').trim())
      .filter(Boolean);
    if (saidParts.length) return saidParts.join('\n\n');
  }
  const chunks: string[] = [];
  for (const p of m.parts) {
    if (p.type === 'text') {
      const t = fullText(p, blobs);
      if (t) chunks.push(t);
    } else if (p.type === 'tool_call') {
      chunks.push(`[call ${p.name} (call_id ${p.id})] ${JSON.stringify(p.input ?? {})}`);
    } else if (p.type === 'tool_result') {
      chunks.push(`[output of ${p.name} (call_id ${p.callId})]\n${fullContent(p, blobs)}`);
    } else if (p.type === 'image') {
      chunks.push(`[image ${p.id ?? p.name ?? 'attachment'} (${p.width && p.height ? `${p.width}×${p.height}` : p.mediaType})]`);
    }
  }
  return chunks.join('\n\n');
}

export const recallTool: ToolDef<RecallInput> = {
  kind: 'grep',
  readOnly: true,
  title: (i) =>
    i.callId
      ? `Recall the output of ${i.callId}${i.query ? ` (${oneLine(i.query, 40)})` : ''}`
      : i.message !== undefined
        ? `Recall message #${i.message}${i.from ? ` from ${i.from}` : ''}${i.query ? ` (${oneLine(i.query, 40)})` : ''}`
        : `Recall "${oneLine(i.query ?? '', 80)}"`,
  async execute(input, ctx) {
    const history: Message[] = ctx.history?.() ?? [];
    const blobs = ctx.blobs;
    if (!blobs || !history.length) return { content: 'There is no earlier history in this session.' };

    if (input.callId) {
      for (const m of history) {
        for (const p of m.parts) {
          if (p.type !== 'tool_result' || p.callId !== input.callId) continue;
          const call = history.flatMap((x) => x.parts).find((q) => q.type === 'tool_call' && q.id === input.callId);
          const head = call && call.type === 'tool_call' ? `${call.name} ${oneLine(JSON.stringify(call.input ?? {}), 200)}\n` : '';
          const full = fullContent(p, blobs);
          const q = input.query?.trim();
          if (q && input.from === undefined) {
            const re = compileQuery(q);
            // A batched read holds up to 40 files under "==> path <==" headers: return the matching file section(s) directly.
            if (full.startsWith('==> ')) {
              const sections = full.split(/\n\n(?===> )/);
              const byHeader = sections.filter((s) => re.test(s.split('\n', 1)[0]));
              const matched = byHeader.length ? byHeader : sections.filter((s) => re.test(s));
              if (matched.length && matched.length < sections.length) {
                const joined = matched.join('\n\n');
                const part = joined.slice(0, ctx.outputChars);
                return {
                  content: `${head}(matching /${q}/ in ${matched.length} of ${sections.length} sections)\n${part}${part.length < joined.length ? `\n… (${joined.length - part.length} more chars in matched sections)` : ''}`,
                };
              }
            }
            const { windows, totalMatches, nextAt } = findMatchWindows(full, q, Math.max(AROUND, Math.floor(ctx.outputChars / 6)), MAX_WINDOWS_PER_PART);
            if (windows.length === 1) {
              const from = Math.max(0, windows[0].matchAt - AROUND);
              const end = Math.min(full.length, from + ctx.outputChars);
              return { content: `${head}${from ? `(from character ${from} of ${full.length}, around /${q}/)\n` : ''}${full.slice(from, end)}${end < full.length ? `\n… (${full.length - end} more chars: recall with call_id="${input.callId}", from=${end})` : ''}` };
            }
            if (windows.length > 1) {
              const blocks = windows.map((w) => `(characters ${w.start}..${w.end} of ${full.length})\n${w.start > 0 ? '…' : ''}${full.slice(w.start, w.end)}${w.end < full.length ? '…' : ''}`);
              const more = nextAt !== undefined ? `\n… (${totalMatches} matches total; pass call_id="${input.callId}", from=${Math.max(0, nextAt - AROUND)} for later ones)` : '';
              return { content: `${head}(${totalMatches} matches for /${q}/ in ${full.length} chars)\n\n${blocks.join('\n\n')}${more}` };
            }
            return { content: `${head}Nothing in tool call ${input.callId} matches /${q}/.` };
          }
          const from = Math.max(0, Math.min(input.from ?? 0, full.length));
          const end = from + ctx.outputChars;
          const part = full.slice(from, end);
          let tailNote = '';
          if (end < full.length) {
            const later = [...full.matchAll(/(?:^|\n\n)==> ([^\n]+?) <==/g)]
              .filter((x) => (x.index ?? 0) >= end)
              .map((x) => `${x[1]}@${(x.index ?? 0) + (x[0].startsWith('\n\n') ? 2 : 0)}`);
            const hint = later.length ? `; pass query="<path>" or from=N (${later.slice(0, 40).join(', ')}${later.length > 40 ? `, +${later.length - 40} more` : ''})` : `: recall with from=${end}`;
            tailNote = `\n… (${full.length - end} more chars${hint})`;
          }
          // The pictures it carried come back too, from the blob store, as the newest pictures of the session.
          const images = from ? [] : (p.images ?? []).map((img) => ({ ...img, data: img.data || (img.blob ? (blobs.get(img.blob)?.toString('base64') ?? '') : '') })).filter((img) => img.data);
          return { content: `${head}${from ? `(from character ${from} of ${full.length})\n` : ''}${part}${tailNote}`, ...(images.length ? { images } : {}) };
        }
      }
      return { content: `No tool call ${input.callId} in this session.`, isError: true };
    }

    if (input.message !== undefined) {
      const idx = Math.trunc(input.message);
      if (!Number.isFinite(idx) || idx < 0 || idx >= history.length) {
        return { content: `No message #${input.message} in this session (valid range: #0..#${history.length - 1}).`, isError: true };
      }
      const m = history[idx];
      const head = `[#${idx} ${messageLabel(m)}${m.time ? `, ${new Date(m.time).toISOString().slice(11, 16)}` : ''}]\n`;
      const full = renderMessageBody(m, blobs);
      const q = input.query?.trim();
      if (q && input.from === undefined) {
        const { windows, totalMatches, nextAt } = findMatchWindows(full, q, Math.max(AROUND, Math.floor(ctx.outputChars / 6)), MAX_WINDOWS_PER_PART);
        if (!windows.length) return { content: `${head}Nothing in message #${idx} matches /${q}/.` };
        if (windows.length === 1) {
          const from = Math.max(0, windows[0].matchAt - AROUND);
          const end = Math.min(full.length, from + ctx.outputChars);
          return {
            content: `${head}${from ? `(from character ${from} of ${full.length}, around /${q}/)\n` : ''}${full.slice(from, end)}${end < full.length ? `\n… (${full.length - end} more chars: recall with message=${idx}, from=${end})` : ''}`,
          };
        }
        const blocks = windows.map((w) => `(characters ${w.start}..${w.end} of ${full.length})\n${w.start > 0 ? '…' : ''}${full.slice(w.start, w.end)}${w.end < full.length ? '…' : ''}`);
        const more = nextAt !== undefined ? `\n… (${totalMatches} matches total; recall with message=${idx}, from=${Math.max(0, nextAt - AROUND)} for later ones)` : '';
        return { content: `${head}(${totalMatches} matches for /${q}/ in ${full.length} chars)\n\n${blocks.join('\n\n')}${more}` };
      }
      const from = Math.max(0, Math.min(input.from ?? 0, full.length));
      const end = Math.min(full.length, from + ctx.outputChars);
      const part = full.slice(from, end);
      const tailNote = end < full.length ? `\n… (${full.length - end} more chars: recall with message=${idx}, from=${end})` : '';
      return { content: `${head}${from ? `(from character ${from} of ${full.length})\n` : ''}${part}${tailNote}` };
    }

    const query = input.query?.trim();
    if (!query) return { content: 'Give call_id for a tool output, message for a #N message, or query to search the history.', isError: true };
    const re = compileQuery(query);
    const exactImgId = /^img-\d+$/i.test(query) ? query.toLowerCase() : null;
    if (exactImgId) {
      const snap = ctx.sessionImage?.(exactImgId, !!ctx.model?.vision);
      if (snap) {
        const reopen = ctx.readImageCallHint ? ctx.readImageCallHint(snap.virtualPath) : `read("${snap.virtualPath}")`;
        const buf = ctx.model?.vision ? blobs.get(snap.blob) : null;
        return {
          content: `[${snap.id}] ${snap.origin === 'user' ? 'user image' : `tool ${snap.toolName ?? 'image'}`}${snap.name ? ` "${snap.name}"` : ''}${snap.width && snap.height ? ` (${snap.width}×${snap.height})` : ''}${snap.sourcePath ? ` | source: ${snap.sourcePath}` : ''}\nReopen with ${reopen} (supports region: [x, y, width, height]).${snap.digest ? `\nRecorded details: ${snap.digest}` : ''}`,
          ...(buf
            ? {
                images: [
                  {
                    type: 'image' as const,
                    id: snap.id,
                    blob: snap.blob,
                    mediaType: snap.mediaType,
                    data: buf.toString('base64'),
                    name: snap.name,
                    width: snap.width,
                    height: snap.height,
                    sourcePath: snap.sourcePath,
                    sourceSha256: snap.sourceSha256,
                  },
                ],
              }
            : {}),
        };
      }
    }
    const hits: string[] = [];
    let total = 0;
    for (const snap of ctx.sessionImages?.() ?? []) {
      const line = `[${snap.id}] ${snap.origin === 'user' ? 'user image' : `tool ${snap.toolName ?? 'image'}`}${snap.name ? ` "${snap.name}"` : ''}${snap.sourcePath ? ` (${snap.sourcePath})` : ''}${snap.digest ? ` — ${snap.digest}` : ''}`;
      if (!re.test(line) && !re.test(snap.virtualPath)) continue;
      total++;
      if (hits.length < MAX_HITS) {
        const reopen = ctx.readImageCallHint ? ctx.readImageCallHint(snap.virtualPath) : `read("${snap.virtualPath}")`;
        hits.push(`[session image ${snap.id}]\n${line}\nReopen virtual snapshot (read tool only, not on disk) with ${reopen}`);
      }
    }
    history.forEach((m, i) => {
      if (m.replay) return;
      for (const p of m.parts) {
        const [where, text] =
          p.type === 'text'
            ? [
                m.role === 'user' ? (m.origin === 'compaction' ? 'summary' : p.synthetic ? (p.said !== undefined ? 'user (mid-turn)' : 'note') : 'user') : 'assistant',
                p.said !== undefined ? (fullSaid(p, blobs) ?? fullText(p, blobs)) : fullText(p, blobs),
              ]
            : p.type === 'tool_result'
              ? [`output of ${p.name} (call_id ${p.callId})`, fullContent(p, blobs)]
              : p.type === 'tool_call'
                ? [`call ${p.name} (call_id ${p.id})`, JSON.stringify(p.input ?? {})]
                : ['', ''];
        if (!text) continue;
        const { windows, totalMatches, nextAt } = findMatchWindows(text, query, AROUND, MAX_WINDOWS_PER_PART);
        if (!windows.length) continue;
        total += totalMatches;
        if (hits.length >= MAX_HITS) continue;
        const snippets = windows.map((w) => {
          const offsetTag = windows.length > 1 || text.length > AROUND * 4 ? `(@char ${w.start}) ` : '';
          return `${offsetTag}${w.start > 0 ? '…' : ''}${text.slice(w.start, w.end).trim()}${w.end < text.length ? '…' : ''}`;
        });
        const moreNote =
          nextAt !== undefined
            ? `\n(… ${totalMatches - windows.length} more match${totalMatches - windows.length === 1 ? '' : 'es'} in #${i}; pass ${p.type === 'tool_result' ? `call_id="${p.callId}"` : `message=${i}`}, from=${Math.max(0, nextAt - AROUND)})`
            : '';
        hits.push(`[#${i} ${where}${m.time ? `, ${new Date(m.time).toISOString().slice(11, 16)}` : ''}]\n${snippets.join('\n---\n')}${moreNote}`);
      }
    });
    if (!hits.length) return { content: `Nothing in this session's history matches /${query}/.` };
    return {
      content: `${total} match${total === 1 ? '' : 'es'} in the session's history${hits.length >= MAX_HITS && total > hits.length ? ` (first ${hits.length} entries)` : ''}:\n\n${hits.join('\n\n')}`,
      display: { kind: 'list', title: query, items: hits.map((h) => oneLine(h, 160)), total },
    };
  },
};
