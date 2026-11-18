import { describe, expect, it } from 'vitest';
import { stateOf } from '../src/components/Welcome';
import { translate } from '../src/lib/i18n';
import type { SessionListItem } from '../src/lib/types';

const zh = (k: string) => translate('zh-CN', k);
const row = (patch: Partial<SessionListItem>) => ({ id: 's', title: 'T', cwd: '/w', created: 0, updated: 0, live: null, ...patch }) as SessionListItem;

describe('where each of the folder’s sessions stands on the welcome page', () => {
  it('says what it waits for or does now first, then how its last turn ended, and nothing for a session from before', () => {
    expect(stateOf(row({ live: 'waiting', last: { end: 'done', files: 2 } }), zh)).toEqual({ text: '等待确认', waiting: true });
    expect(stateOf(row({ live: 'running' }), zh)?.text).toBe('运行中');
    expect(stateOf(row({ last: { end: 'done', files: 3 } }), zh)?.text).toBe('修改 3 个文件');
    expect(stateOf(row({ last: { end: 'done', files: 0 } }), zh)?.text).toBe('已完成');
    expect(stateOf(row({ last: { end: 'aborted', files: 1 } }), zh)?.text).toBe('已手动停止');
    expect(stateOf(row({ last: { end: 'error', files: 0 } }), zh)?.text).toBe('因出错停止');
    expect(stateOf(row({ last: { end: 'done', files: 1 } }), (k) => translate('en', k))?.text).toBe('Changed 1 file');
    expect(stateOf(row({}), zh)).toBeNull();
  });
});
