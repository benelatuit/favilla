import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useStore } from '../../lib/store';
import { fill, THEME_NAMES, useT } from '../../lib/i18n';
import { DEFAULT_THEME, PALETTES, readTheme, shownThemes, themeInForce, themeSetting, type Palette, type ThemeMode } from '../../lib/themes';
import { Row, Segmented, useSetConfig } from './Rows';

/** What each theme looks like, in a line. */
const LOOKS: Record<string, string> = {
  drafting: 'Textured grey paper, blue accents',
  nightshift: 'Graphite grey, blue accents',
  daylight: 'White, blue accents',
  porcelain: 'Blue-white, cobalt accents',
  plain: 'Neutral white, black accents',
  kiln: 'Warm paper, terracotta, serif titles',
  'kiln-night': 'Brown-black, terracotta, serif titles',
  sky: 'Sky-blue notebook paper, navy ink',
  'sky-night': 'Navy, sky-blue accents',
  gesso: 'Chalk white, soot-black text, colour only for states',
  lampblack: 'Near-black, ivory text, colour only for states',
};

// One query, made on first use: React reads the snapshot on every render.
let dark: MediaQueryList | undefined;
const darkQuery = () => (dark ??= window.matchMedia('(prefers-color-scheme: dark)'));
const watchDark = (changed: () => void) => {
  darkQuery().addEventListener('change', changed);
  return () => darkQuery().removeEventListener('change', changed);
};

/** Whether the system is dark now, kept up to date while the settings are open. */
const useSystemDark = () => useSyncExternalStore(watchDark, () => darkQuery().matches);

/**
 * The look of the app, in one panel: Favilla itself drawn large in the theme in force, the palettes in a strip under
 * it, and light, dark or the system's as a row. Pointing at a palette shows it in the picture before it is chosen; a
 * choice applies at once. The three light-only palettes say so, and while one is chosen the mode stays on light.
 */
export function ThemePanel() {
  const t = useT();
  const setting = useStore((s) => s.info?.config.theme || DEFAULT_THEME);
  const set = useSetConfig();
  const systemDark = useSystemDark();
  const [peek, setPeek] = useState<Palette | null>(null);
  const { palette, mode } = readTheme(setting);
  const pick = (p: Palette, m: ThemeMode) => {
    const next = themeSetting(p, m);
    if (next !== setting) set({ theme: next });
  };
  const shown = peek ?? palette;
  const theme = themeInForce(shown, mode, systemDark);
  return (
    <div className="look" data-setting="theme" id="setting-theme">
      <Preview theme={theme} />
      <p className="look-caption">
        <b>{THEME_NAMES[theme]}</b>
        {!shown.dark && <small>{t('Light only')}</small>}
        {t(LOOKS[theme])}
      </p>
      <Palettes chosen={palette} mode={mode} dim={themeInForce(palette, mode, systemDark) !== palette.light} onPeek={setPeek} onPick={(p) => pick(p, mode)} />
      <Row
        id="colour-mode"
        label={t('Colour mode')}
        note={palette.dark ? undefined : fill(t('{n} has no dark version.'), THEME_NAMES[palette.light])}
        control={
          <Segmented<ThemeMode>
            value={mode}
            options={[
              ['light', t('Light')],
              ['dark', t('Dark'), { disabled: !palette.dark }],
              ['system', t('Follow the system'), { disabled: !palette.dark }],
            ]}
            onChange={(m) => pick(palette, m)}
            label={t('Colour mode')}
          />
        }
      />
    </div>
  );
}

/**
 * The palettes as a radio group: a small swatch each, its name under it. The arrow keys move along them and choose as
 * they go. In a dark window the light-only palettes' swatches stay dimmed until pointed at or focused, so three white
 * tiles do not glare in a dark list.
 */
function Palettes({ chosen, mode, dim, onPeek, onPick }: { chosen: Palette; mode: ThemeMode; dim: boolean; onPeek: (p: Palette | null) => void; onPick: (p: Palette) => void }) {
  const t = useT();
  const picks = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = PALETTES.length;
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    picks.current[to]?.focus();
    onPick(PALETTES[to]);
  };
  return (
    <div className="look-picks" role="radiogroup" aria-label={t('Theme')} data-dim={dim || undefined} onPointerLeave={() => onPeek(null)}>
      {PALETTES.map((p, i) => {
        const on = p.id === chosen.id;
        return (
          <button
            key={p.id}
            ref={(el) => {
              picks.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`look-pick ${on ? 'is-on' : ''} ${p.dark ? '' : 'is-light-only'}`}
            // A touch has no pointing before it chooses: only a mouse or a pen previews.
            onPointerEnter={(e) => e.pointerType !== 'touch' && onPeek(p)}
            onClick={() => !on && onPick(p)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {/* Keyed by place, so a change of mode retints the swatch rather than making it again. */}
            {shownThemes(p, mode).map((theme, j) => (
              <i key={j} data-theme-preview={theme} aria-hidden="true" />
            ))}
            {THEME_NAMES[p.light]}
          </button>
        );
      })}
    </div>
  );
}

/** The answer's code, as the app colours it: keywords, the function's name and numbers. One run of text, the colours
 * on spans in it, so the picture costs no more elements than it shows. */
const CODE: (string | [string, string])[] = [
  ['k', 'function'], ' ', ['f', 'isLeap'], '(y) {\n  ',
  ['k', 'if'], ' (y % ', ['n', '400'], ' === ', ['n', '0'], ') ', ['k', 'return true'], ';\n  ',
  ['k', 'return'], ' y % ', ['n', '4'], ' === ', ['n', '0'], ' && y % ', ['n', '100'], ' !== ', ['n', '0'], ';\n}',
];

/**
 * Favilla in one theme's own tokens (the theme files apply them to [data-theme-preview] as to the document): the title
 * bar and the sidebar on the board, and on the paper a sent message, an answer with a heading, inline code and a code
 * block, and the composer with the accent's send button. Narrow, it is the phone's: the conversation alone. Each part
 * is one element where it can be, so opening the page costs little more than the rows it replaced.
 */
function Preview({ theme }: { theme: string }) {
  const t = useT();
  // Only the theme changes as palettes are chosen and pointed at: the parts are made once per language, and React
  // passes over them when the same element comes back.
  const parts = useMemo(() => <PreviewParts t={t} />, [t]);
  return (
    <div className="look-stage" data-theme-preview={theme} aria-hidden="true">
      {parts}
    </div>
  );
}

function PreviewParts({ t }: { t: (key: string) => string }) {
  const title = t('Leap years in the date parser');
  const [before, after] = t('Years divisible by 400 are leap years again, so {code} now returns true.').split('{code}');
  return (
    <>
      <span className="look-brand">Favilla</span>
      <span className="look-crumb">
        ledger-api /<b>{title}</b>
      </span>
      <span className="look-side">
        <span className="look-folder">ledger-api</span>
        <span className="look-row is-on">{title}</span>
        <span className="look-row">{t('Retry failed webhooks')}</span>
        <span className="look-row">{t('Add CSV export to the report')}</span>
      </span>
      <span className="look-paper">
        <span className="look-user">{t('Why is 2000-02-29 rejected?')}</span>
        <span className="look-h">{t('The third rule for leap years')}</span>
        <span className="look-p">
          {before}
          <code>isLeap(2000)</code>
          {after}
        </span>
        <code className="look-code">{CODE.map((part, i) => (typeof part === 'string' ? part : <span key={i} className={`is-${part[0]}`}>{part[1]}</span>))}</code>
        <span className="look-composer">
          {t('Message Favilla')}
          <span className="look-send" />
        </span>
      </span>
    </>
  );
}
