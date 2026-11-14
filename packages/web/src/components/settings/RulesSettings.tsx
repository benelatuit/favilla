import type { SettingBasis } from '@favilla/core/types';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { settingSaveError, toast, useStore } from '../../lib/store';
import { fill, useT } from '../../lib/i18n';
import { Keys } from '../ui/Keys';
import { Group, LoadError, Loading, Page, Row, useSettingDraft, useView } from './Rows';

interface RuleFile {
  path: string;
  content: string;
  exists: boolean;
  basis?: SettingBasis;
}

interface RulesView {
  global: RuleFile;
  project: RuleFile;
  memory: RuleFile;
  globalMemory: RuleFile;
  /** Instruction files further up the folder chain, read too. */
  others: { path: string; chars: number }[];
  /** Characters of instruction files the model of a new session takes in. */
  limit: number;
}

type Which = 'global' | 'project' | 'memory' | 'globalMemory';

/** One instruction file edited in place: its name and path, the text, and Save once it differs (Ctrl+S too). */
function RuleEditor({ id, which, title, note, file, folder, onSaved }: { id: string; which: Which; title: string; note: string; file: RuleFile; folder: string; onSaved: (v: RulesView) => void }) {
  const t = useT();
  const draft = useSettingDraft(file.content, file.basis);
  const text = draft.value;
  const [busy, setBusy] = useState(false);
  useEffect(() => draft.clear(), [folder]);
  const dirty = text !== draft.initial;
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api<RulesView>('/rules', { method: 'PUT', body: { which, cwd: folder, content: text, basis: draft.basis } }));
      draft.saved();
      toast(t('Saved'), 'info');
    } catch (e) {
      settingSaveError(e, async () => { onSaved(await api<RulesView>(`/rules?cwd=${encodeURIComponent(folder)}`)); draft.clear(); });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      id={id}
      label={title}
      note={
        <span className="mono set-path-text" data-tip={file.path}>
          <bdi>{file.path}</bdi>
        </span>
      }
      stack
    >
      <textarea
        className="rule-text mono"
        spellCheck={false}
        value={text}
        placeholder={note}
        aria-label={title}
        rows={Math.min(14, Math.max(3, text.split('\n').length + 1))}
        onChange={(e) => draft.change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (dirty) save();
          }
        }}
      />
      <div className="rule-foot">
        {dirty && (
          <>
            <button type="button" className="btn is-small" disabled={busy} onClick={save}>
              {file.exists || !text ? t('Save') : t('Create file')}
            </button>
            <Keys combo="Mod+S" />
            <button type="button" className="link" onClick={() => draft.clear()}>
              {t('Discard changes')}
            </button>
          </>
        )}
        <span className="muted num rule-count">{fill(t('{n} characters'), text.length.toLocaleString())}</span>
      </div>
    </Row>
  );
}

/** Settings > Rules: the user's standing instructions, for every project and for this one, and what Favilla noted down itself. */
export function RulesSettings() {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const session = useStore((s) => s.session);
  const { view, error, setView, reload } = useView<RulesView>(`/rules?cwd=${encodeURIComponent(folder)}`);
  const apply = async () => {
    if (!session) return;
    try {
      await api(`/sessions/${session.meta.id}/reload-rules`, { body: {} });
      toast(t('The open session now follows the saved rules.'), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const editor = (id: string, which: Which, title: string, note: string) => view && <RuleEditor id={id} which={which} title={title} note={note} file={view[which]} folder={folder} onSaved={setView} />;
  return (
    <Page
      title={t('Rules')}
      lede={view ? fill(t('Standing instructions for the agent. New sessions read up to {n} characters of them.'), view.limit.toLocaleString()) : undefined}
      action={
        session && view ? (
          <button type="button" className="link" onClick={apply}>
            {t('Apply to the open session now')}
          </button>
        ) : undefined
      }
    >
      {!view ? (
        error ? <LoadError error={error} retry={reload} /> : <Loading />
      ) : (
        <>
          <Group
            title={t('Your rules')}
            foot={
              view.others.length > 0 && (
                <p className="set-note">
                  {t('Also read for this folder:')} <span className="mono">{view.others.map((o) => o.path).join(', ')}</span>
                </p>
              )
            }
          >
            {editor('rules-global', 'global', t('Every project'), t('Instructions for every session in every folder: how you like to work, tools to prefer, things never to do.'))}
            {editor('rules-project', 'project', t('This project'), t('Instructions for this folder: how to build and test it, conventions, what to leave alone.'))}
          </Group>
          <Group title={t('Favilla’s notes')}>
            {editor('notes-project', 'memory', t('Notes on this project'), t('What the agent saved with its remember tool. Edit or delete anything that is wrong or no longer true.'))}
            {editor('notes-user', 'globalMemory', t('Notes about you'), t('What the agent saved about you for every project: how you like to work, your name and sign-off, your setup. Edit or delete anything that is wrong or no longer true.'))}
          </Group>
        </>
      )}
    </Page>
  );
}
