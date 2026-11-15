import { useEffect, useState, useSyncExternalStore } from 'react';
import { remoteMode } from './remote';

/**
 * The layout on a narrow screen. "simple" is the phone's own: a list of sessions as the home page, one conversation at
 * a time with a back button, a composer with the model and effort and nothing else. "full" is the window as on the
 * computer, drawers and all. The choice is this device's, kept in its own storage; wide windows always get the full one.
 */
export type Layout = 'simple' | 'full';

const KEY = 'favilla.layout';
/** Below this the sidebar is a drawer (App.tsx), and the simple layout can take over. */
export const NARROW = '(max-width: 859px)';

function stored(): Layout | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'simple' || v === 'full' ? v : null;
  } catch {
    return null;
  }
}

let chosen = stored();
/** No session open: whether the simple layout shows the list of sessions or a new one being written. */
let composing = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** Until one is picked here, a phone (a paired remote, or any touch screen) gets the simple layout. */
export function layoutChoice(): Layout {
  return chosen ?? (remoteMode || window.matchMedia('(pointer: coarse)').matches ? 'simple' : 'full');
}

export function setLayout(layout: Layout): void {
  chosen = layout;
  try {
    localStorage.setItem(KEY, layout);
  } catch {
    /* storage unavailable: the choice lasts until the page closes */
  }
  changed();
}

export function useLayoutChoice(): Layout {
  return useSyncExternalStore(subscribe, layoutChoice);
}

export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Whether the simple layout is in force: chosen for this device, on a narrow screen. */
export function useSimple(): boolean {
  const narrow = useMedia(NARROW);
  const choice = useLayoutChoice();
  return narrow && choice === 'simple';
}

export function useComposing(): boolean {
  return useSyncExternalStore(subscribe, () => composing);
}

export function setComposing(on: boolean): void {
  if (composing === on) return;
  composing = on;
  changed();
}
