import type {AdvancedClusterCollection,AdvancedTaskRecord,AdvancedOptimizationStageConfig,AdvancedCandidateInput,AdvancedStageInputSelection} from './contracts';
import {conformerCalculationIdentityKey} from '../conformers/clustering';
import {coordinatesFingerprint,graphFingerprint} from '../../core/modeling/graph';

export function conformerStageConfigs(task:AdvancedTaskRecord):AdvancedOptimizationStageConfig[]{
  return task.spec.kind==='conformer-search'?task.spec.search.stages:task.spec.kind==='sampling'||task.spec.kind==='docking'?task.spec.optimizationStages:[];
}
/** Manifest compatibility floor, separate from advanced/source schema numbers.
 * Historical runs also retain these semantics after a current draft changes. */
export function conformerTaskRequiresExtendedSemantics(task:AdvancedTaskRecord):boolean {
  const extended=(config:Pick<AdvancedOptimizationStageConfig,'clustering'|'inputStride'>)=>
    config.inputStride!==undefined&&config.inputStride!==1||config.clustering?.rmsdMatching!==undefined&&config.clustering.rmsdMatching!=='fixed';
  return conformerStageConfigs(task).some(extended)||task.runs.some(run=>run.stages.some(stage=>
    stage.configuration&&extended(stage.configuration)||stage.inputSelection?.inputStride!==undefined&&stage.inputSelection.inputStride!==1
    ||stage.clustering?.policy.rmsdMatching!==undefined&&stage.clustering.policy.rmsdMatching!=='fixed'
    ||stage.clustering?.groups.some(group=>group.rmsdMatching!==undefined&&group.rmsdMatching!=='fixed')));
}
/** New writer floor, including explicitly disabled new settings. */
export function conformerTaskRequiresElementGeometrySemantics(task:AdvancedTaskRecord):boolean{
 const extended=(config:Pick<AdvancedOptimizationStageConfig,'clustering'>)=>config.clustering?.eliminateEquivalent!==undefined;
 return conformerStageConfigs(task).some(extended)||task.runs.some(run=>run.stages.some(stage=>
  stage.configuration&&extended(stage.configuration)||stage.clustering?.algorithmVersion==='fixed-then-element-v1'||!!stage.clustering?.equivalence));
}
/** Pure, one-time current-draft migration. Executed runs retain the original
 * configuration, inputs and promotion list as historical scientific evidence. */
export function migrateConformerInputSemantics(task:AdvancedTaskRecord):void {
  const workflow=task.conformerWorkflow;
  if(!workflow||!['conformer-search','sampling'].includes(task.spec.kind))return;
  // A missing matching field is historical fixed correspondence, including
  // already migrated receiving-stage projects. Do not touch executed snapshots
  // or their cluster sets, and do not regroup while opening a project.
  const historical=conformerStageConfigs(task).map(config=>({...structuredClone(config),inputStride:config.inputStride??1,
    clustering:{...config.clustering,rmsdMatching:config.clustering?.rmsdMatching??'fixed' as const}}));
  if(task.spec.kind==='conformer-search')task.spec.search.stages=historical;
  else if(task.spec.kind==='sampling')task.spec.optimizationStages=historical;
  if(workflow.inputSemantics===2)return;
  const configs=conformerStageConfigs(task),legacy=configs.map(config=>config.advanceCount);
  const migrated=normalizeConformerStageConfigs(configs,'fixed').map((config,index)=>({...config,clustering:structuredClone(historical[index].clustering)}));
  if(task.spec.kind==='conformer-search')task.spec.search.stages=migrated;
  else if(task.spec.kind==='sampling')task.spec.optimizationStages=migrated;
  if(legacy.at(-1)!==undefined)workflow.legacyLastAdvanceCount=legacy.at(-1);
  workflow.inputSemantics=2;
}
/** New requests use receiving-stage semantics even when called with an old
 * producer-side DTO. No scientific history exists at task creation yet. */
export function normalizeConformerStageConfigs(configs:readonly AdvancedOptimizationStageConfig[],_defaultMatching:'fixed'|'symmetry'='fixed'):AdvancedOptimizationStageConfig[]{
  return configs.map((config,index)=>{const {advanceCount:_,inputClusterCount:count,...rest}=structuredClone(config);
    return {...rest,inputStride:config.inputStride??1,clustering:{...config.clustering,rmsdMatching:'fixed',eliminateEquivalent:config.clustering?.eliminateEquivalent??false},...(index?{inputClusterCount:count??configs[index-1].advanceCount??10}:{})};});
}
export function selectConformerInputsByStride<T>(inputs:readonly T[],inputStride=1):T[]{
  if(!Number.isSafeInteger(inputStride)||inputStride<1)throw Error('抽帧间隔须为正整数。');
  return inputs.filter((_,index)=>index%inputStride===0);
}
export function buildAdvancedClusterCollection(task:AdvancedTaskRecord,configurationId:string):AdvancedClusterCollection|undefined {
  const state=task.conformerWorkflow?.stages.find(row=>row.stageId===configurationId);if(!state)return;
  const run=task.runs.find(row=>row.id===state.producerRunId),stage=run?.stages.find(row=>row.id===state.stageRunId);
  const frames=new Map([...task.guessFrames,...task.runs.flatMap(row=>row.frames)].map(frame=>[frame.id,frame]));
  const results=stage?.results??[],ordinal=new Map((stage?.inputCandidateIds??results.map(row=>row.candidateId)).map((id,index)=>[id,index]));
  const groups=stage?.clustering?.groups??[],group=groups.length===1?groups[0]:undefined;
  const rows:AdvancedClusterCollection['clusters'][number][]=groups.flatMap(group=>group.clusters.map(cluster=>{
    const result=results.find(row=>row.candidateId===cluster.representative.candidateId&&row.status==='completed');
    const frameId=result?.frameId??null,frame=frameId?frames.get(frameId):undefined;
    const parent=frame?.parentRef,source=cluster.representative.source;
    const matching=frame&&frame.candidateId===cluster.representative.candidateId&&frame.energyHartree===cluster.representative.energyHartree
      &&parent?.documentId===source.documentId&&parent.revision===source.revision&&parent.frameId===source.frameId&&parent.sourceId===source.sourceId
      &&frame.source.structure.charge===group.identity.charge&&frame.source.structure.multiplicity===group.identity.multiplicity
      &&conformerCalculationIdentityKey(cluster.representative.identity)===conformerCalculationIdentityKey(group.identity)
      &&(!result?.identity||conformerCalculationIdentityKey(result.identity)===conformerCalculationIdentityKey(group.identity))
      &&coordinatesFingerprint(frame.source.structure)===coordinatesFingerprint(cluster.representative.structure)&&graphFingerprint(frame.source.structure)===graphFingerprint(cluster.representative.structure);
    return {clusterId:cluster.id,representativeCandidateId:cluster.representative.candidateId,representativeFrameId:frameId,
      memberCandidateIds:cluster.members.map(member=>member.candidateId),memberCount:cluster.members.length,energyHartree:cluster.representative.energyHartree,
      sourceOrdinal:ordinal.get(cluster.representative.candidateId)??Number.MAX_SAFE_INTEGER,
      ...(!matching?{unavailableReason:'簇代表完整结构或能量来源缺失。'}:{})};
  }));
  // Legacy subsets stay readable without inventing membership or complete clusters.
  if(!groups.length&&state.resultFrameIds?.length!==0)for(const [index,id]of (state.representativeFrameIds??[]).entries()){
    const frame=frames.get(id);rows.push({clusterId:`legacy-frame:${id}`,representativeCandidateId:frame?.candidateId??id,representativeFrameId:id,
      memberCandidateIds:[],memberCount:null,energyHartree:frame?.energyHartree??null,sourceOrdinal:index,
      ...(!frame?{unavailableReason:'历史代表完整结构缺失。'}:{})});
  }
  rows.sort((a,b)=>(a.energyHartree??Infinity)-(b.energyHartree??Infinity)||a.sourceOrdinal-b.sourceOrdinal);
  const complete=!!stage?.clustering&&groups.length<=1&&stage.status==='completed'&&!!state.completed;
  return {schema:1,id:state.collectionId,revision:state.revision??0,taskId:task.id,configurationId,producerRunId:state.producerRunId,stageRunId:state.stageRunId,configKey:state.configKey,
    current:state.valid,settlement:complete?'complete':stage?.clustering?'partial':rows.length?'historical-incomplete':(state.resultFrameIds?.length??0)>0?'needs-clustering':'partial',
    comparison:group?{groupId:group.id,comparisonKey:group.comparisonKey,identity:group.identity}:null,clusters:rows};
}
export function clusterCollectionSignature(collection:AdvancedClusterCollection,inputs:readonly AdvancedCandidateInput[]):string {
  return JSON.stringify([collection.id,collection.revision,collection.comparison&&conformerCalculationIdentityKey(collection.comparison.identity),
    collection.clusters.map(row=>[row.clusterId,row.representativeCandidateId,row.representativeFrameId,row.energyHartree]),
    inputs.map(input=>[input.candidateId,input.source.ref,input.source.stamp,input.source.structure.charge,input.source.structure.multiplicity,input.source.constraints])]);
}
export function selectAdvancedClusterInputs(task:AdvancedTaskRecord,configurationId:string,count:number,inputStride=1):{inputs:AdvancedCandidateInput[];selection:AdvancedStageInputSelection}{
  if(!Number.isSafeInteger(count)||count<1)throw Error('选取上一级簇数须为正整数。');
  const collection=buildAdvancedClusterCollection(task,configurationId);
  if(!collection?.current||collection.settlement!=='complete'||!collection.comparison||!collection.clusters.length)throw Error('上一级尚无完整有效的正式归簇集合。');
  const selected=selectConformerInputsByStride(collection.clusters.slice(0,count),inputStride),frames=new Map(task.runs.flatMap(run=>run.frames).map(frame=>[frame.id,frame]));
  const inputs=selected.map(row=>{const frame=row.representativeFrameId?frames.get(row.representativeFrameId):undefined;
    if(row.unavailableReason||!frame)throw Error('选中簇代表完整结构缺失，未用较高能簇补足输入。');
    return {candidateId:row.representativeCandidateId,source:structuredClone(frame.source)};});
  return {inputs,selection:{schema:1,mode:'previous-clusters',collectionId:collection.id,collectionRevision:collection.revision,
    collectionSignature:clusterCollectionSignature(collection,inputs),requestedCount:count,inputStride,actualCount:inputs.length,clusterIds:selected.map(row=>row.clusterId),representativeFrameIds:selected.map(row=>row.representativeFrameId!)}};
}
export function conformerUpstreamSummary(task:AdvancedTaskRecord|undefined,index:number,count?:number,inputStride=1){
  const previous=task&&conformerStageConfigs(task)[index-1],collection=previous&&buildAdvancedClusterCollection(task,previous.id);
  const ready=!!collection?.current&&collection.settlement==='complete'&&!!collection.comparison&&collection.clusters.length>0;
  const validCount=Number.isSafeInteger(count)&&count!>0,validStride=Number.isSafeInteger(inputStride)&&inputStride>0;
  const selected=validCount&&validStride?selectConformerInputsByStride(collection?.clusters.slice(0,count)??[],inputStride):[];
  const unavailable=ready&&selected.some(row=>row.unavailableReason||!row.representativeFrameId);
  return {count:collection?.clusters.length??0,selectedCount:selected.length,ready:ready&&validCount&&validStride&&!unavailable,message:!validCount?'选取上一级簇数须为正整数。':!validStride?'抽帧间隔须为正整数。':unavailable?'选中簇代表结构不可用':collection?.settlement==='needs-clustering'?'上一级待整理归簇':'等待上一级正式归簇'};
}
