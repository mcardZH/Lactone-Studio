import NumericInput from '../NumericInput';
import type {AdvancedOptimizationMethod,AdvancedXtbOptions} from '../../modeling/advanced/contracts';
import type {XtbMethod} from '../../modeling/xtb/contracts';
import {advancedMethodSolvents} from './solvation';
import {InputSettingsField,InputSettingsRow} from '../InputSettingsFields';
import {InputSettingsCheckbox} from '../InputSettingsLayout';

export const ADVANCED_METHODS=[['gfn2','GFN2-xTB'],['gfn1','GFN1-xTB'],['gfn0','GFN0-xTB'],['gfnff','GFN-FF'],['MMFF94','MMFF94'],['MMFF94s','MMFF94s'],['UFF','UFF']] as const;
/** The additional method is scoped to the approved molecular workflows; the
 * generic menus (including historical docking) retain their own capabilities. */
export const CONFORMER_OPTIMIZATION_METHODS=[...ADVANCED_METHODS.slice(0,4),['gxtb','g-xTB'] as const,...ADVANCED_METHODS.slice(4)] as const;
export const WAVEFUNCTION_METHODS=[['gfn2','GFN2-xTB'],['gxtb','g-xTB']] as const;
export type AdvancedMethodName=typeof ADVANCED_METHODS[number][0]|'gxtb';
export interface AdvancedMethodDraft{method:AdvancedMethodName;threads:number;maxSteps:number;sccIterationLimit:number;sccIterationLimitText?:string;solvationModel:'none'|'alpb'|'gbsa';solvent:string;internalConstraintsConfirmed:boolean}
export const initialAdvancedMethod:Readonly<AdvancedMethodDraft>=Object.freeze({method:'gfn2',threads:1,maxSteps:500,sccIterationLimit:250,solvationModel:'none',solvent:'water',internalConstraintsConfirmed:false});
const forcefield=(method:AdvancedMethodName)=>['MMFF94','MMFF94s','UFF'].includes(method);
export function compileAdvancedMethod(draft:AdvancedMethodDraft):AdvancedOptimizationMethod{
 if(!Number.isSafeInteger(draft.maxSteps)||draft.maxSteps<1)throw Error('优化步数超出所选方法范围。');
 if(!Number.isSafeInteger(draft.threads)||draft.threads<1)throw Error('线程数须为正整数。');
 if(forcefield(draft.method)){
  if(draft.threads!==1||draft.solvationModel!=='none')throw Error('分子力场使用单线程与气相，不支持该溶剂设置。');
  return{backend:'forcefield',forcefield:draft.method as 'MMFF94'|'MMFF94s'|'UFF',threads:1,maxSteps:draft.maxSteps,solvent:'none'};
 }
 if(draft.solvationModel!=='none'&&!advancedMethodSolvents(draft.method,draft.solvationModel).includes(draft.solvent))throw Error('所选方法未参数化该溶剂模型或溶剂。');
 const options:AdvancedXtbOptions={method:draft.method as XtbMethod,threads:draft.threads,maxSteps:draft.maxSteps,solvent:draft.solvationModel==='none'?'none':draft.solvent,internalConstraintsConfirmed:draft.internalConstraintsConfirmed,...(draft.solvationModel==='none'?{}:{solvation:{model:draft.solvationModel,solvent:draft.solvent}})};
 return{backend:'xtb',options};
}
export function compileAdvancedSinglepointOptions(draft:AdvancedMethodDraft):AdvancedXtbOptions{
 if(!['gfn2','gxtb'].includes(draft.method))throw Error('波函数生成请选择GFN2-xTB或g-xTB。');
 const scc=draft.sccIterationLimitText===undefined?draft.sccIterationLimit:Number(draft.sccIterationLimitText);
 if(draft.sccIterationLimitText!==undefined&&!/^\d+$/.test(draft.sccIterationLimitText.trim())||!Number.isSafeInteger(scc)||scc<1)throw Error('SCC迭代上限须为正整数。');
 if(draft.solvationModel==='gbsa')throw Error('历史GBSA设置已保留；生成前请选择气相或ALPB。');
 const method=compileAdvancedMethod(draft);
 if(method.backend!=='xtb')throw Error('XTB波函数单点方法无效。');
 return {...method.options,maxSccIterations:scc};
}
export function changeAdvancedMethod(draft:AdvancedMethodDraft,method:AdvancedMethodName):AdvancedMethodDraft{
 // Changing the method must not silently replace a visible scientific draft.
 // The corresponding submission boundary reports an incompatible medium.
 return {...draft,method,...(forcefield(method)?{threads:1,maxSteps:draft.maxSteps}:{})};
}
export function AdvancedMethodControls(p:{value:AdvancedMethodDraft;onChange(value:AdvancedMethodDraft):void;prefix:string;singlepoint?:boolean;hasCoordinates?:boolean;hideThreads?:boolean;hideMethod?:boolean}){
 const value=p.value,isForcefield=forcefield(value.method);
 const update=(patch:Partial<AdvancedMethodDraft>)=>p.onChange({...value,...patch});
 return <><InputSettingsRow className="shared-input-row-compact">{!p.hideMethod&&<InputSettingsField label="方法"><select aria-label={`${p.prefix}方法`} value={value.method} disabled={p.singlepoint} onChange={event=>p.onChange(changeAdvancedMethod(value,event.target.value as AdvancedMethodName))}>{ADVANCED_METHODS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></InputSettingsField>}
  {p.singlepoint?<InputSettingsField label="SCC迭代上限"><NumericInput aria-label={`${p.prefix}SCC迭代上限`}  min="1" step="1" value={value.sccIterationLimit} onChange={event=>update({sccIterationLimit:Number(event.target.value)})}/></InputSettingsField>:<InputSettingsField label="优化步数"><NumericInput aria-label={`${p.prefix}优化步数`}  min="1" value={value.maxSteps} onChange={event=>update({maxSteps:Number(event.target.value)})}/></InputSettingsField>}
  <InputSettingsField label="溶剂模型"><select aria-label={`${p.prefix}溶剂模型`} value={value.solvationModel} onChange={event=>{const model=event.target.value as AdvancedMethodDraft['solvationModel'];update({solvationModel:model,...(model!=='none'&&!advancedMethodSolvents(value.method,model).includes(value.solvent)?{solvent:'water'}:{})});}}><option value="none">气相</option><option value="alpb" disabled={!advancedMethodSolvents(value.method,'alpb').length}>ALPB</option><option value="gbsa" disabled={!advancedMethodSolvents(value.method,'gbsa').length}>GBSA</option></select></InputSettingsField>
  {value.solvationModel!=='none'&&<InputSettingsField label="溶剂"><select aria-label={`${p.prefix}溶剂`} value={value.solvent} onChange={event=>update({solvent:event.target.value})}>{advancedMethodSolvents(value.method,value.solvationModel).map(name=><option key={name} value={name}>{name}</option>)}</select></InputSettingsField>}
 </InputSettingsRow>{isForcefield&&<p className="muted-note">单线程</p>}{!p.singlepoint&&p.hasCoordinates&&<InputSettingsCheckbox checked={value.internalConstraintsConfirmed} onChange={internalConstraintsConfirmed=>update({internalConstraintsConfirmed})} label="确认使用当前内坐标冻结约束"/>}</>;
}
