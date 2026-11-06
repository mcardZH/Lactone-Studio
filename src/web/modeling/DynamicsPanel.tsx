import { useState, useSyncExternalStore } from 'react';
import { DismissibleNotice } from '../DismissibleNotice';
import NumericInput from '../NumericInput';
import type { DynamicsController, DynamicsConfig, DynamicsControllerState } from '../../modeling/dynamics/controller';
import type { DynamicsOperation, MDMethod } from '../../modeling/dynamics/contracts';
import { ScientificEditCancelledError } from '../../core/modeling/analysis-binding';
import './dynamics.css';

const states: Record<string,string> = {idle:'待启动',starting:'准备中',running:'运行中',pausing:'正在暂停',paused:'已暂停',stopping:'停止中',stopped:'已停止',completed:'已完成',error:'异常停止'};
const methods: {value:MDMethod;label:string}[] = [
  {value:'auto',label:'力场 AUTO'},{value:'MMFF94',label:'MMFF94'},{value:'MMFF94s',label:'MMFF94s'},{value:'UFF',label:'UFF'},
  {value:'gfnff',label:'GFN-FF'},{value:'gfn0',label:'GFN0-xTB'},{value:'gfn1',label:'GFN1-xTB'},{value:'gfn2',label:'GFN2-xTB'},
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
export default function DynamicsPanel({controller,disabled=false,compact=true,beforeStart,onStartFailure}:{controller:DynamicsController;disabled?:boolean;geometryDisabled?:boolean;compact?:boolean;beforeStart?:BeforeStart;onStartFailure?():void}) {
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const [temperature,setTemperature]=useState('300'),[method,setMethod]=useState<MDMethod>('auto');
  const [localError,setLocalError]=useState(''),[temperatureTouched,setTemperatureTouched]=useState(false),[startPending,setStartPending]=useState(false);
  const active=['starting','running','pausing','paused','stopping'].includes(state.status);
  const temperatureK=Number(temperature),validTemperature=temperature.trim()!==''&&Number.isFinite(temperatureK)&&temperatureK>=0&&temperatureK<=5000;
  const fieldInvalid=temperatureTouched&&!validTemperature;
  const report=(cause:unknown)=>setLocalError(cause instanceof ScientificEditCancelledError?'':cause instanceof Error?cause.message:String(cause));
  async function start(){
    if(disabled||active||startPending||!validTemperature)return;
    setLocalError('');setStartPending(true);
    try{await startApprovedDynamics(controller,'md',{method,temperatureK},beforeStart,onStartFailure);}
    catch(cause){report(cause);}finally{setStartPending(false);}
  }
  async function stop(){setLocalError('');try{await controller.command({type:'stop'});}catch(cause){report(cause);}}
  const shownFrame=displayedDynamicsFrame(state);
  const timeFs=state.mode==='md'?shownFrame?.physicalTimeFs:undefined;
  const stateText=state.mode&&state.mode!=='md'&&active?(state.mode==='geometry'?'机械整理':'预优化')+' · '+states[state.status]:states[state.status]??state.status;
  const geometryReadout=state.mode==='geometry'?<div className="dynamics-readout" aria-label="实时动力学状态"><span>已接受迭代 <output>{state.lastFrame?.step??0}</output></span><span>几何目标 <output>{state.lastFrame?.geometryObjective===undefined?'—':state.lastFrame.geometryObjective.toFixed(5)}</output>（无量纲）</span><span>引擎 <output>{state.lastFrame?.engine??'—'}</output></span></div>:null;
  return <section className={'dynamics-panel'+(compact?' dynamics-panel-compact':'')} data-compact={compact} aria-label="分子动力学" onKeyDown={event=>event.stopPropagation()} onKeyUp={event=>event.stopPropagation()}>
    <div className="dynamics-compact-main dynamics-md-main">
      <label className="dynamics-temperature"><span>T</span><NumericInput aria-label="MD目标温度" aria-invalid={fieldInvalid||undefined} min="0" max="5000" step="10" stepper value={temperature} disabled={active||startPending} onChange={event=>setTemperature(event.target.value)} onBlur={()=>setTemperatureTouched(true)}/><span>K</span></label>
      <label className="dynamics-method"><span>计算级别</span><select aria-label="MD计算级别" value={method} disabled={active||startPending} onChange={event=>{const value=event.target.value as MDMethod;if(methods.some(item=>item.value===value))setMethod(value);}}>{methods.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <button type="button" disabled={disabled||active||startPending||!validTemperature||!state.capabilities.available} onClick={()=>void start()}>开始</button>
      <button type="button" className="dynamics-stop" disabled={!active||state.status==='stopping'} onClick={()=>void stop()}>停止</button>
    </div>
    <div className="dynamics-compact-secondary"><strong className="dynamics-mode-label">MD</strong><span role="status">{startPending&&!active?'准备中':stateText}</span><span className="dynamics-time">累计时间 <output>{timeFs===undefined?'—':(timeFs/1000).toFixed(3)}</output> ps</span></div>
    {geometryReadout&&(compact?<details className="dynamics-advanced"><summary>动力学详情</summary>{geometryReadout}</details>:geometryReadout)}
    {!state.capabilities.available&&<p className="dynamics-unavailable">{state.capabilities.reason||'当前环境没有原生动力学引擎；请在桌面版使用。'}</p>}
    {fieldInvalid&&<DismissibleNotice className="dynamics-error" identity={'temperature:'+temperature}>请输入0–5000 K范围内的有效温度。</DismissibleNotice>}
    {(localError||state.error)&&<DismissibleNotice className="dynamics-error" identity={(state.sessionId??'idle')+':'+(localError||state.error)} role="alert">{localError||state.error}</DismissibleNotice>}
  </section>;
}
