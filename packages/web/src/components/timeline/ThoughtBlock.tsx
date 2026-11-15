import { memo } from 'react';
import { foldKey, useFoldOpen } from '../../lib/fold-state';
import { fill, useT } from '../../lib/i18n';
import { CaretRight, Lightbulb } from '../icons';
import { useSessionScope } from '../tools/SessionScope';
import { Markdown } from './MarkdownView';

export function thoughtTitle(text: string): string {
  const bold = /^\s*\*\*(.+?)\*\*/.exec(text)?.[1];
  const flat = (bold ?? text).replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

export const Thought = memo(function Thought({ id, text, live }: { id: string; text: string; live?: boolean }) {
  const t = useT();
  const { sessionId } = useSessionScope();
  const [open, toggleOpen] = useFoldOpen(sessionId, foldKey.thought(id), false);
  const title = live ? thoughtTitle(text.split(/\n\n(?=\*\*)/).pop() ?? text) : thoughtTitle(text);
  if (!title) return null;
  return (
    <div className={`step thought ${open ? 'is-open' : ''} ${live ? 'is-running' : ''}`} data-find={id}>
      <button type="button" className="step-head" onClick={toggleOpen} aria-expanded={open}>
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
        <span className="step-end" data-find-skip />
        <CaretRight size={11} className="step-caret" />
      </button>
      {open && (
        <div className="step-body">
          <Markdown text={text} className="thought-text" />
        </div>
      )}
    </div>
  );
});

/** Several thoughts in a row read as one: the latest one's title and how many there were, each one a click away. */
export const ThoughtRun = memo(
  function ThoughtRun({ texts, keys }: { texts: string[]; keys: string[] }) {
    const t = useT();
    const { sessionId } = useSessionScope();
    const [open, , setOpen] = useFoldOpen(sessionId, keys[0] ? foldKey.thoughtRun(keys[0]) : undefined, false);
    const titles = texts.map((x) => thoughtTitle(x)).filter(Boolean);
    if (!titles.length) return null;
    if (open) {
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
    }
    return (
      <div className="step thought">
        <button type="button" className="step-head" onClick={() => setOpen(true)} aria-expanded={false}>
          <span className="step-icon">
            <Lightbulb size={16} />
          </span>
          <span className="step-verb" data-find-skip>
            {t('Thinking')}
          </span>
          <span className="step-target is-thought">{titles[titles.length - 1]}</span>
          <span className="step-meta num" data-find-skip>
            {fill(t('{n} thoughts'), titles.length)}
          </span>
          <CaretRight size={11} className="step-caret" />
        </button>
      </div>
    );
  },
  (a, b) => a.keys.length === b.keys.length && a.keys.every((k, i) => k === b.keys[i] && a.texts[i] === b.texts[i]),
);
