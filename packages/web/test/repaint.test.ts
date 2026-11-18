import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles');
const css = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')]));

/** Splits on the commas outside brackets. */
function split(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(' || list[i] === '[') depth++;
    else if (list[i] === ')' || list[i] === ']') depth--;
    else if (list[i] === ',' && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim().replace(/\s+/g, ' ').replace(/"/g, "'")).filter(Boolean);
}

/** A selector, with a list in :where() or :is() standing for each of its parts. */
function parts(selector: string): string[] {
  const group = /^:(?:where|is)\((.*)\)$/.exec(selector);
  return group ? split(group[1]) : [selector];
}

/** Properties a theme switch changes, so a transition on one of them would ease the switch. */
const COLOUR = /^(all|background(-color)?|color|border(-\w+)?(-color)?|box-shadow|outline(-color)?|text-decoration(-color)?|fill|stroke|caret-color|accent-color)$/;

describe('the repaint rule of a theme switch', () => {
  const repaint = /\.is-repainting\s*:is\(([^{]*)\)\s*\{/.exec(css['base.css']);
  const listed = new Set(split(repaint?.[1] ?? ''));

  it('names every control that eases a colour', () => {
    expect(repaint).not.toBeNull();
    const missing: string[] = [];
    for (const [file, text] of Object.entries(css)) {
      for (const [, selectors, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const [, property, value] of body.matchAll(/(?:^|;)\s*(transition|transition-property)\s*:\s*([^;]+)/g)) {
          const eases = split(value).some((part) => COLOUR.test(part.split(' ')[0]));
          if (!eases || (property === 'transition' && /^none/.test(value.trim()))) continue;
          for (const selector of split(selectors).flatMap(parts)) if (!listed.has(selector)) missing.push(`${file}: ${selector}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
