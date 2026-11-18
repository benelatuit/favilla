import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { remoteMode } from '../lib/remote';
import { desktop } from '../lib/desktop';
import { asPointed, type Pointed } from '../lib/point';
import { ArrowsClockwise, ArrowsIn, ArrowsOut, ArrowSquareOut, Browser, Crosshair } from './icons';
import { Pen } from './Pen';
import { Select } from './ui/Select';

interface PreviewView {
  pages: { url: string; command: string; started: number }[];
  url?: string;
  proxied?: string;
}

/** Carries an element pointed at in the preview to the composer, which sends it with the next message. */
export const POINTED = 'favilla:pointed';

/** An address without its scheme: localhost:5173/cart. */
const shortUrl = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');

interface PreviewProps {
  open: boolean;
  wide: boolean;
  onWide: (wide: boolean) => void;
}

/** The page chosen in each session, for as long as this window lives. */
const choices = new Map<string, string>();

/**
 * The page this session's folder serves, in the panel, through Favilla's proxy (server/preview.ts), which adds
 * point-and-tell to it: the crosshair, a click on the page, and the element goes with the next message, with what
 * the page did in the seconds before. Asked for again as the work goes on, so a dev server the agent starts shows
 * up by itself.
 */
export function PreviewTab(props: PreviewProps) {
  const id = useStore((s) => s.activeId);
  // A new session must have a fresh view before it can show an iframe.
  return <SessionPreview key={id} id={id} {...props} />;
}

function SessionPreview({ id, open, wide, onWide }: PreviewProps & { id: string | null }) {
  const t = useT();
  const status = useStore((s) => s.session?.status);
  const [view, setView] = useState<PreviewView | null>(null);
  const [chosen, setChosen] = useState(() => id ? choices.get(id) : undefined);
  const [picking, setPicking] = useState(false);
  const [reload, setReload] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const seen = useRef('');
  // A pick asked of the page and not yet answered.
  const asked = useRef(false);

  useEffect(() => {
    if (!open || !id || remoteMode) return;
    let gone = false;
    const take = (v: PreviewView) => {
      const key = JSON.stringify([v.proxied, v.pages.map((p) => p.url)]);
      if (gone || key === seen.current) return;
      seen.current = key;
      setView(v);
    };
    const ask = () =>
      api<PreviewView>(`/sessions/${id}/preview${chosen ? `?url=${encodeURIComponent(chosen)}` : ''}`)
        .then(take)
        .catch(() => take({ pages: [] }));
    void ask();
    const timer = window.setInterval(ask, 5000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [open, id, chosen, status]);

  const proxied = view?.proxied;
  const origin = proxied ? new URL(proxied).origin : '';
  const served = view?.url ? new URL(view.url).origin : '';
  useEffect(() => {
    const heard = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || e.origin !== origin || e.data?.favilla !== 'point') return;
      // Only an answer to a pick asked for, and only one: the page is the user's project, not Favilla, and may send anything.
      if (!asked.current) return;
      asked.current = false;
      setPicking(false);
      const picked = asPointed(e.data.picked);
      // The page as its server serves it: the proxy's address means nothing to the agent.
      if (picked) window.dispatchEvent(new CustomEvent<Pointed>(POINTED, { detail: { ...picked, page: picked.page.replace(origin, served) } }));
    };
    window.addEventListener('message', heard);
    return () => window.removeEventListener('message', heard);
  }, [origin, served]);
  // A new page, or the same one loaded again, starts out of picking.
  useEffect(() => setPicking(false), [proxied, reload]);

  if (remoteMode)
    return (
      <div className="panel-empty">
        <Browser size={20} />
        <p>{t('The preview opens on the computer this session runs on.')}</p>
      </div>
    );
  if (!view)
    return (
      <div className="panel-body is-loading" aria-busy="true">
        <Pen width={24} />
      </div>
    );
  if (!proxied || !view.url)
    return (
      <div className="panel-empty">
        <Browser size={20} />
        <p>{t('No page is served from this folder yet. Once a dev server runs here, its page shows in this tab, and you can point at what to change.')}</p>
      </div>
    );
  const point = () => {
    const on = !picking;
    asked.current = on;
    setPicking(on);
    frame.current?.contentWindow?.postMessage({ favilla: 'point', on }, origin);
    if (on) frame.current?.focus();
  };
  const choose = (url: string) => {
    if (id) choices.set(id, url);
    setChosen(url);
  };
  const page = view.url;
  return (
    <div className="preview">
      <div className="preview-bar">
        <button type="button" className={`preview-point ${picking ? 'is-on' : ''}`} aria-pressed={picking} data-tip={t('Point at something on the page, then say what to change')} onClick={point}>
          <Crosshair size={16} />
          <span>{t('Point')}</span>
        </button>
        {view.pages.length > 1 ? (
          <Select value={page} options={view.pages.map((p) => ({ value: p.url, label: shortUrl(p.url) }))} onChange={choose} className="preview-pages" />
        ) : (
          <span className="mono preview-url" data-tip={page}>
            {shortUrl(page)}
          </span>
        )}
        <button type="button" className="icon-btn is-small" aria-label={t(wide ? 'Narrower' : 'Wider')} data-tip={t(wide ? 'Narrower' : 'Wider')} onClick={() => onWide(!wide)}>
          {wide ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
        </button>
        <button type="button" className="icon-btn is-small" aria-label={t('Reload')} data-tip={t('Reload')} onClick={() => setReload((n) => n + 1)}>
          <ArrowsClockwise size={14} />
        </button>
        <button type="button" className="icon-btn is-small" aria-label={t('Open in the browser')} data-tip={t('Open in the browser')} onClick={() => (desktop ? desktop.openExternal(page) : window.open(page, '_blank', 'noopener'))}>
          <ArrowSquareOut size={14} />
        </button>
      </div>
      {picking && <p className="preview-hint">{t('Click the thing you mean on the page. Esc leaves.')}</p>}
      <iframe key={reload} ref={frame} className="preview-frame" src={proxied} title={t('Preview')} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" />
    </div>
  );
}
