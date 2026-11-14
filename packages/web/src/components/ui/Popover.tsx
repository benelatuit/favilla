import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface Anchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'point';

export function anchorOf(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Where a floating box of the given size goes: beside the anchor, flipped when it would not fit, kept in the window. */
export function place(anchor: Anchor, size: { width: number; height: number }, placement: Placement, gap = 6): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = 8;
  let left: number;
  let top: number;
  if (placement === 'point') {
    left = anchor.x + size.width > vw - m ? anchor.x - size.width : anchor.x;
    top = anchor.y + size.height > vh - m ? anchor.y - size.height : anchor.y;
  } else {
    const below = anchor.y + anchor.h + gap;
    const above = anchor.y - gap - size.height;
    const fitsBelow = below + size.height <= vh - m;
    const fitsAbove = above >= m;
    const useTop = placement === 'top-start' ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;
    top = useTop ? above : below;
    left = placement === 'bottom-end' ? anchor.x + anchor.w - size.width : anchor.x;
  }
  return {
    left: Math.round(Math.min(Math.max(m, left), vw - size.width - m)),
    top: Math.round(Math.min(Math.max(m, top), vh - size.height - m)),
  };
}

interface PopoverProps {
  anchor: Anchor;
  placement?: Placement;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** Presses on this element (usually the trigger) do not count as outside. */
  ignore?: Element | null;
  label?: string;
  /** At least this wide: a field's list is as wide as the field. */
  minWidth?: number;
  /** Space between the anchor and the plate. */
  gap?: number;
}

/** A floating plate next to an anchor. Closes on a press outside, Escape, resize and window blur. */
export function Popover({ anchor, placement = 'bottom-start', onClose, children, className, ignore, label, minWidth, gap }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(place(anchor, { width: el.offsetWidth, height: el.offsetHeight }, placement, gap));
  }, [anchor.x, anchor.y, anchor.w, anchor.h, placement, gap]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || ignore?.contains(target)) return;
      close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close.current();
    };
    const leave = () => close.current();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', leave);
    window.addEventListener('resize', leave);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', leave);
      window.removeEventListener('resize', leave);
    };
  }, [ignore]);

  return createPortal(
    <div ref={ref} className={`popover ${className ?? ''}`} aria-label={label} style={{ ...(pos ?? { left: -9999, top: 0, visibility: 'hidden' }), ...(minWidth ? { minWidth } : {}) }}>
      {children}
    </div>,
    document.body,
  );
}
