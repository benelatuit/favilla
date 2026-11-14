import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { presetFor } from '../src/mail/accounts';
import { compileQuery, parseId, snippetOf } from '../src/mail/client';

describe('mail parts', () => {
  it('fills in known providers from the address', () => {
    expect(presetFor('someone@gmail.com')?.imap.host).toBe('imap.gmail.com');
    expect(presetFor('a.b@qq.com')?.smtp).toEqual({ host: 'smtp.qq.com', port: 465, secure: true });
    expect(presetFor('me@example.org')).toBeUndefined();
  });

  it('reads message ids and free queries for servers without Gmail search', () => {
    expect(parseId('4521@[Gmail]/All Mail')).toEqual({ uid: 4521, folder: '[Gmail]/All Mail' });
    expect(parseId('17')).toEqual({ uid: 17, folder: 'INBOX' });
    expect(() => parseId('abc@INBOX')).toThrow(/not a message id/);
    const q = compileQuery('from:boss subject:"q4 plan" is:unread after:2026/10/01 budget');
    expect(q).toMatchObject({ from: 'boss', subject: 'q4 plan', seen: false, text: 'budget' });
    expect((q.since as Date).toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(compileQuery('')).toEqual({ all: true });
  });

  it('makes a snippet from the raw start of a part in any encoding', () => {
    const b64 = Buffer.from(Buffer.from('你好，会议改到周三。\n> 引用的旧邮件\n谢谢', 'utf8').toString('base64'));
    expect(snippetOf(b64, { type: 'text/plain', encoding: 'base64', parameters: { charset: 'utf-8' } })).toBe('你好，会议改到周三。 谢谢');
    const qp = Buffer.from('Caf=C3=A9 opens at <b>9</b>=\r\n am');
    expect(snippetOf(qp, { type: 'text/html', encoding: 'quoted-printable', parameters: { charset: 'utf-8' } })).toBe('Café opens at 9 am');
  });
});

// The whole tool against a real IMAP/SMTP server on this computer (GreenMail), when its jar is there.
const jar = process.env.FAVILLA_GREENMAIL_JAR;
const live = !!jar && fs.existsSync(jar);

describe.runIf(live)('mail tool against a local server', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-mail-'));
  const work = path.join(home, 'work');
  let server: ChildProcess;
  const asked: string[] = [];
  let answer: 'allow' | 'deny' = 'deny';
  let tool: typeof import('../src/tools/mail').mailTool;
  let ctx: Record<string, unknown>;
  let nodemailer: typeof import('nodemailer');
  let ImapFlow: typeof import('imapflow').ImapFlow;

  const open = (port: number) =>
    new Promise<boolean>((ok) => {
      const s = net.connect(port, '127.0.0.1', () => (s.destroy(), ok(true)));
      s.on('error', () => ok(false));
    });

  const friend = () => new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'friend@example.org', pass: 'secret' }, logger: false });

  beforeAll(async () => {
    fs.mkdirSync(work, { recursive: true });
    process.env.FAVILLA_HOME = path.join(home, 'favilla');
    fs.mkdirSync(process.env.FAVILLA_HOME, { recursive: true });
    server = spawn('java', ['-Dgreenmail.setup.test.smtp', '-Dgreenmail.setup.test.imap', '-Dgreenmail.hostname=127.0.0.1', '-Dgreenmail.users=me:secret@example.com,friend:secret@example.org', '-Dgreenmail.users.login=email', '-jar', jar!], { cwd: home, stdio: 'ignore' });
    for (let i = 0; i < 120 && !((await open(3143)) && (await open(3025))); i++) await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(
      path.join(process.env.FAVILLA_HOME, 'config.json'),
      JSON.stringify({ mail: { accounts: [{ address: 'me@example.com', name: 'Me Test', imap: { host: '127.0.0.1', port: 3143, secure: false }, smtp: { host: '127.0.0.1', port: 3025, secure: false } }] } }),
    );
    fs.writeFileSync(path.join(process.env.FAVILLA_HOME, 'auth.json'), JSON.stringify({ mail: { 'me@example.com': 'secret' } }));
    nodemailer = (await import('nodemailer')).default as unknown as typeof import('nodemailer');
    ImapFlow = (await import('imapflow')).ImapFlow;
    // Three messages from a friend: plain, HTML, and one with an attachment. (GreenMail matches FROM on the whole address only.)
    const t = nodemailer.createTransport({ host: '127.0.0.1', port: 3025, secure: false, auth: { user: 'friend@example.org', pass: 'secret' } });
    await t.sendMail({ from: 'Friend <friend@example.org>', to: 'me@example.com', subject: 'Lunch on Friday', text: 'Shall we have lunch on Friday at noon?' });
    await t.sendMail({ from: 'Friend <friend@example.org>', to: 'me@example.com', subject: 'Weekly report', html: '<h1>Report</h1><p>Sales rose <b>12%</b>; see <a href="https://example.org/r">the sheet</a>.</p>' });
    await t.sendMail({ from: 'Friend <friend@example.org>', to: 'me@example.com', subject: 'The contract', text: 'Attached is the contract.', attachments: [{ filename: 'contract.txt', content: 'Clause 1: be kind.' }] });
    t.close();
    const { loadConfig } = await import('../src/config/config');
    tool = (await import('../src/tools/mail')).mailTool;
    ctx = {
      cwd: work,
      config: loadConfig(work),
      proxy: false,
      outputChars: 20_000,
      confirm: async (r: { detail: string }) => (asked.push(r.detail), answer),
    };
  }, 60_000);

  afterAll(() => {
    server?.kill();
  });

  const run = (input: Record<string, unknown>) => tool.execute(input as never, ctx as never);

  it('searches newest first with the start of each text, and reads HTML as markdown', async () => {
    const all = await run({ action: 'search' });
    expect(all.isError).toBeFalsy();
    const items = (all.display as { items: { id: string; subject: string; snippet?: string; unread: boolean; attachments: number }[] }).items;
    expect(items.map((m) => m.subject)).toEqual(['The contract', 'Weekly report', 'Lunch on Friday']);
    expect(items[2].snippet).toBe('Shall we have lunch on Friday at noon?');
    expect(items[0].attachments).toBe(1);
    expect(items.every((m) => m.unread)).toBe(true);
    const found = await run({ action: 'search', query: 'from:friend@example.org subject:report' });
    expect((found.display as { items: unknown[] }).items).toHaveLength(1);
    const report = await run({ action: 'read', id: items[1].id });
    expect(report.content).toContain('# Report');
    expect(report.content).toContain('Sales rose **12%**; see [the sheet](https://example.org/r).');
  });

  it('saves attachments where asked', async () => {
    const items = (await run({ action: 'search', query: 'subject:contract' })).display as { items: { id: string }[] };
    const read = await run({ action: 'read', id: items.items[0].id, saveTo: 'in' });
    const saved = path.join(work, 'in', 'contract.txt');
    expect(read.content).toContain(`contract.txt (text/plain, 1 KB) saved to ${saved}`);
    expect(fs.readFileSync(saved, 'utf8')).toBe('Clause 1: be kind.');
  });

  it('sends only what the user approves, as a reply in the thread', async () => {
    const lunch = ((await run({ action: 'search', query: 'subject:lunch' })).display as { items: { id: string }[] }).items[0].id;
    answer = 'deny';
    const declined = await run({ action: 'send', replyTo: lunch, body: 'Friday works, see you at noon.' });
    expect(declined.content).toMatch(/^Not sent: the user did not approve/);
    expect(asked[0]).toContain('To: friend@example.org');
    expect(asked[0]).toContain('Subject: Re: Lunch on Friday');
    answer = 'allow';
    const sent = await run({ action: 'send', replyTo: lunch, body: 'Friday works, see you at noon.' });
    expect(sent.content).toMatch(/^Sent from me@example.com to friend@example.org/);
    const f = friend();
    await f.connect();
    const lock = await f.getMailboxLock('INBOX');
    try {
      const got = [];
      for await (const m of f.fetch('1:*', { envelope: true, headers: ['in-reply-to'] })) got.push(m);
      expect(got).toHaveLength(1);
      expect(got[0].envelope?.subject).toBe('Re: Lunch on Friday');
      expect(got[0].headers?.toString()).toMatch(/In-Reply-To: <.+>/i);
    } finally {
      lock.release();
      await f.logout();
    }
  });

  it('keeps drafts and marks messages', async () => {
    const draft = await run({ action: 'draft', to: ['friend@example.org'], subject: 'Plans', body: 'A first try at the plan.' });
    expect(draft.isError).toBeFalsy();
    const drafts = await run({ action: 'search', folder: (draft.content.match(/^Saved in (.+?) of/) ?? [])[1] });
    expect((drafts.display as { items: { subject: string }[] }).items.map((m) => m.subject)).toEqual(['Plans']);
    const ids = ((await run({ action: 'search', query: 'from:friend@example.org' })).display as { items: { id: string }[] }).items.map((m) => m.id);
    const marked = await run({ action: 'mark', ids: ids.slice(0, 2), read: true, starred: true });
    expect(marked.content).toBe('2 messages read, starred.');
    const after = ((await run({ action: 'search', query: 'is:unread' })).display as { items: { id: string }[] }).items.map((m) => m.id);
    expect(after).toEqual([ids[2]]);
    const archive = await run({ action: 'mark', ids: [ids[2]], archive: true });
    expect(archive.content).toMatch(/no archive folder/);
  });
});
