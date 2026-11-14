import { useState } from 'react';
import type { Goal } from '../lib/types';
import { actions, toast, useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { GoalList, TodoList } from './ToolEntry';
import { CaretRight, ListChecks } from './icons';

/**
 * Pinned above the conversation like a work order on the board: the agent's own done criteria: the objective, one graduation mark per criterion (inked when met) and the count,
 * and open, the criteria. The agent keeps them with its criteria tool; the user states what they want with /goal.
 */
export function GoalCard() {
  const t = useT();
  const goal = useStore((s) => s.session?.meta.goal);
  const steps = useStore((s) => s.session?.todos ?? []);
  const working = useStore((s) => s.session?.status === 'running' || s.session?.status === 'compacting');
  const [open, setOpen] = useState(false);
  if (!goal && !steps.length) return null;
  // Tool surfaces with a plan tool of their own (Claude's, Codex's) keep steps; they show in the same card.
  const g: Goal = goal ?? { objective: t('Plan'), criteria: steps.map((x) => ({ text: x.content, done: x.status === 'completed' })), by: 'model', updated: 0 };
  const done = g.criteria.filter((c) => c.done).length;
  const total = g.criteria.length;
  const complete = total > 0 && done === total;
  return (
    <section className={`goal-card ${open ? 'is-open' : ''} ${complete ? 'is-complete' : ''}`} aria-label={t('Done when')}>
      <button type="button" className="goal-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ListChecks size={14} weight={complete ? 'bold' : 'regular'} className="goal-flag" />
        <span className="goal-objective">{g.objective}</span>
        {total > 0 && (
          <span className="goal-ticks" aria-hidden>
            {g.criteria.map((c, i) => (
              <i key={i} className={c.done ? 'is-done' : g.active === i + 1 ? 'is-active' : ''} />
            ))}
          </span>
        )}
        {total > 0 && <span className="goal-count num">{`${done}/${total}`}</span>}
        <CaretRight size={11} className="goal-caret" />
      </button>
      {open && (
        <div className="goal-body">
          {goal && (total ? <GoalList goal={goal} live={working} /> : <p className="goal-empty">{t('The agent adds the criteria when it starts.')}</p>)}
          {goal && steps.length > 0 && <TodoList todos={steps} />}
          {!goal && <TodoList todos={steps} />}
          {goal && (
            <div className="goal-actions">
              <button type="button" className="link" onClick={() => actions.settings({ goal: null }).catch((e) => toast(String(e), 'error'))}>
                {t('Clear')}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
