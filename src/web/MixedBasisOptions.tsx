import {DismissibleNotice} from './DismissibleNotice';
import { RotateCcw } from 'lucide-react';
import { angularBasisPlan, basisElementCount, type FForm } from '../core/basis';
import { defaultSettings } from '../core/gaussian';
import { canonicalBasis } from '../core/catalog';
import { defaultMixedBasis, MIXED_BASES, mixedBasisSize, type BasisRegion, type MixedBasisSettings } from '../core/mixed-basis';
import { formatAtomSelection } from '../core/structures';
import type { FragmentDefinition, GaussianSettings, Structure } from '../core/types';
import CardDropdown from './CardDropdown';
import type { AtomPickerRequest } from './AtomPickerModal';
import InteractiveSelectionField, { SelectionGroupHeader, SelectionAddButton, SelectionRemoveButton, type InteractiveSelectionFieldProps } from './InteractiveSelectionField';
import { applyRegionSelection, planRegionSelection, remainingRegionAtomIds, regionSelectionIdentityError } from '../modeling/application/region-selection';
import { inputSelectionIndices } from '../core/input-selection';
import './mixed-basis.css';

export interface MixedBasisOptionsProps {
  structure:Structure|null;
  globalBasis:string;
  value?:MixedBasisSettings;
  /** Complete form supplies explicit 5D and inherited shells; optional for older callers. */
  gaussianSettings?:GaussianSettings;
  selected:number[];
  fragments?:FragmentDefinition[];
  disabledReason?:string;
  onChange:(value:MixedBasisSettings)=>void;
  onPick:(request:AtomPickerRequest)=>void;
  onRequestSelection?:InteractiveSelectionFieldProps['onRequestSelection'];
}
const numberedIds=(structure:Structure,numbers:readonly number[])=>numbers.map(number=>structure.atoms[number-1]?.id??'invalid-number:'+number);
function RegionEditor({region,index,structure,dForm,fForm,selected,fragments,onChange,onDelete,onPick,onRequestSelection,taskId,settings,onCommit,remaining}:{region:BasisRegion;index:number;structure:Structure;dForm:'5D'|'6D';fForm:FForm;selected:number[];fragments:FragmentDefinition[];onChange:(region:BasisRegion)=>void;onDelete:()=>void;onPick:MixedBasisOptionsProps['onPick'];onRequestSelection?:MixedBasisOptionsProps['onRequestSelection'];taskId?:string;settings:MixedBasisSettings;onCommit:InteractiveSelectionFieldProps['onConfirm'];remaining:string[]}){
  const total=region.atoms.map(number=>structure.atoms[number-1]).filter(Boolean).map(atom=>basisElementCount(region.basis,atom.element,dForm));
  const count=fForm==='7F'&&total.length&&total.every(value=>value!==null)?total.reduce<number>((sum,value)=>sum+value!,0):null;
  const choices=[{label:'使用当前选择',atomIds:selected.map(i=>structure.atoms[i]?.id??'invalid-index:'+i)},...[...new Set(structure.atoms.map(atom=>atom.element))].map(element=>({label:'按元素 '+element,atomIds:structure.atoms.filter(atom=>atom.element===element).map(atom=>atom.id!)})),...fragments.map((fragment,i)=>({label:'使用片段'+(i+1)+'范围',atomIds:numberedIds(structure,fragment.atoms)}))];
  return <article className="mixed-basis-region shared-input-card shared-input-subcard" data-testid="basis-region" data-region-id={region.id}>
    <div className="mixed-basis-region-title shared-input-card-header"><SelectionGroupHeader title={`基${index+1}`} actions={<SelectionRemoveButton label={'删除基组区域'+(index+1)} onClick={onDelete}/>}/></div>
    <InteractiveSelectionField structure={structure} label={'基组区域'+(index+1)} rowId={region.id} engine="gaussian" purpose="basis" taskId={taskId} atomIds={numberedIds(structure,region.atoms)} contextKey={JSON.stringify(settings)} onRequestSelection={onRequestSelection} onPick={onPick} onConfirm={onCommit} remainingAtomIds={remaining} draftChoices={choices}/>
    {!region.atoms.length?<p className="interactive-selection-empty">空区域草稿：确认成员后设置基组；被覆盖移空的区域和原参数仍保留。</p>:<div className="selection-region-settings">
      <label className="field">区域名称<input aria-label={'基组区域'+(index+1)+'名称'} value={region.name} onChange={event=>onChange({...region,name:event.target.value})}/></label>
      <CardDropdown label={'区域'+(index+1)+'内置基组'} value={canonicalBasis(region.basis)} layout="catalog" onChange={basis=>onChange({...region,basis})} options={MIXED_BASES.map(basis=>({value:basis.value,label:basis.label,body:<><p>{basis.description}</p><small>按本任务统一{dForm} / {fForm}计数；仅输出实际所选原子中心。</small></>}))}/>
      <output className="mixed-basis-count">{region.atoms.length} 个原子 · {count===null?'基函数数待核实':count+' 个基函数'}</output>
    </div>}
  </article>;
}
export function selectMixedAngular(settings:MixedBasisSettings,dForm:'5D'|'6D'):MixedBasisSettings{return {...settings,dForm,angularExplicit:true};}
export default function MixedBasisOptions({structure,globalBasis,value,gaussianSettings,selected,fragments=[],disabledReason,onChange,onPick,onRequestSelection}:MixedBasisOptionsProps){
  const settings=value??defaultMixedBasis(),angular=angularBasisPlan({...gaussianSettings??defaultSettings('opt'),basis:globalBasis,mixedBasis:settings}),size=mixedBasisSize(structure,globalBasis,settings,angular.dForm,angular.fForm);
  const update=(patch:Partial<MixedBasisSettings>)=>onChange({...settings,...patch});
  const rows=structure?settings.regions.map((row,i)=>({...row,label:'基'+(i+1),atomIds:numberedIds(structure,row.atoms)})):[];
  function commit(id:string,ids:string[],guard:()=>void,overwrite:boolean){
    if(!structure)throw new Error('请先提供结构。');
    const next=applyRegionSelection(rows,planRegionSelection(structure,rows,id,ids),overwrite,guard);
    update({regions:settings.regions.map(row=>({...row,atoms:inputSelectionIndices(structure,next.find(value=>value.id===row.id)!.atomIds).map(i=>i+1).sort((a,b)=>a-b)}))});
  }
  const overlaps=new Map<number,number>();
  for(const region of settings.regions)for(const atom of new Set(region.atoms))overlaps.set(atom,(overlaps.get(atom)??0)+1);
  const overlapping=[...overlaps].filter(([,count])=>count>1).map(([atom])=>atom);
  const locked=disabledReason||(!structure?'请先导入完整显式结构。':'');
  const addRegion=()=>update({regions:[...settings.regions,{id:globalThis.crypto?.randomUUID?.()??'basis-'+Date.now()+'-'+Math.random(),name:'基'+(settings.regions.length+1),basis:MIXED_BASES.some(basis=>basis.value===canonicalBasis(globalBasis))?canonicalBasis(globalBasis):'def2SVP',atoms:[]}]});
  if(!settings.enabled)return null;
  return <section className="mixed-basis-options" data-field="mixed-basis" data-testid="mixed-basis-options">
    <div className="mixed-basis-heading"><SelectionGroupHeader title={`混合基组区域（${settings.regions.length}）`} actions={<><SelectionAddButton label="添加基组区域" testId="add-basis-region" disabled={!structure||!!locked} onClick={addRegion}/>{settings.regions.length>0&&<button type="button" className="text-button" onClick={()=>onChange({...defaultMixedBasis(),enabled:true})}><RotateCcw size={14}/>清空区域</button>}</>}/></div>
    {locked&&<p className="mixed-basis-hint">{locked}</p>}
    <p className="mixed-basis-hint">全局基组 <strong>{canonicalBasis(globalBasis)}</strong> 用于未分配原子；各区域覆盖其原子。不同区域不得重叠，基组区域不改变BSSE片段或其电子态。</p>
    {settings.enabled&&structure&&!locked&&<>
      {settings.regions.some(region=>region.atoms.length>0)&&<details className="mixed-angular-details shared-input-card shared-input-subcard"><summary>高级壳形式 / 来源兼容 · {angular.dForm} / {angular.fForm}</summary><label className="field">全局d壳形式<select aria-label="混合基组d壳形式" disabled={!!gaussianSettings?.use5D} value={settings.dForm} onChange={event=>onChange(selectMixedAngular(settings,event.target.value as '5D'|'6D'))}><option value="5D">5D / 7F · 纯函数</option><option value="6D">6D / 7F · d使用Cartesian，其余纯函数</option></select><small>{gaussianSettings?.use5D?'主动5D选项已生效；关闭后可在此调整兼容壳形式。':settings.angularExplicit===false&&!gaussianSettings?.inheritedRoute?.angular?'Gen默认5D / 7F，不额外追加壳形式关键词。':'保留旧表单或来源的明确壳形式；主动选择会写入统一壳形式。'}所有原子使用同一形式。</small></label></details>}
      {settings.regions.map((region,index)=><RegionEditor key={region.id} region={region} index={index} structure={structure} dForm={angular.dForm} fForm={angular.fForm} selected={selected} fragments={fragments} onChange={next=>update({regions:settings.regions.map(item=>item.id===region.id?next:item)})} onDelete={()=>update({regions:settings.regions.filter(item=>item.id!==region.id)})} onPick={onPick} onRequestSelection={onRequestSelection} taskId={gaussianSettings?.task} settings={settings} onCommit={(ids,guard,overwrite)=>commit(region.id,ids,guard,overwrite)} remaining={regionSelectionIdentityError(structure)?[]:remainingRegionAtomIds(structure,rows,region.id)}/>)}
      {!!overlapping.length&&<DismissibleNotice className="mixed-basis-error" role="alert">区域重叠：原子 {formatAtomSelection(overlapping.map(number=>number-1))}。每个原子只能归属一个覆盖区域。</DismissibleNotice>}
      {settings.regions.some(region=>region.atoms.length>0)&&<div className="mixed-basis-total" aria-live="polite"><strong>{size.count===null?'总基函数数待核实':size.count+' 个基函数'}</strong><span>{size.convention}</span><span>其余 {size.remaining} 原子沿全局基组{size.remainingCount===null?'':' · '+size.remainingCount+' 个基函数'}</span>{size.reason&&<span>{size.reason}</span>}</div>}
    </>}
  </section>;
}
