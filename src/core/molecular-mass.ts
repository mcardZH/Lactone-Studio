import table from '../data/atomic-weights.json';
import type { Atom } from './types';

export const ATOMIC_WEIGHT_SOURCE = { url: table.source, title: table.table };
const weights: Record<string, number> = table.weights;
export interface MolecularMass { value: number | null; unknownElements: string[] }

/** Mean molecular mass (u), using only explicit atoms; never infer implicit H or isotope masses. */
export function molecularMass(atoms: Pick<Atom, 'element'>[]): MolecularMass {
  if (!atoms.length) return { value: null, unknownElements: [] };
  const unknownElements = [...new Set(atoms.filter(atom => weights[atom.element] === undefined).map(atom => atom.element))];
  if (unknownElements.length) return { value: null, unknownElements };
  return { value: atoms.reduce((sum, atom) => sum + weights[atom.element], 0), unknownElements: [] };
}
