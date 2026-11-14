import type { SettingBasis } from '@favilla/core/types';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { confirmDialog, settingSaveError, toast, useStore } from '../../lib/store';
import { count, fill, useT } from '../../lib/i18n';
import type { McpServerView } from '../../lib/types';
import { ArrowsClockwise, CheckCircle, ClipboardText, Plug, Plus, Trash, X } from '../icons';
import { Group, Item, LoadError, Loading, Page, PathNote, Segmented } from './Rows';

type Kind = 'command' | 'url';
/** A name and, when typed, a new value; a saved value is never sent to the page, so blank keeps it. */
type Pair = { name: string; value: string; saved: boolean };

interface Form {
  name: string;
  kind: Kind;
  command: string;
  args: string;
  cwd: string;
  url: string;
  pairs: Pair[];
  enabled: boolean;
}

const quote = (a: string) => (/[\s"]/.test(a) ? `'${a}'` : a);

function formOf(s?: McpServerView): Form {
  const c = s?.config;
  if (c && 'url' in c) return { name: s!.name, kind: 'url', command: '', args: '', cwd: '', url: c.url, pairs: c.headers.map((name) => ({ name, value: '', saved: true })), enabled: c.enabled };
  return { name: s?.name ?? '', kind: 'command', command: c?.command ?? '', args: (c?.args ?? []).map(quote).join(' '), cwd: c?.cwd ?? '', url: '', pairs: (c?.env ?? []).map((name) => ({ name, value: '', saved: true })), enabled: c?.enabled ?? true };
}

function formConfig(f: Form) {
  const pairs = f.pairs.filter((p) => p.name.trim()).map((p) => (p.saved && !p.value ? { name: p.name.trim() } : { name: p.name.trim(), value: p.value }));
  return f.kind === 'url' ? { kind: 'url', url: f.url.trim(), headers: pairs, enabled: f.enabled } : { kind: 'command', command: f.command.trim(), args: f.args, cwd: f.cwd.trim(), env: pairs, enabled: f.enabled };
}

function State({ s }: { s: McpServerView }) {
  const t = useT();
  return (
    <span className={s.state === 'ready' ? 'is-ready' : s.state === 'failed' ? 'is-failed' : undefined} data-tip={s.error}>
      {s.state === 'ready' ? (
        <>
          <CheckCircle size={14} weight="fill" /> {count(t, s.tools.length, '{n} tool', '{n} tools')}
        </>
      ) : s.state === 'failed' ? (
        t('Could not connect')
      ) : s.state === 'off' ? (
        t('Off')
      ) : (
        t('Connecting…')
      )}
    </span>
  );
}

/**
 * A server's settings: a program on this computer or an address, with env vars or headers. `actions` go on the line
 * of Save, for a server that exists: connecting it again, and apart at the end, removing it.
 */
function ServerForm({ server, onSaved, onLoad, onCancel, actions }: { server?: McpServerView; onSaved: (list: McpServerView[]) => void; onLoad: (list: McpServerView[]) => void; onCancel: () => void; actions?: ReactNode }) {
  const t = useT();
  const [opened, setOpened] = useState(server);
  const [f, setF] = useState<Form>(() => formOf(opened));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const setPair = (i: number, patch: Partial<Pair>) => set({ pairs: f.pairs.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const valid = /^[\w.-]{1,40}$/.test(f.name.trim()) && (f.kind === 'url' ? /^https?:\/\/\S+/.test(f.url.trim()) : !!f.command.trim());
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api<McpServerView[]>('/mcp/save', { body: {
        name: f.name.trim(), from: opened?.name, config: formConfig(f),
        before: opened ? formConfig(formOf(opened)) : null, basis: opened?.basis ?? {},
      } }));
    } catch (e) {
      settingSaveError(e, async () => {
        const list = await api<McpServerView[]>('/mcp');
        onLoad(list);
        const fresh = list.find((s) => s.name === opened?.name);
        if (!fresh) onCancel();
        else { setOpened(fresh); setF(formOf(fresh)); }
      });
    } finally {
      setBusy(false);
    }
  };
  const label = f.kind === 'url' ? t('Headers') : t('Environment variables');
  return (
    <div className="set-form">
      <div className="field-grid">
        <label className="field">
          <span>{t('Name')}</span>
          <input type="text" spellCheck={false} value={f.name} placeholder="github" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <div className="field">
          <span>{t('How Favilla reaches it')}</span>
          <Segmented<Kind>
            value={f.kind}
            options={[
              ['command', t('A program on this computer')],
              ['url', t('An address')],
            ]}
            onChange={(k) => set({ kind: k, pairs: [] })}
            label={t('How Favilla reaches it')}
          />
        </div>
      </div>
      {f.kind === 'command' ? (
        <>
          <div className="field-grid">
            <label className="field">
              <span>{t('Command')}</span>
              <input type="text" spellCheck={false} className="mono" value={f.command} placeholder="npx" onChange={(e) => set({ command: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('Arguments')}</span>
              <input type="text" spellCheck={false} className="mono" value={f.args} placeholder="-y @modelcontextprotocol/server-github" onChange={(e) => set({ args: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>{t('Working folder (optional)')}</span>
            <input type="text" spellCheck={false} className="mono" value={f.cwd} onChange={(e) => set({ cwd: e.target.value })} />
          </label>
        </>
      ) : (
        <label className="field">
          <span>{t('Address')}</span>
          <input type="text" spellCheck={false} className="mono" value={f.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
        </label>
      )}
      <div className="field">
        <span>{label}</span>
        {f.pairs.map((p, i) => (
          <div key={i} className="field-row mcp-pair">
            <input type="text" spellCheck={false} className="mono" value={p.name} placeholder={f.kind === 'url' ? 'Authorization' : 'GITHUB_TOKEN'} aria-label={t('Name')} onChange={(e) => setPair(i, { name: e.target.value })} />
            <input type="password" autoComplete="off" spellCheck={false} className="mono" value={p.value} placeholder={p.saved ? t('Saved; type to replace') : t('Value')} aria-label={t('Value')} onChange={(e) => setPair(i, { value: e.target.value })} />
            <button type="button" className="icon-btn" aria-label={t('Remove')} data-tip={t('Remove')} onClick={() => set({ pairs: f.pairs.filter((_, k) => k !== i) })}>
              <X size={14} />
            </button>
          </div>
        ))}
        <button type="button" className="link mcp-add-pair" onClick={() => set({ pairs: [...f.pairs, { name: '', value: '', saved: false }] })}>
          <Plus size={12} /> {f.kind === 'url' ? t('Add a header') : t('Add a variable')}
        </button>
        <span className="set-note">{t('Values stay in the global config file on this computer; this page never shows them again.')}</span>
      </div>
      <div className="row-actions">
        <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={save}>
          {busy ? t('Connecting…') : server ? t('Save') : t('Add server')}
        </button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={onCancel}>
          {t('Cancel')}
        </button>
        {actions}
      </div>
    </div>
  );
}

/** Paste the "mcpServers" block a README shows, or one server; every server in it is added. */
function PasteForm({ basis, onSaved, onCancel, onLoad }: { basis: SettingBasis; onSaved: (list: McpServerView[]) => void; onCancel: () => void; onLoad: () => void }) {
  const t = useT();
  const [opened] = useState(basis);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const single = /^\s*\{\s*"(command|url|serverUrl)"/.test(text);
  const add = async () => {
    setBusy(true);
    try {
      onSaved(await api<McpServerView[]>('/mcp/import', { body: { text, name: name.trim(), basis: opened } }));
    } catch (e) {
      settingSaveError(e, () => { onCancel(); onLoad(); });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="set-form">
      <label className="field">
        <span>{t('Configuration')}</span>
        <textarea className="rule-text mono" rows={7} spellCheck={false} value={text} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} onChange={(e) => setText(e.target.value)} />
      </label>
      {single && (
        <label className="field">
          <span>{t('Name')}</span>
          <input type="text" spellCheck={false} value={name} placeholder="github" onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <p className="set-note">{t('The block a README or another app shows (Claude Desktop, Cursor, VS Code) works as it is.')}</p>
      <div className="row-actions">
        <button type="button" className="btn btn-primary" disabled={!text.trim() || busy || (single && !name.trim())} onClick={add}>
          {busy ? t('Connecting…') : t('Add')}
        </button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={onCancel}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}

/** Settings > MCP servers: their state, set up and changed here, connected again without a restart. */
export function McpSettings() {
  const t = useT();
  const info = useStore((s) => s.info);
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<McpServerView | null>(null);
  const [adding, setAdding] = useState<'form' | 'paste' | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  // While a server connects, its state is asked for again, for about half a minute.
  const take = (list: McpServerView[], tries = 0) => {
    setServers(list);
    if (poll.current) clearTimeout(poll.current);
    if (tries < 20 && list.some((s) => s.state === 'connecting')) poll.current = setTimeout(() => api<McpServerView[]>('/mcp').then((l) => take(l, tries + 1)).catch(() => {}), 1500);
  };
  const load = () => {
    setError(null);
    api<McpServerView[]>('/mcp')
      .then(take)
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => {
    load();
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [info]);
  const lede = t('Tools from MCP servers reach the model in new sessions.');
  if (!servers)
    return (
      <Page title={t('MCP servers')} lede={lede}>
        {error ? <LoadError error={error} retry={load} /> : <Loading />}
      </Page>
    );
  const call = async (action: string, name: string, basis?: SettingBasis) => {
    try {
      take(await api<McpServerView[]>(`/mcp/${action}`, { body: { name, basis } }));
      if (action === 'delete') setOpen(null);
    } catch (e) {
      settingSaveError(e, () => { setOpen(null); load(); });
    }
  };
  const remove = async ({ name, basis }: McpServerView) => {
    if (await confirmDialog({ title: fill(t('Remove {n}?'), name), body: t('Its settings are deleted from the global config. Open sessions keep its tools until they end.'), confirm: t('Remove'), cancel: t('Cancel'), danger: true })) await call('delete', name, basis);
  };
  const shown = open && !servers.some((s) => s.name === open.name) ? [...servers, open] : servers;
  const saved = (list: McpServerView[]) => {
    take(list);
    setAdding(null);
    setOpen(null);
    toast(t('Saved. New sessions get its tools once it has connected.'), 'info');
  };
  return (
    <Page title={t('MCP servers')} lede={lede}>
      <Group foot={info && <PathNote label={t('Kept in')} path={info.config.globalConfig} />}>
        {shown.length === 0 && <p className="set-empty">{t('No MCP servers yet.')}</p>}
        {shown.map((s) => (
          <Item key={s.name} id={`mcp-${s.name}`} mark={<Plug size={14} />} name={s.name} state={<State s={s} />} open={open?.name === s.name} onToggle={() => setOpen(open?.name === s.name ? null : s)}>
            {s.state === 'failed' && s.error && <p className="set-note is-warn">{s.error}</p>}
            {s.tools.length > 0 && <p className="set-note mono">{s.tools.join(' · ')}</p>}
            <ServerForm
              server={s}
              onSaved={saved}
              onLoad={take}
              onCancel={() => setOpen(null)}
              actions={
                <>
                  {s.config?.enabled !== false && (
                    <button type="button" className="link" onClick={() => call('restart', s.name)}>
                      <ArrowsClockwise size={14} /> {t('Connect again')}
                    </button>
                  )}
                  <span className="set-danger">
                    <button type="button" className="link is-danger" onClick={() => remove(s)}>
                      <Trash size={14} /> {t('Remove server')}
                    </button>
                  </span>
                </>
              }
            />
          </Item>
        ))}
        <Item id="mcp-add" add mark={<Plus size={14} />} name={t('Add an MCP server')} meta={t('A program such as npx or uvx, or an address')} open={adding === 'form'} onToggle={() => setAdding(adding === 'form' ? null : 'form')}>
          <ServerForm onLoad={take} onSaved={saved} onCancel={() => setAdding(null)} />
        </Item>
        <Item id="mcp-paste" add mark={<ClipboardText size={14} />} name={t('Paste a configuration')} meta={t('The block a README shows')} open={adding === 'paste'} onToggle={() => setAdding(adding === 'paste' ? null : 'paste')}>
          <PasteForm basis={Object.assign({}, ...servers.map((s) => s.basis))} onLoad={load} onSaved={saved} onCancel={() => setAdding(null)} />
        </Item>
      </Group>
    </Page>
  );
}
