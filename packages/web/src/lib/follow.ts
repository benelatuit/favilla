import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** How close to the end still counts as being at it, in px. */
const AT_END = 24;
/** Distance from the end before offering "Latest" while live output is streaming, in px. */
const LIVE_AWAY_ENTER = 120;
const LIVE_AWAY_EXIT = 48;
/** Distance from the end before offering "Latest" in a settled view, in px. */
const IDLE_AWAY_ENTER = 280;
const IDLE_AWAY_EXIT = 96;
/** Maximum temporary bottom cushion when steps fold or shrink so the viewport never bounces, in px. */
const MAX_RUNWAY = 104;
/** Duration of the dynamic chase glide back to the bottom, in ms. */
const GLIDE_MS = 160;
/** Fold toggles inside a timeline: clicking one keeps its header in place instead of snapping to the bottom. */
const FOLD_TOGGLE = '.step-head, .user-fold, .thought-run-fold, .ledger-line, .compaction .link, .clamp-toggle';

export interface FollowOptions {
  enabled?: boolean;
  key?: unknown;
  /** Whether new content is actively streaming into this view. */
  live?: boolean;
  /** Optional inner content box observed for height changes and tail-item offsets. */
  content?: () => HTMLElement | null | undefined;
  /** Optional leaf spacer element that absorbs step-fold shrinkage without invalidating `.timeline` styles. */
  spacer?: () => HTMLElement | null | undefined;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isEditableOrOverlayTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.closest('[role="menu"], [role="listbox"], [role="dialog"]:not(.childsheet), .palette, .findbar');
}

/** True when a wheel/touch gesture happens inside a nested scrollable box (such as an open terminal) that contains it. */
function nestedScrollConsumes(target: EventTarget | null, container: HTMLElement, dir: -1 | 1): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== container) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
      const style = getComputedStyle(node);
      const oy = style.overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
        if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') return true;
        if (dir < 0 && node.scrollTop > 0.5) return true;
        if (dir > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 0.5) return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

interface TailRef {
  el: HTMLElement;
  top: number;
}

function isRunwayExcluded(el: Element): boolean {
  const c = el.classList;
  return c.contains('follow-runway') || c.contains('working') || c.contains('jump-anchor') || c.contains('earlier');
}

/**
 * Records the `offsetTop` of recent content children above `--follow-runway` so `syncBottom` can distinguish tail
 * shrinkage (which `--follow-runway` absorbs) from offscreen `content-visibility: auto` height changes above the view.
 */
function captureTailRefs(contentEl: HTMLElement | null | undefined): TailRef[] {
  if (!contentEl) return [];
  let cursor = contentEl.lastElementChild;
  while (cursor && isRunwayExcluded(cursor)) cursor = cursor.previousElementSibling;
  if (!(cursor instanceof HTMLElement)) return [];
  const tail: TailRef = { el: cursor, top: cursor.offsetTop };
  const refs: TailRef[] = [];
  let prev = cursor.previousElementSibling;
  while (prev && refs.length < 6) {
    if (prev instanceof HTMLElement && !isRunwayExcluded(prev)) {
      refs.push({ el: prev, top: prev.offsetTop });
    }
    prev = prev.previousElementSibling;
  }
  refs.push(tail);
  return refs;
}

function readOffsetDelta(refs: readonly TailRef[], contentEl: HTMLElement): number {
  for (const r of refs) {
    if (r.el.isConnected && r.el.parentElement === contentEl) {
      return r.el.offsetTop - r.top;
    }
  }
  return 0;
}

/**
 * Keeps a scrolling view on its newest content while the reader is at the end, and lets go the instant they move
 * up: a wheel turn, a key, a finger or the scrollbar. Coming back to the end follows again.
 *
 * Height shrinkage from auto-folding steps or closing tails is absorbed by `--follow-runway` on `content` so
 * visible lines stay steady without bouncing or leaving blank voids.
 */
export function useFollow(
  target: () => HTMLElement | null | undefined,
  opts: FollowOptions = {},
): { following: boolean; away: boolean; follow: (instant?: boolean) => void } {
  const { enabled = true, key, live = false, content, spacer } = opts;
  const following = useRef(true);
  const last = useRef(0);
  const lastUpAt = useRef(-1e9);
  const runway = useRef(0);
  const syncedSize = useRef({ sh: -1, ch: -1 });
  const widthChanged = useRef(false);
  const tailRefs = useRef<TailRef[]>([]);
  const liveRef = useRef(live);
  liveRef.current = live;
  const contentGetter = useRef(content);
  contentGetter.current = content;
  const spacerGetter = useRef(spacer);
  spacerGetter.current = spacer;
  const anchor = useRef<{ el: Element; top: number; at: number; raf: number; pinned?: boolean } | null>(null);
  const glide = useRef<{ raf: number } | null>(null);
  const [shown, setShown] = useState({ following: true, away: false });

  const setRunway = useCallback((contentEl: HTMLElement | null | undefined, px: number) => {
    const next = px > 0.5 ? Math.round(px) : 0;
    if (runway.current === next) return;
    runway.current = next;
    const spacerEl = spacerGetter.current?.();
    if (spacerEl) {
      if (next > 0) {
        spacerEl.style.display = 'block';
        spacerEl.style.height = `${next}px`;
      } else {
        spacerEl.style.display = '';
        spacerEl.style.height = '';
      }
      return;
    }
    if (!contentEl) return;
    if (next > 0) contentEl.style.setProperty('--follow-runway', `${next}px`);
    else contentEl.style.removeProperty('--follow-runway');
  }, []);

  const syncOverflowAnchor = useCallback((el: HTMLElement | null | undefined) => {
    if (!el) return;
    const want = following.current ? 'none' : '';
    if (el.style.overflowAnchor !== want) el.style.overflowAnchor = want;
  }, []);

  const cancelGlide = useCallback(() => {
    if (!glide.current) return;
    if (glide.current.raf) cancelAnimationFrame(glide.current.raf);
    glide.current = null;
  }, []);

  const cancelAnchor = useCallback(() => {
    if (!anchor.current) return;
    if (anchor.current.raf) cancelAnimationFrame(anchor.current.raf);
    anchor.current = null;
  }, []);

  const computeAway = useCallback((naturalGap: number, clientHeight: number, wasAway: boolean): boolean => {
    if (following.current) return false;
    const isLive = liveRef.current;
    const cap = clientHeight > 0 ? Math.max(72, Math.round(clientHeight * 0.45)) : IDLE_AWAY_ENTER;
    const enterAt = Math.min(isLive ? LIVE_AWAY_ENTER : IDLE_AWAY_ENTER, cap);
    const exitAt = Math.min(isLive ? LIVE_AWAY_EXIT : IDLE_AWAY_EXIT, Math.round(enterAt * 0.5));
    return wasAway ? naturalGap > exitAt : naturalGap > enterAt;
  }, []);

  const show = useCallback(
    (rawGap: number, clientHeight = 0) => {
      const naturalGap = Math.max(0, rawGap - runway.current);
      setShown((s) => {
        const nextFollowing = following.current;
        const nextAway = computeAway(naturalGap, clientHeight, s.away);
        return s.following === nextFollowing && s.away === nextAway ? s : { following: nextFollowing, away: nextAway };
      });
    },
    [computeAway],
  );

  const pinAnchor = useCallback(
    (el: HTMLElement, a: { el: Element; top: number; pinned?: boolean }) => {
      const sh = el.scrollHeight;
      const ch = el.clientHeight;
      if (a.pinned && sh === syncedSize.current.sh && ch === syncedSize.current.ch) return;
      a.pinned = true;
      const hadRunway = runway.current > 0;
      setRunway(contentGetter.current?.(), 0);
      if (a.el.isConnected) {
        const delta = a.el.getBoundingClientRect().top - a.top;
        if (Math.abs(delta) > 0.5) el.scrollTop += delta;
      }
      const nextSh = hadRunway ? el.scrollHeight : sh;
      last.current = el.scrollTop;
      syncedSize.current = { sh: nextSh, ch };
      const g = Math.max(0, nextSh - last.current - ch);
      following.current = g <= AT_END;
      if (following.current) tailRefs.current = captureTailRefs(contentGetter.current?.());
      syncOverflowAnchor(el);
      show(g, ch);
    },
    [setRunway, show, syncOverflowAnchor],
  );

  const syncBottom = useCallback(
    (el: HTMLElement) => {
      const a = anchor.current;
      if (a && performance.now() - a.at < 250) {
        pinAnchor(el, a);
        return;
      }
      syncOverflowAnchor(el);
      if (!following.current || glide.current) return;

      const sh = el.scrollHeight;
      const ch = el.clientHeight;
      const st = el.scrollTop;
      const contentEl = contentGetter.current?.();
      const boxWidthChanged = widthChanged.current;
      widthChanged.current = false;
      if (contentEl) {
        const prevTop = last.current;
        const prevCh = syncedSize.current.ch;
        const chDelta = prevCh > 0 ? ch - prevCh : 0;
        const offsetDelta = boxWidthChanged ? 0 : readOffsetDelta(tailRefs.current, contentEl);
        const nextTailRefs = captureTailRefs(contentEl);
        const desiredTop = boxWidthChanged ? 0 : Math.max(0, prevTop + offsetDelta - Math.max(0, chDelta));
        const naturalBottom =
          sh <= ch && desiredTop > 0 && contentEl.offsetParent === el
            ? contentEl.offsetTop + contentEl.offsetHeight - runway.current
            : sh - runway.current;
        const naturalMaxTop = Math.max(0, naturalBottom - ch);
        if (desiredTop > 0 && naturalMaxTop < desiredTop - 0.5) {
          const cap = ch > 0 ? Math.min(MAX_RUNWAY, Math.max(64, Math.round(ch * 0.4))) : MAX_RUNWAY;
          const needed = Math.min(cap, Math.max(0, ch + desiredTop - naturalBottom));
          setRunway(contentEl, needed);
          const nextSh = Math.max(ch, naturalBottom + runway.current);
          const nextGoal = Math.max(0, nextSh - ch);
          if (Math.abs(st - nextGoal) > 0.5) el.scrollTop = nextGoal;
          last.current = nextGoal;
          syncedSize.current = { sh: nextSh, ch };
          tailRefs.current = nextTailRefs;
          return;
        }
        if (runway.current > 0) {
          setRunway(contentEl, 0);
          const nextSh = Math.max(ch, naturalBottom);
          const nextGoal = Math.max(0, nextSh - ch);
          if (Math.abs(st - nextGoal) > 0.5) el.scrollTop = nextGoal;
          last.current = nextGoal;
          syncedSize.current = { sh: nextSh, ch };
          tailRefs.current = nextTailRefs;
          return;
        }
        const goal = Math.max(0, sh - ch);
        if (Math.abs(st - goal) > 0.5) el.scrollTop = goal;
        last.current = goal;
        syncedSize.current = { sh, ch };
        tailRefs.current = nextTailRefs;
        return;
      }
      const goal = Math.max(0, sh - ch);
      if (Math.abs(st - goal) > 0.5) el.scrollTop = goal;
      last.current = goal;
      syncedSize.current = { sh, ch };
    },
    [pinAnchor, setRunway, syncOverflowAnchor],
  );

  useLayoutEffect(() => {
    const el = target();
    following.current = true;
    lastUpAt.current = -1e9;
    syncedSize.current = { sh: -1, ch: -1 };
    widthChanged.current = false;
    tailRefs.current = [];
    cancelAnchor();
    cancelGlide();
    setRunway(contentGetter.current?.(), 0);
    show(0, el?.clientHeight ?? 0);
    if (!el || !enabled) {
      if (el) el.style.overflowAnchor = '';
      return;
    }
    syncOverflowAnchor(el);
    el.scrollTop = el.scrollHeight;
    last.current = el.scrollTop;
    syncedSize.current = { sh: el.scrollHeight, ch: el.clientHeight };
    tailRefs.current = captureTailRefs(contentGetter.current?.());

    const gap = () => Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    let touchY = 0;
    let touchMovingUp = false;
    let scrollbarDragging = false;

    const stop = () => {
      lastUpAt.current = performance.now();
      cancelAnchor();
      cancelGlide();
      if (!following.current) {
        show(gap(), el.clientHeight);
        return;
      }
      following.current = false;
      syncOverflowAnchor(el);
      show(gap(), el.clientHeight);
    };

    const onScroll = () => {
      if (anchor.current && performance.now() - anchor.current.at < 250) return;
      if (glide.current) return;
      const top = el.scrollTop;
      const g = gap();
      if (scrollbarDragging && top < last.current - 0.5) {
        last.current = top;
        stop();
        return;
      }
      const movedDown = top > last.current + 0.5;
      const settledAtExactEnd = g <= 0.5 && top >= last.current && performance.now() - lastUpAt.current > 120;
      if (!following.current && !touchMovingUp && !scrollbarDragging && ((movedDown && g <= AT_END) || settledAtExactEnd)) {
        following.current = true;
        if (runway.current > 0) setRunway(contentGetter.current?.(), 0);
        syncOverflowAnchor(el);
        syncedSize.current = { sh: el.scrollHeight, ch: el.clientHeight };
        tailRefs.current = captureTailRefs(contentGetter.current?.());
      } else if (!following.current && runway.current > 0) {
        const cap = el.clientHeight > 0 ? Math.max(72, Math.round(el.clientHeight * 0.45)) : IDLE_AWAY_ENTER;
        const enterAt = Math.min(liveRef.current ? LIVE_AWAY_ENTER : IDLE_AWAY_ENTER, cap);
        if (g - runway.current > enterAt) setRunway(contentGetter.current?.(), 0);
      }
      last.current = el.scrollTop;
      show(gap(), el.clientHeight);
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        if (!nestedScrollConsumes(e.target, el, -1)) stop();
      } else if (e.deltaY > 0 && !following.current && !nestedScrollConsumes(e.target, el, 1)) {
        const g = gap();
        if (g <= AT_END) {
          following.current = true;
          if (runway.current > 0) setRunway(contentGetter.current?.(), 0);
          syncOverflowAnchor(el);
          syncedSize.current = { sh: el.scrollHeight, ch: el.clientHeight };
          tailRefs.current = captureTailRefs(contentGetter.current?.());
          show(g, el.clientHeight);
        }
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
      touchMovingUp = false;
    };
    const onTouchMove = (e: TouchEvent) => {
      const now = e.touches[0]?.clientY ?? 0;
      if (now > touchY + 2) {
        if (!nestedScrollConsumes(e.target, el, -1)) {
          touchMovingUp = true;
          stop();
        }
      } else if (now < touchY - 2) {
        touchMovingUp = false;
      }
      touchY = now;
    };
    const onTouchEnd = () => {
      touchMovingUp = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 1 && !nestedScrollConsumes(e.target, el, -1)) {
        stop();
        return;
      }
      if (e.target !== el) return;
      const inGutter = e.offsetX >= el.clientWidth - 2 || e.offsetX <= 2;
      if (!inGutter) return;
      scrollbarDragging = true;
      const endDrag = () => {
        scrollbarDragging = false;
        window.removeEventListener('pointerup', endDrag);
        window.removeEventListener('pointercancel', endDrag);
      };
      window.addEventListener('pointerup', endDrag, { once: true });
      window.addEventListener('pointercancel', endDrag, { once: true });
    };

    const isOuterScroll = !el.parentElement?.closest('.scroll');
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableOrOverlayTarget(e.target)) return;
      const active = document.activeElement;
      const ownsKeys = el.contains(active) || (isOuterScroll && (!active || active === document.body || active === document.documentElement));
      if (!ownsKeys) return;
      if (!isOuterScroll && active && nestedScrollConsumes(active, el, -1)) return;
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home' || (e.key === ' ' && e.shiftKey)) {
        stop();
      } else if (e.key === 'End' && !following.current) {
        following.current = true;
        if (runway.current > 0) setRunway(contentGetter.current?.(), 0);
        syncOverflowAnchor(el);
        syncedSize.current = { sh: el.scrollHeight, ch: el.clientHeight };
        tailRefs.current = captureTailRefs(contentGetter.current?.());
        show(0, el.clientHeight);
      }
    };

    const onClickCapture = (e: MouseEvent) => {
      const hit = (e.target as Element | null)?.closest?.(FOLD_TOGGLE);
      if (!hit || !el.contains(hit) || (hit as HTMLButtonElement).disabled) return;
      cancelAnchor();
      cancelGlide();
      const state = { el: hit, top: hit.getBoundingClientRect().top, at: performance.now(), raf: 0 };
      anchor.current = state;
      queueMicrotask(() => {
        if (anchor.current === state && el.isConnected) pinAnchor(el, state);
      });
      state.raf = requestAnimationFrame(() => {
        if (anchor.current === state) {
          if (el.isConnected) pinAnchor(el, state);
          anchor.current = null;
        }
      });
    };

    let lastBoxWidth = -1;
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        if (!el.isConnected || entries.length === 0) return;
        let resizedWidth = false;
        for (const entry of entries) {
          if (entry.target === el) {
            const w = Math.round(entry.contentRect.width);
            if (lastBoxWidth >= 0 && w !== lastBoxWidth) resizedWidth = true;
            lastBoxWidth = w;
          }
        }
        if (resizedWidth) widthChanged.current = true;
        if (!following.current && !anchor.current) {
          const ch = el.clientHeight;
          show(Math.max(0, el.scrollHeight - el.scrollTop - ch), ch);
          return;
        }
        if (!anchor.current && !glide.current && !resizedWidth) {
          const sh = el.scrollHeight;
          const ch = el.clientHeight;
          if (sh === syncedSize.current.sh && ch === syncedSize.current.ch) return;
        }
        syncBottom(el);
      });
      ro.observe(el);
      const contentEl = contentGetter.current?.();
      if (contentEl && contentEl !== el) ro.observe(contentEl);
    }

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    el.addEventListener('click', onClickCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnchor();
      cancelGlide();
      ro?.disconnect();
      setRunway(contentGetter.current?.(), 0);
      el.style.overflowAnchor = '';
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('keydown', onKey);
    };
    // `target` and `content` read refs when called; the element changes only with `key` or `enabled`.
  }, [enabled, key, show, cancelAnchor, cancelGlide, pinAnchor, setRunway, syncBottom, syncOverflowAnchor]);

  useLayoutEffect(() => {
    const el = target();
    if (!el || !enabled) return;
    if (!following.current && !anchor.current) return;
    syncBottom(el);
  });

  /**
   * Return to the newest content and keep following it. Uses a short rAF chase glide that dynamically tracks live
   * growing `scrollHeight` without getting aborted by incoming stream chunks, or jumps immediately when `instant` or
   * `prefers-reduced-motion: reduce` is active.
   */
  const follow = useCallback(
    (instant = false) => {
      const el = target();
      cancelAnchor();
      cancelGlide();
      following.current = true;
      setRunway(contentGetter.current?.(), 0);
      syncOverflowAnchor(el);
      show(0, el?.clientHeight ?? 0);
      if (!el) return;

      const g = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
      if (instant || prefersReducedMotion() || g <= AT_END) {
        el.scrollTop = el.scrollHeight;
        last.current = el.scrollTop;
        syncedSize.current = { sh: el.scrollHeight, ch: el.clientHeight };
        tailRefs.current = captureTailRefs(contentGetter.current?.());
        if (!instant) return;
        let frames = 0;
        const pin = () => {
          if (!following.current || !el.isConnected) return;
          el.scrollTop = el.scrollHeight;
          last.current = el.scrollTop;
          syncedSize.current = { sh: el.scrollHeight, ch: el.clientHeight };
          tailRefs.current = captureTailRefs(contentGetter.current?.());
          if (++frames < 4) requestAnimationFrame(pin);
        };
        requestAnimationFrame(pin);
        return;
      }

      const startAt = performance.now();
      const state = { raf: 0 };
      glide.current = state;
      const step = (now: number) => {
        if (glide.current !== state || !following.current || !el.isConnected) {
          if (glide.current === state) glide.current = null;
          return;
        }
        const goal = Math.max(0, el.scrollHeight - el.clientHeight);
        const rem = goal - el.scrollTop;
        const t = Math.min(1, (now - startAt) / GLIDE_MS);
        if (t >= 1 || rem <= 1.5) {
          el.scrollTop = goal;
          last.current = el.scrollTop;
          syncedSize.current = { sh: el.scrollHeight, ch: el.clientHeight };
          tailRefs.current = captureTailRefs(contentGetter.current?.());
          glide.current = null;
          return;
        }
        const factor = Math.max(0.34, t * t);
        el.scrollTop += Math.max(2, rem * factor);
        last.current = el.scrollTop;
        state.raf = requestAnimationFrame(step);
      };
      state.raf = requestAnimationFrame(step);
    },
    // `target` reads refs when called.
    [cancelAnchor, cancelGlide, setRunway, show, syncOverflowAnchor],
  );

  return { ...shown, follow };
}
