import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { desktop, isMac } from '../../lib/desktop';
import { useT } from '../../lib/i18n';
import { getState, setUi, useStore, type ViewerImage } from '../../lib/store';
import { CaretLeft, CaretRight, MagnifyingGlassMinus, MagnifyingGlassPlus, X } from '../icons';

type Size = { w: number; h: number };
type View = { scale: number; x: number; y: number };
type Rect = { left: number; top: number; w: number; h: number };
type Pad = { x: number; y: number };

/** Sizes of pictures already loaded, so one opened again, or the next one, is placed on its first frame. */
const sizes = new Map<string, Size>();
/** The thumbnail the open picture grew out of, to go back into on close, and what had the focus before. */
let origin: { el: HTMLImageElement; index: number } | null = null;
let opener: HTMLElement | null = null;
let openings = 0;

/**
 * Open the viewer on these pictures, at the one numbered `index`. `from` is what was pressed (a thumbnail, or the
 * button holding one): the picture grows out of it and goes back into it on close.
 */
export function openViewer(images: ViewerImage[], index = 0, from?: Element | null): void {
  if (!images.length) return;
  const at = Math.max(0, Math.min(index, images.length - 1));
  const img = from instanceof HTMLImageElement ? from : (from?.querySelector('img') ?? null);
  origin = img ? { el: img, index: at } : null;
  // A remote thumbnail's object URL is released with its DOM node. The viewer keeps the picture's own address.
  const remoteSrc = img?.dataset.remoteSrc;
  if (img && remoteSrc && sameSrc(img.src, images[at].src)) {
    images = images.map((image, i) => i === at ? { ...image, src: remoteSrc } : image);
  }
  // The thumbnail holds the picture already: its size places the large one on the first frame.
  if (img?.naturalWidth && sameSrc(remoteSrc ?? img.src, images[at].src)) sizes.set(images[at].src, { w: img.naturalWidth, h: img.naturalHeight });
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setUi({ viewer: { images, index: at, opened: ++openings } });
}

function sameSrc(a: string, b: string): boolean {
  try {
    return new URL(a, location.href).href === new URL(b, location.href).href;
  } catch {
    return a === b;
  }
}

const MAX = 8;

/** Room kept around a fitted picture: beside it for the arrows when there are several, less on a phone. */
function padFor(stage: Size, many: boolean): Pad {
  const wide = stage.w > 640;
  return { x: wide ? (many ? 64 : 24) : 12, y: wide ? 24 : 12 };
}

/** The scale at which the picture fills the room it has, larger than 1 for small pictures. */
function fillOf(stage: Size, n: Size, pad: Pad): number {
  return Math.max(0.01, Math.min((stage.w - 2 * pad.x) / n.w, (stage.h - 2 * pad.y) / n.h));
}

/** A picture smaller than its room on an axis stays centred there; a larger one moves only until its edge shows. */
function clampView(v: View, stage: Size, n: Size, pad: Pad): View {
  const lx = Math.max(0, (n.w * v.scale - (stage.w - 2 * pad.x)) / 2);
  const ly = Math.max(0, (n.h * v.scale - (stage.h - 2 * pad.y)) / 2);
  return { scale: v.scale, x: Math.max(-lx, Math.min(lx, v.x)), y: Math.max(-ly, Math.min(ly, v.y)) };
}

/** Where the picture sits on the stage, its corner on a whole device pixel so it is drawn sharp. */
function place(stage: Size, n: Size, v: View, nudge: { x: number; y: number } | null): Rect {
  const dpr = window.devicePixelRatio || 1;
  const snap = (x: number) => Math.round(x * dpr) / dpr;
  const w = n.w * v.scale;
  const h = n.h * v.scale;
  return { left: snap((stage.w - w) / 2 + v.x + (nudge?.x ?? 0)), top: snap((stage.h - h) / 2 + v.y + (nudge?.y ?? 0)), w, h };
}

/** The transform that shows a picture laid out at `base` over the rectangle `at`. */
function over(at: Rect, base: Rect): string {
  return `translate(${at.left}px, ${at.top}px) scale(${at.w / base.w}, ${at.h / base.h})`;
}

/** The largest rectangle of this aspect inside `box`, centred: where a cropped thumbnail's picture really is. */
function contain(box: Rect, aspect: number): Rect {
  const w = Math.min(box.w, box.h * aspect);
  const h = w / aspect;
  return { left: box.left + (box.w - w) / 2, top: box.top + (box.h - h) / 2, w, h };
}

function shrink(r: Rect, k: number): Rect {
  return { left: r.left + (r.w * (1 - k)) / 2, top: r.top + (r.h * (1 - k)) / 2, w: r.w * k, h: r.h * k };
}

/** The motion tokens from the stylesheet, and whether the system asks for less motion. */
function motion(): { fast: number; slow: number; ease: string; still: boolean } {
  const css = getComputedStyle(document.documentElement);
  const ms = (name: string, d: number) => parseFloat(css.getPropertyValue(name)) || d;
  return { fast: ms('--fast', 120), slow: ms('--slow', 180), ease: css.getPropertyValue('--ease').trim() || 'ease-out', still: matchMedia('(prefers-reduced-motion: reduce)').matches };
}

/** The thumbnail the picture came from, where it is now on the stage, while it is still on the page. */
function originOn(stage: HTMLElement, index: number): Rect | null {
  if (!origin || origin.index !== index || !origin.el.isConnected) return null;
  const o = origin.el.getBoundingClientRect();
  if (o.width < 1 || o.height < 1) return null;
  const box = stage.getBoundingClientRect();
  return { left: o.left - box.left, top: o.top - box.top, w: o.width, h: o.height };
}

/** The viewer while one is open; each opening starts with its own state. */
export function Viewer() {
  const viewer = useStore((s) => s.ui.viewer);
  if (!viewer?.images.length) return null;
  return createPortal(<Open key={viewer.opened} images={viewer.images} index={Math.min(viewer.index, viewer.images.length - 1)} />, document.body);
}

/**
 * Pictures the agent looked at (or the user attached), on a dark light table: fitted at first and grown out of the
 * thumbnail pressed; zoomed with the wheel or a pinch around the pointer, with + and -, and to 1:1 or back with a
 * click on the picture; dragged when larger than the table; the neighbours one arrow key or swipe away.
 */
function Open({ images, index }: { images: ViewerImage[]; index: number }) {
  const t = useT();
  const image = images[index];
  const many = images.length > 1;
  const stageRef = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size | null>(null);
  const [view, setView] = useState<View | 'fit'>('fit');
  const [ready, setReady] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [nudge, setNudge] = useState<{ x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [closing, setClosing] = useState(false);

  const size = sizes.get(image.src) ?? null;
  const shown = ready === image.src;
  const pad = stage ? padFor(stage, many) : { x: 0, y: 0 };
  const fill = stage && size ? fillOf(stage, size, pad) : 1;
  const fit = Math.min(1, fill);
  const max = Math.max(MAX, fill);
  const v = view === 'fit' || !stage || !size ? { scale: fit, x: 0, y: 0 } : clampView(view, stage, size, pad);
  const atFit = Math.abs(v.scale - fit) < 1e-3;
  const pannable = !!stage && !!size && (size.w * v.scale > stage.w - 2 * pad.x + 0.5 || size.h * v.scale > stage.h - 2 * pad.y + 0.5);
  const rect = stage && size ? place(stage, size, v, nudge) : null;

  // The handlers outside React's render (wheel, gestures, close) read the picture's geometry from here.
  const geo = useRef({ stage, size, pad, fit, max, v, rect, atFit, pannable, shown, index, src: image.src });
  geo.current = { stage, size, pad, fit, max, v, rect, atFit, pannable, shown, index, src: image.src };
  const flipFrom = useRef<Rect | null>(null);
  const intro = useRef(true);
  const shutting = useRef(false);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setStage((s) => (s && s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  // "Loading" only when a picture is slow to come, never as a flash before a quick one.
  useEffect(() => {
    setSlow(false);
    const id = window.setTimeout(() => setSlow(true), 400);
    return () => window.clearTimeout(id);
  }, [image.src]);

  // The neighbours load while this one is looked at, so the arrow keys never wait.
  useEffect(() => {
    if (!many) return;
    for (const step of [1, -1]) {
      const src = images[(index + step + images.length) % images.length].src;
      if (sizes.has(src)) continue;
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => sizes.set(src, { w: im.naturalWidth || 512, h: im.naturalHeight || 512 });
      im.src = src;
    }
  }, [images, index, many]);

  // The picture grows out of its thumbnail when it first shows, and fades in after an arrow key.
  useLayoutEffect(() => {
    const el = picture.current;
    const st = stageRef.current;
    const r = geo.current.rect;
    if (!shown || !el || !st || !r) return;
    const first = intro.current;
    intro.current = false;
    const m = motion();
    if (m.still) return;
    if (!first) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: m.fast, easing: m.ease });
      return;
    }
    const from = originOn(st, index);
    if (from) el.animate([{ transform: over(contain(from, r.w / r.h), r) }, { transform: over(r, r) }], { duration: m.slow, easing: m.ease });
    else el.animate([{ transform: over(shrink(r, 0.96), r), opacity: 0 }, { transform: over(r, r), opacity: 1 }], { duration: m.slow, easing: m.ease });
  }, [shown, index]);

  // A step zoom (a button, a key, a click) moves the picture from where it was instead of jumping. Checked after
  // every render, so a step that changed nothing leaves no stale start behind.
  useLayoutEffect(() => {
    const from = flipFrom.current;
    flipFrom.current = null;
    const el = picture.current;
    const to = geo.current.rect;
    if (!from || !el || !to) return;
    if (Math.abs(from.left - to.left) + Math.abs(from.top - to.top) + Math.abs(from.w - to.w) < 1) return;
    const m = motion();
    if (!m.still) el.animate([{ transform: over(from, to) }, { transform: over(to, to) }], { duration: m.slow, easing: m.ease });
  });

  /** Change the view with the picture moving there from where it is now. */
  const stepTo = useCallback((change: () => void) => {
    flipFrom.current = geo.current.rect;
    change();
  }, []);

  /** Zoom by `k` (kept between fit and the most), keeping the stage point `at` (from its centre) where it is. */
  const zoom = useCallback((k: number, at?: { x: number; y: number }) => {
    setView((prev) => {
      const g = geo.current;
      if (!g.stage || !g.size) return prev;
      const cur = prev === 'fit' ? { scale: g.fit, x: 0, y: 0 } : clampView(prev, g.stage, g.size, g.pad);
      const scale = Math.min(g.max, Math.max(g.fit, cur.scale * k));
      if (scale <= g.fit * 1.001) return 'fit';
      const r = scale / cur.scale;
      const p = at ?? { x: 0, y: 0 };
      return clampView({ scale, x: p.x - (p.x - cur.x) * r, y: p.y - (p.y - cur.y) * r }, g.stage, g.size, g.pad);
    });
  }, []);

  const close = useCallback(() => {
    if (shutting.current) return;
    shutting.current = true;
    setClosing(true);
    const m = motion();
    const finish = () => {
      setUi({ viewer: null });
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      opener = null;
      origin = null;
    };
    const el = picture.current;
    const st = stageRef.current;
    const g = geo.current;
    if (m.still) return finish();
    if (el && st && g.rect && g.shown) {
      for (const a of el.getAnimations()) a.cancel();
      const base = g.rect;
      const back = originOn(st, g.index);
      const to = back ? contain(back, base.w / base.h) : shrink(base, 0.96);
      el.animate([{ transform: over(base, base), opacity: 1 }, { transform: over(to, base), opacity: back ? 0.6 : 0 }], { duration: m.slow, easing: m.ease, fill: 'forwards' });
    }
    window.setTimeout(finish, m.slow);
  }, []);

  const go = useCallback((step: number) => {
    const viewer = getState().ui.viewer;
    if (!viewer || viewer.images.length < 2 || shutting.current) return;
    setView('fit');
    setNudge(null);
    setUi({ viewer: { ...viewer, index: (viewer.index + step + viewer.images.length) % viewer.images.length } });
  }, []);

  /** A click on the picture: from fit to 1:1 at that point (2x for a picture already shown whole), or back. */
  const toggle = useCallback(
    (at: { x: number; y: number }) => {
      const g = geo.current;
      if (!g.shown) return;
      if (g.atFit) stepTo(() => zoom((g.fit < 1 ? 1 : 2) / g.v.scale, at));
      else stepTo(() => setView('fit'));
    },
    [stepTo, zoom],
  );

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Shortcuts with a modifier stay the window's own (its zoom among them).
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === '+' || e.key === '=') stepTo(() => zoom(1.25));
      else if (e.key === '-' || e.key === '_') stepTo(() => zoom(0.8));
      else if (e.key === '0') stepTo(() => setView('fit'));
      else if (e.key === '1') stepTo(() => zoom(1 / geo.current.v.scale));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [close, go, stepTo, zoom]);

  // The wheel zooms around the pointer, by how far it turned: a notch is a step, a trackpad pinch is smooth.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = geo.current;
      if (!g.shown || !g.stage) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? g.stage.h : 1;
      const k = Math.min(2, Math.max(0.5, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015))));
      const box = el.getBoundingClientRect();
      zoom(k, { x: e.clientX - box.left - box.width / 2, y: e.clientY - box.top - box.height / 2 });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoom]);

  // Pointers: a drag pans a picture larger than the table, two fingers pinch, a finger on a fitted picture swipes
  // to the neighbours or down to close, and a press that did not move is a click.
  const press = useRef<{ id: number; x: number; y: number; touch: boolean; view: View; mode: 'wait' | 'pan' | 'swipe' | 'none' } | null>(null);
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; mx: number; my: number; view: View } | null>(null);
  const moved = useRef(false);

  const centre = () => {
    const box = stageRef.current!.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('button') || (e.pointerType === 'mouse' && e.button !== 0) || shutting.current) return;
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = geo.current;
    if (fingers.current.size === 2 && g.shown) {
      const [a, b] = [...fingers.current.values()];
      pinch.current = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, view: g.v };
      press.current = null;
      moved.current = true;
      setNudge(null);
      setPanning(false);
      return;
    }
    if (fingers.current.size > 1) return;
    moved.current = false;
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse', view: g.v, mode: 'wait' };
    // A quick drag leaves the stage before it counts as one: the stage keeps the pointer from the press on (a
    // finger is kept by what it touched already).
    if (e.pointerType !== 'touch') stageRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!fingers.current.has(e.pointerId)) return;
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = geo.current;
    if (!g.stage || !g.size) return;
    const pz = pinch.current;
    if (pz && fingers.current.size >= 2) {
      const [a, b] = [...fingers.current.values()];
      const c = centre();
      const scale = Math.min(g.max, Math.max(g.fit, (pz.view.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pz.d));
      const r = scale / pz.view.scale;
      const next = { scale, x: (a.x + b.x) / 2 - c.x - (pz.mx - c.x - pz.view.x) * r, y: (a.y + b.y) / 2 - c.y - (pz.my - c.y - pz.view.y) * r };
      setView(scale <= g.fit * 1.001 ? 'fit' : clampView(next, g.stage, g.size, g.pad));
      return;
    }
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (p.mode === 'wait') {
      if (Math.hypot(dx, dy) < (p.touch ? 8 : 4)) return;
      moved.current = true;
      p.mode = g.pannable ? 'pan' : p.touch && g.atFit && g.shown ? 'swipe' : 'none';
      if (p.mode === 'pan') setPanning(true);
    }
    if (p.mode === 'pan') setView(clampView({ ...p.view, x: p.view.x + dx, y: p.view.y + dy }, g.stage, g.size, g.pad));
    else if (p.mode === 'swipe') setNudge(Math.abs(dx) >= Math.abs(dy) ? { x: many ? dx : dx / 3, y: 0 } : { x: 0, y: Math.max(0, dy) });
  };

  const onPointerEnd = (e: React.PointerEvent) => {
    fingers.current.delete(e.pointerId);
    if (pinch.current) {
      if (fingers.current.size < 2) pinch.current = null;
      return;
    }
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    setPanning(false);
    if (p.mode !== 'swipe') return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (e.type === 'pointerup' && many && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    else if (e.type === 'pointerup' && dy > 90 && dy > Math.abs(dx)) close();
    else stepTo(() => setNudge(null));
  };

  const onClick = (e: React.MouseEvent) => {
    if (moved.current) {
      moved.current = false;
      return;
    }
    if ((e.target as Element).closest('button')) return;
    // Where the press was, not what it was on: the stage holds the pointer, so the click lands on the stage.
    const r = geo.current.shown ? picture.current?.getBoundingClientRect() : undefined;
    if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      // The second click of a double click would undo the first.
      if (e.detail > 1) return;
      const c = centre();
      toggle({ x: e.clientX - c.x, y: e.clientY - c.y });
    } else close();
  };

  const status = failed === image.src ? t('This picture could not be loaded.') : !shown && slow ? t('Loading the picture…') : null;
  const root = ['viewer', desktop && 'is-desktop', isMac && 'is-mac', closing && 'is-closing', panning && 'is-panning'].filter(Boolean).join(' ');
  const stageClass = ['viewer-stage', atFit && 'is-fit', pannable && 'is-pannable'].filter(Boolean).join(' ');
  return (
    <div
      ref={rootRef}
      className={root}
      role="dialog"
      aria-modal="true"
      aria-label={image.name}
      tabIndex={-1}
      // How far a finger has pulled the picture down to close it: the table and its edges fade with it.
      style={nudge?.y && !closing ? ({ '--pull': Math.min(1, nudge.y / 240) } as React.CSSProperties) : undefined}
    >
      <div className="viewer-shade" />
      <div className="viewer-bar">
        <button type="button" className="icon-btn" aria-label={t('Close')} data-tip={t('Close')} data-keys="Esc" onClick={close}>
          <X size={16} />
        </button>
        <div className="viewer-title">
          <span className="viewer-name">{image.name}</span>
          {image.caption && <span className="viewer-caption mono">{image.caption}</span>}
        </div>
        {many && (
          <span className="viewer-count num">
            {index + 1} / {images.length}
          </span>
        )}
      </div>
      <div
        ref={stageRef}
        className={stageClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onClick}
      >
        {failed !== image.src && (
          <div
            key={image.src}
            ref={picture}
            className={`viewer-picture${shown ? ' is-shown' : ''}${v.scale >= 2 ? ' is-pixels' : ''}`}
            style={rect ? { width: rect.w, height: rect.h, transform: `translate(${rect.left}px, ${rect.top}px)` } : undefined}
          >
            <img
              src={image.src}
              alt={image.name}
              draggable={false}
              decoding="async"
              onLoad={(e) => {
                const el = e.currentTarget;
                const src = image.src;
                sizes.set(src, { w: el.naturalWidth || 512, h: el.naturalHeight || 512 });
                // Shown once decoded, so the first frame is the whole picture and not an empty frame.
                void el
                  .decode()
                  .catch(() => undefined)
                  .then(() => {
                    if (geo.current.src === src) setReady(src);
                  });
              }}
              onError={() => setFailed(image.src)}
            />
          </div>
        )}
        {status && <p className="viewer-status">{status}</p>}
        {many && (
          <>
            <button type="button" className="viewer-nav is-prev icon-btn" aria-label={t('Previous')} data-tip={t('Previous')} data-keys="←" onClick={() => go(-1)}>
              <CaretLeft size={20} />
            </button>
            <button type="button" className="viewer-nav is-next icon-btn" aria-label={t('Next')} data-tip={t('Next')} data-keys="→" onClick={() => go(1)}>
              <CaretRight size={20} />
            </button>
          </>
        )}
      </div>
      <div className="viewer-foot">
        <button type="button" className="icon-btn" aria-label={t('Zoom out')} data-tip={t('Zoom out')} data-keys="-" disabled={!shown || atFit} onClick={() => stepTo(() => zoom(0.8))}>
          <MagnifyingGlassMinus size={16} />
        </button>
        <span className="viewer-scale num">{shown ? `${Math.round(v.scale * 100)}%` : '–'}</span>
        <button type="button" className="icon-btn" aria-label={t('Zoom in')} data-tip={t('Zoom in')} data-keys="+" disabled={!shown || v.scale >= max - 1e-3} onClick={() => stepTo(() => zoom(1.25))}>
          <MagnifyingGlassPlus size={16} />
        </button>
        <span className="viewer-rule" />
        <button type="button" className="viewer-mode" aria-pressed={shown && atFit} data-tip={t('Fit to the window')} data-keys="0" disabled={!shown} onClick={() => stepTo(() => setView('fit'))}>
          {t('Fit to the window')}
        </button>
        <button type="button" className="viewer-mode" aria-pressed={shown && Math.abs(v.scale - 1) < 1e-3} data-tip={t('Actual size')} data-keys="1" disabled={!shown} onClick={() => stepTo(() => zoom(1 / v.scale))}>
          {t('Actual size')}
        </button>
        {shown && size && (
          <>
            <span className="viewer-rule is-size" />
            <span className="viewer-size num">
              {size.w} × {size.h}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
