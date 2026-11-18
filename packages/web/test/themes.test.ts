import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYSTEM_THEMES } from '@favilla/core/config/theme';
import { DEFAULT_THEME, PAIRS, PALETTES, readTheme, shownThemes, themeInForce, themeSetting, type ThemeMode } from '../src/lib/themes';

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
    expect(readTheme('no-such-theme')).toEqual({ palette: PALETTES.find((p) => p.id === 'gesso'), mode: 'system' });
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

describe('the default theme', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
  /** One theme's token from its block in a theme file. */
  const token = (css: string, theme: string, name: string) => {
    const block = css.slice(css.indexOf(`:root[data-theme='${theme}']`));
    return new RegExp(`${name}: (#[0-9a-f]{6});`).exec(block.slice(0, block.indexOf('}')))?.[1];
  };

  it('is Gesso following the system: Gesso on a light system, Lampblack on a dark one', () => {
    expect(DEFAULT_THEME).toBe('lampblack-auto');
    const { palette, mode } = readTheme(DEFAULT_THEME);
    expect([palette.id, mode]).toEqual(['gesso', 'system']);
    expect(themeInForce(palette, mode, false)).toBe('gesso');
    expect(themeInForce(palette, mode, true)).toBe('lampblack');
  });

  it('leaves a saved choice as it is: "auto" is still Drafting following the system', () => {
    expect(readTheme('auto')).toEqual({ palette: PALETTES[0], mode: 'system' });
    expect(themeInForce(PALETTES[0], 'system', true)).toBe('nightshift');
    expect(readTheme('kiln-night').mode).toBe('dark');
  });

  it('follows the system between the same pairs on the page as in the engine and the desktop window', () => {
    expect(PAIRS).toEqual(Object.fromEntries(Object.entries(SYSTEM_THEMES).map(([k, v]) => [k, [...v]])));
  });

  it('is what the first frame wears before the page names a theme, in the files and in the window ground', () => {
    const gesso = read('src/themes/gesso.css');
    const lampblack = read('src/themes/lampblack.css');
    // The bare :root is Gesso's block and no other theme's.
    expect(gesso).toContain(":root,\n:root[data-theme='gesso'],");
    for (const file of fs.readdirSync(path.join(import.meta.dirname, '../src/themes'))) {
      if (file.endsWith('.css') && file !== 'gesso.css') expect(read(`src/themes/${file}`), file).not.toMatch(/^:root,$/m);
    }
    // Every other theme sits on the bare :root too, and takes from it only what it does not set itself: nothing of
    // Gesso's own (its user plate went to every theme once), only the QR tokens, at the values Drafting's bare :root
    // gave them up to 1.2.26.
    const blocks = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1], names: [...m[2].matchAll(/(--[\w-]+):/g)].map((n) => n[1]) }));
    const bare = blocks(gesso).find((b) => /^\s*:root,/.test(b.sel))!.names;
    for (const file of fs.readdirSync(path.join(import.meta.dirname, '../src/themes')).filter((f) => f.endsWith('.css'))) {
      const css = read(`src/themes/${file}`);
      for (const theme of new Set([...css.matchAll(/:root\[data-theme='([\w-]+)'\]/g)].map((m) => m[1]))) {
        const own = new Set(blocks(css).filter((b) => b.sel.includes(`[data-theme='${theme}']`)).flatMap((b) => b.names));
        expect(bare.filter((n) => !own.has(n)).filter((n) => n !== '--qr-paper' && n !== '--qr-ink'), theme).toEqual([]);
      }
    }
    expect([token(gesso, 'gesso', '--qr-paper'), token(gesso, 'gesso', '--qr-ink')]).toEqual(['#ffffff', '#1b2127']);
    // On a dark system the frame before takes Lampblack's own ground and ink.
    const dark = /:root:not\(\[data-theme\]\) \{([^}]*)\}/.exec(lampblack)![1];
    for (const name of ['--board', '--paper', '--ink']) expect(dark, name).toContain(`${name}: ${token(lampblack, 'lampblack', name)};`);
    // The desktop window's ground and buttons before the page draws, in the same colours.
    const main = read('../desktop/src/main.ts');
    for (const [theme, css] of [['gesso', gesso], ['lampblack', lampblack]] as const) {
      const bar = `${theme}: { color: '${token(css, theme, '--board')}', symbolColor: '${token(css, theme, '--ink-2')}', background: '${token(css, theme, '--paper')}' }`;
      expect(main, theme).toContain(bar);
    }
  });
});
