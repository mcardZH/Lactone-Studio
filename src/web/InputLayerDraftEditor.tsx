import {DismissibleNotice} from './DismissibleNotice';
import type { BuilderAssignment } from '../core/builder-draft';
import type { Structure } from '../core/types';
import { editInputLayerDrafts,isEmptyInputLayerDraft,isInputLayerDraft,inputLayerPartition,inputLayerPrefix } from '../core/input-layer-capability';
import InteractiveSelectionField,{SelectionGroupHeader,SelectionAddButton,SelectionRemoveButton,type InteractiveSelectionFieldProps} from './InteractiveSelectionField';
import {applyRegionSelection,planRegionSelection,remainingRegionAtomIds,regionSelectionIdentityError} from '../modeling/application/region-selection';

interface Props {
  engine:'gaussian'|'orca';taskId:string;structure:Structure|null;layers:BuilderAssignment[];
  capabilityError:string|null;enabled:boolean;onChange(layers:BuilderAssignment[]):void;
  onMap(qmAtomIds:string[]):void;onRequestSelection:NonNullable<InteractiveSelectionFieldProps['onRequestSelection']>;onAbandon?():void;
}
export default function InputLayerDraftEditor({engine,taskId,structure,layers,capabilityError,enabled,onChange,onMap,onRequestSelection,onAbandon}:Props){
  const editableRows=layers.filter(layer=>!isEmptyInputLayerDraft(layer));
  const displayLabel=(layer:BuilderAssignment)=>layer.kind==='qm'?'QM'+(editableRows.filter(row=>row.kind==='qm').findIndex(row=>row.id===layer.id)+1):layer.kind==='mm'?'MM'+(editableRows.filter(row=>row.kind==='mm').findIndex(row=>row.id===layer.id)+1):'未支持层';
  const rows=editableRows.map(row=>({...row,label:displayLabel(row)}));
  const members=new Set(editableRows.flatMap(layer=>layer.atomIds));
  const remaining=structure?.atoms.flatMap(atom=>atom.id&&!members.has(atom.id)?[atom.id]:[])??[];
  const partition=inputLayerPartition(structure,layers,engine);
  function update(id:string,patch:Partial<BuilderAssignment>){onChange(layers.map(layer=>layer.id===id?{...layer,...patch}:layer));}
  function apply(id:string,ids:string[],guard:()=>void,overwrite:boolean){
    if(!structure)throw new Error('请先提供结构。');
    const next=applyRegionSelection(rows,planRegionSelection(structure,rows,id,ids),overwrite,guard);
    onChange(editableRows.map(row=>({...row,atomIds:[...next.find(value=>value.id===row.id)!.atomIds]})));
  }
  const addRegion=()=>onChange([...editableRows,{id:inputLayerPrefix(engine)+crypto.randomUUID(),kind:'qm',label:'QM'+(editableRows.filter(row=>row.kind==='qm').length+1),atomIds:[],draftRole:{type:'input-layer',engine,state:'active'}}]);
  return <details className="orca-group input-layer-drafts"><summary><SelectionGroupHeader title={<>QM/MM 区域草稿 · {engine==='gaussian'?'Gaussian':'ORCA'}</>} actions={<SelectionAddButton label="添加区域" disabled={!structure} onClick={addRegion}/>}/></summary>
    <p className="orca-note">多个QM空间组映射到当前同一已支持高层；多个MM组同属当前低层，不代表多方法或三层输入支持。</p>
    {layers.some(isEmptyInputLayerDraft)&&<p className="orca-note">草稿已清空，尚未定义</p>}
    {editableRows.map((layer,index)=><div className="orca-coordinate-row" key={layer.id} style={{borderLeft:'3px solid hsl('+((index*77+210)%360)+' 60% 55%)'}}>
      <SelectionGroupHeader title={displayLabel(layer)} actions={<SelectionRemoveButton label={`删除区域${index+1}`} onClick={()=>onChange(editInputLayerDrafts(engine,editableRows.filter(row=>row.id!==layer.id)))}/>}/>
      <InteractiveSelectionField structure={structure} label={displayLabel(layer)} rowId={layer.id} engine={engine} purpose="layer" taskId={taskId} atomIds={layer.atomIds} contextKey={JSON.stringify([layers,enabled,taskId])} onRequestSelection={onRequestSelection} onConfirm={(ids,guard,overwrite)=>apply(layer.id,ids,guard,overwrite)} remainingAtomIds={structure&&!regionSelectionIdentityError(structure)?remainingRegionAtomIds(structure,rows,layer.id):[]}/>
      {!layer.atomIds.length?<p className="interactive-selection-empty">空区域草稿：确认成员后设置类型；被覆盖移空的区域和原参数仍保留。</p>:<><div className="orca-grid">
        <label className="orca-field">区域名<input value={layer.label??''} onChange={event=>update(layer.id,{label:event.target.value})}/></label>
        <label className="orca-field">类型<select aria-label={displayLabel(layer)+'类型'} value={layer.kind==='qm'||layer.kind==='mm'?layer.kind:'__unsupported'} onChange={event=>{if(event.target.value==='qm'||event.target.value==='mm')update(layer.id,{kind:event.target.value});}}>{layer.kind!=='qm'&&layer.kind!=='mm'&&<option value="__unsupported" disabled>未支持的层类型（仅保留草稿）</option>}<option value="qm">QM 高层空间组</option><option value="mm">MM 低层空间组</option></select></label>
      </div>{layer.kind!=='qm'&&layer.kind!=='mm'&&<DismissibleNotice role="alert" className="orca-error">当前区域类型未支持，不能生成三层输入；请明确选择支持的类型。</DismissibleNotice>}</>}
    </div>)}
    <div className="orca-selection-actions">
      <button type="button" disabled={!enabled||!!partition.error} onClick={()=>{if(!partition.error)onMap(partition.qmAtomIds);}}>显式映射到当前同一高层</button></div>
    {onAbandon&&layers.some(isInputLayerDraft)&&<button type="button" onClick={onAbandon}>放弃草稿，使用现有科学分区</button>}
    <p className="orca-note">未分配 {remaining.length} 个原子；不会默认全部进入 MM。</p>{capabilityError&&<DismissibleNotice role="alert" className="orca-error">{capabilityError}</DismissibleNotice>}
  </details>;
}
