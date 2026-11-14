import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dropWeights } from '../icon-weights.mjs';

// The icon modules as the build reads them (the package's own entry points lead to its bundles instead).
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/@phosphor-icons/react/dist/defs');
const defs = (name: string) => fs.readFileSync(path.join(dir, `${name}.es.js`), 'utf8');

/** Run an icon module with a stand-in for React and return the weights its map holds. */
function weightsOf(code: string): string[] {
  const body = code
    .replace(/^import \* as (\w+) from "react";/m, 'const $1 = { createElement: (...x) => x, Fragment: "f" };')
    .replace(/export \{\s*(\w+) as default\s*\};?\s*$/, 'return $1;');
  return [...(new Function(body)() as Map<string, unknown>).keys()];
}

describe('icon weights in the page', () => {
  it('drops thin and light and keeps the four the interface draws', () => {
    for (const name of ['Camera', 'FolderSimple', 'CircleNotch', 'MagnifyingGlass']) {
      const before = defs(name);
      expect(weightsOf(before)).toEqual(['bold', 'duotone', 'fill', 'light', 'regular', 'thin']);
      expect(weightsOf(dropWeights(before))).toEqual(['bold', 'duotone', 'fill', 'regular']);
    }
  });

  it('leaves other code as it was', () => {
    const code = 'export const x = [ "thinking", 1 ];';
    expect(dropWeights(code)).toBe(code);
  });
});
