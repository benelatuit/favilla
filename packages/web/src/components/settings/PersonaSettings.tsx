import type { SettingBasis } from '@favilla/core/types';
import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import { confirmDialog, settingSaveError, toast, useStore } from '../../lib/store';
import { fill, useT } from '../../lib/i18n';
import { FilePlus, Plus, Trash } from '../icons';
import { Select } from '../ui/Select';
import { DetailFoot, Group, Item, LoadError, Loading, Page, PathNote, Row, sep, useView } from './Rows';

interface Persona {
  basis?: SettingBasis;
  name: string;
  description: string;
  personality: string;
  scenario?: string;
  examples?: string;
  from?: string;
  avatar?: boolean;
}

type Choice = { use: 'global' } | { use: 'none' } | { use: 'library'; name: string };

interface View {
  folder: string;
  dir: string;
  use: string | null;
  here: Choice;
  choices?: { global: SettingBasis; folder: SettingBasis };
  items: Persona[];
  active: string | null;
}

const FIELDS = [
  ['description', 'Who they are'],
  ['personality', 'Temper and way of talking'],
  ['scenario', 'Situation'],
  ['examples', 'Example exchanges'],
] as const;

/** The character's picture, or the first letter of its name. */
function Face({ p }: { p: Persona }) {
  return p.avatar ? (
    <img className="persona-face" alt="" src={`/api/personas/avatar?name=${encodeURIComponent(p.name)}`} />
  ) : (
    <span className="persona-face is-letter" aria-hidden>
      {[...p.name][0] ?? '?'}
    </span>
  );
}

/** One persona opened to edit: each field saved when it loses focus. */
function PersonaDetail({ p, save }: { p: Persona; save: (patch: Record<string, string>, basis?: SettingBasis) => Promise<boolean> }) {
  const t = useT();
  const [draft, setDraft] = useState<Record<string, { value: string; initial: string; basis?: SettingBasis }>>({});
  const shown = (k: keyof Persona) => String(p[k] ?? '');
  const value = (k: keyof Persona) => draft[k]?.value ?? shown(k);
  const change = (k: keyof Persona, value: string) => setDraft((d) => ({ ...d, [k]: { initial: d[k]?.initial ?? shown(k), basis: d[k] ? d[k].basis : p.basis, value } }));
  const commit = async (k: keyof Persona) => {
    const edit = draft[k];
    if (!edit || (edit.initial !== edit.value && !await save({ [k]: edit.value }, edit.basis))) return;
    setDraft((d) => d[k] === edit ? Object.fromEntries(Object.entries(d).filter(([key]) => key !== k)) : d);
  };
  return (
    <div className="set-form">
      <label className="field">
        <span>{t('Name')}</span>
        <input value={value('name')} onChange={(e) => change('name', e.target.value)} onBlur={() => commit('name')} />
      </label>
      {FIELDS.map(([k, label]) => (
        <label key={k} className="field">
          <span>{t(label)}</span>
          <textarea className="rule-text" rows={k === 'examples' ? 5 : 3} value={value(k)} onChange={(e) => change(k, e.target.value)} onBlur={() => commit(k)} />
        </label>
      ))}
      {p.from && <p className="set-note">{fill(t('From the card {n}.'), p.from)}</p>}
    </div>
  );
}

/**
 * Settings > Personas: who the agent is, kept apart from the rules. One library; this folder follows the default,
 * uses none, or picks one. A SillyTavern character card comes in as one.
 */
export function PersonaSettings() {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const session = useStore((s) => s.session);
  const { view, error, setView, reload } = useView<View>(`/personas?cwd=${encodeURIComponent(folder)}`);
  const [open, setOpen] = useState<string | null>(null);
  const [left, setLeft] = useState<string[] | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const lede = t('Who the agent is and how it talks. Its work on your files and the truth of its reports stay the same.');
  if (!view)
    return (
      <Page title={t('Personas')} lede={lede}>
        {error ? <LoadError error={error} retry={reload} /> : <Loading />}
      </Page>
    );
  const call = async <T extends View>(action: string, body: Record<string, unknown>): Promise<T | null> => {
    try {
      const basis = action === 'use' ? view.choices?.[body.scope === 'folder' ? 'folder' : 'global'] : body.basis;
      const v = await api<T>(`/personas/${action}`, { body: { cwd: folder, ...body, basis } });
      setView(v);
      return v;
    } catch (e) {
      settingSaveError(e, () => { setOpen(null); reload(); });
      return null;
    }
  };
  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (picker.current) picker.current.value = '';
    if (!file) return;
    // A card is a picture or JSON: sent as base64, whichever it is.
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const v = await call<View & { imported: string; report: { left: string[] } }>('import', { name: file.name, data });
    if (v) {
      setOpen(v.imported);
      setLeft(v.report.left);
    }
  };
  const create = async () => {
    let name = t('New persona');
    for (let n = 2; view.items.some((p) => p.name === name); n++) name = `${t('New persona')} ${n}`;
    const v = await call<View & { written: string }>('write', { patch: { name, description: '', personality: '' } });
    if (v) setOpen(v.written);
  };
  const remove = async ({ name, basis }: Persona) => {
    if (await confirmDialog({ title: fill(t('Delete {n}?'), name), body: t('Sessions that use it keep their own copy.'), confirm: t('Delete'), cancel: t('Cancel'), danger: true })) await call('delete', { name, basis });
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
  const names = view.items.map((p) => ({ value: `lib:${p.name}`, label: p.name }));
  const here = view.here;
  const missing = here.use === 'library' && !view.items.some((p) => p.name === here.name);
  const hereValue = here.use === 'library' ? (missing ? 'global' : `lib:${here.name}`) : here.use;
  const hereOptions = [{ value: 'global', label: fill(t('Follow the default ({n})'), view.use ?? t('none')) }, { value: 'none', label: t('No persona here') }, ...names];
  const chooseHere = (v: string) => call('use', { scope: 'folder', ...(v.startsWith('lib:') ? { use: 'library', name: v.slice(4) } : { use: v }) });
  const kept = t('A session keeps the persona it started with; sub-agents have none.');
  return (
    <Page title={t('Personas')} lede={lede}>
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
        <Row id="persona-here" label={t('This folder uses')} control={<Select value={hereValue} options={hereOptions} onChange={chooseHere} className="is-field" />} />
        <Row id="persona-default" label={t('Default for other folders')} control={<Select value={view.use ? `lib:${view.use}` : 'none'} options={[{ value: 'none', label: t('No persona') }, ...names]} onChange={(v) => call('use', { name: v.startsWith('lib:') ? v.slice(4) : '' })} className="is-field" />} />
      </Group>
      <Group
        id="persona-library"
        title={t('Persona library')}
        foot={
          <>
            {left && <p className="set-note">{left.length ? fill(t('Read the card. Not used here: {n}.'), left.join(', ')) : t('Read the card.')}</p>}
            <PathNote label={t('Kept in')} path={view.dir} />
          </>
        }
      >
        {view.items.length === 0 && <p className="set-empty">{t('No personas yet. Make one, or import a SillyTavern character card, PNG or JSON.')}</p>}
        {view.items.map((p) => (
          <Item key={p.name} mark={<Face p={p} />} name={<bdi>{p.name}</bdi>} meta={(p.description || p.personality || '').split('\n')[0]} open={open === p.name} onToggle={() => setOpen(open === p.name ? null : p.name)}>
            <PersonaDetail
              p={p}
              save={async (patch, basis) => {
                const v = await call<View & { written: string }>('write', { old: p.name, patch, basis });
                if (v) setOpen(v.written);
                return !!v;
              }}
            />
            <DetailFoot
              danger={
                <button type="button" className="link is-danger" onClick={() => remove(p)}>
                  <Trash size={14} /> {t('Delete')}
                </button>
              }
            />
          </Item>
        ))}
        <div className="set-list-actions">
          <input ref={picker} type="file" accept=".png,.json,image/png,application/json" hidden onChange={(e) => pick(e.target.files)} />
          <button type="button" className="btn is-small" onClick={create}>
            <Plus size={14} />
            {t('New persona')}
          </button>
          <button type="button" className="btn is-small" onClick={() => picker.current?.click()}>
            <FilePlus size={14} />
            {t('Import a character card')}
          </button>
        </div>
      </Group>
    </Page>
  );
}
