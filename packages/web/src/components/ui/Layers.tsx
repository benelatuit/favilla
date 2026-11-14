import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dismissToast, setUi, useStore } from '../../lib/store';
import { useT } from '../../lib/i18n';
import { CheckCircle, Info as InfoIcon, Warning, WarningOctagon, X } from '../icons';
import { Keys } from './Keys';
import { MenuList } from './Menu';
import { anchorOf, place, Popover, type Anchor } from './Popover';

/**
 * Tooltips for every element with data-tip (and optional data-keys for a shortcut). One layer serves the
 * whole app, so no element needs the browser's own title tooltip.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; keys?: string; anchor: Anchor } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | null = null;
    let warm = 0;
    const hide = () => {
      clearTimeout(timer);
      if (current) warm = Date.now();
      current = null;
      setTip(null);
    };
    const show = (el: Element) => {
      const text = el.getAttribute('data-tip');
      if (!text || !el.isConnected) return;
      setTip({ text, keys: el.getAttribute('data-keys') ?? undefined, anchor: anchorOf(el) });
    };
    const arm = (el: Element | null) => {
      if (el === current) return;
      clearTimeout(timer);
      setTip(null);
      current = el;
      if (el) timer = setTimeout(() => show(el), Date.now() - warm < 600 ? 60 : 450);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      arm((e.target as Element).closest?.('[data-tip]') ?? null);
    };
    const focus = (e: FocusEvent) => {
      const el = e.target as Element;
      if (el.matches?.(':focus-visible')) arm(el.closest('[data-tip]'));
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !box.current) return setPos(null);
    const size = { width: box.current.offsetWidth, height: box.current.offsetHeight };
    const centered = { ...tip.anchor, x: tip.anchor.x + tip.anchor.w / 2 - size.width / 2, w: size.width };
    setPos(place(centered, size, 'top-start', 6));
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={box} className="tooltip" role="tooltip" style={pos ?? { left: -9999, top: 0, visibility: 'hidden' }}>
      <span>{tip.text}</span>
      {tip.keys && <Keys combo={tip.keys} />}
    </div>,
    document.body,
  );
}

/** The right-click menu, opened by the app's context-menu handler. */
export function ContextMenuLayer() {
  const menu = useStore((s) => s.ui.menu);
  if (!menu) return null;
  return (
    <Popover anchor={{ x: menu.x, y: menu.y, w: 0, h: 0 }} placement="point" onClose={() => setUi({ menu: null })} className="context-menu">
      <MenuList entries={menu.entries} onDone={() => setUi({ menu: null })} />
    </Popover>
  );
}

/** Confirmation dialog: Enter confirms, Escape cancels; the destructive choice is never the default focus. */
export function DialogLayer() {
  const dialog = useStore((s) => s.ui.dialog);
  const cancel = useRef<HTMLButtonElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!dialog) return;
    (dialog.danger ? cancel : ok).current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault(), e.stopPropagation(), dialog.resolve(false);
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [dialog]);
  if (!dialog) return null;
  return createPortal(
    <div className="scrim is-dialog" onPointerDown={(e) => e.target === e.currentTarget && dialog.resolve(false)}>
      <section className="dialog" role="alertdialog" aria-modal="true" aria-label={dialog.title}>
        <h2>{dialog.title}</h2>
        {dialog.body && <p>{dialog.body}</p>}
        <div className="dialog-actions">
          <button ref={cancel} type="button" className="btn" onClick={() => dialog.resolve(false)}>
            {dialog.cancel}
          </button>
          <button ref={ok} type="button" className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => dialog.resolve(true)}>
            {dialog.confirm}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

const TOAST_ICONS = { info: InfoIcon, warn: Warning, error: WarningOctagon } as const;

export function ToastLayer() {
  const t = useT();
  const toasts = useStore((s) => s.toasts);
  return createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => {
        const Icon = x.level === 'info' && /^(Saved|Done|Copied|已)/.test(x.text) ? CheckCircle : TOAST_ICONS[x.level];
        return (
          <div key={x.id} className={`toast is-${x.level}`} role={x.level === 'error' ? 'alert' : 'status'}>
            <Icon size={16} weight={x.level === 'info' ? 'regular' : 'fill'} className="toast-icon" />
            <span className="toast-text">{x.text}{x.load && <> <button type="button" className="link" onClick={() => { dismissToast(x.id); x.load?.(); }}>{t('Load file values')}</button></>}</span>
            <button type="button" className="icon-btn is-small" aria-label={t('Close')} onClick={() => dismissToast(x.id)}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
