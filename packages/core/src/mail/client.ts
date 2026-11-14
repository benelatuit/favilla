/**
 * One mail account over IMAP (search, read, mark, drafts) and SMTP (send). Connections are kept for a couple
 * of minutes between calls. Message ids are `uid@folder`, so they stay valid across calls and restarts.
 * Searching on Gmail uses Gmail's own query language over All Mail, as Gmail's search box does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow, type FetchMessageObject, type MessageAddressObject, type MessageStructureObject, type SearchObject } from 'imapflow';
import nodemailer, { type SendMailOptions as MailOptions } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { toMarkdown } from '../tools/webpage';
import { isGmail, type MailAccountSettings } from './accounts';

export interface MessageSummary {
  /** `uid@folder`, what read, mark and reply_to take. */
  id: string;
  uid: number;
  folder: string;
  date?: string;
  from?: string;
  to?: string;
  subject: string;
  snippet?: string;
  unread: boolean;
  starred: boolean;
  attachments: number;
  labels?: string[];
}

export interface MessageFull extends MessageSummary {
  cc?: string;
  replyTo?: string;
  messageId?: string;
  body: string;
  /** The body was HTML, shown here as markdown. */
  html: boolean;
  files: { part: string; name: string; type: string; size: number; saved?: string }[];
}

export interface Outgoing {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  attachments?: string[];
  /** The id of a message this answers: it joins that thread. */
  replyTo?: string;
  replyAll?: boolean;
}

const isLocal = (host: string) => /^(localhost|127\.|\[::1\]|::1$)/.test(host);

export function parseId(id: string): { uid: number; folder: string } {
  const at = id.indexOf('@');
  const uid = Number(at > 0 ? id.slice(0, at) : id);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`"${id}" is not a message id; ids look like 4521@INBOX.`);
  return { uid, folder: at > 0 ? id.slice(at + 1) : 'INBOX' };
}

const addr = (a?: MessageAddressObject[]) => (a ?? []).map((x) => (x.name ? `${x.name} <${x.address}>` : (x.address ?? ''))).filter(Boolean).join(', ');
const bare = (a?: MessageAddressObject[]) => (a ?? []).map((x) => x.address ?? '').filter(Boolean);

function leaves(node: MessageStructureObject | undefined, out: MessageStructureObject[] = []): MessageStructureObject[] {
  if (!node) return out;
  if (node.childNodes?.length) for (const c of node.childNodes) leaves(c, out);
  else out.push({ ...node, part: node.part ?? '1' });
  return out;
}

const fileName = (n: MessageStructureObject) => n.dispositionParameters?.filename ?? n.parameters?.name;
const isFile = (n: MessageStructureObject) => n.disposition === 'attachment' || (!!fileName(n) && !n.type.startsWith('text/'));

/** The part to show as the body: plain text unless the message only has HTML (or a stub of plain text). */
function bodyPart(parts: MessageStructureObject[]): MessageStructureObject | undefined {
  const text = parts.filter((p) => !isFile(p) && (p.type === 'text/plain' || p.type === 'text/html'));
  const plain = text.find((p) => p.type === 'text/plain');
  const html = text.find((p) => p.type === 'text/html');
  if (plain && (!html || (plain.size ?? 0) > 200)) return plain;
  return html ?? plain;
}

function qpDecode(s: string): Buffer {
  const bytes: number[] = [];
  const text = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

/** The start of a part fetched raw: undo its transfer encoding and charset, then flatten it to a line. */
export function snippetOf(raw: Buffer, part: MessageStructureObject, decoded = false): string {
  let bytes = raw;
  if (!decoded) {
    const enc = (part.encoding ?? '').toLowerCase();
    if (enc === 'base64') {
      const b64 = raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
      bytes = Buffer.from(b64.slice(0, b64.length - (b64.length % 4)), 'base64');
    } else if (enc === 'quoted-printable') bytes = qpDecode(raw.toString('latin1'));
  }
  let text: string;
  try {
    text = new TextDecoder(part.parameters?.charset ?? 'utf-8').decode(bytes);
  } catch {
    text = bytes.toString('utf8');
  }
  if (part.type === 'text/html') {
    text = text
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>?/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }
  // Quoted replies and the space they leave are not what the message says.
  text = text
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, 220);
}

/** A free query on a server without Gmail's search: from:, to:, subject:, is:unread, is:starred, has:attachment, after:/before:, other words in the text. */
export function compileQuery(query: string): SearchObject {
  const q: SearchObject = {};
  const words: string[] = [];
  for (const m of query.matchAll(/(-?)(\w+):("[^"]*"|\S+)|"([^"]+)"|(\S+)/g)) {
    const [, neg, key, rawValue, quoted, word] = m;
    if (key) {
      const value = rawValue.replace(/^"|"$/g, '');
      const k = key.toLowerCase();
      if (k === 'from' || k === 'to' || k === 'cc' || k === 'subject') q[k] = value;
      else if (k === 'is' && value === 'unread') q.seen = !!neg;
      else if (k === 'is' && value === 'read') q.seen = !neg;
      else if (k === 'is' && value === 'starred') q.flagged = !neg;
      else if ((k === 'after' || k === 'since' || k === 'newer') && !Number.isNaN(Date.parse(value.replace(/\//g, '-')))) q.since = new Date(value.replace(/\//g, '-'));
      else if ((k === 'before' || k === 'older') && !Number.isNaN(Date.parse(value.replace(/\//g, '-')))) q.before = new Date(value.replace(/\//g, '-'));
      else if (k === 'has' && value === 'attachment') q.header = { ...(q.header ?? {}), 'content-type': 'multipart/mixed' };
      else words.push(`${key}:${value}`);
    } else words.push(quoted ?? word);
  }
  if (words.length) q.text = words.join(' ');
  return Object.keys(q).length ? q : { all: true };
}

interface Pooled {
  client: ImapFlow;
  timer?: NodeJS.Timeout;
}

const pool = new Map<string, Pooled>();
const IDLE_MS = 120_000;

export class MailClient {
  constructor(
    readonly account: MailAccountSettings,
    private readonly password: string,
    private readonly proxy: string | false = false,
  ) {}

  private key(): string {
    return `${this.account.address.toLowerCase()} ${this.account.imap.host}`;
  }

  private async imap(): Promise<ImapFlow> {
    const k = this.key();
    const held = pool.get(k);
    if (held && held.client.usable) {
      this.keepAlive(held);
      return held.client;
    }
    const { host, port, secure } = this.account.imap;
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user: this.account.user || this.account.address, pass: this.password },
      logger: false,
      // A test server on this computer has a certificate of its own making.
      tls: { rejectUnauthorized: !isLocal(host) },
      ...(this.proxy && !isLocal(host) ? { proxy: this.proxy } : {}),
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 120_000,
    } as ConstructorParameters<typeof ImapFlow>[0]);
    client.on('error', () => pool.delete(k));
    client.on('close', () => pool.delete(k));
    await client.connect();
    const entry: Pooled = { client };
    pool.set(k, entry);
    this.keepAlive(entry);
    return client;
  }

  private keepAlive(entry: Pooled): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      pool.delete(this.key());
      entry.client.logout().catch(() => entry.client.close());
    }, IDLE_MS);
    entry.timer.unref?.();
  }

  /** Close the connection now (tests, and before the account changes). */
  async close(): Promise<void> {
    const entry = pool.get(this.key());
    pool.delete(this.key());
    if (entry?.timer) clearTimeout(entry.timer);
    await entry?.client.logout().catch(() => entry.client.close());
  }

  async gmail(): Promise<boolean> {
    return isGmail(this.account) || (await this.imap()).capabilities.has('X-GM-EXT-1');
  }

  /** The folders, each with its special use (\All, \Sent, \Drafts, \Trash, \Junk, \Archive) when it has one. */
  async folders(): Promise<{ path: string; use?: string }[]> {
    const list = await (await this.imap()).list();
    return list.map((f) => ({ path: f.path, use: f.specialUse }));
  }

  async special(use: string): Promise<string | undefined> {
    return (await this.folders()).find((f) => f.use === use)?.path;
  }

  /** Messages matching a query, newest first, with the start of the text of the first ten. */
  async search(o: { query?: string; folder?: string; limit?: number }): Promise<{ folder: string; total: number; items: MessageSummary[] }> {
    const client = await this.imap();
    const gmail = await this.gmail();
    const folder = o.folder || (gmail ? ((await this.special('\\All')) ?? 'INBOX') : 'INBOX');
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 100);
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const criteria: SearchObject = o.query?.trim() ? (gmail ? { gmraw: o.query.trim() } : compileQuery(o.query)) : { all: true };
      const uids = (await client.search(criteria, { uid: true })) || [];
      const picked = [...uids].sort((a, b) => a - b).slice(-limit);
      if (!picked.length) return { folder, total: 0, items: [] };
      const found: { m: FetchMessageObject; parts: MessageStructureObject[] }[] = [];
      for await (const m of client.fetch(picked, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, ...(gmail ? { labels: true } : {}) }, { uid: true })) {
        found.push({ m, parts: leaves(m.bodyStructure) });
      }
      found.sort((a, b) => b.m.uid - a.m.uid);
      const items = found.map(({ m, parts }) => this.summary(m, folder, parts));
      for (const [i, { m, parts }] of found.slice(0, 10).entries()) {
        const part = bodyPart(parts);
        if (!part?.part) continue;
        const got = await client.fetchOne(String(m.uid), { bodyParts: [{ key: part.part, maxLength: 1600 }] }, { uid: true }).catch(() => false as const);
        const raw = got ? got.bodyParts?.get(part.part) : undefined;
        if (raw && got) items[i].snippet = snippetOf(raw, part, got.binaryParts?.has(part.part));
      }
      return { folder, total: uids.length, items };
    } finally {
      lock.release();
    }
  }

  private summary(m: FetchMessageObject, folder: string, parts: MessageStructureObject[]): MessageSummary {
    const e = m.envelope;
    const date = e?.date ?? m.internalDate;
    const labels = m.labels ? [...m.labels].filter((l) => !/^\\(Inbox|Sent|Important|Starred)$/i.test(l)) : undefined;
    return {
      id: `${m.uid}@${folder}`,
      uid: m.uid,
      folder,
      date: date ? new Date(date).toISOString() : undefined,
      from: addr(e?.from),
      to: addr(e?.to),
      subject: e?.subject ?? '(no subject)',
      unread: !m.flags?.has('\\Seen'),
      starred: !!m.flags?.has('\\Flagged'),
      attachments: parts.filter(isFile).length,
      ...(labels?.length ? { labels } : {}),
    };
  }

  /** A whole message: its headers, its text (HTML turned into markdown), its attachments, saved when asked. */
  async read(id: string, o: { saveTo?: string } = {}): Promise<MessageFull> {
    const { uid, folder } = parseId(id);
    const client = await this.imap();
    const gmail = await this.gmail();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const m = await client.fetchOne(String(uid), { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, ...(gmail ? { labels: true } : {}) }, { uid: true });
      if (!m) throw new Error(`No message ${id}: it may have been moved or deleted. Search again.`);
      const parts = leaves(m.bodyStructure);
      const part = bodyPart(parts);
      let body = '';
      let html = false;
      if (part?.part) {
        const d = await client.download(String(uid), part.part, { uid: true, maxBytes: 2_000_000 });
        const chunks: Buffer[] = [];
        for await (const c of d.content) chunks.push(Buffer.from(c as Buffer));
        const text = Buffer.concat(chunks).toString('utf8');
        html = part.type === 'text/html';
        // Pictures in mail are mostly tracking pixels and logos; loading one tells the sender it was opened.
        body = html ? toMarkdown(text, 'https://mail.invalid/').replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt.trim() ? `[image: ${alt.trim()}]` : '')) : text.replace(/\r\n/g, '\n').trim();
      }
      const files: MessageFull['files'] = parts.filter(isFile).map((p) => ({ part: p.part!, name: fileName(p) ?? `part-${p.part}`, type: p.type, size: p.size ?? 0 }));
      if (o.saveTo && files.length) {
        fs.mkdirSync(o.saveTo, { recursive: true });
        for (const f of files) {
          const d = await client.download(String(uid), f.part, { uid: true });
          const name = path.basename(f.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || `part-${f.part}`;
          let target = path.join(o.saveTo, name);
          for (let n = 2; fs.existsSync(target); n++) target = path.join(o.saveTo, `${path.parse(name).name} (${n})${path.parse(name).ext}`);
          await new Promise<void>((ok, fail) => d.content.pipe(fs.createWriteStream(target)).on('finish', () => ok()).on('error', fail));
          f.saved = target;
        }
      }
      const e = m.envelope;
      return { ...this.summary(m, folder, parts), cc: addr(e?.cc), replyTo: addr(e?.replyTo), messageId: e?.messageId, body, html, files };
    } finally {
      lock.release();
    }
  }

  /** Read or unread, starred or not, archived, moved, labelled (Gmail), for messages of any folders. */
  async mark(ids: string[], change: { read?: boolean; starred?: boolean; archive?: boolean; move?: string; label?: string; unlabel?: string }): Promise<string[]> {
    const client = await this.imap();
    const gmail = await this.gmail();
    const byFolder = new Map<string, number[]>();
    for (const id of ids) {
      const { uid, folder } = parseId(id);
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), uid]);
    }
    const done: string[] = [];
    const archive = change.archive && !gmail ? await this.special('\\Archive') : undefined;
    if (change.archive && !gmail && !archive) throw new Error('This account has no archive folder; move the messages to a folder instead.');
    for (const [folder, uids] of byFolder) {
      const lock = await client.getMailboxLock(folder);
      try {
        if (change.read !== undefined) await (change.read ? client.messageFlagsAdd(uids, ['\\Seen'], { uid: true }) : client.messageFlagsRemove(uids, ['\\Seen'], { uid: true }));
        if (change.starred !== undefined) await (change.starred ? client.messageFlagsAdd(uids, ['\\Flagged'], { uid: true }) : client.messageFlagsRemove(uids, ['\\Flagged'], { uid: true }));
        if (change.label && gmail) await client.messageFlagsAdd(uids, [change.label], { uid: true, useLabels: true });
        if (change.unlabel && gmail) await client.messageFlagsRemove(uids, [change.unlabel], { uid: true, useLabels: true });
        // Archiving on Gmail takes the Inbox label away; elsewhere it is a move to the archive folder.
        if (change.archive && gmail) await client.messageFlagsRemove(uids, ['\\Inbox'], { uid: true, useLabels: true });
        const to = change.move ?? archive;
        if (to && to !== folder) await client.messageMove(uids, to, { uid: true });
        done.push(...uids.map((u) => `${u}@${folder}`));
      } finally {
        lock.release();
      }
    }
    return done;
  }

  /** The mail to send for `o`: a reply joins its thread (In-Reply-To, References, "Re:") and goes to its sender. */
  async compose(o: Outgoing): Promise<{ mail: MailOptions; preview: string; to: string[] }> {
    let to = o.to ?? [];
    let cc = o.cc ?? [];
    let subject = o.subject ?? '';
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    if (o.replyTo) {
      const orig = await this.headers(o.replyTo);
      inReplyTo = orig.messageId;
      references = [...orig.references, ...(orig.messageId ? [orig.messageId] : [])];
      if (!subject) subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
      if (!to.length) to = orig.replyTo.length ? orig.replyTo : orig.from;
      if (o.replyAll) {
        const me = this.account.address.toLowerCase();
        cc = [...new Set([...cc, ...orig.to, ...orig.cc])].filter((a) => a.toLowerCase() !== me && !to.some((t) => t.toLowerCase() === a.toLowerCase()));
      }
    }
    const recipients = [...to, ...cc, ...(o.bcc ?? [])];
    if (!recipients.length) throw new Error('Give at least one recipient (to), or reply_to a message.');
    const bad = recipients.filter((r) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(r.replace(/^.*<([^>]+)>\s*$/, '$1')));
    if (bad.length) throw new Error(`Not email addresses: ${bad.join(', ')}`);
    const files = (o.attachments ?? []).map((p) => {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`No file to attach at ${p}`);
      return { path: p, filename: path.basename(p), size: fs.statSync(p).size };
    });
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > 24 * 1024 * 1024) throw new Error(`The attachments come to ${(total / 1048576).toFixed(1)} MB; most providers refuse over 25 MB. Share a link instead.`);
    const mail: MailOptions = {
      from: { name: this.account.name ?? '', address: this.account.address },
      to,
      ...(cc.length ? { cc } : {}),
      ...(o.bcc?.length ? { bcc: o.bcc } : {}),
      subject,
      text: o.body,
      ...(files.length ? { attachments: files.map((f) => ({ path: f.path, filename: f.filename })) } : {}),
      ...(inReplyTo ? { inReplyTo, references } : {}),
    };
    const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
    // Headers, a blank line, the text: the layout the approval card and the timeline split on.
    const head = [
      `From: ${this.account.name ? `${this.account.name} <${this.account.address}>` : this.account.address}`,
      `To: ${to.join(', ')}`,
      cc.length ? `Cc: ${cc.join(', ')}` : '',
      o.bcc?.length ? `Bcc: ${o.bcc.join(', ')}` : '',
      `Subject: ${subject || '(no subject)'}`,
      inReplyTo ? `In reply to: ${o.replyTo}` : '',
      files.length ? `Attachments: ${files.map((f) => `${f.filename} (${kb(f.size)})`).join(', ')}` : '',
    ].filter(Boolean);
    const preview = `${head.join('\n')}\n\n${o.body}`;
    return { mail, preview, to: recipients };
  }

  private async headers(id: string): Promise<{ messageId?: string; references: string[]; subject: string; from: string[]; replyTo: string[]; to: string[]; cc: string[] }> {
    const { uid, folder } = parseId(id);
    const client = await this.imap();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const m = await client.fetchOne(String(uid), { uid: true, envelope: true, headers: ['references'] }, { uid: true });
      if (!m) throw new Error(`No message ${id} to reply to.`);
      const refs = m.headers?.toString('utf8').replace(/^references:\s*/i, '').match(/<[^>]+>/g) ?? [];
      const e = m.envelope;
      return { messageId: e?.messageId, references: refs, subject: e?.subject ?? '', from: bare(e?.from), replyTo: bare(e?.replyTo).filter((r) => !bare(e?.from).includes(r)), to: bare(e?.to), cc: bare(e?.cc) };
    } finally {
      lock.release();
    }
  }

  async send(mail: MailOptions): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
    const { host, port, secure } = this.account.smtp;
    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user: this.account.user || this.account.address, pass: this.password },
      tls: { rejectUnauthorized: !isLocal(host) },
      ...(this.proxy && !isLocal(host) && /^https?:/.test(this.proxy) ? { proxy: this.proxy } : {}),
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    try {
      const info = await transport.sendMail(mail);
      const list = (v: (string | { address: string })[]) => v.map((x) => (typeof x === 'string' ? x : x.address));
      return { messageId: info.messageId, accepted: list(info.accepted), rejected: list(info.rejected) };
    } finally {
      transport.close();
    }
  }

  /** Put the mail in Drafts, where the user can finish and send it from any mail program. */
  async saveDraft(mail: MailOptions): Promise<string> {
    const raw = await new MailComposer(mail).compile().build();
    const drafts = (await this.special('\\Drafts')) ?? 'Drafts';
    const client = await this.imap();
    try {
      await client.append(drafts, raw, ['\\Draft', '\\Seen']);
    } catch (e) {
      // A mailbox without a drafts folder: the server says TRYCREATE, so make it and try again.
      if (!/TRYCREATE|no such (folder|mailbox)/i.test(`${(e as Error).message} ${(e as { serverResponseCode?: string }).serverResponseCode ?? ''}`)) throw e;
      await client.mailboxCreate(drafts);
      await client.append(drafts, raw, ['\\Draft', '\\Seen']);
    }
    return drafts;
  }

  /** Sign in to both servers, for the settings' test button. */
  async test(): Promise<{ folders: number }> {
    const folders = (await this.folders()).length;
    const { host, port, secure } = this.account.smtp;
    const transport = nodemailer.createTransport({ host, port, secure, auth: { user: this.account.user || this.account.address, pass: this.password }, tls: { rejectUnauthorized: !isLocal(host) }, connectionTimeout: 20_000 });
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
    return { folders };
  }
}
