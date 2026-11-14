/**
 * Mail accounts: where their servers are (known providers are filled in from the address) and their app
 * passwords. The settings live in the global config's `mail`; passwords in ~/.favilla/auth.json, beside the
 * API keys, never in a config file a project could share.
 */
import { authPath, readAuthFile, updateAuthFile } from '../auth/store';
import type { FavillaConfig } from '../config/config';
import { globalConfigPath, loadGlobalConfigRaw, updateGlobalConfig } from '../config/config';

import { checkSettings, SettingsConflict, type SettingBasis, type SettingPath } from '../config/document';

export interface MailServer {
  host: string;
  port: number;
  /** TLS from the start (993, 465); false: STARTTLS when the server offers it (143, 587). */
  secure: boolean;
}

export interface MailAccountSettings {
  address: string;
  /** The name senders see. */
  name?: string;
  /** Login when it is not the address. */
  user?: string;
  provider?: string;
  imap: MailServer;
  smtp: MailServer;
}

export interface MailSettings {
  accounts?: MailAccountSettings[];
  /** The account used when a call names none. */
  default?: string;
  /** Send without showing the user each email first. Off unless the user turns it on. */
  sendWithoutAsking?: boolean;
}

interface Preset {
  match: RegExp;
  provider: string;
  imap: MailServer;
  smtp: MailServer;
  /** Where the user makes the password a program signs in with. */
  passwords?: string;
}

/** Providers whose servers follow from the address. Each needs an app password (or authorisation code). */
export const PRESETS: Preset[] = [
  { match: /@(gmail|googlemail)\.com$/i, provider: 'gmail', imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, passwords: 'https://myaccount.google.com/apppasswords' },
  { match: /@(outlook|hotmail|live|msn)\.[a-z.]+$/i, provider: 'outlook', imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false }, passwords: 'https://account.live.com/proofs/AppPassword' },
  { match: /@(qq|foxmail)\.com$/i, provider: 'qq', imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465, secure: true }, passwords: 'https://wx.mail.qq.com/' },
  { match: /@163\.com$/i, provider: '163', imap: { host: 'imap.163.com', port: 993, secure: true }, smtp: { host: 'smtp.163.com', port: 465, secure: true }, passwords: 'https://mail.163.com/' },
  { match: /@126\.com$/i, provider: '126', imap: { host: 'imap.126.com', port: 993, secure: true }, smtp: { host: 'smtp.126.com', port: 465, secure: true }, passwords: 'https://mail.126.com/' },
  { match: /@(icloud|me|mac)\.com$/i, provider: 'icloud', imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }, passwords: 'https://account.apple.com/account/manage' },
  { match: /@(yahoo|ymail)\.[a-z.]+$/i, provider: 'yahoo', imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true }, passwords: 'https://login.yahoo.com/account/security' },
  { match: /@fastmail\.[a-z.]+$/i, provider: 'fastmail', imap: { host: 'imap.fastmail.com', port: 993, secure: true }, smtp: { host: 'smtp.fastmail.com', port: 465, secure: true }, passwords: 'https://app.fastmail.com/settings/security/apps' },
];

export function presetFor(address: string): Preset | undefined {
  return PRESETS.find((p) => p.match.test(address.trim()));
}

export const isGmail = (a: MailAccountSettings) => a.provider === 'gmail' || a.imap.host === 'imap.gmail.com';

/**
 * The user's own mail settings, from the global config only: a project's config could otherwise point an
 * account at another server and receive its password.
 */
export function mailSettings(_config?: FavillaConfig): MailSettings {
  return (loadGlobalConfigRaw() as { mail?: MailSettings }).mail ?? {};
}

export function mailAccounts(config: FavillaConfig): MailAccountSettings[] {
  return usableMailAccounts(mailSettings(config));
}

export function usableMailAccounts(mail: MailSettings): MailAccountSettings[] {
  return (mail.accounts ?? []).filter((a) => a?.address && a.imap?.host && a.smtp?.host);
}

/** The account a call means: the one named (address, or a part of it), else the default, else the only one. */
export function pickAccount(config: FavillaConfig, name?: string): MailAccountSettings {
  const all = mailAccounts(config);
  if (!all.length) throw new Error('No mail account is set up. Add one in Settings > Mail.');
  if (name?.trim()) {
    const want = name.trim().toLowerCase();
    const hit = all.find((a) => a.address.toLowerCase() === want) ?? all.find((a) => a.address.toLowerCase().includes(want) || a.name?.toLowerCase() === want);
    if (!hit) throw new Error(`No mail account "${name}". The accounts: ${all.map((a) => a.address).join(', ')}.`);
    return hit;
  }
  const def = mailSettings(config).default;
  return all.find((a) => a.address === def) ?? all[0];
}

export function mailPassword(address: string): string | undefined {
  return (readAuthFile() as { mail?: Record<string, string> }).mail?.[address.toLowerCase()];
}

/** Account paths on the wire use the address, so adding another account cannot move an edit to the wrong one. */
export function checkMailAccount(id: string, config: unknown, fields: SettingPath[] | undefined, basis?: SettingBasis) {
  const file = globalConfigPath();
  const mail = (config as { mail?: MailSettings }).mail;
  const accounts = mail?.accounts ?? [];
  if (!Array.isArray(accounts) || (mail !== undefined && (!mail || typeof mail !== 'object' || Array.isArray(mail)))) throw new SettingsConflict(file);
  const index = accounts.findIndex((a) => typeof a?.address === 'string' && a.address.toLowerCase() === id);
  const old = accounts[index];
  const key = ['accounts', id];
  if (basis && old && !basis[JSON.stringify(key)]) throw new SettingsConflict(file);
  checkSettings(file, basis, { accounts: { [id]: old } }, old && fields ? fields.map((p) => [...key, ...p]) : [key]);
  return { mail, accounts, index, old };
}

export function changeMailAccount(id: string, account: MailAccountSettings | undefined, fields: [SettingPath, unknown][], password: string | undefined, basis?: SettingBasis): void {
  const write = () => {
    const edits: [SettingPath, unknown][] = [];
    updateGlobalConfig((current) => {
      const { mail, accounts, index: at, old } = checkMailAccount(id, current, account ? fields.map(([at]) => at) : undefined, basis);
      const path = ['mail', 'accounts', at < 0 ? accounts.length : at];
      if (!account || !old) {
        if (account || old) edits.push([path, account]);
      } else {
        edits.push(...fields.map(([p, v]): [SettingPath, unknown] => [[...path, ...p], v]));
      }
      return !account && mail?.default?.toLowerCase() === id ? { 'mail.default': undefined } : {};
    }, edits);
  };
  if (account && password === undefined) write();
  else updateAuthFile((f) => {
    const at = ['mail', id];
    checkSettings(authPath(), basis, f, [at]);
    const mail = { ...((f as { mail?: Record<string, string> }).mail ?? {}) };
    if (password === undefined) delete mail[id];
    else mail[id] = password;
    write();
    return { ...f, mail };
  });
}
