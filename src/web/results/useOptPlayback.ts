import { useEffect,useLayoutEffect,useRef,useMemo, useSyncExternalStore } from 'react';
import type { TrajectoryResult } from '../../results/contracts';
import { OptPlaybackSession, type OptPlaybackSessionOptions } from '../../results/opt-playback';
import type { TrajectoryControlsProps } from './TrajectoryControls';
import {createPlaybackCollection,playbackCollectionRestriction,type PlaybackCollection} from '../../results/playback-collection';
import {playbackOwners} from '../../results/playback-owner';

export interface PlaybackContinuationIdentity {ownerId:string;collectionId:string;sourceGeneration:number;revision:string;baseRevision:string|null;incremental:boolean;stageId:string}
export function canContinuePlayback(previous:PlaybackContinuationIdentity|undefined,next:PlaybackContinuationIdentity|undefined){return Boolean(previous&&next&&next.incremental&&next.ownerId&&next.collectionId&&next.stageId&&Number.isSafeInteger(next.sourceGeneration)&&next.sourceGeneration>=0&&previous.ownerId===next.ownerId&&previous.collectionId===next.collectionId&&previous.sourceGeneration===next.sourceGeneration&&previous.stageId===next.stageId&&next.revision!==previous.revision&&next.baseRevision===previous.revision);}
export function playbackFramesExtend(previous:TrajectoryResult,next:TrajectoryResult){return next.frames.length>=previous.frames.length&&previous.frames.every((frame,index)=>{const current=next.frames[index];return (frame.sourceFrameIndex??frame.index)===(current.sourceFrameIndex??current.index)&&frame.sourceLine===current.sourceLine;});}
export interface OptPlaybackOptions extends OptPlaybackSessionOptions { active: boolean; ready?: boolean; onError?(message: string): void;continuation?:PlaybackContinuationIdentity;collection?:PlaybackCollection }

/** One frame snapshot drives canvas, metadata, analyses and detached trajectory tabs. */
export function useOptPlayback(result: TrajectoryResult, { active, ready = true, autoPreview = true, previewFrameDelayMs, tsFrameIndex, prepareFrame, prepared, onError,continuation,restored,liveContinuation,collection }: OptPlaybackOptions) {
  const currentCollection=useMemo(()=>collection??createPlaybackCollection(result,{ownerId:crypto.randomUUID()}),[collection,result]);
  const committed=useRef<{owner:OptPlaybackSession;result:TrajectoryResult;identity?:PlaybackContinuationIdentity;active:boolean}|null>(null);
  const session=useMemo(()=>{const previous=committed.current,retained=active&&previous?.active&&previous.result!==result&&previous.result.id===result.id&&previous.result.source.id===result.source.id&&playbackFramesExtend(previous.result,result)&&canContinuePlayback(previous.identity,continuation)?previous.owner.captureViewState():null;
    const lease=playbackOwners.acquire(currentCollection,result,{autoPreview,previewFrameDelayMs,tsFrameIndex,prepareFrame,prepared,restored,liveContinuation,...(retained?{restored:retained,liveContinuation:{playing:retained.playing,silentLoading:retained.silentLoading}}:{})});
    return{owner:lease.session,lease,result,identity:continuation?{...continuation}:undefined};
  },[result,currentCollection,continuation?undefined:autoPreview,previewFrameDelayMs,tsFrameIndex,prepareFrame,prepared]);
  const owner=session.owner;
  useLayoutEffect(()=>{committed.current={...session,active};},[session,active]);
  owner.onError = onError;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  // React effect replay explicitly reacquires; stale environment callbacks do not.
  useEffect(() => { session.lease.reacquire(); return () => session.lease.release(); }, [session]);
  const restriction=playbackCollectionRestriction(currentCollection);
  useEffect(() => { session.lease.setEnvironment(active&&!restriction, ready); }, [session, active, ready,restriction]);
  const targets=currentCollection.targets,seekTarget=(kind:'ts'|'ci')=>{const id=targets[kind]?.frameId,frame=currentCollection.frames.find(frame=>frame.frameId===id);if(frame?.sourceFrameIndex!==undefined)owner.seek(frame.sourceFrameIndex);};
  const controls: TrajectoryControlsProps = { count: currentCollection.frames.length, index: Math.max(0,currentCollection.frames.findIndex(frame=>frame.sourceFrameIndex===state.frame.index)), playing: state.playing, busy: state.busy,
    preparation: state.preparation, loading: state.loading, loadCancelled: state.loadCancelled, silentLoading: state.silentLoading||state.holdingFrameDuringPreparation,
    onSilentLoading: owner.setSilentLoading, onCancelPreparation: owner.cancelPreparation, onPrepare: owner.prepare,
    disabled: !!restriction||!active || !ready || state.loading || state.loadCancelled || result.frames.length === 0, compact: true, previewing: state.previewing, previewStartedAt: state.previewStartedAt, previewCompletedAt: state.previewCompletedAt,
    frameDelayMs: state.frameDelayMs, previewFrameDelayMs: owner.previewFrameDelayMs, onFrameDelay: owner.setFrameDelay,
    fps: state.fps, direction: state.direction, mode: state.mode, range: state.range, endpointPauseMs: state.endpointPauseMs,
    targets,onSeekTarget:seekTarget,onPlay: owner.play, onPause: owner.pause, onSeek: index=>{const frame=currentCollection.frames[index];if(frame?.sourceFrameIndex!==undefined)owner.seek(frame.sourceFrameIndex);}, onStep: owner.step,
    onFps: owner.setFps, onDirection: owner.setDirection, onMode: owner.setMode, onRange: owner.setRange, onEndpointPause: owner.setEndpointPause };
  return { ...state, controls, seekTs: owner.seekTs, prepare: owner.prepare, captureViewState:owner.captureViewState };
}
