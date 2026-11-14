import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { listenForBrowser } from '../net/browser-port';
import type { ImagePart } from '../types';
import { assetsDir, displayPath, resolvePath } from '../util/paths';
import { parseCuts } from './watch';
import type { ToolContext, ToolDef, ToolOutput } from './types';

/**
 * A film rendered from a page: the model writes the animation as one timeline, `seek(t)` drawing the frame for time t
 * (canvas, SVG, the DOM; painted pictures as layers), and this renders every frame in the browser at the delivery size
 * and rate and encodes it with its sound. Without it a requested film was painted stills under camera moves, cut every 2.5
 * s: a slideshow a user called PPT (2026-11-02). In a page, lines draw themselves, shapes turn into the next ones,
 * drawings change on twos, type moves with the beat and the camera travels from one scene into the next.
 */

export interface FilmInput {
  /** The animation page in the project (.html). */
  page: string;
  /** The video to write; beside the page by default. */
  out?: string;
  seconds?: number;
  fps?: number;
  size?: [number, number];
  /** The sound to put under it (the music tool's WAV). */
  sound?: string;
  /** Only part of the timeline, in seconds. */
  from?: number;
  to?: number;
  /** Twelve frames across the part as a sheet, instead of a video: for looking while working. */
  preview?: boolean;
  /** Sub-frames averaged into each frame for motion blur (half the frame's time, as a 180° shutter); 1 is none. */
  blur?: number;
}

const err = (content: string): ToolOutput => ({ content, isError: true });
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };

/** The project's files over HTTP for the page, and Favilla's paint engine at /__favilla/paint.js. */
async function serveProject(root: string): Promise<{ base: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = url === '/__favilla/paint.js' ? path.join(assetsDir(), 'paint', 'engine.js') : path.join(root, url);
    if (!file.startsWith(root) && url !== '/__favilla/paint.js') return void res.writeHead(403).end();
    fs.stat(file, (e, st) => {
      if (e || !st.isFile()) return void res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
  });
  const port = await listenForBrowser(server);
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

export const filmTool: ToolDef<FilmInput> = {
  kind: 'draw',
  readOnly: false,
  title: (i, cwd) => `Film ${displayPath(cwd, resolvePath(cwd, i.page))}`,
  async execute(input, ctx: ToolContext): Promise<ToolOutput> {
    const page = resolvePath(ctx.cwd, input.page);
    const shown = displayPath(ctx.cwd, page);
    if (!/\.html?$/i.test(page) || !fs.existsSync(page)) return err(`${shown}: give the animation page, an .html file of the project that defines seek(t).`);
    const browser = ctx.browser?.();
    if (!browser) return err('Rendering a film needs Chrome, Chromium or Edge, and none was found (Settings > Tools sets its path).');
    // Size and rate: as asked, else the cut list beside the page, else 1920x1080 at 24.
    const cutsFile = ['cuts.yaml', 'cuts.yml', 'cuts.json'].map((f) => path.join(path.dirname(page), f)).find((f) => fs.existsSync(f));
    let cuts: ReturnType<typeof parseCuts> | undefined;
    try {
      cuts = cutsFile ? parseCuts(fs.readFileSync(cutsFile, 'utf8')) : undefined;
    } catch {
      cuts = undefined;
    }
    const [w, h] = input.size ?? cuts?.size ?? [1920, 1080];
    const fps = input.fps ?? cuts?.fps ?? 24;
    if (!(w >= 64 && h >= 64 && w <= 3840 && h <= 2160 && fps >= 6 && fps <= 60)) return err('size is 64-3840 by 64-2160 and fps 6-60.');
    const root = path.resolve(ctx.cwd);
    if (!page.startsWith(root)) return err(`${shown} is outside the project.`);
    const server = await serveProject(root);
    const url = `${server.base}/${path.relative(root, page).split(path.sep).map(encodeURIComponent).join('/')}`;
    const blur = Math.max(1, Math.min(8, Math.round(input.blur ?? 1)));
    try {
      return await browser.withPage(url, { width: w, height: h }, async ({ evaluate, capture }) => {
        const info = (await evaluate(
          `(async () => { if (window.ready && typeof window.ready.then === 'function') await Promise.race([window.ready, new Promise((r) => setTimeout(r, 60000))]); await document.fonts.ready; return { seek: typeof window.seek, duration: typeof window.duration === 'number' ? window.duration : null }; })()`,
          90_000,
        )) as { seek: string; duration: number | null };
        if (info.seek !== 'function') return err(`${shown} defines no seek(t): the page must set window.seek = (t) => { ...draw the frame for time t... } (it may return a promise), and window.duration in seconds.`);
        const seconds = input.seconds ?? info.duration ?? (cuts?.shots.length ? undefined : undefined);
        if (!seconds || !(seconds > 0)) return err('How long is it? Give seconds, or set window.duration in the page.');
        const from = Math.max(0, input.from ?? 0);
        const to = Math.min(seconds, input.to ?? seconds);
        const frameAt = async (t: number, format: 'jpeg' | 'png' = 'jpeg') => {
          await evaluate(`Promise.resolve(window.seek(${t.toFixed(6)}))`);
          return capture(format, 92);
        };
        if (input.preview) {
          // Twelve frames across the part, on one sheet: the look and the motion's path at a glance.
          const shots: Buffer[] = [];
          for (let i = 0; i < 12; i++) shots.push(await frameAt(from + ((to - from) * i) / 12, 'jpeg'));
          const cells = shots.map((b, i) => `<figure><img src="data:image/jpeg;base64,${b.toString('base64')}"><figcaption>${(from + ((to - from) * i) / 12).toFixed(2)} s</figcaption></figure>`).join('');
          const sheetW = 1600;
          const cellW = Math.floor((sheetW - 50) / 4);
          const cellH = Math.round((cellW * h) / w) + 22;
          const sheet = await browser.paint(`<!doctype html><html><body style="margin:0;background:#fff;font:12px sans-serif"><style>div{display:grid;grid-template-columns:repeat(4,${cellW}px);gap:10px;padding:10px}figure{margin:0}img{width:${cellW}px;height:auto;display:block}figcaption{color:#555;padding-top:3px}</style><div>${cells}</div></body></html>`, { width: sheetW, height: cellH * 3 + 50 });
          const images: ImagePart[] = [{ type: 'image', mediaType: 'image/png', data: sheet.png.toString('base64'), name: `${path.basename(page)} preview` }];
          return { content: `Twelve frames of ${shown} from ${from.toFixed(2)} to ${to.toFixed(2)} s, ${w}x${h}, on one sheet${ctx.model.vision ? ' (attached)' : ''}. A sheet shows the look and where things are, not how they move: render the part as a video and watch it for that.`, images: ctx.model.vision ? images : undefined };
        }
        const out = resolvePath(ctx.cwd, input.out ?? page.replace(/\.html?$/i, '.mp4'));
        const sound = input.sound ? resolvePath(ctx.cwd, input.sound) : undefined;
        if (sound && !fs.existsSync(sound)) return err(`${displayPath(ctx.cwd, sound)} was not found.`);
        ctx.checkpoints.capture(ctx.turn, out);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const filters = blur > 1 ? ['-vf', `tmix=frames=${blur},select='eq(mod(n\\,${blur})\\,${blur - 1})',setpts=N/(${fps}*TB)`] : [];
        const args = [
          '-v', 'error', '-y',
          '-f', 'image2pipe', '-framerate', String(fps * blur), '-c:v', 'mjpeg', '-i', '-',
          ...(sound ? ['-ss', from.toFixed(3), '-i', sound] : []),
          ...filters,
          '-map', '0:v:0', ...(sound ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest'] : []),
          '-r', String(fps), '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '17', '-tune', 'animation', '-pix_fmt', 'yuv420p',
          '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', out,
        ];
        const enc = spawn('ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        let encErr = '';
        enc.stderr.on('data', (c: Buffer) => (encErr = (encErr + c.toString()).slice(-4000)));
        const finished = new Promise<number>((r) => enc.on('close', (c) => r(c ?? 1)));
        enc.on('error', () => {});
        const frames = Math.round((to - from) * fps);
        const started = Date.now();
        for (let n = 0; n < frames; n++) {
          for (let k = 0; k < blur; k++) {
            // Sub-frames spread over half the frame's time, like a 180° shutter.
            const t = from + (n + (blur > 1 ? (k / blur) * 0.5 : 0)) / fps;
            const jpg = await frameAt(t);
            if (!enc.stdin.write(jpg)) await new Promise((r) => enc.stdin.once('drain', r));
          }
          if (n % Math.max(1, Math.round(frames / 10)) === 0) ctx.progress?.(`frame ${n} of ${frames}\n`);
        }
        enc.stdin.end();
        const code = await finished;
        if (code !== 0) return err(`ffmpeg could not encode the film: ${encErr.trim().split('\n').slice(-3).join(' ')}`);
        ctx.files.recordWrite(out);
        return { content: `Rendered ${displayPath(ctx.cwd, out)}: ${frames} frames, ${w}x${h} at ${fps} fps${blur > 1 ? ` with ${blur} sub-frames of motion blur each` : ''}${sound ? `, with ${displayPath(ctx.cwd, sound)} under it` : ''}, in ${Math.round((Date.now() - started) / 1000)} s. Now watch it with the cut list: the watch tool reads every frame for freezes, still shots, pops, steps and the hits.` };
      });
    } catch (e) {
      return err(`Rendering ${shown} failed: ${(e as Error).message.slice(0, 600)}`);
    } finally {
      server.close();
    }
  },
};
