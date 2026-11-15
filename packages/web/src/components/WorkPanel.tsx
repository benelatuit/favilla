import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { actions, confirmDialog, setUi, settingSaveError, toast, useStore } from '../lib/store';
import { fill, useT } from '../lib/i18n';
import { diffOp, fmtTokens, plainTitle, shortPath } from '../lib/format';
import { resetIn, windowName } from '../lib/plan';
import { absolutePath, desktop } from '../lib/desktop';
import type { ContextReport, SessionUsage, TurnChanges } from '../lib/types';
import { DiffView } from './ToolEntry';
import { Popover, anchorOf, type Anchor } from './ui/Popover';
import { ArrowCounterClockwise, ArrowSquareOut, ArrowsInLineVertical, CaretRight, GitDiff, ListNumbers, X } from './icons';
import { PreviewTab } from './Preview';
import { showBlock } from '../lib/find';
import { userTurns, userWords } from '../lib/messages';
import { turnFace } from '../lib/turns';
import { openViewer } from './ui/Viewer';

/** What the context is made of, in the order the model reads it; each kind drawn as its own hatching. */
const KINDS = [
  { key: 'system', label: 'System prompt' },
  { key: 'tools', label: 'Tool definitions' },
  { key: 'summary', label: 'Summary of earlier work' },
  { key: 'conversation', label: 'Conversation' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'outputs', label: 'Tool output' },
  { key: 'cut', label: 'Trimmed tool output' },
] as const;

/**
 * Context usage as a ruler: ticks every twentieth of the window, where trimming and compaction start, the
 * current reading, and, once the session reports it, the fill drawn as a cross-section of what it holds.
 */
function ContextRuler({ usage, report }: { usage: SessionUsage; report: ContextReport | null }) {
  const t = useT();
  const w = Math.max(1, usage.contextWindow);
  const pct = Math.min(1, usage.contextTokens / w);
  const compact = Math.min(1, usage.compactAt / w);
  const trim = report ? Math.min(1, report.pruneAt / w) : 0;
  // The report is a moment behind the live reading: scale its parts to the reading so the two agree.
  const total = report ? KINDS.reduce((n, k) => n + report.parts[k.key], 0) : 0;
  const scale = total > 0 ? pct / total : 0;
  // Compaction usually starts near the end of the window, where a label centred on its mark ran into the window
  // size. Measured, so every language and panel width fits: centred when there is room, else ending at its mark
  // when that clears the trim label, else centred with the window size hidden (the reading above gives it).
  const caption = useRef<HTMLElement>(null);
  const [crowded, setCrowded] = useState({ end: false, trim: false, endAligned: false });
  useLayoutEffect(() => {
    const el = caption.current;
    if (!el) return;
    const measure = () => {
      const box = (s: string) => el.querySelector<HTMLElement>(s)?.getBoundingClientRect();
      const [cap, trimBox, compactBox, endBox] = [el.getBoundingClientRect(), box('.ruler-trim-label'), box('.ruler-compact-label'), box('.ruler-end')];
      if (!compactBox || !endBox) return;
      const gap = 6;
      const mark = cap.left + compact * cap.width;
      const w = compactBox.width;
      const clearsTrim = (left: number) => !trimBox || trimBox.right + gap <= left;
      const clearsEnd = (right: number) => right + gap <= endBox.left;
      const next =
        clearsEnd(mark + w / 2) && clearsTrim(mark - w / 2)
          ? { end: false, trim: false, endAligned: false }
          : clearsEnd(mark) && clearsTrim(mark - w)
            ? { end: false, trim: false, endAligned: true }
            : { end: !clearsEnd(mark + w / 2), trim: !clearsTrim(mark - w / 2), endAligned: false };
      setCrowded((c) => (c.end === next.end && c.trim === next.trim && c.endAligned === next.endAligned ? c : next));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [trim, compact, usage.contextWindow, t]);
  return (
    <figure className="ruler" aria-label={`${Math.round(pct * 100)}%`}>
      <div className="ruler-reading">
        <span className="ruler-value num">{fmtTokens(usage.contextTokens)}</span>
        <WindowSize usage={usage} />
        <span className="ruler-pct num">{Math.round(pct * 100)}%</span>
      </div>
      <div className="ruler-scale">
        {report && total > 0 ? (
          <div className="ruler-parts">
            {KINDS.map((k) =>
              report.parts[k.key] > 0 ? <span key={k.key} className={`ctx-part is-${k.key}`} style={{ width: `${report.parts[k.key] * scale * 100}%` }} data-tip={`${t(k.label)} · ${fmtTokens(report.parts[k.key])}`} /> : null,
            )}
          </div>
        ) : (
          <div className="ruler-fill" style={{ transform: `scaleX(${pct})` }} />
        )}
        {Array.from({ length: 21 }, (_, i) => (
          <span key={i} className={`tick ${i % 2 ? 'is-minor' : ''}`} style={{ left: `${i * 5}%` }} />
        ))}
        {trim > 0 && <span className="ruler-trim" style={{ left: `${trim * 100}%` }} />}
        <span className="ruler-compact" style={{ left: `${compact * 100}%` }} />
      </div>
      <figcaption className="ruler-caption num" ref={caption}>
        <span>0</span>
        {trim > 0 && compact - trim > 0.2 && (
          <span className={`ruler-trim-label${crowded.trim ? ' is-crowded' : ''}`} style={{ left: `${trim * 100}%` }}>
            {t('trims here')}
          </span>
        )}
        <span className={`ruler-compact-label${crowded.endAligned ? ' is-end' : ''}`} style={{ left: `${compact * 100}%` }}>
          {t('compacts here')}
        </span>
        <span className={`ruler-end${crowded.end ? ' is-crowded' : ''}`}>{fmtTokens(usage.contextWindow)}</span>
      </figcaption>
    </figure>
  );
}

/** "272k", "1m" or a plain count: the window the way it is typed. */
function typed(n: number): string {
  if (n % 1_000_000 === 0) return `${n / 1_000_000}m`;
  if (n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

/** "200k", "1m", "1.5m", "300000" or "300,000"; at least 4096. */
function parseTokens(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text.trim().toLowerCase().replace(/[\s,_]/g, ''));
  if (!m) return undefined;
  const n = Math.round(Number(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1000 : 1));
  return n >= 4096 && n <= 100_000_000 ? n : undefined;
}

const SIZES = [32_000, 64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000, 2_000_000];

/** Four common sizes nearest the provider's own, and the provider's own. */
function presets(native: number): number[] {
  const near = SIZES.filter((n) => n >= native / 8 && n <= native * 4 && Math.abs(n - native) / native > 0.05);
  near.sort((a, b) => Math.abs(Math.log(a / native)) - Math.abs(Math.log(b / native)));
  return [...near.slice(0, 4), native].sort((a, b) => a - b);
}

const short = (n: number) => fmtTokens(n).replace('.0', '');

/**
 * The window's size in the reading, and the place to change it: a typed size or one of a few around the
 * provider's own. The same setting as Context in Settings > Models, for this session's model; open sessions take it at once.
 */
function WindowSize({ usage }: { usage: SessionUsage }) {
  const t = useT();
  const model = useStore((s) => s.session?.model);
  const windows = useStore((s) => s.info?.config.windows);
  const basis = useStore((s) => s.providers.find((p) => p.id === model?.ref.split('/')[0])?.basis);
  const btn = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [opened, setOpened] = useState<{ basis: typeof basis; window: number }>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const override = model ? windows?.find((w) => w.ref === model.ref)?.contextWindow : undefined;
  const native = model?.nativeWindow ?? model?.contextWindow ?? usage.contextWindow;
  const current = override ?? native;
  const begin = () => { setOpened({ basis, window: current }); setText(typed(current)); setAnchor(anchorOf(btn.current!)); };
  if (!model) return <span className="ruler-of num">/ {fmtTokens(usage.contextWindow)}</span>;
  const wanted = parseTokens(text);
  const save = (n: number) => {
    setBusy(true);
    actions
      .setConfig({ windows: [{ ref: model.ref, contextWindow: n === native ? null : n }] }, opened?.basis)
      .then(() => actions.loadProviders())
      .then(() => setAnchor(null))
      .catch((e) => settingSaveError(e, async () => { await actions.loadSettings(); setAnchor(null); }))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`ruler-of num window-size ${override ? 'is-set' : ''} ${anchor ? 'is-open' : ''}`}
        data-tip={anchor ? undefined : t('Change the window')}
        aria-expanded={!!anchor}
        onClick={() => anchor ? setAnchor(null) : begin()}
      >
        / {fmtTokens(usage.contextWindow)}
      </button>
      {anchor && (
        <Popover anchor={anchor} placement="bottom-start" onClose={() => setAnchor(null)} ignore={btn.current} className="window-pop" label={t('Context window')}>
          <form
            className="window-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (wanted && wanted !== opened?.window) save(wanted);
            }}
          >
            <label className="window-field">
              <span className="window-label">{t('Context window')}</span>
              <span className="window-entry">
                <input autoFocus value={text} spellCheck={false} className={`num ${wanted && wanted > native ? 'is-over' : ''}`} aria-invalid={!wanted} placeholder="200k" onChange={(e) => setText(e.target.value)} />
                <button type="submit" className="btn is-small" disabled={busy || !wanted || wanted === opened?.window}>
                  {t('Apply')}
                </button>
              </span>
            </label>
            <div className="window-sizes" role="group" aria-label={t('Common sizes')}>
              {presets(native).map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`num ${n === current ? 'is-current' : ''} ${n === native ? 'is-native' : ''}`}
                  disabled={busy}
                  data-tip={n === native ? t('What the provider gives') : undefined}
                  onClick={() => (n === current ? setAnchor(null) : save(n))}
                >
                  {short(n)}
                </button>
              ))}
            </div>
            {wanted && wanted > native ? (
              <p className="window-note is-warn">{fill(t('More than the {n} the provider gives: a long conversation may be refused, and Favilla then compacts.'), short(native))}</p>
            ) : (
              override && (
                <p className="window-note">
                  {fill(t('The provider gives {n}.'), short(native))}{' '}
                  <button type="button" className="link" disabled={busy} onClick={() => save(native)}>
                    {t('Restore')}
                  </button>
                </p>
              )
            )}
          </form>
        </Popover>
      )}
    </>
  );
}

function ContextTab() {
  const t = useT();
  const id = useStore((s) => s.session?.meta.id);
  const usage = useStore((s) => s.session?.usage);
  const status = useStore((s) => s.session?.status);
  const busy = status !== 'idle';
  const [report, setReport] = useState<ContextReport | null>(null);
  // Asked again when the reading moves by a few hundred tokens or the session changes state, not on every event.
  const step = usage ? Math.round(usage.contextTokens / 400) : 0;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    api<ContextReport>(`/sessions/${id}/context`, { signal: controller.signal })
      .then((r) => !controller.signal.aborted && setReport(r))
      .catch(() => !controller.signal.aborted && setReport(null));
    return () => controller.abort();
  }, [id, step, status, usage?.contextWindow, usage?.compactAt]);
  if (!usage) return null;
  const hit = usage.totalInput ? Math.round((usage.cacheRead / usage.totalInput) * 100) : 0;
  const rows: [string, string][] = [
    [t('Input tokens'), fmtTokens(usage.totalInput)],
    [t('From cache'), `${fmtTokens(usage.cacheRead)} · ${hit}%`],
    [t('Output tokens'), fmtTokens(usage.totalOutput)],
    [t('Requests'), String(usage.requests)],
  ];
  if (usage.cost) rows.push([t('Cost'), `$${usage.cost.toFixed(usage.cost < 1 ? 4 : 2)}`]);
  return (
    <div className="panel-body">
      <section className="panel-section">
        <h3>{t('Context window')}</h3>
        <ContextRuler usage={usage} report={report} />
        {report && (
          <dl className="ctx-legend">
            {KINDS.map((k) =>
              report.parts[k.key] > 0 ? (
                <div key={k.key}>
                  <dt>
                    <i className={`ctx-swatch ctx-part is-${k.key}`} aria-hidden />
                    {t(k.label)}
                    {k.key === 'outputs' && <span className="muted num"> · {report.outputs}</span>}
                    {k.key === 'cut' && <span className="muted num"> · {report.cut}</span>}
                  </dt>
                  <dd className="num">{fmtTokens(report.parts[k.key])}</dd>
                </div>
              ) : null,
            )}
          </dl>
        )}
        {report && report.compactions > 0 && <p className="field-note">{fill(t('Compacted {n} times in this session; everything said and returned stays on disk, and the model can recall it.'), report.compactions)}</p>}
        <button type="button" className="btn is-small" disabled={busy} onClick={() => actions.compact().catch((e) => toast(String(e), 'error'))}>
          <ArrowsInLineVertical size={14} /> {t('Compact now')}
        </button>
      </section>
      <section className="panel-section">
        <h3>{t('This session')}</h3>
        <dl className="stats">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="num">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      {usage.plan && (usage.plan.windows?.length || usage.plan.credits) ? (
        <section className="panel-section">
          <h3>
            {t('Plan usage')}
            {usage.plan.type && <span className="muted"> · {usage.plan.type}</span>}
          </h3>
          <dl className="stats">
            {usage.plan.windows.map((w) => (
              <div key={w.minutes}>
                <dt>{windowName(w, t)}</dt>
                <dd className="num">
                  {fill(t('{n}% left'), Math.round(Math.max(0, 100 - w.usedPercent)))}
                  {w.resetAt && <span className="muted"> · {resetIn(w.resetAt, t)}</span>}
                </dd>
              </div>
            ))}
            {usage.plan.credits && (
              <div>
                <dt>{t('Credits')}</dt>
                <dd className="num">{usage.plan.credits.unlimited ? t('Unlimited') : Math.floor(usage.plan.credits.balance).toLocaleString()}</dd>
              </div>
            )}
          </dl>
          <p className="field-note">{t('As the server reported with the last answer.')}</p>
        </section>
      ) : null}
    </div>
  );
}

/** Restore points a tape shows before it is asked for the rest. */
const NEWEST = 8;

function ChangesTab({ visible }: { visible: boolean }) {
  const t = useT();
  const id = useStore((s) => s.session?.meta.id);
  const cwd = useStore((s) => s.session?.meta.cwd ?? '');
  const turns = useStore((s) => visible ? (s.session?.turns.length ?? 0) : 0);
  const status = useStore((s) => visible ? s.session?.status : undefined);
  const messages = useStore((s) => visible ? s.session?.messages : undefined);
  const results = useStore((s) => visible ? s.results : undefined);
  const [changes, setChanges] = useState<TurnChanges[] | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  /** Restore points opened to their files. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** All of a long tape, not only its newest points. */
  const [all, setAll] = useState(false);

  useLayoutEffect(() => {
    if (!visible) setChanges(null);
  }, [visible]);

  useEffect(() => {
    if (!visible || !id) return;
    const controller = new AbortController();
    api<TurnChanges[]>(`/sessions/${id}/changes`, { signal: controller.signal })
      .then((c) => !controller.signal.aborted && setChanges(c.filter((x) => x.files.length).reverse()))
      .catch(() => !controller.signal.aborted && setChanges([]));
    return () => controller.abort();
  }, [visible, id, turns, status]);

  if (!visible || !results) return null;

  // A turn the user started is named by what they asked; one that began without them (work picked up after a
  // background job, a queue) says so, never by its id.
  const label = (turn: string) => {
    const m = messages?.find((x) => x.turn === turn && x.origin === 'user');
    return plainTitle(m ? userWords(m).split('\n')[0] : '') || t('Continued on its own');
  };

  const at = (turn: string) => {
    const m = messages?.find((x) => x.turn === turn && x.origin === 'user') ?? messages?.find((x) => x.turn === turn);
    return m ? new Date(m.time).toTimeString().slice(0, 5) : '';
  };
  const undo = async (turn: string) => {
    const ok = await confirmDialog({
      title: t('Go back to before this turn?'),
      body: t('Every file this turn and later turns changed goes back to how it was before this turn, what commands changed or made included.'),
      confirm: t('Go back'),
      cancel: t('Cancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/sessions/${id}/undo`, { body: { turn } });
      setChanges(null);
      await actions.refreshSession();
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  if (changes === null) return <div className="panel-body is-loading" aria-busy="true" />;
  if (!changes.length)
    return (
      <div className="panel-empty">
        <GitDiff size={20} />
        <p>{t('Each turn that changes files leaves a restore point here: the folder can go back to before any of them, what commands changed included.')}</p>
      </div>
    );
  // A tape of restore points, newest first: each turn a point on the line, its time, what it was asked, and what it
  // changed, one line each; the way back on every point, named where the pointer is. A point opens to its files and
  // their diffs. A long tape shows its newest points until asked for the rest.
  const points = all ? changes : changes.slice(0, NEWEST);
  return (
    <div className="panel-body restore-tape">
      {points.map((c, i) => {
        const added = c.files.reduce((n, f) => n + f.added, 0);
        const removed = c.files.reduce((n, f) => n + f.removed, 0);
        const byCommands = c.files.filter((f) => f.via === 'command').length;
        const shown = open.has(c.turn);
        const face = messages ? turnFace(messages, c.turn, results, id ?? undefined) : null;
        return (
          <section key={c.turn} className={`restore-point ${i === 0 ? 'is-latest' : ''} ${shown ? 'is-open' : ''}`}>
            <span className="restore-dot" aria-hidden />
            <header>
              <button type="button" className="restore-head" aria-expanded={shown} onClick={() => setOpen((s) => (s.has(c.turn) ? new Set([...s].filter((x) => x !== c.turn)) : new Set([...s, c.turn])))}>
                <span className="restore-time num">{at(c.turn)}</span>
                <span className="turn-label" data-tip={label(c.turn)}>
                  {label(c.turn)}
                </span>
                <span className="restore-sum">
                  {fill(t(c.files.length > 1 ? '{n} files' : '{n} file'), c.files.length)} <span className="add num">+{added}</span> <span className="del num">−{removed}</span>
                  {byCommands > 0 && (
                    <span className="restore-cmd" data-tip={t('Files changed by commands rather than the edit tools')}>
                      {fill(t('{n} by commands'), byCommands)}
                    </span>
                  )}
                </span>
              </button>
              <button type="button" className="restore-back" data-tip={t('Go back to before this turn')} aria-label={t('Go back to before this turn')} disabled={status !== 'idle'} onClick={() => void undo(c.turn)}>
                <ArrowCounterClockwise size={14} />
                <span>{t('Go back')}</span>
              </button>
            </header>
            {face && (face.picture || face.said) && (
              // What the turn made, at a glance: the picture it showed and the first thing its answer says.
              <div className="restore-face">
                {face.picture && (
                  <button type="button" className="restore-thumb" aria-label={face.picture.name} onClick={(e) => openViewer([{ src: face.picture!.src, name: face.picture!.name }], 0, e.currentTarget)}>
                    <img src={face.picture.src} alt="" loading="lazy" />
                  </button>
                )}
                {face.said && <p className="restore-said">{face.said}</p>}
              </div>
            )}
            {shown && (
          <ul className="changed-files">
            {c.files.map((f) => {
              const key = `${c.turn}:${f.path}`;
              const abs = absolutePath(cwd, f.movedTo ?? f.path);
              const isOpen = openFile === key;
              return (
                <li key={f.path} className={isOpen ? 'is-open' : ''}>
                  <div className="changed-row" data-ctx="file" data-path={abs}>
                    <button type="button" className="changed-open" aria-expanded={isOpen} onClick={() => setOpenFile(isOpen ? null : key)}>
                      <CaretRight size={11} className="step-caret" />
                      <span className={`diff-op is-${f.op}`}>{diffOp(f.op)}</span>
                      {/* The end of a long path says which file it is; all of it is in the tip. */}
                      <span className="mono changed-path" data-tip={f.movedTo ?? f.path}>
                        {shortPath(f.movedTo ?? f.path, 48)}
                      </span>
                      <span className="step-meta num">
                        <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
                      </span>
                    </button>
                    {desktop && f.op !== 'delete' && (
                      <button
                        type="button"
                        className="icon-btn is-small"
                        aria-label={t('Open file')}
                        data-tip={t('Open file')}
                        onClick={() => desktop!.openPath(abs).then((err) => err && toast(err, 'error'))}
                      >
                        <ArrowSquareOut size={14} />
                      </button>
                    )}
                  </div>
                  {isOpen && <DiffView files={[f]} compact bare />}
                </li>
              );
            })}
          </ul>
            )}
          </section>
        );
      })}
      {!all && changes.length > NEWEST && (
        <button type="button" className="restore-more" onClick={() => setAll(true)}>
          {fill(t('Show {n} earlier'), changes.length - NEWEST)}
        </button>
      )}
      <p className="restore-note">{t('What commands change is undone too.')}</p>
    </div>
  );
}

/** The user's message the reader is at: the last one that starts above two fifths of the way down the view. */
function useMessageInView(turnCount: number): string | null {
  const [id, setId] = useState<string | null>(null);
  useLayoutEffect(() => {
    const view = document.querySelector<HTMLElement>('.main .scroll');
    if (!view) return;
    let frame = 0;
    const look = () => {
      frame = 0;
      const box = view.getBoundingClientRect();
      const top = box.top + box.height * 0.4;
      let at: string | null = null;
      for (const el of view.querySelectorAll<HTMLElement>('.timeline > .turn-user[data-find]')) {
        if (el.getBoundingClientRect().top > top) break;
        at = el.dataset.find ?? null;
      }
      // Above the first message drawn (a stretch far back), the first one is where the reader is.
      setId(at ?? view.querySelector<HTMLElement>('.timeline > .turn-user[data-find]')?.dataset.find ?? null);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(look);
    };
    look();
    view.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      view.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [turnCount]);
  return id;
}

/**
 * The outline of a session: every message the user typed, numbered, with its time, and where the conversation was
 * summarized. A click brings that message to the top of the conversation, drawing that part of a long session; the
 * one at the top of the view is marked as the reader scrolls.
 */
function OutlineTab() {
  const t = useT();
  const messages = useStore((s) => s.session?.messages);
  const turns = useMemo(() => userTurns(messages ?? []), [messages]);
  const here = useMessageInView(turns.length);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
  }, [here]);
  if (!turns.length)
    return (
      <div className="panel-empty">
        <ListNumbers size={20} />
        <p>{t('Your messages in this session will be listed here, a click away from each.')}</p>
      </div>
    );
  return (
    <nav className="panel-body outline" aria-label={t('Outline')}>
      <ol className="outline-list" ref={list}>
        {turns.map((m) => (
          <li key={m.id} className={m.after ? 'is-after-summary' : ''}>
            {m.after && (
              <span className="outline-rule" aria-hidden>
                {t('Summarized here')}
              </span>
            )}
            <button
              type="button"
              className="outline-item"
              aria-current={here === m.id ? 'location' : undefined}
              onClick={() => {
                showBlock(m.id);
                // A drawer over the conversation steps aside for it.
                if (!window.matchMedia('(min-width: 1180px)').matches) setUi({ panel: false });
              }}
            >
              <span className="outline-n num">{m.n}</span>
              <span className="outline-text">{plainTitle(m.text.split('\n')[0]) || t('(images only)')}</span>
              <span className="outline-time num">{new Date(m.time).toTimeString().slice(0, 5)}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The tabs by name alone: an icon beside each name said it twice, and four of them did not fit the panel's width. */
const TABS = [
  { id: 'preview', label: 'Preview' },
  { id: 'changes', label: 'Restore points' },
  { id: 'context', label: 'Context' },
  { id: 'outline', label: 'Outline' },
] as const;

export function WorkPanel() {
  const t = useT();
  const open = useStore((s) => s.ui.panel);
  const id = useStore((s) => s.session?.meta.id);
  // A tab saved by an older version (the plan, now in the goal card above the conversation) opens on the changes.
  const saved = useStore((s) => s.ui.panelTab);
  const tab = saved === 'context' || saved === 'outline' || saved === 'preview' ? saved : 'changes';
  // A page is easier to point at wider than the panel: the preview can take half the window.
  const [wide, setWide] = useState(false);
  return (
    <aside className={`workpanel ${tab === 'preview' && wide ? 'is-wide' : ''}`} aria-label={t('Side panel')}>
      <div className="tabs" role="tablist">
        {TABS.map(({ id, label }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setUi({ panelTab: id })}>
            {t(label)}
          </button>
        ))}
        <button type="button" className="icon-btn is-small panel-close" aria-label={t('Close panel')} onClick={() => setUi({ panel: false })}>
          <X size={14} />
        </button>
      </div>
      {tab === 'preview' && <PreviewTab open={open} wide={wide} onWide={setWide} />}
      {tab === 'changes' && <ChangesTab key={id} visible={open} />}
      {open && tab === 'context' && <ContextTab key={id} />}
      {open && tab === 'outline' && <OutlineTab key={id} />}
    </aside>
  );
}
