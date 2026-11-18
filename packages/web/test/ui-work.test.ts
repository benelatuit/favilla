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

  it('shows every file of a turn, goes to one from the list and opens the runs between hunks once asked', async () => {
    await js('fixture.turnChanges()');
    await wait('document.querySelectorAll(".changes-files button").length === 2');
    expect(await js<string>('document.querySelector(".changes-sum").textContent')).toBe('2 files +3 −3');
    const ofLong = (q: string) => `document.querySelector('.changes-file[data-change="1"]')${q}`;
    // Two hunks: the first line apart, the 18 between them, nothing known after the last.
    expect(await js<string[]>(`[...${ofLong('.querySelectorAll(".dl-gap")')}].map((g) => g.textContent)`)).toEqual(['1 unchanged line', '18 unchanged lines']);

    await js('document.querySelectorAll(".changes-files button")[1].click()');
    await wait('document.querySelector(".changes-file-link.is-current")?.textContent.includes("long.txt")');
    await frames();
    // At the top of the view, or as near as the end of the list lets it come, and still the one marked.
    const at = await js<{ top: number; height: number; end: boolean }>(`(() => {
      const box = document.querySelector('.changes-scroll');
      return { top: ${ofLong('.getBoundingClientRect().top')} - box.getBoundingClientRect().top, height: box.clientHeight, end: box.scrollTop + box.clientHeight >= box.scrollHeight - 2 };
    })()`);
    if (at.end) expect(at.top).toBeGreaterThanOrEqual(0);
    else expect(Math.abs(at.top)).toBeLessThanOrEqual(1);
    expect(at.top).toBeLessThan(at.height);
    expect(await js<string>('document.querySelector(".changes-file-link.is-current").textContent')).toContain('long.txt');

    // The first run asks for the file with all its lines; the run after the last hunk then opens without asking.
    await js(`[...${ofLong('.querySelectorAll(".dl-gap button")')}].find((b) => b.textContent === '18 unchanged lines').click()`);
    await wait(`[...${ofLong('.querySelectorAll(".dl-row code")')}].some((c) => c.textContent === 'line 15')`);
    expect(await js<string[]>(`[...${ofLong('.querySelectorAll(".dl-gap")')}].map((g) => g.textContent)`)).toEqual(['7 unchanged lines']);
    expect(await js<number>('fixture.asks.filter((a) => a.includes("?file=long.txt")).length')).toBe(1);
    await js(`${ofLong('.querySelector(".dl-gap button")')}.click()`);
    await wait(`[...${ofLong('.querySelectorAll(".dl-row code")')}].some((c) => c.textContent === 'line 40')`);
    expect(await js<number>('fixture.asks.filter((a) => a.includes("?file=")).length')).toBe(1);
    // Every line of the file now, in order on the new side.
    const numbers = await js<number[]>(`[...${ofLong('.querySelectorAll(".dl-row:not(.is-rem) .dl-n:last-of-type")')}].map((n) => Number(n.dataset.n))`);
    expect(numbers).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));

    await js('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
    await wait('!document.querySelector(".changes-view")');
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

  it('distinguishes cancelled/denied/pending steps, retries failed full-output loads, and scopes sub-agent live streams and paths (Bugs 9, 10, 13)', async () => {
    await js('window.releaseRetry = fixture.seedOutcomes()');
    await wait('!!document.querySelector(".process-head")');
    await js('document.querySelector(".process-head").click()');
    await wait('!!document.querySelector("[data-find=call-cancelled]")');

    // Bug 9: cancelled, denied, and pending steps are visually distinct from tool crashes and strip model instructions.
    expect(await js('document.querySelector("[data-find=call-cancelled]").classList.contains("is-cancelled")')).toBe(true);
    expect(await js('document.querySelector("[data-find=call-cancelled]").classList.contains("is-error")')).toBe(false);
    expect(await js('document.querySelector("[data-find=call-denied]").classList.contains("is-denied")')).toBe(true);
    expect(await js('document.querySelector("[data-find=call-denied]").textContent')).not.toContain("Don't run it");
    expect(await js('document.querySelector("[data-find=call-pending]").classList.contains("is-pending")')).toBe(true);

    // Bug 13: failed useFull load disables button on retry and resolves cleanly.
    await js('document.querySelector("[data-find=retry-tool] .step-head").click()');
    await wait('!!document.querySelector("[data-find=retry-tool] .term-note button")');
    await js('document.querySelector("[data-find=retry-tool] .term-note button").click()');
    await wait('document.querySelector("[data-find=retry-tool] .term-note button")?.textContent.includes("Could not load")');
    await js('document.querySelector("[data-find=retry-tool] .term-note button").click()');
    expect(await js('document.querySelector("[data-find=retry-tool] .term-note button").disabled')).toBe(true);
    await js('window.releaseRetry()');
    await wait('document.querySelector("[data-find=retry-tool] .step-body").textContent.includes("Full loaded log body")');

    // Bug 10: expanding a finished task loads and shows its steps immediately without a second "Show its steps" click.
    await js('document.querySelector("[data-find=call-task] .step-head").click()');
    await wait('document.querySelector("[data-find=call-task] .step-body").textContent.includes("src/child-only.ts")');

    // Bug 10: ChildSheet resolves relative paths against the child cwd and streams live text + tool progress without polling.
    await js('fixture.openScopedSheet()');
    await wait('!!document.querySelector(".childsheet [data-find=child-read-1]")');
    expect(await js('document.querySelector(".childsheet [data-path]")?.getAttribute("data-path")')).toBe('/child-workspace/src/child-only.ts');
    await js(`(() => {
      fixture.emit({ type: 'subagent', sessionId: 'a', callId: 'call-task', event: { sessionId: 'child-scoped', type: 'stream.start', messageId: 'cm-live', model: 'm' } });
      fixture.emit({ type: 'subagent', sessionId: 'a', callId: 'call-task', event: { sessionId: 'child-scoped', type: 'stream.text', messageId: 'cm-live', index: 0, delta: 'Live child stream words' } });
      fixture.emit({ type: 'subagent', sessionId: 'a', callId: 'call-task', event: { sessionId: 'child-scoped', type: 'tool.start', callId: 'cm-shell', name: 'shell', title: 'echo hi', input: { command: 'echo hi' } } });
      fixture.emit({ type: 'subagent', sessionId: 'a', callId: 'call-task', event: { sessionId: 'child-scoped', type: 'tool.progress', callId: 'cm-shell', chunk: 'live-progress-line\\n' } });
    })()`);
    await wait('document.querySelector(".childsheet").textContent.includes("Live child stream words") && document.querySelector(".childsheet").textContent.includes("live-progress-line")');
    await js('fixture.getState() && document.querySelector(".childsheet button[aria-label]")?.click()');
  });

  it('anchors scroll on fold toggle near bottom, reveals 4-layer Ctrl+F matches in one pass, keeps settled failure color, and preserves 1->2 step + parallel state (Bugs 1b, 2, 4, 6, 7, 8, 12, 14)', async () => {
    await js('fixture.seedToolchainBugs()');
    // Both turns have ended, the session idle: each folds into its line above its answer.
    await wait('document.querySelectorAll(".timeline .turn-toggle").length >= 2');

    // Bug 4: settled .process-failed keeps removal ink (not muted --ink-3)
    const colors = await js<{ failed: string; ink3: string }>(`(() => {
      const pf = document.querySelector('.process-failed');
      const probe = document.createElement('span');
      probe.style.color = 'var(--ink-3)';
      document.body.append(probe);
      const ink3 = getComputedStyle(probe).color;
      probe.remove();
      return { failed: getComputedStyle(pf).color, ink3 };
    })()`);
    expect(colors.failed).not.toBe(colors.ink3);

    // Bug 6: scroll to the very bottom so useFollow is following, then open the tail turn's 20 steps from its line.
    // The line's viewport top must stay anchored instead of snapping scrollTop to scrollHeight!
    await js('(() => { const s = document.querySelector(".main .scroll"); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event("scroll")); })()');
    await frames();
    const topBefore = await js<number>('(() => { const heads = document.querySelectorAll(".timeline .turn-toggle"); const h = heads[heads.length - 1]; const t = h.getBoundingClientRect().top; h.click(); return t; })()');
    await frames();
    const topAfter = await js<number>('(() => { const heads = document.querySelectorAll(".timeline .turn-toggle"); return heads[heads.length - 1].getBoundingClientRect().top; })()');
    expect(Math.abs(topAfter - topBefore)).toBeLessThan(6);
    await wait('document.querySelectorAll(".timeline [data-find^=tail-step-]").length === 20');

    // Bug 2: switching to session 'b' and back to 'a' preserves the manually opened tail turn!
    await js('fixture.open("b")');
    await wait('document.body.textContent.includes("End of B")');
    await js('fixture.open("a")');
    await wait('document.querySelectorAll(".timeline [data-find^=tail-step-]").length === 20');

    // Bug 7: 4-layer nested Ctrl+F reveal (WorkFold -> ProcessGroup -> LookGroup -> nested-grep ToolEntry) mounts and highlights!
    await js('fixture.findNested()');
    await wait('Array.from(CSS.highlights.get("favilla-find-now") ?? [])[0]?.toString() === "deeply nested beacon"');

    // Bug 12: .look-steps is indented on a sub-rail and .step-caret sits in grid column 5.
    const layoutChecks = await js<{ lookLeft: number; caretCol: string }>(`(() => {
      document.querySelector('[data-find="settled-diff"] .step-head').click();
      const lookSteps = document.querySelector('.look-steps');
      const caret = document.querySelector('.step-caret');
      return {
        lookLeft: parseFloat(getComputedStyle(lookSteps).paddingLeft),
        caretCol: getComputedStyle(caret).gridColumnStart,
      };
    })()`);
    expect(layoutChecks.lookLeft).toBeGreaterThanOrEqual(12);
    expect(layoutChecks.caretCol).toBe('5');
    // One file's change is named by the step's own line, so its rows come without a header of their own; the lines it
    // changed stand out from the code around them.
    await wait(`!!document.querySelector('[data-find="settled-diff"] .dl-row.is-ins')`);
    const diffCheck = await js<{ header: boolean; insBg: string; boxBg: string }>(`(() => {
      const step = document.querySelector('[data-find="settled-diff"]');
      return {
        header: !!step.querySelector('.diff-name'),
        insBg: getComputedStyle(step.querySelector('.dl-row.is-ins')).backgroundColor,
        boxBg: getComputedStyle(step.querySelector('.dl-box')).backgroundColor,
      };
    })()`);
    expect(diffCheck.header).toBe(false);
    expect(diffCheck.insBg).not.toBe(diffCheck.boxBg);

    // Bug 1b & Bug 8: manually open single live step 'live-1', then add parallel step 'live-2'.
    // 'live-1' stays open across the 1 -> 2 step transition, and ProcessLine shows 'Running 2 steps' + both commands!
    await js('window.addSecondLive = fixture.seedSingleStepThenSecond()');
    await wait('!!document.querySelector("[data-find=live-1]")');
    await js('document.querySelector("[data-find=live-1] .step-head").click()');
    await wait('document.querySelector("[data-find=live-1]").classList.contains("is-open")');
    await js('window.addSecondLive()');
    await wait('!!document.querySelector("[data-find=live-2]")');
    expect(await js('document.querySelector("[data-find=live-1]").classList.contains("is-open")')).toBe(true);
    const liveHeadText = await js<string>('(() => { const heads = document.querySelectorAll(".timeline .process-head"); return heads[heads.length - 1].textContent || ""; })()');
    expect(liveHeadText).toContain('Running 2 steps');
    expect(liveHeadText).toContain('npm run build');
    expect(liveHeadText).toContain('npm run lint');
  });

  it('absorbs auto-fold shrinkage without scroll bounce, releases immediately on tiny upward wheel, keeps .jump shift-free, and isolates inner terminal wheel', async () => {
    await js('window.fsCtl = fixture.seedFollowScenario()');
    await wait('!!document.querySelector("[data-find=fs-shell-1] .step-tail")');
    await frames();

    // 1) At bottom: folding LiveTail + 2 steps into 1 ProcessLine shrinks natural height, but --follow-runway keeps visible messages steady (no downward clamp bounce).
    const beforeShrink = await js<{ top: number; userTop: number }>(`(() => {
      const s = document.querySelector('.main .scroll');
      const cards = document.querySelectorAll('.turn-user');
      return { top: s.scrollTop, userTop: cards[cards.length - 1].getBoundingClientRect().top };
    })()`);
    expect(beforeShrink.top).toBeGreaterThan(50);

    await js('window.fsCtl.foldIntoProcess()');
    await frames();
    const afterShrink = await js<{ top: number; userTop: number; runway: number }>(`(() => {
      const s = document.querySelector('.main .scroll');
      const rw = document.querySelector('.follow-runway');
      const cards = document.querySelectorAll('.turn-user');
      return {
        top: s.scrollTop,
        userTop: cards[cards.length - 1].getBoundingClientRect().top,
        runway: rw ? rw.offsetHeight : 0,
      };
    })()`);
    expect(Math.abs(afterShrink.top - beforeShrink.top)).toBeLessThan(2);
    expect(Math.abs(afterShrink.userTop - beforeShrink.userTop)).toBeLessThan(2);
    expect(afterShrink.runway).toBeGreaterThan(0);

    // Growing new streamed prose consumes the runway smoothly back to empty.
    await js('window.fsCtl.appendAnswer("Line 1 of answer\\n\\nLine 2 of answer\\n\\nLine 3 of answer\\n\\nLine 4 of answer\\n\\nLine 5 of answer")');
    await frames();
    expect(await js<number>('document.querySelector(".follow-runway")?.offsetHeight ?? 0')).toBe(0);

    // 2) Tiny upward wheel (-1.5px within AT_END=24px) releases follow immediately and incoming stream chunks never yank back down.
    const released = await js<{ before: number; afterWheel: number }>(`(() => {
      const s = document.querySelector('.main .scroll');
      const before = s.scrollTop;
      s.dispatchEvent(new WheelEvent('wheel', { deltaY: -1.5, bubbles: true }));
      s.scrollTop = before - 2;
      s.dispatchEvent(new Event('scroll'));
      return { before, afterWheel: s.scrollTop };
    })()`);
    await js('window.fsCtl.appendAnswer("Line 1\\n\\nLine 2\\n\\nLine 3\\n\\nLine 4\\n\\nLine 5\\n\\nLine 6\\n\\nLine 7\\n\\nLine 8")');
    await frames();
    const afterStreamWhileReleased = await js<number>('document.querySelector(".main .scroll").scrollTop');
    expect(Math.abs(afterStreamWhileReleased - released.afterWheel)).toBeLessThan(2);

    // 3) Scrolling >120px up while live shows .jump with 0px timeline height shift and hysteresis; clicking .jump glides back to bottom.
    const jumpCheck = await js<{ timelineBefore: number; timelineWithJump: number; hasJumpAt140: boolean }>(`(async () => {
      const s = document.querySelector('.main .scroll');
      const tl = document.querySelector('.timeline');
      s.scrollTop = s.scrollHeight;
      s.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
      const timelineBefore = tl.offsetHeight;
      s.dispatchEvent(new WheelEvent('wheel', { deltaY: -140, bubbles: true }));
      s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 140);
      s.dispatchEvent(new Event('scroll'));
      await new Promise(requestAnimationFrame);
      return {
        timelineBefore,
        timelineWithJump: tl.offsetHeight,
        hasJumpAt140: !!document.querySelector('.jump'),
      };
    })()`);
    expect(jumpCheck.hasJumpAt140).toBe(true);
    expect(jumpCheck.timelineWithJump).toBe(jumpCheck.timelineBefore);

    // Hysteresis: moving down to gap=80px (above LIVE_AWAY_EXIT=48px) keeps .jump mounted without flickering off.
    await js(`(() => {
      const s = document.querySelector('.main .scroll');
      s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 80);
      s.dispatchEvent(new Event('scroll'));
    })()`);
    await frames();
    expect(await js<boolean>('!!document.querySelector(".jump")')).toBe(true);

    // Clicking .jump hides it immediately and returns to the bottom.
    await js('document.querySelector(".jump").click()');
    await wait('(() => { const s = document.querySelector(".main .scroll"); return !document.querySelector(".jump") && s.scrollHeight - s.scrollTop - s.clientHeight <= 2; })()');

    // 4) Inner <Terminal follow> appends spans incrementally without rebuilding earlier DOM nodes and isolates inner wheel from outer timeline.
    await js('window.fsCtl.startTallLiveShell()');
    await wait('!!document.querySelector("[data-find=fs-tall-shell]")');
    await js('document.querySelector("[data-find=fs-tall-shell] .step-head").click()');
    await wait('!!document.querySelector("[data-find=fs-tall-shell] .terminal")');
    await frames();
    // Re-pin outer scroll after manual fold anchor opened the terminal.
    await js('(() => { const s = document.querySelector(".main .scroll"); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event("scroll")); })()');
    await frames();

    await js('window.__firstTermSpan = document.querySelector("[data-find=fs-tall-shell] .terminal span")');
    await js('window.fsCtl.appendTallShell("\\x1b[36m[chunk 32]\\x1b[0m extra line A\\n[chunk 33] extra line B\\n")');
    await frames();
    const termState = await js<{ sameFirstNode: boolean; innerAtEnd: boolean }>(`(() => {
      const term = document.querySelector('[data-find=fs-tall-shell] .terminal');
      return {
        sameFirstNode: term.querySelector('span') === window.__firstTermSpan,
        innerAtEnd: term.scrollHeight - term.scrollTop - term.clientHeight <= 2,
      };
    })()`);
    expect(termState.sameFirstNode).toBe(true);
    expect(termState.innerAtEnd).toBe(true);

    // Wheeling up inside the overflowing .terminal unpins inner terminal ONLY; outer .main .scroll keeps following!
    await js(`(() => {
      const term = document.querySelector('[data-find=fs-tall-shell] .terminal');
      term.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true }));
      term.scrollTop = Math.max(0, term.scrollTop - 60);
      term.dispatchEvent(new Event('scroll'));
    })()`);
    await frames();
    const outerBeforeMore = await js<number>('document.querySelector(".main .scroll").scrollTop');
    await js('window.fsCtl.appendAnswer("Line 1\\n\\nLine 2\\n\\nLine 3\\n\\nLine 4\\n\\nLine 5\\n\\nLine 6\\n\\nLine 7\\n\\nLine 8\\n\\nLine 9\\n\\nLine 10\\n\\nLine 11\\n\\nLine 12")');
    await frames();
    const outerGapAfter = await js<number>('(() => { const s = document.querySelector(".main .scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight; })()');
    const outerAfterMore = await js<number>('document.querySelector(".main .scroll").scrollTop');
    expect(outerAfterMore).toBeGreaterThan(outerBeforeMore);
    expect(outerGapAfter).toBeLessThanOrEqual(2);

    // 5) Widening the scroll container (e.g. closing sidebar/panel) unwraps lines without injecting fake --follow-runway.
    await js(`(() => {
      const s = document.querySelector('.main .scroll');
      s.style.width = '260px';
    })()`);
    await frames();
    await js(`(() => {
      const s = document.querySelector('.main .scroll');
      s.style.width = '';
    })()`);
    await frames();
    expect(await js<number>('document.querySelector(".follow-runway")?.offsetHeight ?? 0')).toBe(0);
  });
});
