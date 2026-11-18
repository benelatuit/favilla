import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFind } from '../../lib/find';
import { computeRevealPath, revealFoldPath, syncFoldAliases } from '../../lib/fold-state';
import { useFollow } from '../../lib/follow';
import { fill, useT } from '../../lib/i18n';
import { motion } from '../../lib/motion';
import { actions, preparingOf, setUi, toast, useStore, type Failure, type State } from '../../lib/store';
import { buildTimeline, keysOf, type TimelineBuild } from '../../lib/timeline';
import type { Draft, Message, RunningTool, ToolResultPart } from '../../lib/types';
import { TAIL, drawn as drawnPart, earlier as earlierPart, later as laterPart, toShow, type Win } from '../../lib/window';
import { ArrowDown, ArrowsClockwise, Stop } from '../icons';
import { Pen, type PenMode } from '../Pen';
import { useElapsed } from '../TitleBar';
import { SessionScopeProvider } from '../tools/SessionScope';
import { Keys } from '../ui/Keys';
import { useCodeCopy, useMarkdownImages } from './MarkdownView';
import { renderTimelineItem } from './WorkFold';

/** The user's message while the turn gets it ready: there at once, as it will stand. */
function Preparing() {
  const prep = useStore((s) => preparingOf(s.session));
  if (!prep) return null;
  return (
    <div className="turn-user is-preparing">
      <div className="user-card">
        <div className="user-text">{prep.text}</div>
      </div>
    </div>
  );
}

function failureAdvice(f: Failure): { say: string; settings: boolean } | null {
  switch (f.kind) {
    case 'auth':
      return /no api key/i.test(f.text)
        ? { say: 'This provider has no API key yet. Add one in the provider settings.', settings: true }
        : { say: 'The provider turned down the API key. Check it in the provider settings.', settings: true };
    case 'model_not_found':
      return { say: 'The provider does not have this model, or cannot reach it just now. Check the model name, or pick another model below.', settings: true };
    case 'network':
      return { say: 'Could not reach the provider. Check its address, that a model server on this computer is running, and the HTTPS proxy.', settings: true };
    case 'overloaded':
    case 'server':
    case 'stream_stalled':
      return { say: 'The provider is busy or failing just now. Try again in a while, or pick another model below.', settings: false };
    case 'rate_limit':
      return { say: 'The provider is limiting requests. Wait a moment and try again.', settings: false };
    case 'quota':
      return { say: 'This account has used up its quota with the provider. Check its usage or billing there.', settings: false };
    default:
      return null;
  }
}

/**
 * A turn that ended on an error, said at the end of the conversation until the next turn starts, or a quiet line
 * when it was stopped. Every failure can be tried again: after a request the provider refused, the model or effort
 * below may have been changed.
 */
function Failed() {
  const t = useT();
  const failed = useStore((s) => s.failed);
  const idle = useStore((s) => (s.session?.status ?? 'idle') === 'idle');
  if (!failed || !idle) return null;
  if (failed.kind === 'aborted') {
    return (
      <div className="turn-stopped" role="status">
        <Stop size={13} /> {t('Stopped by you')}
      </div>
    );
  }
  const advice = failureAdvice(failed);
  const detail = failed.text.replace(/\s*\(no answer after \d+ tries:[^)]*\)\s*$/, '');
  return (
    <div className="notice is-error turn-failed" role="status">
      {advice ? (
        <>
          <p className="turn-failed-say">{t(advice.say)}</p>
          <p className="turn-failed-detail mono">{detail}</p>
        </>
      ) : (
        <p className="turn-failed-say">{fill(t('This turn did not finish: {n}'), failed.text)}</p>
      )}
      <div className="turn-failed-actions">
        <button type="button" className="btn is-small" onClick={() => actions.retry().catch((e) => toast((e as Error).message, 'error'))}>
          <ArrowsClockwise size={14} /> {t('Try again')}
        </button>
        {advice?.settings && (
          <button type="button" className="btn is-small btn-quiet" onClick={() => setUi({ settings: 'providers' })}>
            {t('Open provider settings')}
          </button>
        )}
      </div>
    </div>
  );
}

/** What the turn is doing now, for its pen: a word only when it changes, so a streamed delta draws nothing here. */
function penMode(s: State): PenMode {
  if (s.session?.status === 'compacting') return 'fold';
  const detail = s.session?.statusDetail;
  if (detail === 'retrying') return 'wait';
  if (detail === 'thinking') return 'think';
  if (s.running.size) return 'step';
  // The part being written now: the newest one of the newest message.
  let last: Draft | undefined;
  for (const d of s.drafts.values()) last = d;
  let at = -1;
  let kind: string | undefined;
  if (last) for (const [i, p] of last.parts) if (i > at) [at, kind] = [i, p.kind];
  return kind === 'reasoning' ? 'think' : kind === 'tool' ? 'step' : 'write';
}

function Working() {
  const t = useT();
  const status = useStore((s) => s.session?.status ?? 'idle');
  const detail = useStore((s) => s.session?.statusDetail);
  const mode = useStore(penMode);
  const elapsed = useElapsed();
  if (status === 'idle' || status === 'waiting') return null;
  const label =
    status === 'compacting'
      ? t('Compacting context')
      : detail === 'checking'
        ? t('Checking the answer covers every request')
        : detail === 'shadow-tests'
          ? t('Running the shadow tests another model wrote from the request')
          : detail === 'auditing'
            ? t('Measuring the page at desktop and phone width')
            : detail === 'retrying'
              ? t('Retrying')
              : detail === 'thinking'
                ? t('Thinking; this model does not show its thoughts')
                : t('Working');
  return (
    <div className="working" aria-live="polite">
      <Pen mode={mode} width={24} />
      <span>{label}</span>
      {elapsed && <span className="num muted">{elapsed}</span>}
      <span className="working-hint">
        <Keys combo="Esc" /> {t('to stop')}
      </span>
    </div>
  );
}

/** The lines above and below a shortened conversation draw more of it on their own when reached. */
function MoreHistory({ count, onMore, later = false }: { count: number; onMore: () => void; later?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const rootMargin = later ? '0px 0px 200px 0px' : '200px 0px 0px 0px';
  const remaining = later ? count : undefined;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { rootMargin });
    seen.observe(el);
    return () => seen.disconnect();
  }, [onMore, rootMargin, remaining]);
  return (
    <button type="button" ref={ref} className={later ? 'link earlier later' : 'link earlier'} onClick={onMore}>
      {fill(later ? t('Show later ({n} more)') : t('Show earlier ({n} more)'), count)}
    </button>
  );
}

export interface TimelineProps {
  messages: Message[];
  results: Map<string, ToolResultPart>;
  drafts: Map<string, Draft>;
  running: Map<string, RunningTool>;
  footer?: ReactNode;
  /** Another session's work shown inside a sheet (a sub-agent's): whether it is still working, and no working line of this one's. */
  embedded?: { live: boolean };
  /** The session these messages belong to, when it is not the open one (a sub-agent's): what its steps load comes from it. */
  sessionId?: string;
}

export const Timeline = memo(function Timeline({ messages, results, drafts, running, footer, embedded, sessionId }: TimelineProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const runwayRef = useRef<HTMLDivElement>(null);
  const sessionBusy = useStore((s) => (s.session?.status ?? 'idle') !== 'idle');
  const busy = embedded ? embedded.live : sessionBusy;
  const openSession = useStore((s) => s.session?.meta.id);
  const replaces = useStore((s) => s.session?.meta.replaces);
  const owner = sessionId ?? openSession;
  const expanded = !!embedded;
  useCodeCopy(ref, t('Copied'));
  useMarkdownImages(ref, t('Picture not found'));

  const [shown, setShown] = useState({ owner, followKey: owner, win: TAIL });
  if (shown.owner !== owner) {
    const same = !embedded && shown.owner && replaces?.includes(shown.owner);
    setShown(same ? { ...shown, owner } : { owner, followKey: owner, win: TAIL });
  }
  const { win, followKey } = shown;
  // Another session's conversation fades in where the last one stood, rather than taking its place in one frame.
  // Opacity alone, on the compositor: the switch costs no layout, and the scroll it opens at is set underneath.
  const fadedFor = useRef(followKey);
  useLayoutEffect(() => {
    if (embedded || fadedFor.current === followKey) return;
    fadedFor.current = followKey;
    const m = motion();
    if (!m.still) ref.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: m.fast, easing: m.ease });
  }, [followKey, embedded]);
  const setWin = useCallback((update: Win | ((before: Win) => Win)) => {
    setShown((before) => {
      const win = typeof update === 'function' ? update(before.win) : update;
      return win === before.win ? before : { ...before, win };
    });
  }, []);
  const atEnd = win.to === null;
  const { away, follow } = useFollow(() => ref.current?.parentElement, {
    enabled: !embedded && atEnd,
    key: followKey,
    live: busy,
    content: () => ref.current,
    spacer: () => runwayRef.current,
  });

  const previous = useRef<TimelineBuild>(undefined);
  const built = useMemo(
    () => buildTimeline({ messages, results, running, drafts, live: busy, embedded: expanded, sessionId: owner }, previous.current),
    [messages, results, running, drafts, busy, expanded, owner],
  );
  useLayoutEffect(() => {
    previous.current = built;
    syncFoldAliases(owner, built.items);
  }, [built, owner]);

  const { items } = built;
  // The turn that has just ended in this view gathers its steps into the line above its answer. Only that once: the
  // same fold drawn again (the view scrolled back to it, the session opened later) is drawn as a line.
  const ending = useRef({ busy, owner, key: '', at: 0 });
  if (ending.current.busy !== busy || ending.current.owner !== owner) {
    let key = '';
    if (!busy && ending.current.busy && ending.current.owner === owner && !embedded) {
      for (let i = items.length - 1; i >= 0 && items[i].kind !== 'user'; i--) {
        if (items[i].kind === 'work') {
          key = items[i].key;
          break;
        }
      }
    }
    ending.current = { busy, owner, key, at: key ? performance.now() : 0 };
  }
  const gather = ending.current.key && performance.now() - ending.current.at < 1000 ? ending.current.key : undefined;
  const lastItem = items[items.length - 1];
  const lastProcess = lastItem?.kind === 'process' ? lastItem : undefined;
  const { start, end } = drawnPart(items, win);
  const itemsNow = useRef(items);
  itemsNow.current = items;

  const kept = useRef<{ el: Element; top: number } | null>(null);
  const more = useCallback(() => {
    const first = ref.current?.querySelector(':scope > :not(.earlier):not(.jump-anchor):not(.follow-runway)');
    if (first) kept.current = { el: first, top: first.getBoundingClientRect().top };
    setWin((w) => earlierPart(itemsNow.current, w));
  }, [setWin]);
  useLayoutEffect(() => {
    const k = kept.current;
    kept.current = null;
    const box = ref.current?.parentElement;
    if (k && box && k.el.isConnected) box.scrollTop += k.el.getBoundingClientRect().top - k.top;
  }, [start]);
  const fewer = useCallback(() => setWin((w) => laterPart(itemsNow.current, w)), [setWin]);

  const reveal = useFind((_, r) => (embedded ? null : r));
  useLayoutEffect(() => {
    if (!reveal) return;
    const i = items.findIndex((it) => keysOf(it).includes(reveal.block));
    if (i >= 0) setWin((w) => toShow(items, w, i));
    const path = computeRevealPath(items, reveal.block, { openStep: reveal.open });
    if (path.length) revealFoldPath(owner, path);
    // Each request once, on the items of its moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  return (
    <SessionScopeProvider sessionId={owner} results={results}>
      <div className="timeline" ref={ref}>
        {start > 0 && <MoreHistory count={start} onMore={more} />}
        {items.slice(start, end).map((item) => renderTimelineItem(item, expanded, busy, lastProcess, t, gather))}
        {end < items.length && <MoreHistory count={items.length - end} onMore={fewer} later />}
        {!embedded && atEnd && <Preparing />}
        {!embedded && atEnd && <Working />}
        {!embedded && atEnd && <Failed />}
        {footer}
        {/* Below everything, the working line included: the room steps give up as they fold is never a hole between
            the last step and the line that says the turn is still going. */}
        {!embedded && atEnd && <div ref={runwayRef} className="follow-runway" aria-hidden />}
        {/* Always there, with the button only when it is wanted: the newest entries are counted from the end of the
            timeline (timeline.css), so a child that comes or goes there restyles every entry. It came and went on
            each fold toggle away from the end. */}
        {!embedded && (
          <div className="jump-anchor">
            {(away || !atEnd) && (
              <button
                type="button"
                className="jump"
                onClick={() => {
                  setWin(TAIL);
                  follow(!atEnd);
                }}
              >
                <ArrowDown size={14} weight="bold" />
                <span>{t('Latest')}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </SessionScopeProvider>
  );
});
