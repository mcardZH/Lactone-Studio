import {DismissibleNotice} from './DismissibleNotice';
import NumericInput from './NumericInput';
import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import type { FileSettings, GaussianSettings, Structure, TaskOptions, Vector3 } from '../core/types';
import { constraintsEnabled, coordinateAction, coordinateAtoms, defaultTaskOptions, supportsConstraints } from '../core/tasks';
import { resolveCoordinateDrafts, coordinateImagePreview, type CoordinateDraft } from '../core/coordinate-drafts';
import { pickerStructureIdentity } from '../core/geometry-guides';
import { formatAtomSelection } from '../core/structures';
import { isXtb } from '../core/xtb';
import type { AtomPickerRequest } from './AtomPickerModal';
import type { TaskSelectionHandle, TaskSelectionIntent } from '../modeling/contracts';
import { inputSelectionIds, inputSelectionIndices } from '../core/input-selection';
import { confirmCoordinateSelection, gaussianScanRange, recommendedScan } from '../modeling/application/coordinate-selection';
import InteractiveSelectionField, { SelectionGroupHeader, SelectionAddButton, SelectionRemoveButton } from './InteractiveSelectionField';
import { InputSettingsField, InputSettingsRow } from './InputSettingsFields';
import './geometry-controls.css';

function legacyDrafts(options: TaskOptions, settings: GaussianSettings): CoordinateDraft[] {
  return options.coordinates.map((coordinate, index) => ({ id: `legacy-${index + 1}`, type: coordinate.type, action: coordinateAction(coordinate, settings.task), atomText: coordinate.atoms.join(','), stepsText: String(coordinate.steps), incrementText: coordinate.increment === null ? '' : String(coordinate.increment), enabled: true, ...(coordinate.objectId ? { objectId: coordinate.objectId } : {}) }));
}

export interface SharedFreezeCounts { atoms: number; coordinates: number }
export interface GeometryControlsProps {
  settings: GaussianSettings; files: FileSettings; structure: Structure | null; selected: number[];
  onChange: (options: TaskOptions) => void; onPick: (request: AtomPickerRequest) => void;
  onRequestSelection?: (intent: TaskSelectionIntent) => TaskSelectionHandle | void; sharedFreezeCounts?: SharedFreezeCounts;
  mode?: 'scan' | 'freeze' | 'both';
  internalCoordinatesDisabled?:boolean;
}
export default function GeometryControls({ settings, files, structure, selected: _selected, onChange, onPick, onRequestSelection, sharedFreezeCounts, mode = 'both', internalCoordinatesDisabled=false }: GeometryControlsProps) {
  const options = settings.taskOptions ?? defaultTaskOptions(), atoms = structure?.atoms ?? [], enabled = constraintsEnabled(settings), scan = settings.task === 'scan';
  const drafts = options.coordinateDrafts ?? legacyDrafts(options, settings);
  const [error, setError] = useState('');
  const [pendingRow,setPendingRow]=useState<CoordinateDraft|null>(null);
  const [liveIds,setLiveIds]=useState<Record<string,string[]>>({});
  const [liveImages,setLiveImages]=useState<Record<string,Vector3[]|undefined>>({});
  const identity = structure ? pickerStructureIdentity(structure) : '';
  const latest = useRef({ options, settings, drafts, identity, structure, onChange });
  latest.current = { options, settings, drafts, identity, structure, onChange };
  const mounted = useRef(true);
  const usable = !!structure && files.geometry === 'explicit' && structure.dimension !== 2;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setError(''); setPendingRow(null); setLiveIds({}); setLiveImages({}); }, [identity, settings.task]);
  useEffect(() => {
    // Existing saved forms preserve their action, values and ordering on first display.
    if (options.coordinateDrafts === undefined && options.coordinates.length) onChange({ ...options, coordinateDrafts: legacyDrafts(options, settings) });
  }, [options, settings, onChange]);
  if (!supportsConstraints(settings.task) && mode !== 'freeze') return null;
  function change(patch: Partial<TaskOptions>) { const current = latest.current; current.onChange({ ...current.options, ...patch }); }
  function updateRow(id: string, patch: Partial<CoordinateDraft>) {
    if(pendingRow?.id===id){setPendingRow({...pendingRow,...patch});return;}
    const current = latest.current;
    change({ coordinateDrafts: current.drafts.map(row => row.id === id ? { ...row, ...patch } : row) });
  }
  function addRow(action: CoordinateDraft['action']) {
    const row: CoordinateDraft = { id: `coordinate-new-${action}-${crypto.randomUUID()}`, type: 'B', action, atomText: '', stepsText: '20', incrementText: '', enabled: true };
    setPendingRow(row);
  }
  function rowIds(row: CoordinateDraft) {
    try { return structure ? inputSelectionIds(structure, coordinateAtoms(row.atomText).map(index => index - 1)) : []; } catch { return []; }
  }
  function renderRows(action: CoordinateDraft['action']) {
    const rows = [...drafts,...(pendingRow?[pendingRow]:[])].filter(row => row.action === action), activeGroup = action === 'scan' ? scan : enabled;
    return <>
      <div className="coordinate-list coordinate-draft-list">{rows.map((row, index) => {
        const ids = rowIds(row), active = row.enabled && activeGroup;
        let measurement: ReturnType<typeof confirmCoordinateSelection> | undefined;
        let measurementError = '';
        try { const currentIds=liveIds[row.id]??ids;if (structure && currentIds.length) measurement = confirmCoordinateSelection(coordinateImagePreview(structure,currentIds,liveImages[row.id]),currentIds); } catch (reason) { measurementError = reason instanceof Error ? reason.message : '内坐标无效。'; }
        const confirmed = !!measurement && measurement.type === row.type, previewType=measurement?.type??row.type;
        const rowErrors = confirmed && pendingRow?.id!==row.id ? resolveCoordinateDrafts({ ...settings, taskOptions: { ...options, coordinateDrafts: [row] } }).errors : [];
        const actualIncrement = row.incrementText || (isXtb(settings.method) ? row.type === 'B' ? '0.05' : '5' : '');
        const range = confirmed && measurement && actualIncrement.trim() ? gaussianScanRange(measurement.value, Number(row.stepsText), Number(actualIncrement)) : null;
        const digits = row.type === 'B' ? 3 : 2, unit = row.type === 'B' ? 'Å' : '°';
        const expectedIdentity = identity, expectedTask = settings.task;
        return <article key={row.id} data-coordinate-id={row.id} data-field={`coordinate-${row.id}`} tabIndex={-1} className={`coordinate-draft${active ? '' : ' inactive-coordinate'}`}>
          <header className="shared-coordinate-row-header"><SelectionGroupHeader title={<label className="check-line"><input aria-label={`启用${action === 'scan' ? '扫描' : '冻结'}行${index + 1}`} type="checkbox" checked={row.enabled} onChange={event => updateRow(row.id, { enabled: event.target.checked })} /><span className="shared-coordinate-row-title">{action === 'scan' ? '扫描' : '冻结'}坐标 {index + 1}{confirmed ? ` · ${{ B: '键长', A: '键角', D: '二面角' }[previewType]}` : ''}</span></label>} actions={<SelectionRemoveButton label={`删除${action === 'scan' ? '扫描' : '冻结'}行${index + 1}`} onClick={() => {if(pendingRow?.id===row.id)setPendingRow(null);else change({ coordinateDrafts: latest.current.drafts.filter(item => item.id !== row.id) });}}/>}/></header>
          <InteractiveSelectionField structure={structure} label={`${action === 'scan' ? '扫描' : '冻结'}坐标 ${index + 1}`} engine="gaussian" purpose="coordinate" rowId={row.id} taskId={settings.task} kind="coordinate" atomIds={ids} disabled={!usable} contextKey={`${identity}:${settings.task}:${row.type}:${row.atomText}:${row.action}`} onRequestSelection={onRequestSelection} onPick={onPick} onDraftChange={(atomIds,images)=>{setLiveIds(current=>({...current,[row.id]:atomIds}));setLiveImages(current=>({...current,[row.id]:images}));}} onEnd={result=>{if(result==='cancelled'&&pendingRow?.id===row.id)setPendingRow(null);}} onConfirm={(atomIds, assertCurrent, _overwrite, images) => {
            assertCurrent(); const current = latest.current;
            if (!mounted.current || current.identity !== expectedIdentity || current.settings.task !== expectedTask || !current.structure || !current.drafts.some(value => value.id === row.id)&&pendingRow?.id!==row.id) throw new Error('内坐标选择已失效，请重新选择。');
            if(images?.some(image=>image.some(value=>value!==0)))throw new Error('当前输入后端不支持跨周期镜像内坐标。');
            const result = confirmCoordinateSelection(current.structure, atomIds);
            const recommended=recommendedScan(result.type,result.value);if(!recommended)throw new Error('当前内坐标不适合默认扫描范围，请检查几何。');const scanDefaults={stepsText:String(recommended.increments),incrementText:String(recommended.increment)};
            const next={...row,...(pendingRow?.id===row.id&&action==='scan'?scanDefaults:{}),type:result.type,atomText:result.atoms.join(','),...(row.atomText!==result.atoms.join(',')||row.type!==result.type?{objectId:undefined}:{})};
            change({coordinateDrafts:pendingRow?.id===row.id?[...current.drafts,next]:current.drafts.map(value=>value.id===row.id?next:value),...(action==='freeze'?{constraintsEnabled:true}:{})});setPendingRow(null); setError('');
          }} />
          {pendingRow?.id===row.id&&<button type="button" onClick={()=>setPendingRow(null)}>取消添加</button>}
          {measurement&&!confirmed&&<p className="coordinate-measurement">{{B:'键长',A:'键角',D:'二面角'}[previewType]} · 当前值 {measurement.value.toFixed(previewType==='B'?3:2)} {measurement.unit}</p>}
          {confirmed && action === 'scan' && <><InputSettingsRow className="shared-numeric-row coordinate-scan-parameters"><InputSettingsField label="增量次数"><NumericInput title="Gaussian N次增量生成N+1个构型。" aria-label="扫描增量次数" stepper={true} min="1" max="10000" step="1" value={row.stepsText} onChange={event => updateRow(row.id, { stepsText: event.target.value })}/></InputSettingsField><InputSettingsField label={`步进 / ${unit}`}><NumericInput title="减小方向填负号。" aria-label="扫描增量" stepper={false} step="any" value={actualIncrement} onChange={event=>updateRow(row.id,{incrementText:event.target.value})}/></InputSettingsField></InputSettingsRow><InputSettingsRow className="coordinate-scan-parameters" ><span>起始值 / {unit} {measurement!.value.toFixed(digits)}</span><span data-testid="coordinate-current-value">终止值 / {unit} {range ? range.end.toFixed(digits) : '待填写步数与步进'}</span></InputSettingsRow></>}
          {confirmed && action === 'freeze' && <p className="coordinate-measurement" data-testid="coordinate-current-value">冻结{row.type} {measurement!.atoms.join(' ')} · 当前值 {measurement!.value.toFixed(digits)} {unit}</p>}
          {row.atomText && !confirmed && <p className="inline-selection-error coordinate-draft-error">{measurementError || '已有编号尚未形成有效内坐标，请重新确认。'}</p>}
          {rowErrors.map(message => <p className="inline-selection-error coordinate-draft-error" key={message}>{message.replace(`内坐标草稿 ${row.id}：`, `${action === 'scan' ? '扫描' : '冻结'}坐标 ${index + 1}：`)}</p>)}
        </article>;
      })}</div></>;
  }
  const freezeDisabled=internalCoordinatesDisabled||settings.task==='sp';
  const frozenIds = (() => { try { return structure ? inputSelectionIds(structure, options.frozenAtoms.map(index => index - 1)) : []; } catch { return []; } })();
  return <section className="geometry-controls" data-field="coordinates" tabIndex={-1}>
    {!usable && <p className="muted-note">请先提供真实三维显式结构；参考CHK几何或二维画布不能代替实际原子编号。</p>}
    {mode !== 'freeze' && scan && <details className="coordinate-module progressive-coordinate-section shared-input-subsection shared-input-card shared-input-subcard" data-testid="scan-coordinates" open={drafts.some(row => row.action === 'scan') || !!pendingRow || undefined}><summary><SelectionGroupHeader title={`扫描内坐标（${drafts.filter(row=>row.action==='scan').length}）`} actions={<SelectionAddButton label="添加内坐标" disabled={!usable||!!pendingRow} onClick={()=>addRow('scan')}/>}/></summary>{renderRows('scan')}</details>}
    {mode !== 'scan' && <>
    {!supportsConstraints(settings.task) && <p className="muted-note">当前任务不支持输出模型冻结；请选择支持约束的任务或解除对应冻结。</p>}
    <fieldset className="shared-freeze-records"><details className="coordinate-module progressive-coordinate-section shared-input-subsection shared-input-card shared-input-subcard" data-testid="freeze-atoms" open={freezeDisabled?false:undefined} style={freezeDisabled?{opacity:.5}:undefined}><summary aria-disabled={freezeDisabled||undefined} onClick={event=>{if(freezeDisabled)event.preventDefault();}}><SelectionGroupHeader title={`冻结原子（${sharedFreezeCounts?.atoms??frozenIds.length}）`} actions={<button type="button" disabled={!usable||freezeDisabled||!frozenIds.length} onClick={()=>change({frozenAtoms:[]})}>清空定义</button>}/></summary>
      {!freezeDisabled && <InteractiveSelectionField structure={structure} label="冻结原子" engine="gaussian" purpose="frozen-atoms" rowId="gaussian-frozen-atoms" taskId={settings.task} atomIds={frozenIds} contextKey={`${identity}:${settings.task}`} disabled={!usable} onPick={onPick} onRequestSelection={onRequestSelection} remainingAtomIds={atoms.map(atom => atom.id!).filter(id => id && !frozenIds.includes(id))} draftChoices={[...new Set(atoms.map(atom => atom.element))].map(element => ({ label: `按元素 ${element}`, atomIds: atoms.filter(atom => atom.element === element).map(atom => atom.id!).filter(Boolean) }))} onConfirm={(atomIds, assertCurrent) => {
        assertCurrent(); const current = latest.current;
        if (!current.structure || !mounted.current || current.identity !== identity || current.settings.task !== settings.task) throw new Error('冻结原子选择已失效。');
        const indices = inputSelectionIndices(current.structure, atomIds);
        change({ frozenAtoms: indices.map(index => index + 1), constraintsEnabled: true }); setError('');
      }} />}
      <p className="muted-note" data-testid="frozen-atoms-summary">模型冻结原子：{formatAtomSelection(options.frozenAtoms.map(index => index - 1)) || '无'}。</p>
    </details>
    <details className="coordinate-module progressive-coordinate-section shared-input-subsection shared-input-card shared-input-subcard" data-testid="freeze-coordinates" open={freezeDisabled?false:pendingRow?.action==='freeze'||undefined} style={freezeDisabled?{opacity:.5}:undefined}><summary aria-disabled={freezeDisabled||undefined} onClick={event=>{if(freezeDisabled)event.preventDefault();}}><SelectionGroupHeader title={`冻结内坐标（${sharedFreezeCounts?.coordinates??drafts.filter(row=>row.action==='freeze').length}）`} actions={<SelectionAddButton label="添加内坐标" disabled={freezeDisabled||!usable||!!pendingRow} onClick={()=>addRow('freeze')}/>}/></summary>{!freezeDisabled&&renderRows('freeze')}</details>
    {internalCoordinatesDisabled&&<details className="coordinate-module progressive-coordinate-section shared-input-subsection shared-input-card shared-input-subcard" data-testid="scan-coordinates" open={false} style={{opacity:.5}}><summary aria-disabled="true" onClick={event=>event.preventDefault()}>扫描内坐标</summary></details>}</fieldset>
    {enabled && ['freq', 'irc'].includes(settings.task) && <p className="muted-note">这里生成所请求的冻结标志与内坐标定义，不执行Gaussian；频率/路径结果仍需按实际输出核验约束与计算条件。</p>}
    </>}
    {error && <DismissibleNotice className="inline-selection-error" role="alert"><Info size={13} />{error}</DismissibleNotice>}
  </section>;
}
