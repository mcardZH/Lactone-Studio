import type {AdvancedTaskRecord,AdvancedResultFrame} from '../../modeling/advanced/contracts';
import type {ConformerResultCollection,ConformerTrajectoryResult} from '../../modeling/conformers/trajectory';
import type {WorkspaceDocumentEntry} from '../../modeling/workspace-registry';
import type {WorkspaceTrajectoryIdentity,WorkspaceTrajectoryBinding} from '../../modeling/workspace-contracts';
import type {TrajectoryResult} from '../../results/contracts';
import {assertResultNotAborted} from '../../results/contracts';
import {isPreparedTrajectoryReady} from '../../results/prepared-trajectory';
import {prepareTrajectoryView,type TrajectoryGeometryPreparation} from '../results/usePreparedTrajectory';

/** Task/collection owner calls this after production resource settlement, before
 * publishing a browser tab. The returned object is the exact input object:
 * rebuilding it afterwards would lose its source-owned WeakMap preparation.
 * The caller owns cancellation; a mounted view has no handle to this signal. */
export async function prepareConformerPublication<T extends TrajectoryResult>(result:T,options:{signal?:AbortSignal;mode?:TrajectoryGeometryPreparation}={}):Promise<T>{
 assertResultNotAborted(options.signal);
 if(isPreparedTrajectoryReady(result))return result;
 const view=prepareTrajectoryView(result,options.mode);
 try{await view.prepare(options.signal);assertResultNotAborted(options.signal);if(!isPreparedTrajectoryReady(result))throw new Error('构象结果尚未完整准备，不能发布。');return result;}
 finally{view.release();}
}
export const isConformerPublicationReady=isPreparedTrajectoryReady;

/** A project first restores its lazy result attachment; its task graph can mount
 * later. Reuse that exact reader when the complete collection revision agrees,
 * so a late task publication joins the player's already running preparation.
 * An id alone cannot conceal a mismatched binding/reference/index. */
export function restoredConformerPublicationResult(candidate:ConformerTrajectoryResult,entry:Pick<WorkspaceDocumentEntry,'trajectory'|'legacyResult'>|undefined):TrajectoryResult{
 const result=entry?.legacyResult;if(!result||result.id!==candidate.id)return candidate;
 const binding=entry?.trajectory,conformer=result as Partial<ConformerTrajectoryResult>;
 const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
 if(!binding||!same(binding.identity,candidate.identity)||!same(binding.frameIds,candidate.frameIds)
  ||conformer.identity&&!same(conformer.identity,candidate.identity)||conformer.frameIds&&!same(conformer.frameIds,candidate.frameIds)
  ||!same(conformer.protectedAtomIds??[],candidate.protectedAtomIds)||result.kind!==candidate.kind||result.engine!==candidate.engine
  ||!same(result.initialStructure,candidate.initialStructure)||!same(result.frames,candidate.frames))throw Error('已恢复的构象结果与当前集合修订不一致，未重复准备或替换来源。');
 return result;
}

type FrameIndex={revision:string;frames:ReadonlyMap<string,AdvancedResultFrame>};
const taskFrames=new Map<string,WeakRef<FrameIndex>>();
const snapshotFrames=new WeakMap<AdvancedTaskRecord,FrameIndex>();
const trajectoryMembers=new WeakMap<readonly string[],ReadonlySet<string>>();
/** Progress DTOs do not invalidate a scientific frame index. New stage writers
 * supply resultRevision; old snapshots use their actual retained frame facts. */
export function conformerPlaybackResultRevision(task:AdvancedTaskRecord):string{
 const frameFacts=(frames:readonly AdvancedResultFrame[])=>frames.map(frame=>[frame.id,frame.source.stamp.coordinatesFingerprint,frame.energyHartree]);
 const candidates=task.conformerWorkflow?.candidateSet;
 return JSON.stringify([task.id,candidates?[candidates.producerRunId,candidates.revision,task.guessFrames.length]:frameFacts(task.guessFrames),task.runs.map(run=>[run.id,
  run.stages?.some(stage=>stage.resultRevision!==undefined)?run.stages.map(stage=>[stage.id,stage.resultRevision]):
   run.mixedSampling||run.intent==='sampling'||run.sampling?[run.frames.length,run.frames[0]?.id,run.frames.at(-1)?.id]:frameFacts(run.frames)])]);
}
/** Stable result revisions are indexed once. Hot playback observes its
 * existing scientific frame; it never rereads a trajectory or clones geometry. */
export function conformerPlaybackFrameIndex(task:AdvancedTaskRecord):ReadonlyMap<string,AdvancedResultFrame>{
 const previous=snapshotFrames.get(task);if(previous)return previous.frames;
 const revision=conformerPlaybackResultRevision(task),cached=taskFrames.get(task.id)?.deref();
 if(cached?.revision===revision){snapshotFrames.set(task,cached);return cached.frames;}
 const frames=new Map([...task.guessFrames,...task.runs.flatMap(run=>run.frames)].map(frame=>[frame.id,frame]));
 const index={revision,frames};snapshotFrames.set(task,index);taskFrames.delete(task.id);taskFrames.set(task.id,new WeakRef(index));
 // Only live task snapshots retain scientific data. This bounded lookup retains
 // weak metadata across progress DTOs, never a closed project's coordinates.
 if(taskFrames.size>32)taskFrames.delete(taskFrames.keys().next().value!);
 return frames;
}
export function conformerTrajectoryObservedSource(binding:WorkspaceTrajectoryBinding,task:AdvancedTaskRecord|undefined){
 if(!task||task.id!==binding.identity.taskId)return undefined;
 let members=trajectoryMembers.get(binding.frameIds);if(!members){members=new Set(binding.frameIds);trajectoryMembers.set(binding.frameIds,members);}
 if(!members.has(binding.currentFrameId))return undefined;
 const frame=conformerPlaybackFrameIndex(task).get(binding.currentFrameId);
 return frame?.taskId===binding.identity.taskId?frame.source:undefined;
}

type Owner=Pick<WorkspaceDocumentEntry,'id'|'epoch'>;
type Options={activate?:boolean};
/** Lazy decoding changes representation, not the saved scientific task state.
 * Only this advanced projection is equivalent; all other revision fields keep
 * their own identity. An observed later task transition retires the pair. */
export function createAdvancedHydrationProjectionBaseline(){
 let equivalent:{actual:string;token:string}|undefined;
 const observe=(actual:string)=>{if(equivalent&&equivalent.actual!==actual)equivalent=undefined;};
 return{record(actual:string,token:string){equivalent=actual===token?undefined:{actual,token};},observe,project(actual:string){observe(actual);return equivalent?.token??actual;},reset(){equivalent=undefined;}};
}
interface PublicationPorts {
 owner(collection:ConformerResultCollection):Owner|undefined;
 closing(id:string):boolean;
 current(collection:ConformerResultCollection):boolean;
 /** Controller workflow revision, independent from a reader's document epoch. */
 revision?(identity:WorkspaceTrajectoryIdentity):string;
 open(collection:ConformerResultCollection,frameId?:string,options?:Options):void;
}
export function conformerCollectionSourcesCurrent(collection:ConformerResultCollection,tasks:readonly Pick<AdvancedTaskRecord,'id'|'guessFrames'|'runs'>[]):boolean{
 const task=tasks.find(task=>task.id===collection.identity.taskId);if(!task||!collection.frames.length)return false;
 const retained=new Map([...task.guessFrames,...task.runs.flatMap(run=>run.frames)].map(frame=>[frame.id,frame]));
 return collection.frames.every(frame=>{const current=retained.get(frame.id);return current?.taskId===frame.taskId&&JSON.stringify(current.source.ref)===JSON.stringify(frame.source.ref)&&current.source.stamp.coordinatesFingerprint===frame.source.stamp.coordinatesFingerprint;});
}
/** Whole current projection, including empty collections and frame order. */
export function conformerCollectionMatchesCurrent(collection:ConformerResultCollection,current:readonly ConformerResultCollection[]):boolean{
 const identityKey=(identity:WorkspaceTrajectoryIdentity)=>JSON.stringify([identity.taskId,identity.runId,identity.stageId,identity.collectionId]);
 const expected=current.find(value=>identityKey(value.identity)===identityKey(collection.identity));
 return Boolean(expected&&expected.playbackAvailable===collection.playbackAvailable&&expected.clusterCollection?.revision===collection.clusterCollection?.revision&&expected.clusterCollection?.settlement===collection.clusterCollection?.settlement&&expected.includeEnergies===collection.includeEnergies&&expected.frames.length===collection.frames.length&&expected.frames.every((frame,index)=>{const other=collection.frames[index];return frame.id===other.id&&frame.kind===other.kind&&frame.energyHartree===other.energyHartree&&JSON.stringify(frame.source.ref)===JSON.stringify(other.source.ref)&&frame.source.stamp.coordinatesFingerprint===other.source.stamp.coordinatesFingerprint;}));
}
/** Desktop reader retirement awaits native ownership. A replacement publication
 * must wait for that exact old document epoch rather than update a dying reader. */
export function createConformerCollectionPublisher(){
 const pending=new Map<string,{owner:Owner;collection:ConformerResultCollection;frameId?:string;options?:Options;revision?:string}>();
 const discarded=new Map<string,string|undefined>();
 const keyOf=(identity:WorkspaceTrajectoryIdentity)=>JSON.stringify([identity.taskId,identity.collectionId]);
 function publish(collection:ConformerResultCollection,frameId:string|undefined,options:Options|undefined,ports:PublicationPorts){
  if(collection.playbackAvailable===false)return;
  const key=keyOf(collection.identity),revision=ports.revision?.(collection.identity);
  // This also rejects an old still-retained subset after branch deletion. The
  // Shell compares the entire current controller collection, not membership.
  if(collection.frames.length&&!ports.current(collection))return;
  if(discarded.has(key)){
   if(options?.activate===false&&discarded.get(key)===revision)return;
   discarded.delete(key);
  }
  const owner=ports.owner(collection);
  if(!collection.frames.length&&owner&&!ports.closing(owner.id)&&ports.revision&&!ports.current(collection))return;
  if(owner&&ports.closing(owner.id)){
   // An empty retirement notification cannot erase already arrived new frames.
   if(collection.frames.length)pending.set(key,{owner:{...owner},collection:{...collection,identity:{...collection.identity},frames:[...collection.frames]},frameId,options,revision});
   return;
  }
  pending.delete(key);
  ports.open(collection,frameId,options);
 }
 function released(owner:Owner,ports:PublicationPorts){
  for(const [key,value] of pending){
   if(value.owner.id!==owner.id||value.owner.epoch!==owner.epoch)continue;
   pending.delete(key);
   if(value.revision===ports.revision?.(value.collection.identity)&&ports.current(value.collection))publish(value.collection,value.frameId,value.options,ports);
  }
 }
 function aborted(owner:Owner){for(const [key,value] of pending)if(value.owner.id===owner.id&&value.owner.epoch===owner.epoch)pending.delete(key);}
 /** Intentional discard never runs released(): its queued reader is abandoned.
  * Passive effects at this revision stay retired; an explicit current open or
  * genuinely newer controller collection may create a new reader. */
 function discard(identity:WorkspaceTrajectoryIdentity,ports:PublicationPorts){const key=keyOf(identity);pending.delete(key);discarded.set(key,ports.revision?.(identity));}
 return {publish,released,aborted,discard,reset(){pending.clear();discarded.clear();}};
}
