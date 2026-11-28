import {
  postprocessPairedWavefunctionBinding,
  postprocessWavefunctionFrame,
  readPostprocessSourceBytes,
} from '../../results/postprocess-document';
import type {McpResultTarget} from './result-tools';
import type {ResultDiagnostic,TrajectoryResult} from '../../results/contracts';
import type {ExcitedState} from '../../results/scientific-contracts';
import {attachTrajectoryStages} from '../../results/trajectory-stages';
import {VibronicSha256} from '../../core/gaussian-vibronic/sha256-stream';
import {printedTransitionText} from '../results/spectroscopy-presentation';
import {toolError} from './types';

export const originalMoldenId='original-molden';
export const printedTransitionsId='printed-transitions';

function assetRevision(subject:unknown) {
  const hash=new VibronicSha256();
  hash.update(new TextEncoder().encode(JSON.stringify(subject)));
  return hash.digest();
}

/** Use the retained attachment and the native proof of its one saved geometry. */
export function originalMolden(target:McpResultTarget,targetRef=target.navigationRef??target.ownerId) {
  const document=target.postprocess,attachment=document?.wavefunction;
  const source=attachment?.source,metadata=source?.metadata;
  if(!document||!attachment||source?.kind!=='molden'||!metadata||metadata.format!=='molden')return;
  const original=source.result.source;
  const binding=document.output?postprocessPairedWavefunctionBinding(document):undefined;
  const frameIndex=document.output?binding?.frameIndex:postprocessWavefunctionFrame(document);
  if(frameIndex==null||!document.result.frames[frameIndex]||target.result?.kind==='diagnostic')return;
  if(target.result&&(document.result.id!==target.result.id||document.result.jobIndex!==target.result.jobIndex||
    document.result.source.id!==target.result.source.id||document.result.source.sha256!==target.result.source.sha256))return;
  if(original.id!==metadata.sourceId||original.name!==metadata.name||!original.size||
    !/^[a-f\d]{64}$/.test(metadata.sourceRevision)||original.sha256&&original.sha256!==metadata.sourceRevision)return;
  const provenance={ownerId:target.ownerId,targetRef,resultId:document.result.id,jobIndex:document.result.jobIndex,
    frameIndex,sourceFrameIndex:binding?.sourceFrameIndex??document.result.frames[frameIndex].sourceFrameIndex??frameIndex,
    source:{...original,sha256:metadata.sourceRevision},
    ...(source.generatedXtb?{artifactId:source.generatedXtb.artifactId,runIdentity:source.generatedXtb.runIdentity}:{})};
  const sourceRevision=JSON.stringify([provenance.resultId,provenance.jobIndex,
    document.result.source.id,document.result.source.sha256,provenance.sourceFrameIndex,original.id,metadata.sourceRevision]);
  const revision=assetRevision([originalMoldenId,sourceRevision]);
  const filename='Ester-Studio-original.molden';
  return {
    asset:{id:originalMoldenId,filename,kind:'molden',mimeType:'chemical/x-molden',assetRevision:revision,provenance,
      ...(provenance.runIdentity?{readOrigin:{tool:'es_run_read',arguments:{runId:provenance.runIdentity.runId}}}:{})},
    exportArguments:{targetRef,assetId:originalMoldenId,assetRevision:revision},
    legacySourceRevision:sourceRevision,
    original:{
      bytes:original.size,sourceRevision:metadata.sourceRevision,
      readRange:(offset:number,length:number,signal?:AbortSignal)=>readPostprocessSourceBytes(attachment,offset,offset+length,signal),
    },
  };
}

export function printedTransitionGroups(result:TrajectoryResult|ResultDiagnostic,selector:{stageId?:string;frameIndex?:number}) {
  const frames=result.kind==='diagnostic'?[]:result.frames;
  const stages=result.kind==='diagnostic'?undefined:attachTrajectoryStages(result).stages;
  const stage=selector.stageId===undefined?undefined:stages?.find(row=>row.id===selector.stageId);
  if(selector.stageId!==undefined&&!stage)
    throw toolError('result_stage_unavailable','The retained job has no such scientific stage.',{stageId:selector.stageId,stages});
  const stageFrames=stage?.frameIndices;
  const frameIndex=selector.frameIndex;
  if(frameIndex!==undefined&&!frames[stageFrames?stageFrames[frameIndex]:frameIndex])
    throw toolError('frame_unavailable','The selected native job or stage has no such complete frame.',{stageId:stage?.id,frameIndex});
  const stageByFrame=stageFrames?new Map(stageFrames.map((sourceIndex,index)=>[sourceIndex,index])):undefined;
  const groups=new Map<number|null,ExcitedState[]>();
  for(const state of result.scientific?.excitedStates??[]){
    const local=state.frameIndex===null?null:stageByFrame?stageByFrame.get(state.frameIndex):state.frameIndex;
    if(local===undefined||frameIndex!==undefined&&local!==frameIndex||stageByFrame&&local===null)continue;
    const members=groups.get(local)??[];
    members.push(state);
    groups.set(local,members);
  }
  return [...groups].sort(([a],[b])=>(a??-1)-(b??-1)).map(([local,states])=>{
    const jobFrameIndex=local===null?null:stageFrames?.[local]??local;
    const sourceFrameIndex=jobFrameIndex===null?null:frames[jobFrameIndex]?.sourceFrameIndex??jobFrameIndex;
    return {frameIndex:local,jobFrameIndex,sourceFrameIndex,stageId:stage?.id,states};
  });
}

export function printedTransitionAsset(result:TrajectoryResult|ResultDiagnostic,targetRef:string,group:ReturnType<typeof printedTransitionGroups>[number],jobId?:string) {
  const provenance={resultId:result.id,source:result.source,jobIndex:result.jobIndex,stageId:group.stageId,frameIndex:group.frameIndex,
    jobFrameIndex:group.jobFrameIndex,sourceFrameIndex:group.sourceFrameIndex};
  const filename='Ester-Studio-printed-transitions.txt';
  const revision=assetRevision([printedTransitionsId,provenance,group.states]);
  return {
    asset:{id:printedTransitionsId,kind:'text',filename,mimeType:'text/plain',assetRevision:revision,provenance},
    exportArguments:{targetRef,...(jobId?{jobId}:{}),...(group.stageId?{stageId:group.stageId}:{}),
      ...(group.frameIndex===null?{}:{frameIndex:group.frameIndex}),assetId:printedTransitionsId,assetRevision:revision},
    text:()=>printedTransitionText(group.states,provenance),
  };
}
