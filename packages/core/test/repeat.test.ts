import { describe, expect, it } from 'vitest';
import { REPEAT_SPAN, RepeatWatch, repeatingTail } from '../src/agent/repeat';

const row = '\t\t{"RoundUp", "0.01230000000000000000000000000000", 4, "0.0123", -4},\n';

describe('repeatingTail', () => {
  it('finds a line repeated over the whole span', () => {
    const s = 'func TestRound(t *testing.T) {\n' + row.repeat(200);
    expect(repeatingTail(s)).toHaveLength(row.length);
  });

  it('finds one character repeated', () => {
    expect(repeatingTail('x'.repeat(REPEAT_SPAN))).toBe('x');
  });

  it('leaves code whose lines only look alike', () => {
    const rows = Array.from({ length: 400 }, (_, i) => `\t\t{"RoundUp", "0.0123", ${i}, "0.0123", -${i}},\n`).join('');
    expect(repeatingTail(rows)).toBeNull();
  });

  it('leaves a stream shorter than the span', () => {
    expect(repeatingTail(row.repeat(10))).toBeNull();
  });

  it('leaves a repeat that has ended', () => {
    const s = row.repeat(200) + 'func other() {\n\treturn 1\n}\n'.repeat(1) + 'x := strings.Repeat("ab", 4)\n'.repeat(1);
    expect(repeatingTail(s)).toBeNull();
  });
});

describe('RepeatWatch', () => {
  it('reports a loop in a streamed part, and only in that part', () => {
    const w = new RepeatWatch();
    let found: string | null = null;
    for (let i = 0; i < 400 && !found; i++) {
      expect(w.add('text:0', `line ${i} of the answer, all different\n`)).toBeNull();
      found = w.add('tool:1', row);
    }
    expect(found).toBe(row.slice(-row.length));
  });
});
