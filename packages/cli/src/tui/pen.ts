import { useSyncExternalStore } from 'react';
import { paint } from './theme';

/**
 * What is under way, in the page's own language (web components/Pen.tsx): a pen on a ruled line of a few cells. It
 * draws the line while the agent writes (`write`), marks it step by step while a tool runs (`step`), slides over it
 * without ink while the model thinks (`think`), stands over a broken line while a request waits to be tried again
 * (`wait`), and draws from the right while the context is folded (`fold`). The ink and the rule differ in shape as
 * well as in grey, so the modes still read with NO_COLOR or in a terminal without colours.
 */
export type PenMode = 'write' | 'step' | 'think' | 'wait' | 'fold';

/** One step of the pen every this long: a calm pace, and two fifths of the redraws of the spinner it replaced (120 ms). */
export const PEN_MS = 300;

export interface PenGlyphs {
  rule: string;
  ink: string;
  nib: string;
}

/** Box-drawing lines, drawn one cell wide by Windows Terminal, VS Code, mintty and the terminals of other systems. */
export const LINES: PenGlyphs = { rule: '─', ink: '━', nib: '•' };
/**
 * ASCII for the Windows console window (conhost): its fonts may lack the heavy line, and with an East Asian code page
 * it draws box lines two cells wide, which would push the rest of the line out of place.
 */
export const ASCII: PenGlyphs = { rule: '-', ink: '=', nib: 'o' };

export function penGlyphs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): PenGlyphs {
  return platform !== 'win32' || env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' ? LINES : ASCII;
}

const glyphs = penGlyphs();

/** The cells of one frame: `i` ink, `r` the rule, `n` the nib, ` ` a gap. */
export function penCells(mode: PenMode, frame: number, cells: number): string {
  const line = (inked: (i: number) => boolean) => Array.from({ length: cells }, (_, i) => (inked(i) ? 'i' : 'r')).join('');
  if (mode === 'wait') return Array.from({ length: cells }, (_, i) => (i === Math.floor(cells / 2) ? ' ' : 'r')).join('');
  if (mode === 'think') {
    // There and back: 0 1 2 3 4 3 2 1 for five cells.
    const span = Math.max(1, 2 * (cells - 1));
    const f = frame % span;
    const at = f < cells ? f : span - f;
    return Array.from({ length: cells }, (_, i) => (i === at ? 'n' : 'r')).join('');
  }
  if (mode === 'step') {
    // Marks on every other cell, one more each two frames, held, then lifted.
    const marks = Math.ceil(cells / 2);
    const f = frame % (2 * marks + 1);
    const shown = f === 2 * marks ? 0 : Math.floor(f / 2) + 1;
    return line((i) => i % 2 === 0 && i / 2 < shown);
  }
  // Drawn one cell a frame, held a frame, then lifted.
  const f = frame % (cells + 2);
  const drawn = f <= cells ? Math.min(f + 1, cells) : 0;
  return line((i) => (mode === 'fold' ? i >= cells - drawn : i < drawn));
}

/** The pen as painted text: the ink in the accent's grey, the rule and the nib's track in the faint one. */
export function pen(mode: PenMode, frame: number, cells = 5, g: PenGlyphs = glyphs): string {
  const runs = penCells(mode, frame, cells).match(/(.)\1*/g) ?? [];
  return runs
    .map((run) => {
      const n = run.length;
      if (run[0] === 'i') return paint('blue', g.ink.repeat(n));
      if (run[0] === 'n') return paint('blue', g.nib.repeat(n));
      if (run[0] === ' ') return ' '.repeat(n);
      return paint('faint', g.rule.repeat(n));
    })
    .join('');
}

// One clock for every pen on screen, running only while one is drawn.
const listeners = new Set<() => void>();
let frame = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      frame++;
      for (const l of listeners) l();
    }, PEN_MS);
    timer.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * The pen's frame, for the lines that draw one: they are drawn again on its steps (and their clocks with them) while
 * the rest of the screen is not, and with no pen on screen there is no timer at all.
 */
export function usePenFrame(): number {
  return useSyncExternalStore(subscribe, () => frame);
}
