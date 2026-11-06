import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import type {AdvancedResultFrame} from '../../modeling/advanced/contracts';
import {createMultiframeDisplay,type MultiframeDisplayPlan,type MultiframeDisplayFrame,type MultiframeDisplayFit,type SamplingSphereDisplay} from '../../modeling/view-multiframe';
import {sameAdvancedFrame} from '../../modeling/advanced/frame-source';
import type {ModelDocument} from '../../modeling/contracts';
import {advancedFrameFragment} from '../../modeling/application/advanced-frame-output';
import {createBuilderDraft} from '../../core/builder-draft';
import type {Structure} from '../../core/types';
import type {ConformerResultCollection,ConformerTrajectoryResult} from '../../modeling/conformers/trajectory';
import type {TrajectoryResult} from '../../results/contracts';
import {createPlaybackCollection} from '../../results/playback-collection';

/** Adapt full published membership, retaining unavailable representatives. The
 * initial reference is the actual run/sampling source supplied by its owner. */
export function createAdvancedPlaybackCollection(result:TrajectoryResult,collection:ConformerResultCollection,initialSource:AdvancedFrameSource|undefined,ownerId:string){
 const actualFrameIds=(result as Partial<ConformerTrajectoryResult>).frameIds;
 const indices=new Map((actualFrameIds??collection.frames.map(frame=>frame.id)).map((id,index)=>[id,index]));
 const clusters=collection.clusterCollection;
 const frames=clusters?clusters.clusters.map(row=>({frameId:row.representativeFrameId??`cluster:${row.clusterId}`,
   ...(!row.unavailableReason&&row.representativeFrameId&&indices.has(row.representativeFrameId)?{sourceFrameIndex:indices.get(row.representativeFrameId),sourceResultId:result.id}:{unavailableReason:row.unavailableReason??'簇代表结构不可用。'})}))
   :collection.frames.map((frame,index)=>({frameId:frame.id,sourceFrameIndex:index,sourceResultId:result.id}));
 return createPlaybackCollection(result,{ownerId,collectionId:collection.id,stageId:collection.identity.stageId,revision:JSON.stringify([clusters?.revision,collection.identity,frames]),fixed:true,frames,
   initialReference:initialSource?{identity:JSON.stringify([initialSource.ref,initialSource.stamp,initialSource.constraints]),structure:initialSource.structure,atomCorrespondenceKey:JSON.stringify(initialSource.structure.atoms.map(atom=>[atom.id,atom.element]))}:undefined});
}

export interface AdvancedPlaybackReferenceSelection {
 mode:'raw'|'fixed';
 /** Immutable actual batch/run initial, not the current canvas or latest task default. */
 referenceSource:AdvancedFrameSource;
 /** Display-only selection; changing this never modifies scientific protection. */
 coreAtomIds:readonly string[];
}
export interface AdvancedCanvasLayers{targetId?:string;source:AdvancedFrameSource;multiframeDisplay?:MultiframeDisplayPlan;samplingSphere?:SamplingSphereDisplay;previewStructure?:Structure;playbackReference?:AdvancedPlaybackReferenceSelection}
export interface AdvancedSourceCollectionInfo{id:string;count:number;label:string}
export function sameDisplaySource(a:AdvancedFrameSource|undefined|null,b:AdvancedFrameSource|undefined|null){return Boolean(a&&b&&sameAdvancedFrame(a.ref,b.ref)&&JSON.stringify(a.stamp)===JSON.stringify(b.stamp));}
/** A target document supplies only the display/auth container identity. Its
 * selections, auxiliary objects, tasks and history never become source data. */
export function advancedDisplayDocument(target:Pick<ModelDocument,'id'|'revision'>,source:AdvancedFrameSource):ModelDocument{
 const fragment=advancedFrameFragment(source),draft=createBuilderDraft(fragment.structure,fragment.assignments);draft.revision=target.revision;
 return{id:target.id,revision:target.revision,draft,selection:{atomIds:[],bonds:[],auxiliaryIds:[],portIds:[],coordinateIds:[]},auxiliaryRelations:fragment.auxiliaryRelations,deletedBonds:fragment.deletedBonds,attachmentPorts:fragment.attachmentPorts??[],internalCoordinates:fragment.internalCoordinates??[],sharedConstraints:fragment.sharedConstraints,coordinateObjects:fragment.coordinateObjects??[],canUndo:false,canRedo:false};
}

export type AdvancedDisplayFit='raw'|'proper'|'core';
export function advancedDisplayFrame(source:AdvancedFrameSource,key:string,collectionId:string):MultiframeDisplayFrame{
 const ref=source.ref;
 return{key,structure:source.structure,identity:{sourceId:ref.sourceId??ref.taskId??`${ref.documentId}:${ref.documentEpoch}`,sourceRevision:JSON.stringify([ref.documentEpoch,ref.revision]),collectionId,frameId:ref.frameId??key,documentId:ref.documentId,taskId:ref.taskId,runId:ref.runId,stageId:ref.stageId,sourceFrameIndex:ref.sourceFrameIndex}};
}
/** A collection is already one real process dimension. Selection never samples. */
export function createAdvancedDisplay(input:{frames:readonly {id:string;source:AdvancedFrameSource}[];collectionId:string;activeFrameKey:string;fit:AdvancedDisplayFit;referenceFrameKey:string;coreReference:AdvancedFrameSource;coreIds:readonly string[]}):MultiframeDisplayPlan{
 const frames=input.frames.map(frame=>advancedDisplayFrame(frame.source,frame.id,input.collectionId));
 const fit:MultiframeDisplayFit=input.fit==='raw'?{kind:'raw'}:input.fit==='proper'?{kind:'proper',referenceFrameKey:input.referenceFrameKey}:{kind:'core',reference:advancedDisplayFrame(input.coreReference,'advanced-core-start',input.collectionId),atomIds:[...input.coreIds]};
 return createMultiframeDisplay({frames,activeFrameKey:input.activeFrameKey,fit});
}
export function retainedDisplayFrames(frames:readonly AdvancedResultFrame[],indices:readonly number[]){
 if(!indices.length||new Set(indices).size!==indices.length||indices.some(index=>!Number.isSafeInteger(index)||index<0||index>=frames.length))throw Error('请选择当前过程集合内的有效完整帧范围。');
 return indices.map(index=>frames[index]);
}
