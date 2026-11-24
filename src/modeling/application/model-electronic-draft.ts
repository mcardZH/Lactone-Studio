import type {ModelStore} from '../contracts';
import {electronicStateParameterError} from '../../core/elements';
import type {ProjectUiStore} from '../../projects/ui-state';
import {pairEditedElectronicState,type ElectronicStateEditField,type PairedElectronicStateEdit} from '../../core/base-electronic-state';
import type {Atom} from '../../core/types';
import {electronicInventorySignature} from '../../core/modeling/electronic-state-policy';

export interface ModelElectronicDraft {
  chargeText:string;multiplicityText:string;
  baseCharge:number|null;baseMultiplicity:number|null;
  baseStructureId?:string;
  baseInventory?:string;
  deferred:boolean;
  lastEditedField?:ElectronicStateEditField;
  pairingError?:string|null;
}
export function modelElectronicDraftKey(documentId:string){return JSON.stringify(['document',documentId,'shared-electronic-draft']);}
export function modelElectronicDraftValues(draft:ModelElectronicDraft):{charge:number;multiplicity:number}|null {
  if(!/^[+-]?\d+$/.test(draft.chargeText)||!/^\+?\d+$/.test(draft.multiplicityText))return null;
  const values={charge:Number(draft.chargeText),multiplicity:Number(draft.multiplicityText)};
  return electronicStateParameterError(values.charge,values.multiplicity)?null:values;
}
export function readModelElectronicDraft(store:ModelStore,ui:ProjectUiStore):ModelElectronicDraft {
  const document=store.getSnapshot(),source=document.draft.structure;
  const charge=source.charge??null,multiplicity=source.multiplicity??null;
  const saved=ui.get<ModelElectronicDraft|undefined>(modelElectronicDraftKey(document.id),undefined);
  if(saved&&typeof saved.chargeText==='string'&&typeof saved.multiplicityText==='string'&&typeof saved.deferred==='boolean'){
    if(saved.baseCharge===charge&&saved.baseMultiplicity===multiplicity)return saved;
    // A structural edit may pair the committed M while one numeric field is
    // still being typed. Keep that text; refresh only untouched base fields.
    if(saved.deferred&&saved.lastEditedField&&saved.baseStructureId===source.id&&saved.baseInventory!==electronicInventorySignature(source))return {...saved,baseCharge:charge,baseMultiplicity:multiplicity,baseInventory:electronicInventorySignature(source),
      chargeText:saved.lastEditedField==='charge'||saved.chargeText!==String(saved.baseCharge??'')?saved.chargeText:charge===null?'':String(charge),
      multiplicityText:saved.lastEditedField==='multiplicity'||saved.multiplicityText!==String(saved.baseMultiplicity??'')?saved.multiplicityText:multiplicity===null?'':String(multiplicity)};
  }
  return {chargeText:charge===null?'':String(charge),multiplicityText:multiplicity===null?'':String(multiplicity),baseCharge:charge,baseMultiplicity:multiplicity,baseStructureId:source.id,baseInventory:electronicInventorySignature(source),deferred:false};
}
/** Future settings use the existing per-project JSON draft owner. A live run's
 * Store, captured request and source identity are never edited or stopped. */
export function editModelElectronicDraft(store:ModelStore,ui:ProjectUiStore,field:'charge'|'multiplicity',text:string,initial?:{charge:number;multiplicity:number}):void {
  const stored=ui.has(modelElectronicDraftKey(store.getSnapshot().id)),base=readModelElectronicDraft(store,ui);
  const current=!stored&&initial?{...base,chargeText:Number.isFinite(initial.charge)?String(initial.charge):'',multiplicityText:Number.isFinite(initial.multiplicity)?String(initial.multiplicity):''}:base;
  const next={...current,[field==='charge'?'chargeText':'multiplicityText']:text,deferred:true,lastEditedField:field,pairingError:null};
  ui.set(modelElectronicDraftKey(store.getSnapshot().id),next);
}
/** A raw edit has no Store/history edge. Blur/step/confirmation pairs both values
 * and writes them together; a live run keeps its immutable scientific snapshot. */
export function commitModelElectronicDraft(store:ModelStore,ui:ProjectUiStore,field?:ElectronicStateEditField,text?:string,atoms:readonly Atom[]=store.getSnapshot().draft.structure.atoms):PairedElectronicStateEdit|null {
  const current=readModelElectronicDraft(store,ui),editedField=field??current.lastEditedField;
  if(!editedField)return null;
  if(field&&current.lastEditedField!==field&&(text===undefined||text===current[field==='charge'?'chargeText':'multiplicityText']))return null;
  const edited={...current,...(text===undefined?{}:{[editedField==='charge'?'chargeText':'multiplicityText']:text})};
  const values=modelElectronicDraftValues(edited);
  if(!values)return null;
  const result=pairEditedElectronicState(atoms,values,editedField,values[editedField]);
  const key=modelElectronicDraftKey(store.getSnapshot().id);
  if(result.error){ui.set(key,{...edited,deferred:true,lastEditedField:editedField,pairingError:result.error});return result;}
  if(!store.isRuntimeSessionActive?.()){
    const source=store.getSnapshot().draft.structure;
    if(source.charge!==result.values.charge||source.multiplicity!==result.values.multiplicity)
      store.execute({type:'set-electronic-state',...result.values,confirmed:false});
  }
  const source=store.getSnapshot().draft.structure;
  ui.set(key,{...edited,chargeText:String(result.values.charge),multiplicityText:String(result.values.multiplicity),
    baseCharge:source.charge??null,baseMultiplicity:source.multiplicity??null,deferred:store.isRuntimeSessionActive?.()===true,lastEditedField:undefined,pairingError:null});
  return result;
}
export function flushModelElectronicDraft(store:ModelStore,ui:ProjectUiStore,confirmed=false):boolean {
  const current=readModelElectronicDraft(store,ui),values=modelElectronicDraftValues(current);
  if(!values||store.isRuntimeSessionActive?.())return false;
  const source=store.getSnapshot().draft.structure;
  if(source.charge!==values.charge||source.multiplicity!==values.multiplicity)store.execute({type:'set-electronic-state',...values,confirmed});
  else store.setElectronicState(values.charge,values.multiplicity,confirmed);
  const document=store.getSnapshot();
  ui.set(modelElectronicDraftKey(document.id),{...current,baseCharge:document.draft.structure.charge??null,baseMultiplicity:document.draft.structure.multiplicity??null,deferred:false});
  return true;
}
export function replaceModelElectronicDraft(store:ModelStore,ui:ProjectUiStore,values:{charge:number;multiplicity:number},confirmed=false):void {
  const current=readModelElectronicDraft(store,ui);
  ui.set(modelElectronicDraftKey(store.getSnapshot().id),{...current,chargeText:Number.isFinite(values.charge)?String(values.charge):'',multiplicityText:Number.isFinite(values.multiplicity)?String(values.multiplicity):'',
    deferred:true,lastEditedField:undefined,pairingError:null});
  if(!store.isRuntimeSessionActive?.())flushModelElectronicDraft(store,ui,confirmed);
}
