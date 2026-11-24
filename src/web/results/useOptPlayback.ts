import { useEffect,useLayoutEffect,useRef,useMemo, useSyncExternalStore } from 'react';
import type { TrajectoryResult } from '../../results/contracts';
import { OptPlaybackSession, playbackCapabilities, type OptPlaybackSessionOptions } from '../../results/opt-playback';
import type { TrajectoryControlsProps } from './TrajectoryControls';
import {createPlaybackCollection,playbackCollectionRestriction,type PlaybackCollection} from '../../results/playback-collection';
import {playbackOwners} from '../../results/playback-owner';

export interface PlaybackContinuationIdentity {ownerId:string;collectionId:string;sourceGeneration:number;revision:string;baseRevision:string|null;incremental:boolean;stageId:string}
export function canContinuePlayback(previous:PlaybackContinuationIdentity|undefined,next:PlaybackContinuationIdentity|undefined){return Boolean(previous&&next&&next.incremental&&next.ownerId&&next.collectionId&&next.stageId&&Number.isSafeInteger(next.sourceGeneration)&&next.sourceGeneration>=0&&previous.ownerId===next.ownerId&&previous.collectionId===next.collectionId&&previous.sourceGeneration===next.sourceGeneration&&previous.stageId===next.stageId&&next.revision!==previous.revision&&next.baseRevision===previous.revision);}
export function playbackFramesExtend(previous:TrajectoryResult,next:TrajectoryResult){return next.frames.length>=previous.frames.length&&previous.frames.every((frame,index)=>{const current=next.frames[index];return (frame.sourceFrameIndex??frame.index)===(current.sourceFrameIndex??current.index)&&frame.sourceLine===current.sourceLine;});}
export interface OptPlaybackOptions extends OptPlaybackSessionOptions { active: boolean; ready?: boolean; onError?(message: string): void;continuation?:PlaybackContinuationIdentity;collection?:PlaybackCollection }

/** One frame snapshot drives canvas, metadata, analyses and detached trajectory tabs. */
export function useOptPlayback(result: TrajectoryResult, { active, ready = true, autoPreview = true, previewFrameDelayMs, tsFrameIndex, initialFrameIndex, prepareFrame, prepared, onError,continuation,restored,liveContinuation,collection,deferBatchPreparation,awaitSceneSubmission }: OptPlaybackOptions) {
  const currentCollection=useMemo(()=>collection??createPlaybackCollection(result,{ownerId:crypto.randomUUID()}),[collection,result]);
  const committed=useRef<{owner:OptPlaybackSession;result:TrajectoryResult;identity?:PlaybackContinuationIdentity;active:boolean}|null>(null);
  const session=useMemo(()=>{const previous=committed.current,retained=previous&&previous.result!==result&&previous.result.id===result.id&&previous.result.source.id===result.source.id&&playbackFramesExtend(previous.result,result)&&canContinuePlayback(previous.identity,continuation)?previous.owner.captureViewState():null;
    const lease=playbackOwners.acquire(currentCollection,result,{autoPreview,previewFrameDelayMs,tsFrameIndex,initialFrameIndex,prepareFrame,prepared,restored,liveContinuation,deferBatchPreparation,awaitSceneSubmission,...(retained?{restored:retained,liveContinuation:active&&previous?.active?{playing:retained.playing,silentLoading:retained.silentLoading}:undefined}:{})});
    return{owner:lease.session,lease,result,identity:continuation?{...continuation}:undefined};
  },[result,currentCollection,continuation?undefined:autoPreview,previewFrameDelayMs,tsFrameIndex,initialFrameIndex,prepareFrame,prepared]);
  const owner=session.owner;
  useLayoutEffect(()=>{committed.current={...session,active};},[session,active]);
  owner.onError = onError;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  // React effect replay explicitly reacquires; stale environment callbacks do not.
  useEffect(() => { session.lease.reacquire(); return () => session.lease.release(); }, [session]);
  const restriction=playbackCollectionRestriction(currentCollection);
  useEffect(() => {
    owner.setBatchPreparationDeferred(deferBatchPreparation??false);
    owner.setSceneSubmissionRequired(awaitSceneSubmission??false);
    session.lease.setEnvironment(active&&!restriction, ready);
    if(deferBatchPreparation&&initialFrameIndex!==undefined)owner.followDeferredFrame(initialFrameIndex);
  }, [session,owner,active,ready,restriction,deferBatchPreparation,awaitSceneSubmission,initialFrameIndex]);
  const frameIndices=useMemo(()=>({positions:new Map(currentCollection.frames.map((frame,index)=>[frame.sourceFrameIndex,index])),sources:new Map(currentCollection.frames.map(frame=>[frame.frameId,frame.sourceFrameIndex]))}),[currentCollection]);
  const targets=currentCollection.targets,seekTarget=(kind:'ts'|'ci')=>{const id=targets[kind]?.frameId,source=id===undefined?undefined:frameIndices.sources.get(id);if(source!==undefined)owner.seek(source);};
  const capabilities=playbackCapabilities(state,result.frames.length,active,ready);
  const controls: TrajectoryControlsProps = { count: currentCollection.frames.length, index: frameIndices.positions.get(state.frame.index)??0, requestedIndex:state.seekTargetIndex===undefined?undefined:frameIndices.positions.get(state.seekTargetIndex), playing: state.playing, busy: state.busy,
    preparation: state.preparation, loading: state.loading, loadCancelled: state.loadCancelled, loadFailed:state.loadFailed, silentLoading: state.silentLoading||state.holdingFrameDuringPreparation,
    onSilentLoading: owner.setSilentLoading, onCancelPreparation: owner.cancelPreparation, onPrepare: owner.prepare,
    disabled: !!restriction||!capabilities.navigation, seekDisabled:!!restriction||!capabilities.seek, compact: true, previewing: state.previewing, previewStartedAt: state.previewStartedAt, previewCompletedAt: state.previewCompletedAt,
    frameDelayMs: state.frameDelayMs, previewFrameDelayMs: owner.previewFrameDelayMs, onFrameDelay: owner.setFrameDelay,
    fps: state.fps, direction: state.direction, mode: state.mode, range: state.range, endpointPauseMs: state.endpointPauseMs,
    targets,onSeekTarget:seekTarget,onPlay: owner.play, onPause: owner.pause, onSeek: index=>{const frame=currentCollection.frames[index];if(frame?.sourceFrameIndex!==undefined)owner.seek(frame.sourceFrameIndex);}, onStep: owner.step,
    onFps: owner.setFps, onDirection: owner.setDirection, onMode: owner.setMode, onRange: owner.setRange, onEndpointPause: owner.setEndpointPause };
  return { ...state, controls, seekTs: owner.seekTs, prepare: owner.prepare, refreshPreparedFrame:owner.refreshPreparedFrame, captureViewState:owner.captureViewState, acknowledgeSceneSubmission: owner.acknowledgeSceneSubmission, readNavigation: owner.readNavigation };
}
