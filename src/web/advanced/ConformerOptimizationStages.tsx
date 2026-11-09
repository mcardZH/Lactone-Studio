import NumericInput from '../NumericInput';
import type {ReactNode} from 'react';
import {InputSettingsCard,InputSettingsField,InputSettingsRow} from '../InputSettingsFields';
import {InputSettingsAction,InputSettingsCheckbox} from '../InputSettingsLayout';
import {ADVANCED_METHODS,changeAdvancedMethod,type AdvancedMethodDraft} from './AdvancedMethodControls';
import {samplingRemainingLabel} from './sampling-time-estimate';
import ConformerSolventField from './ConformerSolventField';
import {conformerSolvationDraftIssue} from './conformer-solvation-draft';

export interface ConformerOptimizationDraft {
  id:string;method:AdvancedMethodDraft;energyThresholdKcalMol:number;rmsdThresholdAngstrom:number;rmsdMatching?:'fixed'|'symmetry';eliminateEquivalent?:boolean;inputStride?:number;inputClusterCount?:number;advanceCount?:number;checkpointAfter:boolean;
}
export interface ConformerOptimizationAction {
  kind:'start'|'continue';hasHistory:boolean;running?:boolean;stopping?:boolean;
  progress?:{total:number;completed:number;interrupted:number;failed:number;pending:number;succeeded?:number;discarded?:number;etaMs?:number|null};partialFrames?:number;
  interruptedFrames?:number;
  phase?:'optimization'|'cluster'|'eliminate-equivalent'|'prepare-results';
  backgroundProgress?:{completed:number;total:number|null;etaMs?:number|null};
  status?:'queued'|'running'|'stopping'|'checkpoint'|'completed'|'failed'|'stopped';
  finalClusterCount?:number;
  equivalence?:{ordinaryClusterCount:number;finalClusterCount:number;eligiblePairCount:number;unresolvedClusterCount:number};
  error?:ReactNode;
}
export default function ConformerOptimizationStages(p:{
  stages:readonly ConformerOptimizationDraft[];onChange(stages:ConformerOptimizationDraft[]):void;
  onStart(index:number):void;onRunAll():void;canStart(index:number):boolean;busy?:boolean;
  progressForStage?(id:string,index:number):ReactNode;
  actionForStage?(id:string,index:number):ConformerOptimizationAction;
  upstreamForStage?(index:number):{count:number;selectedCount?:number;ready:boolean;message?:string};
  samplingInputCount?:number;
  onContinue?(index:number):void;onRestart?(index:number):void;onPause?(index:number):void;
  onRestartAll?():void;onViewResults?(index:number):void;onViewInterrupted?(index:number):void;
}){
  const update=(index:number,patch:Partial<ConformerOptimizationDraft>)=>p.onChange(p.stages.map((row,i)=>i===index?{...row,...patch}:row));
  const validInputs=p.stages.every((stage,index)=>!conformerSolvationDraftIssue(stage.method.method,stage.method)&&Number.isSafeInteger(stage.inputStride??1)&&(stage.inputStride??1)>0&&(!index||Number.isSafeInteger(stage.inputClusterCount??10)&&(stage.inputClusterCount??10)>0));
  return <div className="conformer-optimization-stages" data-testid="conformer-optimization-stages">
    {p.stages.map((stage,index)=>{const action=p.actionForStage?.(stage.id,index);return <InputSettingsCard key={stage.id} title={`第 ${index+1} 级优化`}>
      {index>0?(()=>{const upstream=p.upstreamForStage?.(index),count=Math.min(stage.inputClusterCount??10,upstream?.count??0),selected=upstream?.selectedCount??Math.ceil(count/(stage.inputStride??1));return <div className="conformer-stage-input-summary"><p role="status">输入：优化{index}归簇{upstream?.ready?` · 共 ${upstream.count} 簇`:` · ${upstream?.message??'等待上一级正式归簇'}`}</p>{upstream?.ready&&<p>先取最低能量的{count}簇 · 本级选取 {selected} 个代表</p>}</div>;})():p.samplingInputCount!==undefined&&<p role="status">输入：采样结果 · 可用 {p.samplingInputCount} 帧 · 本级选取 {Number.isSafeInteger(stage.inputStride??1)&&(stage.inputStride??1)>0?Math.ceil(p.samplingInputCount/(stage.inputStride??1)):'—'} 帧</p>}
      {action?<ConformerOptimizationProgress action={action} index={index} method={stage.method.method}/>:p.progressForStage?.(stage.id,index)}
      {action?.error}
      <InputSettingsRow className="shared-input-row-compact conformer-stage-fields conformer-compact-fields">
        <InputSettingsField label="优化方式" className="conformer-choice-field"><select aria-label={`第${index+1}级优化方式`} disabled={p.busy} value={stage.method.method} onChange={event=>update(index,{method:{...changeAdvancedMethod(stage.method,event.target.value as AdvancedMethodDraft['method']),solvationModel:stage.method.solvationModel,solvent:stage.method.solvent}})}>{ADVANCED_METHODS.map(([id,label])=><option key={id} value={id}>{label}{id==='gfn2'?'（推荐）':''}</option>)}</select></InputSettingsField>
        <ConformerSolventField method={stage.method.method} value={stage.method} onChange={value=>update(index,{method:{...stage.method,...value}})} ariaLabel={`第${index+1}级溶剂`} disabled={p.busy}/>
      </InputSettingsRow>
      <InputSettingsRow className="shared-input-row-compact conformer-stage-fields conformer-compact-fields">
        <InputSettingsField label="最大优化步数"><NumericInput aria-label={`第${index+1}级最大优化步数`} disabled={p.busy} min={1} step={1} value={stage.method.maxSteps} onChange={event=>update(index,{method:{...stage.method,maxSteps:event.currentTarget.valueAsNumber}})}/></InputSettingsField>
        {index>0&&<InputSettingsField label="选取上一级簇数"><NumericInput aria-label={`第${index+1}级选取上一级簇数`} disabled={p.busy} stepper min={1} step={1} value={stage.inputClusterCount??10} onChange={event=>update(index,{inputClusterCount:event.currentTarget.valueAsNumber})}/></InputSettingsField>}
        <InputSettingsField label="抽帧间隔"><NumericInput aria-label={`第${index+1}级抽帧间隔`} aria-invalid={!Number.isSafeInteger(stage.inputStride??1)||(stage.inputStride??1)<1||undefined} disabled={p.busy} stepper min={1} step={1} value={Number.isNaN(stage.inputStride)?'':stage.inputStride??1} onChange={event=>update(index,{inputStride:event.currentTarget.valueAsNumber})}/></InputSettingsField>
      </InputSettingsRow>
      <InputSettingsRow className="shared-input-row-compact conformer-stage-fields">
        <InputSettingsField label="归簇能量差 / kcal·mol⁻¹"><NumericInput aria-label={`第${index+1}级归簇能量差`} disabled={p.busy} min={0} step={.05} value={stage.energyThresholdKcalMol} onChange={event=>update(index,{energyThresholdKcalMol:event.currentTarget.valueAsNumber})}/></InputSettingsField>
        <InputSettingsField label="RMSD / Å"><NumericInput aria-label={`第${index+1}级归簇RMSD`} disabled={p.busy} min={.000001} step={.01} value={stage.rmsdThresholdAngstrom} onChange={event=>update(index,{rmsdThresholdAngstrom:event.currentTarget.valueAsNumber})}/></InputSettingsField>
      </InputSettingsRow>
      <div className="conformer-equivalence-option"><InputSettingsCheckbox label="消除等价构象" ariaLabel={`第${index+1}级消除等价构象`} disabled={p.busy} checked={stage.eliminateEquivalent===true} onChange={eliminateEquivalent=>update(index,{eliminateEquivalent,rmsdMatching:'fixed'})}/>
        {stage.eliminateEquivalent===true&&<div className="conformer-equivalence-description"><p>簇代表能量差 &lt; 0.03 kcal/mol</p><p>快速判定，未确认等价的构象保留</p></div>}
      </div>
      <InputSettingsRow><InputSettingsAction ariaLabel={`第${index+1}级${action?.kind==='continue'?'继续':'开始'}`} disabled={p.busy||!validInputs||!p.canStart(index)} onClick={()=>action?.kind==='continue'&&p.onContinue?p.onContinue(index):p.onStart(index)}>{action?.kind==='continue'?'继续优化':'开始优化'}</InputSettingsAction>{p.onPause&&<InputSettingsAction ariaLabel={`第${index+1}级暂停优化`} disabled={!action?.running||action.stopping} onClick={()=>p.onPause?.(index)}>{action?.stopping?'正在暂停':'暂停优化'}</InputSettingsAction>}{p.onRestart&&<InputSettingsAction ariaLabel={`第${index+1}级重新优化`} disabled={p.busy||!validInputs||!action?.hasHistory||!p.canStart(index)} onClick={()=>p.onRestart?.(index)}>重新优化</InputSettingsAction>}{p.stages.length>1&&<InputSettingsAction disabled={p.busy} onClick={()=>p.onChange(p.stages.filter((_,i)=>i!==index))}>移除此级</InputSettingsAction>}</InputSettingsRow>
    </InputSettingsCard>;})}
    <InputSettingsRow><InputSettingsAction disabled={p.busy||p.stages.length>=8} onClick={()=>{const previous=p.stages.at(-1);if(previous)p.onChange([...p.stages,{...previous,id:crypto.randomUUID(),method:{...previous.method},rmsdMatching:'fixed',eliminateEquivalent:false}]);}}>添加优化级</InputSettingsAction><InputSettingsAction variant="primary" disabled={p.busy||!validInputs||!p.canStart(0)} onClick={p.onRunAll}>{p.actionForStage?p.stages.some((stage,index)=>p.actionForStage?.(stage.id,index).kind==='continue')?'批量继续优化':'批量开始优化':'批量运行全部'}</InputSettingsAction>{p.onRestartAll&&<InputSettingsAction disabled={p.busy||!validInputs||!p.stages.some((stage,index)=>p.actionForStage?.(stage.id,index).hasHistory)||!p.canStart(0)} onClick={p.onRestartAll}>全部重新优化</InputSettingsAction>}</InputSettingsRow>
  </div>;
}

/** Exactly one progress surface per level; a completed optimizer is not a completed workflow. */
export function ConformerOptimizationProgress({action,index,method}:{action:ConformerOptimizationAction;index:number;method:string}){
  const progress=action.progress,background=action.backgroundProgress,phase=action.phase??'optimization';
  if(!progress&&!action.running&&action.finalClusterCount===undefined)return null;
  const succeeded=progress?.succeeded??progress?.completed??0,discarded=progress?.discarded??((progress?.interrupted??0)+(progress?.failed??0));
  const phaseLabel=phase==='cluster'?'常规归簇':phase==='eliminate-equivalent'?'消除等价构象':phase==='prepare-results'?'准备结果':`${ADVANCED_METHODS.find(([id])=>id===method)?.[1]??method} 优化`;
  const total=phase==='optimization'?progress?.total:background?.total;
  const processed=phase==='optimization'?succeeded+discarded:background?.completed??0;
  const determinate=typeof total==='number'&&Number.isFinite(total)&&total>0&&Number.isFinite(processed)&&processed>=0&&processed<=total;
  const eta=phase==='optimization'?progress?.etaMs:background?.etaMs;
  const prefix=action.stopping?'停止中':action.status==='queued'?'排队中':'运行中';
  return <div className="conformer-stage-progress" data-testid={`conformer-stage-progress-${index+1}`}>
    {action.running?<><p role="status">{prefix}：第 {index+1} 级 · {phaseLabel}</p>
      <div className="conformer-progress-row"><progress aria-label={`第${index+1}级${phaseLabel}进度`} max={determinate?total!:undefined} value={determinate?processed:undefined}/>
        {phase==='optimization'&&progress&&<output>已处理 {processed}/{progress.total} · 成功 {succeeded} · 丢弃 {discarded}</output>}
        {determinate&&<output>{Number((processed/total!*100).toFixed(1))}%</output>}
        <output>预计剩余 {eta==null||!Number.isFinite(eta)?'估算中':samplingRemainingLabel(eta)}</output></div></>:
      <><p role="status">{action.status==='failed'?'失败':action.status==='stopped'?'已停止':action.finalClusterCount!==undefined?'完成':'待继续'}：成功 {succeeded} · 丢弃 {discarded}</p>
        {action.equivalence?<><p>常规归簇 {action.equivalence.ordinaryClusterCount} → 最终 {action.equivalence.finalClusterCount} 簇</p>{action.equivalence.eligiblePairCount===0&&<p>无符合能量条件的簇对</p>}{action.equivalence.unresolvedClusterCount>0&&<p>保留待判定 {action.equivalence.unresolvedClusterCount} 簇</p>}</>:action.finalClusterCount!==undefined&&<p>最终 {action.finalClusterCount} 簇</p>}</>}
  </div>;
}
