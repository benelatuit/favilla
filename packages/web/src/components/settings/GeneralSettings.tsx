import { useStore } from '../../lib/store';
import { useT } from '../../lib/i18n';
import { LANGUAGES, LANGUAGE_NAMES } from '@favilla/core/i18n';
import { Select } from '../ui/Select';
import { Group, Page, Row, Segmented, useSetConfig } from './Rows';
import { UpdateGroup } from './UpdateGroup';

/** The memory mode this window started with (it changes only at the next start). */
let startedLowMemory: boolean | undefined;

/** What everyone sets once: the language, how Favilla draws, how its answers are laid out, whether destructive commands wait for a yes, and updates. How it looks has a page of its own. */
export function GeneralSettings() {
  const t = useT();
  const info = useStore((s) => s.info);
  const set = useSetConfig();
  if (!info) return null;
  startedLowMemory ??= info.config.lowMemory;
  const guard = info.config.guard;
  // Set from the command line, refusing stays a choice while it is the one in force, as in the composer.
  const guards: [string, string][] = [
    ['confirm', t('Ask first')],
    ['off', t('Full access')],
    ...(guard === 'block' ? [['block', t('Refuse')] as [string, string]] : []),
  ];
  return (
    <Page title={t('General')}>
      <Group>
        <Row
          id="language"
          label={t('Language')}
          control={
            <Select
              value={info.config.language || 'auto'}
              options={[{ value: 'auto', label: t('Follow the system') }, ...LANGUAGES.map((value) => ({ value, label: LANGUAGE_NAMES[value] }))]}
              onChange={(v) => set({ language: v })}
              className="is-field"
            />
          }
        />
        <Row
          id="memory"
          label={t('Rendering')}
          note={info.config.lowMemory !== startedLowMemory ? t('Takes effect the next time Favilla starts.') : undefined}
          control={
            <Select
              value={info.config.lowMemory ? 'low' : 'normal'}
              options={[
                { value: 'normal', label: t('Draw with the graphics card'), hint: t('Smoothest') },
                { value: 'low', label: t('Low-memory mode'), hint: t('About 90 MB less; animations may be less smooth') },
              ]}
              onChange={(v) => set({ 'desktop.hardwareAcceleration': v !== 'low' })}
              className="is-field"
            />
          }
        />
      </Group>
      <Group title={t('Answers')}>
        <Row
          id="answer-format"
          label={t('Answer format')}
          note={info.config.answerFormat === 'plain' ? t('Short paragraphs only, no tables or headings. Applies to new conversations.') : t('Headings, lists and tables where the content calls for them. Applies to new conversations.')}
          control={
            <Segmented
              value={info.config.answerFormat ?? 'structured'}
              options={[
                ['structured', t('Structured')],
                ['plain', t('Plain')],
              ]}
              onChange={(v) => set({ answerFormat: v })}
              label={t('Answer format')}
            />
          }
        />
      </Group>
      <Group title={t('Safety')}>
        <Row
          id="permissions"
          label={t('Permissions')}
          note={guard === 'off' ? t('Every command runs without asking, in every session') : guard === 'block' ? t('Destructive commands are refused, in every session') : t('Deleting folders, discarding git work, force pushes, system changes and publishing wait for a yes.')}
          warn={guard === 'off'}
          control={<Segmented value={guard} options={guards} onChange={(v) => set({ 'guard.mode': v })} label={t('Permissions')} />}
        />
      </Group>
      <UpdateGroup />
    </Page>
  );
}
