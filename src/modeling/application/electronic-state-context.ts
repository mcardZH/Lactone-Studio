import type { GaussianSettings, Structure } from '../../core/types';
import type { OrcaSettings } from '../../core/orca/types';

export interface ElectronicStateContext {
  structure: Structure | null; charge:number; multiplicity:number; electronicStateConfirmed:boolean;
  settings?: GaussianSettings | OrcaSettings;
}
export const electronicInventory=(structure:Structure|null)=>JSON.stringify(structure?.atoms.map(atom=>[atom.id,atom.element,atom.formalCharge??0])??null);

/** An excited-state task has the same save gate as every other task. */
export function requiresElectronicStateConfirmation(structure:Structure,request?:ElectronicStateContext):boolean {
  if(!request?.electronicStateConfirmed || electronicInventory(structure)!==electronicInventory(request.structure))return true;
  return structure.charge!=null && structure.charge!==request.charge || structure.multiplicity!=null && structure.multiplicity!==request.multiplicity;
}
