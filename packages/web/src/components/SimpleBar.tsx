import { useRef, useState } from 'react';
import { actions, getState, setUi, toast, useStore } from '../lib/store';
import { fill, productName, useT } from '../lib/i18n';
import { desktop } from '../lib/desktop';
import { folderName, plainTitle } from '../lib/format';
import { setComposing, setLayout, useComposing } from '../lib/layout';
import { ArrowLeft, Compass, DotsThree, GearSix, Question, SidebarSimple } from './icons';
import { sessionEntries } from './contextMenu';
import { SessionTitle, useSteadyConnection } from './TitleBar';
import { Menu, type MenuEntry } from './ui/Menu';
import { anchorOf, type Anchor } from './ui/Popover';

/** Back to the list of sessions: leave the open session, or the new one being written. */
export function goHome(): void {
  if (getState().session) actions.newSession();
  setComposing(false);
}

/**
 * The simple layout's bar. At home: the name and how many sessions are at work. In a session: back, the title (tap
 * to rename), and under it the folder, model and effort. Its menu switches to the full layout and opens the settings.
 */
export function SimpleBar() {
  const t = useT();
  const session = useStore((s) => s.session);
  const meta = session?.meta;
  const working = useStore((s) => s.sessions.filter((x) => x.live === 'running' || x.live === 'compacting').length);
  const composing = useComposing();
  const connection = useSteadyConnection();
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const inside = !!session || composing;
  const waiting = session?.status === 'waiting';
  const plan = useStore((s) => (s.session?.meta.mode ?? s.draft.mode ?? 'build') === 'plan');

  const entries: MenuEntry[] = [
    ...(meta ? [...sessionEntries(meta.id, plainTitle(meta.title), t).filter((e) => !('id' in e) || e.id !== 'rename'), { kind: 'separator' as const }] : []),
    ...(inside
      ? [
          {
            id: 'plan',
            label: t('Plan'),
            hint: t('Plans first and changes nothing until you approve'),
            icon: <Compass size={16} />,
            checked: plan,
            onSelect: () => actions.settings({ mode: plan ? 'build' : 'plan' }).catch((err) => toast(String(err), 'error')),
          },
          { kind: 'separator' as const },
        ]
      : []),
    { id: 'full', label: t('Full layout'), hint: t('As on the computer'), icon: <SidebarSimple size={16} />, onSelect: () => setLayout('full') },
    { id: 'settings', label: t('Settings'), icon: <GearSix size={16} />, onSelect: () => setUi({ settings: true }) },
  ];

  return (
    <header className="titlebar simple-bar">
      {inside ? (
        <button type="button" className="icon-btn simple-back" aria-label={t('Back')} onClick={goHome}>
          <ArrowLeft size={20} />
        </button>
      ) : (
        <img src="./icon-small.png" alt="" width={18} height={18} className="titlebar-mark" />
      )}
      <div className="simple-bar-text">
        {meta ? <SessionTitle /> : <span className="simple-bar-name">{composing ? t('New session') : productName}</span>}
        {meta ? (
          <span className="simple-bar-sub">
            {folderName(meta.cwd)} · {session.model?.name ?? meta.model} · {meta.effort}
          </span>
        ) : (
          !composing && working > 0 && <span className="simple-bar-sub">{fill(t('{n} at work'), working)}</span>
        )}
      </div>
      {waiting && (
        <span className="titlebar-status is-waiting" aria-live="polite">
          <Question size={14} weight="bold" />
          <span>{t('Waiting for you')}</span>
        </span>
      )}
      {connection !== 'open' && (
        <span className="titlebar-status is-offline">{connection === 'unauthorized' && !desktop ? t('This page lost its access') : t('Reconnecting…')}</span>
      )}
      <button ref={more} type="button" className="icon-btn" aria-label={t('More')} onClick={() => setMenu(menu ? null : anchorOf(more.current!))}>
        <DotsThree size={20} weight="bold" />
      </button>
      {menu && <Menu anchor={menu} placement="bottom-end" ignore={more.current} entries={entries} onClose={() => setMenu(null)} />}
    </header>
  );
}
