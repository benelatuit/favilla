import type { CSSProperties } from 'react';

/**
 * What is under way, as a pen on a ruled line in place of a turning ring. The pen draws the line while the agent
 * writes or a thing loads (`write`), marks it step by step while a tool runs (`step`), hovers over it without ink while
 * the model thinks (`think`), stands lifted over a broken line while a request waits to be tried again (`wait`), and
 * draws from the right while the context is folded (`fold`). The marks follow the text colour of where they sit; the
 * styles are `.pen` in base.css. It is drawn only while the work lasts, so nothing moves on an idle window.
 */
export type PenMode = 'write' | 'step' | 'think' | 'wait' | 'fold';

export function Pen({ mode = 'write', width = 14, label }: { mode?: PenMode; width?: number; label?: string }) {
  return (
    <span
      className={`pen is-${mode}`}
      style={{ '--pen-w': `${width}px`, ...(width < 14 ? { '--pen-h': `${width}px` } : {}) } as CSSProperties}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <i />
      <i />
      <i />
    </span>
  );
}
