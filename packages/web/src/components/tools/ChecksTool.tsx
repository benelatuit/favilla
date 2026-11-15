import { absolutePath } from '../../lib/desktop';
import { fmtDuration } from '../../lib/format';
import { count, fill, useT } from '../../lib/i18n';
import type { CheckResult, ToolDisplay } from '../../lib/types';
import { CheckCircle, WarningCircle } from '../icons';

const CHECK_LABEL: Record<string, string> = { types: 'Types', lint: 'Lint', test: 'Tests', build: 'Build' };

const VERDICT: Record<'catches' | 'pass-before' | 'no-build', string> = {
  catches: 'The tests in {n} fail on the code before the change and pass now: they catch the fix.',
  'pass-before': 'The tests in {n} pass on the code before the change too: they do not catch the fix.',
  'no-build': 'The tests in {n} do not build on the code before the change: they use what it adds.',
};

/** The project's checks: each with its command and time, and for a failure the lines that say why. */
export function ChecksView({ results, found, cwd }: { results: CheckResult[]; found: string[]; cwd: string }) {
  const t = useT();
  if (!results.length) {
    return (
      <div className="step-note">
        {found.length ? `${t('This project has')}: ${found.map((n) => t(CHECK_LABEL[n] ?? n)).join(', ')}` : t('No checks found in this project.')}
      </div>
    );
  }
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

export function ChecksResultView({ d, cwd }: { d: Extract<ToolDisplay, { kind: 'checks' }>; cwd: string }) {
  const t = useT();
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
}

export function AttemptsView({ d }: { d: Extract<ToolDisplay, { kind: 'attempts' }> }) {
  const t = useT();
  return (
    <div className="attempts plate">
      {d.attempts.map((a) => (
        <div key={a.n} className={`attempt-row ${a.chosen ? 'is-chosen' : ''}`}>
          <span className="attempt-n num">#{a.n}</span>
          <span className={`attempt-checks num ${a.failed ? 'del' : a.passed ? 'add' : ''}`}>
            {a.note ? t('no change') : fill(t('{n} checks passed'), `${a.passed}/${a.passed + a.failed}`)}
          </span>
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
}
