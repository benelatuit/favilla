import type { Message, SessionStore, ToolResultPart } from '@favilla/core';
import { fullContent, fullDisplay } from '@favilla/core';
import { bold, dim, paint } from './theme';
import { t } from './i18n';
import { noticeBlock, textBlock, toolBlock, userBlock } from './format';
import { strip } from './text';

type Blobs = SessionStore['blobs'];

/** Results by call, with the full text from the blob store for those a compaction released. */
function resultsOf(messages: Message[], blobs: Blobs): Map<string, ToolResultPart> {
  const out = new Map<string, ToolResultPart>();
  for (const m of messages)
    for (const p of m.parts) if (p.type === 'tool_result') out.set(p.callId, p.contentBlob || p.displayBlob ? { ...p, content: fullContent(p, blobs), display: fullDisplay(p, blobs) } : p);
  return out;
}

/** Answers the harness asked to rewrite in plainer words: only the rewrite is shown. */
function rewritten(messages: Message[]): Set<string> {
  const out = new Set<string>();
  messages.forEach((m, i) => {
    const next = messages[i + 1];
    if (m.role === 'assistant' && next?.origin === 'harness' && next.parts.some((p) => p.type === 'text' && p.text.includes('Rewrite your last message'))) out.add(m.id);
  });
  return out;
}

/** What the user typed, without the files Favilla attached to it. */
export function userText(m: Message): string {
  return m.parts
    .filter((p) => p.type === 'text' && !(p as { synthetic?: boolean }).synthetic)
    .map((p) => (p as { text: string }).text)
    .join('\n')
    .split('\n\nAttached by the user:')[0];
}

/**
 * A session's conversation as scrollback, for opening one (resume, a branch): the last `limit` messages, folded
 * as they were shown live. The transcript (ctrl+t) has all of it.
 */
export function replayItems(messages: Message[], blobs: Blobs, width: number, limit = 40): string[] {
  const shown = messages.filter((m) => !m.replay);
  const results = resultsOf(messages, blobs);
  const skip = rewritten(shown);
  const out: string[] = [];
  const from = Math.max(0, shown.length - limit);
  if (from > 0) out.push(paint('faint', t('… {n} earlier messages · ctrl+t shows the whole conversation', { n: from })));
  for (const m of shown.slice(from)) {
    if (m.role === 'user' && m.origin === 'user') out.push(userBlock(userText(m), m.parts.filter((p) => p.type === 'image').length, width));
    else if (m.role === 'user' && m.origin === 'compaction') out.push(paint('faint', `── ${t('earlier conversation summarized')} ──`));
    else if (m.role === 'assistant' && !skip.has(m.id)) {
      for (const p of m.parts) {
        if (p.type === 'text' && p.text.trim()) out.push(textBlock(p.text, width));
        else if (p.type === 'tool_call') {
          const r = results.get(p.id);
          if (r) out.push(toolBlock(p.name, toolTitle(p.name, p.input), r, width));
        }
      }
    }
  }
  return out;
}

/** A call's title as the engine would give it, for calls replayed from disk (the live title is not stored). */
function toolTitle(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.description ?? i.path ?? i.file_path ?? i.command ?? i.pattern ?? i.query ?? i.url ?? i.objective ?? '';
  return `${name} ${String(v).replace(/\s+/g, ' ')}`.trim();
}

/** The conversation as a markdown file a person can read or share: the user's words, the answers, and one line per tool call. */
export function transcriptMarkdown(messages: Message[], blobs: Blobs, meta: { title: string; cwd: string; provider: string; model: string }): string {
  const results = resultsOf(messages, blobs);
  const out = [`# ${meta.title || 'Favilla session'}`, '', `${meta.provider}/${meta.model} · ${meta.cwd.replace(/\\/g, '/')}`, ''];
  const skip = rewritten(messages);
  for (const m of messages) {
    if (m.replay) continue;
    if (m.role === 'user' && m.origin === 'user') out.push('## You', '', userText(m), '');
    else if (m.role === 'user' && m.origin === 'compaction') out.push('> *Earlier conversation summarized.*', '');
    else if (m.role === 'assistant' && !skip.has(m.id)) {
      const lines: string[] = [];
      for (const p of m.parts) {
        if (p.type === 'text' && p.text.trim()) lines.push(p.text.trim(), '');
        else if (p.type === 'tool_call') {
          const r = results.get(p.id);
          const first = r ? strip(r.content).split('\n').find((l) => l.trim()) ?? '' : '';
          lines.push(`- \`${toolTitle(p.name, p.input).slice(0, 160)}\`${r?.isError ? ' (failed)' : ''}${first ? `: ${first.slice(0, 160)}` : ''}`);
        }
      }
      if (lines.length) out.push('## Favilla', '', ...lines, '');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const MAX_RESULT_LINES = 400;

/** The whole conversation for reading: every message, reasoning in full, each tool's output in full (up to a cap). */
export function transcriptLines(messages: Message[], blobs: Blobs, width: number): string[] {
  const results = resultsOf(messages, blobs);
  const out: string[] = [];
  for (const m of messages) {
    if (m.replay) continue;
    if (m.role === 'user') {
      if (m.origin === 'user') out.push('', userBlock(userText(m), m.parts.filter((p) => p.type === 'image').length, width));
      else if (m.origin === 'compaction') out.push('', paint('violet', bold(t('Summary of earlier work'))), ...m.parts.filter((p) => p.type === 'text').map((p) => dim((p as { text: string }).text)));
      else if (m.origin === 'harness') {
        const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
        if (text.trim()) out.push(noticeBlock('info', `${t('Favilla to the model')}: ${text.replace(/\s+/g, ' ').slice(0, 600)}`));
      }
      continue;
    }
    if (m.role !== 'assistant') continue;
    out.push('');
    for (const p of m.parts) {
      if (p.type === 'reasoning' && p.text.trim()) out.push(dim(paint('muted', `✻ ${p.text.trim()}`)));
      else if (p.type === 'text' && p.text.trim()) out.push(textBlock(p.text, width));
      else if (p.type === 'tool_call') {
        const r = results.get(p.id);
        out.push(paint('faint', `▸ ${p.name} ${JSON.stringify(p.input ?? {}).slice(0, 400)}`));
        if (!r) continue;
        out.push(toolBlock(p.name, toolTitle(p.name, p.input), r, width));
        const lines = strip(r.content).replace(/\r/g, '').split('\n');
        out.push(...lines.slice(0, MAX_RESULT_LINES).map((l) => paint('faint', `    ${l}`)));
        if (lines.length > MAX_RESULT_LINES) out.push(paint('faint', `    ${t('… {n} more lines', { n: lines.length - MAX_RESULT_LINES })}`));
      }
    }
  }
  return out;
}
