import { marked } from 'marked';

/**
 * How much of a reply still being written is settled: whole markdown blocks that a blank line has closed, with
 * another block already begun after them. That part goes to the scrollback for good while the rest stays live,
 * so a long answer never grows the redrawn part of the screen past its height, and a code block or a table is
 * printed once, complete.
 */
export function settledLength(text: string): number {
  const tokens = marked.lexer(text, { gfm: true });
  let offset = 0;
  let settled = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    offset += t.raw.length;
    if (t.type !== 'space' || i === 0) continue;
    if (!tokens.slice(i + 1).some((x) => x.type !== 'space')) break;
    if (/\n[ \t]*\n/.test(`${tokens[i - 1].raw.slice(-1)}${t.raw}`)) settled = offset;
  }
  return settled;
}

/** The last `max` rows of a live block, with a line saying how many are above (they print in full once it closes). */
export function tail(text: string, max: number, above: (n: number) => string): string {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return [above(lines.length - max + 1), ...lines.slice(-(max - 1))].join('\n');
}
