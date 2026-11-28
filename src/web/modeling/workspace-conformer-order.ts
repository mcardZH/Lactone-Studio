import type {AdvancedResultFrame} from '../../modeling/advanced/contracts';
import type {WorkspaceDocumentEntry} from '../../modeling/workspace-registry';
import {trajectoryFrameOrder} from '../results/trajectory-playback-bridge';

/** Sorting belongs to one reader revision, not the reusable collection label. */
export interface ConformerFrameOrder {
 documentId:string;documentEpoch:string;resultId:string;
 availableFrameIds:readonly string[];frameIds:readonly string[];
}

const naturalOrders=new WeakMap<readonly string[],readonly number[]>();
const ordinals=new WeakMap<readonly string[],ReadonlyMap<string,number>>();
const capturedOrders=new WeakMap<ConformerFrameOrder,{frameIds:readonly string[];order:readonly number[]}>();

function frameOrdinals(frameIds:readonly string[]):ReadonlyMap<string,number>{
 let index=ordinals.get(frameIds);
 if(!index){
  index=new Map(frameIds.map((id,ordinal)=>[id,ordinal]));
  if(Object.isFrozen(frameIds))ordinals.set(frameIds,index);
 }
 return index;
}

function sameFrameIds(a:readonly string[],b:readonly string[]):boolean{
 return a===b||a.length===b.length&&a.every((id,index)=>id===b[index]);
}

export function sameConformerFrameOrder(a:ConformerFrameOrder|undefined,b:ConformerFrameOrder):boolean{
 return a===b||!!a&&a.documentId===b.documentId&&a.documentEpoch===b.documentEpoch&&a.resultId===b.resultId&&
  sameFrameIds(a.availableFrameIds,b.availableFrameIds)&&sameFrameIds(a.frameIds,b.frameIds);
}

export function restoreConformerFrameOrders(saved:Readonly<Record<string,ConformerFrameOrder>>):Record<string,ConformerFrameOrder>{
 return Object.fromEntries(Object.entries(saved).map(([id,order])=>[id,Object.freeze({...order,
  availableFrameIds:Object.freeze([...order.availableFrameIds]),frameIds:Object.freeze([...order.frameIds])})]));
}

export function captureConformerFrameOrder(entry:WorkspaceDocumentEntry,collectionId:string,frames:readonly AdvancedResultFrame[]):ConformerFrameOrder|undefined{
 const binding=entry.trajectory,result=entry.legacyResult;
 if(!binding||!result||binding.identity.collectionId!==collectionId||frames.length!==binding.frameIds.length||
  frames.some(frame=>frame.taskId!==binding.identity.taskId))return;
 const ids=frames.map(frame=>frame.id),available=frameOrdinals(binding.frameIds);
 // A passive effect from the previous reader may arrive after replacement or
 // append. It cannot define the order of a different complete frame set.
 const indices=ids.map(id=>available.get(id)??-1);
 if(indices.includes(-1))return;
 const order=Object.freeze(trajectoryFrameOrder(binding.frameIds.length,indices));
 const availableFrameIds=Object.isFrozen(binding.frameIds)?binding.frameIds:Object.freeze([...binding.frameIds]);
 const saved=Object.freeze({documentId:entry.id,documentEpoch:entry.epoch,resultId:result.id,availableFrameIds,frameIds:Object.freeze(ids)});
 capturedOrders.set(saved,{frameIds:availableFrameIds,order});
 return saved;
}
export function conformerPlaybackOrder(entry:WorkspaceDocumentEntry,saved?:ConformerFrameOrder):readonly number[]|undefined{
 const binding=entry.trajectory,result=entry.legacyResult;if(!binding||!result)return;
 const frameIds=binding.frameIds;
 if(saved&&saved.documentId===entry.id&&saved.documentEpoch===entry.epoch&&saved.resultId===result.id){
  const captured=capturedOrders.get(saved);
  if(captured?.frameIds===frameIds)return captured.order;
  if(sameFrameIds(saved.availableFrameIds,frameIds)){
   const available=frameOrdinals(frameIds);
   const order=Object.freeze(trajectoryFrameOrder(frameIds.length,saved.frameIds.map(id=>available.get(id)??-1)));
   if(Object.isFrozen(saved)&&Object.isFrozen(frameIds))capturedOrders.set(saved,{frameIds,order});
   return order;
  }
 }
 // Keep every current frame during the replacement commit, before the newly
 // mounted results panel publishes its sorting projection.
 let order=naturalOrders.get(frameIds);
 if(!order){
  order=Object.freeze(trajectoryFrameOrder(frameIds.length));
  if(Object.isFrozen(frameIds))naturalOrders.set(frameIds,order);
 }
 return order;
}
