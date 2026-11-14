import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkTool, quoteFor } from '../src/tools/check';
import { detectShell, runShell, type ShellInfo } from '../src/tools/shell';
import type { ToolContext } from '../src/tools/types';

const roots: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-quote-test-'));
  roots.push(d);
  return d;
};
const sessions: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const s of sessions) fs.rmSync(path.join(os.tmpdir(), 'favilla-before', s), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const goAvailable = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Every shell of a different kind found here: one that is only a fallback for another stands for nothing. */
const shells: ShellInfo[] = [...new Map(['bash', 'pwsh', 'powershell', 'cmd'].map((want) => detectShell(want)).filter((s) => !s.fallback).map((s) => [s.kind, s])).values()];

// What a test filter or a path may hold that some shell would expand, split or end early: none may reach the program changed.
const SAMPLES = ['^(TestAdd|TestSub)$', 'it $(echo hi) `x` $HOME ${PATH}', '100% %PATH% %%', "it's", 'it’s', 'a & b | c > d; e', '(x) [y] {z} @w ~v', 'back\\slash\\', 'é ✓ 中'];

function ctxFor(cwd: string, shell: ShellInfo, extra: Record<string, unknown> = {}): ToolContext {
  const id = `quote-${process.pid}-${sessions.length}`;
  sessions.push(id);
  return {
    cwd,
    sessionId: id,
    callId: 'c1',
    turn: 't1',
    signal: new AbortController().signal,
    config: { bashTimeoutMs: 120_000 },
    shell,
    outputChars: 30_000,
    outputDir: path.join(cwd, '.out'),
    progress: () => {},
    ...extra,
  } as unknown as ToolContext;
}

describe('check, arguments quoted for the shell that runs them', () => {
  it('bash keeps double quotes with escapes, PowerShell takes single quotes, cmd puts each % outside the quotes', () => {
    expect(quoteFor('bash')('a$b"c`d\\e')).toBe('"a\\$b\\"c\\`d\\\\e"');
    expect(quoteFor('pwsh')("it's $(x) `y` \\$")).toBe("'it''s $(x) `y` \\$'");
    expect(quoteFor('powershell')('it’s')).toBe("'it’’s'");
    expect(quoteFor('cmd')('100% done')).toBe('"100"^%" done"');
    expect(quoteFor('cmd')('dir\\%end\\')).toBe('"dir\\\\"^%"end\\\\"');
  });

  it.each(shells.map((s) => [s.kind, s] as const))('%s hands every argument to the program as it was', async (_kind, shell) => {
    const cwd = tmp();
    write(cwd, 'argv.js', "console.log('ARGV ' + Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64'));\n");
    const quote = quoteFor(shell.kind);
    const run = await runShell(shell, `node ${quote(path.join(cwd, 'argv.js'))} ${SAMPLES.map(quote).join(' ')}`, {
      cwd,
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      logFile: path.join(cwd, 'run.log'),
    });
    const line = run.output.split(/\r?\n/).find((l) => l.startsWith('ARGV '));
    expect(line, run.output).toBeTruthy();
    expect(JSON.parse(Buffer.from(line!.slice(5), 'base64').toString('utf8'))).toEqual(SAMPLES);
  }, 60_000);

  it.skipIf(!goAvailable).each(shells.map((s) => [s.kind, s] as const))('%s: a go filter ending in $ runs the test it names, and new tests are judged on the old code', async (_kind, shell) => {
    const cwd = tmp();
    write(cwd, 'go.mod', 'module calc\n\ngo 1.21\n');
    write(cwd, 'calc.go', 'package calc\n\nfunc Add(a, b int) int { return a + b }\n');
    write(cwd, 'calc_test.go', 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("2 + 3")\n\t}\n}\n\nfunc TestBroken(t *testing.T) {\n\tt.Fatal("always")\n}\n');
    // Before the fix, PowerShell read "TestBroken\$" with the backslash kept: no test matched and the check passed.
    const filtered = await checkTool.execute({ only: ['test'], filter: 'TestBroken$' }, ctxFor(cwd, shell));
    expect(filtered.isError, filtered.content).toBe(true);
    expect(filtered.content).toContain('TestBroken');

    write(cwd, 'calc_test.go', 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("2 + 3")\n\t}\n}\n');
    const originals = new Map<string, Buffer | null>([
      [path.join(cwd, 'calc.go'), Buffer.from('package calc\n\nfunc Add(a, b int) int { return a - b }\n')],
      [path.join(cwd, 'calc_test.go'), null],
    ]);
    const checkpoints = { turns: () => ['t1'], files: () => [...originals.keys()], originals: () => originals };
    const ctx = ctxFor(cwd, shell, { config: { bashTimeoutMs: 120_000, beforeTests: true }, checkpoints });
    // The new test runs on the old code by name, `-run "^(TestAdd)$"`, and fails there: it catches the fix.
    const caught = await checkTool.execute({ only: ['test'] }, ctx);
    expect(caught.isError, caught.content).toBeFalsy();
    expect(caught.display?.kind === 'checks' && caught.display.verdict).toEqual({ kind: 'catches', files: ['calc_test.go'] });
  }, 180_000);

  it('a filter with a double quote is refused where PowerShell or cmd runs the check', async () => {
    const cwd = tmp();
    write(cwd, 'go.mod', 'module calc\n\ngo 1.21\n');
    for (const kind of ['pwsh', 'powershell', 'cmd'] as const) {
      const shell = { kind, path: kind, label: kind, name: kind } as ShellInfo;
      const r = await checkTool.execute({ only: ['test'], filter: 'Test"Add' }, ctxFor(cwd, shell));
      expect(r.isError).toBe(true);
      expect(r.content).toContain('double quote');
    }
  });
});
