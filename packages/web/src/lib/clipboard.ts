import { toast } from './store';

/**
 * Copy text and say so: `done` is the translation key of the note shown once it is copied. A clipboard the page may
 * not use (an insecure origin, a denied permission) is said too, where some copies failed without a word.
 */
export function copyText(text: string, t: (key: string) => string, done = 'Copied'): Promise<boolean> {
  return navigator.clipboard.writeText(text).then(
    () => {
      toast(t(done), 'info');
      return true;
    },
    () => {
      toast(t('Could not use the clipboard'), 'error');
      return false;
    },
  );
}
