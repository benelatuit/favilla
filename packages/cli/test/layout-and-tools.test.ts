import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message, SessionStore } from '@favilla/core';
import { catastropheReason, catastropheRefusal, catastropheText } from '@favilla/core/guard/i18n';
import { formatHelp, formatStatusBar } from '../src/tui/app';
import { COMMANDS } from '../src/tui/commands';
import { CLI_CORE_STEP_PHRASES, contextLines, diffLines, toolBlock, toolOutcome, userBlock } from '../src/tui/format';
import { setLanguage, t } from '../src/tui/i18n';
import { renderMarkdown } from '../src/tui/markdown';
import { cols, liveTailLines, strip } from '../src/tui/text';
import { setTerminalTheme } from '../src/tui/theme';
import { replayItems, transcriptLines, transcriptMarkdown } from '../src/tui/transcript';
import { Pager } from '../src/tui/views';
import { FakeStdin, FakeStdout, until } from './terminal';

const dummyBlobs = {
  read: () => null,
  write: () => '',
  has: () => false,
} as unknown as SessionStore['blobs'];

afterEach(() => {
  setLanguage('en');
  setTerminalTheme('dark');
});

describe('CLI tool outcomes and @favilla/core phrase drift guard', () => {
  it('verifies every phrase in CLI_CORE_STEP_PHRASES exists verbatim in @favilla/core source', () => {
    const coreRoot = path.resolve(import.meta.dirname, '../../core/src');
    const corpus = [
      fs.readFileSync(path.join(coreRoot, 'agent/session.ts'), 'utf8'),
      fs.readFileSync(path.join(coreRoot, 'tools/shell-tools.ts'), 'utf8'),
      fs.readFileSync(path.join(coreRoot, 'guard/i18n.ts'), 'utf8'),
    ].join('\n');

    for (const exact of CLI_CORE_STEP_PHRASES.cancelledExact) expect(corpus).toContain(exact);
    for (const sub of CLI_CORE_STEP_PHRASES.cancelledContains) expect(corpus).toContain(sub);
    for (const prefix of CLI_CORE_STEP_PHRASES.deniedPrefixes) expect(corpus).toContain(prefix);
  });

  it('distinguishes cancelled (○) and denied (!) tool calls from genuine failures (✗)', () => {
    setLanguage('zh-CN');

    const cancelled = toolBlock('read', 'read src/main.ts', {
      type: 'tool_result',
      callId: 'c1',
      name: 'read',
      content: 'Interrupted by the user before it ran.',
      isError: true,
    }, 80);
    expect(strip(cancelled)).toContain('○ read src/main.ts');
    expect(strip(cancelled)).toContain('已停止');
    expect(strip(cancelled)).not.toContain('✗');
    expect(strip(cancelled)).not.toContain('Interrupted by the user');

    const catRefusal = catastropheRefusal(catastropheReason('folder', '/var/www'));
    const denied = toolBlock('shell', 'rm -rf /var/www', {
      type: 'tool_result',
      callId: 'c2',
      name: 'shell',
      content: catRefusal,
      isError: true,
    }, 80);
    expect(toolOutcome({ type: 'tool_result', callId: 'c2', name: 'shell', content: catRefusal, isError: true })).toBe('denied');
    expect(strip(denied)).toContain('! shell rm -rf /var/www');
    expect(strip(denied)).toContain('未运行');
    expect(strip(denied)).toContain('/var/www');
    expect(strip(denied)).not.toContain('✗');
    expect(strip(denied)).not.toContain('Ask the user about this exact target');

    for (const kind of Object.keys(catastropheText) as (keyof typeof catastropheText)[]) {
      const r = catastropheRefusal(catastropheReason(kind, '/srv/data'));
      expect(toolOutcome({ type: 'tool_result', callId: kind, name: 'shell', content: r, isError: true })).toBe('denied');
    }

    const planRefusal = toolBlock('write', 'write src/a.ts', {
      type: 'tool_result',
      callId: 'c3',
      name: 'write',
      content: 'Plan mode is on, so files cannot be changed yet. Finish the plan and present it for approval first.',
      isError: true,
    }, 80);
    expect(strip(planRefusal)).toContain('! write src/a.ts');
    expect(strip(planRefusal)).toContain('规划模式');
    expect(strip(planRefusal)).not.toContain('Finish the plan');

    const failed = toolBlock('read', 'read missing.ts', {
      type: 'tool_result',
      callId: 'c4',
      name: 'read',
      content: 'ENOENT: no such file or directory',
      isError: true,
    }, 80);
    expect(strip(failed)).toContain('✗ read missing.ts');
    expect(strip(failed)).toContain('ENOENT');
  });
});

describe('replayItems compact read-only runs', () => {
  it('folds 2+ consecutive read-only calls into one explored line while keeping full detail in transcriptLines and markdown', () => {
    const messages: Message[] = [
      { id: 'u1', turn: 't1', time: 1, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Inspect the layout' }] },
      { id: 'a1', turn: 't1', time: 2, role: 'assistant', stop: 'tool_use', parts: [{ type: 'tool_call', id: 'c1', name: 'read', input: { path: 'src/a.ts' } }] },
      { id: 'tr1', turn: 't1', time: 3, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: 'c1', name: 'read', content: 'const a = 1;' }] },
      { id: 'a2', turn: 't1', time: 4, role: 'assistant', stop: 'tool_use', parts: [{ type: 'tool_call', id: 'c2', name: 'grep', input: { pattern: 'foldState' } }, { type: 'tool_call', id: 'c3', name: 'glob', input: { pattern: 'src/**/*.tsx' } }] },
      { id: 'tr2', turn: 't1', time: 5, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: 'c2', name: 'grep', content: 'src/b.ts:1:foldState' }, { type: 'tool_result', callId: 'c3', name: 'glob', content: 'src/App.tsx' }] },
      { id: 'a3', turn: 't1', time: 6, role: 'assistant', stop: 'end', parts: [{ type: 'text', text: 'Found three files.' }] },
    ];

    setLanguage('en');
    const items = replayItems(messages, dummyBlobs, 80).map(strip);
    expect(items).toHaveLength(3); // userBlock + 1 compact explored line + final textBlock
    expect(items[1]).toContain('● explored 3 steps');
    expect(items[1]).toContain('src/a.ts');
    expect(items[1]).toContain('foldState');

    const full = transcriptLines(messages, dummyBlobs, 80).map(strip).join('\n');
    expect(full).toContain('const a = 1;');
    expect(full).toContain('src/b.ts:1:foldState');

    const md = transcriptMarkdown(messages, dummyBlobs, { title: 'Test', cwd: '/repo', provider: 'p', model: 'm' });
    expect(md).toContain('`read src/a.ts`');
    expect(md).toContain('`grep foldState`');
    expect(md).toContain('`glob src/**/*.tsx`');
  });
});

describe('60, 80, and 120 column layout and dark/light rendering', () => {
  for (const width of [60, 80, 120]) {
    for (const mode of ['dark', 'light'] as const) {
      it(`keeps userBlock, diffLines, statusBar, help, contextLines and markdown tables within ${width} columns (${mode})`, () => {
        setTerminalTheme(mode);
        setLanguage('zh-CN');

        const user = userBlock('请帮我检查时间线折叠状态模块在连续流式输出、取消执行与会话切换时的全部边界条件是否都已经覆盖完整。', 1, width);
        for (const row of user.split('\n')) {
          expect(cols(strip(row))).toBe(width);
        }

        const patch = diffLines(
          [
            {
              path: 'packages/web/src/lib/fold-state.ts',
              op: 'update',
              added: 2,
              removed: 1,
              patch: '@@ -10,2 +10,3 @@\n-export const legacyOpenState = false;\n+export function selectIsOpen(state: FoldState, key: string, defaultOpen: boolean): boolean { return state.overrides[key] ?? defaultOpen; }\n+export const clean = true;',
            },
          ],
          width,
          0,
        );
        for (const row of patch) {
          expect(cols(strip(row))).toBeLessThanOrEqual(width);
        }
        // Added rows must pad out to exact width so ground shading never stops mid-row on wrapped lines.
        const addedRows = patch.filter((r) => strip(r).includes('+ export function') || strip(r).startsWith('        return state'));
        expect(addedRows.length).toBeGreaterThanOrEqual(1);
        for (const row of addedRows) expect(cols(strip(row))).toBe(width);

        const bar = formatStatusBar({
          model: 'claude-sonnet-4-6',
          effort: 'high',
          mode: 'plan',
          branch: true,
          goal: { done: 2, total: 4 },
          activeChildren: 1,
          ctxPct: 68,
          cost: 0.142,
          planWindows: ['5h 82%'],
          cwd: '/Users/demo/Projects/very-long-workspace-folder-name',
          width,
        });
        expect(cols(strip(bar))).toBeLessThanOrEqual(width);
        expect(strip(bar)).toContain('claude-sonnet-4-6');
        expect(strip(bar)).toContain('规划模式');

        const armedBar = formatStatusBar({
          model: 'claude-sonnet-4-6',
          effort: 'high',
          mode: 'plan',
          branch: true,
          activeChildren: 2,
          ctxPct: 68,
          planWindows: ['5h 82%'],
          cwd: '/Users/demo/Projects/very-long-workspace-folder-name',
          hint: t('press ctrl+c again to quit'),
          width,
        });
        expect(cols(strip(armedBar))).toBeLessThanOrEqual(width);
        expect(strip(armedBar)).toContain(t('press ctrl+c again to quit'));

        const cmds = COMMANDS.map((c) => ({ name: c.name, detail: t(c.detail) }));
        const help = formatHelp(cmds, width);
        for (const row of help.split('\n')) {
          expect(cols(strip(row))).toBeLessThanOrEqual(width);
        }

        const ctx = contextLines(
          {
            tokens: 148_000,
            window: 200_000,
            nativeWindow: 200_000,
            compactAt: 170_000,
            pruneAt: 120_000,
            parts: { system: 6000, tools: 9000, summary: 8000, conversation: 75_000, reasoning: 12_000, outputs: 34_000, cut: 4000 },
            outputs: 18,
            cut: 5,
            compactions: 2,
          } as never,
          width,
        );
        for (const row of ctx) {
          expect(cols(strip(row))).toBeLessThanOrEqual(width);
        }

        const tableMd = renderMarkdown('| 模块名称 | 职责说明 | 当前状态 |\n| --- | --- | --- |\n| fold-state.ts | 纯函数状态机与用户手动覆盖优先级 | 已完成单测 |\n| ToolEntry.tsx | 按工具类别拆分子组件并统一主题变量 | 已完成迁移 |', width);
        for (const row of tableMd.split('\n')) {
          expect(cols(strip(row))).toBeLessThanOrEqual(width);
        }
      });
    }
  }

  it('keeps Pager exit hint visible on 60-column narrow terminals', async () => {
    setLanguage('zh-CN');
    const stdout = new FakeStdout();
    stdout.columns = 60;
    stdout.rows = 16;
    const stdin = new FakeStdin();
    const ink = render(
      React.createElement(Pager, {
        title: '本会话的改动  +128 −42',
        lines: Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: example diff content across narrow terminal`),
        width: 59,
        height: 15,
        onClose: () => {},
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    try {
      await until(() => stdout.text().includes('q 关闭'), 'compact pager header');
      expect(stdout.text()).toContain('本会话的改动');
    } finally {
      ink.unmount();
    }
  });

  it('normalizes live tool tail lines so CR progress overwrites and ANSI-only chunks never jump CLI live rows', () => {
    expect(liveTailLines('\x1b[?25l\x1b]0;vitest\x07  \r\n')).toEqual([]);
    expect(liveTailLines('10%\r40%\r90%\r')).toEqual(['90%']);
    expect(liveTailLines('a\nb\nc\nd\n', 3)).toEqual(['b', 'c', 'd']);
  });
});
