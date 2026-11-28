import { useMemo, useState } from 'react';
import { isPesNetMethod, PES_EXECUTION_PROFILE, type PesCard, type PesGeometry, type PesMethodDraft, type PesParameter, type PesRun, type PesConvergencePreset } from '../../modeling/pes/contracts';
import {validXtbResourceOverride} from '../../modeling/resource-preferences';
import {XtbResourceOverrideField} from '../TaskResourceFields';
import { PES_ALGORITHMS, PES_CARD_LABELS, PES_CONVERGENCE_OPTIONS, GSM_CONVERGENCE_PRESETS, defaultParameters, effectivePesPathParameters, nebPresetParameters, pesParameterSections, usesPesExecutionProfile, pesId } from '../../modeling/pes/defaults';
import { pesStructureCompatibilityIssues } from '../../modeling/pes/request';
import {periodicPesOperationAvailable} from '../../modeling/pes/periodic-capabilities';
import { InputSettingsCard, InputSettingsField, InputSettingsRow, InputSettingsStack } from '../InputSettingsFields';
import {SelectionAddButton,SelectionGroupHeader,SelectionRemoveButton} from '../InteractiveSelectionField';
import { isPesRunLive, PesParameterSections,
  PesRunControls, PesSelect, PesText, type PesSelectionScope } from './pes-fields';
import { PesScanAxes, PesScanCoordinates, PesScanOptimization, PesScanSourceRow } from './PesScanSettings';
import type { PesTabSnapshotSource } from '../modeling/pes-tab-snapshot';
import { PesSnapshotWarning } from './PesSnapshotWarning';

function sourceKey(source: PesGeometry): string {
  return JSON.stringify([source.documentId, source.revision, source.source?.groupId, source.source?.nodeId, source.source?.runId,
    source.source?.seriesId, source.source?.frameId, source.source?.recordId, source.inputSnapshotId]);
}

interface SourceRowProps {
  label: string; fieldLabel?: string; value?: PesGeometry; fallback?: string; sources: readonly PesTabSnapshotSource[];
  tabSources: readonly PesTabSnapshotSource[]; loading?: boolean; canCapture: boolean; outsideGroup?:boolean;
  onSelect(value?: PesGeometry): void; onSelectTab(key: string): void; onCapture(): void; issues: string[];
}
function SourceRow({ label, fieldLabel = label, value, fallback = '选择结构', sources, tabSources, loading, canCapture, outsideGroup, onSelect, onSelectTab, onCapture, issues }: SourceRowProps) {
  const selectedLabel=value?`${value.label??value.structure.name??'已选结构'}${value.source?.frameId?' · 所选帧':''}${outsideGroup?' · 组外已引用':''}`:fallback;
  return <InputSettingsRow className="pes-source-row">
    <InputSettingsField label={fieldLabel} controlWidth="select"><select aria-label={label} title={selectedLabel} value={value ? sourceKey(value) : ''} disabled={loading}
      onChange={event => {
        const key = event.target.value;
        if (key) onSelectTab(key);
        else onSelect();
      }}>
      <option value="">{fallback}</option>
      {value && <option value={sourceKey(value)}>{selectedLabel}</option>}
      {sources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
      {!!tabSources.length && <optgroup label="ES 标签">{tabSources.map(tab => <option key={tab.key} value={tab.key}>{tab.label}</option>)}</optgroup>}
    </select></InputSettingsField>
    <span className="pes-source-actions"><button type="button" className="button pes-button-tonal" disabled={!canCapture || loading} aria-label={`${label}记录快照`} onClick={onCapture}>记录快照</button>
      <PesSnapshotWarning label={`查看${label}结构问题`} issues={issues}/>
    </span>
  </InputSettingsRow>;
}

export function PesCalculationCard({ card, method = card.method.method, source, sources, tabSources = [], scope, update, setSlot, selectTab, capture, run, start, stop, move, remove, available, unavailableReason, canCapture, constraintIssue,sourceIssue,sourceLoading,selectAlgorithm,outsideGroup }: {
  card: PesCard; method?: PesMethodDraft['method']; source: PesGeometry; sources: readonly PesTabSnapshotSource[]; scope:PesSelectionScope; update(edit: (card: PesCard) => PesCard): void;
  tabSources?: readonly PesTabSnapshotSource[];
  outsideGroup?(geometry:PesGeometry):boolean;
  setSlot(slot: string, geometry?: PesGeometry): void; selectTab?(slot:string,key:string):void; capture(slot: string): void; run?: PesRun; start(): void; stop(): void;
  move(direction: -1 | 1): void; remove(): void; available: boolean; unavailableReason?:string; canCapture: boolean;
  constraintIssue?: string;sourceIssue?:string;sourceLoading?:boolean;
  selectAlgorithm?(algorithm:string):void;
}) {
  const [managing, setManaging] = useState(false);
  const live = isPesRunLive(run);
  const { structure } = source;
  const issues = useMemo(() => {
    const warnings: Record<string, string[]> = {};
    if (constraintIssue) warnings[card.kind === 'scan' ? 'start' : 'reactant'] = [constraintIssue];
    if (card.kind === 'path' && !sourceIssue) {
      if (card.slots.product)
        warnings.product = pesStructureCompatibilityIssues(structure, card.slots.product.structure, '产物');
      card.keys.forEach(({ id }, index) => {
        const keyframe = card.slots[id];
        if (keyframe) warnings[id] = pesStructureCompatibilityIssues(structure, keyframe.structure, `关键构型${index + 1}`);
      });
    }
    return warnings;
  }, [card.kind, card.slots, card.keys, constraintIssue, structure, sourceIssue]);
  if (card.kind === 'explore') return <InputSettingsCard sectionKey={`pes-card:${card.id}`} stack className="pes-calculation" title={`${PES_CARD_LABELS.explore} ${card.name}`}>
    <p>单端反应探索已停用，已有结果仍可查看和导出。</p>
    {run && <PesRunControls run={run} stop={stop}/>}
  </InputSettingsCard>;
  const algorithm = card.algorithm;
  const net=isPesNetMethod(method),pathBatch=algorithm==='ci-neb'||algorithm==='fsm';
  const overrideKey=pathBatch?'xtbBatchParallelism':'xtbSingleTaskThreads';
  const resourceOverride=card.resourceOverrides?.[overrideKey];
  const values = effectivePesPathParameters(algorithm, card.parametersByAlgorithm[algorithm] ?? {});
  const periodic=!sourceIssue&&Boolean(structure.cell?.pbc.some(Boolean));
  const parameter = (key: string, value: PesParameter) => update(current => ({ ...current,
    parametersByAlgorithm: { ...current.parametersByAlgorithm, [algorithm]: { ...current.parametersByAlgorithm[algorithm], [key]: value,
      ...(usesPesExecutionProfile(current.parametersByAlgorithm[algorithm]??{})&&['ciMaxForce','ciRmsForce','nebMaxForce','nebRmsForce'].includes(key)?{nebConvergencePreset:'custom'}:{}) } },
  }));
  const slot = (key: string, label: string, fallback?: string, fieldLabel?:string) => {
    const selected=card.slots[key];
    return <SourceRow label={label} fieldLabel={fieldLabel} fallback={card.requiredSlots?.includes(key)&&!selected?'请重新记录或选择结构':fallback}
      value={selected} sources={sources} tabSources={tabSources} loading={sourceLoading} canCapture={canCapture}
      outsideGroup={selected&&outsideGroup?.(selected)}
      issues={issues[key] ?? []}
      onSelect={geometry => setSlot(key, geometry)} onSelectTab={tabKey => selectTab?.(key,tabKey)} onCapture={() => capture(key)}/>;
  };
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
        {Object.entries(PES_ALGORITHMS.path).map(([key,label])=><option key={key} value={key}
          disabled={periodic&&!periodicPesOperationAvailable(method,'path',key)}>{label}</option>)}
      </select></InputSettingsField>}
      {card.kind==='path'&&algorithm==='ci-neb'&&<PesSelect label="初始路径" value={String(values.pathInitializer)} options={{sidpp:'S-IDPP',fsm:'FSM（原生两端生长）'}} onChange={value=>parameter('pathInitializer',value)}/>}
      {card.kind==='path'&&algorithm==='fsm'&&<PesSelect label="生长方式" value={String(values.fsmGrowth)} options={{native:'原生两端生长',sidpp:'S-IDPP引导'}} onChange={value=>parameter('fsmGrowth',value)}/>}
      {card.kind === 'path' && algorithm === 'de-gsm' && <PesSelect label="生长方式" value={String(usesPesExecutionProfile(values)?values.gsmGrowth??'native':'sidpp')} options={{native:'原生DLC生长',sidpp:'S-IDPP引导'}}
        onChange={gsmGrowth=>update(current=>({...current,parametersByAlgorithm:{...current.parametersByAlgorithm,[algorithm]:{...defaultParameters(algorithm),...current.parametersByAlgorithm[algorithm],executionProfile:PES_EXECUTION_PROFILE,gsmGrowth}}}))}/>}
      {card.kind === 'scan' && <>
        <PesScanSourceRow label={sourceIssue?undefined:source.label??structure.name} warnings={issues.start} issue={sourceIssue}/>
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
          {sourceLoading && <output>正在读取所选来源…</output>}
        </InputSettingsCard>
      </>}
      {algorithm==='ci-neb'&&<PesSelect label="路径优化器" value={String(values.nebOptimizer)}
        options={{lbfgs:'L-BFGS',fire2:'FIRE2',...(!usesPesExecutionProfile(values)||values.nebOptimizer==='fire'?{fire:'FIRE（已有设置）'}:{})}}
        onChange={value=>update(current=>{
          const previous=current.parametersByAlgorithm[algorithm]??{};
          const preset=String(previous.nebConvergencePreset??(usesPesExecutionProfile(previous)?'loose':'custom')) as PesConvergencePreset;
          return {...current,parametersByAlgorithm:{...current.parametersByAlgorithm,[algorithm]:{...nebPresetParameters(previous,preset),nebOptimizer:value}}};
        })}/>}
      {algorithm==='ci-neb'&&<PesSelect label="路径收敛标准" value={usesPesExecutionProfile(values)?String(values.nebConvergencePreset??'custom'):'legacy'}
        options={{...(!usesPesExecutionProfile(values)?{legacy:'已有FIRE设置'}:{}),...PES_CONVERGENCE_OPTIONS}}
        onChange={value=>update(current=>({...current,parametersByAlgorithm:{...current.parametersByAlgorithm,[algorithm]:nebPresetParameters(current.parametersByAlgorithm[algorithm]??{},value as PesConvergencePreset)}}))}/>}
      {algorithm==='de-gsm'&&<PesSelect label="节点收敛标准" value={String(values.gsmConvergencePreset??'loose')} options={PES_CONVERGENCE_OPTIONS}
        onChange={value=>update(current=>{
          const previous=current.parametersByAlgorithm[algorithm]??{};
          const selected=value==='custom'?previous.gsmConvergencePreset??'loose':value;
          const limits=GSM_CONVERGENCE_PRESETS[selected as keyof typeof GSM_CONVERGENCE_PRESETS];
          return {...current,parametersByAlgorithm:{...current.parametersByAlgorithm,[algorithm]:{...previous,...limits,gsmConvergencePreset:value}}};
        })}/>}
      {card.kind==='scan'?<PesScanOptimization card={card} update={update} periodic={periodic}/>:<PesParameterSections sections={pesParameterSections(algorithm,values).map(section=>({...section,fields:section.fields.filter(field=>
        !['gsmMaxGradient','gsmRmsGradient'].includes(field.key)||values.gsmConvergencePreset==='custom')}))} values={values} method={method} onChange={parameter}/>}
      {!net&&<details className="xtb-constraint-results"><summary>任务资源</summary><InputSettingsRow>
        <XtbResourceOverrideField label={pathBatch?'本任务 xTB 并行珠数':'本任务 xTB 线程'} value={resourceOverride} disabled={live}
          onChange={value=>update(current=>({...current,resourceOverrides:{...current.resourceOverrides,[overrideKey]:value}}))}/>
      </InputSettingsRow></details>}
      {!live && <InputSettingsRow variant="actions"><button type="button" className="button button-primary" disabled={!available || sourceLoading||!net&&!validXtbResourceOverride(resourceOverride)} title={unavailableReason} onClick={start}>{card.kind === 'scan' ? '开始扫描' : '开始计算'}</button></InputSettingsRow>}
    </>}
    {run && <PesRunControls run={run} stop={stop}/>}
  </InputSettingsCard>;
}
