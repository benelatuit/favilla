import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { listenForBrowser } from '../net/browser-port';
import type { BrowserSession } from './browser';

/**
 * What a page does wrong that a look at a screenshot does not show: errors in the console, sideways scrolling on
 * a phone, text below WCAG AA contrast (as a ratio), controls too small to tap, pictures that did not load, a
 * game's canvas that runs past the first screen. The
 * agent looks at its pages and still misses these (a 9×9 px dot reads as a button in a picture), so Favilla
 * measures them. The scripts are shared with the eval's ui checks.
 */

export interface PageIssue {
  width: number;
  kind: 'error' | 'overflow' | 'contrast' | 'tap' | 'image' | 'fold';
  detail: string;
}

/** A page script: the text whose contrast is under the threshold (3:1 for large text), as "text ratio". */
export function lowContrastScript(threshold: number): string {
  return `(() => {
    // Any CSS colour as sRGB bytes and an alpha from 0 to 1, read back from a canvas: computed styles keep the
    // author's colour space (oklch(0.985 0.011 83) is a near-white), so the numbers in the string are not RGB.
    const cx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    const rgb = (s) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const over = ([r, g, b, a], [r2, g2, b2]) => [r * a + r2 * (1 - a), g * a + g2 * (1 - a), b * a + b2 * (1 - a)];
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    // The colour behind the text, the see-through fills on the way down laid over the first solid one, or null when
    // it cannot be read from styles (an image, a gradient, a fill drawn by a ::before or ::after): those are left
    // out rather than guessed as white.
    const painted = (e, pseudo) => { const s = getComputedStyle(e, pseudo); return s.backgroundImage !== 'none' || (pseudo && s.content !== 'none' && rgb(s.backgroundColor)[3] > 0.1); };
    const bg = (el) => {
      const fills = [];
      for (let e = el; e; e = e.parentElement) {
        if (painted(e, '::before') || painted(e, '::after')) return null;
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c[3] > 0.99) return fills.reduceRight((under, f) => over(f, under), c);
        if (painted(e)) return null;
        if (c[3] > 0) fills.push(c);
      }
      return fills.reduceRight((under, f) => over(f, under), [255, 255, 255]);
    };
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el || seen.has(el) || !walker.currentNode.textContent.trim()) continue;
      seen.add(el);
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      // Text kept only for screen readers (a 1 px clipped box) is not seen.
      const box = el.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) continue;
      const s = getComputedStyle(el);
      const back = bg(el);
      if (!back) continue;
      const fg = over(rgb(s.color), back);
      const [a, b2] = [lum(fg), lum(back)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b2 + 0.05);
      const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700);
      if (ratio < (large ? 3 : ${threshold})) out.push(walker.currentNode.textContent.trim().slice(0, 24) + ' ' + ratio.toFixed(1));
    }
    return out;
  })()`;
}

/** A page script: the visible controls smaller than `min` px on either side, as "label WxH". */
export function smallControlsScript(min: number): string {
  return `[...document.querySelectorAll('button, [role=button], input:not([type=hidden]), select, textarea')]
    .filter((el) => el.checkVisibility ? el.checkVisibility() : el.offsetParent)
    .map((el) => [el, el.getBoundingClientRect()])
    .filter(([, r]) => r.width && r.height && Math.min(r.width, r.height) < ${min})
    .map(([el, r]) => (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height))`;
}

/** A page script: how wide the content is against what fits on screen (a phone's layout viewport grows to fit). */
export const OVERFLOW_SCRIPT = '({ sw: document.documentElement.scrollWidth, w: Math.round(visualViewport ? visualViewport.width : innerWidth) })';

/**
 * A page script: the large canvases (a game's field of play) that run past the bottom of the first screen, as
 * "W×H canvas from y A to B". Agents look at whole-page screenshots, where a board cut off by the screen's edge
 * still looks whole.
 */
export const FOLD_SCRIPT = `(() => {
  const h = Math.round(visualViewport ? visualViewport.height : innerHeight);
  return [...document.querySelectorAll('canvas')]
    .filter((c) => !c.checkVisibility || c.checkVisibility())
    .map((c) => c.getBoundingClientRect())
    .filter((r) => r.width * r.height >= 40000 && r.bottom + scrollY > h + 4)
    .map((r) => Math.round(r.width) + '×' + Math.round(r.height) + ' canvas from y ' + Math.round(r.top + scrollY) + ' to ' + Math.round(r.bottom + scrollY) + ' on a ' + h + ' px tall screen');
})()`;

/** A page script: a dashed line across the page where the first screen ends, for screenshots of the whole page. */
const FOLD_MARK = `(() => {
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;left:0;right:0;height:0;border-top:2px dashed #e0245e;z-index:2147483647;pointer-events:none;top:' + Math.round(visualViewport ? visualViewport.height : innerHeight) + 'px';
  document.documentElement.appendChild(d);
})()`;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.ico': 'image/x-icon',
};

/** A folder served over HTTP on localhost (module scripts do not load from file://). */
export async function serveFolder(root: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.join(root, rel);
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  const port = await listenForBrowser(server);
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

const BUNDLED = /\b(?:vite|react-scripts|next|nuxt|webpack|parcel|astro|@sveltejs\/kit|gatsby|remix|@angular\/core)\b/;

/**
 * The page of a folder that runs as it is, without a build step: its index.html, unless the folder is an app a
 * bundler serves (its index.html loads .ts, .jsx, .vue or .svelte files, or its package.json names a bundler).
 */
export function staticEntry(cwd: string): string | null {
  const entry = path.join(cwd, 'index.html');
  if (!fs.existsSync(entry)) return null;
  try {
    if (BUNDLED.test(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))) return null;
  } catch {
    // No package.json: a plain folder.
  }
  if (/<script[^>]+src=["'][^"']+\.(?:tsx?|jsx|vue|svelte)["']/i.test(fs.readFileSync(entry, 'utf8'))) return null;
  return entry;
}

/** Opens the page at each width and measures what is wrong; at a phone's width, tap targets too. */
export async function auditPage(b: BrowserSession, url: string, widths: number[] = [1280, 390]): Promise<PageIssue[]> {
  const issues: PageIssue[] = [];
  for (const width of widths) {
    const phone = width < 600;
    await b.viewport(width, phone ? 844 : 800);
    b.takeLog();
    await b.open(url);
    await new Promise((r) => setTimeout(r, 800));
    for (const line of b.takeLog()) if (/error|exception|uncaught|failed to load/i.test(line)) issues.push({ width, kind: 'error', detail: line.slice(0, 200) });
    const o = await b.evaluate<{ sw: number; w: number }>(OVERFLOW_SCRIPT);
    if (o.sw > o.w + 1) issues.push({ width, kind: 'overflow', detail: `the page is ${o.sw} px wide on a ${o.w} px screen` });
    const below = await b.evaluate<string[]>(FOLD_SCRIPT);
    if (below.length) issues.push({ width, kind: 'fold', detail: below.slice(0, 2).join(', ') });
    const low = await b.evaluate<string[]>(lowContrastScript(4.5));
    if (low.length) issues.push({ width, kind: 'contrast', detail: low.slice(0, 5).join(', ') });
    if (phone) {
      const small = await b.evaluate<string[]>(smallControlsScript(32));
      if (small.length) issues.push({ width, kind: 'tap', detail: small.slice(0, 5).join(', ') });
    }
    const broken = await b.evaluate<string[]>("[...document.images].filter((i) => i.complete && !i.naturalWidth && i.src).map((i) => i.getAttribute('src')).slice(0, 5)");
    if (broken.length) issues.push({ width, kind: 'image', detail: broken.join(', ') });
  }
  return issues;
}

/**
 * What is on the screen right now, in numbers: the text blocks and pictures that meet the viewport, where they sit,
 * how large the text is and how many lines it takes. Text only: field values and the like stay out.
 */
const VIEW_SCRIPT = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const seen = new Set();
  const blocks = [];
  const onScreen = (r) => r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const box = (e) => {
    while (e && e !== document.body && getComputedStyle(e).display.startsWith('inline') && !/^(BUTTON|A|LABEL)$/.test(e.tagName)) e = e.parentElement;
    return e;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && blocks.length < 60) {
    const node = walker.currentNode;
    if (!node.textContent.trim() || !node.parentElement) continue;
    const e = box(node.parentElement);
    if (!e || e === document.body || seen.has(e) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(e.tagName)) continue;
    seen.add(e);
    if (e.checkVisibility && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = e.getBoundingClientRect();
    if (!onScreen(r)) continue;
    const s = getComputedStyle(e);
    const font = parseFloat(s.fontSize) || 16;
    const line = parseFloat(s.lineHeight) || font * 1.2;
    blocks.push({
      tag: e.tagName.toLowerCase(),
      text: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 70),
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      font: Math.round(font),
      lines: Math.max(1, Math.round(r.height / line)),
      clipped: (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1) && /hidden|clip/.test(s.overflowX + s.overflowY),
      off: r.left < -1 || r.right > vw + 1,
    });
  }
  const media = [...document.querySelectorAll('canvas,video,img,svg,iframe')]
    .map((e) => ({ tag: e.tagName.toLowerCase(), r: e.getBoundingClientRect() }))
    .filter(({ r }) => onScreen(r) && r.width * r.height >= 4096)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)
    .slice(0, 5)
    .map(({ tag, r }) => ({ tag, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), share: Math.round((Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) * 100) / (vw * vh)) }));
  return { w: vw, h: vh, y: Math.round(scrollY), page: document.documentElement.scrollHeight, blocks, media };
})()`;

/**
 * Text out of place on the screen, which a model looking at the screenshot tends to pass over: lines running past the
 * screen's edge, lines cut off by a box that hides its overflow, and text lying on other text. Measured on the lines
 * themselves, since a heading's box can sit inside the screen while its longest word runs out of it. A header pinned
 * over the page and a deliberate ellipsis are left out.
 */
const PLACE_SCRIPT = `(() => {
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  const lines = [];
  const pinnedOf = new Map();
  const pinned = (e) => {
    if (!pinnedOf.has(e)) {
      let p = false;
      for (let a = e; a && a !== document.body; a = a.parentElement) if (/fixed|sticky/.test(getComputedStyle(a).position)) { p = true; break; }
      pinnedOf.set(e, p);
    }
    return pinnedOf.get(e);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && lines.length < 600) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!el || !node.textContent.trim() || el.closest('script,style,noscript,template,svg')) continue;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const own = el.getBoundingClientRect();
    if (own.width <= 1 || own.height <= 1) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= vh) continue;
      // The middle of the line's box, where the letters are: at display sizes the box runs well past them.
      lines.push({ node, el, l: r.left, t: r.top + r.height * 0.15, r: r.right, b: r.bottom - r.height * 0.15, text: node.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) });
    }
  }
  const edge = [], cut = [], onText = [], covered = [];
  const add = (list, s) => { if (list.length < 4 && !list.includes(s)) list.push(s); };
  for (const x of lines) {
    if (x.l < -1 || x.r > vw + 1) { add(edge, '"' + x.text + '"'); continue; }
    for (let a = x.el, depth = 0; a && a !== document.body && depth < 10; a = a.parentElement, depth++) {
      const s = getComputedStyle(a);
      if (!/hidden|clip/.test(s.overflowX + ' ' + s.overflowY)) continue;
      const k = a.getBoundingClientRect();
      if (s.textOverflow !== 'ellipsis' && (x.l < k.left - 1 || x.r > k.right + 1 || x.t < k.top - 1 || x.b > k.bottom + 1)) add(cut, '"' + x.text + '"');
      break;
    }
  }
  const area = (q) => (q.r - q.l) * (q.b - q.t);
  const meet = (p, q) => Math.max(0, Math.min(p.r, q.r) - Math.max(p.l, q.l)) * Math.max(0, Math.min(p.b, q.b) - Math.max(p.t, q.t));
  for (let i = 0; i < lines.length && onText.length < 4; i++) for (let j = i + 1; j < lines.length; j++) {
    const p = lines[i], q = lines[j];
    if (p.node === q.node || pinned(p.el) !== pinned(q.el) || meet(p, q) <= 0.3 * Math.min(area(p), area(q))) continue;
    add(onText, '"' + p.text + '" and "' + q.text + '"');
    break;
  }
  // What lies on top at the middle of each line, when it hides what is under it: a picture, or a box with a fill.
  // Clear boxes are text over text, counted above; a click area over a card is left out.
  const opaque = (e) => {
    if (/^(img|svg|canvas|video|picture)$/i.test(e.tagName) || e.closest('svg')) return true;
    const s = getComputedStyle(e);
    const m = s.backgroundColor.match(/[\\d.]+/g);
    return s.backgroundImage !== 'none' || (!!m && (m.length < 4 || +m[3] > 0.5));
  };
  // Nine points over the letters, since a picture laid over half a word hides it as surely as over all of it.
  const over = (el, l, t, r, b) => {
    let n = 0;
    for (const fx of [0.25, 0.5, 0.75]) for (const fy of [0.2, 0.5, 0.8]) {
      const py = t + (b - t) * fy;
      if (py < 0 || py > vh) continue;
      const top = document.elementFromPoint(Math.min(Math.max(l + (r - l) * fx, 1), vw - 1), py);
      if (!top || top === el || el.contains(top) || top.contains(el) || top.matches('a,button,label,[role=button],[role=link]') || (pinned(top) && !pinned(el)) || !opaque(top)) continue;
      if (++n >= 2) return top;
    }
    return null;
  };
  for (const x of lines) {
    if (covered.length >= 4) break;
    const top = over(x.el, x.l, x.t, x.r, x.b);
    if (top) add(covered, '"' + x.text + '" under ' + top.tagName.toLowerCase());
  }
  return { edge, cut, onText, covered };
})()`;

/**
 * What an unfinished page still has, over the whole page: text that waits invisible for a script to reveal it, type
 * set in a family that is neither loaded nor installed (the browser falls back without a word), placeholder copy,
 * links to anchors the page lacks, and pictures blown up past their own size. Checks of the kind taste-skill's
 * checker runs: in its own tests (2026-10) blind judges scored its pages about as high as pages made without it,
 * while its checker found 0 failures on them against 8 to 13 on the others.
 */
const FINISH_SCRIPT = `(async () => {
  // Fonts still on their way are waited for, a little: a request that hangs must not hold up every browser call.
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  const hidden = [], fallback = [], placeholder = [], anchors = [], blurry = [], unfilled = [];
  const words = (s) => s.replace(/\\s+/g, ' ').trim();
  // A box's text as read, a space between its blocks (textContent runs a heading into the next paragraph).
  const textOf = (e) => { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); const parts = []; while (w.nextNode() && parts.length < 40) parts.push(w.currentNode.textContent); return words(parts.join(' ')); };
  // Invisible at rest: opacity 0 or visibility hidden, outside menus, dialogs, tooltips and boxes laid over others.
  const counted = new Set();
  const all = document.body ? [...document.body.querySelectorAll('*')].slice(0, 4000) : [];
  for (const e of all) {
    if (hidden.length >= 4) break;
    if (/^(script|style|noscript|template|svg)$/i.test(e.tagName) || e.closest('nav,header,dialog,[role=dialog],[role=menu],[role=tooltip],[aria-hidden=true],details:not([open]),[hidden],svg')) continue;
    const s = getComputedStyle(e);
    if (!(parseFloat(s.opacity) < 0.05 || s.visibility === 'hidden') || /fixed|absolute/.test(s.position)) continue;
    let inside = false;
    for (let a = e.parentElement; a && !inside; a = a.parentElement) inside = counted.has(a);
    counted.add(e);
    const r = e.getBoundingClientRect();
    const t = textOf(e);
    if (inside || t.length < 20 || r.width < 40 || r.height < 10) continue;
    hidden.push('"' + t.slice(0, 40).trim() + '"');
  }
  // A family is there when it is loaded, or installed: then text set in it measures unlike both generic faces.
  const cx = document.createElement('canvas').getContext('2d');
  const width = (f) => { cx.font = '72px ' + f; return cx.measureText('mmmmmmmmmmlli1WQ@#').width; };
  const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|emoji|math|fangsong|-apple-system|blinkmacsystemfont)$/i;
  const asked = new Map();
  for (const tag of ['h1', 'h2', 'h3', 'p', 'li', 'button', 'a']) for (const e of [...document.getElementsByTagName(tag)].slice(0, 30)) {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || !words(e.textContent || '')) continue;
    const fam = getComputedStyle(e).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (fam && !generic.test(fam) && !asked.has(fam)) asked.set(fam, tag);
  }
  for (const [fam, tag] of asked) {
    if ([...document.fonts].some((f) => f.family.replace(/^["']|["']$/g, '') === fam && f.status === 'loaded')) continue;
    if (width('"' + fam + '", monospace') === width('monospace') && width('"' + fam + '", serif') === width('serif')) fallback.push(tag + ' "' + fam + '"');
  }
  const text = document.body ? document.body.innerText : '';
  const PLACEHOLDER = /lorem ipsum[^.\\n]{0,30}|dolor sit amet|\\b(?:TODO|TBD|FIXME)\\b[^.\\n]{0,30}|your (?:company|brand|logo|name|text) here|\\[(?:insert|add|your|placeholder)[^\\]\\n]{0,30}\\]/gi;
  for (const m of text.matchAll(PLACEHOLDER)) if (placeholder.length < 3) placeholder.push('"' + words(m[0]).slice(0, 40).trim() + '"');
  // What a script did not fill in, printed as it came: a sum that came out NaN, a value that was never set, an object
  // printed whole, a date that did not parse. "undefined" only where a value goes (after a colon, a currency sign or a
  // bracket): pages about code say it in sentences.
  const UNFILLED = /(^|[\\s:：(（$¥€£])(NaN|\\[object Object\\]|Invalid Date)(?=$|[\\s,.;:)）%])|(?:[:：]\\s?|[$¥€£(（])undefined\\b/gm;
  for (const m of text.matchAll(UNFILLED)) {
    if (unfilled.length >= 3) break;
    // The line it is on, as the page shows it.
    const end = text.indexOf('\\n', m.index + m[0].length);
    unfilled.push('"' + words(text.slice(text.lastIndexOf('\\n', m.index) + 1, end < 0 ? undefined : end)).slice(0, 60) + '"');
  }
  for (const a of document.querySelectorAll('a[href^="#"]')) {
    let id = a.getAttribute('href').slice(1);
    try { id = decodeURIComponent(id); } catch {}
    // "#" and "#top" go to the top, "#/..." and "#!..." are a script's routes.
    if (!id || id === 'top' || /^[!\\/]/.test(id) || document.getElementById(id) || document.getElementsByName(id).length) continue;
    if (anchors.length < 4 && !anchors.includes('#' + id)) anchors.push('#' + id);
  }
  for (const img of document.images) {
    const r = img.getBoundingClientRect();
    const src = img.currentSrc || img.src || '';
    if (!img.naturalWidth || r.width < 120 || r.height < 80 || /\\.svg(\\?|#|$)|^data:image\\/svg/i.test(src)) continue;
    const fit = getComputedStyle(img).objectFit;
    const k = fit === 'contain' || fit === 'scale-down' ? Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight) : Math.max(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const name = /^data:/.test(src) ? 'an inline picture' : decodeURIComponent(src.split(/[?#]/)[0].split('/').pop() || '').slice(0, 40);
    if (k > 1.25 && blurry.length < 3) blurry.push(name + ' ' + img.naturalWidth + '×' + img.naturalHeight + ' shown at ' + Math.round(r.width) + '×' + Math.round(r.height));
  }
  return { hidden, fallback, placeholder, anchors, blurry, unfilled };
})()`;

interface PageView {
  w: number;
  h: number;
  y: number;
  page: number;
  blocks: { tag: string; text: string; x: number; y: number; w: number; h: number; font: number; lines: number; clipped: boolean; off: boolean }[];
  media: { tag: string; x: number; y: number; w: number; h: number; share: number }[];
}

const SHOWN = 24;

/**
 * The page as a look at it would find it, as text beside the screenshot: where things sit, and what a picture does
 * not show (sideways scrolling, text cut off, contrast, controls too small to tap, pictures that did not load).
 * Facts for the model's next step, measured on the page as it stands: no second browser, no extra request.
 */
export async function pageFacts(b: BrowserSession, phone: boolean): Promise<string> {
  const v = await b.evaluate<PageView>(VIEW_SCRIPT);
  const out = [`The screen, ${v.w}×${v.h}, scrolled to ${v.y} of ${v.page} px (x,y w×h, font px, lines):`];
  for (const m of v.media) out.push(`  ${m.tag} ${m.x},${m.y} ${m.w}×${m.h}, ${m.share}% of the screen${m.tag === 'canvas' ? ' (its contents are not text: look at the picture)' : m.tag === 'iframe' ? ' (not looked into)' : ''}`);
  for (const t of v.blocks.slice(0, SHOWN)) out.push(`  ${t.tag} "${t.text}" ${t.x},${t.y} ${t.w}×${t.h}, ${t.font}px, ${t.lines} line${t.lines === 1 ? '' : 's'}${t.clipped ? ', cut off' : ''}${t.off ? ', past the edge' : ''}`);
  if (v.blocks.length > SHOWN) out.push(`  … ${v.blocks.length - SHOWN} more on this screen`);
  const problems: string[] = [];
  const wide = await b.evaluate<{ sw: number; w: number }>(OVERFLOW_SCRIPT);
  if (wide.sw > wide.w + 1) problems.push(`scrolls sideways: ${wide.sw} px wide on a ${wide.w} px screen`);
  const place = await b.evaluate<{ edge: string[]; cut: string[]; onText: string[]; covered: string[] }>(PLACE_SCRIPT).catch(() => ({ edge: [], cut: [], onText: [], covered: [] }));
  if (place.edge.length) problems.push(`text running past the screen's edge: ${place.edge.join(', ')}`);
  if (place.cut.length) problems.push(`text cut off by its box: ${place.cut.join(', ')}`);
  if (place.onText.length) problems.push(`text lying on other text: ${place.onText.join(', ')}`);
  if (place.covered.length) problems.push(`text with something laid over it: ${place.covered.join(', ')}`);
  const low = await b.evaluate<string[]>(lowContrastScript(4.5));
  if (low.length) problems.push(`low contrast: ${low.slice(0, 4).join(', ')}`);
  if (phone) {
    const small = await b.evaluate<string[]>(smallControlsScript(32));
    if (small.length) problems.push(`too small to tap: ${small.slice(0, 4).join(', ')}`);
  }
  const broken = await b.evaluate<string[]>("[...document.images].filter((i) => i.complete && !i.naturalWidth && i.src).map((i) => i.getAttribute('src')).slice(0, 4)");
  if (broken.length) problems.push(`pictures that did not load: ${broken.join(', ')}`);
  const unfinished = await b.evaluate<{ hidden: string[]; fallback: string[]; placeholder: string[]; anchors: string[]; blurry: string[]; unfilled: string[] }>(FINISH_SCRIPT).catch(() => null);
  if (unfinished?.hidden.length) problems.push(`text invisible at rest until a script reveals it (a screenshot, a printout, reduced motion or a script that fails shows a gap): ${unfinished.hidden.join(', ')}`);
  if (unfinished?.fallback.length) problems.push(`type falling back to a default face, its family neither loaded nor installed: ${unfinished.fallback.join(', ')}`);
  if (unfinished?.placeholder.length) problems.push(`placeholder text: ${unfinished.placeholder.join(', ')}`);
  if (unfinished?.unfilled?.length) problems.push(`values a script did not fill in, shown as they came out: ${unfinished.unfilled.join(', ')}`);
  if (unfinished?.anchors.length) problems.push(`links to anchors the page does not have: ${unfinished.anchors.join(', ')}`);
  if (unfinished?.blurry.length) problems.push(`pictures blown up past their own size (blurry): ${unfinished.blurry.join(', ')}`);
  if (problems.length) out.push(`Measured: ${problems.join('; ')}.`);
  return out.join('\n');
}

/** The whole page at each width, with a dashed line where the first screen ends, for a review of how it looks. */
export async function pageShots(b: BrowserSession, url: string, widths: number[] = [1280, 390]): Promise<{ width: number; height: number; png: Buffer }[]> {
  const out: { width: number; height: number; png: Buffer }[] = [];
  for (const width of widths) {
    const height = width < 600 ? 844 : 800;
    await b.viewport(width, height);
    await b.open(url);
    await new Promise((r) => setTimeout(r, 900));
    await b.evaluate(FOLD_MARK);
    out.push({ width, height, png: await b.strip(width, height) });
  }
  return out;
}

/** The issues as one note for the model: what was measured, at which width, in numbers. */
export function auditNote(issues: PageIssue[], page: string, again = false): string {
  const say: Record<PageIssue['kind'], string> = {
    error: 'console error',
    overflow: 'sideways scrolling',
    contrast: 'text under 4.5:1 contrast (text and ratio)',
    tap: 'controls under 32 px to tap',
    image: 'pictures that did not load',
    fold: 'a canvas past the bottom of the first screen (playing it needs scrolling)',
  };
  const lines = issues.map((i) => `- ${i.width} px, ${say[i.kind]}: ${i.detail}`);
  const widths = [...new Set(issues.map((i) => i.width))].join(' and ');
  if (again)
    return `After your changes Favilla measured ${page} again at ${widths} px wide, and these are still there:\n${lines.join('\n')}\nThese are measured on the page as drawn, with what lies behind the text; ratios worked out from the colour values miss that. Fix them, or say in your answer why one should stay.`;
  return `Favilla opened ${page} at ${widths} px wide and measured what a look does not show:\n${lines.join('\n')}\nFix these, or say in your answer why one should stay.`;
}
