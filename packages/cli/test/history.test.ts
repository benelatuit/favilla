import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The suite's fixed test key seals; the home is this file's own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-history-'));
process.env.FAVILLA_HOME = home;
const { addHistory, loadHistory } = await import('../src/tui/history');
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('prompt history', () => {
  it('keeps what was sent sealed line by line, and gives it back newest copy last', () => {
    addHistory('fix the login page', home);
    addHistory('run the tests', home);
    addHistory('fix the login page', home);
    const raw = fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8');
    expect(raw).not.toContain('login');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(3);
    expect(loadHistory()).toEqual(['run the tests', 'fix the login page']);
  });
});
