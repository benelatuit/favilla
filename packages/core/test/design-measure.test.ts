import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserSession, findBrowser } from '../src/tools/browser';
import { designReport, MEASURE_SCRIPT, type DesignMeasure } from '../src/tools/design-measure';
import { designGuide } from '../src/prompt/system';

// The bar is what ten clean brand sites measured on 2026-11-07; the generated page is an agent's landing page of the
// same night, as measured. The last four figures are from 2026-11-11: a brand site's and a Favilla page's medians.
const brand: DesignMeasure = { sizes: 4, body: 20, scale: 3, lineHeight: 1.31, cjk: false, saturated: 0, labels: 0, pillShare: 0, gradients: 0, blurs: 0, emoji: 0, foldWords: 46, pictureShare: 53, families: ['ABC Oracle'], height: 8300, groundChanges: 4, groundColours: 3, boxedText: 11, tiltedText: 0, vividGround: 0 };
const generated: DesignMeasure = { sizes: 14, body: 15, scale: 5.9, lineHeight: 1.65, cjk: false, saturated: 6, labels: 30, pillShare: 39, gradients: 6, blurs: 1, emoji: 1, foldWords: 100, pictureShare: 1, families: ['Avenir Next', 'Iowan Old Style'], height: 4300, groundChanges: 5, groundColours: 3, boxedText: 52, tiltedText: 23, vividGround: 0 };

describe('the page measured against the bar of brand sites', () => {
  it('passes a brand page and names every way a generated one misses, those first', () => {
    expect(designReport(brand)).not.toContain('OUTSIDE THE BAR');
    const report = designReport(generated).split('\n');
    const outside = report.filter((l) => l.startsWith('- OUTSIDE THE BAR'));
    expect(outside).toHaveLength(13);
    expect(report.slice(0, outside.length)).toEqual(outside);
    expect(report.join('\n')).toContain('pictures cover 1% of the page');
  });

  it('holds Chinese text to its own body size and line height', () => {
    const chinese = { ...brand, cjk: true, body: 16, lineHeight: 1.75 };
    expect(designReport(chinese)).not.toContain('OUTSIDE THE BAR');
    expect(designReport({ ...chinese, lineHeight: 1.4 })).toContain('OUTSIDE THE BAR: body line height 1.4 (bar for Chinese text: 1.6 to 1.85)');
  });

  it('allows a long page more changes of ground than a short one, and one on any page', () => {
    expect(designReport({ ...brand, height: 4300, groundChanges: 5 })).toContain('OUTSIDE THE BAR: the ground behind the page changes colour 5 times in 4300px (bar: 3 or fewer');
    expect(designReport({ ...brand, height: 4300, groundChanges: 3 })).not.toContain('OUTSIDE THE BAR');
    expect(designReport({ ...brand, height: 800, groundChanges: 1 })).not.toContain('OUTSIDE THE BAR');
    expect(designReport({ ...brand, height: 800, groundChanges: 2 })).toContain('(bar: 1 or fewer');
  });

  it('holds a page to three grounds, and to four when it is long', () => {
    expect(designReport({ ...brand, height: 5200, groundChanges: 4, groundColours: 5 })).toContain('OUTSIDE THE BAR: the page has 5 different grounds (bar: 3 or fewer)');
    expect(designReport({ ...brand, height: 4300, groundChanges: 3, groundColours: 4 })).toContain('(bar: 3 or fewer)');
    expect(designReport({ ...brand, groundColours: 4 })).not.toContain('OUTSIDE THE BAR');
    expect(designReport({ ...brand, groundColours: 5 })).toContain('(bar: 4 or fewer)');
  });

  it('holds a page that is read to few boxes and leaves a screen people work in its panels', () => {
    expect(designReport({ ...brand, boxedText: 52 })).toContain('OUTSIDE THE BAR: 52% of the text sits inside a box');
    const screen = designReport({ ...brand, height: 900, groundChanges: 0, boxedText: 88 });
    expect(screen).not.toContain('OUTSIDE THE BAR');
    expect(screen).toContain('88% of the text sits inside a box');
    expect(designReport({ ...brand, tiltedText: 23 })).toContain('OUTSIDE THE BAR: 23% of the text is set at a tilt');
  });

  it('holds a page to a quiet ground', () => {
    expect(designReport({ ...brand, vividGround: 100 })).toContain("OUTSIDE THE BAR: 100% of the page's height lies on a saturated ground (bar: 20% or less)");
    expect(designReport({ ...brand, vividGround: 18 })).not.toContain('OUTSIDE THE BAR');
  });

  it('is a script the page can run, and the design guide asks for it only with a browser', () => {
    expect(() => new Function(`return ${MEASURE_SCRIPT}`)).not.toThrow();
    expect(designGuide('browser')).toContain('{measure: true}');
    expect(designGuide()).not.toContain('{measure: true}');
  });
});

// Two pages with the same words. One is striped in four grounds with its plans in bordered boxes and its quotes on
// tilted notes; the other keeps one ground, sets the same things as type and turns dark once at its close.
const words = (n: number) => Array.from({ length: n }, (_, i) => `Word${i}`).join(' ');
const page = (style: string, body: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body { margin: 0; font: 18px/1.4 Georgia, serif; color: #1a1a1a; background: oklch(97% 0.01 90); }
section { padding: 80px 64px; min-height: 480px; box-sizing: border-box; }
h2 { font-size: 54px; margin: 0 0 24px; } p { max-width: 60ch; margin: 0 0 16px; }
.row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; }
${style}</style></head><body>${body}</body></html>`;
const STRIPED = page(
  `.a { background: #ffd9e4; } .b { background: #101010; color: #f2f2f2; } .c { background: #c8f0dc; } .d { background: oklch(70% 0.2 300); }
.plan { border: 2px solid #1a1a1a; padding: 24px; } .note { background: #fff7b0; padding: 24px; transform: rotate(-3deg); box-shadow: 0 4px 0 #0003; }`,
  `<section><h2>Opening</h2><p>${words(30)}</p></section>
<section class="a"><h2>Plans</h2><div class="row">${[1, 2, 3].map(() => `<div class="plan"><p>${words(40)}</p></div>`).join('')}</div></section>
<section class="b"><h2>Steps</h2><p>${words(30)}</p></section>
<section class="c"><h2>Voices</h2><div class="row">${[1, 2, 3].map(() => `<div class="note"><p>${words(40)}</p></div>`).join('')}</div></section>
<section class="d"><h2>Close</h2><p>${words(30)}</p></section>`,
);
const PLAIN = page(
  `.close { background: #101010; color: #f2f2f2; }`,
  `<section><h2>Opening</h2><p>${words(30)}</p></section>
<section><h2>Plans</h2><div class="row">${[1, 2, 3].map(() => `<div><p>${words(40)}</p></div>`).join('')}</div></section>
<section><h2>Steps</h2><p>${words(30)}</p></section>
<section><h2>Voices</h2><div class="row">${[1, 2, 3].map(() => `<div><p>${words(40)}</p></div>`).join('')}</div></section>
<section class="close"><h2>Close</h2><p>${words(30)}</p></section>`,
);

// One strong blue under the whole page.
const LOUD = page(
  `body { background: #0a2be0; color: #fff; }`,
  [1, 2, 3, 4, 5].map((i) => `<section><h2>Part ${i}</h2><p>${words(30)}</p></section>`).join(''),
);

const exe = findBrowser();
describe.skipIf(!exe)('the measure in a real page', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-measure-'));
  let browser: BrowserSession | undefined;
  afterAll(() => {
    browser?.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const measure = async (name: string, html: string): Promise<DesignMeasure> => {
    if (!browser) {
      browser = new BrowserSession(exe!, false);
      await browser.start();
      await browser.viewport(1280, 800);
    }
    const file = path.join(dir, name);
    fs.writeFileSync(file, html);
    await browser.open(pathToFileURL(file).href);
    return browser.evaluate<DesignMeasure>(MEASURE_SCRIPT);
  };

  it('counts the stripes, the boxed words and the tilted words of a striped page, colours in oklch included', async () => {
    const m = await measure('striped.html', STRIPED);
    expect(m.groundChanges).toBe(4);
    expect(m.groundColours).toBeGreaterThanOrEqual(2);
    expect(m.boxedText).toBeGreaterThan(55);
    expect(m.tiltedText).toBeGreaterThan(25);
    expect(m.tiltedText).toBeLessThan(m.boxedText);
    const outside = designReport(m);
    expect(outside).toContain('OUTSIDE THE BAR: the ground behind the page changes colour 4 times');
    expect(outside).toMatch(/OUTSIDE THE BAR: \d+% of the text sits inside a box/);
    expect(outside).toMatch(/OUTSIDE THE BAR: \d+% of the text is set at a tilt/);
    // The last field is written in oklch: read as numbers in the string it would be no colour at all.
    expect(m.saturated).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('finds a saturated ground under the whole page', async () => {
    const m = await measure('loud.html', LOUD);
    expect(m.vividGround).toBe(100);
    expect(designReport(m)).toContain("OUTSIDE THE BAR: 100% of the page's height lies on a saturated ground");
    // The striped page has one saturated field at its close, a fifth of its height.
    const striped = await measure('striped2.html', STRIPED);
    expect(striped.vividGround).toBeLessThanOrEqual(25);
  }, 60_000);

  it('finds one change of ground and no boxes in the same words set plainly', async () => {
    const m = await measure('plain.html', PLAIN);
    expect(m.groundChanges).toBe(1);
    expect(m.boxedText).toBe(0);
    expect(m.tiltedText).toBe(0);
    expect(m.vividGround).toBe(0);
    const report = designReport(m);
    for (const part of ['changes colour', 'sits inside a box', 'set at a tilt', 'saturated ground']) expect(report.split('\n').find((l) => l.includes(part)), part).not.toContain('OUTSIDE');
  }, 60_000);
});
