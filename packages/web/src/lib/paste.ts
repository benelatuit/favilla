import { ATTACHED } from './messages';
import { pastedBlock, takePasted } from '@favilla/core/prompt/attached';
import type { Message } from './types';

export { takePasted };

/**
 * A long paste (a log, a file's text, a stack trace) does not go into the message box, where it buries the user's
 * own words and cannot be edited around: it waits as a chip and is sent after their words, in a block of its own,
 * so the agent can tell what was said from what was pasted. The limits are the terminal UI's (tui/editor.tsx).
 */
const LONG_PASTE_LINES = 8;
const LONG_PASTE_CHARS = 1200;

export const lineCount = (text: string) => text.split('\n').length;

/** Clipboard text as it is kept: Windows line ends made plain, so the line count in the block's tag is exact. */
export const pasteText = (raw: string) => raw.replace(/\r\n?/g, '\n');

export const isLongPaste = (text: string) => text.length > LONG_PASTE_CHARS || lineCount(text) > LONG_PASTE_LINES;

/** The message with what the user attached after their words: the blocks of pointed elements, then the pastes. */
export function withAttached(text: string, blocks: string[], pastes: string[]): string {
  const all = [...blocks, ...pastes.map((p, i) => pastedBlock(p, i + 1))];
  return all.length ? `${text}${ATTACHED}${all.join('\n\n')}` : text;
}

/** What a user's message pasted, in order. */
export function pastedIn(m: Message): string[] {
  const raw = m.parts.map((p) => (p.type === 'text' && !p.synthetic ? p.text : '')).join('\n');
  return takePasted(raw).pastes;
}
