import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {sameAdvancedFrame} from '../../modeling/advanced/frame-source';
import type {WorkspaceActivationStamp} from '../../modeling/workspace-contracts';
import {advancedElectronicSourceConfirmationKey} from '../../modeling/advanced/electronic-confirmation';
import type {Structure} from '../../core/types';
import {pairEditedElectronicState,type ElectronicStateEditField} from '../../core/base-electronic-state';
export {advancedElectronicConfirmationMatches} from '../../modeling/advanced/electronic-confirmation';

export interface AdvancedElectronicState {charge:number;multiplicity:number;confirmed?:boolean;documentId?:string}
export interface AdvancedElectronicText {charge:string;multiplicity:string}
export function advancedElectronicTextValues(raw:AdvancedElectronicText):AdvancedElectronicState|null{
 if(!/^[+-]?\d+$/.test(raw.charge)||!/^\+?\d+$/.test(raw.multiplicity))return null;
 const values={charge:Number(raw.charge),multiplicity:Number(raw.multiplicity)};
 return validAdvancedElectronicDraft(values)?values:null;
}
/** Submit a single explicit edit to the common pairing policy. Raw typing is
 * separate; failures retain that text and cannot write either owner field. */
export function submitAdvancedElectronicText(structure:Structure,raw:AdvancedElectronicText,field:ElectronicStateEditField,text:string){
 const next={...raw,[field]:text};
 if(!/^[+-]?\d+$/.test(text)||!Number.isSafeInteger(Number(text))||field==='multiplicity'&&Number(text)<1)
  return {raw:next,values:null,error:'电荷必须为整数，自旋多重度必须为正整数。'};
 const previous={charge:/^[+-]?\d+$/.test(next.charge)?Number(next.charge):structure.charge??NaN,
  multiplicity:/^\+?\d+$/.test(next.multiplicity)?Number(next.multiplicity):structure.multiplicity??NaN};
 const result=pairEditedElectronicState(structure.atoms,previous,field,Number(text));
 if(result.error)return{raw:next,values:null,error:result.error};
 return{raw:{charge:field==='charge'?text:String(result.values.charge),multiplicity:field==='multiplicity'?text:String(result.values.multiplicity)},values:result.values,error:null};
}

/** Electronic metadata is editable without changing a frame's scientific identity.
 * In particular, confirming a draft must not invalidate itself when q/M returns
 * through the shared document or the controller's immutable source copy. */
export function advancedElectronicConfirmationKey(source:AdvancedFrameSource|null|undefined,state:AdvancedElectronicState):string {
 return advancedElectronicSourceConfirmationKey(source,state);
}

/** Only the current displayed document can supply shared values. Running jobs
 * continue to show their captured snapshot; historical frame objects stay intact. */
export function advancedElectronicDraftState(source:AdvancedFrameSource|null|undefined,shared:AdvancedElectronicState|undefined,displayed:AdvancedFrameSource|undefined,targetId:string|undefined,busy:boolean):AdvancedElectronicState {
 const current=source&&displayed&&(shared?.documentId??source.ref.documentId)===targetId&&sameAdvancedFrame(source.ref,displayed.ref)&&source.stamp.coordinatesFingerprint===displayed.stamp.coordinatesFingerprint;
 return shared&&current&&!busy?{charge:shared.charge,multiplicity:shared.multiplicity}:{charge:source?.structure.charge??0,multiplicity:source?.structure.multiplicity??1};
}

/** An incomplete numeric edit stays local until it can be stored losslessly. */
export function validAdvancedElectronicDraft(state:AdvancedElectronicState):boolean {
 return Number.isSafeInteger(state.charge)&&Number.isSafeInteger(state.multiplicity)&&state.multiplicity>=1;
}

/** A rendered editor can publish only to the document/view it actually showed. */
export function advancedElectronicOwnerCurrent(expected:WorkspaceActivationStamp,current:WorkspaceActivationStamp,source:AdvancedFrameSource,displayed:AdvancedFrameSource|undefined):boolean {
 return expected.documentId===current.documentId&&expected.documentEpoch===current.documentEpoch&&expected.revision===current.revision
  &&expected.viewId===current.viewId&&expected.activationEpoch===current.activationEpoch
  &&!!displayed&&sameAdvancedFrame(source.ref,displayed.ref)&&source.stamp.coordinatesFingerprint===displayed.stamp.coordinatesFingerprint;
}
