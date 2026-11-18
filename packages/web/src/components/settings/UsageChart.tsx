import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useT } from '../../lib/i18n';
import { ticksFor, type Column } from '../../lib/usage';

/** One layer of the stacked columns: where its figure sits in a column's values, its name and its colour. */
export interface Series {
  index: number;
  label: string;
  color: string;
}

/** The height of the plot, the room above it for the top tick and under it for the dates. */
const PLOT = 196;
const TOP = 10;
const BOTTOM = 26;
/** The surface left between two layers of a column and between two columns. */
const GAP = 2;
/** The widest a column gets, however few there are. */
const WIDEST = 18;

/** A layer of a column: square, as the track it stands in. */
function bar(x: number, y: number, w: number, h: number): string {
  return `M${x},${y}h${w}v${h}h${-w}z`;
}

/**
 * Tokens per day (or week, or month) as stacked columns on one axis, every column read on hover, touch or with the
 * arrow keys. The figures behind it are in the table the page shows on request.
 */
export function UsageChart({
  columns,
  series,
  label,
  tick,
  tip,
  dateOf,
  empty,
  early = 0,
  form = 'bars',
}: {
  columns: Column[];
  series: Series[];
  /** What the chart shows, for a screen reader. */
  label: string;
  /** A figure on the axis, short. */
  tick: (n: number) => string;
  /** What the tooltip says of a column. */
  tip: (c: Column) => ReactNode;
  /** A column's date under the axis, short. */
  dateOf: (key: string) => string;
  empty: string;
  /** How many columns at the start come from before the log began: hatched, as figures that leave some requests out. */
  early?: number;
  /** Stacked columns for what adds up, a line per series for what does not (a speed); NaN is a gap in a line. */
  form?: 'bars' | 'lines';
}) {
  const t = useT();
  const hatch = `usage-hatch-${useId().replace(/:/g, '')}`;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(Math.floor(el.clientWidth));
    const seen = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const n = columns.length;
  const lines = form === 'lines';
  const finite = (v: number) => Number.isFinite(v);
  const totals = columns.map((c) => (lines ? Math.max(0, ...series.map((x) => c.values[x.index]).filter(finite)) : series.reduce((s, x) => s + c.values[x.index], 0)));
  const max = Math.max(0, ...totals);
  const ticks = ticksFor(max);
  const top = ticks[ticks.length - 1] || 1;
  // The axis takes as much room as its longest figure.
  const left = Math.max(...ticks.map((v) => tick(v).length)) * 7 + 12;
  const plotW = Math.max(0, width - left);
  const band = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(WIDEST, band - Math.max(GAP, band * 0.42)));
  const y = (v: number) => TOP + PLOT - (v / top) * PLOT;
  const height = TOP + PLOT + BOTTOM;
  // Dates far enough apart to read, counted back from the last column so today always has one.
  const dateW = Math.max(...columns.slice(-3).map((c) => dateOf(c.key).length), 4) * 7 + 14;
  const every = band ? Math.max(1, Math.ceil(dateW / band)) : 1;
  const at = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const i = Math.floor((clientX - r.left - left) / band);
    return i >= 0 && i < n ? i : null;
  };
  const point = (e: PointerEvent) => band && setActive(at(e.clientX));
  const key = (e: KeyboardEvent) => {
    const next = e.key === 'ArrowRight' ? (active ?? n - 2) + 1 : e.key === 'ArrowLeft' ? (active ?? n) - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (e.key === 'Escape') setActive(null);
    if (next === null) return;
    e.preventDefault();
    setActive(Math.min(n - 1, Math.max(0, next)));
  };
  const cx = active === null ? 0 : left + (active + 0.5) * band;
  return (
    <div
      ref={box}
      className="usage-chart"
      tabIndex={0}
      role="group"
      aria-label={`${label}. ${t('Use the arrow keys to read each column.')}`}
      onKeyDown={key}
      onBlur={() => setActive(null)}
      onPointerMove={point}
      onPointerDown={point}
      // A finger lifts before the reader has read the tooltip: it stays until the next touch.
      onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true">
          {early > 0 && (
            <>
              <defs>
                <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line className="usage-early-line" x1="0" y1="0" x2="0" y2="6" />
                </pattern>
              </defs>
              <rect x={left} y={TOP} width={Math.min(early, n) * band} height={PLOT} fill={`url(#${hatch})`} />
              {early < n && <line className="usage-early-edge" x1={Math.round(left + early * band) + 0.5} x2={Math.round(left + early * band) + 0.5} y1={TOP} y2={TOP + PLOT} />}
            </>
          )}
          {active !== null && <rect className="usage-hover" x={left + active * band} y={TOP} width={band} height={PLOT} />}
          {ticks.map((v, i) => (
            <g key={v}>
              <line className={i === 0 ? 'usage-base' : 'usage-grid'} x1={left} x2={width} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
              <text className="usage-axis" x={left - 8} y={y(v) + 4} textAnchor="end">
                {tick(v)}
              </text>
            </g>
          ))}
          {lines &&
            series.map((s) => {
              const xy = (i: number) => `${(left + (i + 0.5) * band).toFixed(1)},${y(columns[i].values[s.index]).toFixed(1)}`;
              // A run of days with a speed is one stroke, a day alone between gaps a dot, or it would not show; days
              // with none are bridged by a dashed line, so the trend reads on and the gap still shows.
              let d = '';
              let bridge = '';
              let last = -1;
              const alone: number[] = [];
              columns.forEach((c, i) => {
                if (!finite(c.values[s.index])) return;
                const prev = i > 0 && finite(columns[i - 1].values[s.index]);
                const next = i + 1 < n && finite(columns[i + 1].values[s.index]);
                if (!prev && !next) alone.push(i);
                if (last >= 0 && !prev) bridge += `M${xy(last)}L${xy(i)}`;
                d += `${prev ? 'L' : 'M'}${xy(i)}`;
                last = i;
              });
              return (
                <g key={s.index}>
                  {bridge && <path className="usage-line is-gap" d={bridge} style={{ stroke: s.color }} />}
                  <path className="usage-line" d={d} style={{ stroke: s.color }} />
                  {alone.map((i) => (
                    <circle key={i} className="usage-dot" cx={left + (i + 0.5) * band} cy={y(columns[i].values[s.index])} r={3} style={{ fill: s.color }} />
                  ))}
                </g>
              );
            })}
          {lines &&
            active !== null &&
            series
              .filter((s) => finite(columns[active].values[s.index]))
              .map((s) => <circle key={s.index} className="usage-dot" cx={cx} cy={y(columns[active].values[s.index])} r={4} style={{ fill: s.color }} />)}
          {!lines && columns.map((c, i) => {
            const x = left + i * band + (band - barW) / 2;
            const shown = series.filter((s) => c.values[s.index] > 0);
            let sum = 0;
            // Each column stands in a faint track the plot's height: a day with little or nothing still has its place,
            // and the eye reads a column against the whole.
            return (
              <g key={c.key}>
                <rect className="usage-lane" x={x} y={TOP} width={barW} height={PLOT} />
                {shown.map((s, j) => {
                  const v = c.values[s.index];
                  const lo = y(sum);
                  sum += v;
                  const hi = y(sum);
                  const h = lo - hi - (j > 0 ? GAP : 0);
                  if (h < 0.75) return null;
                  return <path key={s.index} d={bar(x, hi, barW, h)} style={{ fill: s.color }} />;
                })}
              </g>
            );
          })}
          {columns.map((c, i) => {
            if ((n - 1 - i) % every) return null;
            const mid = left + (i + 0.5) * band;
            const half = (dateOf(c.key).length * 7) / 2;
            const anchor = mid + half > width ? 'end' : mid - half < left ? 'start' : 'middle';
            return (
              <text key={c.key} className="usage-axis" x={anchor === 'end' ? width : anchor === 'start' ? left : mid} y={TOP + PLOT + 18} textAnchor={anchor}>
                {dateOf(c.key)}
              </text>
            );
          })}
          {max === 0 && (
            <text className="usage-empty" x={left + plotW / 2} y={TOP + PLOT / 2} textAnchor="middle">
              {empty}
            </text>
          )}
        </svg>
      )}
      {active !== null && totals[active] > 0 && (
        <div className="usage-tip" aria-live="polite" style={cx > width - 230 ? { right: width - cx + 12 } : { left: cx + 12 }}>
          {tip(columns[active])}
        </div>
      )}
    </div>
  );
}
