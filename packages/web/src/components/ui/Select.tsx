import { useRef, useState, type ReactNode } from 'react';
import { CaretDown } from '../icons';
import { Menu } from './Menu';
import { anchorOf, type Anchor, type Placement } from './Popover';

interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
  /** Drawn before the label in the list. */
  icon?: ReactNode;
}

/** The app's own select: a quiet button that opens a menu of choices with the current one checked. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  tip,
  keys,
  className,
  placement = 'bottom-start',
  icon,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  tip?: string;
  /** A key that does the same from elsewhere, shown in the tip. */
  keys?: string;
  className?: string;
  placement?: Placement;
  icon?: ReactNode;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const label = options.find((o) => o.value === value)?.label ?? value;
  const field = !!className?.split(' ').includes('is-field');
  // Choices with their own icons keep them in front and mark the chosen one at the end.
  const iconed = options.some((o) => o.icon);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`select ${anchor ? 'is-open' : ''} ${className ?? ''}`}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label={tip ? `${tip}: ${label}` : undefined}
        data-tip={anchor ? undefined : tip}
        data-keys={anchor ? undefined : keys}
        onClick={() => setAnchor(anchor ? null : anchorOf(btn.current!))}
      >
        {icon}
        <span className="select-value">{label}</span>
        <CaretDown size={11} className="select-caret" />
      </button>
      {anchor && (
        <Menu
          anchor={anchor}
          placement={placement}
          ignore={btn.current}
          field={field}
          trailingCheck={field || iconed}
          onClose={() => {
            // Closed from the keyboard (a choice, Esc), the keys go back to the select they came from.
            const fromMenu = !!document.activeElement?.closest('.popover');
            setAnchor(null);
            if (fromMenu) btn.current?.focus();
          }}
          entries={options.map((o) => ({ id: o.value, label: o.label, hint: o.hint, icon: o.icon, checked: o.value === value, onSelect: () => onChange(o.value) }))}
        />
      )}
    </>
  );
}
