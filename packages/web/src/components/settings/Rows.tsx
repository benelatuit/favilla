import type { SettingBasis } from '@favilla/core/types';
import { createContext, useCallback, useContext, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { actions, settingSaveError, toast, useStore, type SettingsPage } from '../../lib/store';
import { fill, useT } from '../../lib/i18n';
import { CaretRight, WarningCircle } from '../icons';
import { Pen } from '../Pen';

/**
 * The parts every settings page is made of: a page head, groups of ruled rows (a name and one line of note on the
 * left, the control on the right), lists whose items open in place, and the states of a page that loads.
 */

/** Where the settings are: the page to go to, and the setting a search asked for (scrolled to and marked). */
export interface SettingsNav {
  go: (page: SettingsPage, setting?: string) => void;
  found: string | null;
}

export const NavContext = createContext<SettingsNav>({ go: () => {}, found: null });

export const useSettingsNav = (): SettingsNav => useContext(NavContext);

/** Remember what was displayed when typing started, even if a newer view arrives during the edit. */
export function useSettingDraft(value: string, basis?: SettingBasis) {
  const [draft, setDraft] = useState<{ value: string; initial: string; basis?: SettingBasis }>();
  return {
    ...(draft ?? { value, initial: value, basis }),
    change: (next: string) => setDraft((d) => ({ initial: d?.initial ?? value, basis: d ? d.basis : basis, value: next })),
    clear: () => setDraft(undefined),
    saved: () => setDraft((d) => d === draft ? undefined : d),
  };
}

/** A change to the global config, said to be saved, or the error said. */
export function useSetConfig() {
  const t = useT();
  const opened = useStore((s) => s.info?.basis);
  return useCallback(
    (patch: Record<string, unknown>, basis = opened, load?: () => void | Promise<void>) =>
      actions.setConfig(patch, basis)
        .then(() => { toast(t('Saved'), 'info'); return true; })
        .catch((e) => { settingSaveError(e, load); return false; }),
    [t, opened],
  );
}

/** What a page shows from the server: null while it loads, with the error when it could not, and a way to ask again. */
export function useView<T>(path: string): { view: T | null; error: string | null; setView: (v: T | null) => void; reload: () => void } {
  const [view, setView] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    api<T>(path)
      .then((v) => live && setView(v))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [path, asked]);
  return { view, error, setView, reload: () => setAsked((n) => n + 1) };
}

/** What goes between a sentence and the next one or a link after it: a space after English, none after a Chinese stop. */
export const sep = (text: string) => (/[。！？]$/.test(text) ? '' : ' ');

/** A page: its title, one line under it, and its groups. */
export function Page({ title, lede, action, children }: { title: string; lede?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="set-head">
        <h2>{title}</h2>
        {(lede || action) && (
          <p className="set-lede">
            {lede}
            {lede && action ? sep(lede) : null}
            {action}
          </p>
        )}
      </header>
      {children}
    </>
  );
}

/**
 * A ruled group of rows under a small heading. Its note says what holds for all of them; its foot, under the last
 * rule, what is good to know once they are set (where things are kept, how a change reaches open sessions).
 */
export function Group({ id, title, note, foot, children }: { id?: string; title?: string; note?: ReactNode; foot?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-group" data-setting={id} id={id ? `setting-${id}` : undefined}>
      {(title || note) && (
        <div className="set-group-head">
          {title && <h3>{title}</h3>}
          {note && <p className="set-note">{note}</p>}
        </div>
      )}
      <div className="set-rows">{children}</div>
      {foot && <div className="set-foot">{foot}</div>}
    </section>
  );
}

/**
 * One setting: its name and at most one line of note on the left, its control on the right (under them on a phone).
 * `id` is what the search finds it by. `children` go under the whole row: a form, a list, a warning.
 */
export function Row({ id, label, note, warn, control, children, stack }: { id?: string; label: ReactNode; note?: ReactNode; warn?: boolean; control?: ReactNode; children?: ReactNode; stack?: boolean }) {
  const labelId = id ? `setting-${id}-label` : undefined;
  return (
    <div className={`set-row ${stack ? 'is-stacked' : ''}`} data-setting={id} id={id ? `setting-${id}` : undefined}>
      <div className="set-label">
        <span className="set-name" id={labelId}>
          {label}
        </span>
        {note && <span className={`set-note ${warn ? 'is-warn' : ''}`}>{note}</span>}
      </div>
      {control && (
        <div className="set-control" role="group" aria-labelledby={labelId}>
          {control}
        </div>
      )}
      {children && <div className="set-extra">{children}</div>}
    </div>
  );
}

/**
 * An item of a list (a provider, a server, a persona): its mark, name, a line about it and its state; with `open`
 * set it unfolds into `children`, the item's own settings, in place. `add` makes it the list's last line, which
 * unfolds into the form that adds one.
 */
export function Item({
  id,
  mark,
  name,
  meta,
  state,
  open,
  onToggle,
  end,
  add,
  fold,
  children,
}: {
  id?: string;
  mark?: ReactNode;
  name: ReactNode;
  meta?: ReactNode;
  state?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  /** Buttons at the end of the line, outside the part that unfolds it. */
  end?: ReactNode;
  add?: boolean;
  /** The line that unfolds more items of the same list, quieter than the items. */
  fold?: boolean;
  children?: ReactNode;
}) {
  const head = (
    <>
      {onToggle && !add && <CaretRight size={11} className="set-caret" />}
      {mark && <span className="set-mark">{mark}</span>}
      <span className="set-item-text">
        <span className="set-item-name">{name}</span>
        {meta && <span className="set-item-meta">{meta}</span>}
      </span>
      {state && <span className="set-item-state">{state}</span>}
    </>
  );
  return (
    <div className={`set-item ${open ? 'is-open' : ''} ${add ? 'is-add' : ''} ${fold ? 'is-fold' : ''}`} data-setting={id} id={id ? `setting-${id}` : undefined}>
      <div className="set-item-line">
        {onToggle ? (
          <button type="button" className="set-item-head" aria-expanded={!!open} onClick={onToggle}>
            {head}
          </button>
        ) : (
          <div className="set-item-head is-static">{head}</div>
        )}
        {end}
      </div>
      {open && children && <div className="set-detail">{children}</div>}
    </div>
  );
}

/** The last line of an open item: what can be done with it, and apart at the end, what removes it. */
export function DetailFoot({ children, danger }: { children?: ReactNode; danger?: ReactNode }) {
  return (
    <div className="set-detail-foot">
      {children}
      {danger && <span className="set-danger">{danger}</span>}
    </div>
  );
}

/** A page while what it shows is on its way. */
export function Loading() {
  const t = useT();
  return (
    <p className="set-state" role="status">
      <Pen /> {t('Loading…')}
    </p>
  );
}

/** A page that could not get what it shows: the reason, and asking again. */
export function LoadError({ error, retry }: { error: string; retry: () => void }) {
  const t = useT();
  return (
    <p className="set-state is-error" role="alert">
      <WarningCircle size={16} /> <span>{fill(t('This page could not load: {n}'), error)}</span>
      <button type="button" className="link" onClick={retry}>
        {t('Try again')}
      </button>
    </p>
  );
}

/** A path kept somewhere, ending visible when it is too long for the line. */
export function PathNote({ label, path }: { label: string; path: string }) {
  return (
    <p className="set-path">
      <span>{label}</span>
      <span className="mono set-path-text" data-tip={path}>
        <bdi>{path}</bdi>
      </span>
    </p>
  );
}

/** A choice of one among a few, as a radio group: Tab reaches the chosen option, the arrow keys move and choose. */
export function Segmented<T extends string | boolean>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T | undefined;
  options: [T, string, { icon?: ReactNode; disabled?: boolean }?][];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  const open = options.filter(([, , o]) => !disabled && !o?.disabled).map(([v]) => v);
  // With nothing chosen, or the choice not open, Tab still reaches the group: on its first open option.
  const reachable = open.includes(value as T) ? value : open[0];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = open.indexOf(value as T);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? open.length - 1 : !step ? -1 : at < 0 ? (step > 0 ? 0 : open.length - 1) : (at + step + open.length) % open.length;
    if (to < 0 || !open.length) return;
    e.preventDefault();
    onChange(open[to]);
    (e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[options.findIndex(([v]) => v === open[to])])?.focus();
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map(([v, text, o]) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          tabIndex={v === reachable ? 0 : -1}
          disabled={disabled || o?.disabled}
          className={value === v ? 'is-on' : ''}
          onClick={() => value !== v && onChange(v)}
        >
          {o?.icon}
          {text}
        </button>
      ))}
    </div>
  );
}
