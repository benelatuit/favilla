import type { Goal } from '../types';
import { oneLine } from '../util/text';
import type { ToolDef } from './types';

export interface GoalInput {
  objective?: string;
  /** Replaces the criteria: each a checkable statement of done. */
  criteria?: string[];
  /** 1-based numbers of criteria now met. */
  done?: number[];
  /** How they were shown to be met (a test run, a command's output). */
  evidence?: string;
  /** The criterion being worked on now (long work). */
  active?: number;
  clear?: boolean;
}

const MAX_CRITERIA = 12;

/** The criteria as the model reads them back: the objective, each criterion with its state, what is still open. */
export function formatGoal(g: Goal): string {
  const open = g.criteria.filter((c) => !c.done).length;
  const lines = g.criteria.map((c, i) => `${c.done ? '[x]' : c.claimed ? '[~]' : '[ ]'} ${i + 1}. ${c.text}${c.claimed && !c.done ? ' (claimed, for the review)' : ''}${!c.done && !c.claimed && g.active === i + 1 ? ' (working on it)' : ''}`);
  return `Objective: ${g.objective}\n${lines.join('\n')}${lines.length ? '\n' : ''}${!g.criteria.length ? 'No criteria yet.' : open ? `${open} open.` : 'Every criterion is met.'}`;
}

export function openCriteria(g: Goal | undefined): { n: number; text: string }[] {
  return (g?.criteria ?? []).map((c, i) => ({ n: i + 1, text: c.text, done: c.done })).filter((c) => !c.done);
}

/**
 * The agent's criteria for done, kept as meta.goal (the tool was called goal until 2026-11-05): what the work is for
 * and how to tell it is done. The harness keeps them through compaction, shows them to the user, reminds the model of
 * them on long runs and checks them before the model stops.
 */
export const goalTool: ToolDef<GoalInput> = {
  kind: 'goal',
  readOnly: true,
  title: (i) => (i.clear ? 'Clear the criteria' : i.objective ? `Criteria: ${oneLine(i.objective, 90)}` : i.done?.length ? `Met: ${i.done.join(', ')}` : 'Criteria'),
  async execute(input, ctx) {
    if (input.clear) {
      if (ctx.goal()?.by === 'brief') return { content: 'The brief sets these criteria; they stay until the result has been reviewed.', isError: true };
      ctx.setGoal(undefined);
      return { content: 'Goal cleared.' };
    }
    const current = ctx.goal();
    let g: Goal | undefined = current ? structuredClone(current) : undefined;
    const criteria = (input.criteria ?? []).map((t) => t.trim()).filter(Boolean);
    // A brief sets the bar after looking at real examples; the maker works to it and does not lower it.
    if (g?.by === 'brief' && (criteria.length || input.objective?.trim())) return { content: `The criteria come from the brief and stay as they are until the result has been reviewed: work to them.\n${formatGoal(g)}`, isError: true };
    if (input.objective?.trim() || criteria.length) {
      const objective = input.objective?.trim() || g?.objective;
      if (!objective) return { content: 'Give the objective: one sentence on what the work is for.', isError: true };
      // New criteria start a new checklist; keeping the objective alone keeps the old one.
      g = {
        objective,
        criteria: criteria.length ? criteria.slice(0, MAX_CRITERIA).map((text) => ({ text, done: false })) : (g?.criteria ?? []),
        by: 'model',
        updated: Date.now(),
      };
    }
    if (!g) return { content: 'No criteria yet. Give objective and criteria.', isError: true };
    if (input.active !== undefined) {
      if (!g.criteria[input.active - 1]) return { content: `There is no criterion ${input.active}; there are ${g.criteria.length}.\n${formatGoal(g)}`, isError: true };
      g.active = input.active;
    }
    for (const n of input.done ?? []) {
      const c = g.criteria[n - 1];
      if (!c) return { content: `There is no criterion ${n}; there are ${g.criteria.length}.\n${formatGoal(g)}`, isError: true };
      // On a brief's goal the maker's word is a claim: a reviewer who did not make the work marks it.
      if (g.by === 'brief') c.claimed = true;
      else {
        c.done = true;
        c.proved = undefined;
      }
      if (input.evidence?.trim()) c.evidence = oneLine(input.evidence, 200);
    }
    g.updated = Date.now();
    ctx.setGoal(g);
    const claimedNow = g.by === 'brief' && input.done?.length ? `\nClaimed ${input.done.join(', ')}: when you finish, a reviewer who has not seen the work checks every criterion against the result, and only the review marks them met.` : '';
    return { content: `${formatGoal(g)}${claimedNow}`, display: { kind: 'goal', goal: g } };
  },
};
