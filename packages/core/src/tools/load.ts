import type { ToolDef } from './types';

export interface LoadToolsInput {
  names: string[];
}

/**
 * Tools a session rarely needs (painting, the browser, music, film, watching a video, attempts) are listed in short: their
 * definitions were a third of every request's opening (2026-11-02). Loading one gives its whole definition here, at
 * the end of the conversation, and the tool list stays as it was: a provider's prompt cache starts with the list, so
 * a tool added to it halfway made the next request's whole input uncached.
 */
export const loadToolsTool: ToolDef<LoadToolsInput> = {
  kind: 'read',
  readOnly: true,
  title: (i) => `Load ${i.names.join(', ')}`,
  async execute(input, ctx) {
    const asked = [...new Set((input.names ?? []).map((n) => n.trim()).filter(Boolean))];
    if (!asked.length || !ctx.loadTools) return { content: 'Name the tools to load.', isError: true };
    const { loaded, unknown, text } = ctx.loadTools(asked);
    const parts = [text, unknown.length ? `No tool is called ${unknown.join(', ')}.` : ''].filter(Boolean);
    return { content: parts.join('\n\n'), isError: !loaded.length };
  },
};
