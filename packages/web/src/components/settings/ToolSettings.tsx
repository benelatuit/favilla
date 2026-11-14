import { useState } from 'react';
import { api } from '../../lib/api';
import { actions, toast, useStore } from '../../lib/store';
import { fill, useT } from '../../lib/i18n';
import { Select } from '../ui/Select';
import { Group, Page, Row, Segmented, useSetConfig, useSettingDraft } from './Rows';

const SHELLS = ['bash', 'pwsh', 'powershell', 'cmd'];

/** Settings > Tools: what the agent works with besides the project's files, for sessions started from now on. */
export function ToolSettings() {
  const t = useT();
  const info = useStore((s) => s.info);
  const set = useSetConfig();
  // bash by default; the other shells are there for machines and habits that need them.
  const configured = info?.config.shell || 'bash';
  const custom = !SHELLS.includes(configured.toLowerCase());
  const [choosingPath, setChoosingPath] = useState(false);
  const shell = choosingPath || custom ? 'path' : configured.toLowerCase();
  const exe = useSettingDraft(custom ? configured : '', info?.basis);
  const browserExe = useSettingDraft(info?.config.browserPath ?? '', info?.basis);
  const savePath = (key: string, draft: typeof exe) => set({ [key]: draft.value.trim() }, draft.basis, async () => {
    await actions.loadSettings();
    draft.clear();
    if (key === 'shell') setChoosingPath(false);
  }).then((saved) => { if (saved) draft.saved(); });
  if (!info) return null;
  const c = info.config;
  const search = c.webSearch === false ? 'off' : c.webSearch === 'builtin' ? 'builtin' : 'auto';
  const own = c.browser === 'edge' || c.browser === 'chrome';
  const extensions = (info.extensions ?? []).flatMap((e) => e.settings);
  const openBrowser = () =>
    api<{ how: string }>('/browser/open', { body: {} })
      .then(({ how }) =>
        how === 'busy'
          ? toast(t('An agent is using the browser in the background right now; open it again when that run ends.'), 'error')
          : how === 'stale'
            ? toast(t("Favilla's browser is still running from an earlier version, and Google refuses sign-in there: close all of its windows, then open it again."), 'error')
            : toast(t('Sign in to sites there; the agent works in its own tabs of the same browser.')),
      )
      .catch((e) => toast(String((e as Error).message ?? e), 'error'));
  return (
    <Page title={t('Tools')} lede={t('Changes apply to new sessions.')}>
      <Group>
        <Row
          id="tool-style"
          label={t('Tool style')}
          control={
            <Select
              value={c.tools}
              options={[
                { value: 'favilla', label: 'Favilla', hint: t('One set for every model') },
                { value: 'auto', label: t('Per model'), hint: t('The style each model family was trained on') },
                { value: 'claude', label: t('File tools'), hint: t('Read, edit, search and run, one tool each') },
                { value: 'codex', label: t('Shell and patches'), hint: t('Commands in a shell, edits as patches') },
              ]}
              onChange={(v) => set({ tools: v })}
              className="is-field"
            />
          }
        />
        <Row
          id="terminal"
          label={t('Terminal')}
          note={info.shell ? <span data-tip={info.shell.path}>{info.shell.fallback ?? fill(t('New sessions run commands in {n}.'), info.shell.name)}</span> : undefined}
          warn={!!info.shell?.fallback}
          control={
            <Select
              value={shell}
              options={[
                { value: 'bash', label: 'bash', hint: t('Default. Git Bash on Windows') },
                { value: 'pwsh', label: 'PowerShell 7' },
                { value: 'powershell', label: 'Windows PowerShell' },
                { value: 'cmd', label: 'cmd' },
                { value: 'path', label: t('Another program…') },
              ]}
              onChange={(v) => {
                if (v === 'path') setChoosingPath(true);
                else void set({ shell: v === 'bash' ? '' : v }).then((saved) => {
                  if (saved) { setChoosingPath(false); exe.clear(); }
                });
              }}
              className="is-field"
            />
          }
        >
          {shell === 'path' && (
            <div className="field-row">
              <label className="field">
                <span>{t('Path to the shell')}</span>
                <input type="text" spellCheck={false} value={exe.value} placeholder="C:\msys64\usr\bin\bash.exe" onChange={(e) => exe.change(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && exe.value.trim() && exe.value !== exe.initial && savePath('shell', exe)} />
              </label>
              <button type="button" className="btn" disabled={!exe.value.trim() || exe.value === exe.initial} onClick={() => savePath('shell', exe)}>
                {t('Save')}
              </button>
            </div>
          )}
        </Row>
        <Row id="skills" label={t('Skills')} note={t('Lists the skills in .favilla, ~/.agents and ~/.claude for the model.')} control={<Segmented value={c.skills} options={[[true, t('On')], [false, t('Off')]]} onChange={(v) => set({ skills: v })} label={t('Skills')} />} />
        {/* What the installed extensions bring, each kept under its own key; the server keeps it as the extension says. */}
        {extensions.map((s) => (
          <Row key={s.key} id={`ext-${s.key}`} label={t(s.label)} note={s.note ? t(s.note) : undefined} control={<Select value={s.current} options={s.options.map((o) => ({ value: o.value, label: t(o.label) }))} onChange={(v) => set({ [s.key]: v })} className="is-field" />} />
        ))}
      </Group>
      <Group title={t('Web')}>
        <Row
          id="web-search"
          label={t('Web search')}
          control={
            <Select
              value={search}
              options={[
                { value: 'auto', label: t('Automatic'), hint: t("The provider's own where it has one") },
                { value: 'builtin', label: t('Built-in search only') },
                { value: 'off', label: t('Off') },
              ]}
              onChange={(v) => set({ webSearch: v === 'off' ? false : v === 'builtin' ? 'builtin' : true })}
              className="is-field"
            />
          }
        />
        <Row
          id="browser"
          label={t('Browser')}
          note={own ? fill(t('Once, with it open: go to {n}, choose Remote debugging and tick "Allow remote debugging for this browser instance". The browser may ask to allow each connection. The agent then sees what you are signed in to, so use it with work you trust it with.'), c.browser === 'edge' ? 'edge://inspect' : 'chrome://inspect') : undefined}
          control={
            <Select
              value={c.browser}
              options={[
                { value: 'fresh', label: t('In the background, fresh each session') },
                { value: 'keep', label: t('In the background, keeping logins') },
                { value: 'visible', label: t('In a window, keeping logins'), hint: t('You can watch it and sign in') },
                { value: 'edge', label: t('Your Edge, as you have it open'), hint: t('Your logins; the agent works in tabs of its own') },
                { value: 'chrome', label: t('Your Chrome, as you have it open'), hint: t('Your logins; the agent works in tabs of its own') },
              ]}
              onChange={(v) => set(v === 'edge' || v === 'chrome' ? { 'browser.use': v } : { 'browser.use': 'favilla', 'browser.visible': v === 'visible', 'browser.keepLogins': v !== 'fresh' })}
              className="is-field"
            />
          }
        />
        {!own && (
          // The program the background browser runs: found by itself where Chrome, Chromium or Edge is installed.
          <Row
            id="browser-path"
            label={t('Browser program')}
            warn={!c.browserFound}
            note={c.browserFound ? t('Empty finds the Chrome, Chromium or Edge this computer has.') : t('No Chrome, Chromium or Edge was found: give the path of one.')}
            control={
              <div className="field-row">
                <input type="text" className="set-input" spellCheck={false} value={browserExe.value} placeholder="C:\Program Files\Google\Chrome\Application\chrome.exe" aria-label={t('Browser program')} onChange={(e) => browserExe.change(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && browserExe.value !== browserExe.initial && savePath('browserPath', browserExe)} />
                <button type="button" className="btn" disabled={browserExe.value === browserExe.initial} onClick={() => savePath('browserPath', browserExe)}>
                  {t('Save')}
                </button>
              </div>
            }
          />
        )}
        {!own && (
          <Row
            id="favilla-browser"
            label={t("Favilla's browser")}
            note={t('A Chrome window with its own profile: what you sign in to there, the agent can use.')}
            control={
              <button type="button" className="btn" onClick={openBrowser}>
                {t('Open the browser')}
              </button>
            }
          />
        )}
      </Group>
      <Group title={t('This computer')}>
        <Row
          id="computer"
          label={t('Computer control')}
          note={c.computer ? t('Move the mouse into the top-left corner of the screen to stop it at once.') : t('Screenshots, mouse and keyboard; Windows')}
          warn={c.computer}
          control={<Segmented value={c.computer} options={[[true, t('On')], [false, t('Off')]]} onChange={(v) => set({ computer: v })} label={t('Computer control')} />}
        />
      </Group>
    </Page>
  );
}
