import {GxtbAvailability,useGxtbBackend,gxtbMethodLabel,gxtbRunBlocked} from '../results/GxtbPathControl';
import { useState, useSyncExternalStore } from 'react';
import { DismissibleNotice } from '../DismissibleNotice';
import NumericInput from '../NumericInput';
import { InputSettingsField, InputSettingsRow, InputSettingsStack } from '../InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox, InputSettingsLayout } from '../InputSettingsLayout';
import type { DynamicsController, DynamicsConfig, DynamicsControllerState } from '../../modeling/dynamics/controller';
import type { DynamicsOperation, MDIntegrator, MDMethod } from '../../modeling/dynamics/contracts';
import { ScientificEditCancelledError } from '../../core/modeling/analysis-binding';
import { XTB_METHOD_IDS, XTB_METHOD_LABELS, isXtbMethod, supportsXtbAlpb } from '../../core/xtb-capabilities';
import { mdHydrogenSettings, supportsMDIntegrator } from '../../modeling/dynamics/md-methods';
import type { XtbPreoptimizationSolvation } from '../../modeling/xtb/accept-result';
import { useProjectState } from '../../projects/ui-state';
import { XtbElectronicFields } from './XtbOptimizationPanel';
import './dynamics.css';

const states: Record<string,string> = {idle:'待启动',starting:'准备中',running:'运行中',pausing:'正在暂停',paused:'已暂停',stopping:'停止中',stopped:'已停止',completed:'已完成',error:'异常停止'};
const methods: {value:MDMethod;label:string}[] = [
  ...XTB_METHOD_IDS.map(value=>({value,label:XTB_METHOD_LABELS[value]})),
];
type BeforeStart = (mode:DynamicsOperation,config:DynamicsConfig)=>boolean;
/** Display metadata follows exactly the real frame drawn by the viewport. */
export function displayedDynamicsFrame(state:Pick<DynamicsControllerState,'mode'|'displayFrame'|'lastFrame'>){
  return state.mode==='md' ? state.displayFrame??state.lastFrame : state.lastFrame;
}
export async function startApprovedDynamics(controller:Pick<DynamicsController,'start'>, mode:Parameters<DynamicsController['start']>[0], config:Parameters<DynamicsController['start']>[1], beforeStart?:BeforeStart, onStartFailure?:()=>void) {
  try { if(beforeStart?.(mode,config??{})===false)return;await controller.start(mode,config); }
  catch(cause){onStartFailure?.();throw cause;}
}

/** Live preview controls only. The run owns method, time, frames and shutdown. */
export type ModelMdDraft={temperature:string;method:MDMethod;integrator?:MDIntegrator;shakeHydrogenBonds?:boolean;solvation?:XtbPreoptimizationSolvation};
const initialModelMdDraft=():ModelMdDraft=>({temperature:'300',method:'gfn2'});
export function useModelMdDraft(documentId:string){return useProjectState<ModelMdDraft>('modeling-md-draft',initialModelMdDraft,documentId);}
interface DynamicsPanelProps {controller:DynamicsController;disabled?:boolean;compact?:boolean;beforeStart?:BeforeStart;onStartFailure?():void;
  documentKey?:string;periodic?:boolean;electronicState?:{charge:number;multiplicity:number};onElectronicStateChange?(value:{charge:number;multiplicity:number}):void;
  electronicRawText?:{charge:string;multiplicity:string};onElectronicRawTextChange?(field:'charge'|'multiplicity',text:string):void;onElectronicRawTextCommit?(field:'charge'|'multiplicity',text:string):void;electronicDisabled?:boolean;electronicWarning?:string|null;}
export default function DynamicsPanel({controller,disabled=false,compact=true,beforeStart,onStartFailure,documentKey='default',periodic=false,electronicState,onElectronicStateChange,electronicRawText,onElectronicRawTextChange,onElectronicRawTextCommit,electronicDisabled,electronicWarning}:DynamicsPanelProps) {
  const gxtbBackend=useGxtbBackend();
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const [draft,setDraft]=useModelMdDraft(documentKey);
  const {temperature}=draft;
  const method=draft.method??'gfn2';
  const integrator = periodic || draft.integrator==='ase' ? 'ase' : 'xtb';
  const hydrogen = mdHydrogenSettings(method, draft.shakeHydrogenBonds);
  const solvation = !periodic && isXtbMethod(draft.method) ? draft.solvation : undefined;
  const update=(patch:Partial<ModelMdDraft>)=>setDraft(previous=>({...previous,...patch}));
  const [localError,setLocalError]=useState(''),[temperatureTouched,setTemperatureTouched]=useState(false),[startPending,setStartPending]=useState(false);
  const active=['starting','running','pausing','paused','stopping'].includes(state.status);
  const methodInvalid=!isXtbMethod(method)||!supportsMDIntegrator(method,periodic,integrator);
  const solvationInvalid=Boolean(solvation&&(solvation.model!=='alpb'||!supportsXtbAlpb(method,solvation.solvent,periodic)));
  const temperatureK=Number(temperature),validTemperature=temperature.trim()!==''&&Number.isFinite(temperatureK)&&temperatureK>=0.01&&temperatureK<=5000;
  const electronicInvalid=Boolean(electronicState&&(!Number.isSafeInteger(electronicState.charge)||method!=='gfnff'&&(!Number.isSafeInteger(electronicState.multiplicity)||electronicState.multiplicity<1)));
  const startDisabled=gxtbRunBlocked(gxtbBackend,method)||disabled||active||startPending||!validTemperature||methodInvalid||solvationInvalid||electronicInvalid||!state.capabilities.available;
  const fieldInvalid=temperatureTouched&&!validTemperature;
  const report=(cause:unknown)=>setLocalError(cause instanceof ScientificEditCancelledError?'':cause instanceof Error?cause.message:String(cause));
  async function start(){
    if(startDisabled)return;
    setLocalError('');setStartPending(true);
    try{await startApprovedDynamics(controller,'md',{method,integrator,shakeHydrogenBonds:hydrogen.shakeHydrogenBonds,temperatureK,...(solvation?{solvation}:{})},beforeStart,onStartFailure);}
    catch(cause){report(cause);}finally{setStartPending(false);}
  }
  async function stop(){setLocalError('');try{await controller.command({type:'stop'});}catch(cause){report(cause);}}
  const shownFrame=displayedDynamicsFrame(state);
  const timeFs=state.mode==='md'?shownFrame?.physicalTimeFs:undefined;
  const nativeEvidence=state.mode==='md'?shownFrame?.nativeMD:undefined;
  const aseEvidence=state.mode==='md'?shownFrame?.aseMD:undefined;
  const stateText=states[state.status]??state.status;
  return <section className={'model-simulation-card dynamics-panel'+(compact?' dynamics-panel-compact':'')} data-testid="dynamics-panel" data-compact={compact} aria-label="分子动力学" onKeyDown={event=>event.stopPropagation()} onKeyUp={event=>event.stopPropagation()}>
    <header className="model-simulation-heading"><strong>分子动力学（MD）</strong></header>
    <InputSettingsLayout><InputSettingsStack>{integrator==='xtb'&&<GxtbAvailability method={method}/>}
      <InputSettingsRow>
        <InputSettingsField label="积分器" controlWidth="select">
          <select aria-label="MD积分器" value={integrator} disabled={periodic||active||startPending} onChange={event=>update({integrator:event.target.value==='ase'?'ase':'xtb'})}>
            {!periodic&&<option value="xtb">xTB 原生</option>}
            <option value="ase">{periodic?'ASE（固定晶胞）':'ASE'}</option>
          </select>
        </InputSettingsField>
      </InputSettingsRow>
      <div className="optimization-primary-row dynamics-md-primary">
        <label className="xtb-optimization-method"><span>方法</span>
          <select aria-label="MD计算级别" title={methods.find(item=>item.value===method)?.label} value={method} disabled={active||startPending} onChange={event=>{
            const value=event.target.value as MDMethod;
            if(supportsMDIntegrator(value,periodic,integrator))update({method:value});
          }}>{!isXtbMethod(method)&&<option value={method} disabled>{method}（请改选可用方法）</option>}{methods.filter(item=>supportsMDIntegrator(item.value,periodic,integrator)||method===item.value).map(item=>
            <option key={item.value} value={item.value} disabled={!supportsMDIntegrator(item.value,periodic,integrator)}>{item.value==='gxtb'?gxtbMethodLabel(gxtbBackend):item.label}</option>
          )}</select>
        </label>
        <label className="model-temperature-field"><span>温度</span><span className="model-temperature-control">
          <NumericInput aria-label="MD目标温度" aria-description="单位：K" aria-invalid={fieldInvalid||undefined} min="0" max="5000" step="10" stepper
            value={temperature} disabled={active||startPending} onChange={event=>update({temperature:event.target.value})}
            onBlur={()=>setTemperatureTouched(true)}/>
          <span className="model-temperature-unit" aria-hidden="true">K</span>
        </span></label>
        <div className="model-simulation-actions">
          <InputSettingsAction variant="primary" disabled={startDisabled} onClick={()=>void start()}>开始</InputSettingsAction>
          <InputSettingsAction disabled={!active||state.status==='stopping'} onClick={()=>void stop()}>停止</InputSettingsAction>
        </div>
      </div>
      <InputSettingsRow>
        <InputSettingsCheckbox label="含氢键长约束" ariaLabel="MD含氢键长约束" checked={hydrogen.shakeHydrogenBonds}
          disabled={disabled||active||startPending||method==='gfnff'} onChange={shakeHydrogenBonds=>update({shakeHydrogenBonds})}/>
        <output aria-label="MD氢质量">氢质量 {hydrogen.hydrogenMassAmu} amu</output>
      </InputSettingsRow>
      {electronicState&&onElectronicStateChange&&<XtbElectronicFields prefix="MD" {...electronicState} method={method} periodic={periodic}
        electronicRawText={electronicRawText} onElectronicRawTextChange={onElectronicRawTextChange} onElectronicRawTextCommit={onElectronicRawTextCommit} electronicDisabled={electronicDisabled} electronicWarning={electronicWarning}
        multiplicityLabel="自旋多重度" disabled={disabled||active||startPending} onElectronicStateChange={onElectronicStateChange}
        solvation={solvation} onSolvationChange={solvation=>update({solvation})}/>}
      <div className="dynamics-compact-secondary">
        <span role="status">{startPending&&!active?'准备中':stateText}</span>
        <span className="dynamics-time">累计时间 <output>{timeFs===undefined?'—':(timeFs/1000).toFixed(3)}</output> ps</span>
      </div>
    </InputSettingsStack></InputSettingsLayout>
    {methodInvalid&&<DismissibleNotice identity={`${documentKey}:${method}:${integrator}`}>所选方法与积分器不支持当前模型，请改选方法。</DismissibleNotice>}
    {nativeEvidence&&<details className="dynamics-advanced"><summary>原生MD详情</summary>
      {nativeEvidence.seedTreatment==='verified'&&<p>实际随机种子 {nativeEvidence.effectiveSeed}</p>}
      {nativeEvidence.seedTreatment==='program-random'&&<p>由 g-xTB 随机初始化</p>}
      {nativeEvidence.seedTreatment==='native-internal-initialization'&&<p>由 xTB 内部随机初始化</p>}
      {nativeEvidence.degreesOfFreedom!==undefined&&<p>自由度 {nativeEvidence.degreesOfFreedom}</p>}
      {(nativeEvidence.protectedAtomIds.length>0||!!nativeEvidence.internalConstraints?.length)&&<p>共同保护力常数 {nativeEvidence.forceConstantKJMolNm2} kJ·mol⁻¹·nm⁻²</p>}
      {nativeEvidence.internalConstraints?.map((row,i)=><p key={row.id??i}>{row.type} {row.atomIds.join('–')} · 目标 {row.target.toPrecision(5)} · 实际 {row.actual.toPrecision(5)} · 偏差 {row.residual.toPrecision(3)} {row.unit==='angstrom'?'Å':'°'}</p>)}
    </details>}
    {aseEvidence&&<details className="dynamics-advanced"><summary>ASE MD 详情</summary>
      <p>V-rescale · 步长 {aseEvidence.dtFs} fs · 耦合时间 {aseEvidence.thermostatTimeConstantFs} fs</p>
      <p>自由度 {aseEvidence.degreesOfFreedom} · 固定原子 {aseEvidence.frozenAtomIds.length}{aseEvidence.shake&&` · 含氢键长约束 ${aseEvidence.shake.hydrogenBondCount}`}</p>
      {aseEvidence.internalConstraints?.map((row,i)=><p key={row.id??i}>{row.type} {row.atomIds.join('–')} · 目标 {row.target.toPrecision(5)} · 实际 {row.actual.toPrecision(5)} · 偏差 {row.residual.toPrecision(3)} {row.unit==='angstrom'?'Å':'°'}</p>)}
    </details>}
    {!state.capabilities.available&&<p className="dynamics-unavailable">{state.capabilities.reason||'当前环境没有原生动力学引擎；请在桌面版使用。'}</p>}
    {fieldInvalid&&<DismissibleNotice className="dynamics-error" identity={'temperature:'+temperature}>请输入大于0且不超过5000 K的有效温度。</DismissibleNotice>}
    {(localError||state.error)&&<DismissibleNotice className="dynamics-error" identity={(state.sessionId??'idle')+':'+(localError||state.error)} role="alert">{localError||state.error}</DismissibleNotice>}
  </section>;
}
