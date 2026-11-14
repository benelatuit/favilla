import { useEffect, useRef } from 'react';
import { useT } from '../lib/i18n';
import { useStore } from '../lib/store';
import { closeFind, currentMatch, findNext, getFind, paint, position, search, unpaint, useFind } from '../lib/find';
import { CaretDown, CaretUp, MagnifyingGlass, X } from './icons';

const box = () => document.querySelector<HTMLElement>('.main .scroll');
const scope = () => document.querySelector('.main .timeline');
const matchKey = (m: NonNullable<ReturnType<typeof currentMatch>>) => `${m.block}#${m.paste ?? ''}#${m.n}`;

/** The part of the conversation at the top of the view (a message or an answer), where a new search starts. */
function onScreen(): string | null {
  const el = box();
  if (!el) return null;
  const top = el.getBoundingClientRect().top;
  for (const part of el.querySelectorAll<HTMLElement>('.timeline > [data-find]')) if (part.getBoundingClientRect().bottom > top + 8) return part.dataset.find ?? null;
  return null;
}

/** Scroll `scroller` so the match sits a third of the way down it, unless it is in view there already. */
function place(scroller: HTMLElement, r: Range, margin: number): void {
  const at = r.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (at.top >= view.top + margin && at.bottom <= view.bottom - margin) return;
  scroller.scrollTop += at.top - view.top - scroller.clientHeight / 3;
}

/**
 * Bring a match into view. A part far from the view is laid out only roughly until it comes near
 * (content-visibility), and its text measures in the wrong place: the element that holds the match is brought near
 * first, and the match is placed a frame later, once it is laid out, inside an output that scrolls on its own (a
 * long terminal) as well as in the conversation.
 */
function bringIntoView(r: Range, again = true): void {
  const view = box();
  const host = r.startContainer.parentElement;
  if (!view || !host) return;
  const near = host.getBoundingClientRect();
  const frame = view.getBoundingClientRect();
  if (again && (near.bottom < frame.top || near.top > frame.bottom)) {
    host.scrollIntoView({ block: 'center' });
    requestAnimationFrame(() => bringIntoView(r, false));
    return;
  }
  for (let el: HTMLElement | null = host; el && el !== view; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) place(el, r, 8);
  }
  place(view, r, 56);
}

/**
 * Find in the conversation (Ctrl+F), as a browser or an editor finds: a small plate at the top of the conversation
 * with the words, where the current match is among all of them, previous and next (Shift+Enter and Enter, F3), and
 * Esc to close. The whole session is searched, whole outputs and the part before a compaction included; going to a
 * match draws its part of the conversation and opens the step or thought that holds it.
 */
export function FindBar() {
  const t = useT();
  const f = useFind((s) => s);
  const sessionId = useStore((s) => s.activeId);
  const grown = useStore((s) => s.session?.messages.length ?? 0);
  const input = useRef<HTMLInputElement>(null);
  const current = currentMatch(f);
  // The match still to be brought into view: its part may be drawn and opened only later (a whole output loading).
  const due = useRef<string | null>(null);

  // Another session: the bar closes, as a browser's find does on another page.
  useEffect(() => closeFind, [sessionId]);

  // The pinned goal leaves the conversation unobstructed while a match is brought into view.
  useEffect(() => {
    document.body.classList.toggle('is-finding', f.open);
    return () => document.body.classList.remove('is-finding');
  }, [f.open]);

  useEffect(() => {
    if (!f.open) return;
    input.current?.focus();
    input.current?.select();
    // Opened again with the last words: search for them in this conversation as it is now.
    if (f.asked && getFind().query.trim() && !getFind().hits.length) search(getFind().query, onScreen);
  }, [f.open, f.asked]);

  // The current match: its part is drawn and opened first, so wait for it on the page, then bring it into view. One
  // that shows only once a whole output has loaded is brought into view then, by the watch below.
  useEffect(() => {
    if (!f.open) return unpaint();
    due.current = current ? matchKey(current) : null;
    const now = paint(scope(), f.query, current);
    if (now) {
      due.current = null;
      bringIntoView(now);
      return;
    }
    if (!current) return;
    // While the match is missing, only a change to the page can make it available.
    const fallback = window.setTimeout(() => {
      if (due.current) scope()?.querySelector(`[data-find="${CSS.escape(current.block)}"]`)?.scrollIntoView({ block: 'center' });
    }, 1500);
    return () => window.clearTimeout(fallback);
    // `current` is read from `f`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.open, f.query, f.at, f.hits]);

  // The page changes under the marks (a step opens, an answer streams in): mark it again, without moving the view.
  useEffect(() => {
    const root = box();
    if (!f.open || !root) return;
    let pending = 0;
    const again = () => {
      pending = 0;
      const g = getFind();
      const cur = currentMatch(g);
      const now = paint(scope(), g.query, cur);
      if (now && cur && due.current === matchKey(cur)) {
        due.current = null;
        bringIntoView(now);
      }
    };
    const watch = new MutationObserver(() => {
      if (!pending) pending = window.setTimeout(again, 180);
    });
    watch.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      watch.disconnect();
      clearTimeout(pending);
    };
  }, [f.open]);

  // The conversation grew while the bar is open: the same search again, staying on the same match.
  useEffect(() => {
    if (f.open && getFind().query.trim()) search(getFind().query, onScreen, true);
  }, [grown]);

  useEffect(() => unpaint, []);

  if (!f.open) return null;
  const n = position(f);
  const count = !f.query.trim() ? '' : f.busy && !f.hits.length ? '…' : f.total ? `${n} / ${f.total}` : t('No matches');
  return (
    <div className="findbar" role="search">
      <MagnifyingGlass size={14} className="findbar-icon" />
      <input
        ref={input}
        value={f.query}
        spellCheck={false}
        placeholder={t('Find in this conversation')}
        aria-label={t('Find in this conversation')}
        onChange={(e) => search(e.target.value, onScreen)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            findNext(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeFind();
          }
        }}
      />
      <span className={`findbar-count num ${f.query.trim() && !f.total && !f.busy ? 'is-none' : ''}`} aria-live="polite">
        {count}
      </span>
      <button type="button" className="icon-btn is-small" aria-label={t('Previous match')} data-tip={t('Previous match')} data-keys="Shift+Enter" disabled={!f.total} onClick={() => findNext(-1)}>
        <CaretUp size={14} />
      </button>
      <button type="button" className="icon-btn is-small" aria-label={t('Next match')} data-tip={t('Next match')} data-keys="Enter" disabled={!f.total} onClick={() => findNext(1)}>
        <CaretDown size={14} />
      </button>
      <button type="button" className="icon-btn is-small" aria-label={t('Close')} data-tip={t('Close')} data-keys="Esc" onClick={closeFind}>
        <X size={14} />
      </button>
    </div>
  );
}
