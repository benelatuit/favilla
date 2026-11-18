import React from 'react';
import { render, Text } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASCII, LINES, pen, penCells, penGlyphs, PEN_MS, usePenFrame, type PenMode } from '../src/tui/pen';
import { cols, strip } from '../src/tui/text';
import { FakeStdin, FakeStdout } from './terminal';

const frames = (mode: PenMode, n: number, cells = 5) => Array.from({ length: n }, (_, f) => penCells(mode, f, cells));

describe('the pen in the terminal', () => {
  it('draws the line from the left, holds it, lifts it, and folds from the right', () => {
    expect(frames('write', 8)).toEqual(['irrrr', 'iirrr', 'iiirr', 'iiiir', 'iiiii', 'iiiii', 'rrrrr', 'irrrr']);
    expect(frames('fold', 7)).toEqual(['rrrri', 'rrrii', 'rriii', 'riiii', 'iiiii', 'iiiii', 'rrrrr']);
  });

  it('marks a tool step by step, slides over the line while thinking, and stands still over a broken line while waiting', () => {
    expect(frames('step', 7)).toEqual(['irrrr', 'irrrr', 'irirr', 'irirr', 'iriri', 'iriri', 'rrrrr']);
    expect(frames('step', 5, 3)).toEqual(['irr', 'irr', 'iri', 'iri', 'rrr']);
    expect(frames('think', 9).map((f) => f.indexOf('n'))).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0]);
    expect(new Set(frames('wait', 9))).toEqual(new Set(['rr rr']));
  });

  it('keeps every frame the same width in both glyph sets, with ink and rule apart without colour', () => {
    for (const g of [LINES, ASCII]) {
      expect(new Set([g.rule, g.ink, g.nib]).size).toBe(3);
      for (const mode of ['write', 'step', 'think', 'wait', 'fold'] as const) {
        for (let f = 0; f < 12; f++) {
          expect(cols(strip(pen(mode, f, 5, g)))).toBe(5);
          expect(cols(strip(pen(mode, f, 3, g)))).toBe(3);
        }
      }
    }
    expect(strip(pen('write', 2, 5, ASCII))).toBe('===--');
    expect(strip(pen('think', 1, 5, LINES))).toBe('─•───');
  });

  it('uses box lines where they are one cell wide and ASCII in the Windows console', () => {
    expect(penGlyphs({}, 'win32')).toBe(ASCII);
    expect(penGlyphs({ WT_SESSION: 'x' }, 'win32')).toBe(LINES);
    expect(penGlyphs({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe(LINES);
    expect(penGlyphs({}, 'linux')).toBe(LINES);
    expect(penGlyphs({}, 'darwin')).toBe(LINES);
  });
});

describe('the pen clock', () => {
  afterEach(() => vi.useRealTimers());

  it('runs only while a pen is on screen, and draws only the line that holds it', async () => {
    vi.useFakeTimers();
    let lineDraws = 0;
    let outerDraws = 0;
    function Line() {
      const f = usePenFrame();
      lineDraws++;
      return <Text>{penCells('write', f, 5)}</Text>;
    }
    function Outer({ busy }: { busy: boolean }) {
      outerDraws++;
      return busy ? <Line /> : <Text>idle</Text>;
    }
    const stdout = new FakeStdout();
    const idleTimers = () => vi.getTimerCount();
    const ink = render(<Outer busy={false} />, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: new FakeStdin() as unknown as NodeJS.ReadStream, patchConsole: false });
    await vi.advanceTimersByTimeAsync(50);
    const before = idleTimers();
    ink.rerender(<Outer busy />);
    await vi.advanceTimersByTimeAsync(50);
    expect(idleTimers()).toBe(before + 1);
    const [l0, o0] = [lineDraws, outerDraws];
    await vi.advanceTimersByTimeAsync(PEN_MS * 4);
    expect(lineDraws - l0).toBe(4);
    expect(outerDraws).toBe(o0);
    ink.rerender(<Outer busy={false} />);
    await vi.advanceTimersByTimeAsync(50);
    expect(idleTimers()).toBe(before);
    ink.unmount();
  });
});
