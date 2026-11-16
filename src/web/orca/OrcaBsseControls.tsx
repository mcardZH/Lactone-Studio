import { electronicStateWarning } from '../../core/elements';
import {reconcileElectronicStateAfterInventoryEdit} from '../../core/modeling/electronic-state-policy';
import BaseElectronicStateFields from '../BaseElectronicStateFields';
import NumericInput from '../NumericInput';
import type { OrcaJobRequest } from '../../core/orca/types';
import { atomNumbers } from './OrcaCoordinates';
import InteractiveSelectionField, { SelectionGroupHeader, SelectionAddButton, SelectionRemoveButton, type InteractiveSelectionFieldProps } from '../InteractiveSelectionField';
import { fragmentColor } from '../../core/regions';
import { applyRegionSelection, planRegionSelection, remainingRegionAtomIds, regionSelectionIdentityError } from '../../modeling/application/region-selection';

export interface OrcaBsseControlsProps {
  request: OrcaJobRequest; onChange(request: OrcaJobRequest): void; selectedIds: string[];
  onRequestSelection?: InteractiveSelectionFieldProps['onRequestSelection'];
}
const finite=(value:number)=>Number.isFinite(value)?value:'';
export default function OrcaBsseControls({request,onChange,selectedIds,onRequestSelection}:OrcaBsseControlsProps){
  const fragments=request.settings.fragments,structure=request.structure;
  const spinMode=(fragment:typeof fragments[number])=>fragment.multiplicityMode??(fragment.atomIds.length?'manual':'auto');
  const update=(next:typeof fragments)=>onChange({...request,settings:{...request.settings,fragments:next,fragmentStatesConfirmed:false}});
  const rows=fragments.map((row,i)=>({...row,label:'片段'+(i+1)}));
  const assigned=new Set(fragments.flatMap(fragment=>fragment.atomIds));
  const remaining=structure?.atoms.flatMap(atom=>atom.id&&!assigned.has(atom.id)?[atom.id]:[])??[];
  function apply(id:string,ids:string[],guard:()=>void,overwrite:boolean){
    if(!structure)throw new Error('请先提供结构。');
    const next=applyRegionSelection(rows,planRegionSelection(structure,rows,id,ids),overwrite,guard);
    update(fragments.map(row=>{const atomIds=[...next.find(value=>value.id===row.id)!.atomIds];const paired=reconcileElectronicStateAfterInventoryEdit(structure.atoms.filter(atom=>atomIds.includes(atom.id!)),row);return {...row,atomIds,charge:paired.charge,multiplicityMode:spinMode(row),multiplicity:paired.multiplicity};}));
  }
  return <details className="orca-group shared-input-card shared-input-inline" data-state={request.settings.fragmentStatesConfirmed?'confirmed':'pending'} open><summary><SelectionGroupHeader title={`片段（${fragments.length}）`} actions={<SelectionAddButton label="添加片段" disabled={!structure} onClick={()=>update([...fragments,{id:crypto.randomUUID(),atomIds:[],charge:0,multiplicity:1,multiplicityMode:'auto'}])}/>}/></summary>
    <p className="orca-note">未分配原子：{atomNumbers(remaining,structure)||'无'}。计算片段与QM/MM层分别保存。</p>
    {fragments.map((fragment,i)=><div className="orca-coordinate-row shared-input-card shared-input-subcard" key={fragment.id}>
      <InteractiveSelectionField renderHeader={()=><SelectionGroupHeader title={<><i className="fragment-color-dot" style={{background:fragmentColor(i)}} aria-hidden="true"/>片段{i+1}</>} actions={<SelectionRemoveButton label={`删除ORCA片段${i+1}`} onClick={()=>update(fragments.filter(row=>row.id!==fragment.id))}/>}/>} structure={structure} label={'ORCA片段'+(i+1)} rowId={fragment.id} engine="orca" purpose="fragment" taskId={request.settings.task} atomIds={fragment.atomIds} contextKey={JSON.stringify([request.settings,request.charge,request.multiplicity])} onRequestSelection={onRequestSelection} onConfirm={(ids,guard,overwrite)=>apply(fragment.id,ids,guard,overwrite)} remainingAtomIds={structure&&!regionSelectionIdentityError(structure)?remainingRegionAtomIds(structure,rows,fragment.id):[]} draftChoices={[{label:'采用当前选区',atomIds:selectedIds}]}/>
      {!fragment.atomIds.length?<p className="interactive-selection-empty">空片段草稿：确认成员后设置电子态；被覆盖移空的片段和原参数仍保留。</p>:<BaseElectronicStateFields embedded preserveNumericDraft chargeFieldLabel="电荷" chargeLabel={'ORCA片段'+(i+1)+'电荷'} multiplicityLabel={'ORCA片段'+(i+1)+'多重度'} charge={fragment.charge} multiplicity={fragment.multiplicity} atoms={structure?.atoms.filter(atom=>fragment.atomIds.includes(atom.id!))??[]} onElectronicStateChange={values=>update(fragments.map(row=>row.id===fragment.id?{...row,...values,multiplicityMode:'manual'}:row))} confirmed={request.settings.fragmentStatesConfirmed} warning={structure?electronicStateWarning(structure.atoms.filter(atom=>fragment.atomIds.includes(atom.id!)),fragment.charge,fragment.multiplicity):null} onChargeChange={charge=>update(fragments.map(row=>row.id===fragment.id?{...row,charge,multiplicityMode:'manual'}:row))} onMultiplicityChange={multiplicity=>update(fragments.map(row=>row.id===fragment.id?{...row,multiplicity,multiplicityMode:'manual'}:row))}/>}
    </div>)}
    {!fragments.length&&<p className="interactive-selection-empty">尚未添加片段。</p>}
    {fragments.length>=2&&fragments.every(row=>row.atomIds.length>0)&&<label className="check-line"><input aria-label="确认ORCA片段电子态" type="checkbox" checked={request.settings.fragmentStatesConfirmed===true} onChange={event=>onChange({...request,settings:{...request.settings,fragmentStatesConfirmed:event.target.checked}})}/><span>确认片段电子态</span></label>}
  </details>;
}
