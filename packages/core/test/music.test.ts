import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { arrange, solveTempo } from '../src/music/arrange';
import { isBedScore, parseScore, ScoreError } from '../src/music/score';
import { catalogue, pickZone } from '../src/music/sounds';
import { parseChord, parsePitch, pitchName, voice } from '../src/music/theory';
import { BrowserSession, findBrowser } from '../src/tools/browser';
import { musicTool } from '../src/tools/music';
import type { ToolContext } from '../src/tools/types';

const skill = fs.readFileSync(path.join(__dirname, '..', 'assets', 'skills', 'music', 'SKILL.md'), 'utf8');
const worked = skill.slice(skill.indexOf('```yaml') + 8, skill.indexOf('```', skill.indexOf('```yaml') + 8));
const cat = catalogue();
const ranges = Object.fromEntries(Object.entries(cat.instruments).filter(([, v]) => v.range).map(([k, v]) => [k, v.range!])) as Record<string, [number, number]>;

describe('music theory', () => {
  it('reads pitches and chord symbols', () => {
    expect(parsePitch('C4')).toBe(60);
    expect(parsePitch('F#5')).toBe(78);
    expect(parsePitch('Bb3')).toBe(58);
    expect(pitchName(61)).toBe('C#4');
    const c = (s: string) => {
      const ch = parseChord(s)!;
      return ch.intervals.map((i) => i % 12).sort((a, b) => a - b);
    };
    expect(c('Dmaj9')).toEqual([0, 2, 4, 7, 11]);
    expect(c('Bm7')).toEqual([0, 3, 7, 10]);
    expect(c('A7sus4')).toEqual([0, 5, 7, 10]);
    expect(c('Gm6')).toEqual([0, 3, 7, 9]);
    expect(c('F#m7b5')).toEqual([0, 3, 6, 10]);
    expect(parseChord('D/F#')!.bass).toBe(6);
    expect(parseChord('Hmaj7')).toBeNull();
  });

  it('voices a chord under the tune: the bass alone, no third below C3, colour kept, nothing over the ceiling', () => {
    const v = voice(parseChord('Dmaj9')!, { top: 71, voices: 3 });
    expect(v.bass).toBeGreaterThanOrEqual(28);
    expect(v.bass).toBeLessThanOrEqual(52);
    expect(v.bass % 12).toBe(2);
    expect(Math.max(...v.upper)).toBeLessThanOrEqual(71);
    expect(v.upper[0] - v.bass).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < v.upper.length; i++) if (v.upper[i] - v.upper[i - 1] <= 4) expect(v.upper[i - 1]).toBeGreaterThanOrEqual(48);
    // The ninth (E) and the major seventh (C#) are both there.
    expect(v.upper.map((p) => p % 12)).toEqual(expect.arrayContaining([4, 1]));
    // Under a held tune D the major seventh C# gives way.
    const under = voice(parseChord('Dmaj9')!, { top: 71, voices: 3, avoid: [1] });
    expect(under.upper.map((p) => p % 12)).not.toContain(1);
  });
});

describe('a score in bars', () => {
  it('names the bar of every mistake', () => {
    const base = 'key: C major\nmeter: 4/4\ntempo: 90\nparts:\n  tune: piano\nchords: "C | F | G | C"\n';
    expect(() => parseScore(`${base}tune: "C5:2 D5:1 | E5:4"`)).toThrow(/tune bar 1: 3 beats in a bar of 4/);
    expect(() => parseScore(`${base}tune: "C5:4 | X5:4"`)).toThrow(/tune bar 2: "X5" is not a pitch/);
    expect(() => parseScore(`${base.replace('C | F | G | C', 'C | Q | G | C')}tune: "C5:4"`)).toThrow(/chords bar 2: "Q" is not a chord symbol/);
    expect(() => parseScore(`${base.replace('  tune: piano', '  lead: piano')}`)).toThrow(ScoreError);
    // Sharps are not comments.
    expect(parseScore(`${base}tune: "C#5:2 F#5:2 # a comment"`).lines.tune.map((n) => n.pitch)).toEqual([73, 78]);
  });

  it('solves the tempo so pinned moments land on their bars, and places the rest on the nearest 16th', () => {
    const score = parseScore(worked);
    const { map } = solveTempo(score);
    expect(map.time(3 * 4)).toBeCloseTo(9.1, 6);
    expect(map.time(6 * 4)).toBeCloseTo(18.3, 6);
    expect(map.time(11 * 4)).toBeCloseTo(33.5, 6);
    expect(map.time(16 * 4)).toBeCloseTo(49.0, 6);
    expect(map.segments.map((s) => s.bpm.toFixed(2)).slice(0, 4)).toEqual(['79.12', '78.26', '78.95', '77.42']);
    score.sync.push({ at: 38.7, name: 'last fold', hit: 'accent' });
    const a = arrange(score, { ranges, palette: cat.palettes.chamber });
    const placed = a.sync.find((s) => s.name === 'last fold')!;
    expect(placed.bar).toBe(13);
    expect(Math.round(placed.errorMs)).toBe(31);
  });

  it('plays the worked cue within every instrument, with the moments marked and nothing reaching up to the tune', () => {
    const a = arrange(parseScore(worked), { ranges, palette: cat.palettes.chamber });
    for (const n of a.notes) {
      const r = ranges[n.instrument];
      if (r && n.key !== null && n.role !== 'tune' && n.role !== 'answer') expect(n.key).toBeGreaterThanOrEqual(r[0]);
    }
    expect(a.notes.filter((n) => n.role === 'hits').map((n) => n.instrument)).toEqual(expect.arrayContaining(['timpani', 'cymbal']));
    expect(a.report.writing.join(' ')).toMatch(/stays under the tune/);
    expect(a.report.writing.join(' ')).not.toMatch(/outside its/);
    expect(a.report.tune.join(' ')).toMatch(/Enters at 9\.1 s \(bar 4\)/);
    expect(a.beatSheet[3]).toEqual({ bar: 4, time: 9.1, frame: 218 });
    // Velocities are whole numbers, and the struck notes are a few milliseconds off the grid.
    expect(a.notes.every((n) => Number.isInteger(n.vel))).toBe(true);
  });

  it('plays a texture on a drum as one stroke a beat, not a chord of strokes', () => {
    const score = parseScore('key: G major\nmeter: 4/4\ntempo: 96\npalette: mallets\nparts:\n  tune: marimba\n  comp: {instrument: frame drum, strike: "2 4"}\nchords: "G6 | Cmaj7"\ntune: "G5:4 | B5:4"\n');
    const strokes = arrange(score, { ranges, palette: cat.palettes.mallets }).notes.filter((n) => n.role === 'comp');
    expect(strokes).toHaveLength(4);
    expect(strokes.every((n) => n.key === null)).toBe(true);
  });

  it('picks the layer by velocity and the nearest sample by key', () => {
    const piano = cat.instruments.piano;
    const soft = pickZone(piano, 60, 30);
    const loud = pickZone(piano, 60, 110);
    expect(soft.zone.vel[1]).toBeLessThan(loud.zone.vel[0]);
    expect(Math.abs(Math.log2(soft.rate) * 12)).toBeLessThanOrEqual(2);
    const swell = pickZone(cat.instruments.cymbal, null, 80, 3);
    expect(swell.zone.swell).toBe(2);
  });

  it('pads trailing rest on the final bar, allows voiceover beds without a tune, and hints when sync pins jump tempo', () => {
    const buttonEnd = parseScore('key: D major\nmeter: 4/4\ntempo: 96\nparts:\n  tune: piano\nchords: "Dmaj7 | A7:2"\ntune: "F#5:4 | D5:1.5"\n');
    expect(buttonEnd.lines.tune.filter((n) => n.bar === 2)).toEqual([
      { bar: 2, beat: 1, dur: 1.5, pitch: 74 },
      { bar: 2, beat: 2.5, dur: 2.5, pitch: null },
    ]);

    const bedScore = parseScore('key: F major\nmeter: 4/4\ntempo: 76\nloudness: bed\nparts:\n  pad: {instrument: strings, pad: true}\n  pulse: {instrument: harp, arp: "0 2 1 2", unit: 0.5}\nchords: "Fmaj7 | Dm9 | Bbmaj7 | C7sus4"\n');
    expect(bedScore.parts.find((p) => p.role === 'tune')).toBeUndefined();
    const bedArr = arrange(bedScore, { ranges, palette: cat.palettes.chamber });
    expect(bedArr.report.writing.join(' ')).toContain('stay voiced warm under speech');
    expect(bedArr.report.writing.join(' ')).not.toContain('reaches up to the tune');
    expect(bedArr.report.tune.join(' ')).not.toContain('more rest than tune');

    const pinned = parseScore('key: C major\nmeter: 4/4\ntempo: 96\nlength: 20\nsync:\n  - {at: 5.0, bar: 3, beat: 1, name: cutA}\n  - {at: 11.2, bar: 5, beat: 1, name: cutB}\nparts:\n  tune: piano\nchords: "C | G | Am | F | C | G | C | C"\ntune: "C5:4 | B4:4 | A4:4 | G4:4 | E5:4 | D5:4 | C5:4 | C5:4"\n');
    const solved = solveTempo(pinned);
    // Pins remain exact as written, with a concrete suggestion for nearby beats.
    expect(solved.map.time(2 * 4)).toBeCloseTo(5.0, 6);
    expect(solved.map.time(4 * 4)).toBeCloseTo(11.2, 6);
    expect(solved.lines.join(' ')).toContain('Nearby lower-step pins:');
    expect(isBedScore(bedScore)).toBe(true);
    expect(isBedScore(pinned)).toBe(false);
  });

  it('resolves cuts beside the score first, then falls back to cwd', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-music-cuts-'));
    try {
      const work = path.join(tmp, 'work');
      const scratch = path.join(tmp, 'scratch');
      fs.mkdirSync(work, { recursive: true });
      fs.mkdirSync(scratch, { recursive: true });
      fs.writeFileSync(path.join(work, 'cuts.yaml'), 'fps: 24\nhits:\n  - {at: 2.0, what: cwdMarker}\n');
      const ctx = {
        cwd: work,
        turn: 't1',
        model: { vision: false },
        checkpoints: { capture: () => {} },
        files: { recordWrite: () => {}, checkEditable: () => undefined },
      } as unknown as ToolContext;
      const doc = 'key: C major\nmeter: 4/4\ntempo: 120\ncuts: cuts.yaml\nparts:\n  tune: piano\nchords: "C | G | Am | F"\ntune: "C5:4 | B4:4 | A4:4 | G4:4"\n';

      // No cuts.yaml in scratch -> falls back to work/cuts.yaml.
      const fromCwd = await musicTool.execute({ path: path.join(scratch, 'draft.music.yaml'), doc, plan: true }, ctx);
      expect(fromCwd.isError).toBeFalsy();
      expect(fromCwd.content).toContain('cwdMarker');

      // When cuts.yaml also exists beside the score, the one beside the score wins.
      fs.writeFileSync(path.join(scratch, 'cuts.yaml'), 'fps: 24\nhits:\n  - {at: 2.0, what: besideMarker}\n');
      const beside = await musicTool.execute({ path: path.join(scratch, 'draft2.music.yaml'), doc, plan: true }, ctx);
      expect(beside.isError).toBeFalsy();
      expect(beside.content).toContain('besideMarker');
      expect(beside.content).not.toContain('cwdMarker');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!findBrowser())('reports the level of an answer part that speaks in the tune gaps', async () => {
    const sr = 48000;
    const n = sr; // 1 s mono 16-bit WAV at 440 Hz
    const wav = Buffer.alloc(44 + n * 2);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + n * 2, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sr, 24);
    wav.writeUInt32LE(sr * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / sr)), 44 + i * 2);

    const script = fs.readFileSync(path.join(__dirname, '..', 'assets', 'music', 'render.js'), 'utf8');
    const server = http.createServer((req, res) => {
      if (req.url === '/render.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return void res.end(`<!doctype html><html><body><script>${script}</script></body></html>`);
      }
      if (req.url === '/tone.wav') {
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        return void res.end(wav);
      }
      if (req.method === 'POST' && req.url === '/out') {
        req.resume();
        req.on('end', () => {
          res.writeHead(200);
          res.end('ok');
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = new BrowserSession(findBrowser()!, false);
    try {
      await browser.start();
      const job = {
        tuneSpans: [[0, 0.8], [2.0, 2.8]],
        tuneNotes: [[0, 1.0], [2.0, 1.0]],
        length: 4.0,
        room: 'dry',
        lufs: -14,
        peak: -1.2,
        fade: 0.2,
        out: `${base}/out`,
        parts: [
          { role: 'tune', sustained: false, levelDb: 0, carve: 0, send: 0.1, notes: [{ url: `${base}/tone.wav`, rate: 1, gainDb: 0, t: 0, dur: 0.9, attack: 0.01, release: 0.1, pan: 0 }, { url: `${base}/tone.wav`, rate: 1, gainDb: 0, t: 2.0, dur: 0.9, attack: 0.01, release: 0.1, pan: 0 }] },
          { role: 'answer', sustained: false, levelDb: -12, carve: 2, send: 0.1, notes: [{ url: `${base}/tone.wav`, rate: 1.5, gainDb: 0, t: 1.1, dur: 0.7, attack: 0.01, release: 0.1, pan: 0.2 }, { url: `${base}/tone.wav`, rate: 1.5, gainDb: 0, t: 3.1, dur: 0.7, attack: 0.01, release: 0.1, pan: 0.2 }] },
        ],
      };
      const m = (await browser.evaluatePage(`${base}/render.html`, `window.__music(${JSON.stringify(job)})`, 30_000)) as { front: { role: string }[]; apart: { role: string; overall: number }[] };
      expect(m.front.find((f) => f.role === 'answer')).toBeUndefined();
      const ans = m.apart.find((a) => a.role === 'answer');
      expect(ans).toBeDefined();
      expect(ans!.overall).toBeGreaterThan(9);
      expect(ans!.overall).toBeLessThan(15);
    } finally {
      browser.close();
      server.close();
    }
  }, 30_000);
});
