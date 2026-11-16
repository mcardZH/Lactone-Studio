import type { AdvancedFrameRef, AdvancedFrameSource } from './frame-source';
import { coordinatesFingerprint, graphFingerprint } from '../../core/modeling/graph';
import {electronicInventorySignature} from '../../core/modeling/electronic-state-policy';

type ElectronicSource=Pick<AdvancedFrameSource,'ref'|'structure'>;
/** Document lifetime/activation and revision still seal writes. They are not
 * scientific input: save/reopen, metadata and a new run may change them. */
function inputOrigin(ref:Readonly<AdvancedFrameRef>){
  return [ref.documentId,ref.sourceId??null,ref.sourceRevision??null,ref.frameId??null,ref.sourceFrameIndex??null];
}
export function advancedElectronicInputIdentity(source:ElectronicSource|null|undefined):string{
  if(!source)return '';
  return JSON.stringify(['electronic-input/v3',inputOrigin(source.ref),electronicInventorySignature(source.structure)]);
}

/** Raw single-point drafts still belong to the full input snapshot. Their
 * validity is independent of the basic q/M confirmation above. */
export function advancedElectronicDraftIdentity(source:ElectronicSource):string{
  return JSON.stringify(['electronic-input/v2',inputOrigin(source.ref),coordinatesFingerprint(source.structure),
    graphFingerprint(source.structure),source.structure.atoms.map(atom=>atom.id)]);
}

/** A user confirmation belongs to this complete scientific source identity.
 * Mere presence of charge/multiplicity is never a confirmation receipt. */
export function advancedElectronicSourceConfirmationKey(source: ElectronicSource | null | undefined,
  state: { charge: number; multiplicity: number }): string {
  return JSON.stringify([advancedElectronicInputIdentity(source&&{...source,structure:{...source.structure,...state}}),state.charge,state.multiplicity]);
}

/** Existing supported projects carry the former full-ref receipt. Reuse it
 * only when its stable origin, actual coordinates, graph and q/M all agree. */
export function advancedElectronicConfirmationMatches(receipt:string|undefined,source:ElectronicSource|null|undefined,state:{charge:number;multiplicity:number}):boolean{
  if(!receipt||!source)return false;
  if(receipt===advancedElectronicSourceConfirmationKey(source,state))return true;
  try{
    const old:unknown=JSON.parse(receipt);
    if(Array.isArray(old)&&old.length===3&&old[1]===state.charge&&old[2]===state.multiplicity&&typeof old[0]==='string'){
      const input=JSON.parse(old[0]);
      return Array.isArray(input)&&input[0]==='electronic-input/v2'
        &&JSON.stringify(input[1])===JSON.stringify(inputOrigin(source.ref))
        &&input[2]===coordinatesFingerprint(source.structure)&&input[3]===graphFingerprint({...source.structure,...state});
    }
    if(!Array.isArray(old)||old.length!==6||!old[0]||typeof old[0]!=='object'||old[4]!==state.charge||old[5]!==state.multiplicity)return false;
    return JSON.stringify(inputOrigin(old[0] as AdvancedFrameRef))===JSON.stringify(inputOrigin(source.ref))
      &&old[1]===coordinatesFingerprint(source.structure)
      &&old[2]===graphFingerprint({...source.structure,...state});
  }catch{return false;}
}
