import { describe, expect, it } from 'vitest';
import { count, translate } from '../src/lib/i18n';
import { age, diffOp, shortTime } from '../src/lib/format';
import { EFFORTS } from '../src/lib/modes';

describe('small words', () => {
  it('counts one in the singular and the rest in the plural, in both languages', () => {
    const en = (k: string) => translate('en', k);
    const zh = (k: string) => translate('zh-CN', k);
    expect(count(en, 1, '{n} file', '{n} files')).toBe('1 file');
    expect(count(en, 3, '{n} file', '{n} files')).toBe('3 files');
    expect(count(en, 1, '{n} request', '{n} requests')).toBe('1 request');
    expect(count(zh, 1, '{n} step', '{n} steps')).toBe('1 步');
    expect(count(zh, 4, '{n} model', '{n} models')).toBe('4 个模型');
  });

  it('names a changed file by git’s letter', () => {
    expect(['add', 'delete', 'move', 'update'].map(diffOp)).toEqual(['A', 'D', 'R', 'M']);
  });

  it('lists the efforts lowest first', () => {
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('gives a session’s age as short as the language writes it, and a date past a week', () => {
    const now = Date.UTC(2026, 10, 17, 12, 0);
    const ago = (min: number) => now - min * 60_000;
    expect(age(ago(0.5), 'en', now)).toBe('now');
    expect(age(ago(5), 'en', now)).toBe('5m');
    expect(age(ago(3 * 60), 'en', now)).toBe('3h');
    expect(age(ago(2 * 24 * 60), 'en', now)).toBe('2d');
    expect(age(ago(5), 'zh-CN', now)).toBe('5分钟');
    expect(age(ago(3 * 60), 'zh-CN', now)).toBe('3小时');
    expect(age(ago(9 * 24 * 60), 'en', now)).toBe(shortTime(ago(9 * 24 * 60), 'en'));
  });
});
