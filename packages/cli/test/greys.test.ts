import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contextLines, diffLines, ledgerLine, noticeBlock, toolBlock, todoLines, userBlock } from '../src/tui/format';
import { renderMarkdown } from '../src/tui/markdown';
import { borders, grounds, paint } from '../src/tui/theme';

/** Every colour a piece of terminal output sets, as [r, g, b] (a 256-colour index is turned into its grey or not). */
function colours(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\x1b\[([\d;]*)m/g)) {
    const codes = m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        out.push(codes.slice(i + 2, i + 5).join(','));
        i += 4;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const n = codes[i + 2];
        out.push(n === 16 || n === 231 || n >= 232 ? `grey ${n}` : `index ${n}`);
        i += 2;
      } else if ((c >= 30 && c <= 37) || (c >= 40 && c <= 47) || (c >= 90 && c <= 97) || (c >= 100 && c <= 107)) out.push(`basic ${c}`);
    }
  }
  return out;
}

const grey = (rgb: string) => rgb.startsWith('grey') || (/^(\d+),\1,\1$/.test(rgb));

describe('the terminal in greys', () => {
  it('sets no hue anywhere it paints', () => {
    const diff = { kind: 'diff' as const, files: [{ path: 'src/a.ts', op: 'update' as const, added: 2, removed: 1, patch: '@@ -1,3 +1,4 @@\n const a = 1;\n-export function old() { return "x"; }\n+export function next() { return "y"; }\n+// a comment\n tail();' }] };
    const samples = [
      ...diffLines(diff.files, 80, 0),
      toolBlock('edit', 'edit src/a.ts', { type: 'tool_result', callId: '1', name: 'edit', content: '', display: diff }, 80),
      toolBlock('shell', 'npm test', { type: 'tool_result', callId: '2', name: 'shell', content: 'boom', display: { kind: 'terminal', command: 'npm test', output: 'FAIL a\nboom', exitCode: 1, durationMs: 1200, cwd: '.' } }, 80),
      toolBlock('check', 'check', { type: 'tool_result', callId: '3', name: 'check', content: '', display: { kind: 'checks', found: ['test'], results: [{ name: 'test', command: 'vitest', ok: false, durationMs: 9, problems: ['a.test.ts:3 expected 1'], summary: '1 failed' }, { name: 'types', command: 'tsc', ok: true, durationMs: 9, problems: [] }] } } as never, 80),
      toolBlock('read', 'read x', { type: 'tool_result', callId: '4', name: 'read', content: 'no such file', isError: true }, 80),
      renderMarkdown('# Title\n\nSome **bold** text with `code` and a [link](https://example.com).\n\n- [x] done\n- [ ] open\n\n```ts\nconst n: number = 42; // the answer\n```\n\n> quoted', 80),
      userBlock('fix the tide table', 2, 60),
      noticeBlock('error', 'the turn failed'),
      noticeBlock('warn', 'careful'),
      ...todoLines([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }]),
      ...contextLines({ tokens: 50_000, window: 200_000, nativeWindow: 200_000, compactAt: 160_000, pruneAt: 120_000, parts: { system: 4000, tools: 6000, summary: 2000, conversation: 20_000, reasoning: 3000, outputs: 14_000, cut: 1000 }, outputs: 12, cut: 3, compactions: 1 } as never, 80),
      ledgerLine([{ id: 'a', role: 'assistant', parts: [], time: 0, turn: 't' }, { id: 'u', role: 'user', parts: [diff && { type: 'tool_result', callId: 'x', name: 'edit', content: '', display: diff }], time: 1, turn: 't' }, { id: 'b', role: 'assistant', parts: [], time: 2, turn: 't' }] as never, 't', 5000),
      ...(['ink', 'muted', 'faint', 'code', 'blue', 'green', 'red', 'brass', 'violet'] as const).map((h) => paint(h, 'x')),
    ];
    const set = new Set(samples.flatMap(colours));
    expect([...set].filter((c) => !grey(c))).toEqual([]);
    expect(set.size).toBeGreaterThan(3);
  });

  it('marks failures and changes with symbols, not hues', () => {
    const failed = toolBlock('shell', 'npm test', { type: 'tool_result', callId: '2', name: 'shell', content: '', display: { kind: 'terminal', command: 'npm test', output: 'x', exitCode: 1, durationMs: 1, cwd: '.' } }, 80);
    expect(failed).toContain('✗');
    const fine = toolBlock('shell', 'npm test', { type: 'tool_result', callId: '2', name: 'shell', content: '', display: { kind: 'terminal', command: 'npm test', output: 'x', exitCode: 0, durationMs: 1, cwd: '.' } }, 80);
    expect(fine).not.toContain('✗');
    expect(noticeBlock('error', 'x')).toContain('✗');
  });

  it('draws borders and grounds in greys, and the command without its UI too', () => {
    for (const hex of [...Object.values(borders), ...Object.values(grounds)]) expect(hex.slice(1, 3) === hex.slice(3, 5) && hex.slice(3, 5) === hex.slice(5, 7)).toBe(true);
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ['../src/headless.ts', '../src/tui/views.tsx', '../src/tui/editor.tsx', '../src/tui/app.tsx']) {
      const src = fs.readFileSync(path.join(here, file), 'utf8');
      expect(src).not.toMatch(/\\x1b\[(3[0-7]|9[0-7]|4[0-7])m/);
      expect(src).not.toMatch(/#[0-9a-f]{6}\b/i);
    }
  });
});

describe('pictures in an answer', () => {
  const plain = (s: string) => s.replace(/\x1b\[[\d;]*m|\x1b\]8;;[^\x07]*\x07/g, '');
  it('read as their words in a terminal, with the file when they are one', () => {
    expect(plain(renderMarkdown('看这张：![手机上的首页](pic:3f9a2c1b7d4e)', 80))).toContain('手机上的首页]');
    expect(plain(renderMarkdown('看这张：![手机上的首页](pic:3f9a2c1b7d4e)', 80))).not.toContain('pic:');
    expect(plain(renderMarkdown('![图标](design/icon.png)', 80))).toMatch(/\[.*: 图标 design\/icon\.png\]/);
  });
});
