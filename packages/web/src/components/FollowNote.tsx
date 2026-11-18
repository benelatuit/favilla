import { useEffect } from 'react';
import { fill, useT } from '../lib/i18n';
import { actions, applyFollow, getState, toast, useStore } from '../lib/store';
import type { FollowChange } from '../lib/types';
import { Eye } from './icons';

/**
 * In place of the composer, for a session this window only reads: one line saying why, and the session's event
 * stream while it is open, so messages show as the process that writes it saves them.
 */
export function FollowNote() {
  const t = useT();
  const id = useStore((s) => (s.session?.following ? s.session.meta.id : undefined));
  const holder = useStore((s) => s.session?.following?.holder ?? null);
  const home = useStore((s) => s.session?.following?.home);

  useEffect(() => {
    if (!id) return;
    // What the view holds already; the stream starts after it.
    const after = getState().session?.messages.length ?? 0;
    const source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/follow?after=${after}`);
    source.onmessage = (m) => {
      try {
        applyFollow(id, JSON.parse(m.data) as FollowChange);
      } catch {
        /* a torn event; the next one carries the state */
      }
    };
    return () => source.close();
  }, [id]);

  if (!id) return null;
  const line =
    holder !== null
      ? home
        ? fill(t('This session is running in another Favilla process, in {n}. It is read-only here and shows new messages as they are saved.'), home)
        : t('This session is running in another Favilla process. It is read-only here and shows new messages as they are saved.')
      : home
        ? fill(t('This session is in another Favilla folder, {n}. It is read-only here.'), home)
        : t('The other Favilla process has closed this session.');
  return (
    <div className="follow-note" role="status">
      <Eye size={16} aria-hidden />
      <span>{line}</span>
      {holder === null && !home && (
        <button type="button" className="btn is-small" onClick={() => actions.open(id).catch((e) => toast(String(e), 'error'))}>
          {t('Open here')}
        </button>
      )}
    </div>
  );
}
