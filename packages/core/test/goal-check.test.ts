import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { goalTool, formatGoal } from '../src/tools/goal';
import { checkTool, detectChecks, failureBlocks, readOutput } from '../src/tools/check';
import { jobTool } from '../src/tools/shell-tools';
import { JobManager } from '../src/tools/jobs';
import { detectShell } from '../src/tools/shell';
import type { Goal } from '../src/types';
import type { ToolContext } from '../src/tools/types';

const roots: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-gc-'));
  roots.push(d);
  return d;
};
// A killed background job can hold its folder on Windows for a moment.
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));

function context(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  let goal: Goal | undefined;
  return {
    cwd,
    sessionId: 's',
    callId: 'c1',
    turn: 't',
    signal: new AbortController().signal,
    config: { bashTimeoutMs: 60_000 } as ToolContext['config'],
    shell: detectShell(),
    outputChars: 30_000,
    outputDir: path.join(cwd, '.out'),
    progress: () => {},
    goal: () => goal,
    setGoal: (g) => (goal = g),
    ...extra,
  } as ToolContext;
}

describe('goal', () => {
  it('sets a goal, marks criteria met with evidence, and refuses numbers it does not have', async () => {
    const ctx = context(tmp());
    const set = await goalTool.execute({ objective: 'Add CSV export', criteria: ['Export button on the report page', 'CSV matches the table', 'Tests cover empty reports'] }, ctx);
    expect(set.content).toContain('[ ] 2. CSV matches the table');
    expect(set.content).toContain('3 open.');
    const done = await goalTool.execute({ done: [1, 3], evidence: 'npm test: 14 passed' }, ctx);
    expect(done.content).toMatch(/\[x\] 1\. Export button[\s\S]*\[ \] 2\.[\s\S]*\[x\] 3\./);
    expect(ctx.goal()!.criteria[2].evidence).toBe('npm test: 14 passed');
    const wrong = await goalTool.execute({ done: [7] }, ctx);
    expect(wrong.isError).toBe(true);
    await goalTool.execute({ done: [2] }, ctx);
    expect(formatGoal(ctx.goal()!)).toContain('Every criterion is met.');
    await goalTool.execute({ clear: true }, ctx);
    expect(ctx.goal()).toBeUndefined();
  });
});

describe('goal milestones', () => {
  it('marks the milestone being worked on, and refuses one it does not have', async () => {
    const ctx = context(tmp());
    await goalTool.execute({ objective: 'Move the store to SQLite', criteria: ['Schema and migrations', 'Reads and writes through it', 'Old JSON files imported'] }, ctx);
    const on = await goalTool.execute({ active: 2, done: [1] }, ctx);
    expect(on.content).toContain('[x] 1. Schema and migrations');
    expect(on.content).toContain('[ ] 2. Reads and writes through it (working on it)');
    expect(ctx.goal()!.active).toBe(2);
    expect((await goalTool.execute({ active: 9 }, ctx)).isError).toBe(true);
    // New criteria start a new list, with nothing in progress.
    await goalTool.execute({ objective: 'Move the store to SQLite', criteria: ['Only this'] }, ctx);
    expect(ctx.goal()!.active).toBeUndefined();
  });
});

describe('check', () => {
  it('finds the checks a project declares', () => {
    const node = tmp();
    fs.writeFileSync(path.join(node, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build' } }));
    fs.writeFileSync(path.join(node, 'pnpm-lock.yaml'), '');
    expect(detectChecks(node).map((c) => `${c.name}: ${c.command}`)).toEqual(['types: pnpm run typecheck', 'lint: pnpm run lint', 'test: pnpm run test', 'build: pnpm run build']);
    const go = tmp();
    fs.writeFileSync(path.join(go, 'go.mod'), 'module x\n');
    expect(detectChecks(go).map((c) => c.command)).toEqual(['go vet ./...', 'go test ./...']);
    const py = tmp();
    fs.writeFileSync(path.join(py, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n');
    fs.mkdirSync(path.join(py, 'tests'));
    expect(detectChecks(py).map((c) => c.name)).toEqual(['lint', 'test']);
  });

  it('reads what failed out of common outputs', () => {
    const tsc = readOutput('src/app.ts(12,5): error TS2304: Cannot find name \'widget\'.\nFound 1 error in src/app.ts:12\n');
    expect(tsc.problems).toEqual(["src/app.ts(12,5): error TS2304: Cannot find name 'widget'."]);
    expect(tsc.summary).toBe('Found 1 error in src/app.ts:12');
    const pytest = readOutput('....F.\n=== short test summary info ===\nFAILED tests/test_csv.py::test_empty - AssertionError: assert 0 == 1\n1 failed, 5 passed in 0.12s\n');
    expect(pytest.problems).toEqual(['FAILED tests/test_csv.py::test_empty - AssertionError: assert 0 == 1']);
    expect(pytest.summary).toBe('1 failed, 5 passed in 0.12s');
  });

  it("keeps each failing test's own lines, what it expected and what came", () => {
    const go = '=== RUN   TestCode\n--- FAIL: TestCode (0.00s)\n    errors_task_test.go:14: Code() = 201, want 205\n    errors_task_test.go:15: exit message wrong\n=== RUN   TestOther\n--- PASS: TestOther (0.00s)\nFAIL\nFAIL\tgithub.com/x/errors\t0.012s\n';
    const told = failureBlocks(go);
    expect(told).toContain('--- FAIL: TestCode');
    expect(told).toContain('Code() = 201, want 205');
    expect(told).not.toContain('TestOther');
    const jest = 'FAIL src/sum.test.ts\n  ● sum › adds\n\n    expect(received).toBe(expected)\n\n    Expected: 3\n    Received: 4\n\nTests: 1 failed, 2 passed\n';
    expect(failureBlocks(jest)).toContain('Received: 4');
    // Capped: a run with hundreds of failures does not flood the context.
    expect(failureBlocks(go.repeat(200)).length).toBeLessThanOrEqual(3000);
  });

  it('runs the checks and reports failures as lines to act on', async () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        scripts: {
          typecheck: 'node -e "console.log(\'ok\')"',
          test: 'node -e "console.error(\'src/sum.ts:3:5 - error TS2322: Type string is not assignable to type number.\'); console.error(\'Tests: 1 failed, 4 passed\'); process.exit(1)"',
        },
      }),
    );
    const r = await checkTool.execute({}, context(dir));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^1 of 2 checks failed:/);
    expect(r.content).toContain('✓ types: npm run --silent typecheck');
    expect(r.content).toContain('✗ test: npm run --silent test');
    expect(r.content).toContain('src/sum.ts:3:5 - error TS2322');
    expect(r.content).toContain('Tests: 1 failed, 4 passed');
    expect(r.display?.kind === 'checks' && r.display.results.map((x) => x.ok)).toEqual([true, false]);
    const none = await checkTool.execute({}, context(tmp()));
    expect(none.content).toMatch(/^No checks found/);
    // A package folder with no project file of its own runs the project's checks, from the folder that has them.
    fs.mkdirSync(path.join(dir, 'src', 'pkg'), { recursive: true });
    const sub = await checkTool.execute({ path: 'src/pkg', only: ['types'] }, context(dir));
    expect(sub.content).toMatch(/^All 1 checks passed:/);
    expect(sub.content).toContain('✓ types: npm run --silent typecheck');

    // With a session's checkpoints: failures seen before any change are the project's, and marked when they recur.
    const changed: string[] = [];
    const checkpoints = { turns: () => ['t1'], files: () => changed };
    const before = await checkTool.execute({}, context(dir, { checkpoints } as never));
    expect(before.content).toContain('These failures come from the project as it was');
    changed.push(path.join(dir, 'src/sum.ts'));
    const after = await checkTool.execute({}, context(dir, { checkpoints } as never));
    expect(after.content).toContain('src/sum.ts:3:5 - error TS2322: Type string is not assignable to type number.  (failing before this session changed anything)');
    expect(after.content).not.toContain('These failures come from the project as it was');
  }, 60_000);
});

describe('job wait', () => {
  it('waits for a line in a background job, or reports that it did not come', async () => {
    const dir = tmp();
    const shell = detectShell();
    const jobs = new JobManager(shell, path.join(dir, 'jobs'));
    const ctx = context(dir, { jobs });
    const job = jobs.start('echo starting; sleep 1; echo "listening on http://localhost:5173"; sleep 20', dir);
    try {
      const r = await jobTool.execute({ id: job.id, action: 'wait', until: 'listening on', timeoutMs: 10_000 }, ctx);
      expect(r.content).toMatch(/matched \/listening on\/ after/);
      expect(r.content).toContain('http://localhost:5173');
      const miss = await jobTool.execute({ id: job.id, action: 'wait', until: 'never printed', timeoutMs: 1000 }, ctx);
      expect(miss.content).toContain('no match after 1 s; it is still running');
    } finally {
      jobs.disposeAll();
      // Stopping is asynchronous on Windows; its folder stays locked until the job has ended.
      for (let i = 0; i < 50 && !jobs.peek(job.id)?.done; i++) await new Promise((r) => setTimeout(r, 100));
    }
  }, 30_000);
});

describe('remember', () => {
  it('keeps short notes per project, outside the repository, and replaces a wrong one', async () => {
    const home = tmp();
    const before = process.env.FAVILLA_HOME;
    process.env.FAVILLA_HOME = home;
    try {
      const { rememberTool, readMemory, memoryFile } = await import('../src/tools/memory');
      const project = tmp();
      const ctx = context(project);
      await rememberTool.execute({ note: 'Tests run with pnpm test; vitest needs CI=1 to exit.' }, ctx);
      await rememberTool.execute({ note: 'The API client lives in src/net/client.ts.' }, ctx);
      await rememberTool.execute({ note: 'The API client lives in src/net/client.ts.' }, ctx);
      expect(readMemory(project)).toEqual(['Tests run with pnpm test; vitest needs CI=1 to exit.', 'The API client lives in src/net/client.ts.']);
      expect(memoryFile(project).startsWith(home)).toBe(true);
      expect(fs.readdirSync(project)).toEqual([]);
      const wrong = await rememberTool.execute({ note: 'x', replaces: 'not a note' }, ctx);
      expect(wrong.isError).toBe(true);
      await rememberTool.execute({ note: 'The API client moved to src/api/client.ts.', replaces: 'The API client lives in src/net/client.ts.' }, ctx);
      expect(readMemory(project)).toEqual(['Tests run with pnpm test; vitest needs CI=1 to exit.', 'The API client moved to src/api/client.ts.']);
    } finally {
      if (before === undefined) delete process.env.FAVILLA_HOME;
      else process.env.FAVILLA_HOME = before;
    }
  });

  it('keeps notes about the user for every project apart, moves a note between the two, and keeps no secret', async () => {
    const home = tmp();
    const before = process.env.FAVILLA_HOME;
    process.env.FAVILLA_HOME = home;
    try {
      const { rememberTool, readMemory, readGlobalMemory, globalMemoryFile } = await import('../src/tools/memory');
      const one = tmp();
      const other = tmp();
      await rememberTool.execute({ note: 'Sign emails as Kai Luo.', scope: 'global' }, context(one));
      await rememberTool.execute({ note: 'The dev server runs on port 5174.' }, context(one));
      // Read from another folder: the user's note is there, the first project's is not.
      expect(readGlobalMemory()).toEqual(['Sign emails as Kai Luo.']);
      expect(readMemory(other)).toEqual([]);
      expect(globalMemoryFile().startsWith(home)).toBe(true);
      // A preference kept for one project turns out to hold everywhere: it moves.
      await rememberTool.execute({ note: 'Use pnpm here.' }, context(other));
      await rememberTool.execute({ note: 'The user uses pnpm in every project.', scope: 'global', replaces: 'Use pnpm here.' }, context(other));
      expect(readMemory(other)).toEqual([]);
      expect(readGlobalMemory()).toEqual(['Sign emails as Kai Luo.', 'The user uses pnpm in every project.']);
      for (const secret of ['The OpenAI key is sk-proj-abcdefghijklmnopqrstuvwx', 'The server password is hunter2', '数据库密码是 abc123']) {
        const r = await rememberTool.execute({ note: secret, scope: 'global' }, context(one));
        expect(r.isError, secret).toBe(true);
      }
      expect(readGlobalMemory()).toHaveLength(2);
    } finally {
      if (before === undefined) delete process.env.FAVILLA_HOME;
      else process.env.FAVILLA_HOME = before;
    }
  });

  // The user writes in these notes through Settings; a note the agent added had rewritten them one bullet a line and
  // dropped the oldest lines past 4,000 characters, headings and all (2026-11-06).
  it('keeps what the user wrote in the notes: a note goes on at the end, and past the size it is refused, not cut', async () => {
    const home = tmp();
    const before = process.env.FAVILLA_HOME;
    process.env.FAVILLA_HOME = home;
    try {
      const { rememberTool, globalMemoryFile } = await import('../src/tools/memory');
      const file = globalMemoryFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const mine = '# How I work\nShort answers, in Chinese.\n\nMy machine: Windows, pnpm, Node 22.\n';
      fs.writeFileSync(file, mine);
      expect((await rememberTool.execute({ note: 'Sign emails as Kai.', scope: 'global' }, context(tmp()))).isError).toBeFalsy();
      expect(fs.readFileSync(file, 'utf8')).toBe(`${mine.trimEnd()}\n- Sign emails as Kai.\n`);
      // Near the size with the user's own words: the next note is refused and the file left as it was.
      const full = `${mine}${'w'.repeat(3990 - mine.length)}\n`;
      fs.writeFileSync(file, full);
      const refused = await rememberTool.execute({ note: 'The user likes tea.', scope: 'global' }, context(tmp()));
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain('The notes are full');
      expect(fs.readFileSync(file, 'utf8')).toBe(full);
      // A file of the tool's own bullets still loses its oldest past the size.
      fs.writeFileSync(file, Array.from({ length: 80 }, (_, i) => `- Note ${i} ${'x'.repeat(40)}`).join('\n') + '\n');
      expect((await rememberTool.execute({ note: 'The newest note.', scope: 'global' }, context(tmp()))).isError).toBeFalsy();
      const kept = fs.readFileSync(file, 'utf8');
      expect(kept.length).toBeLessThanOrEqual(4000);
      expect(kept).not.toContain('- Note 0 ');
      expect(kept.trimEnd().endsWith('- The newest note.')).toBe(true);
    } finally {
      if (before === undefined) delete process.env.FAVILLA_HOME;
      else process.env.FAVILLA_HOME = before;
    }
  });
});

describe('review', () => {
  it("is given the user's own words: this turn's, and the request before a bare go-on", async () => {
    const { askedThisTurn } = await import('../src/tools/review');
    const msg = (turn: string, text: string, extra: object = {}) => ({ id: turn + text.length, role: 'user', origin: 'user', turn, time: 0, parts: [{ type: 'text', text }], ...extra }) as never;
    const issue = `# Search leaves the highlight on\n\n${'The colour stays on across a newline when a match ends there. '.repeat(5)}`;
    const history = [
      msg('t1', issue),
      { id: 'a1', role: 'assistant', turn: 't1', time: 0, parts: [{ type: 'text', text: 'Fixed.' }] } as never,
      msg('t2', 'continue'),
      { id: 'n1', role: 'user', origin: 'user', turn: 't2', time: 0, parts: [{ type: 'text', text: 'Favilla note', synthetic: true }] } as never,
    ];
    expect(askedThisTurn(history, 't1')).toBe(issue.trim());
    const t2 = askedThisTurn(history, 't2');
    expect(t2.startsWith('# Search leaves the highlight on')).toBe(true);
    expect(t2.endsWith('continue')).toBe(true);
    expect(t2).not.toContain('Favilla note');
  });
});
