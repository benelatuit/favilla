import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** How close to the end still counts as being at it, in px. */
const AT_END = 24;
/** How far up the reader is before a jump back to the newest content is offered, in px. */
const FAR = 400;

/**
 * Keeps a scrolling view on its newest content while the reader is at the end, and lets go the moment they move
 * up: a wheel turn, a key, a finger or the scrollbar. Coming back to the end follows again. A distance from the
 * end alone cannot tell a reader moving up from content growing: a clock or streamed text re-renders several times
 * a second and pulled the reader back down before one wheel step (about 100 px) took them out of reach.
 *
 * `target` returns the scrolling element; `key` names what is shown, and a new one starts at its end again.
 */
export function useFollow(target: () => HTMLElement | null | undefined, opts: { enabled?: boolean; key?: unknown } = {}): { following: boolean; away: boolean; follow: (instant?: boolean) => void } {
  const { enabled = true, key } = opts;
  const following = useRef(true);
  const last = useRef(0);
  const [shown, setShown] = useState({ following: true, away: false });
  const show = useCallback((gap: number) => {
    const next = { following: following.current, away: gap > FAR };
    setShown((s) => (s.following === next.following && s.away === next.away ? s : next));
  }, []);

  useLayoutEffect(() => {
    const el = target();
    following.current = true;
    show(0);
    if (!el) return;
    last.current = el.scrollTop;
    const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    const stop = () => {
      if (!following.current) return;
      following.current = false;
      show(gap());
    };
    const onScroll = () => {
      const top = el.scrollTop;
      // Content that shrinks clamps the position upward at the end: that is no reader leaving.
      if (top < last.current - 1 && gap() > 2) following.current = false;
      else if (gap() <= AT_END) following.current = true;
      last.current = top;
      show(gap());
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stop();
    };
    let y = 0;
    const onTouchStart = (e: TouchEvent) => {
      y = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const now = e.touches[0]?.clientY ?? 0;
      // A finger moving down pulls earlier content into view.
      if (now > y + 2) stop();
      y = now;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') stop();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('keydown', onKey);
    };
    // `target` reads refs when called; the element changes only with what is shown.
  }, [key, show]);

  useLayoutEffect(() => {
    const el = target();
    if (!el || !enabled || !following.current) return;
    el.scrollTop = el.scrollHeight;
    last.current = el.scrollTop;
  });

  /**
   * Back to the newest content and following it. `instant` jumps there over the next frames instead of gliding: what
   * is drawn changes first (a stretch far back gives way to the end), and a glide aimed at the old end stopped short.
   */
  const follow = useCallback(
    (instant = false) => {
      const el = target();
      following.current = true;
      show(0);
      if (!el) return;
      if (!instant) return el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      let frames = 0;
      const pin = () => {
        if (!following.current) return;
        el.scrollTop = el.scrollHeight;
        last.current = el.scrollTop;
        if (++frames < 4) requestAnimationFrame(pin);
      };
      requestAnimationFrame(pin);
    },
    // `target` reads refs when called.
    [show],
  );

  return { ...shown, follow };
}
