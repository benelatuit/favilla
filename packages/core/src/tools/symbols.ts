import fs from 'node:fs';
import { displayPath, resolvePath } from '../util/paths';
import { oneLine } from '../util/text';
import type { ToolDef } from './types';

export interface SymbolsInput {
  path: string;
  line: number;
  /** The name on that line; without it, the column. */
  symbol?: string;
  column?: number;
  find: 'definition' | 'references';
}

/** Where a symbol is defined, or every place that uses it, from the project's language server. */
export const symbolsTool: ToolDef<SymbolsInput> = {
  kind: 'grep',
  readOnly: true,
  title: (i, cwd) => `${i.find === 'references' ? 'References to' : 'Definition of'} ${i.symbol ?? 'symbol'} at ${displayPath(cwd, resolvePath(cwd, i.path))}:${i.line}`,
  async execute(input, ctx) {
    const servers = ctx.languageServers?.();
    const abs = resolvePath(ctx.cwd, input.path);
    if (!fs.existsSync(abs)) return { content: `File not found: ${input.path}`, isError: true };
    if (!servers?.covers(abs)) return { content: 'No language server covers this file (TypeScript 7, pyright, gopls or rust-analyzer). Use search instead.', isError: true };
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const text = lines[input.line - 1];
    if (text === undefined) return { content: `${input.path} has only ${lines.length} lines.`, isError: true };
    let column = input.column;
    if (input.symbol) {
      const m = new RegExp(`(?<![\\w$])${input.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).exec(text);
      if (!m) return { content: `"${input.symbol}" is not on line ${input.line} of ${input.path}: ${oneLine(text, 160)}`, isError: true };
      column = m.index + 1;
    }
    if (!column) return { content: 'Give symbol (the name on that line) or column.', isError: true };
    let found;
    try {
      found = input.find === 'references' ? await servers.references(abs, input.line, column) : await servers.definition(abs, input.line, column);
    } catch (e) {
      return { content: `The language server could not answer: ${(e as Error).message}`, isError: true };
    }
    if (!found?.length) return { content: `No ${input.find === 'references' ? 'references' : 'definition'} found.` };
    const cache = new Map<string, string[]>();
    const show = found.slice(0, 60).map((l) => {
      let src = cache.get(l.file);
      if (!src) {
        try {
          src = fs.readFileSync(l.file, 'utf8').split(/\r?\n/);
        } catch {
          src = [];
        }
        cache.set(l.file, src);
      }
      return `${displayPath(ctx.cwd, l.file)}:${l.line}:${l.column}  ${oneLine(src[l.line - 1] ?? '', 140).trim()}`;
    });
    return {
      content: `${found.length} ${input.find === 'references' ? `place${found.length === 1 ? '' : 's'} use it` : `definition${found.length === 1 ? '' : 's'}`}:\n${show.join('\n')}${found.length > show.length ? `\n… ${found.length - show.length} more` : ''}`,
      display: { kind: 'list', title: input.symbol ?? input.path, items: show, total: found.length },
    };
  },
};
