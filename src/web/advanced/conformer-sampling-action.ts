import type {AdvancedController} from '../../modeling/advanced/controller';
import type {AdvancedTaskRecord,AdvancedMixedSamplingDefinition,AdvancedOptimizationStageConfig} from '../../modeling/advanced/contracts';

type SamplingController=Pick<AdvancedController,'previewMixedConfiguration'|'previewStageConfiguration'|'selectInitialGuess'|'confirmMixedElectronicState'|'configureMixedSampling'|'configureStages'|'continueSampling'|'appendSampling'|'restartSampling'>;
export const CONFORMER_ELECTRONIC_IMPACT='更改本次搜索的电荷或自旋多重度后，旧电子态结果将退出当前候选集合，当前优化结果及晋级名单失效；已封存批次和原始优化历史保留。后续采样与优化只使用新电子态，不混用旧完成标记。继续？';
export function commitConformerElectronicDraft(previous:{charge:number;multiplicity:number},next:{charge:number;multiplicity:number},hasResults:boolean,confirm:(message:string)=>boolean,commit:(changed:boolean)=>void):boolean{
  const changed=previous.charge!==next.charge||previous.multiplicity!==next.multiplicity;
  if(changed&&hasResults&&!confirm(CONFORMER_ELECTRONIC_IMPACT))return false;
  commit(changed);return true;
}
/** Explicit UI action boundary: obtain impact before any mutation, reuse the
 * selected immutable initial, and never publish/activate a document here. */
export function submitConformerSampling(p:{controller:SamplingController;task:AdvancedTaskRecord;
  definition:AdvancedMixedSamplingDefinition;stages:AdvancedOptimizationStageConfig[];
  electronic:{charge:number;multiplicity:number};mode:'continue'|'append'|'restart';confirm(message:string):boolean}){
  const initial=p.task.mixedSampling?.initialGuesses.find(initial=>initial.id===p.task.mixedSampling?.selectedInitialGuessId);
  if(!initial)throw Error('请明确选择本次采样使用的初猜。');
  const cardImpact=p.controller.previewMixedConfiguration(p.task.id,p.definition),stageImpact=p.controller.previewStageConfiguration(p.task.id,p.stages);
  if(p.mode==='continue'&&!cardImpact.canContinue)throw Error(cardImpact.sealed?'本批采样已封存，请用追加采样建立新批次。':'当前各卡已达到目标或组合已耗尽；增加目标、修改未封存配置或追加新批次后再继续。');
  if(p.mode==='restart'&&!p.confirm('重新采样将清除本任务全部采样批次及下游优化结果，并按当前配置重新开始。继续？'))return null;
  if(p.mode!=='restart'&&(p.mode==='continue'&&cardImpact.requiresConfirmation||stageImpact.requiresConfirmation)&&!p.confirm(`本次设置将使${cardImpact.affectedCardIds.length?'部分采样卡及其':'本级及更高级'}依赖结果失效，继续后按新科学配置处理。继续？`))return null;
  p.controller.selectInitialGuess(p.task.id,initial.id);
  p.controller.confirmMixedElectronicState(p.task.id,initial.source,p.electronic);
  p.controller.configureMixedSampling(p.task.id,p.definition);p.controller.configureStages(p.task.id,p.stages);
  const runId=p.mode==='restart'?p.controller.restartSampling(p.task.id):p.mode==='append'?p.controller.appendSampling(p.task.id):p.controller.continueSampling(p.task.id);
  return{runId,source:initial.source};
}
