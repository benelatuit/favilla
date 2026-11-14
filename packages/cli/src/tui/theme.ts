/**
 * Terminal palette: black, white and greys. Meaning comes from weight, dim, inverse and symbols, never from hue: what
 * is active or chosen is bold white, an error is bold with ✗ or !, an addition is bright with +, a removal dim with −,
 * what matters less steps down the greys. The names below are roles kept from the coloured palette (blue was the
 * accent, green success, red failure, brass a warning, violet sub-agents and modes); each now maps to a grey and a
 * weight. Tuned for a dark terminal, as the coloured palette was.
 */
const truecolor = process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' || !!process.env.WT_SESSION || process.platform === 'win32';

function rgb(hex: string, layer: 38 | 48): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  if (truecolor) return `\x1b[${layer};2;${r};${g};${b}m`;
  // 256 colours: the grey ramp (232–255) holds 24 steps between black and white.
  const v = Math.round((r + g + b) / 3);
  return `\x1b[${layer};5;${v < 8 ? 16 : v > 238 ? 231 : 232 + Math.round(((v - 8) / 247) * 23)}m`;
}

/** Each role: its grey, and whether it is drawn bold. */
const ROLES = {
  /** Body text. */
  ink: { grey: '#e4e4e4' },
  /** Secondary text: what a step acts on, the detail of a row. */
  muted: { grey: '#a2a2a2' },
  /** Hints, rules, line numbers, counts. */
  faint: { grey: '#6c6c6c' },
  /** Code as written. */
  code: { grey: '#cbcbcb' },
  /** What is active or chosen: the selected row, the prompt mark, headings, links, keywords. */
  blue: { grey: '#ffffff', bold: true },
  /** Success and additions: bright, with ✓ or + beside them. */
  green: { grey: '#f4f4f4' },
  /** Failures: bold, with ✗ or ! beside them. */
  red: { grey: '#ffffff', bold: true },
  /** Warnings and what waits on the user: bold, a step below an error. */
  brass: { grey: '#d6d6d6', bold: true },
  /** Sub-agents, modes, pictures: a light grey with their symbols (⎇ ✦ ✎). */
  violet: { grey: '#bdbdbd' },
} as const;

export type Hue = keyof typeof ROLES;

/** Line grounds: an added line on a lighter grey, the user's own messages on their own; a removed line has none. */
export const grounds = {
  added: '#2b2b2b',
  removed: '#181818',
  user: '#222222',
  code: '#2e2e2e',
};

/** Box borders of prompts, pickers and the input. */
export const borders = {
  /** The input box while it has the keys. */
  active: '#9c9c9c',
  idle: '#4a4a4a',
  /** A prompt that waits for the user: a confirmation, a question, a plan. */
  prompt: '#c8c8c8',
  /** One that asks before something that cannot be undone. */
  alert: '#ffffff',
};

const RESET_FG = '\x1b[39m';
const RESET_BG = '\x1b[49m';
export const paint = (hue: Hue, s: string) => {
  const role: { grey: string; bold?: boolean } = ROLES[hue];
  const text = `${rgb(role.grey, 38)}${s}${RESET_FG}`;
  return role.bold ? `\x1b[1m${text}\x1b[22m` : text;
};
/** A ground under the text; the text's own greys keep working, since they reset only the foreground. */
export const ground = (g: keyof typeof grounds, s: string) => `${rgb(grounds[g], 48)}${s.split(RESET_BG).join(rgb(grounds[g], 48))}${RESET_BG}`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
export const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
export const underline = (s: string) => `\x1b[4m${s}\x1b[24m`;
export const strike = (s: string) => `\x1b[9m${s}\x1b[29m`;
/** A link the terminal can open on click (OSC 8); terminals without it show the text alone. */
export const link = (url: string, s: string) => `\x1b]8;;${url}\x1b\\${s}\x1b]8;;\x1b\\`;

/** Lines added and removed, as counts beside a change: added bright with +, removed dim with −. */
export const added = (n: number) => paint('green', `+${n}`);
export const removed = (n: number) => dim(paint('muted', `−${n}`));
