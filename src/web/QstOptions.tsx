import {DismissibleNotice} from './DismissibleNotice';
import { useState } from 'react';
import type { GaussianQstSettings, InputStructureSource, JobRequest } from '../core/types';
import { confirmQstMapping, defaultGaussianQstSettings, isQstTask, qstInputErrors, qstTargetContext } from '../core/gaussian-qst';
import MultiStructureSourcePicker, { inputStructureSourceIsCurrent } from './MultiStructureSourcePicker';
import type { MultiStructureSourceActions } from './MultiStructureSourcePicker';

export interface QstOptionsProps extends MultiStructureSourceActions {
  request:JobRequest;sourceCandidates:InputStructureSource[];onChange(value:GaussianQstSettings):void;
  /** Snapshot binding only; neither this widget nor this callback replaces
   * coordinates, switches task owner or silently copies electronic state. */
  onReactantSourceChange?(source:InputStructureSource|null):void;
  currentReactantSource?:InputStructureSource|null;
}
export default function QstOptions({request,sourceCandidates,onChange,onReactantSourceChange,onRequestSourcePick,onImportSources}:QstOptionsProps){
  const [error,setError]=useState('');if(!isQstTask(request.settings.task))return null;
  const q=request.settings.qst??defaultGaussianQstSettings(),third=request.settings.task==='qst3';
  const taskLabel=request.settings.task.toUpperCase();
  const sourceActions={onRequestSourcePick,onImportSources};
  const change=(patch:Partial<GaussianQstSettings>)=>{setError('');onChange({...q,...patch,mappingConfirmed:false,targetContext:''});};
  const slots=[q.reactantSource,q.product,...(third?[q.tsGuess]:[])],current=slots.every(source=>inputStructureSourceIsCurrent(source,sourceCandidates));
  const proposed={...q,mappingConfirmed:true,targetContext:qstTargetContext(request)},ready=current&&qstInputErrors({...request,settings:{...request.settings,qst:proposed}}).length===0;
  const confirmed=q.mappingConfirmed===true&&q.targetContext===qstTargetContext(request)&&ready;
  const reactantAtoms=q.reactantSource?.structure.atoms??[];
  const numberedSources=[q.product,...(third?[q.tsGuess]:[])];
  const numberedMappingReady=current&&reactantAtoms.length>0&&reactantAtoms.every(atom=>!!atom.id)&&numberedSources.every(source=>!!source&&source.structure.atoms.length===reactantAtoms.length&&source.structure.atoms.every((atom,index)=>!!atom.id&&atom.element===reactantAtoms[index].element));
  const mapCurrentNumbers=()=>{if(!numberedMappingReady)return;change({mapping:reactantAtoms.map((atom,index)=>({reactantId:atom.id!,productId:q.product!.structure.atoms[index].id!,...(third?{tsGuessId:q.tsGuess!.structure.atoms[index].id!}:{})}))});};
  const pair=(id:string,key:'productId'|'tsGuessId',value:string)=>change({mapping:[...q.mapping.filter(p=>p.reactantId!==id),{...(q.mapping.find(p=>p.reactantId===id)??{reactantId:id,productId:''}),[key]:value}]});
  return <section className="qst-options" data-field="qst" aria-label={`${request.settings.task.toUpperCase()}多结构来源`}>
    <h4>{request.settings.task.toUpperCase()} · 独立同一势能面搜索</h4><p className="muted-note">首批仅有限、非周期、普通单层DFT及同电子态。所有结构按确认映射输出同序，不删除或重排来源原件。{third?'第三结构是TS猜测，不要求冒称已验TS。':''}不叠加Opt=TS、不生成Link1。</p>
    <details open><summary>选择结构</summary><p className="muted-note">每个角色独立选择真实结构快照；选择反应物只改变本任务来源，不替换所属文档模型或迁移任务。各结构须采用本任务相同的电荷与多重度。</p>
      <MultiStructureSourcePicker {...sourceActions} label={`${taskLabel} · 反应物来源`} value={q.reactantSource} candidates={sourceCandidates} onChange={source=>{change({reactantSource:source,mapping:[]});onReactantSourceChange?.(source);}}/>
      <MultiStructureSourcePicker {...sourceActions} label={`${taskLabel} · 产物来源`} value={q.product} candidates={sourceCandidates} onChange={source=>change({product:source,mapping:[]})}/>
      {third&&<MultiStructureSourcePicker {...sourceActions} label={`${taskLabel} · 过渡态初猜来源`} value={q.tsGuess} candidates={sourceCandidates} onChange={source=>change({tsGuess:source,mapping:[]})}/>}
    </details>
    <details open><summary>逐原子一一对应（界面编号从1开始）</summary><p className="muted-note">同元素次序不是物理身份；逐项选择对应，或在逐位元素一致时明确按当前编号填入，再核对并确认。</p>
      <button type="button" className="text-button" disabled={!numberedMappingReady} onClick={mapCurrentNumbers}>按当前编号对应</button>
      {!numberedMappingReady&&<p className="muted-note">需先选齐当前有效来源，且原子数量和逐位元素一致；编号不一致时请逐项选择映射。</p>}
      {reactantAtoms.map((atom,index)=><div className="two-fields" key={atom.id??index}>
        <label className="field">R {index+1} {atom.element} → Product<select aria-label={`QST反应物${index+1}的Product映射`} value={q.mapping.find(p=>p.reactantId===atom.id)?.productId??''} onChange={event=>pair(atom.id!,'productId',event.target.value)}><option value="">请选择对应原子</option>{q.product?.structure.atoms.map((a,j)=><option key={a.id} value={a.id}>{j+1} {a.element}</option>)}</select></label>
        {third&&<label className="field">→ TS猜测<select aria-label={`QST反应物${index+1}的TS猜测映射`} value={q.mapping.find(p=>p.reactantId===atom.id)?.tsGuessId??''} onChange={event=>pair(atom.id!,'tsGuessId',event.target.value)}><option value="">请选择对应原子</option>{q.tsGuess?.structure.atoms.map((a,j)=><option key={a.id} value={a.id}>{j+1} {a.element}</option>)}</select></label>}
      </div>)}
    </details>
    <label className="check-line"><input type="checkbox" aria-label="QST追加最终频率" checked={q.frequency===true} onChange={event=>change({frequency:event.target.checked})}/>明确追加目标级别最终频率（不认证TS、不自动IRC）</label>
    <label className="check-line"><input type="checkbox" aria-label="确认QST原子对应与同一电子态条件" checked={confirmed} disabled={!ready&&!confirmed} onChange={event=>{if(!event.target.checked){change({});return;}try{onChange(confirmQstMapping(request));setError('');}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}}/>已核对真实来源、完整一一对应、同电子态和当前共享科学条件</label>
    {error&&<DismissibleNotice role="alert" className="inline-selection-error">{error}</DismissibleNotice>}{!ready&&!confirmed&&<p className="muted-note">请补齐来源、当前反应物与所有映射；普通TS、Hessian或基础态确认不替代本任务来源核对。</p>}
  </section>;
}
