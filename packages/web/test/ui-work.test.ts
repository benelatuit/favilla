import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { BrowserSession, findBrowser } from '../../core/src/tools/browser';

const executable = findBrowser();
const web = fileURLToPath(new URL('../', import.meta.url));

describe.runIf(!!executable)('work the open page uses', () => {
  let home: string;
  let vite: ViteDevServer;
  let browser: BrowserSession;
  let url: string;
  let n = 0;
  const js = <T,>(source: string) => browser.evaluate<T>(source);
  const wait = (source: string, timeout = 4000) => vi.waitFor(async () => expect(await js(source), source).toBeTruthy(), { timeout, interval: 30 });
  const frames = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-ui-work-'));
    process.env.FAVILLA_HOME = home;
    vite = await createServer({
      root: web, configFile: false, cacheDir: path.join(home, 'vite'),
      oxc: { jsx: { runtime: 'automatic' } },
      server: { host: '127.0.0.1', port: 0, hmr: false },
      plugins: [{
        name: 'test page',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.startsWith('/fixture?')) {
              res.setHeader('Content-Type', 'text/html');
              res.end('<!doctype html><html lang="en"><div id="root"></div><script type="module" src="/test/ui-work.fixture.ts"></script>');
            } else if (req.url?.startsWith('/fixture-page')) {
              res.setHeader('Content-Type', 'text/html');
              res.end('<!doctype html><p>Preview</p>');
            } else next();
          });
        },
      }],
    });
    await vite.listen();
    url = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}/fixture`;
    browser = new BrowserSession(executable!, false, { visible: false, downloadDir: home });
    await browser.start();
  }, 30_000);

  afterAll(async () => {
    const child = browser && (Reflect.get(browser, 'child') as ChildProcess | null);
    const closed = child && child.exitCode === null ? once(child, 'close') : null;
    browser?.close();
    await closed;
    await vite?.close();
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });

  beforeEach(async () => {
    if (n) await js('localStorage.clear()');
    await browser.open(`${url}?test=${++n}`);
    await wait('!!document.querySelector(".composer textarea")');
  }, 30_000);

  it('restores all four composer fields after a refused send and keeps them in their own session', async () => {
    await js('fixture.compose("Keep my draft"); fixture.attachments()');
    await wait('!!document.querySelector(".thumb-remove") && !!document.querySelector(".pointed-remove")');
    await js('fixture.send(true)');
    await wait('document.querySelector("textarea").value === "Keep my draft"');
    expect(await js('document.querySelectorAll(".thumb-remove").length')).toBe(1);
    expect(await js('document.querySelectorAll(".pointed-chip:not(.is-paste)").length')).toBe(1);
    expect(await js('document.querySelectorAll(".is-paste").length')).toBe(1);

    await js('fixture.open("b")');
    await frames();
    expect(await js('document.querySelector("textarea").value')).toBe('');
    expect(await js('document.querySelectorAll(".thumb-remove,.pointed-remove").length')).toBe(0);
    await js('fixture.open("a")');
    await frames();
    expect(await js('document.querySelector("textarea").value')).toBe('Keep my draft');
    expect(await js('document.querySelectorAll(".thumb-remove,.pointed-remove").length')).toBe(3);
    await js('fixture.send(false)');
    await wait('fixture.sent.length === 2');
    const sent = await js<{ text: string; images: unknown[] }[]>('fixture.sent');
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1].text).toContain('<pasted');
    expect(sent[1].text).toContain('#the-button');
    expect(sent[1].images).toHaveLength(1);
  });

  it('keeps text, points and pastes after reload and leaves pictures in page memory', async () => {
    await js('fixture.compose("Survive reload"); fixture.attachments()');
    await wait('document.querySelectorAll(".thumb-remove,.pointed-remove").length === 3');
    await browser.open(`${url}?test=${n}&reload=1`);
    await wait('document.querySelector("textarea")?.value === "Survive reload"');
    expect(await js('document.querySelectorAll(".pointed-chip").length')).toBe(2);
    expect(await js('document.querySelectorAll(".thumb-remove").length')).toBe(0);
  });

  it('keeps the original chips when a send is refused by a replaced session', async () => {
    await js('fixture.open("b")');
    await js('fixture.compose("Keep every chip"); fixture.attachments()');
    await wait('document.querySelectorAll(".thumb-remove,.pointed-remove").length === 3');
    await js('fixture.send("replaced")');
    await wait('fixture.getState().session.meta.id === "replacement" && document.querySelector("textarea").value === "Keep every chip"');
    expect(await js('document.querySelectorAll(".thumb-remove,.pointed-remove").length')).toBe(3);
    expect(await js('fixture.sent.length')).toBe(1);
  });

  it('shows a sibling branch at its tail and keeps the old window for growth and replacement', async () => {
    await js('fixture.scroll(0); fixture.showBlock("user-4")');
    await wait('document.querySelector("[data-find=user-4]") && !document.querySelector("[data-find^=end-a]")');
    await js('fixture.open("b")');
    await wait('document.querySelector("[data-find^=end-b]") && fixture.gap() < 2');

    await js('fixture.scroll(0); fixture.showBlock("user-4")');
    await wait('document.querySelector("[data-find=user-4]") && !document.querySelector("[data-find^=end-b]")');
    await js('fixture.emit({ type: "message.added", sessionId: "b", message: { id: "growth", role: "assistant", time: 1, parts: [{ type: "text", text: "Growing" }] } })');
    await frames();
    expect(await js('!!document.querySelector("[data-find=user-4]")')).toBe(true);
    await js('fixture.emit({ type: "session.replaced", sessionId: "b", replacement: fixture.views.replacement.meta })');
    await wait('fixture.getState().session.meta.id === "replacement"');
    expect(await js('!!document.querySelector("[data-find=user-4]")')).toBe(true);
    expect(await js('!!document.querySelector("[data-find^=end-replacement]")')).toBe(false);
  });

  it('does no changes, context, or outline work while shut and opens without old data', async () => {
    await js('fixture.asks.length = 0; fixture.tab("changes", false); fixture.status("running", 800)');
    await frames();
    expect(await js('fixture.asks.filter(x => x.endsWith("/changes"))')).toEqual([]);
    await js('fixture.tab("context", false); fixture.status("idle", 1200)');
    await frames();
    expect(await js('fixture.asks.filter(x => x.endsWith("/context"))')).toEqual([]);

    await js(`(() => {
      window.measurements = 0;
      const measure = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        if (this.matches('.main .scroll')) window.measurements++;
        return measure.call(this);
      };
      fixture.tab('outline', false);
      fixture.scroll(0);
    })()`);
    await frames();
    expect(await js('window.measurements')).toBe(0);

    await js('fixture.changes("old"); fixture.tab("changes", true)');
    await wait('!!document.querySelector(".restore-head")');
    await js('document.querySelector(".restore-head").click()');
    await wait('document.querySelector(".workpanel").textContent.includes("old.txt")');
    await js('fixture.tab("changes", false)');
    await frames();
    await js('window.releaseChanges = fixture.holdChanges(); fixture.changes("new"); fixture.tab("changes", true)');
    await frames();
    expect(await js('document.querySelector(".workpanel").textContent.includes("old.txt")')).toBe(false);
    await js('window.releaseChanges()');
    await wait('!!document.querySelector(".restore-head")');
    await js('document.querySelector(".restore-head").click()');
    await wait('document.querySelector(".workpanel").textContent.includes("new.txt")');

    await js('fixture.preview(); fixture.tab("preview", true)');
    await wait('!!document.querySelector(".workpanel iframe")');
    await js('window.previewFrame = document.querySelector(".workpanel iframe"); fixture.tab("preview", false)');
    await frames();
    await js('fixture.tab("preview", true)');
    await frames();
    expect(await js('window.previewFrame === document.querySelector(".workpanel iframe")')).toBe(true);
  });

  it('keeps a comma-containing option selected, toggles it once, and sends the existing answer format', async () => {
    await js('fixture.question()');
    await wait('document.querySelectorAll(".question .option-label").length === 4');
    const choose = (i: number) => js(`document.querySelectorAll('.question button.option')[${i}].click()`);
    const chosen = () => js<string[]>('Array.from(document.querySelectorAll(".question .is-chosen .option-label"), el => el.textContent)');
    await choose(0);
    await frames();
    expect(await chosen()).toEqual(['Red, blue']);
    await choose(1);
    await choose(0);
    await frames();
    expect(await chosen()).toEqual(['Green']);
    await choose(0);
    await choose(2);
    await frames();
    expect(await chosen()).toEqual(['Red, blue', 'Green', 'Left, right']);
    await js('document.querySelector(".prompt-actions .btn-primary").click()');
    expect(await js('fixture.answered')).toEqual([{ id: 'ask', answers: { 'Colors?': 'Green, Red, blue', 'Direction?': 'Left, right' } }]);
  });

  it('keeps the preview choice by session and never displays the old iframe during a switch', async () => {
    await js('fixture.previewFor("a", ["a-first", "a-chosen"]); fixture.previewFor("b", ["b-first", "b-chosen"]); fixture.tab("preview", true)');
    const page = (name: string) => `document.querySelector('.workpanel iframe')?.src.endsWith('page=${name}')`;
    await wait(page('a-first'));
    await js('document.querySelector(".preview-pages").click()');
    await wait('document.querySelectorAll("[role=menuitemradio]").length >= 2');
    await js('Array.from(document.querySelectorAll("[role=menuitemradio]")).find(el => el.textContent.includes("a-chosen")).click()');
    await wait(page('a-chosen'));

    await js('window.resumePreview = fixture.holdPreview("b"); fixture.open("b")');
    await frames();
    expect(await js('!!document.querySelector(".workpanel iframe")')).toBe(false);
    expect(await js('fixture.asks.filter(path => path.startsWith("/sessions/b/preview"))')).toEqual(['/sessions/b/preview']);
    await js('window.resumePreview()');
    await wait(page('b-first'));
    await js('fixture.open("a")');
    await wait(page('a-chosen'));
  });

  it('leaves Mermaid source during streaming and draws completed diagrams in the current theme', async () => {
    const text = '```mermaid\ngraph TD\n  A --> B\n```\n\n';
    await js(`fixture.emit({type:'stream.start', sessionId:'a', messageId:'diagram', model:'m'});
      fixture.emit({type:'stream.text', sessionId:'a', messageId:'diagram', index:0, at:0, delta:${JSON.stringify(text)}})`);
    await wait('!!document.querySelector(".is-streaming .mermaid-block code")');
    // The first diagram loads the library. With the old observer it is drawn even though the stream is open.
    await js('new Promise(resolve => setTimeout(resolve, 1500))');
    expect(await js('!!document.querySelector(".is-streaming .mermaid-block svg")')).toBe(false);
    await js(`fixture.emit({type:'stream.text', sessionId:'a', messageId:'diagram', index:0, at:${text.length}, delta:'More words.'})`);
    await wait('document.querySelector(".is-streaming")?.textContent.includes("More words.")');
    expect(await js('!!document.querySelector(".is-streaming .mermaid-block code")')).toBe(true);

    const finish = (id: string) => js(`fixture.emit({type:'message.added', sessionId:'a', message:{
      id:${JSON.stringify(id)}, role:'assistant', time:1234, parts:[{type:'text', text:${JSON.stringify(text + 'More words.')}}]
    }})`);
    await finish('diagram');
    const svg = (id: string) => `document.querySelector('[data-find="${id}:0"] .mermaid-block svg')`;
    await wait(`!!${svg('diagram')}`, 12_000);
    const old = await js<string>(`${svg('diagram')}.id`);
    await js('document.documentElement.dataset.theme = "nightshift"');
    await wait(`${svg('diagram')}.id !== ${JSON.stringify(old)}`, 12_000);
    await finish('diagram-new');
    await wait(`!!${svg('diagram-new')}`, 12_000);
    for (const id of ['diagram', 'diagram-new']) {
      expect(await js(`${svg(id)}.outerHTML.includes(getComputedStyle(document.documentElement).getPropertyValue('--sheet').trim())`)).toBe(true);
    }
  }, 35_000);

  it('waits for delayed tool output without scanning the timeline at every frame', async () => {
    await js(`(() => {
      window.scans = 0;
      const walk = document.createTreeWalker.bind(document);
      document.createTreeWalker = (root, ...args) => {
        if (root instanceof Element && root.matches('[data-find]')) window.scans++;
        return walk(root, ...args);
      };
      window.releaseOutput = fixture.findTool();
    })()`);
    await wait('fixture.asks.includes("/sessions/a/result/slow-tool")');
    // Let the first mutations from opening the tool settle, then watch a quiet stretch of frames.
    await js('new Promise(resolve => setTimeout(resolve, 250))');
    const before = await js<number>('window.scans');
    expect(before).toBeGreaterThan(0);
    await js(`new Promise(resolve => {
      let n = 0;
      const tick = () => ++n === 12 ? resolve(true) : requestAnimationFrame(tick);
      requestAnimationFrame(tick);
    })`);
    expect(await js('window.scans')).toBe(before);
    await js('window.releaseOutput()');
    await wait('CSS.highlights.has("favilla-find-now")');
    expect(await js('Array.from(CSS.highlights.get("favilla-find-now"))[0].toString()')).toBe('the missing phrase');
  });

  it('find opens the paste that holds the match, past where a shown paste is cut', async () => {
    await js('fixture.findPaste()');
    const match = 'Array.from(CSS.highlights.get("favilla-find-now") ?? [])[0]';
    await wait(`(${match})?.toString() === "a beacon at the end"`);
    expect(await js(`(${match}).startContainer.parentElement.closest("[data-find]").dataset.find`)).toBe('pasted-message');
  });

  it('retries a failed remote picture while it stays on screen', async () => {
    await js('window.pics = fixture.pictures(); window.pics.add("picture-one")');
    await wait('document.querySelector("#picture-one").src.startsWith("blob:")');
    expect(await js('window.pics.info.requests')).toBe(2);
    await js('window.pics.stop?.()');
  });

  it('revokes a shared remote object URL only after the last image leaves', async () => {
    await js('window.pics = fixture.pictures(false); window.pics.add("picture-one"); window.pics.add("picture-two")');
    await wait(`document.querySelector('#picture-one').src.startsWith('blob:') &&
      document.querySelector('#picture-one').src === document.querySelector('#picture-two').src`);
    expect(await js('window.pics.info.requests')).toBe(1);
    const url = await js<string>('document.querySelector("#picture-one").src');
    expect(await js('fixture.pictureViewer("picture-one")')).toBe('/api/blob/fixture');
    await js('document.querySelector("#picture-one").remove()');
    await frames();
    expect(await js('window.pics.info.revoked')).toEqual([]);
    await js('document.querySelector("#picture-two").removeAttribute("src")');
    await wait('window.pics.info.revoked.length === 1');
    expect(await js('window.pics.info.revoked')).toEqual([url]);
    await js('window.pics.stop?.()');
  });

  it('uses child events without a polling fetch and reconciles on turn end and reconnect', async () => {
    await js('fixture.child({ type: "tool.start", callId: "c", name: "read", title: "Read", input: {} }); fixture.sheet()');
    await wait('document.querySelector(".childsheet").textContent.includes("Child started")');
    await js('fixture.child({ type: "message.added", message: { id: "child-second", role: "assistant", time: 2, parts: [{ type: "text", text: "Child event" }] } })');
    await wait('document.querySelector(".childsheet").textContent.includes("Child event")');
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(await js('fixture.asks.filter(x => x === "/sessions/child").length')).toBe(1);

    await js(`(() => {
      fixture.views.child.messages.push({ id: 'child-second', role: 'assistant', time: 2, parts: [{ type: 'text', text: 'Child event' }] });
      fixture.views.child.messages.push({ id: 'child-final', role: 'assistant', time: 3, parts: [{ type: 'text', text: 'Child finished' }] });
      fixture.child({ type: 'status', status: 'idle' });
      fixture.child({ type: 'turn.end', turn: 't', reason: 'done' });
    })()`);
    await wait('document.querySelector(".childsheet").textContent.includes("Child finished")');
    expect(await js('fixture.asks.filter(x => x === "/sessions/child").length')).toBe(2);
    await js(`(() => {
      fixture.views.child.messages.push({ id: 'child-lost', role: 'assistant', time: 4, parts: [{ type: 'text', text: 'Missed event' }] });
      fixture.reconnect();
    })()`);
    await wait('document.querySelector(".childsheet").textContent.includes("Missed event")');
    expect(await js('fixture.asks.filter(x => x === "/sessions/child").length')).toBe(3);
  });
});
