import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkShadow, readJestReport, readPytest, readTap, shadowFiles, shadowKind, trustShadow } from '../src/agent/shadow-tests';

// Shadow tests had been written for Go projects alone; the runners that report test by test now get them too
// (2026-11-06): node --test, vitest, jest and pytest.
const top = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-shadow-kinds-'));
afterAll(() => fs.rmSync(top, { recursive: true, force: true, maxRetries: 3 }));
const signal = new AbortController().signal;

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(top, name);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

describe('which projects get shadow tests', () => {
  it('reads it from what runs their tests', () => {
    expect(shadowKind(project('k-go', { 'go.mod': 'module x\n' }))).toBe('go');
    expect(shadowKind(project('k-node', { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }))).toBe('node');
    expect(shadowKind(project('k-vitest', { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }))).toBe('vitest');
    expect(shadowKind(project('k-jest', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) }))).toBe('jest');
    expect(shadowKind(project('k-py', { 'pytest.ini': '[pytest]\n', 'app.py': 'x = 1\n' }))).toBe('pytest');
    expect(shadowKind(project('k-none', { 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) }))).toBeNull();
  });
});

describe("the runners' reports", () => {
  it('reads vitest and jest JSON by test title, and a file that does not load as no results', () => {
    const r = readJestReport(JSON.stringify({ testResults: [{ assertionResults: [{ title: 'ShadowFix adds', status: 'failed', failureMessages: ['expected 5, got -1'] }, { title: 'ShadowKeep zero', status: 'passed' }] }] }));
    expect([...r.results]).toEqual([['ShadowFix adds', 'fail'], ['ShadowKeep zero', 'pass']]);
    expect(r.text).toContain('expected 5, got -1');
    const broken = readJestReport(JSON.stringify({ testResults: [{ message: "Cannot find module '../src/add'", assertionResults: [] }] }));
    expect(broken.results.size).toBe(0);
    expect(broken.text).toContain('Cannot find module');
  });

  it('reads TAP from node --test, nested tests too', () => {
    const tap = ['TAP version 13', '# Subtest: adding', '    ok 1 - ShadowKeep zero', '    not ok 2 - ShadowFix adds', '      ---', "      error: 'Expected values to be strictly equal'", '      ...', 'not ok 1 - adding'].join('\n');
    const r = readTap(tap);
    expect(r.results.get('ShadowKeep zero')).toBe('pass');
    expect(r.results.get('ShadowFix adds')).toBe('fail');
    expect(r.text).toContain('strictly equal');
  });

  it('reads pytest -rA by test name', () => {
    const out = ['F.', '=================================== FAILURES ===================================', '______ test_shadow_fix_adds ______', 'E   assert -1 == 5', '=========================== short test summary info ============================', 'PASSED tests/test_shadow.py::test_shadow_keep_zero', 'FAILED tests/test_shadow.py::test_shadow_fix_adds - assert -1 == 5'].join('\n');
    const r = readPytest(out);
    expect([...r.results]).toEqual([['test_shadow_keep_zero', 'pass'], ['test_shadow_fix_adds', 'fail']]);
    expect(r.text).toContain('assert -1 == 5');
  });
});

describe('shadow tests under node --test', () => {
  const test = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/add.mjs';",
    "test('ShadowFix adds two numbers', () => assert.equal(add(2, 3), 5));",
    "test('ShadowKeep adds zeros', () => assert.equal(add(0, 0), 0));",
    "test('ShadowFix a test that passes before the fix is not trusted', () => assert.equal(add(1, 0), 1));",
  ].join('\n');
  const pkg = JSON.stringify({ type: 'module', scripts: { test: 'node --test' } });

  it('trusts the tests that behave as named on the old code, and sends back a change they fail on', async () => {
    const copy = project('n-copy', { 'package.json': pkg, 'src/add.mjs': 'export const add = (a, b) => a - b;\n', 'test/shadow.test.mjs': test });
    const files = shadowFiles(copy, ['test/shadow.test.mjs', 'src/add.mjs'], 'node');
    expect(files.map((f) => f.rel)).toEqual(['test/shadow.test.mjs']);
    const set = await trustShadow(copy, files, signal, 'node');
    expect(set?.trusted.sort()).toEqual(['ShadowFix adds two numbers', 'ShadowKeep adds zeros']);

    const unfixed = project('n-unfixed', { 'package.json': pkg, 'src/add.mjs': 'export const add = (a, b) => a - b;\n', 'test/keep.txt': '' });
    const failed = await checkShadow(unfixed, set!, signal);
    expect(failed.failing).toEqual(['ShadowFix adds two numbers']);
    expect(failed.placed.length).toBe(1);

    const fixed = project('n-fixed', { 'package.json': pkg, 'src/add.mjs': 'export const add = (a, b) => a + b;\n', 'test/keep.txt': '' });
    const passed = await checkShadow(fixed, set!, signal);
    expect(passed.failing).toEqual([]);
    expect(passed.unbuilt).toBe(false);
    expect(fs.existsSync(path.join(fixed, 'test', 'shadow.test.mjs'))).toBe(false);
  }, 60_000);
});

let pytest = false;
try {
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'pytest', '--version'], { stdio: 'ignore', windowsHide: true });
  pytest = true;
} catch {
  /* no pytest on this machine */
}

describe.skipIf(!pytest)('shadow tests under pytest', () => {
  it('trusts the tests that behave as named on the old code, and passes a fixed change', async () => {
    const test = ['from app import add', '', 'def test_shadow_fix_adds():', '    assert add(2, 3) == 5', '', 'def test_shadow_keep_zeros():', '    assert add(0, 0) == 0', ''].join('\n');
    const copy = project('p-copy', { 'pytest.ini': '[pytest]\npythonpath = .\n', 'app.py': 'def add(a, b):\n    return a - b\n', 'tests/test_shadow.py': test });
    const set = await trustShadow(copy, shadowFiles(copy, ['tests/test_shadow.py'], 'pytest'), signal, 'pytest');
    expect(set?.trusted.sort()).toEqual(['test_shadow_fix_adds', 'test_shadow_keep_zeros']);
    const fixed = project('p-fixed', { 'pytest.ini': '[pytest]\npythonpath = .\n', 'app.py': 'def add(a, b):\n    return a + b\n', 'tests/keep.txt': '' });
    const r = await checkShadow(fixed, set!, signal);
    expect(r.failing).toEqual([]);
    expect(r.unbuilt).toBe(false);
  }, 60_000);
});
