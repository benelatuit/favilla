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
  row = 0;
  col = 0;
  constructor(
    public columns: number,
    public rows: number,
  ) {}

  private get top(): number {
    return Math.max(0, this.lines.length - this.rows);
  }
  private line(r: number): string[] {
    while (this.lines.length <= r) this.lines.push([]);
    return this.lines[r];
  }
  private put(ch: string): void {
    const w = Math.max(0, stringWidth(ch));
    if (this.col + w > this.columns) {
      this.row++;
      this.col = 0;
    }
    const l = this.line(this.row);
    while (l.length < this.col) l.push(' ');
    l[this.col] = ch;
    if (w === 2) l[this.col + 1] = '';
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
        if (mode === 0) l.length = Math.min(l.length, this.col);
        else if (mode === 2) l.length = 0;
        else for (let k = 0; k <= this.col && k < l.length; k++) l[k] = ' ';
        break;
      }
      case 'J': {
        const mode = Number.isNaN(nums[0]) ? 0 : nums[0];
        if (mode === 0) {
          this.line(this.row).length = Math.min(this.line(this.row).length, this.col);
          this.lines.length = this.row + 1;
        } else if (mode === 2 || mode === 3) {
          for (let r = this.top; r < this.lines.length; r++) this.lines[r] = [];
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
