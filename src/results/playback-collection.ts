import type {Structure} from '../core/types';
import type {TrajectoryResult} from './contracts';
import {attachTrajectoryStages,confirmedStageCiFrame,confirmedStageTsFrame} from './trajectory-stages';
import {sha256Utf8} from '../core/file-identity';

export interface PlaybackCollectionIdentity {ownerId:string;collectionId:string;sourceId:string;sourceGeneration:number;revision:string;stageId:string}
export interface PlaybackFrameIdentity {frameId:string;sourceFrameIndex?:number;sourceResultId?:string;unavailableReason?:string}
export interface PlaybackSeekTarget {frameId?:string;reason?:string;provenance:{sourceId:string;stageId:string;iteration?:number;image?:number;imageBase?:0|1;sourceLine?:number}}
export interface PlaybackInitialReference {identity:string;structure:Structure;atomCorrespondenceKey:string}
/** Complete published membership, including unavailable entries. This is a view
 * adapter, never permission to erase a missing scientific representative. */
export interface PlaybackCollection {
 identity:PlaybackCollectionIdentity;frames:readonly PlaybackFrameIdentity[];atomCorrespondenceKey:string;
 fixed:boolean;initialReference?:PlaybackInitialReference;targets:{ts?:PlaybackSeekTarget;ci?:PlaybackSeekTarget};
}
export type PlaybackReference={kind:'first'}|{kind:'initial';sourceIdentity:string}|{kind:'frame';frameId:string}
 |{kind:'center';frameId:string;cacheKey:string;meanRmsd:number};
export interface PlaybackOverlayState {schema:1;enabled:boolean;fitAtoms:'heavy'|'all';reference:PlaybackReference}
export interface PlaybackCollectionOptions {ownerId:string;collectionId?:string;stageId?:string;generation?:number;revision?:string;fixed?:boolean;frames?:readonly PlaybackFrameIdentity[];initialReference?:PlaybackInitialReference}
function playbackStage(result:TrajectoryResult,stageId?:string){
 const stages=attachTrajectoryStages(result).stages;
 return stages?.find(stage=>stage.id===stageId)??(stages?.length===1?stages[0]:undefined);
}
export function createPlaybackCollection(result:TrajectoryResult,options:PlaybackCollectionOptions):PlaybackCollection {
 const stage=playbackStage(result,options.stageId),stageId=options.stageId??stage?.id??'trajectory';
 const frames:readonly PlaybackFrameIdentity[]=options.frames??result.frames.map((frame,index)=>({frameId:JSON.stringify([result.source.id,result.jobIndex,stageId,frame.sourceFrameIndex??frame.index]),sourceFrameIndex:index,sourceResultId:result.id}));
 if(new Set(frames.map(frame=>frame.frameId)).size!==frames.length||frames.some(frame=>!frame.frameId||frame.sourceFrameIndex!==undefined&&(!Number.isSafeInteger(frame.sourceFrameIndex)||frame.sourceFrameIndex<0||frame.sourceFrameIndex>=result.frames.length)))throw Error('播放集合需要不同的稳定帧身份及真实来源对应。');
 const sourceIndices=frames.flatMap(frame=>frame.sourceFrameIndex===undefined?[]:[frame.sourceFrameIndex]);if(new Set(sourceIndices).size!==sourceIndices.length)throw Error('播放集合不能将同一来源帧重复登记为独立成员。');
 // A revision is an opaque equality token, not a transport of the complete
 // membership. Keep all facts in the digest once; repeating their JSON in
 // every display frame otherwise grows metadata quadratically.
 const revision='playback-collection-v1:'+sha256Utf8(JSON.stringify([
  options.revision??null,result.id,result.kind,result.engine,result.jobIndex,result.role??null,
  [result.source.id,result.source.name,result.source.size,result.source.sha256??null,result.source.software??null,result.source.nativeJobName??null],
  options.collectionId??result.id,stageId,options.generation??0,
  frames.map(frame=>[frame.frameId,frame.sourceFrameIndex??null,frame.sourceResultId??null,frame.unavailableReason??null]),
 ]));
 const sourceId=result.source.id,identity={ownerId:options.ownerId,collectionId:options.collectionId??result.id,sourceId,sourceGeneration:options.generation??0,revision,stageId};
 const atomCorrespondenceKey=JSON.stringify(result.initialStructure.atoms.map(atom=>[atom.id,atom.element]));
 const target=(index:number|undefined,kind:'ts'|'ci'):PlaybackSeekTarget=>{
  const sourceFrame=index===undefined?undefined:result.frames[index],proof=sourceFrame?.climbingImage;
  const member=index===undefined?undefined:frames.find(frame=>frame.sourceFrameIndex===index&&!frame.unavailableReason);
  return{
   ...(member?{frameId:member.frameId}:{reason:kind==='ts'?'当前IRC阶段没有可靠的TS来源标记。':'当前band/轮次没有可靠的CI来源对应。'}),
   provenance:{sourceId,stageId,iteration:stage?.sourceIteration,sourceLine:sourceFrame?.sourceLine,
    ...(proof?{sourceId:proof.source.id,sourceLine:proof.source.line,image:proof.image,imageBase:proof.imageBase,iteration:proof.iteration}:{})},
  };
 };
 const targets:PlaybackCollection['targets']={};
 if(stage?.kind==='irc'||result.scientific?.tasks.includes('irc'))targets.ts=target(confirmedStageTsFrame(result,stage),'ts');
 if(stage?.kind==='neb-path'||result.scientific?.tasks.includes('neb'))targets.ci=target(confirmedStageCiFrame(result,stage),'ci');
 return{identity,frames,atomCorrespondenceKey,fixed:options.fixed??true,initialReference:options.initialReference,targets};
}
/** A display cursor in the current stage. The reference geometry and frame order stay independent. */
export function initialPlaybackFrame(result:TrajectoryResult,collection:PlaybackCollection):number|undefined {
 if(result.frames.length<2)return undefined;
 const stage=playbackStage(result,collection.identity.stageId);
 if(!stage)return undefined;
 const seek=(kind:'ts'|'ci')=>{
  const id=collection.targets[kind]?.frameId;
  return collection.frames.find(frame=>frame.frameId===id&&!frame.unavailableReason)?.sourceFrameIndex;
 };
 if(stage.kind==='irc')return seek('ts');
 const tasks=result.scientific?.tasks??[];
 const ordinary=stage.id==='trajectory'&&stage.kind==='trajectory'
  && !tasks.some(task=>task==='md'||task==='freq'||task==='scan'||task==='irc'||task==='neb')
  && (result.kind==='optimization'||result.role==='optimization-trajectory'||result.role==='ts-optimization-trajectory'
   ||result.kind==='trajectory'&&result.engine==='xyz'&&(!result.role||result.role==='unknown'));
 const optimization=stage.kind==='ts-optimization'||stage.kind==='optimization'&&stage.id!=='neb-other';
 if(stage.kind!=='neb-path'&&!optimization&&!ordinary)return undefined;
 const index=(stage.kind==='neb-path'?seek('ci'):undefined)??stage.frameIndices.at(-1);
 return index!==undefined&&collection.frames.some(frame=>frame.sourceFrameIndex===index&&!frame.unavailableReason)?index:undefined;
}
export function playbackCollectionKey(collection:PlaybackCollection){const i=collection.identity;return JSON.stringify([i.ownerId,i.collectionId,i.sourceId,i.sourceGeneration,i.stageId]);}
/** Stable presentation lifetime across progress DTOs. A new outer object is
 * not a new scientific collection; its explicit version/reference facts are. */
export function playbackCollectionVersion(collection:PlaybackCollection){
 const reference=collection.initialReference;
 return JSON.stringify([playbackCollectionKey(collection),collection.identity.revision,collection.atomCorrespondenceKey,collection.fixed,
  reference?[reference.identity,reference.atomCorrespondenceKey]:null,collection.targets.ts??null,collection.targets.ci??null]);
}
export function playbackCollectionComplete(collection:PlaybackCollection){return collection.frames.length>0&&collection.frames.every(frame=>frame.sourceFrameIndex!==undefined&&!frame.unavailableReason);}
export function playbackCollectionRestriction(collection:PlaybackCollection){return collection.frames.find(frame=>frame.unavailableReason)?.unavailableReason??(!playbackCollectionComplete(collection)?'当前集合存在缺失结构，完整成员已保留。':undefined);}
/** UI-only migration. Old partial overlays must never turn on as full overlays. */
export function restorePlaybackOverlay(value:unknown,collection:PlaybackCollection):PlaybackOverlayState {
 const saved=value as Partial<PlaybackOverlayState>|undefined,reference=saved?.reference;
 const valid=reference?.kind==='first'||reference?.kind==='initial'&&collection.initialReference?.identity===reference.sourceIdentity||(reference?.kind==='frame'||reference?.kind==='center')&&collection.frames.some(frame=>frame.frameId===reference.frameId);
 return{schema:1,enabled:saved?.schema===1&&saved.enabled===true&&!!valid,fitAtoms:saved?.fitAtoms==='all'?'all':'heavy',reference:valid?reference!:{kind:'first'}};
}
