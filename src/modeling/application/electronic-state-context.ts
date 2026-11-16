import type { GaussianSettings, Structure } from '../../core/types';
import type { OrcaSettings } from '../../core/orca/types';
import {electronicInventorySignature} from '../../core/modeling/electronic-state-policy';

export interface ElectronicStateContext {
  structure: Structure | null; charge:number; multiplicity:number; electronicStateConfirmed:boolean;
  settings?: GaussianSettings | OrcaSettings;
}
export const electronicInventory=electronicInventorySignature;

/** An excited-state task has the same save gate as every other task. */
export function requiresElectronicStateConfirmation(structure:Structure,request?:ElectronicStateContext):boolean {
  if(!request?.electronicStateConfirmed || electronicInventory(structure)!==electronicInventory(request.structure))return true;
  return structure.charge!=null && structure.charge!==request.charge || structure.multiplicity!=null && structure.multiplicity!==request.multiplicity;
}
