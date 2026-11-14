import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type ServerEvent } from '../lib/api';
import { useFollow } from '../lib/follow';
import { useEverySecond } from '../lib/clock';
import { useT } from '../lib/i18n';
import { fmtDuration } from '../lib/format';
import { observeSession, setUi, useStore } from '../lib/store';
import type { ChildView, SessionView, ToolResultPart } from '../lib/types';
import { ArrowDown, TreeStructure, X } from './icons';
import { Timeline } from './Timeline';
import { ActivityLine, ChildLine, StopChild } from './ToolEntry';

const EMPTY = new Map();

/** What the sub-agent is doing this moment, from its events: a step running, or thinking, writing, waiting. */
function NowLine({ c }: { c: ChildView }) {
  const t = useT();
  const step = c.steps.at(-1);
  // The running step reads as the timeline's steps do (verb and target in the reader's language), not as the
  // tool's own English title.
  if (c.activity === 'tool' && step && !step.ended) {
    return (
      <div className="is-activity">
        <ChildLine step={step} />
      </div>
    );
  }
  return <ActivityLine c={c} />;
}

type MessageEvent = Extract<ServerEvent, { type: 'message.added' | 'message.updated' }>;

function withMessage(view: SessionView, event: MessageEvent): SessionView {
  const at = view.messages.findIndex((m) => m.id === event.message.id);
  if (event.type === 'message.added') {
    return at < 0 ? { ...view, messages: [...view.messages, event.message] } : view;
  }
  if (at < 0) return view;
  const messages = [...view.messages];
  messages[at] = event.message;
  return { ...view, messages };
}

/** A sub-agent's conversation, kept current by its own events while the sheet is open. */
export function ChildSheet() {
  const t = useT();
  const sheet = useStore((s) => s.ui.sheet);
  const child = useStore((s) => (sheet ? [...s.children.values()].flat().find((c) => c.sessionId === sheet.sessionId) : undefined));
  const id = sheet?.sessionId;
  const [saved, setView] = useState<SessionView | null>(null);
  const view = saved?.meta.id === id ? saved : null;
  const live = child ? child.activity !== 'done' : !!view && view.status !== 'idle';
  const [failure, setError] = useState<{ id: string; message: string } | null>(null);
  const error = failure?.id === id ? failure?.message : undefined;
  const body = useRef<HTMLDivElement>(null);
  const { following, away, follow } = useFollow(() => body.current, { key: sheet?.sessionId });

  useEffect(() => {
    setView(null);
    setError(null);
    if (!id) return;
    const controller = new AbortController();
    let current: SessionView | null = null;
    let buffered: MessageEvent[] | null = null;
    let again = false;
    const load = () => {
      if (buffered) {
        again = true;
        return;
      }
      const events: MessageEvent[] = [];
      buffered = events;
      api<SessionView>(`/sessions/${id}`, { signal: controller.signal })
        .then((v) => {
          if (controller.signal.aborted) return;
          // An event can beat the HTTP view to this window. A message already in the view is kept once.
          current = events.reduce(withMessage, v);
          setView(current);
          setError(null);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError({ id, message: (e as Error).message });
        })
        .finally(() => {
          buffered = null;
          if (again && !controller.signal.aborted) {
            again = false;
            load();
          }
        });
    };
    const off = observeSession({
      id,
      reconnect: load,
      event(event) {
        if (event.type === 'message.added' || event.type === 'message.updated') {
          buffered?.push(event);
          if (current) {
            const next = withMessage(current, event);
            if (next !== current) setView(current = next);
            else if (event.type === 'message.updated') load();
          }
        } else if (event.type === 'turn.end' || (event.type === 'compaction' && (event.phase === 'end' || event.phase === 'pruned'))) {
          // Compaction's replay and released outputs are not sent as individual message updates.
          load();
        }
      },
    });
    load();
    return () => {
      off();
      controller.abort();
    };
  }, [id]);

  // The clocks on the line below move every second while it works.
  useEverySecond(live);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUi({ sheet: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  const messages = view?.messages;
  const results = useMemo(() => {
    const results = new Map<string, ToolResultPart>();
    for (const m of messages ?? []) for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);
    return results;
  }, [messages]);
  if (!sheet) return null;
  const started = child?.steps[0]?.started;
  return createPortal(
    <div className="childsheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && setUi({ sheet: null })}>
      <aside className="childsheet" role="dialog" aria-label={sheet.title}>
        <header className="childsheet-head">
          <TreeStructure size={16} />
          <span className="childsheet-kind">{t('Sub-agent')}</span>
          <span className="childsheet-title">{sheet.title}</span>
          {child?.model && <span className="childsheet-meta mono">{child.model.split('/').pop()}</span>}
          {live && (
            <span className="childsheet-live num">
              {t('working')}
              {started ? ` · ${fmtDuration(Date.now() - started)}` : ''}
            </span>
          )}
          {live && <StopChild sessionId={sheet.sessionId} />}
          <button type="button" className="icon-btn" aria-label={t('Close')} data-tip={t('Close')} data-keys="Esc" onClick={() => setUi({ sheet: null })}>
            <X size={16} />
          </button>
        </header>
        <div ref={body} className="childsheet-body scroll">
          {error ? (
            <div className="notice is-warn">{error}</div>
          ) : view ? (
            <>
              <Timeline messages={view.messages} results={results} drafts={EMPTY} running={EMPTY} embedded={{ live }} sessionId={sheet.sessionId} />
              {live && child && (
                <div className="childsheet-now">
                  <NowLine c={child} />
                </div>
              )}
            </>
          ) : (
            <div className="childsheet-empty">{t('Loading…')}</div>
          )}
        </div>
        {!following && (live || away) && (
          <button type="button" className="childsheet-latest" onClick={() => follow()}>
            <ArrowDown size={14} /> {t('Latest')}
          </button>
        )}
      </aside>
    </div>,
    document.body,
  );
}
