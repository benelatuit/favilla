import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { envProxy, http } from '../net/http';
import { appPath, assetsDir } from '../util/paths';

/**
 * Real recorded instruments, CC0 or public domain, fetched the first time a piece needs them into Favilla's cache (never
 * into a project) and checked against their git blob hashes: a sustained string section, a grand piano, harp, mallets,
 * plucked bass, drums with skins and a cymbal that swells. Only the zones a piece plays are fetched. WAV files are kept
 * as Opus when ffmpeg is there, a tenth of the size.
 */

export interface Zone {
  file: string;
  key: number | null;
  lo?: number;
  hi?: number;
  vel: [number, number];
  sha: string;
  size: number;
  /** A cymbal swell's length in seconds. */
  swell?: number;
}

export interface Instrument {
  source: string;
  family: string;
  kind: 'struck' | 'plucked' | 'sustained' | 'hit';
  range?: [number, number];
  release?: number;
  attack?: number;
  /** Its recorded level: the loudest 300 ms RMS of its loudest layer near mid-range, in dBFS (measured when the catalogue was built). */
  level?: number;
  zones: Zone[];
}

export interface Catalogue {
  sources: Record<string, { base: string; license: string; credit: string }>;
  palettes: Record<string, string[]>;
  instruments: Record<string, Instrument>;
}

let cached: Catalogue | null = null;
export function catalogue(): Catalogue {
  cached ??= JSON.parse(fs.readFileSync(path.join(assetsDir(), 'music', 'sounds.json'), 'utf8')) as Catalogue;
  return cached;
}

export interface Pick {
  zone: Zone;
  /** Playback rate: 2 to the power of the semitones from the sample to the note, over 12. */
  rate: number;
  gainDb: number;
}

/** The sample for a note: the velocity layer, then the zone holding the key (or the nearest), and how far to shift it. */
export function pickZone(ins: Instrument, key: number | null, vel: number, swell?: number): Pick {
  if (swell !== undefined) {
    const swells = ins.zones.filter((z) => z.swell !== undefined).sort((a, b) => a.swell! - b.swell!);
    const fit = [...swells].reverse().find((z) => z.swell! <= swell + 0.01) ?? swells[0];
    if (fit) return { zone: fit, rate: 1, gainDb: 0 };
  }
  const plain = ins.zones.filter((z) => z.swell === undefined);
  const layer = plain.filter((z) => vel >= z.vel[0] && vel <= z.vel[1]);
  const gap = (z: Zone) => Math.min(Math.abs(vel - z.vel[0]), Math.abs(vel - z.vel[1]));
  const zones = layer.length ? layer : plain.filter((z) => gap(z) === Math.min(...plain.map(gap)));
  // A recorded layer carries most of the dynamic; within it a gentle slope. One layer for all: a wider one.
  const single = zones[0].vel[0] <= 1 && zones[0].vel[1] >= 127;
  const gainDb = single ? Math.max(-6, Math.min(4, (vel - 80) * 0.12)) : Math.max(-5, Math.min(0, (vel - zones[0].vel[1]) * 0.2));
  if (key === null || zones[0].key === null) return { zone: zones[Math.min(zones.length - 1, Math.floor(((vel % 7) / 7) * zones.length))], rate: 1, gainDb };
  const holding = zones.find((z) => z.lo !== undefined && z.hi !== undefined && key >= z.lo && key <= z.hi);
  const zone = holding ?? zones.reduce((m, z) => (Math.abs(z.key! - key) < Math.abs(m.key! - key) ? z : m), zones[0]);
  return { zone, rate: 2 ** ((key - zone.key!) / 12), gainDb };
}

const gitBlobSha = (data: Buffer) => crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

let ffmpeg: boolean | null = null;
const hasFfmpeg = () => (ffmpeg ??= spawnSync('ffmpeg', ['-version'], { windowsHide: true, timeout: 10_000 }).status === 0);

/** The cached file for a zone, if it is there. */
function cachedPath(source: string, zone: Zone): string | null {
  const dir = appPath('cache', 'sounds', source);
  for (const ext of ['.ogg', '.wav', '.m4a']) {
    const p = path.join(dir, `${zone.sha}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Every zone in the cache, fetching what is missing (six at a time) and checking each against its hash. Returns the
 * local file of each zone by its hash, and how much was fetched.
 */
export async function ensureSounds(zones: { source: string; zone: Zone }[], opts: { proxy?: string | false; signal?: AbortSignal } = {}): Promise<{ files: Map<string, string>; fetched: number; bytes: number }> {
  const cat = catalogue();
  const files = new Map<string, string>();
  const todo: { source: string; zone: Zone }[] = [];
  for (const z of zones) {
    if (files.has(z.zone.sha)) continue;
    const hit = cachedPath(z.source, z.zone);
    if (hit) files.set(z.zone.sha, hit);
    else if (!todo.some((t) => t.zone.sha === z.zone.sha)) todo.push(z);
  }
  let bytes = 0;
  const proxy = opts.proxy ?? envProxy();
  const fetchOne = async ({ source, zone }: { source: string; zone: Zone }) => {
    const base = cat.sources[source]?.base;
    if (!base) throw new Error(`no source ${source} in the sound catalogue`);
    const url = base + zone.file.split('/').map(encodeURIComponent).join('/');
    let data: Buffer | null = null;
    for (let attempt = 0; attempt < 4 && !data; attempt++) {
      try {
        const res = await http(url, { proxy, signal: opts.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const got = Buffer.from(await res.arrayBuffer());
        if (gitBlobSha(got) !== zone.sha) throw new Error('the file does not match its hash');
        data = got;
      } catch (e) {
        if (opts.signal?.aborted || attempt === 3) throw new Error(`fetching ${zone.file}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    bytes += data!.length;
    const dir = appPath('cache', 'sounds', source);
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(zone.file).toLowerCase();
    const tmp = path.join(dir, `${zone.sha}.part${ext}`);
    fs.writeFileSync(tmp, data!);
    let out = path.join(dir, `${zone.sha}${ext}`);
    if (ext === '.wav' && hasFfmpeg()) {
      const opus = path.join(dir, `${zone.sha}.ogg`);
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-c:a', 'libopus', '-b:a', '128k', opus], { windowsHide: true, timeout: 120_000 });
      if (r.status === 0 && fs.existsSync(opus)) {
        fs.rmSync(tmp, { force: true });
        files.set(zone.sha, opus);
        return;
      }
    }
    fs.renameSync(tmp, out);
    files.set(zone.sha, out);
    out = '';
  };
  for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(fetchOne));
  return { files, fetched: todo.length, bytes };
}
