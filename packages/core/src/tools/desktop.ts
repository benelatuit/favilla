import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImagePart } from '../types';
import { assetsDir } from '../util/paths';
import { oneLine } from '../util/text';
import type { ToolDef } from './types';

type Point = [number, number];

export type DesktopAction =
  | { click: Point; button?: 'left' | 'right' | 'middle'; double?: boolean }
  | { move: Point }
  | { drag: [Point, Point] }
  | { scroll: number; at?: Point }
  | { type: string }
  | { key: string }
  | { wait: number }
  | { focus: string }
  | { zoom: [number, number, number, number] };

export const DESKTOP_ACTIONS = ['click', 'move', 'drag', 'scroll', 'type', 'key', 'wait', 'focus', 'zoom'];

export interface DesktopInput {
  /** Work in this window (part of its title): it comes to the front and screenshots show only it. */
  window?: string;
  actions?: DesktopAction[];
  /** List the open windows instead of looking at the screen. */
  list?: boolean;
}

interface Win {
  Handle: number;
  Title: string;
  X: number;
  Y: number;
  W: number;
  H: number;
  Minimized: boolean;
  Focused: boolean;
}

interface Shot {
  X: number;
  Y: number;
  W: number;
  H: number;
  Width: number;
  Height: number;
  Scale: number;
  CursorX: number;
  CursorY: number;
}

/** Screenshots are scaled to fit this, which keeps text legible and the picture cheap for the model. */
const MAX_W = 1280;
const MAX_H = 800;

const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b, meta: 0x5b, cmd: 0x5b, super: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, printscreen: 0x2c, menu: 0x5d, plus: 0xbb, minus: 0xbd,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};

/** "ctrl+shift+t" as virtual-key codes, or why it cannot be. */
export function chord(combo: string): number[] {
  return combo
    .toLowerCase()
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      if (VK[k] !== undefined) return VK[k];
      if (/^f([1-9]|1\d|2[0-4])$/.test(k)) return 0x70 + Number(k.slice(1)) - 1;
      if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
      throw new Error(`Unknown key "${k}" in "${combo}". Use names like ctrl, alt, shift, win, enter, tab, esc, up, f5, a, 1.`);
    });
}

/**
 * The desktop through a helper process (Windows PowerShell with a small compiled class): one per session,
 * started on first use. Points the model gives are read off the last screenshot, so they are mapped back
 * through that screenshot's origin and scale.
 */
export class DesktopSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private waits = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private next = 1;
  private buf = '';
  private dir = '';
  view: { x: number; y: number; scale: number; width: number; height: number } | null = null;
  window: { handle: number; title: string } | null = null;
  /** Pictures zoom actions took since the last call. */
  zooms: ImagePart[] = [];

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    this.dir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-desk-'));
    // Copied out first: in the packed app the asset sits inside app.asar, which only this process can read.
    const script = path.join(this.dir, 'windows.ps1');
    if (!fs.existsSync(script)) fs.writeFileSync(script, fs.readFileSync(path.join(assetsDir(), 'desktop', 'windows.ps1')));
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this.receive(line);
      }
    });
    p.stderr.resume();
    p.on('exit', () => {
      this.proc = null;
      for (const w of this.waits.values()) w.reject(new Error('The desktop helper stopped.'));
      this.waits.clear();
    });
    this.proc = p;
    return p;
  }

  private receive(line: string): void {
    let msg: { id: number; ok: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const w = this.waits.get(msg.id);
    if (!w) return;
    this.waits.delete(msg.id);
    if (msg.ok) w.resolve(msg.result);
    else w.reject(new Error(msg.error ?? 'The desktop helper failed.'));
  }

  call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const p = this.start();
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waits.delete(id);
        reject(new Error(`The desktop helper did not answer "${op}" in time.`));
      }, timeoutMs);
      this.waits.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      p.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  /** A point read off the last screenshot, in screen pixels. */
  toScreen(p: Point): Point {
    if (!this.view) throw new Error('Look at the screen first (call without actions): points are read off a screenshot.');
    const [x, y] = p;
    if (!(x >= 0 && y >= 0 && x <= this.view.width && y <= this.view.height)) throw new Error(`(${x}, ${y}) is outside the last screenshot (${this.view.width}×${this.view.height}).`);
    return [Math.round(this.view.x + x / this.view.scale), Math.round(this.view.y + y / this.view.scale)];
  }

  async windows(): Promise<Win[]> {
    return (await this.call<Win[]>('windows')) ?? [];
  }

  /** The window whose title contains `part` (an exact match first, then the frontmost visible one). */
  async find(part: string): Promise<Win | null> {
    const want = part.trim().toLowerCase();
    const all = await this.windows();
    const hits = all.filter((w) => w.Title.toLowerCase().includes(want));
    return hits.find((w) => w.Title.toLowerCase() === want) ?? hits.find((w) => !w.Minimized) ?? hits[0] ?? null;
  }

  async focus(part: string): Promise<string> {
    const w = await this.find(part);
    if (!w) throw new Error(`No open window has "${part}" in its title.`);
    const front = await this.call<boolean>('focus', { handle: w.Handle });
    this.window = { handle: w.Handle, title: w.Title };
    return front ? `brought "${oneLine(w.Title, 80)}" to the front` : `"${oneLine(w.Title, 80)}" could not be brought to the front (Windows refused); it may be covered`;
  }

  async shot(): Promise<{ image: ImagePart; info: Shot; scope: string }> {
    let rect = { x: 0, y: 0, w: 0, h: 0 };
    let scope = 'the whole screen';
    if (this.window) {
      const w = (await this.windows()).find((x) => x.Handle === this.window!.handle);
      if (w && !w.Minimized && w.W > 0 && w.H > 0) {
        rect = { x: w.X, y: w.Y, w: w.W, h: w.H };
        scope = `the window "${oneLine(w.Title, 80)}"`;
      } else this.window = null;
    }
    const file = path.join(this.dir || (this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-desk-'))), `shot-${this.next}.png`);
    const info = await this.call<Shot>('shot', { ...rect, maxW: MAX_W, maxH: MAX_H, file });
    const data = fs.readFileSync(file).toString('base64');
    fs.rmSync(file, { force: true });
    this.view = { x: info.X, y: info.Y, scale: info.Scale, width: info.Width, height: info.Height };
    return { image: { type: 'image', mediaType: 'image/png', data, name: 'screen.png' }, info, scope };
  }

  /** A part of the last screenshot captured again at the screen's own resolution (up to 1600 px a side). */
  async zoom(region: [number, number, number, number]): Promise<string> {
    const [x, y, w, h] = region.map(Number);
    if (!(w >= 4 && h >= 4)) throw new Error('zoom is [x, y, width, height] in the screenshot\'s pixels');
    const [sx, sy] = this.toScreen([x, y]);
    const [ex, ey] = this.toScreen([Math.min(x + w, this.view!.width), Math.min(y + h, this.view!.height)]);
    const file = path.join(this.dir, `zoom-${this.next}.png`);
    const info = await this.call<Shot>('shot', { x: sx, y: sy, w: ex - sx, h: ey - sy, maxW: 1600, maxH: 1600, file });
    this.zooms.push({ type: 'image', mediaType: 'image/png', data: fs.readFileSync(file).toString('base64'), name: `zoom [${[x, y, w, h].join(', ')}]` });
    fs.rmSync(file, { force: true });
    return `zoomed into [${[x, y, w, h].join(', ')}]: ${info.Width}×${info.Height} screen pixels`;
  }

  close(): void {
    this.proc?.kill();
    this.proc = null;
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(d: DesktopSession, a: DesktopAction): Promise<string> {
  if ('click' in a) {
    const [x, y] = d.toScreen(a.click);
    await d.call('click', { x, y, button: a.button ?? 'left', count: a.double ? 2 : 1 });
    return `${a.double ? 'double-' : ''}${a.button && a.button !== 'left' ? `${a.button}-` : ''}clicked (${a.click.join(', ')})`;
  }
  if ('move' in a) {
    const [x, y] = d.toScreen(a.move);
    await d.call('move', { x, y });
    return `moved to (${a.move.join(', ')})`;
  }
  if ('drag' in a) {
    const [x1, y1] = d.toScreen(a.drag[0]);
    const [x2, y2] = d.toScreen(a.drag[1]);
    await d.call('drag', { x1, y1, x2, y2 });
    return `dragged (${a.drag[0].join(', ')}) to (${a.drag[1].join(', ')})`;
  }
  if ('scroll' in a) {
    const at = a.at ?? (d.view ? ([d.view.width / 2, d.view.height / 2] as Point) : null);
    if (!at) throw new Error('Look at the screen first: scrolling happens over a point of the screenshot.');
    const [x, y] = d.toScreen(at);
    await d.call('wheel', { x, y, clicks: -Math.round(a.scroll) });
    return `scrolled ${a.scroll > 0 ? 'down' : 'up'} ${Math.abs(Math.round(a.scroll))}`;
  }
  if ('type' in a) {
    await d.call('type', { text: a.type }, 60_000 + a.type.length * 20);
    return `typed ${a.type.length} character${a.type.length === 1 ? '' : 's'}`;
  }
  if ('key' in a) {
    for (const combo of a.key.trim().split(/\s+/)) await d.call('keys', { vks: chord(combo) });
    return `pressed ${a.key}`;
  }
  if ('wait' in a) {
    await sleep(Math.min(Math.max(a.wait, 0), 10_000));
    return `waited ${a.wait} ms`;
  }
  if ('focus' in a) return d.focus(a.focus);
  if ('zoom' in a) return d.zoom(a.zoom);
  throw new Error(`Unknown action ${JSON.stringify(a)}.`);
}

/**
 * Sees and uses this computer's desktop: a screenshot (of one window, or the whole screen), and clicks,
 * drags, scrolling, typing and key chords at points read off that screenshot. The user stops it at any
 * time by moving the mouse into the top-left corner of the screen.
 */
export const desktopTool: ToolDef<DesktopInput> = {
  kind: 'web',
  readOnly: false,
  title: (i) => (i.list ? 'Desktop: list windows' : `Desktop${i.window ? ` "${oneLine(i.window, 40)}"` : ''}${i.actions?.length ? ` (${i.actions.length} action${i.actions.length === 1 ? '' : 's'})` : ''}`),
  async execute(input, ctx) {
    if (process.platform !== 'win32') return { content: 'Computer control works on Windows for now.', isError: true };
    const d = ctx.desktop?.();
    if (!d) return { content: 'Computer control is off. The user can turn it on in Settings > Tools.', isError: true };
    if (input.list) {
      const all = await d.windows();
      const lines = all.map((w) => `${w.Focused ? '* ' : '  '}${oneLine(w.Title, 100)}${w.Minimized ? ' (minimized)' : ` (${w.W}×${w.H} at ${w.X},${w.Y})`}`);
      return { content: `${all.length} open window${all.length === 1 ? '' : 's'} (* has the focus):\n${lines.join('\n')}`, display: { kind: 'list', title: 'Windows', items: lines, total: lines.length } };
    }
    const done: string[] = [];
    let failure = '';
    try {
      if (input.window) done.push(await d.focus(input.window));
      for (const a of input.actions ?? []) {
        if (ctx.signal.aborted) break;
        done.push(await run(d, a));
        await sleep(120);
      }
    } catch (e) {
      const message = (e as Error).message;
      // The user's stop signal ends computer use for this task, not just this call.
      if (message.startsWith('STOP:')) {
        return {
          content: `The user stopped computer control by moving the mouse into the top-left corner of the screen.${done.length ? ` Done before that: ${done.join('; ')}.` : ''} Do not use the desktop again until the user asks; say what you were doing and where it stands.`,
          isError: true,
        };
      }
      failure = message;
    }
    // Let the screen settle before looking at it.
    await sleep(input.actions?.length ? 450 : 0);
    let shot: Awaited<ReturnType<DesktopSession['shot']>> | null = null;
    try {
      shot = await d.shot();
    } catch (e) {
      failure ||= (e as Error).message;
    }
    const cursor = shot ? [Math.round((shot.info.CursorX - shot.info.X) * shot.info.Scale), Math.round((shot.info.CursorY - shot.info.Y) * shot.info.Scale)] : null;
    const inside = shot && cursor && cursor[0] >= 0 && cursor[1] >= 0 && cursor[0] <= shot.info.Width && cursor[1] <= shot.info.Height;
    const lines = [
      shot
        ? `Screenshot of ${shot.scope}: ${shot.info.Width}×${shot.info.Height}${shot.info.Scale < 1 ? ` (the screen's ${shot.info.W}×${shot.info.H} scaled by ${shot.info.Scale.toFixed(3)})` : ''}. Points you give refer to this picture.${inside ? ` The mouse is at (${cursor!.join(', ')}), drawn as a ring.` : ''}`
        : '',
      done.length ? `Done: ${done.join('; ')}.` : '',
      failure ? `Stopped: ${failure}` : '',
    ].filter(Boolean);
    return {
      content: lines.join('\n'),
      isError: !!failure && !shot,
      images: shot && ctx.model.vision ? [shot.image, ...d.zooms.splice(0)] : (d.zooms.splice(0), undefined),
      display: { kind: 'shot', url: shot?.scope ?? 'desktop', width: shot?.info.Width ?? 0, height: shot?.info.Height ?? 0 },
    };
  },
};
