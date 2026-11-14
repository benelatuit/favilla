import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkShadow, shadowFiles, shadowNote, shadowProject, trustShadow } from '../src/agent/shadow-tests';

const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

// A module whose Sign reads "+5" and "-5" but neither a Unicode minus nor leading spaces: the bug a request reports.
const SOURCE = `package num

import "strings"

func Sign(s string) int {
	switch {
	case strings.HasPrefix(s, "-"):
		return -1
	case strings.HasPrefix(s, "+"):
		return 1
	}
	return 0
}
`;
const NARROW = SOURCE.replace('case strings.HasPrefix(s, "-"):', 'case strings.HasPrefix(s, "-"), strings.HasPrefix(s, "\\u2212"):');
const WHOLE = NARROW.replace('switch {', 's = strings.TrimSpace(s)\n\tswitch {');
// What a tester writes: two fix tests that fail before the change, one that already passes (not to be trusted),
// and a keep test.
const SHADOW = `package num

import "testing"

func TestShadowFixUnicodeMinus(t *testing.T) {
	if Sign("\\u22125") != -1 {
		t.Fatal("a Unicode minus reads as positive")
	}
}

func TestShadowFixLeadingSpace(t *testing.T) {
	if Sign("  -5") != -1 {
		t.Fatal("a minus after spaces reads as positive")
	}
}

func TestShadowFixAlreadyWorks(t *testing.T) {
	if Sign("-5") != -1 {
		t.Fatal("plain minus")
	}
}

func TestShadowKeepPlus(t *testing.T) {
	if Sign("+5") != 1 {
		t.Fatal("plus")
	}
}
`;

function module(dir: string, source: string): void {
  fs.mkdirSync(path.join(dir, 'num'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/shadow\n\ngo 1.21\n');
  fs.writeFileSync(path.join(dir, 'num', 'num.go'), source);
}

describe.skipIf(!hasGo)('shadow tests', () => {
  it('trusts what behaves as named before the change, and reports what still fails after it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-shadow-'));
    const copy = path.join(root, 'copy');
    const work = path.join(root, 'work');
    try {
      module(copy, SOURCE);
      fs.writeFileSync(path.join(copy, 'num', 'shadow_test.go'), SHADOW);
      expect(shadowProject(copy)).toBe(true);
      const files = shadowFiles(copy, ['num/shadow_test.go', 'num/num.go']);
      expect(files.map((f) => f.rel)).toEqual(['num/shadow_test.go']);
      const signal = new AbortController().signal;
      const set = await trustShadow(copy, files, signal);
      // The fix test that already passes on the old code tells nothing: it is left out.
      expect(set?.trusted.sort()).toEqual(['TestShadowFixLeadingSpace', 'TestShadowFixUnicodeMinus', 'TestShadowKeepPlus']);

      // The narrow fix: one of the two fix tests still fails, and the tests stay for the agent to run.
      module(work, NARROW);
      const narrow = await checkShadow(work, set!, signal);
      expect(narrow.unbuilt).toBe(false);
      expect(narrow.failing).toEqual(['TestShadowFixLeadingSpace']);
      expect(narrow.placed).toHaveLength(1);
      expect(fs.existsSync(path.join(work, 'num', 'shadow_test.go'))).toBe(true);
      const note = shadowNote(narrow, (abs) => path.relative(work, abs).replace(/\\/g, '/'));
      expect(note).toContain('One of them fails');
      expect(note).toContain('num/shadow_test.go');
      expect(note).toContain('a minus after spaces reads as positive');
      fs.rmSync(path.join(work, 'num', 'shadow_test.go'));

      // The whole fix: everything passes and nothing is left in the working tree.
      module(work, WHOLE);
      const whole = await checkShadow(work, set!, signal);
      expect(whole.failing).toEqual([]);
      expect(whole.placed).toEqual([]);
      expect(fs.existsSync(path.join(work, 'num', 'shadow_test.go'))).toBe(false);

      // A file of that name the project has already is never overwritten.
      fs.writeFileSync(path.join(work, 'num', 'shadow_test.go'), 'package num\n');
      const kept = await checkShadow(work, set!, signal);
      expect(kept.placed).toEqual([]);
      expect(fs.readFileSync(path.join(work, 'num', 'shadow_test.go'), 'utf8')).toBe('package num\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);

  it('says when the tests no longer build against the change', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-shadow-'));
    try {
      module(path.join(root, 'copy'), SOURCE);
      fs.writeFileSync(path.join(root, 'copy', 'num', 'shadow_test.go'), SHADOW);
      const signal = new AbortController().signal;
      const set = await trustShadow(path.join(root, 'copy'), shadowFiles(path.join(root, 'copy'), ['num/shadow_test.go']), signal);
      // The change renamed what the tests call.
      module(path.join(root, 'work'), SOURCE.replace('func Sign(', 'func SignOf('));
      const r = await checkShadow(path.join(root, 'work'), set!, signal);
      expect(r.unbuilt).toBe(true);
      expect(shadowNote(r, (abs) => abs)).toContain('do not build against your change');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
