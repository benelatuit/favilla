import { describe, expect, it } from 'vitest';
import { count, translate } from '../src/lib/i18n';
import { diffOp } from '../src/lib/format';
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
});
