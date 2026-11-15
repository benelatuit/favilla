import { fill, useT } from '../../lib/i18n';
import { renderMarkdown } from '../../lib/markdown';
import type { ToolDisplay, ToolResultPart } from '../../lib/types';
import { Clamp, Images } from './MediaViewer';

export const VIA: Record<string, string> = { api: 'site API', browser: 'read in the browser', pdf: 'PDF', text: 'text', page: '' };

export function LinksView({ d }: { d: Extract<ToolDisplay, { kind: 'links' }> }) {
  const t = useT();
  return (
    <div className="links plate">
      {d.engines?.length || d.dropped ? (
        <div className="links-about">
          {[d.engines?.join(' + '), d.dropped ? fill(t('{n} copy-site results left out'), d.dropped) : ''].filter(Boolean).join(' · ')}
        </div>
      ) : null}
      <ol>
        {d.results.map((r) => (
          <li key={r.url} className={r.quote ? 'is-read' : ''}>
            <a href={r.url} target="_blank" rel="noreferrer">
              {r.title || r.url}
            </a>
            <span className="links-url mono">
              {r.url.replace(/^https?:\/\/(www\.)?/, '')}
              {r.date ? <span className="num"> · {r.date}</span> : null}
            </span>
            {r.quote ? <Clamp className="links-quote md" html={renderMarkdown(r.quote)} /> : r.snippet && <span className="links-snippet">{r.snippet}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ShotView({ result, content, d }: { result: ToolResultPart; content: string; d: Extract<ToolDisplay, { kind: 'shot' }> }) {
  const report = content.split(/\n(?:Visible text \(start\)|Page text|Elements \(act on them by ref)/)[0].split('\n').slice(1).join('\n').trim();
  return (
    <>
      <Images result={result} caption={d.url} />
      {report && <pre className={`plate plain mono ${result.isError ? 'is-error' : ''}`}>{report}</pre>}
    </>
  );
}

export function WebFetchView({ content, d }: { content: string; d: Extract<ToolDisplay, { kind: 'web' }> }) {
  const t = useT();
  const body = content.replace(/^[^\n]*(\n(Published|Updated|The |A PDF)[^\n]*)*\n\n/, '');
  return (
    <>
      <div className="step-note web-note">
        <a href={d.url} target="_blank" rel="noreferrer">
          {d.title || d.url}
        </a>
        <span className="num">
          {' · '}
          {[d.via && VIA[d.via] ? t(VIA[d.via]) : '', d.date ?? '', d.chars ? fill(t('{n} characters'), d.chars.toLocaleString()) : `${Math.round(d.bytes / 1024)} KB`]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      {body.trim() && <Clamp className="md plate prose web-text" html={renderMarkdown(body.slice(0, 6000))} />}
    </>
  );
}
