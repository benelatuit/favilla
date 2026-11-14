import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Message, ToolResultPart } from '../lib/types';
import type { Draft, RunningTool } from '../lib/types';
import { renderMarkdown, renderStreamingParts, updateStreamingMarkdown } from '../lib/markdown';
import { count, fill, useT } from '../lib/i18n';
import { copyText } from '../lib/clipboard';
import { actions, preparingOf, setUi, toast, useStore, type Failure } from '../lib/store';
import { api } from '../lib/api';
import { useFollow } from '../lib/follow';
import { TAIL, drawn as drawnPart, earlier as earlierPart, later as laterPart, toShow, type Win } from '../lib/window';
import type { Work } from '../lib/turns';
import { buildTimeline, keysOf, type Block, type Item, type Ledger, type Step, type TimelineBuild } from '../lib/timeline';
import { revealNonce, useFind } from '../lib/find';
import { attachedFiles, userWords } from '../lib/messages';
import { pointedIn } from '../lib/point';
import { lineCount, pastedIn } from '../lib/paste';
import { OwnerSession } from '../lib/owner';
import { ICONS, stepWhat, ToolEntry, toolKind, VERB, type Kind } from './ToolEntry';
import { isCheckCommand, stepFailed, stepPaths, viewCommand } from '../lib/steps';
import { fmtDuration, fmtTokens } from '../lib/format';
import { keepRawText } from './contextMenu';
import { ArrowDown, ArrowsClockwise, Binoculars, CaretRight, Check, CircleNotch, ClipboardText, Copy, Crosshair, FileText, GitBranch, Lightbulb, PencilSimple, Question, Stack, Timer, X } from './icons';
import { useElapsed } from './TitleBar';
import { Keys } from './ui/Keys';
import { openViewer } from './ui/Viewer';

/**
 * Pictures in markdown: a click opens the viewer, and one that cannot be read becomes a line naming it instead of
 * the browser's broken-image mark.
 */
function useMarkdownImages(ref: React.RefObject<HTMLElement | null>, missing: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const img = e.target as HTMLImageElement;
      if (img.tagName !== 'IMG' || !img.closest('.md')) return;
      openViewer([{ src: img.src, name: img.alt || 'image' }], 0, img);
    };
    const onError = (e: Event) => {
      const img = e.target as HTMLImageElement;
      if (img.tagName !== 'IMG' || !img.closest('.md')) return;
      const span = document.createElement('span');
      span.className = 'md-img-missing';
      const path = new URL(img.src, location.href).searchParams.get('path');
      span.textContent = `${missing}: ${img.alt || path || img.src}`;
      // A figure goes with its picture: its words are in the line that stands in.
      (img.closest('.md-figure') ?? img).replaceWith(span);
    };
    el.addEventListener('click', onClick);
    // Load errors do not bubble; they are seen on the way down.
    el.addEventListener('error', onError, true);
    return () => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('error', onError, true);
    };
  }, [ref, missing]);
}

/** Copy buttons in code blocks rendered from markdown. */
function useCodeCopy(ref: React.RefObject<HTMLElement | null>, done: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('[data-copy-code]') as HTMLButtonElement | null;
      if (!btn) return;
      const code = btn.closest('pre')?.querySelector('code')?.textContent ?? '';
      navigator.clipboard.writeText(code).then(() => {
        btn.classList.add('is-done');
        btn.dataset.tip = done;
        setTimeout(() => btn.classList.remove('is-done'), 1400);
      });
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [ref, done]);
}

const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  // The session whose project a picture's relative path is in: a sub-agent's in its sheet, else the open one.
  const owner = useContext(OwnerSession);
  const open = useStore((s) => s.session?.meta.id);
  const session = owner ?? open;
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef<ReturnType<typeof updateStreamingMarkdown>>(undefined);
  const parts = streaming ? renderStreamingParts(text, session) : undefined;
  useLayoutEffect(() => {
    mounted.current = parts && updateStreamingMarkdown(ref.current!, parts, mounted.current);
  }, [parts]);
  return <div ref={ref} className={`md ${className ?? ''}`} dangerouslySetInnerHTML={parts ? undefined : { __html: renderMarkdown(text, session) }} />;
});

// ── pieces ─────────────────────────────────────────────────────────────────

function thoughtTitle(text: string): string {
  const bold = /^\s*\*\*(.+?)\*\*/.exec(text)?.[1];
  const flat = (bold ?? text).replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

/** Open a fold when find brings a match inside it into view; it stays open after, as the reader left it. */
function useOpenOnFind(blocks: string | string[], open: () => void, when = true): void {
  const asked = useFind((_, r) => (when && (!Array.isArray(blocks) || blocks.length) ? revealNonce(r, blocks) : 0));
  useEffect(() => {
    if (asked) open();
    // `open` is a state setter's call; only a new request matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
}

function Thought({ id, text, live }: { id: string; text: string; live?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  useOpenOnFind(id, () => setOpen(true));
  const title = live ? thoughtTitle(text.split(/\n\n(?=\*\*)/).pop() ?? text) : thoughtTitle(text);
  if (!title) return null;
  return (
    <div className={`step thought ${open ? 'is-open' : ''} ${live ? 'is-running' : ''}`} data-find={id}>
      <button type="button" className="step-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="step-icon">
          <Lightbulb size={16} />
        </span>
        <span className="step-verb" data-find-skip>
          {t('Thinking')}
        </span>
        {/* Opened, the whole thought is below: its title is not a second match. */}
        <span className="step-target is-thought" {...(open ? { 'data-find-skip': true } : {})}>
          {title}
        </span>
        <CaretRight size={11} className="step-caret" />
      </button>
      {open && (
        <div className="step-body">
          <Markdown text={text} className="thought-text" />
        </div>
      )}
    </div>
  );
}

/** Several thoughts in a row read as one: the latest one's title and how many there were, each one a click away. */
function ThoughtRun({ texts, keys }: { texts: string[]; keys: string[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  useOpenOnFind(keys, () => setOpen(true));
  const titles = texts.map((x) => thoughtTitle(x)).filter(Boolean);
  if (!titles.length) return null;
  if (open)
    return (
      <div className="thought-run is-open">
        {texts.map((x, i) => (
          <Thought key={keys[i]} id={keys[i]} text={x} />
        ))}
        <button type="button" className="thought-run-fold" onClick={() => setOpen(false)}>
          {t('Fold')}
        </button>
      </div>
    );
  return (
    <div className="step thought">
      <button type="button" className="step-head" onClick={() => setOpen(true)} aria-expanded={false}>
        <span className="step-icon">
          <Lightbulb size={16} />
        </span>
        <span className="step-verb">{t('Thinking')}</span>
        <span className="step-target is-thought">{titles[titles.length - 1]}</span>
        <span className="step-meta num">{fill(t('{n} thoughts'), titles.length)}</span>
        <CaretRight size={11} className="step-caret" />
      </button>
    </div>
  );
}

/** Steps as drawn: runs of finished thoughts merged into one row, everything else as it is. */
function stepRows(steps: Step[]): ({ kind: 'run'; key: string; texts: string[]; keys: string[] } | Step)[] {
  const rows: ({ kind: 'run'; key: string; texts: string[]; keys: string[] } | Step)[] = [];
  for (const s of steps) {
    const last = rows[rows.length - 1];
    if (s.kind === 'reasoning' && !s.live && last?.kind === 'reasoning' && !last.live) rows[rows.length - 1] = { kind: 'run', key: last.key, texts: [last.text, s.text], keys: [last.key, s.key] };
    else if (s.kind === 'reasoning' && !s.live && last?.kind === 'run') {
      last.texts.push(s.text);
      last.keys.push(s.key);
    } else rows.push(s);
  }
  return rows;
}

/** The parts a row of steps holds, by the names find uses. */
const rowKeys = (rows: Row[]) => rows.flatMap((r) => (r.kind === 'run' ? r.keys : [r.key]));

type ToolStep = Extract<Step, { kind: 'tool' }>;
type Row = ReturnType<typeof stepRows>[number];
const failed = (s: ToolStep) => stepFailed(s.result);

/** Tools that only look. A command looks when every part of it is one of these, with nothing written by a redirect. */
const LOOK: Kind[] = ['read', 'grep', 'glob', 'web', 'websearch'];
const LOOK_COMMAND = /^(?:ls|dir|cat|type|head|tail|wc|rg|grep|find|fd|tree|stat|file|pwd|which|where|du|df|Get-ChildItem|Get-Content|git\s+(?:status|log|diff|show|branch|grep|blame|ls-files|rev-parse))(?:\s|$)/i;

function looks(s: Row): s is ToolStep {
  if (s.kind !== 'tool') return false;
  const kind = toolKind(s.name);
  if (LOOK.includes(kind)) return true;
  const command = typeof s.input?.command === 'string' ? s.input.command : '';
  if (kind !== 'shell' || !command || /(^|[^2&])>|-delete\b|-exec\b/.test(command)) return false;
  return command.split(/&&|\|\||;|\|/).every((part) => LOOK_COMMAND.test(part.trim()));
}

/**
 * Two or more looking steps in a row (thoughts between them included) become one line of what was looked at; a
 * thought after the last of them stays outside, since it leads into what comes next.
 */
function lookRows(rows: Row[]): (Row | { kind: 'look'; key: string; rows: Row[] })[] {
  const out: (Row | { kind: 'look'; key: string; rows: Row[] })[] = [];
  let run: Row[] = [];
  const flush = () => {
    const last = run.map((r) => looks(r)).lastIndexOf(true);
    const head = run.slice(0, last + 1);
    if (head.filter(looks).length >= 2) out.push({ kind: 'look', key: `look-${head[0].key}`, rows: head });
    else out.push(...head);
    out.push(...run.slice(last + 1));
    run = [];
  };
  for (const r of rows) {
    if (looks(r) || (run.length && (r.kind === 'run' || (r.kind === 'reasoning' && !r.live)))) run.push(r);
    else {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}

function drawRows(list: Row[]) {
  return list.map((s) =>
    s.kind === 'run' ? (
      <ThoughtRun key={s.key} texts={s.texts} keys={s.keys} />
    ) : s.kind === 'reasoning' ? (
      <Thought key={s.key} id={s.key} text={s.text} live={s.live} />
    ) : (
      <ToolEntry key={s.key} callId={s.id} name={s.name} title={s.title} input={s.input} result={s.result} running={s.live} forming={s.forming} />
    ),
  );
}

/** What a run of looking steps looked at, as one line that opens to the steps. */
function LookRun({ rows, open: startOpen }: { rows: Row[]; open: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(startOpen);
  useOpenOnFind(rowKeys(rows), () => setOpen(true));
  const tools = rows.filter(looks);
  const working = tools.some((s) => s.live);
  const what = [...new Set(tools.map((s) => stepWhat(s.name, s.title, s.input)).filter(Boolean))];
  return (
    <div className="look-run">
      <div className="step">
        <button type="button" className={`step-head look-head ${open ? 'is-open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="step-icon">{working ? <CircleNotch size={14} className="spin" /> : <Binoculars size={16} />}</span>
          <span className="step-verb">{t(working ? 'Exploring' : 'Explored')}</span>
          <span className="step-target">{what.join(' · ')}</span>
          <span className="step-meta num">
            {fill(t('{n} steps'), tools.length)}
            <FailedNote tools={tools} />
          </span>
          <CaretRight size={11} className="step-caret" />
        </button>
      </div>
      {open && <div className="look-steps">{drawRows(rows)}</div>}
    </div>
  );
}

/** A step's words cut for a line's end. */
const shortWhat = (s: ToolStep) => {
  const w = stepWhat(s.name, s.title, s.input);
  return w.length > 28 ? `${w.slice(0, 27)}…` : w;
};

/** What failed in a run of steps: the step itself when one did, which the reader would otherwise open the run to find. */
function FailedNote({ tools }: { tools: ToolStep[] }) {
  const t = useT();
  const broke = tools.filter(failed);
  if (!broke.length) return null;
  const said = broke.length === 1 && shortWhat(broke[0]);
  return <span className="process-failed">{said ? fill(t('Failed: {n}'), said) : fill(t('{n} steps failed'), broke.length)}</span>;
}

/**
 * A settled run of up to three steps of one sort reads as one step does, its verb and what each acted on ("Run
 * check the remote · fast-forward"), so it looks like the single steps around it; a longer or mixed run is counted.
 */
function runWords(tools: ToolStep[]): { kind: Kind; whats: string[] } | null {
  if (!tools.length || tools.length > 3) return null;
  const kinds = tools.map((s) => toolKind(s.name));
  if (new Set(kinds.map((k) => VERB[k])).size !== 1 || ['other', 'mcp', 'task', 'ask'].includes(kinds[0])) return null;
  const whats = [...new Set(tools.map((s) => stepWhat(s.name, s.title, s.input)).filter(Boolean))];
  return whats.length ? { kind: kinds[0], whats } : null;
}

/** What a run of steps did, counted by kind, in the order a reader asks: what it read, changed, searched, ran. */
function stepSummary(tools: ToolStep[], t: (key: string) => string): string[] {
  const named = (s: ToolStep) => {
    const paths = stepPaths(s.input ?? {});
    return paths.length ? paths : [stepWhat(s.name, s.title, s.input)];
  };
  const files = (kinds: Kind[]) => new Set(tools.filter((s) => kinds.includes(toolKind(s.name))).flatMap(named)).size;
  const many = (kinds: Kind[]) => tools.filter((s) => kinds.includes(toolKind(s.name))).length;
  const read = files(['read']);
  const changed = files(['write', 'edit', 'patch']);
  const searched = many(['grep', 'glob', 'web', 'websearch']);
  const ran = many(['shell']);
  const other = tools.length - many(['read', 'write', 'edit', 'patch', 'grep', 'glob', 'web', 'websearch', 'shell']);
  const said = (n: number, one: string, more: string) => (n ? [fill(t(n > 1 ? more : one), n)] : []);
  return [
    ...said(read, 'Read {n} file', 'Read {n} files'),
    ...said(changed, 'Changed {n} file', 'Changed {n} files'),
    ...said(searched, 'Searched {n} time', 'Searched {n} times'),
    ...said(ran, 'Ran {n} command', 'Ran {n} commands'),
    ...said(other, '{n} other step', '{n} other steps'),
  ];
}

/**
 * A run of steps as one line. While it works the line is the step at work, its tool and what it acts on, changing as
 * the steps go by, and their count; once done it says what the steps did, counted, and how many failed. A click
 * opens the steps under it.
 */
function ProcessLine({ tools, steps, live, open, onToggle }: { tools: ToolStep[]; steps: Step[]; live: boolean; open: boolean; onToggle: () => void }) {
  const t = useT();
  const working = [...tools].reverse().find((s) => s.live || s.forming !== undefined);
  const thinking = live && !working && steps[steps.length - 1]?.kind === 'reasoning';
  const now = working ?? (live && !thinking ? tools[tools.length - 1] : undefined);
  const kind = now ? toolKind(now.name) : undefined;
  const words = live ? null : runWords(tools);
  const Icon = thinking ? Lightbulb : kind ? ICONS[kind] : words ? ICONS[words.kind] : Stack;
  const key = thinking ? 'thinking' : (now?.key ?? 'done');
  return (
    <div className={`step ${open ? 'is-open' : ''} ${live ? 'is-running' : ''}`}>
      <button type="button" className={`step-head process-head ${live ? 'is-live' : ''}`} onClick={onToggle} aria-expanded={open}>
        <span className="step-icon">
          <span key={key} className="process-swap">
            <Icon size={16} />
          </span>
        </span>
        {live ? (
          <span key={key} className="process-now process-swap">
            <span className="step-verb">{thinking ? t('Thinking') : t(VERB[kind ?? 'other'])}</span>
            {now && <span className="step-target">{stepWhat(now.name, now.title, now.input)}</span>}
          </span>
        ) : words ? (
          <span className="process-now">
            <span className="step-verb">{t(VERB[words.kind])}</span>
            <span className="step-target">{words.whats.join(' · ')}</span>
          </span>
        ) : (
          <span className="step-target process-summary">{stepSummary(tools, t).join(' · ')}</span>
        )}
        <span className="step-meta num">
          {/* A counted line has already said how many steps did what: the total again would only repeat it. */}
          {(live || (words && tools.length > 1)) && fill(t('{n} steps'), tools.length)}
          <FailedNote tools={tools} />
        </span>
        <CaretRight size={11} className="step-caret" />
      </button>
    </div>
  );
}

/**
 * A run of steps between two pieces of text, folded to one line from its first step on, as it happens and as it
 * stays: the line shows the step at work, then what the steps did. Folded from the start, nothing moves when the run
 * ends (folding an open batch as the answer began moved the page under the reader, 2026-11-03), and the turn's ledger
 * still lists every file changed. A single step is its own row; opened, the steps read as before, looking steps in a
 * line of what they looked at. A sub-agent's conversation, opened to be read, shows its steps open.
 */
const Process = memo(function Process({ steps, live, fold = true }: { steps: Step[]; live: boolean; fold?: boolean }) {
  const [open, setOpen] = useState(false);
  useOpenOnFind(
    steps.map((s) => s.key),
    () => setOpen(true),
    fold,
  );
  const tools = steps.filter((s): s is ToolStep => s.kind === 'tool');
  const drawn = lookRows(stepRows(steps)).map((r) => (r.kind === 'look' ? <LookRun key={r.key} rows={r.rows} open={!fold} /> : drawRows([r])));
  // One step is its own row; a run with a tool in it and anything more is one line, a thought beside a single
  // command included: drawn as two rows on a rail, it read as a different sort of thing from the folded runs around it.
  if (!fold || !tools.length || steps.length < 2) return <div className="process">{drawn}</div>;
  return (
    <div className={`process is-folded ${open ? 'is-open' : ''}`}>
      <ProcessLine tools={tools} steps={steps} live={live} open={open} onToggle={() => setOpen((o) => !o)} />
      {open && <div className="process process-steps">{drawn}</div>}
    </div>
  );
}, sameProcess);

/**
 * Whether a run of steps reads the same: its steps are new objects on every render (the timeline is worked out
 * again for each streamed piece), so they are compared by what they hold. A long session redrew every turn on
 * screen twenty times a second while one answer came in.
 */
function sameProcess(a: { steps: Step[]; live: boolean; fold?: boolean }, b: { steps: Step[]; live: boolean; fold?: boolean }): boolean {
  if (a.live !== b.live || a.fold !== b.fold || a.steps.length !== b.steps.length) return false;
  return a.steps.every((s, i) => {
    const o = b.steps[i];
    if (s.key !== o.key || s.kind !== o.kind) return false;
    if (s.kind === 'reasoning') return o.kind === 'reasoning' && s.text === o.text && s.live === o.live;
    return o.kind === 'tool' && s.title === o.title && s.result === o.result && s.live === o.live && s.forming === o.forming && s.input === o.input && s.name === o.name;
  });
}

/**
 * A finished turn's work as one line: what its steps did, counted, as a run of steps says it. Opened, the steps and
 * the notes between them read as they did; find opens it when a match is inside.
 */
function WorkFold({ work, draw }: { work: Work<Item>; draw: (item: Item) => ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  useOpenOnFind(useMemo(() => keysOf(work), [work]), () => setOpen(true));
  const tools = work.items.flatMap((x) => (x.kind === 'process' ? x.steps.filter((s): s is ToolStep => s.kind === 'tool') : []));
  const broke = tools.some(failed);
  return (
    <div className={`work-fold ${open ? 'is-open' : ''}`}>
      <div className={`step ${open ? 'is-open' : ''}`}>
        <button type="button" className="step-head process-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="step-icon">
            <Stack size={16} />
          </span>
          <span className="step-target process-summary">{stepSummary(tools, t).join(' · ')}</span>
          {broke && (
            <span className="step-meta num">
              <FailedNote tools={tools} />
            </span>
          )}
          <CaretRight size={11} className="step-caret" />
        </button>
      </div>
      {open && <div className="work-body">{work.items.map(draw)}</div>}
    </div>
  );
}

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
  const [open, setOpen] = useState(false);
  useOpenOnFind(id, () => setOpen(true));
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
        <button type="button" className="user-fold" onClick={() => setOpen((o) => !o)}>
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
    // Files changed from this message's turn on: those are what undoing would put back.
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

const UserCard = memo(function UserCard({ m }: { m: Message }) {
  const t = useT();
  const { text, attached, images } = userParts(m);
  // What the user pointed at in the preview, as its tag and words.
  const pointed = pointedIn(m);
  // What they pasted, by number; one opens in place.
  const pasted = useMemo(() => pastedIn(m), [m]);
  const [shown, setShown] = useState(-1);
  const found = useFind((_, r) => r?.block === m.id && r.paste !== undefined ? r : null);
  useEffect(() => {
    if (found?.paste !== undefined) setShown(found.paste);
  }, [found]);
  const editing = useStore((s) => s.ui.editing === m.id);
  const raw = useCallback((card: HTMLDivElement | null) => keepRawText(card, text), [text]);
  if (editing) return <UserEdit m={m} text={text} />;
  return (
    <div ref={raw} className="turn-user" data-ctx="message" data-key={m.id} data-kind="user" data-find={m.id}>
      <div className="user-actions" data-find-skip>
        <button type="button" className="icon-btn is-small" aria-label={t('Edit and send again')} data-tip={t('Edit and send again')} onClick={() => setUi({ editing: m.id })}>
          <PencilSimple size={14} />
        </button>
      </div>
      <div className="user-card">
        {images.length > 0 && (
          <div className="user-images">
            {images.map((img, i) =>
              img.src ? (
                <button key={i} type="button" className="shot-open" aria-label={img.name} onClick={(e) => openViewer(images.filter((x) => x.src).map((x) => ({ src: x.src, name: x.name })), images.filter((x) => x.src).indexOf(img), e.currentTarget)}>
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
    </div>
  );
});

/** A command in one line as a step shows it: without the cd in front of it, which says where and not what. */
const oneLineCommand = (c: string) => {
  const flat = viewCommand(c).rest.replace(/\s+/g, ' ').trim();
  return flat.length > 56 ? `${flat.slice(0, 55)}…` : flat;
};

/**
 * Under a turn's answer, what the turn took and did as Favilla recorded it: its time (and how much of it went to
 * the model), the files it changed, and how its checks stand. One quiet line of figures; it opens into the parts.
 * The line names no command: a command there was mostly the cd in front of it, and the steps above already show
 * each one. Opened, it lists the checks alone, each once as it last ended.
 */
type Run = Ledger['runs'][number];
/** Green only for a pass on the code as it stands: a run on the old code or one with no verdict is neither. */
const runTone = (r: Run) => (r.before || r.state === 'unknown' ? '' : r.state === 'passed' ? 'is-ok' : 'is-bad');
const runSymbol = (r: Run) => (r.before || r.state === 'unknown' ? '?' : r.state === 'passed' ? '✓' : '✗');
const RunMark = ({ r, size }: { r: Run; size: number }) =>
  r.before || r.state === 'unknown' ? <Question size={size} weight="bold" /> : r.state === 'passed' ? <Check size={size} weight="bold" /> : <X size={size} weight="bold" />;

/** The turn as a commit or pull-request description: the answer, then what changed and what was checked. */
function asDescription(answer: string, l: Ledger): string {
  const out = [answer.trim()];
  if (l.files.length) out.push(`**Changes**\n${l.files.map((f) => `- \`${f.path}\` (+${f.added} −${f.removed})`).join('\n')}`);
  // Each check once, as it last ended.
  const last = new Map<string, Ledger['runs'][number]>();
  for (const r of l.runs) if (isCheckCommand(r.command)) last.set(r.command, r);
  if (last.size) out.push(`**Checks**\n${[...last.values()].map((r) => `- ${runSymbol(r)} \`${r.command.replace(/\s+/g, ' ').trim()}\`${r.before ? ' (on the code before this change)' : r.state === 'unknown' ? ' (no verdict)' : ''}`).join('\n')}`);
  return out.join('\n\n');
}

function TurnLedger({ l, answer }: { l: Ledger; answer: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Each check once, as it last ended; the same check from another folder is the same check.
  const byCommand = new Map<string, Run>();
  for (const r of l.runs) if (isCheckCommand(r.command)) byCommand.set(oneLineCommand(r.command), r);
  const checks = [...byCommand.values()];
  const open_ = checks.filter((r) => r.before || r.state === 'unknown').length;
  const bad = checks.filter((r) => !r.before && r.state === 'failed').length;
  const verdict = bad ? { tone: 'is-bad', n: bad, one: '{n} check failed', many: '{n} checks failed' } : open_ ? { tone: '', n: open_, one: '{n} check without a verdict', many: '{n} checks without a verdict' } : { tone: 'is-ok', n: checks.length, one: '{n} check passed', many: '{n} checks passed' };
  const added = l.files.reduce((n, f) => n + f.added, 0);
  const removed = l.files.reduce((n, f) => n + f.removed, 0);
  const toolMs = Math.max(0, l.ms - l.modelMs);
  const share = (ms: number) => `${l.ms ? Math.round((ms / l.ms) * 100) : 0}%`;
  return (
    <div className={`ledger ${open ? 'is-open' : ''}`} data-find-skip>
      <button type="button" className="ledger-line" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="ledger-parts">
          <span className="ledger-part num">
            <Timer size={14} />
            {fmtDuration(l.ms)}
            <span className="ledger-quiet">
              {' · '}
              {count(t, l.requests, '{n} request', '{n} requests')}
            </span>
          </span>
          {l.files.length > 0 && (
            <span className="ledger-part num">
              <FileText size={14} />
              {count(t, l.files.length, '{n} file', '{n} files')} <span className="add">+{added}</span> <span className="del">−{removed}</span>
            </span>
          )}
          {checks.length > 0 && (
            <span className={`ledger-part ${verdict.tone}`}>
              {bad ? <X size={14} weight="bold" /> : open_ ? <Question size={14} weight="bold" /> : <Check size={14} weight="bold" />}
              {count(t, verdict.n, verdict.one, verdict.many)}
            </span>
          )}
        </span>
        <CaretRight size={11} className="ledger-caret" />
      </button>
      {open && (
        <div className="ledger-body">
          <div className="ledger-time">
            <div className="ledger-bar" aria-hidden>
              <span className="is-model" style={{ width: share(l.modelMs) }} />
              <span className="is-tools" style={{ width: share(toolMs) }} />
            </div>
            <span className="num">
              <i className="ledger-key is-model" /> {t('Model')} {fmtDuration(l.modelMs)}
              <i className="ledger-key is-tools" /> {t('Tools')} {fmtDuration(toolMs)}
            </span>
          </div>
          {l.files.length > 0 && (
            <ul className="ledger-list">
              {l.files.map((f) => (
                <li key={f.path}>
                  <span className="mono ledger-path">{f.path}</span>
                  <span className="num">
                    <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {checks.length > 0 && (
            <ul className="ledger-list">
              {checks.map((r, i) => (
                <li key={i} className={runTone(r)} data-tip={r.command}>
                  <span className="ledger-mark">
                    <RunMark r={r} size={12} />
                  </span>
                  <span className="mono ledger-path">{oneLineCommand(r.command)}</span>
                  <span className="num ledger-quiet">
                    {r.before ? `${t('on the old code')} · ` : r.state === 'unknown' ? `${t('no verdict')} · ` : r.state === 'passed' ? '' : r.exit === null ? `${t('did not finish')} · ` : r.exit === 0 ? `${t('printed failures')} · ` : `exit ${r.exit} · `}
                    {fmtDuration(r.ms)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="ledger-copy"
            onClick={() => void copyText(asDescription(answer, l), t, 'Copied as a commit description')}
          >
            <Copy size={12} /> {t('Copy as a commit description')}
          </button>
        </div>
      )}
    </div>
  );
}

const Answer = memo(function Answer({ b }: { b: Extract<Block, { kind: 'text' }> }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const raw = useCallback((card: HTMLDivElement | null) => keepRawText(card, b.text), [b.text]);
  return (
    <div ref={raw} className={`answer ${b.final ? 'is-final' : ''} ${b.streaming ? 'is-streaming' : ''}`} data-ctx="message" data-key={b.key} data-find={b.key}>
      <Markdown text={b.text} streaming={b.streaming} />
      {b.final && b.ledger && <TurnLedger l={b.ledger} answer={b.text} />}
      {b.final && (
        <div className="answer-actions" data-find-skip>
          <button
            type="button"
            className="icon-btn is-small"
            aria-label={t('Copy message')}
            data-tip={copied ? t('Copied') : t('Copy message')}
            onClick={() =>
              navigator.clipboard.writeText(b.text).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                },
                () => toast(t('Could not use the clipboard'), 'error'),
              )
            }
          >
            {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
          </button>
          <button
            type="button"
            className="icon-btn is-small"
            aria-label={t('Branch from here')}
            data-tip={t('Branch from here')}
            onClick={() =>
              actions
                .fork(b.key.split(':')[0], 'after')
                .then(() => toast(t('A new branch starts here; the original conversation is unchanged.'), 'info'))
                .catch((e) => toast((e as Error).message, 'error'))
            }
          >
            <GitBranch size={14} />
          </button>
        </div>
      )}
    </div>
  );
}, (a, z) => a.b.key === z.b.key && a.b.text === z.b.text && a.b.final === z.b.final && a.b.streaming === z.b.streaming && a.b.ledger === z.b.ledger);

/**
 * Where the context was compacted: what it held before and after, how many of the latest rounds stayed word for word,
 * and, open, the summary and Favilla's record of the work beside it, as the model reads them.
 */
function Compaction({ m }: { m: Message }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim() ?? text;
  // The record is plain lines Favilla wrote from the calls themselves: from its heading to the next paragraph.
  const at = text.indexOf('What the work before this point did');
  const rest = at >= 0 ? text.slice(at) : '';
  const end = rest.search(/\n\n(?![ -])/);
  const record = rest ? (end < 0 ? rest : rest.slice(0, end)).trim() : undefined;
  const c = m.compacted;
  // Find in the conversation opens it to a match in its summary.
  useOpenOnFind(m.id, () => setOpen(true));
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
        <button type="button" className="link" onClick={() => setOpen((o) => !o)}>
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
}

/** The user's message while the turn gets it ready: there at once, as it will stand. */
function Preparing() {
  const prep = useStore((s) => preparingOf(s.session));
  if (!prep) return null;
  return (
    <div className="turn-user is-preparing">
      <div className="user-card">
        <div className="user-text">{prep.text}</div>
      </div>
    </div>
  );
}

/**
 * What a provider's failure means for the user and where it is fixed, by its kind. The provider's own words stay
 * under it: a first run had shown "Happy: Invalid token" and "ECONNREFUSED" with nothing to say what to do.
 */
function failureAdvice(f: Failure): { say: string; settings: boolean } | null {
  switch (f.kind) {
    case 'auth':
      return /no api key/i.test(f.text)
        ? { say: 'This provider has no API key yet. Add one in the provider settings.', settings: true }
        : { say: 'The provider turned down the API key. Check it in the provider settings.', settings: true };
    case 'model_not_found':
      return { say: 'The provider does not have this model, or cannot reach it just now. Check the model name, or pick another model below.', settings: true };
    case 'network':
      return { say: 'Could not reach the provider. Check its address, that a model server on this computer is running, and the HTTPS proxy.', settings: true };
    case 'overloaded':
    case 'server':
    case 'stream_stalled':
      return { say: 'The provider is busy or failing just now. Try again in a while, or pick another model below.', settings: false };
    case 'rate_limit':
      return { say: 'The provider is limiting requests. Wait a moment and try again.', settings: false };
    case 'quota':
      return { say: 'This account has used up its quota with the provider. Check its usage or billing there.', settings: false };
    default:
      return null;
  }
}

/** Failures a second try can get past once something changed (a key, the model, the service); the rest fail the same. */
const RETRIES = new Set(['auth', 'model_not_found', 'network', 'overloaded', 'server', 'stream_stalled', 'rate_limit', 'quota', 'unknown']);

/** A turn that ended on an error, said at the end of the conversation until the next turn starts. */
function Failed() {
  const t = useT();
  const failed = useStore((s) => s.failed);
  const idle = useStore((s) => (s.session?.status ?? 'idle') === 'idle');
  if (!failed || !idle) return null;
  const advice = failureAdvice(failed);
  const retry = !!failed.kind && RETRIES.has(failed.kind);
  // The session's own note after a few tries ("no answer after 3 tries: ...") says in English what the advice says.
  const detail = failed.text.replace(/\s*\(no answer after \d+ tries:[^)]*\)\s*$/, '');
  return (
    <div className="notice is-error turn-failed" role="status">
      {advice ? (
        <>
          <p className="turn-failed-say">{t(advice.say)}</p>
          <p className="turn-failed-detail mono">{detail}</p>
        </>
      ) : (
        <p className="turn-failed-say">{fill(t('This turn did not finish: {n}'), failed.text)}</p>
      )}
      {(retry || advice?.settings) && (
        <div className="turn-failed-actions">
          {retry && (
            <button type="button" className="btn is-small" onClick={() => actions.retry().catch((e) => toast((e as Error).message, 'error'))}>
              <ArrowsClockwise size={14} /> {t('Try again')}
            </button>
          )}
          {advice?.settings && (
            <button type="button" className="btn is-small btn-quiet" onClick={() => setUi({ settings: 'providers' })}>
              {t('Open provider settings')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Working() {
  const t = useT();
  const status = useStore((s) => s.session?.status ?? 'idle');
  const detail = useStore((s) => s.session?.statusDetail);
  const elapsed = useElapsed();
  if (status === 'idle' || status === 'waiting') return null;
  const label = status === 'compacting' ? t('Compacting context') : detail === 'checking' ? t('Checking the answer covers every request') : detail === 'shadow-tests' ? t('Running the shadow tests another model wrote from the request') : detail === 'auditing' ? t('Measuring the page at desktop and phone width') : detail === 'retrying' ? t('Retrying') : detail === 'thinking' ? t('Thinking; this model does not show its thoughts') : t('Working');
  return (
    <div className="working" aria-live="polite">
      <span className="spindle" aria-hidden />
      <span>{label}</span>
      {elapsed && <span className="num muted">{elapsed}</span>}
      <span className="working-hint">
        <Keys combo="Esc" /> {t('to stop')}
      </span>
    </div>
  );
}

// ── timeline ───────────────────────────────────────────────────────────────

/** The lines above and below a shortened conversation draw more of it on their own when reached. */
function MoreHistory({ count, onMore, later = false }: { count: number; onMore: () => void; later?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const rootMargin = later ? '0px 0px 200px 0px' : '200px 0px 0px 0px';
  // Recheck the lower edge as the conversation grows below it.
  const remaining = later ? count : undefined;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { rootMargin });
    seen.observe(el);
    return () => seen.disconnect();
  }, [onMore, rootMargin, remaining]);
  return (
    <button type="button" ref={ref} className={later ? 'link earlier later' : 'link earlier'} onClick={onMore}>
      {fill(later ? t('Show later ({n} more)') : t('Show earlier ({n} more)'), count)}
    </button>
  );
}

interface TimelineProps {
  messages: Message[];
  results: Map<string, ToolResultPart>;
  drafts: Map<string, Draft>;
  running: Map<string, RunningTool>;
  footer?: ReactNode;
  /** Another session's work shown inside a sheet (a sub-agent's): whether it is still working, and no working line of this one's. */
  embedded?: { live: boolean };
  /** The session these messages belong to, when it is not the open one (a sub-agent's): what its steps load comes from it. */
  sessionId?: string;
}

export function Timeline({ messages, results, drafts, running, footer, embedded, sessionId }: TimelineProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const sessionBusy = useStore((s) => (s.session?.status ?? 'idle') !== 'idle');
  const busy = embedded ? embedded.live : sessionBusy;
  const openSession = useStore((s) => s.session?.meta.id);
  const replaces = useStore((s) => s.session?.meta.replaces);
  const owner = sessionId ?? openSession;
  const expanded = !!embedded;
  useCodeCopy(ref, t('Copied'));
  useMarkdownImages(ref, t('Picture not found'));
  // Only a part is drawn: the end at first, a stretch around a place far back once find or the outline asks for one.
  // Another session starts from its end again.
  const [shown, setShown] = useState({ owner, followKey: owner, win: TAIL });
  if (shown.owner !== owner) {
    // A replacement is the conversation already on screen. A different branch may share all its early messages.
    const same = !embedded && shown.owner && replaces?.includes(shown.owner);
    setShown(same ? { ...shown, owner } : { owner, followKey: owner, win: TAIL });
  }
  const { win, followKey } = shown;
  const setWin = useCallback((update: Win | ((before: Win) => Win)) => {
    setShown((before) => {
      const win = typeof update === 'function' ? update(before.win) : update;
      return win === before.win ? before : { ...before, win };
    });
  }, []);
  const atEnd = win.to === null;
  // An embedded timeline sits in a scrolling sheet that follows it itself; a stretch far back does not follow.
  const { away, follow } = useFollow(() => ref.current?.parentElement, { enabled: !embedded && atEnd, key: followKey });

  const previous = useRef<TimelineBuild>(undefined);
  const built = useMemo(
    () => buildTimeline({ messages, results, running, drafts, live: busy, embedded: expanded, sessionId: owner }, previous.current),
    [messages, results, running, drafts, busy, expanded, owner],
  );
  useLayoutEffect(() => { previous.current = built; }, [built]);
  const { items } = built;
  // A run of steps is at work only while nothing follows it: once the model writes on under it, the run has ended
  // and its line says what it did, where it went on naming its last step beside an answer being written.
  const lastItem = items[items.length - 1];
  const lastProcess = lastItem?.kind === 'process' ? lastItem : undefined;
  const { start, end } = drawnPart(items, win);
  const itemsNow = useRef(items);
  itemsNow.current = items;
  // Drawing more above keeps what is on screen where it is. The browser does this itself, except at the very top of
  // the scroll (where the reader lands after a fling, or find after placing a match near the start of a stretch),
  // where the new parts pushed everything down a screen or more.
  const kept = useRef<{ el: Element; top: number } | null>(null);
  const more = useCallback(() => {
    const first = ref.current?.querySelector(':scope > :not(.earlier)');
    if (first) kept.current = { el: first, top: first.getBoundingClientRect().top };
    setWin((w) => earlierPart(itemsNow.current, w));
  }, []);
  useLayoutEffect(() => {
    const k = kept.current;
    kept.current = null;
    const box = ref.current?.parentElement;
    if (k && box && k.el.isConnected) box.scrollTop += k.el.getBoundingClientRect().top - k.top;
  }, [start]);
  const fewer = useCallback(() => setWin((w) => laterPart(itemsNow.current, w)), []);
  const reveal = useFind((_, r) => (embedded ? null : r));
  useEffect(() => {
    if (!reveal) return;
    const i = items.findIndex((it) => keysOf(it).includes(reveal.block));
    if (i >= 0) setWin((w) => toShow(items, w, i));
    // Each request once, on the items of its moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  const draw = (item: Item): ReactNode => {
    switch (item.kind) {
      case 'user':
        return <UserCard key={item.key} m={item.m} />;
      case 'steer':
        return (
          <div key={item.key} className="turn-user is-steer" data-find={item.key}>
            <span className="steer-label" data-find-skip>
              {t('Sent while it was working')}
            </span>
            <div className="user-card">
              <div className="user-text">{item.text}</div>
            </div>
          </div>
        );
      case 'compaction':
        return <Compaction key={item.key} m={item.m} />;
      case 'text':
        return <Answer key={item.key} b={item} />;
      case 'refusal':
        // Most providers give no reason: then the line says only that it declined, with nothing after a colon.
        return (
          <div key={item.key} className="notice is-warn">
            {item.text.trim() ? `${t('The model declined')}: ${item.text}` : t('The model declined')}
          </div>
        );
      case 'process':
        return <Process key={item.key} steps={item.steps} live={busy && item === lastProcess} fold={!embedded} />;
      case 'work':
        return <WorkFold key={item.key} work={item} draw={draw} />;
    }
  };

  return (
    <OwnerSession.Provider value={sessionId}>
    <div className="timeline" ref={ref}>
      {start > 0 && <MoreHistory count={start} onMore={more} />}
      {items.slice(start, end).map(draw)}
      {end < items.length && <MoreHistory count={items.length - end} onMore={fewer} later />}
      {!embedded && atEnd && <Preparing />}
      {!embedded && atEnd && <Working />}
      {!embedded && atEnd && <Failed />}
      {footer}
      {(away || !atEnd) && !embedded && (
        <button
          type="button"
          className="jump"
          onClick={() => {
            setWin(TAIL);
            follow(!atEnd);
          }}
        >
          <ArrowDown size={14} weight="bold" />
          <span>{t('Latest')}</span>
        </button>
      )}
    </div>
    </OwnerSession.Provider>
  );
}
