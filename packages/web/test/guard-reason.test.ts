import { describe, expect, it } from 'vitest';
import { guardReason } from '@favilla/core/guard/i18n';
import { translate } from '../src/lib/i18n';

const zh = (k: string) => translate('zh-CN', k);

describe('why the guard asks, in the window’s language', () => {
  it('translates whole sentences, and the ones around a path with the path kept and the clause after it translated', () => {
    expect(guardReason(zh, 'This push rewrites or deletes history on the remote.')).toBe('这次推送会改写或删除远端历史。');
    expect(guardReason(zh, 'Deletes C:\\Users\\me: it targets your home folder.')).toBe('删除 C:\\Users\\me：目标是用户主目录。');
    expect(guardReason(zh, 'Deletes ~/.ssh: it targets ~/.ssh, which holds keys and app data.')).toBe('删除 ~/.ssh：目标是存放密钥与应用数据的 ~/.ssh。');
    expect(guardReason(zh, 'find … -delete under /var/log, outside the workspace.')).toBe('find … -delete 会删除工作区外 /var/log 下的文件。');
    // Not known: as the guard wrote it.
    expect(guardReason(zh, 'Something new.')).toBe('Something new.');
    expect(guardReason((k) => translate('en', k), 'Deletes /: it targets a filesystem root.')).toBe('Deletes /: it targets a filesystem root.');
  });
});
