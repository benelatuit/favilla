import type { ToolDisplay, ToolResultPart } from './types';
import { guardReason } from './guard-reason';

export type ToolKind =
  | 'read'
  | 'write'
  | 'edit'
  | 'patch'
  | 'shell'
  | 'job'
  | 'grep'
  | 'glob'
  | 'todo'
  | 'task'
  | 'web'
  | 'websearch'
  | 'shot'
  | 'ask'
  | 'plan'
  | 'mcp'
  | 'goal'
  | 'check'
  | 'note'
  | 'mail'
  | 'draw'
  | 'other';

/** Tool names of every profile, mapped to what they do. */
const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read',
  read_file: 'read',
  view_image: 'read',
  Write: 'write',
  Edit: 'edit',
  apply_patch: 'patch',
  Bash: 'shell',
  bash: 'shell',
  shell_command: 'shell',
  BashOutput: 'job',
  KillShell: 'job',
  background_job: 'job',
  Grep: 'grep',
  grep: 'grep',
  Glob: 'glob',
  glob: 'glob',
  TodoWrite: 'todo',
  update_plan: 'todo',
  Task: 'task',
  run_subagent: 'task',
  WebFetch: 'web',
  web_fetch: 'web',
  WebSearch: 'websearch',
  web_search: 'websearch',
  Screenshot: 'shot',
  screenshot: 'shot',
  AskUserQuestion: 'ask',
  request_user_input: 'ask',
  ExitPlanMode: 'plan',
  exit_plan_mode: 'plan',
  read: 'read',
  write: 'write',
  edit: 'edit',
  notebook_edit: 'edit',
  NotebookEdit: 'edit',
  shell: 'shell',
  job: 'job',
  search: 'grep',
  plan: 'todo',
  agent: 'task',
  ask: 'ask',
  present_plan: 'plan',
  criteria: 'goal',
  goal: 'goal',
  check: 'check',
  review: 'task',
  brief: 'task',
  remember: 'note',
  browser: 'shot',
  mail: 'mail',
  paint: 'draw',
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  return TOOL_KINDS[name] ?? 'other';
}

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

/** "mcp__server__tool" as its server and tool. */
export function mcpParts(name: string): { server: string; tool: string } {
  const [, server = '', ...rest] = name.split('__');
  return { server, tool: rest.join('__') };
}

/** What the call acts on: a path, a command, a pattern, a URL. */
export function toolTarget(kind: ToolKind, title: string): string {
  const words = title.split(' ');
  if (['read', 'write', 'edit', 'web', 'patch', 'draw'].includes(kind) && words.length > 1 && /^[A-Z_a-z]+$/.test(words[0])) return words.slice(1).join(' ');
  if (kind === 'task' && title.startsWith('Agent: ')) return title.slice(7);
  if (kind === 'websearch') return title.replace(/^Search the web for /, '');
  if (kind === 'shot') return title.replace(/^Screenshot /, '');
  if (kind === 'ask') return title.replace(/^Ask:\s*/, '');
  if (kind === 'goal') return title.replace(/^Criteria:\s*/, '');
  if (kind === 'mcp') return title.replace(/^[^·]*·\s*/, '');
  return title;
}

/** The command of a shell call, from its arguments, its result or its title. */
export function commandText(input: Record<string, unknown> | undefined, title: string, d?: ToolDisplay): string {
  const c = input?.command;
  if (typeof c === 'string' && c) return c;
  if (Array.isArray(c)) return c.length >= 3 && /^(bash|sh|zsh)$/.test(String(c[0])) && c[1] === '-lc' ? String(c[2]) : c.map(String).join(' ');
  return d?.kind === 'terminal' ? d.command : title;
}

/** What a step acts on, in a few words: a command by what it was said to do (or its head), else a path, a pattern, a URL. */
export function stepWhat(name: string, title: string, input?: Record<string, unknown>): string {
  const kind = toolKind(name);
  const said = kind === 'shell' && typeof input?.description === 'string' ? input.description.trim() : '';
  return kind === 'shell' ? said || viewCommand(commandText(input, title)).head : toolTarget(kind, title);
}

export type StepOutcome = 'forming' | 'running' | 'pending' | 'ok' | 'failed' | 'denied' | 'cancelled';

/**
 * Exact English phrases @favilla/core writes into ToolResultPart.content for user interruptions and guard/policy
 * refusals. Guarded by a contract test against packages/core/src/{agent/session,tools/shell-tools,guard/i18n}.ts.
 */
export const CORE_STEP_PHRASES = {
  cancelledExact: ['Interrupted.', 'Interrupted by the user before it ran.'] as const,
  cancelledContains: ['Interrupted by the user.'] as const,
  deniedPrefixes: [
    'The user did not allow this command (',
    'Not run: ',
    'Plan mode is on, so ',
    'This run stays inside its folder (',
  ] as const,
};

export interface StepOutcomeInput {
  id?: string;
  name?: string;
  forming?: string;
  live?: unknown;
  running?: unknown;
  result?: { content?: string; isError?: boolean; display?: ToolDisplay };
  opaque?: boolean;
}

export function stepOutcome(step: StepOutcomeInput): StepOutcome {
  if (step.forming !== undefined) return 'forming';
  if (step.live || step.running) return 'running';
  const r = step.result;
  if (!r) {
    // Provider-side opaque web_search blocks carry no separate tool_result message.
    if (step.opaque || (step.name === 'web_search' && !!step.id?.includes(':'))) return 'ok';
    return 'pending';
  }
  const text = (r.content ?? '').trim();
  if ((CORE_STEP_PHRASES.cancelledExact as readonly string[]).includes(text)) return 'cancelled';
  if (CORE_STEP_PHRASES.cancelledContains.some((s) => text.includes(s))) return 'cancelled';
  if (CORE_STEP_PHRASES.deniedPrefixes.some((p) => text.startsWith(p))) return 'denied';
  if (stepFailed(r)) return 'failed';
  return 'ok';
}

/**
 * User-facing explanation for a cancelled or policy-denied tool result, with model-steering instructions stripped
 * and guard/catastrophe reasons translated when known.
 */
export function stepOutcomeDetail(result: { content?: string } | undefined, t: (key: string) => string): string {
  const text = (result?.content ?? '').trim();
  if (!text) return '';
  if (text === 'Interrupted.' || text === 'Interrupted by the user.' || text === 'Interrupted by the user before it ran.') {
    return t('stopped by you');
  }
  const denied = /^The user did not allow this command \(([\s\S]+?)\)\.\s*Don't run it; find another way or ask the user\.$/.exec(text);
  if (denied) return guardReason(t, denied[1]);
  const catastrophe = /^Not run: ([\s\S]+?)\.\s*Ask the user about this exact target; do not try another command to do the same thing\.$/.exec(text);
  if (catastrophe) {
    return catastrophe[1]
      .split('; ')
      .map((part) => guardReason(t, part.endsWith('.') ? part : `${part}.`))
      .join(' ');
  }
  if (text.startsWith('Plan mode is on, so ')) {
    return text
      .replace(/\s*Finish the plan and present it for approval first\.$/, '')
      .replace(/\s*Tests, builds and commands that only look are fine; the rest waits for an approved plan\.$/, '');
  }
  if (text.startsWith('This run stays inside its folder (')) {
    return text.replace(/\s*Work with what is in the folder; a skill's SKILL\.md is read with the read tool\.$/, '');
  }
  return text.split('\n').slice(0, 2).join(' ');
}

const LOOK_KINDS: readonly ToolKind[] = ['read', 'grep', 'glob', 'web', 'websearch'];

const LOOK_COMMAND =
  /^(?:ls|dir|cat|type|head|tail|wc|rg|grep|egrep|fgrep|findstr|Select-String|find|fd|tree|stat|file|pwd|which|where|du|df|Get-ChildItem|Get-Content|git\s+(?:status|log|diff|show|branch|grep|blame|ls-files|rev-parse))(?:\s|$)/i;

const SHELL_WRITE_OR_EXEC =
  /(?:^|[^2&])>{1,2}|\$\(|`|<\(|>\(|<<|\b(?:xargs|tee)\b|-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b|--output(?:=|\s)|\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item|Clear-Content|Start-Process|Stop-Process)\b/i;

const GIT_BRANCH_MUTATE =
  /^git\s+branch\b.*\s(?:-[dDmMcCu]\b|--(?:delete|move|copy|set-upstream-to|unset-upstream|edit-description)\b)/i;

/**
 * Whether a step strictly only reads/searches and settled cleanly (or is currently running as a pure look step).
 * Failed, denied, cancelled, pending, or mutating multi-line/piped shell commands never hide inside an "Explored" fold.
 */
export function isReadOnlyLookStep(step: {
  kind: string;
  id?: string;
  name: string;
  input?: Record<string, unknown>;
  live?: unknown;
  forming?: string;
  result?: { content?: string; isError?: boolean; display?: ToolDisplay };
  opaque?: boolean;
}): boolean {
  if (step.kind !== 'tool') return false;
  const outcome = stepOutcome(step);
  if (outcome !== 'ok' && outcome !== 'running' && outcome !== 'forming') return false;
  const kind = toolKind(step.name);
  if (LOOK_KINDS.includes(kind)) return true;
  if (kind !== 'shell' || step.forming !== undefined) return false;
  const raw = typeof step.input?.command === 'string' ? step.input.command.trim() : '';
  if (!raw || SHELL_WRITE_OR_EXEC.test(raw)) return false;
  const segments = raw
    .split(/&&|\|\||;|\||\r?\n/)
    .map((part) => part.replace(/\s+2>(?:&1|\/dev\/null)\s*$/g, '').trim())
    .filter((part) => part.length > 0 && !part.startsWith('#'));
  if (!segments.length) return false;
  let sawLook = false;
  for (const seg of segments) {
    if (/^(?:cd|pushd|popd)(?:\s|$)/i.test(seg)) continue;
    if (GIT_BRANCH_MUTATE.test(seg)) return false;
    if (!LOOK_COMMAND.test(seg)) return false;
    sawLook = true;
  }
  return sawLook;
}
