import { BrowserSession, findBrowser } from './browser';

export type Region = [number, number, number, number];

/** Width and height from an image's header: PNG, JPEG, GIF, WebP and BMP. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM') return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: walk the segments to the frame header (SOF0-SOF15 except DHT, JPG and DAC).
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
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
  private idle: NodeJS.Timeout | null = null;

  private async page(): Promise<BrowserSession> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), 120_000);
    this.idle.unref();
    if (this.session) return this.session;
    const exe = findBrowser();
    if (!exe) throw new Error('enlarging a part of an image needs Chrome, Edge or Chromium, and none was found');
    this.session = new BrowserSession(exe, false);
    await this.session.start();
    return this.session;
  }

  async crop(data: Buffer, mediaType: string, [x, y, w, h]: Region, maxSide: number): Promise<{ data: string; width: number; height: number; scale: number }> {
    const scale = Math.min(4, maxSide / Math.max(w, h));
    const page = await this.page();
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
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }
}

export const imageWorker = new ImageWorker();
