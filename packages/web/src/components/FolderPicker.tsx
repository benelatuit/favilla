import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { actions, setUi, toast, useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { ArrowUp, FolderSimple, HardDrives, House, MagnifyingGlass, X } from './icons';

interface Listing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  roots: { name: string; path: string }[];
}

/** Folder browser for the browser UI; the desktop app opens the system dialog instead. */
export function FolderPicker() {
  const t = useT();
  const start = useStore((s) => s.folder);
  const [listing, setListing] = useState<Listing | null>(null);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const close = () => setUi({ picker: false });
  const go = (p: string) =>
    api<Listing>(`/fs?path=${encodeURIComponent(p)}`)
      .then((l) => {
        setListing(l);
        setFilter('');
        setActive(0);
        input.current?.focus();
      })
      .catch((e) => toast(String(e), 'error'));
  useEffect(() => {
    go(start);
  }, [start]);
  const choose = async () => {
    if (!listing) return;
    await actions.setFolder(listing.path);
    close();
  };
  const dirs = listing?.dirs.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return createPortal(
    <div className="scrim is-sheet" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <section className="sheet picker" role="dialog" aria-modal="true" aria-label={t('Choose folder')}>
        <header className="sheet-head">
          <h2>{t('Choose folder')}</h2>
          <button type="button" className="icon-btn" onClick={close} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </header>
        <div className="picker-roots">
          {listing?.roots.map((r) => (
            <button type="button" key={r.path} className="btn is-small" onClick={() => go(r.path)}>
              {r.name === 'Home' ? <House size={14} /> : <HardDrives size={14} />} {r.name === 'Home' ? t('Home') : r.name}
            </button>
          ))}
        </div>
        <div className="picker-path">
          <button type="button" className="icon-btn is-small" disabled={!listing?.parent} aria-label={t('Up')} data-tip={t('Up')} onClick={() => listing?.parent && go(listing.parent)}>
            <ArrowUp size={14} />
          </button>
          <span className="mono">{listing?.path}</span>
        </div>
        <label className="pop-search">
          <MagnifyingGlass size={14} />
          <input
            ref={input}
            placeholder={t('Filter folders')}
            value={filter}
            onChange={(e) => (setFilter(e.target.value), setActive(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') e.preventDefault(), setActive((a) => Math.min(a + 1, dirs.length - 1));
              else if (e.key === 'ArrowUp') e.preventDefault(), setActive((a) => Math.max(a - 1, 0));
              else if (e.key === 'Enter' && dirs[active]) e.preventDefault(), go(dirs[active].path);
              else if (e.key === 'Backspace' && !filter && listing?.parent) go(listing.parent);
              else if (e.key === 'Escape') close();
            }}
          />
        </label>
        <ul className="picker-list">
          {dirs.length === 0 && <li className="pop-empty">{t('No folders here.')}</li>}
          {dirs.map((d, i) => (
            <li key={d.path}>
              <button type="button" className={`menu-item ${i === active ? 'is-active' : ''}`} onPointerMove={() => setActive(i)} onClick={() => go(d.path)}>
                <span className="menu-icon">
                  <FolderSimple size={16} />
                </span>
                <span className="menu-text">
                  <span className="menu-name">{d.name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <footer className="sheet-foot">
          <button type="button" className="btn" onClick={close}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={choose}>
            {t('Use this folder')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
