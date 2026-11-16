import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';

const src = (html: string) => /<img[^>]*src="([^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');

describe('pictures in answers', () => {
  it('reads a picture on this computer through the server, in the session it belongs to', () => {
    expect(src(renderMarkdown('![icon](design/icon.png)', 's1'))).toBe('/api/image?path=design%2Ficon.png&session=s1');
    expect(src(renderMarkdown('![icon](C:\\Projects\\app\\design\\图标.png)', 's1'))).toBe(`/api/image?path=${encodeURIComponent('C:\\Projects\\app\\design\\图标.png')}&session=s1`);
    expect(src(renderMarkdown('![icon](file:///C:/work/app/design/icon.png)', 's1'))).toBe(`/api/image?path=${encodeURIComponent('file:///C:/work/app/design/icon.png')}&session=s1`);
  });

  it('leaves pictures on the web and in the blob store as they are', () => {
    expect(src(renderMarkdown('![a](https://example.com/a.png)'))).toBe('https://example.com/a.png');
    expect(src(renderMarkdown('![a](/api/blob/abc.bin)'))).toBe('/api/blob/abc.bin');
  });

  it('keeps links to scripts out', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript');
  });
});

describe('where pictures stand', () => {
  const one = (s: string) => renderMarkdown(s, 's1');
  it('a picture on its own line is a figure with its words under it, two side by side in a row', () => {
    expect(one('看下面。\n\n![手机上的首页](pic:3f9a2c1b7d4e)\n\n就这样。')).toMatch(/<div class="md-figures"><figure class="md-figure"><img [^>]*alt="手机上的首页"[^>]*><figcaption>手机上的首页<\/figcaption><\/figure><\/div>/);
    expect(one('![改前](a.png) ![改后](b.png)')).toMatch(/^<div class="md-figures is-row"><figure class="md-figure"><img[^>]*><figcaption>改前<\/figcaption><\/figure><figure class="md-figure"><img[^>]*><figcaption>改后<\/figcaption><\/figure><\/div>/);
  });

  it('a picture in a paragraph of text goes first in it, beside the text', () => {
    const html = one('按钮现在是这样 ![新按钮](pic:aaaaaaaaaaaa) 点下去会变深。');
    expect(html).toMatch(/^<p><span class="md-figure is-side"><img[^>]*><span class="md-caption">新按钮<\/span><\/span>按钮现在是这样 /);
  });

  it('takes its size from words in the title, which are no tooltip, and keeps other words as one', () => {
    const wide = one('![首页](pic:aaaaaaaaaaaa "wide")');
    expect(wide).toContain('<figure class="md-figure is-wide">');
    expect(wide).not.toContain('title=');
    expect(one('![图标](icon.png "small 新图标")')).toMatch(/<figure class="md-figure is-small"><img [^>]*title="新图标"/);
    expect(one('![图标](icon.png "side")\n')).toContain('<span class="md-figure is-side">');
  });

  it('is a thumbnail in a table cell, and stays as written inside a link', () => {
    expect(one('| 图 | 说明 |\n|---|---|\n| ![a](a.png) | 第一版 |')).toContain('<span class="md-figure is-cell"><img');
    const linked = one('[![a](a.png)](https://example.com)');
    expect(linked).not.toContain('md-figure');
    expect(linked).toContain('<img');
  });
});

describe('lines in answers', () => {
  it('keeps a line break inside a paragraph, and blank lines still part paragraphs', () => {
    expect(renderMarkdown('第一行说结论。\n第二行说原因。')).toBe('<p>第一行说结论。<br>\n第二行说原因。</p>\n');
    expect(renderMarkdown('一段。\n\n另一段。')).toBe('<p>一段。</p>\n<p>另一段。</p>\n');
  });

  it('marks standalone bold section labels without touching bold sentences, inline emphasis or list items', () => {
    expect(renderMarkdown('结论先行。\n\n**改了什么**\n- 修了空行')).toContain('<p class="md-label"><strong>改了什么</strong></p>');
    expect(renderMarkdown('Done.\n\n**Changed**\n- `a.ts`')).toContain('<p class="md-label"><strong>Changed</strong></p>');
    // A bold full sentence, inline emphasis, two bold spans, or bold inside a blockquote stays a plain paragraph.
    expect(renderMarkdown('**不是。**')).toBe('<p><strong>不是。</strong></p>\n');
    expect(renderMarkdown('**Yes.**')).toBe('<p><strong>Yes.</strong></p>\n');
    expect(renderMarkdown('**原因**：连接池满了')).toBe('<p><strong>原因</strong>：连接池满了</p>\n');
    expect(renderMarkdown('**A** and **B**')).toBe('<p><strong>A</strong> and <strong>B</strong></p>\n');
    expect(renderMarkdown('> **Changed**')).toBe('<blockquote>\n<p><strong>Changed</strong></p>\n</blockquote>\n');
  });
});
