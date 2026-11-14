import type { Message } from '../types';
import { fullContent } from '../store/pack';
import { oneLine } from '../util/text';
import type { ToolDef } from './types';

export interface RecallInput {
  /** A tool call's id: its full output, however much of it was cut or summarized. */
  callId?: string;
  /** With callId: the character to start from, for output too long to come back at once. */
  from?: number;
  /** Words or a regex to find in everything said and returned in this session. */
  query?: string;
}

const MAX_HITS = 12;
const AROUND = 220;

/**
 * Nothing in a session is lost to compaction: the full history stays on disk. recall returns a tool
 * call's complete output by its id, or finds words in everything the user and the model said and every
 * tool returned, including what was summarized or cut to save context, so exact details (an error, a path,
 * the user's words) come back as they were instead of being guessed.
 */
function compileQuery(query: string): RegExp {
  try {
    return new RegExp(query, 'i');
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

export const recallTool: ToolDef<RecallInput> = {
  kind: 'grep',
  readOnly: true,
  title: (i) => (i.callId ? `Recall the output of ${i.callId}${i.query ? ` (${oneLine(i.query, 40)})` : ''}` : `Recall "${oneLine(i.query ?? '', 80)}"`),
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
            const hit = full.search(re);
            if (hit >= 0) {
              const from = Math.max(0, hit - AROUND);
              const end = from + ctx.outputChars;
              return { content: `${head}${from ? `(from character ${from} of ${full.length}, around /${q}/)\n` : ''}${full.slice(from, end)}${end < full.length ? `\n… (${full.length - end} more chars: recall with from=${end})` : ''}` };
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
    const query = input.query?.trim();
    if (!query) return { content: 'Give call_id for a tool output, or query to search the history.', isError: true };
    const re = compileQuery(query);
    const hits: string[] = [];
    let total = 0;
    history.forEach((m, i) => {
      if (m.replay) return;
      for (const p of m.parts) {
        const [where, text] =
          p.type === 'text'
            ? [m.role === 'user' ? (m.origin === 'compaction' ? 'summary' : p.synthetic ? 'note' : 'user') : 'assistant', p.text]
            : p.type === 'tool_result'
              ? [`output of ${p.name} (call_id ${p.callId})`, fullContent(p, blobs)]
              : p.type === 'tool_call'
                ? [`call ${p.name} (call_id ${p.id})`, JSON.stringify(p.input ?? {})]
                : ['', ''];
        const at = text ? text.search(re) : -1;
        if (at < 0) continue;
        total++;
        if (hits.length >= MAX_HITS) continue;
        const from = Math.max(0, at - AROUND);
        const snippet = `${from > 0 ? '…' : ''}${text.slice(from, at + AROUND)}${at + AROUND < text.length ? '…' : ''}`;
        hits.push(`[#${i} ${where}${m.time ? `, ${new Date(m.time).toISOString().slice(11, 16)}` : ''}]\n${snippet.trim()}`);
      }
    });
    if (!hits.length) return { content: `Nothing in this session's history matches /${query}/.` };
    return {
      content: `${total} match${total === 1 ? '' : 'es'} in the session's history${total > hits.length ? ` (first ${hits.length})` : ''}:\n\n${hits.join('\n\n')}`,
      display: { kind: 'list', title: query, items: hits.map((h) => oneLine(h, 160)), total },
    };
  },
};
