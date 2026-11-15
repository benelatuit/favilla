/**
 * A page's design in numbers, against the bar of well-made brand sites: measured on 2026-11-07 from the computed
 * styles of ten clean brand sites (Apple, Things, Arc, Song Tea, Pentagram, Teenage Engineering, Vercel, Leica,
 * Nothing, Muji) and of four agents' landing pages for one brief. The medians: five font sizes carry 95% of the text
 * (agents twelve), body 17.5px (15), the largest type 3.2 times the body (5.9; one agent 21.6), one saturated colour
 * (seven), no small letter-spaced capitals (thirty), no pill shapes (four to six in ten boxes), 39 words on the first
 * screen (111), pictures over 82% of the page's area (4%). Words for a model are taste it cannot check; numbers it
 * can meet.
 *
 * Three more on 2026-11-11, for what a user named in agents' pages (boxes everywhere, a page stuffed and banded):
 * eleven sites (the same without Arc, Vercel and Muji, with Linear, Stripe, Raycast and Kinto) against fifteen pages
 * Favilla made. The medians: the ground changes colour once in 2400px of page (Favilla's once in 900px, at every
 * section), 11% of the text sits in a box (52%), no text is tilted (23%).
 *
 * One more on 2026-11-12, for pages set over one saturated colour from top to bottom: eleven sites (Apple, Things,
 * Song Tea, Pentagram, Teenage Engineering, Linear, Stripe, Raycast, Nothing, Leica, Vercel) against the fifteen
 * pages of 2026-11-11. No site has a saturated ground under any of its height (the pages 0 to 100%, three over 20%).
 *
 * Three more on 2026-11-14, for what was left in pages that met those bars: glows (a coloured shadow, or a wide soft
 * one), boxes two deep inside other boxes, and type left as the browser sets it or prose running wider than 960px.
 */
export interface DesignMeasure {
  sizes: number;
  body: number;
  scale: number;
  lineHeight: number;
  cjk: boolean;
  saturated: number;
  labels: number;
  pillShare: number;
  gradients: number;
  blurs: number;
  emoji: number;
  foldWords: number;
  pictureShare: number;
  families: string[];
  /** The page's height in px at the measured width. */
  height: number;
  /** How often the fill behind the whole width changes down the page, bands under 80px left out. */
  groundChanges: number;
  /** How many different fills those bands have between them. */
  groundColours: number;
  /** The share of the text, in percent, that sits in a box narrower than the page: a border, a shadow or a fill of its own. */
  boxedText: number;
  /** The share of the text, in percent, under a rotation. */
  tiltedText: number;
  /** The share of the page's height, in percent, whose ground is a saturated colour. */
  vividGround: number;
  /** Shadows that glow: a saturated colour, or a blur of 28px and more at a visible strength. */
  glows?: number;
  /** Boxes with two or more boxes around them. */
  nestedBoxes?: number;
  /** The browser's own type (a serif body at its default margin) or prose wider than 960px. */
  bareType?: boolean;
}

/** Shared in-page sRGB canvas colour reader (handles oklch/lab/color-mix), alpha compositing, luminance and saturation. */
export const DOM_COLOUR_PRELUDE = `const cx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true }), _rgba = new Map();
  const rgba = (c) => { if (!c) return [0, 0, 0, 0]; let v = _rgba.get(c); if (!v) { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; v = [d[0], d[1], d[2], d[3] / 255]; _rgba.set(c, v); } return v; };
  const over = ([r, g, b, a], [r2, g2, b2]) => [r * a + r2 * (1 - a), g * a + g2 * (1 - a), b * a + b2 * (1 - a)];
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const sat = ([r, g, b]) => { const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, l = (mx + mn) / 2; return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); };`;

/** Runs in the page: what the report needs, from visible elements' computed styles. */
export const MEASURE_SCRIPT = String.raw`(() => {
  const W = innerWidth, FOLD = innerHeight, H = document.documentElement.scrollHeight;
  const shown = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  ${DOM_COLOUR_PRELUDE}
  const rgb = (c) => { const v = rgba(c); return v[3] >= 0.05 ? v.slice(0, 3) : null; };
  const key = (c) => c.map((v) => Math.round(v / 16)).join(',');
  const sizes = {}, fams = {}, colours = new Set(), lines = [], texts = [], all = [];
  let chars = 0, han = 0, labels = 0, gradients = 0, glows = 0, blurs = 0, emoji = 0, fold = 0, picture = 0, boxes = 0, pills = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (!shown(el)) continue;
    all.push(el);
    const s = getComputedStyle(el), r = el.getBoundingClientRect(), area = r.width * r.height, top = r.top + scrollY;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    if (own) {
      const fs = Math.round(parseFloat(s.fontSize)), n = own.length, h = (own.match(/[㐀-鿿]/g) || []).length;
      sizes[fs] = (sizes[fs] || 0) + n; chars += n; han += h; texts.push([el, n]);
      const f = s.fontFamily.split(',')[0].replace(/["']/g, '').trim(); fams[f] = (fams[f] || 0) + n;
      const c = rgb(s.color); if (c && sat(c) > 0.35 && Math.max(...c) > 60) colours.add(key(c));
      if (s.textTransform === 'uppercase' && fs <= 13 && parseFloat(s.letterSpacing) > 0.5) labels++;
      emoji += (own.match(/\p{Emoji_Presentation}/gu) || []).length;
      if (top < FOLD) fold += h ? h / 2 : own.split(/\s+/).length;
      lines.push([fs, parseFloat(s.lineHeight) / fs || 1.2, n]);
    }
    const bg = rgb(s.backgroundColor);
    if (bg && area > 2000 && sat(bg) > 0.35 && Math.max(...bg) > 60) colours.add(key(bg));
    if (/gradient\(/.test(s.backgroundImage) && area > 180) gradients++;
    if (s.boxShadow && s.boxShadow !== 'none' && area > 180) {
      const colStr = s.boxShadow.split(/\s+-?\d/)[0];
      const nums = [...s.boxShadow.slice(colStr.length).matchAll(/-?\d+(?:\.\d+)?(?=px)/g)].map((m) => +m[0]);
      const sc = rgba(colStr.trim());
      if (sc[3] >= 0.08 && (sat(sc) > 0.4 || ((nums[2] || 0) >= 28 && sc[3] >= 0.14))) glows++;
    }
    if (/blur/.test(s.backdropFilter || '') || /blur/.test(s.filter)) blurs++;
    const nonControl = !el.closest('button,a,input,select,textarea,[role=button],[role=tab]');
    if ((bg || parseFloat(s.borderTopWidth) > 0) && (area > 2000 || (nonControl && area > 350)) && r.width < W * 0.9) {
      boxes++;
      const rad = parseFloat(s.borderTopLeftRadius);
      if (nonControl && (rad >= 999 || rad >= r.height / 2 - 1)) pills++;
    }
    const mono = /mono|courier|consolas/i.test(s.fontFamily);
    if (/^(IMG|PICTURE|VIDEO|CANVAS)$/.test(el.tagName) || (el.tagName === 'svg' && area > 40000) || (/url\(/.test(s.backgroundImage) && area > 40000) || (el.tagName === 'PRE' && mono && area > 40000 && !el.closest('code'))) picture += Math.min(r.width, W) * Math.min(r.height, 2000);
  }
  // The fill an element shows, its see-through layers laid over what is behind it down to the page.
  const far = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const fillOf = (el) => { const c = rgba(getComputedStyle(el).backgroundColor); return c[3] > 0.05 ? c : null; };
  const page = [document.documentElement, document.body].reduce((c, el) => { const f = fillOf(el); return f ? over(f, c) : c; }, [255, 255, 255]);
  const behind = (el) => { const stack = []; for (let p = el.parentElement; p; p = p.parentElement) { const c = fillOf(p); if (c) { stack.push(c); if (c[3] > 0.95) break; } } return stack.reverse().reduce((c, f) => over(f, c), page); };
  const shows = (el) => { const c = fillOf(el); return c ? over(c, behind(el)) : null; };
  // The ground down the page, in rows of 8px, from blocks as wide as the page (a picture as wide counts as a ground of its own). A change is a band of 80px or more in another colour than the band before it.
  const rows = new Array(Math.ceil(H / 8)).fill(null);
  for (const el of all) {
    const r = el.getBoundingClientRect(); if (r.width < W * 0.96 || r.height < 40) continue;
    const c = shows(el) || (getComputedStyle(el).backgroundImage !== 'none' ? [128, 128, 128] : null); if (!c) continue;
    for (let i = Math.max(0, Math.floor((r.top + scrollY) / 8)), end = Math.min(rows.length, Math.ceil((r.bottom + scrollY) / 8)); i < end; i++) rows[i] = c;
  }
  const bands = [];
  for (const c of rows.map((c) => c || page)) { const last = bands[bands.length - 1]; if (last && far(last.c, c) < 24) last.n++; else bands.push({ c, n: 1 }); }
  let grounds = 0, ground = null;
  for (const b of bands) if (b.n >= 10 && !(ground && far(ground, b.c) < 24)) { grounds++; ground = b.c; }
  const kinds = [];
  for (const b of bands) if (b.n >= 10 && !kinds.some((k) => far(k, b.c) < 24)) kinds.push(b.c);
  // A box: narrower than the page, holding words, with a border on three sides or more, a shadow, or a fill unlike what is behind it. Controls, tables, pictures and code are not boxes.
  const box = new Set(all.filter((el) => {
    const r = el.getBoundingClientRect(); if (r.width < 120 || r.height < 56 || r.width > W * 0.94) return false;
    if (el.closest('a,button,input,select,textarea,label,summary,[role=button],[role=tab],nav') || /^(IMG|SVG|VIDEO|CANVAS|PICTURE|TABLE|TR|TD|TH|THEAD|TBODY|PRE|CODE)$/i.test(el.tagName)) return false;
    if ((el.innerText || '').replace(/\s+/g, '').length < 20) return false;
    const s = getComputedStyle(el), f = shows(el);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((k) => parseFloat(s['border' + k + 'Width']) >= 1 && s['border' + k + 'Style'] !== 'none' && rgba(s['border' + k + 'Color'])[3] > 0.1).length;
    return sides >= 3 || s.boxShadow !== 'none' || (!!f && far(f, behind(el)) >= 18);
  }));
  // A saturated ground: strong in colour and neither near white nor near black.
  const vivid = rows.filter((c) => { c = c || page; const l = (Math.max(...c) + Math.min(...c)) / 510; return sat(c) > 0.5 && l > 0.2 && l < 0.8; }).length;
  const turned = (el) => { const m = getComputedStyle(el).transform.match(/^matrix\(([^)]+)\)/); if (!m) return false; const [a, b] = m[1].split(',').map(Number), deg = Math.abs(Math.atan2(b, a) * 180 / Math.PI); return deg > 0.4 && deg < 179.6; };
  let boxed = 0, tilted = 0;
  for (const [el, n] of texts) {
    let inBox = false, atTilt = false;
    for (let p = el; p && p !== document.body; p = p.parentElement) { inBox = inBox || box.has(p); atTilt = atTilt || turned(p); }
    if (inBox) boxed += n;
    if (atTilt) tilted += n;
  }
  let nestedBoxes = 0;
  for (const el of box) {
    let depth = 0;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (box.has(p)) depth++;
    if (depth >= 2) nestedBoxes++;
  }
  const bs = document.body ? getComputedStyle(document.body) : null;
  const bareFont = bs ? /^(times( new roman)?|simsun|serif)$/i.test(bs.fontFamily.split(',')[0].replace(/["']/g, '').trim()) : false;
  const bareBody = !!(bs && bareFont && parseFloat(bs.marginLeft) === 8 && page[0] > 250 && page[1] > 250 && page[2] > 250);
  const wideProse = W >= 1000 && all.some((el) => el.tagName === 'P' && (el.innerText || '').trim().length >= 90 && el.getBoundingClientRect().width > 960);
  const bareType = bareBody || wideProse;
  const order = Object.entries(sizes).sort((a, b) => b[1] - a[1]);
  const body = +(order[0] || [16])[0];
  let cum = 0, used = 0;
  for (const [, v] of order) { if (cum >= chars * 0.95) break; cum += v; used++; }
  const atBody = lines.filter((l) => l[0] === body);
  return {
    sizes: used, body, scale: Math.round(10 * Math.max(body, ...lines.map((l) => l[0])) / body) / 10,
    lineHeight: Math.round(100 * atBody.reduce((a, l) => a + l[1], 0) / (atBody.length || 1)) / 100,
    cjk: han > chars * 0.3, saturated: colours.size, labels, pillShare: boxes ? Math.round(100 * pills / boxes) : 0,
    gradients, glows, blurs, emoji, foldWords: Math.round(fold), pictureShare: Math.round(100 * picture / (W * H)),
    families: Object.entries(fams).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f),
    height: Math.round(H), groundChanges: Math.max(0, grounds - 1), groundColours: kinds.length, boxedText: chars ? Math.round(100 * boxed / chars) : 0, tiltedText: chars ? Math.round(100 * tilted / chars) : 0,
    vividGround: Math.round(100 * vivid / (rows.length || 1)), nestedBoxes, bareType,
  };
})()`;

/** Defect-only design report: lists only items outside the bar, plus one summary line. */
export function designReport(m: DesignMeasure): string {
  const outside: string[] = [];
  const check = (ok: boolean, line: string, fix: string) => {
    if (!ok) outside.push(`- OUTSIDE THE BAR: ${line}. ${fix}`);
  };
  check(m.sizes <= 6, `${m.sizes} font sizes carry 95% of the text (bar: 6 or fewer)`, 'Fold the sizes into one 3–5 step scale.');
  check(m.body >= 14 && m.body <= 20, `body ${m.body}px (bar: 14 to 20)`, 'Set body text between 14 and 19px.');
  check(m.scale <= 6, `the largest type is ${m.scale} times the body (bar: 6 or less)`, 'Keep display headings near 2 to 5 times the body.');
  const [lo, hi] = m.cjk ? [1.6, 1.85] : [1.3, 1.72];
  check(m.lineHeight >= lo && m.lineHeight <= hi, `body line height ${m.lineHeight} (bar for ${m.cjk ? 'Chinese' : 'Latin'} text: ${lo} to ${hi})`, 'Set the body line height inside the bar.');
  check(m.saturated <= 2, `${m.saturated} saturated colours (bar: 2 or fewer)`, 'Keep one accent; rest on neutrals.');
  check(m.labels <= 2, `${m.labels} small letter-spaced capital labels (bar: 2 or fewer)`, 'Remove micro-eyebrow labels above headings.');
  check(m.pillShare <= 10, `${m.pillShare}% of boxes are pill-shaped (bar: 10% or less)`, 'Use 0 to 8px radii instead of static pill badges.');
  check(m.gradients === 0, `${m.gradients} gradients (bar: none)`, 'Use flat fills instead of CSS gradients.');
  check((m.glows ?? 0) === 0, `${m.glows} glowing or heavy-blur shadows (bar: none)`, 'Remove coloured glows and heavy card shadows.');
  check(m.blurs === 0, `${m.blurs} blurred or frosted layers (bar: none)`, 'Remove backdrop-filter / blur layers.');
  check(m.emoji === 0, `${m.emoji} emoji (bar: none)`, 'Use words or clean inline SVG icons instead of emoji.');
  const changes = Math.max(1, Math.floor(m.height / 1200));
  check(m.groundChanges <= changes, `the ground behind the page changes colour ${m.groundChanges} times in ${m.height}px (bar: ${changes} or fewer, one for every 1200px at most)`, 'Keep one ground through the page and part sections with space and rules.');
  const kinds = m.height > 6000 ? 4 : 3;
  check(m.groundColours <= kinds, `the page has ${m.groundColours} different grounds (bar: ${kinds} or fewer)`, 'Use at most two grounds (plus one inversion at the close).');
  if (m.height > 1600) {
    check(m.boxedText <= 40, `${m.boxedText}% of the text sits inside a box (bar: 40% or less)`, 'Let prose, prices, steps and Q&A sit directly on the ground parted by space.');
  }
  check((m.nestedBoxes ?? 0) <= 1, `${m.nestedBoxes} boxes nested three levels deep (bar: 1 or fewer)`, 'Flatten card-inside-card nesting.');
  check(m.tiltedText <= 5, `${m.tiltedText}% of the text is set at a tilt (bar: 5% or less)`, 'Set text straight.');
  check(m.vividGround <= 20, `${m.vividGround}% of the page's height lies on a saturated ground (bar: 20% or less)`, 'Rest the page on a quiet neutral ground.');
  check(!m.bareType, 'bare browser defaults or >960px-wide unmeasured body paragraphs', 'Set an explicit font stack, page margins (>= 24px desktop), and 50–75ch max-width on reading paragraphs.');
  const summary = `${m.sizes} sizes, body ${m.body}px/${m.lineHeight}, ${m.boxedText}% boxed, type: ${m.families.join(', ') || 'none found'}`;
  return outside.length ? `${outside.join('\n')}\nSummary: ${summary}.` : `All design bars met (${summary}).`;
}
