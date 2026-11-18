/** The motion tokens from the stylesheet, and whether the system asks for less motion. */
export function motion(): { fast: number; slow: number; ease: string; still: boolean } {
  const css = getComputedStyle(document.documentElement);
  const ms = (name: string, d: number) => parseFloat(css.getPropertyValue(name)) || d;
  return { fast: ms('--fast', 120), slow: ms('--slow', 180), ease: css.getPropertyValue('--ease').trim() || 'ease-out', still: matchMedia('(prefers-reduced-motion: reduce)').matches };
}
