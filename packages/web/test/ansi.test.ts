import { describe, expect, it } from 'vitest';
import { ansiChunkToHtml, ansiToHtml, createAnsiState, liveTailLines, stripAnsi } from '../src/lib/ansi';

describe('ansi incremental html and live tail helpers', () => {
  it('preserves SGR colour and weight state across incremental chunks identically to full ansiToHtml', () => {
    const chunks = [
      '\x1b[1;32mPASS\x1b[22m src/follow.ts\n',
      '  still green line 2\n',
      '\x1b[2;36mdim cyan ',
      'across boundary\x1b[0m plain\n',
    ];
    const state = createAnsiState();
    const incremental = chunks.map((c) => ansiChunkToHtml(c, state)).join('');
    // Merging adjacent spans with identical class attributes proves per-character style parity across chunk seams.
    const coalesce = (html: string) => html.replace(/<\/span><span class="([^"]+)">/g, (_, cls, off, src) => {
      const before = src.slice(0, off);
      const open = before.lastIndexOf('<span class="');
      const prevCls = open >= 0 ? /^<span class="([^"]+)">/.exec(before.slice(open))?.[1] : null;
      return prevCls === cls ? '' : `</span><span class="${cls}">`;
    });
    expect(coalesce(incremental)).toBe(ansiToHtml(chunks.join('')));
    expect(state).toEqual({ fg: null, bold: false, dim: false });
  });

  it('collapses carriage-return progress overwrites without blanking a line that ends with trailing CR', () => {
    expect(liveTailLines('Downloading 10%\rDownloading 45%\rDownloading 90%')).toEqual(['Downloading 90%']);
    expect(liveTailLines('Building [==>   ] 40%\rBuilding [====> ] 80%\r')).toEqual(['Building [====> ] 80%']);
    expect(ansiToHtml('step 1\rstep 2\r')).toBe('step 2');
  });

  it('strips private CSI and OSC sequences and drops empty/control-only tails', () => {
    const raw = '\x1b[?25l\x1b]0;cargo test\x07\x1b]8;;https://example.com\x1b\\   \r\n';
    expect(stripAnsi(raw).trim()).toBe('');
    expect(liveTailLines(raw)).toEqual([]);
    expect(liveTailLines('\x1b[?25l\nline 1\nline 2\nline 3\nline 4\n\x1b[?25h', 3)).toEqual(['line 2', 'line 3', 'line 4']);
  });
});
