import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { desktop } from '../lib/desktop';
import { fill, useT } from '../lib/i18n';
import { highlightCode } from '../lib/markdown';
import { copyText } from '../lib/clipboard';
import { setUi, toast, useStore } from '../lib/store';
import { ArrowSquareOut, Copy, FileCode, FolderOpen, X } from './icons';

/** The code's line height in the view, in pixels: the mark over the named lines is placed by it. */
const LINE = 20;
/** Lines shown around the named one in a long file; the rest stays one click away in the editor. */
const WINDOW = 1600;

interface Loaded {
  path: string;
  relative: string;
  content: string;
  /** Other files of the project whose paths end the same way, when the answer gave only the end. */
  others: number;
}

/** Open a file an answer named, at its lines. */
export function openFile(path: string, at: { line?: number; end?: number; session?: string } = {}): void {
  setUi({ fileView: { path, ...at } });
}

/** Any file reference in any rendered answer opens the view, by click or by Enter and Space when focused. */
function useFileRefClicks(): void {
  useEffect(() => {
    const open = (el: HTMLElement) => openFile(el.dataset.file!, { line: Number(el.dataset.line) || undefined, end: Number(el.dataset.end) || undefined, session: el.dataset.session });
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('.file-ref') as HTMLElement | null;
      if (!el?.dataset.file) return;
      e.preventDefault();
      open(el);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = (e.target as Element | null)?.closest?.('.file-ref') as HTMLElement | null;
      if (!el?.dataset.file) return;
      e.preventDefault();
      open(el);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
}

/**
 * A file an answer named, read through the server and shown with its lines numbered, scrolled to the lines it was
 * named at and those lines marked. From here it opens in the editor, shows in its folder, or its path is copied.
 */
export function FileView() {
  const t = useT();
  const view = useStore((s) => s.ui.fileView);
  const [file, setFile] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  useFileRefClicks();

  useEffect(() => {
    if (!view) return;
    setFile(null);
    setError('');
    let live = true;
    api<Loaded>(`/file?path=${encodeURIComponent(view.path)}${view.session ? `&session=${encodeURIComponent(view.session)}` : ''}`)
      .then((f) => live && setFile(f))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [view?.path, view?.session]);

  useEffect(() => {
    if (!view) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setUi({ fileView: null });
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [view]);

  const lines = useMemo(() => file?.content.replace(/\r\n/g, '\n').split('\n') ?? [], [file]);
  const line = view?.line && view.line <= lines.length ? view.line : undefined;
  const first = line && lines.length > WINDOW ? Math.max(1, Math.min(line - Math.floor(WINDOW / 3), lines.length - WINDOW + 1)) : 1;
  const last = Math.min(lines.length, first + WINDOW - 1);
  const html = useMemo(() => (file ? highlightCode(lines.slice(first - 1, last).join('\n'), file.path) : ''), [file, lines, first, last]);
  const numbers = useMemo(() => Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i).join('\n'), [first, last]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !file) return;
    el.scrollTop = line ? Math.max(0, (line - first) * LINE - el.clientHeight / 3) : 0;
  }, [file, line, first]);

  if (!view) return null;
  const close = () => setUi({ fileView: null });
  const shown = file?.path ?? view.path;
  const name = shown.split(/[\\/]/).filter(Boolean).pop() ?? shown;
  const folder = file ? file.relative.split('/').slice(0, -1).join('/') : '';
  const end = line && view.end && view.end > line ? Math.min(view.end, lines.length) : line;
  const copy = () => void copyText(shown, t);
  return createPortal(
    <div className="scrim is-sheet file-view-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="file-view" role="dialog" aria-modal="true" aria-label={name}>
        <header className="file-view-head">
          <FileCode size={16} className="file-view-icon" />
          <div className="file-view-title">
            <span className="file-view-name mono">
              {name}
              {line && (
                <span className="file-view-at">
                  :{line}
                  {end && end > line ? `–${end}` : ''}
                </span>
              )}
            </span>
            {folder && (
              <span className="file-view-folder mono" data-tip={file?.path}>
                {folder}
              </span>
            )}
          </div>
          <div className="file-view-actions">
            {desktop && file && (
              <button type="button" className="icon-btn is-small" aria-label={t('Open in the editor')} data-tip={t('Open in the editor')} onClick={() => desktop!.openPath(file.path).then((err) => err && toast(err, 'error'))}>
                <ArrowSquareOut size={16} />
              </button>
            )}
            {desktop && file && (
              <button type="button" className="icon-btn is-small" aria-label={t('Show in folder')} data-tip={t('Show in folder')} onClick={() => desktop!.showItem(file.path)}>
                <FolderOpen size={16} />
              </button>
            )}
            <button type="button" className="icon-btn is-small" aria-label={t('Copy path')} data-tip={t('Copy path')} onClick={copy}>
              <Copy size={16} />
            </button>
            <button type="button" className="icon-btn is-small" aria-label={t('Close')} data-tip={t('Close')} data-keys="Esc" onClick={close}>
              <X size={16} />
            </button>
          </div>
        </header>
        {file && file.others > 0 && <p className="file-view-note">{fill(t('{n} other files end the same way; this is the one nearest the project root.'), file.others)}</p>}
        {error ? (
          <p className="file-view-empty">{/404/.test(error) || /No such/.test(error) ? fill(t('{n} is not in this project.'), view.path) : error}</p>
        ) : !file ? (
          <div className="file-view-empty">
            <span className="spindle" aria-hidden />
          </div>
        ) : (
          <div className="file-view-code" ref={scroller}>
            <div className="file-view-lines" style={{ lineHeight: `${LINE}px` }}>
              {line && <div className="file-view-mark" style={{ top: (line - first) * LINE, height: ((end ?? line) - line + 1) * LINE }} aria-hidden />}
              <pre className="file-view-gutter" aria-hidden>
                {numbers}
              </pre>
              <pre className="file-view-text">
                <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
              </pre>
            </div>
            {(first > 1 || last < lines.length) && <p className="file-view-note">{fill(t('Lines {n} of the file; the editor has the rest.'), `${first}–${last} / ${lines.length}`)}</p>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
