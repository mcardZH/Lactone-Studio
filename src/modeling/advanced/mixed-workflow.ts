import {coordinatesFingerprint,graphFingerprint} from '../../core/modeling/graph';
import type {AdvancedFrameSource} from './frame-source';
import type {AdvancedMixedSamplingCard,AdvancedMixedSamplingDefinition,AdvancedSamplingCardState,AdvancedSamplingBatch} from './contracts';

export function mixedCardTargetTimeFs(card:AdvancedMixedSamplingCard):number {
 if(card.kind!=='sampling')return 0;
 const options=card.sampling;
 return (options.operation==='md'?options.molecularMD:options.operation==='metadynamics'?options.metadynamics:options.sphericalMD)?.durationFs??50000;
}
export function mixedCardTargetCount(card:AdvancedMixedSamplingCard):number {
 if(card.kind!=='conformer-search')return 0;
 return card.search.quantity.mode==='total-effective'?card.search.quantity.targetCount:card.search.torsions.reduce((total,row)=>total*(row.pointCount??card.search.quantity.pointsPerTorsion),1);
}
/** Workload and host resources do not change scientific source identity. */
export function mixedCardScienceKey(card:AdvancedMixedSamplingCard,definition:AdvancedMixedSamplingDefinition,source:AdvancedFrameSource):string {
 let configuration:unknown;
 if(card.kind==='conformer-search') {
  const {quantity,samplingLimits,...rest}=card.search;
  const {maxCandidates,maxAttempts,maxAtoms,maxTorsions,...limits}=samplingLimits??{};
  const {targetCount,...policy}=quantity as typeof quantity&{targetCount?:number};
  const torsions=rest.torsions.map(row=>{if(quantity.mode==='total-effective'&&quantity.automaticPointAllocation&&row.pointCountMode!=='manual'){const {pointCount,...axis}=row;return axis;}return row;});
  configuration={kind:card.kind,...rest,torsions,quantity:policy,limits};
 } else {
  const {threads,memoryBudgetBytes,maxSteps,maxEvaluations,maxFrames,maxWallTimeSeconds,...sampling}=card.sampling;
  for(const key of ['molecularMD','metadynamics','sphericalMD'] as const)if(sampling[key]){const {durationFs,...settings}=sampling[key]!;sampling[key]=settings as never;}
  configuration={kind:card.kind,sampling};
 }
 return JSON.stringify({configuration,source:{ref:source.ref,graph:graphFingerprint(source.structure),coordinates:coordinatesFingerprint(source.structure),constraints:source.constraints},
  protection:{...(definition.coreProtectionEnabled!==undefined?{enabled:definition.coreProtectionEnabled}:{}),protectedAtomIds:definition.protectedAtomIds,core:definition.coreProtection,native:definition.nativeProtection,sphere:definition.sphere}});
}
export function makeSamplingCardState(card:AdvancedMixedSamplingCard,definition:AdvancedMixedSamplingDefinition,source:AdvancedFrameSource,revision=1):AdvancedSamplingCardState {
 return{id:card.id,configurationRevision:revision,configuration:structuredClone(card),scienceKey:mixedCardScienceKey(card,definition,source),status:'pending',frameIds:[],mergedFrameIds:[],completedTimeFs:0,segments:[],generated:0,duplicates:0,coreRejected:0,accepted:0};
}
export function samplingCardNeedsWork(card:AdvancedSamplingCardState):boolean {
 return card.configuration.kind==='sampling'?card.completedTimeFs+1e-9<mixedCardTargetTimeFs(card.configuration)
  :card.frameIds.length<mixedCardTargetCount(card.configuration)&&!card.exhausted;
}
export function syncSamplingBatch(batch:AdvancedSamplingBatch,definition:AdvancedMixedSamplingDefinition,source:AdvancedFrameSource,initialGuessId:string):void {
 if(batch.sealed)throw Error('本批采样已封存；请追加新批次，不能修改或补填旧批。');
 batch.cards=definition.cards.map(configuration=>{
  const old=batch.cards.find(card=>card.id===configuration.id),key=mixedCardScienceKey(configuration,definition,source);
  if(!old||old.scienceKey!==key)return makeSamplingCardState(configuration,definition,source,(old?.configurationRevision??0)+1);
  old.configuration=structuredClone(configuration);if(samplingCardNeedsWork(old))old.status='pending';else old.status='completed';return old;
 });
 batch.definition=structuredClone(definition);batch.source=source;batch.initialGuessId=initialGuessId;
}
