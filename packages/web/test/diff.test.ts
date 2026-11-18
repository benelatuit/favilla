import { describe, expect, it } from 'vitest';
import { columns, diffRows, highlightLines, highlightSlices, markRanges, splitHighlighted, widestRows, wordChanges, type CodeRow, type LineRow } from '../src/lib/diff';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('splitHighlighted', () => {
  it('preserves the markup bytes of blank lines, entities, adjacent tags and multiline spans', () => {
    const input = '\n<span a="中"><span>x&amp;\r\n\n</span>🙂</span><br/>tail\n';
    const rows = ['', '<span a="中"><span>x&amp;\r</span></span>', '<span a="中"><span></span></span>',
      '<span a="中"><span></span>🙂</span><br/>tail', ''];
    expect(Buffer.from(JSON.stringify(splitHighlighted(input)))).toEqual(Buffer.from(JSON.stringify(rows)));
    for (const plain of ['', '\n', '中🙂&lt;\r\nlast\n']) expect(splitHighlighted(plain)).toEqual(plain.split('\n'));
  });

  it('closes and reopens a span that crosses a line break', () => {
    const lines = splitHighlighted('<span class="c">/* one\ntwo */</span> x\ny');
    expect(lines).toEqual(['<span class="c">/* one</span>', '<span class="c">two */</span> x', 'y']);
  });

  it('keeps nested spans balanced on every line', () => {
    const lines = splitHighlighted('<span class="a"><span class="b">p\nq</span>\nr</span>');
    expect(lines).toEqual(['<span class="a"><span class="b">p</span></span>', '<span class="a"><span class="b">q</span></span>', '<span class="a">r</span>']);
  });
});

describe('wordChanges', () => {
  it('marks only the words that changed', () => {
    const w = wordChanges("  return row.amount > 4 ? 'hold' : 'pass';", "  return row.amountCents > 400 ? 'hold' : 'pass';")!;
    const a = "  return row.amount > 4 ? 'hold' : 'pass';";
    const b = "  return row.amountCents > 400 ? 'hold' : 'pass';";
    expect(w.a.map(([x, y]) => a.slice(x, y))).toEqual(['amount', '4']);
    expect(w.b.map(([x, y]) => b.slice(x, y))).toEqual(['amountCents', '400']);
  });

  it('gives nothing for a line rewritten from start to end', () => {
    expect(wordChanges('const a = 1;', 'export default function run() {}')).toBeNull();
  });

  it('gives nothing for very long lines', () => {
    expect(wordChanges('x'.repeat(500), 'y' + 'x'.repeat(499))).toBeNull();
  });

  it('splits CJK text into characters', () => {
    const a = '提示：保存失败';
    const b = '提示：上传失败';
    const w = wordChanges(a, b)!;
    expect(w.b.map(([x, y]) => b.slice(x, y))).toEqual(['上传']);
  });
});

describe('markRanges', () => {
  it('wraps ranges, closing the mark around tags and counting entities as one character', () => {
    const html = '<span class="k">if</span> a &lt; bb';
    expect(markRanges(html, [[0, 2]])).toBe('<span class="k"><mark class="dl-word">if</mark></span> a &lt; bb');
    expect(markRanges(html, [[7, 9]])).toBe('<span class="k">if</span> a &lt; <mark class="dl-word">bb</mark>');
    expect(text(markRanges(html, [[1, 6]]))).toBe('if a < bb');
  });
});

describe('columns and widestRows', () => {
  it('counts wide characters twice', () => {
    expect(columns('ab宽')).toBe(4);
    expect(columns('\tx')).toBe(5);
  });

  it('finds a shorter line of wide characters wider than a longer line of narrow ones', () => {
    const rows: CodeRow[] = [
      { k: 'ctx', o: 1, n: 1, html: '', text: 'x'.repeat(190) },
      { k: 'ctx', o: 2, n: 2, html: '', text: '宽'.repeat(145) },
      { k: 'ctx', o: 3, n: 3, html: '', text: 'short' },
    ];
    expect(widestRows(rows, 1)).toEqual([1]);
  });
});

describe('diffRows', () => {
  const patch = [
    '@@ -10,4 +10,4 @@',
    ' /* a comment',
    '    that spans */',
    "-const total = sum(rows);",
    "+const total = sum(rows, 'cents');",
    ' done();',
    '@@ -40,2 +40,3 @@',
    ' a();',
    '+b();',
    ' c();',
  ].join('\n');

  it('numbers both sides, counts the gaps, and marks changed words', () => {
    const { rows, digits } = diffRows(patch, 'x.ts');
    expect(rows[0]).toEqual({ k: 'gap', count: 9, o: 1, n: 1 });
    const kinds = rows.map((r) => r.k);
    expect(kinds).toEqual(['gap', 'ctx', 'ctx', 'rem', 'ins', 'ctx', 'gap', 'ctx', 'ins', 'ctx']);
    const between = rows[6] as Extract<CodeRow, { k: 'gap' }>;
    expect(between).toMatchObject({ count: 26, o: 14, n: 14 });
    const ins = rows[4] as LineRow;
    expect(ins.n).toBe(12);
    expect(ins.html).toContain('<mark class="dl-word">');
    expect(text(ins.html)).toBe("const total = sum(rows, 'cents');");
    expect(rows[9]).toMatchObject({ k: 'ctx', o: 41, n: 42 });
    expect(digits).toBe(2);
  });

  it('keeps a comment that spans lines in one colour', () => {
    const { rows } = diffRows(patch, 'x.ts');
    const second = rows[2] as LineRow;
    expect(second.html).toMatch(/^<span class="hljs-comment">/);
  });

  it('starts an added file at line 1 with nothing above, in either form of its first line', () => {
    for (const head of ['@@ -1,0 +1,2 @@', '@@ -0,0 +1,2 @@']) {
      const { rows } = diffRows(`${head}\n+a\n+b`, 'new.txt');
      expect(rows).toMatchObject([{ k: 'ins', n: 1 }, { k: 'ins', n: 2 }]);
    }
  });

  it('numbers an insertion from the line the server names', () => {
    // jsdiff for a line put in after line 1 of three: the old side is empty at line 2.
    const { rows } = diffRows('@@ -2,0 +2,1 @@\n+X', 'a.txt');
    expect(rows).toMatchObject([{ k: 'gap', count: 1, o: 1, n: 1 }, { k: 'ins', n: 2 }]);
  });

  it('shows what the patch says in place of lines', () => {
    const { rows } = diffRows('@@ large change: 9000 lines replaced by 12000 @@', 'big.ts');
    expect(rows).toEqual([{ k: 'note', text: 'large change: 9000 lines replaced by 12000' }]);
  });

  it('folds long unchanged runs of a whole-file patch and keeps their rows', () => {
    const lines = Array.from({ length: 30 }, (_, i) => ` line ${i + 1}`);
    lines[14] = '-line 15';
    lines.splice(15, 0, '+line fifteen');
    const { rows } = diffRows(`@@ -1,30 +1,30 @@\n${lines.join('\n')}`, 'a.txt', { fold: 3 });
    const gaps = rows.filter((r): r is Extract<CodeRow, { k: 'gap' }> => r.k === 'gap');
    expect(gaps.map((g) => [g.count, g.o, g.rows?.length])).toEqual([[11, 1, 11], [12, 19, 12]]);
    expect(rows.filter((r) => r.k === 'ctx')).toHaveLength(6);
  });

  it('ignores a trailing empty line after the last hunk', () => {
    const { rows } = diffRows('@@ -1,1 +1,1 @@\n-a\n+b\n', 'a.txt');
    expect(rows.map((r) => r.k)).toEqual(['rem', 'ins']);
  });
});

describe('highlightSlices', () => {
  it('gives the same colours as one block, a comment across a slice boundary included', () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(`const v${i} = ${i};`, '');
    // A comment with blank lines inside it, across where the first slice would end.
    lines.splice(18, 0, '/* a note', '', 'that goes on */');
    const whole = highlightLines(lines, 'a.ts');
    const sliced = [...highlightSlices(lines, 'a.ts', 20)].flat();
    expect(sliced).toEqual(whole);
  });
});
