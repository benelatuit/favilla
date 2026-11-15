import { setUi, toast, useStore } from '../lib/store';
import { fill, useT } from '../lib/i18n';
import { desktop } from '../lib/desktop';
import { downloadUpdate, installUpdate, updatePercent, updateWay } from '../lib/update';
import { ArrowCircleUp } from './icons';

/**
 * A newer version, said once at the title bar's end: one click fetches the installer, the next restarts into it.
 * Nothing shows while there is none, while checking is off, or in a build without an update feed.
 */
export function UpdateButton() {
  const t = useT();
  const u = useStore((s) => s.update);
  if (!u?.feed || !u.available || !u.latest) return null;
  const version = u.latest.version;
  const way = updateWay(u);
  const fail = (e: unknown) => toast(String(e), 'error');

  let label: string;
  let tip: string | undefined;
  let run: (() => void) | undefined;
  if (way === 'install') {
    const d = u.download;
    if (d.state === 'downloading') {
      label = fill(t('Downloading {n}%'), updatePercent(u));
    } else if (d.state === 'ready') {
      label = t('Restart to update');
      tip = fill(t('Version {n} is ready to install'), version);
      run = () => void installUpdate(u, t).catch(fail);
    } else if (d.state === 'failed') {
      label = t('Download again');
      tip = d.error ? t(d.error) : undefined;
      run = () => void downloadUpdate().catch(fail);
    } else {
      label = fill(t('Update to {n}'), version);
      run = () => void downloadUpdate().catch(fail);
    }
  } else if (way === 'portable') {
    label = fill(t('Version {n} is available'), version);
    tip = t('Opens the download page of the new portable file');
    run = () => desktop?.openExternal(u.portableUrl!);
  } else {
    label = fill(t('Version {n} is available'), version);
    run = () => setUi({ settings: 'general' });
  }

  return (
    <button type="button" className={`titlebar-update is-${u.download.state}`} data-tip={tip} disabled={!run} aria-live="polite" onClick={run}>
      <ArrowCircleUp size={15} weight={u.download.state === 'ready' ? 'fill' : 'regular'} />
      <span>{label}</span>
    </button>
  );
}
