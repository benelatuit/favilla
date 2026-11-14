import { actions, confirmDialog, toast } from './store';
import { count } from './i18n';

/** Put back the files the last turn with changes touched, after a yes: from the composer's /undo and the palette. */
export async function undoLastTurn(t: (key: string) => string): Promise<void> {
  const ok = await confirmDialog({
    title: t('Undo the last turn’s file changes?'),
    body: t('Files the agent changed in its last turn with changes go back to how they were before it.'),
    confirm: t('Undo changes'),
    cancel: t('Cancel'),
  });
  if (!ok) return;
  const n = await actions.undoLast().catch((e) => (toast(String(e), 'error'), -1));
  if (n === 0) toast(t('Nothing to undo.'), 'info');
  else if (n > 0) toast(count(t, n, 'Restored {n} file', 'Restored {n} files'), 'info');
}
