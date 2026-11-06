import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {activateMultiframeDisplay,acquirePinnedMultiframeDisplay,type MultiframeDisplayPlan,type MultiframeDisplayFit} from '../../modeling/view-multiframe';
import type {TrajectoryResult} from '../../results/contracts';
import type {PreparedTrajectoryView} from '../../results/prepared-trajectory';
import {createPlaybackCollection,playbackCollectionComplete,playbackCollectionKey,playbackCollectionRestriction,restorePlaybackOverlay,type PlaybackCollection,type PlaybackOverlayState} from '../../results/playback-collection';
import {centerAtomIds,centerCacheKey,TrajectoryCenterOwner,type CenterProgress,type CenterResourcePort,type CenterInput} from '../../results/trajectory-center';
import {useProjectState} from '../../projects/ui-state';
import {createTrajectoryCenterResourcePort,trajectoryCenterCollectionIdentity} from './trajectory-center-resources';

interface Options {result:TrajectoryResult;prepared:PreparedTrajectoryView;documentId:string;sourceRevision:string;stageId:string;currentIndex:number;active:boolean;collection?:PlaybackCollection;centerResources?:CenterResourcePort}
interface Snapshot {key:string;busy:boolean;plan?:MultiframeDisplayPlan;error?:string}
/** One display transform owner. Full membership is independent of the player's
 * range, cursor and table selection; no physical coordinate is written. */
export function usePostprocessMultiframe(p:Options){
 const fallback=useMemo(()=>createPlaybackCollection(p.result,{ownerId:p.documentId,stageId:p.stageId,revision:p.sourceRevision}),[p.result,p.documentId,p.stageId,p.sourceRevision]);
 const collection=p.collection??fallback,key=playbackCollectionKey(collection);
 const [saved,writeSaved]=useProjectState<{collectionKey:string;state:PlaybackOverlayState}>('playback.overlay.v1',()=>({collectionKey:key,state:{schema:1,enabled:false,fitAtoms:'heavy',reference:{kind:'first'}}}),key);
 const setSaved=useCallback((state:PlaybackOverlayState)=>writeSaved({collectionKey:key,state}),[key,writeSaved]);
 let selected=restorePlaybackOverlay(saved?.collectionKey===key?saved.state:undefined,collection);
 const staleCenter=selected.reference.kind==='center'&&selected.reference.cacheKey!==centerCacheKey({collection,structures:[],fitAtoms:selected.fitAtoms});
 if(staleCenter&&selected.reference.kind==='center')selected={...selected,reference:{kind:'frame',frameId:selected.reference.frameId}};
 const selectionKey=JSON.stringify([collection.identity,selected]);
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[center,setCenter]=useState<{key:string;busy:boolean;progress?:CenterProgress;error?:string}|null>(null);
 const centerRequest=useRef(0);
 const centerOwner=useMemo(()=>new TrajectoryCenterOwner(),[key]);
 const latest=useRef({collection,selected,selectionKey,currentIndex:p.currentIndex});latest.current={collection,selected,selectionKey,currentIndex:p.currentIndex};
 const resourceIdentity=trajectoryCenterCollectionIdentity(collection);
 const defaultResources=useMemo(()=>createTrajectoryCenterResourcePort({collection,prepared:p.prepared,documentId:p.documentId,isCurrent:()=>latest.current.collection.fixed&&trajectoryCenterCollectionIdentity(latest.current.collection)===resourceIdentity}),[resourceIdentity,p.prepared,p.documentId]);
 const resources=p.centerResources??defaultResources;
 const initial=collection.initialReference,reference=selected.reference;
 const referenceFrameId=reference.kind==='first'?collection.frames[0]?.frameId:reference.kind==='initial'?undefined:reference.frameId;
 const referenceFrame=collection.frames.find(frame=>frame.frameId===referenceFrameId),referenceIndex=referenceFrame?.sourceFrameIndex??0;
 const restriction=playbackCollectionRestriction(collection);
 const complete=playbackCollectionComplete(collection)&&p.prepared.snapshot().completed===p.prepared.indices.length;
 const centerReason=restriction??(!collection.fixed?'增长中的集合不能寻找自动中心帧。':!complete?'全部帧载入并校验完成后可寻找自动中心帧。':!resources&&collection.frames.length>1?'当前宿主尚未提供后台分析资源。':undefined);
 useEffect(()=>()=>{void centerOwner.cancel();},[centerOwner]);
 useEffect(()=>{centerRequest.current++;void centerOwner.cancel();setCenter(null);},[centerOwner,collection.identity.revision,collection.atomCorrespondenceKey,collection.fixed]);
 useLayoutEffect(()=>{
  if(!selected.enabled||restriction)return;
  const abort=new AbortController();let release:(()=>void)|undefined;
  setSnapshot({key:selectionKey,busy:true});
  void(async()=>{
   const local=collection.frames.map(frame=>frame.sourceFrameIndex!),indices=local.map(index=>p.prepared.indices[index]),bySource=new Map(indices.map((index,i)=>[index,collection.frames[i]]));
   const ref=reference.kind==='initial'?initial?.structure: p.prepared.get(referenceIndex)?.structure??(await p.prepared.ensure(referenceIndex,abort.signal)).structure;
   if(!ref)throw Error('本次初始来源不可用。');
   const atomIds=centerAtomIds(ref,selected.fitAtoms);
   const fit:MultiframeDisplayFit=reference.kind==='initial'?{kind:'core',reference:{key:initial!.identity,structure:ref,identity:{sourceId:collection.identity.sourceId,sourceRevision:collection.identity.revision,collectionId:collection.identity.collectionId,frameId:initial!.identity}},atomIds}:{kind:'proper',referenceFrameKey:referenceFrameId!,atomIds};
   const value=await acquirePinnedMultiframeDisplay({owner:p.prepared.owner,indices,signal:abort.signal,generation:collection.identity.sourceGeneration,transformRevision:selectionKey,
    activeFrameKey:collection.frames.find(frame=>frame.sourceFrameIndex===p.currentIndex)?.frameId??collection.frames[0].frameId,fit,
    frame:(sourceIndex,structure)=>{const frame=bySource.get(sourceIndex)!;return{key:frame.frameId,structure,identity:{sourceId:collection.identity.sourceId,sourceRevision:collection.identity.revision,collectionId:collection.identity.collectionId,stageId:collection.identity.stageId,documentId:p.documentId,frameId:frame.frameId,sourceFrameIndex:sourceIndex}};}});
   if(abort.signal.aborted){value.dispose();return;}release=value.dispose;setSnapshot({key:selectionKey,busy:false,plan:value.plan});
  })().catch(error=>{if(!abort.signal.aborted)setSnapshot({key:selectionKey,busy:false,error:error instanceof Error?error.message:String(error)});});
  return()=>{abort.abort();release?.();};
 },[p.prepared,selectionKey,restriction]);
 const live=snapshot?.key===selectionKey?snapshot:null,currentKey=collection.frames.find(frame=>frame.sourceFrameIndex===p.currentIndex)?.frameId;
 const plan=useMemo(()=>p.active&&selected.enabled&&live?.plan&&currentKey?activateMultiframeDisplay(live.plan,currentKey):undefined,[p.active,selected.enabled,live?.plan,currentKey]);
 const update=useCallback((patch:Partial<PlaybackOverlayState>)=>{void centerOwner.cancel();setSaved({...latest.current.selected,...patch});},[centerOwner,setSaved]);
 const requestCenter=useCallback(async(fitAtoms=latest.current.selected.fitAtoms)=>{
  const own=latest.current,version=JSON.stringify([own.collection.identity,fitAtoms]),requestId=++centerRequest.current;
  try{
   await centerOwner.cancel();
   if(!own.collection.fixed||!playbackCollectionComplete(own.collection)||p.prepared.snapshot().completed!==p.prepared.indices.length)throw Error('自动中心帧需要固定且全部准备完成的集合。');
   if(!resources&&own.collection.frames.length>1)throw Error('当前宿主尚未提供后台分析资源。');
   const structures=own.collection.frames.map(frame=>p.prepared.get(frame.sourceFrameIndex!)?.structure);if(structures.some(value=>!value))throw Error('自动中心帧需要完整有效结构。');
   const input={collection:own.collection,structures,fitAtoms} as CenterInput;setCenter({key:version,busy:true});
   const result=await centerOwner.start(input,resources??{acquire:async()=>({threads:1}),cancel:async()=>{},release:async()=>{}},progress=>{if(centerRequest.current===requestId)setCenter(previous=>previous?.key===version?{...previous,progress}:previous);});
   if(centerRequest.current!==requestId||!latest.current.collection.fixed||JSON.stringify([latest.current.collection.identity,fitAtoms])!==version)return;
   setSaved({...latest.current.selected,fitAtoms,reference:{kind:'center',frameId:result.frameId,cacheKey:result.cacheKey,meanRmsd:result.meanRmsd}});setCenter({key:version,busy:false});
  }catch(error){if(centerRequest.current!==requestId)return;if((error as Error)?.name!=='AbortError')setCenter({key:version,busy:false,error:error instanceof Error?error.message:String(error)});else setCenter({key:version,busy:false});}
 },[centerOwner,p.prepared,resources,setSaved]);
 const onFitAtoms=useCallback((fitAtoms:'heavy'|'all')=>{if(latest.current.selected.reference.kind==='center')void requestCenter(fitAtoms);else update({fitAtoms});},[requestCenter,update]);
 const onToggle=useCallback(()=>update({enabled:!latest.current.selected.enabled}),[update]);
 const onReference=useCallback((kind:string)=>{const own=latest.current,c=own.collection,initial=c.initialReference,current=c.frames.find(frame=>frame.sourceFrameIndex===own.currentIndex);if(kind==='center'){void requestCenter();return;}if(kind==='first')update({reference:{kind:'first'}});else if(kind==='initial'&&initial)update({reference:{kind:'initial',sourceIdentity:initial.identity}});else if(kind==='specified'&&current)update({reference:{kind:'frame',frameId:current.frameId}});},[requestCenter,update]);
 const onReferenceIndex=useCallback((index:number)=>{const frame=latest.current.collection.frames[index];if(frame&&!frame.unavailableReason)update({reference:{kind:'frame',frameId:frame.frameId}});},[update]);
 const onCurrentReference=useCallback(()=>{const own=latest.current,frame=own.collection.frames.find(frame=>frame.sourceFrameIndex===own.currentIndex);if(frame)update({reference:{kind:'frame',frameId:frame.frameId}});},[update]);
 const onCancelCenter=useCallback(()=>{void centerOwner.cancel();},[centerOwner]);
 const referenceKind=reference.kind==='frame'?'specified':reference.kind;
 return{enabled:selected.enabled,busy:!!live?.busy,plan,displayedFrameCount:live?.plan?.frameCount,atomInstances:live?.plan?.atomInstances,
  total:collection.frames.length,fitAtoms:selected.fitAtoms,referenceKind,referenceIndex,initialAvailable:!!initial,centerAvailable:!centerReason,centerReason,
  centerBusy:!!center?.busy,centerProgress:center?.progress,centerError:center?.error??(staleCenter?'中心缓存已失效，原参考保留；请重新选择自动中心帧。':undefined),meanRmsd:reference.kind==='center'?reference.meanRmsd:undefined,
  error:restriction??live?.error,onToggle,onFitAtoms,onReference,onReferenceIndex,onCurrentReference,onCancelCenter,
 };
}
