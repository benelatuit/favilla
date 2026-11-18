import { memo, useEffect, useState, type ReactNode } from 'react';
import { useEverySecond } from '../../lib/clock';
import { absolutePath } from '../../lib/desktop';
import { useFind } from '../../lib/find';
import { foldKey, useFoldOpen } from '../../lib/fold-state';
import { fmtDuration, fmtTokens } from '../../lib/format';
import { count, fill, useT } from '../../lib/i18n';
import { stepOutcome, stepOutcomeDetail } from '../../lib/steps';
import { actions, useStore } from '../../lib/store';
import type { ChildView, ToolDisplay, ToolResultPart } from '../../lib/types';
import { CaretRight, Circle, CircleNotch, Question, Stop, WarningCircle } from '../icons';
import { Stages, stagesOf } from '../Stages';
import { openViewer } from '../ui/Viewer';
import { AttemptsView, ChecksResultView } from './ChecksTool';
import { DiffView } from './DiffTool';
import { FileListView, FileReadView } from './FileReadTool';
import { GoalList, PlanView, QuestionView, TodoList } from './GoalTodoTool';
import { commandText, FILE_KINDS, ICONS, mcpParts, shortModel, toolKind, toolTarget, VERB, type Kind } from './icons';
import { MailView, mailWhat } from './MailTool';
import { browseInResults, pictures } from './MediaViewer';
import { MatchesView } from './SearchTool';
import { useSessionScope } from './SessionScope';
import { CommandTarget, LiveTail, ShellResultView, Terminal } from './ShellTool';
import { childOf, ChildLinks, ChildProgress, TaskResultView } from './TaskTool';
import { useFull } from './useFull';
import { LinksView, ShotView, VIA, WebFetchView } from './WebTool';

export interface RunningState {
  started: number;
  output: string;
  sub: string[];
  display?: ToolDisplay;
}

export interface ToolEntryProps {
  callId?: string;
  draftKey?: string;
  opaque?: boolean;
  name: string;
  title: string;
  /** The call's arguments: a command's description, a sub-agent's model. */
  input?: Record<string, unknown>;
  result?: ToolResultPart;
  running?: RunningState;
  /** Still being written by the model: the arguments streamed so far. */
  forming?: string;
}

function RunningBody({ kind, running, kids, title }: { kind: Kind; running: RunningState; kids?: ChildView[]; title: string }) {
  return (
    <>
      {kids?.length ? (
        <ChildProgress kids={kids} title={title} />
      ) : (
        running.sub.length > 0 && (
          <div className="step-sub">
            {running.sub.map((s, i) => (
              <div key={i}>{s}</div>
            ))}
          </div>
        )
      )}
      {kind === 'shell' || running.output ? <Terminal text={running.output} follow /> : null}
    </>
  );
}

function ResultBody({
  result,
  outcome,
  cwd,
  kids,
  title,
  whole,
}: {
  result: ToolResultPart;
  outcome: ReturnType<typeof stepOutcome>;
  cwd: string;
  kids?: ChildView[];
  title: string;
  whole?: boolean;
}) {
  const t = useT();
  const { content, display: d, more } = useFull(result, whole);

  if ((outcome === 'cancelled' || outcome === 'denied') && d?.kind !== 'terminal' && d?.kind !== 'checks' && d?.kind !== 'shot') {
    return (
      <>
        <div className={`plate plain ${outcome === 'denied' ? 'is-denied' : 'is-cancelled'}`}>{stepOutcomeDetail({ content }, t)}</div>
        {more}
      </>
    );
  }

  // Views that show their own failure (a terminal, the checks, a page) keep their shape when they fail.
  if (result.isError && d?.kind !== 'terminal' && d?.kind !== 'checks' && d?.kind !== 'shot') {
    return (
      <>
        <pre className="plate plain is-error">{content}</pre>
        {more}
      </>
    );
  }

  switch (d?.kind) {
    case 'terminal':
      return <ShellResultView d={d} cwd={cwd} more={more} />;
    case 'diff':
      return (
        <>
          <DiffView files={d.files} cwd={cwd} all={whole} />
          {more}
        </>
      );
    case 'file':
      return <FileReadView result={result} d={d} />;
    case 'search':
      return <MatchesView preview={d.preview || content} pattern={d.pattern} cwd={cwd} />;
    case 'list':
      return <FileListView d={d} />;
    case 'todo':
      return <TodoList todos={d.todos} />;
    case 'goal':
      return <GoalList goal={d.goal} />;
    case 'checks':
      return <ChecksResultView d={d} cwd={cwd} />;
    case 'attempts':
      return <AttemptsView d={d} />;
    case 'task':
      return <TaskResultView content={content} d={d} kids={kids} title={title} more={more} />;
    case 'question':
      return <QuestionView d={d} />;
    case 'plan':
      return <PlanView d={d} />;
    case 'mail':
      return <MailView d={d} cwd={cwd} />;
    case 'links':
      return <LinksView d={d} />;
    case 'shot':
      return <ShotView result={result} content={content} d={d} />;
    case 'web':
      return <WebFetchView content={content} d={d} />;
    default:
      return (
        <>
          <pre className="plate plain mono">{content}</pre>
          {more}
        </>
      );
  }
}

/** One step of the agent's work: a line on the process rail that opens into its output. */
export const ToolEntry = memo(function ToolEntry({ callId, draftKey, opaque, name, title, input, result, running, forming }: ToolEntryProps) {
  const t = useT();
  const { sessionId, cwd, getResults } = useSessionScope();
  const kind = toolKind(name);
  const isTask = kind === 'task';
  const kids = useStore((s) => (isTask && callId ? s.children.get(callId) : undefined));
  // Two flags in one subscription, as a number, so a long run of steps keeps one listener each for them: a sub-agent the
  // user stopped earlier, and a step an approval card holds. That step has not started: it waits for the answer, and
  // a clock would count the wait.
  const flags = useStore(
    (s) =>
      (isTask && !!callId && !!s.session?.meta.stopped?.includes(callId) ? 1 : 0) |
      (!!running && !!s.session?.pending.permissions.some((p) => p.tool === name && p.title === title) ? 2 : 0),
  );
  const stoppedBefore = (flags & 1) !== 0;
  const waiting = (flags & 2) !== 0;
  const live = useStore((s) => (callId && s.background.length ? s.background.find((b) => b.callId === callId && !!b.tool) : undefined));
  const task = useStore((s) => (callId && s.session?.meta.tasks?.length ? s.session.meta.tasks.find((x) => x.callId === callId) : undefined));

  const Icon = ICONS[kind];
  const stepKey = callId ? foldKey.step({ id: callId, draftKey }) : undefined;
  const aliasKey = callId && draftKey && draftKey !== callId ? foldKey.stepById(callId) : undefined;
  const [storeOpen, toggleStoreOpen, setStoreOpen] = useFoldOpen(sessionId, stepKey, false, aliasKey);
  const [localOpen, setLocalOpen] = useState(false);
  const open = stepKey ? storeOpen : localOpen;
  const toggleOpen = () => {
    if (stepKey) toggleStoreOpen();
    else setLocalOpen((o) => !o);
  };

  // Find opens the step whose output holds the match it brings into view (and reads the whole output for it).
  const asked = useFind((_, r) => (r?.open && callId && r.block === callId ? r.nonce : 0));
  useEffect(() => {
    if (!asked) return;
    if (stepKey) setStoreOpen(true);
    else setLocalOpen(true);
  }, [asked, stepKey, setStoreOpen]);

  useEverySecond(!!running && !waiting);

  const d = result?.display;
  const halted = !!task && !live && task.state !== 'done';
  const staged = live?.display ? stagesOf(live.display) : task?.display ? stagesOf(task.display) : result ? stagesOf(d) : stagesOf(undefined, running?.display);

  const outcome = stepOutcome({ id: callId, name, forming, running, result, opaque });
  const failed = outcome === 'failed';
  const cancelled = outcome === 'cancelled';
  const denied = outcome === 'denied';
  const pending = outcome === 'pending';

  let meta: ReactNode = null;
  const childSteps = kids?.reduce((n, c) => n + c.steps.length, 0) ?? 0;
  if (waiting) {
    meta = <span className="step-meta">{t('Waiting for you')}</span>;
  } else if (running && isTask) {
    const askedInput = (input ?? {}) as { model?: unknown; effort?: unknown };
    const model = kids?.[0]?.model ?? (typeof askedInput.model === 'string' ? askedInput.model : '');
    const effort = kids?.[0]?.effort ?? (typeof askedInput.effort === 'string' ? askedInput.effort : '');
    meta = (
      <span className="step-meta num">
        {[model ? shortModel(model) : '', effort, childSteps ? count(t, childSteps, '{n} step', '{n} steps') : '', fmtDuration(Date.now() - running.started)]
          .filter(Boolean)
          .join(' · ')}
      </span>
    );
  } else if (running) {
    meta = <span className="step-meta num">{fmtDuration(Date.now() - running.started)}</span>;
  } else if (task) {
    const state =
      live || task.state === 'running'
        ? 'in the background'
        : task.state === 'done'
          ? 'background, done'
          : task.state === 'stopped'
            ? 'background, stopped'
            : task.state === 'failed'
              ? 'background, failed'
              : 'background, cut off when Favilla closed';
    meta = <span className="step-meta num">{t(state)}</span>;
  } else if (d?.kind === 'diff') {
    const added = d.files.reduce((n, f) => n + f.added, 0);
    const removed = d.files.reduce((n, f) => n + f.removed, 0);
    meta = (
      <span className="step-meta num">
        <span className="add">+{added}</span> <span className="del">−{removed}</span>
      </span>
    );
  } else if (d?.kind === 'terminal') {
    meta = (
      <span className={`step-meta num ${failed ? 'del' : ''}`} data-tip={d.stoppedFor}>
        {d.stoppedFor
          ? `${t('Stopped: memory ran short')} · `
          : cancelled
            ? `${t('stopped by you')} · `
            : d.exitCode
              ? `exit ${d.exitCode} · `
              : ''}
        {d.exitCode === null && d.background ? t('started in the background') : fmtDuration(d.durationMs)}
      </span>
    );
  } else if (d?.kind === 'file') {
    meta = (
      <span className="step-meta num">
        {d.image ? t('image') : d.lineCount < d.totalLines ? `${d.startLine}–${d.startLine + d.lineCount - 1} / ${d.totalLines}` : fill(t('{n} lines'), d.totalLines)}
      </span>
    );
  } else if (d?.kind === 'search') {
    meta = <span className="step-meta num">{d.matches}</span>;
  } else if (d?.kind === 'list') {
    meta = <span className="step-meta num">{d.total}</span>;
  } else if (d?.kind === 'task' && d.background) {
    const going = !!kids?.some((c) => c.activity !== 'done');
    const state = going ? t('in the background') : stoppedBefore || kids?.some((c) => c.stopped) ? t('background, stopped') : t('background, done');
    meta = (
      <span className="step-meta num">
        {[state, d.model ? shortModel(d.model) : '', d.effort ?? '', childSteps ? count(t, childSteps, '{n} step', '{n} steps') : ''].filter(Boolean).join(' · ')}
      </span>
    );
  } else if (d?.kind === 'task') {
    meta = (
      <span className="step-meta num">
        {[d.stopped ? t('stopped by you') : '', d.model ? shortModel(d.model) : '', d.effort ?? '', count(t, d.steps, '{n} step', '{n} steps'), fmtTokens(d.tokens), d.durationMs ? fmtDuration(d.durationMs) : '']
          .filter(Boolean)
          .join(' · ')}
      </span>
    );
  } else if (d?.kind === 'web' && (d.via === 'api' || d.via === 'browser' || d.via === 'pdf')) {
    meta = <span className="step-meta num">{t(VIA[d.via])}</span>;
  } else if (d?.kind === 'attempts') {
    const kept = d.attempts.find((a) => a.chosen);
    meta = <span className={`step-meta num ${kept && !kept.failed ? 'add' : ''}`}>{kept ? fill(t('#{n} kept'), kept.n) : t('none kept')}</span>;
  } else if (d?.kind === 'todo') {
    meta = <span className="step-meta num">{d.todos.filter((x) => x.status === 'completed').length}/{d.todos.length}</span>;
  } else if (d?.kind === 'mail') {
    const note =
      d.action === 'search'
        ? fill(t('{n} found'), d.total ?? d.items?.length ?? 0)
        : d.action === 'read' && d.message?.files.length
          ? count(t, d.message.files.length, '{n} attachment', '{n} attachments')
          : d.action === 'send'
            ? t(d.declined ? 'not sent' : 'sent')
            : d.action === 'draft'
              ? t('in Drafts')
              : '';
    meta = note ? <span className={`step-meta num ${d.action === 'send' && !d.declined ? 'add' : ''}`}>{note}</span> : null;
  } else if (d?.kind === 'links') {
    const read = d.results.filter((r) => r.quote).length;
    meta = (
      <span className="step-meta num">
        {count(t, d.results.length, '{n} result', '{n} results')}
        {read ? ` · ${fill(t('{n} read'), read)}` : ''}
      </span>
    );
  } else if (d?.kind === 'shot') {
    meta = <span className="step-meta num">{d.width}×{d.height}</span>;
  } else if (d?.kind === 'goal' && d.goal.criteria.length) {
    meta = <span className="step-meta num">{d.goal.criteria.filter((c) => c.done).length}/{d.goal.criteria.length}</span>;
  } else if (d?.kind === 'checks' && d.results.length) {
    const bad = d.results.filter((r) => !r.ok).length;
    meta = <span className={`step-meta num ${bad ? 'del' : 'add'}`}>{bad ? fill(t('{n} failed'), bad) : fill(t('{n} passed'), d.results.length)}</span>;
  } else if (cancelled) {
    meta = <span className="step-meta num">{t('stopped by you')}</span>;
  } else if (denied) {
    meta = <span className="step-meta num">{t('Not run')}</span>;
  } else if (pending) {
    meta = <span className="step-meta num">{t('did not finish')}</span>;
  }

  const shots = pictures(result, d);
  const hasBody = !!result || !!(running && (running.output || running.sub.length));
  const label = name === 'brief' ? t('Brief') : kind === 'other' ? name : kind === 'mcp' ? mcpParts(name).server : t(VERB[kind]);
  const what = forming !== undefined ? forming.replace(/\s+/g, ' ').slice(-140) : kind === 'mail' ? mailWhat(title, input, d, t) : toolTarget(kind, title);
  const command = kind === 'shell' && forming === undefined ? commandText(input, title, d) : undefined;
  const said = kind === 'shell' && typeof input?.description === 'string' ? input.description.trim() : '';
  const filePath = FILE_KINDS.includes(kind) && what && !/\s{2}/.test(what) ? absolutePath(cwd, what) : undefined;
  const copyText = d?.kind === 'terminal' ? d.command : kind === 'shell' ? title : what;

  const stepIcon =
    waiting ? (
      <Question size={14} weight="bold" />
    ) : running || forming !== undefined ? (
      <CircleNotch size={14} className="spin" />
    ) : failed ? (
      <WarningCircle size={16} weight="fill" />
    ) : cancelled || denied ? (
      <Stop size={15} />
    ) : pending ? (
      <Circle size={14} />
    ) : (
      <Icon size={16} />
    );

  return (
    <div
      className={`step tool is-${kind} ${failed ? 'is-error' : ''} ${cancelled ? 'is-cancelled' : ''} ${denied ? 'is-denied' : ''} ${pending ? 'is-pending' : ''} ${waiting ? 'is-waiting' : running || forming !== undefined ? 'is-running' : ''} ${open ? 'is-open' : ''}`}
      data-ctx="tool"
      data-copy={copyText}
      data-copy-label={kind === 'shell' ? 'Copy command' : 'Copy'}
      {...(callId ? { 'data-find': callId } : {})}
    >
      <button type="button" className="step-head" onClick={() => hasBody && toggleOpen()} aria-expanded={hasBody ? open : undefined} disabled={!hasBody}>
        <span className="step-icon">{stepIcon}</span>
        <span className="step-verb" data-find-skip>
          {label}
        </span>
        {command !== undefined ? (
          <CommandTarget command={command} said={said} cwd={cwd} />
        ) : (
          <span className={`step-target ${kind === 'shell' || filePath || kind === 'grep' || kind === 'glob' ? 'mono' : ''}`} {...(filePath ? { 'data-ctx': 'file', 'data-path': filePath } : {})}>
            {what}
          </span>
        )}
        <span className="step-end" data-find-skip>
          {meta}
          {shots.length > 0 && (
            <span className="step-thumbs">
              {shots.slice(0, 3).map((s, i) => (
                <img
                  key={i}
                  src={s.src}
                  alt=""
                  loading="lazy"
                  onClick={(e) => {
                    e.stopPropagation();
                    openViewer(...browseInResults(shots[i], getResults()), e.currentTarget);
                  }}
                />
              ))}
              {shots.length > 3 && <span className="num">+{shots.length - 3}</span>}
            </span>
          )}
        </span>
        {hasBody && <CaretRight size={11} className="step-caret" />}
      </button>
      {staged && !open && <Stages display={staged} halted={halted} />}
      {task?.state === 'interrupted' && !live && !open && (
        <div className="stages-line">
          <button type="button" className="link" onClick={() => void actions.send(fill(t('Carry on with "{n}"'), task.description))}>
            {t('Carry on')}
          </button>
        </div>
      )}
      {running && !open && kids?.length ? (
        <ChildProgress kids={kids} last={3} title={what} />
      ) : (
        running &&
        !open &&
        running.sub.length > 0 && (
          <div className="step-sub">
            {running.sub.slice(-3).map((s, i) => (
              <div key={i}>{s}</div>
            ))}
          </div>
        )
      )}
      {running && !open && kind === 'shell' && running.output && <LiveTail text={running.output} />}
      {!running && !open && d?.kind === 'task' && d.childSession && (
        <div className="child-progress is-folded">
          <ChildLinks c={childOf(kids, d.childSession)} title={what} />
        </div>
      )}
      {open && (
        <div className="step-body">
          {running ? (
            <RunningBody kind={kind} running={running} kids={kids} title={what} />
          ) : (
            result && <ResultBody result={result} outcome={outcome} cwd={cwd} kids={kids} title={what} whole={asked > 0} />
          )}
        </div>
      )}
      {!open && denied && result && <div className="step-note is-denied">{stepOutcomeDetail(result, t)}</div>}
      {!open && failed && d?.kind !== 'terminal' && d?.kind !== 'checks' && result && <div className="step-error">{result.content.split('\n').slice(0, 2).join(' ')}</div>}
    </div>
  );
});
