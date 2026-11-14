import { ATTACHED, attachedPart, takePasted } from '@favilla/core/prompt/attached';
import type { Message } from './types';

export { ATTACHED };

/** What the user typed in a message, without the files Favilla attached to it. */
export function userWords(m: Message): string {
  return m.parts
    .filter((p) => p.type === 'text' && !p.synthetic)
    .map((p) => (p as { text: string }).text)
    .join('\n')
    .split(ATTACHED)[0];
}

/** The files attached to a user's message, by path. */
export function attachedFiles(m: Message): string[] {
  const raw = m.parts
    .filter((p) => p.type === 'text' && !p.synthetic)
    .map((p) => (p as { text: string }).text)
    .join('\n');
  return [...attachedPart(takePasted(raw).text).matchAll(/<(?:file|folder) path="([^"]+)">/g)].map((x) => x[1]);
}

/** The messages the user typed, in order, numbered from 1: the turns of a conversation as the outline lists them. */
export function userTurns(messages: Message[]): { id: string; n: number; text: string; time: number; after?: 'compaction' }[] {
  const out: { id: string; n: number; text: string; time: number; after?: 'compaction' }[] = [];
  let summarized = false;
  for (const m of messages) {
    if (m.replay) continue;
    if (m.origin === 'compaction') summarized = true;
    if (m.origin !== 'user') continue;
    out.push({ id: m.id, n: out.length + 1, text: userWords(m), time: m.time, ...(summarized ? { after: 'compaction' as const } : {}) });
    summarized = false;
  }
  return out;
}
