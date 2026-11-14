/** Terminal output to HTML: SGR colours become theme classes; everything else is escaped. */
const BASIC = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function ansiToHtml(input: string): string {
  const text = input.replace(/\r\n/g, '\n').replace(/^.*\r(?!\n)/gm, '');
  let out = '';
  let fg: string | null = null;
  let bold = false;
  let dim = false;
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
  let last = 0;
  const flush = (chunk: string) => {
    if (!chunk) return;
    const cls = [fg ? `ansi-${fg}` : '', bold ? 'ansi-bold' : '', dim ? 'ansi-dim' : ''].filter(Boolean).join(' ');
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
        fg = null;
        bold = false;
        dim = false;
      } else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) {
        bold = false;
        dim = false;
      } else if (c >= 30 && c <= 37) fg = BASIC[c - 30];
      else if (c >= 90 && c <= 97) fg = `bright-${BASIC[c - 90]}`;
      else if (c === 39) fg = null;
      else if (c === 38 && codes[i + 1] === 5) {
        const n = codes[i + 2];
        fg = n < 8 ? BASIC[n] : n < 16 ? `bright-${BASIC[n - 8]}` : null;
        i += 2;
      } else if (c === 38 && codes[i + 1] === 2) i += 4;
    }
  }
  flush(text.slice(last));
  return out;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
}
