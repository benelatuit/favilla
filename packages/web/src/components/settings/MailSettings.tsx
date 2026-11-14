import type { SettingBasis } from '@favilla/core/types';
import { useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { fill, useT } from '../../lib/i18n';
import { settingSaveError, toast } from '../../lib/store';
import { EnvelopeSimple, Plus } from '../icons';
import { Select } from '../ui/Select';
import { Group, Item, LoadError, Loading, Page, Row, useView } from './Rows';

interface Server {
  host: string;
  port: number;
  secure: boolean;
}

interface AccountView {
  address: string;
  name?: string;
  user?: string;
  provider?: string;
  imap: Server;
  smtp: Server;
  hasPassword: boolean;
}

interface MailView {
  basis?: SettingBasis;
  accounts: AccountView[];
  default: string | null;
  sendWithoutAsking: boolean;
  presets: { provider: string; passwords?: string }[];
}

/** The providers whose servers Favilla knows, by address; others need their servers typed in. */
const PROVIDERS: [RegExp, string, string][] = [
  [/@(gmail|googlemail)\.com$/i, 'gmail', 'Gmail'],
  [/@(outlook|hotmail|live|msn)\.[a-z.]+$/i, 'outlook', 'Outlook'],
  [/@(qq|foxmail)\.com$/i, 'qq', 'QQ 邮箱'],
  [/@163\.com$/i, '163', '网易 163'],
  [/@126\.com$/i, '126', '网易 126'],
  [/@(icloud|me|mac)\.com$/i, 'icloud', 'iCloud'],
  [/@(yahoo|ymail)\.[a-z.]+$/i, 'yahoo', 'Yahoo'],
  [/@fastmail\.[a-z.]+$/i, 'fastmail', 'Fastmail'],
];

const providerOf = (address: string) => PROVIDERS.find(([re]) => re.test(address.trim()));
const providerName = (id?: string) => PROVIDERS.find(([, p]) => p === id)?.[2];

/** Settings > Mail: the mailboxes the agent may read and write, and whether it shows each email before sending. */
export function MailSettings() {
  const t = useT();
  const { view, error, setView, reload } = useView<MailView>('/mail');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const lede = t('Mailboxes the agent may search, read and write in. Passwords stay on this computer.');
  if (!view)
    return (
      <Page title={t('Mail')} lede={lede}>
        {error ? <LoadError error={error} retry={reload} /> : <Loading />}
      </Page>
    );
  const put = (body: Record<string, unknown>) =>
    api<MailView>('/mail', { method: 'PUT', body: { ...body, basis: view.basis } })
      .then((v) => {
        setView(v);
        toast(t('Saved'), 'info');
      })
      .catch((e) => settingSaveError(e, reload));
  const remove = (address: string) =>
    api<MailView>(`/mail/accounts/${encodeURIComponent(address)}`, { method: 'DELETE', body: { basis: view.basis } })
      .then((v) => {
        setView(v);
        setRemoving(null);
      })
      .catch((e) => settingSaveError(e, reload));
  return (
    <Page title={t('Mail')} lede={lede}>
      <Group>
        {view.accounts.length === 0 && <p className="set-empty">{t('No mailbox yet.')}</p>}
        {view.accounts.map((a) => (
          <Item
            key={a.address}
            id={`mail-${a.address}`}
            mark={<EnvelopeSimple size={16} />}
            name={a.address}
            meta={
              <>
                {!a.hasPassword && <span className="is-warn">{t('no password saved')} · </span>}
                {[a.name, providerName(a.provider) ?? a.imap.host].filter(Boolean).join(' · ')}
              </>
            }
            end={
              <span className="set-item-actions">
                {view.default === a.address ? (
                  <span className="set-mark-text">{t('Default')}</span>
                ) : (
                  <button type="button" className="link" onClick={() => put({ default: a.address })}>
                    {t('Make default')}
                  </button>
                )}
                {removing === a.address ? (
                  <button type="button" className="link is-danger" onClick={() => remove(a.address)} onBlur={() => setRemoving(null)}>
                    {t('Remove it')}
                  </button>
                ) : (
                  <button type="button" className="link" onClick={() => setRemoving(a.address)}>
                    {t('Remove')}
                  </button>
                )}
              </span>
            }
          />
        ))}
        <Item id="mail-add" add mark={<Plus size={14} />} name={t('Add a mailbox')} meta={t('Gmail, Outlook, QQ, 163, iCloud or any IMAP server')} open={adding} onToggle={() => setAdding(!adding)}>
          <AddMailbox
            presets={view.presets}
            basis={view.basis}
            onDone={(v) => {
              setAdding(false);
              if (v) setView(v);
            }}
          />
        </Item>
      </Group>
      <Group title={t('Sending')}>
        <Row
          id="mail-send"
          label={t('Before an email is sent')}
          control={
            <Select
              value={view.sendWithoutAsking ? 'send' : 'ask'}
              options={[
                { value: 'ask', label: t('Show me each email first') },
                { value: 'send', label: t('Send without asking'), hint: t('The agent sends on its own') },
              ]}
              onChange={(v) => put({ sendWithoutAsking: v === 'send' })}
              className="is-field"
            />
          }
        />
      </Group>
    </Page>
  );
}

function AddMailbox({ presets, basis, onDone }: { presets: MailView['presets']; basis?: SettingBasis; onDone: (v?: MailView) => void }) {
  const [opened] = useState(basis);
  const t = useT();
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [own, setOwn] = useState(false);
  const [imap, setImap] = useState({ host: '', port: '993' });
  const [smtp, setSmtp] = useState({ host: '', port: '465' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const known = providerOf(address);
  const servers = own || (!known && /@[^@\s]+\.[^@\s]+$/.test(address));
  const where = presets.find((p) => p.provider === known?.[1])?.passwords;
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim()) && !!password.trim() && (!servers || (!!imap.host.trim() && !!smtp.host.trim()));
  const save = async () => {
    setBusy(true);
    setError(undefined);
    const port = (v: string, tls: number) => Number(v) || tls;
    try {
      const v = await api<MailView>('/mail/accounts', {
        body: {
          address: address.trim(),
          basis: opened,
          password,
          name: name.trim() || undefined,
          ...(servers
            ? {
                // TLS from the start on the TLS ports (993, 465); elsewhere STARTTLS when the server offers it.
                imap: { host: imap.host.trim(), port: port(imap.port, 993), secure: port(imap.port, 993) % 1000 === 993 },
                smtp: { host: smtp.host.trim(), port: port(smtp.port, 465), secure: port(smtp.port, 465) % 1000 === 465 },
              }
            : {}),
        },
      });
      toast(fill(t('{n} is connected: the agent can read and write its email.'), address.trim()), 'info');
      onDone(v);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="set-form mail-add">
      <div className="field-grid">
        <label className="field">
          <span>{t('Email address')}</span>
          <input type="email" spellCheck={false} value={address} placeholder="name@gmail.com" onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label className="field">
          <span>{known?.[1] === 'qq' || known?.[1] === '163' || known?.[1] === '126' ? t('Authorisation code') : t('App password')}</span>
          <input type="password" autoComplete="off" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
      <p className="set-note">
        {known?.[1] === 'gmail'
          ? t('Gmail needs an app password: turn on 2-Step Verification in your Google account, then make a 16-character app password and paste it here.')
          : known?.[1] === 'qq' || known?.[1] === '163' || known?.[1] === '126'
            ? t('Turn on the IMAP/SMTP service in the web mailbox’s settings, make an authorisation code and paste it here.')
            : known
              ? t('Make an app password in the account’s security settings and paste it here.')
              : t('Enter the IMAP and SMTP servers your provider gives, and the password for mail programs.')}{' '}
        {where && (
          <a href={where} target="_blank" rel="noreferrer">
            {t('Open the page')}
          </a>
        )}
      </p>
      <label className="field">
        <span>{t('Name others see')}</span>
        <input type="text" spellCheck={false} value={name} placeholder={t('Optional')} onChange={(e) => setName(e.target.value)} />
      </label>
      {servers && (
        <div className="field-grid">
          <label className="field">
            <span>{t('IMAP server')}</span>
            <input type="text" spellCheck={false} value={imap.host} placeholder="imap.example.com" onChange={(e) => setImap({ ...imap, host: e.target.value })} />
          </label>
          <label className="field mail-port">
            <span>{t('Port')}</span>
            <input type="text" inputMode="numeric" value={imap.port} onChange={(e) => setImap({ ...imap, port: e.target.value })} />
          </label>
          <label className="field">
            <span>{t('SMTP server')}</span>
            <input type="text" spellCheck={false} value={smtp.host} placeholder="smtp.example.com" onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />
          </label>
          <label className="field mail-port">
            <span>{t('Port')}</span>
            <input type="text" inputMode="numeric" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} />
          </label>
        </div>
      )}
      {error && <div className="field-error">
        {error.message}{error instanceof ApiError && error.settingsConflict && <> <button type="button" className="link" onClick={() => api<MailView>('/mail').then(onDone).catch(setError)}>{t('Load file values')}</button></>}
      </div>}
      <div className="row-actions">
        <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={save}>
          {busy ? t('Signing in…') : t('Sign in and add')}
        </button>
        {known && !own && (
          <button type="button" className="btn btn-quiet" onClick={() => setOwn(true)}>
            {t('Other servers')}
          </button>
        )}
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => onDone()}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}
