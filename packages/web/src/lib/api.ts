import type { AgentEvent, StreamDraft } from '@favilla/core/types';
import { settingsWords, settingText, type SettingsMessage, type SettingsNotice } from '@favilla/core/i18n';
import { getState } from './store';
import { resolveLang, translate } from './i18n';
import { remote, remoteMode, type RemoteState } from './remote';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly replacementId?: string,
    readonly settingsConflict = false,
  ) {
    super(message);
  }
}

function apiError(status: number, data: { error?: string; replacementId?: string; problem?: SettingsMessage } | null, fallback: string): ApiError {
  const lang = resolveLang(getState().info?.config.language);
  const text = data?.problem ? settingText(data.problem, (key) => translate(lang, key)) : data?.error || fallback;
  return new ApiError(status, text, data?.replacementId, data?.problem?.key === settingsWords.conflict);
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  init.signal?.throwIfAborted();
  if (remoteMode) {
    // On a phone: the same request, sealed, over the channel to the computer.
    const r = await remote.request(init.method ?? (init.body !== undefined ? 'POST' : 'GET'), path, init.body);
    init.signal?.throwIfAborted();
    const data = r.b ?? (r.text !== undefined ? r.text : null);
    if (r.s >= 400) throw apiError(r.s, data as Parameters<typeof apiError>[1], String(r.s));
    return data as T;
  }
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
    signal: init.signal,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw apiError(res.status, data, `${res.status} ${res.statusText}`);
  return data as T;
}

export type ConnectionState = 'open' | 'connecting' | 'closed' | 'unauthorized';

// A page can still be paired with a server that predates stream offsets.
type OptionalStreamOffset<E> = E extends { type: 'stream.text' | 'stream.reasoning' | 'stream.tool' }
  ? Omit<E, 'at'> & { at?: number }
  : E;
type SubagentEvent = Extract<AgentEvent, { type: 'subagent' }>;
type WireAgentEvent = OptionalStreamOffset<Exclude<AgentEvent, SubagentEvent>> | (Omit<SubagentEvent, 'event'> & { event: WireAgentEvent });

export type ServerEvent = WireAgentEvent | { type: 'server.config' } | { type: 'server.settings'; notice: SettingsNotice };

export type EventConnection = (() => void) & { follow?: (session: string | null) => void };

interface WindowEvents {
  session: string | null;
  draft(session: string, draft: StreamDraft): void;
  replay(events: ServerEvent[]): void;
}

/** Live events over SSE; reconnects on its own and reports whether it could replay the gap. */
export function connectEvents(onEvent: (e: ServerEvent) => void, onState: (s: ConnectionState, resumed?: boolean) => void | Promise<boolean>, windowEvents: WindowEvents): EventConnection {
  if (remoteMode) {
    // On a phone the channel carries the events; its state is the connection's.
    const map: Record<RemoteState, ConnectionState> = { open: 'open', connecting: 'connecting', offline: 'closed', unpaired: 'unauthorized', refused: 'unauthorized' };
    const off = remote.onState((s) => onState(map[s]));
    const unsub = remote.subscribe((e) => onEvent(e as ServerEvent));
    return () => {
      off();
      unsub();
    };
  }
  let es: EventSource | null = null;
  let stopped = false;
  let retry = 500;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let statusProbe: AbortController | undefined;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  let session = windowEvents.session;
  let version = 0;
  let cursor: string | undefined;
  let covered: number | undefined;
  let updateScope: (() => void) | undefined;

  const lost = (source: EventSource) => {
    if (source !== es) return;
    es = null;
    updateScope = undefined;
    clearTimeout(fallback);
    source.close();
    // An event stream does not report why it failed: ask once whether the server is down or this page lost its access.
    const check = statusProbe = new AbortController();
    // After sleep an old connection can stay pending. The status probe must not hold up reconnecting.
    const timeout = setTimeout(() => check.abort(), 2000);
    fetch('/api/info', { credentials: 'same-origin', signal: check.signal })
      .then((r) => { if (!stopped) onState(r.status === 401 ? 'unauthorized' : 'closed'); })
      .catch(() => { if (!stopped) onState('closed'); })
      .finally(() => {
        clearTimeout(timeout);
        statusProbe = undefined;
        if (stopped) return;
        retryTimer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 8000);
      });
  };

  const open = () => {
    if (stopped) return;
    onState('connecting');
    const sent = version;
    const query = new URLSearchParams({ window: id, active: session ?? '', scope: String(sent) });
    if (cursor && sent === covered) query.set('after', cursor);
    const source = es = new EventSource(`/api/events?${query}`);
    let trusted = false;
    let missed: ServerEvent[] | undefined;
    let acknowledged = sent;
    const current = () => source === es;

    source.onopen = () => {
      if (!current()) return;
      retry = 500;
      if (!source.addEventListener) onState('open');
      else fallback = setTimeout(() => { if (current()) onState('open'); }, 500);
    };
    source.onmessage = (m) => {
      if (!current()) return;
      try {
        const event = JSON.parse(m.data) as ServerEvent;
        if (missed) missed.push(event);
        else {
          onEvent(event);
          if (m.lastEventId) cursor = m.lastEventId;
        }
      } catch {
        /* ignore malformed */
      }
    };
    source.onerror = () => lost(source);

    source.addEventListener?.('replay', () => {
      if (!current()) return;
      clearTimeout(fallback);
      missed = [];
    });
    source.addEventListener?.('ready', (m) => {
      if (!current()) return;
      clearTimeout(fallback);
      // A connection cut during replay must resume from the last cursor we actually applied.
      if (missed?.length) windowEvents.replay(missed);
      missed = undefined;
      cursor = m.lastEventId;
      covered = undefined;
      updateScope = () => {
        const sending = version;
        void api(`/events/${id}`, { method: 'PUT', body: { version: sending, session } }).catch(() => {
          if (version === sending) lost(source);
        });
      };
      const done = onState('open', JSON.parse(m.data).resumed === true && sent === version);
      void Promise.resolve(done).then((ok) => {
        if (!current() || ok === false) return;
        trusted = true;
        covered = acknowledged;
      }, () => {});
      if (sent !== version) updateScope();
    });
    source.addEventListener?.('draft', (m) => {
      if (!current()) return;
      const snapshot = JSON.parse(m.data) as { version: number; session?: string; draft: StreamDraft | null };
      if (snapshot.version !== version) return;
      acknowledged = snapshot.version;
      if (trusted) covered = acknowledged;
      if (snapshot.session && snapshot.draft) windowEvents.draft(snapshot.session, snapshot.draft);
    });
  };
  open();
  const stop: EventConnection = () => {
    stopped = true;
    clearTimeout(fallback);
    clearTimeout(retryTimer);
    statusProbe?.abort();
    es?.close();
    es = null;
    updateScope = undefined;
  };
  stop.follow = (next) => {
    if (next === session) return;
    session = next;
    version++;
    updateScope?.();
  };
  return stop;
}

export async function fileToImage(file: File): Promise<{ mediaType: string; data: string; name: string }> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType: file.type || 'image/png', data: btoa(binary), name: file.name || 'pasted.png' };
}
