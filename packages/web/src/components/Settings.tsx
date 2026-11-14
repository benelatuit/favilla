import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { setUi, useStore, type SettingsPage } from '../lib/store';
import { useT } from '../lib/i18n';
import { paintTitleBar } from '../lib/titlebar';
import { CaretLeft, CaretRight, MagnifyingGlass, X } from './icons';
import { NavContext, type SettingsNav } from './settings/Rows';
import { FINDABLE, PAGES, pageOf, type Findable } from './settings/pages';
import { GeneralSettings } from './settings/GeneralSettings';
import { ProviderSettings } from './settings/ProviderSettings';
import { ModelSettings } from './settings/ModelSettings';
import { RulesSettings } from './settings/RulesSettings';
import { PersonaSettings } from './settings/PersonaSettings';
import { PresetSettings } from './settings/PresetSettings';
import { ToolSettings } from './settings/ToolSettings';
import { McpSettings } from './settings/McpSettings';
import { MailSettings } from './settings/MailSettings';
import { RemoteSettings } from './settings/RemoteSettings';
import { StorageSettings } from './settings/StorageSettings';
import { UsageSettings } from './settings/UsageSettings';

const CONTENT: Record<SettingsPage, ComponentType> = {
  general: GeneralSettings,
  providers: ProviderSettings,
  models: ModelSettings,
  rules: RulesSettings,
  personas: PersonaSettings,
  presets: PresetSettings,
  tools: ToolSettings,
  mcp: McpSettings,
  mail: MailSettings,
  remote: RemoteSettings,
  usage: UsageSettings,
  storage: StorageSettings,
};

/** Where the settings were left in this window: they open there again, as a settings window does. */
let lastPage: SettingsPage | null = null;

/** The width at which the nav and the page no longer fit side by side, as in the styles. */
const NARROW = '(max-width: 720px)';

/**
 * Settings: one page at a time, chosen from a short nav grouped by what people come for, with a search that goes
 * straight to a setting. On a phone the nav is a list of its own and a page opens over it, with a way back.
 */
export function Settings() {
  const t = useT();
  const info = useStore((s) => s.info);
  const asked = useStore((s) => s.ui.settings);
  const providers = useStore((s) => s.providers);
  const [page, setPage] = useState<SettingsPage>(() => (typeof asked === 'string' ? asked : (lastPage ?? (providers.some((p) => p.configured) ? 'general' : 'providers'))));
  // A phone opens on the list of pages, unless a link asked for one.
  const [listing, setListing] = useState(() => typeof asked !== 'string' && window.matchMedia(NARROW).matches);
  // Pages stay as they were once opened, so a draft on one survives a look at another.
  const [opened, setOpened] = useState<SettingsPage[]>(() => [page]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<{ id: string; focus: boolean } | null>(null);
  // Settings is loaded when first opened (61ddfd8), so the repaint App asks for a frame after it opens can come
  // before its veil is in the page, and the window buttons stayed lit over a dimmed window. It asks once it is there.
  useLayoutEffect(() => {
    paintTitleBar();
  }, []);
  const sheet = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const close = () => setUi({ settings: false });

  const go = (p: SettingsPage, setting?: string, focus = false) => {
    setPage(p);
    setOpened((list) => (list.includes(p) ? list : [...list, p]));
    setListing(false);
    setFound(setting ? { id: setting, focus } : null);
  };
  useEffect(() => {
    lastPage = page;
  }, [page]);

  // A link elsewhere (the model list, the welcome page) names a page: go there, and let the next link do the same.
  useEffect(() => {
    if (typeof asked !== 'string') return;
    go(asked);
    setUi({ settings: true });
  }, [asked]);

  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.popover')) close();
    };
    document.addEventListener('keydown', key);
    // Typing starts a search, where there is a keyboard to type with.
    if (window.matchMedia('(pointer: fine)').matches && !window.matchMedia(NARROW).matches) search.current?.focus();
    return () => document.removeEventListener('keydown', key);
  }, []);

  // A setting a search found: brought into view on its page and marked a moment; from the keyboard, its control
  // takes the focus. A page that loads what it shows draws the row a little later.
  useEffect(() => {
    if (!found) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const row = sheet.current?.querySelector<HTMLElement>(`.set-page:not([hidden]) [data-setting="${CSS.escape(found.id)}"]`);
      if (!row) {
        if (tries++ < 15) timer = setTimeout(look, 80);
        return;
      }
      row.scrollIntoView({ block: 'center' });
      row.classList.remove('is-found');
      void row.offsetWidth;
      row.classList.add('is-found');
      if (found.focus) row.querySelector<HTMLElement>('button:not(:disabled), input, textarea')?.focus({ preventScroll: true });
    };
    look();
    return () => clearTimeout(timer);
  }, [found]);

  const findable = useMemo<Findable[]>(
    () => [
      ...FINDABLE,
      ...providers.map((p): Findable => ({ id: `provider-${p.id}`, page: 'providers', label: p.name, terms: 'provider api key sign in' })),
      ...(info?.extensions ?? []).flatMap((e) => e.settings.map((s): Findable => ({ id: `ext-${s.key}`, page: 'tools', label: s.label }))),
    ],
    [providers, info?.extensions],
  );
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/\s+/);
    return findable
      .map((f) => {
        const name = t(f.label).toLowerCase();
        const where = pageOf(f.page).label;
        const text = `${name} ${f.label.toLowerCase()} ${f.terms ?? ''} ${t(where).toLowerCase()} ${where.toLowerCase()}`;
        return words.every((w) => text.includes(w)) ? { f, rank: name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2 } : null;
      })
      .filter((x): x is { f: Findable; rank: number } => !!x)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 12)
      .map((x) => x.f);
  }, [query, findable, t]);

  if (!info) return null;

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(results.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      go(results[active].page, results[active].id, true);
    } else if (e.key === 'Escape' && query) {
      // The first Escape clears the search; the next closes the settings.
      e.stopPropagation();
      setQuery('');
    }
  };

  /** Up and down move through the pages and open each; Tab goes on into the page. */
  const onNavKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? PAGES.length - 1 : null;
    if (to === null || to < 0 || to >= PAGES.length) return;
    e.preventDefault();
    go(PAGES[to].id);
    sheet.current?.querySelector<HTMLElement>(`[data-page-link="${PAGES[to].id}"]`)?.focus();
  };

  const nav: SettingsNav = { go, found: found?.id ?? null };

  return createPortal(
    <div className="scrim is-sheet" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <section ref={sheet} className={`sheet settings ${listing ? 'is-listing' : ''}`} role="dialog" aria-modal="true" aria-label={t('Settings')}>
        <nav className="set-nav" aria-label={t('Settings')}>
          <h2>{t('Settings')}</h2>
          <label className="set-search">
            <MagnifyingGlass size={14} />
            <input
              ref={search}
              type="text"
              role="searchbox"
              enterKeyHint="search"
              value={query}
              placeholder={t('Search settings')}
              aria-label={t('Search settings')}
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
            />
            {query && (
              <button type="button" className="icon-btn is-small" aria-label={t('Clear')} onClick={() => (setQuery(''), search.current?.focus())}>
                <X size={12} />
              </button>
            )}
          </label>
          {query ? (
            <div className="set-results" role="listbox" aria-label={t('Search settings')}>
              {results.length === 0 && <p className="set-results-empty">{t('No setting matches.')}</p>}
              {results.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'is-active' : ''}
                  onPointerMove={() => i !== active && setActive(i)}
                  onClick={() => go(r.page, r.id)}
                >
                  <span className="set-result-name">{t(r.label)}</span>
                  <span className="set-result-page">{t(pageOf(r.page).label)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="set-links">
              {PAGES.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  data-page-link={p.id}
                  className={`${p.id === page ? 'is-on' : ''} ${i > 0 && PAGES[i - 1].group !== p.group ? 'is-new-group' : ''}`}
                  aria-current={p.id === page ? 'page' : undefined}
                  tabIndex={p.id === page ? 0 : -1}
                  onClick={() => go(p.id)}
                  onKeyDown={(e) => onNavKey(e, i)}
                >
                  <p.icon size={16} className="set-link-icon" />
                  <span>{t(p.label)}</span>
                  <CaretRight size={12} className="set-link-caret" />
                </button>
              ))}
            </div>
          )}
          <span className="settings-version num">Favilla {info.version}</span>
        </nav>
        <div className="set-main">
          <div className="set-bar">
            <button type="button" className="set-back" onClick={() => setListing(true)}>
              <CaretLeft size={16} />
              {t('Settings')}
            </button>
          </div>
          <NavContext.Provider value={nav}>
            {PAGES.filter((p) => opened.includes(p.id)).map((p) => {
              const Content = CONTENT[p.id];
              return (
                <div key={p.id} className="set-page" hidden={p.id !== page} role="region" aria-label={t(p.label)}>
                  <Content />
                </div>
              );
            })}
          </NavContext.Provider>
        </div>
        <button type="button" className="icon-btn sheet-close" onClick={close} aria-label={t('Close')} data-tip={t('Close')} data-keys="Esc">
          <X size={16} />
        </button>
      </section>
    </div>,
    document.body,
  );
}
