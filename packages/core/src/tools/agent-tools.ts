import type { Question, Todo } from '../types';
import { oneLine } from '../util/text';
import type { ToolDef } from './types';

export interface TodoInput {
  todos: Todo[];
  explanation?: string;
}

export const todoTool: ToolDef<TodoInput> = {
  kind: 'todo',
  readOnly: true,
  title: (i) => {
    const done = i.todos.filter((t) => t.status === 'completed').length;
    return `Plan ${done}/${i.todos.length}`;
  },
  async execute(input, ctx) {
    ctx.setTodos(input.todos);
    const done = input.todos.filter((t) => t.status === 'completed').length;
    const active = input.todos.filter((t) => t.status === 'in_progress').length;
    const warn = active > 1 ? ' More than one item is in progress; keep exactly one in progress.' : '';
    return {
      content: `Todo list updated: ${done} done, ${active} in progress, ${input.todos.length - done - active} pending.${warn} Keep it current as you work and mark each item completed as soon as it is done.`,
      display: { kind: 'todo', todos: input.todos },
    };
  },
};

export interface TaskInput {
  description: string;
  prompt: string;
  agent: string;
  /** general: the files (paths, folders or globs) it may change. */
  files?: string[];
  /** A model (provider/model) and effort other than the session's sub-agent defaults, when asked for. */
  model?: string;
  effort?: string;
  /** Run while the caller goes on with other work; the report comes back as a message when it is done. */
  background?: boolean;
}

export const taskTool: ToolDef<TaskInput> = {
  kind: 'task',
  readOnly: true,
  title: (i) => `Agent: ${oneLine(i.description, 80)}`,
  async execute(input, ctx) {
    const r = await ctx.runSubagent(input);
    // No session means it never started: the reason is a refusal, not a failure of its work.
    if (r.error) return { content: r.sessionId ? `The sub-agent failed: ${r.error}${r.text ? `\nPartial report:\n${r.text}` : ''}` : `Not started: ${r.error}`, isError: true };
    return {
      content: r.text || '(the sub-agent returned no report)',
      display: { kind: 'task', description: input.description, agent: input.agent, steps: r.steps, tokens: r.tokens, childSession: r.sessionId, files: input.files, changed: r.changed, model: r.model, effort: r.effort, durationMs: r.durationMs, ...(r.background ? { background: true } : {}), ...(r.stopped ? { stopped: true } : {}) },
    };
  },
};

export interface AttemptsInput {
  /** The complete brief: the attempts see nothing of this conversation. */
  task: string;
  count?: number;
  /** A command whose success decides; without it, the project's own checks. */
  check?: string;
}

/**
 * Several attempts at one task at the same time, each in its own copy of the repository, scored by the
 * project's checks; a judge picks among the best, and only the chosen change is applied here.
 */
export const attemptsTool: ToolDef<AttemptsInput> = {
  kind: 'task',
  readOnly: false,
  title: (i) => `Attempts ×${Math.min(5, Math.max(2, i.count ?? 3))}: ${oneLine(i.task, 70)}`,
  async execute(input, ctx) {
    if (!ctx.runAttempts) return { content: 'Parallel attempts are only for the main agent.', isError: true };
    return ctx.runAttempts({ task: input.task, count: Math.min(5, Math.max(2, Math.round(input.count ?? 3))), check: input.check });
  },
};

export interface AskInput {
  questions: Question[];
}

export const askTool: ToolDef<AskInput> = {
  kind: 'ask',
  readOnly: true,
  title: (i) => `Ask: ${oneLine(i.questions[0]?.question ?? '', 100)}`,
  async execute(input, ctx) {
    const answers = await ctx.ask(input.questions);
    if (!answers) {
      return {
        content: 'Nobody is available to answer right now. Continue with your best judgment, and state the assumption you made in your final summary.',
        display: { kind: 'question', questions: input.questions, answers: {} },
      };
    }
    const lines = input.questions.map((q) => `"${q.question}" -> ${answers[q.question] ?? '(no answer)'}`);
    return {
      content: `The user answered:\n${lines.join('\n')}\nProceed with these answers.`,
      display: { kind: 'question', questions: input.questions, answers },
    };
  },
};

export interface PlanInput {
  plan: string;
  /** The pieces of work in order: on approval they become the goal, the progress the user follows. */
  steps?: string[];
}

/** A plan's first line, for the goal it turns into. */
const planTitle = (plan: string) => oneLine(plan.split('\n').find((l) => l.trim())?.replace(/^[#*\s]+|\**$/g, '') ?? 'The plan', 120);

export const planTool: ToolDef<PlanInput> = {
  kind: 'plan',
  readOnly: true,
  title: () => 'Plan ready for review',
  async execute(input, ctx) {
    if (ctx.mode !== 'plan') return { content: 'Plan mode is not active; go ahead with the work.' };
    const verdict = await ctx.approvePlan(input.plan);
    // Stopped while the card waited: the user said nothing about the plan, and the result must not say they did.
    if (ctx.signal.aborted) return { content: 'The turn was stopped before the user answered; the plan has no verdict yet.', display: { kind: 'plan', plan: input.plan, approved: false } };
    // Nobody approved it, so nothing starts: a plan run on its own ends with the plan.
    if (!verdict && process.env.FAVILLA_ACCEPT_PLANS !== '1') {
      return { content: 'Nobody is here to approve this, so the plan stands as your answer: end your turn with it, in a line or two. Nothing was changed.', display: { kind: 'plan', plan: input.plan, approved: false } };
    }
    if (!verdict || verdict.approved) {
      ctx.setMode('build');
      const steps = (input.steps ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 12);
      if (steps.length) ctx.setGoal({ objective: planTitle(input.plan), criteria: steps.map((text) => ({ text, done: false })), by: 'model', updated: Date.now() });
      return {
        content: `${verdict ? 'The user approved the plan.' : 'The plan is accepted.'} Plan mode is off: you can now edit files and run commands. Work through the plan${steps.length ? '. Its steps are now the goal: mark each as it is done' : ''}.${verdict?.feedback ? `\nUser notes: ${verdict.feedback}` : ''}`,
        display: { kind: 'plan', plan: input.plan, approved: true },
      };
    }
    return {
      content: `The user did not approve the plan yet. Stay in plan mode and revise it.${verdict.feedback ? `\nTheir feedback: ${verdict.feedback}` : ''}`,
      display: { kind: 'plan', plan: input.plan, approved: false },
    };
  },
};
