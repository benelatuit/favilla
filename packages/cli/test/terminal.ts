import { EventEmitter } from 'node:events';
import stringWidth from 'string-width';

/**
 * A terminal for the Ink app in tests: keys go in through stdin as a real terminal sends them, and what the app
 * writes is played on a small screen emulator, so a test reads the scrollback and the screen as a person would
 * see them (a line drawn and then erased is gone, a line printed twice is there twice).
 */
export class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode() {
    return this;
  }
  setEncoding() {
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  send(data: string): void {
    this.queue.push(data);
    this.emit('readable');
  }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The escape codes Ink and the app use: cursor moves, erasing, and the ones that change nothing on screen. */
export class Screen {
  lines: string[][] = [[]];
  /** Each cell's colours and weight as SGR sequences set them when it was written, for `html()`. */
  styles: string[][] = [[]];
  row = 0;
  col = 0;
  private pen: Pen = {};
  constructor(
    public columns: number,
    public rows: number,
  ) {}

  private get top(): number {
    return Math.max(0, this.lines.length - this.rows);
  }
  private line(r: number): string[] {
    while (this.lines.length <= r) this.lines.push([]);
    while (this.styles.length < this.lines.length) this.styles.push([]);
    return this.lines[r];
  }
  private cut(r: number, length: number): void {
    this.lines[r].length = Math.min(this.lines[r].length, length);
    this.styles[r].length = Math.min(this.styles[r].length, length);
  }
  private put(ch: string): void {
    const w = Math.max(0, stringWidth(ch));
    if (this.col + w > this.columns) {
      this.row++;
      this.col = 0;
    }
    const l = this.line(this.row);
    const st = this.styles[this.row];
    while (l.length < this.col) l.push(' ');
    while (st.length < this.col) st.push('');
    const pen = penKey(this.pen);
    l[this.col] = ch;
    st[this.col] = pen;
    if (w === 2) {
      l[this.col + 1] = '';
      st[this.col + 1] = pen;
    }
    this.col += Math.max(1, w);
  }

  feed(data: string): void {
    let i = 0;
    while (i < data.length) {
      const c = data[i];
      if (c === '\x1b') {
        const rest = data.slice(i);
        const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
        if (osc) {
          i += osc[0].length;
          continue;
        }
        const csi = /^\x1b\[([0-9;?<>=]*)([A-Za-z~])/.exec(rest);
        if (csi) {
          this.csi(csi[1], csi[2]);
          i += csi[0].length;
          continue;
        }
        i += rest.length > 1 ? 2 : 1;
        continue;
      }
      if (c === '\r') {
        this.col = 0;
        i++;
        continue;
      }
      if (c === '\n') {
        this.row++;
        this.line(this.row);
        this.col = 0;
        i++;
        continue;
      }
      if (c === '\x07' || c < ' ') {
        i++;
        continue;
      }
      const g = segmenter.segment(data.slice(i, i + 8))[Symbol.iterator]().next().value!.segment;
      this.put(g);
      i += g.length;
    }
  }

  private csi(params: string, final: string): void {
    if (params.startsWith('?')) return;
    if (final === 'm') return void (this.pen = sgr(this.pen, params));
    const nums = params.split(';').map((n) => (n === '' ? NaN : Number(n)));
    const n = Number.isNaN(nums[0]) ? 1 : nums[0];
    switch (final) {
      case 'A':
        this.row = Math.max(this.top, this.row - n);
        break;
      case 'B':
        this.row += n;
        this.line(this.row);
        break;
      case 'C':
        this.col += n;
        break;
      case 'D':
        this.col = Math.max(0, this.col - n);
        break;
      case 'E':
        this.row += n;
        this.line(this.row);
        this.col = 0;
        break;
      case 'G':
        this.col = Math.max(0, n - 1);
        break;
      case 'H':
      case 'f': {
        const r = Number.isNaN(nums[0]) ? 1 : nums[0];
        const cl = Number.isNaN(nums[1]) || nums[1] === undefined ? 1 : nums[1];
        this.row = this.top + Math.max(0, r - 1);
        this.line(this.row);
        this.col = Math.max(0, cl - 1);
        break;
      }
      case 'K': {
        const l = this.line(this.row);
        const mode = Number.isNaN(nums[0]) ? 0 : nums[0];
        if (mode === 0) this.cut(this.row, this.col);
        else if (mode === 2) this.cut(this.row, 0);
        else
          for (let k = 0; k <= this.col && k < l.length; k++) {
            l[k] = ' ';
            this.styles[this.row][k] = '';
          }
        break;
      }
      case 'J': {
        const mode = Number.isNaN(nums[0]) ? 0 : nums[0];
        if (mode === 0) {
          this.line(this.row);
          this.cut(this.row, this.col);
          this.lines.length = this.row + 1;
          this.styles.length = this.row + 1;
        } else if (mode === 2 || mode === 3) {
          for (let r = this.top; r < this.lines.length; r++) {
            this.lines[r] = [];
            this.styles[r] = [];
          }
        }
        break;
      }
      default:
        break;
    }
  }

  /** Scrollback and screen, trailing blank lines dropped. */
  text(): string {
    const out = this.lines.map((l) => l.join('').replace(/\s+$/, ''));
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  }

  /**
   * Scrollback and screen as markup, each run of cells in its colours and weight, for a person to judge how the
   * screen reads. `ground` and `ink` stand for the terminal's own background and text, which inverse swaps in.
   */
  html(ground: string, ink: string): string {
    const rows = this.text().split('\n').length;
    const out: string[] = [];
    for (let r = 0; r < rows; r++) {
      const l = this.lines[r] ?? [];
      const st = this.styles[r] ?? [];
      let end = l.length;
      while (end > 0 && (l[end - 1] ?? ' ') === ' ' && !penOf(st[end - 1] ?? '').bg) end--;
      let line = '';
      for (let c = 0; c < end; ) {
        const key = st[c] ?? '';
        let text = '';
        for (; c < end && (st[c] ?? '') === key; c++) {
          const ch = (l[c] ?? ' ').replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[x]!);
          // A wide character takes its two cells exactly, as a terminal gives it: in a page font a CJK glyph is a
          // little narrower or wider than two columns and a frame's right edge after it went ragged.
          text += l[c + 1] === '' && ch ? `<span style="display:inline-block;width:2ch">${ch}</span>` : ch;
        }
        const css = penCss(penOf(key), ground, ink);
        line += css ? `<span style="${css}">${text}</span>` : text;
      }
      out.push(line);
    }
    return out.join('\n');
  }
}

interface Pen {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

const penKey = (p: Pen): string => (Object.keys(p).length ? JSON.stringify(p) : '');
const penOf = (key: string): Pen => (key ? (JSON.parse(key) as Pen) : {});

const BASIC = ['#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc', '#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2'];
const hex = (n: number) => n.toString(16).padStart(2, '0');
function xterm(n: number): string {
  if (n < 16) return BASIC[n];
  if (n >= 232) return `#${hex(8 + (n - 232) * 10).repeat(3)}`;
  const i = n - 16;
  const step = (v: number) => (v ? 55 + v * 40 : 0);
  return `#${hex(step(Math.floor(i / 36)))}${hex(step(Math.floor(i / 6) % 6))}${hex(step(i % 6))}`;
}

/** The pen after one SGR sequence: colours in 16, 256 and true colour, weight, slant, lines and inverse. */
function sgr(pen: Pen, params: string): Pen {
  let next: Pen = { ...pen };
  const n = params === '' ? [0] : params.split(/[;:]/).map(Number);
  for (let i = 0; i < n.length; i++) {
    const v = n[i];
    if (v === 0) next = {};
    else if (v === 1) next.bold = true;
    else if (v === 2) next.dim = true;
    else if (v === 22) {
      delete next.bold;
      delete next.dim;
    } else if (v === 3) next.italic = true;
    else if (v === 23) delete next.italic;
    else if (v === 4) next.underline = true;
    else if (v === 24) delete next.underline;
    else if (v === 7) next.inverse = true;
    else if (v === 27) delete next.inverse;
    else if (v === 9) next.strike = true;
    else if (v === 29) delete next.strike;
    else if (v === 39) delete next.fg;
    else if (v === 49) delete next.bg;
    else if ((v >= 30 && v <= 37) || (v >= 90 && v <= 97)) next.fg = BASIC[v >= 90 ? v - 82 : v - 30];
    else if ((v >= 40 && v <= 47) || (v >= 100 && v <= 107)) next.bg = BASIC[v >= 100 ? v - 92 : v - 40];
    else if (v === 38 || v === 48) {
      const key = v === 38 ? 'fg' : 'bg';
      if (n[i + 1] === 5) {
        next[key] = xterm(n[i + 2]);
        i += 2;
      } else if (n[i + 1] === 2) {
        next[key] = `#${hex(n[i + 2])}${hex(n[i + 3])}${hex(n[i + 4])}`;
        i += 4;
      }
    }
  }
  return next;
}

function penCss(p: Pen, ground: string, ink: string): string {
  let fg = p.fg;
  let bg = p.bg;
  if (p.inverse) [fg, bg] = [bg ?? ground, fg ?? ink];
  const css: string[] = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background:${bg}`);
  if (p.bold) css.push('font-weight:700');
  if (p.dim) css.push('opacity:.55');
  if (p.italic) css.push('font-style:italic');
  const lines = [p.underline && 'underline', p.strike && 'line-through'].filter(Boolean);
  if (lines.length) css.push(`text-decoration:${lines.join(' ')}`);
  return css.join(';');
}

export class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 110;
  rows = 40;
  screen = new Screen(this.columns, this.rows);
  write(s: string | Uint8Array, cb?: () => void): boolean {
    this.screen.feed(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    cb?.();
    return true;
  }
  text(): string {
    return this.screen.text();
  }
  /** How many times `needle` is on the screen and in the scrollback. */
  count(needle: string): number {
    return this.text().split(needle).length - 1;
  }
}

export const KEYS = {
  enter: '\r',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  backspace: '\x7f',
  tab: '\t',
  shiftTab: '\x1b[Z',
  ctrlT: '\x14',
  paste: (s: string) => `\x1b[200~${s}\x1b[201~`,
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `test` holds, checking every 25 ms; fails with `what` after `ms`. */
export async function until(test: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
