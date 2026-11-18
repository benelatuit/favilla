import { useState } from 'react';
import type { PermissionRequest, QuestionRequest } from '../lib/types';
import { actions, toast } from '../lib/store';
import { renderMarkdown } from '../lib/markdown';
import { useT } from '../lib/i18n';
import { guardReason } from '@favilla/core/guard/i18n';
import { MailSheet, splitPreview } from './MailSheet';
import { Check, Compass, EnvelopeSimple, PaperPlaneTilt, Question, Warning } from './icons';

/**
 * The choice that was pressed, until the engine takes it and the prompt goes: the pressed button stays down, the
 * others stop answering, and a second click sends nothing. A failed send gives the choice back.
 */
function useChoice(send: (choice: string) => unknown) {
  const [held, setHeld] = useState<string | null>(null);
  const choose = (choice: string) => {
    if (held !== null) return;
    setHeld(choice);
    Promise.resolve(send(choice)).catch((e) => {
      setHeld(null);
      toast(String(e), 'error');
    });
  };
  const button = (choice: string, kind = '') => ({
    type: 'button' as const,
    className: `btn ${kind} ${held === choice ? 'is-held' : ''}`,
    disabled: held !== null && held !== choice,
    onClick: () => choose(choice),
  });
  return { button, held };
}

/** An email about to be sent, laid out as one: its headers, then what it says, and the choice to send it. */
function MailPrompt({ req, button }: { req: PermissionRequest; button: ReturnType<typeof useChoice>['button'] }) {
  const t = useT();
  const { head, body } = splitPreview(req.detail);
  return (
    <section className="prompt is-mail" aria-live="assertive" role="alert">
      <header>
        <EnvelopeSimple size={16} weight="fill" />
        <strong>{t('Send this email?')}</strong>
        <span className="prompt-reason">{t('Once sent, an email cannot be taken back.')}</span>
      </header>
      <MailSheet head={head} body={body} />
      <div className="prompt-actions">
        <button {...button('allow', 'btn-primary')}>
          <PaperPlaneTilt size={14} /> {t('Send')}
        </button>
        <button {...button('allow_session')}>
          {t('Send without asking in this session')}
        </button>
        <button {...button('deny', 'btn-quiet')}>
          {t("Don't send")}
        </button>
      </div>
    </section>
  );
}

export function PermissionPrompt({ req }: { req: PermissionRequest }) {
  const t = useT();
  const { button } = useChoice((d) => actions.permission(req.id, d));
  if (req.rule === 'mail.send') return <MailPrompt req={req} button={button} />;
  return (
    <section className="prompt is-warn" aria-live="assertive" role="alert">
      <header>
        <Warning size={16} weight="fill" />
        <strong>{t('Confirm command')}</strong>
        <span className="prompt-reason">{guardReason(t, req.reason)}</span>
      </header>
      <pre className="plate plain mono">{req.detail}</pre>
      <div className="prompt-actions">
        <button {...button('allow', 'btn-primary')}>
          {t('Run once')}
        </button>
        {!req.once && (
          <button {...button('allow_session')}>
            {t('Allow for this session')}
          </button>
        )}
        <button {...button('deny', 'btn-quiet')}>
          {t("Don't run")}
        </button>
      </div>
    </section>
  );
}

export function QuestionPrompt({ req }: { req: QuestionRequest }) {
  const t = useT();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const { button, held } = useChoice((choice) =>
    actions.answer(req.id, choice === 'skip' ? null : Object.fromEntries(Object.entries(answers).map(([question, choices]) => [question, choices.join(', ')]))),
  );
  const complete = req.questions.every((q) => answers[q.question]?.some((answer) => answer.trim()));
  const toggle = (q: QuestionRequest['questions'][number], label: string) => {
    setAnswers((a) => {
      if (!q.multiSelect) return { ...a, [q.question]: [label] };
      const cur = (a[q.question] ?? []).filter(Boolean);
      return { ...a, [q.question]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
    });
  };
  return (
    <section className="prompt" aria-live="polite">
      {req.questions.map((q) => (
        <div key={q.question} className="question">
          <header>
            <Question size={16} />
            <strong>{q.header ? `${q.header}: ` : ''}</strong>
            <span>{q.question}</span>
          </header>
          <div className="options">
            {q.options.map((o) => {
              const chosen = answers[q.question]?.includes(o.label) ?? false;
              return (
                <button type="button" key={o.label} className={`option ${chosen ? 'is-chosen' : ''}`} onClick={() => toggle(q, o.label)}>
                  <span className="option-mark">{chosen && <Check size={12} weight="bold" />}</span>
                  <span className="option-label">{o.label}</span>
                  {o.description && <span className="option-desc">{o.description}</span>}
                </button>
              );
            })}
            <label className="option other">
              <span className="option-mark" />
              <input
                type="text"
                placeholder={t('Something else')}
                value={other[q.question] ?? ''}
                onChange={(e) => {
                  setOther((x) => ({ ...x, [q.question]: e.target.value }));
                  setAnswers((a) => ({ ...a, [q.question]: [e.target.value] }));
                }}
              />
            </label>
          </div>
        </div>
      ))}
      <div className="prompt-actions">
        <button {...button('submit', 'btn-primary')} disabled={!complete || (held !== null && held !== 'submit')}>
          {t('Submit')}
        </button>
        <button {...button('skip', 'btn-quiet')}>
          {t('Skip, let the agent decide')}
        </button>
      </div>
    </section>
  );
}

export function PlanPrompt({ id, plan }: { id: string; plan: string }) {
  const t = useT();
  const [feedback, setFeedback] = useState('');
  const [asking, setAsking] = useState(false);
  return (
    <section className="prompt">
      <header>
        <Compass size={16} />
        <strong>{t('Plan ready for review')}</strong>
      </header>
      <div className="md plan-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }} />
      {asking && <textarea className="feedback" placeholder={t('What should change?')} value={feedback} onChange={(e) => setFeedback(e.target.value)} autoFocus />}
      <div className="prompt-actions">
        <button type="button" className="btn btn-primary" onClick={() => actions.plan(id, true)}>
          {t('Approve and build')}
        </button>
        <button type="button" className="btn" onClick={() => (asking ? actions.plan(id, false, feedback.trim() || undefined) : setAsking(true))}>
          {t('Keep planning')}
        </button>
      </div>
    </section>
  );
}
