import path from 'node:path';
import { mailAccounts, mailPassword, mailSettings, pickAccount } from '../mail/accounts';
import { MailClient, type MessageSummary } from '../mail/client';
import { mailHold } from './outbound';
import type { ToolDef, ToolOutput } from './types';

export interface MailInput {
  action: 'accounts' | 'search' | 'read' | 'draft' | 'send' | 'mark';
  account?: string;
  query?: string;
  folder?: string;
  limit?: number;
  id?: string;
  ids?: string[];
  saveTo?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  attachments?: string[];
  replyTo?: string;
  replyAll?: boolean;
  read?: boolean;
  starred?: boolean;
  archive?: boolean;
  move?: string;
  label?: string;
  unlabel?: string;
}

export const MAIL_ACTIONS = ['accounts', 'search', 'read', 'draft', 'send', 'mark'] as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** A time as this computer's clock shows it; the offset is said once, in the result's first line. */
const when = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const zone = () => {
  const off = -new Date().getTimezoneOffset();
  return `UTC${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
};

function line(m: MessageSummary, i: number): string {
  const marks = [m.unread ? 'unread' : '', m.starred ? 'starred' : '', m.attachments ? `${m.attachments} attachment${m.attachments === 1 ? '' : 's'}` : '', m.labels?.length ? `labels: ${m.labels.join(', ')}` : ''].filter(Boolean).join(' · ');
  return `${i + 1}. ${m.id} · ${when(m.date)}${marks ? ` · ${marks}` : ''}\n   From: ${m.from || '?'}\n   Subject: ${m.subject}${m.snippet ? `\n   ${m.snippet}` : ''}`;
}

/** Email in the user's accounts: search, read, draft and (with the user's yes) send, and keep the inbox. */
export const mailTool: ToolDef<MailInput> = {
  kind: 'mail',
  readOnly: false,
  title: (i) =>
    i.action === 'search'
      ? `Search mail${i.query ? ` for "${i.query}"` : ''}`
      : i.action === 'read'
        ? `Read mail ${i.id ?? ''}`
        : i.action === 'send' || i.action === 'draft'
          ? `${i.action === 'send' ? 'Send' : 'Draft'} mail${i.subject ? `: ${i.subject}` : i.replyTo ? ` in reply to ${i.replyTo}` : ''}`
          : i.action === 'mark'
            ? `Mark mail`
            : 'Mail accounts',
  async execute(input, ctx): Promise<ToolOutput> {
    const all = mailAccounts(ctx.config);
    if (!all.length) return { content: 'No mail account is set up. The user can add one in Settings > Mail (an app password from the provider).', isError: true };
    if (input.action === 'accounts') {
      const def = mailSettings(ctx.config).default;
      const lines = all.map((a) => `- ${a.address}${a.name ? ` (${a.name})` : ''}${a.address === def || (!def && a === all[0]) ? ' · default' : ''} · ${a.provider ?? a.imap.host}`);
      return { content: `Mail accounts:\n${lines.join('\n')}`, display: { kind: 'mail', action: 'accounts', account: def ?? all[0].address, accounts: all.map((a) => a.address) } };
    }
    let account;
    try {
      account = pickAccount(ctx.config, input.account);
    } catch (e) {
      return { content: (e as Error).message, isError: true };
    }
    const password = mailPassword(account.address);
    if (!password) return { content: `${account.address} has no password saved. The user can add its app password in Settings > Mail.`, isError: true };
    const client = new MailClient(account, password, ctx.proxy);
    try {
      switch (input.action) {
        case 'search': {
          const r = await client.search({ query: input.query, folder: input.folder, limit: input.limit });
          const head = `${r.items.length} of ${r.total} message${r.total === 1 ? '' : 's'} in ${r.folder} of ${account.address}${input.query ? ` for "${input.query}"` : ''}, newest first (times in ${zone()})`;
          return {
            content: r.items.length ? `${head}:\n\n${r.items.map(line).join('\n\n')}\n\nRead one with its id; ${r.total > r.items.length ? 'a narrower query or a higher limit shows others' : 'that is all of them'}.` : `No messages in ${r.folder} of ${account.address}${input.query ? ` match "${input.query}"` : ''}.`,
            display: { kind: 'mail', action: 'search', account: account.address, folder: r.folder, query: input.query, total: r.total, items: r.items },
          };
        }
        case 'read': {
          if (!input.id) return { content: 'Give the id of the message to read (from a search).', isError: true };
          const saveTo = input.saveTo ? path.resolve(ctx.cwd, input.saveTo) : undefined;
          const m = await client.read(input.id, { saveTo });
          const head = [`From: ${m.from}`, `To: ${m.to}`, m.cc ? `Cc: ${m.cc}` : '', m.replyTo && m.replyTo !== m.from ? `Reply-To: ${m.replyTo}` : '', `Date: ${when(m.date)} (${zone()})`, `Subject: ${m.subject}`, m.labels?.length ? `Labels: ${m.labels.join(', ')}` : ''].filter(Boolean).join('\n');
          const files = m.files.length ? `\n\nAttachments:\n${m.files.map((f) => `- ${f.name} (${f.type}, ${Math.max(1, Math.round(f.size / 1024))} KB)${f.saved ? ` saved to ${f.saved}` : ''}`).join('\n')}${m.files.some((f) => f.saved) ? '' : '\nRead again with save_to to save them.'}` : '';
          const body = m.body.length > ctx.outputChars ? `${m.body.slice(0, ctx.outputChars)}\n\n[The message continues: ${m.body.length - ctx.outputChars} more characters.]` : m.body;
          return {
            content: `${m.id}\n${head}\n\n${body || '(no text)'}${files}`,
            display: { kind: 'mail', action: 'read', account: account.address, message: { ...m, body: m.body.slice(0, 20_000) } },
          };
        }
        case 'draft':
        case 'send': {
          if (!input.body?.trim()) return { content: 'Give the body of the email.', isError: true };
          const hold = mailHold(input.subject ?? '', input.body, ctx.checkpoints as object | undefined);
          if (hold) return { content: hold, isError: true };
          const { mail, preview, to } = await client.compose({ to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, body: input.body, attachments: input.attachments?.map((p) => path.resolve(ctx.cwd, p)), replyTo: input.replyTo, replyAll: input.replyAll });
          if (input.action === 'draft') {
            const folder = await client.saveDraft(mail);
            return { content: `Saved in ${folder} of ${account.address}:\n\n${preview}`, display: { kind: 'mail', action: 'draft', account: account.address, preview, to } };
          }
          // Sending reaches other people and cannot be taken back: the user sees the whole email first.
          if (!mailSettings(ctx.config).sendWithoutAsking) {
            const decision = ctx.confirm ? await ctx.confirm({ title: `Send an email from ${account.address}`, detail: preview, reason: 'Sending an email reaches other people and cannot be taken back.', rule: 'mail.send' }) : 'deny';
            if (decision === 'deny') {
              return { content: `Not sent: the user did not approve this email. Nothing left ${account.address}. Ask what to change, or save it with action draft.\n\n${preview}`, display: { kind: 'mail', action: 'send', account: account.address, preview, to, declined: true } };
            }
          }
          const sent = await client.send(mail);
          const refused = sent.rejected.length ? ` Refused by the server: ${sent.rejected.join(', ')}.` : '';
          return { content: `Sent from ${account.address} to ${sent.accepted.join(', ') || to.join(', ')} (Message-ID ${sent.messageId}).${refused}`, display: { kind: 'mail', action: 'send', account: account.address, preview, to: sent.accepted.length ? sent.accepted : to } };
        }
        case 'mark': {
          const ids = input.ids ?? (input.id ? [input.id] : []);
          if (!ids.length) return { content: 'Give ids: the messages to mark.', isError: true };
          const changes = { read: input.read, starred: input.starred, archive: input.archive, move: input.move, label: input.label, unlabel: input.unlabel };
          if (Object.values(changes).every((v) => v === undefined)) return { content: 'Say what to change: read, starred, archive, move, label or unlabel.', isError: true };
          const done = await client.mark(ids, changes);
          const what = [input.read === true ? 'read' : input.read === false ? 'unread' : '', input.starred === true ? 'starred' : input.starred === false ? 'not starred' : '', input.archive ? 'archived' : '', input.move ? `moved to ${input.move}` : '', input.label ? `labelled ${input.label}` : '', input.unlabel ? `without ${input.unlabel}` : ''].filter(Boolean).join(', ');
          return { content: `${done.length} message${done.length === 1 ? '' : 's'} ${what}.`, display: { kind: 'mail', action: 'mark', account: account.address, total: done.length, note: what } };
        }
      }
    } catch (e) {
      const msg = (e as Error & { responseText?: string; authenticationFailed?: boolean }).authenticationFailed || /auth|credentials|login/i.test((e as Error).message) ? `${account.address} refused the password: an app password (or the provider's authorisation code) is needed, made in the account's security settings. The user can update it in Settings > Mail.` : `Mail failed: ${(e as Error & { responseText?: string }).responseText ?? (e as Error).message}`;
      return { content: msg, isError: true };
    }
    return { content: `Unknown action "${input.action}". Use one of: ${MAIL_ACTIONS.join(', ')}.`, isError: true };
  },
};
