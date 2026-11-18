import { BinarySize } from './DiffTool';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { useEverySecond } from '../../lib/clock';
import { fmtDuration } from '../../lib/format';
import { fill, useT } from '../../lib/i18n';
import { renderMarkdown } from '../../lib/markdown';
import { stepFailed, toolTitle } from '../../lib/steps';
import { actions, setUi, toast } from '../../lib/store';
import type { ChildStep, ChildView, Message, SessionView, ToolDisplay, ToolResultPart } from '../../lib/types';
import { ArrowSquareOut, Question, Stop, WarningCircle } from '../icons';
import { Pen } from '../Pen';
import { FILE_KINDS, ICONS, mcpParts, stepWhat, toolKind, VERB } from './icons';

const openSheet = (sessionId: string, title: string) => setUi({ sheet: { sessionId, title } });

/** Cache of extracted child steps for finished sub-agents reopened after a session reload. */
const cachedChildSteps = new Map<string, ChildStep[]>();

export function clearCachedChildSteps(): void {
  cachedChildSteps.clear();
}

function stepsFromMessages(messages: Message[]): ChildStep[] {
  const results = new Map<string, ToolResultPart>();
  for (const m of messages) {
    if (m.replay) continue;
    for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);
  }
  const steps: ChildStep[] = [];
  for (const m of messages) {
    if (m.replay || m.role !== 'assistant') continue;
    for (const p of m.parts) {
      if (p.type !== 'tool_call') continue;
      const r = results.get(p.id);
      const input = (p.input ?? {}) as Record<string, unknown>;
      steps.push({
        id: p.id,
        name: p.name,
        title: toolTitle(p.name, input),
        input,
        started: m.time,
        ended: m.time + (r?.durationMs ?? 0),
        failed: stepFailed(r),
      });
    }
  }
  return steps;
}

/** The end of a sub-agent's thinking as one line: the title it gave the thought, or its last words. */
function thoughtLine(text: string): string {
  const last = text.split(/\n\n(?=\*\*)/).pop() ?? text;
  const bold = /^\s*\*\*(.+?)\*\*/.exec(last)?.[1];
  const flat = (bold ?? last).replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  return !bold && flat.length > 110 ? `…${flat.slice(-110)}` : flat;
}

/** The sub-agent a task started, as its events show it; one with no events here counts as finished. */
export const childOf = (kids: ChildView[] | undefined, sessionId: string): ChildView =>
  kids?.find((c) => c.sessionId === sessionId) ?? { sessionId, steps: [], activity: 'done', since: 0, thought: '', tokens: 0 };

/** The way into a sub-agent's whole conversation, and while it works a way to stop it alone. */
export function ChildLinks({ c, title }: { c: ChildView; title: string }) {
  return (
    <span className="child-links">
      <OpenChild sessionId={c.sessionId} title={title} />
      {c.activity !== 'done' && <StopChild sessionId={c.sessionId} />}
    </span>
  );
}

function OpenChild({ sessionId, title }: { sessionId: string; title: string }) {
  const t = useT();
  return (
    <button type="button" className="link child-open" onClick={() => openSheet(sessionId, title)}>
      <ArrowSquareOut size={12} />
      {t('Open its whole conversation')}
    </button>
  );
}

/** Stops this sub-agent alone: the agent that started it is told and goes on. */
export function StopChild({ sessionId }: { sessionId: string }) {
  const t = useT();
  return (
    <button
      type="button"
      className="link child-open child-stop"
      data-tip={t('The agent that started it is told and goes on')}
      onClick={() => {
        const sent = actions.stopChild(sessionId);
        if (sent) sent.catch((e) => toast(String(e), 'error'));
      }}
    >
      <Stop size={12} />
      {t('Stop this one')}
    </button>
  );
}

/** One step of a sub-agent in the words of the main timeline: the verb, what it acts on, how long it took. */
export function ChildLine({ step }: { step: ChildStep }) {
  const t = useT();
  const kind = toolKind(step.name);
  const Icon = ICONS[kind];
  const label = kind === 'other' ? step.name : kind === 'mcp' ? mcpParts(step.name).server : t(VERB[kind]);
  const said = kind === 'shell' && typeof step.input?.description === 'string' ? step.input.description.trim() : '';
  const what = stepWhat(step.name, toolTitle(step.name, step.input ?? {}), step.input);
  return (
    <div className={`child-step ${step.ended ? '' : 'is-running'} ${step.failed ? 'is-error' : ''}`}>
      <span className="child-icon">
        {!step.ended ? <Pen mode="step" width={12} /> : step.failed ? <WarningCircle size={12} weight="fill" /> : <Icon size={12} />}
      </span>
      <span className="child-verb">{label}</span>
      <span className={`child-target ${(kind === 'shell' && !said) || FILE_KINDS.includes(kind) || kind === 'grep' ? 'mono' : ''}`}>{what}</span>
      <span className="child-time num">{fmtDuration((step.ended ?? Date.now()) - step.started)}</span>
    </div>
  );
}

export function ActivityLine({ c }: { c: ChildView }) {
  const t = useT();
  const doing =
    c.activity === 'thinking' ? 'Thinking now' : c.activity === 'writing' ? 'Writing its report' : c.activity === 'waiting' ? 'Waiting for you' : 'Starting';
  return (
    <div className="child-step is-running is-activity">
      <span className="child-icon">
        {c.activity === 'waiting' ? <Question size={12} weight="bold" /> : <Pen mode={c.activity === 'thinking' ? 'think' : 'write'} width={12} />}
      </span>
      <span className="child-verb">{t(doing)}</span>
      <span className="child-target is-thought">{c.activity === 'thinking' ? thoughtLine(c.thought) : ''}</span>
      <span className="child-time num">{fmtDuration(Date.now() - c.since)}</span>
    </div>
  );
}

/**
 * A sub-agent's steps, current activity, and sheet link.
 * When `collapsible` is set inside an already-expanded task card, steps start visible with a Fold toggle.
 */
export function ChildProgress({
  kids,
  last,
  title,
  folded = false,
  collapsible = false,
}: {
  kids: ChildView[];
  last?: number;
  title: string;
  folded?: boolean;
  collapsible?: boolean;
}) {
  const t = useT();
  const [all, setAll] = useState(!folded);
  const working = kids.some((c) => c.activity !== 'done');
  useEverySecond(working);
  const totalSteps = kids.reduce((k, c) => k + c.steps.length, 0);

  if (!all) {
    return (
      <div className="child-progress is-folded">
        {totalSteps > 0 && (
          <button type="button" className="link" onClick={() => setAll(true)}>
            {t('Show its steps')}
          </button>
        )}
        {kids.length === 1 && <ChildLinks c={kids[0]} title={title} />}
      </div>
    );
  }
  return (
    <div className="child-progress">
      {kids.map((c, k) => {
        const steps = last ? c.steps.slice(-last) : c.steps;
        const earlier = c.steps.length - steps.length;
        return (
          <div key={c.sessionId} className="child">
            {kids.length > 1 && (
              <div className="child-name">
                {fill(t('Attempt {n}'), k + 1)}
                <ChildLinks c={c} title={`${title} · ${fill(t('Attempt {n}'), k + 1)}`} />
              </div>
            )}
            {earlier > 0 && <div className="child-more num">{fill(t('{n} earlier steps'), earlier)}</div>}
            {steps.map((step) => (
              <ChildLine key={step.id} step={step} />
            ))}
            {c.activity !== 'done' && c.activity !== 'tool' && <ActivityLine c={c} />}
          </div>
        );
      })}
      <div className="child-progress is-folded">
        {collapsible && totalSteps > 0 && (
          <button type="button" className="link" onClick={() => setAll(false)}>
            {t('Fold')}
          </button>
        )}
        {kids.length === 1 && <ChildLinks c={kids[0]} title={title} />}
      </div>
    </div>
  );
}

export function TaskResultView({
  content,
  d,
  kids,
  title,
  more,
}: {
  content: string;
  d: Extract<ToolDisplay, { kind: 'task' }>;
  kids?: ChildView[];
  title: string;
  more: ReactNode;
}) {
  const t = useT();
  const childId = d.childSession;
  const hasLiveSteps = !!kids?.some((c) => c.steps.length > 0);
  const [loadedSteps, setLoadedSteps] = useState<ChildStep[] | null>(() => (childId ? cachedChildSteps.get(childId) ?? null : null));

  useEffect(() => {
    if (hasLiveSteps || !childId || !d.steps) return;
    const hit = cachedChildSteps.get(childId);
    if (hit) {
      setLoadedSteps(hit);
      return;
    }
    const controller = new AbortController();
    api<SessionView>(`/sessions/${childId}`, { signal: controller.signal })
      .then((v) => {
        if (controller.signal.aborted) return;
        const extracted = stepsFromMessages(v.messages ?? []);
        if (extracted.length > 0) {
          cachedChildSteps.set(childId, extracted);
          if (cachedChildSteps.size > 64) {
            const oldest = cachedChildSteps.keys().next().value;
            if (oldest !== undefined) cachedChildSteps.delete(oldest);
          }
        }
        setLoadedSteps(extracted);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [hasLiveSteps, childId, d.steps]);

  const effectiveKids: ChildView[] | undefined = hasLiveSteps
    ? kids
    : childId && loadedSteps?.length
      ? [{ ...childOf(kids, childId), steps: loadedSteps }]
      : undefined;

  const report = content.replace(/\n\n\[Recorded by \w+\][\s\S]*$/, '');
  return (
    <>
      {effectiveKids?.some((c) => c.steps.length) ? (
        <ChildProgress kids={effectiveKids} title={title} collapsible />
      ) : childId ? (
        <ChildLinks c={childOf(kids, childId)} title={title} />
      ) : null}
      {(d.files?.length || d.changed?.length || (d.changed && d.agent === 'general')) && (
        <dl className="task-facts plate">
          {d.files?.length ? (
            <div>
              <dt>{t('May change')}</dt>
              <dd className="mono">{d.files.join(', ')}</dd>
            </div>
          ) : null}
          {(d.changed?.length || d.agent === 'general') && d.changed && (
            <div>
              <dt>{t('Changed')}</dt>
              <dd>
                {d.changed.length
                  ? d.changed.map((c) => (
                      <span key={c.path} className="task-change">
                        <span className="mono">{c.path}</span> {c.binary ? <BinarySize bytes={c.binary} /> : <><span className="add num">+{c.added}</span> <span className="del num">−{c.removed}</span></>}
                      </span>
                    ))
                  : t('No files')}
              </dd>
            </div>
          )}
        </dl>
      )}
      <div className="md plate prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(report) }} />
      {more}
    </>
  );
}
