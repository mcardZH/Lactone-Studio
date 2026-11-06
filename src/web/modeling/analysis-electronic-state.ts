import type {Structure} from '../../core/types';
import {initialBaseElectronicState} from '../../core/base-electronic-state';

/** A source-owned unknown is not replaced by a form default. Explicit edits
 * still use the same canonical commit path for analyses and derived models. */
export function ownsSourceElectronicState(entry?:{analysisBinding?:unknown;derivation?:unknown}):boolean {
  return Boolean(entry?.analysisBinding||entry?.derivation);
}

/** Analysis-origin geometry owns its q/M, including explicit unknowns. A
 * missing value may have a form suggestion, never an automatic Store write. */
export function analysisSourceElectronicState(structure:Structure):{charge:number;multiplicity:number} {
  return initialBaseElectronicState(structure);
}

export function mayMirrorElectronicState(analysisOrigin:boolean, canonical:Pick<Structure,'charge'|'multiplicity'>, form:{charge:number;multiplicity:number}):boolean {
  return !analysisOrigin || canonical.charge===form.charge&&canonical.multiplicity===form.multiplicity;
}
