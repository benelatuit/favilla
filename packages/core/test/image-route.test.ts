import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A picture an answer shows by its path (![icon](design/icon.png)) is read through the server.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-image-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(path.join(project, 'design'), { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'fake/m1', providers: { fake: { api: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', auth: 'none', local: true, models: { m1: { contextWindow: 32000 } } } } }));
// The smallest PNG: one pixel.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(project, 'design', 'icon.png'), png);
fs.writeFileSync(path.join(project, 'notes.txt'), 'not a picture');
// Files an answer names: one deep in the project, two of one name, and one that is not text.
fs.mkdirSync(path.join(project, 'src', 'store'), { recursive: true });
fs.mkdirSync(path.join(project, 'lib', 'deep'), { recursive: true });
fs.writeFileSync(path.join(project, 'src', 'store', 'sessions.ts'), Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'));
fs.writeFileSync(path.join(project, 'lib', 'index.ts'), 'export {};\n');
fs.writeFileSync(path.join(project, 'lib', 'deep', 'index.ts'), 'export {};\n');
fs.writeFileSync(path.join(project, 'data.bin'), Buffer.from([1, 2, 0, 3]));

const { createRuntime } = await import('../src/runtime');
const { startServer } = await import('../src/server/server');
let rt: ReturnType<typeof createRuntime>;
let server: Awaited<ReturnType<typeof startServer>>;
let session = '';
const get = (query: string, auth = true) => fetch(`${server.url.replace(/\/$/, '')}/api/image?${query}`, { headers: auth ? { Authorization: 'Bearer t' } : {} });

beforeAll(async () => {
  rt = createRuntime(project, { interactive: true });
  server = await startServer({ runtime: rt, token: 't' });
  session = (await rt.start({ cwd: project, model: 'fake/m1' })).id;
});

afterAll(async () => {
  await server.close();
  rt.dispose();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the page’s own files', () => {
  it('keeps only the hashed build files for good; the icon and the page are asked for again', async () => {
    const web = path.join(home, 'web');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Favilla</title>');
    fs.writeFileSync(path.join(web, 'icon.png'), png);
    fs.writeFileSync(path.join(web, 'assets', 'index-D-eLV40z.js'), 'export {};');
    const page = await startServer({ runtime: rt, token: 'w', webDir: web });
    try {
      const cache = async (p: string) => (await fetch(`${page.url.replace(/\/$/, '')}${p}`)).headers.get('cache-control');
      expect(await cache('/icon.png')).toBe('no-cache');
      expect(await cache('/assets/index-D-eLV40z.js')).toBe('public, max-age=31536000, immutable');
      expect(await cache('/')).toBe('no-store');
      expect((await fetch(new URL('/%', page.url))).status).toBe(400);
      const sibling = path.join(home, 'web-extra');
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, 'fixture.txt'), 'fixture');
      expect((await fetch(new URL('/..%2fweb-extra/fixture.txt', page.url))).status).toBe(403);
      for (const origin of ['null', 'not an origin']) {
        const res = await fetch(new URL('/api/fixture', page.url), { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer w' } });
        expect(res.status).toBe(403);
      }
    } finally {
      await page.close();
    }
  });
});

describe('pictures by path', () => {
  it('limits phone reads to the project, its scratch or an exact session reference', async () => {
    const { scratchDir } = await import('../src/prompt/system');
    const outside = path.join(home, 'other');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(project, 'linked'), 'junction');
    const ask = (route: string, file: string, phone = true, id = session) => fetch(new URL(`/api/${route}?${new URLSearchParams({ session: id, path: file, stat: '' })}`, server.url), { headers: { Authorization: 'Bearer t', ...(phone ? { 'X-Favilla-Device': 'fixture' } : {}) } });
    for (const route of ['file', 'image']) {
      const name = route === 'file' ? 'record.txt' : 'record.png';
      const file = path.join(outside, name);
      fs.writeFileSync(file, route === 'file' ? 'fixture' : png);
      fs.copyFileSync(file, path.join(scratchDir(project), name));
      expect((await ask(route, path.join(scratchDir(project), name))).status).toBe(200);
      expect((await ask(route, route === 'file' ? 'notes.txt' : 'design/icon.png')).status).toBe(200);
      expect((await ask(route, file, false)).status).toBe(200);
      rt.live.get(session)!.messages.push({ id: name, role: 'assistant', time: 1, parts: [{ type: 'text', text: `See \`${file}.old\`.` }] });
      expect((await ask(route, file)).status).toBe(403);
      expect((await ask(route, `linked/${name}`)).status).toBe(403);
      rt.live.get(session)!.messages.push({ id: name + '2', role: 'assistant', time: 2, parts: [{ type: 'text', text: `See \`${file}\`.` }] });
      expect((await ask(route, file)).status).toBe(200);
      expect((await ask(route, file, true, '')).status).toBe(403);
    }
  });
  it('reads a path relative to the session project, an absolute path and a file URL', async () => {
    for (const p of ['design/icon.png', path.join(project, 'design', 'icon.png'), pathToFileURL(path.join(project, 'design', 'icon.png')).href]) {
      const res = await get(`session=${session}&path=${encodeURIComponent(p)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    }
  });

  it('serves pictures only, to the app only', async () => {
    expect((await get(`session=${session}&path=notes.txt`)).status).toBe(415);
    expect((await get(`session=${session}&path=design/missing.png`)).status).toBe(404);
    expect((await get(`session=${session}&path=design/icon.png`, false)).status).toBe(401);
  });

  it('reads a picture a tool showed, by the short name its result gave (pic: and the start of its id)', async () => {
    const id = rt.store.blobs.put(png, false);
    const res = await get(`session=${session}&path=${encodeURIComponent(`pic:${id.slice(0, 12)}`)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    // Kept text (a file's content, a command's output) is no picture, and a name nothing starts with is none.
    const text = rt.store.blobs.put('const secret = 1;');
    expect((await get(`path=pic:${text.slice(0, 12)}`)).status).toBe(415);
    expect((await get('path=pic:000000000000')).status).toBe(404);
    expect((await get(`path=pic:${id.slice(0, 12)}`, false)).status).toBe(401);
  });
});

describe('files an answer names', () => {
  type Found = { path: string; relative: string; content?: string; others: number };
  const file = async (query: string, auth = true) => {
    const res = await fetch(`${server.url.replace(/\/$/, '')}/api/file?session=${session}&${query}`, { headers: auth ? { Authorization: 'Bearer t' } : {} });
    return { status: res.status, body: res.ok ? ((await res.json()) as Found) : null };
  };

  it('reads a path relative to the session project, and one in full', async () => {
    for (const p of ['src/store/sessions.ts', path.join(project, 'src', 'store', 'sessions.ts')]) {
      const { status, body } = await file(`path=${encodeURIComponent(p)}`);
      expect(status).toBe(200);
      expect(body!.relative).toBe('src/store/sessions.ts');
      expect(body!.content!.split('\n')[29]).toBe('export const line30 = 30;');
    }
  });

  it('finds a file named by the end of its path, the one nearest the root when more end so', async () => {
    // A path from another checkout or machine ends like the project's file: that one, by the longest end that fits.
    for (const p of ['store/sessions.ts', 'sessions.ts', path.join(home, 'elsewhere', 'app', 'src', 'store', 'sessions.ts'), '/workspace/app/src/store/sessions.ts']) {
      expect((await file(`path=${encodeURIComponent(p)}`)).body!.relative, p).toBe('src/store/sessions.ts');
    }
    const both = await file('path=index.ts');
    expect(both.body!.relative).toBe('lib/index.ts');
    expect(both.body!.others).toBe(1);
  });

  it('says where a file is without reading it, and refuses what is missing, not text, or not asked by the app', async () => {
    const where = await file('stat&path=sessions.ts');
    expect(where.body!.path).toBe(path.join(project, 'src', 'store', 'sessions.ts'));
    expect(where.body!.content).toBeUndefined();
    expect((await file('path=src/missing.ts')).status).toBe(404);
    expect((await file('path=data.bin')).status).toBe(415);
    expect((await file('path=sessions.ts', false)).status).toBe(401);
  });
});
