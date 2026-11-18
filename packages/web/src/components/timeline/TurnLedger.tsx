import { memo, useCallback, useContext, useState } from 'react';
import { copyText } from '../../lib/clipboard';
import { fmtDuration } from '../../lib/format';
import { count, fill, useT } from '../../lib/i18n';
import { OwnerSession } from '../../lib/owner';
import { isCheckCommand, viewCommand } from '../../lib/steps';
import { actions, toast, useStore } from '../../lib/store';
import { openChanges } from '../ChangesView';
import { TOUCH } from '../../lib/layout';
import type { Block, Ledger } from '../../lib/timeline';
import { keepRawText } from '../contextMenu';
import { CaretRight, Check, Copy, GitBranch, Question, X } from '../icons';
import { Markdown } from './MarkdownView';

/** A command in one line as a step shows it: without the cd in front of it, which says where and not what. */
const oneLineCommand = (c: string) => {
  const flat = viewCommand(c).rest.replace(/\s+/g, ' ').trim();
  return flat.length > 56 ? `${flat.slice(0, 55)}…` : flat;
};

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
  const last = new Map<string, Ledger['runs'][number]>();
  for (const r of l.runs) if (isCheckCommand(r.command)) last.set(r.command, r);
  if (last.size) {
    out.push(
      `**Checks**\n${[...last.values()]
        .map((r) => `- ${runSymbol(r)} \`${r.command.replace(/\s+/g, ' ').trim()}\`${r.before ? ' (on the code before this change)' : r.state === 'unknown' ? ' (no verdict)' : ''}`)
        .join('\n')}`,
    );
  }
  return out.join('\n\n');
}

/** A turn's checks, the last run of each command, and what they come to in one word. */
function checksOf(l: Ledger) {
  const byCommand = new Map<string, Run>();
  for (const r of l.runs) if (isCheckCommand(r.command)) byCommand.set(oneLineCommand(r.command), r);
  const checks = [...byCommand.values()];
  const open = checks.filter((r) => r.before || r.state === 'unknown').length;
  const bad = checks.filter((r) => !r.before && r.state === 'failed').length;
  const verdict = bad
    ? { tone: 'is-bad', n: bad, one: '{n} check failed', many: '{n} checks failed' }
    : open
      ? { tone: '', n: open, one: '{n} check without a verdict', many: '{n} checks without a verdict' }
      : { tone: 'is-ok', n: checks.length, one: '{n} check passed', many: '{n} checks passed' };
  return { checks, bad, open, verdict };
}

/** Opens the turn's changes, at a file or at the first: only in the open session, whose turns have restore points. */
function useReview(turn?: string): ((file?: string) => void) | undefined {
  const session = useStore((s) => s.session?.meta.id);
  const owner = useContext(OwnerSession);
  return session && turn && (!owner || owner === session) ? (file?: string) => openChanges(session, turn, file) : undefined;
}

/**
 * The figures on a turn's line after its time and steps: the files it changed, which open its changes, and how its
 * checks came out. Nothing when it changed nothing and checked nothing.
 */
export function TurnFigures({ l, turn }: { l: Ledger; turn?: string }) {
  const t = useT();
  const review = useReview(turn);
  const { checks, bad, open, verdict } = checksOf(l);
  const added = l.files.reduce((n, f) => n + f.added, 0);
  const removed = l.files.reduce((n, f) => n + f.removed, 0);
  const files = (
    <>
      {count(t, l.files.length, '{n} file', '{n} files')} <span className="add">+{added}</span> <span className="del">−{removed}</span>
    </>
  );
  return (
    <>
      {l.files.length > 0 &&
        (review ? (
          <button type="button" className="turn-part turn-files num" onClick={() => review()} data-tip={t('View changes')}>
            {files}
          </button>
        ) : (
          <span className="turn-part num">{files}</span>
        ))}
      {checks.length > 0 && (
        <span className={`turn-part turn-check ${verdict.tone}`}>
          {bad ? <X size={12} weight="bold" /> : open ? <Question size={12} weight="bold" /> : <Check size={12} weight="bold" />}
          {count(t, verdict.n, verdict.one, verdict.many)}
        </span>
      )}
    </>
  );
}

/** What a turn took, opened: the model's time against the tools', each check with its outcome, and the turn as a commit description. */
export function TurnFacts({ l, answer }: { l: Ledger; answer: string }) {
  const t = useT();
  const { checks } = checksOf(l);
  const toolMs = Math.max(0, l.ms - l.modelMs);
  const share = (ms: number) => `${l.ms ? Math.round((ms / l.ms) * 100) : 0}%`;
  return (
    <div className="turn-facts" data-find-skip>
      <div className="turn-time">
        <div className="turn-bar" aria-hidden>
          <span className="is-model" style={{ width: share(l.modelMs) }} />
          <span className="is-tools" style={{ width: share(toolMs) }} />
        </div>
        <span className="turn-legend num">
          <span>
            <i className="turn-key is-model" />
            {t('Model')} {fmtDuration(l.modelMs)}
          </span>
          <span>
            <i className="turn-key is-tools" />
            {t('Tools')} {fmtDuration(toolMs)}
          </span>
          <span>{count(t, l.requests, '{n} request', '{n} requests')}</span>
        </span>
      </div>
      {checks.length > 0 && (
        <ul className="turn-checks">
          {checks.map((r, i) => (
            <li key={i} className={runTone(r)} data-tip={r.command}>
              <span className="turn-mark">
                <RunMark r={r} size={12} />
              </span>
              <span className="mono turn-command">{oneLineCommand(r.command)}</span>
              <span className="num turn-quiet">
                {r.before
                  ? `${t('on the old code')} · `
                  : r.state === 'unknown'
                    ? `${t('no verdict')} · `
                    : r.state === 'passed'
                      ? ''
                      : r.exit === null
                        ? `${t('did not finish')} · `
                        : r.exit === 0
                          ? `${t('printed failures')} · `
                          : `exit ${r.exit} · `}
                {fmtDuration(r.ms)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="turn-actions">
        <button type="button" className="turn-action" onClick={() => void copyText(asDescription(answer, l), t, 'Copied as a commit description')}>
          <Copy size={12} /> {t('Copy as a commit description')}
        </button>
      </div>
    </div>
  );
}

/**
 * A turn's figures under its answer, where no fold above the answer carries them (a sub-agent's sheet draws its turns
 * open): the same line, opening into the same facts.
 */
export function TurnLedger({ l, answer, turn }: { l: Ledger; answer: string; turn?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className={`turn-ledger ${open ? 'is-open' : ''}`} data-find-skip>
      <div className="turn-line">
        <button type="button" className="turn-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="num">{fill(t('Worked {n}'), fmtDuration(l.ms))}</span>
          <CaretRight size={11} className="turn-caret" />
        </button>
        <TurnFigures l={l} turn={turn} />
      </div>
      {open && <TurnFacts l={l} answer={answer} />}
    </div>
  );
}

export const Answer = memo(
  function Answer({ b }: { b: Extract<Block, { kind: 'text' }> }) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const raw = useCallback((card: HTMLDivElement | null) => keepRawText(card, b.text), [b.text]);
    // A session this window only reads cannot be branched here: the branch would be made from its file by this process.
    const readOnly = useStore((s) => !!s.session?.following);
    return (
      <div ref={raw} className={`answer ${b.final ? 'is-final' : ''} ${b.streaming ? 'is-streaming' : ''}`} data-ctx="message" data-key={b.key} data-find={b.key} tabIndex={TOUCH && b.final ? -1 : undefined}>
        {/* The key is the message's id and the part's place in it; a draft and its finished message share the id. */}
        <Markdown text={b.text} streaming={b.streaming} stamp={b.key.slice(0, b.key.lastIndexOf(':'))} />
        {b.final && b.ledger && !b.lined && <TurnLedger l={b.ledger} answer={b.text} turn={b.turn} />}
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
            {!readOnly && (
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
            )}
          </div>
        )}
      </div>
    );
  },
  (a, z) => a.b.key === z.b.key && a.b.text === z.b.text && a.b.final === z.b.final && a.b.streaming === z.b.streaming && a.b.ledger === z.b.ledger && a.b.lined === z.b.lined,
);
