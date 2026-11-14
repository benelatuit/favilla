/**
 * Pitches, chord symbols and voicings. The voicing rules are the house rules a composer checked by ear: the bass alone
 * low, the next voice a fifth or more above it, no thirds below C3, the upper voices close and the top one a fifth
 * under the tune, colour tones kept, and each voice moving as little as it can from the chord before.
 */

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** A pitch name in scientific pitch (C4 is middle C, 60) to its MIDI number. */
export function parsePitch(s: string): number | null {
  const m = /^([A-Ga-g])(#{1,2}|b{1,2}|♯|♭)?(-?\d)$/.exec(s.trim());
  if (!m) return null;
  const acc = m[2] ?? '';
  const shift = acc.startsWith('#') || acc === '♯' ? acc.length : acc.startsWith('b') || acc === '♭' ? -acc.length : 0;
  return 12 * (Number(m[3]) + 1) + LETTER[m[1].toUpperCase()] + shift;
}

export function pitchName(n: number, flats = false): string {
  return `${(flats ? FLATS : SHARPS)[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

export interface Key {
  tonic: number;
  minor: boolean;
  /** The scale's pitch classes. */
  pcs: number[];
  flats: boolean;
}

export function parseKey(s: string): Key {
  const m = /^\s*([A-G])([#b]?)\s*(major|minor|maj|min|m)?\s*$/i.exec(s);
  if (!m) throw new Error(`"${s}" is not a key (D major, F# minor)`);
  const tonic = (LETTER[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  const minor = /^(minor|min|m)$/i.test(m[3] ?? '');
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const flats = m[2] === 'b' || (!minor && [5, 10, 3, 8, 1].includes(tonic)) || (minor && [2, 7, 0, 5, 10].includes(tonic));
  return { tonic, minor, pcs: steps.map((x) => (x + tonic) % 12), flats };
}

export interface Chord {
  symbol: string;
  root: number;
  bass: number;
  /** Intervals above the root, colour tones above the octave (9 = 14). */
  intervals: number[];
  /** Tones a voicing must keep: the third (or the suspension), the seventh and the colours. */
  needed: number[];
}

/** A chord symbol: Dmaj9, Bm7, A7sus4, Cadd9, Gmaj7#11, F#m7b5, Gm6, Bb/D, E7b9, Csus2, Ddim7, Faug. */
export function parseChord(symbol: string): Chord | null {
  const m = /^([A-G])([#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(symbol.trim());
  if (!m) return null;
  const root = (LETTER[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  let q = m[3];
  const iv = new Set<number>();
  let third = 4;
  let fifth = 7;
  let seventh: number | null = null;
  const take = (re: RegExp) => {
    const hit = re.exec(q);
    if (hit) q = q.slice(0, hit.index) + q.slice(hit.index + hit[0].length);
    return !!hit;
  };
  if (take(/^(m7b5|ø7?)/)) {
    third = 3;
    fifth = 6;
    seventh = 10;
  } else if (take(/^(dim7|°7)/)) {
    third = 3;
    fifth = 6;
    seventh = 9;
  } else if (take(/^(dim|°)/)) {
    third = 3;
    fifth = 6;
  } else if (take(/^(aug|\+)/)) fifth = 8;
  else if (take(/^(mMaj|mM|minMaj)/)) {
    third = 3;
    seventh = 11;
  } else if (take(/^(maj|M|Δ)/)) seventh = 11;
  else if (take(/^(min|m|-)/)) third = 3;
  let ext = 0;
  const num = /^(13|11|9|7|6)/.exec(q);
  if (num) {
    q = q.slice(num[0].length);
    ext = Number(num[0]);
  }
  const majorSeventh = seventh === 11;
  if (ext === 6) iv.add(9);
  if (ext >= 7) seventh ??= 10;
  if (ext === 7 && majorSeventh) seventh = 11;
  if (ext >= 9) iv.add(14);
  if (ext >= 11) iv.add(17);
  if (ext >= 13) iv.add(21);
  if (seventh === null && /^(maj)$/.test(m[3])) seventh = 11;
  for (;;) {
    if (take(/^(sus4|sus)/)) third = 5;
    else if (take(/^sus2/)) third = 2;
    else if (take(/^(add9|add2|\(9\))/)) iv.add(14);
    else if (take(/^add11/)) iv.add(17);
    else if (take(/^add13/)) iv.add(21);
    else if (take(/^\/?9/)) iv.add(14);
    else if (take(/^(#11|\+11)/)) iv.add(18);
    else if (take(/^b9/)) iv.add(13);
    else if (take(/^#9/)) iv.add(15);
    else if (take(/^b13/)) iv.add(20);
    else if (take(/^(b5|-5)/)) fifth = 6;
    else if (take(/^(#5|\+5)/)) fifth = 8;
    else if (take(/^[()\s]/)) continue;
    else break;
  }
  if (q.trim()) return null;
  // An eleventh on a major third clashes with it: the third goes (C11 is a sus sound).
  if (iv.has(17) && third === 4 && ext >= 11) third = 5;
  const intervals = [0, third, fifth, ...(seventh !== null ? [seventh] : []), ...[...iv].sort((a, b) => a - b)];
  const bass = m[4] ? (LETTER[m[4][0]] + (m[4][1] === '#' ? 1 : m[4][1] === 'b' ? -1 : 0) + 12) % 12 : root;
  const needed = [third, ...(seventh !== null ? [seventh] : []), ...iv];
  return { symbol: symbol.trim(), root, bass, intervals, needed };
}

export interface Voicing {
  bass: number;
  /** Upper voices, low to high. */
  upper: number[];
}

/**
 * Voices a chord under a tune: the bass in E1-E3 near the last one; `voices` upper voices from the chord's needed
 * tones first (then the root, then the fifth), at least a fifth over the bass, no third below C3, neighbours 2-7
 * semitones apart, the top at most `top`; of the candidates, the one that moves least from `prev`.
 */
export function voice(c: Chord, opts: { top: number; voices: number; prev?: Voicing; low?: number; avoid?: number[] }): Voicing {
  const prevBass = opts.prev?.bass ?? 40;
  let bass = 28 + ((c.bass - 28 + 1200) % 12);
  while (bass + 12 <= 52 && Math.abs(bass + 12 - prevBass) < Math.abs(bass - prevBass)) bass += 12;
  // A seventh or a colour tone a semitone under a note the tune holds rubs against it (the major seventh under the
  // tune's root above all): it gives way to the root or the fifth. The third stays; a tune that rubs on it is the tune's.
  const colour = (i: number) => i > 11 || i === 9 || i === 10 || i === 11;
  const needed = c.needed.filter((i) => !(colour(i) && opts.avoid?.includes((c.root + i) % 12)));
  const pcs = [...new Set([...needed.map((i) => (c.root + i) % 12), c.root, (c.root + c.intervals[2]) % 12])];
  const want = Math.max(1, Math.min(opts.voices, 5));
  const choose = pcs.slice(0, Math.max(want, Math.min(pcs.length, want)));
  const top = Math.max(opts.top, bass + 14);
  const low = Math.max(opts.low ?? 48, bass + 7);
  const options = (pc: number) => {
    const out: number[] = [];
    for (let n = low + ((pc - low + 1200) % 12); n <= top; n += 12) out.push(n);
    return out;
  };
  const sets = choose.slice(0, want).map(options);
  // Fewer tones than voices: double the root, then the fifth.
  while (sets.length < want) sets.push(options(sets.length % 2 ? c.root : (c.root + c.intervals[2]) % 12));
  let best: number[] | null = null;
  let bestScore = Infinity;
  const pick = (i: number, acc: number[]) => {
    if (i === sets.length) {
      const v = [...acc].sort((a, b) => a - b);
      if (new Set(v).size < v.length) return;
      let s = 0;
      for (let k = 1; k < v.length; k++) {
        const gap = v[k] - v[k - 1];
        if (gap === 1) s += 12;
        if (gap > 7) s += (gap - 7) * 2;
        if (gap <= 4 && v[k - 1] < 48) s += 20;
      }
      if (v[0] - bass < 7) s += 30;
      if (opts.prev?.upper.length) {
        const p = opts.prev.upper;
        for (let k = 0; k < v.length; k++) s += Math.abs(v[k] - p[Math.min(k, p.length - 1)]) * 0.7;
      } else s += Math.abs(v[v.length - 1] - (top - 4)) * 0.3;
      if (s < bestScore) {
        bestScore = s;
        best = v;
      }
      return;
    }
    for (const n of sets[i].length ? sets[i] : [low]) pick(i + 1, [...acc, n]);
  };
  pick(0, []);
  return { bass, upper: best ?? [] };
}
