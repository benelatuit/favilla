import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { setUi, useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { fmtTokens } from '../lib/format';
import type { ModelView } from '../lib/types';
import { CaretDown, CaretRight, Check, Cpu, MagnifyingGlass } from './icons';
import { Popover, anchorOf, type Anchor, type Placement } from './ui/Popover';

export function useModel(ref: string | undefined): ModelView | undefined {
  return useStore((s) => s.providers.flatMap((p) => p.models).find((m) => m.ref === ref));
}

const FOLDED = 'favilla.modelGroups';
const RECENT = 'favilla.recentModels';
/** Past this many models the list opens with only the current model's provider unfolded. */
const LONG = 12;
const FULL_OPTIONS = 48;
const SCROLL_BAND = 320;
const visibleText = /[^ \t\r\n\f]/;
const hasTwoLines = (m: ModelView) => m.name !== m.id && visibleText.test(m.name) && visibleText.test(m.id);
const optionText = (text: string) => text.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ | $/g, '');

/** Find the rows touching the scroll band, with a band on either side for the next scroll. */
function optionWindow(list: HTMLDivElement, options: NodeListOf<HTMLButtonElement>) {
  const firstAfter = (y: number) => {
    let lo = 0, hi = options.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const row = options[mid];
      if (row.offsetTop + row.offsetHeight <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const top = Math.floor(list.scrollTop / SCROLL_BAND) * SCROLL_BAND;
  return { first: firstAfter(top - SCROLL_BAND), last: firstAfter(top + list.clientHeight + 2 * SCROLL_BAND) + 1 };
}

function readList(key: string): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

/** A model the user picked, newest first, for the picker's recent group. */
function rememberModel(ref: string): void {
  if (ref) writeList(RECENT, [ref, ...(readList(RECENT) ?? []).filter((r) => r !== ref)].slice(0, 5));
}

/** Models of every configured provider, searchable, folded by provider, the current one checked. */
export function ModelPicker({ value, onPick, placement = 'top-start', className }: { value: string; onPick: (ref: string) => void; placement?: Placement; className?: string }) {
  const t = useT();
  const providers = useStore((s) => s.providers);
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [folded, setFolded] = useState<Set<string>>(() => new Set(readList(FOLDED) ?? []));
  const current = useModel(value);
  const field = !!className?.split(' ').includes('is-field');
  const [visible, setVisible] = useState({ first: 0, last: 28 });
  const [focused, setFocused] = useState(-1);
  const needle = q.trim().toLowerCase();

  const groups = useMemo(
    () =>
      providers
        .filter((p) => p.configured && p.models.length)
        .map((p) => ({ p, models: p.models.filter((m) => `${m.ref} ${m.name}`.toLowerCase().includes(needle)) }))
        .filter((g) => g.models.length),
    [providers, needle],
  );
  const total = groups.reduce((n, g) => n + g.models.length, 0);
  const searching = !!needle;
  const isFolded = (id: string) => !searching && folded.has(id);
  // The models picked lately, while the list is long enough to need them.
  const recent = useMemo(() => {
    if (searching || total <= 8) return [];
    const all = groups.flatMap((g) => g.models);
    return (readList(RECENT) ?? []).map((ref) => all.find((m) => m.ref === ref)).filter((m): m is ModelView => !!m).slice(0, 4);
    // `anchor`: read again each time the list opens.
  }, [groups, searching, total, anchor]);
  /** What the arrow keys move through: the recent models, then the models of every unfolded provider. */
  const rows = useMemo(() => [...recent, ...groups.flatMap(({ p, models }) => (!searching && folded.has(p.id) ? [] : models))],
    [recent, groups, searching, folded]);
  const windowed = rows.length > FULL_OPTIONS;
  // Keep one actual row of each height so the remaining buttons take up exactly the same space.
  const oneLine = windowed ? rows.findIndex((m) => !hasTwoLines(m)) : -1;
  const twoLines = windowed ? rows.findIndex(hasTwoLines) : -1;
  const optionsOf = (el: HTMLDivElement) => el.querySelectorAll<HTMLButtonElement>('[role="option"]');
  const showWindow = (el: HTMLDivElement, options = optionsOf(el)) => {
    const next = optionWindow(el, options);
    setVisible((old) => old.first === next.first && old.last === next.last ? old : next);
  };

  useLayoutEffect(() => {
    const el = list.current;
    if (!anchor || !el || !windowed) return;
    const options = optionsOf(el);
    if (oneLine >= 0) el.style.setProperty('--model-option-height', getComputedStyle(options[oneLine]).height);
    if (twoLines >= 0) el.style.setProperty('--model-option-hint-height', getComputedStyle(options[twoLines]).height);
    showWindow(el, options);
  }, [anchor, rows, windowed, oneLine, twoLines, field]);

  useEffect(() => {
    if (!anchor) return;
    setQ('');
    // A long list the user never folded opens with only the current model's provider unfolded.
    if (readList(FOLDED) === null && providers.reduce((n, p) => n + (p.configured ? p.models.length : 0), 0) > LONG) setFolded(new Set(providers.filter((p) => !p.models.some((m) => m.ref === value)).map((p) => p.id)));
    requestAnimationFrame(() => input.current?.focus());
  }, [anchor]);
  useEffect(() => setActive(Math.max(0, rows.findIndex((m) => m.ref === value))), [q, anchor]);
  useEffect(() => {
    list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const toggle = (id: string) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
    writeList(FOLDED, [...next]);
  };

  const choose = (m: ModelView) => {
    setAnchor(null);
    rememberModel(m.ref);
    if (m.ref !== value) onPick(m.ref);
  };

  let nextIndex = 0;
  const item = (key: string, m: ModelView) => {
    const i = nextIndex++;
    const hint = m.name !== m.id;
    const tokens = fmtTokens(m.contextWindow);
    // A real button in every slot keeps the browser's Tab order and the listbox's whole option set.
    const draw = !windowed || i < recent.length || i === active || i === focused || i === oneLine || i === twoLines || (i >= visible.first && i < visible.last);
    return (
      <button
        type="button"
        key={key}
        role="option"
        aria-selected={m.ref === value}
        aria-label={draw ? undefined : [optionText(m.name), hint ? optionText(m.id) : '', tokens].filter(Boolean).join(' ')}
        className={`menu-item ${i === active ? 'is-active' : ''}${draw ? '' : hasTwoLines(m) ? ' model-option-shell is-two-line' : ' model-option-shell'}`}
        onPointerMove={() => i !== active && setActive(i)}
        onFocus={windowed ? () => setFocused(i) : undefined}
        onBlur={windowed ? () => setFocused(-1) : undefined}
        onClick={() => choose(m)}
      >
        {draw && <>
          <span className="menu-icon">{m.ref === value && <Check size={14} weight="bold" />}</span>
          <span className="menu-text">
            <span className="menu-name">{m.name}</span>
            {hint && <span className="menu-hint mono">{m.id}</span>}
          </span>
          <span className="menu-meta num">{tokens}</span>
        </>}
      </button>
    );
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`select model-select ${anchor ? 'is-open' : ''} ${className ?? ''}`}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        data-tip={anchor ? undefined : t('Model')}
        onClick={() => setAnchor(anchor ? null : anchorOf(btn.current!))}
      >
        <Cpu size={14} />
        <span className="select-value">{current?.name ?? (value.split('/').pop() || t('Choose a model'))}</span>
        <CaretDown size={11} className="select-caret" />
      </button>
      {anchor && (
        <Popover anchor={anchor} placement={placement} onClose={() => setAnchor(null)} ignore={btn.current} className={`model-pop ${field ? 'is-field-list' : ''}`} label={t('Model')} minWidth={field ? anchor.w : undefined} gap={field ? 4 : undefined}>
          <label className="pop-search">
            <MagnifyingGlass size={14} />
            <input
              ref={input}
              placeholder={t('Search models')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') e.preventDefault(), setActive((a) => Math.min(a + 1, rows.length - 1));
                else if (e.key === 'ArrowUp') e.preventDefault(), setActive((a) => Math.max(a - 1, 0));
                else if (e.key === 'Enter' && rows[active]) e.preventDefault(), choose(rows[active]);
              }}
            />
          </label>
          <div className="pop-scroll" ref={list} role="listbox" onScroll={windowed ? (e) => showWindow(e.currentTarget) : undefined}>
            {groups.length === 0 && (
              <div className="pop-empty">
                <p>{q ? t('No model matches.') : t('No models yet.')}</p>
                {!q && (
                  <button
                    type="button"
                    className="btn is-small"
                    onClick={() => {
                      setAnchor(null);
                      setUi({ settings: 'providers' });
                    }}
                  >
                    {t('Set up a provider')}
                  </button>
                )}
              </div>
            )}
            {recent.length > 0 && (
              <div className="pop-group" role="group" aria-label={t('Recent')}>
                <div className="menu-label">{t('Recent')}</div>
                {recent.map((m) => item(`recent:${m.ref}`, m))}
              </div>
            )}
            {groups.map(({ p, models }) => {
              const shut = isFolded(p.id);
              const here = models.some((m) => m.ref === value);
              return (
                <div key={p.id} className={`pop-group ${shut ? 'is-folded' : ''}`} role="group" aria-label={p.name}>
                  <button type="button" className="menu-label pop-fold" aria-expanded={!shut} disabled={searching} onClick={() => toggle(p.id)}>
                    {!searching && <CaretRight size={11} className={`pop-fold-caret ${shut ? '' : 'is-open'}`} />}
                    <span className="pop-fold-name">{p.name}</span>
                    {shut && here && <span className="pop-fold-current">{current?.name}</span>}
                    <span className="pop-fold-count num">{models.length}</span>
                  </button>
                  {!shut && models.map((m) => item(`${p.id}:${m.ref}`, m))}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="pop-foot"
            onClick={() => {
              setAnchor(null);
              setUi({ settings: 'providers' });
            }}
          >
            {t('Manage providers')}
          </button>
        </Popover>
      )}
    </>
  );
}
