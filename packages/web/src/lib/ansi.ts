/** Terminal output to HTML: SGR colours become theme classes; everything else is escaped. */
const BASIC = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const ANSI_TOKEN = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export interface AnsiState {
  fg: string | null;
  bold: boolean;
  dim: boolean;
}

export function createAnsiState(): AnsiState {
  return { fg: null, bold: false, dim: false };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function normalizeCr(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/^.*\r(?=[^\r\n])/gm, '').replace(/\r/g, '');
}

/** Convert an incremental chunk of terminal output into HTML while mutating `state` across chunks. */
export function ansiChunkToHtml(input: string, state: AnsiState = createAnsiState()): string {
  const text = normalizeCr(input);
  let out = '';
  const re = new RegExp(ANSI_TOKEN.source, 'g');
  let last = 0;
  const flush = (chunk: string) => {
    if (!chunk) return;
    const cls = [state.fg ? `ansi-${state.fg}` : '', state.bold ? 'ansi-bold' : '', state.dim ? 'ansi-dim' : ''].filter(Boolean).join(' ');
    out += cls ? `<span class="${cls}">${esc(chunk)}</span>` : esc(chunk);
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    flush(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        state.fg = null;
        state.bold = false;
        state.dim = false;
      } else if (c === 1) state.bold = true;
      else if (c === 2) state.dim = true;
      else if (c === 22) {
        state.bold = false;
        state.dim = false;
      } else if (c >= 30 && c <= 37) state.fg = BASIC[c - 30];
      else if (c >= 90 && c <= 97) state.fg = `bright-${BASIC[c - 90]}`;
      else if (c === 39) state.fg = null;
      else if (c === 38 && codes[i + 1] === 5) {
        const n = codes[i + 2];
        state.fg = n < 8 ? BASIC[n] : n < 16 ? `bright-${BASIC[n - 8]}` : null;
        i += 2;
      } else if (c === 38 && codes[i + 1] === 2) i += 4;
    }
  }
  flush(text.slice(last));
  return out;
}

export function ansiToHtml(input: string): string {
  return ansiChunkToHtml(input, createAnsiState());
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI_STRIP, '');
}

/** Last non-empty lines of live terminal output with ANSI control codes stripped and `\r` progress lines collapsed. */
export function liveTailLines(text: string, maxLines = 3): string[] {
  if (!text) return [];
  return normalizeCr(stripAnsi(text))
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(-maxLines);
}
