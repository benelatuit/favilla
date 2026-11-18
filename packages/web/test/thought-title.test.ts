import { expect, it } from 'vitest';
import { thoughtTitle } from '../src/components/timeline/ThoughtBlock';

it('keeps the underscores inside a name and drops only emphasis marks', () => {
  expect(thoughtTitle('Checking MONTH_DAYS against leap years')).toBe('Checking MONTH_DAYS against leap years');
  expect(thoughtTitle('**Fixing parse_date** first')).toBe('Fixing parse_date');
  expect(thoughtTitle('This is _really_ the __last__ one')).toBe('This is really the last one');
  expect(thoughtTitle('snake_case and __dunder__ names')).toBe('snake_case and dunder names');
  expect(thoughtTitle('a *b* and **c** and ***d***')).toBe('a b and c and d');
});

it('keeps code spans as written, without their backticks', () => {
  expect(thoughtTitle('Reading `MONTH_DAYS[2]` and `__init__`')).toBe('Reading MONTH_DAYS[2] and __init__');
  expect(thoughtTitle('Use ``a `b` c`` here')).toBe('Use a `b` c here');
});

it('drops heading and quote marks and folds lines', () => {
  expect(thoughtTitle('## Plan\n> check the_end\nthen go')).toBe('Plan check the_end then go');
  expect(thoughtTitle('a stray ` backtick')).toBe('a stray backtick');
});

it('shortens a long thought to 140 characters', () => {
  const title = thoughtTitle('x'.repeat(200));
  expect(title).toHaveLength(141);
  expect(title.endsWith('…')).toBe(true);
});
