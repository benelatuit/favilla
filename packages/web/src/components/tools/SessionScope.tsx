import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { OwnerSession } from '../../lib/owner';
import { getState, useStore } from '../../lib/store';
import type { ToolResultPart } from '../../lib/types';

export interface SessionScopeValue {
  sessionId?: string;
  cwd: string;
  getResults: () => ReadonlyMap<string, ToolResultPart>;
}

const SessionScopeContext = createContext<SessionScopeValue | null>(null);

export function SessionScopeProvider({
  sessionId,
  cwd,
  results,
  children,
}: {
  sessionId?: string;
  cwd?: string;
  results?: ReadonlyMap<string, ToolResultPart>;
  children: ReactNode;
}) {
  const parentScope = useContext(SessionScopeContext);
  const fallbackCwd = useStore((s) => s.session?.meta.cwd ?? s.folder);
  const resolvedCwd = cwd ?? (parentScope && parentScope.sessionId === sessionId ? parentScope.cwd : fallbackCwd);
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const value = useMemo<SessionScopeValue>(
    () => ({
      sessionId,
      cwd: resolvedCwd,
      getResults: () => resultsRef.current ?? getState().results,
    }),
    [sessionId, resolvedCwd],
  );
  return (
    <OwnerSession.Provider value={sessionId}>
      <SessionScopeContext.Provider value={value}>{children}</SessionScopeContext.Provider>
    </OwnerSession.Provider>
  );
}

export function useSessionScope(): SessionScopeValue {
  const scoped = useContext(SessionScopeContext);
  const owner = useContext(OwnerSession);
  if (scoped) return scoped;
  const st = getState();
  return {
    sessionId: owner ?? st.session?.meta.id,
    cwd: st.session?.meta.cwd ?? st.folder,
    getResults: () => getState().results,
  };
}
