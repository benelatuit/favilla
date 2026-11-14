import fs from 'node:fs';
import path from 'node:path';
import type { CheckResult } from '../types';
import { displayPath, isWindows, resolvePath } from '../util/paths';
import { cleanTerminal, oneLine } from '../util/text';
import { beforeTree, changedTests, newGoTests } from './before';
import { describeProbe, probeChanges } from './probe';
import { agentEnv, runShell, type ShellInfo } from './shell';
import type { ToolDef } from './types';

export type CheckName = 'types' | 'lint' | 'test' | 'build';

interface Check {
  name: CheckName;
  command: string;
  /** Test runners whose name filter is known. */
  runner?: 'pytest' | 'go' | 'cargo' | 'vitest' | 'jest';
}

export interface CheckInput {
  /** Which checks to run; default types, lint and test (build only when named). */
  only?: CheckName[];
  /** A folder to check instead of the working directory (a package in a monorepo). */
  path?: string;
  /** Run only tests whose name matches (pytest -k, go -run, cargo, vitest/jest -t). */
  filter?: string;
  /** Only the tests the files changed in this session can affect (vitest related, jest --findRelatedTests, the matching pytest files, the changed Go packages). */
  related?: boolean;
  /** Run on the code as it was before this session's changes, with the session's test files as they are now. */
  before?: boolean;
  /** Explicit test-sensitivity sample: at most two partial-revert runs instead of the automatic old-code run. */
  probe?: boolean;
}

const ORDER: CheckName[] = ['types', 'lint', 'test', 'build'];
const MAX_PROBLEMS = 30;

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * One argument quoted for the shell the check runs in, so nothing in it is expanded there. bash, zsh and sh take
 * double quotes with their four escapes. PowerShell expands $name and $(...) inside double quotes and reads a
 * backslash as a plain character, so `-run "^(TestA)\$"` reached go as a pattern that matched no test and passed;
 * it gets single quotes, inside which only a doubled quote means anything (the typographic single quotes count as
 * quotes there too). cmd expands %NAME% even inside double quotes, so each % stands outside them behind a caret;
 * the program then reads backslashes before a closing quote as escapes, so those are doubled.
 * A double quote inside the argument cannot pass PowerShell or cmd intact: the caller refuses it first.
 */
export function quoteFor(kind: ShellInfo['kind']): (s: string) => string {
  if (kind === 'pwsh' || kind === 'powershell') return (s) => `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
  if (kind === 'cmd') return (s) => s.split('%').map((part) => `"${part.replace(/\\+$/, '$&$&')}"`).join('^%');
  return (s) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

const posixQuote = quoteFor('bash');

/** The checks a project declares: npm scripts, Python tool config, go.mod, Cargo.toml, Makefile targets. */
export function detectChecks(root: string): Check[] {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const found: Check[] = [];
  const add = (c: Check) => {
    if (!found.some((x) => x.name === c.name)) found.push(c);
  };

  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const run = (script: string) => (pm === 'npm' ? `npm run --silent ${script}` : `${pm} run ${script}`);
    const scripts: Record<string, unknown> = pkg.scripts ?? {};
    const script = (name: string) => (typeof scripts[name] === 'string' && !/no test specified/.test(scripts[name] as string) ? (scripts[name] as string) : null);
    const typesScript = ['typecheck', 'type-check', 'check-types', 'types', 'tsc'].find(script);
    if (typesScript) add({ name: 'types', command: run(typesScript) });
    else if (has('tsconfig.json') && (has('node_modules/.bin/tsc') || has('node_modules/typescript'))) add({ name: 'types', command: 'npx --no-install tsc --noEmit' });
    if (script('lint')) add({ name: 'lint', command: run('lint') });
    const test = script('test');
    if (test) {
      // A plain runner can take a name filter directly.
      const bare = /^\s*(vitest|jest)(\s+run)?\s*$/.exec(test);
      // The runner behind the script, also when it carries options ("vitest run --coverage"), for related runs.
      const named = /\b(vitest|jest)\b/.exec(test);
      add({ name: 'test', command: run('test'), runner: bare ? (bare[1] as 'vitest' | 'jest') : named ? (named[1] as 'vitest' | 'jest') : undefined });
    }
    if (script('build')) add({ name: 'build', command: run('build') });
  }

  const pyproject = readText(path.join(root, 'pyproject.toml'));
  const python = isWindows ? 'python' : 'python3';
  const pyTests = has('pytest.ini') || /\[tool\.pytest/.test(pyproject) || has('conftest.py') || has('tests') || has('test') || (safeList(root).some((f) => /^test_.*\.py$|_test\.py$/.test(f)));
  if (pyTests && (pyproject || has('setup.py') || has('setup.cfg') || has('requirements.txt') || has('pytest.ini') || safeList(root).some((f) => f.endsWith('.py')))) {
    add({ name: 'test', command: `${python} -m pytest -q`, runner: 'pytest' });
  }
  if (has('mypy.ini') || /\[tool\.mypy\]/.test(pyproject)) add({ name: 'types', command: `${python} -m mypy .` });
  else if (has('pyrightconfig.json') || /\[tool\.pyright\]/.test(pyproject)) add({ name: 'types', command: 'pyright' });
  if (has('ruff.toml') || has('.ruff.toml') || /\[tool\.ruff/.test(pyproject)) add({ name: 'lint', command: `${python} -m ruff check .` });
  else if (has('.flake8')) add({ name: 'lint', command: `${python} -m flake8` });

  if (has('go.mod')) {
    add({ name: 'types', command: 'go vet ./...' });
    add({ name: 'test', command: 'go test ./...', runner: 'go' });
  }
  if (has('Cargo.toml')) {
    add({ name: 'types', command: 'cargo check --quiet --message-format=short' });
    add({ name: 'test', command: 'cargo test --quiet', runner: 'cargo' });
  }
  const make = readText(path.join(root, 'Makefile'));
  for (const target of ['test', 'lint'] as const) if (new RegExp(`^${target}:`, 'm').test(make)) add({ name: target, command: `make ${target}` });

  return found.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The test command narrowed to a folder inside the project, or null when the runner cannot be narrowed. */
function folderCommand(c: Check, within: string, filter: string | undefined, quote: (s: string) => string): { command: string; scope: string } | null {
  if (c.name !== 'test') return null;
  const scope = `tests in ${within}`;
  const named = filter ? ` -t ${quote(filter)}` : '';
  switch (c.runner) {
    case 'go':
      return { command: withFilter(c, filter, quote).replace('./...', `./${within}/...`), scope };
    case 'pytest':
      return { command: `${withFilter(c, filter, quote)} ${quote(within)}`, scope };
    case 'vitest':
      return { command: `npx --no-install vitest run ${quote(within)}${named}`, scope };
    case 'jest':
      return { command: `npx --no-install jest ${quote(within)}${named}`, scope };
    default:
      return null;
  }
}

/**
 * The command that runs only the tests the changed files can affect, and what it covers; null when the runner
 * has no such mode or nothing related was found (then the whole suite runs).
 */
export function relatedCommand(c: Check, root: string, changed: string[], quote = posixQuote): { command: string; scope: string } | null {
  if (c.name !== 'test' || !changed.length) return null;
  const rel = changed.map((f) => path.relative(root, f).replace(/\\/g, '/')).filter((f) => f && !f.startsWith('..'));
  if (!rel.length) return null;
  switch (c.runner) {
    case 'vitest':
      return { command: `npx --no-install vitest related --run ${rel.map(quote).join(' ')}`, scope: `tests importing ${rel.length} changed file${rel.length === 1 ? '' : 's'}` };
    case 'jest':
      return { command: `npx --no-install jest --findRelatedTests ${rel.map(quote).join(' ')} --passWithNoTests`, scope: `tests importing ${rel.length} changed file${rel.length === 1 ? '' : 's'}` };
    case 'go': {
      const pkgs = [...new Set(rel.filter((f) => f.endsWith('.go')).map((f) => `./${path.posix.dirname(f)}`))];
      return pkgs.length ? { command: `go test ${pkgs.join(' ')}`, scope: `${pkgs.length} changed package${pkgs.length === 1 ? '' : 's'}` } : null;
    }
    case 'pytest': {
      const tests = new Set<string>();
      const stems = new Set<string>();
      for (const f of rel.filter((f) => f.endsWith('.py'))) {
        const base = path.posix.basename(f, '.py');
        if (/^test_|_test$/.test(base)) tests.add(f);
        else stems.add(base);
      }
      if (stems.size) {
        // Test files named after a changed module, or importing it.
        for (const t of findTests(root)) {
          const name = path.posix.basename(t, '.py').replace(/^test_|_test$/g, '');
          if (stems.has(name)) tests.add(t);
          else {
            const text = readText(path.join(root, t));
            if ([...stems].some((s) => new RegExp(`^\\s*(?:from\\s+[\\w.]*\\b${s}\\b|import\\s+[\\w.]*\\b${s}\\b)`, 'm').test(text))) tests.add(t);
          }
        }
      }
      return tests.size ? { command: `${c.command} ${[...tests].map(quote).join(' ')}`, scope: `${tests.size} test file${tests.size === 1 ? '' : 's'} for the changed modules` } : null;
    }
    default:
      return null;
  }
}

/** Python test files under a root (test_*.py, *_test.py), skipping virtualenvs and caches; at most 2000. */
function findTests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= 2000 || depth > 8) return;
    for (const e of safeEntries(dir)) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__' || e.name === 'venv' || e.name === 'env' || e.name === 'build' || e.name === 'dist') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/^test_.*\.py$|_test\.py$/.test(e.name)) out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root, 0);
  return out;
}

function safeEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function withFilter(c: Check, filter: string | undefined, quote: (s: string) => string): string {
  if (!filter || c.name !== 'test') return c.command;
  switch (c.runner) {
    case 'pytest':
      return `${c.command} -k ${quote(filter)}`;
    case 'go':
      return `${c.command} -run ${quote(filter)}`;
    case 'cargo':
      return `${c.command} ${quote(filter)}`;
    case 'vitest':
      return `npx --no-install vitest run -t ${quote(filter)}`;
    case 'jest':
      return `npx --no-install jest -t ${quote(filter)}`;
    default:
      return c.command;
  }
}

const PROBLEM = [
  /^\s*(?:FAIL(?:ED)?|ERROR)\b/, // pytest summary, jest and vitest files
  /[\w./\\-]+\.\w+\(\d+,\d+\): error/, // tsc
  /[\w./\\-]+\.\w+:\d+(?::\d+)?(?: -)?:?\s.*\b(?:error|Error|fail|FAIL)\b/, // tsc --pretty, mypy, go vet, cargo, pyright, ruff, eslint unix
  /^\s*(?:--- FAIL|panicked at|thread '.*' panicked|AssertionError|Error: |TypeError: |ReferenceError: |SyntaxError: |E\s{3})/,
  /^\s*[×✗✖]\s/, // vitest, jest, mocha failure marks
];

const SUMMARY = /\b\d+ (?:passed|failed|errors?|tests?|warnings?|problems?)\b|^Tests?:|Test Files|Found \d+ errors?|^ok\s|^FAIL\s|test result:/;

/** Where a failing test's own report begins: Go, pytest, jest and vitest, Rust. */
const BLOCK_START = /^\s*(?:--- FAIL:|panic:|●\s|_{3,} .+ _{3,}$|thread '.*' panicked|FAIL\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?\b)/;
const BLOCK_END = /^\s*(?:--- (?:PASS|FAIL|SKIP)|=== (?:RUN|PAUSE|CONT)|ok\s|FAIL\s*$|FAIL\t|PASS\s*$|_{3,} |={3,}|Test Files|Tests:)/;

/**
 * Each failing test's own lines (its assertion, what was expected and what came, the first frames of a panic), up to
 * `max` characters. The one-line problems leave them out ("--- FAIL: TestX" without "got 201, want 205"), and the
 * model then read the whole log (58 such reads in the evals).
 */
export function failureBlocks(output: string, max = 3000): string {
  const lines = cleanTerminal(output).split(/\r?\n/);
  const blocks: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!BLOCK_START.test(lines[i])) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && block.length < 14 && !BLOCK_END.test(lines[j]) && !BLOCK_START.test(lines[j]); j++) if (lines[j].trim()) block.push(lines[j]);
    const text = block.map((l) => oneLine(l.trimEnd(), 240)).join('\n');
    if (used + text.length > max) break;
    blocks.push(text);
    used += text.length;
  }
  return blocks.join('\n\n');
}

/** The lines that say what failed, and the run's own summary line. */
export function readOutput(output: string): { problems: string[]; summary?: string } {
  const lines = cleanTerminal(output).split(/\r?\n/).map((l) => l.trimEnd());
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (problems.length >= MAX_PROBLEMS) break;
    const t = l.trim();
    if (!t || seen.has(t) || !PROBLEM.some((re) => re.test(l))) continue;
    seen.add(t);
    problems.push(oneLine(t, 300));
  }
  let summary: string | undefined;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60) && !summary; i--) {
    const t = lines[i].trim();
    if (t && SUMMARY.test(t)) summary = oneLine(t, 200);
  }
  return { problems, summary };
}

/**
 * Runs the project's own checks (type check, lint, tests; build on request) and reports what failed as
 * file:line messages, failing tests and each run's summary, with the full output saved to a file. One call
 * replaces guessing the commands and reading thousands of lines of logs.
 */
/**
 * Per session (its checkpoints stand for it): the problems each check reported before the session changed any
 * file. A check that fails the same way later failed before the agent's work too, and is marked so.
 */
const baselines = new WeakMap<object, Map<string, Set<string>>>();

export const checkTool: ToolDef<CheckInput> = {
  kind: 'check',
  readOnly: false,
  title: (i) => `Check${i.only?.length ? ` ${i.only.join(', ')}` : ''}${i.path ? ` in ${i.path}` : ''}${i.filter ? ` (${i.filter})` : ''}`,
  async execute(input, ctx) {
    if (input.before && input.probe) return { content: 'Use before or probe, not both: probe starts from passing current tests.', isError: true };
    const quote = quoteFor(ctx.shell.kind);
    if (input.filter?.includes('"') && (ctx.shell.kind === 'pwsh' || ctx.shell.kind === 'powershell' || ctx.shell.kind === 'cmd'))
      return { content: `A filter with a double quote cannot reach the test runner intact through ${ctx.shell.name}: filter on a part of the name without it.`, isError: true };
    const asked = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;
    if (!fs.existsSync(asked)) return { content: `Folder not found: ${input.path}`, isError: true };
    // A package folder has no project file of its own: the checks come from the nearest folder above that has them,
    // with the tests narrowed to the folder asked for (92 of 375 eval sessions got "No checks found" for a package).
    let root = asked;
    let all = detectChecks(root);
    let within: string | null = null;
    for (let up = path.dirname(asked); !all.length && input.path && up !== path.dirname(up); up = path.dirname(up)) {
      const rel = path.relative(ctx.cwd, up);
      if (rel.startsWith('..') || path.isAbsolute(rel)) break;
      const found = detectChecks(up);
      if (found.length) {
        root = up;
        all = found;
        within = path.relative(up, asked).replace(/\\/g, '/');
      }
    }
    const want = input.only?.length ? input.only : ((input.before ? ['test'] : ['types', 'lint', 'test']) as CheckName[]);
    const checks = all.filter((c) => want.includes(c.name));
    const shown = displayPath(ctx.cwd, root);
    if (!checks.length) {
      const offered = all.map((c) => c.name).join(', ');
      return {
        content: offered
          ? `No ${want.join('/')} check here; the project has: ${offered}.`
          : `No checks found in ${shown}: no test, type-check or lint command in package.json, pyproject.toml, go.mod, Cargo.toml or a Makefile. Run the project's commands with the shell.`,
        display: { kind: 'checks', results: [], found: all.map((c) => c.name) },
      };
    }
    const timeoutMs = Math.min(600_000, Math.round((ctx.config.bashTimeoutMs ?? 120_000) * 2.5));
    const env = agentEnv({ CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' });
    // On the old code: the same checks in the copy of the project as it was before this session changed it.
    let runRoot = root;
    if (input.before) {
      const originals = ctx.checkpoints?.originals?.() ?? new Map<string, Buffer | null>();
      if (!originals.size) return { content: 'Nothing has changed in this session yet, so the code as it was is the code as it is: check without before.' };
      const rel = path.relative(ctx.cwd, root);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return { content: 'before works on folders inside the working directory.', isError: true };
      const tree = beforeTree(ctx.cwd, ctx.sessionId, originals);
      if ('error' in tree) return { content: `No copy of the old code to check: ${tree.error}.`, isError: true };
      runRoot = path.join(tree.root, rel);
    }
    const results: CheckResult[] = [];
    /** Each failed test run's own failure reports, for the model (the front ends have the problems and the log). */
    const blocks = new Map<CheckResult, string>();
    // The files this session changed, for related runs.
    const points = ctx.checkpoints as typeof ctx.checkpoints | undefined;
    const changed = input.related && points ? [...new Set(points.turns().flatMap((t) => points.files(t)))].filter((f) => fs.existsSync(f)) : [];
    const scopes: string[] = [];
    for (const c of checks) {
      if (ctx.signal.aborted) break;
      const narrow = (input.related && !input.filter ? relatedCommand(c, root, changed, quote) : null) ?? (within ? folderCommand(c, within, input.filter, quote) : null);
      if (within && c.name === 'test') scopes.push(narrow ? `Ran the tests in ${within} with the checks of ${displayPath(ctx.cwd, root)}.` : `The tests of ${displayPath(ctx.cwd, root)} cannot be narrowed to ${within}, so they all ran.`);
      if (input.related && c.name === 'test') scopes.push(narrow ? `Ran only the ${narrow.scope}.` : changed.length ? 'No narrower run was possible here, so the whole suite ran.' : 'Nothing has changed in this session yet, so the whole suite ran.');
      const command = narrow?.command ?? withFilter(c, input.filter, quote);
      const logFile = path.join(ctx.outputDir, `${ctx.callId}-${c.name}.log`);
      ctx.progress(`$ ${command}\n`);
      const run = await runShell(ctx.shell, command, { cwd: runRoot, timeoutMs, signal: ctx.signal, onData: ctx.progress, logFile, env, memoryGuard: ctx.config.memoryGuard !== false });
      const ok = run.exitCode === 0 && !run.timedOut;
      const { problems, summary } = readOutput(run.output);
      let logPath = run.logPath;
      if (!logPath) {
        fs.mkdirSync(ctx.outputDir, { recursive: true });
        fs.writeFileSync(logFile, cleanTerminal(run.output));
        logPath = logFile;
      }
      // Output that names nothing still says something: its last lines.
      const tail = !ok && !problems.length ? cleanTerminal(run.output).trim().split(/\r?\n/).slice(-12).map((l) => oneLine(l, 300)) : [];
      const stopped = run.stoppedFor ? [`Stopped by Favilla: ${run.stoppedFor}. Check one package or one test at a time (path, filter or related).`] : [];
      const result: CheckResult = { name: c.name, command, ok: ok && !run.stoppedFor, durationMs: run.durationMs, problems: [...stopped, ...problems, ...tail], summary, logPath, timedOut: run.timedOut || undefined };
      results.push(result);
      if (!result.ok && c.name === 'test') {
        const told = failureBlocks(run.output);
        if (told) blocks.set(result, told);
      }
    }
    const failed = results.filter((r) => !r.ok);
    const incomplete = ctx.signal.aborted || results.length !== checks.length;
    // Before the session's first change, what fails is the project's state, not the agent's doing: remember it.
    const cp = ctx.checkpoints as typeof ctx.checkpoints | undefined;
    let base = cp ? baselines.get(cp) : undefined;
    const untouched = !input.before && !!cp && !cp.turns().some((t) => cp.files(t).length);
    if (untouched) {
      base ??= new Map();
      baselines.set(cp, base);
      for (const r of results) base.set(`${r.name}:${r.command}`, new Set(r.ok ? [] : r.problems.map(problemKey)));
    }
    const lines: string[] = [
      ...(input.before ? ["On the code as it was before this session's changes, with your test files as they are now:"] : []),
      incomplete ? `Checks interrupted (${results.length}/${checks.length} completed):` : failed.length ? `${failed.length} of ${results.length} checks failed:` : `All ${results.length} checks passed:`,
    ];
    for (const r of results) {
      lines.push(`${r.ok ? '✓' : '✗'} ${r.name}: ${r.command} (${(r.durationMs / 1000).toFixed(1)} s)${r.timedOut ? ' timed out' : ''}${r.summary ? ` · ${r.summary}` : ''}`);
      if (!r.ok) {
        const before = !untouched ? base?.get(`${r.name}:${r.command}`) : undefined;
        for (const p of r.problems) lines.push(`  ${p}${before?.has(problemKey(p)) ? '  (failing before this session changed anything)' : ''}`);
        const told = blocks.get(r);
        if (told) lines.push('  What the failing tests reported:', ...told.split('\n').map((l) => (l ? `    ${l}` : '')));
        lines.push(`  full output: ${r.logPath}`);
      }
    }
    if (untouched && failed.length) lines.push('These failures come from the project as it was: nothing has been changed in this session yet.');
    lines.push(...scopes);
    // A slow full run: point at the narrow one for the iterations in between.
    const slowTest = results.find((r) => r.name === 'test' && r.durationMs > 60_000);
    if (slowTest && !input.related && !input.filter) lines.push(`The tests took ${Math.round(slowTest.durationMs / 1000)} s. While iterating, check with related: true runs only the tests your changes can affect; run them all once more before finishing.`);
    const skipped = all.filter((c) => !want.includes(c.name)).map((c) => c.name);
    if (skipped.length) lines.push(`Not run: ${skipped.join(', ')} (ask for them with only).`);
    // Tests that pass are no proof of a fix until they fail without it: the session's tests, on the old code.
    const passed = checks.find((c) => c.name === 'test' && results.some((r) => r.name === 'test' && r.ok));
    const verdict = !input.before && !input.probe && !incomplete && passed && ctx.config.beforeTests === true ? await testsOnOldCode(ctx, root, passed, env) : null;
    if (verdict) lines.push(verdict.text);
    const probe = input.probe ? !failed.length && !incomplete && passed
      ? await probeChanges(ctx, root, results.find((r) => r.name === 'test' && r.ok)!.command)
      : { results: [], skipped: 'Current checks did not pass or no test command ran; no probe ran.' } : undefined;
    if (probe) lines.push(describeProbe(probe));
    return {
      content: lines.join('\n'),
      isError: failed.length > 0 || incomplete,
      display: { kind: 'checks', results, found: all.map((c) => c.name), ...(input.before ? { before: true } : {}), ...(incomplete ? { incomplete: true } : {}), ...(probe ? { probe } : {}), ...(verdict ? { verdict: { kind: verdict.kind, files: verdict.files } } : {}) },
    };
  },
};

/** What the session's tests did on the old code: failed (they catch the fix), passed (they do not), did not build. */
export type TestVerdict = 'catches' | 'pass-before' | 'no-build';

/** Per session (its checkpoints stand for it): the states of its test files already run on the old code. */
const judged = new WeakMap<object, Set<string>>();

/**
 * The test files this session added or changed, run on the code as it was before its changes, once per state of
 * those files: a sentence saying whether they catch what was fixed, or null when there is nothing to say (no test
 * changed, a runner Favilla cannot narrow, no copy, a run cut short).
 */
async function testsOnOldCode(ctx: Parameters<ToolDef['execute']>[1], root: string, c: Check, env: NodeJS.ProcessEnv): Promise<{ text: string; kind: TestVerdict; files: string[] } | null> {
  const cp = ctx.checkpoints as typeof ctx.checkpoints | undefined;
  if (!cp?.originals) return null;
  const originals = cp.originals();
  const { files, key } = changedTests(ctx.cwd, originals);
  const mine = files.map((f) => path.join(ctx.cwd, f)).filter((abs) => !path.relative(root, abs).startsWith('..'));
  if (!mine.length) return null;
  let seen = judged.get(cp);
  if (!seen) judged.set(cp, (seen = new Set()));
  if (seen.has(key)) return null;
  seen.add(key);
  const rel = mine.map((abs) => path.relative(root, abs).replace(/\\/g, '/'));
  const quote = quoteFor(ctx.shell.kind);
  let command: string | null = null;
  switch (c.runner) {
    case 'go': {
      const pkgs = [...new Set(rel.filter((f) => f.endsWith('_test.go')).map((f) => `./${path.posix.dirname(f)}`))];
      // The tests the session added, by name; a test only changed runs with the rest of its package.
      const names = new Set<string>();
      for (const abs of mine.filter((f) => f.endsWith('_test.go'))) for (const n of newGoTests(originals.get(abs)?.toString('utf8') ?? null, fs.readFileSync(abs, 'utf8'))) names.add(n);
      if (pkgs.length) command = `go test -count=1 ${names.size ? `-run ${quote(`^(${[...names].join('|')})$`)} ` : ''}${pkgs.join(' ')}`;
      break;
    }
    case 'vitest':
      command = `npx --no-install vitest run ${rel.map(quote).join(' ')}`;
      break;
    case 'jest':
      command = `npx --no-install jest ${rel.map(quote).join(' ')}`;
      break;
    case 'pytest': {
      const py = rel.filter((f) => f.endsWith('.py'));
      if (py.length) command = `${c.command} ${py.map(quote).join(' ')}`;
      break;
    }
  }
  if (!command) return null;
  const tree = beforeTree(ctx.cwd, ctx.sessionId, originals);
  if ('error' in tree) return null;
  ctx.progress(`$ ${command}   (on the code before this session's changes)\n`);
  const logFile = path.join(ctx.outputDir, `${ctx.callId}-before.log`);
  const run = await runShell(ctx.shell, command, { cwd: path.join(tree.root, path.relative(ctx.cwd, root)), timeoutMs: 180_000, signal: ctx.signal, env, logFile, memoryGuard: ctx.config.memoryGuard !== false });
  if (run.timedOut || run.stoppedFor || ctx.signal.aborted) return null;
  const out = cleanTerminal(run.output);
  const named = files.join(', ');
  if (run.exitCode === 0) return { kind: 'pass-before', files, text: `Your tests in ${named} also pass on the code as it was before this session's changes (${command}), so they do not catch what you fixed: a test for a fix fails without it and passes with it.` };
  if (/\[build failed\]|\bundefined: |cannot find package|SyntaxError|Cannot find module|ModuleNotFoundError|ImportError|error TS\d+/.test(out))
    return { kind: 'no-build', files, text: `Your tests in ${named} do not build on the code as it was before this session's changes (they use what the change adds), so whether they catch the fix is not known.` };
  return { kind: 'catches', files, text: `Your tests in ${named} fail on the code as it was before this session's changes and pass now: they catch what you fixed.` };
}

/** A problem line without what changes from run to run (timings, addresses, counts in brackets). */
function problemKey(line: string): string {
  return line
    .replace(/\(\d+(\.\d+)?\s*m?s\)/g, '')
    .replace(/0x[0-9a-f]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
