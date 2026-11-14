import { isMac } from '../../lib/desktop';

const NAMES: Record<string, string> = isMac
  ? { Mod: '⌘', Alt: '⌥', Shift: '⇧', Enter: '↩', Esc: 'esc', Backspace: '⌫' }
  : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Enter: 'Enter', Esc: 'Esc', Backspace: 'Backspace' };

/** A key combination such as "Mod+K", drawn as key caps; Mod is Ctrl, or ⌘ on a Mac. */
export function Keys({ combo }: { combo: string }) {
  return (
    <span className="keys " aria-label={keysLabel(combo)}>
      {combo.split('+').map((k) => (
        <kbd key={k}>{NAMES[k] ?? k}</kbd>
      ))}
    </span>
  );
}

function keysLabel(combo: string): string {
  return combo
    .split('+')
    .map((k) => NAMES[k] ?? k)
    .join(isMac ? '' : '+');
}
