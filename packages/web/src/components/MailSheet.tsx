import { useT } from '../lib/i18n';
import { renderMarkdown } from '../lib/markdown';

/** An email as headers over its text, for an email about to be sent and for one written or read. */
export function MailSheet({ head, body, markdown }: { head: [string, string][]; body: string; markdown?: boolean }) {
  const t = useT();
  return (
    <div className="mail-sheet plate">
      <dl className="mail-head">
        {head.map(([k, v], i) => (
          <div key={i}>
            <dt>{k ? t(k) : ''}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {markdown ? <div className="mail-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} /> : <div className="mail-body">{body}</div>}
    </div>
  );
}

/** "Header: value" lines over a blank line and the text, as the preview of a written email comes. */
export function splitPreview(preview: string): { head: [string, string][]; body: string } {
  const [top, ...rest] = preview.split(/\n\n/);
  const head = top.split('\n').map((l): [string, string] => {
    const at = l.indexOf(': ');
    return at > 0 ? [l.slice(0, at), l.slice(at + 2)] : ['', l];
  });
  return { head, body: rest.join('\n\n') };
}
