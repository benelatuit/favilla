import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useFind } from '../../lib/find';
import { foldKey, useFoldOpen } from '../../lib/fold-state';
import { fmtTokens } from '../../lib/format';
import { count, fill, useT } from '../../lib/i18n';
import { attachedFiles, userWords } from '../../lib/messages';
import { lineCount, pastedIn } from '../../lib/paste';
import { pointedIn } from '../../lib/point';
import { actions, setUi, toast, useStore } from '../../lib/store';
import type { Message } from '../../lib/types';
import { keepRawText } from '../contextMenu';
import { Check, ClipboardText, Copy, Crosshair, FileText, PencilSimple } from '../icons';
import { useSessionScope } from '../tools/SessionScope';
import { openViewer } from '../ui/Viewer';
import { Markdown } from './MarkdownView';

function userParts(m: Message): { text: string; attached: string[]; images: { src: string; name: string }[] } {
  const text = userWords(m);
  const attached = attachedFiles(m);
  const images = m.parts
    .filter((p) => p.type === 'image')
    .map((p, i) => {
      const img = p as { mediaType: string; data?: string; name?: string; url?: string };
      return { src: img.url ?? (img.data ? `data:${img.mediaType};base64,${img.data}` : ''), name: img.name ?? `image ${i + 1}` };
    });
  return { text, attached, images };
}

const USER_FOLD_LINES = 14;

/**
 * What the user wrote, as written: line breaks kept, fenced code shown as code. A long paste (an issue, a log, a
 * spec) shows its opening lines and opens in place, so the work after it is not three screens away.
 */
function UserText({ id, text }: { id: string; text: string }) {
  const t = useT();
  const { sessionId } = useSessionScope();
  const [open, toggleOpen] = useFoldOpen(sessionId, foldKey.user(id), false);
  const lines = text.split('\n').length;
  const long = lines > USER_FOLD_LINES + 4 || text.length > 1600;
  const parts = text.split(/(^```[^\n]*\n[\s\S]*?\n```[ \t]*$)/m);
  return (
    <div className={`user-text-wrap ${long && !open ? 'is-folded' : ''}`}>
      <div className="user-text">
        {parts.map((p, i) => {
          const fence = /^```([^\n]*)\n([\s\S]*?)\n```[ \t]*$/.exec(p);
          return fence ? (
            <pre key={i} className="user-code">
              <code>{fence[2]}</code>
            </pre>
          ) : (
            <span key={i}>{p.replace(/^\n|\n$/g, '')}</span>
          );
        })}
      </div>
      {long && (
        <button type="button" className="user-fold" onClick={toggleOpen}>
          {open ? t('Fold') : fill(t('Show all {n} lines'), lines)}
        </button>
      )}
    </div>
  );
}

/**
 * A sent message edited in place and sent again: the conversation after it goes, or goes on beside a new branch;
 * either way this conversation's later file changes can be undone first.
 */
function UserEdit({ m, text }: { m: Message; text: string }) {
  const t = useT();
  const id = useStore((s) => s.activeId);
  const [draft, setDraft] = useState(text);
  const [changed, setChanged] = useState(0);
  const [undo, setUndo] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id || !m.turn) return;
    api<{ turn: string; files: unknown[] }[]>(`/sessions/${id}/changes`)
      .then((all) => {
        const from = all.findIndex((c) => c.turn === m.turn);
        setChanged(from < 0 ? 0 : all.slice(from).reduce((n, c) => n + c.files.length, 0));
      })
      .catch(() => setChanged(0));
  }, [id, m.turn]);
  const cancel = () => setUi({ editing: null });
  const submit = async (replace: boolean) => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      const restored = await actions.fork(m.id, 'before', { undo: changed > 0 && undo, text: draft, replace });
      if (restored.length) toast(fill(t('Put back {n} files as they were before that message.'), restored.length), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <div className="turn-user is-editing">
      <div className="user-card user-edit">
        <textarea
          autoFocus
          value={draft}
          rows={Math.min(12, Math.max(2, draft.split('\n').length))}
          aria-label={t('Edit message')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel();
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(true);
          }}
        />
        <div className="user-edit-bar">
          {changed > 0 && (
            <label className="check">
              <input type="checkbox" checked={undo} onChange={(e) => setUndo(e.target.checked)} />
              <span>{fill(t('Undo the {n} file changes made since'), changed)}</span>
            </label>
          )}
          <span className="user-edit-gap" />
          <button type="button" className="btn btn-quiet is-small" onClick={cancel} disabled={busy}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn is-small" onClick={() => submit(false)} disabled={busy || !draft.trim()}>
            {t('Send in a new branch')}
          </button>
          <button type="button" className="btn btn-primary is-small" onClick={() => submit(true)} disabled={busy || !draft.trim()}>
            {t('Send again')}
          </button>
        </div>
      </div>
      <p className="user-edit-note">{t('Send again drops the conversation after this message; a new branch keeps it as it is.')}</p>
    </div>
  );
}

export const UserCard = memo(function UserCard({ m }: { m: Message }) {
  const t = useT();
  const { text, attached, images } = userParts(m);
  const pointed = pointedIn(m);
  const pasted = useMemo(() => pastedIn(m), [m]);
  const [shown, setShown] = useState(-1);
  const found = useFind((_, r) => (r?.block === m.id && r.paste !== undefined ? r : null));
  useEffect(() => {
    if (found?.paste !== undefined) setShown(found.paste);
  }, [found]);
  const editing = useStore((s) => s.ui.editing === m.id);
  const [copied, setCopied] = useState(false);
  const raw = useCallback((card: HTMLDivElement | null) => keepRawText(card, text), [text]);
  if (editing) return <UserEdit m={m} text={text} />;
  const copy = () =>
    navigator.clipboard.writeText([text, ...pasted].filter(Boolean).join('\n\n')).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => toast(t('Could not use the clipboard'), 'error'),
    );
  const validImages = images.filter((x) => x.src);
  return (
    <div ref={raw} className="turn-user" data-ctx="message" data-key={m.id} data-kind="user" data-find={m.id}>
      <div className="user-card">
        {images.length > 0 && (
          <div className="user-images">
            {images.map((img, i) =>
              img.src ? (
                <button
                  key={i}
                  type="button"
                  className="shot-open"
                  aria-label={img.name}
                  onClick={(e) =>
                    openViewer(
                      validImages.map((x) => ({ src: x.src, name: x.name })),
                      validImages.indexOf(img),
                      e.currentTarget,
                    )
                  }
                >
                  <img src={img.src} alt={img.name} />
                </button>
              ) : (
                <span key={i} className="file-chip">
                  {img.name}
                </span>
              ),
            )}
          </div>
        )}
        {text && <UserText id={m.id} text={text} />}
        {(attached.length > 0 || pointed.length > 0 || pasted.length > 0) && (
          <div className="user-files">
            {pasted.map((p, i) => (
              <button key={`t${i}`} type="button" className={`file-chip ${shown === i ? 'is-open' : ''}`} data-find-skip aria-expanded={shown === i} onClick={() => setShown(shown === i ? -1 : i)}>
                <ClipboardText size={12} /> {fill(t('Pasted text {n}'), i + 1)} <span className="paste-lines num">{count(t, lineCount(p), '{n} line', '{n} lines')}</span>
              </button>
            ))}
            {attached.map((f) => (
              <span key={f} className="file-chip mono">
                <FileText size={12} /> {f}
              </span>
            ))}
            {pointed.map((p, i) => (
              <span key={`p${i}`} className="file-chip" data-tip={p.selector}>
                <Crosshair size={12} /> <bdi>{p.label}</bdi>
              </span>
            ))}
          </div>
        )}
        {shown >= 0 && shown < pasted.length && (
          <pre className="user-code user-pasted" data-find-paste={shown} tabIndex={0}>
            {found?.paste !== shown && pasted[shown].length > 20_000 ? `${pasted[shown].slice(0, 20_000)}\n…` : pasted[shown]}
          </pre>
        )}
      </div>
      <div className="user-actions" data-find-skip>
        <button type="button" className="icon-btn is-small" aria-label={t('Copy message')} data-tip={copied ? t('Copied') : t('Copy message')} onClick={copy}>
          {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
        </button>
        <button type="button" className="icon-btn is-small" aria-label={t('Edit and send again')} data-tip={t('Edit and send again')} onClick={() => setUi({ editing: m.id })}>
          <PencilSimple size={14} />
        </button>
      </div>
    </div>
  );
});

/**
 * Where the context was compacted: what it held before and after, how many of the latest rounds stayed word for word,
 * and, open, the summary and Favilla's record of the work beside it, as the model reads them.
 */
export const Compaction = memo(function Compaction({ m }: { m: Message }) {
  const t = useT();
  const { sessionId } = useSessionScope();
  const [open, toggleOpen] = useFoldOpen(sessionId, foldKey.compaction(m.id), false);
  const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim() ?? text;
  const at = text.indexOf('What the work before this point did');
  const rest = at >= 0 ? text.slice(at) : '';
  const end = rest.search(/\n\n(?![ -])/);
  const record = rest ? (end < 0 ? rest : rest.slice(0, end)).trim() : undefined;
  const c = m.compacted;
  return (
    <div className="compaction" data-find={m.id}>
      <div className="rule-label">
        <span>{t('Earlier conversation summarized')}</span>
        {c && (
          <span className="compaction-figures num">
            {`${fmtTokens(c.before)} → ${fmtTokens(c.after)}`}
            {c.rounds > 0 && ` · ${fill(t(c.rounds > 1 ? 'the last {n} rounds kept word for word' : 'the last round kept word for word'), c.rounds)}`}
          </span>
        )}
        <button type="button" className="link" onClick={toggleOpen}>
          {open ? t('Hide summary') : t('Show summary')}
        </button>
      </div>
      {open && (
        <div className="compaction-body">
          <Markdown text={summary} className="plate prose" />
          {record && (
            <div className="compaction-record">
              <div className="compaction-record-head">{t('What Favilla recorded of the work')}</div>
              <pre className="mono">{record.split('\n').slice(1).join('\n')}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
