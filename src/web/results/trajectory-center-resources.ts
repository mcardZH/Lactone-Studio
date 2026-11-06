import type {DocumentStamp} from '../../core/modeling/contracts';
import {coordinatesFingerprint,graphFingerprint} from '../../core/modeling/graph';
import type {PreparedTrajectoryView} from '../../results/prepared-trajectory';
import type {PlaybackCollection} from '../../results/playback-collection';
import type {CenterResourcePort} from '../../results/trajectory-center';

export interface TrajectoryCenterResourceBridge {
 acquireWorkerResources(request:{id:string;stamp:DocumentStamp}):Promise<{threads:number}>;
 cancelWorkerResources(id:string):Promise<void>;
 releaseWorkerResources(id:string):Promise<void>;
}
export function trajectoryCenterCollectionIdentity(collection:PlaybackCollection){return JSON.stringify([collection.identity,collection.atomCorrespondenceKey]);}
/** A resource port does not acquire anything until explicit center selection.
 * The stamp describes a real prepared raw source frame, never the view cursor.
 * Its constraints slot binds the immutable collection, not model constraints. */
export function createTrajectoryCenterResourcePort(input:{collection:PlaybackCollection;prepared:PreparedTrajectoryView;documentId:string;isCurrent():boolean;bridge?:TrajectoryCenterResourceBridge|null}):CenterResourcePort|undefined{
 const desktop=input.bridge===undefined?(typeof window==='undefined'?undefined:window.sciyueDesktop):input.bridge;
 if(!desktop?.acquireWorkerResources||!desktop.cancelWorkerResources||!desktop.releaseWorkerResources)return undefined;
 const bridge=desktop as TrajectoryCenterResourceBridge,identity=trajectoryCenterCollectionIdentity(input.collection);
 const guard=()=>{if(!input.isCurrent())throw new DOMException('中心帧所属集合已变化。','AbortError');};
 return{
  async acquire(id){
   guard();const index=input.collection.frames[0]?.sourceFrameIndex;
   const frame=index===undefined?undefined:input.prepared.get(index);
   if(!frame?.raw)throw Error('中心帧资源申请需要已验证的原始来源帧。');
   const stamp:DocumentStamp={documentId:input.documentId,revision:input.collection.identity.sourceGeneration,graphFingerprint:graphFingerprint(frame.raw),coordinatesFingerprint:coordinatesFingerprint(frame.raw),constraintsFingerprint:identity};
   const grant=await bridge.acquireWorkerResources({id,stamp});
   try{guard();if(!Number.isSafeInteger(grant.threads)||grant.threads<1)throw Error('后台资源回执未提供有效线程额度。');return{threads:grant.threads};}
   catch(error){await bridge.releaseWorkerResources(id);throw error;}
  },
  cancel:id=>bridge.cancelWorkerResources(id),release:id=>bridge.releaseWorkerResources(id),
 };
}
