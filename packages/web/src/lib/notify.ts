import type { ServerEvent } from './api';
import { desktop } from './desktop';
import { fill, resolveLang, translate } from './i18n';
import type { SessionListItem } from './types';

/**
 * A system notification for what a person must see while Favilla is in the background: a session that finished or
 * stopped, or one waiting for their approval or answer (it does nothing until they come). Clicking it brings the
 * window up on that session. Sub-agents report through their parent and are not announced on their own.
 */
export function notifyAway(e: ServerEvent, sessions: SessionListItem[], language: string | undefined, open: (id: string) => void): void {
  if (typeof Notification === 'undefined' || typeof document === 'undefined' || document.hasFocus()) return;
  if (!('sessionId' in e)) return;
  const item = sessions.find((s) => s.id === e.sessionId);
  if (!item || item.parentId) return;
  const lang = resolveLang(language);
  const tr = (key: string) => translate(lang, key);
  let body = '';
  if (e.type === 'turn.end') {
    if (e.reason === 'done') body = tr('Finished');
    else if (e.reason === 'error') body = fill(tr('Stopped: {n}'), (e.error ?? '').slice(0, 120));
    else if (e.reason === 'max_steps') body = tr('Stopped at the step limit');
  } else if (e.type === 'permission.request') body = fill(tr('Waiting for your approval: {n}'), e.request.title.slice(0, 120));
  else if (e.type === 'question.request') body = tr('Waiting for your answer');
  if (!body) return;
  if (Notification.permission === 'default') {
    void Notification.requestPermission();
    return;
  }
  if (Notification.permission !== 'granted') return;
  const n = new Notification(item.title || 'Favilla', { body, tag: `favilla-${e.sessionId}`, icon: './icon.png' });
  n.onclick = () => {
    desktop?.focusWindow?.();
    window.focus();
    open(e.sessionId);
    n.close();
  };
}
