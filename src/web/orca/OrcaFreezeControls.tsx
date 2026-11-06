import { Snowflake } from 'lucide-react';
import type { Structure } from '../../core/types';
import type { OrcaSettings } from '../../core/orca/types';
import type { TaskSelectionHandle, TaskSelectionIntent } from '../../modeling/contracts';
import { inputSelectionIndices } from '../../core/input-selection';
import InteractiveSelectionField, { SelectionGroupHeader } from '../InteractiveSelectionField';
import OrcaCoordinates, { atomNumbers } from './OrcaCoordinates';
import { InputSettingsAction, InputSettingsEnableCard } from '../InputSettingsLayout';

export interface OrcaFreezeControlsProps {
  settings: OrcaSettings; structure: Structure | null; selectedIds: string[];
  onChange: (patch: Partial<OrcaSettings>) => void;
  onRequestSelection?: (intent: TaskSelectionIntent) => TaskSelectionHandle | void;
  sharedFreezeCounts?: { atoms: number; coordinates: number };
  onInherit?:()=>void;
  inheritDisabled?:boolean;
  freezeEnabled?:boolean;
  onFreezeEnabledChange?:(enabled:boolean)=>void;
  internalCoordinatesDisabled?:boolean;
}

export default function OrcaFreezeControls({ settings: s, structure, selectedIds, onChange, onRequestSelection, sharedFreezeCounts, freezeEnabled=true, onFreezeEnabledChange,internalCoordinatesDisabled=false }: OrcaFreezeControlsProps) {
  const md = s.task === 'md';
  const supported = ['opt','optfreq','ts','scan','tdopt','md'].includes(s.task);
  return <InputSettingsEnableCard enabled={s.task!=='sp'&&freezeEnabled} onEnabledChange={enabled=>onFreezeEnabledChange?.(enabled)} disabled={!onFreezeEnabledChange||s.task==='sp'} switchLabel="启用模型冻结" title={<><Snowflake size={15}/>冻结</>} actions={onFreezeEnabledChange&&<InputSettingsAction reset ariaLabel="停用冻结，保留冻结定义" disabled={s.task==='sp'} onClick={()=>onFreezeEnabledChange(false)}>恢复默认</InputSettingsAction>} sectionKey="freeze" className={'task-specific input-freeze-card'+(s.task==='sp'?' input-card-unavailable':'')} field="freeze-controls" testId="orca-freeze-controls" tabIndex={-1}>
    {!supported && <p className="muted-note">当前任务不支持输出模型冻结；请选择支持约束的任务或解除对应冻结。</p>}
    <fieldset className="shared-freeze-records"><details className="coordinate-module progressive-coordinate-section shared-input-subsection shared-input-card shared-input-subcard" data-testid="orca-freeze-atoms"><summary><SelectionGroupHeader title={`冻结原子（${sharedFreezeCounts?.atoms??s.frozenAtomIds.length}）`} actions={<button type="button" disabled={!structure||structure.dimension===2||!s.frozenAtomIds.length} onClick={()=>onChange({frozenAtomIds:[]})}>清空定义</button>}/></summary>
      {md&&<p className="orca-note">模型原子冻结从MD活动范围排除对应原子；原有活动范围仍是独立设置。</p>}
        <InteractiveSelectionField structure={structure} label="ORCA冻结原子" engine="orca" purpose="frozen-atoms" rowId="orca-frozen-atoms" taskId={s.task} atomIds={s.frozenAtomIds} contextKey={`${structure?.id}:${structure?.revision}:${s.task}:${s.frozenAtomIds.join(',')}`} disabled={!structure || structure.dimension === 2} onRequestSelection={onRequestSelection} remainingAtomIds={structure?.atoms.flatMap(atom => atom.id && !s.frozenAtomIds.includes(atom.id) ? [atom.id] : []) ?? []} draftChoices={[...new Set(structure?.atoms.map(atom=>atom.element)??[])].map(element=>({label:`按元素 ${element}`,atomIds:structure?.atoms.flatMap(atom=>atom.element===element&&atom.id?[atom.id]:[])??[]}))} onConfirm={(atomIds, assertCurrent) => {
          assertCurrent(); if (!structure) throw new Error('结构已失效。'); inputSelectionIndices(structure, atomIds); onChange({ frozenAtomIds: [...atomIds] });
        }} />
        <span>模型冻结原子：{atomNumbers(s.frozenAtomIds, structure) || '无'}</span>
    </details>
    <OrcaCoordinates disabled={internalCoordinatesDisabled} mode={internalCoordinatesDisabled?"both":"freeze"} md={md} value={md ? s.md.constraints : s.constraints} onChange={constraints => onChange(md ? { md: { ...s.md, constraints } } : { constraints })} structure={structure} selectedIds={selectedIds} taskId={s.task} onRequestSelection={onRequestSelection} sharedFreezeCount={sharedFreezeCounts?.coordinates} /></fieldset>
  </InputSettingsEnableCard>;
}
