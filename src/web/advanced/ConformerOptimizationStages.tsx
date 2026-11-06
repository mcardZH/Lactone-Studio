import NumericInput from '../NumericInput';
import type {ReactNode} from 'react';
import {InputSettingsCard,InputSettingsField,InputSettingsRow} from '../InputSettingsFields';
import {InputSettingsAction} from '../InputSettingsLayout';
import {ADVANCED_METHODS,changeAdvancedMethod,type AdvancedMethodDraft} from './AdvancedMethodControls';
import {samplingRemainingLabel} from './sampling-time-estimate';

export interface ConformerOptimizationDraft {
  id:string;method:AdvancedMethodDraft;energyThresholdKcalMol:number;rmsdThresholdAngstrom:number;rmsdMatching?:'fixed'|'symmetry';inputStride?:number;inputClusterCount?:number;advanceCount?:number;checkpointAfter:boolean;
}
export interface ConformerOptimizationAction {
  kind:'start'|'continue';hasHistory:boolean;running?:boolean;stopping?:boolean;
  progress?:{total:number;completed:number;interrupted:number;failed:number;pending:number;succeeded?:number;discarded?:number;etaMs?:number|null};partialFrames?:number;
  interruptedFrames?:number;
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
  const validInputs=p.stages.every((stage,index)=>Number.isSafeInteger(stage.inputStride??1)&&(stage.inputStride??1)>0&&(!index||Number.isSafeInteger(stage.inputClusterCount??10)&&(stage.inputClusterCount??10)>0));
  return <div className="conformer-optimization-stages" data-testid="conformer-optimization-stages">
    {p.stages.map((stage,index)=>{const action=p.actionForStage?.(stage.id,index);return <InputSettingsCard key={stage.id} title={`第 ${index+1} 级优化`}>
      {index>0?(()=>{const upstream=p.upstreamForStage?.(index),count=Math.min(stage.inputClusterCount??10,upstream?.count??0),selected=upstream?.selectedCount??Math.ceil(count/(stage.inputStride??1));return <div className="conformer-stage-input-summary"><p role="status">输入：优化{index}归簇{upstream?.ready?` · 共 ${upstream.count} 簇`:` · ${upstream?.message??'等待上一级正式归簇'}`}</p>{upstream?.ready&&<p>先取最低能量的{count}簇 · 本级选取 {selected} 个代表</p>}</div>;})():p.samplingInputCount!==undefined&&<p role="status">输入：采样结果 · 可用 {p.samplingInputCount} 帧 · 本级选取 {Number.isSafeInteger(stage.inputStride??1)&&(stage.inputStride??1)>0?Math.ceil(p.samplingInputCount/(stage.inputStride??1)):'—'} 帧</p>}
      {action?.progress&&(()=>{const progress=action.progress,s=progress.succeeded??progress.completed,d=progress.discarded??progress.interrupted+progress.failed,n=progress.total,processed=Math.min(n,s+d);return <div className="conformer-stage-progress"><p role="status" aria-label={`第${index+1}级累计优化进度`}>已优化 {s}　合计 {n}　丢弃 {d}</p><div className="conformer-progress-row"><progress aria-label={`第${index+1}级优化处理进度`} max={Math.max(1,n)} value={processed}/><output>{n?Number((processed/n*100).toFixed(1)):0}%</output>{action.running&&<output>预计剩余 {progress.etaMs==null?'估算中':samplingRemainingLabel(progress.etaMs)}</output>}</div></div>;})()}
      <InputSettingsRow className="shared-input-row-compact conformer-stage-fields">
        <InputSettingsField label="优化方式" className="conformer-choice-field"><select aria-label={`第${index+1}级优化方式`} disabled={p.busy} value={stage.method.method} onChange={event=>update(index,{method:changeAdvancedMethod(stage.method,event.target.value as AdvancedMethodDraft['method'])})}>{ADVANCED_METHODS.map(([id,label])=><option key={id} value={id}>{label}{id==='gfn2'?'（推荐）':''}</option>)}</select></InputSettingsField>
        <InputSettingsField label="最大优化步数"><NumericInput aria-label={`第${index+1}级最大优化步数`} disabled={p.busy} min={1} step={1} value={stage.method.maxSteps} onChange={event=>update(index,{method:{...stage.method,maxSteps:event.currentTarget.valueAsNumber}})}/></InputSettingsField>
      </InputSettingsRow>
      <InputSettingsRow className="shared-input-row-compact conformer-stage-fields">
        {index>0&&<InputSettingsField label="选取上一级簇数"><NumericInput aria-label={`第${index+1}级选取上一级簇数`} disabled={p.busy} stepper min={1} step={1} value={stage.inputClusterCount??10} onChange={event=>update(index,{inputClusterCount:event.currentTarget.valueAsNumber})}/></InputSettingsField>}
        <InputSettingsField label="抽帧间隔"><NumericInput aria-label={`第${index+1}级抽帧间隔`} aria-invalid={!Number.isSafeInteger(stage.inputStride??1)||(stage.inputStride??1)<1||undefined} disabled={p.busy} stepper min={1} step={1} value={Number.isNaN(stage.inputStride)?'':stage.inputStride??1} onChange={event=>update(index,{inputStride:event.currentTarget.valueAsNumber})}/></InputSettingsField>
      </InputSettingsRow>
      <InputSettingsRow className="shared-input-row-compact conformer-stage-fields">
        <InputSettingsField label="归簇能量差 / kcal·mol⁻¹"><NumericInput aria-label={`第${index+1}级归簇能量差`} disabled={p.busy} min={0} step={.05} value={stage.energyThresholdKcalMol} onChange={event=>update(index,{energyThresholdKcalMol:event.currentTarget.valueAsNumber})}/></InputSettingsField>
        <InputSettingsField label="RMSD / Å"><NumericInput aria-label={`第${index+1}级归簇RMSD`} disabled={p.busy} min={.000001} step={.01} value={stage.rmsdThresholdAngstrom} onChange={event=>update(index,{rmsdThresholdAngstrom:event.currentTarget.valueAsNumber})}/></InputSettingsField>
      </InputSettingsRow>
      <InputSettingsRow className="shared-input-row-compact conformer-stage-fields">
        <InputSettingsField label="RMSD匹配" className="conformer-choice-field"><select aria-label={`第${index+1}级RMSD匹配`} disabled={p.busy} value={stage.rmsdMatching??'symmetry'} onChange={event=>update(index,{rmsdMatching:event.currentTarget.value as 'fixed'|'symmetry'})}><option value="symmetry">对称等价原子（推荐）</option><option value="fixed">固定原子对应</option></select></InputSettingsField>
      </InputSettingsRow>
      <InputSettingsRow><InputSettingsAction ariaLabel={`第${index+1}级${action?.kind==='continue'?'继续':'开始'}`} disabled={p.busy||!validInputs||!p.canStart(index)} onClick={()=>action?.kind==='continue'&&p.onContinue?p.onContinue(index):p.onStart(index)}>{action?.kind==='continue'?'继续优化':'开始优化'}</InputSettingsAction>{p.onPause&&<InputSettingsAction ariaLabel={`第${index+1}级暂停优化`} disabled={!action?.running||action.stopping} onClick={()=>p.onPause?.(index)}>{action?.stopping?'正在暂停':'暂停优化'}</InputSettingsAction>}{p.onRestart&&<InputSettingsAction ariaLabel={`第${index+1}级重新优化`} disabled={p.busy||!validInputs||!action?.hasHistory||!p.canStart(index)} onClick={()=>p.onRestart?.(index)}>重新优化</InputSettingsAction>}{p.stages.length>1&&<InputSettingsAction disabled={p.busy} onClick={()=>p.onChange(p.stages.filter((_,i)=>i!==index))}>移除此级</InputSettingsAction>}</InputSettingsRow>
    </InputSettingsCard>;})}
    <InputSettingsRow><InputSettingsAction disabled={p.busy||p.stages.length>=8} onClick={()=>{const previous=p.stages.at(-1);if(previous)p.onChange([...p.stages,{...previous,id:crypto.randomUUID(),method:{...previous.method}}]);}}>添加优化级</InputSettingsAction><InputSettingsAction variant="primary" disabled={p.busy||!validInputs||!p.canStart(0)} onClick={p.onRunAll}>{p.actionForStage?p.stages.some((stage,index)=>p.actionForStage?.(stage.id,index).kind==='continue')?'批量继续优化':'批量开始优化':'批量运行全部'}</InputSettingsAction>{p.onRestartAll&&<InputSettingsAction disabled={p.busy||!validInputs||!p.stages.some((stage,index)=>p.actionForStage?.(stage.id,index).hasHistory)||!p.canStart(0)} onClick={p.onRestartAll}>全部重新优化</InputSettingsAction>}</InputSettingsRow>
  </div>;
}
