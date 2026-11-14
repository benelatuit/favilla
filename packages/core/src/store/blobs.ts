import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { appPath } from '../util/paths';
import { seal, unseal } from './seal';
import { timedSync } from '../util/slow';

const QUALITY = 6;
const brotli = promisify(zlib.brotliCompress);
const compression = (size: number) => ({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } });
const blobId = (buf: Buffer, compress: boolean) => `${createHash('sha256').update(buf).digest('hex').slice(0, 40)}.${compress ? 'br' : 'bin'}`;
// Only the previews the page asks for are kept. An id is the hash of its content, so a hit needs no second read.
const PREVIEW_CACHE_BYTES = 12 * 1024 * 1024;
type ProjectPreview = (text: string) => string | undefined;
type Preview = { project: ProjectPreview; preview: Buffer; bytes: number };

/**
 * Content-addressed storage shared by every session: each payload is kept once however often it appears
 * (a file read five times, the same screenshot, a snapshot in several turns). Text is Brotli-compressed;
 * images and other binary data are already compressed and stored as they are. Either is sealed on disk when
 * sealing is on (see seal.ts); the id is the hash of the content itself, so sealing leaves sharing as it was.
 *
 * An id is "<hash>.br" or "<hash>.bin", so it says how to read the file.
 */
export class BlobStore {
  private previews = new Map<string, Preview>();
  private previewBytes = 0;

  constructor(readonly root = appPath('blobs')) {}

  private file(id: string): string {
    return path.join(this.root, id.slice(0, 2), id);
  }

  put(data: Buffer | string, compress = true): string {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const id = blobId(buf, compress);
    const f = this.file(id);
    if (fs.existsSync(f)) return id;
    const body = compress
      ? timedSync('output stored', () => zlib.brotliCompressSync(buf, compression(buf.length)))
      : buf;
    this.keep(f, body);
    return id;
  }

  /** A large result being packed in the background can compress without holding the engine's thread. */
  async putLargeText(text: string): Promise<string> {
    const buf = Buffer.from(text, 'utf8');
    const id = blobId(buf, true);
    const file = this.file(id);
    if (!fs.existsSync(file)) {
      const body = await brotli(buf, compression(buf.length));
      if (!fs.existsSync(file)) this.keep(file, body);
    }
    return id;
  }

  private keep(f: string, body: Buffer): void {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, seal(body));
      fs.renameSync(tmp, f);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      // Only a blob that is already on disk can stand in for this write.
      if (!fs.existsSync(f)) throw error;
    }
  }

  get(id: string): Buffer | null {
    if (!/^[0-9a-f]{40}\.(br|bin)$/.test(id)) return null;
    try {
      const packed = unseal(fs.readFileSync(this.file(id)));
      return id.endsWith('.br') ? zlib.brotliDecompressSync(packed) : packed;
    } catch {
      return null;
    }
  }

  text(id: string): string | null {
    return this.get(id)?.toString('utf8') ?? null;
  }

  /** What `project` makes of a blob's text, kept so that opening a session again does not unpack every blob again. */
  previewText(id: string, project: ProjectPreview): string | null {
    const old = this.previews.get(id);
    if (old) {
      this.previews.delete(id);
      // A blob that has gone gives nothing, as a read of it would.
      if (old.project === project && this.has(id)) {
        this.previews.set(id, old);
        return old.preview.toString('utf16le');
      }
      this.previewBytes -= old.bytes;
    }
    const decoded = this.get(id);
    if (!decoded) return null;
    const text = project(decoded.toString('utf8'));
    if (text === undefined) return null;
    const bytes = 2 * text.length + 256;
    if (bytes <= PREVIEW_CACHE_BYTES) {
      while (this.previewBytes + bytes > PREVIEW_CACHE_BYTES) {
        const [key, entry] = this.previews.entries().next().value!;
        this.previews.delete(key);
        this.previewBytes -= entry.bytes;
      }
      // A sliced string could keep the whole expanded result alive.
      this.previews.set(id, { project, preview: Buffer.from(text, 'utf16le'), bytes });
      this.previewBytes += bytes;
    }
    return text;
  }

  has(id: string): boolean {
    return fs.existsSync(this.file(id));
  }

  /** The id that starts with `prefix` (12 to 40 hex digits): a picture's short name (pic:…) in an answer is one. */
  find(prefix: string): string | null {
    if (!/^[0-9a-f]{12,40}$/.test(prefix)) return null;
    try {
      return fs.readdirSync(path.join(this.root, prefix.slice(0, 2))).find((n) => n.startsWith(prefix) && /\.(?:br|bin)$/.test(n)) ?? null;
    } catch {
      return null;
    }
  }

  /** Delete blobs nothing refers to any more, sparing recent ones a writer may be about to reference. */
  gc(live: Set<string>, minAgeMs = 24 * 3600_000): { removed: number; freed: number } {
    let removed = 0;
    let freed = 0;
    let dirs: string[];
    try {
      dirs = fs.readdirSync(this.root);
    } catch {
      return { removed, freed };
    }
    const cutoff = Date.now() - minAgeMs;
    for (const d of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(this.root, d));
      } catch {
        continue;
      }
      for (const name of names) {
        if (live.has(name)) continue;
        const f = path.join(this.root, d, name);
        try {
          const st = fs.statSync(f);
          if (st.mtimeMs > cutoff) continue;
          fs.rmSync(f, { force: true });
          removed++;
          freed += st.size;
        } catch {
          /* gone already */
        }
      }
    }
    return { removed, freed };
  }
}

/** Blob ids mentioned anywhere in a text (session lines, checkpoint indexes). */
export function blobIds(text: string): string[] {
  return text.match(/[0-9a-f]{40}\.(?:br|bin)/g) ?? [];
}
