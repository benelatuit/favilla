/**
 * The theme of a person who has not chosen one: Gesso by day and Lampblack by night, following the system. Only an
 * unset `theme` reads as this; a saved one stays as it is, "auto" (Drafting following the system, the default up to
 * 1.2.26) among them. The engine, the desktop window before the page draws and the page itself all start from it.
 */
export const DEFAULT_THEME = 'lampblack-auto';

/** The settings that follow the system: the light theme, then the dark one. */
export const SYSTEM_THEMES: Readonly<Record<string, readonly [light: string, dark: string]>> = {
  auto: ['drafting', 'nightshift'],
  'kiln-auto': ['kiln', 'kiln-night'],
  'sky-auto': ['sky', 'sky-night'],
  'lampblack-auto': ['gesso', 'lampblack'],
};
