import { describe, expect, it } from 'vitest';
import { applyReplace } from '../src/tools/replace';

const file = `function add(a, b) {
    return a + b;
}

function sub(a, b) {
    return a - b;
}
`;

describe('applyReplace', () => {
  it('replaces an exact unique match', () => {
    const r = applyReplace(file, 'return a + b;', 'return b + a;');
    expect(r.ok && r.content.includes('return b + a;')).toBe(true);
    expect(r.ok && r.strategy).toBe('exact');
  });

  it('refuses ambiguous matches and names the lines', () => {
    const r = applyReplace(file, '(a, b) {', '(x, y) {');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/2 places \(lines 1, 5\)/);
  });

  it('replaces every occurrence with replace_all', () => {
    const r = applyReplace(file, '(a, b) {', '(x, y) {', true);
    expect(r.ok && r.content.match(/\(x, y\)/g)?.length).toBe(2);
  });

  it('matches despite wrong indentation and re-indents the replacement', () => {
    const r = applyReplace(file, 'function sub(a, b) {\n  return a - b;\n}', 'function sub(a, b) {\n  const d = a - b;\n  return d;\n}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe('indentation');
      expect(r.content).toContain('function sub(a, b) {\n    const d = a - b;\n    return d;\n}');
    }
  });

  it('matches despite trailing whitespace differences', () => {
    const r = applyReplace('a = 1   \nb = 2\n', 'a = 1\nb = 2', 'a = 3\nb = 4');
    expect(r.ok && r.content).toBe('a = 3\nb = 4\n');
  });

  it('matches literal escape sequences the model wrote by mistake', () => {
    const r = applyReplace('x = "hi"\ny = 2\n', 'x = \\"hi\\"\\ny = 2', 'x = "bye"\ny = 3');
    expect(r.ok && r.content).toBe('x = "bye"\ny = 3\n');
  });

  it('points to the closest region when nothing matches', () => {
    const r = applyReplace(file, 'function sub(a, c) {\n    return a - c;\n}', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/closest text is at lines 5-7/);
  });

  it('rejects identical old and new strings', () => {
    expect(applyReplace(file, 'a', 'a').ok).toBe(false);
  });
});
