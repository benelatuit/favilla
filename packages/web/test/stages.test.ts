import { describe, expect, it } from 'vitest';
import { figureText, stagesOf, type StagesDisplay } from '../src/components/Stages';

const board = (state: 'on' | 'done'): StagesDisplay => ({ kind: 'stages', stages: [{ label: 'One', done: 1, of: 3, state }], figures: [{ label: '{n} found', n: 4 }] });

describe('the card of long work in stages', () => {
  it('puts both numbers into a figure, and leaves no {m} when there is none', () => {
    expect(figureText('{n} found, {m} after repeats', 12, 7)).toBe('12 found, 7 after repeats');
    expect(figureText('{n} proven by a test', '2/3')).toBe('2/3 proven by a test');
    expect(figureText('{n} found', 5, undefined)).toBe('5 found');
  });

  it("shows the card the call last sent while it runs, and the result's once it is done", () => {
    const live = board('on');
    const final = board('done');
    expect(stagesOf(undefined, live)).toBe(live);
    expect(stagesOf(final, live)).toBe(final);
    // A result of another kind (an error's text, say) is what the call ended with: the running card is gone.
    expect(stagesOf({ kind: 'text', text: 'stopped' }, live)).toBeUndefined();
    expect(stagesOf(undefined, { kind: 'text', text: 'x' })).toBeUndefined();
    expect(stagesOf()).toBeUndefined();
  });
});
