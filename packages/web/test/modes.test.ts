import { describe, expect, it } from 'vitest';
import { MODE_ORDER, nextMode } from '../src/lib/modes';

describe('the composer modes', () => {
  it('go round in the order the menu lists them', () => {
    expect(MODE_ORDER).toEqual(['build', 'plan']);
    expect(nextMode('build')).toBe('plan');
    expect(nextMode('plan')).toBe('build');
  });
});
