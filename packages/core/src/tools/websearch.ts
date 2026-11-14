/**
 * Web search for models whose provider has none of its own. Several engines are asked at once (DuckDuckGo and
 * Bing need no key; Brave's API and a SearXNG instance join when configured); their lists are merged by rank,
 * copies of the same page fold into one, copy sites are left out and primary sources move up. The top results
 * are then opened and the passages that answer the query quoted, so one call returns what the pages say.
 */
import { http } from '../net/http';
import { bestPassages, quotePassages, terms, type Passage } from './passages';
import type { ToolContext, ToolDef } from './types';
import { isoDay, linkLines, linksIn, readPage, type Page } from './webpage';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** YYYY-MM-DD when the engine shows one. */
  date?: string;
}

export type Recency = 'day' | 'week' | 'month' | 'year';

export interface WebSearchInput {
  query: string;
  allowed?: string[];
  blocked?: string[];
  limit?: number;
  /** How many of the top results to open and quote (0 for links only). */
  read?: number;
  recency?: Recency;
}

// ── result pages ────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', middot: '·' };

function decode(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\ufffd/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The real address behind a DuckDuckGo result link (they point at a redirect with the target in `uddg`). */
function ddgTarget(href: string): string {
  const raw = decode(href);
  const m = /[?&]uddg=([^&]+)/.exec(raw);
  if (m) return decodeURIComponent(m[1]);
  return raw.startsWith('//') ? `https:${raw}` : raw;
}

const ddgAd = (url: string) => /duckduckgo\.com\/y\.js|[?&]ad_domain=/.test(url);

/** Results from DuckDuckGo's HTML page, ads left out. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of html.split(/<div class="result[ "]/).slice(1)) {
    if (/^[^>]*result--ad/.test(block)) continue;
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block) ?? /href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = ddgTarget(link[1]);
    if (!/^https?:\/\//.test(url) || ddgAd(url)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block);
    out.push({ title: decode(link[2]), url, snippet: snippet ? decode(snippet[1]) : '' });
  }
  return out;
}

/** Results from DuckDuckGo's lite page (rows of a table). */
export function parseDuckDuckGoLite(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const parts = html.split(/(?=<a[^>]+class=['"]result-link['"])/).slice(1);
  for (const part of parts) {
    const link = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(part);
    if (!link || /result-sponsored/.test(part.slice(0, 400))) continue;
    const url = ddgTarget(link[1]);
    if (!/^https?:\/\//.test(url) || ddgAd(url)) continue;
    const snippet = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(part);
    out.push({ title: decode(link[2]), url, snippet: snippet ? decode(snippet[1]) : '' });
  }
  return out;
}

/** The real address behind a Bing result link (a redirect with the target base64-encoded after `u=a1`). */
function bingTarget(href: string): string {
  const raw = decode(href);
  const m = /[?&]u=a1([^&]+)/.exec(raw);
  if (m) {
    try {
      const url = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^https?:\/\//.test(url)) return url;
    } catch {
      /* the link as it is */
    }
  }
  return raw;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** A date at the start of a snippet ("Mar 2, 2026 · …", "2026年3月2日 — …"), taken off it. */
function leadingDate(snippet: string): { date?: string; rest: string } {
  let m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s*[·—-]\s*/.exec(snippet);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) return { date: isoDay(Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2])), rest: snippet.slice(m[0].length) };
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*[·—-]?\s*/.exec(snippet);
  if (m) return { date: isoDay(Date.UTC(+m[1], +m[2] - 1, +m[3])), rest: snippet.slice(m[0].length) };
  return { rest: snippet };
}

/** Results from Bing's page, ads and answer boxes left out. */
export function parseBing(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const h2 = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!h2) continue;
    const url = bingTarget(h2[1]);
    if (!/^https?:\/\//.test(url) || /^https?:\/\/(www\.)?bing\.com\//.test(url)) continue;
    const p = /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block) ?? /<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const { date, rest } = leadingDate(p ? decode(p[1]) : '');
    out.push({ title: decode(h2[2]), url, snippet: rest, ...(date ? { date } : {}) });
  }
  return out;
}

// ── engines ─────────────────────────────────────────────────────────────────

interface EngineQuery {
  query: string;
  recency?: Recency;
  /** The query is in Chinese, Japanese or Korean: ask for results in that market. */
  lang?: Lang;
  /** The sites the results must come from, as the engine's own filter. */
  sites?: string[];
  signal: AbortSignal;
  proxy: string | false;
}

interface Engine {
  label: string;
  run(q: EngineQuery): Promise<SearchResult[]>;
}

class EngineError extends Error {
  constructor(
    message: string,
    readonly refused = false,
  ) {
    super(message);
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const refusal = (html: string) => /anomaly-modal|captcha|unusual traffic|are you a robot|verify you are (a )?human|challenge-form/i.test(html.slice(0, 100_000)) && html.length < 150_000;

async function resultPage(url: string, q: EngineQuery): Promise<string> {
  const res = await http(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': q.lang ? MARKETS[q.lang].accept : 'en-US,en;q=0.9' },
    signal: AbortSignal.any([q.signal, AbortSignal.timeout(12_000)]),
    proxy: q.proxy,
  });
  const html = await res.text();
  if (!res.ok) throw new EngineError(`answered ${res.status}`, res.status === 429 || refusal(html));
  if (refusal(html)) throw new EngineError('asked for a captcha', true);
  return html;
}

type Lang = 'zh' | 'ja' | 'ko';

/** Each language's market on the engines and the language a browser there would ask pages for. */
const MARKETS: Record<Lang, { ddg: string; bing: string; searxng: string; accept: string }> = {
  zh: { ddg: 'cn-zh', bing: 'setlang=zh-Hans&mkt=zh-CN', searxng: 'zh-CN', accept: 'zh-CN,zh;q=0.9,en;q=0.6' },
  ja: { ddg: 'jp-jp', bing: 'setlang=ja&mkt=ja-JP', searxng: 'ja', accept: 'ja,en;q=0.6' },
  ko: { ddg: 'kr-kr', bing: 'setlang=ko&mkt=ko-KR', searxng: 'ko', accept: 'ko,en;q=0.6' },
};

/** The query's language when it is Chinese, Japanese or Korean: kana mean Japanese even among Chinese characters. */
export function queryLang(query: string): Lang | undefined {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query)) return 'ja';
  if (/\p{Script=Hangul}/u.test(query)) return 'ko';
  if (/\p{Script=Han}/u.test(query)) return 'zh';
  return undefined;
}

/** The query with the engine's own site filter: one site, or several joined with OR (Bing and Brave read both). */
const withSite = (q: EngineQuery) => {
  const s = q.sites ?? [];
  return s.length === 1 ? `${q.query} site:${s[0]}` : s.length ? `${q.query} (${s.map((d) => `site:${d}`).join(' OR ')})` : q.query;
};

const duckduckgo: Engine = {
  label: 'DuckDuckGo',
  async run(q) {
    // DuckDuckGo answers a site: filter with its captcha (2026-11-08, both pages, every try): the sites go in as
    // words, which brings their pages up, and the results are filtered to them afterwards.
    const query = q.sites?.length ? `${q.query} ${q.sites.join(' ')}` : q.query;
    const params = `q=${encodeURIComponent(query)}&kl=${q.lang ? MARKETS[q.lang].ddg : 'wt-wt'}${q.recency ? `&df=${q.recency[0]}` : ''}`;
    try {
      return parseDuckDuckGo(await resultPage(`https://html.duckduckgo.com/html/?${params}`, q));
    } catch (e) {
      if (!(e instanceof EngineError) || !e.refused) throw e;
      // The HTML page sometimes wants a captcha while the lite one still answers.
      return parseDuckDuckGoLite(await resultPage(`https://lite.duckduckgo.com/lite/?${params}`, q));
    }
  },
};

function bingRecency(r: Recency): string {
  if (r === 'day') return 'ex1:"ez1"';
  if (r === 'week') return 'ex1:"ez2"';
  if (r === 'month') return 'ex1:"ez3"';
  const today = Math.floor(Date.now() / 86_400_000);
  return `ex1:"ez5_${today - 365}_${today}"`;
}

const bing: Engine = {
  label: 'Bing',
  async run(q) {
    const market = q.lang ? MARKETS[q.lang].bing : 'setlang=en-US&mkt=en-US';
    const filter = q.recency ? `&filters=${encodeURIComponent(bingRecency(q.recency))}` : '';
    return parseBing(await resultPage(`https://www.bing.com/search?q=${encodeURIComponent(withSite(q))}&${market}${filter}`, q));
  },
};

function brave(key: string): Engine {
  return {
    label: 'Brave',
    async run(q) {
      const res = await http(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(withSite(q))}&count=20${q.recency ? `&freshness=p${q.recency[0]}` : ''}`, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
        signal: AbortSignal.any([q.signal, AbortSignal.timeout(12_000)]),
        proxy: q.proxy,
      });
      if (!res.ok) throw new EngineError(`answered ${res.status}`, res.status === 429);
      const d = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string; page_age?: string }[] } };
      return (d.web?.results ?? []).map((r) => ({ title: decode(r.title), url: r.url, snippet: decode(r.description ?? ''), ...(isoDay(r.page_age) ? { date: isoDay(r.page_age) } : {}) }));
    },
  };
}

function searxng(base: string): Engine {
  return {
    label: 'SearXNG',
    async run(q) {
      const url = `${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(withSite(q))}&format=json${q.recency ? `&time_range=${q.recency}` : ''}${q.lang ? `&language=${MARKETS[q.lang].searxng}` : ''}`;
      const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(base);
      const res = await http(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.any([q.signal, AbortSignal.timeout(15_000)]), proxy: local ? false : q.proxy });
      if (!res.ok) throw new EngineError(`answered ${res.status}`);
      const d = (await res.json()) as { results?: { title: string; url: string; content?: string; publishedDate?: string }[] };
      return (d.results ?? []).map((r) => ({ title: decode(r.title ?? ''), url: r.url, snippet: decode(r.content ?? ''), ...(isoDay(r.publishedDate) ? { date: isoDay(r.publishedDate) } : {}) }));
    },
  };
}

/** The engines this configuration asks: the keyless pair, plus Brave and SearXNG when set up. */
export function enginesFor(search: { engines?: string[]; braveKey?: string; searxng?: string } | undefined): Engine[] {
  const braveKey = search?.braveKey || process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
  const searxUrl = search?.searxng || process.env.SEARXNG_URL;
  const all: Record<string, Engine | undefined> = { duckduckgo, bing, brave: braveKey ? brave(braveKey) : undefined, searxng: searxUrl ? searxng(searxUrl) : undefined };
  const names = search?.engines?.length ? search.engines : ['duckduckgo', 'bing', 'brave', 'searxng'];
  const out = names.map((n) => all[n.toLowerCase()]).filter((e): e is Engine => !!e);
  return out.length ? out : [duckduckgo, bing];
}

// ── merging and ranking ─────────────────────────────────────────────────────

/** Copies of other sites' pages (mostly Stack Overflow and CSDN threads, often machine-translated): left out. */
export const COPY_SITES = [
  'qastack.com', 'qastack.ru', 'qastack.com.br', 'qastack.mx', 'qastack.cn', 'qastack.jp', 'qastack.fr', 'qastack.it', 'qastack.kr', 'qastack.vn', 'qastack.id', 'qastack.in.th', 'qastack.info.tr', 'qastack.com.de', 'qastack.com.ua',
  'it-swarm.com', 'it-swarm.dev', 'it-swarm.net', 'it-swarm.xyz', 'it-swarm.asia', 'it-swarm-fr.com', 'it-swarm-es.com', 'it-swarm.com.de', 'it-swarm-ja.tech', 'it-swarm-vi.com',
  'stackovernet.com', 'stackovernet.xyz', 'stackoom.com', 'exchangetuts.com', 'itcodar.com', 'newbedev.com', 'solveforum.com', 'answerbun.com', 'devcodetutorial.com', 'codeleading.com',
  'programmerall.com', 'titanwolf.org', 'quabr.com', 'py4u.net', 'py4u.org', 'pythonfixing.com', 'javaer101.com', 'stackguides.com', 'coder.social', 'programmersought.com', 'pianshen.com',
  'icode9.com', 'codenong.com',
];

/** Sites that rarely hold the answer for a model (paywalls, pins, short snippets): kept, ranked lower. */
const WEAK_SITES = ['pinterest.com', 'quora.com', 'codegrepper.com', 'tutorialspoint.com', 'javatpoint.com', 'linkedin.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'slideshare.net', 'scribd.com', 'coursehero.com', 'chegg.com', 'brainly.com', 'runebook.dev'];

/** A site's front page or a section's (a language root, /docs/): it rarely answers a question by itself. */
function frontPage(url: string): boolean {
  try {
    return /^\/((?:[a-z]{2}(?:[-_][a-z]{2,4})?|docs?|documentation|home|index\.\w+|download|downloads)\/?)?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Primary sources: ranked a little higher. */
const PRIMARY_SITES = [
  'github.com', 'stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'askubuntu.com', 'developer.mozilla.org', 'python.org', 'pkg.go.dev', 'go.dev', 'docs.rs', 'rust-lang.org',
  'nodejs.org', 'npmjs.com', 'pypi.org', 'learn.microsoft.com', 'wikipedia.org', 'arxiv.org', 'readthedocs.io', 'man7.org', 'kernel.org', 'w3.org', 'whatwg.org', 'ietf.org', 'rfc-editor.org',
  'postgresql.org', 'sqlite.org', 'gnu.org', 'developer.apple.com', 'developer.android.com', 'web.dev', 'chromium.org', 'typescriptlang.org',
];

/** Hosts that serve many owners' sites: each subdomain is a site of its own. */
const SHARED_HOSTS = ['github.io', 'gitlab.io', 'readthedocs.io', 'vercel.app', 'netlify.app', 'pages.dev', 'blogspot.com', 'substack.com', 'medium.com', 'wordpress.com', 'hashnode.dev', 'notion.site'];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const hostIs = (host: string, domain: string) => {
  const d = domain.toLowerCase().replace(/^\*?\.|^https?:\/\//g, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return host === d || host.endsWith(`.${d}`);
};

/** The site a host belongs to, for the per-site cap: the registrable name, or the subdomain on shared hosts. */
function siteOf(host: string): string {
  if (SHARED_HOSTS.some((s) => host.endsWith(`.${s}`))) return host;
  const labels = host.split('.');
  const take = labels.length >= 3 && /^(co|com|org|net|ac|gov|edu)$/.test(labels.at(-2)!) && labels.at(-1)!.length === 2 ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** One key for copies of the same page: no www/m., no tracking parameters, no index.html or trailing slash. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|amp)\./, '');
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_\w+|ref|ref_src|ref_url|fbclid|gclid|msclkid|yclid|spm|from|source|share|si|igshid|mc_cid|mc_eid|_ga|scid|trk)$/i.test(k)) u.searchParams.delete(k);
    }
    const path = u.pathname.replace(/\/(index\.(html?|php))?$/i, '').replace(/\/amp$/i, '') || '/';
    const search = u.searchParams.toString();
    return `${host}${path}${search ? `?${search}` : ''}`.toLowerCase();
  } catch {
    return url;
  }
}

/** An address of one version's docs: a version subdomain, a /3.x/ or /v2/ folder, a site named for a version (vite3-cn). */
const OLD_DOCS = /^https?:\/\/v\d+(?:[-.]\d+)*\.|\/v?\d+(?:\.\d+)*\.x\/|\/v\d+(?:\.\d+)?\/|\/\/[a-z]+\d+-(?:cn|zh|docs)\./i;

/** A query that asks for the current state of something. */
const FRESH = /\b(?:latest|newest|current|currently|recent|recently|today|this (?:week|month|year)|now|new release|just released)\b|最新|最近|目前|现在|今年|本月|本周|刚发布|新版/i;

/** Engine result lists, kept half an hour: the same search again (after a compaction, by a sub-agent) is free. */
const ENGINE_CACHE = new Map<string, { at: number; results: SearchResult[] }>();
const ENGINE_CACHE_MS = 30 * 60_000;

const QUERY_STOP = new Set('the and for with how what why when does not from into your you can use using get set make best way vs'.split(' '));

export interface Ranked extends SearchResult {
  key: string;
  score: number;
  engines: string[];
}

/**
 * One list from several engines' lists: reciprocal-rank merging (a page several engines rank well comes first),
 * copies folded, copy sites and blocked sites left out, primary sources and the query's own project site moved
 * up, at most three results from one site. With `allowed`, only those sites' results, and no cap: a search
 * kept to one site wants that site's pages, and the cap had left three of them.
 */
export function rankResults(lists: { engine: string; results: SearchResult[] }[], query: string, prefs: { blocked?: string[]; preferred?: string[]; allowed?: string[] } = {}): { results: Ranked[]; dropped: string[] } {
  const by = new Map<string, Ranked>();
  for (const { engine, results } of lists) {
    results.forEach((r, i) => {
      if (!/^https?:\/\//.test(r.url)) return;
      const key = canonicalUrl(r.url);
      const credit = 1 / (6 + i);
      const e = by.get(key);
      if (!e) {
        by.set(key, { ...r, key, score: credit, engines: [engine] });
        return;
      }
      e.score += credit;
      if (!e.engines.includes(engine)) e.engines.push(engine);
      if (r.snippet.length > e.snippet.length) e.snippet = r.snippet;
      e.date ??= r.date;
      if (!e.title) e.title = r.title;
    });
  }
  const specific = terms(query).length >= 3;
  const fresh = FRESH.test(query) || query.includes(String(new Date().getFullYear()));
  const words = [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]{2,}/g) ?? []).filter((w) => !QUERY_STOP.has(w)))];
  const dropped: string[] = [];
  const kept: Ranked[] = [];
  for (const r of by.values()) {
    const host = hostOf(r.url);
    if (prefs.allowed?.length && !prefs.allowed.some((d) => hostIs(host, d))) continue;
    if (COPY_SITES.some((d) => hostIs(host, d)) || prefs.blocked?.some((d) => hostIs(host, d))) {
      dropped.push(host);
      continue;
    }
    let prior = 1;
    if (prefs.preferred?.some((d) => hostIs(host, d))) prior *= 1.6;
    const front = frontPage(r.url);
    // A question asks for a page about it, not a front page that only names the project.
    if (front && specific) prior *= 0.45;
    // The query names the project and this is a page of its own site: vitest -> vitest.dev/guide/...
    const labels = host.split('.').slice(0, -1);
    if (!front && words.some((w) => labels.includes(w) || (w.length >= 5 && labels.some((l) => l.startsWith(w))))) prior *= 1.3;
    else if (host === 'github.com' && words.some((w) => r.url.toLowerCase().split('/').slice(3, 5).some((seg) => seg === w || seg.startsWith(`${w}-`) || seg.endsWith(`-${w}`)))) prior *= 1.3;
    if (PRIMARY_SITES.some((d) => hostIs(host, d))) prior *= 1.25;
    if (/^(docs?|developer|learn|api)\./.test(host) || /\/(docs?|guide|reference|api|manual|handbook)(\/|$)/i.test(r.url.replace(/^https?:\/\/[^/]+/, ''))) prior *= 1.15;
    if (WEAK_SITES.some((d) => hostIs(host, d))) prior *= 0.6;
    // A result whose title, snippet and address hold under a third of the query's words seldom answers it (all the
    // off-topic results in the 2026-11-02 sample did): lower, not gone, since a terse page can still be the one.
    if (words.length >= 3) {
      const seen = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
      if (words.filter((w) => seen.includes(w)).length / words.length < 1 / 3) prior *= 0.5;
    }
    // Two years old by its own date: lower. A query that asks for the current state (latest, 最新, this year's
    // number) wants this year's pages: a year old is lower still, the last half-year higher.
    const when = r.date ? Date.parse(r.date) : NaN;
    if (Number.isFinite(when)) {
      const age = Date.now() - when;
      if (age > 2 * 365 * 86_400_000) prior *= 0.8;
      if (fresh && age > 365 * 86_400_000) prior *= 0.6;
      else if (fresh && age < 183 * 86_400_000) prior *= 1.2;
    }
    r.score *= prior;
    kept.push(r);
  }
  // Docs of an older version (v3.vitejs.dev, /3.x/, /v2/) when the same site's unversioned docs are in the list too:
  // the old ones ranked second and were quoted in the sample.
  const unversioned = new Set(kept.filter((r) => !OLD_DOCS.test(r.url)).map((r) => siteOf(hostOf(r.url))));
  for (const r of kept) if (OLD_DOCS.test(r.url) && unversioned.has(siteOf(hostOf(r.url)))) r.score *= 0.6;
  kept.sort((a, b) => b.score - a.score);
  if (prefs.allowed?.length) return { results: kept, dropped };
  const perSite = new Map<string, number>();
  const results = kept.filter((r) => {
    const site = siteOf(hostOf(r.url));
    const n = (perSite.get(site) ?? 0) + 1;
    perSite.set(site, n);
    return n <= 3;
  });
  return { results, dropped };
}

// ── the tool ────────────────────────────────────────────────────────────────

interface ReadResult {
  passages: Passage[];
  /** The passages as the result quotes them, with where each starts and where its links go. */
  quoted: string;
  title?: string;
  date?: string;
}

/** Why an opened result is not quoted, said with it so the model knows whether web_fetch would do better. */
type Unread = 'late' | 'failed' | 'scripted' | 'silent';

const UNREAD: Record<Unread, string> = {
  late: 'Not read: the page did not answer in time; web_fetch reads it.',
  failed: 'Not read: the page could not be opened.',
  scripted: 'Not read: the page builds its content with JavaScript; web_fetch reads it through the browser.',
  silent: 'Read: it says nothing on the query.',
};

/** Passages as a search result quotes them: under their heading with where each starts, and the links in each. */
function quoteRead(page: Page, passages: Passage[], query: string): string {
  return passages
    .map((p) => `${p.heading ? `   § ${p.heading} (start ${p.start})\n` : `   (start ${p.start})\n`}${quotePassages([{ ...p, heading: undefined }], '   ')}${linkLines(linksIn(page, p.start, p.start + p.text.length, query, 3), '   ')}`)
    .join('\n   …\n');
}

/** What a search result quotes from its page on the query; empty when the page says nothing on it. */
export function searchQuote(page: Page, query: string): string {
  return quoteRead(page, bestPassages(page.markdown, query, { max: 3, maxChars: 1400, minCover: terms(query).length >= 3 ? 0.34 : 0 }), query);
}

/**
 * Open the top results (a few more than asked, in case some fail or say nothing on the query) and quote what
 * they say on it. Then the order follows what the pages hold: pages that answer first, pages that were read
 * and do not answer last, pages that could not be read where they were; the first two results keep their
 * places while their pages are still on the way.
 */
async function readTop(results: Ranked[], query: string, want: number, ctx: ToolContext): Promise<{ order: Ranked[]; reads: Map<string, ReadResult>; unread: Map<string, Unread> }> {
  const reads = new Map<string, ReadResult>();
  const unread = new Map<string, Unread>();
  if (want <= 0) return { order: results, reads, unread };
  const candidates = results.slice(0, want + 3);
  // A page that holds under a third of the query's terms in any one passage does not answer it.
  const minCover = terms(query).length >= 3 ? 0.34 : 0;
  // Pages answer in their own time. Once enough have answered, or a moment after the first did, the search goes on
  // without the slow ones (measured 2026-11-02: a median 1.15 s saved, up to 4.4 s on Chinese queries); a late page
  // still lands in the page cache for web_fetch. The engines' first two picks are worth one more moment.
  const arrived: { r: Ranked; read: ReadResult | null; why?: Unread }[] = [];
  await new Promise<void>((resolve, reject) => {
    let left = candidates.length;
    let grace: NodeJS.Timeout | undefined;
    let extended = false;
    const finish = () => {
      if (grace) clearTimeout(grace);
      resolve();
    };
    const graceOver = () => {
      const topPending = candidates.slice(0, 2).some((r) => !arrived.some((o) => o.r === r));
      if (topPending && !extended) {
        extended = true;
        grace = setTimeout(finish, 1500);
        return;
      }
      finish();
    };
    if (!left) return finish();
    for (const r of candidates) {
      // No browser and a short wait: a search stays quick; web_fetch reads pages that need more.
      readPage(r.url, { signal: ctx.signal, proxy: ctx.proxy, timeoutMs: 7000 })
        .then((page) => {
          const passages = bestPassages(page.markdown, query, { max: 3, maxChars: 1400, minCover });
          if (passages.length) arrived.push({ r, read: { passages, quoted: quoteRead(page, passages, query), title: page.title, date: page.updated ?? page.published } });
          else arrived.push({ r, read: null, why: page.partial ? 'scripted' : 'silent' });
        })
        .catch(() => arrived.push({ r, read: null, why: 'failed' }))
        .finally(() => {
          if (ctx.signal.aborted) return reject(new Error('stopped'));
          left--;
          const answered = arrived.filter((o) => o.read).length;
          if (!left || answered >= want) return finish();
          if (answered && !grace) grace = setTimeout(graceOver, 1500);
        });
    }
  });
  // In the ranking's order, as they stood when the search went on.
  for (const r of candidates) {
    const o = arrived.find((a) => a.r === r);
    if (o?.read && reads.size < want) reads.set(r.key, o.read);
    else if (o?.why) unread.set(r.key, o.why);
    else if (!o) unread.set(r.key, 'late');
  }
  const silent = (r: Ranked) => unread.get(r.key) === 'silent';
  const answering = results.filter((r) => reads.has(r.key));
  const rest = results.filter((r) => !reads.has(r.key) && !silent(r));
  const order = [...answering, ...rest, ...results.filter(silent)];
  // A top result whose page was still on the way is not worse for being slow.
  for (const [i, r] of results.slice(0, 2).entries()) {
    if (unread.get(r.key) !== 'late') continue;
    order.splice(order.indexOf(r), 1);
    order.splice(i, 0, r);
  }
  return { order, reads, unread };
}

export const webSearchTool: ToolDef<WebSearchInput> = {
  kind: 'web',
  readOnly: true,
  title: (i) => `Search the web for "${i.query}"`,
  async execute(input, ctx) {
    const query = input.query.trim();
    if (!query) return { content: 'Give a search query.', isError: true };
    const engines = enginesFor(ctx.config.search);
    const allowed = (input.allowed ?? []).map((d) => d.trim()).filter(Boolean);
    const q: EngineQuery = { query, recency: input.recency, lang: queryLang(query), sites: allowed.length ? allowed : undefined, signal: ctx.signal, proxy: ctx.proxy };
    const answers = await Promise.all(
      engines.map(async (e) => {
        try {
          // Searches limited to the last day or week stay live.
          const key = `${e.label}\n${query}\n${q.recency ?? ''}\n${allowed.join(' ')}`;
          const hit = ENGINE_CACHE.get(key);
          if (hit && Date.now() - hit.at < ENGINE_CACHE_MS && q.recency !== 'day' && q.recency !== 'week') return { engine: e.label, results: hit.results };
          const results = await e.run(q);
          if (results.length) ENGINE_CACHE.set(key, { at: Date.now(), results });
          return { engine: e.label, results };
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          return { engine: e.label, results: [] as SearchResult[], failed: (err as Error).message };
        }
      }),
    );
    const answered = answers.filter((a) => !a.failed);
    const failed = answers.filter((a) => a.failed).map((a) => `${a.engine} ${a.failed}`);
    if (!answered.length) {
      return { content: `Search failed: ${failed.join('; ')}. Try again in a minute, or fetch a page you know directly.`, isError: true };
    }
    let { results, dropped } = rankResults(answered, query, { blocked: [...(input.blocked ?? []), ...(ctx.config.search?.blocked ?? [])], preferred: ctx.config.search?.preferred, allowed });
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 15);
    const want = Math.min(Math.max(input.read ?? 3, 0), 5);
    const opened = await readTop(results.slice(0, limit + 3), query, want, ctx);
    const reads = opened.reads;
    results = opened.order.slice(0, limit);
    const sources = answered.map((a) => a.engine);
    const display = {
      kind: 'links' as const,
      query,
      engines: sources,
      dropped: dropped.length,
      results: results.map((r) => {
        const read = reads.get(r.key);
        return { title: read?.title || r.title, url: r.url, snippet: r.snippet, ...(r.date || read?.date ? { date: r.date ?? read?.date } : {}), ...(read ? { quote: read.passages.map((p) => p.text).join('\n…\n') } : {}) };
      }),
    };
    const about = [sources.join(' and '), dropped.length ? `${dropped.length} copy-site result${dropped.length === 1 ? '' : 's'} left out` : '', failed.length ? `${failed.join('; ')}` : ''].filter(Boolean).join('; ');
    if (!results.length) return { content: `No results for "${query}" (${about}). Try other words or fewer filters.`, display };
    const lines = results.map((r, i) => {
      const read = reads.get(r.key);
      const date = r.date ?? read?.date;
      const head = `${i + 1}. ${read?.title || r.title}${date ? ` (${date})` : ''}\n   ${r.url}`;
      if (read) return `${head}\n   From the page:\n${read.quoted}`;
      const why = opened.unread.get(r.key);
      return `${head}${r.snippet ? `\n   ${r.snippet}` : ''}${why ? `\n   (${UNREAD[why]})` : ''}`;
    });
    const tail = reads.size
      ? 'Quoted parts are from the pages as they are now; web_fetch with start reads around a part.'
      : want
        ? 'None of the top pages could be opened in time or said anything on the query: snippets only. web_fetch the most promising result before relying on it.'
        : 'Snippets can be stale or partial: read the most relevant page before relying on it.';
    return { content: `Results for "${query}" (${about}):\n\n${lines.join('\n\n')}\n\n${tail}`, display };
  },
};
