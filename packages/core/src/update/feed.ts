import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The update feed: one small JSON file that names the newest version and where its files are. The public build reads
 * the one on the website, a build kept on one computer a file on that computer. Each file comes with its size and SHA-256,
 * so whatever is downloaded is checked against the feed before it is run.
 *
 *   { "version": "1.2.19", "date": "2026-11-20", "notes": "...",
 *     "windows": { "setup": { "url": "...", "size": 142067580, "sha256": "07f4..." }, "portable": { ... } } }
 *
 * A url may be relative to the feed, so a folder holding the feed and its installers can move as one.
 */

export interface FeedFile {
  url: string;
  size: number;
  sha256: string;
}

export interface Release {
  version: string;
  date?: string;
  notes?: string;
  setup?: FeedFile;
  portable?: FeedFile;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class FeedError extends Error {}

/** Reads a feed's text; `feedUrl` is where it came from, for relative urls and for which schemes its files may use. */
export function parseFeed(text: string, feedUrl: string): Release {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FeedError('The update feed is not JSON');
  }
  if (!raw || typeof raw !== 'object') throw new FeedError('The update feed is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== 'string' || !VERSION.test(o.version)) throw new FeedError('The update feed has no version number');
  const windows = (o.windows && typeof o.windows === 'object' ? o.windows : {}) as Record<string, unknown>;
  const release: Release = { version: o.version };
  if (typeof o.date === 'string') release.date = o.date.slice(0, 32);
  if (typeof o.notes === 'string') release.notes = o.notes.slice(0, 2000);
  for (const kind of ['setup', 'portable'] as const) {
    if (windows[kind] !== undefined) release[kind] = feedFile(windows[kind], feedUrl, kind);
  }
  return release;
}

function feedFile(v: unknown, feedUrl: string, kind: string): FeedFile {
  const f = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (typeof f.url !== 'string' || !f.url) throw new FeedError(`The update feed's ${kind} file has no url`);
  if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size <= 0) throw new FeedError(`The update feed's ${kind} file has no size`);
  const sha256 = typeof f.sha256 === 'string' ? f.sha256.toLowerCase() : '';
  if (!SHA256.test(sha256)) throw new FeedError(`The update feed's ${kind} file has no SHA-256`);
  let url: URL;
  try {
    url = new URL(f.url, feedUrl);
  } catch {
    throw new FeedError(`The update feed's ${kind} url is not valid`);
  }
  // A feed on the web names files on the web over https; only a feed on this computer may name files on it, and only a
  // server on this computer may serve them over plain http (a local mirror, the tests).
  const feed = new URL(feedUrl);
  const ok =
    url.protocol === 'https:' ||
    (url.protocol === 'file:' && feed.protocol === 'file:') ||
    (url.protocol === 'http:' && feed.protocol === 'http:' && loopback(url.hostname) && loopback(feed.hostname));
  if (!ok) throw new FeedError(`The update feed's ${kind} url must use https`);
  return { url: url.href, size: f.size, sha256 };
}

const loopback = (host: string) => host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);

/** Whether version `a` is later than `b` (numbers only; a suffix such as -beta counts as before the plain number). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main, pre] = v.trim().replace(/^v/, '').split('-', 2);
    return { parts: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre !== undefined };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length, 3); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return d > 0;
  }
  return !x.pre && y.pre;
}

/** A feed address as a URL: an absolute path on this computer becomes a file: url. */
export function feedUrlOf(feed: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(feed) || feed.startsWith('/') || feed.startsWith('\\\\')) return pathToFileURL(feed).href;
  return feed;
}

/** The host a web feed is on, or '' for a feed on this computer: what the settings name as the place asked. */
export function feedHost(feed: string): string {
  try {
    const u = new URL(feedUrlOf(feed));
    return u.protocol === 'file:' ? '' : u.host;
  } catch {
    return '';
  }
}

/** SHA-256 of a file, read in a stream. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** The path behind a file: url. */
export const localPath = (url: string): string => fileURLToPath(url);
