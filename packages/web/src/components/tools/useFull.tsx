import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import type { ToolDisplay, ToolResultPart } from '../../lib/types';
import { useSessionScope } from './SessionScope';

/**
 * Fetches the unclipped tool output or diff on demand when a preview was truncated.
 * Resets cleanly across callId/sessionId changes and aborts stale in-flight requests on unmount or retry.
 */
export function useFull(
  result: ToolResultPart,
  whole = false,
): { content: string; display: ToolDisplay | undefined; more: ReactNode } {
  const t = useT();
  const { sessionId } = useSessionScope();
  const identity = `${sessionId ?? ''}:${result.callId}`;
  const [loaded, setLoaded] = useState<{ key: string; content: string; display?: ToolDisplay } | null>(null);
  const [status, setStatus] = useState<{ key: string; phase: 'idle' | 'loading' | 'failed' }>({ key: identity, phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const full = loaded?.key === identity ? loaded : null;
  const phase = status.key === identity ? status.phase : 'idle';
  const d = result.display;
  const partial = !!result.truncated || ((d?.kind === 'terminal' || d?.kind === 'diff') && !!d.clipped);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [identity]);

  const load = useCallback(() => {
    if (!sessionId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ key: identity, phase: 'loading' });
    api<{ content: string; display?: ToolDisplay }>(
      `/sessions/${sessionId}/result/${encodeURIComponent(result.callId)}`,
      { signal: controller.signal },
    )
      .then((res) => {
        if (controller.signal.aborted) return;
        setLoaded({ key: identity, content: res.content, display: res.display });
        setStatus({ key: identity, phase: 'idle' });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setStatus({ key: identity, phase: 'failed' });
      });
  }, [sessionId, identity, result.callId]);

  // A Ctrl+F match may sit past the clipped preview; auto-load once when Find asks for the whole output.
  useEffect(() => {
    if (whole && partial && !full && phase === 'idle' && sessionId) load();
  }, [whole, partial, full, phase, sessionId, load]);

  const more =
    partial && !full && sessionId ? (
      <div className="term-note">
        <button type="button" className="link" onClick={load} disabled={phase === 'loading'}>
          {t(phase === 'failed' ? 'Could not load the rest' : d?.kind === 'diff' ? 'Show the whole change' : 'Show all output')}
        </button>
      </div>
    ) : null;

  return { content: full?.content ?? result.content, display: full?.display ?? d, more };
}
