import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bestPassages, splitPassages, terms } from '../src/tools/passages';
import { decodeText, forgetPages, fromHtml, linksIn, PageError, pageText, readPage } from '../src/tools/webpage';
import { canonicalUrl, parseBing, parseDuckDuckGo, parseDuckDuckGoLite, queryLang, rankResults } from '../src/tools/websearch';

const filler = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `<p>Paragraph ${i + 1} about ${topic}: the widget reads its configuration, checks every entry and reports each problem with the line it sits on, so a deploy never starts from a broken file.</p>`).join('\n');

const ARTICLE = `<!doctype html><html><head><title>Widget Guide | Acme Docs</title>
<meta property="article:published_time" content="2026-03-02T10:00:00Z"></head>
<body>
<nav><a href="/">Home</a> <a href="/docs">Docs</a> <a href="/blog">Blog</a></nav>
<main><article>
<h1>Widget Guide</h1>
${filler('the guide', 4)}
<h2><a href="#install">Install</a></h2>
<p>Install the command with your platform's package manager; it needs the runtime described on the <a href="/docs/runtime">runtime page</a>, and the <a href="#config">configuration</a> section says what to write next.</p>
<div class="language-bash"><span class="lang">bash</span><pre><code>widget install --global</code></pre></div>
<h2>Options</h2>
<table><tr><th>Flag</th><th>Meaning</th></tr><tr><td><code>--dry</code></td><td>Check only | change nothing</td></tr><tr><td><code>--force</code></td><td>Replace files</td></tr></table>
<p><img src="data:image/png;base64,AAAA" alt="diagram"> The diagram shows the order of the checks.</p>
${filler('options', 2)}
</article></main>
<footer>Copyright Acme Widgets</footer>
</body></html>`;

function pdf(text: string): string {
  const page = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  return `%PDF-1.4\n${objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj`).join('\n')}\ntrailer << /Root 1 0 R /Size 6 >>\n%%EOF\n`;
}

let server: http.Server;
let base = '';
const hits = new Map<string, number>();
let flaky = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === '/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ARTICLE);
    } else if (path === '/gbk') {
      // 中文页面 in GBK, the charset named only in the page's meta tag.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(Buffer.concat([Buffer.from('<html><head><meta charset="gbk"><title>'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd2, 0xb3, 0xc3, 0xe6]), Buffer.from(`</title></head><body>${filler('charsets', 3)}</body></html>`)]));
    } else if (path === '/app') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>App</title><script src="/app.js"></script></head><body><div id="root"></div></body></html>');
    } else if (path === '/guarded') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>');
    } else if (path === '/paper.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf('Attention is all you need'));
    } else if (path === '/flaky') {
      // The first request is dropped at the connection, as a proxy reconnecting does; the second is answered.
      if (flaky++ === 0) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('answered the second time');
    } else if (path === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such page');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a":1,"b":[1,2]}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  forgetPages();
  hits.clear();
});

const o = () => ({ signal: new AbortController().signal, proxy: false as const });

describe('passages', () => {
  it('turns text into search terms: stems, stop words, Chinese character pairs', () => {
    expect(terms('Running the tests')).toEqual(['run', 'test']);
    expect(terms('parse parsed parsing')).toEqual(['pars', 'pars', 'pars']);
    expect(terms('借用检查怎么报错')).toEqual(['借用', '用检', '检查', '查怎', '么报', '报错']);
  });

  it('keeps code blocks whole and passages under their headings', () => {
    const md = '# Guide\n\nIntro text.\n\n## Install\n\nRun this:\n\n```sh\nnpm i\n\nnpm test\n```\n\n## Use\n\nCall it.';
    const ps = splitPassages(md, 40);
    expect(ps.map((p) => p.heading)).toEqual(['Guide', 'Install', 'Use']);
    expect(ps[1].text).toBe('Run this:\n\n```sh\nnpm i\n\nnpm test\n```');
    expect(md.slice(ps[2].start)).toBe('Call it.');
    // Smaller passages split between blocks, never inside the code block.
    expect(splitPassages(md, 5).find((p) => p.text.startsWith('```'))?.text).toBe('```sh\nnpm i\n\nnpm test\n```');
  });

  it('counts a compound name whole as well as by its parts', () => {
    const t = terms('curl --retry-all-errors, ctx.signal in v4.1, utf-8 and c++');
    expect(t).toEqual(expect.arrayContaining(['retry-all-errors', 'retry', 'error', 'ctx.signal', 'ctx', 'signal', 'v4.1', 'utf-8', 'c++']));
    expect(t).not.toContain('errors,');
  });

  it('cuts a long table into groups of rows under its header, a long code block into fenced runs, a long list at its items', () => {
    const row = (i: number) => `| Limit ${i} | ${i} per day | What limit ${i} counts, and when it resets each day |`;
    const table = ['| Limit | Value | Meaning |', '| --- | --- | --- |', ...Array.from({ length: 40 }, (_, i) => row(i))].join('\n');
    const tableParts = splitPassages(`## Limits\n\n${table}`);
    expect(tableParts.length).toBeGreaterThan(2);
    for (const p of tableParts) expect(p.text.startsWith('| Limit | Value | Meaning |\n| --- | --- | --- |\n')).toBe(true);
    expect(tableParts.some((p) => p.text.includes(row(33)))).toBe(true);
    const md = `## Limits\n\n${table}`;
    const at = tableParts.find((p) => p.text.includes(row(33)))!.start;
    expect(md.slice(at)).toMatch(/^\| Limit \d+ \|/);

    const code = ['```python', ...Array.from({ length: 60 }, (_, i) => (i % 6 === 5 ? '' : `value_${i} = compute(${i}, retries=3)`)), '```'].join('\n');
    const codeParts = splitPassages(code);
    expect(codeParts.length).toBeGreaterThan(1);
    for (const p of codeParts) expect(p.text).toMatch(/^```python\n[\s\S]*\n```$/);
    expect(codeParts.map((p) => p.text.replace(/^```python\n|\n```$/g, '')).join('\n')).toContain('value_58 = compute(58, retries=3)');

    const list = Array.from({ length: 30 }, (_, i) => `- Section ${i}\n    - \`module_${i}\` — what module ${i} does for the program`).join('\n');
    const listParts = splitPassages(list);
    expect(listParts.length).toBeGreaterThan(1);
    // An item stays with the items under it.
    for (const p of listParts) expect(p.text.startsWith('- Section')).toBe(true);
  });

  it('finds the passage that answers, and nothing when no passage covers enough of the query', () => {
    const md = ['## Colours', 'The theme sets colours for every panel.', '## Retries', 'Failed uploads are retried three times with a growing wait between tries.', '## Logs', 'Logs rotate daily.'].join('\n\n');
    const found = bestPassages(md, 'how many times are failed uploads retried', { max: 1 });
    expect(found).toHaveLength(1);
    expect(found[0].heading).toBe('Retries');
    expect(bestPassages(md, 'upload retries with exponential backoff and jitter in kubernetes', { minCover: 0.5 })).toEqual([]);
  });
});

describe('reading pages', () => {
  it('decodes the charset a page names', () => {
    expect(decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'text/html; charset=gbk')).toBe('中文');
    expect(decodeText(Buffer.concat([Buffer.from('<meta charset="gb2312">'), Buffer.from([0xd6, 0xd0])]), 'text/html')).toBe('<meta charset="gb2312">中');
  });

  it('reads the article: chrome gone, link addresses listed once at the end, anchors and inline images out, code and tables kept', async () => {
    const page = await readPage(`${base}/article`, o());
    expect(page.title).toBe('Widget Guide | Acme Docs');
    expect(page.published).toBe('2026-03-02');
    expect(page.via).toBe('page');
    const md = page.markdown;
    expect(md).toContain('## Install');
    // A link's text stays in the sentence; its absolute address goes in the list at the end.
    expect(md).toContain('runtime page');
    expect(md).toContain(`Links on the page:\n- runtime page: ${base}/docs/runtime`);
    expect(md).not.toMatch(/\]\(https?:/);
    expect(md).toContain('the configuration section');
    expect(md).toContain('```bash\nwidget install --global\n```');
    expect(md).toContain('| Flag | Meaning |');
    expect(md).toContain('| `--dry` | Check only \\| change nothing |');
    expect(md).toContain('[image: diagram]');
    expect(md).not.toContain('Copyright Acme');
    expect(md).not.toContain('Blog');
  });

  it('keeps pages for a while, so reading one again costs no request', async () => {
    await readPage(`${base}/article`, o());
    await readPage(`${base}/article#install`, o());
    expect(hits.get('/article')).toBe(1);
  });

  it("does not keep a scripted page's empty shell, so a fetch with the browser reads it again", async () => {
    const shell = await readPage(`${base}/app`, o());
    expect(shell.partial).toBe(true);
    await readPage(`${base}/app`, o());
    expect(hits.get('/app')).toBe(2);
  });

  it("reads the main element when Readability's article leaves much of it out", () => {
    // A docs index: its content is a list of links in a wrapper Readability takes for a menu.
    const items = Array.from({ length: 40 }, (_, i) => `<li><a href="mod${i}.html">mod${i} — module number ${i}</a></li>`).join('');
    const html = `<html><head><title>Library</title></head><body><nav><a href="/">Home</a></nav><main><h1>The Library</h1><p>${'The modules of the standard library, grouped by what they are for. '.repeat(8)}</p><div class="modules-menu"><ul>${items}<li><a href="zoneinfo.html">zoneinfo — IANA time zone support</a></li></ul></div><nav><a href="next.html">Next page</a></nav></main></body></html>`;
    const page = fromHtml(html, 'https://docs.example.org/library/index.html');
    expect(page.markdown).toContain('zoneinfo — IANA time zone support');
    expect(page.markdown).not.toContain('Next page');
    const zone = page.links?.find((l) => l.href === 'https://docs.example.org/library/zoneinfo.html');
    expect(zone?.at).toBe(page.markdown.indexOf('zoneinfo — IANA time zone support'));
    // A quoted part names the links in it that the query asks about.
    expect(linksIn(page, 0, page.markdown.length, 'zoneinfo time zones', 3).map((l) => l.href)).toEqual(['https://docs.example.org/library/zoneinfo.html']);
  });

  it('reads code one line per line in its fence with its language, and text without markdown escapes', () => {
    const lines = `<pre data-language="js"><code><div class="ec-line"><div class="code">const a = 1;</div></div><div class="ec-line"><div class="code">const b = 2;</div></div></code></pre>`;
    const sphinx = `<div class="highlight-python3"><div class="highlight"><pre><span></span><span class="gp">&gt;&gt;&gt; </span>import asyncio\n</pre></div></div>`;
    const md = fromHtml(`<html><body><article><p>${'Text around the examples, long enough to count as the article. '.repeat(5)}</p>${lines}<p>Set snake_case names with --dry-run first.</p>${sphinx}</article></body></html>`, 'https://example.com/').markdown;
    expect(md).toContain('```js\nconst a = 1;\nconst b = 2;\n```');
    expect(md).toContain('```python\n>>> import asyncio\n```');
    expect(md).toContain('Set snake_case names with --dry-run first.');
  });

  it('reads a long table as a table', () => {
    const rows = Array.from({ length: 450 }, (_, i) => `<tr><td>limit-${i}</td><td>${i * 10}</td></tr>`).join('');
    const md = fromHtml(`<html><body><article><p>${'The limits of the service, each with its value. '.repeat(6)}</p><table><tr><th>Name</th><th>Value</th></tr>${rows}</table></article></body></html>`, 'https://example.com/').markdown;
    expect(md).toContain('| limit-321 | 3210 |');
  });

  it('reads a GBK page in its own charset', async () => {
    const page = await readPage(`${base}/gbk`, o());
    expect(page.title).toBe('中文页面');
  });

  it('reads pages that build themselves with JavaScript, and bot-checked ones, through the browser', async () => {
    const rendered = `<html><head><title>App</title></head><body><article><h1>Rendered</h1>${filler('the rendered app', 4)}</article></body></html>`;
    const asked: string[] = [];
    const browser = () => ({ render: async (url: string) => (asked.push(url), { html: rendered, url, title: 'App' }) }) as never;
    const app = await readPage(`${base}/app`, { ...o(), browser });
    expect(app.via).toBe('browser');
    expect(app.note).toMatch(/JavaScript/);
    expect(app.markdown).toContain('Paragraph 1 about the rendered app');
    const guarded = await readPage(`${base}/guarded`, { ...o(), browser });
    expect(guarded.via).toBe('browser');
    expect(guarded.note).toMatch(/bot check/);
    expect(asked).toEqual([`${base}/app`, `${base}/guarded`]);
    forgetPages();
    await expect(readPage(`${base}/guarded`, o())).rejects.toThrow(/bot check/);
  });

  it('reads a PDF as text and pretty-prints JSON', async () => {
    const paper = await readPage(`${base}/paper.pdf`, o());
    expect(paper.via).toBe('pdf');
    expect(paper.markdown).toContain('Attention is all you need');
    const json = await readPage(`${base}/data.json`, o());
    expect(json.markdown).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  });

  it('tries once more when the connection drops, and reports HTTP errors with what the server said', async () => {
    flaky = 0;
    expect((await readPage(`${base}/flaky`, o())).markdown).toBe('answered the second time');
    const err = await readPage(`${base}/missing`, o()).catch((e) => e);
    expect(err).toBeInstanceOf(PageError);
    expect(err.status).toBe(404);
    expect(err.message).toContain('no such page');
  });

  it('gives a long page in parts, with where to read on and the sections further down', () => {
    const md = Array.from({ length: 12 }, (_, i) => `## Section ${i + 1}\n\n${'Text of the section. '.repeat(20)}`).join('\n\n');
    const page = { ...fromHtml('<p>x</p>', 'https://example.com/doc'), markdown: md };
    const first = pageText(page, { maxChars: 1200 });
    expect(first.to).toBeLessThan(md.length);
    expect(first.text).toMatch(new RegExp(`Continue with start: ${first.to}`));
    const later = /\n {2}(\d+) {2}## Section 9\n/.exec(first.text);
    expect(later).not.toBeNull();
    const ninth = pageText(page, { start: Number(later![1]), maxChars: 600 });
    expect(ninth.text).toContain('[From character');
    expect(ninth.text.split('\n\n')[2].startsWith('## Section 9')).toBe(true);
  });
});

describe('search results', () => {
  it('reads the result pages of DuckDuckGo, its lite page and Bing', () => {
    const ddg = `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fguide%2Fcli&amp;rut=x">CLI | <b>Vitest</b></a><a class="result__snippet">Run only <b>related</b> tests.</a></div>
<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Ad</a></div>`;
    expect(parseDuckDuckGo(ddg)).toEqual([{ title: 'CLI | Vitest', url: 'https://vitest.dev/guide/cli', snippet: 'Run only related tests.' }]);
    const lite = `<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa" class='result-link'>Example A</a></td></tr><tr><td class='result-snippet'>About <b>A</b>.</td></tr>`;
    expect(parseDuckDuckGoLite(lite)).toEqual([{ title: 'Example A', url: 'https://example.com/a', snippet: 'About A.' }]);
    const target = Buffer.from('https://example.org/docs/page?x=1').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const bing = `<li class="b_algo" data-id><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${target}&amp;ntb=1">Docs <strong>page</strong></a></h2><div class="b_caption"><p class="b_lineclamp2">Mar 2, 2026 · What the page says.</p></div></li>`;
    expect(parseBing(bing)).toEqual([{ title: 'Docs page', url: 'https://example.org/docs/page?x=1', snippet: 'What the page says.', date: '2026-03-02' }]);
  });

  it('folds copies of a page into one key', () => {
    expect(canonicalUrl('https://www.example.com/docs/?utm_source=x&id=3#top')).toBe(canonicalUrl('http://example.com/docs/index.html?id=3'));
    expect(canonicalUrl('https://m.example.com/a/')).toBe('example.com/a');
  });

  it('merges engines, leaves copy sites out, puts front pages after answers, caps a site at three', () => {
    const r = (url: string, title = url) => ({ title, url, snippet: '' });
    const { results, dropped } = rankResults(
      [
        { engine: 'A', results: [r('https://python.org/'), r('https://stackoverflow.com/questions/1/taskgroup-errors'), r('https://qastack.com/questions/1'), r('https://docs.python.org/3/library/asyncio-task.html')] },
        { engine: 'B', results: [r('https://docs.python.org/3/library/asyncio-task.html'), r('https://www.python.org'), r('https://blog.example.com/1'), r('https://blog.example.com/2'), r('https://blog.example.com/3'), r('https://blog.example.com/4')] },
      ],
      'python asyncio taskgroup exception handling',
    );
    expect(dropped).toEqual(['qastack.com']);
    const urls = results.map((x) => x.url);
    expect(urls[0]).toBe('https://docs.python.org/3/library/asyncio-task.html');
    expect(results[0].engines).toEqual(['A', 'B']);
    expect(urls.indexOf('https://python.org/')).toBeGreaterThan(urls.indexOf('https://stackoverflow.com/questions/1/taskgroup-errors'));
    expect(urls.filter((u) => u.startsWith('https://blog.example.com'))).toHaveLength(3);
  });

  it('keeps a search limited to sites to their pages, without the cap of three', () => {
    const r = (url: string) => ({ title: url, url, snippet: '' });
    const { results } = rankResults(
      [{ engine: 'A', results: [r('https://docs.python.org/3/a.html'), r('https://example.com/x'), r('https://docs.python.org/3/b.html'), r('https://docs.python.org/3/c.html'), r('https://peps.python.org/pep-0654/'), r('https://docs.python.org/3/d.html')] }],
      'asyncio taskgroup',
      { allowed: ['docs.python.org', 'peps.python.org'] },
    );
    expect(results.map((x) => x.url).sort()).toEqual(['https://docs.python.org/3/a.html', 'https://docs.python.org/3/b.html', 'https://docs.python.org/3/c.html', 'https://docs.python.org/3/d.html', 'https://peps.python.org/pep-0654/']);
  });

  it("asks the engines in the query's own language", () => {
    expect(queryLang('Array.prototype.at 負の整数')).toBe('ja');
    expect(queryLang('借用检查 报错')).toBe('zh');
    expect(queryLang('러스트 소유권')).toBe('ko');
    expect(queryLang('rust ownership')).toBeUndefined();
  });

  // The junk of the 2026-11-02 sample: an old version's docs ranked second and quoted, off-topic pages ranked high.
  it("lowers an old version's docs beside the current ones, and results that hold little of the query", () => {
    const r = (url: string, title: string, snippet = '') => ({ title, url, snippet });
    const { results } = rankResults(
      [
        {
          engine: 'A',
          results: [
            r('https://v3.vitejs.dev/config/server-options', 'Server Options | Vite', 'vite server proxy configuration options'),
            r('https://example-recipes.com/best-pasta', 'Best pasta recipes', 'dinner tonight'),
            r('https://vitejs.dev/config/server-options', 'Server Options | Vite', 'vite server proxy configuration options'),
            r('https://forum.example.org/t/vite-proxy-config', 'Vite proxy config not working', 'server proxy configuration in vite'),
          ],
        },
      ],
      'vite server proxy configuration',
    );
    const urls = results.map((x) => x.url);
    expect(urls[0]).toBe('https://vitejs.dev/config/server-options');
    expect(urls.indexOf('https://v3.vitejs.dev/config/server-options')).toBeGreaterThan(urls.indexOf('https://forum.example.org/t/vite-proxy-config'));
    expect(urls.at(-1)).toBe('https://example-recipes.com/best-pasta');
  });

  // 2026-11-02: searches kept finding what was current half a year or a year before.
  it('puts this half-year first for a query that asks for the latest', () => {
    const day = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const r = (url: string, date: string) => ({ title: 'Vite release notes', url, snippet: 'vite latest release version notes', date });
    const lists = [{ engine: 'A', results: [r('https://blog.example.com/vite-6', day(500)), r('https://news.example.org/vite-8', day(60))] }];
    expect(rankResults(lists, 'latest vite release version').results.map((x) => x.url)[0]).toBe('https://news.example.org/vite-8');
    // Without asking for the latest, the engine's order stands.
    expect(rankResults(lists, 'vite release version notes').results.map((x) => x.url)[0]).toBe('https://blog.example.com/vite-6');
  });
});
