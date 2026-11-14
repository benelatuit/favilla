import fs from 'node:fs';
import { displayPath, resolvePath } from '../util/paths';
import { readTool } from './fs-tools';
import { globTool, grepTool } from './search-tools';
import { searchCode } from './codesearch';
import type { ImagePart } from '../types';
import type { ToolDef } from './types';

const MAX_FILES = 40;

export interface ReadManyInput {
  /** Files, folders or images; a file may carry a line range: "src/app.ts:120-200" or "src/app.ts:120". */
  paths: string[];
  offset?: number;
  limit?: number;
  outline?: boolean;
  /** For one image: the part to show enlarged. */
  region?: number[];
}

/** "path:120-200" → the path and its range, unless a file is really named like that. */
function withRange(spec: string, cwd: string): { path: string; offset?: number; limit?: number } {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(spec.trim());
  if (!m || fs.existsSync(resolvePath(cwd, spec))) return { path: spec };
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : undefined;
  return { path: m[1], offset: start, limit: end && end >= start ? end - start + 1 : undefined };
}

/** The single-file reader speaks of offset and limit; this surface asks for ranges in the path. */
function rangeHints(text: string, path: string): string {
  return text
    .replace(/Use offset and limit to read further\./, `Read further with a range, e.g. "${path}:START-END".`)
    .replace('(offset and limit count pages in a PDF)', '(a range counts pages in a PDF)')
    .replace(/Continue with offset=(\d+)\./, (_, n) => `Continue with "${path}:${n}".`)
    .replace(/; offset (\d+) is past the end\./, '; that range is past the end.');
}

/**
 * Reads one or several files in a single call. Each is read as a single read would be (line numbers,
 * images attached, folders listed, notebooks as cells) under a "==> path <==" header, drawing from a shared
 * remaining-character pool so short files leave full room for longer siblings without flooding small windows.
 */
export const readManyTool: ToolDef<ReadManyInput> = {
  kind: 'read',
  readOnly: true,
  title: (i, cwd) => {
    if (i.paths.length === 1) return readTool.title(withRange(i.paths[0], cwd), cwd);
    const names = i.paths.map((p) => displayPath(cwd, resolvePath(cwd, withRange(p, cwd).path)));
    return names.length <= 8 ? `Read ${names.join(', ')}` : `Read ${names.slice(0, 6).join(', ')} (+${names.length - 6} more)`;
  },
  async execute(input, ctx) {
    const rawPaths = [...new Set(input.paths.map((p) => p.trim()).filter(Boolean))];
    const specs = (rawPaths.length ? rawPaths : input.paths).map((p) => withRange(p, ctx.cwd));
    if (specs.length === 1) {
      const s = specs[0];
      const r = await readTool.execute({ path: s.path, offset: s.offset ?? input.offset, limit: s.limit ?? input.limit, outline: input.outline && !s.offset, overview: true, region: input.region }, ctx);
      return { ...r, content: rangeHints(r.content, s.path) };
    }
    const list = specs.slice(0, MAX_FILES);
    // Reading all needed files in one turn saves round-trips while putting the same source text into context;
    // cap the whole batch at three reads' worth (~30% of window) and share whatever remains across the files left,
    // stopping cleanly at a file boundary rather than chopping a few lines off every file.
    const totalBudget = ctx.outputChars * 3;
    const parts: string[] = [];
    const images: ImagePart[] = [];
    const items: string[] = [];
    let failed = 0;
    let used = 0;
    let budgetStopped = false;
    for (let i = 0; i < list.length; i++) {
      if (i > 0 && used >= totalBudget) {
        budgetStopped = true;
        break;
      }
      const s = list[i];
      const share = Math.min(ctx.outputChars, Math.max(8000, Math.floor((totalBudget - used) / (list.length - i))));
      // region is the same part of every image: before and after shots compared at one spot. It was dropped here,
      // and a model that read three screenshots' button with it got three whole pages back (2026-11-05).
      const r = await readTool.execute({ path: s.path, offset: s.offset, limit: s.limit, outline: input.outline && !s.offset, overview: true, region: input.region }, { ...ctx, outputChars: share });
      const shown = displayPath(ctx.cwd, resolvePath(ctx.cwd, s.path));
      const block = `==> ${shown}${s.offset ? `:${s.offset}` : ''} <==\n${rangeHints(r.content, s.path)}`;
      parts.push(block);
      used += block.length + 2;
      if (r.images) images.push(...r.images);
      if (r.isError) failed++;
      const d = r.display;
      items.push(d?.kind === 'file' && !d.image ? `${shown}  ${d.lineCount < d.totalLines ? `${d.startLine}-${d.startLine + d.lineCount - 1} / ${d.totalLines}` : `${d.totalLines} lines`}` : shown);
    }
    const more = parts.length < specs.length ? `\n\n[Read ${parts.length} of ${specs.length} files${budgetStopped ? ' (output limit reached)' : ''}; ask for the rest in another call.]` : '';
    return {
      content: parts.join('\n\n') + more,
      images: images.length ? images : undefined,
      isError: (parts.length > 0 && failed === parts.length) || undefined,
      display: { kind: 'list', title: `${parts.length} files`, items, total: parts.length },
    };
  },
};

export interface SearchInput {
  /** Regex searched in file contents. */
  pattern?: string;
  /** What the code does, in plain words: the definitions that match, ranked (when no exact word is known). */
  query?: string;
  /** File-name filter; alone, it lists matching files. */
  glob?: string;
  path?: string;
  mode?: 'content' | 'files' | 'count';
  context?: number;
  ignoreCase?: boolean;
  type?: string;
  limit?: number;
  multiline?: boolean;
}

/**
 * One search for contents and names: a pattern searches contents (matching lines grouped by file by
 * default, so the next step can go straight to a line), a glob alone lists files by name, both together
 * search inside the files the glob picks.
 */
export const searchTool: ToolDef<SearchInput> = {
  kind: 'grep',
  readOnly: true,
  title: (i, cwd) => (i.query && !i.pattern ? `Find code: ${i.query}` : i.pattern ? grepTool.title({ pattern: i.pattern, path: i.path, glob: i.glob }, cwd) : globTool.title({ pattern: i.glob ?? '', path: i.path }, cwd)),
  async execute(input, ctx) {
    if (input.query && !input.pattern) {
      const r = await searchCode(ctx.cwd, input.query, { limit: input.limit ? Math.min(input.limit, 20) : 8, signal: ctx.signal, under: input.path });
      if (!r.hits.length) return { content: `No code matches "${input.query}" among ${r.pieces} pieces of ${r.files} files. Try other words, or a pattern for an exact name.`, display: { kind: 'search', pattern: input.query, path: input.path ?? '.', matches: 0, files: 0, preview: '' } };
      const blocks = r.hits.map((h, i) => [`${i + 1}. ${h.file}:${h.start}-${h.end}`, `${String(h.line).padStart(6)}  ${h.head}`, ...h.lines.map((l) => `${String(l.n).padStart(6)}  ${l.text.trim()}`)].join('\n'));
      const preview = r.hits.flatMap((h) => [`${h.file}:${h.line}:${h.head}`, ...h.lines.map((l) => `${h.file}:${l.n}:${l.text}`)]).join('\n');
      return {
        content: `Code that matches "${input.query}", best first (ranked over ${r.pieces} pieces of ${r.files} files):\n\n${blocks.join('\n\n')}\n\nRead a range to see a piece whole; search with a pattern for exact names.`,
        display: { kind: 'search', pattern: input.query, path: input.path ?? '.', matches: r.hits.length, files: new Set(r.hits.map((h) => h.file)).size, preview },
      };
    }
    if (input.pattern) {
      const mode = input.mode ?? 'content';
      return grepTool.execute(
        { pattern: input.pattern, path: input.path, glob: input.glob, type: input.type, mode, ignoreCase: input.ignoreCase, context: input.context, limit: input.limit, multiline: input.multiline, grouped: mode === 'content' },
        ctx,
      );
    }
    if (input.glob) return globTool.execute({ pattern: input.glob, path: input.path }, ctx);
    return { content: 'Give a pattern to search file contents, a glob to find files by name (or both), or a query in plain words to find the code that does something.', isError: true };
  },
};
