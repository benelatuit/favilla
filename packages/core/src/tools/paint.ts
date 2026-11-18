import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ImagePart } from '../types';
import { assetsDir, displayPath, resolvePath } from '../util/paths';
import { scratchDir } from '../prompt/system';
import type { ToolContext, ToolDef, ToolOutput } from './types';
import { imageSize } from './image';

export interface PaintInput {
  /** The painting Favilla keeps between calls, by name, outside the project. */
  canvas?: string;
  /** A whole document (YAML or JSON): starts the canvas over with it. */
  doc?: string;
  /** The layer `items` go on; made on top when it is new. */
  layer?: string;
  /** Place this layer immediately below another named layer. */
  below?: string;
  /** New items for `layer` (a YAML or JSON list, or the list itself). */
  items?: string | unknown[];
  /** add (default): after the layer's items. replace: instead of them. */
  mode?: 'add' | 'replace';
  /** The layer's blend, opacity and clip, when they are given. */
  blend?: string;
  opacity?: number;
  clip?: string;
  /** Picture settings to change (YAML, JSON or an object): size, paper, background, seed, tile, adjust, symbols. */
  set?: string | Record<string, unknown>;
  /** Layers by name, or items by number ("#12"), to take out. */
  remove?: string[];
  /** Go back this many changes. */
  undo?: number;
  /** Where the picture goes; kept for later calls. Without it the picture stays beside the canvas, outside the project. */
  out?: string;
  /** A part of the picture to see enlarged: [x, y, width, height]. */
  look?: number[];
  /** A document file of the project, painted as it is (written first when doc is given). */
  path?: string;
  /** A picture file to cut out of its ground in one call, with no canvas or document: written to `out`. */
  cut?: string;
  /** With cut: the ground to take away, "auto" (the colour its border shares, the default) or a colour. */
  key?: string;
  tolerance?: number;
  soft?: number;
  /** With cut: false also takes the key out of holes inside the subject. */
  flood?: boolean;
  /** With cut: crop to what is left, with a margin of two pixels. */
  trim?: boolean;
  /** With cut: fit what is left into [width, height], centred on a clear ground (an icon, a favicon). */
  size?: number[];
}

/** What Favilla keeps of a canvas: the document, the changes it can go back through, and where the picture goes. */
interface CanvasState {
  doc: PaintDoc;
  history: PaintDoc[];
  out?: string;
  nextId: number;
}
const HISTORY = 20;

const err = (content: string): ToolOutput => ({ content, isError: true });
const MAX_SIDE = 4096;
const MAX_PIXELS = 12_000_000;
const MAX_IMAGE = 25 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

let engine: string | null = null;
const engineScript = () => (engine ??= fs.readFileSync(path.join(assetsDir(), 'paint', 'engine.js'), 'utf8'));

interface PaintLayer {
  name?: string;
  blend?: string;
  opacity?: number;
  clip?: string;
  items?: Record<string, unknown>[];
}

interface PaintDoc {
  size?: [number, number];
  tile?: boolean;
  layers?: PaintLayer[];
  [k: string]: unknown;
}

const canvasFile = (cwd: string, name: string) => path.join(scratchDir(cwd), 'paint', `${name}.json`);

function loadCanvas(file: string): CanvasState | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CanvasState;
  } catch {
    return null;
  }
}

/** YAML or JSON text, or the value itself when a model passed it unquoted. */
function parsed<T>(v: string | T): T {
  return typeof v === 'string' ? (parseYaml(v) as T) : v;
}

/** Numbers for the items that lack one, so a later call can take one out by "#n". */
function numberItems(items: Record<string, unknown>[], state: CanvasState): { first: number; last: number } {
  const first = state.nextId;
  for (const it of items) {
    if (it && typeof it === 'object' && it.id === undefined) it.id = state.nextId++;
  }
  return { first, last: state.nextId - 1 };
}

/** The change a call asks for, made on the canvas; a message when it cannot be. */
function change(input: PaintInput, state: CanvasState | null): { state: CanvasState; added?: string } | { error: string } {
  const was = state ? (JSON.parse(JSON.stringify(state.doc)) as PaintDoc) : null;
  let next: CanvasState = state ?? { doc: {}, history: [], nextId: 1 };
  let touched = false;
  let added: string | undefined;
  if (input.below !== undefined && (!input.layer || !input.below || input.below === input.layer || input.undo))
    return { error: 'below needs a layer and a different named layer above it.' };
  if (input.undo) {
    if (!state?.history.length) return { error: 'There is nothing to go back to on this canvas.' };
    const steps = Math.min(Math.max(1, Math.round(input.undo)), state.history.length);
    next = { ...state, doc: state.history[state.history.length - steps], history: state.history.slice(0, -steps) };
    return { state: next };
  }
  try {
    if (input.doc !== undefined) {
      const doc = parsed<PaintDoc>(input.doc);
      if (!doc || typeof doc !== 'object') return { error: 'doc holds no document.' };
      next = { ...next, doc };
      for (const l of doc.layers ?? []) numberItems(l.items ?? [], next);
      touched = true;
    }
    if (input.set !== undefined) {
      const set = parsed<Record<string, unknown>>(input.set);
      if (!set || typeof set !== 'object') return { error: 'set holds no settings.' };
      next = { ...next, doc: { ...next.doc, ...set } };
      touched = true;
    }
    if (input.remove?.length) {
      const doc = next.doc;
      for (const what of input.remove) {
        const id = /^#(\d+)$/.exec(what)?.[1];
        if (id) {
          let hit = false;
          for (const l of doc.layers ?? []) {
            const left = (l.items ?? []).filter((it) => String(it.id) !== id);
            if (left.length !== (l.items ?? []).length) hit = true;
            l.items = left;
          }
          if (!hit) return { error: `No item ${what} on this canvas.` };
        } else {
          const left = (doc.layers ?? []).filter((l) => l.name !== what);
          if (left.length === (doc.layers ?? []).length) return { error: `No layer "${what}" on this canvas; it has ${(doc.layers ?? []).map((l) => l.name ?? '(unnamed)').join(', ') || 'none'}.` };
          doc.layers = left;
        }
      }
      touched = true;
    }
    if (input.layer !== undefined || input.items !== undefined) {
      const name = input.layer ?? 'main';
      const doc = next.doc;
      doc.layers ??= [];
      let layer = doc.layers.find((l) => l.name === name);
      if (!layer) {
        layer = { name, items: [] };
        doc.layers.push(layer);
      }
      if (input.below !== undefined) {
        const above = doc.layers.find(l => l.name === input.below);
        if (!above) return { error: `No layer "${input.below}" to place "${name}" below.` };
        doc.layers.splice(doc.layers.indexOf(layer), 1);
        doc.layers.splice(doc.layers.indexOf(above), 0, layer);
      }
      if (input.blend !== undefined) layer.blend = input.blend;
      if (input.opacity !== undefined) layer.opacity = input.opacity;
      if (input.clip !== undefined) layer.clip = input.clip;
      const items = input.items === undefined ? [] : parsed<Record<string, unknown>[]>(input.items as string | Record<string, unknown>[]);
      if (!Array.isArray(items)) return { error: 'items is a list of items.' };
      if (input.mode === 'replace') layer.items = [];
      const { first, last } = numberItems(items, next);
      layer.items = [...(layer.items ?? []), ...items];
      if (items.length) added = `${items.length} on layer ${name}${last >= first ? ` (#${first}-#${last})` : ''}`;
      touched = true;
    }
  } catch (e) {
    return { error: `That does not read as YAML or JSON: ${(e as Error).message.split('\n')[0]}` };
  }
  if (touched && was) next = { ...next, history: [...next.history, was].slice(-HISTORY) };
  return { state: next, added };
}

/** The picture with a grid every 50 px (labelled every 100) to place marks by, and for a tile four copies side by side. */
function reviewPage(png: string, w: number, h: number, tile: boolean): { html: string; width: number; height: number } {
  const lines: string[] = [];
  for (let x = 50; x < w; x += 50) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" class="${x % 100 ? 'minor' : 'major'}"/>`);
  for (let y = 50; y < h; y += 50) lines.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" class="${y % 100 ? 'minor' : 'major'}"/>`);
  const labels: string[] = [];
  for (let x = 100; x < w; x += 100) labels.push(`<text x="${x + 3}" y="12">${x}</text>`);
  for (let y = 100; y < h; y += 100) labels.push(`<text x="3" y="${y - 3}">${y}</text>`);
  const repeat = tile ? `<div class="tile" style="width:${w * 2}px;height:${h * 2}px;background:url(${png}) 0 0/${w}px ${h}px repeat"></div>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#e9ebed;font:11px ui-monospace,Consolas,monospace;display:flex;gap:20px;padding:20px;align-items:flex-start}
.pic{position:relative;width:${w}px;height:${h}px;background:repeating-conic-gradient(#d9dcdf 0 25%,#f4f5f6 0 50%) 0 0/16px 16px;box-shadow:0 0 0 1px #9aa1a8}
.pic img,.pic svg{position:absolute;inset:0}
line{stroke-width:1}.minor{stroke:rgba(20,90,200,.12)}.major{stroke:rgba(20,90,200,.32)}
text{fill:rgba(20,70,170,.8)}
.tile{box-shadow:0 0 0 1px #9aa1a8}
</style></head><body><div class="pic"><img src="${png}" width="${w}" height="${h}"><svg width="${w}" height="${h}">${lines.join('')}${labels.join('')}</svg></div>${repeat}</body></html>`;
  return { html, width: w + 40 + (tile ? w * 2 + 20 : 0), height: Math.max(h, tile ? h * 2 : 0) + 40 };
}

/** A cutout on white, on near-black and on a checkerboard: a fringe of the old ground or a hole shows on one of them. */
function cutSheet(png: string, w: number, h: number): { html: string; width: number; height: number } {
  const k = Math.min(1, 420 / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k));
  const H = Math.max(1, Math.round(h * k));
  const cell = (ground: string) => `<div style="width:${W}px;height:${H}px;background:${ground};box-shadow:0 0 0 1px #9aa1a8"><img src="${png}" width="${W}" height="${H}"></div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#e9ebed;display:flex;gap:20px;padding:20px;align-items:flex-start}img{display:block}</style></head><body>${cell('#ffffff')}${cell('#16181b')}${cell('repeating-conic-gradient(#d9dcdf 0 25%,#f4f5f6 0 50%) 0 0/16px 16px')}</body></html>`;
  return { html, width: W * 3 + 80, height: H + 40 };
}

/** Crops a picture to its pixels that are not clear, two pixels round them: window.__trim(dataUrl) gives {png, box}. */
const TRIM_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.__trim = async (url) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (d[(y * c.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return {};
  x0 = Math.max(0, x0 - 2);
  y0 = Math.max(0, y0 - 2);
  x1 = Math.min(c.width - 1, x1 + 2);
  y1 = Math.min(c.height - 1, y1 + 2);
  const o = document.createElement('canvas');
  o.width = x1 - x0 + 1;
  o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return { png: o.toDataURL('image/png'), box: [x0, y0, o.width, o.height] };
};
window.__stats = async (url, key) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, H = c.height;
  let opaque = 0, clear = 0, fringe = 0, uncut = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  const keyDist = (i) => {
    if (!Array.isArray(key)) return 999;
    const r = d[i], gr = d[i + 1], b = d[i + 2];
    const s = r + gr + b, ks = key[0] + key[1] + key[2];
    return s < 45 || ks < 45
      ? Math.hypot(r - key[0], gr - key[1], b - key[2])
      : Math.hypot(r / s - key[0] / ks, gr / s - key[1] / ks, b / s - key[2] / ks) * 706.7 + (Math.abs(s - ks) / 3) * 0.35;
  };
  const nearClear = (x, y) => {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || d[(ny * W + nx) * 4 + 3] < 10) return true;
    }
    return false;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = d[i + 3];
      if (a > 200) opaque++;
      if (a < 10) clear++;
      else {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (Array.isArray(key)) {
          const kd = keyDist(i);
          if ((a < 250 || nearClear(x, y)) && kd < 75) fringe++;
          else if (a >= 200 && !nearClear(x, y) && kd < 45) uncut++;
        }
      }
    }
  const n = W * H;
  const at = (x, y) => d[(y * W + x) * 4 + 3];
  const corners = [at(0, 0), at(W - 1, 0), at(0, H - 1), at(W - 1, H - 1)].filter((a) => a < 10).length;
  return { opaque: opaque / n, clear: clear / n, box: x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1], corners, fringe: Array.isArray(key) ? fringe : undefined, uncut: Array.isArray(key) ? uncut : undefined };
};
window.__fit = async (url, W, H) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  // Halved step by step down to twice the size, then drawn once: one big step down leaves jagged edges.
  let src = img;
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const k = Math.min(W / w, H / h);
  const tw = w * k;
  const th = h * k;
  while (w > tw * 2 && h > th * 2) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w / 2));
    c.height = Math.max(1, Math.round(h / 2));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    src = c;
    w = c.width;
    h = c.height;
  }
  const fw = Math.max(1, Math.round(img.naturalWidth * k));
  const fh = Math.max(1, Math.round(img.naturalHeight * k));
  const o = document.createElement('canvas');
  o.width = W;
  o.height = H;
  const g = o.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, Math.round((W - fw) / 2), Math.round((H - fh) / 2), fw, fh);
  return { png: o.toDataURL('image/png') };
};
</script></body></html>`;

/** A part of the picture enlarged, for looking at fine work: at most three times, on a page of about 900 px. */
function lookPage(png: string, W: number, H: number, box: number[]): { html: string; width: number; height: number; zoom: number } {
  const x = Math.max(0, Math.min(W - 1, Math.round(box[0])));
  const y = Math.max(0, Math.min(H - 1, Math.round(box[1])));
  const w = Math.max(8, Math.min(W - x, Math.round(box[2])));
  const h = Math.max(8, Math.min(H - y, Math.round(box[3])));
  const zoom = Math.max(1, Math.min(3, 900 / Math.max(w, h)));
  const width = Math.round(w * zoom);
  const height = Math.round(h * zoom);
  const html = `<!doctype html><html><body style="margin:0"><div style="width:${width}px;height:${height}px;background:url(${png}) ${-x * zoom}px ${-y * zoom}px/${W * zoom}px ${H * zoom}px no-repeat"></div></body></html>`;
  return { html, width, height, zoom };
}

/** Pictures the model can see: only when it takes images. */
function shown(ctx: ToolContext, images: ImagePart[]): ImagePart[] | undefined {
  return ctx.model.vision && images.length ? images : undefined;
}

export const paintTool: ToolDef<PaintInput> = {
  kind: 'draw',
  readOnly: false,
  title: (i, cwd) => `Paint ${i.path ? displayPath(cwd, resolvePath(cwd, i.path)) : (i.canvas ?? 'painting')}`,
  async execute(input, ctx) {
    let doc: PaintDoc;
    let base = ctx.cwd;
    let outAbs: string;
    let label: string;
    let summary = '';
    let cutting = false;
    if (input.cut) {
      // One call takes a picture's ground away: no canvas is kept, and nothing lands in the project but the cutout,
      // where out says (beside the canvases otherwise). Models without it wrote scripts of their own to do this.
      const src = resolvePath(ctx.cwd, input.cut);
      const shownSrc = displayPath(ctx.cwd, src);
      if (!MIME[path.extname(src).toLowerCase()]) return err(`${shownSrc}: a picture to cut out is a PNG, JPEG, WebP, GIF or BMP file.`);
      if (!fs.existsSync(src)) return err(`${shownSrc} was not found.`);
      if (fs.statSync(src).size > MAX_IMAGE) return err(`${shownSrc} is over ${MAX_IMAGE / 1024 / 1024} MB.`);
      const dims = imageSize(fs.readFileSync(src));
      if (!dims) return err(`${shownSrc}: its size could not be read.`);
      const item: Record<string, unknown> = { image: src, fit: 'stretch', key: input.key ?? 'auto' };
      if (input.tolerance !== undefined) item.tolerance = input.tolerance;
      if (input.soft !== undefined) item.soft = input.soft;
      if (input.flood !== undefined) item.flood = input.flood;
      doc = { size: [dims.width, dims.height], paper: { type: 'none' }, layers: [{ name: 'cut', items: [item] }] };
      outAbs = input.out ? resolvePath(ctx.cwd, input.out) : path.join(scratchDir(ctx.cwd), 'paint', `${path.basename(src).replace(/\.\w+$/, '')}-cut.png`);
      label = `the ground out of ${shownSrc}`;
      cutting = true;
    } else if (input.path) {
      // A document file of the project.
      const abs = resolvePath(ctx.cwd, input.path);
      const shownPath = displayPath(ctx.cwd, abs);
      if (!/\.(ya?ml|json)$/i.test(abs)) return err(`${shownPath}: a painting is a .paint.yaml (or .yaml, .json) document.`);
      if (input.doc !== undefined) {
        const why = fs.existsSync(abs) ? (ctx.mayChange?.(abs) ?? ctx.files.checkEditable(abs)) : undefined;
        if (why) return err(`${shownPath} already exists. ${why}`);
        ctx.checkpoints.capture(ctx.turn, abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, input.doc);
        ctx.files.recordWrite(abs);
      }
      if (!fs.existsSync(abs)) return err(`${shownPath} does not exist; give doc to write it.`);
      try {
        doc = parseYaml(fs.readFileSync(abs, 'utf8')) as PaintDoc;
      } catch (e) {
        return err(`${shownPath} does not read as YAML or JSON: ${(e as Error).message.split('\n')[0]}`);
      }
      if (!doc || typeof doc !== 'object') return err(`${shownPath} holds no document.`);
      base = path.dirname(abs);
      outAbs = resolvePath(ctx.cwd, input.out ?? abs.replace(/(\.paint)?\.(ya?ml|json)$/i, '.png'));
      label = shownPath;
    } else {
      // A canvas Favilla keeps: nothing lands in the project but the picture, and only where `out` says.
      const name = (input.canvas ?? 'painting').trim().replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'painting';
      const file = canvasFile(ctx.cwd, name);
      const state = loadCanvas(file);
      const r = change(input, state);
      if ('error' in r) return err(r.error);
      doc = r.state.doc;
      if (!doc.size && !doc.layers) return err(`The canvas "${name}" is empty: start it with doc, or with set (size, paper) and items on a layer.`);
      if (input.out) r.state.out = input.out;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(r.state));
      outAbs = r.state.out ? resolvePath(ctx.cwd, r.state.out) : file.replace(/\.json$/, '.png');
      label = `canvas ${name}`;
      const layers = (doc.layers ?? []).map((l) => `${l.name ?? '(unnamed)'} ${(l.items ?? []).length}`).join(', ');
      summary = ` Layers: ${layers || 'none'}.${r.added ? ` Added ${r.added}.` : ''}`;
    }
    const [w, h] = Array.isArray(doc.size) ? doc.size.map(Number) : [1024, 768];
    if (!(w >= 8 && h >= 8 && w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_PIXELS)) return err(`A painting of ${w}×${h} is outside 8 to ${MAX_SIDE} pixels a side or ${MAX_PIXELS / 1e6} million pixels.`);
    const size: [number, number] = [Math.round(w), Math.round(h)];
    // Pictures to paint over or retouch go into the page as data: the page cannot read files.
    const send: PaintDoc = { ...doc, size, layers: (doc.layers ?? []).map((l) => ({ ...l, items: [...(l.items ?? [])] })) };
    for (const layer of send.layers ?? []) {
      for (const [i, item] of (layer.items ?? []).entries()) {
        if (typeof item.image !== 'string') continue;
        const file = path.resolve(base, item.image);
        const mime = MIME[path.extname(file).toLowerCase()];
        if (!mime) return err(`${item.image}: a picture to paint with is a PNG, JPEG, WebP, GIF or BMP file.`);
        if (!fs.existsSync(file)) return err(`${item.image} was not found (looked at ${displayPath(ctx.cwd, file)}).`);
        if (fs.statSync(file).size > MAX_IMAGE) return err(`${item.image} is over ${MAX_IMAGE / 1024 / 1024} MB.`);
        layer.items![i] = { ...item, src: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` };
      }
    }
    const browser = ctx.browser?.();
    if (!browser) return err('Painting needs Chrome, Chromium or Edge, and none was found (Settings > Tools sets its path).');
    const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${engineScript()}</script></body></html>`;
    interface PaintStats {
      markPct: number;
      markBox: [number, number, number, number] | null;
      lumMean: number;
      lumRange: [number, number];
      grid: [number, number][];
      seam: { x: number; innerX: number; y: number; innerY: number } | null;
    }
    let painted: { png?: string; notes?: string[]; error?: string; stats?: PaintStats; cutKey?: [number, number, number] | null } | undefined;
    try {
      const run = await browser.paint(page, { width: 32, height: 32, probe: `window.__paint(${JSON.stringify(send)}).catch((e) => ({ error: String((e && e.stack) || e) }))` });
      painted = run.probe as typeof painted;
    } catch (e) {
      return err(`Painting ${label} failed: ${(e as Error).message}`);
    }
    if (!painted?.png) return err(`Painting ${label} failed: ${(painted?.error ?? 'no picture came back').slice(0, 600)}`);
    let png = Buffer.from(painted.png.slice(painted.png.indexOf(',') + 1), 'base64');
    // trim: the cutout cropped to what is left, two pixels round it, in the same page the engine ran in.
    let trimmed = '';
    if (cutting && input.trim) {
      try {
        const run = await browser.paint(TRIM_PAGE, { width: 32, height: 32, probe: `window.__trim(${JSON.stringify(painted.png)})` });
        const got = run.probe as { png?: string; box?: number[] } | undefined;
        if (got?.png && got.box) {
          png = Buffer.from(got.png.slice(got.png.indexOf(',') + 1), 'base64');
          trimmed = ` Trimmed to ${got.box[2]}×${got.box[3]} from ${size[0]}×${size[1]} (at ${got.box[0]}, ${got.box[1]}).`;
        } else trimmed = ' Nothing was left to trim to: the whole picture was taken as ground; try a lower tolerance or another key.';
      } catch {
        trimmed = ' The trim failed; the cutout is untrimmed.';
      }
    }
    let fitted = '';
    if (cutting && input.size?.length === 2) {
      const [W, H] = input.size.map((n) => Math.round(Number(n)));
      if (W >= 8 && H >= 8 && W <= MAX_SIDE && H <= MAX_SIDE) {
        try {
          const run = await browser.paint(TRIM_PAGE, { width: 32, height: 32, probe: `window.__fit(${JSON.stringify(`data:image/png;base64,${png.toString('base64')}`)}, ${W}, ${H})` });
          const got = run.probe as { png?: string } | undefined;
          if (got?.png) {
            png = Buffer.from(got.png.slice(got.png.indexOf(',') + 1), 'base64');
            fitted = ` Fitted into ${W}×${H}, centred on a clear ground.`;
          }
        } catch {
          fitted = ' The fit failed; the cutout keeps its own size.';
        }
      } else fitted = ` size is 8 to ${MAX_SIDE} pixels a side; the cutout keeps its own size.`;
    }
    const shownSize = imageSize(png) ?? { width: size[0], height: size[1] };
    const outShown = displayPath(ctx.cwd, outAbs);
    ctx.checkpoints.capture(ctx.turn, outAbs);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, png);
    ctx.files.recordWrite(outAbs);
    const picture: ImagePart = { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: path.basename(outAbs) };
    const images: ImagePart[] = [picture];
    const url = `data:image/png;base64,${picture.data}`;
    let looked = '';
    if (ctx.model.vision) {
      try {
        const sheet = cutting ? cutSheet(url, shownSize.width, shownSize.height) : reviewPage(url, size[0], size[1], !!doc.tile);
        const review = await browser.paint(sheet.html, { width: sheet.width, height: sheet.height });
        images.push({ type: 'image', mediaType: 'image/png', data: review.png.toString('base64'), name: `${path.basename(outAbs)} review` });
      } catch {
        // The picture stands without its check sheet.
      }
      if (input.look?.length === 4) {
        try {
          const part = lookPage(url, shownSize.width, shownSize.height, input.look);
          const shot = await browser.paint(part.html, { width: part.width, height: part.height });
          images.push({ type: 'image', mediaType: 'image/png', data: shot.png.toString('base64'), name: `${path.basename(outAbs)} look` });
          looked = ` The part you asked for is attached too, ${part.zoom.toFixed(1)} times larger.`;
        } catch {
          // The picture stands without the enlarged part.
        }
      }
    }
    const notes = painted.notes?.length ? `\n${painted.notes.join('\n')}` : '';
    if (cutting) {
      const where = input.out ? '' : ' It is beside the canvases, outside the project: give out to put it where the project keeps pictures.';
      // The cutout in numbers, so a model that cannot see it has no need of a script of its own to measure it.
      let measured = '';
      try {
        const run = await browser.paint(TRIM_PAGE, { width: 32, height: 32, probe: `window.__stats(${JSON.stringify(url)}, ${JSON.stringify(painted.cutKey ?? null)})` });
        const m = run.probe as { opaque: number; clear: number; box: number[] | null; corners: number; fringe?: number; uncut?: number } | undefined;
        if (m) {
          const fringeNote = typeof m.fringe === 'number' ? `, ${m.fringe} key-fringe px${m.uncut && m.uncut > 20 ? `, ${m.uncut} interior key px (use flood: false for holes)` : ''}` : '';
          measured = ` Measured: ${Math.round(m.opaque * 100)}% opaque, ${Math.round(m.clear * 100)}% clear, ${m.corners} of 4 corners clear, ${m.box ? `what is left spans ${m.box[2]}×${m.box[3]} at ${m.box[0]}, ${m.box[1]}${fringeNote}` : 'nothing is left'}.`;
        }
      } catch {
        // The cutout stands without its numbers.
      }
      const seenCut = ctx.model.vision ? ` The cutout and a sheet of it on white, on near-black and on a checkerboard are attached: a fringe of the old ground or a hole in the subject shows on one of them. If so, cut again with another tolerance, soft or key.${looked}` : '';
      return {
        content: `Cut ${label} into ${outShown} (${shownSize.width}×${shownSize.height}).${trimmed}${fitted}${measured}${where}${seenCut}${notes}`,
        images: shown(ctx, images),
        display: { kind: 'file', path: outShown, startLine: 1, lineCount: 0, totalLines: 0, preview: '', image: true, size: [shownSize.width, shownSize.height] },
      };
    }
    const s = painted.stats;
    const blind = !ctx.model.vision && s
      ? (() => {
          const box = s.markBox ? `bbox ${s.markBox[0]},${s.markBox[1]} ${s.markBox[2]}×${s.markBox[3]}` : 'no marks';
          const seam = s.seam ? `, seam ΔRGB ${s.seam.x}/${s.seam.y} vs interior ${s.seam.innerX}/${s.seam.innerY}` : '';
          const cells = ['TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR'].map((n, i) => `${n} ${s.grid[i][0]}/${s.grid[i][1]}`);
          return `\nMeasured: ${s.markPct}% marked (${box}), lum ${s.lumRange[0]}–${s.lumRange[1]}% (mean ${s.lumMean}%)${seam}.\n3×3 lum%/mark%: ${cells.slice(0, 3).join(' ')} | ${cells.slice(3, 6).join(' ')} | ${cells.slice(6, 9).join(' ')}.`;
        })()
      : '';
    const seen = ctx.model.vision ? ` The picture and a check sheet (a grid every 50 px, labelled every 100${doc.tile ? ', and the tile repeated 2×2 to show its seams' : ''}) are attached.${looked} Change only what needs it: items on a layer, replace, remove, undo.` : '';
    return {
      content: `Painted ${label} into ${outShown} (${size[0]}×${size[1]}).${summary}${seen}${blind}${notes}`,
      images: shown(ctx, images),
      display: { kind: 'file', path: outShown, startLine: 1, lineCount: 0, totalLines: 0, preview: '', image: true, size },
    };
  },
};
