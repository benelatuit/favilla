import { useState } from 'react';
import { api } from '../../lib/api';
import { actions, confirmDialog, toast, useStore } from '../../lib/store';
import { fill, useT } from '../../lib/i18n';
import { copyText } from '../../lib/clipboard';
import { fmtBytes, folderName } from '../../lib/format';
import { CircleNotch, Copy, ShieldCheck, Warning } from '../icons';
import { dataDir, fileManagerLabel, revealFolder } from '../Folders';
import { Group, LoadError, Page, Row, Segmented, sep, useSetConfig, useView } from './Rows';

interface View {
  total: number;
  sessions: { bytes: number; count: number };
  blobs: { bytes: number; files: number };
  scratch: { bytes: number; projects: { folder: string; bytes: number; entries: number }[]; reclaimable: { bytes: number; entries: number }; confirmed: boolean };
  browser: { bytes: number; cache: number };
  other: number;
  seal: { on: boolean; key: 'ready' | 'none' | 'unreadable'; place: string | null };
}

/** One part of what Favilla's folder holds: its size in figures, and the way to make room in it. */
function Part({ label, bytes, note, action, busy, onAction }: { label: string; bytes: number; note?: string; action?: string; busy?: boolean; onAction?: () => void }) {
  return (
    <Row
      label={label}
      note={note || undefined}
      control={
        <span className="storage-part">
          <span className="storage-size num">{fmtBytes(bytes)}</span>
          {action && (
            <button type="button" className="btn is-small" disabled={busy} onClick={onAction}>
              {action}
            </button>
          )}
        </span>
      }
    />
  );
}

/** Settings > Storage: where Favilla's disk space goes, room made on request, and how sessions are sealed at rest. */
export function StorageSettings() {
  const t = useT();
  const info = useStore((s) => s.info);
  const set = useSetConfig();
  const { view, error, setView, reload } = useView<View>('/storage');
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [importing, setImporting] = useState('');
  const clean = async (what: string) => {
    setBusy(what);
    try {
      const r = await api<{ removed: number; freed: number; view: View }>('/storage/clean', { body: { what } });
      setView(r.view);
      toast(what === 'seal' ? fill(t('Sealed {n} files.'), r.removed) : fill(t('Made {n} of room.'), fmtBytes(r.freed)), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const showKey = async () => {
    if (!(await confirmDialog({ title: t('Show the recovery key?'), body: t('Anyone with this key and a copy of Favilla’s folder can read your sessions. Keep it where you keep passwords, never in a chat or a repository.'), confirm: t('Show'), cancel: t('Cancel') }))) return;
    try {
      setKey((await api<{ key: string | null }>('/storage/recovery-key', { body: {} })).key);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const importKey = async () => {
    try {
      const r = await api<{ seal: View['seal'] }>('/storage/import-key', { body: { key: importing } });
      if (view) setView({ ...view, seal: r.seal });
      setImporting('');
      toast(t('Key taken in. Sessions it sealed open again.'), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const measure = () =>
    api<View>('/storage?fresh=1')
      .then(setView)
      .catch((e) => toast((e as Error).message, 'error'));
  if (!info) return null;
  const home = dataDir(info.config.globalConfig);
  const seal = view?.seal;
  const sealOn = seal?.on ?? true;
  const sweep = view && (view.scratch.confirmed ? t('Scratch folders are swept once a day: what is two weeks old, copies over 300 MB not touched for two days, and the oldest past 3 GB a project. Nothing changed in the last six hours is touched.') : t('Scratch folders are swept once a day of what is two weeks old. Nothing changed in the last six hours is touched.'));
  return (
    <Page title={t('Storage')} lede={t('What Favilla keeps on this computer. Nothing here touches your projects.')}>
      <Group
        id="space"
        title={t('Space')}
        foot={
          sweep && (
            <p className="set-note">
              {sweep}
              {sep(sweep)}
              <button type="button" className="link" onClick={measure}>
                {t('Measure again')}
              </button>
            </p>
          )
        }
      >
        {!view ? (
          error ? (
            <LoadError error={error} retry={reload} />
          ) : (
            <p className="set-state" role="status">
              <CircleNotch size={14} className="spin" /> {t('Measuring…')}
            </p>
          )
        ) : (
          <>
            <Part label={t('Sessions')} bytes={view.sessions.bytes} note={fill(t('{n} sessions, compressed when idle'), view.sessions.count)} action={t('Compress now')} busy={!!busy} onAction={() => clean('sessions')} />
            <Part label={t('Pictures, outputs and file snapshots')} bytes={view.blobs.bytes} note={t('Each kept once; what no session refers to is dropped')} />
            <Part label={t('Scratch files')} bytes={view.scratch.bytes} note={view.scratch.projects.slice(0, 3).map((p) => `${folderName(p.folder)} ${fmtBytes(p.bytes)}`).join(' · ')} action={t('Clear what is idle')} busy={!!busy} onAction={() => clean('scratch')} />
            {!view.scratch.confirmed && view.scratch.reclaimable.entries > 0 && (
              // The size rules wait for one yes: what they would take is shown first, then they run every day.
              <div className="storage-ask">
                <p className="set-note">{fill(t('By the size rules {n} could go from scratch folders: copies over 300 MB not touched for two days, and the oldest past 3 GB a project. Until you say yes, only what is two weeks old is cleared by itself.'), `${view.scratch.reclaimable.entries} · ${fmtBytes(view.scratch.reclaimable.bytes)}`)}</p>
                <button type="button" className="btn is-small" disabled={!!busy} onClick={() => clean('scratch-rules')}>
                  {t('Clear them, and every day from now on')}
                </button>
              </div>
            )}
            <Part label={t('Favilla’s browser')} bytes={view.browser.bytes} note={fill(t('{n} of it is cache; sign-ins stay'), fmtBytes(view.browser.cache))} action={t('Clear the cache')} busy={!!busy} onAction={() => clean('browser')} />
            <Part label={t('Other')} bytes={view.other} />
            <div className="set-row storage-total">
              <div className="set-label">
                <span className="set-name">{t('Total')}</span>
                <span className="set-note mono set-path-text" data-tip={home}>
                  <bdi>{home}</bdi>
                </span>
              </div>
              <div className="set-control">
                <span className="storage-part">
                  <span className="storage-size num">{fmtBytes(view.total)}</span>
                  <button type="button" className="link" onClick={() => void revealFolder(home, t)}>
                    {t(fileManagerLabel(info.platform))}
                  </button>
                </span>
              </div>
            </div>
          </>
        )}
      </Group>
      <Group title={t('Encryption')}>
        <Row
          id="encryption"
          label={t('Seal sessions')}
          note={t('With a key only your account here can open. A copy of the folder elsewhere needs the recovery key.')}
          control={<Segmented value={sealOn} options={[[true, t('On')], [false, t('Off')]]} onChange={(v) => set({ 'storage.encrypt': v }, info?.basis, async () => { await actions.loadSettings(); reload(); }).then((saved) => { if (saved && view) setView({ ...view, seal: { ...view.seal, on: v } }); })} label={t('Seal sessions')} disabled={!view} />}
        >
          {seal?.place === 'file' && (
            <p className="set-note is-warn">
              <Warning size={14} /> {t('This system has no key store Favilla can use, so the key is kept in a file in Favilla’s folder: a copy of the whole folder takes the key along.')}
            </p>
          )}
          {seal?.key === 'unreadable' && (
            <p className="set-note is-warn">
              <Warning size={14} /> {t('The key on this computer cannot be opened (after a reinstall, say). Take in the recovery key and the sessions it sealed open again; until then new data is kept unsealed.')}
            </p>
          )}
          {seal?.key === 'ready' && seal.on && (
            <div className="set-list-actions">
              <button type="button" className="btn is-small" disabled={!!busy} onClick={() => clean('seal')}>
                {t('Seal what was saved before')}
              </button>
            </div>
          )}
        </Row>
        {seal?.key === 'ready' && (
          <Row
            id="recovery-key"
            label={t('Recovery key')}
            note={t('Opens the sessions on another computer or after a reinstall.')}
            control={
              <button type="button" className="btn" onClick={showKey}>
                <ShieldCheck size={14} /> {t('Show the recovery key')}
              </button>
            }
          >
            {key && (
              <div className="field-row storage-key">
                <code className="mono">{key}</code>
                <button type="button" className="icon-btn" aria-label={t('Copy')} data-tip={t('Copy')} onClick={() => void copyText(key, t)}>
                  <Copy size={14} />
                </button>
              </div>
            )}
          </Row>
        )}
        <Row
          id="take-key"
          label={t('Take in a recovery key')}
          control={
            <div className="field-row">
              <input type="password" autoComplete="off" spellCheck={false} className="set-input mono" value={importing} placeholder="favilla-key-…" aria-label={t('Take in a recovery key')} onChange={(e) => setImporting(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && importing.trim() && importKey()} />
              <button type="button" className="btn" disabled={!importing.trim()} onClick={importKey}>
                {t('Take in')}
              </button>
            </div>
          }
        />
      </Group>
    </Page>
  );
}
