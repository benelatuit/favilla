import fs from 'node:fs';
import { displayPath } from '../util/paths';
import { makeDiff } from './diffutil';
import { formatGoal } from './goal';
import type { Message } from '../types';
import type { ToolDef } from './types';

export interface ReviewInput {
  /** What to look at most closely (a risk the author sees, a part they are unsure of). */
  focus?: string;
}

const MAX_DIFF = 60_000;
const MAX_ASK = 8000;

/**
 * What the user asked, in their own words: this turn's messages, and the one before when this turn only says to go
 * on. The goal is the author's reading of the request; a reviewer who sees only that cannot tell a fix that covers
 * the example from one that covers what was asked.
 */
export function askedThisTurn(history: Message[], turn: string): string {
  const own = (m: Message) =>
    m.parts
      .filter((p) => p.type === 'text' && !p.synthetic)
      .map((p) => (p as { text: string }).text)
      .join('\n')
      .trim();
  const users = history.filter((m) => m.role === 'user' && m.origin === 'user');
  let text = users
    .filter((m) => m.turn === turn)
    .map(own)
    .filter(Boolean)
    .join('\n\n');
  if (text.length < 200) {
    const before = users
      .filter((m) => m.turn !== turn)
      .map(own)
      .filter(Boolean)
      .at(-1);
    if (before) text = `${before}\n\n${text}`.trim();
  }
  return text.length > MAX_ASK ? `${text.slice(0, MAX_ASK)}\n…` : text;
}

/**
 * A second pair of eyes before finishing: a read-only sub-agent gets the session's net change (every file
 * as it was before its first edit against how it is now) and the goal, reads around it as it needs, and
 * reports bugs, unmet criteria, missed edge cases and missing tests. Its context is fresh, so it reads the
 * change as a reviewer does, without the author's assumptions.
 */
export const reviewTool: ToolDef<ReviewInput> = {
  kind: 'task',
  readOnly: true,
  title: (i) => `Review the change${i.focus ? `: ${i.focus.slice(0, 80)}` : ''}`,
  async execute(input, ctx) {
    // Each file as it was before the first edit in this session, against what it is now.
    const first = new Map<string, string | null>();
    for (const turn of ctx.checkpoints.turns()) {
      for (const c of ctx.checkpoints.changes(turn)) if (!first.has(c.path)) first.set(c.path, c.before);
    }
    const files = [...first].map(([abs, before]) => {
      const shown = displayPath(ctx.cwd, abs);
      let after: string | null = null;
      try {
        after = fs.readFileSync(abs, 'utf8');
      } catch {
        after = null;
      }
      return makeDiff(shown, before, after, before === null ? 'add' : after === null ? 'delete' : 'update');
    });
    const changed = files.filter((f) => f.added || f.removed);
    if (!changed.length) return { content: 'Nothing to review: no file was changed in this session.' };
    let diff = changed.map((f) => `--- ${f.path} (${f.op}, +${f.added} -${f.removed})\n${f.patch}`).join('\n\n');
    if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n… (the rest of the change is cut; read the files for it)`;
    const goal = ctx.goal();
    const asked = askedThisTurn(ctx.history?.() ?? [], ctx.turn);
    const prompt = [
      'Review a change to this project as a careful senior engineer would. You can read and search the code (read-only): look at the surrounding code, callers and tests wherever the diff alone does not settle a question.',
      'Check relevant callers and existing guards before reporting a defect. Separate code-proven facts from assumptions; state the concrete cause, supported impact and any missing decisive fact. A suspicious pattern alone is not a finding.',
      asked ? `What the user asked, in their words:\n<request>\n${asked}\n</request>` : '',
      goal ? `The author's goal for the change:\n${formatGoal(goal)}` : '',
      input.focus ? `The author asks you to look closely at: ${input.focus}` : '',
      `The change, as unified diffs against each file before it was first edited:\n${diff}`,
      'Report, most serious first:\n1. Bugs and wrong behaviour, each with path:line and why, including what worked before the change and no longer does (other inputs, options that skip the changed code, values it should pass through untouched).\n2. What the request or the goal asks that the change does not do. Judge against the request itself: does the change fix the rule the request is about, or only the example it shows? Look for other inputs, positions, branches and callers that reach the same defect; a special case added where a shared function is wrong is a bug. Then edge cases it misses (empty, boundary and malformed input, error paths, concurrency where it applies).\n3. Tests missing for what changed.\nSkip style preferences. Do not suggest rewrites the goal does not need. If nothing needs fixing, say "No issues found." Keep it under 300 words.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const r = await ctx.runSubagent({ description: 'Review the change', prompt, agent: 'explore' });
    if (r.error) return { content: `The review failed: ${r.error}${r.text ? `\nPartial report:\n${r.text}` : ''}`, isError: true };
    return {
      content: `Review of ${changed.length} changed file${changed.length === 1 ? '' : 's'}:\n${r.text || '(no report)'}`,
      display: { kind: 'task', description: 'Review the change', agent: 'review', steps: r.steps, tokens: r.tokens, childSession: r.sessionId },
    };
  },
};
