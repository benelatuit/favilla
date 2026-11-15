import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BrowserSession, browserTool, findBrowser } from '../src/tools/browser';
import type { ToolContext } from '../src/tools/types';

const exe = findBrowser();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-browser-test-'));
const session = exe ? new BrowserSession(exe, false) : null;
afterAll(() => {
  session?.close();
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 2000);
});

describe.runIf(!!exe)('a benchmark browser', () => {
  it('stays offline with a proxy configured, and still reads local pages', async () => {
    // The configured proxy keeps a list of what reaches it: of two proxy flags the browser would take this one.
    const asked: string[] = [];
    const proxy = http.createServer((req, res) => {
      asked.push(req.url ?? '');
      res.end('through the proxy');
    });
    proxy.on('connect', (req, socket) => {
      asked.push(req.url ?? '');
      socket.destroy();
    });
    const local = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<p>a local page</p>');
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    const was = process.env.FAVILLA_WEB_FETCH;
    process.env.FAVILLA_WEB_FETCH = 'off';
    const s = new BrowserSession(exe!, `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    try {
      await s.start();
      await s.open('http://outside.example/').catch(() => {});
      await s.open(`http://127.0.0.1:${(local.address() as AddressInfo).port}/`);
      expect(await s.readText(200)).toContain('a local page');
      expect(asked).toEqual([]);
    } finally {
      s.close();
      if (was === undefined) delete process.env.FAVILLA_WEB_FETCH;
      else process.env.FAVILLA_WEB_FETCH = was;
      proxy.close();
      local.close();
    }
  }, 30_000);
});

const page = `<!doctype html><meta charset="utf-8"><title>Signup</title>
<label>Name <input id="name"></label>
<button onclick="document.querySelector('#out').textContent = 'Hello, ' + document.querySelector('#name').value; console.error('save failed: 500')">Save</button>
<p id="out">Nothing yet</p>`;

describe.runIf(!!exe)('browser', () => {
  it.each([
    { js: 'new Promise(() => {})' },
    { wait: 15_000 },
    { wait: '#never-appears' },
    { wait: 'load' },
  ])('interrupts an in-flight action without running the remaining actions: %j', async (action) => {
    const s = new BrowserSession(exe!, false);
    const controller = new AbortController();
    const ctx = { cwd: dir, signal: controller.signal, model: { vision: false }, browser: () => s } as unknown as ToolContext;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const act = s.act.bind(s);
    const calls = vi.spyOn(s, 'act').mockImplementation((a, cwd) => {
      const result = act(a, cwd);
      started();
      return result;
    });
    let work: Promise<string> | undefined;
    try {
      await s.start();
      work = browserTool.execute({ actions: [action, { js: 'document.title = "must not run"' }] }, ctx).then(
        () => 'finished',
        (e: Error) => e.name,
      );
      await began;
      controller.abort();
      expect(await Promise.race([work, new Promise((r) => setTimeout(() => r('still waiting'), 1000))])).toBe('AbortError');
      expect(calls).toHaveBeenCalledTimes(1);
      // Cancelling an operation leaves the session usable, without stale pending requests.
      expect(await s.evaluate('1 + 1')).toBe(2);
    } finally {
      s.close();
      await work;
    }
  }, 30_000);

  it('opens a page, types, clicks by text, and reports what the page said', async () => {
    fs.writeFileSync(path.join(dir, 'signup.html'), page);
    const ctx = { cwd: dir, signal: new AbortController().signal, model: { vision: true }, browser: () => session } as unknown as ToolContext;
    const r = await browserTool.execute({ url: 'signup.html', actions: [{ type: 'Ada', into: '#name' }, { click: 'text=Save' }] }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('"Signup"');
    expect(r.content).toContain('Done: opened signup.html; typed "Ada" into #name; clicked text=Save.');
    expect(r.content).toContain('Hello, Ada');
    expect(r.content).toMatch(/console\.error: save failed: 500/);
    expect(r.images?.[0].mediaType).toBe('image/png');
    // The page stays open: the next call sees the same state, and a missing element stops with a reason.
    const again = await browserTool.execute({ actions: [{ click: '#missing' }] }, ctx);
    expect(again.isError).toBe(true);
    expect(again.content).toContain('Stopped: nothing matches #missing');
    expect(again.content).toContain('Hello, Ada');
    expect(again.content).toContain('No console errors or failed requests.');
  }, 60_000);

  it('holds a button down for the screenshot and lets go at the next action or call', async () => {
    fs.writeFileSync(path.join(dir, 'press.html'), '<!doctype html><title>Press</title><style>button{padding:20px}button:active{background:rgb(1,2,3)}</style><button id="buy">Buy</button>');
    const ctx = { cwd: dir, signal: new AbortController().signal, model: { vision: false }, browser: () => session } as unknown as ToolContext;
    const pressed = () => session!.evaluate<boolean>(`document.querySelector('#buy').matches(':active')`);
    const r = await browserTool.execute({ url: 'press.html', actions: [{ click: '#buy', hold: true }] }, ctx);
    expect(r.content).toContain('pressed #buy and held it down');
    expect(await pressed()).toBe(true);
    await browserTool.execute({ actions: [{ hover: '#buy' }] }, ctx);
    expect(await pressed()).toBe(false);
    await browserTool.execute({ actions: [{ click: '#buy', hold: true }] }, ctx);
    await browserTool.execute({}, ctx);
    expect(await pressed()).toBe(false);
  }, 60_000);
});

const form = `<!doctype html><meta charset="utf-8"><title>Order</title>
<h1>Order form</h1>
<label>Email <input id="email" value="old@x.io"></label>
<label>Country <select id="country"><option>Singapore</option><option value="jp">Japan</option></select></label>
<label><input type="checkbox" id="gift"> Gift wrap</label>
<label>Receipt <input type="file" id="receipt"></label>
<div class="fake-btn" style="cursor:pointer" onclick="document.querySelector('#out').textContent = 'div clicked'">Fancy button</div>
<button id="send" onclick="if (confirm('Send the order?')) document.querySelector('#out').textContent = [document.querySelector('#email').value, document.querySelector('#country').value, document.querySelector('#gift').checked, (document.querySelector('#receipt').files[0] || {}).name].join(' / ')">Send</button>
<a href="second.html" target="_blank">Terms</a>
<a href="second.html" id="same">Terms here</a>
<p id="out">Nothing yet</p>`;
const second = `<!doctype html><meta charset="utf-8"><title>Terms</title><main><h1>Terms</h1><p>Rule one: be kind.</p><ul><li>Rule two: ship it.</li></ul></main>`;

describe.runIf(!!exe)('browser control', () => {
  it('shows a whole page in one call as the screens a visitor scrolls through', async () => {
    const tall = (px: number) => `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tall</title><style>html{scroll-behavior:smooth}body{margin:0}header{position:sticky;top:0;height:40px;background:#222}</style><header></header><div style="height:${px - 40}px;background:linear-gradient(#fff,#06c)"></div>`;
    const ctx = { cwd: dir, signal: new AbortController().signal, model: { vision: true }, browser: () => session } as unknown as ToolContext;
    const size = (png: string) => { const b = Buffer.from(png, 'base64'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    fs.writeFileSync(path.join(dir, 'tall.html'), tall(1000));
    // Where the page stood before the look is where it stands after it.
    const r = await browserTool.execute({ url: 'tall.html', width: 400, height: 400, fullPage: true, actions: [{ scroll: 120 }] }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/at 400×400 \(the whole page, 1000 px tall, attached as its 3 screens from top to bottom\)/);
    expect(r.images?.map((i) => i.name)).toEqual(['screen 1 of 3', 'screen 2 of 3', 'screen 3 of 3']);
    for (const i of r.images ?? []) expect(size(i.data)).toEqual([400, 400]);
    // Three different screens: a strip clipped beyond the viewport, or a smooth scroll still on its way, would repeat one.
    expect(new Set(r.images?.map((i) => i.data)).size).toBe(3);
    expect(await session!.evaluate('scrollY')).toBe(120);
    // More screens than one request should carry: the first eight, and where the rest begins.
    fs.writeFileSync(path.join(dir, 'tall.html'), tall(4000));
    const long = await browserTool.execute({ url: 'tall.html', fullPage: true }, ctx);
    expect(long.content).toContain('(the page is 4000 px tall, 10 screens: the first 8 are attached, the rest begins 3200 px down)');
    expect(long.images).toHaveLength(8);
    fs.writeFileSync(path.join(dir, 'tall.html'), tall(300));
    const short = await browserTool.execute({ url: 'tall.html', fullPage: true }, ctx);
    expect(short.content).toContain('(the whole page fits this screen, screenshot attached)');
    expect(short.images).toHaveLength(1);
    // Without it, one screen as before.
    const one = await browserTool.execute({ url: 'tall.html' }, ctx);
    expect(one.content).toContain('(screenshot attached)');
    // Single-call dual-width check attaches 1280×800 and 390×844 at 1× and flags gradients/mobile issues.
    const dual = await browserTool.execute({ url: 'tall.html', checkWidths: true }, ctx);
    expect(dual.content).toContain('checked at 1280×800 and 390×844, 2 screenshots attached');
    expect(dual.content).toContain('OUTSIDE THE BAR: 1 gradients');
    expect(dual.images?.map((i) => [i.name, size(i.data)])).toEqual([
      ['desktop 1280×800', [1280, 800]],
      ['mobile 390×844', [390, 844]],
    ]);
    await browserTool.execute({ url: 'about:blank', width: 1280, height: 800 }, ctx);
  }, 90_000);

  it('keeps its size from call to call and says what is on the screen, in numbers', async () => {
    fs.writeFileSync(
      path.join(dir, 'wide.html'),
      '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;font:16px sans-serif;background:#fff"><h1 style="font-size:40px;color:#111">A headline</h1><div style="width:900px;color:#ccc">Too wide and too pale</div><p style="position:absolute;top:3000px">Far below the fold</p>',
    );
    const ctx = { cwd: dir, signal: new AbortController().signal, model: { vision: false }, outputChars: 30_000, browser: () => session } as unknown as ToolContext;
    const phone = await browserTool.execute({ url: 'wide.html', width: 390 }, ctx);
    expect(phone.content).toContain('at 390×844');
    expect(phone.content).toMatch(/h1 "A headline" \d+,\d+ \d+×\d+, 40px, 1 line/);
    expect(phone.content).toContain('scrolls sideways');
    expect(phone.content).toContain('low contrast');
    expect(phone.content).not.toContain('Far below the fold');
    expect((await browserTool.execute({}, ctx)).content).toContain('at 390×844');
    expect((await browserTool.execute({ width: 1280 }, ctx)).content).toContain('at 1280×800');
  }, 60_000);

  it('acts on elements by ref: fill, select, check, upload, a dialog, tabs, back and read', async () => {
    fs.writeFileSync(path.join(dir, 'order.html'), form);
    fs.writeFileSync(path.join(dir, 'second.html'), second);
    fs.writeFileSync(path.join(dir, 'receipt.txt'), 'paid');
    const ctx = { cwd: dir, signal: new AbortController().signal, model: { vision: false }, outputChars: 30_000, browser: () => session } as unknown as ToolContext;
    const first = await browserTool.execute({ url: 'order.html' }, ctx);
    const ref = (pattern: RegExp, text = first.content) => pattern.exec(text)?.[1] ?? '';
    const email = ref(/\[(e\d+)\] textbox "Email" value="old@x\.io"/);
    const country = ref(/\[(e\d+)\] combobox "Country" value="Singapore"/);
    const gift = ref(/\[(e\d+)\] checkbox "Gift wrap" unchecked/);
    const receipt = ref(/\[(e\d+)\] file "Receipt"/);
    const send = ref(/\[(e\d+)\] button "Send"/);
    expect([email, country, gift, receipt, send].every(Boolean)).toBe(true);
    expect(first.content).toMatch(/\[e\d+\] clickable "Fancy button"/);
    expect(first.content).toContain('heading "Order form"');

    const r = await browserTool.execute(
      { actions: [{ fill: email, value: 'ada@x.io' }, { select: country, option: 'japan' }, { check: gift }, { upload: receipt, files: ['receipt.txt'] }, { click: send }] },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('ada@x.io / jp / true / receipt.txt');
    expect(r.content).toContain('confirm dialog "Send the order?" was accepted');
    // The same ref works in the next call; a stale or unknown one says so.
    expect(r.content).toContain(`[${email}] textbox "Email" value="ada@x.io"`);
    const bad = await browserTool.execute({ actions: [{ click: 'e999' }] }, ctx);
    expect(bad.content).toMatch(/nothing matches e999 \(refs come from the latest element list/);

    // A link that opens a tab is followed; the tab list shows both.
    const terms = ref(/\[(e\d+)\] link "Terms" → second\.html/, r.content);
    const tab = await browserTool.execute({ actions: [{ click: terms }, { wait: 'load' }] }, ctx);
    expect(tab.content).toContain('the page opened a new tab (tab 2); now in it');
    expect(tab.content).toMatch(/Tabs \(\* is this one\): 1 Order — .*; 2\* Terms — /);
    const closed = await browserTool.execute({ actions: [{ tab: 'close' }] }, ctx);
    expect(closed.content).toContain('"Order"');

    // Same-tab navigation, back, and reading the whole text.
    const here = ref(/\[(e\d+)\] link "Terms here"/, closed.content);
    const read = await browserTool.execute({ actions: [{ click: here }, { wait: 'load' }, { read: true }] }, ctx);
    expect(read.content).toContain('Page text:\n# Terms\nRule one: be kind.\n- Rule two: ship it.');
    const back = await browserTool.execute({ actions: [{ back: true }] }, ctx);
    expect(back.content).toContain('"Order"');
  }, 90_000);
});
