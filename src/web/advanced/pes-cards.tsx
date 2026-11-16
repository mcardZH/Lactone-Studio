import { useState } from 'react';
import { PES_EXECUTION_PROFILE, type PesCard, type PesGeometry, type PesParameter, type PesRun, type PesConvergencePreset } from '../../modeling/pes/contracts';
import { PES_ALGORITHMS, PES_CARD_LABELS, PES_CONVERGENCE_OPTIONS, defaultParameters, effectivePesPathParameters, nebPresetParameters, pesParameterSections, usesPesExecutionProfile, pesId } from '../../modeling/pes/defaults';
import { pesPathStructureIssue } from '../../modeling/pes/request';
import { InputSettingsCard, InputSettingsField, InputSettingsRow, InputSettingsStack } from '../InputSettingsFields';
import {SelectionAddButton,SelectionGroupHeader,SelectionRemoveButton} from '../InteractiveSelectionField';
import { isPesRunLive, PesMethodFields, PesParameterSections,
  PesRunControls, PesSelect, PesText, type PesSelectionScope } from './pes-fields';
import { PesScanAxes, PesScanCoordinates, PesScanOptimization, PesScanSourceRow } from './PesScanSettings';
import type { ScanSourceChoice } from '../../modeling/pes/scan-source';

function sourceKey(source: PesGeometry): string {
  return JSON.stringify([source.documentId, source.revision, source.source?.nodeId, source.source?.runId, source.source?.seriesId, source.source?.frameId,source.inputSnapshotId]);
}

interface SourceRowProps { label: string; fieldLabel?: string; value?: PesGeometry; fallback?: string; sources: PesGeometry[]; canCapture: boolean; onSelect(value?: PesGeometry): void; onCapture(): void; issues?: string[] }
function SourceRow({ label, fieldLabel = label, value, fallback = '选择结构', sources, canCapture, onSelect, onCapture, issues }: SourceRowProps) {
  const options = new Map(sources.map(source => [sourceKey(source), source]));
  if (value && !options.has(sourceKey(value))) options.set(sourceKey(value), value);
  return <InputSettingsRow className="pes-source-row">
    <InputSettingsField label={fieldLabel} controlWidth="select"><select aria-label={label} title={value?.label ?? value?.structure.name ?? fallback} value={value ? sourceKey(value) : ''}
      onChange={event => onSelect(options.get(event.target.value))}>
      <option value="">{fallback}</option>
      {[...options].map(([key, source]) => <option key={key} value={key}>{source.label ?? source.structure.name}{source.source?.frameId ? ' · 所选帧' : ''}</option>)}
    </select></InputSettingsField>
    <span className="pes-source-actions"><button type="button" className="button button-primary" disabled={!canCapture} aria-label={`${label}记录快照`} onClick={onCapture}>记录快照</button>
      {!!issues?.length && <details className="pes-local-failures">
        <summary aria-label="查看路径结构问题" title="查看路径结构问题"><span aria-hidden="true">!</span></summary>
        <div role="note">{issues.map((issue, index) => <p key={index}>{issue}</p>)}</div>
      </details>}
    </span>
  </InputSettingsRow>;
}

export function PesCalculationCard({ card, source, sources, scope, update, setSlot, capture, run, start, stop, move, remove, available, canCapture, scanSources,selectScanSource,sourceIssue,sourceLoading,selectAlgorithm }: {
  card: PesCard; source: PesGeometry; sources: PesGeometry[]; scope:PesSelectionScope; update(edit: (card: PesCard) => PesCard): void;
  setSlot(slot: string, geometry?: PesGeometry): void; capture(slot: string): void; run?: PesRun; start(): void; stop(): void;
  move(direction: -1 | 1): void; remove(): void; available: boolean; canCapture: boolean;
  scanSources?:ScanSourceChoice[];selectScanSource?(key:string):void;sourceIssue?:string;sourceLoading?:boolean;
  selectAlgorithm?(algorithm:string):void;
}) {
  const [managing, setManaging] = useState(false);
  const live = isPesRunLive(run);
  if (card.kind === 'explore') return <InputSettingsCard sectionKey={`pes-card:${card.id}`} stack className="pes-calculation" title={`${PES_CARD_LABELS.explore} ${card.name}`}>
    <p>单端反应探索已停用，已有结果仍可查看和导出。</p>
    {run && <PesRunControls run={run} stop={stop}/>}
  </InputSettingsCard>;
  const algorithm = card.algorithm;
  const values = effectivePesPathParameters(algorithm, card.parametersByAlgorithm[algorithm] ?? {});
  const structure = source.structure;
  const parameter = (key: string, value: PesParameter) => update(current => ({ ...current,
    parametersByAlgorithm: { ...current.parametersByAlgorithm, [algorithm]: { ...current.parametersByAlgorithm[algorithm], [key]: value,
      ...(usesPesExecutionProfile(current.parametersByAlgorithm[algorithm]??{})&&['ciMaxForce','ciRmsForce','nebMaxForce','nebRmsForce'].includes(key)?{nebConvergencePreset:'custom'}:{}) } },
  }));
  const pathIssues = card.kind === 'path' ? [
    ...(card.slots.product ? [pesPathStructureIssue(structure, card.slots.product.structure, '产物')] : []),
    ...card.keys.map((key, index) => card.slots[key.id] ? pesPathStructureIssue(structure, card.slots[key.id]!.structure, `关键构型${index + 1}`) : `请选择第${index + 1}个关键构型。`),
  ].filter((issue): issue is string => !!issue) : [];
  const slot = (key: string, label: string, fallback?: string, fieldLabel?:string) => <SourceRow label={label} fieldLabel={fieldLabel} fallback={card.requiredSlots?.includes(key)&&!card.slots[key]?'请重新记录或选择结构':fallback} value={card.slots[key]} sources={sources} canCapture={canCapture}
    issues={key === 'product' ? pathIssues : undefined}
    onSelect={geometry => setSlot(key, geometry)} onCapture={() => capture(key)}/>;
  const actions = <button type="button" className="button" aria-expanded={managing} onClick={() => setManaging(value => !value)}>卡片操作</button>;
  return <InputSettingsCard sectionKey={`pes-card:${card.id}`} actions={actions} stack className="pes-calculation" title={<button type="button" className="shared-input-card-toggle"
    aria-expanded={!card.collapsed} onClick={() => update(current => ({ ...current, collapsed: !current.collapsed }))}>
    <span aria-hidden="true">{card.collapsed ? '▸' : '▾'}</span><span className="shared-input-card-title-text">{PES_CARD_LABELS[card.kind]} {card.name}</span>
  </button>}>
    {managing && <InputSettingsRow>
      <InputSettingsField label="卡片名称" controlWidth="text"><input value={card.name} onChange={event => { const name = event.target.value; update(current => ({ ...current, name })); }}/></InputSettingsField>
      <button type="button" className="button" disabled={live} onClick={remove}>删除卡片</button>
    </InputSettingsRow>}
    {!card.collapsed && <>
      {card.kind === 'path' && <InputSettingsField label="路径方法" controlWidth="select"><select aria-label="路径方法" value={algorithm} disabled={live} onChange={event=>selectAlgorithm?.(event.target.value)}>
        {Object.entries(PES_ALGORITHMS.path).map(([key,label])=><option key={key} value={key}>{label}</option>)}
      </select></InputSettingsField>}
      {card.kind==='path'&&algorithm==='ci-neb'&&<PesSelect label="初始路径" value={String(values.pathInitializer)} options={{sidpp:'S-IDPP',fsm:'FSM（原生两端生长）'}} onChange={value=>parameter('pathInitializer',value)}/>}
      {card.kind==='path'&&algorithm==='fsm'&&<PesSelect label="生长方式" value={String(values.fsmGrowth)} options={{native:'原生两端生长',sidpp:'S-IDPP引导'}} onChange={value=>parameter('fsmGrowth',value)}/>}
      {card.kind === 'path' && algorithm === 'de-gsm' && <PesSelect label="生长方式" value={String(usesPesExecutionProfile(values)?values.gsmGrowth??'native':'sidpp')} options={{native:'原生DLC生长',sidpp:'S-IDPP引导'}}
        onChange={gsmGrowth=>update(current=>({...current,parametersByAlgorithm:{...current.parametersByAlgorithm,[algorithm]:{...defaultParameters(algorithm),...current.parametersByAlgorithm[algorithm],executionProfile:PES_EXECUTION_PROFILE,gsmGrowth}}}))}/>}
      <PesMethodFields value={card.method} onChange={method => update(current => ({ ...current, method }))}/>
      {card.kind === 'scan' && <>
        <PesScanSourceRow card={card} choices={scanSources??[]} issue={sourceIssue} loading={sourceLoading} canCapture={canCapture} onSelect={key=>selectScanSource?.(key)} capture={()=>capture('start')}/>
        <PesScanCoordinates card={card} scope={scope} update={update}/>
        <PesScanAxes card={card} scope={scope} update={update}/>
      </>}
      {card.kind === 'path' && <>
        <InputSettingsCard level="subcard" titleRole="subcard" title="路径结构" stack actions={<SelectionAddButton label="添加关键构型" onClick={()=>update(current=>({...current,keys:[...current.keys,{id:pesId('key'),position:''}]}))}/> }>
          {slot('reactant', '反应物', 'initial')}
          {card.keys.map((key, index) => <InputSettingsStack className="pes-definition" key={key.id}>
            <SelectionGroupHeader title={'关键构型 '+(index+1)} actions={<>
              {([-1, 1] as const).map(direction => <button type="button" className="button" key={direction} disabled={index + direction < 0 || index + direction >= card.keys.length}
                onClick={() => update(current => {
                  const keys = [...current.keys]; [keys[index], keys[index + direction]] = [keys[index + direction], keys[index]]; return { ...current, keys };
                })}>{direction < 0 ? '上移' : '下移'}</button>)}
              <SelectionRemoveButton label={'移除关键构型 '+(index+1)} onClick={() => update(current => {
                const slots = { ...current.slots }, mappings = { ...current.mappings }; delete slots[key.id]; delete mappings[key.id];
                return { ...current, slots, mappings, keys: current.keys.filter(item => item.id !== key.id) };
              })}/>
            </>}/>
            {slot(key.id, `关键构型${index + 1}`, undefined, '结构')}
            <PesText label="位置（第k个珠子）" value={key.position} placeholder="自动" onChange={position=>update(current=>({...current,
              keys:current.keys.map(item=>item.id===key.id?{...item,position}:item),
            }))}/>
          </InputSettingsStack>)}
          {slot('product', '产物')}
        </InputSettingsCard>
      </>}
      {algorithm==='ci-neb'&&<PesSelect label="路径收敛标准" value={usesPesExecutionProfile(values)?String(values.nebConvergencePreset??'custom'):'legacy'}
        options={{...(!usesPesExecutionProfile(values)?{legacy:'已有FIRE设置'}:{}),...PES_CONVERGENCE_OPTIONS}}
        onChange={value=>update(current=>({...current,parametersByAlgorithm:{...current.parametersByAlgorithm,[algorithm]:nebPresetParameters(current.parametersByAlgorithm[algorithm]??{},value as PesConvergencePreset)}}))}/>}
      {card.kind==='scan'?<PesScanOptimization card={card} update={update}/>:<PesParameterSections sections={pesParameterSections(algorithm,values)} values={values} method={card.method.method} onChange={parameter}/>}
      {!live && <InputSettingsRow variant="actions"><button type="button" className="button button-primary" disabled={!available} onClick={start}>{card.kind === 'scan' ? '开始扫描' : '开始计算'}</button></InputSettingsRow>}
    </>}
    {run && <PesRunControls run={run} stop={stop}/>}
  </InputSettingsCard>;
}
