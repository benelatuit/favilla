import type { UpdateView } from '@favilla/core/update/view';
import { api } from './api';
import { desktop } from './desktop';
import { fill } from './i18n';
import { confirmDialog, getState, setState, toast } from './store';

/**
 * What the page does with a newer version (core/src/update/updater.ts): an installed desktop app downloads the
 * installer and restarts into it; a portable one opens the page of the new file; anywhere else the page only says
 * there is one, and the settings say how to get it (npm, or the desktop app).
 */
export type UpdateWay = 'install' | 'portable' | 'tell';

export function updateWay(u: UpdateView): UpdateWay {
  if (u.install === 'setup' && desktop?.installUpdate) return 'install';
  if (u.install === 'portable' && desktop && u.portableUrl?.startsWith('https://')) return 'portable';
  return 'tell';
}

/** Reads the view again (after a settings change); a server from before the update check has none, and that is fine. */
export function refreshUpdate(): Promise<void> {
  return api<UpdateView>('/update')
    .then((update) => setState({ update }))
    .catch(() => {});
}

export async function checkUpdate(): Promise<void> {
  setState({ update: await api<UpdateView>('/update/check', { method: 'POST' }) });
}

export async function downloadUpdate(): Promise<void> {
  setState({ update: await api<UpdateView>('/update/download', { method: 'POST' }) });
}

/** Sessions at work stop when the app closes; the user says so first. */
export async function installUpdate(u: UpdateView, t: (key: string) => string): Promise<void> {
  if (!u.file || !u.sha256 || !desktop?.installUpdate) return;
  const working = getState().sessions.filter((s) => s.live === 'running' || s.live === 'compacting').length;
  if (
    working &&
    !(await confirmDialog({
      title: t('Restart to update?'),
      body: fill(t('{n} sessions are at work. They stop when Favilla closes and can be continued after the update.'), working),
      confirm: t('Restart'),
      cancel: t('Cancel'),
    }))
  )
    return;
  const error = await desktop.installUpdate();
  if (error) toast(t(error), 'error');
}

/** Download progress as a whole percentage. */
export const updatePercent = (u: UpdateView): number => (u.download.total ? Math.min(100, Math.floor((u.download.received / u.download.total) * 100)) : 0);
