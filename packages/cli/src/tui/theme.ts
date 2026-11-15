/**
 * Terminal palette: black, white and greys for both dark and light terminals. Meaning comes from weight, dim, inverse
 * and symbols, never from hue: what is active or chosen is bold ink, an error is bold with ✗ or !, an addition is
 * bright with +, a removal dim with −, what matters less steps down the greys. The names below are roles kept from
 * the coloured palette (blue was the accent, green success, red failure, brass a warning, violet sub-agents and modes);
 * each maps to an achromatic grey (R === G === B) and a weight.
 */
const truecolor = process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' || !!process.env.WT_SESSION || process.platform === 'win32';

export type TerminalTheme = 'dark' | 'light';

/**
 * Conservative terminal background detection: always defaults to 'dark' unless FAVILLA_THEME=light is explicitly set
 * or COLORFGBG unambiguously reports a dark foreground index paired with a light background index (e.g. "0;15", "0;7").
 */
export function resolveTerminalTheme(env: NodeJS.ProcessEnv = process.env): TerminalTheme {
  const explicit = env.FAVILLA_THEME?.trim().toLowerCase();
  if (explicit === 'light') return 'light';
  if (explicit && explicit !== 'auto') return 'dark';
  const raw = env.COLORFGBG?.trim();
  if (!raw) return 'dark';
  const parts = raw.split(';').map((p) => p.trim());
  if (parts.length < 2) return 'dark';
  if (!parts.every((p) => p === 'default' || /^\d+$/.test(p))) return 'dark';
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (first === 'default' || last === 'default') return 'dark';
  const fg = Number(first);
  const bg = Number(last);
  const isDarkFg = fg === 0 || fg === 8 || fg === 16 || (fg >= 232 && fg <= 239);
  const isLightBg = bg === 7 || bg === 15 || bg === 231 || (bg >= 250 && bg <= 255);
  return isDarkFg && isLightBg ? 'light' : 'dark';
}

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

type RoleSpec = { grey: string; bold?: boolean };

const DARK_ROLES = {
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
} as const satisfies Record<string, RoleSpec>;

export type Hue = keyof typeof DARK_ROLES;

const LIGHT_ROLES: Record<Hue, RoleSpec> = {
  ink: { grey: '#1a1a1a' },
  muted: { grey: '#545454' },
  faint: { grey: '#767676' },
  code: { grey: '#2c2c2c' },
  blue: { grey: '#000000', bold: true },
  green: { grey: '#121212' },
  red: { grey: '#000000', bold: true },
  brass: { grey: '#2e2e2e', bold: true },
  violet: { grey: '#424242' },
};

const PALETTES = {
  dark: {
    roles: DARK_ROLES as Record<Hue, RoleSpec>,
    grounds: {
      added: '#2b2b2b',
      removed: '#181818',
      user: '#222222',
      code: '#2e2e2e',
    },
    borders: {
      active: '#9c9c9c',
      idle: '#4a4a4a',
      prompt: '#c8c8c8',
      alert: '#ffffff',
    },
  },
  light: {
    roles: LIGHT_ROLES,
    grounds: {
      added: '#e6e6e6',
      removed: '#f2f2f2',
      user: '#ececec',
      code: '#e8e8e8',
    },
    borders: {
      active: '#5c5c5c',
      idle: '#b8b8b8',
      prompt: '#383838',
      alert: '#000000',
    },
  },
} as const;

let activeTheme: TerminalTheme = resolveTerminalTheme();

/** Line grounds: an added line on its own grey, the user's own messages on their own. */
export const grounds = { ...PALETTES[activeTheme].grounds };

/** Box borders of prompts, pickers and the input. */
export const borders = { ...PALETTES[activeTheme].borders };

export function terminalTheme(): TerminalTheme {
  return activeTheme;
}

export function setTerminalTheme(mode?: TerminalTheme): TerminalTheme {
  activeTheme = mode ?? resolveTerminalTheme();
  Object.assign(grounds, PALETTES[activeTheme].grounds);
  Object.assign(borders, PALETTES[activeTheme].borders);
  return activeTheme;
}

const RESET_FG = '\x1b[39m';
const RESET_BG = '\x1b[49m';
export const paint = (hue: Hue, s: string) => {
  const role = PALETTES[activeTheme].roles[hue];
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
