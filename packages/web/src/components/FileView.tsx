import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { desktop } from '../lib/desktop';
import { COLOUR_AT_ONCE, colourLines } from '../lib/colour';
import { highlightLines, widestRows, type CodeRow } from '../lib/diff';
import { fill, useT } from '../lib/i18n';
import { copyText } from '../lib/clipboard';
import { fileName, PICTURE, RUNS_WHEN_OPENED } from '../lib/fileRefs';
import { pictureSrc } from '../lib/markdown';
import { setUi, toast, useStore } from '../lib/store';
import { CodeRows } from './code/CodeRows';
import { ArrowSquareOut, Copy, FileCode, FolderOpen, X } from './icons';
import { Pen } from './Pen';
import { openViewer } from './ui/Viewer';


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

/**
 * A link to a file here that is no text file (a video, a picture, a PDF): a picture opens in the viewer, anything
 * else in the program the system opens it with. A file that would run is shown in its folder instead, since it was
 * the answer that chose the link. In the browser, which can start no program, the file view says where the file is.
 */
export async function openLocalLink(asked: string, session: string | undefined, name: string, from?: Element): Promise<void> {
  if (PICTURE.test(asked)) return openViewer([{ src: pictureSrc(asked, session), name: name || fileName(asked) }], 0, from);
  if (!desktop) return openFile(asked, { session });
  const absolute = /^([a-z]:[\\/]|\\\\|\/)/i.test(asked);
  let file: string;
  try {
    file = (await api<{ path: string }>(`/file?stat&path=${encodeURIComponent(asked)}${session ? `&session=${encodeURIComponent(session)}` : ''}`)).path;
  } catch (e) {
    // A folder, or a file outside the project the server did not find: the system says what it makes of the path.
    if (!absolute) return void toast(`${(e as Error).message ?? String(e)}: ${asked}`, 'error');
    file = asked;
  }
  if (RUNS_WHEN_OPENED.test(file)) return desktop.showItem(file);
  const err = await desktop.openPath(file);
  if (err) toast(`${err}: ${file}`, 'error');
}

/** Any file reference in any rendered answer opens the view, by click or by Enter and Space when focused. */
function useFileRefClicks(): void {
  useEffect(() => {
    const open = (el: HTMLElement) => openFile(el.dataset.file!, { line: Number(el.dataset.line) || undefined, end: Number(el.dataset.end) || undefined, session: el.dataset.session });
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[data-local]') as HTMLAnchorElement | null;
      if (link?.dataset.local) {
        // Enter on a focused link arrives here as a click too.
        e.preventDefault();
        void openLocalLink(link.dataset.local, link.dataset.session, link.textContent ?? '', link);
        return;
      }
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
  const end = line && view?.end && view.end > line ? Math.min(view.end, lines.length) : line;
  // A long file is shown as plain text first and coloured off the page: coloured in one go, it held the page before
  // the view showed anything.
  const small = lines.length <= COLOUR_AT_ONCE;
  const plain = useMemo(() => (file && !small ? highlightLines(lines, file.path, false) : null), [file, lines, small]);
  const early = useMemo(() => (file && small ? highlightLines(lines, file.path) : null), [file, lines, small]);
  const [late, setLate] = useState<{ lines: string[]; html: string[] } | null>(null);
  useEffect(() => {
    if (!file || small) return;
    return colourLines(lines, file.path, (html) => setLate({ lines, html }));
  }, [file, lines, small]);
  const html = early ?? (late?.lines === lines ? late.html : plain);
  // While the colours are on their way, rows are drawn only where they are read: one drawn ahead now would be drawn
  // again when they come.
  const colouring = !!file && !small && late?.lines !== lines;
  const rows = useMemo(
    () => lines.map((text, i): CodeRow => ({ k: 'ctx', n: i + 1, html: html?.[i] ?? '', text, mark: !!line && i + 1 >= line && i + 1 <= (end ?? line) })),
    [lines, html, line, end],
  );
  const widest = useMemo(() => widestRows(lines), [lines]);

  // The named lines a third of the way down, once drawn.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !file) return;
    const mark = el.querySelector<HTMLElement>('.dl-row.is-mark');
    if (!mark) return void (el.scrollTop = 0);
    // The view opens with a small scale: measured on screen, a line 4,500 down came out 150 lines short.
    const scale = el.getBoundingClientRect().height / el.offsetHeight || 1;
    el.scrollTop = Math.max(0, el.scrollTop + (mark.getBoundingClientRect().top - el.getBoundingClientRect().top) / scale - el.clientHeight / 3);
  }, [file, line]);

  if (!view) return null;
  const close = () => setUi({ fileView: null });
  const shown = file?.path ?? view.path;
  const name = shown.split(/[\\/]/).filter(Boolean).pop() ?? shown;
  const folder = file ? file.relative.split('/').slice(0, -1).join('/') : '';
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
            <Pen width={24} />
          </div>
        ) : (
          <div className="file-view-code" ref={scroller}>
            <CodeRows rows={rows} widest={widest} digits={String(lines.length).length} sides={1} root={scroller} around={line ? line - 1 : undefined} ahead={1024} hold={colouring} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
