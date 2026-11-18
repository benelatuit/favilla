/**
 * The themes as a person picks them: a palette, and whether it is light, dark or follows the system. Four palettes have
 * a light and a dark theme and a setting that follows the system between the two; three are light only. The config
 * keeps one value, `theme`, which these map both ways. Unset, it is DEFAULT_THEME: Gesso following the system.
 */
import { DEFAULT_THEME } from '@favilla/core/config/theme';

export { DEFAULT_THEME };
export type ThemeMode = 'light' | 'dark' | 'system';

export interface Palette {
  id: string;
  light: string;
  dark?: string;
  /** The setting that follows the system between `light` and `dark`. */
  system?: string;
}

export const PALETTES: readonly Palette[] = [
  { id: 'drafting', light: 'drafting', dark: 'nightshift', system: 'auto' },
  { id: 'kiln', light: 'kiln', dark: 'kiln-night', system: 'kiln-auto' },
  { id: 'sky', light: 'sky', dark: 'sky-night', system: 'sky-auto' },
  { id: 'gesso', light: 'gesso', dark: 'lampblack', system: 'lampblack-auto' },
  { id: 'daylight', light: 'daylight' },
  { id: 'porcelain', light: 'porcelain' },
  { id: 'plain', light: 'plain' },
];

/** The settings that follow the system's light or dark: the light theme, then the dark one. */
export const PAIRS: Record<string, [string, string]> = Object.fromEntries(
  PALETTES.filter((p) => p.system && p.dark).map((p) => [p.system!, [p.light, p.dark!]]),
);

/** The palette and mode a setting stands for; a value no palette has reads as the default, following the system. */
export function readTheme(setting: string): { palette: Palette; mode: ThemeMode } {
  for (const palette of PALETTES) {
    if (setting === palette.system) return { palette, mode: 'system' };
    if (setting === palette.dark) return { palette, mode: 'dark' };
    if (setting === palette.light) return { palette, mode: 'light' };
  }
  return { palette: PALETTES.find((p) => p.system === DEFAULT_THEME)!, mode: 'system' };
}

/** The setting for a palette in a mode; a light-only palette is light whatever the mode. */
export function themeSetting(palette: Palette, mode: ThemeMode): string {
  return (mode === 'dark' && palette.dark) || (mode === 'system' && palette.system) || palette.light;
}

/** The theme a palette wears in a mode, with the system dark or not: what the window shows once it is chosen. */
export function themeInForce(palette: Palette, mode: ThemeMode, systemDark: boolean): string {
  return palette.dark && (mode === 'dark' || (mode === 'system' && systemDark)) ? palette.dark : palette.light;
}

/** The themes a palette's picture shows in a mode: one, or its light and dark halves while it follows the system. */
export function shownThemes(palette: Palette, mode: ThemeMode): string[] {
  if (!palette.dark || mode === 'light') return [palette.light];
  return mode === 'dark' ? [palette.dark] : [palette.light, palette.dark];
}
