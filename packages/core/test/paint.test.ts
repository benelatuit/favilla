import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession, browserTool, findBrowser } from '../src/tools/browser';
import { paintTool } from '../src/tools/paint';
import type { ToolContext } from '../src/tools/types';

const exe = findBrowser();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-paint-'));
// Canvases are kept under Favilla's own folder: a scratch one here.
process.env.FAVILLA_HOME = path.join(dir, '.home');
fs.mkdirSync(process.env.FAVILLA_HOME, { recursive: true });
let browser: BrowserSession | null = null;
beforeAll(async () => {
  if (exe) {
    browser = new BrowserSession(exe, false);
    await browser.start();
  }
  // A browser takes its time to start beside the whole suite: this hook failing was the file's one flake.
}, 60_000);
afterAll(() => {
  browser?.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ctx = () =>
  ({
    cwd: dir,
    turn: 't1',
    model: { vision: true },
    browser: () => browser,
    checkpoints: { capture: () => {} },
    files: { recordWrite: () => {}, checkEditable: () => undefined },
  }) as unknown as ToolContext;

/** Width and height from a PNG's header. */
const sizeOf = (file: string) => {
  const b = fs.readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

describe.skipIf(!exe)('paint', () => {
  it('paints a document into a PNG with a check sheet, and says what it did not know', async () => {
    const doc = [
      'size: [320, 200]',
      'paper: { type: cold-press }',
      'layers:',
      '  - name: wash',
      '    blend: multiply',
      '    items:',
      '      - { fill: wash, region: [[20, 20], [300, 30], [290, 180], [30, 170]], color: "#8fb3c9", to: "#e7c9a0", direction: 0 }',
      '  - name: line',
      '    items:',
      '      - { stroke: brushpen, color: "#26221e", size: 8, points: [[40, 150, 0.2], [160, 160, 1], [280, 150, 0.1]] }',
      '      - { stroke: crayola, points: [[10, 10], [20, 20]] }',
    ].join('\n');
    const r = await paintTool.execute({ path: 'banner.paint.yaml', doc }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/^Painted banner\.paint\.yaml into banner\.png \(320×200\)/);
    expect(r.content).toContain('No brush "crayola"');
    expect(sizeOf(path.join(dir, 'banner.png'))).toEqual([320, 200]);
    expect(r.images?.length).toBe(2);
  }, 60_000);

  it('shows a tile repeated 2×2, and retouches a picture placed in a layer', async () => {
    const tile = await paintTool.execute({ path: 'paper.paint.yaml', doc: 'size: [128, 128]\ntile: true\npaper: { type: kraft }\nlayers:\n  - items: [{ fill: crosshatch, brush: pencil, color: "#4a3a28", spacing: 14, size: 2 }]\n' }, ctx());
    expect(tile.isError).toBeFalsy();
    expect(tile.content).toContain('repeated 2×2');
    const photo = await paintTool.execute({ path: 'photo.paint.yaml', out: 'warm.png', doc: 'size: [128, 128]\nlayers:\n  - items: [{ image: paper.png, fit: cover }]\n    adjust: { warmth: 0.5, contrast: 0.2 }\nadjust: { grain: 0.05, vignette: 0.3 }\n' }, ctx());
    expect(photo.isError).toBeFalsy();
    expect(sizeOf(path.join(dir, 'warm.png'))).toEqual([128, 128]);
  }, 60_000);

  it('cuts a picture out of its ground: the border colour gone, the subject whole, its edge free of the old ground', async () => {
    const photo = await paintTool.execute({ path: 'subject.paint.yaml', out: 'subject.png', doc: 'size: [96, 96]\nbackground: "#ff00ff"\nlayers:\n  - items: [{ fill: flat, region: [[24, 24], [72, 24], [72, 72], [24, 72]], color: "#22aa66" }]\n' }, ctx());
    expect(photo.isError).toBeFalsy();
    const cut = await paintTool.execute({ path: 'cut.paint.yaml', out: 'cut.png', doc: 'size: [96, 96]\npaper: { type: none }\nlayers:\n  - items: [{ image: subject.png, fit: stretch, key: auto }]\n' }, ctx());
    expect(cut.isError).toBeFalsy();
    const png = fs.readFileSync(path.join(dir, 'cut.png')).toString('base64');
    const r = await browser!.paint('<!doctype html><body></body>', {
      width: 16,
      height: 16,
      probe: `(async () => { const i = new Image(); i.src = 'data:image/png;base64,${png}'; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; const at = (px, py) => Array.from(d.slice((py * c.width + px) * 4, (py * c.width + px) * 4 + 4)); let pink = 0; for (let k = 0; k < d.length; k += 4) if (d[k + 3] > 40 && d[k] > 150 && d[k + 2] > 150 && d[k + 1] < 110) pink++; return { corner: at(2, 2), middle: at(48, 48), pink }; })()`,
    });
    const p = r.probe as { corner: number[]; middle: number[]; pink: number };
    expect(p.corner[3]).toBe(0);
    expect(p.middle[3]).toBe(255);
    expect(p.middle[1]).toBeGreaterThan(p.middle[0] + 60);
    // No magenta fringe left around the subject.
    expect(p.pink).toBeLessThan(12);
  }, 60_000);

  it('cuts a picture out in one call: written only where out says, trimmed to the subject, shown on three grounds', async () => {
    const made = await paintTool.execute({ path: 'badge.paint.yaml', out: 'badge.png', doc: 'size: [120, 80]\nbackground: "#ffffff"\nlayers:\n  - items: [{ fill: flat, region: [[30, 20], [90, 20], [90, 60], [30, 60]], color: "#1f4fa8" }]\n' }, ctx());
    expect(made.isError).toBeFalsy();
    const before = new Set(fs.readdirSync(dir));
    const r = await paintTool.execute({ cut: 'badge.png', out: 'art/badge-cut.png', trim: true }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/^Cut the ground out of badge\.png into art[\\/]badge-cut\.png/);
    expect(r.content).toMatch(/Trimmed to/);
    // In numbers too, for a model that cannot see it.
    expect(r.content).toMatch(/Measured: \d+% opaque, \d+% clear, 4 of 4 corners clear, what is left spans/);
    // The subject is 60×40 and its edge about two pixels deep; the trim keeps two more round it.
    const [w, h] = sizeOf(path.join(dir, 'art', 'badge-cut.png'));
    expect(w).toBeGreaterThanOrEqual(60);
    expect(w).toBeLessThanOrEqual(70);
    expect(h).toBeGreaterThanOrEqual(40);
    expect(h).toBeLessThanOrEqual(50);
    // The cutout and its sheet on white, near-black and a checkerboard.
    expect(r.images).toHaveLength(2);
    // Nothing else came into the project: only the folder of the cutout.
    expect([...fs.readdirSync(dir)].filter((f) => !before.has(f))).toEqual(['art']);
    expect(fs.readdirSync(path.join(dir, 'art'))).toEqual(['badge-cut.png']);
    // Without out it stays outside the project and says how to bring it in.
    const loose = await paintTool.execute({ cut: 'badge.png' }, ctx());
    expect(loose.isError).toBeFalsy();
    expect(loose.content).toMatch(/outside the project: give out/);
    expect([...fs.readdirSync(dir)].filter((f) => !before.has(f))).toEqual(['art']);
    expect((await paintTool.execute({ cut: 'nowhere.png' }, ctx())).content).toMatch(/nowhere\.png was not found/);
    // An icon in one call: cut, trimmed and fitted into the box asked for.
    const icon = await paintTool.execute({ cut: 'badge.png', out: 'favicon.png', trim: true, size: [32, 32] }, ctx());
    expect(icon.content).toMatch(/Fitted into 32×32/);
    expect(sizeOf(path.join(dir, 'favicon.png'))).toEqual([32, 32]);
  }, 60_000);

  it('refuses what it cannot paint', async () => {
    expect((await paintTool.execute({ path: 'huge.paint.yaml', doc: 'size: [9000, 9000]\n' }, ctx())).content).toMatch(/outside 8 to 4096/);
    expect((await paintTool.execute({ path: 'missing.paint.yaml', doc: 'size: [64, 64]\nlayers:\n  - items: [{ image: nowhere.png }]\n' }, ctx())).content).toMatch(/nowhere\.png was not found/);
    expect((await paintTool.execute({ path: 'broken.paint.yaml', doc: 'size: [64, 64\n' }, ctx())).content).toMatch(/does not read as YAML/);
    expect((await paintTool.execute({ path: 'picture.svg' }, ctx())).content).toMatch(/is a \.paint\.yaml/);
  }, 60_000);
});

/** How many of a picture's pixels differ from its first one: a rough measure that something was painted. */
const inked = async (file: string): Promise<number> => {
  const png = fs.readFileSync(file).toString('base64');
  const r = await browser!.paint('<!doctype html><body></body>', {
    width: 16,
    height: 16,
    probe: `(async () => { const i = new Image(); i.src = 'data:image/png;base64,${png}'; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - d[0]) + Math.abs(d[k + 1] - d[1]) + Math.abs(d[k + 2] - d[2]) > 24) n++; return n; })()`,
  });
  return r.probe as number;
};

describe.skipIf(!exe)('paint: a canvas kept by Favilla', () => {
  const home = process.env.FAVILLA_HOME!;
  const kept = (name: string) => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === `${name}.json`) hits.push(p);
      }
    };
    walk(home);
    return hits[0];
  };

  it('keeps the document outside the project, and changes it call by call', async () => {
    const before = fs.readdirSync(dir).length;
    const first = await paintTool.execute({ canvas: 'hero', doc: 'size: [240, 160]\nbackground: "#f4efe4"\nlayers:\n  - name: base\n    items:\n      - { fill: flat, rect: [20, 20, 200, 120], color: "#8fb3c9" }\n' }, ctx());
    expect(first.isError).toBeFalsy();
    expect(first.content).toContain('Layers: base 1.');
    // Nothing in the project: the document and the picture stay with Favilla.
    expect(fs.readdirSync(dir).length).toBe(before);
    expect(kept('hero')).toBeTruthy();

    const added = await paintTool.execute({ canvas: 'hero', layer: 'marks', items: '- { stroke: ink, color: "#222", size: 4, path: "M 30 130 C 80 40, 160 40, 210 130" }\n- { stroke: pen, color: "#222", ellipse: [120, 80, 30, 20], size: 2 }\n', out: 'hero.png' }, ctx());
    expect(added.content).toContain('Layers: base 1, marks 2.');
    expect(added.content).toMatch(/Added 2 on layer marks \(#2-#3\)/);
    expect(sizeOf(path.join(dir, 'hero.png'))).toEqual([240, 160]);
    const lined = fs.readFileSync(path.join(dir, 'hero.png'));

    // One item out, by number; `out` is remembered.
    const less = await paintTool.execute({ canvas: 'hero', remove: ['#2'] }, ctx());
    expect(less.content).toContain('marks 1');
    expect(fs.readFileSync(path.join(dir, 'hero.png')).equals(lined)).toBe(false);
    // Replace a layer, go back two changes, and a layer goes by name.
    await paintTool.execute({ canvas: 'hero', layer: 'marks', mode: 'replace', items: [{ stroke: 'pen', color: '#a00', size: 3, points: [[10, 10], [200, 150]] }] }, ctx());
    const back = await paintTool.execute({ canvas: 'hero', undo: 2 }, ctx());
    expect(back.content).toContain('marks 2');
    expect((await paintTool.execute({ canvas: 'hero', remove: ['nothere'] }, ctx())).content).toMatch(/No layer "nothere"/);
    expect((await paintTool.execute({ canvas: 'blank', remove: ['x'] }, ctx())).isError).toBeTruthy();
  }, 60_000);

  it('shows a part enlarged, and says what it does not know', async () => {
    const r = await paintTool.execute({ canvas: 'zoom', doc: 'size: [200, 200]\nlayers:\n  - items:\n      - { stroke: pen, color: "#000", size: 2, points: [[0, 0], [200, 200]] }\n      - { scatter: bananas }\n      - { texture: lava }\n', look: [50, 50, 60, 60] }, ctx());
    expect(r.images?.length).toBe(3);
    expect(r.content).toContain('3.0 times larger');
    expect(r.content).toContain('No scatter shape "bananas"');
    expect(r.content).toContain('No texture "lava"');
  }, 60_000);

  it('draws symbols and groups in their own frames', async () => {
    const doc = [
      'size: [300, 200]',
      'background: "#ffffff"',
      'symbols:',
      '  mark:',
      '    - { fill: flat, circle: [0, 0, 10], color: "#000000" }',
      'layers:',
      '  - name: a',
      '    items:',
      '      - { use: mark, at: [60, 100] }',
      '      - { use: mark, at: [240, 100], scale: 2, color: "#c00000" }',
      '      - { group: [{ stroke: pen, color: "#000", size: 2, points: [[0, 0], [40, 0]] }], at: [130, 60], rotate: 90 }',
      '      - { use: nothing }',
    ].join('\n');
    const r = await paintTool.execute({ canvas: 'marks', doc, out: 'marks.png' }, ctx());
    expect(r.content).toContain('No symbol "nothing"');
    const n = await inked(path.join(dir, 'marks.png'));
    // Two discs, one of twice the radius (about 314 + 1256 px), and a short line.
    expect(n).toBeGreaterThan(1000);
    expect(n).toBeLessThan(2600);
  }, 60_000);

  it('makes many marks from a few words: strands, scatter, form shading, cast shadows and textures', async () => {
    const one = async (name: string, item: Record<string, unknown>) => {
      const r = await paintTool.execute({ canvas: name, doc: JSON.stringify({ size: [320, 240], background: '#ffffff', layers: [{ name: 'a', items: [item] }] }), out: `${name}.png` }, ctx());
      expect(r.isError, r.content).toBeFalsy();
      expect(r.content).not.toMatch(/No (brush|scatter|texture|symbol)|needs (a region|the region)/);
      return inked(path.join(dir, `${name}.png`));
    };
    expect(await one('fur', { strands: 'fur', along: 'M 40 200 C 100 100, 220 100, 280 200', count: 400, length: [10, 24], colors: ['#7a3b16', '#c0682a'], size: [1, 2] })).toBeGreaterThan(1500);
    expect(await one('hair', { strands: 'hair', along: [[60, 30], [120, 90], [140, 200]], count: 120, length: [60, 120], color: '#2a1a10', spread: 30 })).toBeGreaterThan(1500);
    expect(await one('grass', { strands: 'grass', rect: [0, 160, 320, 80], count: 300, color: '#3f6b2a' })).toBeGreaterThan(1500);
    expect(await one('leaves', { scatter: 'leaf', rect: [20, 20, 280, 200], count: 60, size: [14, 26], colors: ['#b8532a', '#d9942e'], light: 'upper-left' })).toBeGreaterThan(3000);
    expect(await one('ball', { shade: true, circle: [160, 120, 90], form: 'sphere', light: 'upper-left', color: '#102040', strength: 0.8 })).toBeGreaterThan(3000);
    expect(await one('hatched', { shade: true, form: 'cylinder', rect: [100, 20, 120, 200], light: 'left', method: 'hatch', spacing: 5 })).toBeGreaterThan(800);
    expect(await one('fold', { shade: true, form: 'fold', rect: [40, 20, 240, 200], folds: 3, strength: 0.7 })).toBeGreaterThan(3000);
    expect(await one('shadow', { cast: true, ellipse: [160, 120, 40, 60], light: 'upper-left', strength: 0.8 })).toBeGreaterThan(800);
    for (const kind of ['wood', 'stone', 'marble', 'bark', 'cloth', 'clouds', 'water']) expect(await one(`t-${kind}`, { texture: kind, rect: [0, 0, 320, 240], color: '#3a2a1e', color2: '#c9a877', scale: 30 }), kind).toBeGreaterThan(5000);
  }, 120_000);
});

describe.skipIf(!exe)('paint: named outlines', () => {
  it('lets a mass, its shading and its shadow share one outline, and says when a name is unknown', async () => {
    const doc = ['size: [200, 200]', 'background: "#ffffff"', 'shapes:', '  rock: "M 40 150 C 40 60, 160 60, 160 150 Z"', 'layers:', '  - name: a', '    items:', '      - { fill: flat, path: "@rock", color: "#808080" }', '      - { shade: true, path: "@rock", form: sphere, light: upper-left }', '      - { fill: flat, path: "@nothing", color: "#ff0000" }'].join('\n');
    const r = await paintTool.execute({ canvas: 'rock', doc, out: 'rock.png' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('No shape "@nothing"');
    expect(await inked(path.join(dir, 'rock.png'))).toBeGreaterThan(3000);
  }, 60_000);

  it('paints full-canvas washes with direction words, wraps tile strokes seamlessly, and gives concise numbers when blind', async () => {
    const blindCtx = () => ({ ...ctx(), model: { vision: false }, signal: new AbortController().signal }) as unknown as ToolContext;
    const wash = await paintTool.execute(
      {
        canvas: 'wash-words',
        doc: 'size: [200, 150]\npaper: { type: cold-press }\nlayers:\n  - items:\n      - { fill: wash, color: "#223355", to: "#ddaa66", direction: down }\n      - { fill: wash, region: [], color: "#446688", direction: upper-left, strength: 0.3 }\n',
        out: 'wash-words.png',
      },
      blindCtx(),
    );
    expect(wash.isError, wash.content).toBeFalsy();
    expect(wash.images).toBeUndefined();
    expect(wash.content).toMatch(/Measured: \d+% marked \(bbox \d+,\d+ \d+×\d+\), lum \d+–\d+%/);
    expect(wash.content).toContain('3×3 lum%/mark%: TL ');

    const tiled = await paintTool.execute(
      {
        canvas: 'tile-seam',
        doc: [
          'size: [192, 192]',
          'tile: true',
          'paper: { type: canvas }',
          'layers:',
          '  - items:',
          '      - { fill: crosshatch, brush: pencil, color: "#4a3a28", spacing: 12, size: 2 }',
          '      - { stroke: airbrush, color: "#3a2a1e", size: 80, opacity: 0.45, points: [[-30, 96, 0.8], [40, 96, 0.8]] }',
          '      - { scatter: dot, count: 40, size: [6, 12], colors: ["#5c4632"] }',
          'adjust: { blur: 1, grain: 0.03 }',
        ].join('\n'),
        out: 'tile-seam.png',
      },
      blindCtx(),
    );
    expect(tiled.isError, tiled.content).toBeFalsy();
    expect(tiled.content).not.toContain('outside the 192×192 picture');
    const m = /seam ΔRGB (\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?) vs interior (\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/.exec(tiled.content);
    expect(m).toBeTruthy();
    const [sx, sy, ix, iy] = m!.slice(1).map(Number);
    expect(sx).toBeLessThan(ix * 2 + 6);
    expect(sy).toBeLessThan(iy * 2 + 6);

    // browser(out) exports an exact 1× width×height PNG even below 600 px width, and reports text boxes when blind.
    const htmlPath = path.join(dir, 'type-over-art.html');
    fs.writeFileSync(
      htmlPath,
      '<!doctype html><html><body style="margin:0;width:420px;height:260px;position:relative;background:#1b2230;color:#f5ebd6;font:700 32px serif"><div style="position:absolute;left:36px;top:32px">Autumn Study</div><div style="position:absolute;left:36px;bottom:28px;font:400 15px sans-serif"> Plate IV · Hand-ground ink </div></body></html>',
    );
    const shot = await browserTool.execute({ url: 'type-over-art.html', width: 420, height: 260, out: 'plate.png' }, blindCtx());
    expect(shot.isError, shot.content).toBeFalsy();
    expect(sizeOf(path.join(dir, 'plate.png'))).toEqual([420, 260]);
    expect(shot.content).toContain('saved plate.png (420×260)');
    expect(shot.content).toMatch(/Text layout: 2 text boxes, all inside 420×260, no overlap/);
  }, 60_000);
});
