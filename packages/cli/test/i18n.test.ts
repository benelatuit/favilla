import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setLanguage, t, zh } from '../src/tui/i18n';

const dir = path.join(import.meta.dirname, '../src/tui');

/** Every string the terminal UI passes to t(), and the command details it translates. */
export function usedKeys(): Set<string> {
  const keys = new Set<string>();
  const lit = String.raw`'((?:[^'\\]|\\.)*)'`;
  for (const f of fs.readdirSync(dir).filter((x) => /\.tsx?$/.test(x))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of s.matchAll(new RegExp(String.raw`\bt\(\s*` + lit, 'g'))) keys.add(m[1]);
    for (const m of s.matchAll(new RegExp(String.raw`\bt\([^'()]*\?\s*` + lit + String.raw`\s*:\s*` + lit, 'g'))) {
      keys.add(m[1]);
      keys.add(m[2]);
    }
    if (f === 'commands.ts') for (const m of s.matchAll(new RegExp(String.raw`detail: ` + lit, 'g'))) keys.add(m[1]);
  }
  return new Set([...keys].map((k) => k.replace(/\\'/g, "'").replace(/\\\\/g, '\\')));
}

describe('terminal UI language', () => {
  it('has Chinese for every string it shows', () => {
    const missing = [...usedKeys()].filter((k) => !(k in zh));
    expect(missing).toEqual([]);
  });

  it('keeps the placeholders of each template in its Chinese', () => {
    for (const [k, v] of Object.entries(zh)) {
      const want = (k.match(/\{\w+\}/g) ?? []).sort();
      const got = (v.match(/\{\w+\}/g) ?? []).sort();
      expect(got, k).toEqual(want);
    }
  });

  it('fills placeholders and follows the setting', () => {
    setLanguage('zh-CN');
    expect(t('{n} steps', { n: 3 })).toBe(zh['{n} steps'].replace('{n}', '3'));
    setLanguage('en');
    expect(t('{n} steps', { n: 3 })).toBe('3 steps');
  });
});
