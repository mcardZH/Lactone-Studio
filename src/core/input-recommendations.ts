import { atomicNumber } from './elements';
import type { Atom } from './types';

/** Form recommendations only: parity does not establish a physical spin state. */
export function suggestFragmentState(atoms: readonly Atom[]) {
  const electrons = atoms.reduce((sum, atom) => sum + atomicNumber(atom.element), 0);
  return { charge: 0, multiplicity: electrons % 2 === 0 ? 1 : 2 };
}

export function recommendedExcitedStates(atomCount: number, task: 'td' | 'tdopt', root = 1): number {
  if (task === 'tdopt') return 5 * Math.ceil((root + 3) / 5);
  return atomCount <= 20 ? 20 : atomCount <= 30 ? 30 : atomCount <= 50 ? 50 : atomCount <= 80 ? 80 : 100;
}
