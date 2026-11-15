import fs from 'node:fs';
import { pageFacts } from './pageaudit';
import { designReport, MEASURE_SCRIPT, type DesignMeasure } from './design-measure';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { ImagePart } from '../types';
import { WebSocket } from 'undici';
import { killChild, which } from '../util/proc';
import { oneLine } from '../util/text';
import { abortError, sleep } from '../util/async';
import { displayPath, isInside, isWindows, resolvePath } from '../util/paths';
import { scratchDir } from '../prompt/system';
import type { ToolDef } from './types';

let found: string | null | undefined;

/** A Chromium browser that can render headless: Chrome first, then Chromium, then Edge. */
export function findBrowser(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  if (found !== undefined) return found;
  const env = process.env;
  const candidates = isWindows
    ? [
        env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'),
        env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : [which('google-chrome'), which('google-chrome-stable'), which('chromium'), which('chromium-browser'), which('microsoft-edge')];
  found = candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
  return found;
}

/** Where an action lands: a ref from the last element list ("e12"), a CSS selector, or "text=Label". */
type Target = string;

export type BrowserAction =
  | { click: Target; double?: boolean; button?: 'left' | 'right'; hold?: boolean }
  | { hover: Target }
  | { type: string; into?: Target }
  | { fill: Target; value: string }
  | { select: Target; option: string }
  | { check: Target }
  | { uncheck: Target }
  | { upload: Target; files: string[] }
  | { press: string }
  | { wait: number | string }
  | { scroll: number | string }
  | { back: true }
  | { forward: true }
  | { reload: true }
  | { tab: 'new' | 'close' | 'list' | number; url?: string }
  | { js: string }
  | { read: true }
  | { zoom: [number, number, number, number] }
  | { measure: true };

export const ACTION_KEYS = ['click', 'hover', 'type', 'fill', 'select', 'check', 'uncheck', 'upload', 'press', 'wait', 'scroll', 'back', 'forward', 'reload', 'tab', 'js', 'read', 'zoom', 'measure'];

export interface BrowserInput {
  /** A URL (a local dev server works) or an HTML file; without it, the page from the last call. */
  url?: string;
  actions?: BrowserAction[];
  width?: number;
  height?: number;
  fullPage?: boolean;
  /** Verify desktop (1280×800) and mobile (390×844) in one call with defect-only ergonomics & design-bar checks. */
  checkWidths?: boolean;
  /** Bring the browser up as a window the user can watch (and use: to sign in, say). */
  show?: boolean;
  /** Save an exact 1× width×height PNG of the viewport to this file path. */
  out?: string;
}

export interface BrowserOptions {
  /** A window on screen instead of a headless browser. */
  visible?: boolean;
  /** A profile kept between sessions (logins survive); without it, a fresh profile per session. */
  profileDir?: string;
  /** Where downloads are saved. */
  downloadDir?: string;
  /**
   * The user's own browser, by its user data folder: the agent attaches to it as it runs (after the user turns on
   * remote debugging at edge://inspect or chrome://inspect), works in tabs of its own with the user's logins, and
   * never starts, closes or reconfigures that browser.
   */
  attachDir?: string;
}

/** The user data folders of the browsers people use every day, for attaching to them. */
export function userBrowserDir(kind: 'edge' | 'chrome'): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'win32') return kind === 'edge' ? path.join(local, 'Microsoft', 'Edge', 'User Data') : path.join(local, 'Google', 'Chrome', 'User Data');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', kind === 'edge' ? 'Microsoft Edge' : 'Google/Chrome');
  return path.join(os.homedir(), '.config', kind === 'edge' ? 'microsoft-edge' : 'google-chrome');
}

/**
 * What every browser Favilla starts is started with. A debugging port alone makes Chrome tell each page it is under
 * automation (navigator.webdriver), and Google's sign-in then refuses the browser as "not secure", though Favilla's
 * browser is where the user signs in for the agent. The switch that keeps it quiet makes Chrome show a bar warning
 * about an unsupported flag; --test-type is Chrome's own way to leave that bar out.
 */
/** Pixels of a screenshot to one pixel of the page (1× keeps multi-turn vision token cost compact; zoom handles close-ups). */
const SHOT_SCALE = Number(process.env.FAVILLA_SHOT_SCALE ?? 1) || 1;

/** Screens of a page in one look: the pictures one request keeps (context/images.ts gives a window eight at most). */
export const MAX_SCREENS = 8;
/** How long a screen is given to settle after the page scrolls to it. */
const SCREEN_SETTLE_MS = 450;

const BASE_FLAGS = ['--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--disable-blink-features=AutomationControlled', '--test-type'];

/** What the user does once so the agent can attach to their own browser. */
export function attachHint(kind: 'edge' | 'chrome'): string {
  const page = kind === 'edge' ? 'edge://inspect/#remote-debugging' : 'chrome://inspect/#remote-debugging';
  return `Favilla could not reach your ${kind === 'edge' ? 'Edge' : 'Chrome'}. With it open, go to ${page} and tick "Allow remote debugging for this browser instance", then try again (the browser may ask to allow the connection).`;
}

const KEYS: Record<string, { code: string; key: string; keyCode: number; text?: string }> = {
  enter: { code: 'Enter', key: 'Enter', keyCode: 13, text: '\r' },
  tab: { code: 'Tab', key: 'Tab', keyCode: 9 },
  escape: { code: 'Escape', key: 'Escape', keyCode: 27 },
  esc: { code: 'Escape', key: 'Escape', keyCode: 27 },
  backspace: { code: 'Backspace', key: 'Backspace', keyCode: 8 },
  delete: { code: 'Delete', key: 'Delete', keyCode: 46 },
  arrowdown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  arrowup: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
  arrowleft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
  arrowright: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  down: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  up: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
  left: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
  right: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  home: { code: 'Home', key: 'Home', keyCode: 36 },
  end: { code: 'End', key: 'End', keyCode: 35 },
  pageup: { code: 'PageUp', key: 'PageUp', keyCode: 33 },
  pagedown: { code: 'PageDown', key: 'PageDown', keyCode: 34 },
  space: { code: 'Space', key: ' ', keyCode: 32, text: ' ' },
};
const MODIFIERS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

/**
 * Finds an element by a ref from the last element list, by CSS selector, or by its visible text with "text=…";
 * runs in the page. A ref whose element left the page finds nothing.
 */
const FIND = `(q) => {
  if (/^e\\d+$/.test(q)) { const e = window.__favilla && window.__favilla.refs.get(q); return e && e.isConnected ? e : null; }
  if (q.startsWith('text=')) {
    const want = q.slice(5).trim().toLowerCase();
    const all = [...document.querySelectorAll('button, a, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], input[type=submit], input[type=button], label, summary, option, li, [onclick], h1, h2, h3, span, div')];
    const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return all.find((e) => visible(e) && (e.innerText || e.value || '').trim().toLowerCase() === want)
      || all.find((e) => visible(e) && (e.innerText || e.value || '').trim().toLowerCase().includes(want)) || null;
  }
  return document.querySelector(q);
}`;

/**
 * The page's interactive elements (and the headings in view) as short lines with refs the model can act on:
 * '[e7] button "Save"', '[e8] textbox "Email" value="ada@x.io"'. Refs stay with their element for as long as
 * the page lives, so a ref from one call still works in the next; elements in view come first.
 */
const SNAPSHOT = `(() => {
  const L = (window.__favilla ||= { refs: new Map(), ids: new WeakMap(), next: 0 });
  const MAX = 150, vw = innerWidth, vh = innerHeight;
  const clean = (s, n = 80) => { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', file: 'file', search: 'searchbox', number: 'spinbutton', color: 'colorpicker', hidden: null };
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]';
  const roleOf = (e) => {
    const r = e.getAttribute('role');
    if (r && !['presentation', 'none', 'generic', 'group', 'region', 'list', 'listitem', 'img', 'separator', 'status', 'alert', 'log', 'tooltip', 'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'form', 'article', 'document', 'application', 'toolbar', 'tablist', 'menu', 'menubar', 'listbox', 'tree', 'grid', 'rowgroup', 'row', 'table', 'dialog', 'alertdialog', 'heading'].includes(r)) return r;
    const t = e.tagName;
    if (t === 'A') return e.hasAttribute('href') ? 'link' : null;
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return e.multiple ? 'listbox' : 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') { const ty = (e.type || 'text').toLowerCase(); return ty in INPUT_ROLES ? INPUT_ROLES[ty] : 'textbox'; }
    if (t === 'IFRAME') return 'frame';
    if (e.isContentEditable && !(e.parentElement && e.parentElement.isContentEditable)) return 'textbox';
    if (/^H[1-6]$/.test(t)) return 'heading';
    if (e.hasAttribute('onclick') || (e.tabIndex >= 0 && e.hasAttribute('tabindex'))) return 'clickable';
    return null;
  };
  const nameOf = (e) => {
    const al = e.getAttribute('aria-label'); if (al) return al;
    const lb = e.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ').trim(); if (t) return t; }
    // A label's own words, without the text of the control it wraps (a select's options, say).
    const own = (l) => { const c = l.cloneNode(true); c.querySelectorAll('input,select,textarea,button').forEach((x) => x.remove()); return (c.textContent || '').trim(); };
    if (e.labels && e.labels.length) { const t = [...e.labels].map(own).join(' ').trim(); if (t) return t; }
    if (e.tagName === 'IFRAME') return e.title || e.name || e.src;
    if (e.tagName !== 'INPUT' && e.tagName !== 'TEXTAREA' && e.tagName !== 'SELECT') { const t = (e.innerText || '').trim(); if (t) return t; }
    const img = e.querySelector && e.querySelector('img[alt]');
    return e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt') || (img && img.alt) || e.getAttribute('name') || (e.type === 'submit' || e.type === 'button' ? e.value : '') || '';
  };
  const shown = (e, r) => {
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  };
  const items = [];
  const seen = new Set();
  const walk = (root) => {
    for (const e of root.querySelectorAll('*')) {
      if (e.shadowRoot) walk(e.shadowRoot);
      let role = e.matches(INTERACTIVE) || /^H[1-6]$/.test(e.tagName) ? roleOf(e) : null;
      // A plain element styled as clickable that sits in nothing clickable: the buttons many apps draw with divs.
      if (!role && (e.tagName === 'DIV' || e.tagName === 'SPAN' || e.tagName === 'LI' || e.tagName === 'IMG' || e.tagName === 'svg') && !e.closest(INTERACTIVE)) {
        const s = getComputedStyle(e);
        if (s.cursor === 'pointer' && !(e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer')) role = 'clickable';
      }
      if (!role || seen.has(e)) continue;
      if (role === 'clickable' && e.parentElement && e.parentElement.closest('a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option]')) continue;
      const r = e.getBoundingClientRect();
      if (!shown(e, r)) continue;
      seen.add(e);
      items.push({ e, role, inView: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw });
    }
  };
  walk(document);
  items.sort((a, b) => (a.inView === b.inView ? 0 : a.inView ? -1 : 1));
  const lines = [];
  let more = 0;
  for (const it of items) {
    const e = it.e;
    if (it.role === 'heading') { if (it.inView && lines.length < MAX) lines.push('heading "' + clean(e.innerText, 100) + '"'); continue; }
    if (lines.length >= MAX) { more++; continue; }
    let id = L.ids.get(e);
    if (!id) { id = 'e' + (++L.next); L.ids.set(e, id); L.refs.set(id, e); }
    const st = [];
    const ty = (e.type || '').toLowerCase();
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') st.push('disabled');
    if (e.tagName === 'INPUT' && (ty === 'checkbox' || ty === 'radio')) st.push(e.checked ? 'checked' : 'unchecked');
    else if (e.hasAttribute('aria-checked')) st.push(e.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked');
    if (e.hasAttribute('aria-expanded')) st.push(e.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (e.getAttribute('aria-selected') === 'true' || (e.getAttribute('aria-current') && e.getAttribute('aria-current') !== 'false')) st.push('selected');
    if (e.tagName === 'SELECT') st.push('value="' + clean(e.selectedOptions[0] ? e.selectedOptions[0].text : '', 40) + '"');
    else if (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && it.role !== 'button' && it.role !== 'checkbox' && it.role !== 'radio' && it.role !== 'file')) st.push(ty === 'password' ? (e.value ? 'value=•••' : 'value=""') : 'value="' + clean(e.value, 40) + '"');
    if (e.tagName === 'A') st.push('→ ' + clean(e.getAttribute('href'), 60));
    if (!it.inView) st.push('(off screen)');
    lines.push('[' + id + '] ' + it.role + ' "' + clean(nameOf(e)) + '"' + (st.length ? ' ' + st.join(' ') : ''));
  }
  return { lines, more };
})()`;

/** The page's text for reading: headings, paragraphs, list items, table rows and links, in order. */
const READ = `(() => {
  const root = document.querySelector('main, article, [role=main]') || document.body;
  if (!root) return '';
  const out = [];
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  for (const e of root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,tr,dt,dd,figcaption,label')) {
    if (e.closest('nav, footer, script, style, noscript')) continue;
    if (e.tagName !== 'TR' && e.parentElement && e.parentElement.closest('p,li,pre,blockquote,dt,dd')) continue;
    const r = e.getBoundingClientRect(); if (r.width < 1 && r.height < 1) continue;
    let t = e.tagName === 'TR' ? [...e.children].map((c) => clean(c.innerText)).join(' | ') : e.tagName === 'PRE' ? e.innerText : clean(e.innerText);
    if (!t) continue;
    if (/^H[1-6]$/.test(e.tagName)) t = '#'.repeat(+e.tagName[1]) + ' ' + t;
    else if (e.tagName === 'LI') t = '- ' + t;
    out.push(t);
  }
  const text = out.join('\\n');
  // Pages built from plain divs have little of the above: then all their text, as the browser lays it out.
  const all = (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
  const letters = (s) => s.replace(/\\s+/g, '').length;
  return letters(text) * 2 >= letters(all) ? text : all;
})()`;

interface Tab {
  targetId: string;
  sessionId: string;
}

/**
 * A Chrome that stays open for a session, so pages keep their state between calls (a login, an open
 * dialog, a filled form), with its tabs, the dialogs pages open and the files they download. Headless with a
 * fresh profile by default; or a window on screen, and a profile kept between sessions so logins survive.
 * Never the user's own browser profile.
 */
export class BrowserSession {
  private child: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private tabs: Tab[] = [];
  private current = 0;
  private next = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private loadWaiters: (() => void)[] = [];
  private dir: string | null = null;
  private log: string[] = [];
  private events: string[] = [];
  private downloads = new Map<string, string>();
  private starting: Promise<void> | null = null;
  private profileNote = '';
  /** Working in a browser that was already open (Favilla's browser, with the user's logins): it stays when done. */
  private shared = false;
  /** Tabs this session opened, which are all it closes in a shared browser. */
  private created = new Set<string>();
  /** The size pages are looked at, kept from one call to the next. */
  size = { width: 1280, height: 800 };
  private emulated = false;
  private zooms: ImagePart[] = [];
  /** The button {click, hold: true} keeps pressed until the next action or call. */
  private held: { x: number; y: number; button: 'left' | 'right' } | null = null;
  /** Pixels of the last screenshot to one pixel of the page. */
  private shotScale = 1;
  private signal?: AbortSignal;
  private generation = 0;

  constructor(
    private readonly executable: string,
    private readonly proxy: string | false,
    private opts: BrowserOptions = {},
  ) {}

  get visible(): boolean {
    return !!this.opts.visible;
  }

  /** Cancel this operation's waits, not the user's browser or its other tabs. */
  async withSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const before = this.signal;
    this.signal = signal;
    try {
      return await run();
    } finally {
      this.signal = before;
    }
  }

  /** Switch between a window and headless; a running browser restarts in the new mode (pages close). */
  setVisible(visible: boolean): boolean {
    if (!!this.opts.visible === visible) return false;
    this.opts = { ...this.opts, visible };
    if (this.ws || this.starting) this.close();
    return true;
  }

  private get sessionId(): string {
    return this.tabs[this.current]?.sessionId ?? '';
  }

  /**
   * One DevTools command. A browser that stops answering, or a connection that drops, must not hold the tool call
   * (and the turn) for ever: each command has a time limit, and a closed connection fails what is still waiting.
   */
  private send(method: string, params: Record<string, unknown> = {}, session: string | false = this.sessionId, limitMs = 90_000): Promise<any> {
    const id = ++this.next;
    const signal = this.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      if (!this.ws) return reject(new Error('the browser is not running'));
      const done = <T,>(f: (v: T) => void) => (v: T) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        f(v);
      };
      const fail = (e: Error) => done(reject)(e);
      const onAbort = () => fail(abortError());
      const timer = setTimeout(() => fail(new Error(`the browser did not answer ${method} within ${Math.round(limitMs / 1000)} s`)), limitMs);
      timer.unref?.();
      this.pending.set(id, { resolve: done(resolve), reject: fail });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
      } catch (e) {
        fail(e as Error);
      }
    });
  }

  private note(line: string): void {
    this.log.push(oneLine(line, 300));
    if (this.log.length > 60) this.log.shift();
  }

  /** What the page reported since the last call: console errors and warnings, uncaught exceptions, failed requests. */
  takeLog(): string[] {
    return this.log.splice(0);
  }

  /** Pictures zoom actions took since the last call. */
  takeZooms(): ImagePart[] {
    return this.zooms.splice(0);
  }

  /** Dialogs answered, tabs opened, files downloaded since the last call. */
  takeEvents(): string[] {
    const out = this.events.splice(0);
    if (this.profileNote) out.unshift(this.profileNote), (this.profileNote = '');
    return out;
  }

  async start(): Promise<void> {
    this.signal?.throwIfAborted();
    if (this.starting) return this.starting;
    if (this.ws) return;
    const starting = this.launch();
    this.starting = starting;
    try {
      await starting;
    } catch (e) {
      if (this.starting === starting) this.close();
      throw e;
    }
  }

  private spawnBrowser(profile: string): Promise<string> {
    const visible = !!this.opts.visible;
    // A benchmark runs offline: without this the agent's browser reads the task's fix off its project's page. It replaces
    // the configured proxy, because of two --proxy-server flags the browser takes the last. Local pages still load.
    const proxy = process.env.FAVILLA_WEB_FETCH === 'off' ? 'http://127.0.0.1:9' : this.proxy;
    this.child = spawn(
      this.executable,
      [
        ...(visible ? ['--window-size=1280,900', '--new-window'] : ['--headless=new', '--window-size=1280,900', '--disable-gpu', '--hide-scrollbars', '--mute-audio']),
        ...BASE_FLAGS,
        '--disable-extensions',
        `--user-data-dir=${profile}`,
        ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>;localhost;127.0.0.1'] : []),
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: !visible },
    );
    const child = this.child;
    const signal = this.signal;
    return new Promise<string>((resolve, reject) => {
      let buf = '';
      const fail = (e: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        killChild(child);
        reject(e);
      };
      const onAbort = () => fail(abortError());
      const timer = setTimeout(() => fail(new Error('the browser did not start')), 20_000);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stderr!.on('data', (d) => {
        buf += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(m[1]);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`the browser exited (${code})`));
      });
      child.on('error', fail);
    });
  }

  private async launch(): Promise<void> {
    const signal = this.signal;
    const generation = this.generation;
    const check = () => {
      if (signal?.aborted || generation !== this.generation) throw abortError();
    };
    sweepStaleProfiles();
    let endpoint: string | null;
    if (this.opts.attachDir) {
      // The user's own browser: only ever attached to, never started. The port file is there while remote
      // debugging is on; a browser that turned it on from its inspect page may serve no HTTP, so it is not asked.
      endpoint = (await running(this.opts.attachDir))?.endpoint ?? portFileEndpoint(this.opts.attachDir);
      if (!endpoint) throw new Error(attachHint(/edge/i.test(this.opts.attachDir) ? 'edge' : 'chrome'));
      this.shared = true;
    } else {
      this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-browser-'));
      endpoint = this.opts.profileDir ? await runningEndpoint(this.opts.profileDir) : null;
      // Favilla's browser is already open (the user's window, or another session's): work in tabs of its own there,
      // with the user's logins, and leave the browser running when done.
      this.shared = !!endpoint;
    }
    check();
    const dir = this.dir ?? '';
    if (!endpoint) {
      try {
        endpoint = await this.spawnBrowser(this.opts.profileDir ?? path.join(dir, 'profile'));
      } catch (e) {
        check();
        if (!this.opts.profileDir) throw e;
        // The kept profile is open in a browser Favilla cannot reach: Chrome hands the start over to it and exits.
        this.profileNote = 'The kept browser profile is in use by a browser Favilla cannot reach, so this one started with a fresh profile (no saved logins).';
        endpoint = await this.spawnBrowser(path.join(dir, 'profile'));
      }
    }
    check();
    // Under load the browser can print its address a moment before it takes connections: try again briefly.
    let ws: WebSocket | null = null;
    for (let attempt = 1; !ws; attempt++) {
      const tried = new WebSocket(endpoint);
      const open = await new Promise<boolean>((resolve) => {
        const done = (ok: boolean) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          tried.removeEventListener('open', onOpen);
          tried.removeEventListener('error', onError);
          tried.removeEventListener('close', onError);
          if (!ok) tried.close();
          resolve(ok);
        };
        const onOpen = () => done(true);
        const onError = () => done(false);
        const onAbort = () => done(false);
        const timer = setTimeout(onError, 20_000);
        tried.addEventListener('open', onOpen);
        tried.addEventListener('error', onError);
        tried.addEventListener('close', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      if (signal?.aborted || generation !== this.generation) {
        tried.close();
        throw abortError();
      }
      if (open) ws = tried;
      else if (attempt >= 3) throw new Error(this.opts.attachDir ? attachHint(/edge/i.test(this.opts.attachDir) ? 'edge' : 'chrome') : 'could not connect to the browser');
      else await sleep(300 * attempt, signal);
    }
    this.ws = ws;
    ws.addEventListener('message', (m) => { if (this.ws === ws) this.receive(JSON.parse(String(m.data))); });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.starting = null;
      this.tabs = [];
      for (const p of this.pending.values()) p.reject(new Error('the browser closed'));
      this.pending.clear();
      for (const done of this.loadWaiters.splice(0)) done();
    });
    await this.send('Target.setDiscoverTargets', { discover: true }, false);
    // The user's own browser keeps its own download settings.
    if (this.opts.downloadDir && !this.opts.attachDir) {
      fs.mkdirSync(this.opts.downloadDir, { recursive: true });
      await this.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.opts.downloadDir, eventsEnabled: true }, false).catch(() => {});
    }
    // The window's own first tab when there is one, so a visible browser does not show an extra blank tab; in a
    // browser the user has open, a tab of the agent's own, never one of theirs.
    const targets = ((await this.send('Target.getTargets', {}, false)).targetInfos ?? []) as { targetId: string; type: string }[];
    const mine = this.shared ? null : targets.find((t) => t.type === 'page')?.targetId;
    const first = mine ?? (await this.send('Target.createTarget', { url: 'about:blank' }, false)).targetId;
    if (!mine) this.created.add(first);
    await this.attach(first);
    this.current = 0;
    // A window for the user, in a browser an earlier Favilla started without the switch in BASE_FLAGS.
    if (this.shared && this.opts.visible && !this.opts.attachDir && (await this.evaluate('navigator.webdriver').catch(() => false)) === true)
      this.profileNote = "Favilla's browser was started by an earlier version of Favilla and tells sites it is automated, so Google's sign-in refuses it there. Ask the user to close all of its windows; it starts without that the next time.";
  }

  private async attach(targetId: string): Promise<Tab> {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    const tab = { targetId, sessionId };
    this.tabs.push(tab);
    await Promise.all([this.send('Page.enable', {}, sessionId), this.send('Runtime.enable', {}, sessionId), this.send('Network.enable', {}, sessionId), this.passAsChrome(sessionId)]);
    return tab;
  }

  private agent: Promise<string | null> | null = null;

  /**
   * Headless Chrome names itself HeadlessChrome in its user agent, and many sites turn that away; the same
   * browser without the word reads them like a person's.
   */
  private async passAsChrome(sessionId: string): Promise<void> {
    if (this.opts.visible) return;
    this.agent ??= this.send('Browser.getVersion', {}, false)
      .then((v: { userAgent?: string }) => (v.userAgent?.includes('HeadlessChrome') ? v.userAgent.replace('HeadlessChrome', 'Chrome') : null))
      .catch(() => null);
    const ua = await this.agent;
    if (ua) await this.send('Emulation.setUserAgentOverride', { userAgent: ua }, sessionId).catch(() => {});
  }

  private async withTemporaryTab<T>(work: (sessionId: string) => Promise<T>, opts: { asChrome?: boolean } = {}): Promise<T> {
    await this.start();
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', background: true }, false);
    try {
      const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
      const enabled = this.send('Page.enable', {}, sessionId);
      if (opts.asChrome) await Promise.all([enabled, this.passAsChrome(sessionId)]);
      else await enabled;
      return await work(sessionId);
    } finally {
      await this.send('Target.closeTarget', { targetId }, false).catch(() => {});
    }
  }

  /**
   * A page loaded in a background tab of its own and read once it has settled (the text stops growing), for
   * reading pages that build themselves with JavaScript. The agent's tabs and their state are left alone.
   */
  async render(url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ html: string; url: string; title: string }> {
    return this.withTemporaryTab(async (sessionId) => {
      const r = await this.send('Page.navigate', { url }, sessionId);
      if (r?.errorText) throw new Error(`could not open ${url}: ${r.errorText}`);
      const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
      let last = -1;
      let steady = 0;
      while (Date.now() < deadline && !opts.signal?.aborted) {
        await new Promise((res) => setTimeout(res, 400));
        const v = await this.send('Runtime.evaluate', { expression: '[document.readyState, document.body ? document.body.innerText.length : 0]', returnByValue: true }, sessionId).catch(() => null);
        const [state, length] = (v?.result?.value as [string, number] | undefined) ?? ['loading', 0];
        steady = state === 'complete' && length > 0 && length === last ? steady + 1 : 0;
        last = length;
        if (steady >= 2) break;
      }
      if (opts.signal?.aborted) throw new Error('stopped');
      const page = await this.send('Runtime.evaluate', { expression: '({ html: document.documentElement.outerHTML, url: location.href, title: document.title })', returnByValue: true }, sessionId);
      return page.result.value as { html: string; url: string; title: string };
    }, { asChrome: true });
  }

  private receive(msg: any): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
      return;
    }
    const params = msg.params ?? {};
    const mine = !msg.sessionId || msg.sessionId === this.sessionId;
    switch (msg.method) {
      case 'Page.loadEventFired':
        if (mine) for (const w of this.loadWaiters.splice(0)) w();
        break;
      case 'Page.javascriptDialogOpening':
        // The click that opened it was meant: accept, and say so.
        this.events.push(`${params.type} dialog "${oneLine(params.message ?? '', 120)}" was accepted`);
        void this.send('Page.handleJavaScriptDialog', { accept: true, ...(params.type === 'prompt' ? { promptText: params.defaultPrompt ?? '' } : {}) }, msg.sessionId).catch(() => {});
        break;
      case 'Target.targetCreated': {
        const info = params.targetInfo ?? {};
        // A page this one opened (target=_blank, window.open): follow it, as a person would.
        if (info.type === 'page' && info.openerId && this.tabs.some((t) => t.targetId === info.openerId)) {
          void this.attach(info.targetId)
            .then(() => {
              this.current = this.tabs.length - 1;
              this.events.push(`the page opened a new tab (tab ${this.tabs.length}); now in it`);
            })
            .catch(() => {});
        }
        break;
      }
      case 'Target.targetDestroyed': {
        const i = this.tabs.findIndex((t) => t.targetId === params.targetId);
        if (i >= 0) {
          this.tabs.splice(i, 1);
          if (this.current >= this.tabs.length) this.current = Math.max(0, this.tabs.length - 1);
        }
        break;
      }
      case 'Browser.downloadWillBegin':
        this.downloads.set(params.guid, params.suggestedFilename ?? 'download');
        break;
      case 'Browser.downloadProgress':
        if (params.state === 'completed') this.events.push(`downloaded ${path.join(this.opts.downloadDir ?? '', this.downloads.get(params.guid) ?? 'a file')}`);
        else if (params.state === 'canceled') this.events.push(`a download of ${this.downloads.get(params.guid) ?? 'a file'} was cancelled`);
        break;
      case 'Runtime.consoleAPICalled':
        if (mine && (params.type === 'error' || params.type === 'warning' || params.type === 'assert')) {
          this.note(`console.${params.type}: ${(params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ')}`);
        }
        break;
      case 'Runtime.exceptionThrown':
        if (mine) this.note(`uncaught: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'exception'}`);
        break;
      case 'Network.responseReceived':
        if (mine && params.response?.status >= 400) this.note(`HTTP ${params.response.status} ${params.response.url}`);
        break;
      case 'Network.loadingFailed':
        if (mine && !params.canceled) this.note(`request failed: ${params.errorText}${params.type ? ` (${params.type})` : ''}`);
        break;
    }
  }

  /**
   * Lay out a page of HTML in a background tab at an exact size and pixel density and take its picture: the
   * drawing tool's canvas. `probe` runs once fonts and images are in and returns what the caller wants measured.
   */
  async paint(html: string, opts: { width: number; height: number; scale?: number; transparent?: boolean; probe?: string }): Promise<{ png: Buffer; probe: unknown }> {
    return this.withTemporaryTab(async (sessionId) => {
      // In front for the moment it takes: a tab behind another one gets no frames drawn and its fonts put off,
      // so its capture waits ever longer. Closing it hands the front back.
      await this.send('Page.bringToFront', {}, sessionId);
      await this.send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: opts.scale ?? 1, mobile: false }, sessionId);
      if (opts.transparent) await this.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
      const tree = await this.send('Page.getFrameTree', {}, sessionId);
      await this.send('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html }, sessionId);
      // Fonts and pictures in, for two seconds at most: a background tab may put font loads off indefinitely (the
      // capture then draws with what is there), and it gets no animation frames, so none are waited for.
      await this.send(
        'Runtime.evaluate',
        { expression: 'Promise.race([Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]), new Promise((r) => setTimeout(r, 2000))])', awaitPromise: true },
        sessionId,
      );
      const probe = opts.probe ? (await this.send('Runtime.evaluate', { expression: opts.probe, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value : undefined;
      const shot = await this.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: opts.width, height: opts.height, scale: 1 } }, sessionId);
      return { png: Buffer.from(shot.data, 'base64'), probe };
    });
  }

  private async navigateToReady(url: string, sessionId: string, polls: number): Promise<void> {
    await this.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < polls; i++) {
      const r = await this.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
      if (r?.result?.value === 'complete') break;
      await new Promise((res) => setTimeout(res, 100));
    }
  }

  /**
   * A page opened by its address at an exact size, held while `work` runs: it evaluates in the page and captures it,
   * frame after frame (the film tool). In front for the time it takes, so its fonts and pictures are drawn; the tab
   * closes after.
   */
  async withPage<T>(url: string, size: { width: number; height: number }, work: (page: { evaluate: (expression: string, limitMs?: number) => Promise<unknown>; capture: (format: 'jpeg' | 'png', quality?: number) => Promise<Buffer> }) => Promise<T>): Promise<T> {
    return this.withTemporaryTab(async (sessionId) => {
      await this.send('Page.bringToFront', {}, sessionId);
      await this.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await this.navigateToReady(url, sessionId, 300);
      const evaluate = async (expression: string, limitMs = 120_000) => {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, limitMs);
        if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'the page failed');
        return r?.result?.value;
      };
      const capture = async (format: 'jpeg' | 'png', quality = 92) =>
        Buffer.from((await this.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality } : {}), clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } }, sessionId)).data, 'base64');
      return await work({ evaluate, capture });
    });
  }

  /**
   * Opens a page by its address in a background tab, and returns what `expression` (a promise) gives once the page has
   * loaded: work a page does with the browser's own engines, like rendering sound offline. The tab closes after.
   */
  async evaluatePage(url: string, expression: string, limitMs = 300_000): Promise<unknown> {
    return this.withTemporaryTab(async (sessionId) => {
      await this.navigateToReady(url, sessionId, 150);
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, limitMs);
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'the page failed');
      return r?.result?.value;
    });
  }

  async viewport(width: number, height: number, desktop = false): Promise<void> {
    this.size = { width, height };
    // A visible window keeps its own size unless a size is asked for.
    if (this.opts.visible && !this.emulated && width === 1280 && height === 800 && !desktop) return;
    this.emulated = true;
    const phone = !desktop && width < 600;
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: phone });
  }

  private waitForLoad(ms = 20_000): { promise: Promise<void>; cancel: () => void } {
    let cancel!: () => void;
    const signal = this.signal;
    const promise = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        const i = this.loadWaiters.indexOf(done);
        if (i >= 0) this.loadWaiters.splice(i, 1);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.loadWaiters.push(done);
      signal?.addEventListener('abort', done, { once: true });
      cancel = done;
      if (signal?.aborted) done();
    });
    return { promise, cancel };
  }

  private async navigate(method: string, params: Record<string, unknown> = {}, ms = 20_000): Promise<void> {
    const generation = this.generation;
    const loaded = this.waitForLoad(ms);
    try {
      const r = await this.send(method, params);
      if (r?.errorText) throw new Error(`could not open ${params.url}: ${r.errorText}`);
      await loaded.promise;
      this.signal?.throwIfAborted();
      if (!this.ws || generation !== this.generation) throw new Error('the browser closed');
    } finally {
      loaded.cancel();
    }
  }

  /**
   * Until the page in the current tab has loaded. Polled rather than waited for as an event: a tab that was just
   * opened may have loaded before it was attached, and a navigation a click started needs a moment to begin.
   */
  private async loaded(ms = 15_000): Promise<void> {
    await sleep(300, this.signal);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try {
        if ((await this.evaluate<string>('document.readyState')) === 'complete') return;
      } catch {
        this.signal?.throwIfAborted();
        // The old page went away mid-check: the new one is on its way.
      }
      await sleep(100, this.signal);
    }
  }

  async open(url: string): Promise<void> {
    await this.navigate('Page.navigate', { url });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value as T;
  }

  /** The page's interactive elements with refs, in-view ones first. */
  async snapshot(): Promise<{ lines: string[]; more: number }> {
    return (await this.evaluate<{ lines: string[]; more: number }>(SNAPSHOT)) ?? { lines: [], more: 0 };
  }

  async readText(max: number): Promise<string> {
    const t = (await this.evaluate<string>(READ)) ?? '';
    return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t;
  }

  async tabList(): Promise<string[]> {
    const infos = ((await this.send('Target.getTargets', {}, false)).targetInfos ?? []) as { targetId: string; title: string; url: string }[];
    return this.tabs.map((t, i) => {
      const info = infos.find((x) => x.targetId === t.targetId);
      return `${i + 1}${i === this.current ? '*' : ''} ${oneLine(info?.title || '(untitled)', 60)} — ${oneLine(info?.url ?? '', 100)}`;
    });
  }

  /** The point to press on an element, scrolled into view, and what covers it there if something does. */
  private async point(q: Target): Promise<{ x: number; y: number; covered: string | null }> {
    const box = await this.evaluate<{ x: number; y: number; covered: string | null } | null>(
      `(() => { const e = (${FIND})(${JSON.stringify(q)}); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = document.elementFromPoint(x, y); const covered = top && top !== e && !e.contains(top) && !top.contains(e) ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : top.className && typeof top.className === 'string' ? '.' + top.className.trim().split(/\\s+/)[0] : '') : null; return { x, y, covered }; })()`,
    );
    if (!box) throw new Error(missing(q));
    return box;
  }

  /** Let go of a button that {click, hold: true} kept pressed. */
  async release(): Promise<void> {
    const h = this.held;
    if (!h) return;
    this.held = null;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h.x, y: h.y, button: h.button, clickCount: 1 }).catch(() => {});
  }

  private async mouse(x: number, y: number, button: 'left' | 'right', clicks: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    for (let c = 1; c <= clicks; c++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: c });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: c });
    }
  }

  private async key(combo: string): Promise<void> {
    // "+" and "ctrl++" press the plus key itself; everything else splits on "+".
    const plus = combo === '+' || combo.endsWith('++');
    const parts = (plus ? combo.slice(0, -1) : combo).split('+').map((p) => p.trim()).filter(Boolean);
    const name = plus ? '+' : (parts.pop() ?? '');
    if (!name) throw new Error(`"${combo}" names no key`);
    const modifiers = parts.reduce((m, p) => m | (MODIFIERS[p.toLowerCase()] ?? 0), 0);
    const k = KEYS[name.toLowerCase()] ?? { code: /^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : /^\d$/.test(name) ? `Digit${name}` : name, key: name, keyCode: name.toUpperCase().charCodeAt(0), text: name.length === 1 ? name : undefined };
    const text = modifiers & ~8 ? undefined : k.text;
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, text, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers });
  }

  /** Runs one action; throws with what went wrong so the caller can stop and show the page as it is. */
  async act(a: BrowserAction, cwd = process.cwd()): Promise<string> {
    this.signal?.throwIfAborted();
    await this.release();
    if ('click' in a) {
      const p = await this.point(a.click);
      if (a.hold) {
        // Pressed and not let go, so the screenshot shows the pressed state (:active): a page's own script cannot
        // fake it, and a model checking a pressed button had written Chrome scripts of its own to see it (2026-11-05).
        const button = a.button ?? 'left';
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, clickCount: 1 });
        this.held = { x: p.x, y: p.y, button };
        return `pressed ${a.click} and held it down (the next action or call lets go)${p.covered ? ` (a ${p.covered} was over it, so the press went there)` : ''}`;
      }
      await this.mouse(p.x, p.y, a.button ?? 'left', a.double ? 2 : 1);
      return `${a.double ? 'double-' : ''}${a.button === 'right' ? 'right-' : ''}clicked ${a.click}${p.covered ? ` (a ${p.covered} was over it, so the click went there)` : ''}`;
    }
    if ('hover' in a) {
      const p = await this.point(a.hover);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
      return `hovered over ${a.hover}`;
    }
    if ('type' in a) {
      if (a.into) {
        const found = await this.evaluate<boolean>(`(() => { const e = (${FIND})(${JSON.stringify(a.into)}); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.focus(); if ('select' in e) e.select(); return true; })()`);
        if (!found) throw new Error(missing(a.into));
      }
      await this.send('Input.insertText', { text: a.type });
      return `typed ${JSON.stringify(oneLine(a.type, 40))}${a.into ? ` into ${a.into}` : ''}`;
    }
    if ('fill' in a) {
      // Focus, select what is there, and type over it: the page sees the same input events as from a person.
      const found = await this.evaluate<boolean>(
        `(() => { const e = (${FIND})(${JSON.stringify(a.fill)}); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.focus(); if ('select' in e && typeof e.select === 'function') e.select(); else { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } return true; })()`,
      );
      if (!found) throw new Error(missing(a.fill));
      if (a.value) await this.send('Input.insertText', { text: a.value });
      else await this.key('Delete');
      return `filled ${a.fill} with ${JSON.stringify(oneLine(a.value, 40))}`;
    }
    if ('select' in a) {
      const r = await this.evaluate<string>(
        `(() => { const e = (${FIND})(${JSON.stringify(a.select)}); if (!e) return 'missing'; if (e.tagName !== 'SELECT') return 'not a select'; const want = ${JSON.stringify(a.option)}.trim().toLowerCase(); const opts = [...e.options]; const o = opts.find((x) => x.text.trim().toLowerCase() === want || x.value.toLowerCase() === want) || opts.find((x) => x.text.trim().toLowerCase().includes(want)); if (!o) return 'options: ' + opts.map((x) => x.text.trim()).join(', '); e.value = o.value; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return 'ok:' + o.text.trim(); })()`,
      );
      if (r === 'missing') throw new Error(missing(a.select));
      if (r === 'not a select') throw new Error(`${a.select} is not a <select>; open it with click and click the option instead`);
      if (!r.startsWith('ok:')) throw new Error(`${a.select} has no option "${a.option}"; ${r}`);
      return `chose "${r.slice(3)}" in ${a.select}`;
    }
    if ('check' in a || 'uncheck' in a) {
      const q = 'check' in a ? a.check : a.uncheck;
      const want = 'check' in a;
      const state = await this.evaluate<boolean | null>(`(() => { const e = (${FIND})(${JSON.stringify(q)}); if (!e) return null; return 'checked' in e ? e.checked : e.getAttribute('aria-checked') === 'true'; })()`);
      if (state === null) throw new Error(missing(q));
      if (state !== want) {
        const p = await this.point(q);
        await this.mouse(p.x, p.y, 'left', 1);
      }
      return `${want ? 'checked' : 'unchecked'} ${q}${state === want ? ' (it already was)' : ''}`;
    }
    if ('upload' in a) {
      const r = await this.send('Runtime.evaluate', { expression: `(${FIND})(${JSON.stringify(a.upload)})` });
      if (!r.result?.objectId) throw new Error(missing(a.upload));
      const files = a.files.map((f) => resolvePath(cwd, f));
      for (const f of files) if (!fs.existsSync(f)) throw new Error(`no such file to upload: ${f}`);
      await this.send('DOM.setFileInputFiles', { files, objectId: r.result.objectId });
      return `attached ${files.map((f) => path.basename(f)).join(', ')} to ${a.upload}`;
    }
    if ('press' in a) {
      for (const combo of a.press.trim().split(/\s+/)) await this.key(combo);
      return `pressed ${a.press}`;
    }
    if ('wait' in a) {
      if (typeof a.wait === 'number') {
        await sleep(Math.min(a.wait, 15_000), this.signal);
        return `waited ${a.wait} ms`;
      }
      if (a.wait === 'load') {
        await this.loaded();
        return 'the page loaded';
      }
      for (let t = 0; t < 100; t++) {
        if (await this.evaluate<boolean>(`!!(${FIND})(${JSON.stringify(a.wait)})`)) return `${a.wait} appeared`;
        await sleep(100, this.signal);
      }
      throw new Error(`${a.wait} did not appear within 10 s`);
    }
    if ('scroll' in a) {
      if (typeof a.scroll === 'number') await this.evaluate(`window.scrollBy(0, ${Number(a.scroll)})`);
      else if (!(await this.evaluate<boolean>(`(() => { const e = (${FIND})(${JSON.stringify(a.scroll)}); if (e) e.scrollIntoView({ block: 'start' }); return !!e; })()`))) throw new Error(missing(a.scroll));
      return `scrolled ${a.scroll}`;
    }
    if ('back' in a || 'forward' in a) {
      const h = await this.send('Page.getNavigationHistory');
      const to = h.entries[h.currentIndex + ('back' in a ? -1 : 1)];
      if (!to) throw new Error(`there is no page to go ${'back' in a ? 'back' : 'forward'} to`);
      await this.navigate('Page.navigateToHistoryEntry', { entryId: to.id }, 15_000);
      return `went ${'back' in a ? 'back' : 'forward'} to ${oneLine(to.url, 80)}`;
    }
    if ('reload' in a) {
      await this.navigate('Page.reload', {}, 15_000);
      return 'reloaded the page';
    }
    if ('tab' in a) {
      if (a.tab === 'list') return `tabs: ${(await this.tabList()).join('; ')}`;
      if (a.tab === 'new') {
        const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' }, false);
        this.created.add(targetId);
        await this.attach(targetId);
        this.current = this.tabs.length - 1;
        if (a.url) await this.open(a.url);
        return `opened a new tab${a.url ? ` with ${a.url}` : ''}`;
      }
      if (a.tab === 'close') {
        const t = this.tabs[this.current];
        if (!t || this.tabs.length < 2) throw new Error('this is the only tab');
        await this.send('Target.closeTarget', { targetId: t.targetId }, false);
        this.tabs.splice(this.current, 1);
        this.current = Math.max(0, this.current - 1);
        return `closed the tab; now in tab ${this.current + 1}`;
      }
      const i = Number(a.tab) - 1;
      if (!this.tabs[i]) throw new Error(`there is no tab ${a.tab}; ${(await this.tabList()).join('; ')}`);
      this.current = i;
      await this.send('Target.activateTarget', { targetId: this.tabs[i].targetId }, false).catch(() => {});
      return `switched to tab ${a.tab}`;
    }
    if ('js' in a) {
      const v = await this.evaluate<unknown>(a.js);
      return `ran the script: ${oneLine(JSON.stringify(v) ?? 'undefined', 400)}`;
    }
    if ('read' in a) return 'read the page text (below)';
    if ('measure' in a) {
      const m = await this.evaluate<DesignMeasure>(MEASURE_SCRIPT);
      if (!m) throw new Error('the page could not be measured');
      return `measured the page against the bar of well-made brand sites:\n${designReport(m)}`;
    }
    if ('zoom' in a) {
      // A part of what the screenshot shows, captured again at two or three times the pixels: small text, edges.
      // The numbers are read off that screenshot, which may hold more pixels than the page has.
      const [x, y, w, h] = a.zoom.map((n) => Number(n) / this.shotScale);
      if (!(w >= 4 && h >= 4)) throw new Error('zoom is [x, y, width, height] in the screenshot\'s pixels');
      const [sx, sy] = (await this.evaluate<[number, number]>('[scrollX, scrollY]')) ?? [0, 0];
      const scale = Math.max(1, Math.min(3, 1200 / Math.max(w, h)));
      const shot = await this.send('Page.captureScreenshot', { format: 'png', clip: { x: x + sx, y: y + sy, width: w, height: h, scale } });
      this.zooms.push({ type: 'image', mediaType: 'image/png', data: shot.data, name: `zoom [${[x, y, w, h].join(', ')}]` });
      return `zoomed into [${[x, y, w, h].join(', ')}] at ${+scale.toFixed(2)}× (picture ${this.zooms.length + 1})`;
    }
    throw new Error(`unknown action ${JSON.stringify(a)}`);
  }

  /** The viewport as it stands, `scale` picture pixels to one page pixel. */
  async capture(width: number, height: number, scale = 1): Promise<Buffer> {
    this.shotScale = scale;
    let options: Record<string, unknown> = {};
    if (scale !== 1) {
      const [x, y] = (await this.evaluate<[number, number]>('[scrollX, scrollY]')) ?? [0, 0];
      options = { clip: { x, y, width, height, scale } };
    }
    const shot = await this.send('Page.captureScreenshot', { format: 'png', ...options });
    return Buffer.from(shot.data, 'base64');
  }

  /** An exact 1× width×height PNG of the current viewport, after fonts and images settle. */
  async exportPng(width: number, height: number): Promise<Buffer> {
    await this.evaluate('Promise.race([Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]), new Promise((r) => setTimeout(r, 2000))])').catch(() => {});
    const [x, y] = (await this.evaluate<[number, number]>('[scrollX, scrollY]')) ?? [0, 0];
    const shot = await this.send('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } });
    return Buffer.from(shot.data, 'base64');
  }

  /** The whole page as one strip, 6000 px at most: for a sheet a person reads. A model gets `screens`. */
  async strip(width: number, height: number): Promise<Buffer> {
    this.shotScale = 1;
    const metrics = await this.send('Page.getLayoutMetrics');
    const h = Math.min(6000, Math.ceil(metrics.cssContentSize?.height ?? metrics.contentSize?.height ?? height));
    const shot = await this.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: Math.max(height, h), scale: 1 }, captureBeyondViewport: true });
    return Buffer.from(shot.data, 'base64');
  }

  /**
   * The whole page as the screens a visitor scrolls through, top to bottom, the last one ending at the page's end.
   * It was one strip taken beyond the viewport: a long page reached the model shrunk to a ribbon, pinned parts stayed
   * where they were at the top, and what a page shows on scroll never showed. Models did not use it and walked a
   * page a screen a call instead: of some 27 requests for one landing page, 20 were looks (five pages at two widths,
   * 2026-11-11). Each screen here is the real viewport after scrolling to it, and the page ends where it began.
   */
  async screens(width: number, height: number, scale = 1): Promise<{ shots: Buffer[]; pageHeight: number; total: number; step: number }> {
    const [top, full, w, h] = (await this.evaluate<number[]>('[scrollY, Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), innerWidth, innerHeight]')) ?? [0, height, width, height];
    // The screen as the page lays it out: a page with no viewport tag is 980 px wide on a phone, whatever size was asked for.
    width = w || width;
    height = h || height;
    const pageHeight = Math.max(height, Math.ceil(full));
    // A few pixels past a screen's end are not another screen.
    const total = Math.max(1, Math.ceil((pageHeight - 8) / height));
    const shots: Buffer[] = [];
    try {
      for (let i = 0; i < Math.min(total, MAX_SCREENS); i++) {
        // 'instant': a page that sets smooth scrolling would still be on its way when the picture is taken.
        await this.evaluate(`window.scrollTo({ top: ${Math.min(i * height, pageHeight - height)}, behavior: 'instant' })`);
        // What enters on scroll gets the time an entrance is allowed.
        await sleep(i === 0 ? 100 : SCREEN_SETTLE_MS, this.signal);
        shots.push(await this.capture(width, height, scale));
      }
    } finally {
      await this.evaluate(`window.scrollTo({ top: ${top}, behavior: 'instant' })`).catch(() => {});
    }
    return { shots, pageHeight, total, step: height };
  }

  close(): void {
    this.generation++;
    // In a browser the user has open, only the agent's own tabs go.
    if (this.shared && this.ws) for (const targetId of this.created) {
      try {
        this.ws.send(JSON.stringify({ id: ++this.next, method: 'Target.closeTarget', params: { targetId } }));
      } catch { /* the connection is already gone */ }
    }
    for (const p of this.pending.values()) p.reject(new Error('the browser closed'));
    this.pending.clear();
    for (const done of this.loadWaiters.splice(0)) done();
    this.created.clear();
    this.shared = false;
    this.held = null;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    const child = this.child;
    if (child) killChild(child);
    this.child = null;
    this.starting = null;
    this.tabs = [];
    this.current = 0;
    this.emulated = false;
    // The temporary profile goes once Chrome has let go of it: removed on a timer, Chrome's helpers often still
    // held files and the removal failed without a word (524 profiles, 7.8 GB, in a day of page checks and test runs).
    const dir = this.dir;
    this.dir = null;
    if (!dir) return;
    const drop = () => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }, () => {});
    if (child && child.exitCode === null && child.signalCode === null) child.once('exit', () => setTimeout(drop, 500));
    else setTimeout(drop, 500);
  }
}

function missing(q: Target): string {
  return /^e\d+$/.test(q) ? `nothing matches ${q} (refs come from the latest element list; the page may have changed since)` : `nothing matches ${q}`;
}

/**
 * Uses web pages the way a person would and shows the result: open a URL or a local file, then click, type,
 * fill forms, choose options, go back, work in tabs, and get the page's interactive elements with refs to act
 * on, a screenshot, what the page logged, dialogs and downloads, and the start of its text (or all of it with
 * read). The browser stays open between calls.
 */
export const browserTool: ToolDef<BrowserInput> = {
  kind: 'web',
  readOnly: false,
  title: (i) => `Browser${i.url ? ` ${i.url}` : ''}${i.actions?.length ? ` (${i.actions.length} action${i.actions.length === 1 ? '' : 's'})` : ''}`,
  async execute(input, ctx) {
    const b = ctx.browser?.();
    if (!b) return { content: 'No Chrome, Edge or Chromium was found on this machine; set browserPath in the config.', isError: true };
    const outAbs = input.out ? resolvePath(ctx.cwd, input.out) : undefined;
    if (outAbs) {
      if (ctx.config?.confine && ![ctx.cwd, scratchDir(ctx.cwd)].some((r) => isInside(r, outAbs))) {
        return { content: `Refused in confined mode: "${input.out}" is outside the workspace.`, isError: true };
      }
      const why = ctx.mayChange?.(outAbs);
      if (why) return { content: why, isError: true };
    }
    return b.withSignal(ctx.signal, async () => {
      // The size stays until another is asked for: a click on a phone layout must not bring the desktop one back.
      const minSide = outAbs ? 32 : 320;
      const maxW = outAbs ? 4096 : 2560;
      const maxH = outAbs ? 4096 : 4000;
      const dualCheck = !!input.checkWidths && !outAbs && !input.fullPage;
      const width = dualCheck ? 1280 : Math.min(Math.max(input.width ?? b.size.width, minSide), maxW);
      const height = dualCheck ? 800 : Math.min(Math.max(input.height ?? (input.width === undefined ? b.size.height : !outAbs && input.width < 600 ? 844 : 800), minSide), maxH);
      const done: string[] = [];
      let failure = '';
      let reading = false;
      try {
        // Headless and confined callers must not turn a tool request into a desktop window.
        if (ctx.config?.confine || !ctx.interactive) {
          b.setVisible(false);
          if (input.show) done.push('ignored show: the browser stays headless in confined or non-interactive sessions');
        } else if (input.show && b.setVisible(true)) done.push('opened the browser as a window');
        await b.start();
        await b.release();
        await b.viewport(width, height, !!outAbs);
        if (input.url) {
          const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.url) || input.url.startsWith('about:') ? input.url : pathToFileURL(resolvePath(ctx.cwd, input.url)).href;
          await b.open(target);
          done.push(`opened ${input.url}`);
        }
        for (const a of input.actions ?? []) {
          ctx.signal.throwIfAborted();
          if ('read' in a) reading = true;
          done.push(await b.act(a, ctx.cwd));
          await sleep(150, ctx.signal);
        }
      } catch (e) {
        ctx.signal.throwIfAborted();
        failure = (e as Error).message;
      }
      // Let the page settle after the last action before looking at it.
      await sleep(500, ctx.signal);
      let image: ImagePart | undefined;
      let screens: ImagePart[] = [];
      let shown = '';
      let page = { title: '', url: '', text: '' };
      let facts = '';
      let elements: { lines: string[]; more: number } = { lines: [], more: 0 };
      let tabs: string[] = [];
      let textLayout = '';
      try {
        if (outAbs && !failure) {
          const exported = await b.exportPng(width, height);
          ctx.checkpoints.capture(ctx.turn, outAbs);
          fs.mkdirSync(path.dirname(outAbs), { recursive: true });
          fs.writeFileSync(outAbs, exported);
          ctx.files.recordWrite(outAbs);
          done.push(`saved ${displayPath(ctx.cwd, outAbs)} (${width}×${height})`);
          if (!ctx.model.vision) {
            textLayout =
              (await b
                .evaluate<string>(
                  `(() => {
                    const W = ${width}, H = ${height};
                    const boxes = [];
                    for (const e of document.querySelectorAll('body *')) {
                      if (e.closest('script,style,noscript')) continue;
                      const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
                      if (!own) continue;
                      const s = getComputedStyle(e);
                      if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.05) continue;
                      const r = e.getBoundingClientRect();
                      if (r.width < 1 || r.height < 1) continue;
                      boxes.push({ t: own.replace(/\\s+/g, ' ').slice(0, 24), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) });
                    }
                    if (!boxes.length) return '';
                    const clipped = boxes.filter((b) => b.x < 0 || b.y < 0 || b.r > W || b.b > H).map((b) => '"' + b.t + '"');
                    let overlaps = 0;
                    for (let i = 0; i < boxes.length; i++)
                      for (let j = i + 1; j < boxes.length; j++) {
                        const a = boxes[i], c = boxes[j];
                        if (Math.min(a.r, c.r) - Math.max(a.x, c.x) > 4 && Math.min(a.b, c.b) - Math.max(a.y, c.y) > 4) overlaps++;
                      }
                    const shown = boxes.slice(0, 8).map((b) => '"' + b.t + '"@' + b.x + ',' + b.y + ' ' + b.w + '×' + b.h).join('; ');
                    return 'Text layout: ' + boxes.length + ' text box' + (boxes.length === 1 ? '' : 'es') + (clipped.length ? ', CLIPPED ' + clipped.join(', ') : ', all inside ' + W + '×' + H) + (overlaps ? ', ' + overlaps + ' overlap(s)' : ', no overlap') + ' (' + shown + (boxes.length > 8 ? '; …' : '') + ').';
                  })()`,
                )
                .catch(() => '')) ?? '';
          }
        }
        page = await b.evaluate<typeof page>(`({ title: document.title, url: location.href, text: '' })`);
        if (reading) page.text = await b.readText(Math.max(4000, ctx.outputChars - 6000));
        else facts = await pageFacts(b, width < 600).catch(() => '');
        elements = await b.snapshot();
        tabs = await b.tabList();
        const at = SHOT_SCALE !== 1 ? ` at ${SHOT_SCALE}×` : '';
        if (dualCheck) {
          const dm = await b.evaluate<DesignMeasure>(MEASURE_SCRIPT).catch(() => null);
          const barIssues = dm ? designReport(dm).split('\n').filter((l) => l.startsWith('- OUTSIDE THE BAR')) : [];
          if (ctx.model.vision) {
            image = { type: 'image', mediaType: 'image/png', data: (await b.capture(1280, 800, SHOT_SCALE)).toString('base64'), name: 'desktop 1280×800', detail: 'high' as const };
          }
          await b.viewport(390, 844, false);
          await sleep(250, ctx.signal);
          const phoneFacts = await pageFacts(b, true).catch(() => '');
          const phoneMeasured = phoneFacts.split('\n').find((l) => l.startsWith('Measured:'));
          if (ctx.model.vision) {
            screens = [{ type: 'image', mediaType: 'image/png', data: (await b.capture(390, 844, SHOT_SCALE)).toString('base64'), name: 'mobile 390×844', detail: 'high' as const }];
          }
          await b.viewport(1280, 800, false);
          const extras = [
            barIssues.length ? `Design bar (1280×800):\n${barIssues.join('\n')}` : 'Design bar (1280×800): all bars met.',
            phoneMeasured ? `Phone check (390×844) — ${phoneMeasured}` : 'Phone check (390×844): no overflow, clipping, contrast or tap-target (<32px) issues.',
          ];
          facts = [facts, ...extras].filter(Boolean).join('\n');
          shown = ctx.model.vision ? `checked at 1280×800 and 390×844, 2 screenshots attached${at}` : 'checked at 1280×800 and 390×844';
        } else if (ctx.model.vision && input.fullPage) {
          const whole = await b.screens(width, height, SHOT_SCALE);
          screens = whole.shots.map((data, i) => ({ type: 'image', mediaType: 'image/png', data: data.toString('base64'), name: `screen ${i + 1} of ${whole.total}`, detail: 'high' as const }));
          shown = whole.total === 1
            ? `the whole page fits this screen, screenshot attached${at}`
            : whole.total <= screens.length
              ? `the whole page, ${whole.pageHeight} px tall, attached${at} as its ${whole.total} screens from top to bottom`
              : `the page is ${whole.pageHeight} px tall, ${whole.total} screens: the first ${screens.length} are attached${at}, the rest begins ${screens.length * whole.step} px down`;
        } else if (ctx.model.vision) {
          image = { type: 'image', mediaType: 'image/png', data: (await b.capture(width, height, SHOT_SCALE)).toString('base64'), name: 'page.png', detail: 'high' as const };
          shown = `screenshot attached${at}`;
        }
      } catch (e) {
        ctx.signal.throwIfAborted();
        failure ||= (e as Error).message;
      }
      const log = b.takeLog();
      const events = b.takeEvents();
      const zooms = ctx.model.vision ? b.takeZooms() : (b.takeZooms(), []);
      const lines = [
        `${page.title ? `"${page.title}" · ` : ''}${page.url} at ${width}×${height}${shown ? ` (${shown})` : ''}${b.visible ? ' in a window on screen' : ''}`,
        done.length ? `Done: ${done.join('; ')}.` : '',
        failure ? `Stopped: ${failure}` : '',
        events.length ? `Also: ${events.join('; ')}.` : '',
        log.length ? `Page reported:\n${log.map((l) => `  ${l}`).join('\n')}` : 'No console errors or failed requests.',
        tabs.length > 1 ? `Tabs (* is this one): ${tabs.join('; ')}` : '',
        textLayout,
        page.text ? `Page text:\n${page.text}` : facts,
        elements.lines.length ? `Elements (act on them by ref, e.g. {"click": "e3"}):\n${elements.lines.join('\n')}${elements.more ? `\n… ${elements.more} more further down` : ''}` : '',
      ].filter(Boolean);
      return {
        content: lines.join('\n'),
        isError: !!failure,
        images: image || screens.length || zooms.length ? [...(image ? [image] : []), ...screens, ...zooms] : undefined,
        display: { kind: 'shot', url: page.url || input.url || '', width, height },
      };
    });
  },
};

/**
 * The browser already running on a profile (Chrome writes DevToolsActivePort there when started with a debugging
 * port), and whether it runs headless; null when none answers.
 */
async function running(profileDir: string): Promise<{ endpoint: string; headless: boolean } | null> {
  let port: string | undefined;
  let wsPath: string | undefined;
  try {
    [port, wsPath] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
  if (!port || !wsPath) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return null;
    // New headless names itself plain Chrome in Browser; only its user agent still says HeadlessChrome.
    const version = (await r.json().catch(() => ({}))) as { Browser?: string; 'User-Agent'?: string };
    return { endpoint: `ws://127.0.0.1:${port}${wsPath}`, headless: /headless/i.test(`${version.Browser} ${version['User-Agent']}`) };
  } catch {
    return null;
  }
}

let swept = false;

/**
 * Temporary profiles left by browsers that were killed or crashed (a closed session removes its own): once a
 * process, the ones untouched for two hours go. One in use keeps its files open, so its removal fails and it stays.
 */
function sweepStaleProfiles(): void {
  if (swept) return;
  swept = true;
  const tmp = os.tmpdir();
  fs.readdir(tmp, { withFileTypes: true }, (err, entries) => {
    if (err) return;
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('favilla-browser-')) continue;
      const dir = path.join(tmp, e.name);
      fs.stat(dir, (err2, st) => {
        if (!err2 && Date.now() - st.mtimeMs > 2 * 3600_000) fs.rm(dir, { recursive: true, force: true }, () => {});
      });
    }
  });
}

/** The DevTools address the port file of a browser's user data folder names, without asking the browser. */
function portFileEndpoint(dir: string): string | null {
  try {
    const [port, wsPath] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
    return port && wsPath ? `ws://127.0.0.1:${port}${wsPath}` : null;
  } catch {
    return null;
  }
}

/** The DevTools address of a browser already running on a profile, or null when none answers. */
export async function runningEndpoint(profileDir: string): Promise<string | null> {
  return (await running(profileDir))?.endpoint ?? null;
}

/**
 * Favilla's browser for the user: a Chrome window on Favilla's kept profile, where signing in to a site once lets the
 * agent work there too. A window opens in the running one if it is up; otherwise it starts on its own, outliving
 * the session and Favilla, with a debugging port on localhost that the agent's sessions attach to.
 */
export async function openFavillaBrowser(executable: string, profileDir: string, url = 'about:blank'): Promise<'opened' | 'started' | 'busy' | 'stale'> {
  const up = await running(profileDir);
  // An agent's headless browser holds the profile: a window opened in it would never show, and a new Chrome on
  // the same profile hands its start over to that one.
  if (up?.headless) return 'busy';
  if (up) {
    const ws = new WebSocket(up.endpoint);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('could not reach Favilla\'s browser')));
    });
    let next = 0;
    const answers = new Map<number, (v: any) => void>();
    ws.addEventListener('message', (m) => {
      const d = JSON.parse(String(m.data));
      answers.get(d.id)?.(d.result ?? {});
      answers.delete(d.id);
    });
    const call = (method: string, params: Record<string, unknown>, sessionId?: string) =>
      new Promise<any>((resolve) => {
        const id = ++next;
        answers.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => resolve({}), 3000);
      });
    try {
      const { targetId } = await call('Target.createTarget', { url, newWindow: true });
      // One an earlier Favilla started without the switch still tells sites it is automated (BASE_FLAGS), and
      // sign-in fails there until it starts again.
      const { sessionId } = targetId ? await call('Target.attachToTarget', { targetId, flatten: true }) : {};
      const r = sessionId ? await call('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true }, sessionId) : {};
      if (sessionId) await call('Target.detachFromTarget', { sessionId });
      return r.result?.value === true ? 'stale' : 'opened';
    } finally {
      ws.close();
    }
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(executable, [`--user-data-dir=${profileDir}`, ...BASE_FLAGS, '--new-window', url], { detached: true, stdio: 'ignore' });
  child.unref();
  return 'started';
}
