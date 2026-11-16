import type {ModelDocument,ModelStore} from '../contracts';
import type {JsonValue} from '../workspace-contracts';
import {inputNeedsModelReconfirmation} from './input-workflow-lifecycle';
import {captureDesktopAssignments,captureGaussianCoordinates,integrateDesktopBuilderResult,invalidateGaussianObjectBindings} from './gaussian-bridge';
import {captureOrcaAssignments,captureOrcaCoordinates,integrateOrcaBuilderResult,invalidateOrcaRequestForModel} from './orca-bridge';
import {projectCanonicalGaussianFreezes,projectCanonicalOrcaFreezes} from './canonical-freezes';
import {projectSessionModel} from './session-projection';
import {electronicInventorySignature} from '../../core/modeling/electronic-state-policy';
import {readProjectInputDrafts,restoredOrcaProjectRequest,type readProjectInputDraftsForUi,type ProjectInputEngine} from './project-input-draft';

type ValidDrafts=Pick<ReturnType<typeof readProjectInputDraftsForUi>,ProjectInputEngine>;

/** Reuse the normal form projection against the candidate's stable atoms. Only
 * the form's explicit owner is rebound. Scientific source and asset IDs stay intact. */
export function copyProjectInputDrafts(valid:ValidDrafts,source:ModelDocument,target:ModelDocument,targetStore:ModelStore):Partial<Record<ProjectInputEngine,JsonValue>>{
  const {gaussian,orca}=structuredClone({gaussian:valid.gaussian,orca:valid.orca});
  const drafts={gaussian,orca};
  const original=source.draft.structure,structure=target.draft.structure;
  const changed=inputNeedsModelReconfirmation({...source,id:target.id},target,3);
  const electronicChanged=electronicInventorySignature(original)!==electronicInventorySignature(structure)||original.charge!==structure.charge||original.multiplicity!==structure.multiplicity;
  const owner={documentId:target.id};
  const scoped=(engine:ProjectInputEngine)=>{
    const context=targetStore.getContext(engine);
    return {document:context?{...target,draft:{...target.draft,assignments:context.assignments},internalCoordinates:context.coordinates}:target,active:!!context};
  };
  if(gaussian){
    gaussian.owner=owner;
    if(changed){
      const {document,active}=scoped('gaussian');
      const projection=projectSessionModel(document,original,captureDesktopAssignments(original,gaussian.settings),captureGaussianCoordinates(original,gaussian.settings),active);
      let settings=integrateDesktopBuilderResult(original,projection,gaussian.settings).settings;
      if(target.sharedConstraints?.canonical)settings=projectCanonicalGaussianFreezes(structure,settings,target.sharedConstraints);
      gaussian.settings=invalidateGaussianObjectBindings(structure,settings,target.coordinateObjects??[]);
      gaussian.files={...gaussian.files,compatibilityConfirmed:false};
      gaussian.frequencyConfirmed=false;
      const generated=gaussian.step===3||!!gaussian.output||gaussian.editorDirty;
      if(generated){gaussian.step=Math.min(gaussian.step,2);gaussian.resourcesConfirmed=false;}
      if(electronicChanged)gaussian.stateConfirmed=false;
      gaussian.output='';gaussian.generatedName='';gaussian.generatedSignature='';gaussian.editorDirty=false;
      delete gaussian.taskDrafts;
    }
  }
  if(orca){
    orca.owner=owner;
    if(changed){
      const {document,active}=scoped('orca');
      const projection=projectSessionModel(document,original,captureOrcaAssignments(original,orca.settings),captureOrcaCoordinates(original,orca.settings),active);
      const integrated=integrateOrcaBuilderResult(original,projection,orca.settings);
      const rebased=invalidateOrcaRequestForModel(restoredOrcaProjectRequest(orca,original),integrated);
      orca.settings=target.sharedConstraints?.canonical?projectCanonicalOrcaFreezes(structure,rebased.settings,target.sharedConstraints):rebased.settings;
      orca.assets=rebased.assets;
      const generated=orca.step===3||orca.editorDirty||Object.keys(orca.generatedDrafts??{}).length>0;
      if(generated){orca.step=Math.min(orca.step,2);orca.resourcesConfirmed=false;}
      if(electronicChanged)orca.electronicStateConfirmed=false;
      orca.generatedDrafts={};orca.editorDirty=false;
      delete orca.taskDrafts;
    }
  }
  // The strict read also projects q/M onto the new form without altering the
  // target Store. A failed final validation leaves the source intent reusable.
  const checked=readProjectInputDrafts(drafts,target);
  return JSON.parse(JSON.stringify({gaussian:checked.gaussian,orca:checked.orca}));
}
