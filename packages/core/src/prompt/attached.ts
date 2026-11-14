/**
 * What a user attached goes after their words, under this line: files named with @, elements pointed at in a
 * preview, long pastes. The front ends show the words and name the attachments; the model reads both.
 */
export const ATTACHED = '\n\nAttached by the user:\n';

/**
 * A long paste as it goes with a message, numbered in the order pasted. Its line count is in the tag, so a reader
 * of the stored message finds the paste's end even when the pasted text holds a closing tag of its own.
 */
export function pastedBlock(text: string, n: number): string {
  return `<pasted name="Pasted text ${n}" lines="${text.split('\n').length}">\n${text}\n</pasted>`;
}

const PASTED = /^<pasted name="Pasted text \d+" lines="(\d+)">$/;

/** The line count keeps a pasted closing tag or attachment separator inside the paste. */
export function takePasted(raw: string): { text: string; pastes: string[] } {
  const at = raw.indexOf(ATTACHED);
  if (at < 0) return { text: raw, pastes: [] };
  const lines = raw.slice(at + ATTACHED.length).split('\n');
  const pastes: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const n = Number(PASTED.exec(lines[i])?.[1] ?? 0);
    if (n && lines[i + n + 1] === '</pasted>') {
      pastes.push(lines.slice(i + 1, i + n + 1).join('\n'));
      i += n + 1;
    } else rest.push(lines[i]);
  }
  const others = rest.join('\n').trim();
  return { text: others ? `${raw.slice(0, at)}${ATTACHED}${others}` : raw.slice(0, at), pastes };
}

/** The message with blocks attached after the user's words, joining any that are already there. */
export function attach(text: string, blocks: string[]): string {
  if (!blocks.length) return text;
  return text.includes(ATTACHED) ? `${text}\n\n${blocks.join('\n\n')}` : `${text}${ATTACHED}${blocks.join('\n\n')}`;
}

/** The part of a message the user typed. */
export function typedPart(text: string): string {
  const at = text.indexOf(ATTACHED);
  return at < 0 ? text : text.slice(0, at);
}

/** Everything after the user's words, or nothing. */
export function attachedPart(text: string): string {
  const at = text.indexOf(ATTACHED);
  return at < 0 ? '' : text.slice(at + ATTACHED.length);
}
