import { describe, expect, it } from 'vitest';
import { PAIRS, PALETTES, readTheme, shownThemes, themeInForce, themeSetting, type ThemeMode } from '../src/lib/themes';

describe('the theme setting as a palette and a mode', () => {
  it('reads every setting back as the setting it came from', () => {
    for (const palette of PALETTES) {
      for (const mode of ['light', 'dark', 'system'] as ThemeMode[]) {
        const setting = themeSetting(palette, mode);
        expect(readTheme(setting).palette.id).toBe(palette.id);
        expect(themeSetting(readTheme(setting).palette, readTheme(setting).mode)).toBe(setting);
      }
    }
  });

  it('keeps a light-only palette light, and reads an unknown value as the default following the system', () => {
    const daylight = PALETTES.find((p) => p.id === 'daylight')!;
    expect(themeSetting(daylight, 'dark')).toBe('daylight');
    expect(themeSetting(daylight, 'system')).toBe('daylight');
    expect(readTheme('daylight')).toEqual({ palette: daylight, mode: 'light' });
    expect(readTheme('no-such-theme')).toEqual({ palette: PALETTES[0], mode: 'system' });
    expect(themeSetting(PALETTES[0], 'system')).toBe('auto');
  });

  it('follows the system between the same themes as before', () => {
    expect(PAIRS).toEqual({ auto: ['drafting', 'nightshift'], 'kiln-auto': ['kiln', 'kiln-night'], 'sky-auto': ['sky', 'sky-night'], 'lampblack-auto': ['gesso', 'lampblack'] });
  });

  it('pictures a palette following the system in both its themes', () => {
    const gesso = PALETTES.find((p) => p.id === 'gesso')!;
    expect(shownThemes(gesso, 'system')).toEqual(['gesso', 'lampblack']);
    expect(shownThemes(gesso, 'dark')).toEqual(['lampblack']);
    expect(shownThemes(PALETTES.find((p) => p.id === 'plain')!, 'dark')).toEqual(['plain']);
  });

  it('wears the theme the window would: the dark one only in dark, or following a dark system', () => {
    const kiln = PALETTES.find((p) => p.id === 'kiln')!;
    const plain = PALETTES.find((p) => p.id === 'plain')!;
    expect(themeInForce(kiln, 'light', true)).toBe('kiln');
    expect(themeInForce(kiln, 'dark', false)).toBe('kiln-night');
    expect(themeInForce(kiln, 'system', false)).toBe('kiln');
    expect(themeInForce(kiln, 'system', true)).toBe('kiln-night');
    expect(themeInForce(plain, 'dark', true)).toBe('plain');
  });
});
