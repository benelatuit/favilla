import { useState, type ReactNode } from 'react';
import { useStore, toast } from '../../lib/store';
import { fill, productName, resolveLang, useT } from '../../lib/i18n';
import { relativeTime } from '../../lib/format';
import { copyText } from '../../lib/clipboard';
import { desktop } from '../../lib/desktop';
import { checkUpdate, downloadUpdate, installUpdate, refreshUpdate, updatePercent, updateWay } from '../../lib/update';
import { Copy } from '../icons';
import { Pen } from '../Pen';
import { Group, Row, Segmented, useSetConfig } from './Rows';

const NPM_UPDATE = 'npm install -g favilla@latest';

/**
 * Updates, in the general settings: whether to check, what the last check found, and how to get a newer version
 * here. Shown only in a build that names an update feed.
 */
export function UpdateGroup() {
  const t = useT();
  const u = useStore((s) => s.update);
  const lang = useStore((s) => resolveLang(s.info?.config.language));
  const set = useSetConfig();
  const [asking, setAsking] = useState(false);
  if (!u?.feed) return null;
  const fail = (e: unknown) => toast(String(e), 'error');
  const checking = asking || u.checking;
  const latest = u.latest?.version;

  const status = checking ? (
    t('Checking…')
  ) : u.error ? (
    <span data-tip={u.error}>{t('The last check failed')}</span>
  ) : u.available && latest ? (
    fill(t('Version {n} is available'), latest)
  ) : u.checkedAt ? (
    fill(t('Up to date, checked {n}'), relativeTime(u.checkedAt, lang))
  ) : (
    t('Not checked yet')
  );

  const way = updateWay(u);
  let action: ReactNode = null;
  if (u.available && latest) {
    if (way === 'install') {
      const d = u.download;
      action =
        d.state === 'downloading' ? (
          <button type="button" className="btn" disabled>
            <Pen /> {fill(t('Downloading {n}%'), updatePercent(u))}
          </button>
        ) : d.state === 'ready' ? (
          <button type="button" className="btn btn-primary" onClick={() => void installUpdate(u, t).catch(fail)}>
            {t('Restart to update')}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={() => void downloadUpdate().catch(fail)}>
              {d.state === 'failed' ? t('Download again') : fill(t('Update to {n}'), latest)}
            </button>
            {d.state === 'failed' && d.error && <span className="set-note is-warn">{t(d.error)}</span>}
          </>
        );
    } else if (way === 'portable') {
      action = (
        <button type="button" className="btn" onClick={() => desktop?.openExternal(u.portableUrl!)}>
          {t('Open the download page')}
        </button>
      );
    } else if (u.install === 'npm') {
      action = (
        <div className="field-row update-command">
          <code className="mono">{NPM_UPDATE}</code>
          <button type="button" className="icon-btn" aria-label={t('Copy')} data-tip={t('Copy')} onClick={() => void copyText(NPM_UPDATE, t)}>
            <Copy size={14} />
          </button>
        </div>
      );
    } else {
      action = <span className="set-note">{t('Update from the Favilla desktop app.')}</span>;
    }
  }

  return (
    <Group title={t('Updates')}>
      <Row
        id="update-check"
        label={t('Check for updates')}
        note={u.host ? fill(t('Asks {n} for a newer version every few hours.'), u.host) : t('Reads the update feed on this computer.')}
        control={<Segmented value={u.enabled} options={[[true, t('On')], [false, t('Off')]]} onChange={(v) => void set({ 'updates.check': v }).then(() => refreshUpdate())} label={t('Check for updates')} />}
      />
      <Row
        id="update-version"
        label={t('Version')}
        note={
          <>
            {productName} {u.current} · {status}
          </>
        }
        control={
          <button
            type="button"
            className="btn"
            disabled={checking}
            onClick={() => {
              setAsking(true);
              checkUpdate()
                .catch(fail)
                .finally(() => setAsking(false));
            }}
          >
            {t('Check now')}
          </button>
        }
      >
        {(action || (u.available && u.latest?.notes)) && (
          <div className="update-offer">
            {u.available && u.latest?.notes && <p className="update-notes">{u.latest.notes}</p>}
            {action}
          </div>
        )}
      </Row>
    </Group>
  );
}
