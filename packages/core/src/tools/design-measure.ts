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
}

/** Runs in the page: what the report needs, from visible elements' computed styles. */
export const MEASURE_SCRIPT = String.raw`(() => {
  const W = innerWidth, FOLD = innerHeight, H = document.documentElement.scrollHeight;
  const shown = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  // Any CSS colour as sRGB bytes and an alpha, read back from a canvas: computed styles keep the author's colour space (oklch), so the numbers in the string are not RGB.
  const cx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true }), read = new Map();
  const rgba = (c) => { if (!read.has(c)) { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; read.set(c, [d[0], d[1], d[2], d[3] / 255]); } return read.get(c); };
  const rgb = (c) => { const v = c ? rgba(c) : null; return v && v[3] >= 0.05 ? v.slice(0, 3) : null; };
  const sat = ([r, g, b]) => { const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, l = (mx + mn) / 2; return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); };
  const key = (c) => c.map((v) => Math.round(v / 16)).join(',');
  const sizes = {}, fams = {}, colours = new Set(), lines = [], texts = [], all = [];
  let chars = 0, han = 0, labels = 0, gradients = 0, blurs = 0, emoji = 0, fold = 0, picture = 0, boxes = 0, pills = 0;
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
    if (/gradient\(/.test(s.backgroundImage) && area > 2000) gradients++;
    if (/blur/.test(s.backdropFilter || '') || /blur/.test(s.filter)) blurs++;
    if ((bg || parseFloat(s.borderTopWidth) > 0) && area > 2000 && r.width < W * 0.9) {
      boxes++;
      const rad = parseFloat(s.borderTopLeftRadius);
      if (rad >= 999 || rad >= r.height / 2 - 1) pills++;
    }
    const mono = /mono|courier|consolas/i.test(s.fontFamily);
    if (/^(IMG|PICTURE|VIDEO|CANVAS)$/.test(el.tagName) || (el.tagName === 'svg' && area > 40000) || (/url\(/.test(s.backgroundImage) && area > 40000) || (el.tagName === 'PRE' && mono && area > 40000 && !el.closest('code'))) picture += Math.min(r.width, W) * Math.min(r.height, 2000);
  }
  // The fill an element shows, its see-through layers laid over what is behind it down to the page.
  const far = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const lay = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
  const fillOf = (el) => { const c = rgba(getComputedStyle(el).backgroundColor); return c[3] > 0.05 ? c : null; };
  const page = [document.documentElement, document.body].reduce((c, el) => { const f = fillOf(el); return f ? lay(f, c) : c; }, [255, 255, 255]);
  const behind = (el) => { const stack = []; for (let p = el.parentElement; p; p = p.parentElement) { const c = fillOf(p); if (c) { stack.push(c); if (c[3] > 0.95) break; } } return stack.reverse().reduce((c, f) => lay(f, c), page); };
  const shows = (el) => { const c = fillOf(el); return c ? lay(c, behind(el)) : null; };
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
  const order = Object.entries(sizes).sort((a, b) => b[1] - a[1]);
  const body = +(order[0] || [16])[0];
  let cum = 0, used = 0;
  for (const [, v] of order) { if (cum >= chars * 0.95) break; cum += v; used++; }
  const atBody = lines.filter((l) => l[0] === body);
  return {
    sizes: used, body, scale: Math.round(10 * Math.max(body, ...lines.map((l) => l[0])) / body) / 10,
    lineHeight: Math.round(100 * atBody.reduce((a, l) => a + l[1], 0) / (atBody.length || 1)) / 100,
    cjk: han > chars * 0.3, saturated: colours.size, labels, pillShare: boxes ? Math.round(100 * pills / boxes) : 0,
    gradients, blurs, emoji, foldWords: Math.round(fold), pictureShare: Math.round(100 * picture / (W * H)),
    families: Object.entries(fams).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f),
    height: Math.round(H), groundChanges: Math.max(0, grounds - 1), groundColours: kinds.length, boxedText: chars ? Math.round(100 * boxed / chars) : 0, tiltedText: chars ? Math.round(100 * tilted / chars) : 0,
    vividGround: Math.round(100 * vivid / (rows.length || 1)),
  };
})()`;

/** The numbers, each beside its bar, and what is outside the bar first. */
export function designReport(m: DesignMeasure): string {
  const out: string[] = [];
  const check = (ok: boolean, line: string, fix: string) => (ok ? out.push(`- ${line}`) : out.unshift(`- OUTSIDE THE BAR: ${line}. ${fix}`));
  check(m.sizes <= 5, `${m.sizes} font sizes carry 95% of the text (bar: 5 or fewer)`, 'Fold the sizes into one scale of five.');
  const bodyLow = m.cjk ? 15 : 16;
  check(m.body >= bodyLow && m.body <= 20, `body ${m.body}px (bar: ${bodyLow} to 20)`, 'Set the body on the scale, larger rather than smaller.');
  check(m.scale <= 6, `the largest type is ${m.scale} times the body (bar: 2.5 to 6)`, 'Bring the largest size down: brand sites hold it near 3 to 5 times the body.');
  const [lo, hi] = m.cjk ? [1.6, 1.85] : [1.3, 1.55];
  check(m.lineHeight >= lo && m.lineHeight <= hi, `body line height ${m.lineHeight} (bar for ${m.cjk ? 'Chinese' : 'Latin'} text: ${lo} to ${hi})`, 'Set the body line height inside the bar.');
  check(m.saturated <= 2, `${m.saturated} saturated colours (bar: 2 or fewer)`, 'Keep one accent; the rest are neutrals and the colours of the pictures.');
  check(m.labels <= 1, `${m.labels} small letter-spaced capital labels (bar: none)`, 'Take them out: the heading says it.');
  check(m.pillShare <= 10, `${m.pillShare}% of boxes are pill-shaped (bar: 10% or less)`, 'Square the corners to 0 to 8px.');
  check(m.gradients === 0, `${m.gradients} gradients (bar: none)`, 'Flat fields of colour instead.');
  check(m.blurs === 0, `${m.blurs} blurred or frosted layers (bar: none)`, 'Take the blur off.');
  check(m.emoji === 0, `${m.emoji} emoji (bar: none)`, 'Words or drawn marks instead.');
  // The clean sites' median is 39 words and the wordiest of them 58; agents wrote 100 and more.
  const foldBar = 50;
  check(m.foldWords <= foldBar, `${m.foldWords} words on the first screen, a Chinese character counted as half a word (bar: ${foldBar} or fewer)`, 'Say one thing on the first screen; the rest goes lower.');
  // One change for every 1200px passes all eleven sites and fails eleven of Favilla's fifteen pages.
  const changes = Math.max(1, Math.floor(m.height / 1200));
  check(m.groundChanges <= changes, `the ground behind the page changes colour ${m.groundChanges} times in ${m.height}px (bar: ${changes} or fewer, one for every 1200px at most)`, 'Keep one ground through the page and part its sections with space, type and pictures. Change the ground where the page turns, once or twice, never section by section.');
  // Nine of the eleven sites have three grounds or fewer and the two with four are over 8000px tall; pages whose
  // sections each took a colour of their own have five.
  const kinds = m.height > 6000 ? 4 : 3;
  check(m.groundColours <= kinds, `the page has ${m.groundColours} different grounds (bar: ${kinds} or fewer)`, 'Two grounds carry a page and a third marks its one turn: give every other section one of those.');
  // A screen people work in is one or two screens tall and made of panels: the bar is for a page that is read.
  const boxes = `${m.boxedText}% of the text sits inside a box (a border, a shadow or a fill of its own)`;
  if (m.height > 2000) check(m.boxedText <= 35, `${boxes} (bar: 35% or less)`, 'Take the boxes off: prices, quotes, steps and questions are type on the ground with space between them. A box drawn as a note, a ticket or a form sheet is still a box.');
  else out.push(`- ${boxes} (a page that is read: 35% or less; a screen people work in keeps its panels)`);
  check(m.tiltedText <= 5, `${m.tiltedText}% of the text is set at a tilt (bar: 5% or less)`, 'Set it straight. A tilt is for one picture at most, never for text people read.');
  // None of the eleven sites has any; three of the fifteen pages had a third of their height or more on one.
  check(m.vividGround <= 20, `${m.vividGround}% of the page's height lies on a saturated ground (bar: 20% or less)`, 'A strong colour is the accent or the field of one section. Rest the page on a quiet ground (a light or dark neutral, or a pale or deep tone of that colour) and keep the strong one for the place where the page turns.');
  out.push(`- pictures cover ${m.pictureShare}% of the page's area (brand landing pages: half or more; a screen people work in needs none)`);
  out.push(`- type: ${m.families.join(', ') || 'none found'}`);
  return out.join('\n');
}
