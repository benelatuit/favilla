import { pitchName, voice, type Voicing } from './theory';
import { DYNAMIC_LEVELS, isBedScore, type Note, type Part, type Score } from './score';

/**
 * From a score in bars to notes in seconds, played like a person: the tempo solved so pinned moments land on their
 * bars, chords voiced under the tune, textures realised, velocities shaped by dynamics, metre and phrase with a little
 * scatter, struck notes a few milliseconds off the grid. Then what a musician would say about it, bar by bar.
 */

export interface PlayedNote {
  role: string;
  instrument: string;
  /** MIDI pitch; null for an unpitched hit. */
  key: number | null;
  vel: number;
  t: number;
  dur: number;
  /** A cymbal swell: its length in seconds, ending on t + dur. */
  swell?: number;
}

export interface TempoSegment {
  fromBeat: number;
  toBeat: number;
  fromTime: number;
  bpm: number;
}

export class TempoMap {
  constructor(readonly segments: TempoSegment[]) {}
  time(beat: number): number {
    const s = this.segments.find((x) => beat < x.toBeat) ?? this.segments[this.segments.length - 1];
    return s.fromTime + ((beat - s.fromBeat) * 60) / s.bpm;
  }
  beat(t: number): number {
    for (const s of this.segments) {
      const end = s.fromTime + ((s.toBeat - s.fromBeat) * 60) / s.bpm;
      if (t < end || s === this.segments[this.segments.length - 1]) return s.fromBeat + ((t - s.fromTime) * s.bpm) / 60;
    }
    return 0;
  }
}

const LEVEL: Record<string, number> = { ppp: 26, pp: 36, p: 46, mp: 58, mf: 70, f: 84, ff: 98, fff: 110 };
const ROLE_VEL: Record<string, number> = { tune: 16, answer: 6, line: 4, pad: -6, arp: -8, bass: -2, strike: -6 };

/** A small seeded generator, so the same score plays the same way every time. */
function rng(seed: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Arrangement {
  notes: PlayedNote[];
  tempo: TempoMap;
  length: number;
  /** Bar starts in seconds (and frames), for timing pictures to the music. */
  beatSheet: { bar: number; time: number; frame: number }[];
  sync: { name: string; at: number; bar: number; beat: number; time: number; errorMs: number; pinned: boolean; hit: string }[];
  report: { sync: string[]; writing: string[]; tune: string[]; notes: string[] };
}

/** Where a sync point lands: its bar position in beats from bar 1, beat 1. */
const posOf = (bpb: number, bar: number, beat = 1) => (bar - 1) * bpb + (beat - 1);

function pinHint(pins: { at: number; bar?: number; beat?: number; pos: number }[], bpb: number, tempo: number, curStep: number): string {
  const bestFor = (unit: number, lo: number, hi: number) => {
    let best: { pos: number[]; step: number; bpm: number; score: number } | null = null;
    for (let bpm = Math.max(30, Math.floor(lo)); bpm <= Math.min(260, Math.ceil(hi)); bpm += 0.5) {
      const pos: number[] = [];
      let prev = -unit;
      for (let i = 0; i < pins.length; i++) {
        if (pins[i].at === 0) {
          pos.push(0);
          prev = 0;
          continue;
        }
        const raw = Math.round((pins[i].at * bpm) / (60 * unit)) * unit;
        const p = Math.max(prev + unit, unit, raw);
        pos.push(p);
        prev = p;
      }
      const bpms: number[] = [];
      if (pos[0] > 0 && pins[0].at > 0) bpms.push((60 * pos[0]) / pins[0].at);
      for (let i = 1; i < pins.length; i++) bpms.push((60 * (pos[i] - pos[i - 1])) / (pins[i].at - pins[i - 1].at));
      if (!bpms.length || bpms.some((x) => x < 30 || x > 260)) continue;
      let st = 0;
      for (let i = 1; i < bpms.length; i++) st = Math.max(st, Math.abs(bpms[i] / bpms[i - 1] - 1));
      const mean = bpms.reduce((s, x) => s + x, 0) / bpms.length;
      const rank = st + 0.02 * (Math.abs(mean - tempo) / Math.max(30, tempo));
      if (!best || rank < best.score) best = { pos, step: st, bpm: mean, score: rank };
    }
    return best;
  };
  const fmt = (pos: number[]) =>
    pos
      .map((p) => {
        const bar = Math.floor(p / bpb) + 1;
        const beat = (p % bpb) + 1;
        return beat === 1 ? `bar ${bar}` : `bar ${bar} beat ${beat}`;
      })
      .join(', ');
  const parts: string[] = [];
  const byBeat = bestFor(1, tempo * 0.78, tempo * 1.22);
  if (byBeat && byBeat.step < curStep - 0.005 && byBeat.pos.some((p, i) => p !== pins[i].pos)) {
    parts.push(`${fmt(byBeat.pos)} (~${Math.round(byBeat.bpm)} bpm, ${(byBeat.step * 100).toFixed(1)}% step)`);
  }
  if (pins.every((p) => (p.beat ?? 1) === 1)) {
    const byBar = bestFor(bpb, tempo * 0.65, tempo * 1.45);
    if (byBar && byBar.step < curStep - 0.008 && byBar.pos.some((p, i) => p !== pins[i].pos) && (!byBeat || fmt(byBar.pos) !== fmt(byBeat.pos))) {
      parts.push(`downbeats at tempo ${Math.round(byBar.bpm)}: ${fmt(byBar.pos)} (${(byBar.step * 100).toFixed(1)}% step)`);
    }
  }
  return parts.length ? ` Nearby lower-step pins: ${parts.join('; or ')}.` : '';
}

export function solveTempo(score: Score): { map: TempoMap; lines: string[] } {
  const bpb = score.beatsPerBar;
  const pins = score.sync.filter((s) => s.bar !== undefined).map((s) => ({ ...s, pos: posOf(bpb, s.bar!, s.beat ?? 1) })).sort((a, b) => a.pos - b.pos);
  const lines: string[] = [];
  for (let i = 1; i < pins.length; i++) {
    if (pins[i].pos <= pins[i - 1].pos || pins[i].at <= pins[i - 1].at) throw new Error(`sync: "${pins[i].name}" (bar ${pins[i].bar}, ${pins[i].at} s) must come after "${pins[i - 1].name}" (bar ${pins[i - 1].bar}, ${pins[i - 1].at} s) in both bars and seconds`);
  }
  const segs: TempoSegment[] = [];
  if (!pins.length) segs.push({ fromBeat: 0, toBeat: Infinity, fromTime: 0, bpm: score.tempo });
  else {
    const first = pins[0];
    if (first.pos === 0) segs.push({ fromBeat: 0, toBeat: 0, fromTime: first.at, bpm: score.tempo });
    else segs.push({ fromBeat: 0, toBeat: first.pos, fromTime: 0, bpm: (60 * first.pos) / first.at });
    for (let i = 1; i < pins.length; i++) segs.push({ fromBeat: pins[i - 1].pos, toBeat: pins[i].pos, fromTime: pins[i - 1].at, bpm: (60 * (pins[i].pos - pins[i - 1].pos)) / (pins[i].at - pins[i - 1].at) });
    const last = pins[pins.length - 1];
    segs.push({ fromBeat: last.pos, toBeat: Infinity, fromTime: last.at, bpm: segs.length > 1 && segs[segs.length - 1].toBeat > 0 ? segs[segs.length - 1].bpm : score.tempo });
  }
  const real = segs.filter((s) => s.toBeat > s.fromBeat);
  const barOf = (beat: number) => Math.floor(beat / bpb) + 1;
  const described = real.map((s) => `${s.bpm.toFixed(2)} bpm (bars ${barOf(s.fromBeat)}-${Number.isFinite(s.toBeat) ? barOf(s.toBeat - 1) : 'end'})`);
  let step = 0;
  for (let i = 1; i < real.length; i++) step = Math.max(step, Math.abs(real[i].bpm / real[i - 1].bpm - 1));
  const hint = step > 0.03 ? pinHint(pins, bpb, score.tempo, step) : '';
  lines.push(`${described.join(', ')}${real.length > 1 ? `; largest step ${(step * 100).toFixed(1)}%${step > 0.03 ? ', past the 2-3% a listener notices: move a pin by a beat or a bar' : ''}` : ''}.${hint}`);
  const off = real.filter((s) => Math.abs(s.bpm / score.tempo - 1) > 0.15);
  if (off.length) lines.push(`The pins pull the tempo far from the ${score.tempo} bpm written (${off.map((s) => s.bpm.toFixed(0)).join(', ')}): choose bars that fit the moments, or another tempo.`);
  return { map: new TempoMap(segs.filter((s) => s.toBeat > s.fromBeat || s.toBeat === Infinity)), lines };
}

function velocityAt(score: Score, beat: number): number {
  const bar = Math.floor(beat / score.beatsPerBar) + 1;
  const marks = score.dynamics;
  let i = -1;
  for (let k = 0; k < marks.length; k++) if (marks[k].bar <= bar) i = k;
  if (i < 0) return LEVEL.mp;
  const m = marks[i];
  const base = LEVEL[m.level];
  const next = marks[i + 1];
  if (!m.hairpin || !next) return base;
  const from = posOf(score.beatsPerBar, m.bar);
  const to = posOf(score.beatsPerBar, next.bar);
  const target = LEVEL[next.level] !== base ? LEVEL[next.level] : base + (m.hairpin === '<' ? 12 : -12);
  return base + (target - base) * Math.min(1, Math.max(0, (beat - from) / Math.max(1, to - from)));
}

const SUSTAINED = new Set(['strings']);
const UNPITCHED = new Set(['timpani', 'cymbal', 'bass drum', 'frame drum']);

export function arrange(score: Score, opts: { ranges?: Record<string, [number, number]>; palette?: string[] } = {}): Arrangement {
  const bpb = score.beatsPerBar;
  const { map, lines: syncLines } = solveTempo(score);
  const rand = rng(score.name);
  const gauss = () => (rand() + rand() + rand() - 1.5) * 2;
  const notes: PlayedNote[] = [];
  const pinnedTimes = score.sync.filter((s) => s.bar !== undefined).map((s) => s.at);
  const onPin = (t: number) => pinnedTimes.some((p) => Math.abs(p - t) < 0.002);
  const tune = score.lines.tune ?? [];
  const beatOf = (n: Note) => posOf(bpb, n.bar, n.beat);

  const humanVel = (role: string, kind: string, beat: number) => {
    const inBar = beat % bpb;
    const metre = inBar < 1e-6 ? 5 : Math.abs(inBar - bpb / 2) < 1e-6 && bpb % 2 === 0 ? 2 : Math.abs(inBar - Math.round(inBar)) > 1e-6 ? -3 : 0;
    const phrase = 4 * Math.sin(Math.PI * ((beat % (4 * bpb)) / (4 * bpb)));
    const v = velocityAt(score, beat) + (ROLE_VEL[role] ?? ROLE_VEL[kind] ?? 0) + metre + phrase + Math.round((rand() - 0.5) * 6);
    return Math.max(1, Math.min(127, Math.round(v)));
  };
  const place = (role: string, instrument: string, key: number | null, beat: number, beats: number, kind: string) => {
    let t = map.time(beat);
    const end = map.time(beat + beats);
    const sustained = SUSTAINED.has(instrument);
    if (!onPin(t)) t += sustained ? -0.06 : Math.max(-0.008, Math.min(0.008, gauss() * 0.003));
    notes.push({ role, instrument, key, vel: humanVel(role, kind, beat), t: Math.max(0, t), dur: Math.max(0.05, end - t + (sustained ? 0.05 : 0)) });
  };

  // Lines: the tune, the answer and any other written line.
  for (const [role, ns] of Object.entries(score.lines)) {
    const part = score.parts.find((p) => p.role === role)!;
    for (const n of ns) if (n.pitch !== null) place(role, part.instrument, n.pitch + part.octave * 12, beatOf(n), n.dur, 'line');
  }

  // Chords voiced under the tune, each moving as little as it can from the one before.
  // The highest place the accompaniment may reach in a span: a fifth under the tune's top and under its lowest note too.
  const isBed = isBedScore(score);
  const ceilingIn = (from: number, to: number) => {
    let top = -1;
    let low = 999;
    for (const n of tune) {
      const b = beatOf(n);
      if (n.pitch !== null && b < to && b + n.dur > from) {
        top = Math.max(top, n.pitch);
        low = Math.min(low, n.pitch);
      }
    }
    return top < 0 ? (isBed ? 67 : 76) : Math.min(top - 7, low - 3);
  };
  // Pitch classes a semitone under the tune's notes of a beat or more in a span: chord colour there would rub.
  const heldBy = (from: number, to: number) => tune.filter((n) => n.pitch !== null && n.dur >= 1 && beatOf(n) < to && beatOf(n) + n.dur > from).map((n) => (n.pitch! + 11) % 12);
  const voicings: Voicing[] = [];
  let prev: Voicing | undefined;
  for (const c of score.chords) {
    const from = posOf(bpb, c.bar, c.beat);
    const v = voice(c.chord, { top: ceilingIn(from, from + c.dur), voices: 3, prev, avoid: heldBy(from, from + c.dur) });
    voicings.push(v);
    prev = v;
  }
  // Accompaniment goes where its instrument can play it, by octaves; written lines stay as written and are reported.
  const fold = (instrument: string, p: number) => {
    const r = opts.ranges?.[instrument];
    if (!r) return p;
    while (p < r[0]) p += 12;
    while (p > r[1]) p -= 12;
    return p;
  };
  const hasBass = score.parts.some((p) => p.texture.kind === 'bass');
  for (const part of score.parts) {
    const tx = part.texture;
    if (tx.kind === 'line') continue;
    const inBars = (bar: number) => !part.bars || part.bars.has(bar);
    // A drum has no pitch: a texture on it is one stroke where a pitched part would sound a note or a chord.
    const drum = UNPITCHED.has(part.instrument);
    const shift = part.octave * 12;
    let held: PlayedNote[] = [];
    score.chords.forEach((c, ci) => {
      if (!inBars(c.bar)) {
        held = [];
        return;
      }
      const v = voicings[ci];
      const from = posOf(bpb, c.bar, c.beat);
      const to = from + c.dur;
      if (tx.kind === 'pad' && !drum) {
        const pitches = [...(hasBass ? [] : [v.bass]), ...v.upper].map((p) => fold(part.instrument, p + shift));
        const next: PlayedNote[] = [];
        for (const p of pitches) {
          // A tone the chords share is held over, not struck again.
          const tie = held.find((h) => h.key === p);
          if (tie) {
            tie.dur = map.time(to) - tie.t + 0.05;
            next.push(tie);
          } else {
            const before = notes.length;
            place(part.role, part.instrument, p, from, c.dur, 'pad');
            next.push(notes[before]);
          }
        }
        held = next;
      } else if (tx.kind === 'arp') {
        const tones: (number | null)[] = drum ? [null] : [v.bass + 12 * (v.bass < 40 ? 1 : 0), ...v.upper].map((p) => fold(part.instrument, p + shift));
        let k = Math.round((from % bpb) / tx.unit);
        for (let b = from; b < to - 1e-6; b += tx.unit, k++) {
          const idx = tx.pattern[k % tx.pattern.length];
          const p = tones[((idx % tones.length) + tones.length) % tones.length];
          place(part.role, part.instrument, p, b, Math.min(tx.unit * 2, to - b + tx.unit), 'arp');
        }
      } else if (tx.kind === 'bass' || tx.kind === 'strike') {
        const hits = tx.beats.map((x) => posOf(bpb, c.bar, x)).filter((b) => b >= from - 1e-6 && b < to - 1e-6);
        if (!hits.length && tx.kind === 'bass' && c.beat > 1) hits.push(from);
        hits.forEach((b, i) => {
          const until = i + 1 < hits.length ? hits[i + 1] : to;
          if (drum) place(part.role, part.instrument, null, b, until - b, tx.kind);
          else if (tx.kind === 'bass') place(part.role, part.instrument, fold(part.instrument, v.bass + shift), b, until - b, 'bass');
          else for (const p of v.upper) place(part.role, part.instrument, fold(part.instrument, p + shift), b, until - b, 'strike');
        });
      }
    });
  }

  // The film's moments, played by the palette's drums and cymbal: an arrival, an accent, a swell, a button.
  const palette = new Set(opts.palette ?? []);
  const kit = (name: string) => palette.has(name);
  const syncOut: Arrangement['sync'] = [];
  const pinnedSorted = [...score.sync].sort((a, b) => a.at - b.at);
  pinnedSorted.forEach((s, i) => {
    const pinned = s.bar !== undefined;
    let beat = pinned ? posOf(bpb, s.bar!, s.beat ?? 1) : map.beat(s.at);
    if (!pinned) beat = Math.round(beat * 4) / 4;
    const t = map.time(beat);
    syncOut.push({ name: s.name, at: s.at, bar: Math.floor(beat / bpb) + 1, beat: (beat % bpb) + 1, time: t, errorMs: (t - s.at) * 1000, pinned, hit: s.hit });
    const vel = Math.round(velocityAt(score, beat));
    if (s.hit === 'arrive') {
      if (kit('timpani')) notes.push({ role: 'hits', instrument: 'timpani', key: null, vel: Math.min(110, vel + 10), t, dur: 2.5 });
      if (kit('bass drum')) notes.push({ role: 'hits', instrument: 'bass drum', key: null, vel: Math.min(90, vel), t, dur: 1.5 });
      else if (kit('frame drum')) notes.push({ role: 'hits', instrument: 'frame drum', key: null, vel: Math.min(100, vel + 5), t, dur: 1 });
    } else if (s.hit === 'accent') {
      if (kit('timpani')) notes.push({ role: 'hits', instrument: 'timpani', key: null, vel: Math.max(30, vel - 10), t, dur: 2 });
      else if (kit('frame drum')) notes.push({ role: 'hits', instrument: 'frame drum', key: null, vel: Math.max(30, vel - 5), t, dur: 1 });
    } else if (s.hit === 'swell') {
      const room = i > 0 ? t - pinnedSorted[i - 1].at : t;
      if (kit('cymbal') && room > 1.4) notes.push({ role: 'hits', instrument: 'cymbal', key: null, vel: 80, t: t - Math.min(room - 0.2, 4), dur: Math.min(room - 0.2, 4), swell: Math.min(room - 0.2, 4) });
      if (kit('timpani')) notes.push({ role: 'hits', instrument: 'timpani', key: null, vel: Math.min(110, vel + 12), t, dur: 2.5 });
    } else if (s.hit === 'button') {
      if (kit('timpani')) notes.push({ role: 'hits', instrument: 'timpani', key: null, vel: Math.min(105, vel + 8), t, dur: 3 });
    }
  });

  const lastBeat = posOf(bpb, score.bars + 1);
  const musicEnd = map.time(lastBeat);
  const length = score.length ?? musicEnd + (score.end.ring ? 2.5 : 0.3);
  for (const n of notes) if (n.t + n.dur > length) n.dur = Math.max(0.05, length - n.t);
  const beatSheet = Array.from({ length: score.bars + 1 }, (_, i) => ({ bar: i + 1, time: +map.time(posOf(bpb, i + 1)).toFixed(4), frame: Math.round(map.time(posOf(bpb, i + 1)) * score.fps) }));
  return { notes: notes.filter((n) => n.t < length), tempo: map, length, beatSheet, sync: syncOut, report: { sync: syncLines, ...review(score, notes, map, syncOut, length, opts.ranges ?? {}) } };
}

/** What a musician would say: the writing, the tune, the moments. In bars, with what to do. */
function review(score: Score, notes: PlayedNote[], map: TempoMap, sync: Arrangement['sync'], length: number, ranges: Record<string, [number, number]>): { writing: string[]; tune: string[]; notes: string[] } {
  const bpb = score.beatsPerBar;
  const barAt = (t: number) => Math.floor(map.beat(t) / bpb) + 1;
  const writing: string[] = [];
  const tuneLines: string[] = [];
  const out: string[] = [];
  const tune = notes.filter((n) => n.role === 'tune' && n.key !== null);
  const under = notes.filter((n) => n.role !== 'tune' && n.role !== 'answer' && n.role !== 'hits' && n.key !== null);
  const clashBars = new Set<number>();
  const crowdBars = new Set<number>();
  const strong = (t: number) => {
    const b = map.beat(t) % bpb;
    return Math.abs(b - Math.round(b)) < 0.05 && (Math.round(b) === 0 || (bpb % 2 === 0 && Math.round(b) === bpb / 2));
  };
  for (const t of tune) {
    const heard = map.beat(t.t + t.dur) - map.beat(t.t) >= 0.75 || strong(t.t);
    for (const a of under) {
      if (a.t >= t.t + t.dur - 0.02 || a.t + a.dur <= t.t + 0.02) continue;
      const d = t.key! - a.key!;
      if (heard && ((d % 12) + 12) % 12 === 1 && d > 0) clashBars.add(barAt(Math.max(t.t, a.t)));
      if (a.key! > t.key! - 3) crowdBars.add(barAt(Math.max(t.t, a.t)));
    }
  }
  const isBed = isBedScore(score);
  const list = (s: Set<number>) => [...s].sort((a, b) => a - b).slice(0, 8).join(', ') + (s.size > 8 ? ` and ${s.size - 8} more` : '');
  if (!tune.length && isBed) {
    writing.push('Voiceover bed without a lead tune: chords stay voiced warm under speech.');
  } else {
    writing.push(clashBars.size ? `The tune rubs a semitone over the accompaniment in bars ${list(clashBars)}: change the tune's note there, or the chord.` : 'No semitone rubs between the tune and what sounds under it.');
    if (!isBed) {
      if (crowdBars.size) writing.push(`The accompaniment reaches up to the tune in bars ${list(crowdBars)}: lower that part an octave there, or raise the tune.`);
      else writing.push('The accompaniment stays under the tune throughout.');
    }
  }
  const outside: string[] = [];
  for (const [ins, [lo, hi]] of Object.entries(ranges)) {
    const bad = notes.filter((n) => n.instrument === ins && n.key !== null && (n.key < lo || n.key > hi));
    if (bad.length) outside.push(`${ins} plays ${[...new Set(bad.map((n) => pitchName(n.key!)))].slice(0, 4).join(' ')} outside its ${pitchName(lo)}-${pitchName(hi)} (bars ${[...new Set(bad.map((n) => barAt(n.t)))].slice(0, 5).join(', ')})`);
  }
  if (outside.length) writing.push(`${outside.join('; ')}.`);
  const chordBars = new Set(score.chords.map((c) => c.bar)).size;
  // Borrowed: the chord's root, third or fifth falls outside the key (its colour tones may).
  const triad = (c: (typeof score.chords)[number]) => c.chord.intervals.slice(0, 3).map((i) => (c.chord.root + i) % 12);
  const borrowed = [...new Set(score.chords.filter((c) => triad(c).some((pc) => !score.key.pcs.includes(pc))).map((c) => `${c.chord.symbol} (bar ${c.bar})`))];
  writing.push(`${(score.chords.length / Math.max(1, chordBars)).toFixed(1)} chords a bar${borrowed.length ? `; colour from outside the key: ${borrowed.slice(0, 4).join(', ')}` : '; all inside the key: one borrowed chord (iv, bVI, bVII) every eight bars or so gives colour'}.`);

  if (tune.length) {
    const first = tune[0];
    const tuneBars = new Set(tune.map((n) => barAt(n.t + 0.01)));
    const fromBar = barAt(first.t + 0.01);
    const span = Math.max(1, score.bars - fromBar + 1);
    const writtenTune = score.lines.tune ?? [];
    // How often the tune's rhythm comes back: bars whose rhythm an earlier bar or the hook already had.
    const rhythms = new Map<number, string>();
    for (const n of writtenTune) rhythms.set(n.bar, `${rhythms.get(n.bar) ?? ''}${n.pitch === null ? 'r' : ''}${n.dur},`);
    const seen = new Set<string>();
    let returns = 0;
    const cell = Object.values(score.cells)[0];
    for (const [, r] of [...rhythms.entries()].sort((a, b) => a[0] - b[0])) {
      if (seen.has(r) || (cell && r.includes(cell.join(',')))) returns++;
      seen.add(r);
    }
    const pitches = writtenTune.filter((n) => n.pitch !== null);
    let leaps = 0;
    let answered = 0;
    for (let i = 1; i + 1 < pitches.length; i++) {
      const a = pitches[i].pitch! - pitches[i - 1].pitch!;
      if (Math.abs(a) < 5) continue;
      leaps++;
      const b = pitches[i + 1].pitch! - pitches[i].pitch!;
      if (Math.sign(b) === -Math.sign(a) && Math.abs(b) <= 2) answered++;
    }
    const peak = tune.reduce((m, n) => (n.key! > m.key! ? n : m), tune[0]);
    const onHit = sync.some((s) => Math.abs(s.time - peak.t) < 0.6);
    const lo = Math.min(...tune.map((n) => n.key!));
    tuneLines.push(`Enters at ${first.t.toFixed(1)} s (bar ${fromBar}) and sounds in ${Math.round((100 * tuneBars.size) / span)}% of the bars from there; range ${pitchName(lo)}-${pitchName(peak.key!)}.`);
    tuneLines.push(`Its rhythm comes back in ${returns} of ${rhythms.size} bars (${Math.round((100 * returns) / Math.max(1, rhythms.size))}%; pieces people hum repeat a bar's rhythm in 60-70% of bars)${!isBed && returns / Math.max(1, rhythms.size) < 0.5 ? ': give more bars the hook rhythm with new pitches' : ''}.`);
    tuneLines.push(`Leaps answered by a step back: ${answered} of ${leaps}.${leaps - answered > 1 ? ' A leap that goes on in its direction sounds aimless; turn back by a step after it.' : ''}`);
    tuneLines.push(`Peak ${pitchName(peak.key!)} at ${Math.round((100 * peak.t) / length)}% of the cue${onHit ? ', on a moment of the picture' : ''}${!isBed && (peak.t / length < 0.5 || peak.t / length > 0.85) ? ' (it lands best about two thirds through)' : ''}.`);
    if (!isBed && first.t > 0.45 * length) tuneLines.push('The tune comes in late: the first half has no tune to hold on to.');
  }
  for (const s of sync) {
    const pos = `bar ${s.bar}:${+s.beat.toFixed(2)}`;
    const err = `${s.errorMs >= 0 ? '+' : ''}${Math.round(s.errorMs)} ms`;
    const bad = s.errorMs < -45 || s.errorMs > 125;
    out.push(`${s.name.padEnd(18)} ${s.at.toFixed(3)} s  ${pos.padEnd(12)} ${s.hit.padEnd(6)} ${err}${s.pinned ? '' : ' (placed on the nearest 16th)'}${bad ? ': outside what reads as in sync (45 ms early, 125 ms late); pin it to a bar' : ''}`);
  }
  return { writing, tune: tuneLines, notes: out };
}
