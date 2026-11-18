import fs from 'node:fs';
import path from 'node:path';
import { displayPath, isWindows, resolvePath } from '../util/paths';
import { fileListLabels } from '../util/file-list';
import { decodeFile, encode1252, encodeGbk, isProbablyBinary, truncateEnd, type TextEncoding } from '../util/text';
import { newestFirst, runRipgrep, SEARCH_LIMIT_MS } from './ripgrep';
import type { ToolDef } from './types';

const EXCLUDES = ['!.git', '!node_modules', '!.venv', '!venv', '!__pycache__', '!.next', '!.turbo', '!.cache'];

function excludeArgs(searchPath: string): string[] {
  // Searching inside an excluded folder on purpose: do not exclude it.
  return EXCLUDES.filter((g) => !searchPath.replace(/\\/g, '/').split('/').includes(g.slice(1))).flatMap((g) => ['--glob', g]);
}

function slash(s: string): string {
  return isWindows ? s.replace(/\\/g, '/') : s;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  mode?: 'content' | 'files' | 'count';
  ignoreCase?: boolean;
  before?: number;
  after?: number;
  context?: number;
  lineNumbers?: boolean;
  limit?: number;
  multiline?: boolean;
  /** Content results under one heading per file instead of the path on every line. */
  grouped?: boolean;
}

const LEGACY: { label: string; encoding: TextEncoding; name: string; holds: (text: string) => boolean }[] = [
  { label: 'windows-1252', encoding: 'cp1252', name: 'Windows-1252', holds: (t) => !!encode1252(t) },
  { label: 'gbk', encoding: 'gbk', name: 'GBK', holds: (t) => !!encodeGbk(t) },
];

/**
 * The same search in the files that are not UTF-8. rg reads every file as UTF-8, so a pattern with a character above
 * ASCII never matched in a Windows-1252 or GBK file ("Straße" has ß as one byte there) and the answer looked
 * complete: a string found in the code and not in the legacy files that hold it too. For each encoding that can
 * hold the pattern's characters rg names the files that match when read that way; those that really are in that
 * encoding (a UTF-8 file read as Windows-1252 matches by accident) are searched again as the request asked.
 */
async function legacySearch(common: string[], shape: string[], pattern: string, where: string, listOnly: boolean, cwd: string, signal: AbortSignal): Promise<{ out: string[]; files: string[]; note: string } | null> {
  const above = [...pattern].filter((ch) => ch.codePointAt(0)! > 0x7f).join('');
  if (!above) return null;
  const out: string[] = [];
  const all: string[] = [];
  const said: string[] = [];
  for (const enc of LEGACY) {
    if (!enc.holds(above)) continue;
    const listed = await runRipgrep([...common, '-l', '-E', enc.label, '--regexp', pattern, where], cwd, signal);
    if (listed.code !== 0) continue;
    const files = listed.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 400)
      .filter((f) => {
        try {
          const abs = path.resolve(cwd, f);
          if (fs.statSync(abs).size > 4_000_000) return false;
          const buf = fs.readFileSync(abs);
          return !isProbablyBinary(buf) && decodeFile(buf).encoding === enc.encoding;
        } catch {
          return false;
        }
      })
      .slice(0, 60);
    if (!files.length) continue;
    if (listOnly) out.push(files.join('\n'));
    else {
      const again = await runRipgrep([...common, ...shape, '--with-filename', '-E', enc.label, '--regexp', pattern, ...files], cwd, signal);
      if (!again.stdout.trim()) continue;
      out.push(again.stdout.replace(/\s+$/, ''));
    }
    all.push(...files);
    said.push(`${files.map((f) => slash(f.replace(/^\.[\\/]/, ''))).slice(0, 6).join(', ')}${files.length > 6 ? ` and ${files.length - 6} more` : ''} ${files.length === 1 ? 'is' : 'are'} ${enc.name}`);
  }
  return all.length ? { out, files: all, note: `Not UTF-8: ${said.join('; ')}.` } : null;
}

/** rg's output without what it said of `files`, whose own search follows: a path's lines, or its block under a heading. */
function withoutFiles(stdout: string, files: string[], grouped: boolean): string {
  const drop = new Set(files);
  if (grouped) {
    return stdout
      .replace(/\s+$/, '')
      .split(/\r?\n\r?\n/)
      .filter((block) => block && !drop.has(block.split(/\r?\n/)[0]))
      .join('\n\n');
  }
  return stdout
    .split(/\r?\n/)
    .filter((l) => l && !files.some((f) => l === f || (l.startsWith(f) && /^[:-]/.test(l.slice(f.length)))))
    .join('\n');
}

/** rg --heading output: a path, its numbered lines, a blank line before the next path. */
function groupedResult(stdout: string, limit: number): { body: string; matches: number; files: number; shown: number; preview: string[] } {
  const all = stdout.replace(/\s+$/, '').split(/\r?\n/);
  const isLine = (l: string) => /^\d+[:-]/.test(l) || l === '--';
  const matches = all.filter((l) => /^\d+:/.test(l)).length;
  const files = all.filter((l) => l && !isLine(l)).length;
  const kept = all.slice(0, limit).map((l) => (l && !isLine(l) ? slash(l.replace(/^\.[\\/]/, '')) : l));
  return { body: kept.join('\n'), matches, files, shown: kept.filter((l) => /^\d+:/.test(l)).length, preview: kept.filter(Boolean).slice(0, 60) };
}

export const grepTool: ToolDef<GrepInput> = {
  kind: 'grep',
  readOnly: true,
  title: (i) => `Search "${i.pattern}"${i.path ? ` in ${i.path}` : ''}${i.glob ? ` (${i.glob})` : ''}`,
  async execute(input, ctx) {
    const target = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;
    if (!fs.existsSync(target)) return { content: `Path not found: ${input.path}`, isError: true };
    const mode = input.mode ?? 'files';
    const grouped = !!input.grouped && mode === 'content';
    // What to search, then how the result is laid out: the search of files that are not UTF-8 takes the first as it is.
    const common = ['--color=never', grouped ? '--heading' : '--no-heading', '--hidden', '--max-columns=500', '--max-columns-preview', ...excludeArgs(input.path ?? '')];
    if (input.ignoreCase) common.push('-i');
    if (input.multiline) common.push('-U', '--multiline-dotall');
    if (input.glob) for (const g of input.glob.split(/[,\s]+(?![^{]*\})/).filter(Boolean)) common.push('--glob', g);
    if (input.type) common.push('--type', input.type);
    const shape: string[] = [];
    if (mode === 'files') shape.push('-l');
    else if (mode === 'count') shape.push('-c');
    else {
      if (input.lineNumbers !== false) shape.push('-n');
      if (input.context) shape.push('-C', String(input.context));
      else {
        if (input.before) shape.push('-B', String(input.before));
        if (input.after) shape.push('-A', String(input.after));
      }
    }
    const where = input.path ? slash(input.path) : '.';
    const args = [...common, ...shape, '--regexp', input.pattern, where];
    let r = await runRipgrep(args, ctx.cwd, ctx.signal);
    // A pattern copied from code is often not a regular expression at all (interface{}, f(x, a[i): rather than
    // answer with a parse error and wait to be asked again, search for it as it is written and say so.
    let plain = '';
    if (r.code === 2 && /regex parse error/.test(r.stderr)) {
      const literal = [...args];
      literal.splice(literal.lastIndexOf('--regexp'), 0, '--fixed-strings');
      r = await runRipgrep(literal, ctx.cwd, ctx.signal);
      plain = `"${input.pattern}" is not a valid regular expression, so it was searched as plain text.`;
    }
    let notUtf8 = '';
    if (r.code === 0 || r.code === 1) {
      const legacy = await legacySearch(plain ? [...common, '--fixed-strings'] : common, shape, input.pattern, where, mode === 'files', ctx.cwd, ctx.signal);
      if (legacy) {
        const kept = withoutFiles(r.stdout, legacy.files, grouped);
        r = { ...r, code: 0, stdout: [...(kept ? [kept] : []), ...legacy.out].join(grouped ? '\n\n' : '\n') };
        notUtf8 = legacy.note;
      }
    }
    const stopped = r.timedOut ? `The search stopped after ${SEARCH_LIMIT_MS / 1000} s; search a narrower path or glob.` : '';
    if (r.code === 1 || (!r.stdout.trim() && r.code === 0)) {
      return { content: `No matches for ${plain ? `the plain text "${input.pattern}"` : `/${input.pattern}/`}${input.path ? ` in ${input.path}` : ''}.${plain ? ' It is not a valid regular expression, so it was searched as it is written.' : ''}${stopped ? ` ${stopped}` : ''}`, display: { kind: 'search', pattern: input.pattern, path: input.path ?? '.', matches: 0, files: 0, preview: '' } };
    }
    if (r.code !== 0 && r.code !== null) return { content: `Search failed: ${r.stderr.trim() || `rg exited with ${r.code}`}`, isError: true };
    if (grouped) {
      const g = groupedResult(r.stdout, input.limit ?? 300);
      const cut = truncateEnd(g.body, ctx.outputChars);
      const partial = g.shown < g.matches || cut.truncated || r.truncated;
      const header = `${g.matches} matching line${g.matches === 1 ? '' : 's'} in ${g.files} file${g.files === 1 ? '' : 's'}${partial ? ` (showing ${g.shown}; narrow the path, glob or pattern for the rest)` : ''}:`;
      return {
        content: `${plain ? `[${plain}]\n` : ''}${header}\n${cut.text}${notUtf8 ? `\n\n[${notUtf8}]` : ''}`,
        display: { kind: 'search', pattern: input.pattern, path: input.path ?? '.', matches: g.matches, files: g.files, preview: g.preview.join('\n') },
      };
    }
    let lines = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => slash(l.replace(/^\.[\\/]/, '')));
    if (mode === 'files') lines = newestFirst(lines.slice(0, 5000), ctx.cwd);
    const total = lines.length;
    const limit = input.limit ?? (mode === 'content' ? 300 : 200);
    lines = lines.slice(0, limit);
    let body = lines.join('\n');
    const cut = truncateEnd(body, ctx.outputChars);
    body = cut.text;
    const files = mode === 'content' ? new Set(lines.map((l) => l.split(/[:-]\d+[:-]/)[0])).size : total;
    const notes: string[] = [];
    if (total > limit || cut.truncated || r.truncated) notes.push(`Showing ${Math.min(limit, total)} of ${total}${r.truncated ? '+' : ''} results; narrow the search (path, glob, a more specific pattern) to see the rest.`);
    if (plain) notes.push(plain);
    if (stopped) notes.push(stopped);
    if (notUtf8) notes.push(notUtf8);
    const header = mode === 'files' ? `${total} file${total === 1 ? '' : 's'} match (newest first):` : mode === 'count' ? 'Matches per file:' : '';
    return {
      content: `${header ? `${header}\n` : ''}${body}${notes.length ? `\n\n[${notes.join(' ')}]` : ''}`,
      display: { kind: 'search', pattern: input.pattern, path: input.path ?? '.', matches: total, files, preview: lines.slice(0, 60).join('\n') },
    };
  },
};

export interface GlobInput {
  pattern: string;
  path?: string;
}

export const globTool: ToolDef<GlobInput> = {
  kind: 'glob',
  readOnly: true,
  title: (i) => `Find ${i.pattern}${i.path ? ` in ${i.path}` : ''}`,
  async execute(input, ctx) {
    const base = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;
    if (!fs.existsSync(base)) return { content: `Path not found: ${input.path}`, isError: true };
    let pattern = input.pattern.replace(/\\/g, '/');
    const absPrefix = slash(base).replace(/\/$/, '') + '/';
    if (pattern.startsWith(absPrefix)) pattern = pattern.slice(absPrefix.length);
    // Newest first is sorted here over what matched: rg's own --sortr walks the whole tree on one thread before it
    // prints anything, which took minutes over a home folder.
    const args = ['--files', '--hidden', '--color=never', ...excludeArgs(input.path ?? ''), '--glob', pattern];
    const r = await runRipgrep(args, base, ctx.signal);
    if (r.code !== 0 && r.code !== 1) return { content: `File search failed: ${r.stderr.trim()}`, isError: true };
    const found = r.stdout.split(/\r?\n/).filter(Boolean);
    const files = newestFirst(found.slice(0, 5000), base).map((f) => displayPath(ctx.cwd, resolvePath(base, f)));
    const stopped = r.timedOut ? ` The search stopped after ${SEARCH_LIMIT_MS / 1000} s; look in a narrower folder.` : '';
    if (!files.length) return { content: `No files match ${input.pattern}${input.path ? ` under ${input.path}` : ''}.${stopped}`, display: { kind: 'list', title: input.pattern, items: [], total: 0 } };
    const shown = files.slice(0, 250);
    const more = found.length > shown.length || stopped ? `\n\n[${found.length > shown.length ? `${found.length - shown.length} more not shown; use a narrower pattern.` : ''}${stopped}]` : '';
    return {
      content: `${files.length} file${files.length === 1 ? '' : 's'} (newest first):\n${truncateEnd(fileListLabels(ctx.cwd, shown).join('\n'), ctx.outputChars).text}${more}`,
      display: { kind: 'list', title: input.pattern, items: shown.slice(0, 100), total: files.length },
    };
  },
};
