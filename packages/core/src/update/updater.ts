import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { http } from '../net/http';
import { debug } from '../util/log';
import { FeedError, feedHost, feedUrlOf, isNewer, localPath, parseFeed, sha256File, type FeedFile, type Release } from './feed';
import type { InstallKind, UpdateView } from './view';

export type { InstallKind, UpdateView } from './view';

/**
 * Checking for a newer version, and fetching its installer for the desktop app to run.
 *
 * Where to look is fixed when the app is built (FAVILLA_UPDATE_FEED, core/scripts/build-defines.mjs): the public
 * release names the website's feed, a build kept on one computer a feed on that computer, and a build from source none, so
 * it never asks anything. The settings can turn checking off. A check sends a plain GET with the version and the
 * system in the user agent, nothing else. The answer is kept in the data folder, so a start shows a known update
 * without waiting for the network.
 *
 * The installer is downloaded into the system's temp folder and checked against the feed's size and SHA-256 before it
 * is offered. Running it is the desktop app's part (packages/desktop/src/main.ts), which checks the file again.
 */

export interface UpdaterOptions {
  version: string;
  feed: string;
  install: InstallKind;
  /** The file the last answer is kept in. */
  cacheFile: string;
  /** Whether the settings allow checking (read at each check). */
  enabled: () => boolean;
  proxy?: () => string | false | undefined;
  /** Where installers are downloaded to (default: <temp>/favilla-update). */
  downloadDir?: string;
  /** The first check after start, and the time between checks. */
  firstDelayMs?: number;
  everyMs?: number;
  /** An answer younger than this is used without asking again. */
  freshMs?: number;
  now?: () => number;
}

interface Cache {
  feed: string;
  checkedAt: number;
  release: Release;
}

export const DEFAULT_DOWNLOAD_DIR = () => path.join(os.tmpdir(), 'favilla-update');
const HOUR = 3_600_000;

export class Updater {
  private release: Release | undefined;
  private checkedAt: number | undefined;
  private error: string | undefined;
  private checking: Promise<void> | null = null;
  private download: UpdateView['download'] = { state: 'idle', received: 0, total: 0 };
  private file: string | undefined;
  private fetching: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly o: UpdaterOptions) {
    this.now = o.now ?? Date.now;
    const cache = o.feed ? this.readCache() : undefined;
    if (cache) {
      this.release = cache.release;
      this.checkedAt = cache.checkedAt;
    }
  }

  /** A feed is built in and the settings allow checking. */
  active(): boolean {
    return !!this.o.feed && this.o.enabled() && process.env.FAVILLA_UPDATE_CHECK !== '0';
  }

  view(): UpdateView {
    const r = this.release;
    const available = !!r && isNewer(r.version, this.o.version);
    return {
      feed: !!this.o.feed,
      host: feedHost(this.o.feed),
      enabled: this.o.enabled(),
      current: this.o.version,
      install: this.o.install,
      checking: !!this.checking,
      checkedAt: this.checkedAt,
      latest: r ? { version: r.version, date: r.date, notes: r.notes } : undefined,
      available,
      error: this.error,
      download: available ? { ...this.download } : { state: 'idle', received: 0, total: 0 },
      file: available && this.download.state === 'ready' ? this.file : undefined,
      sha256: available && this.download.state === 'ready' ? r?.setup?.sha256 : undefined,
      portableUrl: available && this.o.install === 'portable' ? r?.portable?.url : undefined,
    };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** Checks a while after start and then every few hours, while checking is on. Timers never keep the process up. */
  start(): void {
    if (!this.o.feed) return;
    const tick = () => void this.check().catch(() => {});
    const first = setTimeout(tick, this.o.firstDelayMs ?? 20_000);
    const every = setInterval(tick, this.o.everyMs ?? 6 * HOUR);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /**
   * Asks the feed, unless the last answer is fresh and `force` is not set. A check the user asks for (`asked`) runs
   * with checking turned off too. Errors are kept in the view, not thrown.
   */
  check(force = false, asked = false): Promise<void> {
    if (!this.o.feed || (!asked && !this.active())) return Promise.resolve();
    if (!force && this.checkedAt && this.now() - this.checkedAt < (this.o.freshMs ?? 5 * HOUR)) return Promise.resolve();
    this.checking ??= this.ask().finally(() => {
      this.checking = null;
      this.changed();
    });
    this.changed();
    return this.checking;
  }

  private async ask(): Promise<void> {
    const url = feedUrlOf(this.o.feed);
    try {
      const text = url.startsWith('file:')
        ? await fs.promises.readFile(localPath(url), 'utf8')
        : await this.fetchText(url);
      const release = parseFeed(text, url);
      const moved = this.release?.version !== release.version || this.release?.setup?.sha256 !== release.setup?.sha256;
      this.release = release;
      this.checkedAt = this.now();
      this.error = undefined;
      if (moved && this.download.state !== 'downloading') {
        this.download = { state: 'idle', received: 0, total: 0 };
        this.file = undefined;
      }
      this.writeCache({ feed: this.o.feed, checkedAt: this.checkedAt, release });
      debug('update', `checked: ${release.version} is ${isNewer(release.version, this.o.version) ? 'newer' : 'not newer'}`);
    } catch (e) {
      this.error = e instanceof FeedError ? e.message : `Could not reach the update feed: ${(e as Error).message}`;
      debug('update', `check failed: ${this.error}`);
    }
  }

  private async fetchText(url: string): Promise<string> {
    const res = await http(url, {
      headers: { 'user-agent': `Favilla/${this.o.version} (${process.platform})`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      proxy: this.o.proxy?.() || false,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 64 * 1024) throw new FeedError('The update feed is too large');
    return text;
  }

  /**
   * Fetches the installer of the latest version and checks it. Resolves when it is ready or has failed (the view
   * says which); a second call while one runs joins it.
   */
  fetchInstaller(): Promise<void> {
    const r = this.release;
    if (!r || !isNewer(r.version, this.o.version) || this.o.install !== 'setup' || !r.setup) return Promise.resolve();
    if (this.download.state === 'ready' && this.file && fs.existsSync(this.file)) return Promise.resolve();
    this.fetching ??= this.get(r.version, r.setup).finally(() => {
      this.fetching = null;
      this.changed();
    });
    return this.fetching;
  }

  private async get(version: string, f: FeedFile): Promise<void> {
    const dir = this.o.downloadDir ?? DEFAULT_DOWNLOAD_DIR();
    const file = path.join(dir, `Favilla-Setup-${version}.exe`);
    const part = `${file}.part`;
    this.download = { state: 'downloading', received: 0, total: f.size };
    this.changed();
    try {
      fs.mkdirSync(dir, { recursive: true });
      // An earlier download of the same file is used again when it still checks out.
      if (fs.existsSync(file) && fs.statSync(file).size === f.size && (await sha256File(file)) === f.sha256) {
        this.ready(file, f.size);
        return;
      }
      for (const old of fs.readdirSync(dir)) if (old.startsWith('Favilla-Setup-') && path.join(dir, old) !== file) fs.rmSync(path.join(dir, old), { force: true });
      const hash = crypto.createHash('sha256');
      let received = 0;
      let shown = 0;
      const body = await this.open(f.url);
      const out = fs.createWriteStream(part);
      try {
        for await (const chunk of body) {
          const b = chunk as Buffer;
          received += b.length;
          if (received > f.size) throw new Error('The download is larger than the update feed says');
          hash.update(b);
          if (!out.write(b)) await new Promise<void>((r) => out.once('drain', () => r()));
          if (this.now() - shown > 1000) {
            shown = this.now();
            this.download = { state: 'downloading', received, total: f.size };
            this.changed();
          }
        }
      } finally {
        await new Promise<void>((resolve) => out.end(resolve));
      }
      if (received !== f.size) throw new Error(`The download stopped at ${received} of ${f.size} bytes`);
      if (hash.digest('hex') !== f.sha256) throw new Error('The download does not match the SHA-256 in the update feed');
      fs.renameSync(part, file);
      this.ready(file, received);
    } catch (e) {
      fs.rmSync(part, { force: true });
      this.download = { state: 'failed', received: 0, total: f.size, error: (e as Error).message };
      this.file = undefined;
      debug('update', `download failed: ${(e as Error).message}`);
    }
  }

  private ready(file: string, size: number): void {
    this.file = file;
    this.download = { state: 'ready', received: size, total: size };
    debug('update', `installer ready: ${path.basename(file)}`);
  }

  /** The file's bytes as a stream; a web download gives up after a minute with nothing coming. */
  private async open(url: string): Promise<AsyncIterable<unknown>> {
    if (url.startsWith('file:')) return fs.createReadStream(localPath(url));
    const stall = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(new Error('The download stalled for a minute')), 60_000);
      timer.unref?.();
    };
    alive();
    const res = await http(url, { headers: { 'user-agent': `Favilla/${this.o.version} (${process.platform})` }, signal: stall.signal, proxy: this.o.proxy?.() || false });
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw new Error(`The download answered HTTP ${res.status}`);
    }
    const body = Readable.fromWeb(res.body as never);
    body.on('data', alive).on('end', () => clearTimeout(timer)).on('error', () => clearTimeout(timer));
    return body;
  }

  private readCache(): Cache | undefined {
    try {
      const c = JSON.parse(fs.readFileSync(this.o.cacheFile, 'utf8')) as Cache;
      // An answer from another feed (a build that changed where it looks) is not this feed's.
      if (c.feed !== this.o.feed || typeof c.checkedAt !== 'number' || !c.release) return undefined;
      return { feed: c.feed, checkedAt: c.checkedAt, release: parseFeed(JSON.stringify(cacheShape(c.release)), feedUrlOf(this.o.feed)) };
    } catch {
      return undefined;
    }
  }

  private writeCache(c: Cache): void {
    try {
      fs.mkdirSync(path.dirname(this.o.cacheFile), { recursive: true });
      fs.writeFileSync(this.o.cacheFile, JSON.stringify(c, null, 2));
    } catch (e) {
      debug('update', `could not keep the answer: ${(e as Error).message}`);
    }
  }
}

/** A kept release in the feed's own shape, so it goes through the same checks when read back. */
function cacheShape(r: Release): unknown {
  return { version: r.version, date: r.date, notes: r.notes, windows: { setup: r.setup, portable: r.portable } };
}

/** The feed this build looks at: fixed when it is bundled, empty in a build from source. */
export const BUILT_IN_FEED: string = process.env.FAVILLA_UPDATE_FEED ?? '';

/** How this copy runs: the desktop app tells its engine; a bundle under plain Node is the npm command. */
export function installKind(): InstallKind {
  const told = process.env.FAVILLA_INSTALL_KIND;
  if (told === 'setup' || told === 'portable' || told === 'app') return told;
  return process.versions.electron ? 'app' : 'npm';
}
