import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserSession, findBrowser } from '../src/tools/browser';
import { auditNote, auditPage, pageFacts, serveFolder, staticEntry } from '../src/tools/pageaudit';

const roots: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-audit-'));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));

const BROKEN = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body { margin: 0; font: 16px system-ui; background: #fff; color: #222; }
.banner { width: 900px; }
.dot { width: 9px; height: 9px; padding: 0; border: 0; background: #2a6; }
.faint { color: #c4c9d2; }
</style></head><body>
<div class="banner">Spring offer</div>
<button class="dot" aria-label="Go to step 2"></button>
<p class="faint">Prices exclude VAT.</p>
<script>throw new Error('boom');</script>
</body></html>`;

// Colours as an author writes them today: computed styles keep oklch, and see-through fills sit over the page.
const OKLCH = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
:root { background: oklch(97.2% .014 83); color: oklch(26% .028 53); font: 16px system-ui; }
body { margin: 0; }
header { background: oklch(98.5% .011 83 / .8); }
.ghost { color: oklch(26% .028 53 / .2); }
.night { background: oklch(22% .03 260); color: oklch(96% .01 260); }
</style></head><body>
<header><b>daymark</b></header>
<h1>Make room for what matters.</h1>
<p class="ghost">Saved a while ago</p>
<p class="night">Night shift</p>
</body></html>`;

describe('page audit', () => {
  it('runs only for a folder that needs no build step', () => {
    const plain = tmp();
    fs.writeFileSync(path.join(plain, 'index.html'), '<!doctype html><script src="app.js"></script>');
    expect(staticEntry(plain)).toBe(path.join(plain, 'index.html'));
    const vite = tmp();
    fs.writeFileSync(path.join(vite, 'index.html'), '<!doctype html><script type="module" src="/src/main.tsx"></script>');
    expect(staticEntry(vite)).toBeNull();
    const pkg = tmp();
    fs.writeFileSync(path.join(pkg, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ devDependencies: { vite: '^7.0.0' } }));
    expect(staticEntry(pkg)).toBeNull();
    expect(staticEntry(tmp())).toBeNull();
  });

  it.skipIf(!findBrowser())('measures errors, sideways scrolling, contrast and tap targets', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'index.html'), BROKEN);
    const served = await serveFolder(dir);
    const b = new BrowserSession(findBrowser()!, false);
    try {
      await b.start();
      const issues = await auditPage(b, served.url);
      const kinds = (w: number) => issues.filter((i) => i.width === w).map((i) => i.kind).sort();
      expect(kinds(390)).toEqual(['contrast', 'error', 'overflow', 'tap']);
      expect(issues.find((i) => i.kind === 'tap')!.detail).toBe('Go to step 2 9x9');
      expect(issues.find((i) => i.kind === 'overflow' && i.width === 390)!.detail).toBe('the page is 900 px wide on a 390 px screen');
      expect(issues.find((i) => i.kind === 'contrast')!.detail).toMatch(/^Prices exclude VAT\. 1\.\d$/);
      expect(auditNote(issues, 'index.html')).toMatch(/^Favilla opened index\.html at 1280 and 390 px wide/);
    } finally {
      b.close();
      served.close();
    }
  }, 60_000);

  it.skipIf(!findBrowser())('reads oklch colours and see-through text and fills', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'index.html'), OKLCH);
    const served = await serveFolder(dir);
    const b = new BrowserSession(findBrowser()!, false);
    try {
      await b.start();
      const contrast = (await auditPage(b, served.url, [1280])).filter((i) => i.kind === 'contrast');
      // Only the faded line is too faint; the dark-on-cream text and the light-on-night line pass.
      expect(contrast.map((i) => i.detail)).toEqual([expect.stringMatching(/^Saved a while ago 1\.\d$/)]);
    } finally {
      b.close();
      served.close();
    }
  }, 60_000);

  it.skipIf(!findBrowser())('finds a game canvas that runs past the first screen', async () => {
    const dir = tmp();
    // A board 720 px tall under a 160 px header: whole on a full-page shot, cut off on a 1280×800 screen.
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}header{height:160px}canvas{display:block;width:min(960px,100%);aspect-ratio:4/3}.icon{width:40px;height:40px}</style><header>Breakout</header><canvas></canvas><canvas class="icon"></canvas>',
    );
    const served = await serveFolder(dir);
    const b = new BrowserSession(findBrowser()!, false);
    try {
      await b.start();
      const fold = (await auditPage(b, served.url)).filter((i) => i.kind === 'fold');
      // At 390 px the board shrinks to 390×293 and fits; the 40 px canvas is an icon, not a field of play.
      expect(fold.map((i) => [i.width, i.detail])).toEqual([[1280, '960×720 canvas from y 160 to 880 on a 800 px tall screen']]);
      expect(auditNote(fold, 'index.html')).toContain('1280 px, a canvas past the bottom of the first screen (playing it needs scrolling): 960×720 canvas');
    } finally {
      b.close();
      served.close();
    }
  }, 60_000);

  // What the drawn directions' crops and overlaps did to words on half the pages (2026-11-02).
  it.skipIf(!findBrowser())('names text past the edge, cut off by its box or lying on other text', async () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body { margin: 0; font: 16px/1.2 system-ui; }
header { position: fixed; top: 0; left: 0; right: 0; background: #fff; }
.big { font-size: 180px; white-space: nowrap; margin: 40px 0 0; }
.short { height: 20px; overflow: hidden; }
.mark { position: relative; }
.mark span { position: absolute; top: -6px; left: 0; font-size: 40px; }
.name { width: 80px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lay { position: relative; }
.lay img { position: absolute; top: 0; left: 0; width: 300px; height: 40px; }
</style>
<header>Menu</header>
<p style="margin:0">Under the header</p>
<h1 class="big">Punctuation everywhere</h1>
<div class="short"><p style="margin:0">Line one<br>Line two</p></div>
<div class="mark"><p>Production bugs, recorded as they happen</p><span>Tracewell</span></div>
<div class="name">A very long file name, shortened.txt</div>
<div class="lay"><p style="margin:0">Words under a picture</p><img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='40'%3E%3Crect width='300' height='40' fill='red'/%3E%3C/svg%3E"></div>`,
    );
    const served = await serveFolder(dir);
    const b = new BrowserSession(findBrowser()!, false);
    try {
      await b.start();
      await b.viewport(1280, 800);
      await b.open(served.url);
      const measured = (await pageFacts(b, false)).split('\n').find((l) => l.startsWith('Measured:')) ?? '';
      expect(measured).toContain(`text running past the screen's edge: "Punctuation everywhere"`);
      expect(measured).toContain('text cut off by its box: "Line two"');
      expect(measured).toContain('text lying on other text: "Production bugs, recorded as they happen" and "Tracewell"');
      expect(measured).toContain('text with something laid over it: "Words under a picture" under img');
      expect(measured).not.toContain('Under the header');
      expect(measured).not.toContain('A very long file name');
      expect(measured).not.toContain('"Production bugs, recorded as they happen" under');
    } finally {
      b.close();
      served.close();
    }
  }, 60_000);

  // What taste-skill's checker finds on pages made without it (2026-11-06): content waiting for a scroll to show,
  // type that fell back, copy never written, links into nothing, pictures stretched soft.
  it.skipIf(!findBrowser())('names what an unfinished page still has, and leaves menus, tooltips and system faces alone', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'tiny.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mPYmiqLFTEMLQkAh4pNwcwO4KQAAAAASUVORK5CYII=', 'base64'));
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body { margin: 0; font: 16px/1.4 system-ui; }
h1 { font-family: "Fraunces Nowhere", serif; }
.reveal { opacity: 0; transform: translateY(24px); }
nav ul { opacity: 0; }
.tip { position: absolute; opacity: 0; }
</style>
<nav><ul><li><a href="#about">About this little shop of teas</a></li></ul></nav>
<h1>Harbor Tea, poured by the window</h1>
<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
<p id="about">We have brewed by the harbour since 1998. <a href="#pricing">See prices</a> <a href="#">Top</a> <a href="#/cart">Cart</a></p>
<span class="tip">A tooltip that waits for the pointer to arrive</span>
<img src="tiny.png" alt="" style="width:200px;height:150px">
<section class="reveal"><h2>Our teas</h2><p>Oolong, sencha and a smoky lapsang, weighed to order.</p></section>
<p class="total">Basket total: ¥NaN for 3 items</p>
<p>Delivery: undefined</p>
<p>In JavaScript an unset variable is undefined until it is assigned.</p>`,
    );
    const served = await serveFolder(dir);
    const b = new BrowserSession(findBrowser()!, false);
    try {
      await b.start();
      await b.viewport(1280, 800);
      await b.open(served.url);
      const measured = (await pageFacts(b, false)).split('\n').find((l) => l.startsWith('Measured:')) ?? '';
      expect(measured).toContain('text invisible at rest until a script reveals it');
      expect(measured).toContain('"Our teas Oolong, sencha and a smoky laps"');
      expect(measured).toContain('type falling back to a default face, its family neither loaded nor installed: h1 "Fraunces Nowhere"');
      expect(measured).toContain('placeholder text: "Lorem ipsum dolor sit amet, consectetur"');
      expect(measured).toContain('links to anchors the page does not have: #pricing;');
      expect(measured).toContain('pictures blown up past their own size (blurry): tiny.png 8×8 shown at 200×150');
      expect(measured).toContain('values a script did not fill in, shown as they came out: "Basket total: ¥NaN for 3 items", "Delivery: undefined"');
      expect(measured).not.toContain('an unset variable');
      expect(measured).not.toContain('About this little shop');
      expect(measured).not.toContain('A tooltip');
      expect(measured).not.toContain('system-ui');
      expect(measured).not.toMatch(/#about|#\/cart|#[,;.]/);
    } finally {
      b.close();
      served.close();
    }
  }, 60_000);
});
