import type { ToolDisplay } from '../lib/types';
import { desktop } from '../lib/desktop';
import { useT } from '../lib/i18n';
import { toast } from '../lib/store';
import { Check } from './icons';
import { Pen } from './Pen';

export type StagesDisplay = Extract<ToolDisplay, { kind: 'stages' }>;

/** A figure's words with its numbers put in: '{n} found, {m} after repeats'. */
export function figureText(template: string, n: number | string, m?: number | string): string {
  return template.replace('{n}', String(n)).replace('{m}', m === undefined ? '' : String(m));
}

/** The card a call shows: the one it sent last while it runs, its result's once it is done. */
export function stagesOf(result?: ToolDisplay, running?: ToolDisplay): StagesDisplay | undefined {
  if (result) return result.kind === 'stages' ? result : undefined;
  return running?.kind === 'stages' ? running : undefined;
}

/**
 * Long work in stages, under its title: while it runs, the stages with their counts and the one at work lit; then
 * what came of it in figures, and the files it wrote. What it found is read in those files, never here. `halted`:
 * the work no longer goes on (stopped, or cut off), so the stage it reached is marked without the pen.
 */
export function Stages({ display, halted }: { display: StagesDisplay; halted?: boolean }) {
  const t = useT();
  const running = display.stages.some((s) => s.state !== 'done');
  const open = (p: string) => (desktop ? desktop.openPath(p).then((e) => e && toast(e, 'error')) : toast(p, 'info'));
  const files = display.files ?? [];
  return (
    <>
      {running && (
        <ol className="stages" aria-label={t('Stages')}>
          {display.stages.map((s) => (
            <li key={s.label} className={s.state === 'on' ? (halted ? 'is-halted' : 'is-on') : s.state === 'done' ? 'is-done' : ''}>
              {s.state === 'done' ? <Check size={11} weight="bold" /> : s.state === 'on' && !halted ? <Pen /> : null}
              <span>{t(s.label)}</span>
              {s.of !== undefined && <span className="num">{`${s.done ?? 0}/${s.of}`}</span>}
            </li>
          ))}
        </ol>
      )}
      {(display.figures.length > 0 || files.length > 0 || !!display.note) && (
        <div className="stages-line">
          {display.figures.map((f) => (
            <span key={f.label} className={f.tone === 'good' ? 'num is-good' : 'num'}>
              {figureText(t(f.label), f.n, f.m)}
            </span>
          ))}
          {display.note && <span>{t(display.note)}</span>}
          {files.map((f) => (
            <button key={f.path} type="button" className="link" onClick={() => void open(f.path)}>
              {t(f.label)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
