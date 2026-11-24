import NumericInput from '../NumericInput';
import type {AdvancedOptimizationMethod,AdvancedXtbOptions} from '../../modeling/advanced/contracts';
import type {XtbMethod} from '../../modeling/xtb/contracts';
import {advancedMethodSolvents} from './solvation';
import {InputSettingsField,InputSettingsRow} from '../InputSettingsFields';
import {InputSettingsCheckbox} from '../InputSettingsLayout';

export const ADVANCED_METHODS=[['gfn2','GFN2-xTB'],['gfn1','GFN1-xTB'],['gfn0','GFN0-xTB'],['gfnff','GFN-FF']] as const;
/** The additional method is scoped to the approved molecular workflows; the
 * generic menus (including historical docking) retain their own capabilities. */
export const CONFORMER_OPTIMIZATION_METHODS=[...ADVANCED_METHODS,['gxtb','g-xTB'] as const] as const;
export const WAVEFUNCTION_METHODS=[['gfn2','GFN2-xTB'],['gxtb','g-xTB']] as const;
export type AdvancedMethodName=typeof ADVANCED_METHODS[number][0]|'gxtb';
export interface AdvancedMethodDraft{method:AdvancedMethodName;threads:number;maxSteps:number;sccIterationLimit:number;sccIterationLimitText?:string;solvationModel:'none'|'alpb'|'gbsa';solvent:string;internalConstraintsConfirmed:boolean}
export const initialAdvancedMethod:Readonly<AdvancedMethodDraft>=Object.freeze({method:'gfn2',threads:1,maxSteps:500,sccIterationLimit:250,solvationModel:'none',solvent:'water',internalConstraintsConfirmed:false});
export function compileAdvancedMethod(draft:AdvancedMethodDraft):Extract<AdvancedOptimizationMethod,{backend:'xtb'}>{
 if(!Number.isSafeInteger(draft.maxSteps)||draft.maxSteps<1)throw Error('优化步数超出所选方法范围。');
 if(!Number.isSafeInteger(draft.threads)||draft.threads<1)throw Error('线程数须为正整数。');
 if(draft.solvationModel==='gbsa')throw Error('GBSA 为历史设置。新运行请选择气相或 ALPB。');
 if(draft.solvationModel!=='none'&&!advancedMethodSolvents(draft.method,draft.solvationModel).includes(draft.solvent))throw Error('所选方法未参数化该溶剂模型或溶剂。');
 const options:AdvancedXtbOptions={method:draft.method,threads:draft.threads,maxSteps:draft.maxSteps,solvent:draft.solvationModel==='none'?'none':draft.solvent,internalConstraintsConfirmed:draft.internalConstraintsConfirmed,...(draft.solvationModel==='none'?{}:{solvation:{model:draft.solvationModel,solvent:draft.solvent}})};
 return{backend:'xtb',options};
}
export function compileAdvancedSinglepointOptions(draft:AdvancedMethodDraft):AdvancedXtbOptions{
 if(!['gfn2','gxtb'].includes(draft.method))throw Error('波函数生成请选择GFN2-xTB或g-xTB。');
 const scc=draft.sccIterationLimitText===undefined?draft.sccIterationLimit:Number(draft.sccIterationLimitText);
 if(draft.sccIterationLimitText!==undefined&&!/^\d+$/.test(draft.sccIterationLimitText.trim())||!Number.isSafeInteger(scc)||scc<1)throw Error('SCC迭代上限须为正整数。');
 if(draft.solvationModel==='gbsa')throw Error('历史GBSA设置已保留；生成前请选择气相或ALPB。');
 if(!Number.isSafeInteger(draft.threads)||draft.threads<1)throw Error('线程数须为正整数。');
 if(draft.solvationModel==='alpb'&&!advancedMethodSolvents(draft.method,'alpb').includes(draft.solvent))throw Error('所选方法未参数化该 ALPB 溶剂。');
 return {method:draft.method,threads:draft.threads,maxSccIterations:scc,internalConstraintsConfirmed:false,
  solvent:draft.solvationModel==='alpb'?draft.solvent:'none',...(draft.solvationModel==='alpb'?{solvation:{model:'alpb',solvent:draft.solvent}}:{})};
}
export function changeAdvancedMethod(draft:AdvancedMethodDraft,method:AdvancedMethodName):AdvancedMethodDraft{
 // Changing the method must not silently replace a visible scientific draft.
 // The corresponding submission boundary reports an incompatible medium.
 return {...draft,method};
}
export function AdvancedMethodControls(p:{value:AdvancedMethodDraft;onChange(value:AdvancedMethodDraft):void;prefix:string;singlepoint?:boolean;hasCoordinates?:boolean;hideThreads?:boolean;hideMethod?:boolean}){
 const value=p.value;
 const update=(patch:Partial<AdvancedMethodDraft>)=>p.onChange({...value,...patch});
 return <><InputSettingsRow className="shared-input-row-compact">{!p.hideMethod&&<InputSettingsField label="方法"><select aria-label={`${p.prefix}方法`} value={value.method} disabled={p.singlepoint} onChange={event=>p.onChange(changeAdvancedMethod(value,event.target.value as AdvancedMethodName))}>{ADVANCED_METHODS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></InputSettingsField>}
  {p.singlepoint?<InputSettingsField label="SCC迭代上限"><NumericInput aria-label={`${p.prefix}SCC迭代上限`}  min="1" step="1" value={value.sccIterationLimit} onChange={event=>update({sccIterationLimit:Number(event.target.value)})}/></InputSettingsField>:<InputSettingsField label="优化步数"><NumericInput aria-label={`${p.prefix}优化步数`}  min="1" value={value.maxSteps} onChange={event=>update({maxSteps:Number(event.target.value)})}/></InputSettingsField>}
  <InputSettingsField label="溶剂模型"><select aria-label={`${p.prefix}溶剂模型`} value={value.solvationModel} onChange={event=>{const model=event.target.value as 'none'|'alpb';update({solvationModel:model,...(model==='alpb'&&!advancedMethodSolvents(value.method,model).includes(value.solvent)?{solvent:'water'}:{})});}}><option value="none">气相</option><option value="alpb" disabled={!advancedMethodSolvents(value.method,'alpb').length}>ALPB</option>{value.solvationModel==='gbsa'&&<option value="gbsa" disabled>GBSA · 历史设置</option>}</select></InputSettingsField>
  {value.solvationModel!=='none'&&<InputSettingsField label="溶剂"><select aria-label={`${p.prefix}溶剂`} value={value.solvent} onChange={event=>update({solvent:event.target.value})}>{advancedMethodSolvents(value.method,value.solvationModel).map(name=><option key={name} value={name}>{name}</option>)}</select></InputSettingsField>}
 </InputSettingsRow>{!p.singlepoint&&p.hasCoordinates&&<InputSettingsCheckbox checked={value.internalConstraintsConfirmed} onChange={internalConstraintsConfirmed=>update({internalConstraintsConfirmed})} label="确认使用当前内坐标冻结约束"/>}</>;
}
