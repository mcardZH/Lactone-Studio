import { electronicStateError, electronicStateParameterError, suggestedMultiplicity } from './elements';
import type { Atom, Structure } from './types';

export interface BaseElectronicStateValues { charge: number; multiplicity: number }
export type ElectronicStateEditField = 'charge' | 'multiplicity';
export interface PairedElectronicStateEdit {
  values: BaseElectronicStateValues;
  /** Only the other field was adjusted; the explicitly edited value is kept. */
  paired: boolean;
  /** No replacement was committed. The owner retains the previous configuration
   * and the user's uncommitted text so it can be corrected. */
  error: string | null;
}

/** Submit one explicit field edit. This is not a ground-state inference and is
 * never called for import, geometry edits, source restore or a running snapshot. */
export function pairEditedElectronicState(atoms: readonly Atom[], previous: BaseElectronicStateValues,
  field: ElectronicStateEditField, value: number): PairedElectronicStateEdit {
  const edited = { ...previous, [field]: value };
  const parameterError = field === 'charge'
    ? electronicStateParameterError(value, 1) : electronicStateParameterError(0, value);
  if (parameterError) return { values: previous, paired: false, error: parameterError };
  // Without a structure there is no electron count from which to pair. Keep the
  // user's explicit parameters; the owning workflow still requires its source.
  if (!atoms.length) { const error=electronicStateParameterError(edited.charge,edited.multiplicity);return {values:error?previous:edited,paired:false,error}; }
  try {
    if (!electronicStateError([...atoms], edited.charge, edited.multiplicity)) return { values: edited, paired: false, error: null };
    const candidates = field === 'charge'
      ? [{ charge: value, multiplicity: suggestedMultiplicity([...atoms], value) }]
      : [0, 1].map(charge => ({ charge, multiplicity: value }));
    const accepted = candidates.find(values => !electronicStateError([...atoms], values.charge, values.multiplicity));
    if (accepted) return { values: accepted, paired: true, error: null };
    return { values: previous, paired: false, error: '当前结构无法按这次手改值配对电荷与多重度；原设置已保留，请调整输入。' };
  } catch (cause) {
    return { values: previous, paired: false, error: cause instanceof Error ? cause.message : '当前结构元素无效，原电子态设置已保留。' };
  }
}
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

export function baseElectronicStateParameterError(structure:BaseStructure|null,values:BaseElectronicStateValues):string|null {
  if(!structure?.atoms.length)return '请先提供结构。';
  return electronicStateParameterError(values.charge,values.multiplicity);
}

/** A compatible edit retains acceptance of the shared base state only.
 * Task-reference and source/Hessian confirmations are owned by their own bridges. */
export function retainBaseElectronicStateConfirmation(accepted: boolean, structure: BaseStructure | null, values: BaseElectronicStateValues): boolean {
  return accepted && baseElectronicStateParameterError(structure, values) === null;
}
