import NumericInput from './NumericInput';
import { useState } from 'react';
import type { FileSettings } from '../core/types';
import { InputSettingsField, InputSettingsRow } from './InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox } from './InputSettingsLayout';

export interface ResourcePatch {cores?:number;memory?:number;writeCores?:boolean;writeMemory?:boolean}
const PRESETS=[{cores:4,memory:8},{cores:8,memory:16},{cores:16,memory:32},{cores:32,memory:64}];
export default function ResourceControls({files,external,cores,memory,onChange,confirmed=false,onConfirm}:{files:FileSettings;external:boolean;cores:number;memory:number;onChange:(patch:ResourcePatch)=>void;confirmed?:boolean;onConfirm?:()=>void}){
  const [editingCustom,setEditingCustom]=useState(false);
  const match=files.writeCores&&files.writeMemory?PRESETS.find(p=>p.cores===cores&&p.memory===memory):undefined;
  const derived=!files.writeCores&&!files.writeMemory?'none':match?String(match.cores):'custom';
  const value=editingCustom?'custom':derived;
  function choose(value:string){setEditingCustom(value==='custom');if(value==='none')onChange({writeCores:false,writeMemory:false});else if(value==='custom')onChange({});else{const preset=PRESETS.find(p=>String(p.cores)===value);if(preset)onChange({...preset,writeCores:true,writeMemory:true});}}
  return <section className="resource-controls-eight"><div className="resource-preset-row">
    {external?<p className="muted-note">Gaussian固定单核；xTB实际线程沿挂接脚本。此处只可选是否写入Gaussian内存。</p>:<InputSettingsField label="资源预设" className="resource-preset-field"><select aria-label="资源预设" title={value==='none'?'不预设 · 由运行环境决定（默认）':value==='custom'?'自定义 · 分别指定CPU与内存':undefined} value={value} onChange={event=>choose(event.target.value)}><option value="none" title="不预设 · 由运行环境决定（默认）">不预设（默认）</option>{PRESETS.map(p=><option key={p.cores} value={p.cores}>{p.cores} 核 / {p.memory} GB</option>)}<option value="custom" title="自定义 · 分别指定CPU与内存">自定义</option></select></InputSettingsField>}
    {onConfirm&&<InputSettingsAction variant="primary" disabled={confirmed||(!external&&files.writeCores&&(!Number.isSafeInteger(cores)||cores<1))||(files.writeMemory&&(!Number.isSafeInteger(memory)||memory<1))} onClick={onConfirm} ariaLabel="确认计算资源">{confirmed?'已确认':'确认'}</InputSettingsAction>}</div>{(value==='custom'||external)&&<>
      <InputSettingsRow className="resource-write-options">{!external&&<InputSettingsCheckbox ariaLabel="预设CPU核数" label="预设CPU核数（%nprocshared）" checked={files.writeCores} onChange={writeCores=>onChange({writeCores})}/>}<InputSettingsCheckbox ariaLabel="预设内存" label="预设内存（%mem）" checked={files.writeMemory} onChange={writeMemory=>onChange({writeMemory})}/></InputSettingsRow>
      <InputSettingsRow className="resource-fields">{!external&&<InputSettingsField label="CPU 核数"><NumericInput aria-label="CPU核数" disabled={!files.writeCores} stepper={true} min="1" step="1" value={cores||''} placeholder="不指定则不写入" onChange={event=>onChange({cores:Number(event.target.value)})}/></InputSettingsField>}<InputSettingsField label="总内存（GB）"><NumericInput aria-label="总内存GB" disabled={!files.writeMemory} stepper={false} min="1" step="1" value={memory||''} placeholder="不指定则不写入" onChange={event=>onChange({memory:Number(event.target.value)})}/></InputSettingsField></InputSettingsRow>
    </>}
  </section>;
}

/** Same preset presentation, with ORCA's required resource values retained. */
export function OrcaResourceControls({cores,memory,onChange,confirmed=false,onConfirm}:{cores:number;memory:number;onChange:(patch:{cores?:number;memoryGB?:number})=>void;confirmed?:boolean;onConfirm?:()=>void}) {
  const [editingCustom,setEditingCustom]=useState(false);
  const presets=[{cores:1,memory:1},...PRESETS];
  const match=presets.find(p=>p.cores===cores&&p.memory===memory);
  const value=editingCustom||!match?'custom':String(match.cores);
  return <><div className="resource-preset-row"><InputSettingsField label="资源预设" className="resource-preset-field"><select aria-label="ORCA资源预设" value={value} onChange={event=>{const key=event.target.value;setEditingCustom(key==='custom');if(key==='custom')onChange({});const preset=presets.find(p=>String(p.cores)===key);if(preset)onChange({cores:preset.cores,memoryGB:preset.memory});}}>{presets.map(p=><option key={p.cores} value={p.cores}>{p.cores} 核 / {p.memory} GB</option>)}<option value="custom">自定义</option></select></InputSettingsField>{onConfirm&&<InputSettingsAction variant="primary" disabled={confirmed||!Number.isSafeInteger(cores)||cores<1||!Number.isFinite(memory)||memory<=0} onClick={onConfirm} ariaLabel="确认计算资源">{confirmed?'已确认':'确认'}</InputSettingsAction>}</div>{value==='custom'&&<InputSettingsRow><InputSettingsField label="CPU 核数"><NumericInput aria-label="ORCA核数" stepper={true} min="1" step="1" value={Number.isFinite(cores)?cores:''} onChange={event=>onChange({cores:event.target.value===''?Number.NaN:Number(event.target.value)})}/></InputSettingsField><InputSettingsField label="总内存（GB）"><NumericInput aria-label="ORCA总内存" stepper={false} min="0" step="any" value={Number.isFinite(memory)?memory:''} onChange={event=>onChange({memoryGB:event.target.value===''?Number.NaN:Number(event.target.value)})}/></InputSettingsField></InputSettingsRow>}</>;
}
