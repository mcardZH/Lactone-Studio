import type {ModelDocument} from '../../core/modeling/contracts';
import type {ModelStore} from '../contracts';
import type {GaussianSettings} from '../../core/types';
import type {OrcaJobRequest} from '../../core/orca/types';
import {captureDesktopAssignments,captureGaussianCoordinates} from './gaussian-bridge';
import {captureOrcaAssignments,captureOrcaCoordinates} from './orca-bridge';
import {modelChange} from './model-change';

/** A generated file is a completed snapshot. Scientific model edits return its
 * workflow to parameters; selection, camera and confirmation-only updates do not. */
export function inputNeedsModelReconfirmation(previous:ModelDocument,next:ModelDocument,step:number):boolean {
  if(step!==3)return false;
  const before=previous.draft.structure,after=next.draft.structure;
  const changed=modelChange(before,after);
  return previous.id!==next.id||changed.inventory||changed.geometry||changed.graph
    ||before.charge!==after.charge||before.multiplicity!==after.multiplicity
    ||JSON.stringify(previous.sharedConstraints??null)!==JSON.stringify(next.sharedConstraints??null);
}

/** Replace the private input contexts together with a deliberate task/software
 * reset. Canonical shared freezes and q/M remain owned by the same Store. */
export function resetInputModelContexts(store:ModelStore,next:Partial<{gaussian:GaussianSettings;orca:OrcaJobRequest['settings']}>,active:'gaussian'|'orca'){
  const document=store.getSnapshot(),structure=document.draft.structure.atoms.length?document.draft.structure:null;
  const scopes:('gaussian'|'orca')[]=active==='gaussian'?['orca','gaussian']:['gaussian','orca'];
  for(const scope of scopes){
    if(scope==='gaussian'&&next.gaussian)store.synchronizeContext(captureDesktopAssignments(structure,next.gaussian),captureGaussianCoordinates(structure,next.gaussian),scope);
    if(scope==='orca'&&next.orca)store.synchronizeContext(captureOrcaAssignments(structure,next.orca),captureOrcaCoordinates(structure,next.orca),scope);
  }
}
