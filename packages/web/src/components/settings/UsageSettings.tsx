import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { count, fill, resolveLang, useT } from '../../lib/i18n';
import { actions, setUi, useStore } from '../../lib/store';
import { folderName } from '../../lib/format';
import {
  add,
  bucketKeys,
  cachedShare,
  columnsBefore,
  columnsOf,
  dayKey,
  dayOf,
  folderKey,
  modelKey,
  partsBy,
  previousDays,
  rangeDays,
  rowsIn,
  SERIES,
  sessionParts,
  slotsOf,
  speedColumns,
  speedOf,
  totalOf,
  unitFor,
  waitOf,
  zero,
  type Column,
  type Metric,
  type Part,
  type Range,
  type Sums,
  type TokenStats,
  type Unit,
} from '../../lib/usage';
import { CircleNotch } from '../icons';
import { Select } from '../ui/Select';
import { LoadError, Page, Segmented, sep } from './Rows';
import { UsageChart, type Series } from './UsageChart';

type Split = 'model' | 'kind';

/** What was chosen last in this window: the page opens on it again. */
let lastRange: Range = '30';
let lastSplit: Split = 'model';
let lastMetric: Metric = 'tokens';

/** How many folders, and sessions, get a line of their own; the rest are summed in one. */
const FOLDERS = 8;
const SESSIONS = 8;

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
};

const slot = (i: number) => (i < SERIES ? `var(--chart-${i + 1})` : 'var(--chart-other)');

/** Figures in the language of the page: short ones for the eye, full ones where the reader asked for them. */
function formats(lang: string) {
  // Three figures say a big number well enough at a glance (3920万, 39.2M); a count under ten thousand stays whole.
  const short = new Intl.NumberFormat(lang, { notation: 'compact', maximumSignificantDigits: 3 });
  const full = new Intl.NumberFormat(lang);
  const pct = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 });
  const usd = new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    short: (n: number) => (Math.abs(n) < 10_000 ? full.format(n) : short.format(n)),
    full: (n: number) => full.format(n),
    pct: (n: number) => (n > 0 && n < 0.005 ? `<${pct.format(0.01)}` : pct.format(n)),
    times: (n: number) => new Intl.NumberFormat(lang, { maximumFractionDigits: n < 10 ? 1 : 0 }).format(n),
    cost: (n: number) => (n > 0 && n < 0.005 ? `<${usd.format(0.01)}` : usd.format(n)),
    /** A cost on the axis: whole dollars when the steps are, cents when they are not. */
    costTick: (n: number, top: number) => {
      const digits = top >= 4 ? 0 : top >= 0.04 ? 2 : 3;
      return new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: n === 0 ? 0 : digits, maximumFractionDigits: digits }).format(n);
    },
    speed: (n: number) => new Intl.NumberFormat(lang, { maximumFractionDigits: n < 10 ? 1 : 0 }).format(n),
    seconds: (ms: number) => new Intl.NumberFormat(lang, { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: ms < 10_000 ? 1 : 0 }).format(ms / 1000),
  };
}

/** One figure read at a glance: what it is, the number, and one line on it. */
function Figure({ label, value, full, note }: { label: string; value: string; full?: string; note?: string }) {
  return (
    <div className="usage-figure">
      <span className="usage-figure-label">{label}</span>
      <span className="usage-figure-value" data-tip={full}>
        {value}
      </span>
      {note && <span className="usage-figure-note">{note}</span>}
    </div>
  );
}

/** A swatch for a model, a layer of the chart, a line of a table: the colour says which, the words beside it say it too. */
const Swatch = ({ color }: { color: string }) => <span className="usage-swatch" style={{ background: color }} aria-hidden="true" />;

/**
 * Settings > Usage: the tokens every request took, by day, model and folder, from the log the server keeps (numbers
 * only) and before it began, from the replies kept in sessions.
 */
export function UsageSettings() {
  const t = useT();
  const lang = useStore((s) => resolveLang(s.info?.config.language));
  const providers = useStore((s) => s.providers);
  const [stats, setStats] = useState<TokenStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>(lastRange);
  const [split, setSplit] = useState<Split>(lastSplit);
  const [metric, setMetric] = useState<Metric>(lastMetric);
  const [folder, setFolder] = useState('');
  const [table, setTable] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const tz = zone();
    api<TokenStats>(`/usage?from=0${tz ? `&tz=${encodeURIComponent(tz)}` : ''}`)
      .then(setStats)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  const f = useMemo(() => formats(lang), [lang]);
  const all = useMemo(() => stats?.rows ?? [], [stats]);
  const slots = useMemo(() => slotsOf(all), [all]);
  const folders = useMemo(() => partsBy(all, (r) => folderKey(r.cwd), (r) => folderName(r.cwd), (r) => r.cwd), [all]);
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  const today = dayKey(new Date());
  const scoped = folder ? all.filter((r) => folderKey(r.cwd) === folder) : all;
  const { from, to } = rangeDays(range, today, scoped[0]?.day ?? null);
  const shown = rowsIn(scoped, from, to);
  const sums = shown.reduce<Sums>(add, zero());
  const before = previousDays(range, today);
  const earlier = before ? rowsIn(scoped, before.from, before.to).reduce<Sums>(add, zero()) : null;
  const unit: Unit = unitFor(from, to);
  const priced = all.some((r) => r.cost > 0);
  const timed = all.some((r) => (r.timed ?? 0) > 0);
  // Cost is there to choose when some model has a price, speed when some reply was timed.
  const measure: Metric = (metric === 'cost' && priced) || (metric === 'speed' && timed) ? metric : 'tokens';
  const byModel = split === 'model' || measure !== 'tokens';
  const keys = bucketKeys(from, to, unit);
  const columns = measure === 'speed' ? speedColumns(shown, keys, unit, slots) : columnsOf(shown, keys, unit, split, slots, measure);
  // Speeds are known from the first timed reply on: the line starts there, not at the far end of an empty range.
  const plotted = measure === 'speed' ? columns.slice(Math.max(0, columns.findIndex((c) => c.values.some(Number.isFinite)))) : columns;
  const models = partsBy(shown, modelKey, (r) => r.model, (r) => r.provider);
  const places = partsBy(shown, (r) => folderKey(r.cwd), (r) => folderName(r.cwd), (r) => r.cwd);
  const total = totalOf(sums);
  const logDay = stats?.since ? dayKey(new Date(stats.since)) : null;
  // Columns from before the log hold only the replies kept in sessions: no side requests, no session since removed.
  const early = logDay && measure !== 'speed' ? columnsBefore(keys, to, logDay) : 0;
  const earlyKeys = new Set(keys.slice(0, early));
  const unpriced = new Set(stats?.unpriced ?? []);
  const unknown = models.filter((m) => unpriced.has(m.key));
  const sessions = stats?.sessions ? sessionParts(rowsIn(folder ? stats.sessions.filter((r) => folderKey(r.cwd) === folder) : stats.sessions, from, to)) : null;
  const titles = stats?.titles ?? {};

  // A model's name, with its provider when two providers serve a model of the same name.
  const named = new Map<string, number>();
  for (const k of slots.keys()) named.set(k.slice(k.indexOf('/') + 1), (named.get(k.slice(k.indexOf('/') + 1)) ?? 0) + 1);
  const modelLabel = (p: Pick<Part, 'label' | 'detail'>) => ((named.get(p.label) ?? 0) > 1 ? `${p.label} · ${providerName(p.detail)}` : p.label);
  const bySlot = new Map([...slots].map(([k, i]) => [i, k]));
  const series: Series[] =
    byModel
      ? [...Array(SERIES + 1).keys()]
          .filter((i) => columns.some((c) => c.values[i] > 0))
          .map((i) => {
            const k = bySlot.get(i);
            const m = k ? { label: k.slice(k.indexOf('/') + 1), detail: k.slice(0, k.indexOf('/')) } : null;
            return { index: i, label: m ? modelLabel(m) : t('Other models'), color: slot(i) };
          })
      : [
          { index: 0, label: t('New input'), color: slot(0) },
          { index: 1, label: t('Cache read'), color: slot(1) },
          { index: 2, label: t('Cache write'), color: slot(2) },
          { index: 3, label: t('Output'), color: slot(3) },
        ].filter((s) => columns.some((c) => c.values[s.index] > 0));

  const date = (key: string, long = false) => {
    const d = dayOf(key);
    if (unit === 'month') return new Intl.DateTimeFormat(lang, long ? { year: 'numeric', month: 'long' } : { month: 'short', ...(d.getMonth() === 0 ? { year: '2-digit' } : {}) }).format(d);
    const day = new Intl.DateTimeFormat(lang, long ? { month: 'long', day: 'numeric', ...(unit === 'day' ? { weekday: 'short' } : {}) } : { month: 'numeric', day: 'numeric' }).format(d);
    return long && unit === 'week' ? fill(t('Week of {n}'), day) : day;
  };
  const value = (v: number) => (measure === 'cost' ? f.cost(v) : measure === 'speed' ? fill(t('{n} tok/s'), f.speed(v)) : f.full(v));
  const waited = (s: Sums) => waitOf(s);
  const tip = (c: Column) => {
    const wait = waited(c.sums);
    return (
      <>
        <span className="usage-tip-head">{date(c.key, true)}</span>
        {earlyKeys.has(c.key) && <span className="usage-tip-note">{t('Before the log: replies kept in sessions')}</span>}
        {series
          .filter((s) => c.values[s.index] > 0)
          .map((s) => (
            <span key={s.index} className="usage-tip-row">
              <i className="usage-tip-key" style={{ background: s.color }} />
              <span className="usage-tip-name">{s.label}</span>
              <b className="num">{value(c.values[s.index])}</b>
            </span>
          ))}
        {measure === 'speed' ? (
          wait !== null && (
            <span className="usage-tip-row is-total">
              <span className="usage-tip-name">{t('Wait for the first word')}</span>
              <b className="num">{f.seconds(wait)}</b>
            </span>
          )
        ) : (
          <span className="usage-tip-row is-total">
            <span className="usage-tip-name">{count(t, c.sums.requests, '{n} request', '{n} requests')}</span>
            <b className="num">{measure === 'cost' ? f.cost(c.sums.cost) : f.full(totalOf(c.sums))}</b>
          </span>
        )}
      </>
    );
  };

  // Said only when the period before is all in the log: one half from the log and the other from sessions do not compare.
  const comparable = before !== null && (logDay === null || logDay <= before.from);
  const change = comparable && earlier && totalOf(earlier) > 0 ? total / totalOf(earlier) - 1 : null;
  const cached = cachedShare(sums);
  const pick = (r: Range) => {
    lastRange = r;
    setRange(r);
  };
  const pickSplit = (s: Split) => {
    lastSplit = s;
    setSplit(s);
  };
  const pickMetric = (m: Metric) => {
    lastMetric = m;
    setMetric(m);
  };
  const title =
    measure === 'cost'
      ? unit === 'day'
        ? t('Cost by day')
        : unit === 'week'
          ? t('Cost by week')
          : t('Cost by month')
      : measure === 'speed'
        ? unit === 'day'
          ? t('Output speed by day, in tokens a second')
          : unit === 'week'
            ? t('Output speed by week, in tokens a second')
            : t('Output speed by month, in tokens a second')
        : unit === 'day'
          ? t('Tokens by day')
          : unit === 'week'
            ? t('Tokens by week')
            : t('Tokens by month');
  const top = Math.max(0, ...columns.map((c) => (measure === 'speed' ? Math.max(0, ...c.values.filter(Number.isFinite)) : c.values.reduce((s, v) => s + v, 0))));
  const tick = (v: number) => (measure === 'cost' ? f.costTick(v, top) : f.short(v));
  const costCell = (key: string, n: number) =>
    unpriced.has(key) ? (
      <span className="usage-unknown" data-tip={t('No price known')}>
        —
      </span>
    ) : (
      f.cost(n)
    );
  const speedCell = (s: Sums) => {
    const v = speedOf(s);
    const w = waitOf(s);
    return v === null ? '' : <span data-tip={w === null ? undefined : fill(t('First word after {n} on average'), f.seconds(w))}>{f.speed(v)}</span>;
  };
  const open = (id: string) => {
    setUi({ settings: false });
    void actions.open(id);
  };
  const since = stats?.since ? new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long', day: 'numeric' }).format(stats.since) : null;
  const rest = places.slice(FOLDERS);
  const restSums = rest.reduce<Sums>((s, p) => add(s, p.sums), zero());
  const share = (s: Sums) => (total > 0 ? f.pct(totalOf(s) / total) : '');
  const days = columns.filter((c) => c.sums.requests > 0).reverse();
  const topSessions = sessions?.slice(0, SESSIONS) ?? [];
  const otherSessions = sessions?.slice(SESSIONS) ?? [];
  const otherSums = otherSessions.reduce((s, p) => ({ requests: s.requests + p.requests, total: s.total + p.total, cost: s.cost + p.cost }), { requests: 0, total: 0, cost: 0 });
  const sessionShare = (n: number) => (total > 0 ? f.pct(n / total) : '');

  if (!stats)
    return (
      <Page title={t('Usage')} lede={t('Tokens and requests counted on this computer, by day, model and folder. Only the numbers are kept, never what was said.')}>
        {error ? (
          <LoadError error={error} retry={load} />
        ) : (
          <p className="set-state" role="status">
            <CircleNotch size={14} className="spin" /> {t('Counting…')}
          </p>
        )}
      </Page>
    );

  const foot = (
    <p className="set-note usage-foot">
      {since && fill(t('Every request since {n} is counted here, compaction and titles included. Earlier figures come from the replies kept in sessions and leave those out.'), since)}
      {since && sep(t('Every request since {n} is counted here, compaction and titles included. Earlier figures come from the replies kept in sessions and leave those out.'))}
      {priced && `${t('Costs are estimated from each model’s price list. The provider’s bill is what counts.')}${sep(t('Costs are estimated from each model’s price list. The provider’s bill is what counts.'))}`}
      <button type="button" className="link" onClick={load} disabled={loading}>
        {t('Count again')}
      </button>
    </p>
  );

  if (all.length === 0)
    return (
      <Page title={t('Usage')} lede={t('Tokens and requests counted on this computer, by day, model and folder. Only the numbers are kept, never what was said.')}>
        <p className="usage-none">
          {t('Nothing counted yet. Once a session sends its first request, its tokens show here.')}
          {sep(t('Nothing counted yet. Once a session sends its first request, its tokens show here.'))}
          <button type="button" className="link" onClick={load} disabled={loading}>
            {t('Count again')}
          </button>
        </p>
      </Page>
    );

  return (
    <Page title={t('Usage')} lede={t('Tokens and requests counted on this computer, by day, model and folder. Only the numbers are kept, never what was said.')}>
      <div className={`usage ${loading ? 'is-loading' : ''}`} aria-busy={loading}>
        <div className="usage-bar" data-setting="usage">
          <Segmented<Range>
            label={t('Range')}
            value={range}
            onChange={pick}
            options={[
              ['7', fill(t('{n} days'), 7)],
              ['30', fill(t('{n} days'), 30)],
              ['90', fill(t('{n} days'), 90)],
              ['all', t('All time')],
            ]}
          />
          {folders.length > 1 && (
            <Select
              className="is-field usage-folder"
              value={folder}
              onChange={setFolder}
              tip={t('Folder')}
              options={[{ value: '', label: t('All folders') }, ...folders.map((p) => ({ value: p.key, label: p.label, hint: p.detail }))]}
            />
          )}
        </div>

        <div className="usage-figures">
          <Figure
            label={t('Tokens')}
            value={f.short(total)}
            full={f.full(total)}
            note={change === null ? undefined : change >= 1 ? fill(t('{n} times the period before'), f.times(change + 1)) : fill(t(change >= 0 ? '{n} more than the period before' : '{n} less than the period before'), f.pct(Math.abs(change)))}
          />
          <Figure label={t('Input')} value={f.short(sums.input)} full={f.full(sums.input)} note={cached === null ? undefined : fill(t('{n} read from a cache'), f.pct(cached))} />
          <Figure label={t('Output')} value={f.short(sums.output)} full={f.full(sums.output)} note={sums.reasoning > 0 ? fill(t('{n} of it reasoning'), f.short(sums.reasoning)) : undefined} />
          <Figure label={t('Requests')} value={f.short(sums.requests)} full={f.full(sums.requests)} note={sums.side > 0 ? fill(t('{n} side requests'), f.full(sums.side)) : undefined} />
          {priced && (
            <Figure
              label={t('Estimated cost')}
              value={f.cost(sums.cost)}
              note={unknown.length ? count(t, unknown.length, 'Leaves out {n} model with no known price', 'Leaves out {n} models with no known price') : undefined}
            />
          )}
        </div>
        {!!sums.unreported && <p className="set-note usage-unreported">{fill(t('{n} requests went to a provider that does not report tokens: they count as requests, their tokens are not known.'), f.full(sums.unreported))}</p>}

        <section className="set-group usage-plot">
          <div className="usage-plot-head">
            <h3>{title}</h3>
            <div className="usage-plot-tools">
              {measure === 'tokens' && (
                <Segmented<Split>
                  label={t('Split by')}
                  value={split}
                  onChange={pickSplit}
                  options={[
                    ['model', t('By model')],
                    ['kind', t('By kind')],
                  ]}
                />
              )}
              {(priced || timed) && (
                <Segmented<Metric>
                  label={t('Show')}
                  value={measure}
                  onChange={pickMetric}
                  options={[['tokens', t('Tokens')], ...(priced ? [['cost', t('Cost')] as [Metric, string]] : []), ...(timed ? [['speed', t('Speed')] as [Metric, string]] : [])]}
                />
              )}
            </div>
          </div>
          {(series.length > 0 || early > 0) && (
            <ul className="usage-legend">
              {series.map((s) => (
                <li key={s.index}>
                  <Swatch color={s.color} />
                  {s.label}
                </li>
              ))}
              {early > 0 && (
                <li>
                  <span className="usage-swatch is-early" aria-hidden="true" />
                  {t('Before the log: replies kept in sessions')}
                </li>
              )}
            </ul>
          )}
          <UsageChart
            columns={plotted}
            series={series}
            label={title}
            tick={tick}
            tip={tip}
            dateOf={(k) => date(k)}
            empty={measure === 'speed' ? t('No reply in this range was timed.') : t('No usage in this range.')}
            early={early}
            form={measure === 'speed' ? 'lines' : 'bars'}
          />
          <button type="button" className="link usage-table-toggle" aria-expanded={table} onClick={() => setTable(!table)}>
            {table ? t('Hide the table') : t('Show as a table')}
          </button>
          {table && (
            <div className="usage-scroll">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{t('Date')}</th>
                    <th className="num">{t('Requests')}</th>
                    <th className="num usage-wide">{t('Input')}</th>
                    <th className="num usage-wide">{t('Cache read')}</th>
                    <th className="num usage-wide">{t('Output')}</th>
                    <th className="num">{t('Total')}</th>
                    {priced && <th className="num">{t('Cost')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {days.map((c) => (
                    <tr key={c.key}>
                      <td>{date(c.key, true)}</td>
                      <td className="num">{f.full(c.sums.requests)}</td>
                      <td className="num usage-wide">{f.full(c.sums.input)}</td>
                      <td className="num usage-wide">{f.full(c.sums.cacheRead)}</td>
                      <td className="num usage-wide">{f.full(c.sums.output)}</td>
                      <td className="num">{f.full(totalOf(c.sums))}</td>
                      {priced && <td className="num">{f.cost(c.sums.cost)}</td>}
                    </tr>
                  ))}
                  {days.length === 0 && (
                    <tr>
                      <td colSpan={priced ? 7 : 6} className="usage-table-none">
                        {t('No usage in this range.')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {models.length > 0 && (
          <section className="set-group">
            <div className="set-group-head">
              <h3>{t('Models')}</h3>
            </div>
            <div className="usage-share" aria-hidden="true">
              {models.map((m) => {
                const i = slots.get(m.key) ?? SERIES;
                return totalOf(m.sums) > 0 && <span key={m.key} style={{ flexGrow: totalOf(m.sums), background: slot(i) }} />;
              })}
            </div>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>{t('Model')}</th>
                  <th className="num usage-wide">{t('Requests')}</th>
                  <th className="num usage-wide">{t('Input')}</th>
                  <th className="num usage-wide">{t('Cache hit')}</th>
                  <th className="num usage-wide">{t('Output')}</th>
                  <th className="num">{t('Total')}</th>
                  <th className="num">{t('Share')}</th>
                  {timed && <th className="num usage-wide">{t('tok/s')}</th>}
                  {priced && <th className="num">{t('Cost')}</th>}
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const hit = cachedShare(m.sums);
                  return (
                    <tr key={m.key}>
                      <td>
                        <span className="usage-name">
                          <Swatch color={slot(slots.get(m.key) ?? SERIES)} />
                          <span className="usage-name-text">
                            <span className="usage-name-main">{m.label}</span>
                            <span className="usage-name-detail">{providerName(m.detail)}</span>
                          </span>
                        </span>
                      </td>
                      <td className="num usage-wide">{f.full(m.sums.requests)}</td>
                      <td className="num usage-wide" data-tip={f.full(m.sums.input)}>
                        {f.short(m.sums.input)}
                      </td>
                      <td className="num usage-wide">{hit === null ? '' : f.pct(hit)}</td>
                      <td className="num usage-wide" data-tip={f.full(m.sums.output)}>
                        {f.short(m.sums.output)}
                      </td>
                      <td className="num" data-tip={f.full(totalOf(m.sums))}>
                        {f.short(totalOf(m.sums))}
                      </td>
                      <td className="num">{share(m.sums)}</td>
                      {timed && <td className="num usage-wide">{speedCell(m.sums)}</td>}
                      {priced && <td className="num">{costCell(m.key, m.sums.cost)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        {places.length > 1 && (
          <section className="set-group">
            <div className="set-group-head">
              <h3>{t('Folders')}</h3>
            </div>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>{t('Folder')}</th>
                  <th className="num usage-wide">{t('Requests')}</th>
                  <th className="num">{t('Total')}</th>
                  <th className="num">{t('Share')}</th>
                  {priced && <th className="num">{t('Cost')}</th>}
                </tr>
              </thead>
              <tbody>
                {places.slice(0, FOLDERS).map((p) => (
                  <tr key={p.key}>
                    <td>
                      <span className="usage-name-text">
                        <span className="usage-name-main">{p.label}</span>
                        <span className="usage-name-detail mono" data-tip={p.detail}>
                          <bdi>{p.detail}</bdi>
                        </span>
                      </span>
                    </td>
                    <td className="num usage-wide">{f.full(p.sums.requests)}</td>
                    <td className="num" data-tip={f.full(totalOf(p.sums))}>
                      {f.short(totalOf(p.sums))}
                    </td>
                    <td className="num">{share(p.sums)}</td>
                    {priced && <td className="num">{f.cost(p.sums.cost)}</td>}
                  </tr>
                ))}
                {rest.length > 0 && (
                  <tr className="usage-rest">
                    <td>{fill(t('{n} other folders'), rest.length)}</td>
                    <td className="num usage-wide">{f.full(restSums.requests)}</td>
                    <td className="num">{f.short(totalOf(restSums))}</td>
                    <td className="num">{share(restSums)}</td>
                    {priced && <td className="num">{f.cost(restSums.cost)}</td>}
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        )}

        {sessions && sessions.length > 0 && (
          <section className="set-group">
            <div className="set-group-head">
              <h3>{t('Sessions')}</h3>
            </div>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>{t('Session')}</th>
                  <th className="num usage-wide">{t('Requests')}</th>
                  <th className="num">{t('Total')}</th>
                  <th className="num usage-wide">{t('Share')}</th>
                  {priced && <th className="num">{t('Cost')}</th>}
                </tr>
              </thead>
              <tbody>
                {topSessions.map((p) => {
                  const name = titles[p.session];
                  return (
                    <tr key={p.session}>
                      <td>
                        <span className="usage-name-text">
                          {name ? (
                            <button type="button" className="usage-name-main usage-open" onClick={() => open(p.session)}>
                              {name}
                            </button>
                          ) : (
                            <span className="usage-name-main is-gone">{t('A removed session')}</span>
                          )}
                          <span className="usage-name-detail">{folderName(p.cwd)}</span>
                        </span>
                      </td>
                      <td className="num usage-wide">{f.full(p.requests)}</td>
                      <td className="num" data-tip={f.full(p.total)}>
                        {f.short(p.total)}
                      </td>
                      <td className="num usage-wide">{sessionShare(p.total)}</td>
                      {priced && <td className="num">{f.cost(p.cost)}</td>}
                    </tr>
                  );
                })}
                {otherSessions.length > 0 && (
                  <tr className="usage-rest">
                    <td>{fill(t('{n} other sessions'), otherSessions.length)}</td>
                    <td className="num usage-wide">{f.full(otherSums.requests)}</td>
                    <td className="num">{f.short(otherSums.total)}</td>
                    <td className="num usage-wide">{sessionShare(otherSums.total)}</td>
                    {priced && <td className="num">{f.cost(otherSums.cost)}</td>}
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        )}

        {foot}
      </div>
    </Page>
  );
}
