import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react';
import { count, useT } from '../../lib/i18n';
import { useMedia } from '../../lib/layout';
import type { CodeRow } from '../../lib/diff';

/** Rows drawn together; a chunk is drawn when it comes near the view and kept once drawn. */
export const CHUNK = 64;
/** The height of a code row and of a gap row while lines do not wrap; set in timeline.css as well. */
export const ROW = 20;
const GAP = 28;
/** Rows drawn ahead in idle time by default; past this the rest is drawn only where it is read. */
const AHEAD = 2560;
/** Lines wrap at this width and below, where scrolling sideways through code does not work. */
export const WRAP = '(max-width: 640px)';

const height = (rows: CodeRow[], from: number, to: number) => {
  let h = 0;
  for (let i = from; i < to; i++) h += rows[i].k === 'gap' || rows[i].k === 'note' ? GAP : ROW;
  return h;
};

/**
 * Rows of code: a diff (two line numbers) or a file (one). Long ones are drawn in chunks as they near the view of
 * `root`, the box that scrolls them, so a change of 2,000 lines opens as fast as one of 100; a chunk once drawn stays,
 * so a selection or a search that reached it keeps it. `all` draws every chunk, for Find.
 */
export function CodeRows({
  rows,
  widest,
  digits,
  sides,
  root,
  all,
  around,
  ahead = AHEAD,
  hold,
  onGap,
}: {
  rows: CodeRow[];
  widest: number[];
  digits: number;
  sides: 1 | 2;
  root: RefObject<HTMLElement | null>;
  all?: boolean;
  /** A row to draw at once with its neighbours: the line a file view opens at. */
  around?: number;
  /** Rows to draw ahead in idle time, nearest first, so a fling finds them drawn. */
  ahead?: number;
  /** The rows are about to change (their colours are on the way): nothing is drawn ahead until they do. */
  hold?: boolean;
  onGap?: (index: number) => void;
}) {
  const wrap = useMedia(WRAP);
  const chunks = Math.ceil(rows.length / CHUNK);
  // Opened at a line, the chunks there; else the top. A file opened far down has no use for its first lines yet.
  const first = useCallback(() => {
    if (around === undefined) return new Set([0, 1]);
    const s = new Set<number>();
    for (let c = Math.floor(around / CHUNK) - 1; c <= Math.floor(around / CHUNK) + 1; c++) if (c >= 0 && c < Math.max(1, chunks)) s.add(c);
    return s;
  }, [around, chunks]);
  const [shown, setShown] = useState(first);
  // A file opened at another line draws the chunks there at once. Chunks drawn stay drawn when the rows change
  // (their colours arrive, a gap opens): taking them away would blank the view for a frame.
  const at = useRef(around);
  // Where the reader is: the chunk last come into view, else the line opened at. Drawing ahead starts there.
  const focus = useRef(around === undefined ? 0 : Math.floor(around / CHUNK));
  if (at.current !== around) {
    at.current = around;
    if (around !== undefined) focus.current = Math.floor(around / CHUNK);
    setShown((s) => new Set([...s, ...first()]));
  }
  // The observer is made after every ref of the commit is in place: refs are set children first, so the box that
  // scrolls these rows has none yet when the first placeholder's ref runs, and the view would be taken instead.
  const pending = useRef(new Set<HTMLElement>());
  const io = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const o = new IntersectionObserver(
      (entries) => {
        const near = entries.filter((e) => e.isIntersecting).map((e) => Number((e.target as HTMLElement).dataset.chunk));
        if (!near.length) return;
        focus.current = near[near.length - 1];
        setShown((s) => (near.every((c) => s.has(c)) ? s : new Set([...s, ...near])));
      },
      { root: root.current, rootMargin: '800px 0px' },
    );
    io.current = o;
    for (const el of pending.current) o.observe(el);
    return () => {
      o.disconnect();
      io.current = null;
    };
  }, [root]);
  // In idle time, the chunks nearest the reader are drawn too, one each side in turn, up to `ahead` rows, so a fast
  // fling finds them ready; the rest is drawn as it comes into view. Only in real idle time and
  // not while the box scrolls: a chunk drawn between two frames of a scroll made that frame late.
  const scrolledAt = useRef(0);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = () => (scrolledAt.current = performance.now());
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, [root]);
  useEffect(() => {
    if (all || hold || shown.size >= chunks || shown.size * CHUNK >= ahead) return;
    const hasIdle = typeof requestIdleCallback === 'function';
    let id = 0;
    const tick = (deadline?: IdleDeadline) => {
      if ((deadline && deadline.timeRemaining() < 12) || performance.now() - scrolledAt.current < 150) {
        id = hasIdle ? requestIdleCallback(tick) : window.setTimeout(tick, 100);
        return;
      }
      const f = Math.min(Math.max(focus.current, 0), chunks - 1);
      let next = -1;
      for (let d = 0; d < chunks && next < 0; d++) {
        if (f + d < chunks && !shown.has(f + d)) next = f + d;
        else if (f - d >= 0 && !shown.has(f - d)) next = f - d;
      }
      if (next >= 0) setShown((s) => new Set([...s, next]));
    };
    id = hasIdle ? requestIdleCallback(tick) : window.setTimeout(tick, 100);
    return () => (hasIdle ? cancelIdleCallback(id) : window.clearTimeout(id));
  }, [shown, chunks, all, ahead, hold]);
  const watch = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    pending.current.add(el);
    io.current?.observe(el);
    return () => {
      pending.current.delete(el);
      io.current?.unobserve(el);
    };
  }, []);

  // Summed once for a set of rows: summed on every draw, each chunk drawn walked every row not yet drawn again.
  const heights = useMemo(() => {
    const h: number[] = [];
    for (let c = 0; c < chunks; c++) h.push(height(rows, c * CHUNK, Math.min(rows.length, c * CHUNK + CHUNK)));
    return h;
  }, [rows, chunks]);
  const style = { '--dl-digits': digits } as CSSProperties;
  const t = useT();
  const gap = useCallback((n: number) => count(t, n, '{n} unchanged line', '{n} unchanged lines'), [t]);
  const out = [];
  for (let c = 0; c < chunks; c++) {
    const from = c * CHUNK;
    const to = Math.min(rows.length, from + CHUNK);
    if (all || shown.has(c)) out.push(<Chunk key={c} rows={rows} from={from} to={to} sides={sides} open={!!onGap} gap={gap} wrap={wrap} />);
    else
      out.push(
        <div
          key={c}
          className="dl-pending"
          data-chunk={c}
          // Wrapped lines are taller than one row; the box keeps its place when a drawn chunk turns out taller.
          style={{ height: heights[c] * (wrap ? 1.3 : 1) }}
          ref={watch}
        />,
      );
  }
  const click = (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-gap]');
    if (b && onGap) onGap(Number(b.dataset.gap));
  };
  const sized = !wrap && widest.length > 0 && rows.length > 2 * CHUNK;
  return (
    <div className={`dl ${sides === 1 ? 'is-file' : ''} ${sized ? 'is-sized' : ''}`} style={style} onClick={onGap ? click : undefined}>
      {sized && (
        <div className="dl-sizer" aria-hidden dangerouslySetInnerHTML={{ __html: widest.map((i) => rowHtml(rows[i], sides, i, false, gap, false)).join('') }} />
      )}
      {out}
    </div>
  );
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A wrapped line goes on under its own indent and two columns in, as editors wrap it, not from the left edge. */
const WRAP_AT = 32;
function hang(text: string): string {
  if (text.length < WRAP_AT) return '';
  let n = 0;
  for (const ch of text) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4 - (n % 4);
    else break;
  }
  return ` style="--hang:${Math.min(n, 24) + 2}ch"`;
}

/** One row as markup: a chunk is written in one go, which costs a fraction of a component for each row. */
function rowHtml(r: CodeRow, sides: 1 | 2, index: number, open: boolean, gap: (n: number) => string, wrap: boolean): string {
  if (r.k === 'note') return `<div class="dl-gap is-note"><span>${esc(r.text)}</span></div>`;
  if (r.k === 'gap') {
    const label = esc(gap(r.count));
    // A view that can open a run says so with `onGap`: it has the lines already or asks for them.
    return open
      ? `<div class="dl-gap"><button type="button" class="dl-gap-open" data-gap="${index}">${label}</button></div>`
      : `<div class="dl-gap"><span>${label}</span></div>`;
  }
  const o = sides === 2 ? `<span class="dl-n" data-n="${r.o ?? ''}"></span>` : '';
  return `<div class="dl-row is-${r.k}${r.mark ? ' is-mark' : ''}">${o}<span class="dl-n" data-n="${r.n ?? ''}"></span><code${wrap ? hang(r.text) : ''}>${r.html || ' '}</code></div>`;
}

const Chunk = memo(function Chunk({ rows, from, to, sides, open, gap, wrap }: { rows: CodeRow[]; from: number; to: number; sides: 1 | 2; open: boolean; gap: (n: number) => string; wrap: boolean }) {
  let html = '';
  for (let i = from; i < to; i++) html += rowHtml(rows[i], sides, i, open, gap, wrap);
  return <div className="dl-chunk" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Rows with one opened gap put back in place. */
export function openGap(rows: CodeRow[], index: number): CodeRow[] {
  const g = rows[index];
  if (g?.k !== 'gap' || !g.rows) return rows;
  return [...rows.slice(0, index), ...g.rows, ...rows.slice(index + 1)];
}
