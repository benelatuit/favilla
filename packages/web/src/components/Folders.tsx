import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { actions, getState, setUi, toast, useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { desktop } from '../lib/desktop';
import { folderName, shortPath } from '../lib/format';
import { ArrowSquareOut, CaretUpDown, FolderOpen, FolderSimple } from './icons';
import { Menu, type MenuEntry } from './ui/Menu';
import { anchorOf, type Anchor } from './ui/Popover';

/** Choose a folder: the system dialog in the desktop app, the built-in browser elsewhere. */
export async function pickFolder(): Promise<void> {
  if (!desktop) return setUi({ picker: true });
  try {
    const p = await desktop.pickFolder();
    if (p) await actions.setFolder(p);
  } catch (e) {
    toast(String(e), 'error');
  }
}

/** What the system's file manager is called where Favilla runs. */
export function fileManagerLabel(platform = getState().info?.platform ?? ''): string {
  return platform === 'win32' ? 'Open in File Explorer' : platform === 'darwin' ? 'Open in Finder' : 'Open in the file manager';
}

/** The folder that holds a file: Favilla's own folder from the path of its config file. */
export const dataDir = (file: string) => file.replace(/[\\/][^\\/]+$/, '');

/** Show a folder in the system's file manager: through the desktop app, or the Favilla server on this computer. */
export async function revealFolder(folder: string, t: (k: string) => string): Promise<void> {
  try {
    const error = desktop ? await desktop.openPath(folder) : (await api<{ error?: string }>('/reveal', { body: { path: folder } })).error;
    if (error) toast(error, 'error');
  } catch (e) {
    toast(`${t('Could not open the folder')}: ${(e as Error).message}`, 'error');
  }
}

function useFolderEntries(): MenuEntry[] {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const recent = useStore((s) => s.recent);
  return [
    { id: 'reveal', label: t(fileManagerLabel()), icon: <ArrowSquareOut size={16} />, keys: 'Mod+Shift+E', onSelect: () => void revealFolder(folder, t) },
    { kind: 'separator' },
    { kind: 'label', label: t('Recent folders') },
    ...recent.map((f) => ({
      id: f,
      label: folderName(f),
      hint: shortPath(f, 44),
      checked: f === folder,
      onSelect: () => f !== folder && actions.setFolder(f).catch((e) => toast(String(e), 'error')),
    })),
    { kind: 'separator' },
    { id: 'open', label: t('Open folder…'), icon: <FolderOpen size={16} />, keys: 'Mod+O', onSelect: () => void pickFolder() },
  ];
}

/** The current folder with a menu of recent ones. `variant` sets where it sits: the sidebar head or the welcome page. */
export function FolderSwitcher({ variant }: { variant: 'sidebar' | 'welcome' }) {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const entries = useFolderEntries();
  const btn = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`folder-switch is-${variant} ${anchor ? 'is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label={`${t('Folder')}: ${folder}`}
        onClick={() => setAnchor(anchor ? null : anchorOf(btn.current!))}
      >
        <span className="folder-mark">
          <FolderSimple size={16} weight="duotone" />
        </span>
        <span className="folder-text">
          <span className="folder-name">{folderName(folder)}</span>
          <span className="folder-path">{shortPath(folder, variant === 'welcome' ? 40 : 30)}</span>
        </span>
        <CaretUpDown size={14} className="folder-caret" />
      </button>
      {anchor && <Menu anchor={anchor} ignore={btn.current} entries={entries} onClose={() => setAnchor(null)} className="folder-menu" />}
    </>
  );
}
