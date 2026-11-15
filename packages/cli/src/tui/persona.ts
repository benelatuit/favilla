import fs from 'node:fs';
import path from 'node:path';
import { deletePersona, importPersona, personaText, personasView, readPersona, setPersonaFolderChoice, setPersonaGlobalChoice } from '@favilla/core';
import { t } from './i18n';
import { paint } from './theme';

function overview(cwd: string): string {
  const v = personasView(cwd);
  const here = v.here.use === 'library' ? v.here.name : v.here.use === 'none' ? t('no persona') : `${t('follows every-folder choice')}: ${v.use ?? t('no persona')}`;
  return [
    `${t('New sessions here are:')} ${v.active ?? t('no persona')}`,
    `${t('This folder')} · ${here}`,
    `${t('Every folder')} · ${v.use ?? t('no persona')}`,
    '',
    ...(v.items.length ? v.items.map((p) => `  ${p.name}  ${paint('faint', (p.description || p.personality || '').split('\n')[0].slice(0, 60))}`) : [`  ${paint('faint', t('none imported'))}`]),
  ].join('\n');
}

/** /persona: one library; --global sets the default of every folder, otherwise the choice is this folder's. */
export function personaCommand(arg: string, cwd: string): { text: string; changed: boolean } {
  const words = (arg.match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ''));
  const global = words.includes('--global');
  const [sub, ...rest] = words.filter((w) => w !== '--global');
  const name = rest.join(' ');
  const where = t(global ? 'every folder' : 'this folder');
  const usage = () => ({ text: t('/persona, then: import FILE, use NAME, inherit, none, show NAME, delete NAME; add --global for every folder.'), changed: false });
  try {
    switch (sub) {
      case undefined:
      case 'list':
        return { text: overview(cwd), changed: false };
      case 'import': {
        if (!name) return { text: t('Say which file: /persona import FILE'), changed: false };
        const full = path.resolve(cwd, name);
        const { persona, report } = importPersona(fs.readFileSync(full), path.basename(full));
        return { text: [`${t('Imported')} ${persona.name}`, ...(report.left.length ? [`${t('not used here:')} ${report.left.join(', ')}`] : []), t('Turn it on with /persona use NAME.')].join('\n'), changed: false };
      }
      case 'use':
        if (!name) return usage();
        if (!readPersona(name)) return { text: `${t('No persona by that name:')} ${name}`, changed: false };
        if (global) setPersonaGlobalChoice(name);
        else setPersonaFolderChoice(cwd, { use: 'library', name });
        return { text: `${t('Using')} ${name} (${where})`, changed: true };
      case 'inherit':
        setPersonaFolderChoice(cwd, { use: 'global' });
        return { text: t('This folder follows the every-folder choice.'), changed: true };
      case 'none':
      case 'off':
        if (global) setPersonaGlobalChoice(null);
        else setPersonaFolderChoice(cwd, { use: 'none' });
        return { text: `${t('No persona')} (${where})`, changed: true };
      case 'show': {
        const p = readPersona(name || personasView(cwd).active || '');
        return { text: p ? personaText(p) : name ? `${t('No persona by that name:')} ${name}` : t('no persona'), changed: false };
      }
      case 'delete':
        if (!name) return usage();
        if (!readPersona(name)) return { text: `${t('No persona by that name:')} ${name}`, changed: false };
        deletePersona(name);
        return { text: `${t('Deleted')} ${name}`, changed: true };
      default:
        return usage();
    }
  } catch (e) {
    return { text: (e as Error).message, changed: false };
  }
}
