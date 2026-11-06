import {DismissibleNotice} from './DismissibleNotice';
import NumericInput from './NumericInput';
import { useState } from 'react';
import type { Structure } from '../core/types';
import { defaultOniomSettings, oniomBoundaryCandidates, oniomFromStructure, type GaussianOniomBoundary, type GaussianOniomSettings } from '../core/oniom';
import type { TaskSelectionHandle, TaskSelectionIntent } from '../modeling/contracts';
import { inputSelectionIndices } from '../core/input-selection';
import InteractiveSelectionField from './InteractiveSelectionField';
import type { AtomPickerRequest } from './AtomPickerModal';

export interface OniomOptionsProps {
  settings:GaussianOniomSettings;
  structure:Structure|null;
  /** Current viewer selection is zero based. */
  selection:number[];
  onChange:(settings:GaussianOniomSettings)=>void;
  taskId?:string;
  onRequestSelection?:(intent:TaskSelectionIntent)=>TaskSelectionHandle|void;
  onPick?:(request:AtomPickerRequest)=>void;
}
const numberOrNull=(value:string)=>value.trim()===''?null:Number(value);
export default function OniomOptions({settings,structure,selection,onChange,taskId,onRequestSelection,onPick}:OniomOptionsProps){
  const indices=structure?.atoms.flatMap((atom,i)=>atom.id&&settings.qmAtomIds.includes(atom.id)?[i]:[])??[];
  const [showTypes,setShowTypes]=useState(false);
  const update=(patch:Partial<GaussianOniomSettings>,preserveConfirmation=false)=>onChange({...settings,...patch,...(preserveConfirmation?{}:{statesConfirmed:false})});
  const setQm=(ids:string[])=>{
    if(!structure)throw new Error('结构已失效。');
    inputSelectionIndices(structure,ids);
    update({qmAtomIds:[...ids],boundaries:[]});
  };
  const candidates=oniomBoundaryCandidates(structure,settings.qmAtomIds);
  const proposed=candidates.map(candidate=>settings.boundaries.find(boundary=>boundary.qmAtomId===candidate.qmAtomId&&boundary.lowAtomId===candidate.lowAtomId)??({qmAtomId:candidate.qmAtomId,lowAtomId:candidate.lowAtomId,linkElement:'H',scaleLow:null,scaleHigh:null,confirmed:false} satisfies GaussianOniomBoundary));
  const stale=settings.boundaries.filter(boundary=>!candidates.some(candidate=>candidate.qmAtomId===boundary.qmAtomId&&candidate.lowAtomId===boundary.lowAtomId));
  const setBoundary=(index:number,patch:Partial<GaussianOniomBoundary>,confirmation=false)=>update({boundaries:proposed.map((boundary,i)=>i===index?{...boundary,...patch,...(confirmation?{}:{confirmed:false})}:boundary).concat(stale)});
  const setState=(name:'modelHigh'|'modelLow',key:'charge'|'multiplicity',value:string)=>update({[name]:{...settings[name],[key]:value.trim()===''?Number.NaN:Number(value)}});
  const atomNumber=(id:string)=>{const i=structure?.atoms.findIndex(atom=>atom.id===id)??-1;return i<0?'失效':String(i+1);};
  const missingId=structure?.atoms.some(atom=>!atom.id);
  const qmMembersCurrent=(()=>{try{return !!structure&&settings.qmAtomIds.length>0&&inputSelectionIndices(structure,settings.qmAtomIds).length===settings.qmAtomIds.length;}catch{return false;}})();
  return <details className="mixed-basis-options task-specific" data-field="oniom" data-testid="oniom-options" open={settings.enabled||undefined}>
    <summary>ONIOM · QM / UFF 分层</summary>
    <div className="mixed-basis-heading"><label className="check-line"><input type="checkbox" aria-label="启用ONIOM" checked={settings.enabled} disabled={!structure||missingId} onChange={event=>update({enabled:event.target.checked},true)}/><span>启用Gaussian ONIOM-UFF</span></label><button type="button" className="text-button" onClick={()=>onChange(defaultOniomSettings())}>恢复ONIOM默认</button></div>
    {!structure&&<p className="muted-note">请先导入完整三维结构，再分配QM区域。</p>}
    {missingId&&<DismissibleNotice className="mixed-basis-error" role="alert">结构缺少稳定原子ID，不能可靠保存分层。</DismissibleNotice>}
    {settings.enabled&&structure&&<>
      <InteractiveSelectionField label="ONIOM QM" structure={structure} engine="gaussian" purpose="layer" rowId="gaussian-oniom-high" taskId={taskId} atomIds={settings.qmAtomIds} contextKey={`${taskId}:${settings.enabled}`} disabled={missingId} onRequestSelection={onRequestSelection} onPick={onPick} onClear={()=>setQm([])} clearLabel="清空定义" clearDisabled={!settings.qmAtomIds.length} remainingAtomIds={structure.atoms.flatMap(atom=>atom.id&&!settings.qmAtomIds.includes(atom.id)?[atom.id]:[])} draftChoices={[{label:'采用当前选区',atomIds:selection.flatMap(index=>structure.atoms[index]?.id?[structure.atoms[index].id!]:[])}]} onConfirm={(ids,assertCurrent)=>{assertCurrent();setQm(ids);}}/>
      <div className="mixed-basis-actions">{!settings.qmAtomIds.length&&structure.modelLayers?.some(layer=>layer.kind==='qm')&&<button type="button" className="button button-white" onClick={()=>onChange(oniomFromStructure(settings,structure))}>使用结构已有可信QM分区</button>}</div>
      <p className="muted-note" title="计数为真实原子；link仅用于计算模型。">QM {indices.length} · 低层 {structure.atoms.length-indices.length} · 跨层键 {candidates.length}</p>
      {!qmMembersCurrent&&<p className="muted-note">确认有效QM区域成员后，显示电荷、嵌入与边界参数；QM方法和基组沿当前计算级别。</p>}
      {qmMembersCurrent&&<>
      <label className="check-line" title="冻结全部低层真实原子，输出物理-1并叠加已启用的逐原子冻结。"><input type="checkbox" aria-label="冻结ONIOM低层" checked={settings.freezeLowLayer} onChange={event=>update({freezeLowLayer:event.target.checked},true)}/><span>冻结低层</span></label>
      {!['file','drawn'].includes(structure.bondSource??'')&&<label className="check-line" title="请逐项复核当前共价键图与键级后确认。"><input type="checkbox" aria-label="确认ONIOM实际键图" checked={settings.topologyConfirmed} onChange={event=>update({topologyConfirmed:event.target.checked})}/><span>已核对实际键图与键级</span></label>}
      <div className="two-fields"><label className="field">MM电荷来源<select aria-label="ONIOM MM电荷来源" value={settings.chargeSource} onChange={event=>update({chargeSource:event.target.value as GaussianOniomSettings['chargeSource']})}><option value="none">原生默认：不分配MM部分电荷</option><option value="qeq">Gaussian原生QEq</option><option value="provided">提供原生类型和每原子部分电荷</option></select></label><label className="field">嵌入方式<select aria-label="ONIOM嵌入方式" value={settings.embedding} onChange={event=>update({embedding:event.target.value as GaussianOniomSettings['embedding']})}><option value="mechanical">机械嵌入（原生默认）</option><option value="electronic">电子嵌入（需要MM电荷来源）</option></select></label></div>
      <div className="two-fields">{(['modelHigh','modelLow'] as const).map(name=><fieldset key={name} title="模型包含QM真实原子及已定义的link原子。完整真实体系的电荷/多重度在外部电子态卡设置。"><legend>{name==='modelHigh'?'模型高层电子态':'模型低层电子态'}</legend><label className="field">电荷<NumericInput stepper={true} step="1" aria-label={'ONIOM'+name+'电荷'} value={Number.isFinite(settings[name].charge)?settings[name].charge:''} onChange={event=>setState(name,'charge',event.target.value)}/></label><label className="field">多重度<NumericInput stepper={true} min="1" step="1" aria-label={'ONIOM'+name+'多重度'} value={Number.isFinite(settings[name].multiplicity)?settings[name].multiplicity:''} onChange={event=>setState(name,'multiplicity',event.target.value)}/></label></fieldset>)}</div>
      {candidates.length>0&&<details open><summary>跨共价边界 · 每条明确链接</summary>{candidates.map((candidate,index)=>{const boundary=proposed[index];return <fieldset key={candidate.qmAtomId+'\0'+candidate.lowAtomId} data-testid="oniom-boundary" title={'link替代低层'+candidate.lowIndex+'并连接QM'+candidate.qmIndex+'；边界与当前实际键绑定。'}><legend>QM {candidate.qmIndex} → 低层 {candidate.lowIndex} · 键级{candidate.order}{candidate.aromatic?'（芳香）':''}</legend><div className="two-fields"><label className="field">链接元素<input aria-label={'ONIOM边界'+(index+1)+'link元素'} value={boundary.linkElement} onChange={event=>setBoundary(index,{linkElement:event.target.value})}/></label><label className="field">链接Gaussian UFF类型（可选）<input aria-label={'ONIOM边界'+(index+1)+'link类型'} value={boundary.linkAtomType??''} placeholder="自动分型时留空" onChange={event=>setBoundary(index,{linkAtomType:event.target.value})}/></label></div><div className="two-fields"><label className="field">模型低层缩放<NumericInput stepper={false} min="0" step="any" aria-label={'ONIOM边界'+(index+1)+'低层缩放'} value={boundary.scaleLow??''} placeholder="留空/0：原生自动" onChange={event=>setBoundary(index,{scaleLow:numberOrNull(event.target.value)})}/></label><label className="field">模型高层缩放<NumericInput stepper={false} min="0" step="any" aria-label={'ONIOM边界'+(index+1)+'高层缩放'} value={boundary.scaleHigh??''} placeholder="留空：继承低层/原生自动" onChange={event=>setBoundary(index,{scaleHigh:numberOrNull(event.target.value)})}/></label></div>{settings.chargeSource==='provided'&&<label className="field">链接部分电荷 / e<NumericInput stepper={true} step="any" aria-label={'ONIOM边界'+(index+1)+'link部分电荷'} value={boundary.linkPartialCharge??''} onChange={event=>setBoundary(index,{linkPartialCharge:numberOrNull(event.target.value)})}/></label>}<label className="check-line"><input type="checkbox" aria-label={'确认ONIOM边界'+(index+1)} checked={boundary.confirmed} onChange={event=>setBoundary(index,{confirmed:event.target.checked},true)}/><span>已核对 QM {candidate.qmIndex}–低层 {candidate.lowIndex} 的link目标及缩放</span></label></fieldset>;})}</details>}
      {stale.length>0&&<DismissibleNotice className="mixed-basis-error" role="alert">存在 {stale.length} 条失效旧链接（{stale.map(boundary=>atomNumber(boundary.qmAtomId)+'–'+atomNumber(boundary.lowAtomId)).join(', ')}）。<button type="button" className="text-button" onClick={()=>update({boundaries:settings.boundaries.filter(boundary=>!stale.includes(boundary))})}>移除失效链接</button></DismissibleNotice>}
      <details open={settings.chargeSource==='provided'||showTypes||undefined}><summary>原生UFF类型 / 部分电荷</summary><label className="check-line" title="留空由Gaussian尝试自动分型；显式填写使用原生Gaussian UFF格式。"><input type="checkbox" aria-label="编辑ONIOM显式类型" checked={showTypes} onChange={event=>setShowTypes(event.target.checked)}/><span>编辑显式Gaussian UFF类型</span></label>{(showTypes||settings.chargeSource==='provided')&&structure.atoms.map((atom,index)=>atom.id&&<div className="two-fields" key={atom.id}><label className="field">{index+1} {atom.element} UFF类型<input aria-label={'ONIOM原子'+(index+1)+'UFF类型'} value={settings.atomTypes[atom.id]??''} onChange={event=>update({atomTypes:{...settings.atomTypes,[atom.id!]:event.target.value}})}/></label>{settings.chargeSource==='provided'&&<label className="field" title="单位e；与原子形式电荷分开设置。">部分电荷 / e<NumericInput stepper={true} step="any" aria-label={'ONIOM原子'+(index+1)+'部分电荷'} value={settings.partialCharges[atom.id]??''} onChange={event=>update({partialCharges:{...settings.partialCharges,[atom.id!]:numberOrNull(event.target.value)}})}/></label>}</div>)}</details>
      <label className="check-line"><input type="checkbox" aria-label="确认ONIOM模型电子态" checked={settings.statesConfirmed} onChange={event=>update({statesConfirmed:event.target.checked},true)}/><span>已核对分区、link模型、两套模型电荷自旋以及MM电荷来源</span></label>
      <details className="oniom-parameter-help"><summary>参数说明</summary><p className="muted-note">QM使用当前方法和基组，低层使用UFF。模型高、低层均含QM真实原子和link；完整体系电子态在外部卡片设置。</p><p className="muted-note">link替代边界低层原子并连接对应QM原子，仅用于计算模型。缩放留空或低层填0时沿用Gaussian原生自动规则。</p><p className="muted-note">{settings.chargeSource==='none'?'不分配MM部分电荷时，无MM库仑静电项。':settings.chargeSource==='qeq'?'QEq由Gaussian在初始几何计算，优化中保持不变。':'显式电荷路线需每个原子的Gaussian UFF类型和部分电荷（e）。部分电荷与形式电荷分开设置。'}{settings.embedding==='electronic'?' 电子嵌入按Gaussian原生规则屏蔽距QM两键内的MM电荷。':''}</p><p className="muted-note">UFF类型留空时由Gaussian尝试自动分型；显式类型使用Gaussian原生标签，并按实际化学环境核对参数。</p></details>
      </>}
    </>}
  </details>;
}
