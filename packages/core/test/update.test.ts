import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { feedHost, feedUrlOf, isNewer, parseFeed } from '../src/update/feed';
import { Updater, type UpdaterOptions } from '../src/update/updater';
import type { Runtime } from '../src/runtime';
import { startServer } from '../src/server/server';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const INSTALLER = Buffer.from('MZ' + 'x'.repeat(300_000));
const feedText = (o: Record<string, unknown>) => JSON.stringify(o);

describe('the update feed', () => {
  const file = { size: 10, sha256: 'a'.repeat(64) };

  it('resolves urls against the feed and keeps size and SHA-256', () => {
    const r = parseFeed(feedText({ version: '1.2.19', date: '2026-11-20', notes: 'Fixes', windows: { setup: { url: 'Favilla-Setup-1.2.19.exe', ...file } } }), 'https://example.com/favilla/latest.json');
    expect(r).toEqual({ version: '1.2.19', date: '2026-11-20', notes: 'Fixes', setup: { url: 'https://example.com/favilla/Favilla-Setup-1.2.19.exe', ...file } });
  });

  it('refuses files over plain http, and files on this computer named by a feed on the web', () => {
    expect(() => parseFeed(feedText({ version: '1.2.19', windows: { setup: { url: 'http://example.com/a.exe', ...file } } }), 'https://example.com/latest.json')).toThrow(/https/);
    expect(() => parseFeed(feedText({ version: '1.2.19', windows: { setup: { url: 'file:///C:/a.exe', ...file } } }), 'https://example.com/latest.json')).toThrow(/https/);
    // Plain http only between a feed and files that are both on this computer.
    expect(() => parseFeed(feedText({ version: '1.2.19', windows: { setup: { url: 'http://example.com/a.exe', ...file } } }), 'http://127.0.0.1:9/latest.json')).toThrow(/https/);
    expect(parseFeed(feedText({ version: '1.2.19', windows: { setup: { url: 'a.exe', ...file } } }), 'http://127.0.0.1:9/f/latest.json').setup?.url).toBe('http://127.0.0.1:9/f/a.exe');
    const local = pathToFileURL(path.join(os.tmpdir(), 'feed', 'latest.json')).href;
    expect(parseFeed(feedText({ version: '1.2.19', windows: { setup: { url: 'a.exe', ...file } } }), local).setup?.url).toBe(new URL('a.exe', local).href);
  });

  it('refuses a feed without a plain version, a size or a SHA-256', () => {
    expect(() => parseFeed('not json', 'https://e.com/f')).toThrow(/JSON/);
    expect(() => parseFeed(feedText({ version: 'latest' }), 'https://e.com/f')).toThrow(/version/);
    expect(() => parseFeed(feedText({ version: '1.2.19', windows: { setup: { url: 'a.exe', size: 0, sha256: file.sha256 } } }), 'https://e.com/f')).toThrow(/size/);
    expect(() => parseFeed(feedText({ version: '1.2.19', windows: { setup: { url: 'a.exe', size: 10, sha256: 'abc' } } }), 'https://e.com/f')).toThrow(/SHA-256/);
  });

  it('compares versions by their numbers, a suffix before the plain number', () => {
    expect(isNewer('1.2.10', '1.2.9')).toBe(true);
    expect(isNewer('1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('1.2.18', '1.2.18')).toBe(false);
    expect(isNewer('1.2.17', '1.2.18')).toBe(false);
    expect(isNewer('1.2.18', '1.2.18-beta')).toBe(true);
    expect(isNewer('v2.0.0', '1.99.99')).toBe(true);
  });

  it('names the host of a web feed and none for a feed on this computer', () => {
    expect(feedHost('https://favilla.example.com/latest.json')).toBe('favilla.example.com');
    expect(feedHost('C:\\releases\\latest.json')).toBe('');
    expect(feedUrlOf('C:\\releases\\latest.json')).toMatch(/^file:\/\/\/C:\/releases\/latest\.json$/);
  });
});

describe('the updater', () => {
  let server: http.Server;
  let base = '';
  let feedBody = '';
  let installer = INSTALLER;
  let installerStatus = 200;
  const requests: string[] = [];
  let dir = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      if (req.url === '/latest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(feedBody);
      } else if (req.url?.startsWith('/Favilla-Setup-')) {
        res.writeHead(installerStatus, { 'content-length': String(installer.length) });
        res.end(installer);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => {
    requests.length = 0;
    installer = INSTALLER;
    installerStatus = 200;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (o: Partial<UpdaterOptions> = {}) => {
    dir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-update-test-'));
    return new Updater({ version: '1.2.18', feed: `${base}/latest.json`, install: 'setup', cacheFile: path.join(dir, 'update.json'), enabled: () => true, downloadDir: path.join(dir, 'dl'), ...o });
  };
  const release = (size = INSTALLER.length, sum = sha(INSTALLER)) => feedText({ version: '1.2.19', windows: { setup: { url: 'Favilla-Setup-1.2.19.exe', size, sha256: sum } } });

  it('finds a newer version, keeps the answer, and asks again only when it is old or the user asks', async () => {
    dir = '';
    feedBody = release();
    let now = 1_000_000;
    const u = make({ now: () => now });
    await u.check();
    expect(u.view()).toMatchObject({ feed: true, host: base.slice('http://'.length), current: '1.2.18', available: true, latest: { version: '1.2.19' }, checkedAt: now });
    expect(requests).toEqual(['/latest.json']);

    // A second start reads the kept answer and does not ask while it is fresh.
    const again = make({ now: () => now });
    expect(again.view().available).toBe(true);
    await again.check();
    expect(requests).toHaveLength(1);
    now += 6 * 3_600_000;
    await again.check();
    expect(requests).toHaveLength(2);
    await again.check(true);
    expect(requests).toHaveLength(3);
  });

  it('asks nothing with checking turned off, unless the user asks', async () => {
    dir = '';
    feedBody = release();
    const u = make({ enabled: () => false });
    await u.check(true);
    expect(requests).toEqual([]);
    expect(u.view()).toMatchObject({ enabled: false, available: false });
    await u.check(true, true);
    expect(u.view().available).toBe(true);
  });

  it('keeps what went wrong with the feed in the view', async () => {
    dir = '';
    feedBody = '{"version": 3}';
    const u = make();
    await u.check(true);
    expect(u.view()).toMatchObject({ available: false, error: 'The update feed has no version number' });
  });

  it('downloads the installer, checks it, and offers it once it matches', async () => {
    dir = '';
    feedBody = release();
    const u = make();
    await u.check(true);
    await u.fetchInstaller();
    const v = u.view();
    expect(v.download).toEqual({ state: 'ready', received: INSTALLER.length, total: INSTALLER.length });
    expect(v.file).toBe(path.join(dir, 'dl', 'Favilla-Setup-1.2.19.exe'));
    expect(v.sha256).toBe(sha(INSTALLER));
    expect(fs.readFileSync(v.file!)).toEqual(INSTALLER);
    // A second fetch uses the checked file and downloads nothing.
    requests.length = 0;
    await u.fetchInstaller();
    expect(requests).toEqual([]);
  });

  it('refuses a download that does not match the feed, and leaves nothing behind', async () => {
    dir = '';
    feedBody = release(INSTALLER.length, sha(Buffer.from('other')));
    const u = make();
    await u.check(true);
    await u.fetchInstaller();
    expect(u.view()).toMatchObject({ download: { state: 'failed', error: 'The download does not match the SHA-256 in the update feed' }, file: undefined, sha256: undefined });
    expect(fs.readdirSync(path.join(dir, 'dl'))).toEqual([]);

    feedBody = release(INSTALLER.length + 5);
    await u.check(true);
    await u.fetchInstaller();
    expect(u.view().download).toMatchObject({ state: 'failed', error: `The download stopped at ${INSTALLER.length} of ${INSTALLER.length + 5} bytes` });

    feedBody = release(1000);
    await u.check(true);
    await u.fetchInstaller();
    expect(u.view().download).toMatchObject({ state: 'failed', error: 'The download is larger than the update feed says' });

    feedBody = release();
    installerStatus = 404;
    await u.check(true);
    await u.fetchInstaller();
    expect(u.view().download).toMatchObject({ state: 'failed', error: 'The download answered HTTP 404' });
    expect(fs.readdirSync(path.join(dir, 'dl'))).toEqual([]);
  });

  it('downloads nothing for a portable copy or the npm command, and names the portable file instead', async () => {
    dir = '';
    feedBody = feedText({ version: '1.2.19', windows: { setup: { url: 'Favilla-Setup-1.2.19.exe', size: INSTALLER.length, sha256: sha(INSTALLER) }, portable: { url: 'Favilla-1.2.19-portable.exe', size: 5, sha256: 'b'.repeat(64) } } });
    for (const install of ['portable', 'npm'] as const) {
      const u = make({ install });
      await u.check(true);
      requests.length = 0;
      await u.fetchInstaller();
      expect(requests).toEqual([]);
      expect(u.view().portableUrl).toBe(install === 'portable' ? `${base}/Favilla-1.2.19-portable.exe` : undefined);
    }
  });

  it('reads a feed and its installer from a folder on this computer', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-update-test-'));
    const releases = path.join(dir, 'releases');
    fs.mkdirSync(releases);
    fs.writeFileSync(path.join(releases, 'Favilla-Setup-1.2.19.exe'), INSTALLER);
    fs.writeFileSync(path.join(releases, 'latest.json'), release());
    const u = make({ feed: path.join(releases, 'latest.json') });
    await u.check(true);
    expect(u.view()).toMatchObject({ host: '', available: true });
    await u.fetchInstaller();
    expect(u.view().download.state).toBe('ready');
    expect(requests).toEqual([]);
  });

  it('says nothing about an older or the same version', async () => {
    dir = '';
    feedBody = feedText({ version: '1.2.18', windows: { setup: { url: 'Favilla-Setup-1.2.18.exe', size: INSTALLER.length, sha256: sha(INSTALLER) } } });
    const u = make();
    await u.check(true);
    await u.fetchInstaller();
    expect(u.view()).toMatchObject({ available: false, download: { state: 'idle' } });
    expect(requests).toEqual(['/latest.json']);
  });
});

it('answers /api/update with no feed in a build from source', async () => {
  const runtime = {
    config: {},
    store: { blobs: {} },
    subscribe: () => () => {},
    catalog: { discoverAll: async () => {}, refreshRegistry: async () => false },
    mcp: { start: async () => {} },
    settingsNotices: [],
    subscribeSettings: () => () => {},
  } as unknown as Runtime;
  const server = await startServer({ runtime, token: 'update-test', version: '1.2.18' });
  try {
    const get = await fetch(`${server.url}api/update`, { headers: { Authorization: 'Bearer update-test' } });
    expect(await get.json()).toMatchObject({ feed: false, current: '1.2.18', available: false, download: { state: 'idle' } });
    const check = await fetch(`${server.url}api/update/check`, { method: 'POST', headers: { Authorization: 'Bearer update-test' } });
    expect(await check.json()).toMatchObject({ feed: false, checking: false });
  } finally {
    await server.close();
  }
});
