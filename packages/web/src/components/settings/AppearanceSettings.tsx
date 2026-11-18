import { setLayout, useLayoutChoice } from '../../lib/layout';
import { useT } from '../../lib/i18n';
import { Group, Page, Row, Segmented } from './Rows';
import { ThemePanel } from './ThemePicker';

/** How Favilla looks: the theme, drawn large with the palettes under it, and the layout on a phone. */
export function AppearanceSettings() {
  const t = useT();
  const layout = useLayoutChoice();
  return (
    <Page title={t('Appearance')}>
      <Group title={t('Theme')}>
        <ThemePanel />
      </Group>
      <Group>
        <Row
          id="phone-layout"
          label={t('Layout on a phone')}
          note={
            layout === 'simple'
              ? t('Simple: the sessions as a list, one conversation at a time, the model and effort in the composer. Kept on this device.')
              : t('Full: the window as on a computer, the sidebar and side panel opened as drawers. Kept on this device.')
          }
          control={<Segmented value={layout} options={[['simple', t('Simple')], ['full', t('Full')]]} onChange={setLayout} label={t('Layout on a phone')} />}
        />
      </Group>
    </Page>
  );
}
