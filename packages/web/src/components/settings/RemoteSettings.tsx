import type { SettingBasis } from '@favilla/core/types';
import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api } from '../../lib/api';
import { confirmDialog, settingSaveError, toast } from '../../lib/store';
import { fill, useT } from '../../lib/i18n';
import { copyText } from '../../lib/clipboard';
import { desktop } from '../../lib/desktop';
import { disablePush, enablePush, needsHomeScreen, pushState, pushSupported } from '../../lib/push';
import { Copy, ShieldCheck, Trash, X } from '../icons';
import { Group, Item, LoadError, Loading, Page, Row, Segmented, sep, useSettingDraft } from './Rows';

interface Device {
  id: string;
  name: string;
  added: number;
  seen?: number;
  online: boolean;
  notify?: boolean;
}

interface View {
  basis?: SettingBasis;
  enabled: boolean;
  awake: boolean;
  /** Phones on the same network connect straight to this computer, at one of these addresses. */
  lan: boolean;
  lanState: 'off' | 'starting' | 'open' | 'error';
  lanError?: string;
  lanPort: number;
  lanAddresses: { address: string; name: string }[];
  relay: string;
  /** The address set in the settings ('' for none), and the one used without it ('' when there is none). */
  relaySet: string;
  relayDefault: string;
  state: 'off' | 'connecting' | 'online' | 'error';
  error?: string;
  pc: string;
  devices: Device[];
}

/** The pairing link as a QR, drawn as an SVG path on a white plate so any phone camera reads it in every theme. */
function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    return { d, size: n + 8 };
  }, [text]);
  return (
    <svg className="remote-qr" viewBox={`0 0 ${svg.size} ${svg.size}`} role="img" aria-label="QR">
      <rect className="remote-qr-paper" width={svg.size} height={svg.size} />
      <path className="remote-qr-ink" d={svg.d} />
    </svg>
  );
}

const when = (t: number) => new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** On a paired phone: whether the computer tells this phone when work ends or waits for an answer. */
function PhoneNotifications() {
  const t = useT();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (pushSupported())
      pushState()
        .then((s) => setOn(s.on))
        .catch(() => setOn(false));
  }, []);
  const turn = async (v: boolean) => {
    setBusy(true);
    try {
      if (v) {
        const granted = await enablePush({ done: t('Finished'), limit: t('Stopped at the step limit'), failed: t('Stopped by an error'), ask: t('Waiting for you') });
        if (!granted) toast(t('Notifications are blocked for this page in the browser’s settings.'), 'error');
        setOn(granted);
      } else {
        await disablePush();
        setOn(false);
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!pushSupported())
    return (
      <Row id="notifications" label={t('Notifications on this phone')} note={needsHomeScreen() ? t('On an iPhone or iPad, add this page to the Home Screen (Share, then Add to Home Screen) and open it from there to get notifications.') : t('This browser cannot show notifications from the computer.')} />
    );
  return (
    <Row
      id="notifications"
      label={t('Notifications on this phone')}
      note={t('When work finishes or waits for you, unless you are at the computer or have Favilla open here.')}
      control={<Segmented value={on ?? undefined} options={[[true, t('On')], [false, t('Off')]]} onChange={(v) => void turn(v)} label={t('Notifications on this phone')} disabled={busy || on === null} />}
    />
  );
}

type Via = 'lan' | 'relay';
interface Pairing {
  url: string;
  expires: number;
  via: Via;
  address?: string;
}

const LAMP = { open: 'online', starting: 'connecting', error: 'error', off: 'off' } as const;

/**
 * Settings > Remote: this computer from a paired phone, straight over the same network or anywhere through a relay
 * that only forwards sealed messages. Pairing happens here, with a QR shown on this screen; a phone is forgotten
 * here too.
 */
export function RemoteSettings() {
  const t = useT();
  const [view, setView] = useState<View | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pair, setPair] = useState<Pairing | null>(null);
  const [now, setNow] = useState(Date.now());
  const relay = useSettingDraft(view?.relaySet ?? '', view?.basis);
  const load = () =>
    api<View>('/remote')
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e) => {
        setView(null);
        // On a phone these settings are refused: they belong to the computer.
        setDenied((e as { status?: number }).status === 403);
        setError((e as Error).message);
      });
  useEffect(() => {
    void load();
    const every = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 3000);
    return () => clearInterval(every);
  }, []);
  const lede = t('Use this computer from your phone while it is on and Favilla is open: on the same Wi-Fi by scanning a code, from anywhere else through a relay.');
  if (!view)
    return (
      <Page title={t('Remote')} lede={lede}>
        {denied ? (
          <Group foot={<p className="set-note">{t('Pairing phones and forgetting them is done on the computer itself.')}</p>}>
            <PhoneNotifications />
          </Group>
        ) : error ? (
          <LoadError error={error} retry={() => void load()} />
        ) : (
          <Loading />
        )}
      </Page>
    );
  const call = async (path: string, body: Record<string, unknown>, basis = view.basis, done?: () => void) => {
    try {
      setView(await api<View>(path, { body: { ...body, basis } }));
      done?.();
    } catch (e) {
      settingSaveError(e, async () => { await load(); relay.clear(); });
    }
  };
  const lanReady = view.lan && view.lanState === 'open' && view.lanAddresses.length > 0;
  const startPairing = async (via: Via = view.relay ? 'relay' : 'lan', address?: string) => {
    try {
      const p = await api<Omit<Pairing, 'address'>>('/remote/pair', { body: { via, ...(address ? { address } : {}) } });
      setPair({ ...p, address: p.via === 'lan' ? (address ?? view.lanAddresses[0]?.address) : undefined });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const forget = async (d: Device) => {
    if (await confirmDialog({ title: fill(t('Forget {n}?'), d.name), body: t('It is cut off now and cannot connect again until it is paired again.'), confirm: t('Forget'), cancel: t('Cancel'), danger: true })) await call('/remote/forget', { id: d.id });
  };
  const relayText = relay.value;
  const relayValid = !relayText.trim() || /^https:\/\/[^\s/]+\/*$/.test(relayText.trim());
  const saveRelay = () => call('/remote/enable', { relay: relayText }, relay.basis, relay.saved);
  const left = pair ? Math.max(0, Math.round((pair.expires - now) / 1000)) : 0;
  const stateText = view.state === 'online' ? t('Connected to the relay: paired phones can reach this computer.') : view.state === 'error' ? `${t('Cannot reach the relay; trying again.')} ${view.error ?? ''}` : t('Connecting to the relay…');
  const lanText = !view.enabled
    ? t('A phone on the same Wi-Fi connects straight to this computer, with nothing to set up.')
    : view.lanState === 'error'
      ? `${t('Cannot open a port for phones on this network.')} ${view.lanError ?? ''}`
      : view.lanState === 'open'
        ? view.lanAddresses.length
          ? fill(t('Phones on this network connect at {n}.'), view.lanAddresses.map((a) => `${a.address}:${view.lanPort}`).join(', '))
          : t('This computer is not on a local network right now.')
        : t('Opening…');
  // The first time a program takes connections from the network, Windows asks whether to let it.
  const lanNote = [
    view.lan ? lanText : t('Off: phones connect through the relay only.'),
    view.enabled && view.lan && /Windows/.test(navigator.userAgent) ? t('If Windows asks whether Favilla may use private networks, allow it.') : '',
    view.lan ? t('Meant for a network you trust, such as home or the office.') : '',
  ].reduce((all, part) => (!part ? all : all ? `${all}${sep(all)}${part}` : part), '');
  return (
    <Page title={t('Remote')} lede={lede}>
      <Group foot={<p className="set-note">{t('What passes between a phone and this computer is sealed end to end, on the same Wi-Fi and through the relay alike. A paired phone can do what this window does, and dangerous commands still ask first.')}</p>}>
        <Row
          id="remote"
          label={t('Remote control')}
          note={
            view.enabled &&
            !!view.relay && (
              <>
                <span className={`remote-state is-${view.state}`} aria-hidden />
                {stateText}
              </>
            )
          }
          warn={view.enabled && !!view.relay && view.state === 'error'}
          control={<Segmented value={view.enabled} options={[[true, t('On')], [false, t('Off')]]} onChange={(v) => call('/remote/enable', { on: v })} label={t('Remote control')} />}
        />
        <Row
          id="lan"
          label={t('Same Wi-Fi')}
          note={
            <>
              {view.enabled && view.lan && <span className={`remote-state is-${LAMP[view.lanState]}`} aria-hidden />}
              {lanNote}
            </>
          }
          warn={view.enabled && view.lan && view.lanState === 'error'}
          control={<Segmented value={view.lan} options={[[true, t('On')], [false, t('Off')]]} onChange={(v) => call('/remote/enable', { lan: v })} label={t('Same Wi-Fi')} />}
        />
        <Row
          id="relay"
          label={t('Relay')}
          note={!relayValid ? t('An https:// address, without a path.') : view.relayDefault ? t('Empty uses Favilla’s relay. Your own is a copy of packages/relay on Cloudflare Workers.') : t('For phones away from this network: a copy of packages/relay that you run on Cloudflare Workers. The README says how.')}
          warn={!relayValid || (!view.relay && !view.lan && view.enabled)}
          control={
            <div className="field-row">
              <input type="text" className="set-input" spellCheck={false} value={relayText} placeholder={view.relayDefault || 'https://relay.example.com'} aria-label={t('Relay')} onChange={(e) => relay.change(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && relayValid && relayText !== relay.initial && void saveRelay()} />
              <button type="button" className="btn" disabled={!relayValid || relayText === relay.initial} onClick={() => void saveRelay()}>
                {t('Save')}
              </button>
            </div>
          }
        />
        {view.enabled && desktop && (
          // Only the desktop app can hold off sleep.
          <Row
            id="awake"
            label={t('Staying awake')}
            note={t('A phone cannot reach a sleeping computer. The screen may still turn off.')}
            control={
              <Segmented
                value={view.awake}
                options={[
                  [false, t('While work runs or waits for you')],
                  [true, t('The whole time remote control is on')],
                ]}
                onChange={(v) => call('/remote/enable', { awake: v })}
                label={t('Staying awake')}
              />
            }
          />
        )}
      </Group>
      {(view.enabled || view.devices.length > 0) && (
        <Group title={t('Phones')}>
          {view.devices.length === 0 && !pair && <p className="set-empty">{t('No phone is paired yet.')}</p>}
          {view.devices.map((d) => (
            <Item
              key={d.id}
              mark={<span className={`remote-state is-${d.online ? 'online' : 'off'}`} aria-hidden />}
              name={d.name}
              meta={`${d.online ? t('Connected now') : d.seen ? fill(t('Last here {n}'), when(d.seen)) : fill(t('Paired {n}'), when(d.added))}${d.notify ? ` · ${t('Notified')}` : ''}`}
              end={
                <button type="button" className="icon-btn is-small" aria-label={t('Forget')} data-tip={t('Forget')} onClick={() => void forget(d)}>
                  <Trash size={14} />
                </button>
              }
            />
          ))}
          {!view.enabled ? null : pair && left > 0 ? (
            <div className="remote-pair">
              <Qr text={pair.url} />
              <div className="remote-pair-text">
                {lanReady && !!view.relay && (
                  <Segmented
                    value={pair.via}
                    options={[
                      ['lan', t('Same Wi-Fi')],
                      ['relay', t('Anywhere')],
                    ]}
                    onChange={(v) => void startPairing(v)}
                    label={t('How the phone connects')}
                  />
                )}
                {pair.via === 'lan' && view.lanAddresses.length > 1 && (
                  <Segmented value={pair.address} options={view.lanAddresses.map((a): [string, string] => [a.address, a.name])} onChange={(v) => void startPairing('lan', v)} label={t('Network')} />
                )}
                <p>{pair.via === 'lan' ? t('Scan this with the phone’s camera while the phone is on the same Wi-Fi as this computer. It works once, for ten minutes.') : t('Scan this with the phone’s camera, or open the link on it. It works once, for ten minutes.')}</p>
                <p className="num">{fill(t('{n} left'), `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)}</p>
                <div className="field-row">
                  <code className="mono remote-link">{pair.url}</code>
                  <button type="button" className="icon-btn" aria-label={t('Copy')} data-tip={t('Copy')} onClick={() => void copyText(pair.url, t)}>
                    <Copy size={14} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={t('Close')} data-tip={t('Close')} onClick={() => setPair(null)}>
                    <X size={14} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="set-list-actions">
              <button type="button" className="btn is-small" disabled={!view.relay && !lanReady} onClick={() => void startPairing()}>
                <ShieldCheck size={14} /> {t('Pair a phone')}
              </button>
            </div>
          )}
        </Group>
      )}
    </Page>
  );
}
