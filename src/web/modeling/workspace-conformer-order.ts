import type {AdvancedResultFrame} from '../../modeling/advanced/contracts';
import type {WorkspaceDocumentEntry} from '../../modeling/workspace-registry';
import {trajectoryFrameOrder} from '../results/trajectory-playback-bridge';

/** Sorting belongs to one reader revision, not the reusable collection label. */
export interface ConformerFrameOrder {
 documentId:string;documentEpoch:string;resultId:string;
 availableFrameIds:readonly string[];frameIds:readonly string[];
}
export function captureConformerFrameOrder(entry:WorkspaceDocumentEntry,collectionId:string,frames:readonly AdvancedResultFrame[]):ConformerFrameOrder|undefined{
 const binding=entry.trajectory,result=entry.legacyResult;
 if(!binding||!result||binding.identity.collectionId!==collectionId||frames.some(frame=>frame.taskId!==binding.identity.taskId))return;
 const ids=frames.map(frame=>frame.id),available=new Set(binding.frameIds);
 // A passive effect from the previous reader may arrive after replacement or
 // append. It cannot define the order of a different complete frame set.
 if(ids.length!==binding.frameIds.length||ids.some(id=>!available.has(id)))return;
 trajectoryFrameOrder(binding.frameIds.length,ids.map(id=>binding.frameIds.indexOf(id)));
 return {documentId:entry.id,documentEpoch:entry.epoch,resultId:result.id,availableFrameIds:[...binding.frameIds],frameIds:ids};
}
export function conformerPlaybackOrder(entry:WorkspaceDocumentEntry,saved?:ConformerFrameOrder):readonly number[]|undefined{
 const binding=entry.trajectory,result=entry.legacyResult;if(!binding||!result)return;
 const current=saved&&saved.documentId===entry.id&&saved.documentEpoch===entry.epoch&&saved.resultId===result.id
  &&saved.availableFrameIds.length===binding.frameIds.length&&saved.availableFrameIds.every((id,index)=>id===binding.frameIds[index]);
 // Keep every current frame during the replacement commit, before the newly
 // mounted results panel publishes its sorting projection.
 return trajectoryFrameOrder(binding.frameIds.length,current?saved.frameIds.map(id=>binding.frameIds.indexOf(id)):undefined);
}
