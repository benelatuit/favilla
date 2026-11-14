import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-cli-preset-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
const other = path.join(home, 'other');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(other, { recursive: true });
fs.writeFileSync(
  path.join(project, 'mine.json'),
  JSON.stringify({
    temperature: 1.5,
    assistant_prefill: 'Well,',
    prompts: [
      { identifier: 'main', name: 'Main', role: 'system', content: 'Hello {{user}} {{mystery}}' },
      { identifier: 'charDescription', name: 'Char Description', marker: true },
      { identifier: 'deep', name: 'Deep', role: 'user', content: 'x', injection_position: 1, injection_depth: 2, injection_order: 50 },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'charDescription', enabled: true }, { identifier: 'deep', enabled: false }] }],
  }),
);

const { presetCommand } = await import('../src/tui/preset');
const { activePreset } = await import('@favilla/core');

afterAll(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('/preset', () => {
  it('imports into this folder unless told --global, and says what it left out', () => {
    const r = presetCommand('import mine.json', project);
    expect(r.text).toContain('Imported mine');
    expect(r.text).toContain('2 prompts, 1 off');
    expect(r.text).toContain('Char Description');
    expect(r.text).toContain('{{mystery}}');
    expect(presetCommand('', other).text).not.toContain('mine');
    expect(presetCommand('', project).text).toContain('mine');
  });

  it('turns a preset on for one folder or for all, and only --global reaches another folder', () => {
    expect(presetCommand('use nothing', project).changed).toBe(false);
    expect(presetCommand('use mine', project).changed).toBe(true);
    expect(activePreset(project)?.scope).toBe('workspace');
    expect(activePreset(other)).toBeNull();

    expect(presetCommand('copy mine', project).text).toContain('every folder');
    presetCommand('use mine --global', project);
    expect(activePreset(other)?.scope).toBe('global');
    presetCommand('none', other);
    expect(activePreset(other)).toBeNull();
    presetCommand('inherit', other);
    expect(activePreset(other)?.scope).toBe('global');
  });

  it('shows each prompt with its role and layer', () => {
    const shown = presetCommand('show mine', project).text;
    expect(shown).toMatch(/Main.*system · system prompt/);
    expect(shown).toMatch(/Deep.*user · depth 2 · order 50/);
    expect(shown).toContain('prefill: Well,');
  });

  it('says what went wrong instead of throwing', () => {
    expect(presetCommand('import missing.json', project).changed).toBe(false);
    expect(presetCommand('import', project).text).toContain('/preset import FILE');
    expect(presetCommand('sideways', project).text).toContain('import FILE');
    fs.writeFileSync(path.join(project, 'text.json'), '{"temp": 1}');
    expect(presetCommand('import text.json', project).text).toContain('no prompts list');
  });
});
