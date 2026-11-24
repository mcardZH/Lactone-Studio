import {useEffect,useRef,useState} from 'react';
import type {AdvancedMixedSamplingCard,AdvancedSamplingCardState,AdvancedSamplingBatch,AdvancedMixedInitialGuess,AdvancedTaskRun,AdvancedSamplingGenerationProgress,AdvancedControllerState} from '../../modeling/advanced/contracts';
import {conformerSamplingSchedule} from '../../modeling/advanced/sampling-progress';
import {samplingCardProgressView,samplingTargetFrames,SAMPLING_CARD_STATUS} from './conformer-incremental-presentation';
import {observeSamplingTime,samplingRemainingLabel,samplingTimeEstimate,type SamplingTimeObservation,type SamplingTimeProgress} from './sampling-time-estimate';
const operationLabels:Record<string,string>={md:'高温 MD',metadynamics:'Metadynamics',anneal:'模拟退火（历史）','spherical-md':'球形 MD（历史）'};
/** The generator receipt is cumulative within its card. Attempts and historical
 * acceptance are diagnostics/baselines, never extra received frames. */
export function conformerGenerationProgressForCard(run:AdvancedTaskRun|undefined,taskId:string|undefined,batchId:string|undefined,cardId:string):AdvancedSamplingGenerationProgress|undefined{
  const progress=run?.backgroundProgress,generated=progress?.generation,mixed=run?.mixedSampling;
  if(!run||!mixed||!generated||progress?.phase!=='generate'||!['queued','running','stopping'].includes(run.status)||run.taskId!==taskId
    ||generated.taskId!==taskId||generated.runId!==run.id||generated.batchId!==batchId||mixed?.batchId!==batchId
    ||generated.cardId!==cardId||mixed.definition.cards[mixed.currentCardIndex]?.id!==cardId||mixed.currentSegmentId!==generated.segmentId
    ||!Number.isSafeInteger(generated.received)||generated.received<0||!Number.isSafeInteger(generated.target)||generated.target<1)return;
  return generated;
}
/** Start the rate at the first accepted step from this exact live segment. */
export function conformerSamplingTimeProgress(run:AdvancedTaskRun|undefined,owner:AdvancedControllerState['activeNative'],batchId:string|undefined):SamplingTimeProgress|null{
  const mix=run?.mixedSampling,progress=run?.sampling?.progress;
  if(!run||run.status!=='running'||!mix||mix.batchId!==batchId||!progress||progress.step<=0
    ||owner?.stageId!=='sampling'||owner.taskId!==run.taskId||owner.runId!==run.id
    ||progress.sessionId!==owner.sessionId||progress.runIdentity.taskId!==run.taskId||progress.runIdentity.runId!==run.id)return null;
  const card=mix.definition.cards[mix.currentCardIndex];
  if(card?.kind!=='sampling')return null;
  const configuration=run.sampling?.stageEvents.find(stage=>stage.sessionId===owner.sessionId
    &&stage.runIdentity.taskId===run.taskId&&stage.runIdentity.runId===run.id&&stage.configuration)?.configuration;
  const total=configuration?conformerSamplingSchedule(configuration)?.totalSteps:null;
  return {identity:JSON.stringify([run.taskId,run.id,batchId,card.id,mix.currentSegmentId,owner.sessionId]),
    rateStage:`${progress.phase}:${progress.method}`,step:progress.step,totalSteps:total??null};
}
function SamplingRemaining({progress,fallback}:{progress:SamplingTimeProgress|null;fallback:number|null}){
  const observation=useRef<SamplingTimeObservation|null>(null),[,refresh]=useState(0);
  const {identity,rateStage,step,totalSteps}=progress??{};
  useEffect(()=>{
    const value=identity!==undefined&&rateStage!==undefined&&step!==undefined?{identity,rateStage,step,totalSteps:totalSteps??null}:null;
    const next=observeSamplingTime(observation.current,value,performance.now());
    if(next===observation.current)return;
    observation.current=next;
    refresh(count=>count+1);
  },[identity,rateStage,step,totalSteps]);
  useEffect(()=>{
    if(!identity)return;
    const timer=setInterval(()=>refresh(count=>count+1),1000);
    return()=>clearInterval(timer);
  },[identity,rateStage]);
  const estimate=samplingTimeEstimate(observation.current,progress,performance.now(),Date.now());
  const label=estimate?.kind==='ready'?samplingRemainingLabel(estimate.remainingMs)
    :estimate?.kind==='awaiting-receipt'?'等待结束回执':fallback===null?'估算中':samplingRemainingLabel(fallback);
  return <output>预计剩余 {label}</output>;
}
export function ConformerSamplingCardProgress({card,configuration,index,configurationChanged=false,batchRunning=false,remainingMs=null,timeProgress=null,generationProgress}:{card:AdvancedSamplingCardState;configuration:AdvancedMixedSamplingCard;index:number;sealed?:boolean;configurationChanged?:boolean;batchRunning?:boolean;remainingMs?:number|null;timeProgress?:SamplingTimeProgress|null;generationProgress?:AdvancedSamplingGenerationProgress}){
  const observed=configurationChanged?card.configuration:configuration,value=samplingCardProgressView(card,observed);
  const generation=observed.kind==='conformer-search'?generationProgress:undefined;
  const received=generation?.received??card.receivedFrameCount??card.generated;
  const target=observed.kind==='sampling'?conformerSamplingSchedule(observed.sampling)?.candidateCount??null:generation?.target??samplingTargetFrames(observed);
  const eta=generation?generation.etaMs:remainingMs;
  const denominator=observed.kind==='sampling'?value.targetTimeFs:target,completed=observed.kind==='sampling'?value.completedTimeFs:received;
  const fraction=denominator&&denominator>0?Math.min(1,Math.max(0,completed/denominator)):0;
  return <div className="conformer-card-progress" data-testid={`sampling-card-progress-${card.id}`}><p role="status">{batchRunning?'运行中…':SAMPLING_CARD_STATUS[card.status]??card.status}　累计完成 {observed.kind==='sampling'?`${value.completedTimeFs/1000} ps = ${received}帧`:`${received}帧`}　目标 {observed.kind==='sampling'?`${value.targetTimeFs===null?'—':value.targetTimeFs/1000} ps = ${target??'—'}帧`:`${target??'—'}帧`}</p><div className="conformer-progress-row"><progress aria-label={`采样${index+1}累计进度`} max={1} value={fraction}/><output>{Number((fraction*100).toFixed(1))}%</output>{batchRunning&&<SamplingRemaining progress={timeProgress} fallback={eta}/>}</div></div>;
}
export function SealedSamplingBatches({batches,initialGuesses}:{batches:readonly AdvancedSamplingBatch[];initialGuesses:readonly AdvancedMixedInitialGuess[]}){
  return <>{batches.filter(batch=>batch.sealed).map((batch,index)=><details key={batch.id} className="shared-input-card shared-input-subcard" data-sampling-batch-id={batch.id}><summary>已封存批次 {index+1} · {batch.sealedReason==='optimization'?'已用于优化':batch.sealedReason==='append'?'已追加新批':'历史批次'} · 合并后 {batch.mergedFrameIds.length} 帧</summary><p>初猜：{initialGuesses.find(initial=>initial.id===batch.initialGuessId)?.label??'已保留的来源'} · 本批来源和科学配置只读</p>{batch.cards.map((card,index)=><div key={card.id}><strong>采样{index+1} · {card.configuration.kind==='conformer-search'?'柔性键采样':operationLabels[card.configuration.sampling.operation]??card.configuration.sampling.operation}</strong>{card.configuration.kind==='sampling'&&<p>{card.configuration.sampling.method}{card.configuration.sampling.dtFs!==undefined?` · 步长 ${card.configuration.sampling.dtFs} fs`:''}{card.configuration.sampling.molecularMD?.temperatureK!==undefined?` · 温度 ${card.configuration.sampling.molecularMD.temperatureK} K`:card.configuration.sampling.metadynamics?.temperatureK!==undefined?` · 温度 ${card.configuration.sampling.metadynamics.temperatureK} K`:''}</p>}<ConformerSamplingCardProgress card={card} configuration={card.configuration} index={index} sealed/></div>)}</details>)}</>;
}
