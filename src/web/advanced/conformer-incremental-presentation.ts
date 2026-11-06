import type { AdvancedMixedSamplingCard, AdvancedTaskRecord } from '../../modeling/advanced/contracts';
import type {ResolvedConformerPlaybackFrame} from './conformer-playback';

export interface SamplingCardProgressView {
  status: string; completedTimeFs: number; targetTimeFs: number | null;
  valid: number; merged: number; segments: number; remainingTimeFs: number | null;
}
interface CardObservation {
  status: string; completedTimeFs: number; frameIds: readonly string[];
  mergedFrameIds: readonly string[]; segments: readonly unknown[];
}
export function samplingCardProgressView(card: CardObservation, configuration: AdvancedMixedSamplingCard): SamplingCardProgressView {
  const duration = configuration.kind === 'sampling' ? configuration.sampling.operation === 'md'
    ? configuration.sampling.molecularMD?.durationFs : configuration.sampling.metadynamics?.durationFs : undefined;
  const targetTimeFs = duration !== undefined && Number.isFinite(duration) ? duration : null;
  return {status:card.status,completedTimeFs:card.completedTimeFs,targetTimeFs,
    valid:card.frameIds.length,merged:card.mergedFrameIds.length,segments:card.segments.length,
    remainingTimeFs:targetTimeFs===null?null:Math.max(0,targetTimeFs-card.completedTimeFs)};
}
export const SAMPLING_CARD_STATUS:Record<string,string>={pending:'待执行',running:'运行中',completed:'已完成',failed:'失败',stopped:'已终止'};
export function conformerPlaybackReference(mode:'raw'|'fixed'|undefined,resolved:ResolvedConformerPlaybackFrame|undefined,coreIds:readonly string[]){
  const available=Boolean(resolved?.referenceSource&&coreIds.length&&!resolved.warnings.length&&coreIds.every(id=>resolved.referenceSource!.structure.atoms.some(atom=>atom.id===id)));
  return{available,mode:mode==='raw'?'raw' as const:available?'fixed' as const:'raw' as const};
}
export function samplingTargetFrames(configuration:AdvancedMixedSamplingCard):number|null {
  return configuration.kind==='conformer-search'&&configuration.search.quantity.mode==='total-effective'
    ? configuration.search.quantity.targetCount??null:null;
}
/** The workflow owns cumulative input identity and acceptance. UI never sums
 * duplicate attempts or counts historical promotion members as current work. */
export function optimizationActionView(task:AdvancedTaskRecord|undefined,stageId:string){
  const stage=task?.conformerWorkflow?.stages.find(stage=>stage.stageId===stageId);
  const latest=task?.runs.slice().reverse().find(run=>run.stages.some(stage=>stage.configurationId===stageId||stage.id===stageId));
  const latestStage=latest?.stages.find(stage=>stage.configurationId===stageId||stage.id===stageId);
  const hasWork=Boolean(stage?.progress?.total||latestStage?.results.length||latestStage&&latestStage.status!=='pending');
  return {kind:hasWork?'continue' as const:'start' as const,
    hasHistory:Boolean(stage||latest),progress:stage?.progress,
    partialFrames:stage?.resultFrameIds?.length??0,
    running:Boolean(latest&&['queued','running','stopping'].includes(latest.status)&&(latestStage?.status==='running'||latest.status==='queued'&&latestStage===latest.stages[0])),stopping:latest?.status==='stopping',run:latest};
}
