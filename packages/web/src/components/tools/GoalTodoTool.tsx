import { renderMarkdown } from '../../lib/markdown';
import type { Goal, Todo, ToolDisplay } from '../../lib/types';
import { CheckCircle, Circle, CircleNotch } from '../icons';

/**
 * A goal's criteria: met ones ticked in green ink, with how they were shown to be met. The one being worked on
 * turns only while the agent is at work (`live`); between turns, and in a tool result's copy, it stands still.
 */
export function GoalList({ goal, live = false }: { goal: Goal; live?: boolean }) {
  return (
    <ol className="goal-criteria">
      {goal.criteria.map((c, i) => (
        <li
          key={i}
          className={c.done ? 'is-done' : goal.active === i + 1 ? 'is-active' : ''}
          aria-current={!c.done && goal.active === i + 1 ? 'step' : undefined}
        >
          {c.done ? (
            <CheckCircle size={14} weight={c.proved ? 'fill' : 'regular'} />
          ) : goal.active === i + 1 ? (
            live ? (
              <CircleNotch size={14} className="spin" />
            ) : (
              <Circle size={14} weight="duotone" />
            )
          ) : (
            <Circle size={14} />
          )}
          <span className="goal-text">{c.text}</span>
          {c.evidence && <span className="goal-evidence mono">{c.evidence}</span>}
        </li>
      ))}
    </ol>
  );
}

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todos">
      {todos.map((x, i) => (
        <li key={i} className={`todo is-${x.status}`}>
          <span className="todo-box" aria-hidden />
          <span className="todo-text">{x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content}</span>
        </li>
      ))}
    </ul>
  );
}

export function QuestionView({ d }: { d: Extract<ToolDisplay, { kind: 'question' }> }) {
  return (
    <dl className="qa plate">
      {d.questions.map((q) => (
        <div key={q.question}>
          <dt>{q.question}</dt>
          <dd>{d.answers[q.question] ?? '–'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PlanView({ d }: { d: Extract<ToolDisplay, { kind: 'plan' }> }) {
  return <div className="md plate prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.plan) }} />;
}
