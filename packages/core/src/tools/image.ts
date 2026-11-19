import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ImagePart } from '../types';
import { BrowserSession, findBrowser } from './browser';
import { imageHeaderSize } from '../util/tokens';

export type Region = [number, number, number, number];

/** Single-image raw ceiling (3.6 MB = 4.8 MB base64, under Anthropic's 5 MB base64 cap). */
export const MAX_INGRESS_IMAGE_BYTES = 3_600_000;
/** Maximum pixel length of the longer side after ingress normalization. */
export const MAX_INGRESS_SIDE = 4096;
/** Hard input ceiling before attempting decode/resize on disk images. */
export const MAX_RAW_INPUT_BYTES = 40 * 1024 * 1024;

const DIRECT_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Width and height from an image's header: PNG, JPEG, GIF, WebP and BMP. */
export const imageSize = imageHeaderSize;

/** Sniff an image's MIME type from its leading magic bytes, so misnamed files never 400 at providers. */
export function sniffImageMediaType(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return 'image/gif';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return undefined;
}

/** A region inside the image, or why it is not one. */
export function checkRegion(r: unknown, size: { width: number; height: number }): Region | string {
  if (!Array.isArray(r) || r.length !== 4 || r.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return 'region is [x, y, width, height] in the image\'s pixels';
  const [x, y, w, h] = r.map((v) => Math.round(v)) as Region;
  if (w < 4 || h < 4) return 'the region is too small (at least 4×4 pixels)';
  if (x < 0 || y < 0 || x >= size.width || y >= size.height) return `the region starts outside the image (${size.width}×${size.height})`;
  return [x, y, Math.min(w, size.width - x), Math.min(h, size.height - y)];
}

/**
 * Crops and scales pictures in a headless Chrome page of its own (canvas drawing with high-quality smoothing),
 * started on first use and closed after two idle minutes. Separate from the agent's browser, so zooming never
 * touches the page the agent works on or a browser window the user watches.
 */
class ImageWorker {
  private session: BrowserSession | null = null;
  private browserPath?: string;
  private idle: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async page(browserPath?: string): Promise<BrowserSession> {
    if (this.browserPath !== browserPath) this.close();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), 120_000);
    this.idle.unref();
    if (this.session) return this.session;
    const exe = findBrowser(browserPath);
    if (!exe) throw new Error('resizing or enlarging an image needs Chrome, Edge or Chromium, and none was found');
    this.session = new BrowserSession(exe, false);
    this.browserPath = browserPath;
    await this.session.start();
    return this.session;
  }

  async crop(data: Buffer, mediaType: string, [x, y, w, h]: Region, maxSide: number, browserPath?: string): Promise<{ data: string; width: number; height: number; scale: number }> {
    return this.serial(async () => {
      const scale = Math.min(4, maxSide / Math.max(w, h));
      const page = await this.page(browserPath);
      const out = await page.evaluate<{ data: string; width: number; height: number }>(`(async () => {
        const img = new Image();
        img.src = 'data:${mediaType};base64,${data.toString('base64')}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(${w} * ${scale}));
        c.height = Math.max(1, Math.round(${h} * ${scale}));
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, ${x}, ${y}, ${w}, ${h}, 0, 0, c.width, c.height);
        return { data: c.toDataURL('image/png').slice(22), width: c.width, height: c.height };
      })()`);
      return { ...out, scale };
    });
  }

  /** Scale and re-encode an oversized or unsupported image once on ingress so every later replay is byte-identical. */
  async fit(
    data: Buffer,
    mediaType: string,
    opts: { maxSide?: number; maxBytes?: number; browserPath?: string } = {},
  ): Promise<{ buf: Buffer; mediaType: string; width: number; height: number }> {
    const maxSide = opts.maxSide ?? MAX_INGRESS_SIDE;
    const maxBytes = opts.maxBytes ?? MAX_INGRESS_IMAGE_BYTES;
    const preferLossless = mediaType === 'image/png' || mediaType === 'image/gif' || mediaType === 'image/bmp';
    return this.serial(async () => {
      const page = await this.page(opts.browserPath);
      let outBuf: Buffer | null = null;
      // Stream raw bytes over loopback HTTP rather than 30-55 MB base64 strings inside CDP Runtime.evaluate.
      const srv = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            outBuf = Buffer.concat(chunks);
            res.writeHead(200);
            res.end('ok');
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': mediaType, 'Content-Length': data.byteLength });
        res.end(data);
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const port = (srv.address() as AddressInfo).port;
      try {
        const meta = await page.evaluate<{ mediaType: string; width: number; height: number }>(`(async () => {
          const srcBlob = await (await fetch('http://127.0.0.1:${port}/in')).blob();
          const bmp = await createImageBitmap(srcBlob);
          try {
            const nw = bmp.width || 1;
            const nh = bmp.height || 1;
            const s = Math.min(1, ${maxSide} / Math.max(nw, nh));
            let w = Math.max(1, Math.round(nw * s));
            let h = Math.max(1, Math.round(nh * s));
            const encode = async (cw, ch, type, quality, bg) => {
              const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch) : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
              const g = c.getContext('2d');
              if (bg) {
                g.fillStyle = '#ffffff';
                g.fillRect(0, 0, cw, ch);
              }
              g.imageSmoothingEnabled = true;
              g.imageSmoothingQuality = 'high';
              g.drawImage(bmp, 0, 0, cw, ch);
              if (c.convertToBlob) return await c.convertToBlob(quality !== undefined ? { type, quality } : { type });
              return await new Promise((r) => c.toBlob(r, type, quality));
            };
            let outBlob = null;
            let outType = 'image/jpeg';
            if (${preferLossless ? 'true' : 'false'} && w * h <= 2600000) {
              const png = await encode(w, h, 'image/png', undefined, false);
              if (png && png.size <= ${maxBytes}) {
                outBlob = png;
                outType = 'image/png';
              }
            }
            if (!outBlob) {
              let jpg = await encode(w, h, 'image/jpeg', 0.88, true);
              if (!jpg || jpg.size > ${maxBytes}) jpg = await encode(w, h, 'image/jpeg', 0.76, true);
              while (!jpg || jpg.size > ${maxBytes}) {
                if (w === 1 && h === 1) throw new Error('Image cannot fit the byte limit');
                w = Math.max(1, Math.floor(w * 0.7));
                h = Math.max(1, Math.floor(h * 0.7));
                jpg = await encode(w, h, 'image/jpeg', 0.80, true);
              }
              outBlob = jpg;
              outType = 'image/jpeg';
            }
            await fetch('http://127.0.0.1:${port}/out', { method: 'POST', body: new Blob([outBlob], { type: 'text/plain' }) });
            return { mediaType: outType, width: w, height: h };
          } finally {
            bmp.close();
          }
        })()`);
        if (!outBuf) throw new Error('image worker returned empty output');
        return { buf: outBuf, mediaType: meta.mediaType, width: meta.width, height: meta.height };
      } finally {
        srv.close();
      }
    });
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.session?.close();
    this.session = null;
  }
}

export const imageWorker = new ImageWorker();

/**
 * Normalize an incoming image buffer once at session/tool ingress:
 * - Fast path (< 0.2 ms, zero copy): compliant PNG/JPEG/GIF/WebP <= 3.6 MB raw and <= 4096 px.
 * - Worker path: oversized screenshots (4K/5K/retina PNGs > 3.6 MB or > 4096 px) or BMP files are scaled/re-encoded once.
 */
export async function normalizeIngressImage(
  buf: Buffer,
  declaredMediaType: string,
  opts: { maxSide?: number; maxBytes?: number; browserPath?: string } = {},
): Promise<{ buf: Buffer; mediaType: string; width?: number; height?: number; resized: boolean }> {
  const maxSide = opts.maxSide ?? MAX_INGRESS_SIDE;
  const maxBytes = opts.maxBytes ?? MAX_INGRESS_IMAGE_BYTES;
  const mediaType = sniffImageMediaType(buf) ?? declaredMediaType;
  const sz = imageHeaderSize(buf);
  if (DIRECT_MEDIA_TYPES.has(mediaType) && buf.length <= maxBytes && (!sz || Math.max(sz.width, sz.height) <= maxSide)) {
    return { buf, mediaType, width: sz?.width, height: sz?.height, resized: false };
  }
  // Synthetic non-image test buffers (e.g. Buffer.alloc in HTTP 413 unit tests) have no magic header; only real images go to canvas.
  if (!sz && !sniffImageMediaType(buf) && DIRECT_MEDIA_TYPES.has(mediaType)) {
    return { buf, mediaType, resized: false };
  }
  const fitted = await imageWorker.fit(buf, mediaType, opts);
  return { ...fitted, resized: true };
}

/** Normalize an ImagePart's bytes, MIME type and pixel dimensions in place before storing in the session. */
export async function normalizeImagePart(img: ImagePart, opts: { maxSide?: number; maxBytes?: number; browserPath?: string } = {}): Promise<ImagePart> {
  if (!img.data) return img;
  const raw = Buffer.from(img.data, 'base64');
  const norm = await normalizeIngressImage(raw, img.mediaType, opts);
  if (!norm.resized && norm.mediaType === img.mediaType) {
    return {
      ...img,
      ...(norm.width && norm.height ? { width: norm.width, height: norm.height } : {}),
    };
  }
  return {
    ...img,
    mediaType: norm.mediaType,
    data: norm.buf.toString('base64'),
    width: norm.width,
    height: norm.height,
    blob: undefined,
  };
}
