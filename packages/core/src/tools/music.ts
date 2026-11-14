import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { listenForBrowser } from '../net/browser-port';
import type { ImagePart } from '../types';
import { arrange, type Arrangement, type PlayedNote } from '../music/arrange';
import { isBedScore, parseScore, ScoreError, type Score } from '../music/score';
import { catalogue, ensureSounds, pickZone, type Zone } from '../music/sounds';
import { pitchName } from '../music/theory';
import { assetsDir, displayPath, resolvePath } from '../util/paths';
import { parseCuts } from './watch';
import type { ToolContext, ToolDef, ToolOutput } from './types';

/**
 * Music from a score the model writes in bars: chords, a tune, its answer, a texture for each other part, dynamics,
 * and the film's moments pinned to bars. Favilla solves the tempo so the moments land, voices and humanises, renders
 * recorded CC0 and public-domain instruments in the browser through one room, sets the loudness, and says what it
 * hears in musical words, bar by bar, since the model cannot listen. Made because a film's score drawn with numpy
 * sine waves was "烂完了" (2026-11-02).
 */

export interface MusicInput {
  /** The score file in the project (.music.yaml), written first when doc is given. */
  path: string;
  doc?: string;
  /** Only the timing: bar times and frames, for animating to the music before it is rendered. */
  plan?: boolean;
  /** Where the WAV goes; beside the score by default. */
  out?: string;
}

/** How each part sits in the mix against the tune: level (dB), a dip where the ear follows a tune, darkening, room. */
const SEAT: Record<string, { level: number; carve: number; lowpass?: number; send: number; pan: number; duck?: number }> = {
  tune: { level: 0, carve: 0, send: 0.22, pan: 0 },
  // An answer speaks between the tune's notes and is often a bright bell: it sits well down to stay an answer.
  answer: { level: -16, carve: 2, send: 0.3, pan: 0.25 },
  // A held pad sounds all the time while struck notes die away: it sits far lower to read as quieter.
  pad: { level: -19, carve: 4, lowpass: 5000, send: 0.38, pan: 0, duck: 6 },
  arp: { level: -11, carve: 3, send: 0.26, pan: -0.22, duck: 3 },
  strike: { level: -10, carve: 3, lowpass: 7000, send: 0.25, pan: -0.15, duck: 3 },
  bass: { level: -7, carve: 0, lowpass: 3000, send: 0.12, pan: 0, duck: 2 },
  line: { level: -7, carve: 2, send: 0.25, pan: 0.15, duck: 3 },
  hits: { level: -3, carve: 0, send: 0.32, pan: 0 },
};

const err = (content: string): ToolOutput => ({ content, isError: true });

/** The level (dBFS, loudest 300 ms RMS of the loudest layer) every instrument is brought to before the mix. */
const REFERENCE_DB = -18;

/** A local page for the browser: the renderer, the samples from the cache, and a place to hand the render back. */
async function serve(files: Map<string, string>, out: string): Promise<{ base: string; close: () => void; received: () => boolean }> {
  const script = fs.readFileSync(path.join(assetsDir(), 'music', 'render.js'), 'utf8');
  let got = false;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/render.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return void res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script}</script></body></html>`);
    }
    const z = /^\/z\/([0-9a-f]{40})$/.exec(url);
    if (req.method === 'GET' && z && files.has(z[1])) {
      const f = files.get(z[1])!;
      res.writeHead(200, { 'Content-Type': f.endsWith('.wav') ? 'audio/wav' : f.endsWith('.m4a') ? 'audio/mp4' : 'audio/ogg' });
      return void fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'POST' && url === '/out') {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const w = fs.createWriteStream(out);
      req.pipe(w);
      w.on('finish', () => {
        got = true;
        res.writeHead(200);
        res.end('ok');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listenForBrowser(server);
  return { base: `http://127.0.0.1:${port}`, close: () => server.close(), received: () => got };
}

/** The piano roll: bars, chords, the parts by colour, the film's moments and the loudness over time. */
function rollPage(score: Score, a: Arrangement, loud: [number, number][]): { html: string; width: number; height: number } {
  const W = 1600;
  const H = 520;
  const L = 50;
  const notes = a.notes.filter((n) => n.key !== null);
  const lo = Math.min(...notes.map((n) => n.key!), 36) - 2;
  const hi = Math.max(...notes.map((n) => n.key!), 84) + 2;
  const x = (t: number) => L + ((W - L - 20) * t) / a.length;
  const y = (k: number) => 60 + ((H - 160) * (hi - k)) / (hi - lo);
  const colours: Record<string, string> = { tune: '#c0392b', answer: '#d68910', pad: '#7fb3d5', arp: '#5b8c5a', bass: '#5d4e75', strike: '#8e7cc3', hits: '#555' };
  const roleOf = (n: PlayedNote) => (colours[n.role] ? n.role : (score.parts.find((p) => p.role === n.role)?.texture.kind ?? 'line'));
  const parts: string[] = [];
  for (const b of a.beatSheet) parts.push(`<line x1="${x(b.time)}" x2="${x(b.time)}" y1="40" y2="${H - 100}" stroke="#ddd"/><text x="${x(b.time) + 2}" y="52" font-size="10" fill="#888">${b.bar}</text>`);
  for (const c of score.chords) parts.push(`<text x="${x(a.tempo.time((c.bar - 1) * score.beatsPerBar + c.beat - 1)) + 2}" y="30" font-size="11" fill="#333">${c.chord.symbol}</text>`);
  for (let k = Math.ceil(lo / 12) * 12; k <= hi; k += 12) parts.push(`<line x1="${L}" x2="${W - 20}" y1="${y(k)}" y2="${y(k)}" stroke="#eee"/><text x="4" y="${y(k) + 4}" font-size="10" fill="#999">${pitchName(k)}</text>`);
  for (const n of notes) parts.push(`<rect x="${x(n.t)}" y="${y(n.key!) - 2}" width="${Math.max(1.5, x(n.t + n.dur) - x(n.t))}" height="4" fill="${colours[roleOf(n)] ?? '#888'}" opacity="${0.35 + (0.6 * n.vel) / 127}"/>`);
  for (const s of a.sync) parts.push(`<line x1="${x(s.time)}" x2="${x(s.time)}" y1="36" y2="${H - 100}" stroke="#2f6fd6" stroke-width="1.5" stroke-dasharray="4 3"/><text x="${x(s.time) + 3}" y="${H - 104}" font-size="11" fill="#2f6fd6">${s.name}</text>`);
  if (loud.length) {
    const ly = (v: number) => H - 20 - Math.max(0, Math.min(1, (v + 40) / 35)) * 60;
    parts.push(`<polyline points="${loud.map(([t, v]) => `${x(t).toFixed(1)},${ly(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#333" stroke-width="1.2"/><text x="4" y="${H - 50}" font-size="10" fill="#666">loudness</text>`);
  }
  const key = Object.entries(colours).map(([r, c], i) => `<rect x="${L + i * 110}" y="${H - 14}" width="10" height="10" fill="${c}"/><text x="${L + i * 110 + 14}" y="${H - 5}" font-size="11" fill="#333">${r}</text>`).join('');
  return { html: `<!doctype html><html><body style="margin:0;background:#fff"><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif">${parts.join('')}${key}</svg></body></html>`, width: W, height: H };
}

export const musicTool: ToolDef<MusicInput> = {
  kind: 'draw',
  readOnly: false,
  title: (i, cwd) => `Music ${displayPath(cwd, resolvePath(cwd, i.path))}`,
  async execute(input, ctx: ToolContext): Promise<ToolOutput> {
    const abs = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, abs);
    if (!/\.(ya?ml)$/i.test(abs)) return err(`${shown}: a score is a .music.yaml file.`);
    if (input.doc !== undefined) {
      const why = fs.existsSync(abs) ? (ctx.mayChange?.(abs) ?? ctx.files.checkEditable(abs)) : undefined;
      if (why) return err(`${shown} already exists. ${why}`);
      ctx.checkpoints.capture(ctx.turn, abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, input.doc);
      ctx.files.recordWrite(abs);
    }
    if (!fs.existsSync(abs)) return err(`${shown} does not exist; give doc to write it.`);
    let score: Score;
    try {
      score = parseScore(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      return err(`${shown}: ${(e as Error).message}`);
    }
    const cat = catalogue();
    const palette = cat.palettes[score.palette];
    if (!palette) return err(`palette: ${score.palette} is not one of ${Object.keys(cat.palettes).join(', ')} (${Object.entries(cat.palettes).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ')}).`);
    const unknown = score.parts.filter((p) => !cat.instruments[p.instrument]);
    if (unknown.length) return err(`No instrument called ${unknown.map((p) => p.instrument).join(', ')}. The instruments: ${Object.keys(cat.instruments).join(', ')}.`);
    // The film's moments from its cut list: those the score has not pinned are placed and reported.
    if (score.cutsFile) {
      try {
        const beside = resolvePath(path.dirname(abs), score.cutsFile);
        const cutsPath = fs.existsSync(beside) ? beside : resolvePath(ctx.cwd, score.cutsFile);
        const cuts = parseCuts(fs.readFileSync(cutsPath, 'utf8'));
        for (const h of cuts.hits) if (!score.sync.some((s) => Math.abs(s.at - h.at) < 0.1)) score.sync.push({ at: h.at, name: h.what ?? `hit at ${h.at}s`, hit: 'accent' });
        score.sync.sort((a, b) => a.at - b.at);
      } catch (e) {
        return err(`cuts: ${score.cutsFile} could not be read: ${(e as Error).message}`);
      }
    }
    const ranges = Object.fromEntries(Object.entries(cat.instruments).filter(([, v]) => v.range).map(([k, v]) => [k, v.range!])) as Record<string, [number, number]>;
    let a: Arrangement;
    try {
      a = arrange(score, { ranges, palette });
    } catch (e) {
      return err(`${shown}: ${e instanceof ScoreError ? e.message : (e as Error).message}`);
    }
    const stem = abs.replace(/(\.music)?\.ya?ml$/i, '');
    const beatsFile = `${stem}.beats.json`;
    fs.writeFileSync(beatsFile, JSON.stringify({ fps: score.fps, bars: a.beatSheet, sync: a.sync.map((s) => ({ name: s.name, at: s.at, bar: s.bar, beat: +s.beat.toFixed(3), time: +s.time.toFixed(4), frame: Math.round(s.time * score.fps) })) }, null, 1));
    ctx.files.recordWrite(beatsFile);
    const syncText = [`SYNC    ${a.report.sync.join(' ')}`, ...a.report.notes.map((l) => `        ${l}`)];
    if (input.plan) {
      return { content: [`Timed ${shown}: ${score.bars} bars, ${a.length.toFixed(1)} s. Bar times and frames are in ${displayPath(ctx.cwd, beatsFile)}, for timing the pictures to the music.`, ...syncText].join('\n') };
    }

    const outside = [...new Set(score.parts.map((p) => p.instrument).filter((i) => !palette.includes(i)))];
    const browser = ctx.browser?.();
    if (!browser) return err('Rendering music needs Chrome, Chromium or Edge, and none was found (Settings > Tools sets its path).');
    // Every note's sample, its pitch shift and its gain; the parts by role with their seat in the mix.
    const used = new Map<string, { source: string; zone: Zone }>();
    const parts = new Map<string, { role: string; sustained: boolean; levelDb: number; carve: number; lowpass?: number; send: number; duck?: number; notes: unknown[] }>();
    let stretched = 0;
    for (const n of a.notes) {
      const ins = cat.instruments[n.instrument];
      if (!ins) continue;
      const pick = pickZone(ins, n.key, n.vel, n.swell);
      if (n.key !== null && pick.zone.key !== null && Math.abs(n.key - pick.zone.key) > 4) stretched++;
      used.set(pick.zone.sha, { source: ins.source, zone: pick.zone });
      const kind = score.parts.find((p) => p.role === n.role)?.texture.kind ?? 'line';
      const seat = SEAT[n.role] ?? SEAT[kind] ?? SEAT.line;
      const part = score.parts.find((p) => p.role === n.role);
      const key = `${n.role}|${n.instrument}`;
      if (!parts.has(key)) parts.set(key, { role: n.role, sustained: ins.kind === 'sustained', levelDb: seat.level + (part?.level ?? 0), carve: seat.carve, lowpass: seat.lowpass, send: seat.send, duck: seat.duck, notes: [] });
      const spread = kind === 'pad' && n.key !== null ? Math.max(-0.5, Math.min(0.5, (n.key - 64) / 40)) : 0;
      // Libraries record at levels 25 dB apart: every instrument first comes to one reference, then the mix seats it.
      const calibrate = REFERENCE_DB - (ins.level ?? REFERENCE_DB);
      parts.get(key)!.notes.push({ url: `/z/${pick.zone.sha}`, rate: pick.rate, gainDb: pick.gainDb + calibrate, t: n.t, dur: n.swell ?? n.dur, attack: ins.kind === 'sustained' ? (ins.attack ?? 0.1) : 0.003, release: ins.release ?? 0.3, pan: seat.pan + spread });
    }
    let fetched: { files: Map<string, string>; fetched: number; bytes: number };
    try {
      fetched = await ensureSounds([...used.values()], { proxy: ctx.proxy, signal: ctx.signal });
    } catch (e) {
      return err(`The instruments could not be fetched: ${(e as Error).message}. They come from GitHub the first time; check the network or the proxy.`);
    }
    const out = resolvePath(ctx.cwd, input.out ?? `${stem}.wav`);
    ctx.checkpoints.capture(ctx.turn, out);
    const server = await serve(fetched.files, out);
    let m: { seconds: number; lufs: number; truePeak: number; range: number; limited: number; highShare: number; front: { role: string; median: number; worst: number; over: number; overall: number }[]; apart?: { role: string; overall: number }[]; shortTerm: [number, number][]; samples: number };
    try {
      const tune = a.notes.filter((n) => n.role === 'tune');
      const job = { tuneSpans: tune.map((n) => [n.t, n.t + 0.5 * n.dur]), tuneNotes: tune.map((n) => [n.t, n.dur]), length: a.length, room: score.room, lufs: score.loudness.lufs, peak: score.loudness.peak, fade: score.end.fade, out: `${server.base}/out`, parts: [...parts.values()] };
      m = (await browser.evaluatePage(`${server.base}/render.html`, `window.__music(${JSON.stringify(job)})`, 600_000)) as typeof m;
    } catch (e) {
      return err(`Rendering failed: ${(e as Error).message.slice(0, 600)}`);
    } finally {
      server.close();
    }
    if (!server.received() || !fs.existsSync(out)) return err('Rendering finished but no sound came back.');
    ctx.files.recordWrite(out);

    const isBed = isBedScore(score);
    const hasTune = a.notes.some((n) => n.role === 'tune' && n.key !== null);
    const front = [...m.front].sort((x, y) => x.worst - y.worst);
    // An answer speaks in the tune's long notes and rests, in front by design; the rest must stay under it (except under bed, where no lead tune competes with speech).
    const inFront = isBed ? [] : front.filter((f) => f.role !== 'answer' && (f.worst < 3 || f.over > 0.02));
    const gap = score.loudness.lufs - m.lufs;
    const atCeiling = m.truePeak >= score.loudness.peak - 0.2 && gap >= 0.25 && gap <= 4.5;
    const mix = [
      `${m.lufs.toFixed(1)} LUFS (target ${score.loudness.lufs}${atCeiling ? `; at the ${score.loudness.peak} dBTP peak ceiling, ${gap.toFixed(1)} LU below target — ready to deliver, do not keep re-rendering for loudness` : ''}), true peak ${m.truePeak.toFixed(1)} dBTP (ceiling ${score.loudness.peak}); 3 s loudness range ${m.range.toFixed(1)} dB${!isBed && m.range > 15 ? ' (wide: the quiet bars may vanish on a phone speaker)' : ''}; ${(m.highShare * 100).toFixed(1)}% of the energy above 8 kHz${m.limited > (atCeiling ? 0.06 : 0.02) ? `; the limiter worked on ${(m.limited * 100).toFixed(0)}% of the samples (thin the loudest bars)` : ''}.`,
      isBed
        ? 'Voiceover bed balance: accompaniment-over-tune checks are off so soft textures stay warm under speech.'
        : inFront.length
          ? `In front of the tune where the ear follows it: ${inFront.map((f) => `${f.role} (${f.worst.toFixed(0)} dB under it at its closest${f.over > 0.02 ? `, over it ${Math.round(f.over * 100)}% of the time` : ''})`).join(', ')}: lower that part's level, thin it, or move it away from the tune's register.`
          : 'Nothing in front of the tune.',
      !isBed && front.length ? `Each part under the tune where the ear follows it (1-4 kHz, typical/closest; 8 dB or more keeps the tune in front) and overall: ${front.map((f) => `${f.role} ${f.median.toFixed(0)}/${f.worst.toFixed(0)} dB, ${f.overall.toFixed(0)} dB overall`).join('; ')}.${front.some((f) => f.overall > 18) ? ` ${front.filter((f) => f.overall > 18).map((f) => f.role).join(', ')} barely heard: raise its level.` : ''}` : '',
      !isBed && m.apart?.length ? `Speaking in the tune's gaps: ${m.apart.map((x) => `${x.role} ${x.overall.toFixed(0)} dB under the tune when it speaks`).join('; ')}.` : '',
    ].filter(Boolean);
    const credits = [...new Set([...used.values()].map((u) => u.source))].map((s) => cat.sources[s]?.credit).filter(Boolean);
    const sounds = `${[...new Set(score.parts.map((p) => p.instrument))].join(', ')}${outside.length ? ` (${outside.join(', ')} from outside the ${score.palette} palette: one family of sounds per piece)` : ''}; ${m.samples} samples${fetched.fetched ? `, ${fetched.fetched} fetched now (${(fetched.bytes / 1e6).toFixed(1)} MB)` : ''}${stretched ? `; ${stretched} note${stretched === 1 ? '' : 's'} pitched more than 4 semitones from its sample` : ''}. Credits: ${credits.join('; ')}.`;
    const lines = [
      `Rendered ${displayPath(ctx.cwd, out)} (${a.length.toFixed(1)} s, 48 kHz, 24-bit) in ${m.seconds.toFixed(0)} s, and ${displayPath(ctx.cwd, beatsFile)} (bar times and frames).`,
      ...syncText,
      `WRITING ${a.report.writing.join(' ')}`,
      ...(hasTune ? [`TUNE    ${a.report.tune.join(' ')}`] : []),
      `MIX     ${mix.join(' ')}`,
      `SOUNDS  ${sounds}`,
      isBed && !hasTune
        ? 'What no number judges: whether the bed stays warm and steady without pulling attention from speech.'
        : 'What no number judges: whether the tune is good and fun to hum. Read the music skill\'s list before calling it done; the person\'s ear decides.',
    ];
    let images: ImagePart[] | undefined;
    if (ctx.model.vision) {
      try {
        const page = rollPage(score, a, m.shortTerm);
        const shot = await browser.paint(page.html, { width: page.width, height: page.height });
        images = [{ type: 'image', mediaType: 'image/png', data: shot.png.toString('base64'), name: `${path.basename(stem)} piano roll` }];
        lines[0] += ' The piano roll is attached.';
      } catch {
        // The report stands without the picture.
      }
    }
    return { content: lines.join('\n'), images };
  },
};
