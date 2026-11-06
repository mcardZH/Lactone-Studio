import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {sameAdvancedFrame} from '../../modeling/advanced/frame-source';
import type {WorkspaceActivationStamp} from '../../modeling/workspace-contracts';
import {advancedElectronicSourceConfirmationKey} from '../../modeling/advanced/electronic-confirmation';

export interface AdvancedElectronicState {charge:number;multiplicity:number;confirmed?:boolean;documentId?:string}

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
