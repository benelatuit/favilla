import { parse as parseYaml } from 'yaml';
import { parseChord, parseKey, parsePitch, type Chord, type Key } from './theory';

/**
 * A score as the model writes it: in bars, not seconds. Chords by symbol, the tune and its answer as PITCH:BEATS
 * tokens bar by bar, a texture for each other part, a dynamics line, and the film's moments pinned to bars. Favilla
 * voices, times, plays and mixes it (music/arrange.ts). Every error names the bar it is in.
 */

export type HitKind = 'arrive' | 'accent' | 'swell' | 'button' | 'none';

export interface SyncPoint {
  at: number;
  bar?: number;
  beat?: number;
  name: string;
  hit: HitKind;
}

export interface Note {
  bar: number;
  /** 1-based, fractional within the bar. */
  beat: number;
  dur: number;
  pitch: number | null;
}

export type Texture = { kind: 'line' } | { kind: 'arp'; pattern: number[]; unit: number } | { kind: 'pad' } | { kind: 'bass'; beats: number[] } | { kind: 'strike'; beats: number[] };

export interface Part {
  role: string;
  instrument: string;
  texture: Texture;
  bars?: Set<number>;
  octave: number;
  /** Level against the tune in dB; from the role when not given. */
  level?: number;
}

export interface ChordSpan {
  bar: number;
  beat: number;
  dur: number;
  chord: Chord;
}

export interface Dynamic {
  bar: number;
  level: string;
  hairpin?: '<' | '>';
}

export interface Score {
  name: string;
  key: Key;
  beatsPerBar: number;
  beatUnit: number;
  tempo: number;
  length?: number;
  fps: number;
  palette: string;
  room: string;
  loudness: { lufs: number; peak: number; name: string };
  sync: SyncPoint[];
  parts: Part[];
  chords: ChordSpan[];
  lines: Record<string, Note[]>;
  dynamics: Dynamic[];
  bars: number;
  end: { ring: boolean; fade: number };
  /** The rhythm cells by name, in beats. */
  cells: Record<string, number[]>;
  cutsFile?: string;
}

export class ScoreError extends Error {}

const LOUDNESS: Record<string, { lufs: number; peak: number }> = {
  film: { lufs: -14, peak: -1.2 },
  video: { lufs: -14, peak: -1.2 },
  game: { lufs: -17, peak: -1 },
  quiet: { lufs: -20, peak: -2 },
  bed: { lufs: -24, peak: -3 },
};
const DYN = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
const HITS: HitKind[] = ['arrive', 'accent', 'swell', 'button', 'none'];

/** Bar numbers from "1-11 13-16" or [1, 2, 3]. */
export function barSet(v: unknown, where: string): Set<number> | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const out = new Set<number>();
  const parts = Array.isArray(v) ? v.map(String) : String(v).split(/[\s,]+/).filter(Boolean);
  for (const p of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(p);
    if (!m) throw new ScoreError(`${where}: "${p}" is not a bar or a range of bars (like 1-8)`);
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i);
  }
  return out;
}

/** Text in bars: "N:" starts at bar N, "|" ends a bar; items are what `item` makes of each bar's text. */
function barsOf<T>(text: string, where: string, item: (bar: number, body: string) => T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  let bar = 1;
  for (const raw of text.split('\n')) {
    // A comment is a # after a space: F#5 and C#m7 keep theirs.
    let line = raw.replace(/(^|\s)#(\s.*)?$/, '').trim();
    if (!line) continue;
    const start = /^(\d+)\s*:\s*/.exec(line);
    if (start) {
      bar = Number(start[1]);
      line = line.slice(start[0].length);
    }
    const cells = line.split('|');
    cells.forEach((cell, i) => {
      const body = cell.trim();
      // A trailing "|" closes the bar before it and opens nothing.
      if (!body && i === cells.length - 1) return;
      if (out.has(bar)) throw new ScoreError(`${where} bar ${bar} is written twice`);
      out.set(bar, item(bar, body));
      bar++;
    });
  }
  return out;
}

function lineNotes(text: string, role: string, beatsPerBar: number, cells: Record<string, number[]>): Note[] {
  const notes: Note[] = [];
  const rawBars = barsOf(text, role, (_bar, body) => [body]);
  const lastBar = Math.max(0, ...rawBars.keys());
  for (const [bar, [body]] of rawBars) {
    const out: Note[] = [];
    let beat = 1;
    const push = (pitchText: string, dur: number) => {
      const pitch = /^r$/i.test(pitchText) ? null : parsePitch(pitchText);
      if (pitch === undefined || (pitch === null && !/^r$/i.test(pitchText))) throw new ScoreError(`${role} bar ${bar}: "${pitchText}" is not a pitch (like F#5) or r`);
      if (!(dur > 0)) throw new ScoreError(`${role} bar ${bar}: a note of ${dur} beats`);
      out.push({ bar, beat, dur, pitch });
      beat += dur;
    };
    for (const tok of body.match(/[A-Za-z]\w*\([^)]*\)|\S+/g) ?? []) {
      const cell = /^([A-Za-z]\w*)\(([^)]*)\)$/.exec(tok);
      if (cell) {
        const rhythm = cells[cell[1]];
        if (!rhythm) throw new ScoreError(`${role} bar ${bar}: no rhythm cell named ${cell[1]} (cells: ${Object.keys(cells).join(', ') || 'none'})`);
        const pitches = cell[2].trim().split(/\s+/).filter(Boolean);
        if (pitches.length !== rhythm.length) throw new ScoreError(`${role} bar ${bar}: ${cell[1]} has ${rhythm.length} notes, ${pitches.length} pitches given`);
        pitches.forEach((p, i) => push(p, rhythm[i]));
        continue;
      }
      const m = /^([^:]+):([\d.]+)$/.exec(tok);
      if (!m) throw new ScoreError(`${role} bar ${bar}: "${tok}" is not PITCH:BEATS (like A5:1.5 or r:1)`);
      push(m[1], Number(m[2]));
    }
    const used = beat - 1;
    if (bar === lastBar && used > 1e-6 && used < beatsPerBar - 1e-6) {
      out.push({ bar, beat, dur: +(beatsPerBar - used).toFixed(6), pitch: null });
      beat = beatsPerBar + 1;
    }
    if (Math.abs(beat - 1 - beatsPerBar) > 1e-6) throw new ScoreError(`${role} bar ${bar}: ${+(beat - 1).toFixed(3)} beats in a bar of ${beatsPerBar}`);
    notes.push(...out);
  }
  return notes.sort((a, b) => a.bar - b.bar || a.beat - b.beat);
}

const numbers = (v: unknown, where: string): number[] => {
  const xs = (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\s,]+/)).filter(Boolean).map(Number);
  if (xs.some((x) => !Number.isFinite(x))) throw new ScoreError(`${where}: "${String(v)}" should be numbers`);
  return xs;
};

/** The parts: role -> instrument, or role -> {instrument, arp | pad | beats | strike, unit, bars, octave, level}. */
function partsOf(raw: Record<string, unknown>, texture: Record<string, unknown> | undefined): Part[] {
  const parts: Part[] = [];
  for (const [role, v] of Object.entries(raw)) {
    const o = (typeof v === 'string' ? { instrument: v } : v) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || typeof o.instrument !== 'string') throw new ScoreError(`parts.${role}: give an instrument (like "${role}: piano")`);
    // A texture written apart, under the instrument's or the role's name.
    const t = { ...((texture?.[o.instrument] as object) ?? {}), ...((texture?.[role] as object) ?? {}), ...o } as Record<string, unknown>;
    const where = `parts.${role}`;
    let tx: Texture = { kind: 'line' };
    if (t.arp !== undefined) tx = { kind: 'arp', pattern: numbers(t.arp, `${where}.arp`), unit: Number(t.unit ?? 0.5) };
    else if (t.pad) tx = { kind: 'pad' };
    else if (t.bass !== undefined || t.beats !== undefined) tx = { kind: 'bass', beats: numbers(t.bass ?? t.beats, `${where}.beats`) };
    else if (t.strike !== undefined) tx = { kind: 'strike', beats: numbers(t.strike, `${where}.strike`) };
    else if (role !== 'tune' && role !== 'answer') throw new ScoreError(`${where}: say how it plays: arp, pad, beats (a bass) or strike, or name it tune or answer and write its line`);
    if (tx.kind === 'arp' && !(tx.unit > 0)) throw new ScoreError(`${where}.unit: a note length in beats, like 0.5`);
    parts.push({ role, instrument: o.instrument, texture: tx, bars: barSet(t.bars, `${where}.bars`), octave: Number(t.octave ?? 0) || 0, level: typeof t.level === 'number' ? t.level : undefined });
  }
  return parts;
}

export function isBedScore(score: Pick<Score, 'loudness'>): boolean {
  return score.loudness.name === 'bed' || score.loudness.lufs <= -22;
}

export function parseScore(text: string): Score {
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(text) as Record<string, unknown>;
  } catch (e) {
    throw new ScoreError(`The score is not valid YAML: ${(e as Error).message.split('\n')[0]}`);
  }
  if (!raw || typeof raw !== 'object') throw new ScoreError('The score is a YAML document with key, meter, tempo, parts, chords and tune.');
  const meter = /^(\d+)\/(\d+)$/.exec(String(raw.meter ?? '4/4'));
  if (!meter) throw new ScoreError(`meter: "${raw.meter}" is not like 4/4 or 3/4 or 6/8`);
  // 6/8 and the like are felt in dotted beats; the score still counts in its written unit.
  const beatsPerBar = Number(meter[1]);
  const beatUnit = Number(meter[2]);
  let key: Key;
  try {
    key = parseKey(String(raw.key ?? 'C major'));
  } catch (e) {
    throw new ScoreError(`key: ${(e as Error).message}`);
  }
  const tempo = Number(raw.tempo ?? 90);
  if (!(tempo >= 30 && tempo <= 260)) throw new ScoreError(`tempo: ${raw.tempo} bpm is outside 30-260`);
  const cells: Record<string, number[]> = {};
  for (const [name, v] of Object.entries((raw.cells as Record<string, unknown>) ?? {})) cells[name] = numbers(v, `cells.${name}`);
  const loud = raw.loudness;
  const loudness = typeof loud === 'number' ? { lufs: loud, peak: -1.2, name: `${loud} LUFS` } : { ...(LOUDNESS[String(loud ?? 'film')] ?? LOUDNESS.film), name: String(loud ?? 'film') };
  const isBed = isBedScore({ loudness });
  if (!raw.parts || typeof raw.parts !== 'object') throw new ScoreError('parts: name the roles and their instruments (tune: piano, pad: {instrument: strings, pad: true}, ...)');
  const parts = partsOf(raw.parts as Record<string, unknown>, raw.texture as Record<string, unknown> | undefined);
  if (!isBed && !parts.some((p) => p.role === 'tune')) throw new ScoreError('parts: a piece needs a tune; name the part that carries it "tune" (or set loudness: bed for a voiceover bed without a tune)');

  const chords: ChordSpan[] = [];
  if (typeof raw.chords !== 'string' || !raw.chords.trim()) throw new ScoreError('chords: one bar each, "|" between bars (Dmaj9 | Bm7 | A7sus4:2 A7:2 | ...)');
  const rawChordBars = barsOf(raw.chords, 'chords', (_bar, body) => [body]);
  const lastChordBar = Math.max(0, ...rawChordBars.keys());
  for (const [bar, [body]] of rawChordBars) {
    const toks = body.split(/\s+/).filter(Boolean);
    if (!toks.length) throw new ScoreError(`chords bar ${bar}: empty (repeat the chord, or write N.C. as the last one)`);
    const given = toks.map((t) => /^(.+?):([\d.]+)$/.exec(t));
    const fixed = given.reduce((s, g) => s + (g ? Number(g[2]) : 0), 0);
    const open = given.filter((g) => !g).length;
    const each = open ? (beatsPerBar - fixed) / open : 0;
    let beat = 1;
    const spans = toks.map((t, i) => {
      const sym = given[i] ? given[i]![1] : t;
      const dur = given[i] ? Number(given[i]![2]) : each;
      const chord = parseChord(sym);
      if (!chord) throw new ScoreError(`chords bar ${bar}: "${sym}" is not a chord symbol (like Dmaj9, Bm7, A7sus4, G/B)`);
      const span = { bar, beat, dur, chord };
      beat += dur;
      const used = beat - 1;
      const shortFinal = bar === lastChordBar && used > 1e-6 && used < beatsPerBar - 1e-6;
      if (i === toks.length - 1 && !shortFinal && Math.abs(used - beatsPerBar) > 1e-6) throw new ScoreError(`chords bar ${bar}: ${+used.toFixed(3)} beats in a bar of ${beatsPerBar}`);
      return span;
    });
    chords.push(...spans);
  }
  chords.sort((a, b) => a.bar - b.bar || a.beat - b.beat);

  const lines: Record<string, Note[]> = {};
  for (const p of parts.filter((x) => x.texture.kind === 'line')) {
    const text = raw[p.role];
    if (isBed && (text === undefined || (typeof text === 'string' && !text.trim()))) continue;
    if (typeof text !== 'string' || !text.trim()) throw new ScoreError(`${p.role}: write its line, bar by bar (like "4: A5:1.5 F#5:.5 E5:1 F#5:1 | ...")`);
    lines[p.role] = lineNotes(text, p.role, beatsPerBar, cells);
  }

  const dynamics: Dynamic[] = [];
  for (const piece of String(raw.dynamics ?? '1: mp').split('|')) {
    const m = /^\s*(\d+)\s*:\s*(ppp|pp|p|mp|mf|f|ff|fff)\s*([<>])?\s*$/.exec(piece);
    if (!m) throw new ScoreError(`dynamics: "${piece.trim()}" is not like "4: mp" or "8: mf<"`);
    dynamics.push({ bar: Number(m[1]), level: m[2], hairpin: m[3] as '<' | '>' | undefined });
  }
  dynamics.sort((a, b) => a.bar - b.bar);

  const sync: SyncPoint[] = [];
  for (const [i, s] of ((raw.sync as unknown[]) ?? []).entries()) {
    const o = s as Record<string, unknown>;
    const at = Number(o?.at);
    if (!Number.isFinite(at) || at < 0) throw new ScoreError(`sync ${i + 1}: "at" is the moment in seconds`);
    const hit = String(o.hit ?? 'accent') as HitKind;
    if (!HITS.includes(hit)) throw new ScoreError(`sync ${i + 1}: hit is one of ${HITS.join(', ')}`);
    const bar = o.bar === undefined ? undefined : Number(o.bar);
    if (bar !== undefined && !(bar >= 1 && Number.isInteger(bar))) throw new ScoreError(`sync ${i + 1}: bar is a whole bar number`);
    sync.push({ at, bar, beat: o.beat === undefined ? undefined : Number(o.beat), name: String(o.name ?? o.what ?? `moment ${i + 1}`), hit });
  }
  sync.sort((a, b) => a.at - b.at);

  const lastLine = Math.max(0, ...Object.values(lines).flatMap((ns) => ns.map((n) => n.bar)));
  const bars = Math.max(lastLine, chords.length ? chords[chords.length - 1].bar : 0);
  const end = (raw.end ?? {}) as Record<string, unknown>;
  const palette = String(raw.palette ?? 'chamber');
  for (const d of dynamics) if (!DYN.includes(d.level)) throw new ScoreError(`dynamics bar ${d.bar}: ${d.level}`);
  return {
    name: String(raw.cue ?? raw.name ?? 'cue'),
    key,
    beatsPerBar,
    beatUnit,
    tempo,
    length: raw.length === undefined ? undefined : Number(raw.length),
    fps: Number(raw.fps ?? 24),
    palette,
    room: String(raw.room ?? 'salon'),
    loudness,
    sync,
    parts,
    chords,
    lines,
    dynamics,
    bars,
    end: { ring: end.ring !== false, fade: Number(end.fade ?? 0.8) },
    cells,
    cutsFile: typeof raw.cuts === 'string' ? raw.cuts : undefined,
  };
}

export const DYNAMIC_LEVELS = DYN;
