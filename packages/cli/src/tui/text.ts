import stringWidth from 'string-width';

/** Terminal text by columns: CJK characters and most emoji take two, combining marks none. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const strip = (s: string): string => s.replace(ANSI, '');

/** Last non-empty lines of live terminal output with ANSI control codes stripped and `\r` progress lines collapsed. */
export function liveTailLines(raw: string, max = 3): string[] {
  if (!raw) return [];
  return strip(raw)
    .replace(/\r\n/g, '\n')
    .replace(/^.*\r(?=[^\r\n])/gm, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(-max);
}

export const cols = (s: string): number => stringWidth(s);

/** The text's user-perceived characters with where each starts, so a cursor never lands inside one. */
export function graphemes(s: string): { text: string; index: number }[] {
  return Array.from(segmenter.segment(s), (g) => ({ text: g.segment, index: g.index }));
}

/** Cut to at most `max` columns with an ellipsis; a cut string loses its colours, a short one keeps them. */
export function clip(s: string, max: number): string {
  if (cols(s) <= max) return s;
  const plain = strip(s);
  let out = '';
  let w = 0;
  for (const g of graphemes(plain)) {
    const gw = cols(g.text);
    if (w + gw > Math.max(1, max - 1)) break;
    out += g.text;
    w += gw;
  }
  return `${out}…`;
}

/** Cut from the start to at most `max` columns, keeping the end: a path's last folders say where it is. */
export function clipStart(s: string, max: number): string {
  if (cols(s) <= max) return s;
  const parts = graphemes(strip(s));
  let out = '';
  let w = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const gw = cols(parts[i].text);
    if (w + gw > Math.max(1, max - 1)) break;
    out = parts[i].text + out;
    w += gw;
  }
  return `…${out}`;
}

/** Pad with spaces to `n` columns. */
export const padEnd = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - cols(s)));

interface InputRow {
  /** Offsets in the text where the row starts and ends (the end is exclusive and never includes a newline). */
  start: number;
  end: number;
  text: string;
}

/**
 * The input laid out in rows of `width` columns, broken anywhere (Chinese has no spaces to break at), and the
 * cursor's row and column. Ink is given these rows as they are, so the real terminal cursor, which an input
 * method draws its candidates at, can be put exactly where the text cursor is.
 */
export function layoutInput(text: string, cursor: number, width: number): { rows: InputRow[]; row: number; col: number } {
  const w = Math.max(4, width);
  const rows: InputRow[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    let start = offset;
    let used = 0;
    let row = '';
    for (const g of graphemes(line)) {
      const gw = cols(g.text);
      if (used + gw > w && row) {
        rows.push({ start, end: offset + g.index, text: row });
        start = offset + g.index;
        row = '';
        used = 0;
      }
      row += g.text;
      used += gw;
    }
    rows.push({ start, end: offset + line.length, text: row });
    offset += line.length + 1;
  }
  // The cursor sits on the last row that starts at or before it; at the very end of a full row it moves to the
  // next row's start, as typing would put the next character there.
  let row = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i].start <= cursor) row = i;
  const r = rows[row];
  let col = cols(text.slice(r.start, Math.min(cursor, r.end)));
  if (col >= w && row + 1 < rows.length && rows[row + 1].start === r.end) {
    row++;
    col = 0;
  }
  return { rows, row, col };
}

/** The text offset in `row` nearest to column `col`, for moving the cursor up and down by rows. */
export function offsetAt(row: InputRow, col: number): number {
  let used = 0;
  for (const g of graphemes(row.text)) {
    const gw = cols(g.text);
    if (used + gw > col) return row.start + g.index;
    used += gw;
  }
  return row.end;
}
