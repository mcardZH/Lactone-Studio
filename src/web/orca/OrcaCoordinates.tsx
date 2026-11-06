import NumericInput from '../NumericInput';
import { useEffect, useRef, useState } from 'react';
import type { Structure, Vector3 } from '../../core/types';
import { coordinateImagePreview } from '../../core/coordinate-drafts';
import type { OrcaCoordinate } from '../../core/orca';
import type { TaskSelectionHandle, TaskSelectionIntent } from '../../modeling/contracts';
import { confirmCoordinateSelection, orcaScanRange, recommendedScan } from '../../modeling/application/coordinate-selection';
import { pickerStructureIdentity } from '../../core/geometry-guides';
import { orcaFreezeCaptureRowId } from '../../core/input-capture-binding';
import InteractiveSelectionField, { SelectionGroupHeader, SelectionAddButton, SelectionRemoveButton } from '../InteractiveSelectionField';
import { InputSettingsField, InputSettingsRow } from '../InputSettingsFields';
import '../geometry-controls.css';

export function orderedIds(text: string, structure: Structure | null): string[] {
  if (!structure || !text.trim()) return [];
  const tokens = text.trim().split(/[\s,，]+/);
  if (tokens.some(token => !/^\d+$/.test(token))) return [];
  const indices = tokens.map(token => Number(token) - 1);
  if (indices.some(index => !structure.atoms[index]) || new Set(indices).size !== indices.length) return [];
  return indices.map(index => structure.atoms[index].id!).filter(Boolean);
}
export function atomNumbers(ids: string[], structure: Structure | null): string {
  return ids.map(id => { const index = structure?.atoms.findIndex(atom => atom.id === id) ?? -1; return index >= 0 ? String(index + 1) : '?'; }).join(',');
}
type RequestSelection = (intent: TaskSelectionIntent) => TaskSelectionHandle | void;
function Row({ value, index, structure, onChange, onRemove, md, taskId, onRequestSelection, rowIdOverride, onConfirmed }: {
  value: OrcaCoordinate; index: number; structure: Structure | null;
  onChange: (value: OrcaCoordinate) => void; onRemove: () => void; md?: boolean;
  taskId?: string; onRequestSelection?: RequestSelection; rowIdOverride?:string; onConfirmed?:(value:OrcaCoordinate)=>void;
}) {
  const rowId = rowIdOverride??(value.action==='freeze'&&value.objectId?orcaFreezeCaptureRowId(value.objectId,md):`orca-${md ? 'md' : 'constraints'}-${index}`);
  const latest = useRef({ value, structure, taskId, onChange, onConfirmed });
  latest.current = { value, structure, taskId, onChange, onConfirmed };
  const prefix = `${md ? 'MD' : 'ORCA'}坐标${index + 1}`;
  const patch = (change: Partial<OrcaCoordinate>) => onChange({ ...value, ...change });
  const optional = (text: string) => text === '' ? undefined : Number(text);
  const explicit = value.values !== undefined, identity = structure ? pickerStructureIdentity(structure) : '';
  const [liveIds,setLiveIds]=useState<string[]|null>(null);
  const [liveImages,setLiveImages]=useState<Vector3[]|undefined>();
  let measurement: ReturnType<typeof confirmCoordinateSelection> | undefined, measurementError = '';
  try { const ids=liveIds??value.atomIds;if (structure && ids.length) measurement = confirmCoordinateSelection(coordinateImagePreview(structure,ids,liveImages),ids); } catch (reason) { measurementError = reason instanceof Error ? reason.message : '内坐标无效。'; }
  const confirmed = !!measurement && measurement.type === value.type;
  const range = orcaScanRange(value), unit = value.type === 'B' ? 'Å' : '°', digits = value.type === 'B' ? 3 : 2;
  const increment = range && !range.explicit ? range.increment : null;
  const canonicalIncrement = increment === null ? '' : String(Number(increment.toPrecision(12)));
  const [incrementText, setIncrementText] = useState(canonicalIncrement);
  useEffect(() => setIncrementText(canonicalIncrement), [canonicalIncrement, value.start, value.end, value.steps, explicit]);
  return <article className="orca-coordinate-row coordinate-draft" data-coordinate-id={rowId}>
    <header className="shared-coordinate-row-header"><SelectionGroupHeader title={<>{md ? 'MD' : value.action === 'scan' ? '扫描' : '冻结'}坐标 {index + 1}{confirmed ? ` · ${{ B: '键长', A: '键角', D: '二面角' }[value.type]}` : ''}</>} actions={<SelectionRemoveButton label={`删除${prefix}`} onClick={onRemove}/>}/></header>
    <InteractiveSelectionField structure={structure} label={prefix} engine="orca" purpose="coordinate" rowId={rowId} taskId={taskId} kind="coordinate" atomIds={value.atomIds} disabled={!structure || structure.dimension === 2} contextKey={`${identity}:${taskId}:${value.type}:${value.action}:${value.atomIds.join(',')}`} onRequestSelection={onRequestSelection} onDraftChange={(ids,images)=>{setLiveIds(ids);setLiveImages(images);}} onConfirm={(atomIds, assertCurrent, _overwrite, images) => {
      assertCurrent(); const current = latest.current;
      if (!current.structure || current.taskId !== taskId || pickerStructureIdentity(current.structure) !== identity) throw new Error('内坐标选择已失效，请重新选择。');
      if(images?.some(image=>image.some(value=>value!==0)))throw new Error('当前输入后端不支持跨周期镜像内坐标。');
      const result = confirmCoordinateSelection(current.structure, atomIds);
      const recommended=recommendedScan(result.type,result.value);if(!recommended)throw new Error('当前内坐标不适合默认扫描范围，请检查几何。');const scanDefaults={start:recommended.start,end:recommended.end,steps:recommended.points};
      (current.onConfirmed??current.onChange)({ ...current.value, ...(current.value.action==='scan'&&!current.value.atomIds.length?scanDefaults:{}),type: result.type, atomIds: result.atomIds, ...(current.value.type !== result.type ? {value:undefined}:{}), ...(current.value.type !== result.type || current.value.atomIds.join(',') !== atomIds.join(',') ? { objectId: undefined } : {}) });
    }} />
    {measurement&&!confirmed&&<p className="coordinate-measurement">{{B:'键长',A:'键角',D:'二面角'}[measurement.type]} · 当前值 {measurement.value.toFixed(measurement.type==='B'?3:2)} {measurement.unit}</p>}
    {value.atomIds.length > 0 && !confirmed && <p className="orca-error">{measurementError || '已有编号尚未形成有效内坐标，请重新确认。'}</p>}
    {confirmed && (value.action === 'freeze' ? <InputSettingsRow><span>当前值 / {unit} {measurement!.value.toFixed(digits)}</span><InputSettingsField label={`目标值 / ${unit}`}><NumericInput aria-label={`${prefix}目标值`} stepper={false} step="any" value={value.value ?? ''} placeholder={md ? '必须明确目标值' : '留空沿用初始几何'} onChange={event => patch({ value: optional(event.target.value) })} /></InputSettingsField></InputSettingsRow> : <>
      <InputSettingsRow><InputSettingsField label="扫描定义"><select aria-label={`${prefix}扫描方式`} value={explicit ? 'values' : 'range'} onChange={event => onChange(event.target.value === 'values' ? { type: value.type, action: 'scan', atomIds: value.atomIds, ...(value.objectId ? { objectId: value.objectId } : {}), values: [] } : { type: value.type, action: 'scan', atomIds: value.atomIds, ...(value.objectId ? { objectId: value.objectId } : {}) })}><option value="range">起止值与总点数</option><option value="values">显式数值表</option></select></InputSettingsField></InputSettingsRow>
      {explicit ? <label className="orca-field">数值表（{unit}）<input aria-label={`${prefix}扫描值表`} value={value.values!.join(',')} onChange={event => patch({ values: event.target.value.trim() ? event.target.value.split(/[,，\s]+/).map(Number) : [] })} /></label> : <>
        <InputSettingsRow className="shared-numeric-row coordinate-scan-parameters">{(['start','end'] as const).map(key=><InputSettingsField key={key} label={key==='start'?`起始值（${unit}）`:`终止值（${unit}）`}><NumericInput aria-label={`${prefix}${key}`} stepper={false} step="any" value={value[key]??''} onChange={event=>patch({[key]:optional(event.target.value)})}/></InputSettingsField>)}</InputSettingsRow>
        <InputSettingsRow className="shared-numeric-row coordinate-scan-parameters"><InputSettingsField label="总点数"><NumericInput title="ORCA N个点对应N−1次增量。" aria-label={`${prefix}steps`} stepper={true} min="2" step="1" value={value.steps??''} onChange={event=>patch({steps:optional(event.target.value)})}/></InputSettingsField><InputSettingsField label={`步进 / ${unit}`}><NumericInput aria-label={`${prefix}步进`} value={incrementText} stepper={false} readOnly /></InputSettingsField></InputSettingsRow>
      </>}
    </>)}
  </article>;
}
export default function OrcaCoordinates({ value, onChange, structure, selectedIds: _selectedIds, md = false, taskId, onRequestSelection, sharedFreezeCount, mode = 'both', disabled=false }: {
  value: OrcaCoordinate[]; onChange: (value: OrcaCoordinate[]) => void; structure: Structure | null; selectedIds: string[]; md?: boolean;
  taskId?: string; onRequestSelection?: RequestSelection; inheritModelFreeze?: boolean; sharedFreezeCount?: number; onInheritanceChange?: (inherit: boolean) => void;
  mode?: 'scan' | 'freeze' | 'both'; freezeEnabled?: boolean; disabled?:boolean;
}) {
  const [pending,setPending]=useState<{id:string;value:OrcaCoordinate}|null>(null);
  useEffect(()=>setPending(null),[structure?.id,taskId]);
  function group(action: OrcaCoordinate['action']) {
    if(disabled||taskId==='sp')return <details className="coordinate-module progressive-coordinate-section shared-input-subsection shared-input-card shared-input-subcard" open={false} style={{opacity:.5}} data-testid={action==='scan'?'orca-scan-coordinates':'orca-freeze-coordinates'}><summary aria-disabled="true" onClick={event=>event.preventDefault()}>{action==='scan'?'扫描内坐标':'冻结内坐标'}</summary></details>;
    const rows = value.map((row, index) => ({ row, index })).filter(entry => entry.row.action === action);
    return <details className="coordinate-module progressive-coordinate-section shared-input-subsection shared-input-card shared-input-subcard" open={action === 'scan' && rows.length > 0 || pending?.value.action===action || undefined} data-testid={action === 'scan' ? 'orca-scan-coordinates' : 'orca-freeze-coordinates'}><summary><SelectionGroupHeader title={<>{action === 'scan' ? '扫描内坐标' : md ? 'MD内坐标约束' : '冻结内坐标'}（{action==='freeze'&&sharedFreezeCount!==undefined?sharedFreezeCount:rows.length}）</>} actions={<SelectionAddButton label="添加内坐标" disabled={!structure||structure.dimension===2||!!pending} onClick={()=>setPending({id:`orca-${md ? 'md-' : ''}coordinate-new-${action}-${crypto.randomUUID()}`,value:{type:'B',action,atomIds:[]}})}/>}/></summary>
      {pending?.value.action===action&&<><Row value={pending.value} index={value.length} rowIdOverride={pending.id} structure={structure} md={md} taskId={taskId} onRequestSelection={onRequestSelection} onChange={next=>setPending({...pending,value:next})} onConfirmed={next=>{onChange([...value,next]);setPending(null);}} onRemove={()=>setPending(null)}/><button type="button" onClick={()=>setPending(null)}>取消添加</button></>}
      {rows.map(({ row, index }) => <Row key={index} value={row} index={index} structure={structure} md={md} taskId={taskId} onRequestSelection={onRequestSelection} onChange={next => onChange(value.map((current, i) => i === index ? next : current))} onRemove={() => onChange(value.filter((_, i) => i !== index))} />)}
    </details>;
  }
  return <div className="orca-coordinate-list progressive-coordinate-list">{mode !== 'freeze' && !md && (disabled || taskId === 'scan' || value.some(row => row.action === 'scan')) && group('scan')}{md && value.map((row,index)=>row.action==='scan'&&<div className="orca-error" role="alert" key={`unsupported-md-scan-${index}`}><p>MD坐标 {index+1} 保存了扫描定义；扫描不能用作MD约束，请移除此定义后重新设置冻结坐标。</p><button type="button" aria-label={`删除不适用的MD扫描${index+1}`} onClick={()=>onChange(value.filter((_,i)=>i!==index))}>删除不适用的扫描</button></div>)}{mode !== 'scan' && group('freeze')}</div>;
}
