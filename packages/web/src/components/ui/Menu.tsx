import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from '../icons';
import { Keys } from './Keys';
import { Popover, type Anchor, type Placement } from './Popover';

export type MenuEntry =
  | {
      kind?: never;
      id: string;
      label: string;
      icon?: ReactNode;
      hint?: string;
      keys?: string;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator' }
  | { kind: 'label'; label: string };

type Item = Extract<MenuEntry, { id: string }>;
const isItem = (e: MenuEntry): e is Item => e.kind === undefined;

/** Menu rows with keyboard movement: arrows, Home and End move, Enter or Space chooses, letters jump. */
/** `trailingCheck`: the chosen row is marked at its end, so labels line up with the field above (selects). */
export function MenuList({ entries, onDone, trailingCheck = false }: { entries: MenuEntry[]; onDone: () => void; trailingCheck?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const usable = entries.map((e, i) => (isItem(e) && !e.disabled ? i : -1)).filter((i) => i >= 0);
  const hasChecks = entries.some((e) => isItem(e) && e.checked !== undefined);

  useEffect(() => {
    // The plate is hidden until it is placed, and a hidden list cannot take the keys: take them once it shows.
    // Taken at once, they stayed on the button that opened it and the arrows moved nothing.
    const frame = requestAnimationFrame(() => ref.current?.focus());
    const checked = entries.findIndex((e) => isItem(e) && e.checked);
    setActive(checked >= 0 ? checked : -1);
    return () => cancelAnimationFrame(frame);
  }, []);

  const choose = (e: Item) => {
    onDone();
    e.onSelect();
  };
  const move = (dir: 1 | -1) => {
    if (!usable.length) return;
    const at = usable.indexOf(active);
    setActive(at < 0 ? usable[dir > 0 ? 0 : usable.length - 1] : usable[(at + dir + usable.length) % usable.length]);
  };

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') e.preventDefault(), move(1);
        else if (e.key === 'ArrowUp') e.preventDefault(), move(-1);
        else if (e.key === 'Home') e.preventDefault(), setActive(usable[0] ?? -1);
        else if (e.key === 'End') e.preventDefault(), setActive(usable[usable.length - 1] ?? -1);
        else if (e.key === 'Enter' || e.key === ' ') {
          const item = entries[active];
          if (item && isItem(item) && !item.disabled) e.preventDefault(), choose(item);
        } else if (e.key.length === 1 && /\S/.test(e.key)) {
          const from = usable.indexOf(active);
          const order = [...usable.slice(from + 1), ...usable.slice(0, from + 1)];
          const hit = order.find((i) => (entries[i] as Item).label.toLowerCase().startsWith(e.key.toLowerCase()));
          if (hit !== undefined) setActive(hit);
        }
      }}
    >
      {entries.map((e, i) => {
        if (e.kind === 'separator') return <div key={`s${i}`} className="menu-sep" role="separator" />;
        if (e.kind === 'label') return <div key={`l${i}`} className="menu-label">{e.label}</div>;
        return (
          <button
            key={e.id}
            type="button"
            role={e.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={e.checked}
            className={`menu-item ${i === active ? 'is-active' : ''} ${e.danger ? 'is-danger' : ''}`}
            disabled={e.disabled}
            tabIndex={-1}
            onPointerMove={() => active !== i && setActive(i)}
            onClick={() => choose(e)}
          >
            {trailingCheck ? e.icon && <span className="menu-icon">{e.icon}</span> : (hasChecks || e.icon) && <span className="menu-icon">{e.checked ? <Check size={14} weight="bold" /> : e.icon}</span>}
            <span className="menu-text">
              <span className="menu-name">{e.label}</span>
              {e.hint && <span className="menu-hint">{e.hint}</span>}
            </span>
            {e.keys && <Keys combo={e.keys} />}
            {trailingCheck && e.checked && <Check size={14} weight="bold" className="menu-check" />}
          </button>
        );
      })}
    </div>
  );
}

export function Menu({
  anchor,
  entries,
  onClose,
  placement,
  ignore,
  className,
  field,
  trailingCheck = field,
}: {
  anchor: Anchor;
  entries: MenuEntry[];
  onClose: () => void;
  placement?: Placement;
  ignore?: Element | null;
  className?: string;
  /** The list of a form field: as wide as the field, just below it, rows aligned with its text. */
  field?: boolean;
  /** The chosen row is marked at its end, its own icon kept in front (a field's list, choices with icons). */
  trailingCheck?: boolean;
}) {
  return (
    <Popover anchor={anchor} placement={placement} onClose={onClose} ignore={ignore} className={`${className ?? ''} ${field ? 'is-field-list' : ''}`} minWidth={field ? anchor.w : undefined} gap={field ? 4 : undefined}>
      <MenuList entries={entries} onDone={onClose} trailingCheck={trailingCheck} />
    </Popover>
  );
}
