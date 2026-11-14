import { setUi, useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Bug, GitDiff, MapTrifold, Warning, Wrench } from './icons';
import { Composer, compose } from './Composer';
import { FolderSwitcher } from './Folders';

const STARTERS = [
  { icon: MapTrifold, label: 'Explain how this project is put together', prompt: 'Explain how this project is put together: the main parts, how they connect, and where to start reading.' },
  { icon: Bug, label: 'Find why the tests fail and fix it', prompt: 'Run the tests, find out why any of them fail, and fix the cause.' },
  { icon: GitDiff, label: 'Review my uncommitted changes', prompt: 'Review my uncommitted changes: point out bugs, risky spots and anything I missed. Do not change files.' },
  { icon: Wrench, label: 'Make the build pass', prompt: 'Run the build and the type check, and fix what fails.' },
];

/** No session open: the folder, a composer, and a few ways to start. Sending creates the session. */
export function Welcome() {
  const t = useT();
  const providers = useStore((s) => s.providers);
  const ready = providers.some((p) => p.configured && p.models.length);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>{t('What are we working on?')}</h1>
        <FolderSwitcher variant="welcome" />
        {!ready && (
          <div className="welcome-notice" role="status">
            <Warning size={16} weight="fill" />
            <span>{t('No model is set up yet. Add an API key or a model server on this computer to start.')}</span>
            <button type="button" className="btn is-small btn-primary" onClick={() => setUi({ settings: 'providers' })}>
              {t('Set up a provider')}
            </button>
          </div>
        )}
        <Composer variant="hero" />
        <div className="starters" role="list">
          {STARTERS.map(({ icon: Icon, label, prompt }) => (
            <button key={label} type="button" role="listitem" className="starter" onClick={() => compose(t(prompt))}>
              <Icon size={16} />
              <span>{t(label)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
