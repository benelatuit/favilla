import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import type { ViewerImage } from '../../lib/store';
import type { ToolResultPart } from '../../lib/types';
import { openViewer } from '../ui/Viewer';
import { useSessionScope } from './SessionScope';

/** The pictures in a tool result, ready for the viewer, each with where it came from. */
export function pictures(result: ToolResultPart | undefined, d: ToolResultPart['display'] | undefined): ViewerImage[] {
  const where =
    d?.kind === 'file'
      ? `${d.path}${d.size ? ` · ${d.size[0]}×${d.size[1]}` : ''}${d.region ? ` · [${d.region.join(', ')}]` : ''}`
      : d?.kind === 'shot'
        ? d.url
        : undefined;
  return (result?.images ?? [])
    .map((img, i) => ({
      src: img.url ?? (img.data ? `data:${img.mediaType};base64,${img.data}` : ''),
      name: img.name ?? `image ${i + 1}`,
      caption: where,
    }))
    .filter((p) => p.src);
}

/** Collects every picture across the scoped session's tool results so arrow keys walk that session's gallery. */
export function browseInResults(picture: ViewerImage, results: ReadonlyMap<string, ToolResultPart>): [ViewerImage[], number] {
  const all: ViewerImage[] = [];
  for (const r of results.values()) all.push(...pictures(r, r.display));
  const at = all.findIndex((p) => p.src === picture.src);
  return at >= 0 ? [all, at] : [[picture], 0];
}

export function Images({ result, caption }: { result: ToolResultPart; caption?: string }) {
  const { getResults } = useSessionScope();
  const shots = pictures(result, result.display);
  if (!shots.length) return <div className="step-note">{result.content}</div>;
  return (
    <figure className="shots">
      {shots.map((s, i) => (
        <button key={i} type="button" className="shot-open" aria-label={s.name} onClick={(e) => openViewer(...browseInResults(s, getResults()), e.currentTarget)}>
          <img src={s.src} alt={s.name} loading="lazy" />
        </button>
      ))}
      {caption && <figcaption className="mono">{caption}</figcaption>}
    </figure>
  );
}

/** Rendered text shown a few lines deep; a press opens the rest. */
export function Clamp({ html, className }: { html: string; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 4);
  }, [html]);
  return (
    <div className={`clamp ${open ? 'is-open' : ''}`}>
      <div ref={ref} className={`clamp-body ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />
      {(long || open) && (
        <button type="button" className="link clamp-toggle" onClick={() => setOpen((o) => !o)}>
          {t(open ? 'Show less' : 'Show more')}
        </button>
      )}
    </div>
  );
}
