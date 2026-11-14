import type { Effort, Mode } from './types';

/** The ways the agent works, in the order the mode menu lists them and Shift+Tab goes round them. */
export const MODE_ORDER: Mode[] = ['build', 'plan'];

/** The reasoning efforts, lowest first: what a model offers when it does not say, and what the defaults choose from. */
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The mode Shift+Tab moves to from `mode`. */
export function nextMode(mode: Mode): Mode {
  return MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
}
