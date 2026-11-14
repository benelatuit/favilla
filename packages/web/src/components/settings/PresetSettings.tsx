import type { SettingBasis } from '@favilla/core/types';
import { useRef, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { confirmDialog, settingSaveError, toast, useStore } from '../../lib/store';
import { fill, useT } from '../../lib/i18n';
import { ArrowUp, FilePlus, Trash } from '../icons';
import { Select } from '../ui/Select';
import { DetailFoot, Group, Item, LoadError, Loading, Page, PathNote, Row, sep, useView, useSettingDraft } from './Rows';

type Scope = 'global' | 'workspace';

interface Entry {
  id: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  enabled: boolean;
  /** Where it goes: the system prompt, ahead of the chat, behind it, or inside it. */
  layer: 'system' | 'before' | 'after' | 'depth';
  depth?: number;
  order?: number;
}

interface Preset {
  basis?: SettingBasis;
  name: string;
  entries: Entry[];
  prefill?: string;
  user?: string;
  char?: string;
}

type Choice = { use: 'global' } | { use: 'none' } | { use: 'library'; name: string } | { use: 'own'; name: string };

interface View {
  folder: string;
  global: { dir: string; use: string | null; items: Preset[]; basis?: SettingBasis };
  workspace: { dir: string; use: Choice; items: Preset[]; basis?: SettingBasis };
  active: { name: string; scope: Scope } | null;
}

interface Report {
  entries: number;
  off: number;
  markers: string[];
  macros: string[];
  blank: string[];
}

function EntryRow({ e, onToggle }: { e: Entry; onToggle: (on: boolean) => void }) {
  const t = useT();
  const where = e.layer === 'depth' ? fill(t('Depth {n}'), String(e.depth ?? 0)) : t({ system: 'System prompt', before: 'Before the chat', after: 'After the chat' }[e.layer]);
  return (
    <li className={e.enabled ? 'preset-entry' : 'preset-entry is-off'}>
      <input type="checkbox" checked={e.enabled} aria-label={e.name} onChange={(ev) => onToggle(ev.target.checked)} />
      <details>
        <summary>
          <span className="preset-entry-name">{e.name}</span>
          <span className="mono muted preset-entry-at">
            {e.role} · {where}
            {e.layer === 'depth' ? ` · ${fill(t('order {n}'), String(e.order ?? 100))}` : ''}
          </span>
        </summary>
        <pre className="preset-entry-text mono">{e.content}</pre>
      </details>
    </li>
  );
}

/** The names the macros fill in, the prefill, and each prompt with where it goes. */
function PresetDetail({ preset, save }: { preset: Preset; save: (patch: Record<string, unknown>, basis?: SettingBasis) => Promise<boolean> }) {
  const t = useT();
  const user = useSettingDraft(preset.user ?? '', preset.basis);
  const char = useSettingDraft(preset.char ?? '', preset.basis);
  const prefill = useSettingDraft(preset.prefill ?? '', preset.basis);
  const commit = async (key: string, field: typeof user) => {
    if (field.value === field.initial || await save({ [key]: field.value }, field.basis)) field.saved();
  };
  return (
    <div className="set-form">
      <div className="field-grid">
        <label className="field">
          <span className="mono">{'{{user}}'}</span>
          <input value={user.value} placeholder="User" onChange={(e) => user.change(e.target.value)} onBlur={() => commit('user', user)} />
        </label>
        <label className="field">
          <span className="mono">{'{{char}}'}</span>
          <input value={char.value} placeholder="Assistant" onChange={(e) => char.change(e.target.value)} onBlur={() => commit('char', char)} />
        </label>
      </div>
      <label className="field">
        <span>{t('Prefill')}</span>
        <textarea className="rule-text mono preset-prefill" spellCheck={false} rows={2} value={prefill.value} onChange={(e) => prefill.change(e.target.value)} onBlur={() => commit('prefill', prefill)} />
      </label>
      <p className="set-note">{t('Where the model can, it continues from this text. Models that cannot are asked to begin with it, which includes every model that thinks first.')}</p>
      <ul className="preset-entries">
        {preset.entries.map((e) => (
          <EntryRow key={e.id} e={e} onToggle={(enabled) => save({ entries: [{ id: e.id, enabled }] }, preset.basis)} />
        ))}
      </ul>
    </div>
  );
}

function ReportNote({ report }: { report: Report }) {
  const t = useT();
  return (
    <p className="set-note">
      {fill(t('Read {n} prompts.'), String(report.entries))}
      {report.off > 0 && ` ${fill(t('{n} of them are off, as in the preset.'), String(report.off))}`}
      {report.markers.length > 0 && ` ${fill(t('Left out, with no character card here: {n}.'), report.markers.join(', '))}`}
      {report.blank.length > 0 && ` ${fill(t('Empty, with no character card: {n}.'), report.blank.map((m) => `{{${m}}}`).join(' '))}`}
      {report.macros.length > 0 && ` ${fill(t('Not understood, sent as written: {n}.'), report.macros.map((m) => `{{${m}}}`).join(' '))}`}
    </p>
  );
}

/** A list of presets, each opened to edit its names, prefill and prompts. `extra` adds buttons to a row. */
function PresetList({ items, scope, call, extra }: { items: Preset[]; scope: Scope; call: (action: string, body: Record<string, unknown>) => Promise<boolean>; extra?: (p: Preset) => ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const remove = async ({ name, basis }: Preset) => {
    if (await confirmDialog({ title: fill(t('Delete {n}?'), name), body: t('Sessions that use it keep their own copy.'), confirm: t('Delete'), cancel: t('Cancel'), danger: true })) await call('delete', { scope, name, basis });
  };
  return (
    <>
      {items.map((p) => (
        <Item key={p.name} name={<bdi>{p.name}</bdi>} state={<span className="num">{fill(t('{n} prompts'), String(p.entries.length))}</span>} open={open === p.name} onToggle={() => setOpen(open === p.name ? null : p.name)} end={extra?.(p)}>
          <PresetDetail preset={p} save={(patch, basis) => call('update', { scope, name: p.name, patch, basis })} />
          <DetailFoot
            danger={
              <button type="button" className="link is-danger" onClick={() => remove(p)}>
                <Trash size={14} /> {t('Delete')}
              </button>
            }
          />
        </Item>
      ))}
    </>
  );
}

/**
 * Settings > Presets: SillyTavern presets in one library, which each folder picks from by name, so a preset is
 * imported once and no folder keeps a copy. Copies folders kept before are listed with a way into the library.
 */
export function PresetSettings() {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const session = useStore((s) => s.session);
  const { view, error, setView, reload } = useView<View>(`/presets?cwd=${encodeURIComponent(folder)}`);
  const [report, setReport] = useState<Report | null>(null);
  const [loaded, setLoaded] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const lede = t('SillyTavern chat-completion presets. Favilla reads their prompts and prefill, and nothing else in the file.');
  if (!view)
    return (
      <Page title={t('Presets')} lede={lede}>
        {error ? <LoadError error={error} retry={reload} /> : <Loading />}
      </Page>
    );
  const call = async (action: string, body: Record<string, unknown>) => {
    try {
      const basis = action === 'use' ? (body.scope === 'workspace' ? view.workspace.basis : view.global.basis) : body.basis;
      const v = await api<View & { report?: Report }>(`/presets/${action}`, { body: { scope: 'global', cwd: folder, ...body, basis } });
      setView(v);
      setReport(v.report ?? null);
      return true;
    } catch (e) {
      settingSaveError(e, () => { setLoaded((n) => n + 1); reload(); });
      return false;
    }
  };
  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (picker.current) picker.current.value = '';
    if (file) await call('import', { name: file.name, text: await file.text() });
  };
  const apply = async () => {
    if (!session) return;
    try {
      await api(`/sessions/${session.meta.id}/reload-rules`, { body: {} });
      toast(t('The open session now follows the saved rules.'), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const names = view.global.items.map((p) => ({ value: `lib:${p.name}`, label: p.name }));
  const own = view.workspace.items;
  const here = view.workspace.use;
  const missing = here.use === 'library' && !view.global.items.some((p) => p.name === here.name);
  const hereValue = here.use === 'library' ? (missing ? 'global' : `lib:${here.name}`) : here.use === 'own' ? `own:${here.name}` : here.use;
  const hereOptions = [
    { value: 'global', label: fill(t('Follow the default ({n})'), view.global.use ?? t('none')) },
    { value: 'none', label: t('No preset here') },
    ...names,
    ...own.map((p) => ({ value: `own:${p.name}`, label: fill(t('{n} (this folder’s copy)'), p.name) })),
  ];
  const chooseHere = (v: string) => (v.startsWith('lib:') ? call('use', { scope: 'workspace', use: 'library', name: v.slice(4) }) : v.startsWith('own:') ? call('use', { scope: 'workspace', use: 'own', name: v.slice(4) }) : call('use', { scope: 'workspace', use: v }));
  const kept = t('A session keeps the preset it started with; sub-agents have none.');
  return (
    <Page title={t('Presets')} lede={lede}>
      <Group
        foot={
          <p className="set-note">
            {kept}
            {session && sep(kept)}
            {session && (
              <button type="button" className="link" onClick={apply}>
                {t('Apply to the open session now')}
              </button>
            )}
          </p>
        }
      >
        <Row id="preset-here" label={t('This folder uses')} control={<Select value={hereValue} options={hereOptions} onChange={chooseHere} className="is-field" />} />
        <Row id="preset-default" label={t('Default for other folders')} control={<Select value={view.global.use ? `lib:${view.global.use}` : 'none'} options={[{ value: 'none', label: t('No preset') }, ...names]} onChange={(v) => call('use', { name: v.startsWith('lib:') ? v.slice(4) : '' })} className="is-field" />} />
      </Group>
      <Group
        id="preset-library"
        title={t('Preset library')}
        foot={
          <>
            {report && <ReportNote report={report} />}
            <PathNote label={t('Kept in')} path={view.global.dir} />
          </>
        }
      >
        {view.global.items.length === 0 && <p className="set-empty">{t('No presets yet. Import one from SillyTavern, as JSON.')}</p>}
        <PresetList key={loaded} items={view.global.items} scope="global" call={call} />
        <div className="set-list-actions">
          <input ref={picker} type="file" accept=".json,application/json" hidden onChange={(e) => pick(e.target.files)} />
          <button type="button" className="btn is-small" onClick={() => picker.current?.click()}>
            <FilePlus size={14} />
            {t('Import a preset')}
          </button>
        </div>
      </Group>
      {own.length > 0 && (
        <Group title={t('Copies kept in this folder')} note={t('From before there was one library. Move them in and every folder can use them; a copy the library already has word for word is just removed.')}>
          <PresetList
            key={loaded}
            items={own}
            scope="workspace"
            call={call}
            extra={(p) => (
              <button type="button" className="btn is-small" onClick={() => call('move', { scope: 'workspace', name: p.name })}>
                <ArrowUp size={14} />
                {t('Move to the library')}
              </button>
            )}
          />
        </Group>
      )}
    </Page>
  );
}
