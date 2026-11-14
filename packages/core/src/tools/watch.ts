import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ImagePart } from '../types';
import { scratchDir } from '../prompt/system';
import { displayPath, resolvePath } from '../util/paths';
import type { ToolContext, ToolDef, ToolOutput } from './types';

/**
 * Watching a video the way a viewer sees it, which a model cannot do: it judged films from contact sheets of a frame
 * every second or two, and passed one rendered at 12 pictures a second and upscaled, frozen for 2 s at its climax,
 * still for 38% of its length, with four pops and its sound 300 ms late on a cut (2026-11-02). Every frame is decoded
 * small and compared with the one before: freezes, still stretches, jumps, moves too fast to read without blur, slow
 * moves that advance in hops, and, against a cut list, cuts that do not cut and sound that misses its hits. Only
 * ffmpeg is needed; the timeline is drawn when a browser is there.
 */

export interface WatchInput {
  path: string;
  /** A cut list (YAML or JSON): shots, hits and holds, the file the picture and the score share. */
  cuts?: string;
  /** Seconds: 12 frames at full size from this moment as well. */
  at?: number;
}

/** What the picture and the sound agree on: where shots start, the moments both hit, and stillness meant as such. */
export interface CutList {
  fps?: number;
  size?: [number, number];
  shots: number[];
  hits: { at: number; what?: string }[];
  holds: [number, number][];
}

/** Frames are compared 640 wide, where a 1 px hop at 1080p still shows; moves are tracked at half that. */
const AW = 640;
const TX = 8;
const TY = 4;
const BLOCK = 24;
const REACH = 7;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** A cut list from its text: shots as start times or {at}, hits as times or {at, what}, holds as [from, to] or {from, to}. */
export function parseCuts(text: string): CutList {
  const raw = parseYaml(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('a cut list is a YAML or JSON object with shots, hits and holds');
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const time = (v: unknown, ...keys: string[]): number | undefined => num(v) ?? (v && typeof v === 'object' ? keys.map((k) => num((v as Record<string, unknown>)[k])).find((x) => x !== undefined) : undefined);
  const size = Array.isArray(raw.size) && raw.size.length === 2 ? (raw.size.map(Number) as [number, number]) : undefined;
  return {
    fps: num(raw.fps),
    size: size && size.every((n) => n > 0) ? size : undefined,
    shots: list(raw.shots).map((s) => time(s, 'at', 'in', 'start', 'from')).filter((t): t is number => t !== undefined).sort((a, b) => a - b),
    hits: list(raw.hits)
      .flatMap((h): { at: number; what?: string }[] => {
        const at = time(h, 'at', 'time');
        const what = h && typeof h === 'object' ? String((h as Record<string, unknown>).what ?? '') || undefined : undefined;
        return at === undefined ? [] : [{ at, what }];
      })
      .sort((a, b) => a.at - b.at),
    holds: list(raw.holds)
      .map((h) => (Array.isArray(h) ? [num(h[0]), num(h[1])] : [time(h, 'from', 'start'), time(h, 'to', 'end')]))
      .filter((h): h is [number, number] => h[0] !== undefined && h[1] !== undefined && h[1] > h[0]),
  };
}

/** A program's output, whole or as it streams; its error text kept for the message. */
function run(cmd: string, args: string[], onData?: (chunk: Buffer) => void, timeoutMs = 300_000): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (c: Buffer) => (onData ? onData(c) : out.push(c)));
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: Buffer.concat(out), err });
    });
  });
}

interface Frame {
  t: number;
  /** Mean change from the frame before, in levels of 255 at the analysis size. */
  diff: number;
  repeated: boolean;
  /** The second-fastest tile's move, in pixels a frame at full size (the fastest alone may be a mismatch). */
  fastest: number;
  /** Where that tile is, for a close look. */
  tile: number;
  /** Median move of the textured tiles: the camera's, roughly. */
  pan: number;
  tiles: Float32Array;
  /** Change of each tile over the last second. */
  second?: Float32Array;
}

/** Where a block of `a` went in `b`: the offset within ±REACH with the least absolute difference, to a fraction of a pixel. */
function track(a: Uint8Array, b: Uint8Array, w: number, h: number, x0: number, y0: number): { dx: number; dy: number } | null {
  let s = 0;
  let s2 = 0;
  for (let y = 0; y < BLOCK; y++) {
    const o = (y0 + y) * w + x0;
    for (let x = 0; x < BLOCK; x++) {
      const v = a[o + x];
      s += v;
      s2 += v * v;
    }
  }
  const n = BLOCK * BLOCK;
  // A flat block moves nowhere one can read.
  if (s2 / n - (s / n) ** 2 < 30) return null;
  const sad = (dx: number, dy: number, limit = Infinity): number => {
    const xx = x0 + dx;
    const yy = y0 + dy;
    if (xx < 0 || yy < 0 || xx + BLOCK > w || yy + BLOCK > h) return Infinity;
    let t = 0;
    for (let y = 0; y < BLOCK; y++) {
      const p = (y0 + y) * w + x0;
      const q = (yy + y) * w + xx;
      for (let x = 0; x < BLOCK; x++) {
        const d = a[p + x] - b[q + x];
        t += d < 0 ? -d : d;
      }
      if (t >= limit) return t;
    }
    return t;
  };
  let best = sad(0, 0);
  let bx = 0;
  let by = 0;
  for (let dy = -REACH; dy <= REACH; dy++) {
    for (let dx = -REACH; dx <= REACH; dx++) {
      if (!dx && !dy) continue;
      const v = sad(dx, dy, best);
      if (v < best) {
        best = v;
        bx = dx;
        by = dy;
      }
    }
  }
  const refine = (l: number, c: number, r: number) => {
    const den = l - 2 * c + r;
    return Number.isFinite(den) && den > 0 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den))) : 0;
  };
  return { dx: bx + refine(sad(bx - 1, by), best, sad(bx + 1, by)), dy: by + refine(sad(bx, by - 1), best, sad(bx, by + 1)) };
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((p, q) => p - q);
  return s[s.length >> 1];
};

interface Probe {
  width: number;
  height: number;
  fps: number;
  duration: number;
  audio: boolean;
  start: number;
}

async function probe(file: string): Promise<Probe> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,start_time:format=duration', '-of', 'json', file], undefined, 60_000);
  if (r.code !== 0) throw new Error(`ffprobe could not read it: ${r.err.trim().split('\n').pop() ?? ''}`);
  const j = JSON.parse(r.out.toString()) as { streams?: Record<string, string | number>[]; format?: { duration?: string } };
  const video = j.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('it has no video stream');
  const rate = (v: unknown) => {
    const [p, q] = String(v ?? '0/1').split('/').map(Number);
    return q ? p / q : p;
  };
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps: rate(video.avg_frame_rate) || rate(video.r_frame_rate) || 24,
    duration: Number(j.format?.duration ?? 0),
    audio: !!j.streams?.some((s) => s.codec_type === 'audio'),
    start: Number(video.start_time ?? 0) || 0,
  };
}

/** A frame at half size, each pixel the mean of four. */
function half(f: Uint8Array, w: number, h: number): Uint8Array {
  const hw = w >> 1;
  const hh = h >> 1;
  const out = new Uint8Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    const a = 2 * y * w;
    const b = a + w;
    for (let x = 0; x < hw; x++) out[y * hw + x] = (f[a + 2 * x] + f[a + 2 * x + 1] + f[b + 2 * x] + f[b + 2 * x + 1] + 2) >> 2;
  }
  return out;
}

/** Every frame, grey, compared with the one before and the one a second before. */
async function readFrames(file: string, p: Probe, aw: number, ah: number): Promise<Frame[]> {
  const size = aw * ah;
  const tw = Math.floor(aw / TX);
  const th = Math.floor(ah / TY);
  const mw = aw >> 1;
  const mh = ah >> 1;
  const mtw = Math.floor(mw / TX);
  const mth = Math.floor(mh / TY);
  const scale = p.width / mw;
  const back = Math.max(1, Math.round(p.fps));
  const ring: Uint8Array[] = [];
  const frames: Frame[] = [];
  // Long films are tracked on every few frames only, to stay within a minute or so.
  const every = Math.max(1, Math.ceil((p.duration * p.fps) / 6000));
  let cur = new Uint8Array(size);
  let filled = 0;
  let prev: Uint8Array | null = null;
  let prevHalf: Uint8Array | null = null;
  const take = (f: Uint8Array) => {
    const i = frames.length;
    const tiles = new Float32Array(TX * TY);
    let total = 0;
    let changed = 0;
    if (prev) {
      for (let ty = 0; ty < TY; ty++) {
        for (let tx = 0; tx < TX; tx++) {
          let s = 0;
          for (let y = ty * th; y < (ty + 1) * th; y++) {
            const o = y * aw + tx * tw;
            for (let x = 0; x < tw; x++) {
              const d = f[o + x] - prev[o + x];
              const a = d < 0 ? -d : d;
              s += a;
              if (a >= 3) changed++;
            }
          }
          tiles[ty * TX + tx] = s / (tw * th);
          total += s;
        }
      }
    }
    const diff = prev ? total / (TX * TY * tw * th) : 0;
    // The same picture again: almost no pixel moved by more than decoding noise.
    const repeated = !!prev && changed < size * 0.0003;
    const fh = half(f, aw, ah);
    let fastest = 0;
    let tile = -1;
    let pan = 0;
    if (prevHalf && !repeated && i % every === 0) {
      const moves: { v: number; k: number; dx: number; dy: number }[] = [];
      for (let ty = 0; ty < TY; ty++) {
        for (let tx = 0; tx < TX; tx++) {
          const m = track(prevHalf, fh, mw, mh, tx * mtw + ((mtw - BLOCK) >> 1), ty * mth + ((mth - BLOCK) >> 1));
          if (m) moves.push({ v: Math.hypot(m.dx, m.dy) * scale, k: ty * TX + tx, dx: m.dx * scale, dy: m.dy * scale });
        }
      }
      if (moves.length) {
        moves.sort((p1, p2) => p2.v - p1.v);
        const pick = moves[Math.min(1, moves.length - 1)];
        fastest = pick.v;
        tile = pick.k;
        pan = Math.hypot(median(moves.map((m) => m.dx)), median(moves.map((m) => m.dy)));
      }
    }
    let second: Float32Array | undefined;
    if (ring.length === back) {
      const old = ring[0];
      second = new Float32Array(TX * TY);
      for (let ty = 0; ty < TY; ty++) {
        for (let tx = 0; tx < TX; tx++) {
          let s = 0;
          for (let y = ty * th; y < (ty + 1) * th; y++) {
            const o = y * aw + tx * tw;
            for (let x = 0; x < tw; x++) {
              const d = f[o + x] - old[o + x];
              s += d < 0 ? -d : d;
            }
          }
          second[ty * TX + tx] = s / (tw * th);
        }
      }
    }
    frames.push({ t: i / p.fps, diff, repeated, fastest, tile, pan, tiles, second });
    ring.push(f);
    if (ring.length > back) ring.shift();
    prev = f;
    prevHalf = fh;
  };
  const r = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', `scale=${aw}:${ah}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], (chunk) => {
    let at = 0;
    while (at < chunk.length) {
      const n = Math.min(size - filled, chunk.length - at);
      cur.set(chunk.subarray(at, at + n), filled);
      filled += n;
      at += n;
      if (filled === size) {
        take(cur);
        cur = new Uint8Array(size);
        filled = 0;
      }
    }
  });
  if (r.code !== 0 && !frames.length) throw new Error(`ffmpeg could not decode it: ${r.err.trim().split('\n').pop() ?? ''}`);
  return frames;
}

/**
 * Times where the sound rises sharply: loudness in 10 ms steps, below and above 200 Hz apart (a low thump under a
 * held chord moves only the low band), 6 dB over the band's last 200 ms, 80 ms apart at least.
 */
export async function onsets(file: string): Promise<{ t: number; rise: number }[]> {
  const rate = 16000;
  const r = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-']);
  if (r.code !== 0) return [];
  const pcm = new Int16Array(r.out.buffer, r.out.byteOffset, Math.floor(r.out.length / 2));
  const hop = rate / 100;
  const k = Math.exp((-2 * Math.PI * 200) / rate);
  const low = new Float32Array(pcm.length);
  let lp = 0;
  for (let i = 0; i < pcm.length; i++) low[i] = lp = (1 - k) * pcm[i] + k * lp;
  const bands: number[][] = [[], []];
  for (let i = 0; i + 2 * hop <= pcm.length; i += hop) {
    let sl = 0;
    let sh = 0;
    for (let j = i; j < i + 2 * hop; j++) {
      sl += low[j] * low[j];
      const hi = pcm[j] - low[j];
      sh += hi * hi;
    }
    bands[0].push(10 * Math.log10(sl / (2 * hop) / 32768 ** 2 + 1e-10));
    bands[1].push(10 * Math.log10(sh / (2 * hop) / 32768 ** 2 + 1e-10));
  }
  const db = bands[0].map((v, i) => 10 * Math.log10(10 ** (v / 10) + 10 ** (bands[1][i] / 10)));
  // Against the band's mean over the last 200 ms: a held sound that pulses (a tremolo, a swish) stays near its mean.
  const rise = (b: number[], i: number) => {
    if (b[i] < -55) return 0;
    let m = 0;
    for (let j = i - 20; j < i; j++) m += b[Math.max(0, j)];
    return b[i] - m / 20;
  };
  const rises = db.map((_, i) => (i < 3 ? 0 : Math.max(rise(bands[0], i), rise(bands[1], i))));
  const found: { t: number; rise: number }[] = [];
  for (let i = 3; i < rises.length; i++) {
    if (rises[i] < 6 || db[i] < -50) continue;
    let peak = true;
    for (let j = Math.max(0, i - 4); j <= Math.min(rises.length - 1, i + 4); j++) if (rises[j] > rises[i]) peak = false;
    if (!peak) continue;
    if (found.length && i / 100 - found[found.length - 1].t < 0.08) continue;
    found.push({ t: i / 100, rise: rises[i] });
  }
  return found;
}

async function loudness(file: string): Promise<{ lufs?: number; peak?: number }> {
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const last = (re: RegExp) => {
    const all = [...r.err.matchAll(re)];
    return all.length ? Number(all[all.length - 1][1]) : undefined;
  };
  return { lufs: last(/I:\s+(-?[\d.]+) LUFS/g), peak: last(/Peak:\s+(-?[\d.]+) dBFS/g) };
}

/** Spans of frames that pass a test, as [first, last] indexes, at least `min` long. */
function spans(frames: Frame[], test: (f: Frame, i: number) => boolean, min: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= frames.length; i++) {
    if (i < frames.length && test(frames[i], i)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= min) out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

const s1 = (t: number) => `${t.toFixed(t < 10 ? 2 : 1)} s`;

export interface Watched {
  probe: Probe;
  frames: Frame[];
  flags: string[];
  facts: string[];
  /** Moments worth 12 frames at full size: time, tile, why. */
  looks: { t: number; tile: number; why: string }[];
  jumps: number[];
  freezes: [number, number][];
  stills: [number, number][];
  fast: [number, number][];
  steps: [number, number][];
  hits: { at: number; what?: string; offset?: number }[];
  cuts?: CutList;
}

/** What a viewer would notice, from the frames and, with a cut list, against it. */
export function judge(p: Probe, frames: Frame[], cuts: CutList | undefined, heard: { t: number; rise: number }[] | null): Omit<Watched, 'probe' | 'frames'> {
  const flags: string[] = [];
  const facts: string[] = [];
  const looks: Watched['looks'] = [];
  const fps = p.fps;
  const frame = 1 / fps;
  const held = (a: number, b: number) => (cuts?.holds ?? []).some(([h0, h1]) => a >= h0 - frame && b <= h1 + frame);
  const nearCut = (t: number) => (cuts?.shots ?? []).some((c) => Math.abs(c - t) <= 1.5 * frame);
  const n = frames.length;
  const distinct = frames.filter((f) => !f.repeated).length;
  const duration = n / fps;
  facts.push(`${p.width}×${p.height}, ${fps.toFixed(fps % 1 ? 2 : 0)} fps, ${duration.toFixed(1)} s, ${n} frames, ${distinct} distinct pictures (${((distinct / Math.max(duration, frame)) * 1).toFixed(1)} a second)`);
  if (cuts?.size && (cuts.size[0] !== p.width || cuts.size[1] !== p.height)) flags.push(`The video is ${p.width}×${p.height}; the cut list says ${cuts.size[0]}×${cuts.size[1]}.`);
  if (cuts?.fps && Math.abs(cuts.fps - fps) > 0.01) flags.push(`The video runs at ${fps.toFixed(2)} fps; the cut list says ${cuts.fps}.`);
  // Pictures made at half the rate repeat every other frame, the camera and fades included.
  const alternate = frames.filter((f, i) => i > 0 && f.repeated !== frames[i - 1].repeated).length;
  if (distinct < n * 0.6 && alternate > n * 0.6) flags.push(`Every other frame repeats the one before: the whole film moves at ${(fps / 2).toFixed(0)} pictures a second, camera, fades and particles included. Render at the full rate; hold drawings on twos only where the look wants it.`);

  // Jumps: change far above what is around it.
  const jumps: number[] = [];
  for (let i = 1; i < n; i++) {
    const f = frames[i];
    if (f.repeated) continue;
    const around: number[] = [];
    for (let j = Math.max(1, i - 12); j <= Math.min(n - 1, i + 12); j++) if (j !== i && !frames[j].repeated) around.push(frames[j].diff);
    const m = median(around);
    if (f.diff > Math.max(2, 4 * m) && f.diff > 1.5) {
      if (jumps.length && i - jumps[jumps.length - 1] <= 1) continue;
      jumps.push(i);
    }
  }
  if (cuts?.shots.length) {
    const pops = jumps.filter((i) => !nearCut(frames[i].t));
    for (const i of pops.slice(0, 6)) {
      flags.push(`A jump at ${s1(frames[i].t)} (change ${frames[i].diff.toFixed(1)}, against about ${median(frames.slice(Math.max(1, i - 12), i).map((f) => f.diff)).toFixed(1)} around it) where the cut list has no cut: something pops, vanishes or breaks continuity.`);
      looks.push({ t: Math.max(0, frames[i].t - 5 * frame), tile: -1, why: `the jump at ${s1(frames[i].t)}` });
    }
    if (pops.length > 6) flags.push(`${pops.length - 6} more jumps where the cut list has no cut.`);
    for (const c of cuts.shots) {
      if (c < frame || c > duration - frame) continue;
      if (!jumps.some((i) => Math.abs(frames[i].t - c) <= 1.5 * frame)) flags.push(`The cut list starts a shot at ${s1(c)}, but the picture does not change there.`);
    }
  } else if (jumps.length) {
    facts.push(`Cuts or jumps at ${jumps.slice(0, 16).map((i) => s1(frames[i].t)).join(', ')}${jumps.length > 16 ? ` and ${jumps.length - 16} more` : ''} (with a cut list, the ones that are not cuts are named).`);
  }

  // Freezes: one picture for a second or more; shorter runs of it are a cadence, or hops (below).
  const freezes = spans(frames, (f, i) => i > 0 && f.repeated, Math.round(fps)).filter(([a, b]) => !held(frames[a].t, frames[b].t));
  for (const [a, b] of freezes.slice(0, 6)) {
    flags.push(`Frozen ${s1(frames[a - 1 >= 0 ? a - 1 : a].t)} to ${s1(frames[b].t)} (${((b - a + 2) / fps).toFixed(1)} s of one picture)${cuts ? ', not a hold in the cut list' : ''}. Keep something alive (a drift, breath, light, grain) or list it as a hold.`);
  }
  // Still stretches: almost nothing moves for two seconds.
  const stills = spans(frames, (f, i) => i > 0 && f.diff < 0.3, Math.round(2 * fps)).filter(([a, b]) => !held(frames[a].t, frames[b].t) && !freezes.some(([x, y]) => x <= a && y >= b));
  for (const [a, b] of stills.slice(0, 6)) flags.push(`Almost nothing moves from ${s1(frames[a].t)} to ${s1(frames[b].t)} (${((b - a + 1) / fps).toFixed(1)} s).`);
  const stillTime = spans(frames, (f, i) => i > 0 && f.diff < 0.3, Math.round(0.5 * fps)).reduce((s, [a, b]) => s + (b - a + 1), 0) / fps;
  facts.push(`Near-still for ${stillTime.toFixed(1)} s in all (${Math.round((100 * stillTime) / Math.max(duration, frame))}%)`);

  // Too fast to read: the eye sees steps, not motion, past about a 160th of the width a frame at 24 fps without blur.
  const limit = (p.width / 160) * (24 / fps);
  // Over the frames that are new pictures: on twos every other frame repeats, and the step is between pictures.
  const fresh = frames.map((f, i) => ({ f, i })).filter(({ f, i }) => i > 0 && !f.repeated);
  const fast: [number, number][] = [];
  for (let k = 0; k < fresh.length; k++) {
    const quick = (j: number) => fresh[j] && fresh[j].f.fastest > limit * 1.3 && !nearCut(fresh[j].f.t) && !jumps.includes(fresh[j].i);
    if (!quick(k)) continue;
    let e = k;
    while (quick(e + 1)) e++;
    if (e - k >= 1) fast.push([fresh[k].i, fresh[e].i]);
    k = e;
  }
  const fastest = frames.reduce((m, f, i) => (f.fastest > frames[m].fastest && !jumps.includes(i) ? i : m), 0);
  if (frames[fastest]?.fastest > 0) {
    facts.push(`Fastest move ${frames[fastest].fastest.toFixed(0)} px a frame at ${s1(frames[fastest].t)}; the camera's fastest ${Math.max(...frames.map((f) => f.pan)).toFixed(0)} px a frame`);
    looks.push({ t: Math.max(0, frames[fastest].t - 5 * frame), tile: frames[fastest].tile, why: `the fastest move, at ${s1(frames[fastest].t)}` });
  }
  for (const [a, b] of fast.slice(0, 4)) {
    const top = Math.max(...frames.slice(a, b + 1).map((f) => f.fastest));
    flags.push(`From ${s1(frames[a].t)} to ${s1(frames[b].t)} something moves up to ${top.toFixed(0)} px a frame, past about ${limit.toFixed(0)} px where motion reads as steps: blur it over the frame's time (average sub-frames), slow it, or cut on it.`);
  }

  // Hops: a region that changed over a second but stood still on most of its own frames.
  const steps: [number, number][] = [];
  const back = Math.max(1, Math.round(fps));
  for (let i = back; i < n; i += Math.max(1, Math.round(fps / 2))) {
    const second = frames[i].second;
    if (!second) continue;
    const own = frames.slice(i - back + 1, i + 1);
    let hopping = 0;
    for (let k = 0; k < TX * TY; k++) {
      if (second[k] < 0.4) continue;
      // Unchanged on three frames in four while it moved over the second: more than twos or threes explain. Each change
      // small, an edge shifted a pixel or so: new content (a word, a counter) changes a tile far more.
      const still = own.filter((f) => f.tiles[k] < 0.06).length;
      if (still > own.length * 0.75 && own.every((f) => f.tiles[k] < 1.5)) hopping++;
    }
    if (hopping >= 2 && !frames.slice(i - back + 1, i + 1).some((f, j) => jumps.includes(i - back + 1 + j))) {
      const t0 = frames[i - back + 1].t;
      const t1 = frames[i].t;
      if (steps.length && t0 <= steps[steps.length - 1][1] + 0.5) steps[steps.length - 1][1] = t1;
      else steps.push([t0, t1]);
    }
  }
  // A drift that hops is sustained; a lone change in a second is a word appearing or a counter.
  const hops = steps.filter(([a, b]) => b - a >= 1.5);
  steps.splice(0, steps.length, ...hops);
  for (const [a, b] of steps.slice(0, 4)) flags.push(`From ${s1(a)} to ${s1(b)} slow moves advance in hops: parts change over each second but stand still on most frames. Place things at fractional positions (no rounding to whole pixels) and move them every frame.`);

  // Shots: long ones, and ones where nothing moves.
  const starts = cuts?.shots.length ? cuts.shots : [0, ...jumps.map((i) => frames[i].t)];
  const bounds = [...new Set([0, ...starts.filter((t) => t > 0 && t < duration)])].sort((a, b) => a - b);
  const shots = bounds.map((t, i) => [t, bounds[i + 1] ?? duration] as [number, number]);
  facts.push(`${shots.length} shot${shots.length === 1 ? '' : 's'}${cuts?.shots.length ? ' in the cut list' : ' by the picture'}, ${(duration / Math.max(1, shots.length)).toFixed(1)} s on average`);
  for (const [a, b] of shots) {
    if (b - a > 8) flags.push(`The shot from ${s1(a)} to ${s1(b)} runs ${(b - a).toFixed(1)} s: past about 8 s a shot needs a camera move or a change inside it to hold the eye.`);
    const inner = frames.filter((f) => f.t > a + 0.2 && f.t < b - 0.2);
    if (inner.length > fps && Math.max(...inner.map((f) => f.pan)) < 0.5 && median(inner.map((f) => f.diff)) < 0.3 && !held(a, b)) flags.push(`In the shot from ${s1(a)} to ${s1(b)} neither the camera nor anything else moves.`);
  }

  // The sound against the hits.
  const hits: Watched['hits'] = [];
  if (cuts?.hits.length) {
    if (heard === null) flags.push('The cut list has hits, but the video has no sound.');
    else {
      for (const h of cuts.hits) {
        const near = heard.filter((o) => Math.abs(o.t - h.at) <= 0.5);
        const best = near.sort((x, y) => y.rise - x.rise || Math.abs(x.t - h.at) - Math.abs(y.t - h.at))[0];
        hits.push({ ...h, offset: best ? best.t - h.at : undefined });
        const label = `${s1(h.at)}${h.what ? ` (${h.what})` : ''}`;
        if (!best) flags.push(`No accent in the sound within half a second of the hit at ${label}.`);
        else if (best.t - h.at < -frame) flags.push(`The sound hits ${Math.round((h.at - best.t) * 1000)} ms before the picture at ${label}: more than a frame early reads as wrong.`);
        else if (best.t - h.at > 3 * frame) flags.push(`The sound hits ${Math.round((best.t - h.at) * 1000)} ms after the picture at ${label}: more than three frames late reads as wrong.`);
      }
      const ok = hits.filter((h) => h.offset !== undefined).map((h) => Math.round(h.offset! * 1000));
      if (ok.length) facts.push(`Hits: the sound's accents ${ok.map((o) => `${o > 0 ? '+' : ''}${o} ms`).join(', ')} from the picture's`);
    }
  }
  return { flags, facts, looks, jumps, freezes, stills, fast, steps, hits, cuts };
}

/** The motion over time as a picture: change per frame, freezes, still stretches, jumps, fast moves, shots and hits. */
function timelinePage(w: Watched): { html: string; width: number; height: number } {
  const W = 1600;
  const H = 300;
  const pad = 40;
  const dur = w.frames.length / w.probe.fps;
  const x = (t: number) => pad + ((W - 2 * pad) * t) / Math.max(dur, 0.001);
  const top = Math.max(4, ...w.frames.map((f) => Math.min(f.diff, 40)));
  const y = (v: number) => H - pad - ((H - 2 * pad) * Math.sqrt(Math.min(v, 40))) / Math.sqrt(top);
  const ft = (i: number) => w.frames[i]?.t ?? 0;
  const parts: string[] = [];
  const band = (a: number, b: number, color: string, label: string) => parts.push(`<rect x="${x(a)}" y="${pad}" width="${Math.max(1, x(b) - x(a))}" height="${H - 2 * pad}" fill="${color}"><title>${label}</title></rect>`);
  for (const [a, b] of w.cuts?.holds ?? []) band(a, b, '#dfe9d8', 'hold');
  for (const [a, b] of w.stills) band(ft(a), ft(b), '#f3e7c4', 'still');
  for (const [a, b] of w.freezes) band(ft(a), ft(b), '#d9d9d9', 'frozen');
  for (const [a, b] of w.steps) parts.push(`<rect x="${x(a)}" y="${H - pad - 10}" width="${Math.max(2, x(b) - x(a))}" height="8" fill="#9b6bd6"/>`);
  for (const [a, b] of w.fast) parts.push(`<rect x="${x(ft(a))}" y="${H - pad - 20}" width="${Math.max(2, x(ft(b)) - x(ft(a)))}" height="8" fill="#e08a1e"/>`);
  for (const c of w.cuts?.shots ?? []) parts.push(`<line x1="${x(c)}" x2="${x(c)}" y1="${pad - 6}" y2="${H - pad}" stroke="#555" stroke-dasharray="3 3"/>`);
  for (const i of w.jumps) parts.push(`<line x1="${x(ft(i))}" x2="${x(ft(i))}" y1="${pad}" y2="${H - pad}" stroke="#d23c3c" stroke-width="2"/>`);
  for (const h of w.hits) {
    parts.push(`<path d="M${x(h.at) - 5},${pad - 14} l10,0 l-5,8 z" fill="#2f6fd6"/>`);
    if (h.offset !== undefined) parts.push(`<circle cx="${x(h.at + h.offset)}" cy="${pad - 20}" r="3.5" fill="#2a9d55"/>`);
  }
  const line = w.frames.map((f) => `${x(f.t).toFixed(1)},${y(f.diff).toFixed(1)}`).join(' ');
  parts.push(`<polyline points="${line}" fill="none" stroke="#222" stroke-width="1"/>`);
  for (let t = 0; t <= dur; t += dur > 90 ? 10 : 5) parts.push(`<text x="${x(t)}" y="${H - pad + 16}" font-size="12" text-anchor="middle" fill="#333">${t}s</text>`);
  const key = [
    ['#222', 'change per frame'],
    ['#d9d9d9', 'frozen'],
    ['#f3e7c4', 'almost still'],
    ['#d23c3c', 'jump'],
    ['#e08a1e', 'too fast'],
    ['#9b6bd6', 'hops'],
    ['#2f6fd6', 'hit (cut list)'],
    ['#2a9d55', 'accent in the sound'],
  ]
    .map(([c, l], i) => `<rect x="${pad + i * 190}" y="8" width="12" height="12" fill="${c}"/><text x="${pad + i * 190 + 18}" y="18" font-size="12" fill="#333">${l}</text>`)
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#fff"><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif">${key}${parts.join('')}</svg></body></html>`;
  return { html, width: W, height: H };
}

/** Twelve frames in a row at full size, around a moment, cropped to a quarter of the picture where it moves. */
async function flipbook(file: string, p: Probe, t: number, tile: number, out: string): Promise<boolean> {
  const cw = Math.min(p.width, Math.max(160, Math.round(p.width / 4 / 2) * 2));
  const ch = Math.min(p.height, Math.max(90, Math.round(p.height / 4 / 2) * 2));
  let cx = Math.round((p.width - cw) / 2);
  let cy = Math.round((p.height - ch) / 2);
  if (tile >= 0) {
    const tx = tile % TX;
    const ty = Math.floor(tile / TX);
    cx = Math.round(((tx + 0.5) * p.width) / TX - cw / 2);
    cy = Math.round(((ty + 0.5) * p.height) / TY - ch / 2);
  }
  cx = Math.max(0, Math.min(p.width - cw, cx));
  cy = Math.max(0, Math.min(p.height - ch, cy));
  const r = await run('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', file, '-map', '0:v:0', '-vf', `crop=${cw}:${ch}:${cx}:${cy},tile=4x3:padding=6:color=white`, '-frames:v', '1', out], undefined, 120_000);
  return r.code === 0 && fs.existsSync(out);
}

export const watchTool: ToolDef<WatchInput> = {
  kind: 'read',
  readOnly: true,
  title: (i) => `Watch ${i.path}`,
  async execute(input, ctx: ToolContext): Promise<ToolOutput> {
    const file = resolvePath(ctx.cwd, input.path);
    const shownPath = displayPath(ctx.cwd, file);
    if (!fs.existsSync(file)) return { content: `${shownPath} was not found.`, isError: true };
    let cuts: CutList | undefined;
    if (input.cuts) {
      const cf = resolvePath(ctx.cwd, input.cuts);
      try {
        cuts = parseCuts(fs.readFileSync(cf, 'utf8'));
      } catch (e) {
        return { content: `The cut list ${displayPath(ctx.cwd, cf)} could not be read: ${(e as Error).message}.`, isError: true };
      }
    }
    let p: Probe;
    try {
      p = await probe(file);
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      return { content: missing ? 'Watching a video needs ffmpeg and ffprobe on the PATH, and they were not found.' : `${shownPath}: ${(e as Error).message}.`, isError: true };
    }
    const aw = Math.min(AW, Math.max(64, Math.floor(p.width / 4) * 4));
    const ah = Math.max(8, Math.round((aw * p.height) / p.width / 4) * 4);
    const [frames, heard, loud] = await Promise.all([readFrames(file, p, aw, ah), p.audio ? onsets(file) : Promise.resolve(null), p.audio ? loudness(file) : Promise.resolve({} as { lufs?: number; peak?: number })]);
    if (frames.length < 2) return { content: `${shownPath}: fewer than two frames could be read.`, isError: true };
    const w: Watched = { probe: p, frames, ...judge(p, frames, cuts, heard) };
    if (p.audio) w.facts.push(`Sound ${loud.lufs !== undefined ? `${loud.lufs.toFixed(1)} LUFS` : 'of unknown loudness'}${loud.peak !== undefined ? `, true peak ${loud.peak.toFixed(1)} dBTP` : ''} (a video master sits near -14 LUFS with its peak under -1 dBTP)`);
    else w.facts.push('No sound');

    const dir = path.join(scratchDir(ctx.cwd), 'watch');
    fs.mkdirSync(dir, { recursive: true });
    const stem = path.basename(file).replace(/\.[^.]+$/, '');
    const images: ImagePart[] = [];
    const notes: string[] = [];
    const browser = ctx.browser?.();
    if (browser) {
      try {
        const page = timelinePage(w);
        const shot = await browser.paint(page.html, { width: page.width, height: page.height });
        const out = path.join(dir, `${stem}-timeline.png`);
        fs.writeFileSync(out, shot.png);
        images.push({ type: 'image', mediaType: 'image/png', data: shot.png.toString('base64'), name: `${stem} timeline` });
        notes.push(`the motion timeline (${displayPath(ctx.cwd, out)})`);
      } catch {
        // The numbers stand without the timeline.
      }
    }
    const moments = [...(typeof input.at === 'number' ? [{ t: Math.max(0, input.at), tile: -1, why: `${s1(input.at)}, as asked` }] : []), ...w.looks].slice(0, 3);
    for (const [i, m] of moments.entries()) {
      const out = path.join(dir, `${stem}-frames-${i + 1}.png`);
      if (await flipbook(file, p, m.t, m.tile, out)) {
        images.push({ type: 'image', mediaType: 'image/png', data: fs.readFileSync(out).toString('base64'), name: `${stem} frames ${i + 1}` });
        notes.push(`12 frames in a row at full size from ${s1(m.t)}, ${m.why} (left to right, top to bottom; ${displayPath(ctx.cwd, out)})`);
      }
    }
    const lines = [
      `Watched ${shownPath}: ${w.facts[0]}.`,
      ...w.facts.slice(1).map((f) => `- ${f}.`),
      w.flags.length ? `\nWhat a viewer would notice:\n${w.flags.map((f) => `- ${f}`).join('\n')}` : '\nNothing a viewer would notice in the motion or the timing.',
      notes.length && ctx.model.vision ? `\nAttached: ${notes.join('; ')}.` : '',
      '\nWhat the numbers do not judge: the drawing, the design and whether the film says something; look at the frames at full size for that.',
    ];
    return { content: lines.filter(Boolean).join('\n'), images: ctx.model.vision && images.length ? images : undefined };
  },
};
