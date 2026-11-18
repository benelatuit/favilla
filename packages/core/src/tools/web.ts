import { bestPassages, quotePassages } from './passages';
import type { ToolDef } from './types';
import { linkLines, linksIn, outline, type Page, PageError, pageHeader, pageText, readPage } from './webpage';

export interface WebFetchInput {
  url: string;
  prompt?: string;
  /** Character offset to read from: the later part of a long page, or a section its outline points to. */
  start?: number;
}

const EXTRACT_CHARS = 16_000;
const PAGE_CHARS = 16_000;

/** The passages of a long page that match `prompt`, each with where it starts and where its links go. */
export function fetchQuote(page: Page, prompt: string, maxChars = 8000, max = 8): string {
  return bestPassages(page.markdown, prompt, { max, maxChars })
    .map((p) => `[start ${p.start}]\n${quotePassages([p])}${linkLines(linksIn(page, p.start, p.start + p.text.length, prompt, 4))}`)
    .join('\n\n');
}

/** A long page's size and sections, under an answer drawn from parts of it: where web_fetch with start reads on. */
function sections(page: Page): string {
  const md = page.markdown;
  if (md.length <= EXTRACT_CHARS) return '';
  let heads = outline(md);
  if (heads.length > 15) heads = heads.filter((h) => h.level <= 2);
  const list = heads.slice(0, 15).map((h) => `  ${h.start}  ${'#'.repeat(h.level)} ${h.title}`);
  return `\n\n[The answer is drawn from the parts of the page's ${md.length} characters that match. web_fetch with start reads the page itself${list.length ? `; its sections:\n${list.join('\n')}${heads.length > 15 ? `\n  … ${heads.length - 15} more` : ''}` : ''}.]`;
}

export { webFetchTool } from './web-tools';
export const execute: ToolDef<WebFetchInput>['execute'] = async (input, ctx) => {
  let page;
  try {
    page = await readPage(input.url, { signal: ctx.signal, proxy: ctx.proxy, browser: ctx.browser });
  } catch (e) {
    const status = e instanceof PageError ? e.status : 0;
    return { content: (e as Error).message, isError: true, ...(status ? { display: { kind: 'web' as const, url: input.url, status, bytes: (e as PageError).bytes } } : {}) };
  }
  const display = { kind: 'web' as const, url: page.url, status: page.status, bytes: page.bytes, title: page.title, via: page.via, chars: page.markdown.length, date: page.updated ?? page.published };
  if (input.prompt && !input.start) {
    if (ctx.extract && page.markdown.length > 2000) {
      try {
        // The side model reads the passages that match, not the whole page: 61% less of its input on the
        // fetches recorded in eval sessions (2026-11-02), and each such read is a request of its own. Their
        // links go with them, so an answer can say where to read on.
        const found = page.markdown.length > EXTRACT_CHARS ? fetchQuote(page, input.prompt, EXTRACT_CHARS, 12) : '';
        const answer = await ctx.extract(input.prompt, found || page.markdown.slice(0, EXTRACT_CHARS));
        return { content: `${pageHeader(page)}\n\nOn "${input.prompt}":\n${answer}${sections(page)}`, display };
      } catch {
        /* the matching passages below */
      }
    }
    // A long page and no side model: the passages that match, each with where to read around it.
    if (page.markdown.length > ctx.outputChars) {
      const quoted = fetchQuote(page, input.prompt, Math.min(ctx.outputChars, 8000));
      if (quoted) {
        return { content: `${pageHeader(page)}\n\nThe parts of the page that match "${input.prompt}":\n\n${quoted}\n\n[The page has ${page.markdown.length} characters; fetch with start to read around a part.]`, display };
      }
    }
  }
  // Without a question, a page comes in parts of about 16k characters; its outline and start reach the rest.
  return { content: pageText(page, { start: input.start, maxChars: Math.min(ctx.outputChars, PAGE_CHARS) }).text, display };
};
