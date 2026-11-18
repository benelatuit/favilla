import { memo, useCallback } from 'react';
import { foldKey, hasUserOpenedStep, lookRows, stepRows, useFoldOpen, type FoldState, type ToolStep } from '../../lib/fold-state';
import { count, fill, useT } from '../../lib/i18n';
import { stepPaths } from '../../lib/steps';
import type { Item, Step } from '../../lib/timeline';
import { CaretRight, Lightbulb, Stack } from '../icons';
import { ICONS, stepWhat, toolKind, VERB, type Kind } from '../tools/icons';
import { useSessionScope } from '../tools/SessionScope';
import { LiveTail } from '../tools/ShellTool';
import { drawStepRow, FailedNote, LookGroup } from './LookGroup';

export type ProcessItem = Extract<Item, { kind: 'process' }>;

/**
 * A settled run of up to three steps of one sort reads as one step does, its verb and what each acted on ("Run
 * check the remote · fast-forward"), so it looks like the single steps around it; a longer or mixed run is counted.
 */
function runWords(tools: readonly ToolStep[]): { kind: Kind; whats: string[] } | null {
  if (!tools.length || tools.length > 3) return null;
  const kinds = tools.map((s) => toolKind(s.name));
  if (new Set(kinds.map((k) => VERB[k])).size !== 1 || ['other', 'mcp', 'task', 'ask'].includes(kinds[0])) return null;
  const whats = [...new Set(tools.map((s) => stepWhat(s.name, s.title, s.input)).filter(Boolean))];
  return whats.length ? { kind: kinds[0], whats } : null;
}

/** What a run of steps did, counted by kind, in the order a reader asks: what it read, changed, searched, ran. */
export function stepSummary(tools: readonly ToolStep[], t: (key: string) => string): string[] {
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
 * A run of steps as one line. While it works the line shows the active step (or parallel active steps), changing as
 * the steps go by, and their count; once done it says what the steps did, counted, and how many failed.
 */
export function ProcessLine({
  tools,
  steps,
  live,
  open,
  onToggle,
}: {
  tools: readonly ToolStep[];
  steps: readonly Step[];
  live: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const activeTools = tools.filter((s) => !!s.live || s.forming !== undefined);
  const working = activeTools[activeTools.length - 1];
  const parallelCount = activeTools.length;
  const thinking = live && !working && steps[steps.length - 1]?.kind === 'reasoning';
  const now = working ?? (live && !thinking ? tools[tools.length - 1] : undefined);
  const kind = now ? toolKind(now.name) : undefined;
  const words = live ? null : runWords(tools);
  const Icon = thinking ? Lightbulb : kind ? ICONS[kind] : words ? ICONS[words.kind] : Stack;
  const stepIdentity = (s: ToolStep) => s.draftKey ?? s.key;
  const swapKey = thinking
    ? 'thinking'
    : parallelCount > 1
      ? `parallel:${activeTools.map(stepIdentity).join(',')}`
      : now
        ? stepIdentity(now)
        : 'done';
  const activeTargets =
    parallelCount > 1
      ? [...new Set(activeTools.map((s) => stepWhat(s.name, s.title, s.input)).filter(Boolean))].join(' · ')
      : now
        ? stepWhat(now.name, now.title, now.input)
        : '';
  const sameActiveVerb = parallelCount <= 1 || new Set(activeTools.map((s) => VERB[toolKind(s.name)])).size === 1;

  const liveCountLabel =
    parallelCount > 1
      ? tools.length > parallelCount
        ? `${fill(t('Running {n} steps'), parallelCount)} · ${count(t, tools.length, '{n} step', '{n} steps')}`
        : fill(t('Running {n} steps'), parallelCount)
      : count(t, tools.length, '{n} step', '{n} steps');

  return (
    <div className={`step ${open ? 'is-open' : ''} ${live ? 'is-running' : ''}`}>
      <button type="button" className={`step-head process-head ${live ? 'is-live' : ''}`} onClick={onToggle} aria-expanded={open}>
        <span className="step-icon">
          <span key={swapKey} className="process-swap">
            <Icon size={16} />
          </span>
        </span>
        {live ? (
          <span key={swapKey} className="process-now process-swap">
            <span className="step-verb">{thinking ? t('Thinking') : sameActiveVerb ? t(VERB[kind ?? 'other']) : t('Working')}</span>
            {activeTargets && <span className="step-target">{activeTargets}</span>}
          </span>
        ) : words ? (
          <span className="process-now">
            <span className="step-verb">{t(VERB[words.kind])}</span>
            <span className="step-target">{words.whats.join(' · ')}</span>
          </span>
        ) : (
          <span className="step-target process-summary">{stepSummary(tools, t).join(' · ')}</span>
        )}
        <span className="step-meta num" data-find-skip>
          {/* A counted line has already said how many steps did what: the total again would only repeat it. */}
          {(live || (words && tools.length > 1)) && liveCountLabel}
          <FailedNote tools={tools} />
        </span>
        <CaretRight size={11} className="step-caret" />
      </button>
    </div>
  );
}

function sameProcess(
  a: { item: ProcessItem; live: boolean; fold?: boolean; head?: boolean },
  b: { item: ProcessItem; live: boolean; fold?: boolean; head?: boolean },
): boolean {
  if (a.live !== b.live || a.fold !== b.fold || a.head !== b.head || a.item.anchorKey !== b.item.anchorKey || a.item.steps.length !== b.item.steps.length) return false;
  return a.item.steps.every((s, i) => {
    const o = b.item.steps[i];
    if (s.key !== o.key || s.kind !== o.kind) return false;
    if (s.kind === 'reasoning') return o.kind === 'reasoning' && s.text === o.text && s.live === o.live;
    return (
      o.kind === 'tool' &&
      s.id === o.id &&
      s.draftKey === o.draftKey &&
      s.opaque === o.opaque &&
      s.title === o.title &&
      s.result === o.result &&
      s.live === o.live &&
      s.forming === o.forming &&
      s.input === o.input &&
      s.name === o.name
    );
  });
}

export const ProcessGroup = memo(function ProcessGroup({
  item,
  live,
  fold = true,
  head = true,
}: {
  item: ProcessItem;
  live: boolean;
  fold?: boolean;
  /** False inside a finished turn's fold whose head already says what these steps did. */
  head?: boolean;
}) {
  const { sessionId } = useSessionScope();
  const { steps } = item;
  const defaultOpen = useCallback((state: FoldState) => !fold || hasUserOpenedStep(state, steps), [fold, steps]);
  const [open, toggleOpen] = useFoldOpen(sessionId, foldKey.process(item), defaultOpen, item.key);
  const tools = steps.filter((s): s is ToolStep => s.kind === 'tool');
  const single = !fold || !head || !tools.length || steps.length < 2;
  const liveShell = !single && !open && live ? [...tools].reverse().find((s) => s.live?.output && toolKind(s.name) === 'shell') : undefined;

  const drawn = (single || open)
    ? lookRows(stepRows(steps)).map((r) => (r.kind === 'look' ? <LookGroup key={r.anchorKey} row={r} fold={fold} /> : drawStepRow(r)))
    : null;

  return (
    <div className={`process ${single ? '' : 'is-folded'} ${!single && open ? 'is-open' : ''}`}>
      {!single && <ProcessLine tools={tools} steps={steps} live={live} open={open} onToggle={toggleOpen} />}
      {liveShell?.live?.output && <LiveTail text={liveShell.live.output} />}
      {(single || open) && <div className="process process-steps">{drawn}</div>}
    </div>
  );
}, sameProcess);
