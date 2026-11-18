import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = path.join(import.meta.dirname, '../src/styles');
const read = (file: string) => fs.readFileSync(path.join(styles, file), 'utf8');

describe('the pen, what is under way', () => {
  const base = read('base.css');
  const keyframes = [...base.matchAll(/@keyframes (pen-[\w-]+) \{([\s\S]*?)\n\}/g)];

  it('moves only transform and opacity, so a frame costs no layout and no paint', () => {
    expect(keyframes.map((k) => k[1]).sort()).toEqual(['pen-step-1', 'pen-step-2', 'pen-step-3', 'pen-think', 'pen-write']);
    for (const [, name, body] of keyframes) {
      const props = new Set([...body.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]));
      for (const prop of props) expect(['transform', 'opacity', 'animation-timing-function'], `${name} ${prop}`).toContain(prop);
    }
  });

  it('holds still when motion is reduced', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.pen i \{\s*animation: none !important;/.exec(base);
    expect(reduced).not.toBeNull();
  });

  it('is the only mark of work under way: no turning ring is left', () => {
    for (const file of fs.readdirSync(styles).filter((f) => f.endsWith('.css'))) {
      const css = read(file);
      expect(css, file).not.toMatch(/@keyframes spin\b|\.spindle\b|\.spin\b|rotate\(360deg\)/);
    }
  });
});
