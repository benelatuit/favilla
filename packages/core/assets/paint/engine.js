// Favilla's painting engine, run in a page by the paint tool: window.__paint(doc) paints the document into a canvas
// and returns { png, notes }. Media behave as they do on paper: graphite and chalk catch the paper's tooth, ink is
// crisp and tapers, markers stay flat and darken where they overlap, watercolour spreads, pools at its edges and
// granulates, gouache and oil cover, bristles streak. Procedural fills (hatching, scribbles, stipple, splatter,
// washes) give hand-made texture without plotting every mark; tile mode makes textures that repeat seamlessly.
(() => {
  'use strict';

  // ---------- random numbers and noise ----------

  function rng(seed) {
    let a = seed >>> 0 || 1;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Smooth gradient noise in [0, 1]; with a period it wraps, so textures made from it tile. Gradient noise, not
   * value noise: value noise shows its grid as blocks, which read as pixels in paper and washes.
   */
  function noise2(seed) {
    const r = rng(seed);
    const perm = new Uint16Array(512);
    const gx = new Float32Array(256);
    const gy = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      perm[i] = i;
      const a = r() * Math.PI * 2;
      gx[i] = Math.cos(a);
      gy[i] = Math.sin(a);
    }
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    return (x, y, px = 0, py = 0) => {
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const wx = (v) => (px ? ((v % px) + px) % px : v) & 255;
      const wy = (v) => (py ? ((v % py) + py) % py : v) & 255;
      const dot = (ix, iy, dx, dy) => {
        const h = perm[wx(ix) + perm[wy(iy)]];
        return gx[h] * dx + gy[h] * dy;
      };
      const u = fade(fx);
      const v = fade(fy);
      const n00 = dot(x0, y0, fx, fy);
      const n10 = dot(x0 + 1, y0, fx - 1, fy);
      const n01 = dot(x0, y0 + 1, fx, fy - 1);
      const n11 = dot(x0 + 1, y0 + 1, fx - 1, fy - 1);
      const nx0 = n00 + (n10 - n00) * u;
      const nx1 = n01 + (n11 - n01) * u;
      // Gradient noise lies within about ±0.7: spread to [0, 1].
      return clamp(0.5 + (nx0 + (nx1 - nx0) * v) * 0.72);
    };
  }

  /** Fractal sum of noise octaves at a base cell size (px); periodic over w×h when tiling. */
  function fbm(n, x, y, cell, octaves, w, h, tile) {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let f = 1 / cell;
    for (let o = 0; o < octaves; o++) {
      const px = tile ? Math.max(1, Math.round(w * f)) : 0;
      const py = tile ? Math.max(1, Math.round(h * f)) : 0;
      sum += amp * n(x * (tile ? px / w : f), y * (tile ? py / h : f), px, py);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, v) => {
    const t = clamp((v - a) / (b - a));
    return t * t * (3 - 2 * t);
  };

  // ---------- colour ----------

  function parseColor(c, fallback = [0, 0, 0, 1]) {
    if (Array.isArray(c)) return [c[0], c[1], c[2], c[3] ?? 1];
    if (typeof c !== 'string') return fallback;
    const s = c.trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = [...h].map((x) => x + x).join('');
      const n = parseInt(h.slice(0, 6), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    }
    // Anything else CSS knows (names, oklch, hsl): let a canvas read it.
    const cx = document.createElement('canvas').getContext('2d');
    cx.fillStyle = '#000';
    cx.fillStyle = s;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  const rgbCss = ([r, g, b], a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslToRgb(h, s, l) {
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      t = ((t % 1) + 1) % 1;
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  // ---------- canvases ----------

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /** A blur of the alpha channel (box blur three times, close to a gaussian), wrapping when tiling. */
  function blurAlpha(a, w, h, r, tile) {
    if (r < 1) return a;
    const tmp = new Float32Array(a.length);
    const pass = (src, dst, horizontal) => {
      const n = horizontal ? w : h;
      const lines = horizontal ? h : w;
      const k = 1 / (2 * r + 1);
      for (let line = 0; line < lines; line++) {
        const idx = (i) => (horizontal ? line * w + i : i * w + line);
        const get = (i) => (tile ? src[idx(((i % n) + n) % n)] : src[idx(i < 0 ? 0 : i >= n ? n - 1 : i)]);
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += get(i);
        for (let i = 0; i < n; i++) {
          dst[idx(i)] = acc * k;
          acc += get(i + r + 1) - get(i - r);
        }
      }
    };
    let src = a;
    for (let i = 0; i < 3; i++) {
      pass(src, tmp, true);
      const out = new Float32Array(a.length);
      pass(tmp, out, false);
      src = out;
    }
    return src;
  }

  // ---------- paper ----------

  const PAPERS = {
    none: { cell: 0, depth: 0, color: null },
    smooth: { cell: 3, depth: 0.25, octaves: 3, color: '#f8f6f1' },
    'hot-press': { cell: 3, depth: 0.3, octaves: 3, color: '#f7f4ec' },
    'cold-press': { cell: 7, depth: 0.6, octaves: 4, color: '#f6f1e6' },
    rough: { cell: 12, depth: 0.85, octaves: 5, color: '#f3eee2' },
    canvas: { cell: 0, depth: 0.7, weave: 5, color: '#efe8da' },
    kraft: { cell: 5, depth: 0.55, octaves: 4, color: '#c9a77c', fibres: true },
    newsprint: { cell: 2, depth: 0.35, octaves: 2, color: '#e9e4d6', fibres: true },
  };

  /** The paper's tooth as heights in [0, 1], and its look: its colour lit from the upper left by its own relief. */
  function makePaper(W, H, spec, tile, seed) {
    const kind = PAPERS[spec.type ?? 'cold-press'] ? (spec.type ?? 'cold-press') : 'cold-press';
    const p = PAPERS[kind];
    const height = new Float32Array(W * H);
    const n = noise2(seed * 7 + 1);
    const n2 = noise2(seed * 13 + 5);
    const depth = (spec.grain ?? 1) * p.depth;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v;
        if (p.weave) {
          const sx = tile ? W / (2 * Math.max(1, Math.round(W / (2 * p.weave)))) : p.weave;
          const sy = tile ? H / (2 * Math.max(1, Math.round(H / (2 * p.weave)))) : p.weave;
          const u = Math.sin((x / sx) * Math.PI);
          const t = Math.sin((y / sy) * Math.PI);
          v = 0.5 + 0.25 * (Math.abs(u) * (Math.floor(y / sy) % 2 ? 1 : 0.6) + Math.abs(t) * (Math.floor(x / sx) % 2 ? 0.6 : 1)) / 2 + 0.25 * (fbm(n, x, y, 3, 2, W, H, tile) - 0.5);
        } else if (p.cell) {
          v = fbm(n, x, y, p.cell, p.octaves, W, H, tile);
          if (p.fibres) v = 0.75 * v + 0.25 * fbm(n2, x * 0.25, y * 4, 6, 2, W * 0.25, H * 4, tile);
        } else v = 0.5;
        height[y * W + x] = clamp(0.5 + (v - 0.5) * 1.8);
      }
    }
    const look = canvas(W, H);
    const base = spec.color ?? p.color;
    if (base && kind !== 'none') {
      const [r, g, b] = parseColor(base);
      const cx = look.getContext('2d');
      const img = cx.createImageData(W, H);
      const d = img.data;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const xl = tile ? (x - 1 + W) % W : Math.max(0, x - 1);
          const yu = tile ? (y - 1 + H) % H : Math.max(0, y - 1);
          // Light from the upper left: slopes facing it are lighter, held low so the paper reads as paper, not relief.
          const slope = height[i] - (height[y * W + xl] + height[yu * W + x]) / 2;
          const shade = 1 + depth * 0.1 * clamp(slope * 4, -1, 1) - depth * 0.03 * (1 - height[i]);
          d[i * 4] = clamp(r * shade, 0, 255);
          d[i * 4 + 1] = clamp(g * shade, 0, 255);
          d[i * 4 + 2] = clamp(b * shade, 0, 255);
          d[i * 4 + 3] = 255;
        }
      }
      cx.putImageData(img, 0, 0);
    }
    return { kind, height, look, depth, has: !!base && kind !== 'none' };
  }

  // ---------- brush tips ----------

  const TIP = 128;
  const tipCache = new Map();

  /** A tip's mask: alpha in a TIP×TIP canvas, drawn once per kind (and variant for textured tips). */
  function tipMask(kind, variant = 0) {
    const key = `${kind}:${variant}`;
    if (tipCache.has(key)) return tipCache.get(key);
    const c = canvas(TIP, TIP);
    const cx = c.getContext('2d');
    const img = cx.createImageData(TIP, TIP);
    const d = img.data;
    const n = noise2(97 + variant * 31 + kind.length * 7);
    const r = TIP / 2;
    for (let y = 0; y < TIP; y++) {
      for (let x = 0; x < TIP; x++) {
        const dx = (x + 0.5 - r) / r;
        const dy = (y + 0.5 - r) / r;
        const dist = Math.hypot(dx, dy);
        let a = 0;
        switch (kind) {
          case 'hard':
            a = 1 - smooth(0.86, 1, dist);
            break;
          case 'soft':
            a = Math.exp(-dist * dist * 3.2) * (dist < 1 ? 1 : 0);
            break;
          case 'ink': {
            // Crisp, its rim a little ragged as ink catches the paper.
            const edge = 0.9 + 0.1 * (n(x / 9, y / 9) - 0.5);
            a = 1 - smooth(edge - 0.06, edge, dist);
            break;
          }
          case 'grain': {
            const g = n(x / 3, y / 3);
            a = (1 - smooth(0.55, 1, dist)) * smooth(0.25, 0.75, g + 0.2 * (1 - dist));
            break;
          }
          case 'chalk': {
            const wob = 0.75 + 0.35 * (n(Math.atan2(dy, dx) * 2 + 9, 3) - 0.5);
            const g = n(x / 4, y / 4);
            a = (1 - smooth(wob - 0.25, wob, dist)) * smooth(0.2, 0.7, g + 0.15);
            break;
          }
          case 'flat': {
            // A chisel: wide across, thin along, with soft ends.
            const ax = Math.abs(dx);
            const ay = Math.abs(dy);
            a = (1 - smooth(0.85, 1, ax)) * (1 - smooth(0.2, 0.32, ay));
            break;
          }
          case 'bristle': {
            // Separate hairs across the width, each a little different in strength.
            const hairs = 13;
            const ax = (dx + 1) / 2;
            const hair = Math.floor(ax * hairs);
            const local = ax * hairs - hair;
            const strength = 0.55 + 0.45 * n(hair * 3.7 + variant, 1.3);
            const along = 1 - smooth(0.55, 0.95, Math.abs(dy));
            a = (1 - smooth(0.3, 0.5, Math.abs(local - 0.5))) * strength * along * (Math.abs(dx) < 1 ? 1 : 0);
            break;
          }
          case 'wet':
            a = Math.exp(-dist * dist * 2.2) * (0.8 + 0.4 * (n(x / 11, y / 11) - 0.5)) * (dist < 1 ? 1 : 0);
            break;
          default:
            a = dist < 1 ? 1 : 0;
        }
        d[(y * TIP + x) * 4 + 3] = clamp(a) * 255;
        d[(y * TIP + x) * 4] = d[(y * TIP + x) * 4 + 1] = d[(y * TIP + x) * 4 + 2] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    tipCache.set(key, c);
    return c;
  }

  // ---------- media ----------

  /**
   * What each medium is: its tip, how its size and flow follow pressure, how close its dabs sit, whether paper
   * grain shows through (dry), whether it is wet (watercolour), whether one stroke stays flat (marker), and how it
   * meets what is under it.
   */
  const MEDIA = {
    pencil: { tremor: 0.6, tip: 'grain', flow: 0.62, sizeP: 0.35, spacing: 0.1, dry: 0.9, blend: 'multiply', jitter: 0.08, taper: 0.2, variants: 4, wobble: 0.08 },
    graphite: { tremor: 0.6, tip: 'grain', flow: 0.7, sizeP: 0.4, spacing: 0.1, dry: 0.8, blend: 'multiply', jitter: 0.08, taper: 0.15, variants: 4, wobble: 0.1 },
    ink: { tremor: 0.5, tip: 'ink', flow: 1, sizeP: 0.75, spacing: 0.06, dry: 0.05, blend: 'source-over', taper: 0.18, wobble: 0.1 },
    pen: { tremor: 0.55, tip: 'hard', flow: 1, sizeP: 0.12, spacing: 0.08, dry: 0.08, blend: 'source-over', taper: 0.04, wobble: 0.05 },
    brushpen: { tremor: 0.4, tip: 'ink', flow: 0.95, sizeP: 1, spacing: 0.05, dry: 0.15, blend: 'source-over', taper: 0.35, wobble: 0.14, dryBrush: 0.5 },
    marker: { tip: 'flat', flow: 0.42, sizeP: 0.1, spacing: 0.06, dry: 0.12, blend: 'multiply', flat: true, fixedAngle: -0.6, pool: 0.35 },
    highlighter: { tip: 'flat', flow: 0.35, sizeP: 0, spacing: 0.06, dry: 0, blend: 'multiply', flat: true, fixedAngle: -1.2, pool: 0.2 },
    watercolor: { tip: 'wet', flow: 0.5, sizeP: 0.45, spacing: 0.1, dry: 0, blend: 'multiply', wet: true, taper: 0.1, wobble: 0.12 },
    gouache: { tip: 'soft', flow: 0.92, sizeP: 0.3, spacing: 0.05, dry: 0.25, blend: 'source-over', hairs: 16, hairSpread: 0.9, hairVary: 0.12 },
    oil: { tip: 'soft', flow: 0.95, sizeP: 0.25, spacing: 0.04, dry: 0.2, blend: 'source-over', hairs: 22, hairSpread: 1, hairVary: 0.35, colourVary: 20 },
    pastel: { tip: 'chalk', flow: 0.75, sizeP: 0.3, spacing: 0.1, dry: 1, blend: 'source-over', jitter: 0.12, variants: 6, wobble: 0.1 },
    chalk: { tip: 'chalk', flow: 0.8, sizeP: 0.25, spacing: 0.11, dry: 1.1, blend: 'source-over', jitter: 0.15, variants: 6, wobble: 0.12 },
    charcoal: { tremor: 0.7, tip: 'chalk', flow: 0.7, sizeP: 0.4, spacing: 0.09, dry: 0.95, blend: 'multiply', jitter: 0.1, variants: 6, wobble: 0.12 },
    crayon: { tip: 'grain', flow: 0.9, sizeP: 0.2, spacing: 0.07, dry: 1.25, blend: 'source-over', jitter: 0.06, variants: 4, wobble: 0.06 },
    airbrush: { tip: 'soft', flow: 0.16, sizeP: 0.3, spacing: 0.06, dry: 0, blend: 'source-over' },
    soft: { tip: 'soft', flow: 0.25, sizeP: 0.5, spacing: 0.1, dry: 0, blend: 'source-over' },
    eraser: { tip: 'soft', flow: 0.6, sizeP: 0.4, spacing: 0.08, dry: 0, blend: 'destination-out' },
  };

  /** Points [x, y, pressure?] along a smooth curve through them, one every `step` px, pressure carried along. */
  function resample(points, step, closed, curve = true) {
    const P = points.map((p) => ({ x: p[0], y: p[1], p: p[2] ?? 0.7 }));
    if (P.length === 1) return [{ ...P[0], angle: 0 }];
    if (closed) P.push(P[0]);
    // Catmull-Rom through the points, then even steps along its length.
    const dense = [];
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)];
      const p1 = P[i];
      const p2 = P[i + 1];
      const p3 = P[Math.min(P.length - 1, i + 2)];
      const seg = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2));
      for (let s = 0; s < seg; s++) {
        const t = s / seg;
        const t2 = t * t;
        const t3 = t2 * t;
        // Straight segments keep their corners (a box ruled by hand); a curve runs through the points.
        const cr = curve ? (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3) : (a, b, c) => b + (c - b) * t;
        dense.push({ x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y), p: p1.p + (p2.p - p1.p) * t });
      }
    }
    dense.push(P[P.length - 1]);
    const out = [];
    let carry = 0;
    for (let i = 0; i < dense.length - 1; i++) {
      const a = dense[i];
      const b = dense[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      let d = carry;
      while (d < len) {
        const t = d / len;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t, angle });
        d += step;
      }
      carry = d - len;
    }
    if (!out.length) out.push({ ...dense[0], angle: 0 });
    return out;
  }

  // ---------- geometry: paths, shapes, groups and symbols ----------

  /**
   * SVG path data (M L H V C S Q T A Z, absolute and relative) to polylines, one per subpath, curves and arcs
   * sampled every `step` px. A subpath closed with Z is marked closed.
   */
  function pathPoints(d, step = 3) {
    const tokens = String(d).match(/[a-df-zA-DF-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
    const subs = [];
    let cur = [];
    let x = 0;
    let y = 0;
    let sx = 0;
    let sy = 0;
    let cmd = '';
    let lastC = null;
    let lastQ = null;
    let i = 0;
    const num = () => Number(tokens[i++] ?? 0);
    const push = (px, py) => cur.push([px, py]);
    const cubic = (x1, y1, x2, y2, x3, y3) => {
      const n = Math.max(4, Math.ceil((Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)) / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        push(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
    };
    const quad = (x1, y1, x2, y2) => {
      const n = Math.max(4, Math.ceil((Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1)) / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        push(u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2);
      }
    };
    // The endpoint form of an elliptical arc to its centre form (SVG 1.1, appendix F.6.5), then sampled.
    const arc = (rx, ry, deg, large, sweep, x2, y2) => {
      if (!rx || !ry) return push(x2, y2);
      const phi = (deg * Math.PI) / 180;
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      const dx = (x - x2) / 2;
      const dy = (y - y2) / 2;
      const x1p = cos * dx + sin * dy;
      const y1p = -sin * dx + cos * dy;
      rx = Math.abs(rx);
      ry = Math.abs(ry);
      const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
      if (lam > 1) {
        rx *= Math.sqrt(lam);
        ry *= Math.sqrt(lam);
      }
      const top = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
      const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, top / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
      const cxp = (co * rx * y1p) / ry;
      const cyp = (-co * ry * x1p) / rx;
      const cx = cos * cxp - sin * cyp + (x + x2) / 2;
      const cy = sin * cxp + cos * cyp + (y + y2) / 2;
      const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
      let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
      if (!sweep && dt > 0) dt -= Math.PI * 2;
      else if (sweep && dt < 0) dt += Math.PI * 2;
      const n = Math.max(4, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / step));
      for (let k = 1; k <= n; k++) {
        const t = t1 + (dt * k) / n;
        push(cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos);
      }
    };
    while (i < tokens.length) {
      if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
      else if (!cmd) {
        i++;
        continue;
      }
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      if (C === 'Z') {
        if (cur.length) {
          push(sx, sy);
          cur.closed = true;
          subs.push(cur);
        }
        cur = [];
        x = sx;
        y = sy;
        cmd = '';
        continue;
      }
      if (C === 'M') {
        if (cur.length > 1) subs.push(cur);
        x = ox + num();
        y = oy + num();
        sx = x;
        sy = y;
        cur = [[x, y]];
        cmd = rel ? 'l' : 'L';
        lastC = lastQ = null;
        continue;
      }
      if (!cur.length) cur = [[x, y]];
      if (C === 'L') {
        x = ox + num();
        y = oy + num();
        push(x, y);
        lastC = lastQ = null;
      } else if (C === 'H') {
        x = (rel ? x : 0) + num();
        push(x, y);
        lastC = lastQ = null;
      } else if (C === 'V') {
        y = (rel ? y : 0) + num();
        push(x, y);
        lastC = lastQ = null;
      } else if (C === 'C') {
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num();
        cubic(x1, y1, x2, y2, x3, y3);
        lastC = [x2, y2];
        lastQ = null;
        x = x3;
        y = y3;
      } else if (C === 'S') {
        const x1 = lastC ? 2 * x - lastC[0] : x;
        const y1 = lastC ? 2 * y - lastC[1] : y;
        const x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num();
        cubic(x1, y1, x2, y2, x3, y3);
        lastC = [x2, y2];
        lastQ = null;
        x = x3;
        y = y3;
      } else if (C === 'Q') {
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num();
        quad(x1, y1, x2, y2);
        lastQ = [x1, y1];
        lastC = null;
        x = x2;
        y = y2;
      } else if (C === 'T') {
        const x1 = lastQ ? 2 * x - lastQ[0] : x;
        const y1 = lastQ ? 2 * y - lastQ[1] : y;
        const x2 = ox + num(), y2 = oy + num();
        quad(x1, y1, x2, y2);
        lastQ = [x1, y1];
        lastC = null;
        x = x2;
        y = y2;
      } else if (C === 'A') {
        const rx = num(), ry = num(), deg = num(), large = num(), sweep = num(), x2 = ox + num(), y2 = oy + num();
        arc(rx, ry, deg, large ? 1 : 0, sweep ? 1 : 0, x2, y2);
        x = x2;
        y = y2;
        lastC = lastQ = null;
      } else i++;
    }
    if (cur.length > 1) subs.push(cur);
    return subs;
  }

  /** Outlines of the simple shapes an item may name instead of points or a region. */
  function shapePolygon(item) {
    const ring = (cx, cy, rx, ry, deg = 0) => {
      const out = [];
      const a = (deg * Math.PI) / 180;
      const n = Math.max(24, Math.min(160, Math.ceil(Math.max(rx, ry) * 0.8)));
      for (let k = 0; k < n; k++) {
        const t = (k / n) * Math.PI * 2;
        const px = Math.cos(t) * rx;
        const py = Math.sin(t) * ry;
        out.push([cx + px * Math.cos(a) - py * Math.sin(a), cy + px * Math.sin(a) + py * Math.cos(a)]);
      }
      return out;
    };
    if (Array.isArray(item.ellipse)) {
      const [cx, cy, rx, ry, deg] = item.ellipse.map(Number);
      return ring(cx, cy, rx, ry ?? rx, deg ?? 0);
    }
    if (Array.isArray(item.circle)) {
      const [cx, cy, r] = item.circle.map(Number);
      return ring(cx, cy, r, r);
    }
    if (Array.isArray(item.rect)) {
      const [x, y, w, h, rr = 0] = item.rect.map(Number);
      if (!rr) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      const r = Math.min(rr, w / 2, h / 2);
      const out = [];
      const corner = (cx, cy, from) => {
        for (let k = 0; k <= 6; k++) {
          const t = from + (k / 6) * (Math.PI / 2);
          out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
        }
      };
      corner(x + w - r, y + r, -Math.PI / 2);
      corner(x + w - r, y + h - r, 0);
      corner(x + r, y + h - r, Math.PI / 2);
      corner(x + r, y + r, Math.PI);
      return out;
    }
    return null;
  }

  /** Pressure along a stroke by its length: one number throughout, or values spread evenly from start to end. */
  function withPressure(points, pressure) {
    if (pressure === undefined) return points;
    const vals = Array.isArray(pressure) ? pressure.map(Number) : [Number(pressure)];
    if (vals.length === 1) return points.map((q) => [q[0], q[1], q[2] ?? vals[0]]);
    const lens = [0];
    for (let k = 1; k < points.length; k++) lens.push(lens[k - 1] + Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]));
    const total = lens[lens.length - 1] || 1;
    return points.map((q, k) => {
      const f = (lens[k] / total) * (vals.length - 1);
      const j = Math.min(vals.length - 2, Math.floor(f));
      return [q[0], q[1], q[2] ?? vals[j] + (vals[j + 1] - vals[j]) * (f - j)];
    });
  }

  /** An item's geometry in plain points and polygons: paths, shapes and pressure resolved. A stroke along a path of several pieces becomes one stroke for each. */
  function plain(item, notes, shapes) {
    const it = { ...item };
    let lost = false;
    // "@rock" names an outline kept under `shapes`: one silhouette for a mass, its texture, shading and shadow.
    const named = (v) => {
      if (typeof v !== 'string' || !v.startsWith('@')) return v;
      const found = shapes[v.slice(1)];
      if (found === undefined) {
        notes.push(`No shape "${v}"; known: ${Object.keys(shapes).join(', ') || 'none'}.`);
        lost = true;
      }
      return found;
    };
    for (const k of ['region', 'along', 'clip', 'path']) if (it[k] !== undefined) it[k] = named(it[k]);
    // Left out: without its outline a fill would cover the whole picture.
    if (lost) return [];
    const shape = shapePolygon(it);
    const fillPath = it.region ?? (!shape && it.path);
    if (it.fill && typeof fillPath === 'string') {
      const contours = pathPoints(fillPath).filter((p) => p.length >= 3);
      if (!contours.length) return [];
      it.region = contours[0];
      if (contours.length > 1) it.contours = contours;
    }
    const polyOf = (v) => (typeof v === 'string' ? (pathPoints(v)[0] ?? null) : v);
    for (const k of ['region', 'along', 'clip']) if (typeof it[k] === 'string') it[k] = polyOf(it[k]);
    if (it.stroke || it.brush) {
      if (!it.fill && !it.strands && !it.scatter && !it.shade && !it.texture && !it.cast) {
        let pieces = null;
        if (typeof it.path === 'string') {
          pieces = pathPoints(it.path);
          if (it.smooth === undefined) it.smooth = false;
        } else if (shape) pieces = [Object.assign(shape, { closed: true })];
        if (pieces) {
          if (!pieces.length) notes.push(`A stroke's path "${String(it.path).slice(0, 40)}" draws nothing.`);
          return pieces.map((pts) => ({ ...it, path: undefined, ellipse: undefined, circle: undefined, rect: undefined, points: withPressure(pts, it.pressure), closed: it.closed ?? !!pts.closed }));
        }
        if (Array.isArray(it.points) && it.pressure !== undefined) it.points = withPressure(it.points, it.pressure);
        return [it];
      }
    }
    if (shape && !it.region) it.region = shape;
    if (typeof it.path === 'string' && !it.region) it.region = polyOf(it.path);
    return [it];
  }

  /** The 2D transform a group or a placed symbol sets: move to `at`, turn by `rotate` degrees, scale (about `origin`). */
  function frameOf(g) {
    const [ax, ay] = Array.isArray(g.at) ? g.at.map(Number) : [0, 0];
    const [ox, oy] = Array.isArray(g.origin) ? g.origin.map(Number) : [0, 0];
    const [kx, ky] = Array.isArray(g.scale) ? g.scale.map(Number) : [Number(g.scale ?? 1), Number(g.scale ?? 1)];
    const r = ((Number(g.rotate) || 0) * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    // p' = at + R · S · (p - origin)
    return { a: c * kx, b: s * kx, c: -s * ky, d: c * ky, e: ax - (c * kx * ox - s * ky * oy), f: ay - (s * kx * ox + c * ky * oy), k: Math.sqrt(Math.abs(kx * ky)) };
  }
  const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, k: 1 };
  const compose = (P, Q) => ({ a: P.a * Q.a + P.c * Q.b, b: P.b * Q.a + P.d * Q.b, c: P.a * Q.c + P.c * Q.d, d: P.b * Q.c + P.d * Q.d, e: P.a * Q.e + P.c * Q.f + P.e, f: P.b * Q.e + P.d * Q.f + P.f, k: P.k * Q.k });
  const apply = (T, q) => [T.a * q[0] + T.c * q[1] + T.e, T.b * q[0] + T.d * q[1] + T.f, ...q.slice(2)];

  /** Coordinates and sizes of an item moved into its group's frame. */
  function placed(item, T) {
    if (T === IDENTITY) return item;
    const it = { ...item };
    const pts = (list) => (Array.isArray(list) ? list.map((q) => apply(T, q)) : list);
    for (const k of ['points', 'region', 'along', 'clip']) if (Array.isArray(it[k])) it[k] = pts(it[k]);
    if (it.contours) it.contours = it.contours.map(pts);
    if (Array.isArray(it.box)) {
      const [x0, y0] = apply(T, [it.box[0], it.box[1]]);
      const [x1, y1] = apply(T, [it.box[2], it.box[3]]);
      it.box = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    }
    const scale = (v) => (Array.isArray(v) ? v.map((n) => Number(n) * T.k) : typeof v === 'number' ? v * T.k : v);
    for (const k of ['size', 'spacing', 'length', 'spread', 'softness']) if (it[k] !== undefined) it[k] = scale(it[k]);
    if (Array.isArray(it.rotate)) it.rotate = it.rotate.map((n) => Number(n) + (Math.atan2(T.b, T.a) * 180) / Math.PI);
    return it;
  }

  /**
   * The document as the painter takes it: every group and placed symbol (`use`) expanded into its items in the
   * page's coordinates, and every path and shape turned into points and polygons. A symbol is drawn once in its
   * own frame (say a leaf 100 px long around 0,0) and placed as often as needed, each with its own position,
   * turn, size and colour.
   */
  function prepare(doc, notes) {
    const symbols = doc.symbols ?? {};
    const expand = (items, T, depth) => {
      const out = [];
      for (const raw of items ?? []) {
        if (!raw || typeof raw !== 'object') continue;
        if (raw.group || raw.use) {
          if (depth > 8) {
            notes.push('Groups and symbols nest more than 8 deep; the deeper ones are left out.');
            continue;
          }
          const inner = raw.group ?? symbols[raw.use];
          if (!Array.isArray(inner)) {
            notes.push(`No symbol "${raw.use}"; known: ${Object.keys(symbols).join(', ') || 'none'}.`);
            continue;
          }
          let kids = expand(inner, compose(T, frameOf(raw)), depth + 1);
          if (raw.color) kids = kids.map((c) => ({ ...c, color: raw.color }));
          if (raw.opacity !== undefined) kids = kids.map((c) => ({ ...c, opacity: (c.opacity ?? 1) * Number(raw.opacity) }));
          out.push(...kids);
          continue;
        }
        for (const it of plain(raw, notes, doc.shapes ?? {})) out.push(placed(it, T));
      }
      return out;
    };
    return { ...doc, layers: (doc.layers ?? []).map((l) => ({ ...l, items: expand(l.items, IDENTITY, 0) })) };
  }

  // ---------- the painter ----------

  /** The blend names a document uses, as canvas operations (for the generators inside the painter). */
  const BLENDS_IN = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', 'soft-light': 'soft-light', 'hard-light': 'hard-light', darken: 'darken', lighten: 'lighten', 'color-burn': 'color-burn', 'color-dodge': 'color-dodge', color: 'color', luminosity: 'luminosity' };

  function painter(doc, notes) {
    const W = doc.size?.[0] ?? 1024;
    const H = doc.size?.[1] ?? 768;
    const tile = !!doc.tile;
    const seed = doc.seed ?? 1;
    const random = rng(seed * 2654435761);
    const paper = makePaper(W, H, doc.paper ?? { type: 'none' }, tile, seed);
    const outOfBounds = { n: 0 };
    let lastCutKey = null;

    /** One dab of a tinted tip; wrapped toroidally across all overlapping borders when tiling. */
    function dab(cx, mask, x, y, size, angle, alpha) {
      const s = Math.max(0.5, size);
      const draw = (px, py) => {
        cx.save();
        cx.globalAlpha = clamp(alpha);
        cx.translate(px, py);
        cx.rotate(angle);
        cx.drawImage(mask, -s / 2, -s / 2, s, s);
        cx.restore();
      };
      if (!tile) {
        draw(x, y);
        return;
      }
      const r = s / 2;
      const wx = ((x % W) + W) % W;
      const wy = ((y % H) + H) % H;
      const kx0 = Math.floor((-r - wx) / W);
      const kx1 = Math.ceil((W + r - wx) / W);
      const ky0 = Math.floor((-r - wy) / H);
      const ky1 = Math.ceil((H + r - wy) / H);
      for (let kx = kx0; kx <= kx1; kx++) {
        const px = wx + kx * W;
        if (px + r <= 0 || px - r >= W) continue;
        for (let ky = ky0; ky <= ky1; ky++) {
          const py = wy + ky * H;
          if (py + r > 0 && py - r < H) draw(px, py);
        }
      }
    }

    /** A tip tinted with a colour, cached per tip and colour. */
    const tinted = new Map();
    function tintedTip(kind, variant, rgb) {
      const key = `${kind}:${variant}:${rgb.join(',')}`;
      if (tinted.has(key)) return tinted.get(key);
      const m = tipMask(kind, variant);
      const c = canvas(TIP, TIP);
      const cx = c.getContext('2d');
      cx.drawImage(m, 0, 0);
      cx.globalCompositeOperation = 'source-in';
      cx.fillStyle = rgbCss(rgb);
      cx.fillRect(0, 0, TIP, TIP);
      tinted.set(key, c);
      return c;
    }

    /**
     * The part of the picture a mark can reach, padded: its passes read and write only there. A texture that
     * tiles is small and wraps, so it is worked whole.
     */
    function boxOf(points, pad) {
      if (tile || !points.length) return { x: 0, y: 0, w: W, h: H, whole: true };
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of points) {
        const x = p.x ?? p[0];
        const y = p.y ?? p[1];
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      const bx = Math.max(0, Math.floor(x0 - pad));
      const by = Math.max(0, Math.floor(y0 - pad));
      const ex = Math.min(W, Math.ceil(x1 + pad));
      const ey = Math.min(H, Math.ceil(y1 + pad));
      return { x: bx, y: by, w: Math.max(1, ex - bx), h: Math.max(1, ey - by), whole: bx === 0 && by === 0 && ex === W && ey === H };
    }

    /** Dry media take to the paper's tooth: light pressure only touches the peaks, heavy pressure fills the valleys. */
    function grainPass(buf, amount, box) {
      if (!amount || (paper.kind === 'none' && !doc.paper?.grain)) return;
      const cx = buf.getContext('2d');
      const img = cx.getImageData(box.x, box.y, box.w, box.h);
      const d = img.data;
      const h = paper.height;
      for (let li = 0; li < box.w * box.h; li++) {
        const a = d[li * 4 + 3] / 255;
        if (!a) continue;
        const gi = (box.y + ((li / box.w) | 0)) * W + box.x + (li % box.w);
        // The tooth that pressure reaches: more pigment sits higher; the valleys fill only where it is laid on thick.
        const reach = 1 - a;
        const take = smooth(reach - 0.32 * amount, reach + 0.32 * amount, h[gi] * amount + (1 - amount) * 0.5 + 0.18 * a);
        d[li * 4 + 3] = clamp(a * (0.25 + 0.95 * take) * (1 - 0.35 * amount * (1 - take))) * 255;
      }
      cx.putImageData(img, box.x, box.y);
    }

    /**
     * Watercolour: a wet area with a definite, uneven front; inside it the pigment settles unevenly (blooms), gathers
     * at the front as the water dries back, and sinks into the valleys of the paper (granulation).
     */
    function wetPass(buf, rgb, opts, box) {
      const cx = buf.getContext('2d');
      const img = cx.getImageData(box.x, box.y, box.w, box.h);
      const d = img.data;
      const n = box.w * box.h;
      const raw = new Float32Array(n);
      for (let i = 0; i < n; i++) raw[i] = d[i * 4 + 3] / 255;
      const size = Math.max(4, opts.size ?? 30);
      const wrap = tile && box.whole;
      const soaked = blurAlpha(raw, box.w, box.h, Math.max(1, Math.round(opts.spread ?? size * 0.06)), wrap);
      const front = noise2(seed * 41 + 7);
      const bloomN = noise2(seed * 31 + 11);
      const edges = opts.edges ?? 0.9;
      const gran = (opts.granulation ?? 0.6) * (paper.kind === 'none' ? 0.5 : 1);
      const bloomAmt = opts.bloom ?? 1;
      // Where it is wet: past a threshold, roughened by noise so the front is not a clean outline.
      const wet = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (soaked[i] < 0.02) continue;
        const x = box.x + (i % box.w);
        const y = box.y + ((i / box.w) | 0);
        const rough = (fbm(front, x, y, Math.max(6, size * 0.18), 3, W, H, tile) - 0.5) * 0.22;
        wet[i] = smooth(0.15, 0.22, soaked[i] + rough);
      }
      // The front: what is wet against what is wet a little way in.
      const inner = blurAlpha(wet, box.w, box.h, Math.max(2, Math.round(size * 0.07)), wrap);
      for (let i = 0; i < n; i++) {
        const w = wet[i];
        if (w < 0.01) {
          d[i * 4 + 3] = 0;
          continue;
        }
        const x = box.x + (i % box.w);
        const y = box.y + ((i / box.w) | 0);
        const bloom = 1 - bloomAmt * 0.38 + bloomAmt * 0.55 * fbm(bloomN, x, y, Math.max(12, size * 0.9), 3, W, H, tile);
        const rim = clamp((w - inner[i]) * 3.2) * edges;
        const tooth = 1 + gran * 0.55 * (0.55 - paper.height[y * W + x]);
        const load = Math.min(1, 0.55 + 0.45 * soaked[i]);
        d[i * 4] = rgb[0];
        d[i * 4 + 1] = rgb[1];
        d[i * 4 + 2] = rgb[2];
        d[i * 4 + 3] = clamp(w * load * bloom * tooth * (0.62 + 0.75 * rim) * (opts.strength ?? 1)) * 255;
      }
      cx.putImageData(img, box.x, box.y);
    }

    /** A marker's ink pools at the edges of its stroke: the middle a little lighter than the rim. */
    function poolPass(buf, amount, box) {
      const cx = buf.getContext('2d');
      const img = cx.getImageData(box.x, box.y, box.w, box.h);
      const d = img.data;
      const n = box.w * box.h;
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3] / 255;
      const b = blurAlpha(a, box.w, box.h, 2, tile && box.whole);
      for (let i = 0; i < n; i++) {
        if (!a[i]) continue;
        const rim = clamp((a[i] - b[i]) * 5);
        d[i * 4 + 3] = clamp(a[i] * (1 - amount + amount * rim)) * 255;
      }
      cx.putImageData(img, box.x, box.y);
    }


    /** The dabs of one stroke, into a buffer: its medium's tip, pressure, taper, tremor and hairs. */
    function marks(bx, item, m, rgb, size, pts) {
      const taper = item.taper ?? m.taper ?? 0;
      const wobble = noise2(Math.floor(random() * 1e6));
      const wob = item.wobble ?? m.wobble ?? 0;
      const pressureAt = (t, p) => {
        const ends = taper ? Math.min(1, t / taper, (1 - t) / taper) : 1;
        return clamp(p * (taper ? 0.35 + 0.65 * Math.sqrt(clamp(ends)) : 1));
      };
      if (m.hairs) {
        const path = resample(pts, Math.max(0.5, size * 0.04), !!item.closed, item.smooth !== false);
        const hairs = item.hairs ?? m.hairs;
        for (let k = 0; k < hairs; k++) {
          const across = (k / (hairs - 1) - 0.5) * (m.hairSpread ?? 1);
          // Outer hairs leave the paper first when the pressure drops; some run dry along the stroke.
          const reach = Math.abs(across) * 2;
          const strength = 1 - (m.hairVary ?? 0.2) * random();
          const dryAt = 0.55 + random() * 0.9;
          const width = Math.max(0.7, (size / hairs) * (1.6 + random() * 1.2));
          const col = m.colourVary ? rgb.map((c, j) => (j < 3 ? clamp(c + (random() - 0.5) * m.colourVary, 0, 255) : c)) : rgb;
          const mask = tintedTip('hard', 0, col.map((c) => Math.round(c / 4) * 4));
          const wiggle = (random() - 0.5) * 0.12;
          for (let i = 0; i < path.length; i++) {
            const q = path[i];
            const t = i / Math.max(1, path.length - 1);
            const pr = pressureAt(t, q.p);
            if (pr < reach * 0.85) continue;
            const spread = size * (0.45 + 0.55 * pr);
            const off = (across + wiggle * Math.sin(t * 9 + k)) * spread;
            const nx = -Math.sin(q.angle);
            const ny = Math.cos(q.angle);
            const fade = t > dryAt ? clamp(1 - (t - dryAt) * 3) : 1;
            dab(bx, mask, q.x + nx * off, q.y + ny * off, width, q.angle, m.flow * strength * fade * smooth(reach * 0.85, reach * 0.85 + 0.15, pr));
          }
        }
      } else {
        const step = Math.max(0.35, size * m.spacing);
        const path = resample(pts, step, !!item.closed, item.smooth !== false);
        const total = path.length;
        // A hand drifts a fraction of a pixel to either side of where it means to go.
        const tremor = item.tremor ?? m.tremor ?? 0;
        const variants = m.variants ?? 1;
        let along = 0;
        for (let i = 0; i < total; i++) {
          const q = path[i];
          const t = i / Math.max(1, total - 1);
          along += step;
          const pr = pressureAt(t, q.p);
          // The width breathes a little along the stroke, as a hand never holds it quite still.
          const breathe = wob ? 1 + wob * 2 * (wobble(along / Math.max(8, size * 3), 0.5) - 0.5) : 1;
          const s = size * (1 - m.sizeP + m.sizeP * pr) * breathe * (m.jitter ? 1 + (random() - 0.5) * m.jitter * 2 : 1);
          const jx = m.jitter ? (random() - 0.5) * size * m.jitter : 0;
          const jy = m.jitter ? (random() - 0.5) * size * m.jitter : 0;
          const angle = m.fixedAngle ?? (m.tip === 'flat' ? q.angle + Math.PI / 2 : random() * Math.PI * 2);
          const v = variants > 1 ? Math.floor(random() * variants) : 0;
          const mask = tintedTip(m.tip, v, rgb.map((c) => Math.round(c / 4) * 4));
          let flow = m.flat ? 1 : m.flow * (0.4 + 0.6 * pr);
          // A brush pen dragged light and fast breaks up: the ink skips across the paper.
          if (m.dryBrush) flow *= 1 - m.dryBrush * smooth(0.25, 0.75, 1 - pr) * smooth(0.35, 0.65, wobble(along / 6, 3.1));
          const drift = tremor ? (wobble(along / 24, 7.7) - 0.5) * 2 * tremor * Math.max(1, Math.sqrt(size)) : 0;
          dab(bx, mask, q.x + jx - Math.sin(q.angle) * drift, q.y + jy + Math.cos(q.angle) * drift, s, angle, flow);
        }
      }
    }

    /**
     * One stroke of a medium into its own buffer, then onto the layer. Hair brushes (gouache, oil) paint each hair
     * as its own line along the stroke, offset across its width: streaks come from the hairs, never from stamping.
     */
    function stroke(layer, item) {
      const name = item.stroke ?? item.brush ?? 'pencil';
      const m = MEDIA[name];
      if (!m) {
        notes.push(`No brush "${name}"; known: ${Object.keys(MEDIA).join(', ')}.`);
        return;
      }
      const rgb = parseColor(item.color ?? '#222');
      const size = Math.max(0.5, item.size ?? (m.wet ? 30 : m.tip === 'grain' ? 3 : 6));
      const opacity = item.opacity ?? 1;
      const pts = item.points ?? [];
      if (!pts.length) return;
      if (!item.generated && !tile) for (const p of pts) if (p[0] < -size || p[1] < -size || p[0] > W + size || p[1] > H + size) outOfBounds.n++;
      const buf = canvas(W, H);
      const bx = buf.getContext('2d');
      marks(bx, item, m, rgb, size, pts);
      const box = boxOf(pts, size * 1.5 + (m.wet ? (item.spread ?? size * 0.06) * 4 + size * 0.5 : 0) + 6);
      if (m.wet) wetPass(buf, rgb, { size, spread: item.spread, edges: item.edges, granulation: item.granulation }, box);
      else if (m.dry) grainPass(buf, m.dry * (item.grain ?? 1), box);
      if (m.pool) poolPass(buf, m.pool, box);
      const lx = layer.getContext('2d');
      lx.save();
      // A marker stroke is flat in itself: it was drawn at full strength and is laid down at the marker's flow.
      lx.globalAlpha = clamp(opacity * (m.flat ? m.flow / (1 - (m.pool ?? 0) * 0.6) : 1));
      lx.globalCompositeOperation = item.blend ?? m.blend;
      if (item.clip) clipTo(lx, item.clip);
      lx.drawImage(buf, 0, 0);
      lx.restore();
    }


    function clipTo(cx, region) {
      cx.beginPath();
      region.forEach((p, i) => (i ? cx.lineTo(p[0], p[1]) : cx.moveTo(p[0], p[1])));
      cx.closePath();
      cx.clip();
    }

    /** Where a direction word, degree number or vector points, as a unit vector in the picture (y down). */
    function dirOf(v, d) {
      if (Array.isArray(v)) {
        const vx = Number(v[0]) || 0;
        const vy = Number(v[1]) || 0;
        const n = Math.hypot(vx, vy);
        return n > 1e-6 ? [vx / n, vy / n] : d;
      }
      if (typeof v === 'number' && Number.isFinite(v)) return [Math.cos((v * Math.PI) / 180), Math.sin((v * Math.PI) / 180)];
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        const words = {
          up: [0, -1], top: [0, -1], north: [0, -1],
          down: [0, 1], bottom: [0, 1], south: [0, 1], vertical: [0, 1],
          left: [-1, 0], west: [-1, 0],
          right: [1, 0], east: [1, 0], horizontal: [1, 0],
          'upper-left': [-0.7071, -0.7071], 'top-left': [-0.7071, -0.7071], nw: [-0.7071, -0.7071],
          'upper-right': [0.7071, -0.7071], 'top-right': [0.7071, -0.7071], ne: [0.7071, -0.7071],
          'lower-left': [-0.7071, 0.7071], 'bottom-left': [-0.7071, 0.7071], sw: [-0.7071, 0.7071],
          'lower-right': [0.7071, 0.7071], 'bottom-right': [0.7071, 0.7071], se: [0.7071, 0.7071], diagonal: [0.7071, 0.7071],
        };
        if (words[s]) return words[s];
        const deg = parseFloat(s);
        if (Number.isFinite(deg)) return [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
      }
      return d;
    }

    function bounds(region) {
      if (!Array.isArray(region) || !region.length) return [0, 0, W, H];
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of region) {
        const x = Number(p?.[0]);
        const y = Number(p?.[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
      return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, W, H];
    }

    function inside(region, x, y) {
      let hit = false;
      for (let i = 0, j = region.length - 1; i < region.length; j = i++) {
        const [xi, yi] = region[i];
        const [xj, yj] = region[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    }

    const full = [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ];

    /** Where the line through (ox, oy) along (ux, uy) is inside the region, as [t0, t1] spans along it. */
    function spans(region, ox, oy, ux, uy) {
      const ts = [];
      for (let i = 0, j = region.length - 1; i < region.length; j = i++) {
        const [ax, ay] = region[j];
        const ex = region[i][0] - ax;
        const ey = region[i][1] - ay;
        const den = ux * ey - uy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((ax - ox) * ey - (ay - oy) * ex) / den;
        const s = ((ax - ox) * uy - (ay - oy) * ux) / den;
        if (s >= 0 && s < 1) ts.push(t);
      }
      ts.sort((p, q) => p - q);
      const out = [];
      for (let k = 0; k + 1 < ts.length; k += 2) out.push([ts[k], ts[k + 1]]);
      return out;
    }

    /**
     * Fills make the marks a hand makes to cover an area. Hatching is ruled by eye: each line its own weight, a
     * degree or two off, slightly bowed, heavier in the middle, its ends short of the edge or a little past it,
     * now and then one left out. Scribbles go back and forth row by row; stipple is even; splatter comes in all
     * sizes with satellites; a wash is one wet area.
     */
    function fill(layer, item) {
      const kind = item.fill;
      const region = item.region ?? full;
      const contours = item.contours ?? [region];
      const points = item.contours ? contours.flat() : region;
      const [x0, y0, x1, y1] = bounds(points);
      const rule = item.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
      const outline = () => {
        const path = new Path2D();
        for (const contour of contours) {
          contour.forEach(([x, y], i) => i ? path.lineTo(x, y) : path.moveTo(x, y));
          path.closePath();
        }
        return path;
      };
      if (item.contours && kind !== 'flat') {
        // Generate one continuous pattern in document coordinates, clipped to the painted islands and holes.
        const cx = layer.getContext('2d');
        cx.save();
        cx.clip(outline(), rule);
        try {
          fill(layer, { ...item, contours: undefined, region: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
        } finally { cx.restore(); }
        return;
      }
      const cx0 = (x0 + x1) / 2;
      const cy0 = (y0 + y1) / 2;
      const brush = item.brush ?? (kind === 'wash' ? 'watercolor' : kind === 'stipple' ? 'pen' : kind === 'splatter' ? 'ink' : 'pencil');
      const base = { ...item, stroke: brush, generated: true };
      delete base.fill;
      delete base.region;
      delete base.clip;
      const lines = [];
      const press = item.pressure ?? 0.6;
      switch (kind) {
        case 'hatch':
        case 'crosshatch': {
          const a0 = item.angle ?? 45;
          const angles = kind === 'crosshatch' ? [a0, a0 + (item.cross ?? 90)] : [a0];
          const spacing = Math.max(1.5, item.spacing ?? 8);
          if (tile && !item.region) {
            // Hand-length strokes on a jittered torus lattice wrap seamlessly without lining tapers up along x=0 or y=0.
            const segLen = Math.max(spacing * 4, Math.min(Math.min(W, H) * 0.45, spacing * 9));
            const skip = item.skip ?? 0.05;
            const target = Math.max(4, Math.round(((1 - skip) * W * H) / (spacing * segLen)));
            const nx = Math.max(2, Math.round(Math.sqrt((target * W) / H)));
            const ny = Math.max(2, Math.round(target / nx));
            for (const deg of angles) {
              for (let iy = 0; iy < ny; iy++) {
                for (let ix = 0; ix < nx; ix++) {
                  const mx = ((ix + random()) * W) / nx;
                  const my = ((iy + random()) * H) / ny;
                  const a = ((deg + (random() - 0.5) * (item.angleJitter ?? 3)) * Math.PI) / 180;
                  const ux = Math.cos(a);
                  const uy = Math.sin(a);
                  const half = segLen * (0.4 + 0.25 * random());
                  const pr = press * (0.55 + random() * 0.7);
                  const bow = (random() - 0.5) * spacing * 0.35;
                  const steps = Math.max(3, Math.round((half * 2) / 28));
                  const pts = [];
                  for (let k = 0; k <= steps; k++) {
                    const u = k / steps;
                    const t = -half + half * 2 * u;
                    const bulge = Math.sin(Math.PI * u) * bow;
                    pts.push([mx + ux * t - uy * bulge, my + uy * t + ux * bulge, pr * (0.8 + 0.35 * Math.sin(Math.PI * u))]);
                  }
                  lines.push(pts);
                }
              }
            }
            break;
          }
          const reach = Math.hypot(x1 - x0, y1 - y0) / 2 + spacing;
          for (const deg of angles) {
            for (let o = -reach; o <= reach; o += spacing * (0.8 + random() * 0.4)) {
              if (random() < (item.skip ?? 0.05)) continue;
              const a = ((deg + (random() - 0.5) * (item.angleJitter ?? 3)) * Math.PI) / 180;
              const ux = Math.cos(a);
              const uy = Math.sin(a);
              const ox = cx0 - uy * o;
              const oy = cy0 + ux * o;
              for (const [t0, t1] of spans(region, ox, oy, ux, uy)) {
                const len = t1 - t0;
                if (len < spacing * 0.6) continue;
                const s0 = t0 + len * 0.07 * random() - spacing * 0.25 * random();
                const s1 = t1 - len * 0.07 * random() + spacing * 0.25 * random();
                const pr = press * (0.55 + random() * 0.7);
                const bow = (random() - 0.5) * spacing * 0.4;
                const steps = Math.max(3, Math.round((s1 - s0) / 36));
                const pts = [];
                for (let k = 0; k <= steps; k++) {
                  const u = k / steps;
                  const t = s0 + (s1 - s0) * u;
                  const bulge = Math.sin(Math.PI * u) * bow;
                  pts.push([ox + ux * t - uy * bulge, oy + uy * t + ux * bulge, pr * (0.8 + 0.35 * Math.sin(Math.PI * u))]);
                }
                lines.push(pts);
              }
            }
          }
          break;
        }
        case 'scribble': {
          // Rows along the angle, walked back and forth in one line with rounded turns; the pen lifts every few rows.
          const a = ((item.angle ?? 15) * Math.PI) / 180;
          const ux = Math.cos(a);
          const uy = Math.sin(a);
          const gap = Math.max(1.5, (item.spacing ?? (item.size ?? 3) * 2.4) / (item.density ?? 1));
          const n = noise2(seed * 17 + 3);
          if (tile && !item.region) {
            const pw = W / 3;
            const ph = H / 3;
            for (let py = 0; py < 3; py++) {
              for (let px = 0; px < 3; px++) {
                const bx0 = ((px + random() * 0.8) * W) / 3;
                const by0 = ((py + random() * 0.8) * H) / 3;
                const patch = [[bx0, by0], [bx0 + pw, by0], [bx0 + pw, by0 + ph], [bx0, by0 + ph]];
                const pcx = bx0 + pw / 2;
                const pcy = by0 + ph / 2;
                const prch = Math.hypot(pw, ph) / 2 + gap;
                let pts = [];
                let forward = true;
                for (let o = -prch; o <= prch; o += gap * (0.75 + random() * 0.5)) {
                  const sp = spans(patch, pcx - uy * o, pcy + ux * o, ux, uy);
                  if (!sp.length) continue;
                  const [t0, t1] = sp[0];
                  const ends = forward ? [t0, t1] : [t1, t0];
                  const steps = Math.max(3, Math.round(Math.abs(t1 - t0) / 14));
                  for (let k = 0; k <= steps; k++) {
                    const t = ends[0] + ((ends[1] - ends[0]) * k) / steps;
                    const wob = (n((pcx + t) / 20, (pcy + o) / 20) - 0.5) * gap * 0.9;
                    pts.push([pcx - uy * o + ux * t - uy * wob, pcy + ux * o + uy * t + ux * wob, press * (0.7 + 0.5 * n(t / 30, o / 13))]);
                  }
                  forward = !forward;
                }
                if (pts.length) lines.push(pts);
              }
            }
            break;
          }
          const reach = Math.hypot(x1 - x0, y1 - y0) / 2 + gap;
          let pts = [];
          let forward = true;
          let row = 0;
          for (let o = -reach; o <= reach; o += gap * (0.75 + random() * 0.5)) {
            const ox = cx0 - uy * o;
            const oy = cy0 + ux * o;
            const sp = spans(region, ox, oy, ux, uy);
            if (!sp.length) continue;
            const [t0, t1] = sp[Math.floor(random() * sp.length)];
            const ends = forward ? [t0, t1] : [t1, t0];
            const steps = Math.max(3, Math.round(Math.abs(t1 - t0) / 14));
            for (let k = 0; k <= steps; k++) {
              const t = ends[0] + ((ends[1] - ends[0]) * k) / steps;
              const wob = (n(t / 20, o / 20) - 0.5) * gap * 0.9;
              pts.push([ox + ux * t - uy * wob, oy + uy * t + ux * wob, press * (0.7 + 0.5 * n(t / 30, o / 13))]);
            }
            forward = !forward;
            if (++row % (3 + Math.floor(random() * 4)) === 0 && pts.length) {
              lines.push(pts);
              pts = [];
            }
          }
          if (pts.length) lines.push(pts);
          break;
        }
        case 'stipple': {
          // A jittered grid keeps the dots even, the way a patient hand spaces them.
          const cell = Math.max(2, (item.spacing ?? 9) / Math.sqrt(item.density ?? 1));
          const cellX = tile && !item.region ? W / Math.max(1, Math.round(W / cell)) : cell;
          const cellY = tile && !item.region ? H / Math.max(1, Math.round(H / cell)) : cell;
          for (let y = y0; y < y1 - 1e-6; y += cellY) {
            for (let x = x0; x < x1 - 1e-6; x += cellX) {
              const px = x + random() * cellX;
              const py = y + random() * cellY;
              if (!tile && !inside(region, px, py)) continue;
              if (tile && item.region && !inside(region, px, py)) continue;
              stroke(layer, { ...base, size: (item.size ?? 2) * (0.7 + random() * 0.6), points: [[px, py, 0.9]], taper: 0 });
            }
          }
          return;
        }
        case 'splatter': {
          const count = Math.max(1, Math.round(((item.density ?? 1) * ((x1 - x0) * (y1 - y0))) / 1400));
          const big = item.size ?? 6;
          for (let k = 0; k < count; k++) {
            const x = x0 + (x1 - x0) * random();
            const y = y0 + (y1 - y0) * random();
            if (!inside(region, x, y)) continue;
            // Most drops are small; a big one is a few blots run together, with satellites flung past it.
            const size = big * (0.15 + 2.2 * Math.pow(random(), 3));
            const blots = size > big * 0.6 ? 3 : 1;
            for (let b = 0; b < blots; b++) {
              const r = size * 0.25 * b;
              const ang = random() * Math.PI * 2;
              stroke(layer, { ...base, size: size * (1 - 0.2 * b), points: [[x + Math.cos(ang) * r, y + Math.sin(ang) * r, 0.95]], taper: 0 });
            }
            if (size > big * 0.9) {
              const dir = random() * Math.PI * 2;
              for (let s = 0; s < 2 + Math.floor(random() * 4); s++) {
                const dist = size * (1 + random() * 2.2);
                const ang = dir + (random() - 0.5) * 0.9;
                stroke(layer, { ...base, size: Math.max(0.8, size * (0.08 + random() * 0.18)), points: [[x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, 0.9]], taper: 0 });
              }
              if (random() < 0.4) {
                const len = size * (1.5 + random() * 2);
                stroke(layer, { ...base, size: size * 0.35, taper: 0.9, points: [[x, y, 0.9], [x + Math.cos(dir) * len, y + Math.sin(dir) * len, 0.15]] });
              }
            }
          }
          return;
        }
        case 'flat': {
          // Paint laid flat and opaque (gouache, a card, a cut-paper shape): one colour, its edge a little uneven,
          // the paper's tooth faintly in it.
          const path = outline();
          // Twice the area over the perimeter measures thickness even for a long diagonal leaf.
          // At or below 6.5 px the 3-pass edge blur can erase the mark. Leave those edges antialiased.
          const fine = (item.rough ?? 0.6) ? contours.filter((p) => {
            let twiceArea = 0, perimeter = 0;
            for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
              twiceArea += p[j][0] * p[i][1] - p[i][0] * p[j][1];
              perimeter += Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]);
            }
            return Math.abs(twiceArea) <= 6.5 * perimeter;
          }) : [];
          const rough = fine.length === contours.length ? 0 : item.rough ?? 0.6;
          const color = rgbCss(parseColor(item.color ?? '#f4ecdd'));
          const lx = layer.getContext('2d');
          if (!rough && (item.grain === 0 || paper.kind === 'none' && !doc.paper?.grain) && (!item.blend || item.blend === 'source-over')) {
            lx.save();
            lx.fillStyle = color;
            lx.globalAlpha = clamp(item.opacity ?? 1);
            lx.fill(path, rule);
            lx.restore();
            return;
          }
          const buf = canvas(W, H);
          const bx = buf.getContext('2d');
          bx.fillStyle = color;
          bx.fill(path, rule);
          const box = boxOf(points, 10);
          if (rough) {
            const img = bx.getImageData(box.x, box.y, box.w, box.h);
            const d = img.data;
            const n = box.w * box.h;
            const a = new Float32Array(n);
            for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3] / 255;
            const soft = blurAlpha(a, box.w, box.h, 2, tile && box.whole);
            // Mixed-size paths share one winding mask. Keep the original alpha around their fine contours.
            for (const p of fine) {
              const [left, top, right, bottom] = bounds(p);
              const start = Math.max(0, Math.floor(left) - 6 - box.x), end = Math.min(box.w, Math.ceil(right) + 6 - box.x);
              if (start >= end) continue;
              for (let y = Math.max(0, Math.floor(top) - 6 - box.y); y < Math.min(box.h, Math.ceil(bottom) + 6 - box.y); y++)
                soft.fill(0, y * box.w + start, y * box.w + end);
            }
            const edgeN = noise2(seed * 53 + 9);
            for (let i = 0; i < n; i++) {
              if (soft[i] <= 0 || soft[i] >= 1) continue;
              const x = box.x + (i % box.w);
              const y = box.y + ((i / box.w) | 0);
              d[i * 4 + 3] = smooth(0.4, 0.6, soft[i] + (fbm(edgeN, x, y, 5, 2, W, H, tile) - 0.5) * 0.5 * rough) * 255;
            }
            bx.putImageData(img, box.x, box.y);
          }
          grainPass(buf, item.grain ?? 0.2, box);
          lx.save();
          lx.globalAlpha = clamp(item.opacity ?? 1);
          lx.globalCompositeOperation = item.blend ?? 'source-over';
          lx.drawImage(buf, 0, 0);
          lx.restore();
          return;
        }
        case 'wash': {
          // One wet area, in one colour or running from `color` to `to` along `direction` (degrees, 90 = down, or a word).
          const from = parseColor(item.color ?? '#7a9fb8');
          const to = item.to ? parseColor(item.to) : from;
          const [dx, dy] = dirOf(item.direction, [0, 1]);
          // The colours are read from an opaque canvas: at low alpha a canvas keeps colour only coarsely.
          const colours = canvas(W, H);
          const kx = colours.getContext('2d');
          const hw = Math.max(1, Math.abs(dx) * (x1 - x0) / 2 + Math.abs(dy) * (y1 - y0) / 2);
          const grad = kx.createLinearGradient(cx0 - dx * hw, cy0 - dy * hw, cx0 + dx * hw, cy0 + dy * hw);
          grad.addColorStop(0, rgbCss(from));
          grad.addColorStop(1, rgbCss(to));
          kx.fillStyle = grad;
          kx.fillRect(0, 0, W, H);
          const buf = canvas(W, H);
          const bx = buf.getContext('2d');
          bx.fillStyle = '#000';
          bx.globalAlpha = clamp(item.strength ?? 0.55);
          bx.beginPath();
          region.forEach((p, i) => (i ? bx.lineTo(p[0], p[1]) : bx.moveTo(p[0], p[1])));
          bx.closePath();
          bx.fill();
          // A wash's blooms are as large as the wash: a fifth to a third of the area across.
          const span = Math.min(x1 - x0, y1 - y0);
          wetPass(buf, from, { size: clamp(span * 0.3, 40, 400), spread: item.spread ?? 6, edges: item.edges ?? 0.8, granulation: item.granulation ?? 0.7, bloom: item.bloom ?? 0.5 }, boxOf(region, (item.spread ?? 6) * 4 + 12));
          const out = bx.getImageData(0, 0, W, H);
          const col = kx.getImageData(0, 0, W, H).data;
          for (let i = 0; i < W * H * 4; i += 4) {
            if (!out.data[i + 3]) continue;
            out.data[i] = col[i];
            out.data[i + 1] = col[i + 1];
            out.data[i + 2] = col[i + 2];
          }
          bx.putImageData(out, 0, 0);
          const lx = layer.getContext('2d');
          lx.save();
          lx.globalAlpha = clamp(item.opacity ?? 1);
          lx.globalCompositeOperation = item.blend ?? 'multiply';
          lx.drawImage(buf, 0, 0);
          lx.restore();
          return;
        }
        default:
          notes.push(`No fill "${kind}"; known: hatch, crosshatch, scribble, stipple, splatter, wash, flat.`);
          return;
      }
      for (const pts of lines) stroke(layer, { ...base, points: pts });
    }


    /** The colour a picture's border shares: the median of its edge pixels, channel by channel. */
    function edgeColor(d, w, h) {
      const rs = [];
      const gs = [];
      const bs = [];
      const take = (x, y) => {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 128) return;
        rs.push(d[i]);
        gs.push(d[i + 1]);
        bs.push(d[i + 2]);
      };
      const step = Math.max(1, Math.floor((w + h) / 400));
      for (let x = 0; x < w; x += step) take(x, 0), take(x, h - 1);
      for (let y = 0; y < h; y += step) take(0, y), take(w - 1, y);
      const mid = (a) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1] : 255);
      return [mid(rs), mid(gs), mid(bs)];
    }

    /**
     * A picture with its ground cut away (key: a colour, or "auto" for the colour its border shares). What is near
     * the key and reaches the border goes (flood: false takes it everywhere, holes too); the edge fades over a band
     * (soft) and its colour is un-mixed from the key, so no fringe of the old ground is left on the new one.
     */
    function cutout(img, item) {
      const w = img.width;
      const h = img.height;
      const c = canvas(w, h);
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      const data = cx.getImageData(0, 0, w, h);
      const d = data.data;
      const [kr, kg, kb] = item.key === 'auto' || item.key === true ? edgeColor(d, w, h) : parseColor(item.key);
      lastCutKey = [Math.round(kr), Math.round(kg), Math.round(kb)];
      const FULL = 441.7;
      const tol = clamp(item.tolerance ?? 0.12) * FULL;
      const band = Math.max(1, clamp(item.soft ?? 0.08) * FULL);
      // Nearness to the key by hue more than by light: the ground darkened under a shadow or a painted edge is still
      // ground. Near black, where hue says nothing, plain colour distance.
      const dist = new Float32Array(w * h);
      const ks = kr + kg + kb;
      for (let i = 0, p = 0; p < w * h; p++, i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const s = r + g + b;
        dist[p] = s < 45 || ks < 45 ? Math.hypot(r - kr, g - kg, b - kb) : Math.hypot(r / s - kr / ks, g / s - kg / ks, b / s - kb / ks) * FULL * 1.6 + (Math.abs(s - ks) / 3) * 0.35;
      }
      const near = (p) => dist[p] < tol + band;
      const ground = new Uint8Array(w * h);
      if (item.flood === false) for (let p = 0; p < w * h; p++) ground[p] = near(p) ? 1 : 0;
      else {
        const queue = new Int32Array(w * h);
        let head = 0;
        let tail = 0;
        const seed = (p) => {
          if (!ground[p] && near(p)) (ground[p] = 1), (queue[tail++] = p);
        };
        for (let x = 0; x < w; x++) seed(x), seed((h - 1) * w + x);
        for (let y = 0; y < h; y++) seed(y * w), seed(y * w + w - 1);
        while (head < tail) {
          const p = queue[head++];
          const x = p % w;
          if (x > 0) seed(p - 1);
          if (x < w - 1) seed(p + 1);
          if (p >= w) seed(p - w);
          if (p < w * (h - 1)) seed(p + w);
        }
      }
      let cut = 0;
      for (let p = 0, i = 0; p < w * h; p++, i += 4) {
        if (!ground[p]) continue;
        const a = clamp((dist[p] - tol) / band);
        if (a <= 0) {
          d[i + 3] = 0;
          cut++;
          continue;
        }
        // The edge pixel was the subject laid over the key: take the key back out of it.
        for (const [k, v] of [
          [0, kr],
          [1, kg],
          [2, kb],
        ])
          d[i + k] = clamp(Math.round((d[i + k] - (1 - a) * v) / a), 0, 255);
        d[i + 3] = Math.round(d[i + 3] * a);
      }
      // The ring just inside the cut holds anti-aliased mixes of subject and key: each pixel's alpha is how far it lies
      // from the key toward the subject's colour nearby, and that much of the key is taken back out of it.
      const R = Math.max(1, Math.round(item.edge ?? 2));
      const ring = new Uint8Array(w * h);
      let front = [];
      for (let p = 0; p < w * h; p++) {
        if (!ground[p]) continue;
        const x = p % w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < w * h && !ground[q] && !ring[q]) (ring[q] = 1), front.push(q);
      }
      for (let step = 2; step <= R; step++) {
        const next = [];
        for (const p of front) {
          const x = p % w;
          for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < w * h && !ground[q] && !ring[q]) (ring[q] = step), next.push(q);
        }
        front = next;
      }
      const reach = R + 2;
      for (let p = 0; p < w * h; p++) {
        if (!ring[p]) continue;
        const x0 = p % w;
        const y0 = (p - x0) / w;
        let fr = 0;
        let fg = 0;
        let fb = 0;
        let n = 0;
        for (let y = Math.max(0, y0 - reach); y <= Math.min(h - 1, y0 + reach); y++)
          for (let x = Math.max(0, x0 - reach); x <= Math.min(w - 1, x0 + reach); x++) {
            const q = y * w + x;
            if (ground[q] || ring[q]) continue;
            fr += d[q * 4];
            fg += d[q * 4 + 1];
            fb += d[q * 4 + 2];
            n++;
          }
        if (!n) continue;
        const F = [fr / n - kr, fg / n - kg, fb / n - kb];
        const i = p * 4;
        const C = [d[i] - kr, d[i + 1] - kg, d[i + 2] - kb];
        const len = F[0] * F[0] + F[1] * F[1] + F[2] * F[2];
        if (len < 1) continue;
        const a = clamp((C[0] * F[0] + C[1] * F[1] + C[2] * F[2]) / len);
        if (a >= 0.98) continue;
        if (a <= 0.02) {
          d[i + 3] = 0;
          continue;
        }
        const K = [kr, kg, kb];
        for (let k = 0; k < 3; k++) d[i + k] = clamp(Math.round((d[i + k] - (1 - a) * K[k]) / a), 0, 255);
        d[i + 3] = Math.round(d[i + 3] * a);
      }
      cx.putImageData(data, 0, 0);
      if (cut === 0) notes.push(`Nothing of "${item.image}" was near the key colour, so nothing was cut away.`);
      else if (cut > 0.97 * w * h) notes.push(`Almost all of "${item.image}" was cut away: the tolerance is too wide or the key is the subject's colour.`);
      return c;
    }

    /** A picture from a file, under or over what is painted: placed in a box, fitted by cover, contain or stretch. */
    function image(layer, item, picture) {
      if (!picture) {
        notes.push(`No picture for "${item.image}".`);
        return;
      }
      const img = item.key ? cutout(picture, item) : picture;
      const [bx0, by0, bx1, by1] = item.box ?? [0, 0, W, H];
      const bw = bx1 - bx0;
      const bh = by1 - by0;
      const fit = item.fit ?? 'cover';
      let dw = bw;
      let dh = bh;
      if (fit !== 'stretch') {
        const k = fit === 'contain' ? Math.min(bw / img.width, bh / img.height) : Math.max(bw / img.width, bh / img.height);
        dw = img.width * k;
        dh = img.height * k;
      }
      const lx = layer.getContext('2d');
      lx.save();
      lx.globalAlpha = clamp(item.opacity ?? 1);
      lx.globalCompositeOperation = item.blend ?? 'source-over';
      lx.beginPath();
      lx.rect(bx0, by0, bw, bh);
      lx.clip();
      const [sx, sy, sw, sh] = item.crop ?? [0, 0, img.width, img.height];
      const scale = fit === 'stretch' ? 1 : 1;
      lx.drawImage(img, sx, sy, sw, sh, bx0 + (bw - dw * scale) / 2, by0 + (bh - dh * scale) / 2, dw * scale, dh * scale);
      lx.restore();
    }


    /**
     * Many strokes of one medium laid into one buffer and treated once (the paper's tooth, a marker's pooling),
     * then put on the layer: thousands of hairs or blades cost one pass, not one canvas each. Wet media go one by one.
     */
    function batch(layer, items, opts = {}) {
      if (!items.length) return;
      const name = items[0].stroke ?? 'pencil';
      const m = MEDIA[name];
      if (!m) return notes.push(`No brush "${name}"; known: ${Object.keys(MEDIA).join(', ')}.`);
      if (m.wet) return items.forEach((it) => stroke(layer, it));
      const buf = canvas(W, H);
      const bx = buf.getContext('2d');
      const all = [];
      let big = 1;
      for (const it of items) {
        const size = Math.max(0.5, it.size ?? (m.tip === 'grain' ? 3 : 6));
        big = Math.max(big, size);
        marks(bx, it, m, parseColor(it.color ?? '#222'), size, it.points);
        for (const q of it.points) all.push(q);
      }
      const box = boxOf(all, big * 1.5 + 6);
      if (m.dry) grainPass(buf, m.dry * (opts.grain ?? 1), box);
      if (m.pool) poolPass(buf, m.pool, box);
      const lx = layer.getContext('2d');
      lx.save();
      lx.globalAlpha = clamp((opts.opacity ?? 1) * (m.flat ? m.flow / (1 - (m.pool ?? 0) * 0.6) : 1));
      lx.globalCompositeOperation = opts.blend ?? m.blend;
      if (opts.clip) clipTo(lx, opts.clip);
      lx.drawImage(buf, 0, 0);
      lx.restore();
    }

    const range = (v, d) => (Array.isArray(v) ? [Number(v[0]), Number(v[1] ?? v[0])] : v !== undefined ? [Number(v), Number(v)] : d);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const colorsOf = (item, d) => (Array.isArray(item.colors) && item.colors.length ? item.colors : [item.color ?? d]);
    /** A point inside a region, by trying; null when the region is too thin to hit. */
    function somewhere(region) {
      const [x0, y0, x1, y1] = bounds(region);
      for (let k = 0; k < 60; k++) {
        const x = x0 + random() * (x1 - x0);
        const y = y0 + random() * (y1 - y0);
        if (inside(region, x, y)) return [x, y];
      }
      return null;
    }

    /**
     * Strands: hair, fur, grass, feathers' barbs, fine lines of any kind, grown in numbers. Along a guide curve
     * (`along`) they follow its direction (hair) or grow out from it (fur, grass: `side`); over a region they rise
     * from roots scattered in it, in a direction that a gentle flow bends. Each is a tapered stroke whose pressure
     * swells and fades, with its own length, width and colour from the lists given.
     */
    function strands(layer, item) {
      const kind = item.strands;
      const count = Math.max(1, Math.min(6000, Math.round(item.count ?? 150)));
      const [l0, l1] = range(item.length, kind === 'grass' ? [30, 70] : kind === 'fur' ? [8, 18] : [60, 140]);
      // Fine lines stay whole in ink; pencil on rough paper breaks them into dashes.
      const medium = item.brush ?? (kind === 'fur' ? 'pencil' : 'ink');
      const colors = colorsOf(item, '#3b2a1e');
      const [w0, w1] = range(item.size, kind === 'grass' ? [1.5, 3] : [0.8, 1.8]);
      const curl = item.curl ?? (kind === 'hair' ? 0.25 : 0.4);
      const jitter = ((item.jitter ?? (kind === 'hair' ? 6 : 14)) * Math.PI) / 180;
      const flow = noise2(Math.floor(random() * 1e6));
      const guide = Array.isArray(item.along) && item.along.length > 1 ? resample(item.along, 2, false, true) : null;
      const region = item.region ?? (guide ? null : full);
      const out = [];
      const nearest = (x, y) => {
        let best = guide[0];
        let bd = Infinity;
        for (let g = 0; g < guide.length; g += 2) {
          const d = (guide[g].x - x) ** 2 + (guide[g].y - y) ** 2;
          if (d < bd) {
            bd = d;
            best = guide[g];
          }
        }
        return best;
      };
      const side = item.side === 'right' ? 1 : -1;
      const [dx0, dy0] = dirOf(item.direction, [0, -1]);
      for (let k = 0; k < count; k++) {
        let x;
        let y;
        let a;
        if (guide) {
          const g = guide[Math.floor(random() * guide.length)];
          const across = (random() - 0.5) * (item.spread ?? (kind === 'hair' ? 14 : 4));
          x = g.x - Math.sin(g.angle) * across;
          y = g.y + Math.cos(g.angle) * across;
          a = kind === 'hair' || item.follow ? g.angle : g.angle + (side * Math.PI) / 2;
        } else {
          const at = somewhere(region);
          if (!at) break;
          [x, y] = at;
          a = Math.atan2(dy0, dx0);
        }
        a += (random() - 0.5) * 2 * jitter;
        const L = l0 + random() * (l1 - l0);
        const segs = Math.max(3, Math.min(40, Math.round(L / 5)));
        const pts = [];
        const base = item.pressure ?? 0.85;
        for (let sI = 0; sI <= segs; sI++) {
          const t = sI / segs;
          // Pressure swells from the root and fades to the tip, as a flicked stroke does.
          pts.push([x, y, base * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, 0.2 + t * 0.8)))]);
          if (guide && (kind === 'hair' || item.follow)) {
            const g = nearest(x, y);
            let want = g.angle;
            const diff = Math.atan2(Math.sin(want - a), Math.cos(want - a));
            a += diff * 0.35;
          }
          a += (flow(x / 70, y / 70) - 0.5) * curl * 0.9 + (item.bend ?? 0) * (Math.PI / 180) / segs;
          x += (Math.cos(a) * L) / segs;
          y += (Math.sin(a) * L) / segs;
        }
        out.push({ stroke: medium, color: pick(colors), size: w0 + random() * (w1 - w0), points: pts, taper: item.taper ?? 0.45, tremor: item.tremor ?? 0.2, generated: true });
      }
      batch(layer, out, { opacity: item.opacity, blend: item.blend ? BLENDS_IN[item.blend] ?? item.blend : undefined, clip: item.clip });
    }

    /** Unit outlines (about 1 across, centred) of the things scatter lays down. */
    const SHAPES = {
      leaf: (k) => {
        const out = [];
        for (let i = 0; i <= 16; i++) {
          const t = i / 16;
          out.push([t - 0.5, -0.24 * Math.pow(Math.sin(Math.PI * t), 0.75) * (1 - 0.25 * t)]);
        }
        for (let i = 15; i > 0; i--) {
          const t = i / 16;
          out.push([t - 0.5, 0.24 * Math.pow(Math.sin(Math.PI * t), 0.75) * (1 - 0.25 * t)]);
        }
        return out;
      },
      petal: () => {
        const out = [];
        for (let i = 0; i < 24; i++) {
          const t = (i / 24) * Math.PI * 2;
          const r = 0.5 * (0.55 + 0.45 * Math.cos(t));
          out.push([Math.cos(t) * r * 1.1 - 0.05, Math.sin(t) * r * 0.75]);
        }
        return out;
      },
      stone: (k) => {
        const out = [];
        const n = noise2(k * 977 + 13);
        for (let i = 0; i < 20; i++) {
          const t = (i / 20) * Math.PI * 2;
          const r = 0.5 * (0.75 + 0.35 * n(Math.cos(t) + 2, Math.sin(t) + 2));
          out.push([Math.cos(t) * r, Math.sin(t) * r * 0.72]);
        }
        return out;
      },
      dot: () => Array.from({ length: 16 }, (_, i) => [Math.cos((i / 16) * Math.PI * 2) * 0.5, Math.sin((i / 16) * Math.PI * 2) * 0.5]),
      star: () => Array.from({ length: 10 }, (_, i) => {
        const r = i % 2 ? 0.2 : 0.5;
        const t = (i / 10) * Math.PI * 2 - Math.PI / 2;
        return [Math.cos(t) * r, Math.sin(t) * r];
      }),
      dash: () => [[-0.5, -0.06], [0.5, -0.06], [0.5, 0.06], [-0.5, 0.06]],
      blade: () => {
        const out = [];
        for (let i = 0; i <= 10; i++) {
          const t = i / 10;
          out.push([t - 0.5, -0.07 * (1 - t) + 0.12 * t * t]);
        }
        for (let i = 10; i >= 0; i--) {
          const t = i / 10;
          out.push([t - 0.5, 0.07 * (1 - t) + 0.12 * t * t]);
        }
        return out;
      },
      drop: () => Array.from({ length: 24 }, (_, i) => {
        const t = (i / 24) * Math.PI * 2;
        const r = 0.5 * (1 - 0.45 * Math.max(0, Math.cos(t)) ** 3);
        return [Math.cos(t) * r, Math.sin(t) * r * 0.8];
      }),
    };

    const mix = (a, b, t) => a.map((v, i) => (i < 3 ? v + (b[i] - v) * t : v));
    const lighten = (rgb, t) => mix(rgb, t > 0 ? [255, 255, 255, rgb[3]] : [0, 0, 0, rgb[3]], Math.abs(t));

    /**
     * Scatter: leaves, petals, stones, dots, stars, dashes, blades or drops laid down in a region or along a path,
     * each with its own size, turn and colour from the lists given; on the side the light comes from they come out
     * lighter (`light`), with an outline and a leaf's midrib when asked. Edges are a little uneven, as cut or painted.
     */
    function scatter(layer, item) {
      const kind = item.scatter;
      const make = SHAPES[kind];
      if (!make) return notes.push(`No scatter shape "${kind}"; known: ${Object.keys(SHAPES).join(', ')} (or place a symbol with use).`);
      const guide = Array.isArray(item.along) && item.along.length > 1 ? resample(item.along, 2, false, true) : null;
      const region = item.region ?? full;
      const [x0, y0, x1, y1] = bounds(region);
      const area = Math.max(1, (x1 - x0) * (y1 - y0));
      const count = Math.max(1, Math.min(4000, Math.round(item.count ?? (area / 10000) * (item.density ?? 3))));
      const [s0, s1] = range(item.size, [10, 22]);
      const colors = colorsOf(item, '#7a8a3a').map((c) => parseColor(c));
      const light = item.light !== undefined ? dirOf(item.light, [-0.707, -0.707]) : null;
      const cxr = (x0 + x1) / 2;
      const cyr = (y0 + y1) / 2;
      const half = Math.max(1, Math.hypot(x1 - x0, y1 - y0) / 2);
      const flow = noise2(Math.floor(random() * 1e6));
      const buf = canvas(W, H);
      const bx = buf.getContext('2d');
      const rough = item.rough ?? 0.06;
      const placedAt = [];
      for (let k = 0; k < count; k++) {
        let x;
        let y;
        let along = 0;
        if (guide) {
          const g = guide[Math.floor(random() * guide.length)];
          const off = (random() - 0.5) * (item.spread ?? 10);
          x = g.x - Math.sin(g.angle) * off;
          y = g.y + Math.cos(g.angle) * off;
          along = g.angle;
        } else {
          const at = somewhere(region);
          if (!at) break;
          [x, y] = at;
        }
        const size = s0 + random() * (s1 - s0);
        const rot = item.rotate === 'flow' ? (flow(x / 120, y / 120) - 0.5) * Math.PI * 2 : item.rotate === 'along' ? along : Array.isArray(item.rotate) ? ((Number(item.rotate[0]) + random() * (Number(item.rotate[1]) - Number(item.rotate[0]))) * Math.PI) / 180 : typeof item.rotate === 'number' ? (item.rotate * Math.PI) / 180 : random() * Math.PI * 2;
        let rgb = pick(colors);
        if (item.vary !== 0) rgb = lighten(rgb, (random() - 0.5) * (item.vary ?? 0.16));
        if (light) {
          // Lit from one side: lighter towards the light, darker away from it.
          const t = ((x - cxr) * light[0] + (y - cyr) * light[1]) / half;
          rgb = lighten(rgb, clamp(t, -1, 1) * (item.shade ?? 0.28));
        }
        const poly = make(k).map(([px, py]) => {
          const j = 1 + (random() - 0.5) * rough * 2;
          return [(px * Math.cos(rot) - py * Math.sin(rot)) * size * j, (px * Math.sin(rot) + py * Math.cos(rot)) * size * j];
        });
        const drawShape = (cxAt, cyAt) => {
          bx.beginPath();
          poly.forEach((q, i) => (i ? bx.lineTo(cxAt + q[0], cyAt + q[1]) : bx.moveTo(cxAt + q[0], cyAt + q[1])));
          bx.closePath();
          bx.fillStyle = rgbCss(rgb);
          bx.globalAlpha = clamp(item.opacity ?? 1);
          bx.fill();
          if (item.outline) {
            bx.lineWidth = Math.max(0.5, item.outline.size ?? 1);
            bx.strokeStyle = rgbCss(parseColor(item.outline.color ?? '#2b241d'));
            bx.stroke();
          }
          if (kind === 'leaf' && item.vein !== false) {
            bx.beginPath();
            bx.moveTo(cxAt - Math.cos(rot) * size * 0.45, cyAt - Math.sin(rot) * size * 0.45);
            bx.lineTo(cxAt + Math.cos(rot) * size * 0.42, cyAt + Math.sin(rot) * size * 0.42);
            bx.lineWidth = Math.max(0.4, size * 0.04);
            bx.strokeStyle = rgbCss(lighten(rgb, -0.3));
            bx.stroke();
          }
        };
        if (tile) {
          const wx = ((x % W) + W) % W;
          const wy = ((y % H) + H) % H;
          for (const ox of [-W, 0, W])
            for (const oy of [-H, 0, H])
              if (wx + ox + size > 0 && wx + ox - size < W && wy + oy + size > 0 && wy + oy - size < H) drawShape(wx + ox, wy + oy);
        } else drawShape(x, y);
        placedAt.push([x - size, y - size], [x + size, y + size]);
      }
      const box = boxOf(placedAt, 4);
      const m = MEDIA[item.brush ?? 'gouache'];
      if (m?.dry) grainPass(buf, m.dry * (item.grain ?? 1), box);
      const lx = layer.getContext('2d');
      lx.save();
      lx.globalCompositeOperation = item.blend ? BLENDS_IN[item.blend] ?? item.blend : 'source-over';
      if (item.clip) clipTo(lx, item.clip);
      lx.drawImage(buf, 0, 0);
      lx.restore();
    }

    /** A region as an alpha mask over its box (1 inside), for the per-pixel generators. */
    function maskOf(region, box) {
      const c = canvas(box.w, box.h);
      const cx = c.getContext('2d');
      cx.translate(-box.x, -box.y);
      cx.beginPath();
      region.forEach((q, i) => (i ? cx.lineTo(q[0], q[1]) : cx.moveTo(q[0], q[1])));
      cx.closePath();
      cx.fillStyle = '#000';
      cx.fill();
      const d = cx.getImageData(0, 0, box.w, box.h).data;
      const a = new Float32Array(box.w * box.h);
      for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
      return a;
    }

    /** The light as a unit vector (x right, y down, z towards the viewer) from a word, an angle or [x, y(, z)]. */
    function lightOf(v) {
      const [x, y] = dirOf(v ?? 'upper-left', [-0.707, -0.707]);
      const z = Array.isArray(v) && v.length > 2 ? Number(v[2]) : 0.7;
      const n = Math.hypot(x, y, z) || 1;
      return [x / n, y / n, z / n];
    }

    /**
     * Shading by form: the region is read as a sphere, a cylinder (with its `axis`), a plane (`normal`) or folded
     * cloth (`folds`), lit from `light`. The side away from the light darkens (with a core shadow along the turn
     * and reflected light near the far edge), a highlight sits where the light glances back, and the result goes
     * on as a soft wash (`method: soft`, multiply) or as hatching whose pressure follows the shadow (`hatch`).
     */
    function shade(layer, item) {
      const region = item.region;
      if (!region) return notes.push('shade needs a region (a polygon, a path, an ellipse, a circle or a rect).');
      const [x0, y0, x1, y1] = bounds(region);
      const box = boxOf(region, 2);
      const mask = maskOf(region, box);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = Math.max(1, (x1 - x0) / 2);
      const ry = Math.max(1, (y1 - y0) / 2);
      const L = lightOf(item.light);
      const form = item.form ?? 'sphere';
      const axis = (((item.axis ?? 90) * Math.PI) / 180);
      const ca = Math.cos(axis);
      const sa = Math.sin(axis);
      const strength = item.strength ?? 0.6;
      const core = item.core ?? 0.25;
      const reflect = item.reflect ?? 0.25;
      const shine = item.highlight === false ? 0 : (item.shine ?? 0.6);
      const folds = item.folds ?? 3;
      const plane = item.normal ? (() => {
        const n = item.normal.map(Number);
        const len = Math.hypot(...n) || 1;
        return n.map((v) => v / len);
      })() : [0, 0, 1];
      const shadowAt = new Float32Array(box.w * box.h);
      const lightAt = new Float32Array(box.w * box.h);
      for (let i = 0; i < shadowAt.length; i++) {
        if (mask[i] < 0.01) continue;
        const x = box.x + (i % box.w);
        const y = box.y + ((i / box.w) | 0);
        const u = (x - cx) / rx;
        const v = (y - cy) / ry;
        let n;
        let edge;
        if (form === 'plane') {
          n = plane;
          edge = 0;
        } else if (form === 'sphere') {
          const r2 = Math.min(0.999, u * u + v * v);
          n = [u, v, Math.sqrt(1 - r2)];
          edge = r2;
        } else {
          // Across the axis: the cylinder turns, along it nothing changes.
          const w = clamp(u * sa - v * ca, -0.999, 0.999);
          const along = u * ca + v * sa;
          if (form === 'fold') {
            const ph = Math.sin(w * Math.PI * folds + Math.sin(along * 2) * 0.6);
            n = [ph * 0.75 * sa, -ph * 0.75 * ca, Math.sqrt(1 - Math.min(0.99, ph * ph * 0.56))];
            edge = 0;
          } else {
            const t = form === 'cone' ? clamp(0.5 - along * 0.5, 0.05, 1) : 1;
            const ww = clamp(w / t, -0.999, 0.999);
            n = [ww * sa, -ww * ca, Math.sqrt(1 - ww * ww)];
            edge = ww * ww;
          }
        }
        const nl = n[0] * L[0] + n[1] * L[1] + n[2] * L[2];
        // Folds turn gently and stay near the light, so their shadow starts sooner than a round form's.
        let dark = form === 'fold' ? 0.75 * smooth(0.9, 0.3, nl) : smooth(0.6, -0.2, nl);
        dark += core * Math.exp(-(((nl + 0.05) / 0.16) ** 2));
        if (nl < 0) dark -= reflect * smooth(0.55, 0.98, edge);
        shadowAt[i] = clamp(dark) * mask[i];
        if (shine) {
          const rz = 2 * nl * n[2] - L[2];
          lightAt[i] = Math.pow(clamp(rz), 12 + 30 * (1 - shine)) * shine * mask[i];
        }
      }
      const method = item.method ?? 'soft';
      const lx = layer.getContext('2d');
      if (method === 'hatch') {
        const angle = ((item.angle ?? 45) * Math.PI) / 180;
        const spacing = Math.max(1.5, item.spacing ?? 6);
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        const reach = Math.hypot(x1 - x0, y1 - y0) / 2 + spacing;
        const lines = [];
        for (let o = -reach; o <= reach; o += spacing * (0.85 + random() * 0.3)) {
          const ox = cx - uy * o;
          const oy = cy + ux * o;
          for (const [t0, t1] of spans(region, ox, oy, ux, uy)) {
            const pts = [];
            for (let t = t0; t <= t1; t += 3) {
              const x = ox + ux * t;
              const y = oy + uy * t;
              const bi = (Math.round(y) - box.y) * box.w + (Math.round(x) - box.x);
              const sh = bi >= 0 && bi < shadowAt.length ? shadowAt[bi] : 0;
              pts.push([x, y, sh * strength]);
            }
            // Only where there is shadow to carry: a line breaks off where its side turns to the light.
            let run = [];
            for (const q of pts) {
              if (q[2] > 0.08) run.push(q);
              else if (run.length > 1) {
                lines.push(run);
                run = [];
              } else run = [];
            }
            if (run.length > 1) lines.push(run);
          }
        }
        batch(layer, lines.map((pts) => ({ stroke: item.brush ?? 'pencil', color: item.color ?? '#3a3040', size: item.size ?? 1.6, points: pts, taper: 0.3, generated: true })), { blend: 'multiply' });
      } else {
        const sh = canvas(W, H);
        const sx = sh.getContext('2d');
        const img = sx.createImageData(box.w, box.h);
        const rgb = parseColor(item.color ?? '#2b2238');
        for (let i = 0; i < shadowAt.length; i++) {
          img.data[i * 4] = rgb[0];
          img.data[i * 4 + 1] = rgb[1];
          img.data[i * 4 + 2] = rgb[2];
          img.data[i * 4 + 3] = clamp(shadowAt[i] * strength) * 255;
        }
        sx.putImageData(img, box.x, box.y);
        const soft = item.softness ?? (form === 'fold' ? Math.max(3, rx * 0.04) : 0);
        if (soft) {
          const tmp = canvas(W, H);
          const tx = tmp.getContext('2d');
          tx.filter = `blur(${soft}px)`;
          tx.drawImage(sh, 0, 0);
          sx.clearRect(0, 0, W, H);
          sx.globalCompositeOperation = 'source-over';
          sx.drawImage(tmp, 0, 0);
          sx.globalCompositeOperation = 'destination-in';
          const mk = maskCanvas(region);
          sx.drawImage(mk, 0, 0);
        }
        grainPass(sh, (item.grain ?? 0.5) * (paper.kind === 'none' ? 0 : 1), box);
        lx.save();
        lx.globalCompositeOperation = item.blend ? BLENDS_IN[item.blend] ?? item.blend : 'multiply';
        lx.drawImage(sh, 0, 0);
        lx.restore();
      }
      if (shine) {
        const hl = canvas(W, H);
        const hx = hl.getContext('2d');
        const img = hx.createImageData(box.w, box.h);
        const rgb = parseColor(typeof item.highlight === 'string' ? item.highlight : '#fff6e0');
        for (let i = 0; i < lightAt.length; i++) {
          img.data[i * 4] = rgb[0];
          img.data[i * 4 + 1] = rgb[1];
          img.data[i * 4 + 2] = rgb[2];
          img.data[i * 4 + 3] = clamp(lightAt[i]) * 255;
        }
        hx.putImageData(img, box.x, box.y);
        lx.save();
        lx.globalCompositeOperation = 'screen';
        lx.drawImage(hl, 0, 0);
        lx.restore();
      }
    }

    /** A region as a full-size canvas filled black inside, for clipping a blurred pass back to it. */
    function maskCanvas(region) {
      const c = canvas(W, H);
      const cx = c.getContext('2d');
      cx.beginPath();
      region.forEach((q, i) => (i ? cx.lineTo(q[0], q[1]) : cx.moveTo(q[0], q[1])));
      cx.closePath();
      cx.fillStyle = '#000';
      cx.fill();
      return c;
    }

    /**
     * A cast shadow: the region's silhouette laid on the ground away from the light, from its base (`ground`, the
     * lowest point by default), flattened (`squash`), softer the farther it falls (`blur`). Paint it on a layer
     * below the thing that casts it.
     */
    function cast(layer, item) {
      const region = item.region;
      if (!region) return notes.push('cast needs the region of the thing that casts it.');
      const [, , , y1] = bounds(region);
      const ground = item.ground ?? y1;
      const L = lightOf(item.light);
      const squash = item.squash ?? 0.35;
      const lean = item.lean ?? -L[0] / Math.max(0.2, L[2]);
      const pts = region.map(([x, y]) => {
        const h = Math.max(0, ground - y);
        return [x + h * lean * (item.length ?? 0.8), ground + h * squash * (L[1] < 0 ? 1 : -0.4)];
      });
      const c = canvas(W, H);
      const cx = c.getContext('2d');
      cx.filter = `blur(${item.blur ?? 6}px)`;
      cx.beginPath();
      pts.forEach((q, i) => (i ? cx.lineTo(q[0], q[1]) : cx.moveTo(q[0], q[1])));
      cx.closePath();
      cx.fillStyle = rgbCss(parseColor(item.color ?? '#2b2238'));
      cx.globalAlpha = clamp(item.strength ?? 0.45);
      cx.fill();
      const lx = layer.getContext('2d');
      lx.save();
      lx.globalCompositeOperation = item.blend ? BLENDS_IN[item.blend] ?? item.blend : 'multiply';
      lx.drawImage(c, 0, 0);
      lx.restore();
    }

    /**
     * Textures made from noise, inside a region: wood grain, stone, marble, bark, cloth weave, clouds, water
     * ripples or plain grain, between `color` and `color2`, at a `scale` in px and turned by `angle`.
     */
    function texture(layer, item) {
      const region = item.region ?? full;
      const box = boxOf(region, 1);
      const mask = maskOf(region, box);
      const kind = item.texture;
      const scale = Math.max(2, item.scale ?? 40);
      const ang = ((item.angle ?? 0) * Math.PI) / 180;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const n1 = noise2(Math.floor(random() * 1e6));
      const n2 = noise2(Math.floor(random() * 1e6));
      const c1 = parseColor(item.color ?? '#6b4a2e');
      const c2 = parseColor(item.color2 ?? '#a07a52');
      const strength = item.strength ?? 0.8;
      const known = ['wood', 'stone', 'marble', 'bark', 'cloth', 'clouds', 'water', 'grain'];
      if (!known.includes(kind)) return notes.push(`No texture "${kind}"; known: ${known.join(', ')}.`);
      const c = canvas(W, H);
      const cx = c.getContext('2d');
      const img = cx.createImageData(box.w, box.h);
      const fb = (n, x, y, cell, oct) => fbm(n, x, y, cell, oct, W, H, tile);
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] < 0.01) continue;
        const px = box.x + (i % box.w);
        const py = box.y + ((i / box.w) | 0);
        const x = px * ca + py * sa;
        const y = -px * sa + py * ca;
        let v;
        switch (kind) {
          case 'wood':
            // Broad bands of growth, broken by the fine streaks that run with the grain.
            v = 0.5 + 0.5 * Math.sin(((y + fb(n1, x * 0.35, y, scale * 3, 3) * scale * 2.4) / scale) * Math.PI * 0.8);
            v = v * 0.45 + 0.55 * smooth(0.25, 0.75, fb(n2, x * 0.06, y * 1.2, scale * 0.3, 3));
            break;
          case 'marble':
            v = 0.5 + 0.5 * Math.sin((x / scale + 5 * fb(n1, px, py, scale * 2, 4)) * Math.PI);
            v = Math.pow(v, 3);
            break;
          case 'bark':
            v = 0.5 + 0.5 * Math.sin((x / scale) * Math.PI * 2 + 6 * fb(n1, x * 0.6, y * 0.08, scale, 3));
            v = smooth(0.2, 0.8, v) * 0.85 + 0.15 * fb(n2, px, py, scale * 0.3, 2);
            break;
          case 'cloth':
            v = 0.5 + 0.22 * (Math.sin((x / scale) * Math.PI * 8) + Math.sin((y / scale) * Math.PI * 8)) + 0.25 * (fb(n1, px, py, scale, 2) - 0.5);
            break;
          case 'clouds':
            v = smooth(0.38, 0.78, fb(n1, px, py, scale * 3, 5));
            break;
          case 'water':
            v = 0.5 + 0.5 * Math.sin((y / scale + 1.4 * fb(n1, x * 0.35, y * 1.2, scale * 1.5, 3)) * Math.PI * 2);
            v = smooth(0.55, 0.95, v);
            break;
          case 'stone': {
            const f = fb(n1, px, py, scale, 4);
            v = smooth(0.3, 0.75, f);
            v = v * 0.8 + 0.2 * fb(n2, px, py, scale * 0.18, 2);
            if (Math.abs(fb(n2, px, py, scale * 2.2, 3) - 0.5) < 0.005) v *= 0.35;
            break;
          }
          default:
            v = fb(n1, px, py, scale * 0.25, 2);
        }
        const rgb = mix(c1, c2, clamp(v));
        img.data[i * 4] = rgb[0];
        img.data[i * 4 + 1] = rgb[1];
        img.data[i * 4 + 2] = rgb[2];
        img.data[i * 4 + 3] = clamp(mask[i] * strength * (item.byValue ? v : 1)) * 255;
      }
      cx.putImageData(img, box.x, box.y);
      grainPass(c, (item.grain ?? 0.4) * (paper.kind === 'none' ? 0 : 1), box);
      const lx = layer.getContext('2d');
      lx.save();
      lx.globalCompositeOperation = item.blend ? BLENDS_IN[item.blend] ?? item.blend : 'source-over';
      lx.globalAlpha = clamp(item.opacity ?? 1);
      lx.drawImage(c, 0, 0);
      lx.restore();
    }

    return { W, H, paper, stroke, fill, image, strands, scatter, shade, cast, texture, outOfBounds, cutKey: () => lastCutKey };
  }

  // ---------- adjustments ----------

  /** Changes to the pixels of a canvas: levels, hue, saturation, lightness, contrast, warmth, blur, sharpen, grain, vignette, posterise. */
  function adjust(c, a, tile, seed) {
    if (!a) return;
    const W = c.width;
    const H = c.height;
    const cx = c.getContext('2d');
    if (a.blur) {
      if (tile) {
        const pad = Math.min(Math.max(W, H), Math.ceil(a.blur * 3) + 4);
        const big = canvas(W + pad * 2, H + pad * 2);
        const bx = big.getContext('2d');
        for (const ox of [-W, 0, W])
          for (const oy of [-H, 0, H]) bx.drawImage(c, pad + ox, pad + oy);
        const tmp = canvas(W, H);
        const tx = tmp.getContext('2d');
        tx.filter = `blur(${a.blur}px)`;
        tx.drawImage(big, -pad, -pad);
        cx.clearRect(0, 0, W, H);
        cx.drawImage(tmp, 0, 0);
      } else {
        const tmp = canvas(W, H);
        const tx = tmp.getContext('2d');
        tx.filter = `blur(${a.blur}px)`;
        tx.drawImage(c, 0, 0);
        cx.clearRect(0, 0, W, H);
        cx.drawImage(tmp, 0, 0);
      }
    }
    const img = cx.getImageData(0, 0, W, H);
    const d = img.data;
    const lv = a.levels;
    const black = lv?.black ?? 0;
    const white = lv?.white ?? 255;
    const gamma = lv?.gamma ?? 1;
    const contrast = a.contrast ?? 0;
    const sat = a.saturation ?? 0;
    const light = a.lightness ?? 0;
    const hue = (a.hue ?? 0) / 360;
    const warm = a.warmth ?? 0;
    const grain = a.grain ?? 0;
    const vig = a.vignette ?? 0;
    const post = a.posterize ?? 0;
    const n = grain ? noise2(seed * 5 + 3) : null;
    const src = a.sharpen ? new Uint8ClampedArray(d) : null;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (!d[i + 3]) continue;
        let r = d[i];
        let g = d[i + 1];
        let b = d[i + 2];
        if (src) {
          // Unsharp: each pixel against the mean of its four neighbours.
          const at = (dx, dy, k) => {
            const xx = tile ? (x + dx + W) % W : clamp(x + dx, 0, W - 1);
            const yy = tile ? (y + dy + H) % H : clamp(y + dy, 0, H - 1);
            return src[(yy * W + xx) * 4 + k];
          };
          const s = a.sharpen;
          r += s * (r - (at(-1, 0, 0) + at(1, 0, 0) + at(0, -1, 0) + at(0, 1, 0)) / 4);
          g += s * (g - (at(-1, 0, 1) + at(1, 0, 1) + at(0, -1, 1) + at(0, 1, 1)) / 4);
          b += s * (b - (at(-1, 0, 2) + at(1, 0, 2) + at(0, -1, 2) + at(0, 1, 2)) / 4);
        }
        if (lv) {
          const f = (v) => 255 * Math.pow(clamp((v - black) / Math.max(1, white - black)), 1 / gamma);
          r = f(r);
          g = f(g);
          b = f(b);
        }
        if (contrast) {
          const k = 1 + contrast;
          r = (r - 128) * k + 128;
          g = (g - 128) * k + 128;
          b = (b - 128) * k + 128;
        }
        if (warm) {
          r += warm * 22;
          b -= warm * 22;
          g += warm * 6;
        }
        if (sat || light || hue) {
          let [h, s, l] = rgbToHsl(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255));
          h = (h + hue + 1) % 1;
          s = clamp(s * (1 + sat));
          l = clamp(l + light * (light > 0 ? 1 - l : l));
          [r, g, b] = hslToRgb(h, s, l);
        }
        if (vig) {
          const dx = x / W - 0.5;
          const dy = y / H - 0.5;
          const k = 1 - vig * smooth(0.15, 0.75, Math.hypot(dx, dy) * 1.25);
          r *= k;
          g *= k;
          b *= k;
        }
        if (n) {
          const v = ((tile ? fbm(n, x, y, 2, 1, W, H, true) : n(x * 0.9, y * 0.9)) - 0.5) * grain * 255;
          r += v;
          g += v;
          b += v;
        }
        if (post) {
          const q = 255 / Math.max(1, post - 1);
          r = Math.round(r / q) * q;
          g = Math.round(g / q) * q;
          b = Math.round(b / q) * q;
        }
        d[i] = clamp(r, 0, 255);
        d[i + 1] = clamp(g, 0, 255);
        d[i + 2] = clamp(b, 0, 255);
      }
    }
    cx.putImageData(img, 0, 0);
  }

  // ---------- the document ----------

  const BLENDS = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', 'soft-light': 'soft-light', 'hard-light': 'hard-light', darken: 'darken', lighten: 'lighten', 'color-burn': 'color-burn', 'color-dodge': 'color-dodge', color: 'color', luminosity: 'luminosity' };

  async function loadImages(doc) {
    const out = new Map();
    for (const layer of doc.layers ?? []) {
      for (const item of layer.items ?? []) {
        if (item.image && item.src && !out.has(item.image)) {
          const img = new Image();
          img.src = item.src;
          try {
            await img.decode();
            out.set(item.image, img);
          } catch {
            out.set(item.image, null);
          }
        }
      }
    }
    return out;
  }

  window.__paint = async (input) => {
    const notes = [];
    const doc = prepare(input, notes);
    const p = painter(doc, notes);
    const { W, H } = p;
    const images = await loadImages(doc);
    const out = canvas(W, H);
    const ox = out.getContext('2d');
    if (doc.background) {
      ox.fillStyle = rgbCss(parseColor(doc.background));
      ox.fillRect(0, 0, W, H);
    }
    // show: false keeps the tooth the media catch and leaves the ground clear: a plate to lay over others.
    if (p.paper.has && doc.paper?.show !== false) ox.drawImage(p.paper.look, 0, 0);
    const groundData = ox.getImageData(0, 0, W, H).data;
    const done = new Map();
    for (const [li, layer] of (doc.layers ?? []).entries()) {
      const c = canvas(W, H);
      for (const item of layer.items ?? []) {
        // A fill names its brush too: it is a fill first.
        if (item.strands) p.strands(c, item);
        else if (item.scatter) p.scatter(c, item);
        else if (item.shade) p.shade(c, { ...item, region: Array.isArray(item.region) ? item.region : Array.isArray(item.shade) ? item.shade : item.region });
        else if (item.cast) p.cast(c, { ...item, region: Array.isArray(item.region) ? item.region : Array.isArray(item.cast) ? item.cast : item.region });
        else if (item.texture) p.texture(c, item);
        else if (item.fill) p.fill(c, BLENDS[item.blend] ? { ...item, blend: BLENDS[item.blend] } : item);
        else if (item.stroke || item.brush) p.stroke(c, BLENDS[item.blend] ? { ...item, blend: BLENDS[item.blend] } : item);
        else if (item.image) p.image(c, BLENDS[item.blend] ? { ...item, blend: BLENDS[item.blend] } : item, images.get(item.image));
        else notes.push(`Layer ${layer.name ?? li + 1}: an item needs stroke, fill, image, strands, scatter, shade, cast or texture.`);
      }
      if (layer.adjust) adjust(c, layer.adjust, !!doc.tile, (doc.seed ?? 1) + li);
      if (layer.clip && done.has(layer.clip)) {
        const cx = c.getContext('2d');
        cx.globalCompositeOperation = 'destination-in';
        cx.drawImage(done.get(layer.clip), 0, 0);
      }
      ox.save();
      ox.globalAlpha = clamp(layer.opacity ?? 1);
      ox.globalCompositeOperation = BLENDS[layer.blend ?? 'normal'] ?? 'source-over';
      ox.drawImage(c, 0, 0);
      ox.restore();
      if (layer.name) done.set(layer.name, c);
    }
    // Measure marks before whole-picture vignette/grain so ink coverage reflects what was actually painted.
    const markData = ox.getImageData(0, 0, W, H).data;
    if (doc.adjust) adjust(out, doc.adjust, !!doc.tile, doc.seed ?? 1);
    const finalData = doc.adjust ? ox.getImageData(0, 0, W, H).data : markData;
    const totalPx = W * H;
    let marked = 0;
    let mx0 = W, my0 = H, mx1 = -1, my1 = -1;
    let lumSum = 0;
    const hist = new Uint32Array(101);
    const cellLum = new Float64Array(9);
    const cellMark = new Uint32Array(9);
    const cellN = new Uint32Array(9);
    for (let y = 0; y < H; y++) {
      const gy = Math.min(2, Math.floor((y * 3) / H));
      for (let x = 0; x < W; x++) {
        const gx = Math.min(2, Math.floor((x * 3) / W));
        const ci = gy * 3 + gx;
        const i = (y * W + x) * 4;
        cellN[ci]++;
        const diff = Math.abs(markData[i] - groundData[i]) + Math.abs(markData[i + 1] - groundData[i + 1]) + Math.abs(markData[i + 2] - groundData[i + 2]) + Math.abs(markData[i + 3] - groundData[i + 3]);
        if (diff > 18) {
          marked++;
          cellMark[ci]++;
          if (x < mx0) mx0 = x;
          if (x > mx1) mx1 = x;
          if (y < my0) my0 = y;
          if (y > my1) my1 = y;
        }
        const a = finalData[i + 3] / 255;
        const lum = ((0.2126 * finalData[i] + 0.7152 * finalData[i + 1] + 0.0722 * finalData[i + 2]) / 255) * a + (1 - a);
        const lp = Math.max(0, Math.min(100, Math.round(lum * 100)));
        lumSum += lp;
        hist[lp]++;
        cellLum[ci] += lp;
      }
    }
    const pctAt = (q) => {
      const want = totalPx * q;
      let acc = 0;
      for (let k = 0; k <= 100; k++) {
        acc += hist[k];
        if (acc >= want) return k;
      }
      return 100;
    };
    let seam = null;
    if (doc.tile && W >= 4 && H >= 4) {
      const stepRGB = (i, j) => (Math.abs(finalData[i] - finalData[j]) + Math.abs(finalData[i + 1] - finalData[j + 1]) + Math.abs(finalData[i + 2] - finalData[j + 2])) / 3;
      let sx = 0, ix = 0, sy = 0, iy = 0;
      const midX = W >> 1;
      const midY = H >> 1;
      for (let y = 0; y < H; y++) {
        sx += stepRGB((y * W + (W - 1)) * 4, (y * W) * 4);
        ix += stepRGB((y * W + (midX - 1)) * 4, (y * W + midX) * 4);
      }
      for (let x = 0; x < W; x++) {
        sy += stepRGB(((H - 1) * W + x) * 4, x * 4);
        iy += stepRGB(((midY - 1) * W + x) * 4, (midY * W + x) * 4);
      }
      seam = { x: +(sx / H).toFixed(1), innerX: +(ix / H).toFixed(1), y: +(sy / W).toFixed(1), innerY: +(iy / W).toFixed(1) };
    }
    const stats = {
      markPct: Math.round((marked / totalPx) * 100),
      markBox: mx1 >= 0 ? [mx0, my0, mx1 - mx0 + 1, my1 - my0 + 1] : null,
      lumMean: Math.round(lumSum / totalPx),
      lumRange: [pctAt(0.05), pctAt(0.95)],
      grid: Array.from({ length: 9 }, (_, k) => [cellN[k] ? Math.round(cellLum[k] / cellN[k]) : 100, cellN[k] ? Math.round((cellMark[k] / cellN[k]) * 100) : 0]),
      seam,
    };
    if (p.outOfBounds.n) notes.push(`${p.outOfBounds.n} points lie outside the ${W}×${H} picture.`);
    return { png: out.toDataURL('image/png'), notes, size: [W, H], stats, cutKey: p.cutKey() };
  };
})();
