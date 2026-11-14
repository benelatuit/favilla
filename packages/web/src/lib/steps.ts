import type { ToolDisplay } from './types';

/**
 * What a step's raw input says, made readable: a shell command without its leading `cd`, with a script fed
 * through a heredoc picked out; search output as files and numbered lines.
 */

interface CommandScript {
  /** The program reading it (python, node, psql) or, for `cat > file <<EOF`, the file it writes. */
  tool: string;
  writes?: string;
  /** For highlighting: a file name with the script's extension. */
  as: string;
  body: string;
  lines: number;
  /** The command text before the script and after it. */
  before: string;
  after: string;
}

interface CommandView {
  /** Where a leading `cd` moves to: its last folder or two. */
  dir?: string;
  /** The command without that `cd`. */
  rest: string;
  /** The first line of `rest`. */
  head: string;
  lines: number;
  script?: CommandScript;
}

const TOOL_EXT: Record<string, string> = {
  python: 'py', python3: 'py', py: 'py', node: 'js', bun: 'ts', deno: 'ts', tsx: 'ts', 'ts-node': 'ts', bash: 'sh', sh: 'sh', zsh: 'sh',
  ruby: 'rb', perl: 'pl', php: 'php', psql: 'sql', sqlite3: 'sql', mysql: 'sql', lua: 'lua', R: 'r', Rscript: 'r', pwsh: 'ps1', powershell: 'ps1',
};

function lastFolders(p: string): string {
  const parts = p.replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

const norm = (p: string) =>
  p
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/([a-z])\//i, '$1:/')
    .replace(/\/+$/, '')
    .toLowerCase();

/** A command as the step shows it; a leading cd to `cwd` itself is dropped without a word. */
export function viewCommand(command: string, cwd?: string): CommandView {
  let rest = command.replace(/\r\n/g, '\n').trim();
  let dir: string | undefined;
  const cd = /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|\n)\s*/.exec(rest);
  if (cd) {
    if (!cwd || norm(cd[1]) !== norm(cwd)) dir = lastFolders(cd[1]);
    rest = rest.slice(cd[0].length);
  }
  const all = rest.split('\n');
  let script: CommandScript | undefined;
  const lineIdx = all.findIndex((l) => /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.test(l));
  if (lineIdx >= 0) {
    const m = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(all[lineIdx])!;
    const end = all.findIndex((l, i) => i > lineIdx && l.trim() === m[2]);
    if (end > lineIdx) {
      const lead = all[lineIdx].slice(0, m.index).trim();
      const words = lead.split(/[|&;]+/).pop()!.trim().split(/\s+/).filter(Boolean);
      const writes = /(?:^|\s)(?:cat|tee)\b[^>]*>{1,2}\s*("[^"]+"|'[^']+'|\S+)/.exec(lead)?.[1]?.replace(/^["']|["']$/g, '') ?? (words[0] === 'tee' ? words.find((w, i) => i > 0 && !w.startsWith('-')) : undefined);
      const program = (words.find((w) => !/=/.test(w) && !/^(sudo|env|time|exec)$/.test(w)) ?? '').split(/[\\/]/).pop() ?? '';
      const ext = writes ? (/\.(\w+)$/.exec(writes)?.[1] ?? 'txt') : (TOOL_EXT[program] ?? TOOL_EXT[program.replace(/\d+(\.\d+)?$/, '')] ?? 'txt');
      const body = all.slice(lineIdx + 1, end).join('\n');
      script = { tool: writes ?? program, writes, as: `script.${ext}`, body, lines: end - lineIdx - 1, before: all.slice(0, lineIdx + 1).join('\n'), after: all.slice(end).join('\n') };
    }
  }
  const head = all.find((l) => l.trim() && !SETUP.test(l.trim())) ?? all[0] ?? '';
  return { dir, rest, head: head.trim(), lines: all.length, script };
}

/**
 * Lines a script opens with that say how or where it runs, not what it does: `set -e` led a six-line command's step
 * as its whole title (2026-11-13). The head is the first line after them.
 */
const SETUP = /^(?:#.*|cd\s+(?:"[^"]+"|'[^']+'|\S+)|pushd\s.*|set\s+[-+]\S*(?:\s+\S+)*|shopt\s.*|trap\s.*|umask\s.*|export\s+[A-Za-z_]\w*=\S*|source\s.*|\.\s+\S.*|\$(?:ErrorActionPreference|ProgressPreference)\s*=.*|Set-StrictMode\b.*|@echo\s+off|setlocal\b.*|chcp\s.*)$/i;

/**
 * Exit 1 from a command that answers a question by it: grep and its kin found nothing, diff and cmp found a
 * difference. It is a finding, not a failure: a turn's searches that came back empty had marked its steps failed.
 */
const ANSWERS = /^(?:grep|egrep|fgrep|rg|ag|findstr|select-string|diff|cmp|git\s+(?:grep|diff\s.*(?:--quiet|--exit-code)))\b/i;

export function commandFailed(command: string | undefined, exitCode: number | null | undefined): boolean {
  if (!exitCode) return false;
  if (exitCode !== 1 || !command) return true;
  const last = viewCommand(command).rest.split(/\n/).filter((l) => l.trim()).pop() ?? '';
  const program = last.split(/\|\||&&|;/).pop()!.split('|').pop()!.trim();
  return !ANSWERS.test(program);
}

/**
 * Whether a step failed as the timeline marks it. The engine tells the model every non-zero exit, grep's "nothing
 * found" too, and keeps saying so; on screen, a search that found nothing is not a failure.
 */
export function stepFailed(r?: { isError?: boolean; display?: ToolDisplay }): boolean {
  const d = r?.display;
  if (d?.kind !== 'terminal') return !!r?.isError;
  if (d.exitCode === 1 && !d.stoppedFor && !d.timedOut && !commandFailed(d.command, 1)) return false;
  return !!r?.isError || !!d.exitCode;
}

interface MatchLine {
  n?: number;
  text: string;
  context?: boolean;
}

interface MatchFile {
  path: string;
  lines: MatchLine[];
}

/** Search output in either layout (a path heading over `12:text` lines, or `path:12:text`) as files and lines. */
export function parseMatches(preview: string): MatchFile[] {
  const out: MatchFile[] = [];
  let current: MatchFile | null = null;
  const into = (path: string) => {
    if (current?.path !== path) {
      current = { path, lines: [] };
      out.push(current);
    }
    return current;
  };
  for (const raw of preview.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line === '--') continue;
    let m = /^(\d+)([:-])(.*)$/.exec(line);
    if (m && current) {
      (current as MatchFile).lines.push({ n: Number(m[1]), text: m[3], context: m[2] === '-' });
      continue;
    }
    m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (m && !/^\d+$/.test(m[1])) {
      into(m[1]).lines.push({ n: Number(m[2]), text: m[3] });
      continue;
    }
    // A heading of the grouped layout, a file of a names-only search, or `path:count`.
    const count = /^(.+?):(\d+)$/.exec(line);
    if (count) into(count[1]).lines.push({ text: `${count[2]}` });
    else into(line);
  }
  return out;
}

/** Ranges of `text` that `pattern` matches (a regex where it is one, else the plain words), for marking. */
export function markRanges(text: string, pattern: string): [number, number][] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'gi');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  }
  const out: [number, number][] = [];
  for (const m of text.matchAll(re)) {
    if (!m[0]) break;
    out.push([m.index!, m.index! + m[0].length]);
    if (out.length > 20) break;
  }
  return out;
}

/** A readable title for a finished call (the server sends exact titles only while it runs). */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  if (name === 'check') return [Array.isArray(input.only) && input.only.length ? (input.only as string[]).join(' · ') : 'types · lint · test', s('path'), s('filter')].filter(Boolean).join('  ');
  if (name.startsWith('mcp__')) {
    const [, server = '', ...rest] = name.split('__');
    const tool = rest.join('__');
    const args = Object.keys(input).length ? ` ${JSON.stringify(input).slice(0, 120)}` : '';
    return `${server} · ${tool}${args}`;
  }
  const path = s('file_path') || s('path') || s('notebook_path');
  if (path && !s('pattern') && !s('glob')) return `${name} ${path}`;
  if (Array.isArray(input.paths)) return `${name} ${(input.paths as string[]).join(', ')}`;
  if (s('command')) return s('command');
  if (Array.isArray(input.command)) return (input.command as string[]).join(' ');
  if (s('pattern')) return `"${s('pattern')}"${s('path') ? ` in ${s('path')}` : ''}`;
  if (s('glob')) return `${s('glob')}${s('path') ? ` in ${s('path')}` : ''}`;
  if (s('url')) return `${name} ${s('url')}`;
  // Screenshots: the page's URL, or just the file name of a local page.
  if (s('target')) return /^[a-z][a-z0-9+.-]*:\/\//i.test(s('target')) ? s('target') : (s('target').split(/[\\/]/).pop() ?? s('target'));
  if (s('query')) return s('query');
  if (s('description')) return `Agent: ${s('description')}`;
  if (s('input')) {
    const files = [...s('input').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((x) => x[1]);
    return files.join(', ') || name;
  }
  if (Array.isArray(input.todos) || Array.isArray(input.plan)) return name;
  if (Array.isArray(input.questions)) return String((input.questions as { question?: string }[])[0]?.question ?? name);
  // Criteria name their objective; a call that only marks some met has its count beside it, not the tool's name.
  if (name === 'criteria' || name === 'goal') return s('objective');
  if (s('plan')) return 'Plan ready for review';
  if (s('bash_id') || s('shell_id') || s('id')) return s('bash_id') || s('shell_id') || s('id');
  return name;
}

/**
 * The files a call names, each once: every path of a read of several (a range read is its file), the file of a write
 * or an edit, every file a patch touches. Empty when its input names none, so the caller falls back to its title: one
 * read of two files counted as one file while the title stood for the call.
 */
export function stepPaths(input: Record<string, unknown>): string[] {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const named = Array.isArray(input.paths)
    ? input.paths.filter((p): p is string => typeof p === 'string')
    : s('input')
      ? [...s('input').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((x) => x[1])
      : [s('file_path') || s('path') || s('notebook_path')];
  return [...new Set(named.map((p) => p.trim().replace(/:\d+(?:-\d+)?$/, '').replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))];
}

/** A command that checks the work (tests, type checks, linters, builds); the same test the engine's turn checks use. */
const CHECK_COMMAND = /\b(?:test|tests|pytest|unittest|jest|vitest|mocha|tsc|eslint|biome|ruff|mypy|pyright|flake8|clippy|phpunit|rspec|ctest|go\s+(?:test|vet|build)|cargo\s+(?:test|check|build)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check|typecheck)|make\s+\w*(?:test|check|lint|build)\w*|dotnet\s+(?:test|build)|gradle\w*\s+\w*(?:test|check|build)|mvn\s+\w*(?:test|verify|package))\b/i;

export function isCheckCommand(command: string): boolean {
  return CHECK_COMMAND.test(command);
}
