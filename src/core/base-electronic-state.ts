import { electronicStateError, suggestedMultiplicity } from './elements';
import type { Structure } from './types';

export interface BaseElectronicStateValues { charge: number; multiplicity: number }
type BaseStructure = Pick<Structure, 'atoms' | 'charge' | 'multiplicity'>;

/** Missing metadata gets a parity suggestion, never a claim about the ground state.
 * Explicit source values stay visible even when they require correction. */
export function initialBaseElectronicState(structure: BaseStructure | null): BaseElectronicStateValues {
  const charge = structure?.charge ?? 0;
  const multiplicity = structure?.multiplicity ?? (Number.isInteger(charge)
    ? suggestedMultiplicity(structure?.atoms ?? [], charge) : Number.NaN);
  return { charge, multiplicity };
}

/** UI navigation uses the existing input capability, including Ne >= 1. */
export function baseElectronicStateError(structure: BaseStructure | null, values: BaseElectronicStateValues): string | null {
  if (!structure?.atoms.length) return '请先提供结构。';
  try { return electronicStateError(structure.atoms, values.charge, values.multiplicity); }
  catch (cause) { return cause instanceof Error ? cause.message : '结构元素无效。'; }
}

/** A compatible edit retains acceptance of the shared base state only.
 * Task-reference and source/Hessian confirmations are owned by their own bridges. */
export function retainBaseElectronicStateConfirmation(accepted: boolean, structure: BaseStructure | null, values: BaseElectronicStateValues): boolean {
  return accepted && baseElectronicStateError(structure, values) === null;
}
