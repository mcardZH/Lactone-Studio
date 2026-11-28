import {GxtbAvailability,useGxtbBackend,gxtbMethodLabel,gxtbRunBlocked} from '../results/GxtbPathControl';
import type {ReactNode} from 'react';
import {InputSettingsCard,InputSettingsField,InputSettingsNumericControl,InputSettingsRow,InputSettingsStack} from '../InputSettingsFields';
import {InputSettingsAction,InputSettingsCheckbox} from '../InputSettingsLayout';
import {CONFORMER_OPTIMIZATION_METHODS,type AdvancedMethodDraft} from './AdvancedMethodControls';
import {samplingRemainingLabel} from './sampling-time-estimate';
import ConformerSolventField from './ConformerSolventField';
import {conformerSolvationDraftIssue} from './conformer-solvation-draft';
import {ConformerMethodField} from './ConformerMethodFields';
import type {AdvancedStageRun,ConformerOptimizerAlgorithm} from '../../modeling/advanced/contracts';
import {DEFAULT_CONFORMER_CONVERGENCE,conformerOptimizerAvailable,defaultConformerOptimizer} from '../../modeling/advanced/conformer-shared-optimization';
import {isPesNetMethod,type PesNetMethod} from '../../modeling/pes/contracts';
import {periodicPesOperationAvailable} from '../../modeling/pes/periodic-capabilities';
import {conformerAlpbPresets} from '../../modeling/advanced/conformer-solvation';
import {resetConformerConvergence} from './conformer-draft-hydration';
import { ConvergenceField, CustomConvergenceFields, validConvergence } from '../modeling/XtbOptimizationPanel';
import { netMethods, ordinaryOptimizers, type OptimizationSettings } from '../modeling/tool-session';
import {validXtbResourceOverride,type NetGpuBatchLimit,type XtbResourceOverrides} from '../../modeling/resource-preferences';
import {XtbResourceOverrideField} from '../TaskResourceFields';

const optimizerLabels={ 'native-rf':'xTB 原生 RF',...ordinaryOptimizers };
const nativePresets={loose:'Loose',medium:'Normal',tight:'Tight'} as const;
export type ConformerStageMethodDraft=Omit<AdvancedMethodDraft,'maxSteps'|'method'>&Omit<OptimizationSettings,'optimizer'>&{
  optimizer?:ConformerOptimizerAlgorithm;
  method:AdvancedMethodDraft['method']|PesNetMethod; device?:'cpu'|'gpu'; retiredMethod?:string; sccIterationLimitExplicit?:boolean;
  netGpuBatchLimit?:NetGpuBatchLimit;
  resourceOverrides?:XtbResourceOverrides;
};
export interface ConformerOptimizationDraft {
  id:string;method:ConformerStageMethodDraft;energyThresholdKcalMol:number;rmsdThresholdAngstrom:number;rmsdMatching?:'fixed'|'symmetry';eliminateEquivalent?:boolean;inputStride?:number;inputClusterCount?:number;advanceCount?:number;checkpointAfter:boolean;
}
export interface ConformerOptimizationAction {
  kind:'start'|'continue';hasHistory:boolean;running?:boolean;stopping?:boolean;
  blockedByRetainedBatch?:boolean;
  adoptionErrorKind?:'read'|'integrity';
  cleanupWarning?:AdvancedStageRun['batchCleanupWarning'];
  diagnosticWarning?:NonNullable<AdvancedStageRun['batchProgress']>['diagnosticWarning'];
  progress?:{total:number;completed:number;interrupted:number;failed:number;pending:number;succeeded?:number;discarded?:number;etaMs?:number|null;actualGpuBatchWidth?:number};partialFrames?:number;
  interruptedFrames?:number;
  unconvergedCount?:number;
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
  allowSharedOptimizer?:boolean;periodic?:boolean;
  upstreamForStage?(index:number):{count:number;selectedCount?:number;ready:boolean;message?:string};
  samplingInputCount?:number;hasCoordinates?:boolean;
  onContinue?(index:number):void;onRestart?(index:number):void;onPause?(index:number):void;
  onRestartAll?():void;onViewResults?(index:number):void;onViewInterrupted?(index:number):void;
}){
 const gxtbBackend=useGxtbBackend();
  const periodic=p.periodic===true;
  const xtbMethods=CONFORMER_OPTIMIZATION_METHODS.filter(([id])=>!periodic||periodicPesOperationAvailable(id,'opt'))
    .map(([id,label])=>[id,id==='gxtb'?gxtbMethodLabel(gxtbBackend):label+(id==='gfn2'?'（推荐）':'')] as const);
  const update=(index:number,patch:Partial<ConformerOptimizationDraft>)=>p.onChange(p.stages.map((row,i)=>i===index?{...row,...patch}:row));
  const validInputs=p.stages.every((stage,index)=>{
    const count=index===0?stage.inputStride??1:stage.inputClusterCount??10;
    const method=stage.method.method,net=isPesNetMethod(method);
    return !stage.method.retiredMethod&&!net&&xtbMethods.some(([id])=>id===method)&&
      (periodic||conformerAlpbPresets(method).length===0||!conformerSolvationDraftIssue(method,stage.method))&&Number.isSafeInteger(count)&&count>0&&
      Number.isSafeInteger(stage.method.maxSteps??500)&&(stage.method.maxSteps??500)>0&&
      validXtbResourceOverride(stage.method.resourceOverrides?.xtbBatchParallelism)&&
      (!['gfn1','gfn2','gxtb'].includes(method)||Number.isSafeInteger(stage.method.sccIterationLimit)&&stage.method.sccIterationLimit>0)&&
      Number.isFinite(stage.energyThresholdKcalMol)&&stage.energyThresholdKcalMol>=0&&Number.isFinite(stage.rmsdThresholdAngstrom)&&stage.rmsdThresholdAngstrom>0;
  });
  const constraintsConfirmed=(stage:ConformerOptimizationDraft)=>!p.hasCoordinates||stage.method.internalConstraintsConfirmed;
  const optimizerFor=(method:ConformerStageMethodDraft)=>method.optimizer??defaultConformerOptimizer(method.method,periodic,method.convergencePreset);
  const stageReady=(stage:ConformerOptimizationDraft)=>constraintsConfirmed(stage)&&(p.allowSharedOptimizer===false
    ||conformerOptimizerAvailable(stage.method.method,periodic,optimizerFor(stage.method))&&
      (optimizerFor(stage.method)!=='native-rf'||stage.method.convergencePreset!=='custom')&&validConvergence({
      convergencePreset:stage.method.convergencePreset,convergenceLimits:stage.method.convergenceLimits}));
  const canRunAll=!p.stages.some(stage=>gxtbRunBlocked(gxtbBackend,stage.method.method))&&validInputs&&p.stages.every(stageReady)&&p.canStart(0);
  const addStage=()=>{
    const previous=p.stages.at(-1);
    if(!previous)return;
    const {inputStride:_inputStride,...next}=previous;
    const method=resetConformerConvergence(previous.method);
    const native=defaultConformerOptimizer(method.method,periodic)==='native-rf';
    p.onChange([...p.stages,{...next,id:crypto.randomUUID(),method:{...method,
      ...(p.allowSharedOptimizer!==false?{optimizer:native?undefined:previous.method.optimizer,...(native?{maxSteps:500}:{}),
        internalConstraintsConfirmed:(optimizerFor(previous.method)==='native-rf')===native&&method.internalConstraintsConfirmed}:{})},rmsdMatching:'fixed',eliminateEquivalent:false}]);
  };
  return <InputSettingsCard className="conformer-optimization-stages" testId="conformer-optimization-stages" title="优化与归簇" stack
    actions={<InputSettingsAction disabled={p.busy||p.stages.length>=8} onClick={addStage}>添加优化级</InputSettingsAction>}>
    {p.stages.map((stage,index)=>{const action=p.actionForStage?.(stage.id,index),net=isPesNetMethod(stage.method.method),optimizer=optimizerFor(stage.method),native=optimizer==='native-rf';
      const {convergencePreset,convergenceLimits}=stage.method;
      const convergence={convergencePreset:convergencePreset??DEFAULT_CONFORMER_CONVERGENCE,convergenceLimits};
      const updateOptimizer=(method:ConformerStageMethodDraft['method'],nextOptimizer:ConformerOptimizerAlgorithm)=>{
        const changeKind=native!==(nextOptimizer==='native-rf');
        const next=nextOptimizer==='native-rf'&&convergencePreset==='custom'?resetConformerConvergence(stage.method):stage.method;
        update(index,{method:{...next,method,retiredMethod:undefined,optimizer:nextOptimizer,
          internalConstraintsConfirmed:!changeKind&&stage.method.internalConstraintsConfirmed}});
      };
      return <InputSettingsCard key={stage.id} sectionKey={`conformer-stage:${stage.id}`} level="subcard" collapsible stack title={`第 ${index+1} 级优化`}
      actions={p.stages.length>1&&<InputSettingsAction disabled={p.busy} onClick={()=>p.onChange(p.stages.filter((_,i)=>i!==index))}>移除此级</InputSettingsAction>}>
      {index>0?(()=>{const upstream=p.upstreamForStage?.(index),count=Math.min(stage.inputClusterCount??10,upstream?.count??0);return <InputSettingsStack className="conformer-stage-input-summary"><p role="status">输入：优化{index}归簇{upstream?.ready?` · 共 ${upstream.count} 簇`:` · ${upstream?.message??'等待上一级正式归簇'}`}</p>{upstream?.ready&&<p>本级选取 {upstream.selectedCount??count} 个最低能量代表</p>}</InputSettingsStack>;})():p.samplingInputCount!==undefined&&<p role="status">输入：采样结果 · 可用 {p.samplingInputCount} 帧 · 本级选取 {Number.isSafeInteger(stage.inputStride??1)&&(stage.inputStride??1)>0?Math.ceil(p.samplingInputCount/(stage.inputStride??1)):'—'} 帧</p>}
      {action?<ConformerOptimizationProgress action={action} index={index} method={stage.method.method}/>:p.progressForStage?.(stage.id,index)}
      {action?.error}
      {index>0&&<InputSettingsRow className="conformer-stage-fields">
        <InputSettingsField label="取上一级正式簇中最低能量的代表数" controlWidth="short"><InputSettingsNumericControl ariaLabel={`第${index+1}级选取上一级簇数`} disabled={p.busy} min={1} step={1} integer value={stage.inputClusterCount??10} onValue={inputClusterCount=>update(index,{inputClusterCount})}/></InputSettingsField>
      </InputSettingsRow>}
      <GxtbAvailability method={stage.method.method}/>
      <InputSettingsRow className="conformer-stage-fields">
        <ConformerMethodField method={stage.method.retiredMethod?'retired':stage.method.method} ariaLabel={`第${index+1}级优化方式`} xtb={xtbMethods} disabled={p.busy}
          retainedLabel={stage.method.retiredMethod?`${stage.method.retiredMethod}（已停用，重新选择）`:undefined} onChange={id=>{
            const method=id as ConformerStageMethodDraft['method'];
            updateOptimizer(method,stage.method.optimizer&&conformerOptimizerAvailable(method,periodic,optimizer)?optimizer:defaultConformerOptimizer(method,periodic,convergencePreset));
          }}/>
          {!net&&!periodic&&conformerAlpbPresets(stage.method.method).length>0&&<ConformerSolventField method={stage.method.method} value={stage.method} onChange={value=>update(index,{method:{...stage.method,...value}})} ariaLabel={`第${index+1}级溶剂`} disabled={p.busy}/>}
      </InputSettingsRow>
      {index===0&&<InputSettingsRow className="conformer-stage-fields">
        <InputSettingsField label="抽帧间隔" controlWidth="short"><InputSettingsNumericControl ariaLabel="第1级抽帧间隔" disabled={p.busy} min={1} step={1} integer value={stage.inputStride??1} onValue={inputStride=>update(index,{inputStride})}/></InputSettingsField>
      </InputSettingsRow>}
      <InputSettingsRow className="conformer-stage-fields conformer-clustering-row">
        {!periodic&&<InputSettingsCheckbox label="消除等价构象" ariaLabel={`第${index+1}级消除等价构象`} disabled={p.busy} checked={stage.eliminateEquivalent===true} onChange={eliminateEquivalent=>update(index,{eliminateEquivalent,rmsdMatching:'fixed'})}/>}
        <InputSettingsField label="归簇能量差" unit="kcal·mol⁻¹" controlWidth="short"><InputSettingsNumericControl ariaLabel={`第${index+1}级归簇能量差`} disabled={p.busy} min={0} value={stage.energyThresholdKcalMol} onValue={energyThresholdKcalMol=>update(index,{energyThresholdKcalMol})}/></InputSettingsField>
        <InputSettingsField label="RMSD" unit="Å" controlWidth="number"><InputSettingsNumericControl ariaLabel={`第${index+1}级归簇RMSD`} disabled={p.busy} min={.000001} value={stage.rmsdThresholdAngstrom} onValue={rmsdThresholdAngstrom=>update(index,{rmsdThresholdAngstrom})}/></InputSettingsField>
      </InputSettingsRow>
      {periodic&&<output>晶胞固定 · RMSD 只计算非冻结原子</output>}
      {!periodic&&stage.eliminateEquivalent===true&&<div className="conformer-equivalence-description"><p>簇代表能量差 &lt; 0.03 kcal/mol</p><p>快速判定，未确认等价的构象保留</p></div>}
      {p.hasCoordinates&&<InputSettingsCheckbox label={p.allowSharedOptimizer===false?'确认使用当前 B/A/D 冻结':native?'确认使用当前 B/A/D 目标及 xTB 原生约束势（K20）':'确认使用当前精确 B/A/D 冻结'} disabled={p.busy} checked={stage.method.internalConstraintsConfirmed} onChange={internalConstraintsConfirmed=>update(index,{method:{...stage.method,internalConstraintsConfirmed}})}/>}
      {native&&p.allowSharedOptimizer!==false&&p.hasCoordinates&&<p className="muted-note">B/A/D 使用力常数 20 的原生约束势，并记录实际值和残差。XYZ 冻结使用原生固定原子。</p>}
      {!net&&p.allowSharedOptimizer!==false&&<details className="xtb-constraint-results xtb-run-settings">
        <summary>运行设置 · {optimizerLabels[optimizer]}</summary>
        <InputSettingsRow>
          <InputSettingsField label="优化算法" controlWidth="select"><select aria-label={`第${index+1}级优化算法`} disabled={p.busy} value={optimizer} onChange={event=>updateOptimizer(stage.method.method,event.currentTarget.value as ConformerOptimizerAlgorithm)}>
            {Object.entries(optimizerLabels).filter(([id])=>id===optimizer||conformerOptimizerAvailable(stage.method.method,periodic,id as ConformerOptimizerAlgorithm)).map(([id,label])=><option key={id} value={id} disabled={!conformerOptimizerAvailable(stage.method.method,periodic,id as ConformerOptimizerAlgorithm)}>{label}</option>)}
          </select></InputSettingsField>
          {native?<InputSettingsField label="收敛限度" controlWidth="select"><select aria-label="收敛限度" value={convergence.convergencePreset}
            disabled={p.busy} onChange={event=>update(index,{method:{...stage.method,convergencePreset:event.currentTarget.value as keyof typeof nativePresets,convergenceLimits:undefined}})}>
            {Object.entries(nativePresets).map(([value,label])=><option key={value} value={value}>{label}</option>)}
          </select></InputSettingsField>:<ConvergenceField settings={convergence} disabled={p.busy} onChange={({convergencePreset,convergenceLimits})=>update(index,{method:{...stage.method,convergencePreset,convergenceLimits}})}/>}
          <InputSettingsAction reset disabled={p.busy} ariaLabel={`恢复第${index+1}级默认收敛限度`}
            onClick={()=>update(index,{method:resetConformerConvergence(stage.method)})}>恢复默认</InputSettingsAction>
          <InputSettingsField label="最大优化步数" controlWidth="short"><InputSettingsNumericControl ariaLabel={`第${index+1}级最大优化步数`} disabled={p.busy} min={1} integer value={stage.method.maxSteps??500} onValue={maxSteps=>update(index,{method:{...stage.method,maxSteps}})}/></InputSettingsField>
          {!net&&<XtbResourceOverrideField label="xTB 批量并行数" ariaLabel={`第${index+1}级 xTB 批量并行数`}
            disabled={p.busy} value={stage.method.resourceOverrides?.xtbBatchParallelism} onChange={xtbBatchParallelism=>
              update(index,{method:{...stage.method,resourceOverrides:xtbBatchParallelism===undefined?undefined:{xtbBatchParallelism}}})}/>}
          {!net&&['gfn1','gfn2','gxtb'].includes(stage.method.method)&&<InputSettingsField label="SCC 迭代上限" controlWidth="short"><InputSettingsNumericControl ariaLabel={`第${index+1}级 SCC 迭代上限`} disabled={p.busy} min={1} integer value={stage.method.sccIterationLimit} onValue={sccIterationLimit=>update(index,{method:{...stage.method,sccIterationLimit,sccIterationLimitExplicit:true}})}/></InputSettingsField>}
        </InputSettingsRow>
        {!native&&<CustomConvergenceFields settings={convergence} disabled={p.busy} onChange={({convergencePreset,convergenceLimits})=>update(index,{method:{...stage.method,convergencePreset:convergencePreset??stage.method.convergencePreset,convergenceLimits}})}/>}
      </details>}
      <InputSettingsRow variant="actions"><InputSettingsAction variant="primary" ariaLabel={`第${index+1}级${action?.kind==='continue'?'继续':'开始'}`} disabled={gxtbRunBlocked(gxtbBackend,stage.method.method)||p.busy||action?.blockedByRetainedBatch||!validInputs||!stageReady(stage)||!p.canStart(index)} onClick={()=>action?.kind==='continue'&&p.onContinue?p.onContinue(index):p.onStart(index)}>{action?.kind==='continue'?'继续优化':'开始优化'}</InputSettingsAction>{p.onPause&&<InputSettingsAction ariaLabel={`第${index+1}级暂停优化`} disabled={!action?.running||action.stopping} onClick={()=>p.onPause?.(index)}>{action?.stopping?'正在暂停':'暂停优化'}</InputSettingsAction>}{p.onRestart&&<InputSettingsAction ariaLabel={`第${index+1}级重新优化`} disabled={gxtbRunBlocked(gxtbBackend,stage.method.method)||p.busy||!validInputs||!stageReady(stage)||!action?.hasHistory||!p.canStart(index)} onClick={()=>p.onRestart?.(index)}>重新优化</InputSettingsAction>}</InputSettingsRow>
    </InputSettingsCard>;})}
    <InputSettingsRow variant="actions"><InputSettingsAction variant="primary" disabled={p.busy||!canRunAll||p.stages.some((stage,index)=>p.actionForStage?.(stage.id,index).blockedByRetainedBatch)} onClick={p.onRunAll}>{p.actionForStage?p.stages.some((stage,index)=>p.actionForStage?.(stage.id,index).kind==='continue')?'批量继续优化':'批量开始优化':'批量运行全部'}</InputSettingsAction>{p.onRestartAll&&<InputSettingsAction disabled={p.busy||!canRunAll||!p.stages.some((stage,index)=>p.actionForStage?.(stage.id,index).hasHistory)} onClick={p.onRestartAll}>全部重新优化</InputSettingsAction>}</InputSettingsRow>
  </InputSettingsCard>;
}

/** Exactly one progress surface per level; a completed optimizer is not a completed workflow. */
export function ConformerOptimizationProgress({action,index,method}:{action:ConformerOptimizationAction;index:number;method:string}){
  const progress=action.progress,background=action.backgroundProgress,phase=action.phase??'optimization';
  if(!progress&&!action.running&&action.finalClusterCount===undefined&&!action.cleanupWarning&&!action.diagnosticWarning)return null;
  const succeeded=progress?.succeeded??progress?.completed??0,discarded=progress?.discarded??((progress?.interrupted??0)+(progress?.failed??0));
  const unconverged=action.unconvergedCount??0,discardedText=unconverged?`未收敛 ${unconverged} · 丢弃 ${Math.max(0,discarded-unconverged)}`:`丢弃 ${discarded}`;
  const methodLabel=isPesNetMethod(method)?netMethods[method]:CONFORMER_OPTIMIZATION_METHODS.find(([id])=>id===method)?.[1]??method;
  const phaseLabel=phase==='cluster'?'常规归簇':phase==='eliminate-equivalent'?'消除等价构象':phase==='prepare-results'?'准备结果':`${methodLabel} 优化`;
  const total=phase==='optimization'?progress?.total:background?.total;
  const processed=phase==='optimization'?succeeded+discarded:background?.completed??0;
  const determinate=typeof total==='number'&&Number.isFinite(total)&&total>0&&Number.isFinite(processed)&&processed>=0&&processed<=total;
  const eta=phase==='optimization'?progress?.etaMs:background?.etaMs;
  const prefix=action.stopping?'停止中':action.status==='queued'?'排队中':'运行中';
  const terminal=action.blockedByRetainedBatch?(action.adoptionErrorKind==='integrity'?'结果校验未通过':'结果待载入'):action.status==='failed'?'失败':action.status==='stopped'?'已停止':action.status==='completed'||action.finalClusterCount!==undefined?'完成':'待继续';
  return <div className="conformer-stage-progress" data-testid={`conformer-stage-progress-${index+1}`}>
    {action.running?<><p role="status">{prefix}：第 {index+1} 级 · {phaseLabel}</p>
      <div className="conformer-progress-row"><progress aria-label={`第${index+1}级${phaseLabel}进度`} max={determinate?total!:undefined} value={determinate?processed:undefined}/>
        {phase==='optimization'&&progress&&<output>已处理 {processed}/{progress.total} · 成功 {succeeded} · {discardedText}</output>}
        {phase==='optimization'&&progress?.actualGpuBatchWidth!==undefined&&<output>GPU 批宽 {progress.actualGpuBatchWidth}</output>}
        {determinate&&<output>{Number((processed/total!*100).toFixed(1))}%</output>}
        <output>预计剩余 {eta==null||!Number.isFinite(eta)?'估算中':samplingRemainingLabel(eta)}</output></div></>:
      <><p role="status">{terminal}：成功 {succeeded} · {discardedText}{action.blockedByRetainedBatch&&progress?<> · 待处理 {progress.pending}</>:null}</p>
        {action.equivalence?<><p>常规归簇 {action.equivalence.ordinaryClusterCount} → 最终 {action.equivalence.finalClusterCount} 簇</p>{action.equivalence.eligiblePairCount===0&&<p>无符合能量条件的簇对</p>}{action.equivalence.unresolvedClusterCount>0&&<p>保留待判定 {action.equivalence.unresolvedClusterCount} 簇</p>}</>:action.finalClusterCount!==undefined&&<p>最终 {action.finalClusterCount} 簇</p>}</>}
    {action.cleanupWarning&&<details className="conformer-stage-warning" style={{display:'inline-block'}} data-testid="conformer-batch-cleanup-warning"><summary aria-label="后台文件清理警告" style={{listStyle:'none',color:'#946b00'}}>⚠</summary><p>结果已接收，可继续使用；后台文件清理未完成。</p><pre>{action.cleanupWarning.message}</pre></details>}
    {action.diagnosticWarning&&<details className="conformer-stage-warning" data-testid="conformer-batch-diagnostic-warning">
      <summary>恢复资料保存警告</summary>
      {action.diagnosticWarning.index!==undefined&&<p>第 {action.diagnosticWarning.index+1} 个候选</p>}
      <pre>{action.diagnosticWarning.message}</pre>
    </details>}
  </div>;
}
