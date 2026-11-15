import { memo, useMemo, type ReactNode } from 'react';
import { foldKey, useFoldOpen, type ToolStep } from '../../lib/fold-state';
import { useT } from '../../lib/i18n';
import { stepOutcome } from '../../lib/steps';
import type { Item } from '../../lib/timeline';
import type { Work } from '../../lib/turns';
import { CaretRight, Stack } from '../icons';
import { useSessionScope } from '../tools/SessionScope';
import { FailedNote } from './LookGroup';
import { ProcessGroup, stepSummary } from './ProcessGroup';
import { Answer } from './TurnLedger';
import { Compaction, UserCard } from './UserCard';

export function renderTimelineItem(item: Item, expanded: boolean, busy: boolean, lastProcess: Item | undefined, t: (k: string) => string): ReactNode {
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
      return <WorkFold key={item.key} work={item} expanded={expanded} />;
  }
}

/**
 * A finished turn's work as one line: what its steps did, counted, as a run of steps says it. Opened, the steps and
 * the notes between them read as they did; find opens it when a match is inside.
 */
export const WorkFold = memo(function WorkFold({ work, expanded }: { work: Work<Item>; expanded: boolean }) {
  const t = useT();
  const { sessionId } = useSessionScope();
  const [open, toggleOpen] = useFoldOpen(sessionId, foldKey.work(work.key), false);
  const { tools, hasNotice } = useMemo(() => {
    const list = work.items.flatMap((x) => (x.kind === 'process' ? x.steps.filter((s): s is ToolStep => s.kind === 'tool') : []));
    const nonOk = list.some((s) => {
      const o = stepOutcome(s);
      return o === 'failed' || o === 'denied' || o === 'cancelled';
    });
    return { tools: list, hasNotice: nonOk };
  }, [work]);
  return (
    <div className={`work-fold ${open ? 'is-open' : ''}`}>
      <div className={`step ${open ? 'is-open' : ''}`}>
        <button type="button" className="step-head process-head" onClick={toggleOpen} aria-expanded={open}>
          <span className="step-icon">
            <Stack size={16} />
          </span>
          <span className="step-target process-summary">{stepSummary(tools, t).join(' · ')}</span>
          {hasNotice ? (
            <span className="step-meta num" data-find-skip>
              <FailedNote tools={tools} />
            </span>
          ) : (
            <span className="step-end" data-find-skip />
          )}
          <CaretRight size={11} className="step-caret" />
        </button>
      </div>
      {open && <div className="work-body">{work.items.map((it) => renderTimelineItem(it, expanded, false, undefined, t))}</div>}
    </div>
  );
});
