import {DismissibleNotice} from '../DismissibleNotice';
import {GxtbAvailability,useGxtbBackend,gxtbMethodLabel,gxtbRunBlocked} from '../results/GxtbPathControl';
import NumericInput from '../NumericInput';
import ElectronicStateWarning from '../ElectronicStateWarning';
import {electronicStateIntegerInput} from '../BaseElectronicStateFields';
import ConformerSolventField from '../advanced/ConformerSolventField';
import {InputSettingsField} from '../InputSettingsFields';
import {InputSettingsLayout} from '../InputSettingsLayout';
import { useRef, type ReactNode } from 'react';
import type { XtbMetadata, XtbOptimizationScope } from '../../modeling/xtb/contracts';
import { XTB_METHOD_IDS, XTB_METHOD_LABELS, usesXtbSccIterations, xtbSolvents, type XtbNativeMethod } from '../../core/xtb-capabilities';

import { XTB_INTERNAL_CONSTRAINT_POLICY, xtbPreoptimizationSolvationIssue, type XtbPreoptimizationSolvation } from '../../modeling/xtb/accept-result';
import {OPT_CONVERGENCE_PRESETS} from '../../modeling/pes/defaults';
import {isPesNetMethod,isPesTrainedStateNetMethod} from '../../modeling/pes/contracts';
import {validXtbResourceOverride,type XtbResourceOverrides} from '../../modeling/resource-preferences';
import {XtbResourceOverrideField} from '../TaskResourceFields';
import {availableOrdinaryOptimizer,netMethods,ordinaryOptimizers,ORDINARY_OPTIMIZATION_DEFAULT_MAX_STEPS,ORDINARY_OPTIMIZATION_DEFAULT_OPTIMIZER,resolveOrdinaryOptimizer,validCustomOptimizationLimits,workspaceOptimizationMethodAvailable,type GeometryLimits,type OptimizationSettings,type OrdinaryOptimizer} from './tool-session';
import './xtb-optimization.css';

export { xtbPreoptimizationSolvationIssue };
export type XtbPanelMethod = XtbNativeMethod|'mcgfnff';

export interface XtbPanelOptions extends OptimizationSettings {
  method: XtbPanelMethod;
  charge: number;
  /** GFN-FF retains this form value but does not consume spin. */
  multiplicity: number;
  rebuildBonds: boolean;
  threads?: number;
  resourceOverrides?: Pick<XtbResourceOverrides,'xtbSingleTaskThreads'>;
  maxSccIterations?:number;
  scope?:XtbOptimizationScope;
  solvation?:XtbPreoptimizationSolvation;
}
export interface OrdinaryRunSettings extends OptimizationSettings {
  maxSccIterations?: number;
}
interface XtbOptimizationPanelProps extends Pick<XtbChargeMultiplicityProps,'charge'|'multiplicity'|'electronicRawText'|
  'onElectronicRawTextChange'|'onElectronicRawTextCommit'|'electronicDisabled'|'electronicWarning'|'onElectronicStateChange'> {
  documentKey: string;
  method: string;
  onMethodChange(method:string): void;
  scope: XtbOptimizationScope;
  onScopeChange(scope:XtbOptimizationScope): void;
  solvation?: XtbPreoptimizationSolvation;
  onSolvationChange(solvation:XtbPreoptimizationSolvation|undefined): void;
  rebuildBonds: boolean;
  onRebuildBondsChange(rebuild:boolean): void;
  runtimeSettings: OrdinaryRunSettings;
  onRuntimeSettingsChange(settings:OrdinaryRunSettings): void;
  xtbSingleTaskThreads?: number;
  onXtbSingleTaskThreadsChange?(threads:number|undefined): void;
  selectionCount: number;
  atomCount: number;
  requireMultiplicity?: boolean;
  periodic: boolean;
  disabled: boolean;
  running: boolean;
  canOptimize: boolean;
  status?: string;
  error?: string;
  outcomeIdentity?: string;
  metadata?: XtbMetadata | null;
  ordinaryEvidence?: ReactNode;
  atomLabels?: Readonly<Record<string, string | number>>;
  onOptimize(): void | Promise<void>;
  onStop(): void | Promise<void>;
  footer?: ReactNode;
}
const shown = (value: number | undefined) => value!==undefined&&Number.isFinite(value) ? value : '';
const edited = (value: string) => value.trim() ? Number(value) : Number.NaN;

interface XtbChargeMultiplicityProps {
  prefix:string; charge:number; multiplicity:number; method:string; disabled?:boolean; requireMultiplicity?:boolean;
  multiplicityLabel?:string;
  electronicRawText?:{charge:string;multiplicity:string};
  onElectronicRawTextChange?(field:'charge'|'multiplicity',text:string):void;
  onElectronicRawTextCommit?(field:'charge'|'multiplicity',text:string):void;
  electronicDisabled?:boolean;
  electronicWarning?:string|null;
  onElectronicStateChange(value:{charge:number;multiplicity:number}):void;
}
interface XtbSolvationProps {
  prefix:string; method:string; periodic:boolean; solvation?:XtbPreoptimizationSolvation; disabled?:boolean;
  onSolvationChange(value:XtbPreoptimizationSolvation|undefined):void;
}

export function XtbChargeMultiplicityFields({prefix, charge, multiplicity, method, disabled, requireMultiplicity=false,
  multiplicityLabel='多重度', onElectronicStateChange,electronicRawText,onElectronicRawTextChange,onElectronicRawTextCommit,electronicDisabled,electronicWarning}: XtbChargeMultiplicityProps) {
  const unusedSpin=method==='gfnff'&&!requireMultiplicity;
  const fieldDisabled=electronicDisabled??disabled;
  return <>
    <InputSettingsField label="电荷" controlWidth="short">
      {electronicRawText?electronicStateIntegerInput({text:electronicRawText.charge,field:'charge',label:`${prefix}电荷`,disabled:fieldDisabled,onChange:text=>onElectronicRawTextChange?.('charge',text),onCommit:text=>onElectronicRawTextCommit?.('charge',text)}):<NumericInput aria-label={`${prefix}电荷`} stepper step="1" value={shown(charge)} disabled={fieldDisabled}
        onChange={event=>onElectronicStateChange({charge:edited(event.target.value),multiplicity})}/>}
    </InputSettingsField>
    <InputSettingsField label={multiplicityLabel} controlWidth="short">
      {electronicRawText?electronicStateIntegerInput({text:electronicRawText.multiplicity,field:'multiplicity',label:`${prefix}多重度`,disabled:fieldDisabled,onChange:text=>onElectronicRawTextChange?.('multiplicity',text),onCommit:text=>onElectronicRawTextCommit?.('multiplicity',text)}):<NumericInput aria-label={`${prefix}多重度`} title={unusedSpin?'GFN-FF不使用自旋多重度；保留输入值':undefined}
        stepper step="1" min="1" value={shown(multiplicity)} disabled={fieldDisabled}
        onChange={event=>onElectronicStateChange({charge,multiplicity:edited(event.target.value)})}/>}
    </InputSettingsField>
    <ElectronicStateWarning message={electronicWarning}/>
  </>;
}

export function XtbSolvationField({prefix, method, periodic, solvation, disabled, onSolvationChange}: XtbSolvationProps) {
  if(periodic&&!solvation)return null;
  const issue=solvation&&(!XTB_METHOD_IDS.includes(method as XtbNativeMethod)||xtbPreoptimizationSolvationIssue(method as XtbNativeMethod,solvation,periodic))?'当前方法或周期条件不支持所选溶剂，请明确选择气相或有效介质。':undefined;
  return <ConformerSolventField method={periodic?'periodic':method} ariaLabel={`${prefix}溶剂`} disabled={disabled}
    value={solvation?{solvationModel:solvation.model,solvent:solvation.solvent}:{solvationModel:'none',solvent:''}} validationIssue={issue}
    onChange={value=>onSolvationChange(value.solvationModel==='alpb'?{model:'alpb',solvent:value.solvent}:undefined)}/>;
}

export function XtbElectronicFields(props: XtbChargeMultiplicityProps & XtbSolvationProps) {
  return <InputSettingsLayout className="xtb-electronic-fields">
    <div className="model-electronic-pair"><XtbChargeMultiplicityFields {...props}/></div>
    <XtbSolvationField {...props}/>
  </InputSettingsLayout>;
}

export function xtbPanelSubmission(draft: XtbPanelOptions,periodic=false): XtbPanelOptions | null {
  if(!supportsXtbPanelOptimization(draft.method,periodic,draft.optimizer))return null;
  if (!Number.isSafeInteger(draft.charge) || draft.method !== 'gfnff' && (!Number.isSafeInteger(draft.multiplicity) || draft.multiplicity < 1)) return null;
  if (draft.method!=='mcgfnff'&&xtbPreoptimizationSolvationIssue(draft.method,draft.solvation,periodic)) return null;
  if (!validConvergence(draft))return null;
  const xtbSingleTaskThreads=draft.resourceOverrides?.xtbSingleTaskThreads;
  if(!validXtbResourceOverride(xtbSingleTaskThreads))return null;
  const maxSccIterations=validStepSetting(draft.maxSccIterations)?draft.maxSccIterations??250:250;if(usesScc(draft.method)&&!validStepSetting(draft.maxSccIterations))return null;
  const maxSteps=draft.maxSteps??ORDINARY_OPTIMIZATION_DEFAULT_MAX_STEPS;if(!Number.isSafeInteger(maxSteps)||maxSteps<1)return null;
  const scope=draft.scope??'all';if(!['all','selection','unselected'].includes(scope))return null;
  return { method:draft.method, charge:draft.charge, multiplicity:draft.multiplicity, rebuildBonds:draft.rebuildBonds,scope,maxSteps,
    ...(xtbSingleTaskThreads===undefined?{}:{resourceOverrides:{xtbSingleTaskThreads}}),
    ...(usesScc(draft.method)?{maxSccIterations}:{}),
    ...(draft.optimizer?{optimizer:draft.optimizer}:{}),...(draft.convergencePreset?{convergencePreset:draft.convergencePreset}:{}),...(draft.convergenceLimits?{convergenceLimits:draft.convergenceLimits}:{}),
    ...(draft.method!=='mcgfnff'&&draft.solvation?{solvation:{...draft.solvation}}:{}) };
}

export const defaultGeometryLimits: GeometryLimits=OPT_CONVERGENCE_PRESETS.loose;
const limitLabels:Record<keyof GeometryLimits,string>={energyDifferenceHartree:'能量差 (Eh)',gradientNormHartreePerBohr:'梯度范数 (Eh/Bohr)'};
export function validConvergence(settings:OptimizationSettings):boolean {
  return settings.convergencePreset!=='custom'||validCustomOptimizationLimits(settings.convergenceLimits);
}
export function OptimizerField({value,disabled,onChange,available}:{value:OrdinaryOptimizer;disabled?:boolean;onChange(value:OrdinaryOptimizer):void;available?:(value:OrdinaryOptimizer)=>boolean}){
  return <label><span>优化算法</span><select aria-label="优化算法" value={value} disabled={disabled} onChange={event=>onChange(event.target.value as OrdinaryOptimizer)}>{Object.entries(ordinaryOptimizers).filter(([key])=>key===value||!available||available(key as OrdinaryOptimizer)).map(([key,label])=><option key={key} value={key} disabled={available&&!available(key as OrdinaryOptimizer)}>{label}</option>)}</select></label>;
}
export function ConvergenceField({settings,disabled,onChange}:{settings:OptimizationSettings;disabled?:boolean;onChange(value:OptimizationSettings):void}){
  return <label><span>收敛限度</span><select aria-label="收敛限度" value={settings.convergencePreset??'loose'} disabled={disabled} onChange={event=>{const convergencePreset=event.target.value as OptimizationSettings['convergencePreset'];onChange({convergencePreset,...(convergencePreset==='custom'?{convergenceLimits:settings.convergencePreset==='custom'?settings.convergenceLimits??defaultGeometryLimits:OPT_CONVERGENCE_PRESETS[settings.convergencePreset??'loose']}:{})});}}><option value="loose">Loose</option><option value="medium">Normal</option><option value="tight">Tight</option><option value="custom">自定义</option></select></label>;
}
export function CustomConvergenceFields({settings,disabled,onChange}:{settings:OptimizationSettings;disabled?:boolean;onChange(value:OptimizationSettings):void}){
  if(settings.convergencePreset!=='custom')return null;
  const limits=settings.convergenceLimits??defaultGeometryLimits;
  return <div className="xtb-run-settings-fields">{Object.entries(limitLabels).map(([field,label])=><label key={field}><span>{label}</span><NumericInput aria-label={label} value={Number.isFinite(limits[field as keyof GeometryLimits])?limits[field as keyof GeometryLimits]:''} step="any" min="0" disabled={disabled} onChange={event=>onChange({convergenceLimits:{...limits,[field]:Number(event.target.value)}})}/></label>)}</div>;
}

export function OrdinaryConstraintDetails({rows}:{rows:readonly {id:string;type:string;target:number;residual:number;atoms:string}[]}){
  if(!rows.length)return null;
  const format=(value:number)=>Number(value.toPrecision(8)).toString();
  return <details className="xtb-constraint-results"><summary>精确 B/A/D 冻结（{rows.length}）</summary><div className="xtb-constraint-table-scroll">
    <table aria-label="精确内坐标冻结目标与残差"><thead><tr><th scope="col">类型</th><th scope="col">原子</th><th scope="col">目标</th><th scope="col">实际</th><th scope="col">残差</th></tr></thead><tbody>{rows.map(row=>{
      const unit=row.type==='B'?'Å':'°';
      return <tr key={row.id}><th scope="row">{row.type}</th><td>{row.atoms}</td><td>{format(row.target)} {unit}</td><td>{format(row.target+row.residual)} {unit}</td><td>{format(row.residual)} {unit}</td></tr>;
    })}</tbody></table>
  </div></details>;
}

export function ordinaryRunSettingsValid(method:string,settings:OrdinaryRunSettings):boolean {
  return validStepSetting(settings.maxSteps)&&(!usesScc(method)||validStepSetting(settings.maxSccIterations))&&validConvergence(settings);
}

export default function XtbOptimizationPanel(props:XtbOptimizationPanelProps) {
  const {method, scope, periodic, disabled, running, canOptimize, status, error, metadata, runtimeSettings:settings}=props;
  const trainedState=isPesTrainedStateNetMethod(method);
  const optimizer=resolveOrdinaryOptimizer(method,periodic,settings.optimizer);
  const backend=useGxtbBackend();
  const root=useRef<HTMLElement>(null);
  const inactive=()=>disabled||Boolean(root.current?.closest('[hidden], [aria-hidden="true"]'));
  const block=disabled||running;
  const methods=XTB_METHOD_IDS.filter(value=>workspaceOptimizationMethodAvailable(value,periodic));
  const methodAvailable=workspaceOptimizationMethodAvailable(method,periodic);
  const hasScc=usesScc(method);
  const submissionBlocked=block||!canOptimize||!methodAvailable||gxtbRunBlocked(backend,method);
  const finiteNumber=(value:number)=>Number.isFinite(value)?String(Number(value.toPrecision(12))):'未知';
  return <section ref={root} className="model-simulation-card xtb-optimization-panel" aria-label="预优化" data-testid="preoptimization-panel" data-running={running}>
    <header className="optimization-panel-header model-simulation-heading"><strong>预优化</strong></header>
    <div className="optimization-primary-row">
      <label className="xtb-optimization-method"><span>方法</span><select aria-label="预优化方法" value={method} disabled={block} onChange={event=>props.onMethodChange(event.target.value)}>
        <optgroup label="xTB">{methods.map(value=><option key={value} value={value}>{value==='gxtb'?gxtbMethodLabel(backend):XTB_METHOD_LABELS[value]}</option>)}</optgroup>
        {!methodAvailable&&<option value={method} disabled>{netMethods[method as keyof typeof netMethods]??method}（请改选可用方法）</option>}
      </select></label>
      <label><span>范围</span><select aria-label="预优化范围" value={scope} disabled={block}
        onChange={event=>props.onScopeChange(event.target.value as XtbOptimizationScope)}>
        <option value="all">全体</option><option value="selection" disabled={props.selectionCount===0}>选区</option>
        <option value="unselected" disabled={props.selectionCount===props.atomCount}>非选区</option>
      </select></label>
      <div className="model-simulation-actions">
        <button type="button" disabled={submissionBlocked} onClick={()=>{if(!inactive()&&!submissionBlocked)void props.onOptimize();}}>优化</button>
        <button type="button" className="optimization-stop" disabled={disabled||!running} onClick={()=>{if(!inactive()&&running)void props.onStop();}}>停止</button>
      </div>
    </div>
    <GxtbAvailability method={method}/>
    <InputSettingsLayout className="xtb-electronic-fields">
      <div className="model-electronic-pair"><XtbChargeMultiplicityFields {...props} prefix="预优化" disabled={block} multiplicityLabel="自旋多重度"
        electronicWarning={trainedState?undefined:props.electronicWarning}/></div>
      {xtbSolvents(method,'alpb',periodic).length>0&&<XtbSolvationField prefix="预优化" method={method} periodic={periodic}
        solvation={props.solvation} disabled={block} onSolvationChange={props.onSolvationChange}/>}
    </InputSettingsLayout>
    {trainedState&&<small className="muted-note">模型使用训练态，电荷和多重度用于记录结构来源。</small>}
    <div className="xtb-optimization-actions">
      <label className="xtb-rebuild-bonds" title={method==='gfn2'?'优化正常结束后优先使用最后有效帧的 MBO 更新成键':'优化收敛后用最后有效帧的坐标按经验距离更新'}>
        <input type="checkbox" aria-label="优化后更新成键" checked={props.rebuildBonds} disabled={block||!methodAvailable} onChange={event=>props.onRebuildBondsChange(event.target.checked)}/>
        <span>优化后更新成键</span>
      </label>
      {error?<DismissibleNotice identity={`${props.documentKey}:${props.outcomeIdentity??method}:${error}`} className="xtb-optimization-error">
        {error}
      </DismissibleNotice>:status&&<p className="xtb-optimization-status" role="status">{status}</p>}
    </div>
    {metadata?.trajectoryWarning&&<details className="xtb-constraint-results"><summary aria-label="轨迹提示" title="轨迹提示">⚠</summary>
      <DismissibleNotice identity={`${props.documentKey}:${metadata.trajectoryWarning.code}`}>{metadata.trajectoryWarning.message}</DismissibleNotice>
    </details>}
    <details className="xtb-constraint-results xtb-run-settings"><summary>运行设置 · {ordinaryOptimizers[optimizer]}</summary>
      <div className="xtb-run-settings-fields">
        <OptimizerField value={optimizer} disabled={block||!methodAvailable} available={value=>availableOrdinaryOptimizer(method,periodic,value)} onChange={optimizer=>props.onRuntimeSettingsChange({optimizer})}/>
      </div>
      <div className="xtb-run-settings-fields optimization-limit-row">
        <ConvergenceField settings={settings} disabled={block||!methodAvailable} onChange={props.onRuntimeSettingsChange}/>
        <label><span>最大优化步数</span><NumericInput aria-label="最大优化步数" aria-invalid={!validStepSetting(settings.maxSteps)||undefined}
          min="1" step="1" stepper value={shown(settings.maxSteps??ORDINARY_OPTIMIZATION_DEFAULT_MAX_STEPS)} disabled={block||!methodAvailable} onChange={event=>props.onRuntimeSettingsChange({maxSteps:edited(event.target.value)})}/></label>
        {!isPesNetMethod(method)&&props.onXtbSingleTaskThreadsChange&&<XtbResourceOverrideField label="本任务 xTB 线程"
          disabled={block||!methodAvailable} value={props.xtbSingleTaskThreads} onChange={props.onXtbSingleTaskThreadsChange}/>}
        {hasScc&&<label><span>SCC迭代上限</span><NumericInput aria-label="SCC迭代上限" aria-invalid={!validStepSetting(settings.maxSccIterations)||undefined}
          min="1" step="1" stepper value={shown(settings.maxSccIterations??250)} disabled={block} onChange={event=>props.onRuntimeSettingsChange({maxSccIterations:edited(event.target.value)})}/></label>}
      </div>
      <CustomConvergenceFields settings={settings} disabled={block} onChange={props.onRuntimeSettingsChange}/>
      {!ordinaryRunSettingsValid(method,settings)&&<DismissibleNotice identity={`${props.documentKey}:runtime-settings`}>请填写正整数步数及适用的 SCC 上限，收敛限度须为正数。</DismissibleNotice>}
    </details>
    {metadata?.periodic&&'gradientTargetHartreePerBohr' in metadata.periodic&&Number.isFinite(metadata.periodic.gradientTargetHartreePerBohr)&&
      <details className="xtb-constraint-results"><summary>周期优化精度</summary>
        <p>原生几何优化：{metadata.converged?'已收敛':'未收敛'}</p>
        <p>可动自由度梯度范数 {finiteNumber(metadata.periodic.movableGradientNormHartreePerBohr??NaN)} Eh/Bohr，目标 {finiteNumber(metadata.periodic.gradientTargetHartreePerBohr!)} Eh/Bohr</p>
        {metadata.periodic.gradientTargetMet===false&&<p>未达到周期梯度目标</p>}
      </details>}
    {!!metadata?.internalConstraints.length&&<details className="xtb-constraint-results" data-testid="xtb-constraint-results">
      <summary>内坐标强约束（{metadata.internalConstraints.length}）</summary>
      <p>约束力常数 {XTB_INTERNAL_CONSTRAINT_POLICY.forceConstant} Hartree/Bohr²。偏差参考值为键长 {XTB_INTERNAL_CONSTRAINT_POLICY.bondToleranceAngstrom} Å，键角或二面角 {XTB_INTERNAL_CONSTRAINT_POLICY.angleToleranceDegree}°。</p>
      <div className="xtb-constraint-table-scroll"><table aria-label="xTB内坐标强约束目标与残差"><thead><tr><th scope="col">类型</th><th scope="col">原子</th><th scope="col">目标</th><th scope="col">实际</th><th scope="col">残差</th></tr></thead><tbody>
        {metadata.internalConstraints.map((constraint,index)=>{
          const unit=constraint.unit==='angstrom'?'Å':'°';
          const labels=constraint.atomIds.map(id=>props.atomLabels?.[id]??id).join(' – ');
          return <tr key={`${constraint.type}:${constraint.atomIds.join(':')}:${index}`}><th scope="row">{constraint.type}</th><td title={constraint.atomIds.join(' – ')}>{labels}</td><td>{finiteNumber(constraint.target)} {unit}</td><td>{finiteNumber(constraint.actual)} {unit}</td><td>{finiteNumber(constraint.residual)} {unit}</td></tr>;
        })}
      </tbody></table></div>
    </details>}
    {props.ordinaryEvidence}
    {props.footer&&<div className="model-simulation-footer">{props.footer}</div>}
  </section>;
}

const usesScc=usesXtbSccIterations;
const supportsXtbPanelOptimization=(method:XtbPanelMethod,periodic:boolean,optimizer:OrdinaryOptimizer=ORDINARY_OPTIMIZATION_DEFAULT_OPTIMIZER)=>
  method!=='mcgfnff'&&workspaceOptimizationMethodAvailable(method,periodic)&&availableOrdinaryOptimizer(method,periodic,optimizer);
const validStepSetting=(value:number|undefined)=>value===undefined||Number.isSafeInteger(value)&&value>0;
