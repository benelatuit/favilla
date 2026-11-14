import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectChecks } from '../tools/check';
import { killChild } from '../util/proc';

/**
 * Shadow tests: tests of a request written by another model from the request alone, before any change, in a copy of
 * the project. When the turn would end they run on the change, and one that fails sends the work back once with what
 * it found. A model's own tests share its blind spots: on twelve fresh Go tasks, tests DeepSeek wrote caught none of
 * DeepSeek's failing fixes and a third of gpt-6-luna's.
 * Measured on Go projects; since 2026-11-06 they are written the same way where the project's tests run with node
 * --test, vitest, jest or pytest, which the per-test results of those runners allow (not yet measured there).
 */

/** What runs a project's tests, as far as shadow tests go: each reports test by test. */
export type ShadowKind = 'go' | 'node' | 'vitest' | 'jest' | 'pytest';

export interface ShadowTests {
  kind: ShadowKind;
  /** The test files, by path relative to the project, and their text. */
  files: { rel: string; text: string }[];
  /** Go: the packages they are in, as go test takes them. */
  pkgs: string[];
  /** The tests that behaved as named on the code before the change: a fix test failed there, a keep test passed. */
  trusted: string[];
}

export const SHADOW_FILE = 'shadow_test.go';

/** A shadow test's name says which it is: one the request asks for, or one the change must keep passing. */
const FIX = /^(TestShadowFix|ShadowFix|test_shadow_fix)/;
const KEEP = /^(TestShadowKeep|ShadowKeep|test_shadow_keep)/;

/** What runs the project's tests, when shadow tests can be written for it; null otherwise. */
export function shadowKind(root: string): ShadowKind | null {
  if (fs.existsSync(path.join(root, 'go.mod'))) return 'go';
  const test = detectChecks(root).find((c) => c.name === 'test');
  if (test?.runner === 'vitest' || test?.runner === 'jest' || test?.runner === 'pytest') return test.runner;
  try {
    const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))?.scripts?.test;
    if (typeof script === 'string' && /\bnode\b[^&|;]*\s--test\b/.test(script)) return 'node';
  } catch {
    /* no package.json */
  }
  return null;
}

/** Whether the project is one shadow tests are written for. */
export function shadowProject(root: string): boolean {
  return shadowKind(root) !== null;
}

/** The runner as the tester is told it, and the command it runs its tests with. */
export function shadowRunner(kind: ShadowKind): { runner: string; run: string } {
  switch (kind) {
    case 'go':
      return { runner: 'go test', run: 'go test -run ^TestShadow ./...' };
    case 'node':
      return { runner: "node's own test runner (node --test, with node:test)", run: 'node --test <the shadow test file>' };
    case 'vitest':
      return { runner: 'vitest', run: 'npx vitest run <the shadow test file>' };
    case 'jest':
      return { runner: 'jest', run: 'npx jest <the shadow test file>' };
    case 'pytest':
      return { runner: 'pytest', run: `${process.platform === 'win32' ? 'python' : 'python3'} -m pytest <the shadow test file> -q` };
  }
}

function isShadowFile(kind: ShadowKind, rel: string): boolean {
  const base = path.posix.basename(rel.replace(/\\/g, '/'));
  if (kind === 'go') return base === SHADOW_FILE;
  if (kind === 'pytest') return base === 'test_shadow.py';
  return /^shadow\.test\.[cm]?[jt]sx?$/.test(base);
}

/** The shadow test files a copy holds, among the files its tester changed. */
export function shadowFiles(dir: string, changed: string[], kind: ShadowKind = 'go'): { rel: string; text: string }[] {
  return changed
    .filter((rel) => isShadowFile(kind, rel))
    .flatMap((rel) => {
      try {
        return [{ rel: rel.replace(/\\/g, '/'), text: fs.readFileSync(path.join(dir, rel), 'utf8') }];
      } catch {
        return [];
      }
    });
}

function packagesOf(files: { rel: string }[]): string[] {
  return [...new Set(files.map((f) => (path.posix.dirname(f.rel) === '.' ? '.' : `./${path.posix.dirname(f.rel)}`)))];
}

/** A command's output, ended by the signal or after ten minutes. */
function output(command: string, args: string[], cwd: string, signal: AbortSignal, shell = false): Promise<{ stdout: string; stderr: string }> {
  // In the desktop app the running program is Favilla.exe, which is Node only when told so; without it the runner
  // would start a second window instead of the tests.
  const env = command === process.execPath && process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const stop = () => void killChild(child);
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 600_000);
    child.on('error', () => resolve({ stdout, stderr }));
    child.on('close', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Top-level results of `go test -json` in a folder, and what the failing tests printed. An argument list and no
 * shell: cmd.exe turns `-run "^TestShadow"` into a pattern that matches nothing. No results when the tests do not
 * build; the compiler's lines are the text then.
 */
export async function goTests(cwd: string, pkgs: string[], run: string, signal: AbortSignal): Promise<{ results: Map<string, 'pass' | 'fail'>; text: string }> {
  const { stdout, stderr } = await output('go', ['test', '-count=1', '-json', '-run', run, ...pkgs], cwd, signal);
  const results = new Map<string, 'pass' | 'fail'>();
  let text = '';
  for (const line of stdout.split('\n')) {
    let e: { Action?: string; Test?: string; Output?: string };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.Action === 'output' || e.Action === 'build-output') && e.Output && !/^(=== (RUN|PAUSE|CONT)|--- PASS|PASS\n|ok\s)/.test(e.Output.trimStart())) text += e.Output;
    if (e.Test && !e.Test.includes('/') && (e.Action === 'pass' || e.Action === 'fail')) results.set(e.Test, e.Action);
  }
  return { results, text: (text || stderr).trim().slice(0, 6000) };
}

/** Results of vitest's or jest's JSON report (the same shape): by test title, with what the failing ones said. */
export function readJestReport(json: string): { results: Map<string, 'pass' | 'fail'>; text: string } {
  const results = new Map<string, 'pass' | 'fail'>();
  const said: string[] = [];
  let report: { testResults?: { message?: string; assertionResults?: { title?: string; status?: string; failureMessages?: string[] }[] }[] };
  try {
    report = JSON.parse(json);
  } catch {
    return { results, text: '' };
  }
  for (const file of report.testResults ?? []) {
    // A file that does not load has no tests in it, only its message.
    if (!file.assertionResults?.length && file.message) said.push(file.message);
    for (const t of file.assertionResults ?? []) {
      if (!t.title || (t.status !== 'passed' && t.status !== 'failed')) continue;
      results.set(t.title, t.status === 'passed' ? 'pass' : 'fail');
      if (t.status === 'failed') said.push(`${t.title}\n${(t.failureMessages ?? []).join('\n')}`);
    }
  }
  return { results, text: said.join('\n\n').trim().slice(0, 6000) };
}

/** Results of node --test's TAP report, nested tests included, and the lines of its failures. */
export function readTap(tap: string): { results: Map<string, 'pass' | 'fail'>; text: string } {
  const results = new Map<string, 'pass' | 'fail'>();
  const failing: string[] = [];
  let inFailure = false;
  for (const line of tap.split('\n')) {
    const m = /^\s*(not ok|ok) \d+ - (.+?)(?:\s+#\s.*)?\s*$/.exec(line);
    if (m) {
      results.set(m[2], m[1] === 'ok' ? 'pass' : 'fail');
      inFailure = m[1] === 'not ok';
      if (inFailure) failing.push(line.trim());
      continue;
    }
    if (inFailure && /^\s+(error|expected|actual|message|code|stack|\s{2,}\S)/.test(line)) failing.push(line.trimEnd());
  }
  return { results, text: failing.join('\n').slice(0, 6000) };
}

/** Results of pytest -rA, by test name (the part after the last ::), and its failures section. */
export function readPytest(out: string): { results: Map<string, 'pass' | 'fail'>; text: string } {
  const results = new Map<string, 'pass' | 'fail'>();
  for (const m of out.matchAll(/^(PASSED|FAILED) (\S+?)(?: - .*)?$/gm)) results.set(m[2].split('::').pop()!, m[1] === 'PASSED' ? 'pass' : 'fail');
  const failures = /=+ FAILURES =+([\s\S]*?)(?:=+ short test summary info =+|$)/.exec(out)?.[1] ?? '';
  const errors = /=+ ERRORS =+([\s\S]*?)(?:=+ short test summary info =+|$)/.exec(out)?.[1] ?? '';
  return { results, text: (failures || errors || out).trim().slice(0, 6000) };
}

/** The shadow tests in `files` run in a folder by their kind's runner: each test's result, and what failing ones said. */
async function runShadow(kind: ShadowKind, cwd: string, files: { rel: string }[], pkgs: string[], only: string[] | null, signal: AbortSignal): Promise<{ results: Map<string, 'pass' | 'fail'>; text: string }> {
  if (kind === 'go') return goTests(cwd, pkgs, only ? `^(${only.join('|')})$` : '^TestShadow', signal);
  const rels = files.map((f) => f.rel);
  if (kind === 'node') {
    const { stdout, stderr } = await output(process.execPath, ['--test', '--test-reporter=tap', ...rels], cwd, signal);
    const r = readTap(stdout);
    return { results: r.results, text: r.text || stderr.trim().slice(0, 6000) };
  }
  if (kind === 'pytest') {
    const { stdout, stderr } = await output(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'pytest', ...rels, '-q', '-rA', '-p', 'no:cacheprovider'], cwd, signal);
    const r = readPytest(stdout);
    return { results: r.results, text: r.text || stderr.trim().slice(0, 6000) };
  }
  // vitest and jest write their report to a file; npx is a script on Windows, so these go through a shell.
  const report = path.join(os.tmpdir(), `favilla-shadow-${process.pid}-${Date.now()}.json`);
  const quoted = rels.map((r) => `"${r}"`).join(' ');
  const command = kind === 'vitest' ? `npx --no-install vitest run ${quoted} --reporter=json --outputFile="${report}"` : `npx --no-install jest ${quoted} --json --outputFile="${report}"`;
  try {
    const { stdout, stderr } = await output(command, [], cwd, signal, true);
    let json = '';
    try {
      json = fs.readFileSync(report, 'utf8');
    } catch {
      /* the runner did not start */
    }
    const r = readJestReport(json);
    return { results: r.results, text: r.text || `${stdout}\n${stderr}`.trim().slice(0, 6000) };
  } finally {
    fs.rmSync(report, { force: true });
  }
}

/**
 * Which of a tester's tests to trust, judged in its own copy, where the code is still as it was before the change: a
 * fix test has to fail there and a keep test to pass. Null when none does.
 */
export async function trustShadow(copyDir: string, files: { rel: string; text: string }[], signal: AbortSignal, kind: ShadowKind = 'go'): Promise<ShadowTests | null> {
  if (!files.length) return null;
  const pkgs = kind === 'go' ? packagesOf(files) : [];
  const base = await runShadow(kind, copyDir, files, pkgs, null, signal);
  const trusted = [...base.results].filter(([name, r]) => (FIX.test(name) ? r === 'fail' : KEEP.test(name) && r === 'pass')).map(([name]) => name);
  return trusted.length ? { kind, files, pkgs, trusted } : null;
}

/**
 * The trusted shadow tests run on the change in the working tree. Their files go in where no file of that name is,
 * and stay there when a test fails (the agent can run them while it finishes); otherwise they go again at once.
 */
export async function checkShadow(cwd: string, set: ShadowTests, signal: AbortSignal): Promise<{ failing: string[]; text: string; unbuilt: boolean; placed: string[] }> {
  const placed: string[] = [];
  for (const f of set.files) {
    const at = path.join(cwd, f.rel);
    if (fs.existsSync(at) || !fs.existsSync(path.dirname(at))) continue;
    fs.writeFileSync(at, f.text);
    placed.push(at);
  }
  if (!placed.length) return { failing: [], text: '', unbuilt: false, placed };
  const kind = set.kind ?? 'go';
  const { results, text } = await runShadow(kind, cwd, set.files, set.pkgs, set.trusted, signal);
  const unbuilt = results.size === 0;
  const failing = unbuilt ? [] : set.trusted.filter((t) => results.get(t) === 'fail');
  if (!unbuilt && !failing.length) removeShadow(placed);
  return { failing, text, unbuilt, placed: unbuilt || failing.length ? placed : [] };
}

export function removeShadow(placed: string[]): void {
  for (const at of placed) fs.rmSync(at, { force: true });
}

/** What the agent is told when shadow tests fail on its change. */
export function shadowNote(r: { failing: string[]; text: string; unbuilt: boolean; placed: string[] }, shown: (abs: string) => string): string {
  const where = r.placed.map(shown).join(', ');
  const what = r.unbuilt ? `They do not build against your change:\n\n\`\`\`\n${r.text}\n\`\`\`` : `${r.failing.length === 1 ? 'One of them fails' : `${r.failing.length} of them fail`} on it:\n\n\`\`\`\n${r.text}\n\`\`\``;
  return `Before you started, another model wrote tests of this request from the request alone, without seeing your change. ${what}\n\nThey are in ${where} until this turn ends; do not edit them. Where a failing test checks what was asked, your change is not complete yet: finish it. Where one asks for something the request does not, leave it and say which and why.`;
}
