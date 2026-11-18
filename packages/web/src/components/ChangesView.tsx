import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { absolutePath } from '../lib/desktop';
import { DIFF_AT_ONCE, colourDiff } from '../lib/colour';
import { diffRows, widestRows, type CodeRow } from '../lib/diff';
import { diffOp, shortPath } from '../lib/format';
import { count, useT } from '../lib/i18n';
import { getState, setUi, toast, useStore } from '../lib/store';
import type { DiffFile, Message } from '../lib/types';
import { CodeRows, openGap } from './code/CodeRows';
import { GitDiff, X } from './icons';

type ChangeFile = DiffFile & { via?: string };
interface Loaded {
  files: ChangeFile[];
  /** From the turn's restore point, where every line of each file can be asked for; else the steps' own diffs. */
  whole: boolean;
}

/** Open every file a turn changed, at one of them. */
export function openChanges(session: string, turn: string, file?: string): void {
  setUi({ changesView: { session, turn, file } });
}

/** The steps' own diffs of a turn, one entry a file and change, for a turn without a restore point. */
function stepChanges(messages: Message[], turn: string): ChangeFile[] {
  const out: ChangeFile[] = [];
  for (const m of messages) {
    if (m.turn !== turn || m.replay) continue;
    for (const p of m.parts) if (p.type === 'tool_result' && p.display?.kind === 'diff') out.push(...p.display.files);
  }
  return out;
}

const fileKey = (f: ChangeFile, i: number) => `${i}:${f.movedTo ?? f.path}`;

/**
 * Every file one turn changed, in a sheet: the files on the left with what each gained and lost, all their diffs one
 * after another on the right under headers that stay at the top while their file is read, and a click on a file
 * going to it. From the turn's restore point the unchanged runs between hunks open in place.
 */
export function ChangesView() {
  const t = useT();
  const view = useStore((s) => s.ui.changesView);
  const cwd = useStore((s) => (s.ui.changesView && s.session?.meta.id === s.ui.changesView.session ? s.session.meta.cwd : ''));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  // The file gone to from the list: near the end it may not reach the top, and stays the one marked while in view.
  const target = useRef<number | null>(null);
  const close = useCallback(() => setUi({ changesView: null }), []);

  useEffect(() => {
    if (!view) return;
    setLoaded(null);
    setError('');
    setCurrent(0);
    target.current = null;
    let live = true;
    api<{ turn: string; files: ChangeFile[] }[]>(`/sessions/${encodeURIComponent(view.session)}/changes/${encodeURIComponent(view.turn)}`)
      .then((list) => {
        if (!live) return;
        const files = list[0]?.files ?? [];
        if (files.length) return setLoaded({ files, whole: true });
        const s = getState().session;
        setLoaded({ files: s?.meta.id === view.session ? stepChanges(s.messages, view.turn) : [], whole: false });
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [view?.session, view?.turn]);

  useEffect(() => {
    if (!view) return;
    const key = (e: KeyboardEvent) => {
      // The file view opens over this one and closes first.
      if (e.key !== 'Escape' || getState().ui.fileView) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [view, close]);

  const go = useCallback((i: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-change="${i}"]`);
    if (!el || !scroller.current) return;
    target.current = i;
    scroller.current.scrollTop = el.offsetTop;
    setCurrent(i);
  }, []);

  // Opened at one file: that file at the top once the diffs are there. The keys that scroll then scroll the diffs.
  useEffect(() => {
    if (!loaded) return;
    scroller.current?.focus({ preventScroll: true });
    if (!view?.file) return;
    const i = loaded.files.findIndex((f) => f.path === view.file || f.movedTo === view.file);
    if (i > 0) go(i);
  }, [loaded, view?.file, go]);

  // The file being read, marked in the list: the last whose header has reached the top.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !loaded) return;
    let frame = 0;
    const on = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const heads = el.querySelectorAll<HTMLElement>('[data-change]');
        let at = 0;
        heads.forEach((h, i) => {
          if (h.offsetTop <= el.scrollTop + 8) at = i;
        });
        const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        const gone = target.current !== null ? heads[target.current] : undefined;
        if (end && gone && gone.offsetTop < el.scrollTop + el.clientHeight) at = target.current!;
        else target.current = null;
        setCurrent(at);
      });
    };
    el.addEventListener('scroll', on, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', on);
    };
  }, [loaded]);

  if (!view) return null;
  const files = loaded?.files ?? [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return createPortal(
    <div className="scrim is-sheet changes-view-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="changes-view" role="dialog" aria-modal="true" aria-label={t('Changes in this turn')}>
        <header className="changes-head">
          <GitDiff size={16} className="changes-icon" />
          <div className="changes-title">
            <span className="changes-name">{t('Changes in this turn')}</span>
            {loaded && files.length > 0 && (
              <span className="changes-sum num">
                {count(t, files.length, '{n} file', '{n} files')} <span className="add">+{added}</span> <span className="del">−{removed}</span>
              </span>
            )}
          </div>
          <button type="button" className="icon-btn is-small" aria-label={t('Close')} data-tip={t('Close')} data-keys="Esc" onClick={close}>
            <X size={16} />
          </button>
        </header>
        {error ? (
          <p className="changes-empty">{error}</p>
        ) : !loaded ? (
          <div className="changes-empty">
            <span className="spindle" aria-hidden />
          </div>
        ) : !files.length ? (
          <p className="changes-empty">{t('This turn changed no files.')}</p>
        ) : (
          <div className="changes-body">
            <nav className="changes-files" aria-label={t('Files')}>
              {!loaded.whole && <p className="changes-note">{t('This turn has no restore point: these are the diffs its steps showed.')}</p>}
              {files.map((f, i) => (
                <button key={fileKey(f, i)} type="button" className={`changes-file-link ${i === current ? 'is-current' : ''}`} aria-current={i === current || undefined} onClick={() => go(i)}>
                  <span className={`diff-op is-${f.op}`}>{diffOp(f.op)}</span>
                  <span className="mono changes-path" data-tip={f.movedTo ?? f.path}>
                    {shortPath(f.movedTo ?? f.path, 34)}
                  </span>
                  <span className="num changes-count">
                    <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
                  </span>
                </button>
              ))}
            </nav>
            <div className="changes-scroll" ref={scroller} tabIndex={-1}>
              {files.map((f, i) => (
                <section key={fileKey(f, i)} className="changes-file" data-change={i}>
                  <h3 className="changes-file-head" {...(cwd ? { 'data-ctx': 'file', 'data-path': absolutePath(cwd, f.movedTo ?? f.path) } : {})}>
                    <span className={`diff-op is-${f.op}`}>{diffOp(f.op)}</span>
                    <span className="mono changes-file-path">{f.movedTo ? `${f.path} → ${f.movedTo}` : f.path}</span>
                    <span className="num changes-count">
                      <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
                    </span>
                  </h3>
                  <ChangeRows f={f} root={scroller} session={view.session} turn={view.turn} whole={loaded.whole} />
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * One file's diff in the sheet. With the turn's restore point behind it, a run of unchanged lines opens in place: the
 * first asks for the file with all its lines, which then opens every other run without asking again.
 */
const ChangeRows = memo(function ChangeRows({ f, root, session, turn, whole }: { f: ChangeFile; root: RefObject<HTMLElement | null>; session: string; turn: string; whole: boolean }) {
  const path = f.movedTo ?? f.path;
  // A long patch is shown plain and coloured off the page, as a long file is: coloured here, it took most of the
  // view's opening, and more once the page had stopped colouring long files itself and highlight.js was colder.
  const long = useMemo(() => lineCount(f.patch) > DIFF_AT_ONCE, [f.patch]);
  const plain = useMemo(() => diffRows(f.patch, path, { highlight: !long }), [f.patch, path, long]);
  const [late, setLate] = useState<{ patch: string; html: string[] } | null>(null);
  useEffect(() => {
    if (!long) return;
    return colourDiff(f.patch, path, (html) => setLate({ patch: f.patch, html }));
  }, [f.patch, path, long]);
  const colouring = long && late?.patch !== f.patch;
  const first = useMemo(() => {
    if (!late || late.patch !== f.patch || late.html.length !== plain.rows.length) return plain;
    return { ...plain, rows: plain.rows.map((r, i) => (r.k === 'gap' || r.k === 'note' ? r : { ...r, html: late.html[i] })) };
  }, [plain, late, f.patch]);
  const [opened, setOpened] = useState<{ rows: CodeRow[]; digits: number } | null>(null);
  const shown = opened?.rows ?? first.rows;
  const digits = opened?.digits ?? first.digits;
  const widest = useMemo(() => (opened ? widestRows(opened.rows) : first.widest), [opened, first]);
  const asking = useRef(false);
  const open = useCallback(
    async (index: number) => {
      const g = shown[index];
      if (g?.k !== 'gap') return;
      if (g.rows) return setOpened({ rows: openGap(shown, index), digits });
      if (!whole || asking.current) return;
      asking.current = true;
      try {
        const all = await api<DiffFile>(`/sessions/${encodeURIComponent(session)}/changes/${encodeURIComponent(turn)}?file=${encodeURIComponent(f.path)}`);
        const folded = diffRows(all.patch, path, { fold: 3 });
        // The same run in the file with all its lines, by where it starts on the old side.
        const at = folded.rows.findIndex((r) => r.k === 'gap' && r.o === g.o);
        setOpened({ rows: at >= 0 ? openGap(folded.rows, at) : folded.rows, digits: folded.digits });
      } catch (e) {
        toast(String((e as Error).message ?? e), 'error');
      } finally {
        asking.current = false;
      }
    },
    [shown, digits, whole, session, turn, f.path, path],
  );
  const canOpen = whole || shown.some((r) => r.k === 'gap' && r.rows);
  return (
    <div className="changes-code">
      <CodeRows rows={shown} widest={widest} digits={digits} sides={2} root={root} hold={colouring && !opened} onGap={canOpen ? (i) => void open(i) : undefined} />
    </div>
  );
});
