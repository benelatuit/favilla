import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileTracker } from '../src/tools/filestate';
import { evidenceSummary, observeOutcome, recoveryNote, restoreReads, snapshotVersions } from '../src/agent/evidence';
import { forDisk, fromDisk, release } from '../src/store/pack';
import { BlobStore } from '../src/store/blobs';
import type { Message, ToolEvidence } from '../src/types';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-evidence-'));
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));
const message = (evidence: ToolEvidence, id = 'c1'): Message => ({
  id, role: 'user', time: 1, parts: [{ type: 'tool_result', callId: id, name: 'check', content: 'output', evidence }],
});
const terminal = (output: string, exitCode: number | null = 1) => ({
  content: output, isError: exitCode !== 0,
  display: { kind: 'terminal' as const, command: 'npm test', cwd, output, exitCode, durationMs: 10 },
});

describe('versioned working evidence', () => {
  it.each([
    'ok  example 0.1s [no tests to run]', '? example [no test files]',
    'Ran 0 tests in 0.000s\nOK', 'NO TESTS RAN', 'running 0 tests\ntest result: ok. 0 passed; 0 failed',
    'No tests found, exiting with code 0', '  0 passing (1ms)', 'collected 0 items\nno tests ran in 0.01s',
  ])('records an empty runner as unknown: %s', (output) => {
    const e = observeOutcome('shell', {}, terminal(output, 0), cwd, []);
    expect(e.run).toMatchObject({ outcome: 'unknown', diagnostic: 'ran no tests' });
    expect(e.failure).toBeUndefined();
    const check = observeOutcome('check', {}, { content: '', display: { kind: 'checks', found: ['test'], results: [{ name: 'test', command: 'npm test', ok: true, durationMs: 1, summary: output, problems: [] }] } }, cwd, []);
    expect(check.run).toMatchObject({ outcome: 'unknown', diagnostic: 'ran no tests' });
  });

  it('keeps real passes and failures when another package has no tests', () => {
    for (const output of ['ok example 0.1s\n? empty [no test files]', 'running 2 tests\ntest result: ok. 2 passed; 0 failed\nrunning 0 tests\ntest result: ok. 0 passed; 0 failed']) {
      expect(observeOutcome('shell', {}, terminal(output, 0), cwd, []).run?.outcome).toBe('passed');
    }
    expect(observeOutcome('shell', {}, terminal('No tests found\nFAIL', 1), cwd, []).run?.outcome).toBe('failed');
  });

  it('keeps exact read ranges across storage and release without granting stale edit permission', () => {
    const file = path.join(cwd, 'read.ts');
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    const tracker = new FileTracker();
    tracker.recordRead(file);
    tracker.recordShown(file, 'read1', 2, 2, 4);
    const m = message({ reads: tracker.shownBy('read1') }, 'read1');
    m.parts[0] = { ...m.parts[0], content: 'large\n'.repeat(1000) } as typeof m.parts[0];
    const blobs = new BlobStore(path.join(cwd, 'blobs'));
    release(m, blobs);
    const stored = fromDisk(JSON.parse(JSON.stringify(forDisk(m, blobs))));
    const restored = new FileTracker();
    restoreReads(restored, [stored, { ...stored, replay: true }]);
    expect(restored.coverage()).toEqual([{ path: file, total: 4, ranges: [[2, 2]] }]);
    expect(restored.checkEditable(file)).toContain('not been read');
    expect(restored.earlierRead(file, 2, 2, () => false)).toBeUndefined();
    const stamp = fs.statSync(file);
    fs.writeFileSync(file, 'one\nnew\nthree\n');
    fs.utimesSync(file, stamp.atime, stamp.mtime);
    expect(restored.coverage()).toEqual([]);
    expect(tracker.checkEditable(file)).toContain('modified');
  });

  it('preserves scoped positive and negative observations, marking changed inputs stale', () => {
    const file = path.join(cwd, 'run.js');
    fs.writeFileSync(file, 'module.exports = 1;\n');
    const evidence = observeOutcome('shell', { command: 'npm test' }, terminal('AssertionError: expected 2, got 1'), cwd, snapshotVersions([file]));
    const history = [message(evidence)];
    expect(evidenceSummary(history, cwd)).toContain('failed');
    expect(evidenceSummary(history, cwd)).toContain('AssertionError');
    expect(evidenceSummary(history, cwd)).toContain('tracked inputs unchanged');
    expect(evidenceSummary(history, cwd)).not.toContain('STALE');
    fs.writeFileSync(file, 'module.exports = 2;\n');
    expect(evidenceSummary(history, cwd)).toContain('STALE');
    const passed = observeOutcome('shell', { command: 'npm test' }, terminal('ok', 0), cwd, snapshotVersions([file]));
    history.push(message(passed, 'c2'));
    expect(evidenceSummary(history, cwd)).toContain('passed');
    expect(evidenceSummary(history, cwd)).not.toContain('whole project verified');
  });

  it('invalidates an earlier check for a subsequently added file, but ignores replayed writes', () => {
    const evidence = observeOutcome('shell', { command: 'npm test' }, terminal('ok', 0), cwd, []);
    const write = message({ writes: [path.join(cwd, 'added.js')] }, 'w1');
    expect(evidenceSummary([message(evidence), write], cwd)).toContain('STALE');
    expect(evidenceSummary([message(evidence), { ...write, replay: true }], cwd)).not.toContain('STALE');
  });

  it('does not call empty, background, interrupted or before-code checks a current pass', () => {
    const empty = observeOutcome('check', {}, { content: 'No checks found', display: { kind: 'checks', results: [], found: [] } }, cwd, []);
    expect(empty.run).toBeUndefined();
    const stopped = observeOutcome('shell', {}, { ...terminal('Stopped', 0), display: { ...terminal('Stopped', 0).display, stoppedFor: 'memory' } }, cwd, []);
    expect(stopped.run?.outcome).toBe('unknown');
    const background = observeOutcome('shell', {}, { ...terminal('', null), display: { ...terminal('', null).display, background: 'job1' } }, cwd, []);
    expect(background.run?.outcome).toBe('unknown');
    const old = observeOutcome('check', { before: true }, { content: 'ok', display: { kind: 'checks', results: [{ name: 'test', command: 'npm test', ok: true, durationMs: 1, problems: [] }], found: ['test'], before: true } }, cwd, []);
    expect(evidenceSummary([message(old)], cwd)).toContain('before-code');
    const weak = observeOutcome('check', {}, {
      content: 'Current tests pass but do not discriminate.',
      display: { kind: 'checks', results: [{ name: 'test', command: 'npm test', ok: true, durationMs: 1, problems: [] }], found: ['test'], verdict: { kind: 'pass-before', files: ['test.js'] }, probe: { results: [{ path: 'calc.js', line: 3, outcome: 'survived' }] } },
    }, cwd, []);
    expect(evidenceSummary([message(weak)], cwd)).toContain('pass-before');
    expect(evidenceSummary([message(weak)], cwd)).toContain('calc.js:3 survived');
  });

  it('reads red from a green exit that printed failures, and a closed pipe as no failure', () => {
    const run = (output: string, exit: number, command: string) => ({ ...terminal(output, exit), isError: false, display: { ...terminal(output, exit).display, command } });
    const red = observeOutcome('shell', {}, run('--- FAIL: TestX (0.00s)\nFAIL', 0, 'go test ./... ; echo done'), cwd, []);
    expect(red.failure?.kind).toBe('assertion');
    expect(red.run?.outcome).toBe('failed');
    expect(observeOutcome('shell', {}, run('a.go', 141, 'find . | head -n 1'), cwd, []).failure).toBeUndefined();
    const cut = observeOutcome('shell', {}, run('ok', 141, 'go test ./... | head -n 1'), cwd, []);
    expect(cut.run?.outcome).toBe('unknown');
  });

  it('records an uncaught Python traceback even when a later command exits zero', () => {
    const output = 'Traceback (most recent call last):\n  File "<stdin>", line 3, in <module>\nAssertionError\n M source.py';
    const command = 'python - <<\'PY\'\nassert False\nPY\ngit status --short';
    const result = { ...terminal(output, 0), display: { ...terminal(output, 0).display, command } };
    const e = observeOutcome('shell', {}, result, cwd, []);
    expect(e.run?.outcome).toBe('failed');
    expect(e.failure?.kind).toBe('assertion');
  });

  it('uses distinct repeated-failure guidance, without diagnosing a root cause from one failure', () => {
    const environment = observeOutcome('shell', {}, terminal('npm: command not found', 127), cwd, []);
    expect(environment.failure?.kind).toBe('environment');
    expect(observeOutcome('shell', {}, terminal('spawn npm ENOENT', null), cwd, []).failure?.kind).toBe('environment');
    expect(recoveryNote([], environment)).toBe('');
    expect(recoveryNote([environment], environment)).toContain('executable and working directory');
    expect(recoveryNote([environment, environment], environment)).toBe('');
    const assertion = observeOutcome('shell', {}, terminal('AssertionError: expected 2, got 1'), cwd, []);
    expect(assertion.failure?.kind).toBe('assertion');
    expect(recoveryNote([assertion], assertion)).toContain('failing input');
    const build = observeOutcome('shell', {}, terminal('error TS2307: Cannot find module "./local"'), cwd, []);
    expect(build.failure?.kind).toBe('build');
    expect(recoveryNote([build], build)).toContain('diagnostic');
  });
});
