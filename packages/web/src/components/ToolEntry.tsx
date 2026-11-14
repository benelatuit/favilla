import { memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CheckResult, DiffFile, Goal, Todo, ToolDisplay, ToolResultPart } from '../lib/types';
import { ansiToHtml, stripAnsi } from '../lib/ansi';
import { highlightCode, renderMarkdown } from '../lib/markdown';
import { fmtDuration, fmtTokens } from '../lib/format';
import { absolutePath } from '../lib/desktop';
import { actions, getState, setUi, toast, useStore } from '../lib/store';
import { markRanges, parseMatches, stepFailed, toolTitle, viewCommand } from '../lib/steps';
import type { ChildStep, ChildView } from '../lib/types';
import { api } from '../lib/api';
import { useFollow } from '../lib/follow';
import { OwnerSession } from '../lib/owner';
import { count, fill, useT } from '../lib/i18n';
import { useEverySecond } from '../lib/clock';
import { diffOp } from '../lib/format';
import { useFind } from '../lib/find';
import type { ViewerImage } from '../lib/store';
import { openViewer } from './ui/Viewer';
import { Stages, stagesOf } from './Stages';
import {
  ArrowSquareOut,
  Plug,
  Binoculars,
  SealCheck,
  Circle,
  NotePencil,
  Camera,
  CaretRight,
  CircleNotch,
  Compass,
  FilePlus,
  FileText,
  Files,
  Globe,
  ListChecks,
  MagnifyingGlass,
  PencilSimpleLine,
  Pulse,
  Question,
  TerminalWindow,
  TreeStructure,
  WarningCircle,
  CheckCircle,
  EnvelopeSimple,
  PaintBrush,
  Paperclip,
  Stop,
} from './icons';
import { MailSheet, splitPreview } from './MailSheet';

export type Kind = 'read' | 'write' | 'edit' | 'patch' | 'shell' | 'job' | 'grep' | 'glob' | 'todo' | 'task' | 'web' | 'websearch' | 'shot' | 'ask' | 'plan' | 'mcp' | 'goal' | 'check' | 'note' | 'mail' | 'draw' | 'other';

/** Tool names of every profile, mapped to what they do. */
const KINDS: Record<string, Kind> = {
  Read: 'read',
  read_file: 'read',
  view_image: 'read',
  Write: 'write',
  Edit: 'edit',
  apply_patch: 'patch',
  Bash: 'shell',
  shell_command: 'shell',
  BashOutput: 'job',
  KillShell: 'job',
  background_job: 'job',
  Grep: 'grep',
  Glob: 'glob',
  TodoWrite: 'todo',
  update_plan: 'todo',
  Task: 'task',
  run_subagent: 'task',
  WebFetch: 'web',
  web_fetch: 'web',
  WebSearch: 'websearch',
  web_search: 'websearch',
  Screenshot: 'shot',
  screenshot: 'shot',
  AskUserQuestion: 'ask',
  request_user_input: 'ask',
  ExitPlanMode: 'plan',
  exit_plan_mode: 'plan',
  // Favilla's own surface.
  read: 'read',
  write: 'write',
  edit: 'edit',
  notebook_edit: 'edit',
  NotebookEdit: 'edit',
  shell: 'shell',
  job: 'job',
  search: 'grep',
  plan: 'todo',
  agent: 'task',
  ask: 'ask',
  present_plan: 'plan',
  criteria: 'goal',
  goal: 'goal',
  check: 'check',
  review: 'task',
  brief: 'task',
  remember: 'note',
  browser: 'shot',
  mail: 'mail',
  paint: 'draw',
};

export const ICONS: Record<Kind, (p: { size: number }) => ReactNode> = {
  read: FileText,
  write: FilePlus,
  edit: PencilSimpleLine,
  patch: PencilSimpleLine,
  shell: TerminalWindow,
  job: Pulse,
  grep: MagnifyingGlass,
  glob: Files,
  todo: ListChecks,
  task: TreeStructure,
  web: Globe,
  websearch: Binoculars,
  shot: Camera,
  mcp: Plug,
  ask: Question,
  plan: Compass,
  goal: ListChecks,
  check: SealCheck,
  note: NotePencil,
  mail: EnvelopeSimple,
  draw: PaintBrush,
  other: FileText,
};

export const VERB: Record<Kind, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  patch: 'Edit',
  shell: 'Run',
  job: 'Job',
  grep: 'Search',
  glob: 'Find',
  todo: 'Plan',
  task: 'Agent',
  web: 'Fetch',
  websearch: 'Search the web',
  shot: 'Screenshot',
  mcp: 'Tool',
  ask: 'Ask',
  plan: 'Plan',
  goal: 'Done when',
  check: 'Check',
  note: 'Note',
  mail: 'Mail',
  draw: 'Paint',
  other: 'Tool',
};

export function toolKind(name: string): Kind {
  if (name.startsWith('mcp__')) return 'mcp';
  return KINDS[name] ?? 'other';
}

/** "mcp__server__tool" as its server and tool. */
function mcpParts(name: string): { server: string; tool: string } {
  const [, server = '', ...rest] = name.split('__');
  return { server, tool: rest.join('__') };
}

/** What the call acts on: a path, a command, a pattern, a URL. */
function toolTarget(kind: Kind, title: string): string {
  const words = title.split(' ');
  if (['read', 'write', 'edit', 'web', 'patch', 'draw'].includes(kind) && words.length > 1 && /^[A-Z_a-z]+$/.test(words[0])) return words.slice(1).join(' ');
  if (kind === 'task' && title.startsWith('Agent: ')) return title.slice(7);
  if (kind === 'websearch') return title.replace(/^Search the web for /, '');
  if (kind === 'shot') return title.replace(/^Screenshot /, '');
  // The engine's title for a question or criteria still at work names the tool again, in English, after the verb.
  if (kind === 'ask') return title.replace(/^Ask:\s*/, '');
  if (kind === 'goal') return title.replace(/^Criteria:\s*/, '');
  if (kind === 'mcp') return title.replace(/^[^·]*·\s*/, '');
  return title;
}

const FILE_KINDS: Kind[] = ['read', 'write', 'edit'];

interface RunningState {
  started: number;
  output: string;
  sub: string[];
  display?: ToolDisplay;
}

interface Props {
  callId?: string;
  name: string;
  title: string;
  /** The call's arguments: a command's description, a sub-agent's model. */
  input?: Record<string, unknown>;
  result?: ToolResultPart;
  running?: RunningState;
  /** Still being written by the model: the arguments streamed so far. */
  forming?: string;
}

/** The command of a shell call, from its arguments, its result or its title. */
function commandText(input: Record<string, unknown> | undefined, title: string, d?: ToolDisplay): string {
  const c = input?.command;
  if (typeof c === 'string' && c) return c;
  if (Array.isArray(c)) return c.length >= 3 && /^(bash|sh|zsh)$/.test(String(c[0])) && c[1] === '-lc' ? String(c[2]) : c.map(String).join(' ');
  return d?.kind === 'terminal' ? d.command : title;
}

/** "openai/gpt-6-luna" as "gpt-6-luna". */
const shortModel = (ref: string) => ref.split('/').pop() ?? ref;

const openSheet = (sessionId: string, title: string) => setUi({ sheet: { sessionId, title } });

/** One step of the agent's work: a line on the process rail that opens into its output. */
export function ToolEntry({ callId, name, title, input, result, running, forming }: Props) {
  const t = useT();
  const cwd = useStore((s) => s.session?.meta.cwd ?? s.folder);
  const kids = useStore((s) => (callId ? s.children.get(callId) : undefined));
  // A background sub-agent the user stopped, as the session keeps it for a page opened after the stop.
  const stoppedBefore = useStore((s) => !!callId && !!s.session?.meta.stopped?.includes(callId));
  const kind = toolKind(name);
  const Icon = ICONS[kind];
  const [open, setOpen] = useState(false);
  // Find opens the step whose output holds the match it brings into view (and reads the whole output for it).
  const asked = useFind((_, r) => (r?.open && callId && r.block === callId ? r.nonce : 0));
  useEffect(() => {
    if (asked) setOpen(true);
  }, [asked]);
  useEverySecond(!!running);

  const d = result?.display;
  // A tool's own work in the background: its card as it stands while it goes on, then as the session kept it.
  const live = useStore((s) => (callId ? s.background.find((b) => b.callId === callId && !!b.tool) : undefined));
  const task = useStore((s) => (callId ? s.session?.meta.tasks?.find((x) => x.callId === callId) : undefined));
  const halted = !!task && !live && task.state !== 'done';
  // Long work shows its stages under the title, from the card it sends while running and then its result's.
  const staged = live?.display ? stagesOf(live.display) : task?.display ? stagesOf(task.display) : result ? stagesOf(d) : stagesOf(undefined, running?.display);
  const failed = stepFailed(result);
  let meta: ReactNode = null;
  const childSteps = kids?.reduce((n, c) => n + c.steps.length, 0) ?? 0;
  if (running && kind === 'task') {
    // What a sub-agent runs on, shown while it works as it is once done: asked for in the call, or as it reports.
    const asked = (input ?? {}) as { model?: unknown; effort?: unknown };
    const model = kids?.[0]?.model ?? (typeof asked.model === 'string' ? asked.model : '');
    const effort = kids?.[0]?.effort ?? (typeof asked.effort === 'string' ? asked.effort : '');
    meta = (
      <span className="step-meta num">
        {[model ? shortModel(model) : '', effort, childSteps ? count(t, childSteps, '{n} step', '{n} steps') : '', fmtDuration(Date.now() - running.started)].filter(Boolean).join(' · ')}
      </span>
    );
  } else if (running) meta = <span className="step-meta num">{fmtDuration(Date.now() - running.started)}</span>;
  else if (task) {
    const state = live || task.state === 'running' ? 'in the background' : task.state === 'done' ? 'background, done' : task.state === 'stopped' ? 'background, stopped' : task.state === 'failed' ? 'background, failed' : 'background, cut off when Favilla closed';
    meta = <span className="step-meta num">{t(state)}</span>;
  } else if (d?.kind === 'diff') {
    const added = d.files.reduce((n, f) => n + f.added, 0);
    const removed = d.files.reduce((n, f) => n + f.removed, 0);
    meta = (
      <span className="step-meta num">
        <span className="add">+{added}</span> <span className="del">−{removed}</span>
      </span>
    );
  } else if (d?.kind === 'terminal')
    meta = (
      <span className={`step-meta num ${failed ? 'del' : ''}`} data-tip={d.stoppedFor}>
        {/* A command started in the background says so, not its job's id: "job_1" ran into the time as "job_12s". */}
        {d.stoppedFor ? `${t('Stopped: memory ran short')} · ` : d.exitCode ? `exit ${d.exitCode} · ` : ''}
        {d.exitCode === null && d.background ? t('started in the background') : fmtDuration(d.durationMs)}
      </span>
    );
  else if (d?.kind === 'file') meta = <span className="step-meta num">{d.image ? t('image') : d.lineCount < d.totalLines ? `${d.startLine}–${d.startLine + d.lineCount - 1} / ${d.totalLines}` : fill(t('{n} lines'), d.totalLines)}</span>;
  else if (d?.kind === 'search') meta = <span className="step-meta num">{d.matches}</span>;
  else if (d?.kind === 'list') meta = <span className="step-meta num">{d.total}</span>;
  else if (d?.kind === 'task' && d.background) {
    // Its call returned at once; the sub-agent's own events say how far it is.
    const going = !!kids?.some((c) => c.activity !== 'done');
    const state = going ? t('in the background') : stoppedBefore || kids?.some((c) => c.stopped) ? t('background, stopped') : t('background, done');
    meta = (
      <span className="step-meta num">
        {[state, d.model ? shortModel(d.model) : '', d.effort ?? '', childSteps ? count(t, childSteps, '{n} step', '{n} steps') : ''].filter(Boolean).join(' · ')}
      </span>
    );
  } else if (d?.kind === 'task')
    meta = (
      <span className="step-meta num">
        {[d.stopped ? t('stopped by you') : '', d.model ? shortModel(d.model) : '', d.effort ?? '', count(t, d.steps, '{n} step', '{n} steps'), fmtTokens(d.tokens), d.durationMs ? fmtDuration(d.durationMs) : ''].filter(Boolean).join(' · ')}
      </span>
    );
  else if (d?.kind === 'web' && (d.via === 'api' || d.via === 'browser' || d.via === 'pdf')) meta = <span className="step-meta num">{t(VIA[d.via])}</span>;
  else if (d?.kind === 'attempts') {
    const kept = d.attempts.find((a) => a.chosen);
    meta = <span className={`step-meta num ${kept && !kept.failed ? 'add' : ''}`}>{kept ? fill(t('#{n} kept'), kept.n) : t('none kept')}</span>;
  }
  else if (d?.kind === 'todo') meta = <span className="step-meta num">{d.todos.filter((x) => x.status === 'completed').length}/{d.todos.length}</span>;
  else if (d?.kind === 'mail') {
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
    meta = <span className="step-meta num">{count(t, d.results.length, '{n} result', '{n} results')}{read ? ` · ${fill(t('{n} read'), read)}` : ''}</span>;
  }
  else if (d?.kind === 'shot') meta = <span className="step-meta num">{d.width}×{d.height}</span>;
  else if (d?.kind === 'goal' && d.goal.criteria.length) meta = <span className="step-meta num">{d.goal.criteria.filter((c) => c.done).length}/{d.goal.criteria.length}</span>;
  else if (d?.kind === 'checks' && d.results.length) {
    const bad = d.results.filter((r) => !r.ok).length;
    meta = <span className={`step-meta num ${bad ? 'del' : 'add'}`}>{bad ? fill(t('{n} failed'), bad) : fill(t('{n} passed'), d.results.length)}</span>;
  }

  const shots = pictures(result, d);
  const hasBody = !!result || !!(running && (running.output || running.sub.length));
  const label = name === 'brief' ? t('Brief') : kind === 'other' ? name : kind === 'mcp' ? mcpParts(name).server : t(VERB[kind]);
  const what = forming !== undefined ? forming.replace(/\s+/g, ' ').slice(-140) : kind === 'mail' ? mailWhat(title, input, d, t) : toolTarget(kind, title);
  const command = kind === 'shell' && forming === undefined ? commandText(input, title, d) : undefined;
  const said = kind === 'shell' && typeof input?.description === 'string' ? input.description.trim() : '';
  const filePath = FILE_KINDS.includes(kind) && what && !/\s{2}/.test(what) ? absolutePath(cwd, what) : undefined;
  const copyText = d?.kind === 'terminal' ? d.command : kind === 'shell' ? title : what;

  return (
    <div
      className={`step tool is-${kind} ${failed ? 'is-error' : ''} ${running || forming !== undefined ? 'is-running' : ''} ${open ? 'is-open' : ''}`}
      data-ctx="tool"
      data-copy={copyText}
      data-copy-label={kind === 'shell' ? 'Copy command' : 'Copy'}
      {...(callId ? { 'data-find': callId } : {})}
    >
      <button type="button" className="step-head" onClick={() => hasBody && setOpen((o) => !o)} aria-expanded={hasBody ? open : undefined} disabled={!hasBody}>
        <span className="step-icon">{running || forming !== undefined ? <CircleNotch size={14} className="spin" /> : failed ? <WarningCircle size={16} weight="fill" /> : <Icon size={16} />}</span>
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
        {(meta || shots.length > 0) && (
          // The fourth column of the step line holds what it says about the result and the pictures it looked at.
          <span className="step-end" data-find-skip>
            {meta}
          {shots.length > 0 && (
            // The pictures this step looked at, at a glance; a press opens them full size.
            <span className="step-thumbs">
              {shots.slice(0, 3).map((s, i) => (
                <img
                  key={i}
                  src={s.src}
                  alt=""
                  loading="lazy"
                  onClick={(e) => {
                    e.stopPropagation();
                    openViewer(...browse(shots[i]), e.currentTarget);
                  }}
                />
              ))}
              {shots.length > 3 && <span className="num">+{shots.length - 3}</span>}
            </span>
          )}
          </span>
        )}
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
      {/* A finished sub-agent keeps the way into its work on the folded row: that is what people come back for.
          One still at work in the background can be stopped from there too. */}
      {!running && !open && d?.kind === 'task' && d.childSession && (
        <div className="child-progress is-folded">
          <ChildLinks c={childOf(kids, d.childSession)} title={what} />
        </div>
      )}
      {open && <div className="step-body">{running ? <RunningBody kind={kind} running={running} kids={kids} title={what} /> : result && <ResultBody result={result} cwd={cwd} said={said} kids={kids} title={what} whole={asked > 0} />}</div>}
      {!open && failed && d?.kind !== 'terminal' && d?.kind !== 'checks' && result && <div className="step-error">{result.content.split('\n').slice(0, 2).join(' ')}</div>}
    </div>
  );
}

/** A mail step's line: the query searched, the subject read, or whom an email is for. */
function mailWhat(title: string, input: Record<string, unknown> | undefined, d: ToolDisplay | undefined, t: (k: string) => string): string {
  const m = d?.kind === 'mail' ? d : undefined;
  const action = String(m?.action ?? input?.action ?? '');
  if (action === 'search') return [m?.query ?? input?.query ? `"${m?.query ?? input?.query}"` : t('the latest messages'), m?.folder ?? (input?.folder as string | undefined)].filter(Boolean).join(' · ');
  if (action === 'read') return m?.message?.subject ?? String(input?.id ?? '');
  if (action === 'send' || action === 'draft') {
    const to = m?.to?.join(', ') ?? (Array.isArray(input?.to) ? (input!.to as string[]).join(', ') : '');
    const subject = String(input?.subject ?? '') || (input?.reply_to ?? input?.replyTo ? t('reply') : '');
    return [subject, to && `→ ${to}`].filter(Boolean).join('  ');
  }
  if (action === 'mark') return m?.note ?? t('messages');
  return m?.accounts?.join(', ') ?? title.replace(/^Mail accounts$/, t('accounts'));
}

const shortDate = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toTimeString().slice(0, 5) : d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : iso.slice(0, 10);
};

const sender = (from?: string) => (from ?? '').replace(/\s*<[^>]+>$/, '').replace(/^"|"$/g, '') || from || '';

/** Mail results: messages as rows (unread ones marked), one message as a sheet, a written email as it went. */
function MailView({ d, cwd }: { d: Extract<ToolDisplay, { kind: 'mail' }>; cwd: string }) {
  const t = useT();
  if (d.action === 'search')
    return (
      <div className="plate mail-list">
        <div className="mail-about">{[d.account, d.folder].filter(Boolean).join(' · ')}</div>
        {(d.items ?? []).map((m) => (
          <div key={m.id} className={`mail-row ${m.unread ? 'is-unread' : ''}`}>
            <span className="mail-dot" aria-hidden />
            <span className="mail-from">{sender(m.from)}</span>
            <span className="mail-subject">
              {m.subject}
              {m.snippet && <span className="mail-snippet"> — {m.snippet}</span>}
            </span>
            <span className="mail-date num">
              {m.attachments > 0 && <Paperclip size={12} />}
              {shortDate(m.date)}
            </span>
          </div>
        ))}
      </div>
    );
  if (d.action === 'read' && d.message) {
    const m = d.message;
    const head: [string, string][] = [['From', m.from ?? ''], ['To', m.to ?? ''], ...(m.cc ? ([['Cc', m.cc]] as [string, string][]) : []), ['Date', m.date ? new Date(m.date).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''], ['Subject', m.subject]];
    return (
      <>
        <MailSheet head={head} body={m.body} markdown={m.html} />
        {m.files.length > 0 && (
          <ul className="mail-files">
            {m.files.map((f) => (
              <li key={f.name} {...(f.saved ? { 'data-ctx': 'file', 'data-path': absolutePath(cwd, f.saved) } : {})}>
                <Paperclip size={12} />
                <span className="mono">{f.name}</span>
                <span className="num">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                {f.saved && <span className="mail-saved mono">{f.saved}</span>}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  if ((d.action === 'send' || d.action === 'draft') && d.preview) {
    const { head, body } = splitPreview(d.preview);
    return (
      <>
        <div className={`step-note ${d.declined ? 'del' : d.action === 'send' ? 'add' : ''}`}>{d.declined ? t('Not sent: you turned it down.') : d.action === 'draft' ? t('Saved in Drafts.') : fill(t('Sent to {n}.'), (d.to ?? []).join(', '))}</div>
        <MailSheet head={head} body={body} />
      </>
    );
  }
  return <div className="step-note">{d.note ?? d.accounts?.join(', ') ?? d.account}</div>;
}

const VIA: Record<string, string> = { api: 'site API', browser: 'read in the browser', pdf: 'PDF', text: 'text', page: '' };

/** What the session's tests did on the code before its changes, as the checks view says it. */
const VERDICT: Record<'catches' | 'pass-before' | 'no-build', string> = {
  catches: 'The tests in {n} fail on the code before the change and pass now: they catch the fix.',
  'pass-before': 'The tests in {n} pass on the code before the change too: they do not catch the fix.',
  'no-build': 'The tests in {n} do not build on the code before the change: they use what it adds.',
};

/** A command as its step line: what it does in words when the model said, then the command itself, quieter. */
function CommandTarget({ command, said, cwd }: { command: string; said?: string; cwd: string }) {
  const t = useT();
  const v = viewCommand(command, cwd);
  return (
    <span className="step-target step-cmd">
      {said && <span className="cmd-said">{said}</span>}
      <span className={`cmd-text mono ${said ? 'is-quiet' : ''}`}>
        {v.dir && <span className="cmd-dir">{v.dir} › </span>}
        {v.script ? (
          <span className="cmd-script">
            {v.script.writes ? fill(t('writes {n}'), v.script.writes) : fill(t('{n} script'), v.script.tool || 'shell')} · {fill(t('{n} lines'), v.script.lines)}
          </span>
        ) : (
          <>
            {v.head}
            {v.lines > 1 && <span className="cmd-more num"> +{v.lines - 1}</span>}
          </>
        )}
      </span>
    </span>
  );
}

/** A command in full: where it runs, the command in shell colours, and a script it feeds in its own language. */
function CommandBlock({ command, said, cwd }: { command: string; said?: string; cwd: string }) {
  const v = viewCommand(command, cwd);
  const sh = (text: string) => highlightCode(text, 'command.sh');
  return (
    <div className="term-cmd mono">
      {(said || v.dir) && (
        <div className="term-about">
          {said && <span className="term-said">{said}</span>}
          {v.dir && <span className="term-dir">{v.dir}</span>}
        </div>
      )}
      <div className="term-line">
        <span className="term-prompt">$</span>
        <code dangerouslySetInnerHTML={{ __html: sh(v.script ? v.script.before : v.rest) }} />
      </div>
      {v.script && (
        <>
          <pre className="term-script">
            <code dangerouslySetInnerHTML={{ __html: highlightCode(v.script.body, v.script.as) }} />
          </pre>
          <div className="term-line">
            <code dangerouslySetInnerHTML={{ __html: sh(v.script.after) }} />
          </div>
        </>
      )}
    </div>
  );
}

/** Search results as files, each with its numbered lines and the matched text marked. */
function MatchesView({ preview, pattern, cwd }: { preview: string; pattern: string; cwd: string }) {
  const files = parseMatches(preview);
  if (!files.length) return <pre className="plate plain mono">{preview}</pre>;
  return (
    <div className="plate matches">
      {files.map((file) => (
        <div key={file.path} className="match-file">
          <div className="match-path mono" data-ctx="file" data-path={absolutePath(cwd, file.path)}>
            {file.path}
          </div>
          {file.lines.map((l, i) =>
            l.n === undefined ? (
              <div key={i} className="match-line is-count num">
                {l.text}
              </div>
            ) : (
              <div key={i} className={`match-line ${l.context ? 'is-context' : ''}`}>
                <span className="ln-n num">{l.n}</span>
                <code>{l.context ? l.text : <Marked text={l.text} pattern={pattern} />}</code>
              </div>
            ),
          )}
        </div>
      ))}
    </div>
  );
}

function Marked({ text, pattern }: { text: string; pattern: string }) {
  const ranges = markRanges(text, pattern);
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** Rendered text shown a few lines deep; a press opens the rest. */
function Clamp({ html, className }: { html: string; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 4);
  }, [html]);
  return (
    <div className={`clamp ${open ? 'is-open' : ''}`}>
      <div ref={ref} className={`clamp-body ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />
      {(long || open) && (
        <button type="button" className="link clamp-toggle" onClick={() => setOpen((o) => !o)}>
          {t(open ? 'Show less' : 'Show more')}
        </button>
      )}
    </div>
  );
}

/** The end of a sub-agent's thinking as one line: the title it gave the thought, or its last words. */
function thoughtLine(text: string): string {
  const last = text.split(/\n\n(?=\*\*)/).pop() ?? text;
  const bold = /^\s*\*\*(.+?)\*\*/.exec(last)?.[1];
  const flat = (bold ?? last).replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  return !bold && flat.length > 110 ? `…${flat.slice(-110)}` : flat;
}

/**
 * A sub-agent's work in the step's own language: its steps (the latest ones while it is folded), what it is
 * doing right now with a running clock, and a way into its whole conversation.
 */
function ChildProgress({ kids, last, title, folded }: { kids: ChildView[]; last?: number; title: string; folded?: boolean }) {
  const t = useT();
  const [all, setAll] = useState(!folded);
  const working = kids.some((c) => c.activity !== 'done');
  useEverySecond(working);
  if (!all) {
    const n = kids.reduce((k, c) => k + c.steps.length, 0);
    // Its model requests are counted on the step line; here it is only opened.
    return (
      <div className="child-progress is-folded">
        {n > 0 && (
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
      {kids.length === 1 && <ChildLinks c={kids[0]} title={title} />}
    </div>
  );
}

/** The sub-agent a task started, as its events show it; one with no events here counts as finished. */
const childOf = (kids: ChildView[] | undefined, sessionId: string): ChildView => kids?.find((c) => c.sessionId === sessionId) ?? { sessionId, steps: [], activity: 'done', since: 0, thought: '', tokens: 0 };

/** The way into a sub-agent's whole conversation, and while it works a way to stop it alone. */
function ChildLinks({ c, title }: { c: ChildView; title: string }) {
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

/** What a step acts on, in a few words: a command by what it was said to do (or its head), else a path, a pattern, a URL. */
export function stepWhat(name: string, title: string, input?: Record<string, unknown>): string {
  const kind = toolKind(name);
  const said = kind === 'shell' && typeof input?.description === 'string' ? input.description.trim() : '';
  return kind === 'shell' ? said || viewCommand(commandText(input, title)).head : toolTarget(kind, title);
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
      <span className="child-icon">{!step.ended ? <CircleNotch size={12} className="spin" /> : step.failed ? <WarningCircle size={12} weight="fill" /> : <Icon size={12} />}</span>
      <span className="child-verb">{label}</span>
      <span className={`child-target ${(kind === 'shell' && !said) || FILE_KINDS.includes(kind) || kind === 'grep' ? 'mono' : ''}`}>{what}</span>
      <span className="child-time num">{fmtDuration((step.ended ?? Date.now()) - step.started)}</span>
    </div>
  );
}

export function ActivityLine({ c }: { c: ChildView }) {
  const t = useT();
  const doing = c.activity === 'thinking' ? 'Thinking now' : c.activity === 'writing' ? 'Writing its report' : c.activity === 'waiting' ? 'Waiting for you' : 'Starting';
  return (
    <div className="child-step is-running is-activity">
      <span className="child-icon">
        <CircleNotch size={12} className="spin" />
      </span>
      <span className="child-verb">{t(doing)}</span>
      <span className="child-target is-thought">{c.activity === 'thinking' ? thoughtLine(c.thought) : ''}</span>
      <span className="child-time num">{fmtDuration(Date.now() - c.since)}</span>
    </div>
  );
}

function LiveTail({ text }: { text: string }) {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-3);
  return <pre className="step-tail">{lines.join('\n')}</pre>;
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

function Terminal({ text, follow }: { text: string; follow?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useFollow(() => ref.current, { enabled: !!follow });
  return <pre ref={ref} className="plate terminal" dangerouslySetInnerHTML={{ __html: ansiToHtml(text || ' ') }} />;
}

export function DiffView({ files, compact, cwd, bare }: { files: DiffFile[]; compact?: boolean; cwd?: string; bare?: boolean }) {
  return (
    <div className="diff">
      {files.map((f) => (
        <div key={f.path + (f.movedTo ?? '')} className="diff-file plate">
          {!bare && (
          <div className="diff-name" {...(cwd ? { 'data-ctx': 'file', 'data-path': absolutePath(cwd, f.movedTo ?? f.path) } : {})}>
            <span className={`diff-op is-${f.op}`}>{diffOp(f.op)}</span>
            <span className="mono diff-path">{f.movedTo ? `${f.path} → ${f.movedTo}` : f.path}</span>
            <span className="step-meta num">
              <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
            </span>
          </div>
          )}
          <DiffLines patch={f.patch} path={f.movedTo ?? f.path} compact={compact} />
        </div>
      ))}
    </div>
  );
}

const DiffLines = memo(function DiffLines({ patch, path, compact }: { patch: string; path: string; compact?: boolean }) {
  const rows: { cls: string; old?: number; neu?: number; html: string }[] = [];
  let o = 0;
  let n = 0;
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      if (rows.length) rows.push({ cls: 'hunk', html: '' });
      continue;
    }
    if (line.startsWith('@@') || line.startsWith('\\')) continue;
    const body = highlightCode(line.slice(1), path);
    if (line.startsWith('+')) rows.push({ cls: 'ins', neu: n++, html: body });
    else if (line.startsWith('-')) rows.push({ cls: 'rem', old: o++, html: body });
    else rows.push({ cls: 'ctx', old: o++, neu: n++, html: body });
  }
  const shown = compact ? rows.slice(0, 80) : rows;
  return (
    <div className="lines">
      {shown.map((r, i) =>
        r.cls === 'hunk' ? (
          <div key={i} className="ln hunk" aria-hidden>
            ⋯
          </div>
        ) : (
          <div key={i} className={`ln ${r.cls}`}>
            <span className="ln-n">{r.old ?? ''}</span>
            <span className="ln-n">{r.neu ?? ''}</span>
            <span className="ln-m">{r.cls === 'ins' ? '+' : r.cls === 'rem' ? '−' : ''}</span>
            <code dangerouslySetInnerHTML={{ __html: r.html || ' ' }} />
          </div>
        ),
      )}
      {compact && rows.length > shown.length && <div className="ln hunk">+{rows.length - shown.length}</div>}
    </div>
  );
});

/**
 * A goal's criteria: met ones ticked in green ink, with how they were shown to be met. The one being worked on
 * turns only while the agent is at work (`live`); between turns, and in a tool result's copy, it stands still.
 */
export function GoalList({ goal, live = false }: { goal: Goal; live?: boolean }) {
  return (
    <ol className="goal-criteria">
      {goal.criteria.map((c, i) => (
        <li key={i} className={c.done ? 'is-done' : goal.active === i + 1 ? 'is-active' : ''} aria-current={!c.done && goal.active === i + 1 ? 'step' : undefined}>
          {c.done ? <CheckCircle size={14} weight={c.proved ? 'fill' : 'regular'} /> : goal.active === i + 1 ? live ? <CircleNotch size={14} className="spin" /> : <Circle size={14} weight="duotone" /> : <Circle size={14} />}
          <span className="goal-text">{c.text}</span>
          {c.evidence && <span className="goal-evidence mono">{c.evidence}</span>}
        </li>
      ))}
    </ol>
  );
}

const CHECK_LABEL: Record<string, string> = { types: 'Types', lint: 'Lint', test: 'Tests', build: 'Build' };

/** The project's checks: each with its command and time, and for a failure the lines that say why. */
function ChecksView({ results, found, cwd }: { results: CheckResult[]; found: string[]; cwd: string }) {
  const t = useT();
  if (!results.length) return <div className="step-note">{found.length ? `${t('This project has')}: ${found.map((n) => t(CHECK_LABEL[n] ?? n)).join(', ')}` : t('No checks found in this project.')}</div>;
  return (
    <div className="plate checks">
      {results.map((r) => (
        <div key={r.name} className={`check-row ${r.ok ? 'is-ok' : 'is-failed'}`}>
          <div className="check-head">
            {r.ok ? <CheckCircle size={14} weight="fill" /> : <WarningCircle size={14} weight="fill" />}
            <span className="check-name">{t(CHECK_LABEL[r.name] ?? r.name)}</span>
            <span className="check-cmd mono">{r.command}</span>
            <span className="check-time num">{fmtDuration(r.durationMs)}</span>
          </div>
          {r.summary && <div className="check-summary mono">{r.summary}</div>}
          {!r.ok && r.problems.length > 0 && (
            <ul className="check-problems mono">
              {r.problems.map((p, i) => {
                const file = /^([\w./\\-]+\.\w+)[:(]\d+/.exec(p)?.[1];
                return (
                  <li key={i} {...(file ? { 'data-ctx': 'file', 'data-path': absolutePath(cwd, file) } : {})}>
                    {p}
                  </li>
                );
              })}
            </ul>
          )}
          {!r.ok && r.logPath && (
            <div className="term-note mono" data-ctx="file" data-path={r.logPath}>
              {t('Full log')}: {r.logPath}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todos">
      {todos.map((x, i) => (
        <li key={i} className={`todo is-${x.status}`}>
          <span className="todo-box" aria-hidden />
          <span className="todo-text">{x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content}</span>
        </li>
      ))}
    </ul>
  );
}

function ResultBody({ result, cwd, said, kids, title, whole }: { result: ToolResultPart; cwd: string; said?: string; kids?: ChildView[]; title: string; whole?: boolean }) {
  const t = useT();
  const { content, display: d, more } = useFull(result, whole);
  // Views that show their own failure (a terminal, the checks, a page) keep their shape when they fail.
  if (result.isError && d?.kind !== 'terminal' && d?.kind !== 'checks' && d?.kind !== 'shot')
    return (
      <>
        <pre className="plate plain is-error">{content}</pre>
        {more}
      </>
    );
  switch (d?.kind) {
    case 'terminal':
      return (
        <div className="plate terminal-plate">
          <CommandBlock command={d.command} said={said} cwd={cwd} />
          {d.clipped && <div className="term-note mono">{t('Showing the end of the output')}</div>}
          <Terminal text={d.output} />
          {more}
          {d.logPath && (
            <div className="term-note mono" data-ctx="file" data-path={d.logPath}>
              {t('Full log')}: {d.logPath}
            </div>
          )}
        </div>
      );
    case 'diff':
      return (
        <>
          <DiffView files={d.files} cwd={cwd} />
          {more}
        </>
      );
    case 'file':
      if (d.image) return <Images result={result} />;
      return <CodePreview text={d.preview} start={d.startLine} path={d.path} />;
    case 'search':
      return <MatchesView preview={d.preview || content} pattern={d.pattern} cwd={cwd} />;
    case 'list':
      return (
        <pre className="plate plain mono">
          {d.items.join('\n')}
          {d.total > d.items.length ? `\n… ${d.total - d.items.length}` : ''}
        </pre>
      );
    case 'todo':
      return <TodoList todos={d.todos} />;
    case 'goal':
      return <GoalList goal={d.goal} />;
    case 'checks':
      return (
        <>
          {d.before && <div className="term-note">{t("On the code before this session's changes")}</div>}
          <ChecksView results={d.results} found={d.found} cwd={cwd} />
          {d.verdict && (
            <div className={`term-note check-verdict is-${d.verdict.kind}`}>
              {fill(t(VERDICT[d.verdict.kind]), d.verdict.files.join(', '))}
            </div>
          )}
        </>
      );
    case 'attempts':
      return (
        <div className="attempts plate">
          {d.attempts.map((a) => (
            <div key={a.n} className={`attempt-row ${a.chosen ? 'is-chosen' : ''}`}>
              <span className="attempt-n num">#{a.n}</span>
              <span className={`attempt-checks num ${a.failed ? 'del' : a.passed ? 'add' : ''}`}>{a.note ? t('no change') : fill(t('{n} checks passed'), `${a.passed}/${a.passed + a.failed}`)}</span>
              <span className="attempt-size num">
                {a.files ? (
                  <>
                    {count(t, a.files, '{n} file', '{n} files')} <span className="add">+{a.added}</span> <span className="del">−{a.removed}</span>
                  </>
                ) : null}
              </span>
              <span className="attempt-kept">{a.chosen ? t('kept') : ''}</span>
            </div>
          ))}
          {d.reason && <p className="attempt-reason">{d.reason}</p>}
        </div>
      );
    case 'task': {
      // The note Favilla adds for the model is shown here as rows instead (older sessions name the app as it was then).
      const report = content.replace(/\n\n\[Recorded by \w+\][\s\S]*$/, '');
      return (
        <>
          {kids?.some((c) => c.steps.length) ? (
            <ChildProgress kids={kids} title={title} folded />
          ) : d.childSession ? (
            <ChildLinks c={childOf(kids, d.childSession)} title={title} />
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
                            <span className="mono">{c.path}</span> <span className="add num">+{c.added}</span> <span className="del num">−{c.removed}</span>
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
    case 'question':
      return (
        <dl className="qa plate">
          {d.questions.map((q) => (
            <div key={q.question}>
              <dt>{q.question}</dt>
              <dd>{d.answers[q.question] ?? '–'}</dd>
            </div>
          ))}
        </dl>
      );
    case 'plan':
      return <div className="md plate prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.plan) }} />;
    case 'mail':
      return <MailView d={d} cwd={cwd} />;
    case 'links':
      return (
        <div className="links plate">
          {(d.engines?.length || d.dropped) ? (
            <div className="links-about">{[d.engines?.join(' + '), d.dropped ? fill(t('{n} copy-site results left out'), d.dropped) : ''].filter(Boolean).join(' · ')}</div>
          ) : null}
          <ol>
            {d.results.map((r) => (
              <li key={r.url} className={r.quote ? 'is-read' : ''}>
                <a href={r.url} target="_blank" rel="noreferrer">
                  {r.title || r.url}
                </a>
                <span className="links-url mono">
                  {r.url.replace(/^https?:\/\/(www\.)?/, '')}
                  {r.date ? <span className="num"> · {r.date}</span> : null}
                </span>
                {r.quote ? <Clamp className="links-quote md" html={renderMarkdown(r.quote)} /> : r.snippet && <span className="links-snippet">{r.snippet}</span>}
              </li>
            ))}
          </ol>
        </div>
      );
    case 'shot': {
      // The browser's report: what it did and what the page said, without the page text that follows.
      const report = content.split(/\n(?:Visible text \(start\)|Page text|Elements \(act on them by ref)/)[0].split('\n').slice(1).join('\n').trim();
      return (
        <>
          <Images result={result} caption={d.url} />
          {report && <pre className={`plate plain mono ${result.isError ? 'is-error' : ''}`}>{report}</pre>}
        </>
      );
    }
    case 'web': {
      // The page as the model got it, without the header lines Favilla puts first for it.
      const body = content.replace(/^[^\n]*(\n(Published|Updated|The |A PDF)[^\n]*)*\n\n/, '');
      return (
        <>
          <div className="step-note web-note">
            <a href={d.url} target="_blank" rel="noreferrer">
              {d.title || d.url}
            </a>
            <span className="num">
              {' · '}
              {[d.via && VIA[d.via] ? t(VIA[d.via]) : '', d.date ?? '', d.chars ? fill(t('{n} characters'), d.chars.toLocaleString()) : `${Math.round(d.bytes / 1024)} KB`].filter(Boolean).join(' · ')}
            </span>
          </div>
          {body.trim() && <Clamp className="md plate prose web-text" html={renderMarkdown(body.slice(0, 6000))} />}
        </>
      );
    }
    default:
      return (
        <>
          <pre className="plate plain mono">{content}</pre>
          {more}
        </>
      );
  }
}

/**
 * The UI gets results light: a preview of long output, the end of a long terminal, the start of a long diff.
 * The whole result is fetched once the user asks for it.
 */
function useFull(result: ToolResultPart, whole = false): { content: string; display: ToolDisplay | undefined; more: ReactNode } {
  const t = useT();
  // A sub-agent's step, shown in its sheet, is held by the sub-agent's session.
  const owner = useContext(OwnerSession);
  const open = useStore((s) => s.session?.meta.id);
  const sessionId = owner ?? open;
  const [full, setFull] = useState<{ content: string; display?: ToolDisplay } | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const d = result.display;
  const partial = !!result.truncated || ((d?.kind === 'terminal' || d?.kind === 'diff') && !!d.clipped);
  const load = () => {
    setState('loading');
    api<{ content: string; display?: ToolDisplay }>(`/sessions/${sessionId}/result/${encodeURIComponent(result.callId)}`)
      .then(setFull)
      .catch(() => setState('failed'));
  };
  // A find match may be past the preview: the step opened for one reads the whole output at once.
  useEffect(() => {
    if (whole && partial && !full && state === 'idle' && sessionId) load();
    // `load` is made anew each render; the request is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whole, partial, sessionId]);
  const more =
    partial && !full && sessionId ? (
      <div className="term-note">
        <button type="button" className="link" onClick={load} disabled={state === 'loading'}>
          {t(state === 'failed' ? 'Could not load the rest' : d?.kind === 'diff' ? 'Show the whole change' : 'Show all output')}
        </button>
      </div>
    ) : null;
  return { content: full?.content ?? result.content, display: full?.display ?? d, more };
}

/** Images a tool handed to the model (screenshots, image files), shown as the model saw them. */
/**
 * Every picture the session's tools returned, in order, and where `picture` is among them: the viewer's arrow
 * keys then walk through all the agent looked at, not only one step's pictures.
 */
function browse(picture: ViewerImage): [ViewerImage[], number] {
  const all: ViewerImage[] = [];
  for (const r of getState().results.values()) all.push(...pictures(r, r.display));
  const at = all.findIndex((p) => p.src === picture.src);
  return at >= 0 ? [all, at] : [[picture], 0];
}

/** The pictures in a tool result, ready for the viewer, each with where it came from. */
function pictures(result: ToolResultPart | undefined, d: ToolResultPart['display'] | undefined): ViewerImage[] {
  const where =
    d?.kind === 'file' ? `${d.path}${d.size ? ` · ${d.size[0]}×${d.size[1]}` : ''}${d.region ? ` · [${d.region.join(', ')}]` : ''}` : d?.kind === 'shot' ? d.url : undefined;
  return (result?.images ?? [])
    .map((img, i) => ({ src: img.url ?? (img.data ? `data:${img.mediaType};base64,${img.data}` : ''), name: img.name ?? `image ${i + 1}`, caption: where }))
    .filter((p) => p.src);
}

function Images({ result, caption }: { result: ToolResultPart; caption?: string }) {
  const shots = pictures(result, result.display);
  if (!shots.length) return <div className="step-note">{result.content}</div>;
  return (
    <figure className="shots">
      {shots.map((s, i) => (
        <button key={i} type="button" className="shot-open" aria-label={s.name} onClick={(e) => openViewer(...browse(s), e.currentTarget)}>
          <img src={s.src} alt={s.name} loading="lazy" />
        </button>
      ))}
      {caption && <figcaption className="mono">{caption}</figcaption>}
    </figure>
  );
}

function CodePreview({ text, start, path }: { text: string; start: number; path: string }) {
  const lines = text.split('\n');
  return (
    <div className="plate">
      <div className="lines">
        {lines.map((l, i) => (
          <div key={i} className="ln ctx is-single">
            <span className="ln-n">{start + i}</span>
            <code dangerouslySetInnerHTML={{ __html: highlightCode(l, path) || ' ' }} />
          </div>
        ))}
      </div>
    </div>
  );
}
