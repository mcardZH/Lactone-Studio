import {useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {Structure} from '../../core/types';
import type {TrajectoryResult} from '../../results/contracts';
import type {PlaybackCollectionIdentity,PlaybackFrameIdentity} from '../../results/playback-collection';
import {sameViewportRenderIdentity,type ViewportRenderIdentity} from '../modeling/render/render-completion';
import type {SubmittedScientificFrame} from './analysis-canvas';

interface ScientificFrameProposal {
  active: boolean;
  result: TrajectoryResult;
  index: number;
  raw?: Structure;
  display: Structure;
  collection: PlaybackCollectionIdentity;
  member?: PlaybackFrameIdentity;
  sourceResultId?: string;
  stageId?: string;
  publicationRevision?: string;
  sceneRevision: string;
  sceneGeneration: number;
  requestId?: string;
  canRetainPrevious?(frame:SubmittedScientificFrame): boolean;
  onPlaybackSubmitted(identity:ViewportRenderIdentity): void;
}

export function useSubmittedScientificFrame({active,result,index,raw,display,collection,member,sourceResultId,stageId,publicationRevision,
  sceneRevision,sceneGeneration,requestId,canRetainPrevious,onPlaybackSubmitted}:ScientificFrameProposal) {
  const activation=useMemo(()=>({}),[active]);
  const scope=useMemo(()=>({}),[active,result,collection,publicationRevision,sceneRevision,sceneGeneration]);
  // A new proposal for the same local index (retry, wraparound, or another
  // publication) must not accept an acknowledgement from the earlier draw.
  const frameRequest=useMemo(()=>crypto.randomUUID(),[scope,index,display]);
  const paintRequest=requestId??frameRequest;
  const renderIdentity=useMemo<ViewportRenderIdentity|undefined>(()=>active?{
    sourceId:result.source.id,sourceRevision:sceneRevision,jobIndex:result.jobIndex,
    frameIndex:index,generation:sceneGeneration,requestId:paintRequest,
  }:undefined,[active,result,sceneRevision,index,sceneGeneration,paintRequest]);
  const expected=useRef({scope,renderIdentity,canRetainPrevious});expected.current={scope,renderIdentity,canRetainPrevious};
  const alive=useRef(true);
  useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  type Submission={scope:object;activation:object;display:Structure;frame:SubmittedScientificFrame};
  const last=useRef<Submission|undefined>(undefined);
  const [submitted,setSubmitted]=useState<Submission>();
  const onSceneSubmitted=useCallback((identity:ViewportRenderIdentity)=>{
    if(!alive.current||expected.current.scope!==scope||!sameViewportRenderIdentity(expected.current.renderIdentity,identity))return;
    if(!raw||!member||member.unavailableReason||member.sourceFrameIndex!==index||
      sameViewportRenderIdentity(last.current?.scope===scope?last.current.frame.scene:undefined,identity))return;
    const submission={scope,activation,display,frame:{result,index,structure:raw,scene:identity,collection,frameId:member.frameId,
      sourceResultId:sourceResultId??member.sourceResultId??result.id,stageId:stageId??collection.stageId,publicationRevision}};
    last.current=submission;setSubmitted(submission);
    onPlaybackSubmitted(identity);
  },[scope,activation,display,raw,member,result,index,collection,sourceResultId,stageId,publicationRevision,onPlaybackSubmitted]);
  // A cached canvas must not follow this reader to another publication.
  const isCurrent=useCallback((value:Submission|undefined)=>active&&value&&
    (value.scope===scope||value.activation===activation&&expected.current.canRetainPrevious?.(value.frame)),[scope,activation,active]);
  const readSubmittedScientificFrame=useCallback(()=>alive.current&&expected.current.scope===scope&&isCurrent(last.current)?last.current?.frame:undefined,[scope,isCurrent]);
  const readScene=useCallback(()=>readSubmittedScientificFrame()?.scene,[readSubmittedScientificFrame]);
  const submittedFrame=isCurrent(submitted)?submitted?.frame:undefined;
  const scientificFrameReady=submitted?.scope===scope&&!!submittedFrame&&submittedFrame.index===index&&submittedFrame.structure===raw&&submitted.display===display;
  return{renderIdentity,onSceneSubmitted,readSubmittedScientificFrame,readScene,submittedFrame,scientificFrameReady};
}
