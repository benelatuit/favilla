import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clip, cols, layoutInput, offsetAt } from '../src/tui/text';
import { settledLength, tail } from '../src/tui/stream';
import { pastedImagePaths } from '../src/tui/clipboard';
import { imageToken, pasteToken, resolveInput } from '../src/tui/editor';
import { expandCustom, loadCustomCommands } from '../src/tui/commands';
import { contextLines, diffLines, ledgerLine, toolBlock } from '../src/tui/format';
import { setLanguage } from '../src/tui/i18n';
import { renderMarkdown } from '../src/tui/markdown';
import { strip } from '../src/tui/text';

describe('input layout', () => {
  it('counts Chinese as two columns and breaks rows anywhere', () => {
    expect(cols('中文ab')).toBe(6);
    const lay = layoutInput('一二三四五六', 6, 6);
    expect(lay.rows.map((r) => r.text)).toEqual(['一二三', '四五六']);
    // At the end of a full row the cursor goes to the start of the next.
    expect(layoutInput('一二三四五六', 3, 6)).toMatchObject({ row: 1, col: 0 });
    expect(layoutInput('一二三四五六', 2, 6)).toMatchObject({ row: 0, col: 4 });
  });

  it('keeps lines apart and finds the cursor after a newline', () => {
    const lay = layoutInput('ab\ncd', 3, 10);
    expect(lay.rows.map((r) => r.text)).toEqual(['ab', 'cd']);
    expect(lay).toMatchObject({ row: 1, col: 0 });
    expect(offsetAt(lay.rows[0], 1)).toBe(1);
    expect(offsetAt(lay.rows[0], 9)).toBe(2);
  });

  it('never splits an emoji or a wide character when moving by columns', () => {
    const lay = layoutInput('a中b', 0, 10);
    expect(offsetAt(lay.rows[0], 2)).toBe(1);
    expect(offsetAt(lay.rows[0], 3)).toBe(2);
  });

  it('clips by columns with an ellipsis', () => {
    expect(clip('中文中文中文', 7)).toBe('中文中…');
    expect(clip('short', 10)).toBe('short');
  });
});

describe('streamed replies', () => {
  it('settles whole blocks once the next one has begun', () => {
    expect(settledLength('Para one.')).toBe(0);
    expect(settledLength('Para one.\n\n')).toBe(0);
    const text = 'Para one.\n\nPara t';
    expect(text.slice(0, settledLength(text))).toBe('Para one.\n\n');
  });

  it('keeps an open code block and a list that may go on live', () => {
    expect(settledLength('```js\nconst a = 1;\n\nconst b')).toBe(0);
    const list = '- a\n\n- b';
    expect(settledLength(list)).toBe(0);
    const closed = 'Intro.\n\n```js\nx\n```\n\nAfter';
    expect(closed.slice(0, settledLength(closed))).toBe('Intro.\n\n```js\nx\n```\n\n');
  });

  it('shows the last rows of a long live block', () => {
    const out = tail(Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'), 4, (n) => `+${n}`);
    expect(out.split('\n')).toEqual(['+7', 'l7', 'l8', 'l9']);
  });
});

describe('attachments in the input', () => {
  it('takes pasted image paths, quoted or as file addresses, and leaves other text alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-paste-'));
    const a = path.join(dir, 'a b.png');
    const b = path.join(dir, 'c.jpg');
    fs.writeFileSync(a, 'x');
    fs.writeFileSync(b, 'x');
    expect(pastedImagePaths(`"${a}"`, dir)).toEqual([a]);
    expect(pastedImagePaths(`"${a}" ${b}`, dir)).toEqual([a, b]);
    expect(pastedImagePaths(`file:///${b.replace(/\\/g, '/')}`, dir)?.map((p) => path.resolve(p))).toEqual([path.resolve(b)]);
    expect(pastedImagePaths('c.jpg', dir)).toEqual([b]);
    expect(pastedImagePaths('look at c.jpg', dir)).toBeNull();
    expect(pastedImagePaths(path.join(dir, 'missing.png'), dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends the images whose tokens are still in the text, and long pastes in full', () => {
    setLanguage('zh-CN');
    const img = (n: string) => ({ type: 'image' as const, mediaType: 'image/png', data: n });
    const images = new Map([
      [1, img('one')],
      [2, img('two')],
    ]);
    const pastes = new Map([
      [1, 'line\n'.repeat(20)],
      [2, 'more\n'.repeat(12)],
    ]);
    const r = resolveInput(`${imageToken(2)} compare [粘贴 #1 · 20 行] and ${pasteToken(2, 12)} ${imageToken(2)}`, images, pastes);
    expect(r.images.map((i) => i.data)).toEqual(['two']);
    // The paste is named where its token stood and goes whole after the words, in a block of its own.
    expect(r.text.split('\n\nAttached by the user:\n')[0]).toBe(`${imageToken(2)} compare [Pasted text 1] and [Pasted text 2] ${imageToken(2)}`);
    expect(r.text).toContain(`<pasted name="Pasted text 1" lines="21">\n${'line\n'.repeat(20)}\n</pasted>`);
    expect(r.text).toContain(`<pasted name="Pasted text 2" lines="13">\n${'more\n'.repeat(12)}\n</pasted>`);
    expect(r.text).not.toContain('[粘贴 #1');
    expect(r.text).not.toContain('[已粘贴 #2');
    setLanguage('en');
  });
});

describe('your own commands', () => {
  it('loads markdown commands from the project, with descriptions and $ARGUMENTS', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-cmds-'));
    fs.mkdirSync(path.join(dir, '.favilla', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.favilla', 'commands', 'Ship It.md'), '---\ndescription: tag and push\n---\nTag $ARGUMENTS and push it.');
    fs.writeFileSync(path.join(dir, '.favilla', 'commands', 'diff.md'), 'shadows a built-in');
    const cmds = loadCustomCommands(dir);
    const ship = cmds.find((c) => c.name === '/ship-it')!;
    expect(ship.detail).toBe('tag and push');
    expect(expandCustom(ship, 'v1.2')).toBe('Tag v1.2 and push it.');
    expect(cmds.some((c) => c.name === '/diff')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('tool results and summaries', () => {
  it('draws every kind of result without failing', () => {
    setLanguage('en');
    const base = { type: 'tool_result' as const, callId: 'c', name: 'x', content: 'line one\nline two' };
    const kinds = [
      { kind: 'diff', files: [{ path: 'a.ts', op: 'update', patch: '@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n keep();', added: 1, removed: 1 }] },
      { kind: 'terminal', command: 'npm test', output: 'ok\nfail', exitCode: 1, durationMs: 1200, cwd: '.' },
      { kind: 'file', path: 'a.ts', startLine: 1, lineCount: 10, totalLines: 40, preview: '' },
      { kind: 'search', pattern: 'x', path: '.', matches: 3, files: 2, preview: '' },
      { kind: 'links', query: 'q', results: [{ title: 'A page', url: 'https://example.com/a', snippet: '' }] },
      { kind: 'mail', action: 'search', account: 'me', total: 1, items: [{ id: '1', subject: 'Hello', from: 'Ann', unread: true, starred: false, attachments: 0 }] },
      { kind: 'checks', results: [{ name: 'test', command: 'npm test', ok: false, durationMs: 900, problems: ['a.test.ts:3 expected 2'] }], found: [], verdict: { kind: 'catches', files: [] } },
      { kind: 'attempts', attempts: [{ n: 1, passed: 3, failed: 0, added: 4, removed: 1, files: 1, chosen: true }], reason: 'all tests pass' },
      { kind: 'task', description: 'd', agent: 'explore', steps: 3, tokens: 1200, background: true },
    ];
    for (const d of kinds) {
      const out = strip(toolBlock('tool', 'tool title', { ...base, display: d } as never, 100));
      expect(out.length).toBeGreaterThan(5);
    }
    expect(strip(toolBlock('checks', 'checks', { ...base, display: kinds[6] } as never, 100))).toMatch(/1 of 1 failed[\s\S]*catch the fix/);
  });

  it('numbers diff lines from the hunk and says when there is more', () => {
    const lines = diffLines([{ path: 'a.py', op: 'update', patch: '@@ -10,3 +10,3 @@\n ctx\n-old\n+new\n tail', added: 1, removed: 1 }], 80).map(strip);
    expect(lines[0]).toMatch(/^\s+10\s+ctx/);
    expect(lines[1]).toMatch(/^\s+11 - old/);
    expect(lines[2]).toMatch(/^\s+11 \+ new/);
  });

  it('sums a turn into one line and leaves a quick plain answer without one', () => {
    const msg = (role: 'user' | 'assistant', parts: unknown[], turn = 't1') => ({ id: Math.random().toString(), role, parts, time: 0, turn }) as never;
    const diff = { type: 'tool_result', callId: 'a', name: 'edit', content: '', display: { kind: 'diff', files: [{ path: 'a.ts', op: 'update', patch: '', added: 5, removed: 2 }] } };
    const run = { type: 'tool_result', callId: 'b', name: 'shell', content: '', display: { kind: 'terminal', command: 'npm test', output: '', exitCode: 1, durationMs: 10, cwd: '.' } };
    const line = strip(ledgerLine([msg('assistant', []), msg('user', [diff, run]), msg('assistant', [])], 't1', 65_000));
    expect(line).toMatch(/1m 5s · 2 requests · 1 file \+5 −2 · 1 of 1 runs failed/);
    const passed = { ...run, display: { ...run.display, exitCode: 0 } };
    expect(strip(ledgerLine([msg('assistant', []), msg('user', [passed]), msg('assistant', [])], 't1', 4000))).toMatch(/· 1 run$/);
    expect(ledgerLine([msg('assistant', [])], 't1', 900)).toBe('');
  });

  it('draws the context as a bar with the compaction mark', () => {
    const out = contextLines({ tokens: 50_000, window: 200_000, nativeWindow: 200_000, compactAt: 160_000, pruneAt: 120_000, parts: { system: 5000, tools: 5000, summary: 0, conversation: 20_000, reasoning: 0, outputs: 20_000, cut: 0 }, outputs: 4, cut: 0, compactions: 0 }, 80).map(strip);
    expect(out[0]).toMatch(/50k \/ 200k \(25%\)/);
    expect(out[2]).toMatch(/▲ compacts at 160k/);
  });
});

describe.skipIf(process.platform !== 'win32')('the Windows clipboard reader', () => {
  it('is a script PowerShell parses (checked without running it, so the clipboard is never read)', async () => {
    const { execFileSync } = await import('node:child_process');
    const { windowsScript } = await import('../src/tui/clipboard');
    const script = windowsScript("C:/t/it's.png", 'C:/t/b.jpg');
    const check = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e.Count`;
    const errors = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { input: script, encoding: 'utf8', windowsHide: true }).trim();
    expect(errors).toBe('0');
  });
});

describe('lists in answers', () => {
  it('hangs an item that wraps under its own text, so the next item stands apart', () => {
    const md = '- **硬盘**：换成 1TB 的 NVMe 固态，开机从一分多钟变成十几秒，这一项最明显\n- **电池**：只剩六成容量';
    const lines = strip(renderMarkdown(md, 40)).split('\n');
    expect(lines).toEqual(['• 硬盘：换成 1TB 的 NVMe 固态，开机从一', '  分多钟变成十几秒，这一项最明显', '• 电池：只剩六成容量']);
  });

  it('hangs a numbered item and a nested list under their text, within the width', () => {
    const md = '1. Open the settings and turn on the cache for every provider\n   - an inner point that is long enough to wrap here';
    const lines = strip(renderMarkdown(md, 32)).split('\n');
    expect(lines[0]).toBe('1. Open the settings and turn on');
    expect(lines[1]).toMatch(/^ {3}\S/);
    expect(lines.slice(2).every((l) => /^ {5}[◦ ] ?\S/.test(l))).toBe(true);
    expect(lines.every((l) => cols(l) <= 32)).toBe(true);
  });
});
