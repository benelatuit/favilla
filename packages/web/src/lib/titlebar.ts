import { desktop } from './desktop';

type Rgba = { r: number; g: number; b: number; a: number };

/** A colour the browser computed ("rgb(…)", "rgba(…)", or "#rrggbb" from a variable). */
function parse(color: string): Rgba | undefined {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (hex) return { r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16), a: 1 };
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)/i.exec(color);
  if (!m) return undefined;
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
}

function toHex(c: Rgba): string {
  return `#${[c.r, c.g, c.b].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('')}`;
}

/** The base colour seen through a translucent veil. */
function through(base: string, veil: Rgba): string {
  const b = parse(base);
  if (!b) return base;
  return toHex({ r: b.r * (1 - veil.a) + veil.r * veil.a, g: b.g * (1 - veil.a) + veil.g * veil.a, b: b.b * (1 - veil.a) + veil.b * veil.a, a: 1 });
}

let painted = '';

/**
 * Windows draws the window buttons itself, above the page, in the colours given here. Give them the title bar's
 * colours as seen now: through a dialog's veil while one dims the whole window, or the image viewer's own colours
 * while it fills it, so they never stay lit over a dimmed page. A drawer's shade starts below the title bar and
 * leaves it as it is.
 */
export function paintTitleBar(): void {
  if (!desktop) return;
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  let color = v('--board');
  // The window buttons' symbols in the title bar's secondary ink, as its other icons are drawn.
  let symbol = v('--ink-2');
  const viewer = document.querySelector<HTMLElement>('.viewer');
  if (viewer) {
    // Its colours from the theme, not as computed: its shade fades in and out.
    const st = getComputedStyle(viewer);
    const bg = parse(st.getPropertyValue('--viewer-bg'));
    const ink = parse(st.getPropertyValue('--viewer-ink'));
    if (bg) color = toHex(bg);
    if (ink) symbol = toHex(ink);
  } else {
    for (const el of document.querySelectorAll<HTMLElement>('.scrim')) {
      const veil = parse(getComputedStyle(el).backgroundColor);
      if (!veil || veil.a <= 0) continue;
      color = through(color, veil);
      symbol = through(symbol, veil);
    }
  }
  const background = v('--paper');
  const key = `${color}${symbol}${background}`;
  if (key === painted || !/^#[0-9a-f]{6}$/i.test(color) || !/^#[0-9a-f]{6}$/i.test(symbol)) return;
  painted = key;
  desktop.setTitleBar({ color, symbol, background });
}
