import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setLanguage, t, zh } from '../src/tui/i18n';
import { guardReason } from '@favilla/core/guard/i18n';
import type { ToolResultPart } from '@favilla/core';
import { toolOutcomeDetail } from '../src/tui/format';

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

  it('keeps terminal Chinese free of semicolons, parentheses, contrast-rhetoric, and unspaced English words', () => {
    const entries = Object.entries(zh);
    expect(entries.filter(([, v]) => /[;；]/.test(v))).toEqual([]);
    expect(entries.filter(([, v]) => /[()（）]/.test(v))).toEqual([]);
    expect(entries.filter(([, v]) => /不是.*而是/.test(v))).toEqual([]);
    expect(entries.filter(([, v]) => /智能体|子代理|主代理|分叉|技能/.test(v))).toEqual([]);
    // Strip {placeholder} tokens first, then ensure every ASCII letter is separated from adjacent Han characters.
    const unspaced = entries.filter(([, v]) => {
      const clean = v.replace(/\{\w+\}/g, '');
      return /[一-鿿][A-Za-z]|[A-Za-z][一-鿿]/.test(clean);
    });
    expect(unspaced).toEqual([]);
    expect(zh.shell).toBe('shell');
  });

  it('says why the guard asks in the same words as the window', () => {
    setLanguage('zh-CN');
    const say = (k: string) => t(k);
    expect(guardReason(say, 'This push rewrites or deletes history on the remote.')).toBe('这次推送会改写或删除远端历史。');
    expect(guardReason(say, 'Deletes C:/Users/me: it targets your home folder.')).toBe('删除 C:/Users/me：目标是用户主目录。');
    expect(toolOutcomeDetail({ type: 'tool_result', callId: 'c1', name: 'shell', content: "The user did not allow this command (This push rewrites or deletes history on the remote.). Don't run it; find another way or ask the user." } as ToolResultPart)).toBe('这次推送会改写或删除远端历史。');
    setLanguage('en');
    expect(guardReason(say, 'This push rewrites or deletes history on the remote.')).toBe('This push rewrites or deletes history on the remote.');
  });
});
