import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { actions, confirmDialog, getState, settingSaveError, toast, useStore } from '../../lib/store';
import { count, fill, useT } from '../../lib/i18n';
import type { ProviderView } from '../../lib/types';
import { ArrowsClockwise, CheckCircle, Plus, Trash, Warning } from '../icons';
import { Select } from '../ui/Select';
import { DetailFoot, Group, Item, Page, Row, useSettingDraft, useSettingsNav } from './Rows';

/**
 * The models a provider's server does not list, added by hand under its address. What it lists comes by itself; a
 * model added here takes its window from its family until one is set under Models.
 */
function ProviderModels({ p }: { p: ProviderView }) {
  const t = useT();
  const id = useSettingDraft('', p.basis);
  const [busy, setBusy] = useState(false);
  const added = p.added ?? [];
  const listed = p.models.length - added.length;
  const want = id.value.trim();
  const known = added.some((m) => m.id === want) ? 'added' : p.models.some((m) => m.id === want) ? 'listed' : null;
  const valid = !!want && !/\s/.test(want) && !known;
  const near = valid && listed > 0 ? nearMiss(want, p.models.filter((m) => !added.some((a) => a.id === m.id)).map((m) => m.id)) : undefined;
  const change = async (method: 'POST' | 'DELETE', model: string) => {
    setBusy(true);
    try {
      await api(`/providers/${p.id}/models`, { method, body: { id: model, basis: method === 'POST' ? id.basis : p.basis } });
      await actions.loadProviders();
      if (method === 'POST') id.saved();
    } catch (e) {
      settingSaveError(e, async () => { await actions.loadProviders(); id.clear(); });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {added.length > 0 && (
        <div className="field">
          <span>{t('Models added by hand')}</span>
          <ul className="overrides">
            {added.map((m) => (
              <li key={m.id}>
                <span className="mono">{m.id}</span>
                <span className="num">{fill(t('{n} tokens'), m.contextWindow.toLocaleString())}</span>
                <button type="button" className="link" disabled={busy} onClick={() => change('DELETE', m.id)}>
                  {t('Remove')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="field-row">
          <label className="field">
            <span>{t('Add a model')}</span>
            <input type="text" spellCheck={false} value={id.value} placeholder={t('The model id, as the provider names it')} onChange={(e) => id.change(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && valid && !busy && change('POST', want)} />
          </label>
          <button type="button" className="btn" disabled={!valid || busy} onClick={() => change('POST', want)}>
            {t('Add')}
          </button>
        </div>
        <p className={known || near ? 'field-note is-warn' : 'field-note'}>
          {known === 'listed'
            ? t('The provider already lists this model.')
            : known === 'added'
              ? t('This model is already added.')
              : near
                ? fill(t('The provider lists {n}: check the spelling.'), near)
                : listed > 0
                ? fill(t('{n} come from the provider. Add one it does not list; its context window and pictures are set under Models.'), listed)
                : t('For a server that does not list its models. The context window and pictures are set under Models.')}
        </p>
      </div>
    </>
  );
}

/** A model listing the server refused for the key: 401 or 403, or words to that effect. */
const KEY_REFUSED = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api[ _-]?)?(?:key|token)|incorrect api key|authentication/i;
const keyRefused = (p: ProviderView) => !!p.error && KEY_REFUSED.test(p.error);

/**
 * A listed id within a letter or two of the one typed, case aside: what a misspelt name most likely meant. A model
 * added by hand under a provider that lists its own had been taken without a word, to fail only when first asked.
 */
function nearMiss(want: string, ids: string[]): string | undefined {
  const w = want.toLowerCase();
  let best: string | undefined;
  let room = w.length >= 6 ? 2 : 1;
  for (const id of ids) {
    const l = id.toLowerCase();
    // Ids apart only in their digits are most likely another version (gpt-6.2 beside a listed gpt-6.1), not a typo.
    if (l !== w && l.replace(/\d/g, '') === w.replace(/\d/g, '')) continue;
    const d = editDistance(w, l, room);
    if (d <= room) [best, room] = [id, d - 1];
    if (room < 0) break;
  }
  return best;
}

/** Levenshtein distance, given up at more than `most`. */
function editDistance(a: string, b: string, most: number): number {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...row) > most) return most + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * What to tell the user about a provider just added or given a key, from what the server made of it. A first run
 * had shown a green "Added, with 1 model" over a key the server turned down, and "no models found: list the model
 * ids" to someone who had listed one, when what was missing was the key.
 */
function reportProvider(p: ProviderView, t: (k: string) => string, typed: string[] = []): void {
  if (p.auth === 'key' && !p.keys) return toast(t('Added. This address needs an API key: enter it below.'), 'warn');
  // A proxy on this computer that wants a key, added without one: nothing was turned down, a key is missing.
  if (keyRefused(p)) return p.keys ? toast(t('The provider turned down the API key. Check it below.'), 'error') : toast(t('Added. This address needs an API key: enter it below.'), 'warn');
  if (!p.configured) return toast(p.error ? fill(t('Added, but the model list could not be read: {n}'), p.error) : t('Added, but no models were found. List the model ids, or check the address and key.'), 'error');
  // Typed ids the server's own list leaves out: a misspelt name otherwise shows up only as a failed request later.
  const listed = p.models.filter((m) => !(p.added ?? []).some((a) => a.id === m.id));
  const unlisted = listed.length ? typed.filter((id) => !listed.some((m) => m.id === id)) : [];
  if (unlisted.length) return toast(fill(t('Added. The provider does not list {n}: check the spelling.'), unlisted.join(', ')), 'warn');
  toast(fill(t('Added, with {n} models.'), p.models.length), 'info');
}

function KeyProvider({ p, onClose }: { p: ProviderView; onClose: () => void }) {
  const t = useT();
  const key = useSettingDraft('', p.basis);
  const base = useSettingDraft(p.baseUrl, p.basis);
  const reload = async () => {
    await actions.loadProviders();
    key.clear();
    base.clear();
    if (!getState().providers.some((v) => v.id === p.id)) onClose();
  };
  const save = async () => {
    try {
      const after = await api<ProviderView>(`/providers/${p.id}/key`, { body: { key: key.value, basis: key.basis } });
      key.saved();
      await actions.loadProviders();
      if (after?.error && KEY_REFUSED.test(after.error)) toast(t('The provider turned down the API key. Check it below.'), 'error');
      else toast(t('Saved'), 'info');
    } catch (e) {
      settingSaveError(e, reload);
    }
  };
  const saveBase = () =>
    actions
      .setConfig({ providers: { [p.id]: { baseUrl: base.value } } }, base.basis)
      .then(() => actions.loadProviders())
      .then(() => { base.saved(); toast(t('Saved'), 'info'); })
      .catch((e) => settingSaveError(e, reload));
  return (
    <>
      {(p.auth === 'key' || p.local) && (
        // A server on this computer keeps the field: a proxy there to a cloud service added without its key could not
        // be given one afterwards, only removed and added again.
        <div className="field-row">
          <label className="field">
            <span>{t('API key')}</span>
            <input type="password" autoComplete="off" spellCheck={false} value={key.value} placeholder={p.keys ? `•••••• (${p.keys})` : p.local && !keyRefused(p) ? t('Not needed for servers on this computer') : ''} onChange={(e) => key.change(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.value && save()} />
          </label>
          <button type="button" className="btn" disabled={!key.value} onClick={save}>
            {t('Save')}
          </button>
        </div>
      )}
      <div className="field-row">
        <label className="field">
          <span>{t('Base URL')}</span>
          <input type="text" spellCheck={false} value={base.value} onChange={(e) => base.change(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && base.value !== base.initial && saveBase()} />
        </label>
        <button type="button" className="btn" disabled={base.value === base.initial} onClick={saveBase}>
          {t('Save')}
        </button>
      </div>
      <ProviderModels p={p} />
      {p.local && (
        // A server on this computer is taken to answer one request at a time; a proxy on it to a cloud service is not,
        // and saying so lets the summary be written in the background (an address on 127.0.0.1 alone made such a proxy local).
        <label className="check set-check">
          <input
            type="checkbox"
            checked={!p.serial}
            onChange={(e) =>
              actions
                .setConfig({ providers: { [p.id]: { slots: e.target.checked ? 4 : 1 } } }, p.basis)
                .then(() => actions.loadProviders())
                .catch((err) => settingSaveError(err, reload))
            }
          />
          <span>
            {t('Answers several requests at once')}
            <small>{t('A proxy to a cloud service does; a model running on this computer usually does not.')}</small>
          </span>
        </label>
      )}
    </>
  );
}

/** The request formats a provider can speak; most servers, gateways and local runners take the first. */
const API_KINDS = [
  { value: 'openai-chat', label: 'OpenAI-compatible', hint: 'Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'gemini', label: 'Gemini' },
];

/** A provider of the user's own: any server that speaks one of the formats above. */
function AddProvider({ onDone }: { onDone: (id?: string) => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('openai-chat');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLDivElement>(null);
  // It opens under the whole list of providers: on a short window most of it was below the edge.
  // In braces: Chromium's scrollIntoView now returns a promise, which React would take for the cleanup and call.
  useEffect(() => {
    form.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const url = baseUrl.trim();
  const valid = !!name.trim() && /^https?:\/\/[^\s/]+/.test(url);
  const save = async () => {
    setBusy(true);
    try {
      const typed = models.split(/[\s,]+/).filter(Boolean);
      const p = await api<ProviderView>('/providers', { body: { name: name.trim(), api: kind, baseUrl: url, key: key.trim() || undefined, models: typed } });
      await actions.loadProviders();
      reportProvider(p, t, typed);
      onDone(p.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="set-form" ref={form}>
      <div className="field-grid">
        <label className="field">
          <span>{t('Name')}</span>
          <input type="text" spellCheck={false} value={name} placeholder="OpenRouter" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>{t('Request format')}</span>
          <Select value={kind} options={API_KINDS.map((k) => ({ value: k.value, label: k.label, hint: k.hint }))} onChange={setKind} className="is-field" />
        </div>
        <label className="field">
          <span>{t('Base URL')}</span>
          <input type="text" spellCheck={false} value={baseUrl} placeholder="https://openrouter.ai/api/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('API key')}</span>
          <input type="password" autoComplete="off" spellCheck={false} value={key} placeholder={t('Not needed for servers on this computer')} onChange={(e) => setKey(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>{t('Models')}</span>
        <input type="text" spellCheck={false} value={models} placeholder={t('Optional: model ids separated by commas, when the server does not list them')} onChange={(e) => setModels(e.target.value)} />
      </label>
      <div className="row-actions">
        <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={save}>
          {busy ? t('Connecting…') : t('Add provider')}
        </button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => onDone()}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}

/** One provider: its state at a glance; opened, its key and address. */
function ProviderItem({ p, open, onToggle, onClose }: { p: ProviderView; open: boolean; onToggle: () => void; onClose: () => void }) {
  const t = useT();
  const remove = async () => {
    const ok = await confirmDialog({ title: fill(t('Remove {n}?'), p.name), body: t('Its settings and stored key are deleted. Sessions that used it keep their history.'), confirm: t('Remove'), cancel: t('Cancel'), danger: true });
    if (!ok) return;
    try {
      await api(`/providers/${p.id}`, { method: 'DELETE', body: { basis: p.basis } });
      onClose();
      await actions.loadProviders();
    } catch (e) {
      settingSaveError(e, async () => { await actions.loadProviders(); onClose(); });
    }
  };
  const refresh = async () => {
    try {
      await api(`/providers/${p.id}/discover`, { body: {} });
      await actions.loadProviders();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Item
      id={`provider-${p.id}`}
      name={t(p.name)}
      state={
        // Models typed in by hand make a provider configured even when the server turns its key down: a green count
        // there had stood against the red line saying so.
        keyRefused(p) ? (
          <span className="is-warn">
            <Warning size={14} weight="fill" /> {p.keys ? t('Key refused') : t('Needs an API key')}
          </span>
        ) : p.configured ? (
          <span className="is-ready">
            <CheckCircle size={14} weight="fill" /> {count(t, p.models.length, '{n} model', '{n} models')}
          </span>
        ) : (
          t('Not set up')
        )
      }
      open={open}
      onToggle={onToggle}
    >
      {p.description && <p className="set-note">{t(p.description)}</p>}
      <KeyProvider p={p} onClose={onClose} />
      {p.error && <p className="set-note is-warn">{p.error}</p>}
      {(p.configured || p.custom) && (
        <DetailFoot
          danger={
            p.custom ? (
              <button type="button" className="link is-danger" onClick={remove}>
                <Trash size={14} /> {t('Remove provider')}
              </button>
            ) : undefined
          }
        >
          {p.configured && (
            <button type="button" className="link" onClick={refresh}>
              <ArrowsClockwise size={14} /> {t('Refresh models')}
            </button>
          )}
        </DetailFoot>
      )}
    </Item>
  );
}

/**
 * The providers in use first; the others fold away under one line once any is set up, and open when none is. A
 * provider of one's own is added at the end.
 */
function Providers() {
  const t = useT();
  const providers = useStore((s) => s.providers);
  const { found } = useSettingsNav();
  const [adding, setAdding] = useState(false);
  // With nothing set up yet, the first provider is open: the quickest way to start.
  const [opened, setOpened] = useState<ProviderView | null>(() => providers.some((p) => p.configured) ? null : providers[0] ?? null);
  const shown = opened && !providers.some((p) => p.id === opened.id) ? [...providers, opened] : providers;
  const ready = shown.filter((p) => p.id === opened?.id ? opened.configured : p.configured);
  const rest = shown.filter((p) => !ready.includes(p));
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!found?.startsWith('provider-')) return;
    const id = found.slice('provider-'.length);
    setOpened(providers.find((p) => p.id === id) ?? null);
    if (rest.some((p) => p.id === id)) setMore(true);
  }, [found]);
  const item = (p: ProviderView) => <ProviderItem key={p.id} p={p} open={opened?.id === p.id} onToggle={() => setOpened(opened?.id === p.id ? null : p)} onClose={() => setOpened(null)} />;
  const folded = ready.length > 0 && rest.length > 0;
  return (
    <Group>
      {ready.map(item)}
      {folded && <Item fold name={t('Other providers')} state={<span className="num">{rest.length}</span>} open={more} onToggle={() => setMore(!more)} />}
      {(!folded || more) && <div className="set-sublist">{rest.map(item)}</div>}
      <Item
        id="add-provider"
        add
        mark={<Plus size={14} />}
        name={t('Add a provider')}
        meta={t('Any server with an OpenAI, Anthropic or Gemini style API')}
        open={adding}
        onToggle={() => setAdding(!adding)}
      >
        <AddProvider
          onDone={(id) => {
            setAdding(false);
            if (!id) return;
            const added = getState().providers.find((p) => p.id === id) ?? null;
            setOpened(added);
            // One not set up yet goes among the folded others: they open, and its card, where the key goes, comes into
            // view. A first run had found it folded away under a message saying to fill the key in below.
            if (added && !added.configured) setMore(true);
            setTimeout(() => {
              document.getElementById(`setting-provider-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }, 60);
          }}
        />
      </Item>
    </Group>
  );
}

/** Settings > Providers: where models come from, and the proxy that reaches the ones on the internet. */
export function ProviderSettings() {
  const t = useT();
  const info = useStore((s) => s.info);
  const proxy = useSettingDraft(info?.config.proxy ?? '', info?.basis);
  if (!info) return null;
  const save = async () => {
    try {
      await actions.setConfig({ proxy: proxy.value }, proxy.basis);
      proxy.saved();
      toast(t('Saved'), 'info');
    } catch (e) {
      settingSaveError(e, async () => { await actions.loadSettings(); proxy.clear(); });
    }
  };
  return (
    <Page title={t('Providers')} lede={t('Add an API key, or point Favilla at a model server on this computer.')}>
      <Providers />
      <Group title={t('Network')}>
        <Row
          id="proxy"
          label={t('HTTPS proxy')}
          note={t('Model servers on this computer are always reached directly.')}
          control={
            <div>
              <div className="field-row">
                <input type="text" className="set-input" spellCheck={false} value={proxy.value} placeholder="http://127.0.0.1:7890" aria-label={t('HTTPS proxy')} onChange={(e) => proxy.change(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && proxy.value !== proxy.initial && save()} />
                <button type="button" className="btn" disabled={proxy.value === proxy.initial} onClick={save}>
                  {t('Save')}
                </button>
              </div>
              {info.config.proxyPasswordSaved && <p className="set-note">{t('A proxy password is saved.')}</p>}
            </div>
          }
        />
      </Group>
    </Page>
  );
}
