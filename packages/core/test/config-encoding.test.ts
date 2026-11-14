import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Windows PowerShell 5.1 saves a settings file with a byte-order mark (Set-Content -Encoding UTF8, Out-File) or as
// UTF-16 (a > redirect); a config.json saved that way had stopped Favilla from starting (2026-11-06).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-config-encoding-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
fs.mkdirSync(process.env.FAVILLA_HOME, { recursive: true });
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const { keyPath, loadConfig, loadGlobalConfigRaw, settingsText, updateGlobalConfig } = await import('../src/config/config');

const TEXT = '{\n  // what the user wrote\n  "effort": "low",\n}\n';
const saved = {
  plain: Buffer.from(TEXT, 'utf8'),
  'utf-8 with a mark': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, 'utf8')]),
  'utf-16 le': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT, 'utf16le')]),
  'utf-16 be': Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(TEXT, 'utf16le').swap16()]),
};

describe('a settings file saved by a Windows tool', () => {
  it.each(Object.entries(saved))('reads as its text when saved as %s', (_name, bytes) => {
    const file = path.join(home, `${_name}.json`);
    fs.writeFileSync(file, bytes);
    expect(settingsText(file)).toBe(TEXT);
  });

  it('starts Favilla with its settings, comments and all', () => {
    fs.writeFileSync(path.join(process.env.FAVILLA_HOME!, 'config.json'), saved['utf-16 le']);
    expect(loadConfig().effort).toBe('low');
  });
});

// `favilla config providers.relay.models.gpt-6.1-sol.contextWindow` had split the model id at its dot (2026-11-06).
describe('a dotted key for favilla config', () => {
  const cfg = { model: 'relay/gpt-6.1-sol', providers: { relay: { baseUrl: 'x', models: { 'gpt-6.1-sol': { contextWindow: 1 }, 'gpt-6': {} } } } };

  it('takes a key with dots in it whole where the settings have one, the longest that fits', () => {
    expect(keyPath(cfg, 'providers.relay.models.gpt-6.1-sol.contextWindow')).toEqual(['providers', 'relay', 'models', 'gpt-6.1-sol', 'contextWindow']);
    expect(keyPath(cfg, 'providers.relay.baseUrl')).toEqual(['providers', 'relay', 'baseUrl']);
    expect(keyPath(cfg, 'model')).toEqual(['model']);
  });

  it('splits at every dot past what exists, and keeps a quoted part whole', () => {
    expect(keyPath(cfg, 'providers.other.models.a.b')).toEqual(['providers', 'other', 'models', 'a', 'b']);
    expect(keyPath(cfg, 'providers.relay.models."gpt-6.2-sol".contextWindow')).toEqual(['providers', 'relay', 'models', 'gpt-6.2-sol', 'contextWindow']);
  });

  it('is written whole beside the file and renamed into place; a settings file that is a link stays one', () => {
    const real = path.join(home, 'dotfiles', 'favilla.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, JSON.stringify(cfg));
    const link = path.join(process.env.FAVILLA_HOME!, 'config.json');
    fs.rmSync(link, { force: true });
    try {
      fs.symlinkSync(real, link, 'file');
    } catch {
      // Windows without developer mode cannot make the link; the write itself is checked below.
      fs.copyFileSync(real, link);
    }
    updateGlobalConfig({ effort: 'high' });
    const linked = fs.lstatSync(link).isSymbolicLink();
    expect((JSON.parse(settingsText(linked ? real : link)) as { effort: string }).effort).toBe('high');
    if (linked) expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(path.dirname(link)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    fs.rmSync(link, { force: true });
  });

  it('writes the setting under the model it names', () => {
    fs.writeFileSync(path.join(process.env.FAVILLA_HOME!, 'config.json'), JSON.stringify(cfg));
    updateGlobalConfig({}, [[keyPath(loadGlobalConfigRaw(), 'providers.relay.models.gpt-6.1-sol.contextWindow'), 200000]]);
    expect((loadGlobalConfigRaw() as typeof cfg).providers.relay.models['gpt-6.1-sol'].contextWindow).toBe(200000);
  });
});
