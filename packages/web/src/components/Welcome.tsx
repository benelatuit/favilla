import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { actions, folderKey, setUi, toast, useStore } from '../lib/store';
import { count, resolveLang, useT } from '../lib/i18n';
import { plainTitle, shortTime } from '../lib/format';
import type { SessionListItem } from '../lib/types';
import { Warning } from './icons';
import { Composer, compose } from './Composer';
import { FolderSwitcher } from './Folders';

const STARTERS = [
  { label: 'Explain how this project is put together', prompt: 'Explain how this project is put together: the main parts, how they connect, and where to start reading.' },
  { label: 'Find why the tests fail and fix it', prompt: 'Run the tests, find out why any of them fail, and fix the cause.' },
  { label: 'Review my uncommitted changes', prompt: 'Review my uncommitted changes: point out bugs, risky spots and anything I missed. Do not change files.' },
  { label: 'Make the build pass', prompt: 'Run the build and the type check, and fix what fails.' },
];

/** Sessions the welcome page lists: enough to pick up recent work, few enough to leave the composer the focus. */
const RECENT = 5;

type T = (key: string) => string;

/** Where a session stands, in a few words: what it waits for or does now, else how its last turn ended. */
export function stateOf(s: SessionListItem, t: T): { text: string; waiting?: boolean } | null {
  if (s.live === 'waiting') return { text: t('Waiting for you'), waiting: true };
  if (s.live === 'compacting') return { text: t('Compacting context') };
  if (s.live === 'running') return { text: t('Working') };
  switch (s.last?.end) {
    case 'done':
      return { text: s.last.files ? count(t, s.last.files, 'Changed {n} file', 'Changed {n} files') : t('Finished') };
    case 'aborted':
      return { text: t('Stopped by you') };
    case 'max_steps':
      return { text: t('Stopped at the step limit') };
    case 'error':
      return { text: t('Stopped on an error') };
    case 'refusal':
      return { text: t('The model declined') };
    default:
      return null;
  }
}

/** The folder's own sessions, newest first as the list holds them, not those another window only reads. */
function useRecent(): SessionListItem[] {
  const folder = useStore((s) => s.folder);
  const sessions = useStore((s) => s.sessions);
  return useMemo(() => {
    const key = folderKey(folder);
    return sessions.filter((s) => !s.home && folderKey(s.cwd) === key).slice(0, RECENT);
  }, [sessions, folder]);
}

type GitState = { branch: string; changed: number };

/**
 * What git last said for each folder this window showed, by folderKey. The page opens with it, and git is asked again
 * only once the page is up: asked as it opened, the request and its answer had cost the opening 1.6 ms of main thread
 * at CPU 4x, and the line came in a moment after the page, moving what stood beside it.
 */
const gitSeen = new Map<string, GitState>();

/** How long after the page is up git is asked: past the frames that draw it and take the first keys. */
const GIT_AFTER_MS = 150;

/** The folder's branch and whether anything is left uncommitted, beside the folder a new session starts in. */
function GitLine() {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const key = folderKey(folder);
  // Asked again when a session here ends a turn: its work is what changes the count.
  const latest = useRecent()[0]?.updated ?? 0;
  const [, redraw] = useState(0);
  // A session on its way in (at start, the one the window had open) shows this page only until its view arrives: no git
  // status for a page about to go, or beside the requests that bring the session.
  const opening = useStore((s) => s.reopening || s.activeId !== null);
  useEffect(() => {
    if (opening) return;
    let current = true;
    const settle = (g: GitState | null) => {
      if (!current) return;
      const was = gitSeen.get(key);
      if (g) gitSeen.set(key, g);
      else gitSeen.delete(key);
      // Drawn again only when git says something new, which on most visits it does not.
      if (was?.branch !== g?.branch || was?.changed !== g?.changed) redraw((n) => n + 1);
    };
    const timer = setTimeout(() => {
      api<GitState | null>(`/git?cwd=${encodeURIComponent(folder)}`)
        .then(settle)
        .catch(() => settle(null));
    }, GIT_AFTER_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key, folder, latest, opening]);
  const git = gitSeen.get(key);
  if (!git) return null;
  return (
    <span className="welcome-git">
      <span className="welcome-branch">{git.branch || t('Not on a branch')}</span>
      <span>{git.changed ? count(t, git.changed, '{n} uncommitted file', '{n} uncommitted files') : t('No uncommitted changes')}</span>
    </span>
  );
}

/** How long after the composer has been painted the list under it is drawn: past the frames that open the page. */
const LIST_AFTER_MS = 100;

/**
 * False until a moment after the page has been painted. What waits for it is drawn after the composer, below it, where
 * nothing above moves.
 */
function useAfterPaint(): boolean {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    let timer = 0;
    // The second frame's callback comes once the first, the one with the composer, has been painted.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = 0;
        timer = window.setTimeout(() => setPainted(true), LIST_AFTER_MS);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, []);
  return painted;
}

/** Under the composer: the folder's latest sessions and where each stands, or for a folder with none a few ways to start. */
function Recent() {
  const t = useT();
  const recent = useRecent();
  const lang = useStore((s) => resolveLang(s.info?.config.language));
  // At start, while the window reopens the session it had open, the page is only standing in: drawing the list then
  // cost the reopen 20 to 30 ms of main thread at CPU 4x, for rows nobody gets to read.
  const reopening = useStore((s) => s.reopening);
  // The composer is what the page opens for, so it is drawn first and the list once the page is up: drawn with it, the
  // rows and their layout had put the opening 1.6 ms of main thread at CPU 4x behind 1.2.22's.
  const painted = useAfterPaint();
  if (reopening || !painted) return null;
  if (!recent.length)
    return (
      <section className="welcome-recent" aria-label={t('No sessions in this folder yet')}>
        <h2>{t('No sessions in this folder yet')}</h2>
        <div className="starters" role="list">
          {STARTERS.map(({ label, prompt }) => (
            <button key={label} type="button" role="listitem" className="starter" onClick={() => compose(t(prompt))}>
              {t(label)}
            </button>
          ))}
        </div>
      </section>
    );
  return (
    <section className="welcome-recent" aria-label={t('Recent sessions')}>
      <h2>{t('Recent sessions')}</h2>
      <div className="recent-list">
        {recent.map((s) => {
          const state = stateOf(s, t);
          const title = plainTitle(s.title) || t('Untitled session');
          return (
            <button key={s.id} type="button" className="recent-row" title={title} onClick={() => actions.open(s.id).catch((e) => toast(String(e), 'error'))}>
              <span className="recent-title">{title}</span>
              <span className={`recent-state ${state?.waiting ? 'is-waiting' : ''}`}>{state?.text}</span>
              <span className="recent-time num">{shortTime(s.updated, lang)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * No session open: the folder and its branch, a composer, and under it the folder's recent sessions with where each
 * stands. A folder with none yet gets a few ways to start in their place. Sending creates the session. The list and the
 * branch follow the sessions in parts of their own: the session list changes on every turn anywhere, and the composer
 * is not drawn again for it.
 */
export function Welcome() {
  const t = useT();
  const providers = useStore((s) => s.providers);
  const ready = providers.some((p) => p.configured && p.models.length);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>{t('What are we working on?')}</h1>
        <div className="welcome-where">
          <FolderSwitcher variant="welcome" />
          <GitLine />
        </div>
        {!ready && (
          <div className="welcome-notice" role="status">
            <Warning size={16} weight="fill" />
            <span>{t('No model is set up yet. Add an API key or a model server on this computer to start.')}</span>
            <button type="button" className="btn is-small btn-primary" onClick={() => setUi({ settings: 'providers' })}>
              {t('Set up a provider')}
            </button>
          </div>
        )}
        <Composer variant="hero" />
        <Recent />
      </div>
    </div>
  );
}
