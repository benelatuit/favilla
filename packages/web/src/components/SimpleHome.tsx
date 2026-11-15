import { useMemo, useState } from 'react';
import { actions, toast, useStore } from '../lib/store';
import { fill, resolveLang, useT } from '../lib/i18n';
import { dayGroup, folderName, plainTitle, shortTime } from '../lib/format';
import { setComposing } from '../lib/layout';
import type { SessionListItem } from '../lib/types';
import { CircleNotch, FolderSimple, GitBranch, MagnifyingGlass, NotePencil, Question, X } from './icons';
import { pickFolder } from './Folders';

/** Sessions the list shows before "Show more". */
const SHOWN = 30;

function Row({ s }: { s: SessionListItem }) {
  const t = useT();
  const lang = useStore((st) => resolveLang(st.info?.config.language));
  const title = plainTitle(s.title) || t('Untitled session');
  const state = s.live === 'waiting' ? 'waiting' : s.live === 'running' || s.live === 'compacting' ? 'running' : null;
  return (
    <button type="button" className={`simple-row ${state ? `is-${state}` : ''}`} onClick={() => actions.open(s.id).catch((e) => toast(String(e), 'error'))}>
      <span className="simple-row-title">
        {s.branchOf && <GitBranch size={14} className="simple-row-branch" aria-hidden />}
        {title}
      </span>
      <span className="simple-row-meta">
        {state === 'waiting' && (
          <span className="simple-row-state">
            <Question size={12} weight="bold" />
            {t('Waiting for you')}
          </span>
        )}
        {state === 'running' && (
          <span className="simple-row-state">
            <CircleNotch size={12} className="spin" />
            {s.live === 'compacting' ? t('Compacting context') : t('Working')}
          </span>
        )}
        <span className="simple-row-folder">{folderName(s.cwd)}</span>
        <span>{s.model}</span>
        {!state && <span className="num">{shortTime(s.updated, lang)}</span>}
      </span>
    </button>
  );
}

/**
 * The simple layout's home page: a new session in the current folder, a search, and every folder's sessions in one
 * list, those that need the user first, then those at work, then by day.
 */
export function SimpleHome() {
  const t = useT();
  const sessions = useStore((s) => s.sessions);
  const folder = useStore((s) => s.folder);
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? sessions.filter((s) => plainTitle(s.title).toLowerCase().includes(q)) : sessions;
    const waiting = list.filter((s) => s.live === 'waiting');
    const working = list.filter((s) => s.live === 'running' || s.live === 'compacting');
    const rest = list.filter((s) => !waiting.includes(s) && !working.includes(s)).sort((a, b) => b.updated - a.updated);
    const shown = all || q ? rest : rest.slice(0, SHOWN);
    const by = (g: string[]) => shown.filter((s) => g.includes(dayGroup(s.updated)));
    return {
      list: [
        { key: 'waiting', title: t('Needs you'), items: waiting },
        { key: 'working', title: t('At work'), items: working },
        { key: 'today', title: t('Today'), items: by(['today']) },
        { key: 'yesterday', title: t('Yesterday'), items: by(['yesterday']) },
        { key: 'earlier', title: t('Earlier'), items: by(['week', 'older']) },
      ].filter((g) => g.items.length),
      hidden: rest.length - shown.length,
      none: list.length === 0,
    };
  }, [sessions, query, all, t]);

  const start = () => {
    actions.newSession();
    setComposing(true);
  };

  return (
    <div className="simple-home">
      <div className="simple-home-inner">
        <div className="simple-start">
          <button type="button" className="simple-new" onClick={start}>
            <NotePencil size={16} />
            <span>{t('New session')}</span>
          </button>
          <button type="button" className="simple-folder" onClick={() => void pickFolder()} aria-label={t('Open folder…')}>
            <FolderSimple size={16} />
            <span>{folderName(folder)}</span>
          </button>
        </div>
        <label className="simple-search">
          <MagnifyingGlass size={16} />
          <input type="search" placeholder={t('Search sessions')} value={query} onChange={(e) => setQuery(e.target.value)} enterKeyHint="search" />
          {query && (
            <button type="button" className="icon-btn" aria-label={t('Clear')} onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          )}
        </label>
        {groups.none && <p className="simple-empty">{query ? t('No session matches.') : t('No sessions here yet.')}</p>}
        {groups.list.map((g) => (
          <section key={g.key} className={`simple-group is-${g.key}`}>
            <h2>{g.title}</h2>
            <div className="simple-rows">
              {g.items.map((s) => (
                <Row key={s.id} s={s} />
              ))}
            </div>
          </section>
        ))}
        {groups.hidden > 0 && (
          <button type="button" className="simple-more" onClick={() => setAll(true)}>
            {fill(t('Show {n} more'), groups.hidden)}
          </button>
        )}
      </div>
    </div>
  );
}
