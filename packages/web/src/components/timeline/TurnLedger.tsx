import { memo, useCallback, useState } from 'react';
import { copyText } from '../../lib/clipboard';
import { fmtDuration } from '../../lib/format';
import { count, useT } from '../../lib/i18n';
import { isCheckCommand, viewCommand } from '../../lib/steps';
import { actions, toast } from '../../lib/store';
import type { Block, Ledger } from '../../lib/timeline';
import { keepRawText } from '../contextMenu';
import { CaretRight, Check, Copy, FileText, GitBranch, Question, Timer, X } from '../icons';
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

export function TurnLedger({ l, answer }: { l: Ledger; answer: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const byCommand = new Map<string, Run>();
  for (const r of l.runs) if (isCheckCommand(r.command)) byCommand.set(oneLineCommand(r.command), r);
  const checks = [...byCommand.values()];
  const open_ = checks.filter((r) => r.before || r.state === 'unknown').length;
  const bad = checks.filter((r) => !r.before && r.state === 'failed').length;
  const verdict = bad
    ? { tone: 'is-bad', n: bad, one: '{n} check failed', many: '{n} checks failed' }
    : open_
      ? { tone: '', n: open_, one: '{n} check without a verdict', many: '{n} checks without a verdict' }
      : { tone: 'is-ok', n: checks.length, one: '{n} check passed', many: '{n} checks passed' };
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
          <button type="button" className="ledger-copy" onClick={() => void copyText(asDescription(answer, l), t, 'Copied as a commit description')}>
            <Copy size={12} /> {t('Copy as a commit description')}
          </button>
        </div>
      )}
    </div>
  );
}

export const Answer = memo(
  function Answer({ b }: { b: Extract<Block, { kind: 'text' }> }) {
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
  },
  (a, z) => a.b.key === z.b.key && a.b.text === z.b.text && a.b.final === z.b.final && a.b.streaming === z.b.streaming && a.b.ledger === z.b.ledger,
);
