import { memo } from 'react';
import { foldKey, isLookRowTool, useFoldOpen, type LookGroupRow, type StepRow, type ToolStep } from '../../lib/fold-state';
import { fill, useT } from '../../lib/i18n';
import { stepOutcome } from '../../lib/steps';
import { Binoculars, CaretRight, CircleNotch } from '../icons';
import { stepWhat } from '../tools/icons';
import { useSessionScope } from '../tools/SessionScope';
import { ToolEntry } from '../tools/ToolEntry';
import { Thought, ThoughtRun } from './ThoughtBlock';

export function sameStepRow(a: StepRow, b: StepRow): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === 'run') {
    return b.kind === 'run' && a.keys.length === b.keys.length && a.keys.every((k, i) => k === b.keys[i] && a.texts[i] === b.texts[i]);
  }
  if (a.kind === 'reasoning') {
    return b.kind === 'reasoning' && a.text === b.text && a.live === b.live;
  }
  return (
    b.kind === 'tool' &&
    a.id === b.id &&
    a.draftKey === b.draftKey &&
    a.opaque === b.opaque &&
    a.name === b.name &&
    a.title === b.title &&
    a.input === b.input &&
    a.result === b.result &&
    a.live === b.live &&
    a.forming === b.forming
  );
}

export function drawStepRow(s: StepRow) {
  if (s.kind === 'run') return <ThoughtRun key={s.key} texts={s.texts} keys={s.keys} />;
  if (s.kind === 'reasoning') return <Thought key={s.key} id={s.key} text={s.text} live={s.live} />;
  return (
    <ToolEntry
      key={s.draftKey ?? s.key}
      callId={s.id}
      draftKey={s.draftKey}
      opaque={s.opaque}
      name={s.name}
      title={s.title}
      input={s.input}
      result={s.result}
      running={s.live}
      forming={s.forming}
    />
  );
}

export function drawStepRows(rows: readonly StepRow[]) {
  return rows.map(drawStepRow);
}

const shortWhat = (s: ToolStep) => {
  const w = stepWhat(s.name, s.title, s.input);
  return w.length > 28 ? `${w.slice(0, 27)}…` : w;
};

/** What failed, was denied, or was cancelled in a folded run of steps. */
export function FailedNote({ tools }: { tools: readonly ToolStep[] }) {
  const t = useT();
  const broke = tools.filter((s) => stepOutcome(s) === 'failed');
  if (broke.length) {
    const said = broke.length === 1 && shortWhat(broke[0]);
    return <span className="process-failed">{said ? fill(t('Failed: {n}'), said) : fill(t('{n} steps failed'), broke.length)}</span>;
  }
  const denied = tools.filter((s) => stepOutcome(s) === 'denied');
  if (denied.length) {
    return <span className="process-denied">{t('Denied')}</span>;
  }
  const cancelled = tools.filter((s) => stepOutcome(s) === 'cancelled');
  if (cancelled.length) {
    return <span className="process-cancelled">{t('Cancelled')}</span>;
  }
  return null;
}

/** What a run of strictly read-only steps looked at, as one line that opens to the steps. */
export const LookGroup = memo(
  function LookGroup({ row, fold }: { row: LookGroupRow; fold: boolean }) {
    const t = useT();
    const { sessionId } = useSessionScope();
    const [open, toggleOpen] = useFoldOpen(sessionId, foldKey.look(row), !fold, row.key);
    const tools = row.rows.filter(isLookRowTool);
    const working = tools.some((s) => !!s.live || s.forming !== undefined);
    const what = [...new Set(tools.map((s) => stepWhat(s.name, s.title, s.input)).filter(Boolean))];
    return (
      <div className={`look-run ${open ? 'is-open' : ''}`}>
        <div className={`step ${open ? 'is-open' : ''} ${working ? 'is-running' : ''}`}>
          <button type="button" className={`step-head look-head ${open ? 'is-open' : ''}`} onClick={toggleOpen} aria-expanded={open}>
            <span className="step-icon">{working ? <CircleNotch size={14} className="spin" /> : <Binoculars size={16} />}</span>
            <span className="step-verb" data-find-skip>
              {t(working ? 'Exploring' : 'Explored')}
            </span>
            <span className="step-target">{what.join(' · ')}</span>
            <span className="step-meta num" data-find-skip>
              {fill(t('{n} steps'), tools.length)}
              <FailedNote tools={tools} />
            </span>
            <CaretRight size={11} className="step-caret" />
          </button>
        </div>
        {open && <div className="look-steps">{drawStepRows(row.rows)}</div>}
      </div>
    );
  },
  (a, b) =>
    a.fold === b.fold &&
    a.row.anchorKey === b.row.anchorKey &&
    a.row.rows.length === b.row.rows.length &&
    a.row.rows.every((r, i) => sameStepRow(r, b.row.rows[i])),
);
