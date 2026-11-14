/**
 * Reading a web page for a model. Where a site has an API that returns the exact text (GitHub, Stack Exchange,
 * PyPI, npm) that comes first; otherwise the page itself, decoded in its own charset, with its main content
 * picked out by Readability and turned into markdown with absolute links. PDFs come back as text. Pages that
 * build themselves with JavaScript, or that show plain requests a bot check, are read through the session's
 * browser. Pages are kept for a while, so a search that opened a page and a fetch of it right after cost one
 * request.
 */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { http } from '../net/http';
import { terms } from './passages';
import type { BrowserSession } from './browser';

export interface Page {
  /** Where the text came from, after redirects. */
  url: string;
  title?: string;
  /** The dates the page states (YYYY-MM-DD). */
  published?: string;
  updated?: string;
  markdown: string;
  /** How it was read: the site's API, the page, the browser, a PDF, plain text. */
  via: 'api' | 'page' | 'browser' | 'pdf' | 'text';
  status: number;
  bytes: number;
  /** Told to the model with the page when how it was read matters. */
  note?: string;
  /** The page's links in page order, each address once: what a quoted part links to. */
  links?: PageLink[];
  /** Built by scripts and read without a browser: next to nothing of it is here, so it is not kept. */
  partial?: boolean;
}

export interface PageLink {
  text: string;
  href: string;
  /** Where its text stands in the markdown. */
  at?: number;
}

export class PageError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly bytes = 0,
  ) {
    super(message);
  }
}

export interface ReadOptions {
  signal: AbortSignal;
  proxy: string | false;
  /** The session's browser, for pages plain requests cannot read; absent: no such fallback. */
  browser?: () => BrowserSession | null;
  /** Per request. */
  timeoutMs?: number;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAX_BYTES = 8 * 1024 * 1024;

const isLocal = (host: string) => /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(host);

/** The page at `address`, read the best way available. Throws PageError with a message for the model. */
export async function readPage(address: string, o: ReadOptions): Promise<Page> {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new PageError(`Not a valid URL: ${address}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PageError(`Only http and https pages can be read: ${address}`);
  if (url.protocol === 'http:' && !isLocal(url.hostname)) url.protocol = 'https:';
  const hit = recall(url.href);
  if (hit) return hit;
  for (const site of SITES) {
    const run = site(url);
    if (!run) continue;
    try {
      const page = await run(o);
      if (page) return keep(url.href, page);
    } catch (e) {
      if (o.signal.aborted) throw e;
      // The API refused (rate limit, unknown id): the page itself below.
    }
  }
  return keep(url.href, await readDocument(url, o));
}

// ── kept pages ──────────────────────────────────────────────────────────────

const KEEP_MS = 15 * 60_000;
const kept = new Map<string, { at: number; page: Page }>();
const keyOf = (u: string) => u.replace(/#.*$/, '');

function recall(u: string): Page | undefined {
  const k = kept.get(keyOf(u));
  return k && Date.now() - k.at < KEEP_MS ? k.page : undefined;
}

function keep(asked: string, page: Page): Page {
  // A search reads pages without the browser; the shell of a scripted page kept here would be all a web_fetch
  // right after got, and it would never open the browser.
  if (page.partial) return page;
  const at = Date.now();
  for (const k of new Set([keyOf(asked), keyOf(page.url)])) {
    kept.delete(k);
    kept.set(k, { at, page });
  }
  while (kept.size > 60) kept.delete(kept.keys().next().value!);
  return page;
}

/** Forget kept pages (tests). */
export function forgetPages(): void {
  kept.clear();
}

// ── the page itself ─────────────────────────────────────────────────────────

async function readBody(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < max) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  if (size >= max) await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, max);
}

/**
 * A request that fails at the connection (reset, refused while a proxy reconnects) is tried once more after a
 * moment; a timeout or an HTTP status is an answer and is not.
 */
async function once<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const reason = `${(e as Error).message} ${String((e as { cause?: { code?: string } }).cause?.code ?? '')}`;
    if (signal.aborted || e instanceof PageError || /timeout|aborted/i.test(reason) || !/fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket|UND_ERR|other side closed/i.test(reason)) throw e;
    await new Promise((r) => setTimeout(r, 600));
    return run();
  }
}

async function readDocument(url: URL, o: ReadOptions): Promise<Page> {
  let res: Response;
  let buf: Buffer;
  try {
    ({ res, buf } = await once(async () => {
      const r = await http(url.href, {
        headers: {
          'User-Agent': BROWSER_UA,
          // Markdown first: sites that serve it to agents (Cloudflare's markdown for agents, docs sites) send it.
          Accept: 'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, application/pdf;q=0.7, */*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        },
        signal: AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs ?? 45_000)]),
        proxy: isLocal(url.hostname) ? false : o.proxy,
      });
      return { res: r, buf: await readBody(r, MAX_BYTES) };
    }, o.signal));
  } catch (e) {
    if (o.signal.aborted) throw e;
    // Some sites drop clients that are not browsers before answering.
    const page = await rendered(url.href, o, 'Plain requests to this site failed, so it was read through the browser.');
    if (page) return page;
    throw new PageError(`Fetch failed: ${(e as Error).message}`);
  }
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const final = res.url || url.href;
  if (type.includes('application/pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') return pdfPage(buf, final, res.status);
  if (/^(image|audio|video|font)\/|octet-stream|zip|x-tar|x-7z/.test(type)) {
    throw new PageError(`${final} is ${type || 'binary data'} (${buf.length} bytes); only pages, text and PDFs can be read.`, res.status, buf.length);
  }
  const text = decodeText(buf, type);
  const html = /html|xml/.test(type) ? !/json/.test(type) : /^\s*<(!doctype html|html|head|body)\b/i.test(text);
  const blocked = botCheck(res.status, html ? text : '');
  if (!res.ok && !blocked) throw new PageError(`HTTP ${res.status} from ${final}.\n${excerpt(text, html)}`, res.status, buf.length);
  if (!html) return { url: final, markdown: plainText(text, type), via: 'text', status: res.status, bytes: buf.length };
  const page = blocked ? null : fromHtml(text, final, res.status, buf.length);
  const thin = !!page && scripted(text, page);
  if (blocked || thin) {
    const shown = await rendered(final, o, blocked ? 'The site answers plain requests with a bot check, so this was read through the browser.' : 'The page builds its content with JavaScript, so this was read through the browser.');
    if (shown && shown.markdown.length > (page?.markdown.length ?? 0)) return shown;
  }
  if (page) return thin ? { ...page, partial: true } : page;
  throw new PageError(
    `${final} answered ${res.status} with a bot check${o.browser ? ', and the browser could not get past it either' : ''}. Open it with the browser tool, or find the same content elsewhere.`,
    res.status,
    buf.length,
  );
}

/** The text in its own charset: the header's, a byte-order mark, or the page's meta tag; UTF-8 otherwise. */
export function decodeText(buf: Buffer, type: string): string {
  let label = /charset=["']?([\w.:-]+)/i.exec(type)?.[1];
  if (!label) {
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) label = 'utf-8';
    else if (buf[0] === 0xff && buf[1] === 0xfe) label = 'utf-16le';
    else if (buf[0] === 0xfe && buf[1] === 0xff) label = 'utf-16be';
    else {
      const head = buf.subarray(0, 4096).toString('latin1');
      label = /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding=["']([\w.:-]+)/i.exec(head)?.[1];
    }
  }
  try {
    return new TextDecoder(label ?? 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function plainText(text: string, type: string): string {
  if (/json/.test(type) && text.length < 2_000_000) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* as it came */
    }
  }
  return text;
}

function excerpt(text: string, html: boolean): string {
  const t = html ? text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ') : text;
  return t.replace(/\s+/g, ' ').trim().slice(0, 600);
}

/** A bot check or block page in place of the content (or a refusal that a browser may get past). */
export function botCheck(status: number, html: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  if (!html || html.length > 40_000) return false;
  return /<title>\s*(just a moment|attention required|access denied|please wait|checking your browser|verify(ing)? you are (a )?human|security check|are you a robot)|cf-browser-verification|challenge-platform|cf_chl_opt|captcha-delivery|px-captcha|_incapsula_|datadome/i.test(html);
}

/** A page that shows next to nothing without its scripts. */
function scripted(html: string, page: Page): boolean {
  if (page.markdown.replace(/\s+/g, ' ').trim().length >= 400) return false;
  return /<script\b/i.test(html) && (/<noscript\b[^>]*>[\s\S]{0,600}?javascript/i.test(html) || /<(div|main|section)[^>]+id=["'](root|app|__next|__nuxt|svelte|main)["'][^>]*>\s*<\/\1>/i.test(html) || html.length > 3000);
}

async function rendered(url: string, o: ReadOptions, note: string): Promise<Page | null> {
  const b = o.browser?.();
  if (!b) return null;
  try {
    const r = await b.render(url, { timeoutMs: 25_000, signal: o.signal });
    if (botCheck(200, r.html)) return null;
    const page = fromHtml(r.html, r.url || url, 200, Buffer.byteLength(r.html), 'browser');
    return page.markdown.trim() ? { ...page, note } : null;
  } catch {
    return null;
  }
}

async function pdfPage(buf: Buffer, url: string, status: number): Promise<Page> {
  let pages: string[];
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
    pages = (await extractText(pdf, { mergePages: false })).text;
  } catch (e) {
    throw new PageError(`${url} could not be read as a PDF: ${(e as Error).message}`, status, buf.length);
  }
  if (!pages.some((p) => p.trim())) throw new PageError(`${url} is a PDF without a text layer (probably scanned); download it and run OCR to read it.`, status, buf.length);
  const markdown = pages.map((p, i) => `## Page ${i + 1} of ${pages.length}\n\n${p.trim()}`).join('\n\n');
  return { url, markdown, via: 'pdf', status, bytes: buf.length, note: `A PDF of ${pages.length} page${pages.length === 1 ? '' : 's'}.` };
}

// ── HTML to markdown ────────────────────────────────────────────────────────

/** The part of a DOM node the reading below uses (core is built without the DOM types). */
interface El {
  nodeName: string;
  getAttribute(name: string): string | null;
  parentNode: El | null;
  children: ArrayLike<El>;
  innerHTML: string;
  outerHTML: string;
  textContent: string | null;
  querySelectorAll(selector: string): ArrayLike<El>;
  cloneNode(deep: boolean): El;
  remove(): void;
}

/** Inside a page's main element: its navigation, side panels and controls, not its content. */
const CHROME = 'nav, aside, footer, dialog, form, button, [role=navigation], [role=complementary], [role=search], [role=contentinfo], [aria-hidden=true]';

const textLength = (s?: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().length;

/** The page's main element (the largest when there are several) without its navigation, and how much text it holds. */
function mainPart(document: El): { html: string; length: number } | undefined {
  let best: El | undefined;
  let most = 0;
  for (const el of Array.from(document.querySelectorAll('main, [role=main]'))) {
    const n = textLength(el.textContent);
    if (n > most) [best, most] = [el, n];
  }
  if (!best) return undefined;
  const part = best.cloneNode(true);
  for (const el of Array.from(part.querySelectorAll(CHROME))) el.remove();
  return { html: part.outerHTML, length: textLength(part.textContent) };
}

/** The page's main content as markdown: Readability's article, the main element, or the whole body without its chrome. */
export function fromHtml(html: string, url: string, status = 200, bytes = html.length, via: Page['via'] = 'page'): Page {
  const dates = pageDates(html);
  const { document } = parseHTML(html);
  const docTitle = squash(document.title ?? '');
  // Not text: left in, scripts and styles would count as the main element's text below, and a template holds
  // markup the page does not show.
  for (const el of Array.from((document as unknown as El).querySelectorAll('script, style, noscript, template'))) el.remove();
  // Measured before Readability, which takes the document apart as it reads.
  const main = mainPart(document as unknown as El);
  let article: ReturnType<Readability['parse']> = null;
  try {
    article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 400, keepClasses: true }).parse();
  } catch {
    /* the main element or the whole body below */
  }
  const held = textLength(article?.textContent);
  // Readability drops what looks like navigation to it: MDN's lead paragraph, Go's function signatures, Vercel's
  // limit tables, the list that is a docs index page's content. Where its article holds under nine tenths of the
  // main element's text, the main element is read instead; on the saved pages of evals/web (2026-11-08) the two
  // agree within five percent or the article lacks fifteen percent and more.
  const content = main && main.length >= 200 && held < main.length * 0.9 ? main.html : article?.content && held >= 200 ? article.content : withoutChrome(html);
  const body = markdownOf(content, url);
  return {
    url,
    title: docTitle || squash(article?.title ?? '') || undefined,
    published: dates.published ?? isoDay(article?.publishedTime),
    updated: dates.updated,
    markdown: `${body.markdown}${linkList(url, body.links)}`,
    via,
    status,
    bytes,
    ...(body.links.length ? { links: body.links } : {}),
  };
}

function withoutChrome(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe|template|canvas)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, (m) => (m.length > 20_000 ? m : ''))
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** A table as a markdown table, each cell converted on its own; layout tables stay as text. */
function tableMarkdown(table: El, content: string): string {
  const own = (tr: El) => {
    let p = tr.parentNode;
    while (p && p.nodeName !== 'TABLE') p = p.parentNode;
    return p === table;
  };
  const rows = Array.from(table.querySelectorAll('tr')).filter(own);
  // A long table as text ran its cells together (a registry's "603600`owner`"); past a few hundred rows its cells
  // are read as plain text, which costs a fraction of converting each.
  const plain = rows.length > 400;
  const grid = rows.map((tr) =>
    Array.from(tr.children)
      .filter((c) => c.nodeName === 'TD' || c.nodeName === 'TH')
      .map((c) => (plain ? squash(c.textContent ?? '') : turndown!.turndown(c.innerHTML).replace(/\n+/g, ' ')).replace(/\|/g, '\\|').trim()),
  );
  const width = Math.max(0, ...grid.map((r) => r.length));
  if (width < 2 || grid.length < 2) return `\n\n${content}\n\n`;
  const pad = (r: string[]) => [...r, ...Array<string>(width - r.length).fill('')];
  const lines = [`| ${pad(grid[0]).join(' | ')} |`, `|${' --- |'.repeat(width)}`, ...grid.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)];
  return `\n\n${lines.join('\n')}\n\n`;
}

let turndown: TurndownService | undefined;
let base = '';

const blank = (s: string) => !s.replace(/[\s\u200b\u200c\u200d\ufeff]+/g, '');

/** HTML to markdown, with a list of where its links go at the end; in-page anchors and inline images in data URIs drop out. */
export function toMarkdown(html: string, pageUrl: string): string {
  const { markdown, links } = markdownOf(html, pageUrl);
  return `${markdown}${linkList(pageUrl, links)}`;
}

/** HTML to markdown with the text of its links in place, and the links (absolute, each once) in page order. */
function markdownOf(html: string, pageUrl: string): { markdown: string; links: PageLink[] } {
  if (!turndown) {
    turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    turndown.remove(['script', 'style', 'noscript', 'template']);
    // A model reads the text, nothing renders it: markdown's escapes only cost characters and change what a
    // quote looks like (snake\_case, \>>> prompts, \-- flags).
    turndown.escape = (s: string) => s;
    turndown.addRule('code', {
      filter: 'pre',
      replacement: (_content, node) => {
        const pre = node as unknown as El;
        const text = codeText(pre).replace(/^\n+|\s+$/g, '');
        if (!text) return '';
        const fence = text.includes('```') ? '````' : '```';
        return `\n\n${fence}${codeLanguage(pre)}\n${text}\n${fence}\n\n`;
      },
    });
    turndown.addRule('links', {
      filter: (node) => node.nodeName === 'A' && !!(node as unknown as El).getAttribute('href'),
      replacement: (content, node) => {
        if (blank(content)) return '';
        const href = ((node as unknown as El).getAttribute('href') ?? '').trim();
        if (href.startsWith('#') || /^javascript:/i.test(href)) return content;
        let abs: string;
        try {
          abs = new URL(href, base).href;
        } catch {
          return content;
        }
        // The text stays where it is; addresses go in one list at the end (they were a quarter of a page's characters).
        pageLinks.push({ text: squash(content), href: abs });
        return content;
      },
    });
    turndown.addRule('tables', {
      filter: 'table',
      replacement: (content, node) => tableMarkdown(node as unknown as El, content),
    });
    turndown.addRule('images', {
      filter: 'img',
      replacement: (_content, node) => {
        const img = node as unknown as El;
        // What a picture shows, not where it is stored: the browser tool sees pictures when they matter.
        const alt = squash(img.getAttribute('alt') ?? '');
        return alt && img.getAttribute('width') !== '1' ? `[image: ${alt}]` : '';
      },
    });
  }
  base = pageUrl;
  pageLinks = [];
  const markdown = tidy(turndown.turndown(html));
  const seen = new Set<string>();
  const links = pageLinks.filter((l) => {
    if (!l.text || l.text.startsWith('[image:') || seen.has(l.href) || /^(mailto|tel):|\/(share|sharer|intent)\b|[?&](share|utm_)/i.test(l.href)) return false;
    seen.add(l.href);
    return true;
  });
  return { markdown, links: placeLinks(markdown, links) };
}

let pageLinks: PageLink[] = [];

/**
 * Where each link's text stands in the markdown, found in page order: a passage quoted from the page can then say
 * where the links in it go. A text not found from where the last one stood keeps no place.
 */
function placeLinks(md: string, links: PageLink[]): PageLink[] {
  let from = 0;
  return links.map((l) => {
    const at = md.indexOf(l.text, from);
    if (at < 0) return { text: l.text, href: l.href };
    // A far jump is more likely the same words elsewhere than this link: placed, but the search goes on from here.
    if (at - from < 5000) from = at;
    return { ...l, at };
  });
}

/**
 * Up to twenty of a page's links with their text, the page's own site and other sites in turn: where to read on,
 * without every address inline. A docs index's own pages are what it links to, an article's sources are elsewhere.
 */
function linkList(pageUrl: string, links: PageLink[]): string {
  let own = '';
  try {
    own = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    own = '';
  }
  const here = pageUrl.replace(/#.*$/, '');
  const usable = links.filter((l) => l.text.length >= 3 && l.href.replace(/#.*$/, '') !== here);
  const offSite = (l: PageLink) => {
    try {
      return new URL(l.href).hostname.replace(/^www\./, '') !== own;
    } catch {
      return false;
    }
  };
  const away = usable.filter(offSite);
  const home = usable.filter((l) => !offSite(l));
  const chosen: PageLink[] = [];
  for (let i = 0; chosen.length < 20 && (i < away.length || i < home.length); i++) {
    if (i < home.length) chosen.push(home[i]);
    if (i < away.length && chosen.length < 20) chosen.push(away[i]);
  }
  return chosen.length ? `\n\nLinks on the page:\n${chosen.map((l) => `- ${l.text.slice(0, 80)}: ${l.href}`).join('\n')}` : '';
}

/**
 * The page's links that stand in characters `from` to `to` of its markdown and whose text names something the
 * query asks about, the closest matches first: where a quoted part points on the question. A part of an index
 * page holds hundreds of links, and its first few were seldom the ones asked for.
 */
export function linksIn(page: Pick<Page, 'links' | 'url'>, from: number, to: number, query: string, max: number): PageLink[] {
  const here = page.url.replace(/#.*$/, '');
  const asked = new Set(terms(query));
  return (page.links ?? [])
    .filter((l) => l.at !== undefined && l.at >= from && l.at < to && l.text.length >= 3 && l.href.replace(/#.*$/, '') !== here)
    .map((l) => ({ l, hits: new Set(terms(l.text).filter((t) => asked.has(t))).size }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, max)
    .map((x) => x.l);
}

/** Links as lines under a quoted part. */
export function linkLines(links: PageLink[], indent = ''): string {
  return links.length ? `\n${indent}Links in this part:\n${links.map((l) => `${indent}- ${l.text.slice(0, 80)}: ${l.href}`).join('\n')}` : '';
}

/** Elements that each hold one line of code, for highlighters that put no line breaks between them. */
const CODE_LINES = ['.ec-line', '.cm-line', '.line', '.code-line', '[data-line-number]', '[data-line]'];

/** A code block's text, one line per line. */
function codeText(pre: El): string {
  const text = pre.textContent ?? '';
  for (const selector of CODE_LINES) {
    const lines = Array.from(pre.querySelectorAll(selector));
    if (lines.length < 2) continue;
    // Expressive Code, CodeMirror and some Shiki builds lay lines out as blocks with nothing between them: read
    // as text, a whole example came out as one line.
    return text.split('\n').length >= lines.length ? text : lines.map((l) => l.textContent ?? '').join('\n');
  }
  return text;
}

const LANGS =
  'js|jsx|mjs|cjs|ts|tsx|mts|javascript|typescript|json|jsonc|json5|bash|sh|shell|zsh|fish|console|powershell|ps1|pwsh|cmd|bat|python|py|pycon|go|rust|rs|java|kotlin|kt|c|cpp|cs|csharp|ruby|rb|php|swift|html|xml|svg|css|scss|sass|less|yaml|yml|toml|ini|sql|graphql|gql|diff|text|txt|vue|svelte|astro|dockerfile|makefile|lua|r|dart|elixir|haskell|scala|perl|nginx|proto|http';
const LANG_NAMES = new Set(LANGS.split('|'));
const LABEL = new RegExp(`^(${LANGS})\\n+(\`{3,}|~~~)(\\w*)\\n`, 'gim');

/**
 * A code block's language, from the block or the few elements around it: a data-language attribute, or a class
 * such as language-ts, lang-js, highlight-python3 (Sphinx) or sp-javascript (Sandpack).
 */
function codeLanguage(pre: El): string {
  const code = Array.from(pre.children).find((c) => c.nodeName === 'CODE');
  let el: El | null = code ?? pre;
  for (let i = 0; el && i < 5; i++, el = el === code ? pre : el.parentNode) {
    if (typeof el.getAttribute !== 'function') break;
    const named = (el.getAttribute('data-language') ?? el.getAttribute('data-lang') ?? '').toLowerCase();
    if (/^[\w+#-]{1,20}$/.test(named) && named !== 'plaintext') return named;
    for (const c of (el.getAttribute('class') ?? '').toLowerCase().split(/\s+/)) {
      const name = /^(?:language|lang|highlight|sp)-([\w+#-]+?)\d*$/.exec(c)?.[1];
      if (name && LANG_NAMES.has(name)) return name;
    }
  }
  return '';
}

function tidy(md: string): string {
  return (
    md
      // A code block's language printed as a label above it (VitePress, MDN): put it on the fence.
      .replace(LABEL, (_m, lang: string, fence: string, own: string) => `${fence}${own || lang.toLowerCase()}\n`)
      // Sphinx and the RFC editor's pilcrows, an anchor at each heading and paragraph.
      .replace(/ ?\u00b6$/gm, '')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function pageDates(html: string): { published?: string; updated?: string } {
  const head = html.slice(0, 300_000);
  const meta = (names: string[]) => {
    for (const n of names) {
      const m =
        new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]*content=["']([^"']+)["']`, 'i').exec(head) ??
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']${n}["']`, 'i').exec(head);
      const d = isoDay(m?.[1]);
      if (d) return d;
    }
    return undefined;
  };
  const ld = (key: string) => isoDay(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(head)?.[1]);
  return {
    published: meta(['article:published_time', 'datePublished', 'pubdate', 'publishdate', 'og:published_time', 'dc.date.issued', 'date']) ?? ld('datePublished'),
    updated: meta(['article:modified_time', 'og:updated_time', 'dateModified']) ?? ld('dateModified'),
  };
}

export function isoDay(s?: string | number | null): string | undefined {
  if (s === undefined || s === null || s === '') return undefined;
  const t = typeof s === 'number' ? s : Date.parse(s);
  return Number.isFinite(t) && t > Date.UTC(1990, 0, 1) && t < Date.now() + 2 * 86_400_000 ? new Date(t).toISOString().slice(0, 10) : undefined;
}

// ── a page as a tool result ─────────────────────────────────────────────────

export interface Heading {
  title: string;
  level: number;
  start: number;
}

/** The page's headings (levels 1-3) with where each starts, outside code blocks. */
export function outline(md: string): Heading[] {
  const out: Heading[] = [];
  let offset = 0;
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,3})\s+(.+)$/.exec(line);
    if (m) out.push({ title: m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim(), level: m[1].length, start: offset });
    offset += line.length + 1;
  }
  return out;
}

function dateLine(page: Page): string {
  if (page.published && page.updated && page.updated !== page.published) return `Published ${page.published}, updated ${page.updated}.`;
  if (page.published) return `Published ${page.published}.`;
  if (page.updated) return `Updated ${page.updated}.`;
  return '';
}

/** The page's header: address, title, dates and how it was read. */
export function pageHeader(page: Page): string {
  return [`${page.url}${page.title ? ` — ${page.title}` : ''}`, dateLine(page), page.note ?? ''].filter(Boolean).join('\n');
}

/**
 * The page as a tool result from character `start`, at most `maxChars` of it, cut at a paragraph; when more
 * follows, where to read on and the sections further down with their starts.
 */
export function pageText(page: Page, opts: { start?: number; maxChars: number }): { text: string; from: number; to: number; total: number } {
  const md = page.markdown;
  const total = md.length;
  let from = Math.max(0, Math.min(total, Math.floor(opts.start ?? 0)));
  if (from > 0) from = md.lastIndexOf('\n', from - 1) + 1;
  let to = Math.min(total, from + opts.maxChars);
  if (to < total) {
    const cut = md.lastIndexOf('\n\n', to);
    if (cut > from + opts.maxChars * 0.6) to = cut;
  }
  let text = `${pageHeader(page)}\n\n${from > 0 ? `[From character ${from} of ${total}.]\n\n` : ''}${md.slice(from, to).trim()}`;
  if (to < total) {
    let later = outline(md).filter((h) => h.start >= to);
    // A long reference page: its sections, not every entry under them.
    const sections = later.filter((h) => h.level <= 2);
    if (later.length > 30 && sections.length >= 5) later = sections;
    const list = later.slice(0, 30).map((h) => `  ${h.start}  ${'#'.repeat(h.level)} ${h.title}`);
    text += `\n\n[Shown: characters ${from}-${to} of ${total}. Continue with start: ${to}${list.length ? `, or start at a section further down:\n${list.join('\n')}${later.length > 30 ? `\n  … ${later.length - 30} more` : ''}` : '.'}]`;
  }
  return { text, from, to, total };
}

// ── sites with an API ───────────────────────────────────────────────────────

type Site = (u: URL) => ((o: ReadOptions) => Promise<Page | null>) | null;

async function apiText(url: string, o: ReadOptions, accept = 'application/json'): Promise<string> {
  const headers: Record<string, string> = { 'User-Agent': 'Favilla', Accept: accept };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  // A GitHub token from the environment goes to GitHub's API only: more requests per hour, private repos.
  if (token && new URL(url).hostname === 'api.github.com') headers.Authorization = `Bearer ${token}`;
  return once(async () => {
    const res = await http(url, { headers, signal: AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs ?? 20_000)]), proxy: o.proxy });
    const text = (await readBody(res, MAX_BYTES)).toString('utf8');
    if (!res.ok) throw new PageError(`HTTP ${res.status} from ${url}`, res.status);
    return text;
  }, o.signal);
}

const apiJson = async (url: string, o: ReadOptions, accept?: string) => JSON.parse(await apiText(url, o, accept));

const apiPage = (url: string, title: string, markdown: string, extra: Partial<Page> = {}): Page => ({ url, title, markdown: markdown.trim(), via: 'api', status: 200, bytes: Buffer.byteLength(markdown), ...extra });

function fenced(file: string, text: string): string {
  if (/\.(md|markdown|mdx|txt|rst)$/i.test(file)) return text;
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${/\.(\w+)$/.exec(file)?.[1]?.toLowerCase() ?? ''}\n${text.replace(/\n$/, '')}\n${fence}`;
}

const ROLES: Record<string, string> = { OWNER: ' (owner)', MEMBER: ' (member)', COLLABORATOR: ' (collaborator)', CONTRIBUTOR: ' (contributor)' };

const github: Site = (u) => {
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  const [owner, repoName, kind, ...rest] = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (!owner || !repoName || /^(orgs|settings|marketplace|topics|collections|sponsors|features|login|search|notifications|explore)$/.test(owner)) return null;
  const repo = repoName.replace(/\.git$/, '');
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const day = (s?: string) => isoDay(s) ?? '?';
  if (kind === 'blob' && rest.length >= 2) {
    return async (o) => {
      const text = await apiText(`https://raw.githubusercontent.com/${owner}/${repo}/${rest.join('/')}`, o, 'text/plain');
      const file = rest.slice(1).join('/');
      // A line anchor (#L10-L20) asks for those lines: them with a little around, numbered.
      const lines = /^#L(\d+)(?:-L(\d+))?$/.exec(u.hash);
      if (lines) {
        const all = text.split('\n');
        const a = Math.max(1, Number(lines[1]) - 3);
        const b = Math.min(all.length, Number(lines[2] ?? lines[1]) + 3);
        const body = all.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(5)}  ${l}`).join('\n');
        return apiPage(u.href, `${owner}/${repo}: ${file} lines ${a}-${b} of ${all.length}`, `\`\`\`\n${body}\n\`\`\``);
      }
      return apiPage(u.href, `${owner}/${repo}: ${file}`, fenced(file, text));
    };
  }
  if ((kind === 'issues' || kind === 'pull') && /^\d+$/.test(rest[0] ?? '')) {
    const n = rest[0];
    return async (o) => {
      const issue = await apiJson(`${api}/issues/${n}`, o);
      const comments: any[] = issue.comments ? await apiJson(`${api}/issues/${n}/comments?per_page=100`, o) : [];
      let more = '';
      if (issue.comments > 100) {
        // Long threads: the first hundred and the latest ones, where fixes and decisions usually land.
        const last = await apiJson(`${api}/issues/${n}/comments?per_page=100&page=${Math.ceil(issue.comments / 100)}`, o).catch(() => []);
        comments.push({ gap: issue.comments - 100 - last.length }, ...last);
        more = `\n\n[${issue.comments} comments in all: the first 100 and the last ${last.length} are shown.]`;
      }
      let files = '';
      if (issue.pull_request) {
        const changed: any[] = await apiJson(`${api}/pulls/${n}/files?per_page=100`, o).catch(() => []);
        if (changed.length) files = `\n\nFiles changed:\n${changed.map((f) => `- ${f.filename} (+${f.additions} −${f.deletions})`).join('\n')}`;
      }
      const what = issue.pull_request ? 'Pull request' : 'Issue';
      const facts = [
        `${what} #${n} in ${owner}/${repo}`,
        `${issue.state}${issue.state_reason && issue.state_reason !== 'reopened' ? ` (${issue.state_reason})` : ''}`,
        issue.pull_request?.merged_at ? `merged ${day(issue.pull_request.merged_at)}` : '',
        `opened by ${issue.user?.login ?? '?'} on ${day(issue.created_at)}`,
        issue.labels?.length ? `labels: ${issue.labels.map((l: { name: string }) => l.name).join(', ')}` : '',
      ].filter(Boolean);
      const thread = comments
        .map((c) => (c.gap ? `---\n\n[${c.gap} comments not shown]` : `---\n\n**${c.user?.login ?? '?'}**${ROLES[c.author_association] ?? ''} on ${day(c.created_at)}:\n\n${(c.body ?? '').trim()}`))
        .join('\n\n');
      return apiPage(u.href, `${owner}/${repo}#${n}: ${issue.title}`, `# ${issue.title}\n\n${facts.join(' · ')}\n\n${issue.body?.trim() || '(no description)'}${files}${thread ? `\n\n${thread}` : ''}${more}`, {
        published: isoDay(issue.created_at),
        updated: isoDay(issue.updated_at),
      });
    };
  }
  if (kind === 'commit' && rest[0]) {
    return async (o) => {
      const c = await apiJson(`${api}/commits/${rest[0]}`, o);
      const files = (c.files ?? []).map((f: any) => `### ${f.filename} (${f.status}, +${f.additions} −${f.deletions})${f.patch ? `\n\n\`\`\`diff\n${f.patch}\n\`\`\`` : ''}`).join('\n\n');
      return apiPage(u.href, `${owner}/${repo}@${String(c.sha).slice(0, 10)}: ${String(c.commit?.message ?? '').split('\n')[0]}`, `# ${c.commit?.message ?? ''}\n\n${c.commit?.author?.name ?? '?'} on ${day(c.commit?.author?.date)}\n\n${files}`, { published: isoDay(c.commit?.author?.date) });
    };
  }
  if (kind === 'releases') {
    return async (o) => {
      const list: any[] = rest[0] === 'tag' && rest[1] ? [await apiJson(`${api}/releases/tags/${encodeURIComponent(rest.slice(1).join('/'))}`, o)] : await apiJson(`${api}/releases?per_page=10`, o);
      const md = list.map((r) => `## ${r.name || r.tag_name} (${r.tag_name}) · ${day(r.published_at)}${r.prerelease ? ' · pre-release' : ''}\n\n${(r.body ?? '').trim()}`).join('\n\n');
      return apiPage(u.href, `${owner}/${repo} releases`, `# ${owner}/${repo} releases\n\n${md || '(no releases)'}`);
    };
  }
  if (kind === 'tree' && rest.length >= 2) {
    // A folder: what is in it, and its README.
    return async (o) => {
      const [ref, ...parts] = rest;
      const dir = parts.join('/');
      const items: any[] = await apiJson(`${api}/contents/${dir}?ref=${encodeURIComponent(ref)}`, o);
      const list = items
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
        .map((i) => (i.type === 'dir' ? `- ${i.name}/` : `- ${i.name} (${i.size < 1024 ? `${i.size} B` : `${(i.size / 1024).toFixed(1)} KB`})`))
        .join('\n');
      const readme = items.find((i) => /^readme(\.|$)/i.test(i.name) && i.download_url);
      const text = readme ? await apiText(readme.download_url, o, 'text/plain').catch(() => '') : '';
      return apiPage(u.href, `${owner}/${repo}/${dir} (${ref})`, `# ${owner}/${repo}/${dir} at ${ref}\n\n${list}${text ? `\n\n---\n\n${text}` : ''}`);
    };
  }
  if (!kind || (kind === 'tree' && rest.length <= 1)) {
    return async (o) => {
      const info = await apiJson(api, o);
      const readme = await apiText(`${api}/readme${rest[0] ? `?ref=${encodeURIComponent(rest[0])}` : ''}`, o, 'application/vnd.github.raw').catch(() => '');
      const license = info.license?.spdx_id && info.license.spdx_id !== 'NOASSERTION' ? info.license.spdx_id : '';
      const facts = [`${info.stargazers_count} stars`, `${info.forks_count} forks`, info.language, license, `default branch ${info.default_branch}`, `last push ${day(info.pushed_at)}`, info.archived ? 'archived' : '', info.homepage].filter(Boolean);
      return apiPage(u.href, `${info.full_name}${info.description ? `: ${info.description}` : ''}`, `# ${info.full_name}\n\n${info.description ?? ''}\n\n${facts.join(' · ')}\n\n${readme || '(no README)'}`, { updated: isoDay(info.pushed_at) });
    };
  }
  return null;
};

const SE_HOSTS: Record<string, string> = { 'stackoverflow.com': 'stackoverflow', 'superuser.com': 'superuser', 'serverfault.com': 'serverfault', 'askubuntu.com': 'askubuntu', 'mathoverflow.net': 'mathoverflow.net', 'stackapps.com': 'stackapps' };

const unescapeHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const stackExchange: Site = (u) => {
  const host = u.hostname.replace(/^www\./, '');
  const site = SE_HOSTS[host] ?? /^([a-z]+)\.stackexchange\.com$/.exec(host)?.[1] ?? (/^(ja|ru|es|pt)\.stackoverflow\.com$/.test(host) ? host.replace(/\.com$/, '') : undefined);
  const id = /^\/(?:questions|q)\/(\d+)/.exec(u.pathname)?.[1];
  if (!site || !id) return null;
  return async (o) => {
    const api = 'https://api.stackexchange.com/2.3';
    const q = (await apiJson(`${api}/questions/${id}?site=${site}&filter=withbody`, o)).items?.[0];
    if (!q) return null;
    const answers: any[] = (await apiJson(`${api}/questions/${id}/answers?site=${site}&filter=withbody&sort=votes&order=desc&pagesize=6`, o)).items ?? [];
    const day = (t?: number) => isoDay(t ? t * 1000 : undefined) ?? '?';
    const title = unescapeHtml(q.title ?? '');
    const facts = [`asked ${day(q.creation_date)}`, `score ${q.score}`, `${q.answer_count} answers`, q.tags?.length ? q.tags.join(', ') : '', q.closed_reason ? `closed: ${q.closed_reason}` : ''].filter(Boolean);
    const links: PageLink[] = [];
    const body = (html: string) => {
      const m = markdownOf(html, u.href);
      links.push(...m.links);
      return m.markdown;
    };
    const parts = [
      `# ${title}`,
      facts.join(' · '),
      body(q.body ?? ''),
      ...answers.map((a) => `---\n\n## ${a.is_accepted ? 'Accepted answer' : 'Answer'} · score ${a.score} · ${day(a.last_edit_date ?? a.creation_date)}\n\n${body(a.body ?? '')}`),
    ];
    if (q.answer_count > answers.length) parts.push(`[${q.answer_count - answers.length} more answers with fewer votes at ${q.link ?? u.href}]`);
    // One list of where the thread's links go, not one under each answer.
    const text = parts.join('\n\n');
    const placed = placeLinks(text, links.filter((l, i) => links.findIndex((o) => o.href === l.href) === i));
    return apiPage(q.link ?? u.href, title, `${text}${linkList(u.href, placed)}`, { published: isoDay(q.creation_date * 1000), updated: isoDay((q.last_activity_date ?? 0) * 1000), ...(placed.length ? { links: placed } : {}) });
  };
};

const pypi: Site = (u) => {
  if (u.hostname !== 'pypi.org') return null;
  const m = /^\/project\/([^/]+)(?:\/([^/]+))?\/?$/.exec(u.pathname);
  if (!m) return null;
  return async (o) => {
    const d = await apiJson(`https://pypi.org/pypi/${m[1]}${m[2] ? `/${m[2]}` : ''}/json`, o);
    const i = d.info ?? {};
    const released = d.urls?.[0]?.upload_time_iso_8601;
    const license = i.license_expression || (i.license && i.license.length < 40 ? i.license : '');
    const links = Object.entries(i.project_urls ?? {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    const facts = [i.requires_python ? `Python ${i.requires_python}` : '', license, released ? `released ${isoDay(released)}` : ''].filter(Boolean);
    return apiPage(u.href, `${i.name} ${i.version} on PyPI`, `# ${i.name} ${i.version}\n\n${i.summary ?? ''}\n\n${facts.join(' · ')}${links ? `\n\n${links}` : ''}\n\n${i.description ?? ''}`, { published: isoDay(released) });
  };
};

const npm: Site = (u) => {
  if (!/^(www\.)?npmjs\.com$/.test(u.hostname)) return null;
  const m = /^\/package\/((?:@[^/]+\/)?[^/]+)(?:\/v\/([^/]+))?/.exec(u.pathname);
  if (!m) return null;
  return async (o) => {
    // npm's site turns non-browsers away; its registry and a CDN of package files do not.
    const name = decodeURIComponent(m[1]);
    const v = await apiJson(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${m[2] ?? 'latest'}`, o);
    let readme = '';
    for (const file of ['README.md', 'readme.md', 'Readme.md']) {
      readme = await apiText(`https://cdn.jsdelivr.net/npm/${name}@${v.version}/${file}`, o, 'text/plain').catch(() => '');
      if (readme) break;
    }
    const repo = typeof v.repository === 'string' ? v.repository : v.repository?.url;
    const facts = [v.license ? `license ${v.license}` : '', v.homepage, repo, v.engines?.node ? `node ${v.engines.node}` : ''].filter(Boolean);
    const deps = Object.keys(v.dependencies ?? {});
    return apiPage(u.href, `${name} ${v.version} on npm`, `# ${name} ${v.version}\n\n${v.description ?? ''}\n\n${facts.join(' · ')}${deps.length ? `\n\nDepends on: ${deps.join(', ')}` : ''}\n\n${readme || '(no README in the package)'}`);
  };
};

const arxiv: Site = (u) => {
  if (!/^(www\.|export\.)?arxiv\.org$/.test(u.hostname)) return null;
  const id = /^\/pdf\/([\w.\/-]+?)(?:\.pdf)?\/?$/.exec(u.pathname)?.[1];
  if (!id) return null;
  // A paper's PDF: its HTML rendering when arXiv has one (full text, no multi-megabyte download), else the PDF.
  return async (o) => {
    const html = await apiText(`https://arxiv.org/html/${id}`, o, 'text/html').catch(() => '');
    if (!html || !/<article\b|class="ltx_document/.test(html)) return null;
    const page = fromHtml(html, `https://arxiv.org/html/${id}`);
    return page.markdown.length > 2000 ? { ...page, via: 'page' as const, note: `The HTML rendering of arXiv ${id}; the PDF is at ${u.href}.` } : null;
  };
};

const SITES: Site[] = [github, stackExchange, pypi, npm, arxiv];
