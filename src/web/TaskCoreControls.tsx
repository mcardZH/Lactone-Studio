import NumericInput from './NumericInput';
import type { ReactNode } from 'react';
import type { AdvancedSettings, FileSettings, GaussianSettings, TaskOptions } from '../core/types';
import { defaultAdvanced } from '../core/advanced';
import { excitedOptimizationFrequency } from '../core/excited-state';
import { isXtb, xtbHessian } from '../core/xtb';
import { InputSettingsField, InputSettingsRow, type InputSettingsCardProps } from './InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox, InputSettingsSection } from './InputSettingsLayout';
import './task-core-controls.css';

export function CoreParameterGroup({title,children,...props}:InputSettingsCardProps) {
  return <InputSettingsSection {...props} title={title} level="subcard" className={'task-core-group '+(props.className??'')} collapsible defaultOpen><div className="input-control-flow">{children}</div></InputSettingsSection>;
}
export function OptionalCoreNumber({label,value,onChange,placeholder,integer=false,disabled=false}:{label:string;value:number|null|undefined;onChange(value:number|null):void;placeholder?:string;integer?:boolean;disabled?:boolean}){
  return <div className="task-core-number"><InputSettingsField label={label}><NumericInput aria-label={label} disabled={disabled} stepper={false} min={integer?1:0} step={integer?1:'any'} value={value??''} placeholder={placeholder??'程序默认'} onChange={event=>onChange(event.target.value===''?null:Number(event.target.value))}/></InputSettingsField><InputSettingsAction disabled={disabled} onClick={()=>onChange(null)} ariaLabel={label+'设为默认'}>设为默认</InputSettingsAction></div>;
}
export function FrequencyCoreControls({value={},onChange,ramanSupported=true,disabled=false}:{value?:TaskOptions['frequency'];onChange(value:NonNullable<TaskOptions['frequency']>):void;ramanSupported?:boolean;disabled?:boolean}){
  return <InputSettingsRow className="input-control-flow"><OptionalCoreNumber disabled={disabled} label="温度 / K" value={value.temperatureK} onChange={temperatureK=>onChange({...value,temperatureK})}/><OptionalCoreNumber disabled={disabled} label="压力 / atm" value={value.pressureAtm} onChange={pressureAtm=>onChange({...value,pressureAtm})}/><InputSettingsCheckbox ariaLabel="Raman" label="Raman" checked={value.raman===true} disabled={disabled||(!ramanSupported&&value.raman!==true)} onChange={raman=>onChange({...value,raman})}/></InputSettingsRow>;
}
export function GaussianOptimizationControls({settings,files,atomCount,updateSettings,updateFile}:{settings:GaussianSettings;files:FileSettings;atomCount?:number;updateSettings:<K extends keyof GaussianSettings>(key:K,value:GaussianSettings[K])=>void;updateFile:<K extends keyof FileSettings>(key:K,value:FileSettings[K])=>void}){
  const advanced=settings.advanced??defaultAdvanced(settings.task,excitedOptimizationFrequency(settings)),external=isXtb(settings.method),ts=settings.task==='ts';
  const change=<K extends keyof AdvancedSettings>(key:K,value:AdvancedSettings[K])=>updateSettings('advanced',{...advanced,[key]:value});
  const hessian=ts&&files.hessian==='none'?(external?xtbHessian(settings,files,atomCount):'calcfc'):files.hessian;
  return <><InputSettingsRow><InputSettingsField label="收敛标准"><select aria-label="优化收敛标准" value={excitedOptimizationFrequency(settings)&&advanced.optConvergence==='loose'?'default':advanced.optConvergence} onChange={event=>change('optConvergence',event.target.value as AdvancedSettings['optConvergence'])}><option value="default">程序默认</option><option value="loose" disabled={excitedOptimizationFrequency(settings)}>Loose</option><option value="tight">Tight</option><option value="verytight">VeryTight</option></select></InputSettingsField><div className="input-hessian-group"><InputSettingsField label="Hessian策略"><select aria-label="Hessian读取" value={hessian} onChange={event=>updateFile('hessian',event.target.value as FileSettings['hessian'])}>{!ts&&<option value="none">不额外计算</option>}<option value="calcfc">CalcFC</option><option value="calcall">CalcAll</option><option value="recalcfc">RecalcFC</option>{!external&&<><option value="readfc">ReadFC</option><option value="rcfc">RCFC</option></>}</select></InputSettingsField>{hessian==='recalcfc'&&<InputSettingsField label="RecalcFC 间隔"><NumericInput aria-label="RecalcFC间隔" stepper={true} min="1" step="1" value={files.recalcInterval??''} onChange={event=>updateFile('recalcInterval',event.target.value===''?null:Number(event.target.value))}/></InputSettingsField>}</div></InputSettingsRow><InputSettingsRow><OptionalCoreNumber label="优化步数" integer value={advanced.optMaxCycles} onChange={value=>change('optMaxCycles',value)}/><OptionalCoreNumber label="优化步长 / 0.01 Bohr" integer value={advanced.maxStep} onChange={value=>change('maxStep',value)}/></InputSettingsRow></>;
}
