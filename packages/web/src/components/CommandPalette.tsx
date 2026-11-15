import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { actions, getState, setUi, toast, useStore, settingSaveError } from '../lib/store';
import { useT } from '../lib/i18n';
import { folderName, plainTitle, relativeTime, shortPath } from '../lib/format';
import { resolveLang } from '../lib/i18n';
import { LANGUAGES, LANGUAGE_NAMES, SWITCH_TO } from '@favilla/core/i18n';
import { desktop } from '../lib/desktop';
import type { Effort } from '../lib/types';
import { fileManagerLabel, revealFolder } from './Folders';
import {
  DeviceMobile,
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsInLineVertical,
  ChatCenteredText,
  Compass,
  Cpu,
  FolderOpen,
  FolderSimple,
  GaugeIcon,
  GearSix,
  ListNumbers,
  MagnifyingGlass,
  Moon,
  NotePencil,
  SidebarSimple,
  Sun,
  Translate,
} from './icons';
import { Keys } from './ui/Keys';
import { openFind } from '../lib/find';
import { EFFORTS } from '../lib/modes';
import { undoLastTurn } from '../lib/undo';
import { NARROW, layoutChoice, setLayout } from '../lib/layout';

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keys?: string;
  icon: ReactNode;
  /** Extra words that should find this command. */
  terms?: string;
  run: () => void | Promise<unknown>;
}

/** Subsequence match with a bonus for word starts; null when the query does not fit. */
function score(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  const direct = s.indexOf(q);
  if (direct >= 0) return 100 - direct + (direct === 0 || /\W/.test(s[direct - 1]) ? 50 : 0);
  let at = 0;
  let total = 0;
  for (const ch of q) {
    const i = s.indexOf(ch, at);
    if (i < 0) return null;
    total += i === at ? 3 : i === 0 || /[\s/_.-]/.test(s[i - 1]) ? 2 : 0;
    at = i + 1;
  }
  return total;
}

export function CommandPalette() {
  const t = useT();
  const open = useStore((s) => s.ui.palette);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sessions = useStore((s) => s.sessions);
  const providers = useStore((s) => s.providers);
  const session = useStore((s) => s.session);
  const recent = useStore((s) => s.recent);
  const folder = useStore((s) => s.folder);
  const info = useStore((s) => s.info);
  const lang = resolveLang(info?.config.language);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    if (!open) return [];
    const close = () => setUi({ palette: false });
    const cmds: Command[] = [];
    const action = (c: Omit<Command, 'group'>) => cmds.push({ ...c, group: t('Actions') });
    action({ id: 'new', label: t('New session'), keys: 'Mod+N', icon: <NotePencil size={16} />, run: () => actions.newSession() });
    action({
      id: 'folder',
      label: t('Open folder…'),
      keys: 'Mod+O',
      icon: <FolderOpen size={16} />,
      run: async () => {
        if (desktop) {
          const p = await desktop.pickFolder();
          if (p) await actions.setFolder(p);
        } else setUi({ picker: true });
      },
    });
    if (folder)
      action({ id: 'reveal', label: t(fileManagerLabel(info?.platform)), hint: shortPath(folder, 44), keys: 'Mod+Shift+E', icon: <ArrowSquareOut size={16} />, terms: 'explorer finder reveal show folder workspace 资源管理器 文件夹', run: () => revealFolder(folder, t) });
    if (session) {
      action({ id: 'find', label: t('Find in this conversation'), keys: 'Mod+F', icon: <MagnifyingGlass size={16} />, terms: 'search find 查找 搜索', run: () => openFind() });
      action({ id: 'outline', label: t('Go to one of your messages'), icon: <ListNumbers size={16} />, terms: 'outline jump message 大纲 跳转 消息', run: () => setUi({ panel: true, panelTab: 'outline' }) });
      const mode = session.meta.mode;
      action({ id: 'mode', label: mode === 'plan' ? t('Leave plan mode') : t('Switch to plan mode'), keys: 'Shift+Tab', icon: <Compass size={16} />, run: () => actions.settings({ mode: mode === 'plan' ? 'build' : 'plan' }) });
      action({
        id: 'compact',
        label: t('Compact the context now'),
        icon: <ArrowsInLineVertical size={16} />,
        terms: 'summary summarize context',
        run: () => actions.compact().catch((e) => toast(String(e), 'error')),
      });
      action({
        id: 'undo',
        label: t('Undo the last turn’s file changes'),
        icon: <ArrowCounterClockwise size={16} />,
        terms: 'revert restore rollback',
        run: () => undoLastTurn(t),
      });
    }
    action({ id: 'sidebar', label: t('Toggle the sidebar'), keys: 'Mod+B', icon: <SidebarSimple size={16} />, run: () => setUi({ sidebar: !getState().ui.sidebar }) });
    if (session) action({ id: 'panel', label: t('Toggle the side panel'), keys: 'Mod+Alt+B', icon: <SidebarSimple size={16} mirrored />, run: () => setUi({ panel: !getState().ui.panel }) });
    if (window.matchMedia(NARROW).matches) action({ id: 'layout', label: layoutChoice() === 'simple' ? t('Full layout') : t('Simple layout'), icon: <DeviceMobile size={16} />, terms: 'phone mobile simple full layout 手机 简易 完整 布局', run: () => setLayout(layoutChoice() === 'simple' ? 'full' : 'simple') });
    action({ id: 'settings', label: t('Settings'), keys: 'Mod+,', icon: <GearSix size={16} />, run: () => setUi({ settings: true }) });
    const theme = info?.config.theme ?? 'auto';
    for (const [value, label, icon] of [
      ['drafting', t('Theme: Drafting (light)'), <Sun key="s" size={16} />],
      ['nightshift', t('Theme: Night shift (dark)'), <Moon key="m" size={16} />],
      ['auto', t('Theme: follow the system'), <Sun key="a" size={16} />],
      ['daylight', t('Theme: Daylight (light)'), <Sun key="d" size={16} />],
      ['porcelain', t('Theme: Porcelain (light)'), <Sun key="p" size={16} />],
      ['plain', t('Theme: Plain (light)'), <Sun key="pl" size={16} />],
      ['kiln', t('Theme: Kiln (light)'), <Sun key="k" size={16} />],
      ['kiln-night', t('Theme: Kiln at night (dark)'), <Moon key="kn" size={16} />],
      ['kiln-auto', t('Theme: Kiln, following the system'), <Sun key="ka" size={16} />],
      ['sky', t('Theme: Clear sky (light)'), <Sun key="sk" size={16} />],
      ['sky-night', t('Theme: Night flight (dark)'), <Moon key="skn" size={16} />],
      ['sky-auto', t('Theme: Clear sky, following the system'), <Sun key="ska" size={16} />],
    ] as const) {
      if (value !== theme) action({ id: `theme-${value}`, label, icon, terms: 'appearance dark light warm white blue sky 主题 陶窑 瓷白 素白 白色 浅色 晴空 夜航 蓝色', run: () => actions.setConfig({ theme: value }).catch(settingSaveError) });
    }
    // Written in English whatever the page shows, for someone who cannot read the language it is in.
    if (lang !== 'en') action({ id: 'lang', label: SWITCH_TO.en, icon: <Translate size={16} />, terms: 'language 语言', run: () => actions.setConfig({ language: 'en' }).catch(settingSaveError) });
    // Each language under its own name and "switch to" in its own words, found by searching in either.
    for (const l of LANGUAGES) {
      if (l === lang) continue;
      cmds.push({ id: `lang-${l}`, group: t('Language'), label: LANGUAGE_NAMES[l], hint: SWITCH_TO[l], icon: <Translate size={16} />, terms: `${l} language 语言 語言 言語 언어 idioma langue sprache язык`, run: () => actions.setConfig({ language: l }).catch(settingSaveError) });
    }

    const current = session ? `${session.meta.provider}/${session.meta.model}` : (getState().draft.model ?? info?.config.model);
    for (const p of providers.filter((x) => x.configured)) {
      for (const m of p.models) {
        if (m.ref === current) continue;
        cmds.push({ id: `model-${m.ref}`, group: t('Models'), label: m.name, hint: p.name, icon: <Cpu size={16} />, terms: m.ref, run: () => actions.settings({ model: m.ref }) });
      }
    }
    const efforts: Effort[] = session?.model.efforts ?? EFFORTS;
    const effort = session?.meta.effort ?? getState().draft.effort;
    for (const e of efforts) {
      if (e === effort) continue;
      cmds.push({ id: `effort-${e}`, group: t('Reasoning effort'), label: e, icon: <GaugeIcon size={16} />, terms: 'effort reasoning thinking', run: () => actions.settings({ effort: e }) });
    }
    for (const s of sessions) {
      if (s.id === session?.meta.id) continue;
      cmds.push({
        id: `session-${s.id}`,
        group: t('Sessions'),
        label: plainTitle(s.title) || t('Untitled session'),
        hint: relativeTime(s.updated, lang),
        icon: <ChatCenteredText size={16} />,
        run: () => actions.open(s.id),
      });
    }
    for (const f of recent) {
      if (f === folder) continue;
      cmds.push({ id: `folder-${f}`, group: t('Folders'), label: folderName(f), hint: shortPath(f, 48), icon: <FolderSimple size={16} />, terms: f, run: () => actions.setFolder(f) });
    }
    return cmds.map((c) => ({ ...c, run: () => (close(), c.run()) }));
  }, [open, sessions, providers, session, recent, folder, info, lang, t]);

  const shown = useMemo(() => {
    const q = query.trim();
    const scored = commands
      .map((c) => ({ c, s: score(q, `${c.label} ${c.terms ?? ''} ${c.hint ?? ''}`) }))
      .filter((x) => x.s !== null);
    if (q) scored.sort((a, b) => b.s! - a.s!);
    // Without a query, keep actions first and cap the long groups.
    const caps: Record<string, number> = {};
    return scored
      .map((x) => x.c)
      .filter((c) => q || c.group === t('Actions') || (c.group !== t('Language') && (caps[c.group] = (caps[c.group] ?? 0) + 1) <= 5))
      .slice(0, 60);
  }, [commands, query, t]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const runAt = (i: number) => {
    const c = shown[i];
    if (c) Promise.resolve(c.run()).catch((e) => toast(String(e), 'error'));
  };
  let lastGroup = '';
  return createPortal(
    <div className="scrim is-palette" onPointerDown={(e) => e.target === e.currentTarget && setUi({ palette: false })}>
      <section className="palette" role="dialog" aria-modal="true" aria-label={t('Command palette')}>
        <label className="palette-search">
          <MagnifyingGlass size={16} />
          <input
            ref={input}
            value={query}
            placeholder={t('Type a command, a session or a model')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') e.preventDefault(), setActive((a) => Math.min(a + 1, shown.length - 1));
              else if (e.key === 'ArrowUp') e.preventDefault(), setActive((a) => Math.max(a - 1, 0));
              else if (e.key === 'Enter') e.preventDefault(), runAt(active);
              else if (e.key === 'Escape') e.preventDefault(), setUi({ palette: false });
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `cmd-${shown[active].id}` : undefined}
          />
          <Keys combo="Esc" />
        </label>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <p className="palette-empty">{t('Nothing matches.')}</p>}
          {shown.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id} role="presentation">
                {head && <div className="palette-group">{head}</div>}
                <button
                  id={`cmd-${c.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item ${i === active ? 'is-active' : ''}`}
                  onPointerMove={() => i !== active && setActive(i)}
                  onClick={() => runAt(i)}
                >
                  <span className="palette-icon">{c.icon}</span>
                  <span className="palette-label">{c.label}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                  {c.keys && <Keys combo={c.keys} />}
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>,
    document.body,
  );
}
