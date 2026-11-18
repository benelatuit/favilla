import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { fileInCode, fileInLink, fileName, filesInText, localTarget, type FileRef } from './fileRefs';

// Phosphor's copy and check glyphs, inlined because this HTML is built outside React.
const COPY_ICON =
  '<svg class="i-copy" viewBox="0 0 256 256" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>' +
  '<svg class="i-check" viewBox="0 0 256 256" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z"/></svg>';

// Phosphor's file-code glyph, for a file an answer names.
const FILE_ICON =
  '<svg class="file-ref-icon" viewBox="0 0 256 256" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M181.66,146.34a8,8,0,0,1,0,11.32l-24,24a8,8,0,0,1-11.32-11.32L164.69,152l-18.35-18.34a8,8,0,0,1,11.32-11.32Zm-72-24a8,8,0,0,0-11.32,0l-24,24a8,8,0,0,0,0,11.32l24,24a8,8,0,0,0,11.32-11.32L91.31,152l18.35-18.34A8,8,0,0,0,109.66,122.34ZM216,88V216a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88Zm-56-8h28.69L160,51.31Zm40,136V96H152a8,8,0,0,1-8-8V40H56V216H200Z"/></svg>';

const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const md = new MarkdownIt({
  html: false,
  linkify: true,
  // A line break the model wrote is kept: answers that put each point on a line of its own, without a blank line
  // between, ran together into one block of text (2026-11-07).
  breaks: true,
  highlight(code: string, lang: string): string {
    try {
      const value = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : escapeHtml(code);
      return `<pre class="code"><div class="code-head"><span class="code-lang">${escapeHtml(lang || 'text')}</span><button type="button" class="code-copy" data-copy-code data-tip="Copy" aria-label="Copy">${COPY_ICON}</button></div><code class="hljs">${value}</code></pre>`;
    } catch {
      return '';
    }
  },
});

type Rule = (tokens: any[], idx: number, options: any, env: any, self: any) => string;

// A mermaid fence becomes a diagram once the page draws it (lib/mermaid.ts); until then it shows its source.
const defaultFence = md.renderer.rules.fence as Rule;
md.renderer.rules.fence = ((tokens, idx, options, env, self) => {
  const t = tokens[idx];
  if (t.info.trim().split(/\s+/)[0] !== 'mermaid') return defaultFence(tokens, idx, options, env, self);
  return `<div class="mermaid-block" data-mermaid-src="${escapeHtml(t.content)}"><pre class="code"><code>${escapeHtml(t.content)}</code></pre></div>`;
}) as Rule;
const defaultLink: Rule = (md.renderer.rules.link_open as Rule | undefined) ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = ((tokens, idx, options, env, self) => {
  // A file on this computer is opened by the page (FileView's clicks), not by the browser: its address leads nowhere.
  if (tokens[idx].attrGet('data-local') !== null) tokens[idx].attrSet('href', '#');
  else {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLink(tokens, idx, options, env, self);
}) as Rule;

// A picture shown by its path on this computer (![icon](design/icon.png), C:\…\shot.png, file:///…) is read
// through the server, which resolves a relative path in the session's project; the page itself cannot load it.
const defaultValidate = md.validateLink.bind(md);
md.validateLink = (url: string) => /^file:/i.test(url.trim()) || defaultValidate(url);
const defaultImage = md.renderer.rules.image as Rule;
/**
 * Where the page loads a picture an answer names: one on the web or in the blob store as it is; one on this
 * computer (a path, a file URL, a pic: name) through the server, in the project of `session`.
 *
 * `stamp` names the message that shows it. A page keeps one loaded picture per address and gives it to every later
 * use of that address without asking the server, so two answers showing the same path both got what the first one
 * loaded: an answer that came after the file was drawn again showed the old drawing under its new caption
 * (2026-11-17). With the message in the address each answer loads the file as it is when that answer appears. A pic:
 * name is its content and needs none.
 */
export function pictureSrc(src: string, session?: string, stamp?: string): string {
  if (!src || /^(?:https?:|data:|blob:)/i.test(src) || src.startsWith('/api/')) return src;
  let p = src;
  try {
    p = decodeURI(src);
  } catch {
    /* keep it as written */
  }
  const of = stamp && !/^pic:/i.test(p) ? `&of=${encodeURIComponent(stamp)}` : '';
  return `/api/image?path=${encodeURIComponent(p)}${session ? `&session=${encodeURIComponent(session)}` : ''}${of}`;
}

md.renderer.rules.image = ((tokens, idx, options, env, self) => {
  const t = tokens[idx];
  t.attrSet('src', pictureSrc(t.attrGet('src') ?? '', env?.session, env?.stamp));
  t.attrSet('loading', 'lazy');
  // Words in the title that size or place the picture are no tooltip.
  const words: string[] = String(t.attrGet('title') ?? '').split(/\s+/).filter(Boolean);
  const size = words.includes('wide') ? ' is-wide' : words.includes('small') ? ' is-small' : '';
  const rest = words.filter((w) => !LAYOUT_WORDS.has(w)).join(' ');
  if (rest) t.attrSet('title', rest);
  else t.attrs = ((t.attrs ?? []) as [string, string][]).filter(([k]) => k !== 'title');
  const img = defaultImage(tokens, idx, options, env, self);
  const caption = escapeHtml(self.renderInlineAsText(t.children ?? [], options, env));
  const figure = (t.meta as { figure?: string } | null)?.figure;
  const side = figure === 'side' || (figure === 'block' && words.includes('side')) ? ' is-side' : '';
  if (figure === 'block' && !side) return `<figure class="md-figure${size}">${img}${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
  if (side) return `<span class="md-figure${side}${size}">${img}${caption ? `<span class="md-caption">${caption}</span>` : ''}</span>`;
  if (figure === 'cell') return `<span class="md-figure is-cell">${img}</span>`;
  return img;
}) as Rule;

const LAYOUT_WORDS = new Set(['wide', 'small', 'side']);

/**
 * Pictures are laid out by where they stand, as a page sets its illustrations: alone in a paragraph, a figure with
 * its words under it (two or three in one paragraph side by side, for a before and an after); in a paragraph of text,
 * a small figure at its start beside the text, which wraps around it; in a table cell, a thumbnail. Each is shown at
 * its own size or less. A picture inside a link stays as it was written.
 */
md.core.ruler.push('figures', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const kids = tokens[i].type === 'inline' ? tokens[i].children : null;
    if (!kids?.some((c) => c.type === 'image')) continue;
    let depth = 0;
    let linked = false;
    for (const c of kids) {
      if (c.type === 'link_open') depth++;
      else if (c.type === 'link_close') depth--;
      else if (c.type === 'image' && depth > 0) linked = true;
    }
    if (linked) continue;
    const open = tokens[i - 1];
    const close = tokens[i + 1];
    const images = kids.filter((c) => c.type === 'image');
    const mark = (figure: string) => images.forEach((c) => (c.meta = { ...(c.meta ?? {}), figure }));
    if (open?.type !== 'paragraph_open') {
      mark('cell');
      continue;
    }
    if (kids.every((c) => c.type === 'image' || c.type === 'softbreak' || (c.type === 'text' && !c.content.trim()))) {
      mark('block');
      tokens[i].children = images;
      if (!open.hidden) {
        open.tag = close.tag = 'div';
        open.attrSet('class', `md-figures${images.length > 1 ? ' is-row' : ''}`);
      }
      continue;
    }
    mark('side');
    const text = kids.filter((c) => c.type !== 'image');
    if (text[0]?.type === 'text') text[0].content = text[0].content.replace(/^\s+/, '');
    tokens[i].children = [...images, ...text];
  }
});

/**
 * A top-level paragraph that holds only a short bold phrase (**Changed**, **改了什么**) is a section label for what
 * follows, marked so the stylesheet can tie it to its block without touching bold sentences or inline emphasis.
 */
md.core.ruler.push('section_labels', (state) => {
  const tokens = state.tokens;
  for (let i = 1; i < tokens.length - 1; i++) {
    const open = tokens[i - 1];
    const rawKids = tokens[i].type === 'inline' ? tokens[i].children : null;
    if (!open || open.type !== 'paragraph_open' || open.level !== 0 || open.attrGet('class') || !rawKids) continue;
    // markdown-it's emphasis rule leaves empty text tokens where ** delimiters stood.
    const kids = rawKids.filter((c) => !(c.type === 'text' && !c.content));
    if (kids.length < 3 || kids[0].type !== 'strong_open' || kids[kids.length - 1].type !== 'strong_close') continue;
    let depth = 0;
    let broken = false;
    for (let j = 0; j < kids.length - 1; j++) {
      const k = kids[j].type;
      if (k === 'strong_open') depth++;
      else if (k === 'strong_close') depth--;
      if (depth < 1 || k === 'softbreak' || k === 'hardbreak' || k === 'image') {
        broken = true;
        break;
      }
    }
    if (broken) continue;
    const plain = kids.map((c) => c.content).join('').trim();
    if (plain.length >= 1 && plain.length <= 48 && !/[.!?。！？；;]/.test(plain)) {
      open.attrSet('class', 'md-label');
    }
  }
});

/**
 * A file the answer names becomes the file's name, which opens it (FileView), in place of a long path: written as
 * inline code (`src/store.ts:42`), as a path in the text (C:\app\src\store.ts:42), or as a link to a file here.
 */
md.core.ruler.push('file_refs', (state) => {
  const ref = (r: FileRef) => Object.assign(new state.Token('file_ref', '', 0), { meta: r });
  const text = (content: string) => Object.assign(new state.Token('text', '', 0), { content });
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const kids = block.children;
    const out: typeof kids = [];
    let inLink = false;
    for (let i = 0; i < kids.length; i++) {
      const t = kids[i];
      if (t.type === 'link_open') {
        let close = i + 1;
        let label = '';
        for (; close < kids.length && kids[close].type !== 'link_close'; close++) label += kids[close].content;
        let href = String(t.attrGet('href') ?? '');
        try {
          href = decodeURI(href);
        } catch {
          /* keep it as written */
        }
        const r = close < kids.length ? fileInLink(href, label) : null;
        if (r) {
          out.push(ref(r));
          i = close;
          continue;
        }
        // Any other file here keeps its words and opens on a click.
        const local = localTarget(href);
        if (local) {
          t.attrSet('data-local', local);
          if (state.env?.session) t.attrSet('data-session', String(state.env.session));
        }
        inLink = true;
      } else if (t.type === 'link_close') inLink = false;
      else if (t.type === 'code_inline' && !inLink) {
        const r = fileInCode(t.content);
        if (r) {
          out.push(ref(r));
          continue;
        }
      } else if (t.type === 'text' && !inLink && /[\\/]/.test(t.content)) {
        const found = filesInText(t.content);
        if (found.length) {
          let at = 0;
          for (const f of found) {
            if (f.from > at) out.push(text(t.content.slice(at, f.from)));
            out.push(ref(f));
            at = f.to;
          }
          if (at < t.content.length) out.push(text(t.content.slice(at)));
          continue;
        }
      }
      out.push(t);
    }
    block.children = out;
  }
});
md.renderer.rules.file_ref = ((tokens, idx, _options, env) => {
  const { path, line, end } = tokens[idx].meta as FileRef;
  const lines = line ? `${line}${end ? `–${end}` : ''}` : '';
  const tip = `${path}${line ? `:${line}${end ? `-${end}` : ''}` : ''}`;
  const data = `data-ctx="file" data-file="${escapeHtml(path)}"${line ? ` data-line="${line}"` : ''}${end ? ` data-end="${end}"` : ''}${env?.session ? ` data-session="${escapeHtml(env.session)}"` : ''}`;
  return `<span class="file-ref" role="button" tabindex="0" ${data} data-tip="${escapeHtml(tip)}">${FILE_ICON}<span class="file-ref-name">${escapeHtml(fileName(path))}</span>${lines ? `<span class="file-ref-at">:${lines}</span>` : ''}</span>`;
}) as Rule;

const cache = new Map<string, string>();

/** `session`: whose project a relative picture path is in. `stamp`: the message the text is in, see pictureSrc. */
export function renderMarkdown(text: string, session?: string, stamp?: string): string {
  // Only a text that shows a picture renders differently for another message.
  const key = `${session ?? ''}\n${stamp && text.includes('![') ? stamp : ''}\n${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = md.render(text, { session, stamp });
  if (cache.size > 400) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}

/**
 * The draft as it shows while it streams: an unfinished code fence closed, and the half-written marks on the last line
 * that would flash as stray text taken out or closed (a list item or heading with nothing in it yet, the backtick of
 * a code span still being written). Only the last line changes and it stays a line, so a settled prefix stays valid.
 */
function streamingSource(text: string): string {
  const fences = (text.match(/^```/gm) ?? []).length;
  if (fences % 2) return `${text}\n\`\`\``;
  const start = text.lastIndexOf('\n') + 1;
  const last = text.slice(start);
  const shown = unfinishedLine(last);
  return shown === last ? text : text.slice(0, start) + shown;
}

function unfinishedLine(line: string): string {
  if (/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]*$/.test(line) || /^ {0,3}#{1,6}[ \t]*$/.test(line)) return '';
  // Backticks in indented code are its text.
  if (!line.includes('`') || /^(?: {4}|\t)/.test(line)) return line;
  let open = '';
  let openAt = -1;
  for (const run of line.matchAll(/(?<!\\)`+/g)) {
    if (!open) {
      open = run[0];
      openAt = run.index;
    } else if (run[0].length === open.length) open = '';
  }
  if (!open) return line;
  if (!line.slice(openAt + open.length).trim()) return line.slice(0, openAt);
  const closing = /`*$/.exec(line)![0].length;
  return closing < open.length ? line + '`'.repeat(open.length - closing) : line;
}

/** Reference render of the whole streaming draft. */
export function renderFullStreaming(text: string, session?: string, stamp?: string): string {
  return md.render(streamingSource(text), { session, stamp });
}

let settled: { text: string; html: string; session?: string; stamp?: string } | undefined;

function settledBoundary(tokens: ReturnType<typeof md.parse>, raw: string): { token: number; offset: number } | undefined {
  const lines = raw.split('\n');
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.level !== 0 || !t.map) continue;
    const [first, end] = t.map;
    let line: number;
    let token: number;
    if (t.type === 'fence' && end - first >= 2 && end < lines.length && lines[end - 1] === t.markup) {
      // The synthetic closing fence can move. Only an actual closing line with its newline settles it.
      line = end;
      token = i + 1;
    } else {
      const prev = tokens[i - 1];
      // A full line of the next top-level paragraph or heading, past a blank, cannot extend the previous one.
      if ((t.type !== 'paragraph_open' && t.type !== 'heading_open') || first >= lines.length - 1
          || first === 0 || /[^ \t]/.test(lines[first - 1]) || prev?.level !== 0
          || (prev.type !== 'paragraph_close' && prev.type !== 'heading_close')) continue;
      line = first;
      token = i;
    }
    let offset = 0;
    for (let n = 0; n < line; n++) offset += lines[n].length + 1;
    return { token, offset };
  }
}

export function renderStreamingParts(text: string, session?: string, stamp?: string): { prefix: string; tail: string } {
  // Reference definitions can change earlier inline tokens. CR normalization changes token line offsets.
  // Retain only one bounded prefix even when the stream goes away without a final answer.
  if (text.includes(']:') || text.includes('\r') || text.length > 128 * 1024) {
    settled = undefined;
    return { prefix: '', tail: renderFullStreaming(text, session, stamp) };
  }

  const prior = settled && settled.session === session && settled.stamp === stamp && text.startsWith(settled.text) ? settled : undefined;
  const offset = prior?.text.length ?? 0;
  const env = { session, stamp };
  // Count fences on the whole draft as before, including when their parity changes past the settled prefix.
  const tokens = md.parse(streamingSource(text).slice(offset), env);
  const cut = settledBoundary(tokens, text.slice(offset));
  if (!cut) {
    settled = prior;
    return { prefix: prior?.html ?? '', tail: md.renderer.render(tokens, md.options, env) };
  }

  // At either boundary the last token in the prefix renders independently of the next token.
  const html = (prior?.html ?? '') + md.renderer.render(tokens.slice(0, cut.token), md.options, env);
  settled = { text: text.slice(0, offset + cut.offset), html, session, stamp };
  return { prefix: html, tail: md.renderer.render(tokens.slice(cut.token), md.options, env) };
}

type MountedPrefix = { html: string; end: ChildNode };

/** Keep the DOM of closed blocks. Only the still-changing suffix has to go through the HTML parser again. */
export function updateStreamingMarkdown(el: HTMLElement, parts: ReturnType<typeof renderStreamingParts>, prior?: MountedPrefix): MountedPrefix | undefined {
  const { prefix, tail } = parts;
  if (!prefix) {
    el.innerHTML = tail;
    return;
  }
  // These two interactions change the markup themselves. Give them the same reset a full render would.
  if (prior && prior.end.parentNode === el && prefix.startsWith(prior.html)
      && !el.querySelector('.md-img-missing, .code-copy.is-done, .code-copy:not([data-tip="Copy"])')) {
    while (el.lastChild !== prior.end) el.lastChild!.remove();
    if (prefix.length > prior.html.length) el.insertAdjacentHTML('beforeend', prefix.slice(prior.html.length));
  } else {
    el.innerHTML = prefix;
  }
  const end = el.lastChild;
  if (tail) el.insertAdjacentHTML('beforeend', tail);
  return end ? { html: prefix, end } : undefined;
}

export { highlightCode } from './highlight';
