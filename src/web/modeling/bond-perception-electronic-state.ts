import type {ModelDocument} from '../../modeling/contracts';
import {electronicStateError} from '../../core/elements';
import {electronicInventory} from '../../modeling/application/electronic-state-context';

export interface BondElectronicValues {charge:number;multiplicity:number}
export interface BondElectronicDraft extends BondElectronicValues {documentId:string;sourceKey:string;baseStateKey:string}
const sourceKey=(document:ModelDocument)=>JSON.stringify([document.draft.structure.id,electronicInventory(document.draft.structure)]);
const baseStateKey=(document:ModelDocument)=>JSON.stringify([document.draft.structure.charge,document.draft.structure.multiplicity,document.electronicStateConfirmed===true]);
/** An explicit local entry belongs to this document/source inventory and the
 * canonical electronic state it was entered against, not just to a tab name. */
export function captureBondElectronicDraft(document:ModelDocument,values:BondElectronicValues):BondElectronicDraft{return{...values,documentId:document.id,sourceKey:sourceKey(document),baseStateKey:baseStateKey(document)};}
export function bondElectronicDraftCurrent(document:ModelDocument,draft:BondElectronicDraft|null|undefined):draft is BondElectronicDraft{return Boolean(draft&&draft.documentId===document.id&&draft.sourceKey===sourceKey(document)&&draft.baseStateKey===baseStateKey(document));}
/** Only the authoritative document's confirmation or an explicit matching
 * local entry grants this P01 run. Input-task/request flags are not owners of
 * this document and numeric q/M suggestions alone never grant confirmation. */
export function bondPerceptionElectronicState(document:ModelDocument,options:{local?:BondElectronicDraft|null;consent?:BondElectronicDraft|null;override?:BondElectronicDraft|null}={}){
  const explicit=[options.override,options.local,options.consent].find(value=>bondElectronicDraftCurrent(document,value));
  const electronic:BondElectronicValues=explicit?{charge:explicit.charge,multiplicity:explicit.multiplicity}:{charge:document.draft.structure.charge??Number.NaN,multiplicity:document.draft.structure.multiplicity??Number.NaN};
  const known=Boolean(explicit||document.electronicStateConfirmed===true);
  const valid=known&&Number.isSafeInteger(electronic.charge)&&Number.isSafeInteger(electronic.multiplicity)&&electronic.multiplicity>=1&&!electronicStateError(document.draft.structure.atoms,electronic.charge,electronic.multiplicity);
  return{known,valid,electronic};
}
