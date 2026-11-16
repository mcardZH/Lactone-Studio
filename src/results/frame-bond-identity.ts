import type {FrameBondIdentity} from '../core/modeling/frame-bond-overrides';
import type {TrajectoryResult} from './contracts';
import {attachTrajectoryStages} from './trajectory-stages';

export type ResultFrameBondSource=Omit<FrameBondIdentity,'frameId'>;
/** Consume the original result and actual scientific stage, before display
 * projection. No UI stage label, content revision or coordinate matching. */
export function resultFrameBondSource(result:TrajectoryResult,stageId:string,continuity?:{ownerId:string;collectionId:string;sourceGeneration:number},sourceResultId=result.id):ResultFrameBondSource {
  // View/collection owners are presentation scopes. The original source and
  // its actual generation remain the same when another module views it.
  return {sourceId:JSON.stringify([result.source.id,null,null,continuity?.sourceGeneration??0]),
    resultId:sourceResultId,jobIndex:result.jobIndex,stageId};
}
/** Collection members use the native task/run/stage/member identity, independent
 * of sorting and immutable publication revision. Ordinary sources use the same
 * original-result identity as the postprocessing view. */
export function trajectoryFrameBondIdentity(result:TrajectoryResult,index:number):FrameBondIdentity {
  const native=(result as TrajectoryResult&{identity?:{taskId:string;runId:string;stageId:string;collectionId:string};frameIds?:readonly string[]}),identity=native.identity;
  if(identity&&[identity.taskId,identity.runId,identity.stageId,identity.collectionId].every(value=>typeof value==='string'&&value.length>0)&&native.frameIds?.[index]){
    return{sourceId:JSON.stringify([identity.taskId,identity.runId]),resultId:JSON.stringify([identity.taskId,identity.runId,identity.stageId,identity.collectionId]),jobIndex:result.jobIndex,stageId:identity.stageId,frameId:native.frameIds[index]};
  }
  const stages=attachTrajectoryStages(result).stages,stage=stages?.find(stage=>stage.frameIndices.includes(index));
  return resultFrameBondIdentity(resultFrameBondSource(result,stage?.id??result.frames[index]?.stageId??'trajectory'),result.frames[index]?.sourceFrameIndex??index);
}
export function resultFrameBondIdentity(source:ResultFrameBondSource,sourceFrameIndex:number|string):FrameBondIdentity {
  return {...source,frameId:String(sourceFrameIndex)};
}
/** The working-model handoff uses the first accepted source/stage frame. This
 * index proof remains distinct even when two scientific frames have equal XYZ. */
export function initialResultFrameBondIdentity(result:TrajectoryResult):FrameBondIdentity|undefined {
  const selected=attachTrajectoryStages(result).stages?.[0],index=selected?.frameIndices[0]??0,frame=result.frames[index];
  if(!frame)return;
  return resultFrameBondIdentity(resultFrameBondSource(result,selected?.id??'trajectory'),frame.sourceFrameIndex??index);
}
