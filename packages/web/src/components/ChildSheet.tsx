import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type ServerEvent } from '../lib/api';
import { useEverySecond } from '../lib/clock';
import { useFollow } from '../lib/follow';
import { fmtDuration } from '../lib/format';
import { useT } from '../lib/i18n';
import { observeSession, setUi, useStore } from '../lib/store';
import type { ChildView, Draft, DraftPart, RunningTool, SessionView, ToolResultPart } from '../lib/types';
import { ArrowDown, TreeStructure, X } from './icons';
import { Timeline } from './Timeline';
import { ActivityLine, ChildLine, SessionScopeProvider, StopChild } from './ToolEntry';

const EMPTY_DRAFTS = new Map<string, Draft>();
const EMPTY_RUNNING = new Map<string, RunningTool>();

/** What the sub-agent is doing this moment, from its events: a step running, or thinking, writing, waiting. */
function NowLine({ c }: { c: ChildView }) {
  const step = c.steps.at(-1);
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

interface ChildLiveState {
  id: string;
  drafts: Map<string, Draft>;
  running: Map<string, RunningTool>;
}

function initialChildLive(id: string, v: SessionView): ChildLiveState {
  const drafts = new Map<string, Draft>();
  if (v.live?.draft) {
    const parts = new Map<number, DraftPart>();
    for (const p of v.live.draft.parts) {
      parts.set(p.index, { kind: p.kind, text: p.text, name: p.kind === 'tool' ? p.name : undefined });
    }
    drafts.set(v.live.draft.messageId, { id: v.live.draft.messageId, parts });
  }
  const running = new Map<string, RunningTool>();
  for (const r of v.live?.running ?? []) {
    running.set(r.callId, { ...r, output: '', sub: [] });
  }
  return { id, drafts, running };
}

function applyChildLiveEvent(prev: ChildLiveState, e: ServerEvent): ChildLiveState {
  switch (e.type) {
    case 'stream.start': {
      if (prev.drafts.has(e.messageId)) return prev;
      const drafts = new Map(prev.drafts);
      drafts.set(e.messageId, { id: e.messageId, parts: new Map() });
      return { ...prev, drafts };
    }
    case 'stream.text':
    case 'stream.reasoning':
    case 'stream.tool': {
      const kind = e.type === 'stream.text' ? 'text' : e.type === 'stream.reasoning' ? 'reasoning' : 'tool';
      const existing = prev.drafts.get(e.messageId) ?? { id: e.messageId, parts: new Map<number, DraftPart>() };
      const shown = existing.parts.get(e.index) ?? { kind, text: '' };
      const name = e.type === 'stream.tool' ? e.name ?? shown.name : shown.name;
      const delta = e.at === undefined ? e.delta : e.at <= shown.text.length ? e.delta.slice(shown.text.length - e.at) : '';
      const parts = new Map(existing.parts);
      parts.set(e.index, { ...shown, text: shown.text + delta, name });
      const drafts = new Map(prev.drafts);
      drafts.set(e.messageId, { ...existing, parts });
      return { ...prev, drafts };
    }
    case 'stream.discard': {
      if (!prev.drafts.has(e.messageId)) return prev;
      const drafts = new Map(prev.drafts);
      drafts.delete(e.messageId);
      return { ...prev, drafts };
    }
    case 'message.added': {
      if (e.message.role !== 'assistant' || !prev.drafts.has(e.message.id)) return prev;
      const drafts = new Map(prev.drafts);
      drafts.delete(e.message.id);
      return { ...prev, drafts };
    }
    case 'tool.start': {
      const running = new Map(prev.running);
      running.set(e.callId, { callId: e.callId, name: e.name, title: e.title, input: e.input, started: Date.now(), output: '', sub: [] });
      return { ...prev, running };
    }
    case 'tool.progress': {
      const r = prev.running.get(e.callId);
      if (!r) return prev;
      const running = new Map(prev.running);
      running.set(e.callId, { ...r, output: (r.output + e.chunk).slice(-60_000), display: e.display ?? r.display });
      return { ...prev, running };
    }
    case 'tool.end': {
      if (!prev.running.has(e.callId)) return prev;
      const running = new Map(prev.running);
      running.delete(e.callId);
      return { ...prev, running };
    }
    case 'turn.end':
      return prev.drafts.size || prev.running.size ? { id: prev.id, drafts: new Map(), running: new Map() } : prev;
    default:
      return prev;
  }
}

/** A sub-agent's conversation, kept current by its own events while the sheet is open. */
export function ChildSheet() {
  const t = useT();
  const sheet = useStore((s) => s.ui.sheet);
  const child = useStore((s) => (sheet ? [...s.children.values()].flat().find((c) => c.sessionId === sheet.sessionId) : undefined));
  const id = sheet?.sessionId;
  const [saved, setView] = useState<SessionView | null>(null);
  const [liveState, setLiveState] = useState<ChildLiveState | null>(null);
  const view = saved?.meta.id === id ? saved : null;
  const activeLive = liveState?.id === id ? liveState : null;
  const live = child ? child.activity !== 'done' : !!view && view.status !== 'idle';
  const [failure, setError] = useState<{ id: string; message: string } | null>(null);
  const error = failure?.id === id ? failure?.message : undefined;
  const body = useRef<HTMLDivElement>(null);
  const { following, away, follow } = useFollow(() => body.current, { enabled: !!sheet, key: sheet?.sessionId, live });

  useEffect(() => {
    setView(null);
    setLiveState(id ? { id, drafts: new Map(), running: new Map() } : null);
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
          current = events.reduce(withMessage, v);
          setView(current);
          setLiveState((prev) => {
            const seeded = initialChildLive(id, current!);
            if (!prev || prev.id !== id) return seeded;
            // Keep any live progress/draft chunks that arrived after the HTTP snapshot began.
            const drafts = new Map([...seeded.drafts, ...prev.drafts]);
            for (const m of current!.messages) if (m.role === 'assistant') drafts.delete(m.id);
            const running = new Map([...seeded.running, ...prev.running]);
            for (const m of current!.messages) for (const p of m.parts) if (p.type === 'tool_result') running.delete(p.callId);
            return { id, drafts, running };
          });
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
        setLiveState((prev) => applyChildLiveEvent(prev?.id === id ? prev : { id, drafts: new Map(), running: new Map() }, event));
        if (event.type === 'message.added' || event.type === 'message.updated') {
          buffered?.push(event);
          if (current) {
            const next = withMessage(current, event);
            if (next !== current) setView((current = next));
            else if (event.type === 'message.updated') load();
          }
        } else if (event.type === 'turn.end' || (event.type === 'compaction' && (event.phase === 'end' || event.phase === 'pruned'))) {
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
    const map = new Map<string, ToolResultPart>();
    for (const m of messages ?? []) for (const p of m.parts) if (p.type === 'tool_result') map.set(p.callId, p);
    return map;
  }, [messages]);
  if (!sheet) return null;
  const started = child?.steps[0]?.started;
  const childDrafts = activeLive?.drafts ?? EMPTY_DRAFTS;
  const childRunning = activeLive?.running ?? EMPTY_RUNNING;
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
            <SessionScopeProvider sessionId={sheet.sessionId} cwd={view.meta.cwd} results={results}>
              <Timeline
                messages={view.messages}
                results={results}
                drafts={childDrafts}
                running={childRunning}
                embedded={{ live }}
                sessionId={sheet.sessionId}
              />
              {live && child && !childDrafts.size && !childRunning.size && (
                <div className="childsheet-now">
                  <NowLine c={child} />
                </div>
              )}
            </SessionScopeProvider>
          ) : (
            <div className="childsheet-empty">{t('Loading…')}</div>
          )}
        </div>
        {!following && away && (
          <button type="button" className="childsheet-latest" onClick={() => follow()}>
            <ArrowDown size={14} /> {t('Latest')}
          </button>
        )}
      </aside>
    </div>,
    document.body,
  );
}
