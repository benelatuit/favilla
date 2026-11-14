import fs from 'node:fs';
import path from 'node:path';
import { activePreset, copyPreset, deletePreset, importPreset, presetsView, setGlobalChoice, setWorkspaceChoice, type PresetReport, type PresetScope } from '@favilla/core';
import { t } from './i18n';
import { paint } from './theme';

function reportLines(r: PresetReport): string[] {
  const out = [`${r.entries} ${t('prompts')}${r.off ? `, ${r.off} ${t('off')}` : ''}`];
  if (r.markers.length) out.push(`${t('left out (no character card here):')} ${r.markers.join(', ')}`);
  if (r.blank.length) out.push(`${t('empty, with no character card:')} ${r.blank.map((m) => `{{${m}}}`).join(' ')}`);
  if (r.macros.length) out.push(`${t('not understood, sent as written:')} ${r.macros.map((m) => `{{${m}}}`).join(' ')}`);
  return out;
}

const LAYER: Record<string, string> = { system: 'system prompt', before: 'before the chat', after: 'after the chat' };

function overview(cwd: string): string {
  const v = presetsView(cwd);
  const list = (items: { name: string; entries: unknown[] }[]) =>
    items.length ? items.map((p) => `  ${p.name}  ${paint('faint', `${p.entries.length} ${t('prompts')}`)}`) : [`  ${paint('faint', t('none imported'))}`];
  const here = v.workspace.use;
  const choice = here.use === 'own' ? here.name : here.use === 'none' ? t('no preset') : `${t('follows every-folder choice')}: ${v.global.use ?? t('no preset')}`;
  return [
    `${t('New sessions here use:')} ${v.active ? `${v.active.name} (${t(v.active.scope === 'global' ? 'every folder' : 'this folder')})` : t('no preset')}`,
    '',
    `${t('This folder')} · ${choice}`,
    ...list(v.workspace.items),
    `${t('Every folder')} · ${v.global.use ?? t('no preset')}`,
    ...list(v.global.items),
  ].join('\n');
}

/** /preset: the two libraries are kept apart by the words typed; --global means every folder, otherwise it is this one. */
export function presetCommand(arg: string, cwd: string): { text: string; changed: boolean } {
  const words = (arg.match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ''));
  const global = words.includes('--global');
  const [sub, ...rest] = words.filter((w) => w !== '--global');
  const scope: PresetScope = global ? 'global' : 'workspace';
  const name = rest.join(' ');
  const where = t(global ? 'every folder' : 'this folder');
  try {
    switch (sub) {
      case undefined:
      case 'list':
        return { text: overview(cwd), changed: false };
      case 'import': {
        const file = rest[0];
        if (!file) return { text: t('Say which file: /preset import FILE'), changed: false };
        const full = path.resolve(cwd, file);
        const { preset, report } = importPreset(scope, cwd, fs.readFileSync(full, 'utf8'), rest.slice(1).join(' ') || path.basename(full));
        return { text: [`${t('Imported')} ${preset.name} (${where})`, ...reportLines(report), t('Turn it on with /preset use NAME.')].join('\n'), changed: false };
      }
      case 'use': {
        const v = presetsView(cwd);
        const have = (global ? v.global.items : v.workspace.items).some((p) => p.name === name);
        if (!have) return { text: `${t('No preset by that name in')} ${where}: ${name}`, changed: false };
        if (global) setGlobalChoice(name);
        else setWorkspaceChoice(cwd, { use: 'own', name });
        return { text: `${t('Using')} ${name} (${where})`, changed: true };
      }
      case 'inherit':
        setWorkspaceChoice(cwd, { use: 'global' });
        return { text: t('This folder follows the every-folder choice.'), changed: true };
      case 'none':
        if (global) setGlobalChoice(null);
        else setWorkspaceChoice(cwd, { use: 'none' });
        return { text: `${t('No preset')} (${where})`, changed: true };
      case 'show': {
        const v = presetsView(cwd);
        const p = (global ? v.global.items : v.workspace.items).find((x) => x.name === name);
        if (!p) return { text: `${t('No preset by that name in')} ${where}: ${name}`, changed: false };
        const row = (e: (typeof p.entries)[number]) => {
          const at = e.layer === 'depth' ? `${t('depth')} ${e.depth} · ${t('order')} ${e.order}` : t(LAYER[e.layer]);
          return `  ${e.enabled ? '●' : paint('faint', '○')} ${e.name}  ${paint('faint', `${e.role} · ${at}`)}`;
        };
        return { text: [p.name, ...p.entries.map(row), ...(p.prefill ? [`${t('prefill')}: ${p.prefill}`] : [])].join('\n'), changed: false };
      }
      case 'copy': {
        const v = presetsView(cwd);
        const from: PresetScope = v.workspace.items.some((p) => p.name === name) && !global ? 'workspace' : 'global';
        copyPreset(from, cwd, name);
        return { text: `${t('Copied to')} ${t(from === 'global' ? 'this folder' : 'every folder')}: ${name}`, changed: false };
      }
      case 'delete':
        deletePreset(scope, cwd, name);
        return { text: `${t('Deleted')} ${name} (${where})`, changed: activePreset(cwd)?.preset.name !== name };
      default:
        return { text: t('/preset, then: import FILE, use NAME, inherit, none, show NAME, copy NAME, delete NAME; add --global for every folder.'), changed: false };
    }
  } catch (e) {
    return { text: (e as Error).message, changed: false };
  }
}
