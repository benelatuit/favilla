import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { foldKey, useFoldOpen, type ToolStep } from '../../lib/fold-state';
import { fmtDuration } from '../../lib/format';
import { count, fill, useT } from '../../lib/i18n';
import { motion } from '../../lib/motion';
import { failuresLeft, stepOutcome } from '../../lib/steps';
import type { Item } from '../../lib/timeline';
import type { Work } from '../../lib/turns';
import { CaretRight } from '../icons';
import { useSessionScope } from '../tools/SessionScope';
import { FailedNote } from './LookGroup';
import { ProcessGroup, stepSummary } from './ProcessGroup';
import { Answer, TurnFacts, TurnFigures } from './TurnLedger';
import { Compaction, UserCard } from './UserCard';

/** How long a turn's steps take to gather into its line, in ms; the CSS transition says the same (timeline.css). */
const GATHER_MS = 360;

export function renderTimelineItem(item: Item, expanded: boolean, busy: boolean, lastProcess: Item | undefined, t: (k: string) => string, gather?: string): ReactNode {
  switch (item.kind) {
    case 'user':
      return <UserCard key={item.key} m={item.m} />;
    case 'steer':
      return (
        <div key={item.key} className="turn-user is-steer" data-find={item.key}>
          <span className="steer-label" data-find-skip>
            {t('Sent while it was working')}
          </span>
          <div className="user-card">
            <div className="user-text">{item.text}</div>
          </div>
        </div>
      );
    case 'compaction':
      return <Compaction key={item.key} m={item.m} />;
    case 'text':
      return <Answer key={item.key} b={item} />;
    case 'refusal':
      return (
        <div key={item.key} className="notice is-warn">
          {item.text.trim() ? `${t('The model declined')}: ${item.text}` : t('The model declined')}
        </div>
      );
    case 'process':
      return <ProcessGroup key={item.anchorKey ?? item.key} item={item} live={busy && item === lastProcess} fold={!expanded} />;
    case 'work':
      return <WorkFold key={item.key} work={item} expanded={expanded} gather={item.key === gather} />;
  }
}

/**
 * A finished turn's work as one line above its answer: how long the turn took and how many steps it ran, the files it
 * changed (they open its changes) and how its checks came out. Opened, the steps and the notes between them read as
 * they did, and the turn's facts close them. A turn that has just ended draws its steps as they stood and gathers them
 * into the line (`gather`); history and a reopened session draw the line at once.
 */
export const WorkFold = memo(function WorkFold({ work, expanded, gather = false }: { work: Work<Item>; expanded: boolean; gather?: boolean }) {
  const t = useT();
  const { sessionId } = useSessionScope();
  const [open, toggleOpen] = useFoldOpen(sessionId, foldKey.work(work.key), false);
  const { tools, hasNotice, sole } = useMemo(() => {
    const list = work.items.flatMap((x) => (x.kind === 'process' ? x.steps.filter((s): s is ToolStep => s.kind === 'tool') : []));
    const nonOk = failuresLeft(list).length > 0 || list.some((s) => {
      const o = stepOutcome(s);
      return o === 'denied' || o === 'cancelled';
    });
    // One run of steps under this line would open on a second head saying the same: its steps show at once.
    const sole = work.items.filter((x) => x.kind === 'process').length === 1;
    return { tools: list, hasNotice: nonOk, sole };
  }, [work]);
  const answer = work.answer?.kind === 'text' ? work.answer : undefined;
  const ledger = answer?.ledger;

  const [gathering, setGathering] = useState(() => gather && !motion().still);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!gathering || !el) return;
    // Steps taller than the window gather where they cannot be seen, at the price of a layout a frame: they fold at once.
    if (el.offsetHeight > window.innerHeight) {
      setGathering(false);
      return;
    }
    // The box keeps the line's height at the least, so the line rides its bottom edge up as the steps close above it,
    // and the box ends exactly as tall as the line drawn on its own.
    const line = el.querySelector<HTMLElement>(':scope > .turn-line');
    el.style.minHeight = `${line?.offsetHeight ?? 30}px`;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => el.classList.add('is-closing'));
    });
    const done = window.setTimeout(() => setGathering(false), GATHER_MS + 40);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      window.clearTimeout(done);
      el.style.minHeight = '';
    };
  }, [gathering]);

  const line = (
    <div className="turn-line" data-find-skip>
      <button type="button" className="turn-toggle" onClick={toggleOpen} aria-expanded={open}>
        <span className="num">
          {ledger ? `${fill(t('Worked {n}'), fmtDuration(ledger.ms))} · ${count(t, tools.length, '{n} step', '{n} steps')}` : stepSummary(tools, t).join(' · ')}
        </span>
        {hasNotice && <FailedNote tools={tools} />}
        <CaretRight size={11} className="turn-caret" />
      </button>
      {ledger && <TurnFigures l={ledger} turn={answer?.turn} />}
    </div>
  );

  if (gathering) {
    return (
      <div ref={box} className="work-fold is-gathering">
        <div className="work-gather" aria-hidden>
          <div className="work-gather-inner">{work.items.map((it) => renderTimelineItem(it, expanded, false, undefined, t))}</div>
        </div>
        {line}
      </div>
    );
  }
  return (
    <div ref={box} className={`work-fold ${open ? 'is-open' : ''}`}>
      {line}
      {open && (
        <div className="work-body">
          {work.items.map((it) =>
            sole && it.kind === 'process' ? <ProcessGroup key={it.anchorKey ?? it.key} item={it} live={false} fold={!expanded} head={false} /> : renderTimelineItem(it, expanded, false, undefined, t),
          )}
          {ledger && answer && <TurnFacts l={ledger} answer={answer.text} />}
        </div>
      )}
    </div>
  );
});
