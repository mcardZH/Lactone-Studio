import NumericInput from './NumericInput';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createEpsilonOnlySolvent, defaultSolventModel, findSolventEntry, getSolventEntries, hasSolvation, isEpsilonOnlySolvent, pcmSolventModel, validateSolventSelection, solventSelectionForModelChange } from '../core/solvents';
import type { SolventEngine, SolventModel, SolventParameters, SolventSelection } from '../core/solvents';
import { BookOpen } from 'lucide-react';
import SolventLibraryDialog, { solventDielectricLabel } from './SolventLibraryDialog';
import './solvents.css';
import { InputSettingsAction, InputSettingsEnableCard } from './InputSettingsLayout';

export interface SolventDraftMemory { current: { solvent:string; solvation?:SolventSelection; model:SolventModel } | null }

export interface SolventControlsProps {
  engine: SolventEngine;
  model: SolventModel;
  solvent: string;
  selection?: SolventSelection;
  version?: '5' | '6.0' | '6.1' | 'common';
  requireRefractiveIndex?: boolean;
  task?: string;
  modelManuallySelected?: boolean;
  disabled?: boolean;
  onReset?:()=>void;
  draftMemory?: SolventDraftMemory;
  onChange: (change: { solvent: string; solvation?: SolventSelection }) => void;
  onModelChange?: (model: SolventModel, origin?: 'manual' | 'automatic') => void;
}
const FIELDS: { key: keyof SolventParameters; label: string; description: string; unit?: string; min: number; max?: number }[] = [
  { key: 'dielectric', label: '静态介电常数 ε', description: '无量纲；与研究温度对应', min: 1 },
  { key: 'refractiveIndex', label: '折射率 n（293 K）', description: '无量纲；Gaussian 自动写入 EpsInf = n²', min: 1 },
  { key: 'hydrogenBondAcidity', label: '氢键酸性 α', description: 'Abraham 无量纲酸性参数', min: 0 },
  { key: 'hydrogenBondBasicity', label: '氢键碱性 β', description: 'Abraham 无量纲碱性参数', min: 0 },
  { key: 'surfaceTension', label: '表面张力 γ', unit: 'cal·mol⁻¹·Å⁻²', description: '1 mN/m = 1.43932 cal·mol⁻¹·Å⁻²', min: 0 },
  { key: 'aromaticity', label: '芳香碳比例 φ', description: '芳香碳原子数 / 非氢原子数，0–1', min: 0, max: 1 },
  { key: 'halogenicity', label: 'F/Cl/Br 比例 ψ', description: 'F、Cl、Br 原子数 / 非氢原子数，0–1；不计 I', min: 0, max: 1 },
];

/** Local, controlled selection. No effect selects a solvent or fills physical values. */
export function SolventControls(props: SolventControlsProps) {
  const { engine, model, version, solvent, selection, onChange, disabled } = props;
  const [libraryOpen, setLibraryOpen] = useState(false);
  useEffect(() => { if (disabled) setLibraryOpen(false); }, [disabled]);
  const [confirmSimplification, setConfirmSimplification] = useState(false);
  const manualModel = useRef(false);
  const localPaused = useRef<{ solvent: string; solvation?: SolventSelection; model: SolventModel } | null>(null);
  const paused=props.draftMemory??localPaused;
  const retainedId = selection?.mode === 'builtin' ? selection.id : findSolventEntry(engine, model, solvent, version)?.id;
  const available = useMemo(() => getSolventEntries(engine, model, version, retainedId), [engine, model, version, retainedId]);
  const legacy = selection ? undefined : findSolventEntry(engine, model, solvent, version);
  const currentId = selection?.mode === 'builtin' ? selection.id : legacy?.id;
  const custom = selection?.mode === 'custom';
  const enabled = hasSolvation({ solvent, solvation: selection });
  const mode = custom ? 'custom' : 'builtin';
  const epsilonOnly = isEpsilonOnlySolvent(selection);
  const chosen = available.find(entry => entry.id === currentId);
  const issues = validateSolventSelection(selection, engine, model, version, props);
  const fields = model === 'smd' ? FIELDS : FIELDS.slice(0, 2);
  const update = (key: keyof SolventParameters, value: number | undefined) => {
    onChange({ solvent: 'custom', solvation: { mode: 'custom', custom: {
      ...(selection?.custom ?? { name: '', dielectric: Number.NaN }), [key]: value,
    } } });
  };
  const setAutomaticModel = (next: SolventModel) => {
    if (next !== model) props.onModelChange?.(next, 'automatic');
  };
  const useSimplifiedCustom = (dielectric = Number.NaN) => {
    setAutomaticModel(pcmSolventModel(engine));
    onChange({ solvent: 'custom', solvation: createEpsilonOnlySolvent(dielectric) });
    setConfirmSimplification(false);
  };
  return <InputSettingsEnableCard className="solvent-controls" title="溶剂模型" actions={props.onReset&&<InputSettingsAction reset ariaLabel="恢复溶剂默认" onClick={props.onReset}>恢复默认</InputSettingsAction>} enabled={enabled} switchLabel={`${engine}启用溶剂模型`} disabled={disabled} testId={`${engine}-solvent-controls`} onEnabledChange={() => {
          setConfirmSimplification(false);
          setLibraryOpen(false);
          if (enabled) {
            paused.current = { solvent, solvation: selection, model };
            onChange({ solvent: 'gas', solvation: undefined });
          } else if (paused.current) {
            const previous = paused.current;
            const restoredModel = previous.solvation?.mode === 'custom'
              ? isEpsilonOnlySolvent(previous.solvation) ? pcmSolventModel(engine) : previous.model
              : (props.modelManuallySelected ?? manualModel.current) ? model : defaultSolventModel(engine, props.task, model);
            setAutomaticModel(restoredModel);
            onChange({ solvent: previous.solvent, solvation: solventSelectionForModelChange({engine,version,selection:previous.solvation,currentModel:previous.model,nextModel:restoredModel}) });
          } else {
            if (!(props.modelManuallySelected ?? manualModel.current)) setAutomaticModel(defaultSolventModel(engine, props.task, model));
            onChange({ solvent: '', solvation: { mode: 'builtin', id: '' } });
          }
        }}>
    {enabled && <><div className="solvent-controls-row">
      <label>溶剂环境<select aria-label={`${engine}溶剂环境`} disabled={disabled} value={mode} onChange={event => {
        setConfirmSimplification(false);
        setLibraryOpen(false);
        if (event.target.value === 'custom') useSimplifiedCustom();
        else onChange({ solvent: '', solvation: { mode: 'builtin', id: '' } });
      }}><option value="builtin">内置溶剂</option><option value="custom">自定义 ε</option></select></label>
      {props.onModelChange && <label>模型<select aria-label={`${engine}溶剂模型`} disabled={disabled} value={model}
        onChange={event => { manualModel.current = true; props.onModelChange?.(event.target.value as SolventModel, 'manual'); }}>
        <option value={engine === 'gaussian' ? 'iefpcm' : 'cpcm'}>{engine === 'gaussian' ? 'IEFPCM' : 'CPCM'}</option>
        <option value="smd" disabled={epsilonOnly}>SMD{epsilonOnly ? '（须完整描述符）' : ''}</option>
      </select></label>}
    </div>
    {mode === 'builtin' && <>
      <div className="solvent-current-row"><span>溶剂</span><button type="button" className="shared-input-action solvent-library-trigger" aria-label={`${engine}内置溶剂`} aria-haspopup="dialog" aria-expanded={libraryOpen} disabled={disabled}
        data-value={currentId ?? ''} onClick={() => setLibraryOpen(true)}><strong>{chosen ? `${chosen.chineseName} / ${chosen.englishName}` : solvent || currentId ? `${solvent || currentId}（未核对）` : '选择内置溶剂'}</strong><span><BookOpen size={16} aria-hidden="true" />浏览目录</span></button></div>
      {chosen && <span className="solvent-reference" title={chosen.dielectricReference?.source}>{solventDielectricLabel(chosen)}{version === 'common' && /^orca6\./.test(chosen.id) ? ` · 来源 ORCA ${chosen.id.split(':')[0].slice(4)}` : ''}</span>}
      {(currentId || solvent) && !chosen && <p className="solvent-library-retained" role="alert">原选择已保留，当前软件、模型或版本尚未核对；请浏览目录明确选择。</p>}
      {libraryOpen && !disabled && <SolventLibraryDialog key={`${engine}:${model}:${version}`} engine={engine} model={model} version={version} currentId={currentId} currentName={solvent || currentId}
        onClose={() => setLibraryOpen(false)} onSelect={entry => {
          if (!available.some(value => value.id === entry.id)) return;
          onChange({ solvent: entry.englishName, solvation: { mode: 'builtin', id: entry.id } });
        }} />}
    </>}
    {custom && epsilonOnly && <>
      <label>静态介电常数 ε<NumericInput aria-label={`${engine}静态介电常数 ε`} stepper={false} step="any" min="1.9" disabled={disabled}
        value={Number.isFinite(selection.custom?.dielectric) ? selection.custom!.dielectric : ''}
        onChange={event => onChange({ solvent: 'custom', solvation: createEpsilonOnlySolvent(event.target.value === '' ? Number.NaN : Number(event.target.value)) })} /></label>
      <p className="solvent-note" title="以固定光学介电常数近似，不能视为完整实测溶剂参数">光学响应近似：ε∞ = 1.9（n ≈ 1.3784）</p>
      {model === 'smd' && <button type="button" disabled={disabled} className="solvent-convert" onClick={() => setAutomaticModel(pcmSolventModel(engine))}>使用 {engine === 'gaussian' ? 'IEFPCM' : 'CPCM'} 简化模型</button>}
    </>}
    {custom && !epsilonOnly && <>
      <p className="solvent-note">已保留原有自定义参数与 {model.toUpperCase()} 模型。{model === 'smd' ? 'SMD 仍需完整七项描述符。' : ''}</p>
      <details className="solvent-legacy"><summary>查看 / 修改原有参数</summary>
      <label>溶剂名称<input aria-label={`${engine}自定义溶剂名称`} value={selection.custom?.name ?? ''} disabled={disabled}
        onChange={event => onChange({ solvent: 'custom', solvation: { mode: 'custom', custom: { ...(selection.custom ?? { dielectric: Number.NaN }), name: event.target.value } } })} /></label>
      <div className="solvent-parameters">{fields.map(field => <label key={field.key} title={field.description}><span>{field.label}{(model === 'smd' || field.key === 'dielectric' || props.requireRefractiveIndex) ? ' *' : '（可选）'}{field.unit && <small className="solvent-unit"> / {field.unit}</small>}</span>
        <NumericInput aria-label={`${engine}${field.label}`} stepper={false} step="any" min={field.min} max={field.max} disabled={disabled}
          value={Number.isFinite(selection.custom?.[field.key]) ? selection.custom![field.key] : ''}
          onChange={event => update(field.key, event.target.value === '' ? (field.key === 'dielectric' || model === 'smd' || props.requireRefractiveIndex ? Number.NaN : undefined) : Number(event.target.value))} />
      </label>)}</div>
      <details className="solvent-help"><summary>参数说明</summary><p className="solvent-note">{model === 'smd' ? 'SMD 七项均必填，使用同一可靠来源的完整参数。' : 'PCM/CPCM 填静态介电常数；垂直激发与非平衡响应还需折射率。'}</p><ul>{fields.map(field => <li key={field.key}>{field.label}：{field.description}</li>)}</ul></details>
      </details>
      {!confirmSimplification ? <button type="button" className="solvent-convert" disabled={disabled} onClick={() => setConfirmSimplification(true)}>改为仅填写 ε</button>
        : <div className="solvent-conversion-confirm" role="alert"><p>确认改为 {engine === 'gaussian' ? 'IEFPCM' : 'CPCM'}？将以 ε∞ = 1.9 近似光学响应，替换原有折射率与 SMD 描述符。</p>
          <button type="button" disabled={disabled} onClick={() => useSimplifiedCustom(selection.custom?.dielectric)}>确认简化</button>
          <button type="button" disabled={disabled} onClick={() => setConfirmSimplification(false)}>保留原参数</button></div>}
    </>}
    {issues.length > 0 && <ul className="solvent-issues" aria-live="polite">{issues.map(issue => <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>)}</ul>}
    </>}
  </InputSettingsEnableCard>;
}
