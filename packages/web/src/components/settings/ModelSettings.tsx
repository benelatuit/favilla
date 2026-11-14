import { useState } from 'react';
import { actions, settingSaveError, toast, useStore } from '../../lib/store';
import { fill, useT } from '../../lib/i18n';
import type { Effort } from '../../lib/types';
import { EFFORTS } from '../../lib/modes';
import { ModelPicker } from '../ModelPicker';
import { Select } from '../ui/Select';
import { Group, Page, Row, sep, useSetConfig, useSettingDraft, useSettingsNav } from './Rows';

const COMPACT_MARKS = [0.6, 0.7, 0.82, 0.9];

/** A model's context window and whether it reads pictures, where the provider's word is not the one wanted. */
function PerModel() {
  const t = useT();
  const info = useStore((s) => s.info);
  const providers = useStore((s) => s.providers);
  const [ref, setRef] = useState(info?.config.model ?? '');
  const model = providers.flatMap((p) => p.models).find((m) => m.ref === ref);
  const windows = info?.config.windows ?? [];
  const shown = windows.find((w) => w.ref === ref)?.contextWindow ?? model?.contextWindow;
  const basisOf = (ref: string) => providers.find((p) => p.id === ref.split('/')[0])?.basis;
  const value = useSettingDraft(shown ? String(shown) : '', basisOf(ref));
  const reload = async () => { await actions.loadSettings(); value.clear(); };
  if (!info) return null;
  const n = Number(value.value);
  const valid = Number.isFinite(n) && n >= 4096;
  const saved = () => actions.loadProviders().then(() => toast(t('Saved'), 'info'));
  const saveWindow = (r: string, contextWindow: number | null, basis = basisOf(r)) =>
    actions
      .setConfig({ windows: [{ ref: r, contextWindow }] }, basis)
      .then(saved)
      .then(value.saved)
      .catch((e) => settingSaveError(e, reload));
  const visionSet = (info.config.visions ?? []).find((v) => v.ref === ref)?.vision;
  const saveVision = (r: string, vision: boolean | null) =>
    actions
      .setConfig({ visions: [{ ref: r, vision }] }, basisOf(r))
      .then(saved)
      .catch((e) => settingSaveError(e, reload));
  return (
    <Group title={t('Per model')} note={t('Where the provider’s numbers are not the ones you want.')}>
      <Row id="window-model" label={t('Model')} control={<ModelPicker value={ref} onPick={(ref) => { value.clear(); setRef(ref); }} placement="bottom-end" className="is-field" />} />
      <Row
        id="context-window"
        label={t('Context window')}
        note={model ? fill(t(model.windowAssumed ? 'The provider does not state this model’s window. Favilla assumes {n} tokens.' : 'The provider gives this model {n} tokens.'), (model.nativeWindow ?? model.contextWindow).toLocaleString()) : undefined}
        control={
          <div className="field-row">
            <input type="number" className="set-input num" inputMode="numeric" min={4096} step={1000} value={value.value} aria-label={t('Tokens')} onChange={(e) => value.change(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && valid && n !== Number(value.initial) && saveWindow(ref, n, value.basis)} />
            <button type="button" className="btn" disabled={!ref || !valid || n === Number(value.initial)} onClick={() => saveWindow(ref, n, value.basis)}>
              {t('Save')}
            </button>
          </div>
        }
      />
      {model && (
        <Row
          id="vision"
          label={t('Reads pictures')}
          control={
            <Select
              value={visionSet === undefined ? 'auto' : visionSet ? 'yes' : 'no'}
              options={[
                { value: 'auto', label: visionSet === undefined ? fill(t('As known: {n}'), model.vision ? t('reads them') : t('reads none')) : t('As known'), hint: t('From the provider and models.dev') },
                { value: 'yes', label: t('It reads pictures'), hint: t('Pictures and screenshots go to it') },
                { value: 'no', label: t('It reads none'), hint: t('Pictures are described as left out') },
              ]}
              onChange={(v) => saveVision(ref, v === 'auto' ? null : v === 'yes')}
              className="is-field"
            />
          }
        />
      )}
      {windows.length > 0 && (
        <Row id="windows-set" label={t('Set by hand')} stack>
          <ul className="overrides">
            {windows.map((w) => (
              <li key={w.ref}>
                <span className="mono">{w.ref}</span>
                <span className="num">{w.contextWindow.toLocaleString()}</span>
                <button type="button" className="link" onClick={() => saveWindow(w.ref, null)}>
                  {t('Use the provider’s number')}
                </button>
              </li>
            ))}
          </ul>
        </Row>
      )}
    </Group>
  );
}

/** Settings > Models: what new sessions start with, and how much of the conversation the model sees. */
export function ModelSettings() {
  const t = useT();
  const info = useStore((s) => s.info);
  const ready = useStore((s) => s.providers.some((p) => p.configured && p.models.length));
  const { go } = useSettingsNav();
  const set = useSetConfig();
  if (!info) return null;
  const c = info.config;
  const mark = c.compactAt;
  const marks = COMPACT_MARKS.includes(mark) ? COMPACT_MARKS : [...COMPACT_MARKS, mark].sort();
  const shadow = t('In a Go project, a model of another family writes tests from the request alone.');
  return (
    <Page
      title={t('Models')}
      // With nothing to choose from yet, the page says where models come from.
      lede={ready ? undefined : t('No model is set up yet. Add an API key or a model server on this computer to start.')}
      action={
        ready ? undefined : (
          <button type="button" className="link" onClick={() => go('providers')}>
            {t('Set up a provider')}
          </button>
        )
      }
    >
      <Group title={t('Defaults')} note={t('For the first session and the command line. After that, a new session starts with the model and effort you used last.')}>
        <Row id="model" label={t('Model')} control={<ModelPicker value={c.model ?? ''} onPick={(ref) => set({ model: ref })} placement="bottom-end" className="is-field" />} />
        <Row id="effort" label={t('Reasoning effort')} control={<Select<Effort> value={c.effort ?? 'high'} options={EFFORTS.map((e) => ({ value: e, label: e }))} onChange={(e) => set({ effort: e })} className="is-field" />} />
        <Row
          id="subagent-model"
          label={t('Sub-agent model')}
          note={
            c.subagentModel ? (
              <button type="button" className="link" onClick={() => set({ subagentModel: '' })}>
                {t("Use the session's model")}
              </button>
            ) : (
              t("The session's own model, unless you ask for another in a message.")
            )
          }
          control={<ModelPicker value={c.subagentModel || c.model || ''} onPick={(ref) => set({ subagentModel: ref })} placement="bottom-end" className="is-field" />}
        />
        <Row
          id="shadow-tests"
          label={t('Shadow tests')}
          note={
            <>
              {shadow}
              {sep(shadow)}
              {c.shadowModel ? (
                <button type="button" className="link" onClick={() => set({ 'shadowTests.model': '' })}>
                  {t('Turn off')}
                </button>
              ) : (
                t('Off until you pick a model.')
              )}
            </>
          }
          control={<ModelPicker value={c.shadowModel ?? ''} onPick={(ref) => set({ 'shadowTests.model': ref })} placement="bottom-end" className="is-field" />}
        />
      </Group>
      <Group title={t('Context')} note={t('Changes apply to open sessions at once.')}>
        <Row
          id="compact-at"
          label={t('Compact when the context reaches')}
          note={t('From half the window on, old tool output is cut to stubs the model can recall.')}
          control={
            <Select
              value={String(mark)}
              options={marks.map((v) => ({ value: String(v), label: `${Math.round(v * 100)}%`, hint: v === 0.82 ? t('Default') : undefined }))}
              onChange={(v) => set({ 'context.compactAt': Number(v) })}
              className="is-field"
            />
          }
        />
      </Group>
      <PerModel />
    </Page>
  );
}
