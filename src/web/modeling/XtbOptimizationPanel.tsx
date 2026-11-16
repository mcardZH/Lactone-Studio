import {DismissibleNotice} from '../DismissibleNotice';
import {GxtbAvailability,useGxtbBackend,gxtbMethodLabel,gxtbRunBlocked} from '../results/GxtbPathControl';
import NumericInput from '../NumericInput';
import ElectronicStateWarning from '../ElectronicStateWarning';
import {electronicStateIntegerInput} from '../BaseElectronicStateFields';
import ConformerSolventField from '../advanced/ConformerSolventField';
import {InputSettingsField} from '../InputSettingsFields';
import {InputSettingsLayout} from '../InputSettingsLayout';
import { useRef, useState, type ReactNode } from 'react';
import type { XtbMetadata, XtbOptimizationScope } from '../../modeling/xtb/contracts';
import { XTB_METHOD_IDS, XTB_METHOD_LABELS, supportsXtbOperation, type XtbNativeMethod } from '../../core/xtb-capabilities';
import { XTB_INTERNAL_CONSTRAINT_POLICY, xtbPreoptimizationSolvationIssue, type XtbPreoptimizationSolvation } from '../../modeling/xtb/accept-result';
import './xtb-optimization.css';

export { xtbPreoptimizationSolvationIssue };
export type XtbPanelMethod = XtbNativeMethod;
type XtbPanelPreferences = Pick<XtbPanelOptions,'method'|'rebuildBonds'|'scope'|'maxSteps'|'maxSccIterations'|'solvation'>;
export interface XtbPanelOptions {
  method: XtbPanelMethod;
  charge: number;
  /** GFN-FF retains this form value but does not consume spin. */
  multiplicity: number;
  rebuildBonds: boolean;
  threads?: number;
  maxSteps?: number;
  maxSccIterations?:number;
  scope?:XtbOptimizationScope;
  solvation?:XtbPreoptimizationSolvation;
}
export interface XtbOptimizationPanelProps {
  documentKey: string;
  initialCharge: number | null;
  initialMultiplicity: number | null;
  electronicState?: { charge: number; multiplicity: number };
  onElectronicStateChange?(value: { charge: number; multiplicity: number }): void;
  electronicRawText?:{charge:string;multiplicity:string};
  onElectronicRawTextChange?(field:'charge'|'multiplicity',text:string):void;
  onElectronicRawTextCommit?(field:'charge'|'multiplicity',text:string):void;
  electronicDisabled?:boolean;
  electronicWarning?:string|null;
  physicalCoreCount?:number|null;
  gfn2Threads?:number;
  onGfn2ThreadsChange?(threads:number):void;
  optimizationOptions?: XtbPanelPreferences;
  onOptimizationOptionsChange?(value: XtbPanelPreferences & {scope:XtbOptimizationScope}): void;
  onRunSettingsValidityChange?(valid:boolean):void;
  selectionCount?:number;
  atomCount?:number;
  spaceDefault?: boolean;
  onSetSpaceDefault?(): void;
  /** A GFN2 bond-assistance action shares the fields even when the optimizer is GFN-FF. */
  requireMultiplicity?: boolean;
  /** Periodic image-resolved bond-order analysis is a separate capability. */
  bondRebuildAvailable?: boolean;
  periodic?:boolean;
  /** The owner also disables this panel when its document/page is inactive. */
  disabled?: boolean;
  running?: boolean;
  status?: string;
  error?: string;
  metadata?: XtbMetadata | null;
  /** Current atom numbers/labels; retained stable IDs are the fallback. */
  atomLabels?: Readonly<Record<string, string | number>>;
  onOptimize(options: XtbPanelOptions): void | Promise<void>;
  onStop(): void | Promise<void>;
  footer?: ReactNode;
}
type Draft = XtbPanelOptions & {documentKey:string;scope:XtbOptimizationScope};
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

/** Same-document input edits remain local; a new document resets every option. */
export function xtbPanelDocumentDraft(previous: Draft | null, documentKey: string, initialCharge: number | null, initialMultiplicity: number | null): Draft {
  return previous?.documentKey === documentKey ? previous : {
    documentKey, method: 'gfn2', charge: initialCharge ?? Number.NaN,
    multiplicity: initialMultiplicity ?? Number.NaN, rebuildBonds: true,scope:'all',maxSccIterations:250,
  };
}
export function xtbPanelSubmission(draft: XtbPanelOptions,periodic=false): XtbPanelOptions | null {
  if(!supportsXtbOperation(draft.method,'optimize',periodic))return null;
  if (!Number.isSafeInteger(draft.charge) || draft.method !== 'gfnff' && (!Number.isSafeInteger(draft.multiplicity) || draft.multiplicity < 1)) return null;
  if (xtbPreoptimizationSolvationIssue(draft.method,draft.solvation,periodic)) return null;
  const maxSccIterations=validStepSetting(draft.maxSccIterations)?draft.maxSccIterations??250:250;if(usesScc(draft.method)&&!validStepSetting(draft.maxSccIterations))return null;
  const maxSteps=draft.maxSteps??(periodic?1000:500);if(!Number.isSafeInteger(maxSteps)||maxSteps<1)return null;
  const scope=draft.scope??'all';if(!['all','selection','unselected'].includes(scope))return null;
  return { method:draft.method, charge:draft.charge, multiplicity:draft.multiplicity, rebuildBonds:!periodic && draft.method !== 'gfnff' && draft.rebuildBonds,scope,maxSteps,maxSccIterations,
    ...(draft.solvation?{solvation:{...draft.solvation}}:{}) };
}

export default function XtbOptimizationPanel({ documentKey, initialCharge, initialMultiplicity, electronicState, onElectronicStateChange, optimizationOptions, onOptimizationOptionsChange, onRunSettingsValidityChange, selectionCount,atomCount,spaceDefault=false, onSetSpaceDefault, requireMultiplicity=false, bondRebuildAvailable=true, periodic=false, disabled=false, running=false, status='', error='', metadata, atomLabels, onOptimize, onStop, footer,electronicRawText,onElectronicRawTextChange,onElectronicRawTextCommit,electronicDisabled,electronicWarning }: XtbOptimizationPanelProps) {
  const gxtbBackend=useGxtbBackend();
  const [saved, setSaved] = useState<Draft>(() => xtbPanelDocumentDraft(null, documentKey, initialCharge, initialMultiplicity));
  const documentDraft=xtbPanelDocumentDraft(saved, documentKey, initialCharge, initialMultiplicity);
  const draft = { ...documentDraft, ...optimizationOptions, ...electronicState,scope:optimizationOptions?.scope??documentDraft.scope,
    solvation:optimizationOptions?optimizationOptions.solvation:documentDraft.solvation,
    maxSteps:!validStepSetting(documentDraft.maxSteps)?documentDraft.maxSteps:optimizationOptions?.maxSteps??documentDraft.maxSteps,
    maxSccIterations:!validStepSetting(documentDraft.maxSccIterations)?documentDraft.maxSccIterations:optimizationOptions?.maxSccIterations??documentDraft.maxSccIterations };
  // Adjust during render, so no old-document frame can submit before an effect.
  if (saved.documentKey !== documentKey) setSaved(draft);
  const root = useRef<HTMLElement>(null);
  const inactive = () => disabled || Boolean(root.current?.closest('[hidden], [aria-hidden="true"]'));
  const update = (patch: Partial<Draft>) => {
    if (inactive() || running) return;
    const next={...draft,...patch};setSaved(next);
    if('maxSteps' in patch||'maxSccIterations' in patch||'method' in patch)onRunSettingsValidityChange?.(validStepSetting(next.maxSteps)&&(!usesScc(next.method)||validStepSetting(next.maxSccIterations)));
    if ('charge' in patch || 'multiplicity' in patch) onElectronicStateChange?.({charge:next.charge,multiplicity:next.multiplicity});
    if (('method' in patch || 'rebuildBonds' in patch || 'scope' in patch || 'solvation' in patch || 'maxSteps' in patch || 'maxSccIterations' in patch)
      && validStepSetting(next.maxSteps)&&(!usesScc(next.method)||validStepSetting(next.maxSccIterations))) {
      onOptimizationOptionsChange?.({method:next.method,rebuildBonds:next.rebuildBonds,scope:next.scope,maxSteps:next.maxSteps,maxSccIterations:validStepSetting(next.maxSccIterations)?next.maxSccIterations:optimizationOptions?.maxSccIterations,
        ...(next.solvation?{solvation:next.solvation}:{})});
    }
  };
  const options = xtbPanelSubmission({...draft,rebuildBonds:bondRebuildAvailable&&draft.rebuildBonds},periodic);
  const backendBlocked=gxtbRunBlocked(gxtbBackend,draft.method);
  const emptyRange=draft.scope==='selection'&&selectionCount===0||draft.scope==='unselected'&&atomCount!==undefined&&selectionCount===atomCount;
  const constraintNumber = (value: number) => Number.isFinite(value) ? String(Number(value.toPrecision(12))) : '未知';
  return <section ref={root} className="model-simulation-card xtb-optimization-panel" aria-label="xTB预优化" data-testid="xtb-optimization-panel" data-running={running}>
    <header className="optimization-panel-header model-simulation-heading"><strong>xTB预优化</strong>{onSetSpaceDefault&&<button type="button" className="model-space-default" aria-label="xTB设为空格默认" aria-pressed={spaceDefault} disabled={disabled||running} onClick={()=>{if(!inactive()&&!running)onSetSpaceDefault();}}>{spaceDefault?'空格默认':'设为空格默认'}</button>}</header>
    <div className="optimization-primary-row">
      <label className="xtb-optimization-method"><span>方法</span><select aria-label="xTB预优化方法" value={draft.method} disabled={disabled || running} onChange={event => {
        const method = event.target.value as XtbPanelMethod;
        if (supportsXtbOperation(method,'optimize',periodic)) update({ method });
      }}>{XTB_METHOD_IDS.filter(method=>supportsXtbOperation(method,'optimize',periodic)||draft.method===method).map(method => <option key={method} value={method} disabled={!supportsXtbOperation(method,'optimize',periodic)}>{method==='gxtb'?gxtbMethodLabel(gxtbBackend):XTB_METHOD_LABELS[method]}</option>)}</select></label>
      <label><span>范围</span><select aria-label="xTB优化范围" value={draft.scope} disabled={disabled||running} onChange={event=>{const scope=event.target.value as XtbOptimizationScope;if(['all','selection','unselected'].includes(scope))update({scope});}}><option value="all">全体</option><option value="selection" disabled={selectionCount===0}>选区</option><option value="unselected" disabled={atomCount!==undefined&&selectionCount===atomCount}>非选区</option></select></label>
      <div className="model-simulation-actions">
        <button type="button" disabled={backendBlocked || disabled || running || !options || emptyRange} onClick={() => { if (!backendBlocked && !inactive() && !running && options&&!emptyRange) void onOptimize(options); }}>优化</button>
        <button type="button" className="optimization-stop" disabled={disabled || !running} onClick={() => { if (!inactive() && running) void onStop(); }}>停止</button>
      </div>
    </div>
    <GxtbAvailability method={draft.method}/>
    <XtbElectronicFields prefix="xTB预优化" charge={draft.charge} multiplicity={draft.multiplicity} method={draft.method} periodic={periodic} multiplicityLabel="自旋多重度"
      electronicRawText={electronicRawText} onElectronicRawTextChange={onElectronicRawTextChange} onElectronicRawTextCommit={onElectronicRawTextCommit} electronicDisabled={electronicDisabled} electronicWarning={electronicWarning}
      solvation={draft.solvation} disabled={disabled||running} requireMultiplicity={requireMultiplicity}
      onElectronicStateChange={value=>update(value)} onSolvationChange={solvation=>update({solvation})}/>
    {(draft.method!=='gfnff'||Boolean(error||status))&&<div className="xtb-optimization-actions">
      {draft.method !== 'gfnff' && <label className="xtb-rebuild-bonds" title={!bondRebuildAvailable?'周期优化后成键更新本轮暂不提供；保留现有连接':draft.method==='gfn2'?'使用本次GFN2-xTB输出的MBO更新成键':'使用本次优化坐标按经验参数更新成键'}><input type="checkbox" aria-label={draft.method==='gfn2'?'优化后按 MBO 更新成键':'优化后按经验更新成键'} checked={bondRebuildAvailable&&draft.rebuildBonds} disabled={disabled || running || !bondRebuildAvailable} onChange={event => {if(bondRebuildAvailable)update({ rebuildBonds: event.target.checked });}} /><span>{draft.method==='gfn2'?'优化后按 MBO 更新成键':'优化后按经验更新成键'}</span></label>}
      {error ? <DismissibleNotice className="xtb-optimization-error" identity={documentKey}>{error}</DismissibleNotice> : status && <p className="xtb-optimization-status" role="status">{status}</p>}
    </div>}
    {!supportsXtbOperation(draft.method,'optimize',periodic)&&<DismissibleNotice identity={`${documentKey}:${draft.method}:periodic`}>当前方法不支持周期优化，请改选方法。</DismissibleNotice>}
    {metadata?.trajectoryWarning&&<details className="xtb-constraint-results"><summary aria-label="轨迹提示" title="轨迹提示">⚠</summary>
      <DismissibleNotice identity={`${documentKey}:${metadata.trajectoryWarning.code}`}>{metadata.trajectoryWarning.message}</DismissibleNotice>
    </details>}
    <details className="xtb-constraint-results xtb-run-settings"><summary>运行设置</summary><div className="xtb-run-settings-fields">
      <label><span>最大优化步数</span><NumericInput aria-label="最大优化步数" aria-invalid={!validStepSetting(draft.maxSteps)||undefined} min="1" step="1" stepper value={shown(draft.maxSteps??(periodic?1000:500))} disabled={disabled||running} onChange={event=>update({maxSteps:edited(event.target.value)})}/></label>
      <label><span>SCC迭代上限</span><NumericInput aria-label="SCC迭代上限" aria-invalid={usesScc(draft.method)&&!validStepSetting(draft.maxSccIterations)||undefined} min="1" step="1" stepper value={shown(draft.maxSccIterations??250)} disabled={disabled||running||!usesScc(draft.method)} onChange={event=>update({maxSccIterations:edited(event.target.value)})}/></label>
    </div>{(!validStepSetting(draft.maxSteps)||usesScc(draft.method)&&!validStepSetting(draft.maxSccIterations))&&<DismissibleNotice identity={`${documentKey}:steps:${draft.maxSteps}:${draft.maxSccIterations}`}>步数和适用的SCC迭代上限须为正整数。</DismissibleNotice>}</details>
    {metadata?.periodic&&'gradientTargetHartreePerBohr' in metadata.periodic&&Number.isFinite(metadata.periodic.gradientTargetHartreePerBohr)&&
      <details className="xtb-constraint-results"><summary>周期优化精度</summary>
        <p>原生几何优化：{metadata.converged?'已收敛':'未收敛'}</p>
        <p>可动自由度梯度范数 {constraintNumber(metadata.periodic.movableGradientNormHartreePerBohr??NaN)} Eh/Bohr，目标 {constraintNumber(metadata.periodic.gradientTargetHartreePerBohr!)} Eh/Bohr</p>
        {metadata.periodic.gradientTargetMet===false&&<p>未达到周期梯度目标</p>}
      </details>}
    {!!metadata?.internalConstraints.length && <details className="xtb-constraint-results" data-testid="xtb-constraint-results">
      <summary>内坐标强约束（{metadata.internalConstraints.length}）</summary>
      <p>约束力常数 {XTB_INTERNAL_CONSTRAINT_POLICY.forceConstant} Hartree/Bohr²。偏差参考值为键长 {XTB_INTERNAL_CONSTRAINT_POLICY.bondToleranceAngstrom} Å，键角或二面角 {XTB_INTERNAL_CONSTRAINT_POLICY.angleToleranceDegree}°。</p>
      <div className="xtb-constraint-table-scroll"><table aria-label="xTB内坐标强约束目标与残差"><thead><tr><th scope="col">类型</th><th scope="col">原子</th><th scope="col">目标</th><th scope="col">实际</th><th scope="col">残差</th></tr></thead><tbody>
        {metadata.internalConstraints.map((constraint, index) => {
          const unit = constraint.unit === 'angstrom' ? 'Å' : '°';
          return <tr key={`${constraint.type}:${constraint.atomIds.join(':')}:${index}`}><th scope="row">{constraint.type}</th><td title={constraint.atomIds.join(' – ')}>{constraint.atomIds.map(id => atomLabels?.[id] ?? id).join(' – ')}</td><td>{constraintNumber(constraint.target)} {unit}</td><td>{constraintNumber(constraint.actual)} {unit}</td><td>{constraintNumber(constraint.residual)} {unit}</td></tr>;
        })}
      </tbody></table></div>
    </details>}
    {footer&&<div className="model-simulation-footer">{footer}</div>}
  </section>;
}

const usesScc=(method:XtbPanelMethod)=>method!=='gfn0'&&method!=='gfnff';
const validStepSetting=(value:number|undefined)=>value===undefined||Number.isSafeInteger(value)&&value>0;
