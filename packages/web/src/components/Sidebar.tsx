import { memo, useMemo, useRef, useState } from 'react';
import { actions, folderKey, setUi, toast, useStore } from '../lib/store';
import { fill, resolveLang, useT } from '../lib/i18n';
import { folderName, plainTitle, shortPath, shortTime } from '../lib/format';
import { copyText } from '../lib/clipboard';
import { resetIn, windowName } from '../lib/plan';
import type { SessionListItem } from '../lib/types';
import { ArrowSquareOut, CaretRight, CircleNotch, Copy, DeviceMobile, DotsThree, FolderPlus, GearSix, GitBranch, MagnifyingGlass, NotePencil, PushPin, X } from './icons';
import { fileManagerLabel, pickFolder, revealFolder } from './Folders';
import { sessionEntries } from './contextMenu';
import { Menu, type MenuEntry } from './ui/Menu';
import { anchorOf, type Anchor } from './ui/Popover';
import { NARROW, setLayout, useMedia } from '../lib/layout';

/** Sessions a folder shows before "Show more". */
const SHOWN = 6;

function RenameField({ s }: { s: SessionListItem }) {
  const t = useT();
  const done = (value: string | null) => {
    setUi({ renaming: null });
    const next = value?.trim();
    if (next && next !== s.title) actions.rename(s.id, next).catch((e) => toast(String(e), 'error'));
  };
  return (
    <input
      className="side-rename"
      autoFocus
      defaultValue={plainTitle(s.title)}
      aria-label={t('Rename')}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => done(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') done(null);
      }}
    />
  );
}

const SessionRow = memo(function SessionRow({ s, active, onNavigate, hint }: { s: SessionListItem; active: boolean; onNavigate: () => void; hint?: string }) {
  const t = useT();
  const lang = useStore((st) => resolveLang(st.info?.config.language));
  const renaming = useStore((st) => st.ui.renaming === s.id);
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const title = plainTitle(s.title) || t('Untitled session');
  return (
    <div className={`side-item ${active ? 'is-active' : ''} ${menu ? 'is-menu' : ''}`} data-ctx="session" data-id={s.id} data-title={title}>
      {renaming ? (
        <RenameField s={s} />
      ) : (
        <button
          type="button"
          className="side-open"
          aria-current={active ? 'page' : undefined}
          onClick={() => {
            actions.open(s.id).catch((e) => toast(String(e), 'error'));
            onNavigate();
          }}
          onDoubleClick={() => setUi({ renaming: s.id })}
        >
          {s.branchOf && (
            <span className="side-branch" data-tip={fill(t('Branch of {n}'), plainTitle(s.branchOf.title) || t('Untitled session'))}>
              <GitBranch size={12} />
            </span>
          )}
          <span className="side-title">{title}</span>
          {hint && <span className="side-hint">{hint}</span>}
          {s.live === 'running' ? (
            <span className="side-live" aria-label={t('Working')}>
              <CircleNotch size={12} className="spin" />
            </span>
          ) : (
            <span className="side-time num">{shortTime(s.updated, lang)}</span>
          )}
        </button>
      )}
      {!renaming && (
        <button ref={more} type="button" className="icon-btn is-small side-more" aria-label={t('More')} onClick={() => setMenu(menu ? null : anchorOf(more.current!))}>
          <DotsThree size={16} weight="bold" />
        </button>
      )}
      {menu && <Menu anchor={menu} placement="bottom-end" ignore={more.current} entries={sessionEntries(s.id, title, t)} onClose={() => setMenu(null)} />}
    </div>
  );
});

/** What is left of each limit of the plan, as the server last reported it; the bar is what is left. */
function PlanUsage() {
  const t = useT();
  const plan = useStore((s) => s.session?.usage.plan);
  if (!plan?.windows?.length) return null;
  return (
    <div className="side-usage" aria-label={t('Plan usage')}>
      {plan.windows.map((w) => {
        const left = Math.max(0, Math.min(100, 100 - w.usedPercent));
        const name = windowName(w, t);
        return (
          <div key={w.minutes} className={`usage-row ${left < 15 ? 'is-low' : ''}`} data-tip={`${name}: ${fill(t('{n}% used'), Math.round(w.usedPercent))}${w.resetAt ? ` · ${resetIn(w.resetAt, t)}` : ''}`}>
            <span className="usage-label">{name}</span>
            <span className="usage-track">
              <span className="usage-fill" style={{ transform: `scaleX(${left / 100})` }} />
            </span>
            <span className="usage-value num">{fill(t('{n}% left'), Math.round(left))}</span>
          </div>
        );
      })}
    </div>
  );
}

/** One folder in the sidebar: its name folds it, its sessions under it, newest first. */
const FolderGroup = memo(function FolderGroup({ path, items, current, folded, activeId, onNavigate }: { path: string; items: SessionListItem[]; current: boolean; folded: boolean; activeId: string | null; onNavigate: () => void }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const name = folderName(path);
  const working = items.filter((s) => s.live === 'running').length;
  // The open session stays in view when it is further down than the first few.
  const shown = all ? items : items.filter((s, i) => i < SHOWN || s.id === activeId);
  const startHere = () => {
    if (current) actions.newSession();
    else actions.setFolder(path).catch((e) => toast(String(e), 'error'));
    onNavigate();
  };
  const entries: MenuEntry[] = [
    { id: 'new', label: t('New session'), icon: <NotePencil size={16} />, onSelect: startHere },
    { id: 'reveal', label: t(fileManagerLabel()), icon: <ArrowSquareOut size={16} />, onSelect: () => void revealFolder(path, t) },
    { id: 'copy-path', label: t('Copy path'), icon: <Copy size={16} />, onSelect: () => void copyText(path, t) },
    // The current folder stays listed whatever is chosen: removing it would only look broken.
    ...(current ? [] : [{ kind: 'separator' as const }, { id: 'forget', label: t('Remove from the sidebar'), hint: t('Its sessions are kept'), icon: <X size={16} />, onSelect: () => actions.forgetFolder(path) }]),
  ];
  return (
    <section className={`side-group is-folder ${current ? 'is-current' : ''} ${folded ? 'is-folded' : ''}`}>
      <div className={`side-folder-head ${menu ? 'is-menu' : ''}`}>
        <button type="button" className="side-folder-toggle" aria-expanded={!folded} data-tip={shortPath(path, 60)} onClick={() => actions.fold(path, !folded)}>
          <CaretRight size={12} weight="bold" className="side-caret" />
          <span className="side-folder-name">{name}</span>
          {folded && working > 0 && (
            <span className="side-live" aria-label={fill(t('{n} at work'), working)}>
              <CircleNotch size={12} className="spin" />
            </span>
          )}
        </button>
        <button type="button" className="icon-btn is-small side-folder-act" aria-label={fill(t('New session in {n}'), name)} data-tip={fill(t('New session in {n}'), name)} onClick={startHere}>
          <NotePencil size={14} />
        </button>
        <button ref={more} type="button" className="icon-btn is-small side-folder-act" aria-label={t('More')} onClick={() => setMenu(menu ? null : anchorOf(more.current!))}>
          <DotsThree size={16} weight="bold" />
        </button>
        {menu && <Menu anchor={menu} placement="bottom-end" ignore={more.current} entries={entries} onClose={() => setMenu(null)} />}
      </div>
      {!folded && (
        <>
          {items.length === 0 && <p className="side-folder-empty">{t('No sessions here yet.')}</p>}
          {shown.map((s) => (
            <SessionRow key={s.id} s={s} active={s.id === activeId} onNavigate={onNavigate} />
          ))}
          {items.length > SHOWN && (
            <button type="button" className="side-show" onClick={() => setAll(!all)}>
              {all ? t('Show fewer') : fill(t('Show {n} more'), items.length - shown.length)}
            </button>
          )}
        </>
      )}
    </section>
  );
});

export const Sidebar = memo(function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const t = useT();
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const folder = useStore((s) => s.folder);
  const recent = useStore((s) => s.recent);
  const pinned = useStore((s) => s.pinned);
  const collapsed = useStore((s) => s.collapsed);
  const [query, setQuery] = useState('');
  const narrow = useMedia(NARROW);

  const indexed = useMemo(
    () => sessions.map((s) => ({ s, key: folderKey(s.cwd), lower: plainTitle(s.title).toLowerCase() })),
    [sessions],
  );

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byFolder = new Map<string, SessionListItem[]>();
    const pins = new Set(pinned);
    const byId = q ? undefined : new Map(sessions.map((s) => [s.id, s]));
    for (const { s, key: k, lower } of indexed) {
      if (q ? !lower.includes(q) : pins.has(s.id)) continue;
      let list = byFolder.get(k);
      if (!list) byFolder.set(k, (list = []));
      list.push(s);
    }
    // The folders opened here, in the order they were first opened, then any other with a session at work in it
    // (one started from the phone or the command line). A search goes through every folder's sessions.
    const folders = new Map<string, string>();
    for (const f of [...recent, folder]) if (f && !folders.has(folderKey(f))) folders.set(folderKey(f), f);
    for (const { s, key: k } of indexed) {
      if (!folders.has(k) && (q ? byFolder.has(k) : s.live === 'running')) folders.set(k, s.cwd);
    }
    const groups = [...folders].map(([key, path]) => ({ key, path, items: byFolder.get(key) ?? [] })).filter((g) => !q || g.items.length);
    const top = q ? [] : pinned.map((id) => byId!.get(id)).filter((s): s is SessionListItem => !!s);
    return { groups, top, matches: q ? groups.reduce((n, g) => n + g.items.length, 0) : -1 };
  }, [sessions, indexed, query, folder, recent, pinned]);
  const here = folderKey(folder);

  return (
    <aside className="sidebar" aria-label={t('Sessions')}>
      <div className="side-head">
        {/* The shortcuts of the rows that have one are in their tips: printed on the rows, they were more boxes in a
            column of words. */}
        <button
          type="button"
          className="side-new"
          data-tip={fill(t('New session in {n}'), folderName(folder))}
          data-keys="Mod+N"
          onClick={() => {
            actions.newSession();
            onNavigate();
          }}
        >
          <NotePencil size={16} />
          <span>{t('New session')}</span>
        </button>
        <label className="side-search">
          <MagnifyingGlass size={14} />
          <input type="text" placeholder={t('Search sessions')} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
          {query && (
            <button type="button" className="icon-btn is-small" aria-label={t('Clear')} onClick={() => setQuery('')}>
              <X size={12} />
            </button>
          )}
        </label>
      </div>
      <nav className="side-list" aria-label={t('Sessions')}>
        {view.top.length > 0 && (
          <section className="side-group is-pinned">
            <h3>
              <PushPin size={12} />
              {t('Pinned')}
            </h3>
            {view.top.map((s) => (
              <SessionRow key={s.id} s={s} active={s.id === activeId} onNavigate={onNavigate} hint={folderKey(s.cwd) === here ? undefined : folderName(s.cwd)} />
            ))}
          </section>
        )}
        <div className="side-folders-head">
          <h3>{view.matches >= 0 ? fill(t('{n} sessions found'), view.matches) : t('Folders')}</h3>
          {view.matches < 0 && (
            <button type="button" className="icon-btn is-small" aria-label={t('Open folder…')} data-tip={t('Open folder…')} data-keys="Mod+O" onClick={() => void pickFolder()}>
              <FolderPlus size={14} />
            </button>
          )}
        </div>
        {view.matches === 0 && <p className="side-empty">{t('No session matches.')}</p>}
        {view.groups.map((g) => (
          <FolderGroup key={g.key} path={g.path} items={g.items} current={g.key === here} folded={view.matches < 0 && collapsed.includes(g.key)} activeId={activeId} onNavigate={onNavigate} />
        ))}
      </nav>
      <footer className="side-foot">
        <PlanUsage />
        {narrow && (
          <button type="button" className="side-settings" onClick={() => setLayout('simple')}>
            <DeviceMobile size={16} />
            <span>{t('Simple layout')}</span>
          </button>
        )}
        <button type="button" className="side-settings" data-tip={t('Settings')} data-keys="Mod+," onClick={() => setUi({ settings: true })}>
          <GearSix size={16} />
          <span>{t('Settings')}</span>
        </button>
      </footer>
    </aside>
  );
});
