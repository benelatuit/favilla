import { absolutePath } from '../../lib/desktop';
import { fill, useT } from '../../lib/i18n';
import type { ToolDisplay } from '../../lib/types';
import { Paperclip } from '../icons';
import { MailSheet, splitPreview } from '../MailSheet';

/** A mail step's line: the query searched, the subject read, or whom an email is for. */
export function mailWhat(title: string, input: Record<string, unknown> | undefined, d: ToolDisplay | undefined, t: (k: string) => string): string {
  const m = d?.kind === 'mail' ? d : undefined;
  const action = String(m?.action ?? input?.action ?? '');
  if (action === 'search') return [m?.query ?? input?.query ? `"${m?.query ?? input?.query}"` : t('the latest messages'), m?.folder ?? (input?.folder as string | undefined)].filter(Boolean).join(' · ');
  if (action === 'read') return m?.message?.subject ?? String(input?.id ?? '');
  if (action === 'send' || action === 'draft') {
    const to = m?.to?.join(', ') ?? (Array.isArray(input?.to) ? (input!.to as string[]).join(', ') : '');
    const subject = String(input?.subject ?? '') || (input?.reply_to ?? input?.replyTo ? t('reply') : '');
    return [subject, to && `→ ${to}`].filter(Boolean).join('  ');
  }
  if (action === 'mark') return m?.note ?? t('messages');
  return m?.accounts?.join(', ') ?? title.replace(/^Mail accounts$/, t('accounts'));
}

const shortDate = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toTimeString().slice(0, 5) : d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : iso.slice(0, 10);
};

const sender = (from?: string) => (from ?? '').replace(/\s*<[^>]+>$/, '').replace(/^"|"$/g, '') || from || '';

/** Mail results: messages as rows (unread ones marked), one message as a sheet, a written email as it went. */
export function MailView({ d, cwd }: { d: Extract<ToolDisplay, { kind: 'mail' }>; cwd: string }) {
  const t = useT();
  if (d.action === 'search') {
    return (
      <div className="plate mail-list">
        <div className="mail-about">{[d.account, d.folder].filter(Boolean).join(' · ')}</div>
        {(d.items ?? []).map((m) => (
          <div key={m.id} className={`mail-row ${m.unread ? 'is-unread' : ''}`}>
            <span className="mail-dot" aria-hidden />
            <span className="mail-from">{sender(m.from)}</span>
            <span className="mail-subject">
              {m.subject}
              {m.snippet && <span className="mail-snippet"> — {m.snippet}</span>}
            </span>
            <span className="mail-date num">
              {m.attachments > 0 && <Paperclip size={12} />}
              {shortDate(m.date)}
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (d.action === 'read' && d.message) {
    const m = d.message;
    const head: [string, string][] = [
      ['From', m.from ?? ''],
      ['To', m.to ?? ''],
      ...(m.cc ? ([['Cc', m.cc]] as [string, string][]) : []),
      ['Date', m.date ? new Date(m.date).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''],
      ['Subject', m.subject],
    ];
    return (
      <>
        <MailSheet head={head} body={m.body} markdown={m.html} />
        {m.files.length > 0 && (
          <ul className="mail-files">
            {m.files.map((f) => (
              <li key={f.name} {...(f.saved ? { 'data-ctx': 'file', 'data-path': absolutePath(cwd, f.saved) } : {})}>
                <Paperclip size={12} />
                <span className="mono">{f.name}</span>
                <span className="num">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                {f.saved && <span className="mail-saved mono">{f.saved}</span>}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  if ((d.action === 'send' || d.action === 'draft') && d.preview) {
    const { head, body } = splitPreview(d.preview);
    return (
      <>
        <div className={`step-note ${d.declined ? 'del' : d.action === 'send' ? 'add' : ''}`}>
          {d.declined ? t('Not sent: you turned it down.') : d.action === 'draft' ? t('Saved in Drafts.') : fill(t('Sent to {n}.'), (d.to ?? []).join(', '))}
        </div>
        <MailSheet head={head} body={body} />
      </>
    );
  }
  return <div className="step-note">{d.note ?? d.accounts?.join(', ') ?? d.account}</div>;
}
