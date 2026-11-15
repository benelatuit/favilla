import { useEffect, useState } from 'react';
import { actions, setUi, toast, useStore } from '../lib/store';
import { productName, useT } from '../lib/i18n';
import type { ConnectionState } from '../lib/api';
import { desktop } from '../lib/desktop';
import { clock, folderName, plainTitle } from '../lib/format';
import { useEverySecond } from '../lib/clock';
import { MagnifyingGlass, Question, SidebarSimple } from './icons';
import { Keys } from './ui/Keys';
import { UpdateButton } from './UpdateButton';

/**
 * The connection state, but "down" only once it has been down for a moment: a quick reconnect shows nothing. The
 * moment counts from when it went down: the stream's retries flip it between connecting and closed, and a wait
 * started again at each flip kept a lost connection from showing for six seconds and more.
 */
export function useSteadyConnection(): ConnectionState {
  const connection = useStore((s) => s.connection);
  const down = connection !== 'open';
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!down) return setShown(false);
    const timer = setTimeout(() => setShown(true), 2500);
    return () => clearTimeout(timer);
  }, [down]);
  return down && shown ? connection : 'open';
}

/** Time since the turn started, ticking once a second while the agent works. */
export function useElapsed(): string | null {
  const started = useStore((s) => s.turnStarted);
  useEverySecond(!!started);
  return started ? clock(Date.now() - started) : null;
}

export function SessionTitle() {
  const t = useT();
  const meta = useStore((s) => s.session?.meta);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  if (!meta) return <span className="crumb-title is-new">{t('New session')}</span>;
  const title = plainTitle(meta.title) || t('Untitled session');
  if (editing) {
    const save = () => {
      setEditing(false);
      const next = value.trim();
      if (next && next !== meta.title) actions.rename(meta.id, next).catch((e) => toast(String(e), 'error'));
    };
    return (
      <input
        className="crumb-input"
        autoFocus
        value={value}
        aria-label={t('Rename')}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="crumb-title"
      data-tip={t('Rename')}
      onClick={() => {
        setValue(plainTitle(meta.title));
        setEditing(true);
      }}
    >
      {title}
    </button>
  );
}

/**
 * The window's title bar, drawn by the page. It drags the window everywhere except on its controls;
 * on Windows the system's window buttons sit over its right end in the same colours.
 */
export function TitleBar() {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const hasSession = useStore((s) => !!s.session);
  const status = useStore((s) => s.session?.status ?? 'idle');
  const connection = useSteadyConnection();
  const sidebar = useStore((s) => s.ui.sidebar);
  const panel = useStore((s) => s.ui.panel);
  // Work in progress shows where it happens (the working line at the end of the conversation with its time, the stop
  // in the composer, the mark on the session's row); it was told a second time up here. The title bar says what
  // needs the user: an answer the agent waits for, a connection lost.
  const waiting = status === 'waiting';

  return (
    <header className="titlebar">
      <div className="titlebar-lead">
        <button
          type="button"
          className={`icon-btn ${sidebar ? 'is-on' : ''}`}
          aria-label={t('Sidebar')}
          aria-pressed={sidebar}
          data-tip={t('Sidebar')}
          data-keys="Mod+B"
          onClick={() => setUi({ sidebar: !sidebar })}
        >
          <SidebarSimple size={16} />
        </button>
        <img src="./icon-small.png" alt="" className="titlebar-mark" />
        {/* Shown while the sidebar is docked open, when the lead is the sidebar's own head (shell.css). */}
        <span className="titlebar-name">{productName}</span>
      </div>
      <nav className="crumbs" aria-label={t('Location')}>
        <span className="crumb-folder" data-tip={folder}>
          {folderName(folder)}
        </span>
        <span className="crumb-sep" aria-hidden>
          /
        </span>
        <SessionTitle />
      </nav>
      <div className="titlebar-fill" />
      <UpdateButton />
      {waiting && (
        <span className="titlebar-status is-waiting" aria-live="polite">
          <Question size={14} weight="bold" />
          <span>{t('Waiting for you')}</span>
        </span>
      )}
      {connection !== 'open' && (
        <span className="titlebar-status is-offline" data-tip={connection === 'unauthorized' && !desktop ? t('Open the link that favilla web printed again.') : undefined}>
          {connection === 'unauthorized' && !desktop ? t('This page lost its access') : t('Reconnecting…')}
        </span>
      )}
      <div className="titlebar-tools">
        <button type="button" className="titlebar-search" onClick={() => setUi({ palette: true })} aria-label={t('Command palette')}>
          <MagnifyingGlass size={14} />
          <span>{t('Search and commands')}</span>
          <Keys combo="Mod+K" />
        </button>
        {hasSession && (
          <button
            type="button"
            className={`icon-btn ${panel ? 'is-on' : ''}`}
            aria-label={t('Side panel')}
            aria-pressed={panel}
            data-tip={t('Side panel')}
            data-keys="Mod+Alt+B"
            onClick={() => setUi({ panel: !panel })}
          >
            <SidebarSimple size={16} mirrored />
          </button>
        )}
      </div>
    </header>
  );
}
