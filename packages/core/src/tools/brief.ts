import type { ToolDef } from './types';
import { askedThisTurn } from './review';

export interface BriefInput {
  note?: string;
}

export const BRIEF_TITLE = 'Find out what the request needs';

export const briefTool: ToolDef<BriefInput> = {
  kind: 'task',
  readOnly: true,
  title: () => BRIEF_TITLE,
  async execute(input, ctx) {
    const asked = askedThisTurn(ctx.history?.() ?? [], ctx.turn);
    return ctx.makeBrief(input.note ? `${asked}\n\nThe maker adds: ${input.note}` : asked);
  },
};
