import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { grepTool } from '../src/tools/search-tools';
import type { ToolContext } from '../src/tools/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-search-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
fs.writeFileSync(path.join(root, 'a.go'), 'package main\n\ntype Any interface{}\n\nfunc f(x int) int { return items[x] }\n');
fs.writeFileSync(path.join(root, 'b.go'), 'package main\n\nvar cache map[string]interface{}\n');
const ctx = { cwd: root, turn: 't', config: {}, outputChars: 20_000, signal: new AbortController().signal } as unknown as ToolContext;
const text = (r: { content: unknown }) => String(r.content);

describe('a search pattern that is not a regular expression', () => {
  // Each of these is what a model copies out of code, and each stops ripgrep with "regex parse error".
  it.each([
    ['interface{}', 'content', ['a.go:3:type Any interface{}', 'b.go:3:var cache map[string]interface{}']],
    ['f(x', 'content', ['a.go:5:func f(x int) int { return items[x] }']],
    ['items[x', 'files', ['a.go']],
    ['map[string]interface{', 'count', ['b.go:1']],
  ] as const)('is searched as plain text, and the answer says so: %s', async (pattern, mode, lines) => {
    const r = await grepTool.execute({ pattern, mode }, ctx);
    expect(r.isError).toBeFalsy();
    for (const line of lines) expect(text(r)).toContain(line);
    expect(text(r)).toContain(`"${pattern}" is not a valid regular expression, so it was searched as plain text.`);
  });

  it('says so in the grouped form too', async () => {
    const r = await grepTool.execute({ pattern: 'interface{}', mode: 'content', grouped: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/^\["interface\{\}" is not a valid regular expression, so it was searched as plain text\.\]\n2 matching lines in 2 files/);
  });

  it('says what it looked for when the plain text is not there either', async () => {
    const r = await grepTool.execute({ pattern: 'struct{' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('No matches for the plain text "struct{". It is not a valid regular expression, so it was searched as it is written.');
  });

  it('leaves a valid pattern a regular expression', async () => {
    const r = await grepTool.execute({ pattern: 'interface\\{\\}|f\\(x', mode: 'count' }, ctx);
    expect(text(r)).toContain('a.go:2');
    expect(text(r)).not.toContain('plain text');
    expect(text(await grepTool.execute({ pattern: 'nothing-like-this' }, ctx))).toBe('No matches for /nothing-like-this/.');
  });
});
