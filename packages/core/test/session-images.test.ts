import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PICTURE_BYTES,
  findVirtualImageRefs,
  fitPictures,
  formatReadImageCall,
  imageBudget,
  imageSlots,
  learnPictureBudget,
  parseVirtualImageId,
  pictureBudget,
  planSessionImages,
  virtualImagePath,
} from '../src/context/images';
import {
  MAX_INGRESS_IMAGE_BYTES,
  MAX_INGRESS_SIDE,
  imageSize,
  imageWorker,
  normalizeIngressImage,
} from '../src/tools/image';
import { readTool } from '../src/tools/fs-tools';
import { FileTracker } from '../src/tools/filestate';
import type { ImagePart, Message } from '../src/types';
import type { ToolContext } from '../src/tools/types';

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([tag, data])) >>> 0, 0);
  return Buffer.concat([len, tag, data, crcBuf]);
}

function makePng(width: number, height: number, hex = '#1e293b', noisy = false): Buffer {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0');
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const stride = 1 + width * 3;
  const raw = Buffer.allocUnsafe(height * stride);
  if (noisy) {
    let seed = 0x9e3779b9;
    for (let y = 0; y < height; y++) {
      const row = y * stride;
      raw[row] = 0;
      for (let x = 0; x < width; x++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const p = row + 1 + x * 3;
        raw[p] = seed & 0xff;
        raw[p + 1] = (seed >>> 8) & 0xff;
        raw[p + 2] = (seed >>> 16) & 0xff;
      }
    }
  } else {
    const oneRow = Buffer.allocUnsafe(stride);
    oneRow[0] = 0;
    for (let x = 0; x < width; x++) {
      const p = 1 + x * 3;
      oneRow[p] = r;
      oneRow[p + 1] = g;
      oneRow[p + 2] = b;
    }
    for (let y = 0; y < height; y++) oneRow.copy(raw, y * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const compressed = zlib.deflateSync(raw, { level: noisy ? 1 : 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-sess-img-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

type Reply = { text?: string; call?: { name: string; args: unknown }; delayMs?: number };
let plan: Reply[] = [];
const bodies: { messages: { role: string; content: unknown }[] }[] = [];

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    const isDigestCall = JSON.stringify(parsed.messages).includes('Record concise factual notes for each image below');
    const r: Reply = isDigestCall
      ? {
          text: [...JSON.stringify(parsed.messages).matchAll(/\[(img-\d+)/gi)]
            .map((m) => m[1].toLowerCase())
            .filter((v, idx, arr) => arr.indexOf(v) === idx)
            .map((id) => `[${id}]: preserved pre-eviction visual digest for ${id}`)
            .join('\n'),
        }
      : (plan.shift() ?? { text: 'Done.' });
    if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.call) {
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `c${Math.random().toString(36).slice(2, 8)}`,
                  type: 'function',
                  function: { name: r.call.name, arguments: JSON.stringify(r.call.args) },
                },
              ],
            },
          },
        ],
      });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 12 } });
    res.end('data: [DONE]\n\n');
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'fake/m1',
      tools: 'favilla',
      languageServers: false,
      providers: {
        fake: {
          name: 'Fake',
          api: 'openai-chat',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          auth: 'none',
          local: true,
          models: {
            m1: { contextWindow: 64000, family: 'gpt', vision: true },
            m32: { contextWindow: 32000, family: 'gpt', vision: true },
          },
        },
      },
    }),
  );
});

afterAll(async () => {
  fake.close();
  imageWorker.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('window-proportional unified image budget', () => {
  it('scales hardTokens, softTokens, and maxSlots proportionally across 32k, 64k, 128k, and 256k+ windows', () => {
    const b32 = imageBudget(32_000, 'fake', 'openai-chat');
    expect(b32).toMatchObject({ hardTokens: 3_200, softTokens: 1_920, maxSlots: 2 });

    const b64 = imageBudget(64_000, 'fake', 'openai-chat');
    expect(b64).toMatchObject({ hardTokens: 6_400, softTokens: 3_840, maxSlots: 4 });

    const b128 = imageBudget(128_000, 'fake', 'openai-chat');
    expect(b128).toMatchObject({ hardTokens: 12_800, softTokens: 7_680, maxSlots: 8 });

    const b256 = imageBudget(256_000, 'fake', 'openai-chat');
    expect(b256).toMatchObject({ hardTokens: 25_600, softTokens: 15_360, maxSlots: 16 });

    const b400 = imageBudget(400_000, 'anth', 'anthropic');
    expect(b400).toMatchObject({ hardTokens: 28_000, softTokens: 16_800, maxSlots: 16 });

    // Provider-specific image caps and HTTP 413 learnPictureBudget share the exact same budget object.
    expect(imageSlots(256_000, 'openai-chat')).toBe(16);
    expect(imageBudget(256_000, 'probe-gem', 'gemini').maxBytes).toBe(pictureBudget('probe-gem'));

    const prov = 'probe-413-relay';
    expect(imageBudget(256_000, prov, 'openai-chat').maxBytes).toBe(PICTURE_BYTES);
    learnPictureBudget(prov, 3_000_000);
    expect(imageBudget(256_000, prov, 'openai-chat').maxBytes).toBe(1_500_000);
  });

  it('prioritizes pinned > recently mentioned/reopened > newer images and evicts down to softTokens', () => {
    const mkPic = (id: string, w = 800, h = 600): ImagePart => ({
      type: 'image',
      id,
      mediaType: 'image/png',
      data: 'iVBORw0KGgo=',
      width: w,
      height: h,
    });
    const history: Message[] = [
      { id: 'u1', role: 'user', origin: 'user', time: 1, parts: [{ type: 'text', text: 'Ref 1' }, mkPic('img-01')] },
      { id: 'a1', role: 'assistant', time: 2, parts: [{ type: 'text', text: 'Noted.' }] },
      { id: 'u2', role: 'user', origin: 'user', time: 3, parts: [{ type: 'text', text: 'Ref 2' }, mkPic('img-02')] },
      { id: 'a2', role: 'assistant', time: 4, parts: [{ type: 'text', text: 'Noted.' }] },
      { id: 'u3', role: 'user', origin: 'user', time: 5, parts: [{ type: 'text', text: 'Ref 3' }, mkPic('img-03')] },
      { id: 'a3', role: 'assistant', time: 6, parts: [{ type: 'text', text: 'Noted.' }] },
      { id: 'u4', role: 'user', origin: 'user', time: 7, parts: [{ type: 'text', text: 'Ref 4' }, mkPic('img-04')] },
      // Mention img-01 in the recent assistant/user window so it outranks unmentioned img-02..img-04.
      { id: 'a4', role: 'assistant', time: 8, parts: [{ type: 'text', text: 'Comparing against img-01 header spacing.' }] },
      { id: 'u5', role: 'user', origin: 'user', time: 9, parts: [{ type: 'text', text: 'Here is current state; check img-01 too.' }, mkPic('img-05')] },
    ];
    // 64k budget has maxSlots=4 (floorSlots=2). With 5 images, batch hysteresis evicts down to 2 slots,
    // keeping pinned img-05 + recently mentioned img-01 and evicting unmentioned img-02, img-03, img-04 in order!
    const planned = planSessionImages(history, 0, imageBudget(64_000, 'fake', 'openai-chat'), {
      readCallHint: (v) => formatReadImageCall(['read'], v),
    });
    expect(planned.userDrops.map((u) => u.image.id)).toEqual(['img-02', 'img-03', 'img-04']);
    expect(planned.userDrops[0].caption).toContain('virtual snapshot (read tool only, not on disk)');
    expect(planned.userDrops[0].caption).toContain('read(paths=[".favilla/images/img-02.png"])');

    const fitted = fitPictures(history, 1, { readCallHint: (v) => formatReadImageCall(['read'], v) });
    expect(JSON.stringify(fitted[0].parts)).toContain('virtual snapshot (read tool only, not on disk)');
  });
});

describe('ingress screenshot normalization', () => {
  it('keeps 1080p clean PNGs untouched and normalizes >3.6MB 4K and 5K screenshots under ceiling', async () => {
    const clean1080 = makePng(1920, 1080, '#0f172a', false);
    expect(clean1080.byteLength).toBeLessThan(MAX_INGRESS_IMAGE_BYTES);
    const r1080 = await normalizeIngressImage(clean1080, 'image/png');
    expect(r1080.resized).toBe(false);
    expect(r1080.width).toBe(1920);
    expect(r1080.height).toBe(1080);

    // Noisy 4K PNG exceeds 3.6 MB raw bytes even though 3840 <= 4096.
    const noisy4k = makePng(3840, 2160, '#000', true);
    expect(noisy4k.byteLength).toBeGreaterThan(MAX_INGRESS_IMAGE_BYTES);
    const r4k = await normalizeIngressImage(noisy4k, 'image/png');
    expect(r4k.resized).toBe(true);
    expect(r4k.buf.byteLength).toBeLessThanOrEqual(MAX_INGRESS_IMAGE_BYTES);
    expect(Math.max(r4k.width ?? 0, r4k.height ?? 0)).toBeLessThanOrEqual(MAX_INGRESS_SIDE);
    expect(imageSize(r4k.buf)).toEqual({ width: r4k.width, height: r4k.height });

    // 5K screenshot (5120x2880) exceeds MAX_INGRESS_SIDE (4096) and shrinks proportionally.
    const shot5k = makePng(5120, 2880, '#1d4ed8', false);
    const r5k = await normalizeIngressImage(shot5k, 'image/png');
    expect(r5k.resized).toBe(true);
    expect(r5k.buf.byteLength).toBeLessThanOrEqual(MAX_INGRESS_IMAGE_BYTES);
    expect(r5k.width).toBeLessThanOrEqual(MAX_INGRESS_SIDE);
    expect(r5k.height).toBeLessThanOrEqual(MAX_INGRESS_SIDE);
  });

  it('auto-fits an oversized (>5MB) workspace image in readTool instead of failing', async () => {
    const bigPng = makePng(2600, 1600, '#000', true);
    expect(bigPng.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    const bigPath = path.join(project, 'oversized-4k.png');
    fs.writeFileSync(bigPath, bigPng);
    const ctx = {
      cwd: project,
      callId: 'c_big',
      files: new FileTracker(),
      outputChars: 50_000,
      model: { vision: true },
      signal: new AbortController().signal,
      config: {},
    } as unknown as ToolContext;
    const out = await readTool.execute({ path: 'oversized-4k.png' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.images).toHaveLength(1);
    const rawOut = Buffer.from(out.images![0].data, 'base64');
    expect(rawOut.byteLength).toBeLessThanOrEqual(MAX_INGRESS_IMAGE_BYTES);
  });
});

describe('strict virtual .favilla/images/<id> routing & non-read tool guidance', () => {
  it('parses only registered-shaped .favilla/images/img-NN.* paths and formats surface-accurate read calls', () => {
    expect(parseVirtualImageId('.favilla/images/img-01.png', project)).toBe('img-01');
    expect(parseVirtualImageId('./.favilla\\images\\img-12.jpg', project)).toBe('img-12');
    expect(parseVirtualImageId('.favilla/config.json', project)).toBeNull();
    expect(parseVirtualImageId('.favilla/images/custom.png', project)).toBeNull();
    expect(parseVirtualImageId('src/.favilla/images/img-01.png', project)).toBeNull();
    expect(parseVirtualImageId('../.favilla/images/img-01.png', project)).toBeNull();
    expect(virtualImagePath('img-03', 'image/jpeg')).toBe('.favilla/images/img-03.jpg');

    expect(formatReadImageCall(['read'], '.favilla/images/img-01.png')).toBe('read(paths=[".favilla/images/img-01.png"])');
    expect(formatReadImageCall(['Read'], '.favilla/images/img-01.png')).toBe('Read(file_path=".favilla/images/img-01.png")');
    expect(formatReadImageCall(['view_image'], '.favilla/images/img-01.png')).toBe('view_image(path=".favilla/images/img-01.png")');

    expect(findVirtualImageRefs({ command: 'python -c "open(\'.favilla/images/img-02.png\')"' }, project, (id) => id === 'img-02')).toEqual([
      { id: 'img-02', virtualPath: '.favilla/images/img-02.png' },
    ]);
    expect(findVirtualImageRefs({ command: 'cat .favilla/images/img-99.png' }, project, (id) => id === 'img-02')).toEqual([]);
  });

  it('preserves real disk reads for .favilla/config.json and unregistered .favilla/images/* while guiding non-read tools on registered virtual images', async () => {
    const work = fs.mkdtempSync(path.join(home, 'virt-proj-'));
    fs.mkdirSync(path.join(work, '.favilla', 'images'), { recursive: true });
    fs.writeFileSync(path.join(work, '.favilla', 'config.json'), '{"hello":"real-disk"}\n');
    const customPng = makePng(40, 30, '#10b981');
    fs.writeFileSync(path.join(work, '.favilla', 'images', 'custom.png'), customPng);
    fs.writeFileSync(path.join(work, '.favilla', 'images', 'custom2.png'), customPng);
    const refPng = makePng(120, 90, '#ef4444');

    const prevConfine = process.env.FAVILLA_CONFINE;
    process.env.FAVILLA_CONFINE = '1';
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(work, { interactive: true });
    try {
      const s = await rt.start({ cwd: work, interactive: true });
      plan = [
        { text: 'Saw user image.' },
        { text: '<summary>Compacted summary referencing [img-01] red badge layout.</summary>' },
        // 1) Read real .favilla/config.json -> must read real disk!
        { call: { name: 'read', args: { paths: ['.favilla/config.json'] } } },
        // 2) Read unregistered .favilla/images/custom.png -> must read real disk!
        { call: { name: 'read', args: { paths: ['.favilla/images/custom.png'] } } },
        // 3) Shell tries to inspect virtual .favilla/images/img-01.png -> must get 1-line read guidance, not ENOENT!
        { call: { name: 'shell', args: { command: 'cat .favilla/images/img-01.png' } } },
        // 4) Read virtual .favilla/images/img-01.png with region crop under FAVILLA_CONFINE=1 -> succeeds from BlobStore!
        { call: { name: 'read', args: { paths: ['.favilla/images/img-01.png'], region: [10, 10, 50, 40] } } },
        // 5) Multi-image tool result labels all virtual paths in one shared read-only note.
        { call: { name: 'read', args: { paths: ['.favilla/images/custom.png', '.favilla/images/custom2.png'] } } },
        { text: 'All verified.' },
      ];

      await s.send('Check this badge.', [{ type: 'image', mediaType: 'image/png', data: refPng.toString('base64'), name: 'badge.png' }]);
      const userMsgText = JSON.stringify(s.messages.find((m) => m.role === 'user' && m.origin === 'user')?.parts ?? []);
      expect(userMsgText).toContain('virtual path — read tool only, not on disk or in shell');
      expect(userMsgText).toContain('region=[x,y,w,h] optional');

      await s.compact('manual');
      await s.send('Check config, custom.png, shell on img-01, then read region of img-01.');

      const results = s.messages
        .flatMap((m) => m.parts)
        .filter((p): p is Extract<Message['parts'][number], { type: 'tool_result' }> => p.type === 'tool_result');

      expect(results[0].content).toContain('"hello":"real-disk"');
      expect(results[1].content).toContain('Image .favilla/images/custom.png (40×30');
      expect(results[1].content).toContain('Session image img-02 — virtual path (read tool only, not a file on disk or in shell)');
      expect(results[1].content).toContain('region=[x,y,w,h] optional');
      expect(results[1].images?.[0].width).toBe(40);

      // Non-read tool touching registered virtual path returns clear 1-line guidance.
      expect(results[2].isError).toBe(true);
      expect(results[2].content.trim().split('\n')).toHaveLength(1);
      expect(results[2].content).toContain('virtual session image snapshot, not a file on disk');
      expect(results[2].content).toContain('read(paths=[".favilla/images/img-01.png"]'
      );

      // Virtual read with region crop succeeds even under FAVILLA_CONFINE=1 (50x40 enlarged 4x -> 200x160)!
      expect(results[3].isError).toBeFalsy();
      expect(results[3].content).toContain('Region [10, 10, 50, 40] of session image [img-01]');
      expect(results[3].images?.[0].width).toBe(200);
      expect(results[3].images?.[0].height).toBe(160);

      expect(results[4].isError).toBeFalsy();
      expect(results[4].content).toContain('Session images — virtual paths (read tool only, not files on disk or in shell; pass region=[x,y,w,h] to zoom):');
    } finally {
      if (prevConfine === undefined) delete process.env.FAVILLA_CONFINE;
      else process.env.FAVILLA_CONFINE = prevConfine;
      rt.dispose();
    }
  });
});

describe('overwritten workspace file versioning, mid-turn queued images, pre-eviction digest, and reload persistence', () => {
  it('preserves v1 vs v2 of an overwritten workspace image and warns when disk has changed', async () => {
    const work = fs.mkdtempSync(path.join(home, 'v1v2-proj-'));
    const uiPath = path.join(work, 'ui.png');
    fs.writeFileSync(uiPath, makePng(100, 80, '#dc2626'));

    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(work, { interactive: true });
    try {
      const s = await rt.start({ cwd: work, interactive: true });
      plan = [
        { call: { name: 'read', args: { paths: ['ui.png'] } } },
        { text: 'Read v1.' },
      ];
      await s.send('Read v1 of ui.png.');

      // Overwrite ui.png on disk with v2 (different dimensions & bytes).
      fs.writeFileSync(uiPath, makePng(200, 160, '#2563eb'));
      plan = [
        { call: { name: 'read', args: { paths: ['ui.png'] } } },
        { text: 'Read v2.' },
        { text: '<summary>Visual versions: [img-01] was v1 (100x80) and [img-02] was v2 (200x160).</summary>' },
        { call: { name: 'read', args: { paths: ['.favilla/images/img-01.png'] } } },
        { text: 'Reopened v1.' },
      ];
      await s.send('Read v2 of ui.png.');
      await s.compact('manual');
      await s.send('Reopen img-01 to inspect v1.');

      const lastRead = s.messages
        .flatMap((m) => m.parts)
        .filter((p): p is Extract<Message['parts'][number], { type: 'tool_result' }> => p.type === 'tool_result')
        .at(-1)!;
      expect(lastRead.images?.[0].width).toBe(100);
      expect(lastRead.images?.[0].height).toBe(80);
      expect(lastRead.content).toContain('"ui.png" on disk changed after this snapshot');
    } finally {
      rt.dispose();
    }
  });

  it('registers mid-turn queued user images, extracts digests before budget eviction, and preserves stripped state across Session.open', async () => {
    const work = fs.mkdtempSync(path.join(home, 'queue-reload-'));
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(work, `step-${i}.png`), makePng(640, 480, `#00${i}080`));
    }
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(work, { interactive: true });
    let sessionId = '';
    try {
      // Use m32 (32k window -> maxSlots = 2) so reading 4 distinct images triggers budget eviction + pre-eviction digest!
      const s = await rt.start({ cwd: work, model: 'fake/m32', interactive: true });
      sessionId = s.meta.id;

      plan = [
        // Slow tool call so a mid-turn s.send(...) queues while busy!
        { call: { name: 'read', args: { paths: ['step-1.png'] } }, delayMs: 80 },
        { call: { name: 'read', args: { paths: ['step-2.png'] } } },
        { call: { name: 'read', args: { paths: ['step-3.png'] } } },
        { call: { name: 'read', args: { paths: ['step-4.png'] } } },
        { text: 'Finished inspecting all steps.' },
      ];

      const p1 = s.send('Start inspecting.');
      await new Promise((r) => setTimeout(r, 20));
      const queuedPng = makePng(96, 96, '#f59e0b');
      const p2 = s.send('Also match this queued icon.', [
        { type: 'image', mediaType: 'image/png', data: queuedPng.toString('base64'), name: 'queued-icon.png' },
      ]);
      await Promise.all([p1, p2]);

      // Compact and verify <session_images> manifest sent to compaction includes both the queued image and extracted digest!
      const beforeCompact = bodies.length;
      plan = [{ text: '<summary>Summary preserving [img-01] through [img-05] across compaction.</summary>' }];
      await s.compact('manual');
      const compactReq = JSON.stringify(bodies[beforeCompact].messages);
      expect(compactReq).toContain('<session_images>');
      expect(compactReq).toContain('queued-icon.png');
      expect(compactReq).toContain('captured notes: preserved pre-eviction visual digest for img-01');
    } finally {
      rt.dispose();
    }

    // Reopen session from disk in a fresh runtime: stripped images must stay stripped in outbound requests,
    // while virtual reopen via read(.favilla/images/img-02.png) still restores exact bytes from BlobStore!
    const rt2 = createRuntime(work, { interactive: true });
    try {
      const s2 = await rt2.get(sessionId, { interactive: true });
      const before = bodies.length;
      plan = [
        { call: { name: 'read', args: { paths: ['.favilla/images/img-02.png'] } } },
        { text: 'Reopened queued icon after session reload.' },
      ];
      await s2.send('Reopen img-02 after session reload.');
      const reqs = bodies.slice(before).map((b) => JSON.stringify(b.messages));
      expect((reqs[0].match(/data:image\/png;base64/g) ?? []).length).toBe(0);
      expect((reqs[1].match(/data:image\/png;base64/g) ?? []).length).toBe(1);
    } finally {
      rt2.dispose();
    }
  });
});
