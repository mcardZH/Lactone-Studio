import {DismissibleNotice} from '../DismissibleNotice';
import NumericInput from '../NumericInput';
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { importStructureFiles } from '../../core/file-import';
import { withAtomIds } from '../../core/structures';
import type { InputStructureSource, Structure } from '../../core/types';
import type { OrcaAsset, OrcaJobRequest, OrcaSettings } from '../../core/orca/types';
import { OrcaIrcStartEvidence } from './OrcaHessianPathEvidence';
import type { TaskSelectionHandle, TaskSelectionIntent } from '../../modeling/contracts';
import { inputSelectionIndices } from '../../core/input-selection';
import InteractiveSelectionField from '../InteractiveSelectionField';
import ExcitedStructureStageControls from '../ExcitedStructureStageControls';
import OrcaCoordinates from './OrcaCoordinates';
import MultiStructureSourcePicker, { inputStructureSourceIsCurrent } from '../MultiStructureSourcePicker';
import type { MultiStructureSourceActions } from '../MultiStructureSourcePicker';
import { orcaNebConvergenceDefaults, orcaNebCustomConvergenceEnabled } from '../../core/orca/neb';
import './neb-panel.css';
import { CoreParameterGroup, FrequencyCoreControls, OptionalCoreNumber } from '../TaskCoreControls';
import { InputSettingsField, InputSettingsRow } from '../InputSettingsFields';
import { recommendedExcitedStates } from '../../core/input-recommendations';
import { getOrcaMethodProfile } from '../../core/orca/catalog';
import { orcaOptimizationHessianRoute } from '../../core/orca/optimization-hessian';

export type OrcaTaskControlsProps = MultiStructureSourceActions & { request: OrcaJobRequest; onChange: (request: OrcaJobRequest) => void; onBeforeLocalReset?:()=>void; selectedIds: string[]; onRequestSelection?: (intent: TaskSelectionIntent) => TaskSelectionHandle | void;sourceCandidates?:InputStructureSource[];nebProductSource?:InputStructureSource|null;onNebProductSourceChange?:(source:InputStructureSource|null)=>void;section?:'task'|'partition'|'all' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="orca-field"><span>{label}</span>{children}</label>;
}

function NumberField({ label, value, onChange, step = 'any', min, disabled=false }: {
  label: string; value: number | null | undefined; onChange: (value: number | undefined) => void;
  step?: string | number; min?: number; disabled?:boolean;
}) {
  return <Field label={label}><NumericInput aria-label={label} disabled={disabled} stepper={/目标Root|根数|点数|核数/.test(label)} step={step} min={min}
    value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
    onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value))} /></Field>;
}

function Check({ label, checked, onChange, disabled=false }: { label: string; checked: boolean; onChange: (value: boolean) => void;disabled?:boolean }) {
  return <label className="orca-check"><input type="checkbox" aria-label={label} checked={checked} disabled={disabled}
    onChange={event => onChange(event.target.checked)} />{label}</label>;
}

function NebConvergenceRow({ label, keyword, unit, value, defaultValue, onChange, onBeforeLocalReset, integer = false }: {
  label: string; keyword: string; unit?: string; value: number | undefined; defaultValue: number;
  onChange(value: number | undefined): void; onBeforeLocalReset?:()=>void; integer?: boolean;
}) {
  const id = useId();
  return <div className="neb-convergence-row">
    <label htmlFor={id}>{label}<small>{keyword}{unit ? ` / ${unit}` : ''}</small></label>
    <NumericInput id={id} aria-label={keyword} stepper={false} step={integer ? 1 : 'any'} min={integer ? 1 : 0}
      placeholder={`默认 ${defaultValue}`} title={`程序默认 ${defaultValue}${unit ? ` ${unit}` : ''}`}
      value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
      onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />
    <button type="button" aria-label={`${keyword}恢复默认`} disabled={value === undefined} onClick={() => {onBeforeLocalReset?.();onChange(undefined);}}>恢复默认</button>
  </div>;
}

function AssetField({ label, assets, kind, value, onChange, empty = '请选择已提供的文件' }: {
  label: string; assets: OrcaAsset[]; kind: OrcaAsset['kind']; value?: string;
  onChange: (value: string | undefined) => void; empty?: string;
}) {
  const available = assets.filter(asset => asset.kind === kind);
  return <Field label={label}><select aria-label={label} value={value ?? ''} onChange={event => onChange(event.target.value || undefined)}>
    <option value="">{empty}</option>
    {value && !available.some(asset => asset.id === value) && <option value={value}>失效文件引用（请重新选择）</option>}
    {available.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
  </select></Field>;
}

export default function OrcaTaskControls({ request, onChange, onBeforeLocalReset, selectedIds, onRequestSelection,sourceCandidates=[],nebProductSource,onNebProductSourceChange,onRequestSourcePick,onImportSources,section='all' }: OrcaTaskControlsProps) {
  const latest = useRef({ request, onChange }); latest.current = { request, onChange };
  const importRevision = useRef(0);
  const productChoiceReactant = useRef<Structure | null>(null);
  const [productChoices, setProductChoices] = useState<Structure[]>([]);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [showTsGuess,setShowTsGuess]=useState(Boolean(request.settings.neb.tsGuess||request.settings.neb.tsGuessSource));
  const s = request.settings;
  const optimization=s.optimization??{};
  const optimizerHessianSupported=orcaOptimizationHessianRoute(s)!=='none';
  const optimizing=['opt','optfreq','scan','ts','tdopt'].includes(s.task)&&!(s.task==='tdopt'&&s.excited.frequencyOnly);
  const withFrequency=['freq','optfreq','ts'].includes(s.task)||s.task==='tdopt'&&s.excited.frequency===true;
  const setOptimization=(patch:Partial<NonNullable<OrcaSettings['optimization']>>)=>update({optimization:{...optimization,...patch}});
  const boundProductSource = s.neb.productSource === undefined ? nebProductSource : s.neb.productSource;
  const atoms = request.structure?.atoms ?? [];
  const allAtomIds = atoms.flatMap(atom => atom.id ? [atom.id] : []);
  const update = (patch: Partial<OrcaSettings>) => onChange({ ...request, settings: { ...s, ...patch } });
  const excited = (patch: Partial<OrcaSettings['excited']>) => update({ excited: { ...s.excited, ...patch } });
  const neb = (patch: Partial<OrcaSettings['neb']>) => update({ neb: { ...s.neb, ...patch, mappingConfirmed: false } });
  const nebParameter = (patch: Partial<OrcaSettings['neb']>) => update({ neb: { ...s.neb, ...patch } });
  const nebDefaults = orcaNebConvergenceDefaults(s.neb.variant);
  const customConvergenceEnabled = orcaNebCustomConvergenceEnabled(s.neb);
  const retainedNebExtras = [
    s.neb.convergence?.convType !== undefined ? `ConvType=${s.neb.convergence.convType === 'cionly' ? 'CIOnly' : s.neb.convergence.convType}` : '',
    s.neb.convergence?.toleranceScale !== undefined ? `Tol_Scale=${s.neb.convergence.toleranceScale}` : '',
    s.neb.tsConvergence && Object.values(s.neb.tsConvergence).some(value => value !== undefined) ? (s.neb.variant === 'neb-ts' ? 'TS优化参数（%geom）' : 'TS优化参数（NEB-TS时生效）') : '',
  ].filter(Boolean);
  const canMapByIndex = (other: Structure | null | undefined) => !!other && atoms.length > 0 && other.atoms.length === atoms.length
    && atoms.every((atom, index) => !!atom.id && !!other.atoms[index].id && atom.element === other.atoms[index].element)
    && new Set(atoms.map(atom => atom.id)).size === atoms.length && new Set(other.atoms.map(atom => atom.id)).size === other.atoms.length;
  const md = (patch: Partial<OrcaSettings['md']>) => update({ md: { ...s.md, ...patch, restartConfirmed: false } });
  const currentSelection = selectedIds.filter(id => atoms.some(atom => atom.id === id));
  function assertMembers(ids: string[], assertCurrent: () => void) {
    assertCurrent(); const current = latest.current.request;
    if (!current.structure) throw new Error('结构已失效。');
    inputSelectionIndices(current.structure, ids);
  }
  const atomList = (ids: string[]) => ids.map(id => { const index = atoms.findIndex(atom => atom.id === id); return index < 0 ? '?' : index + 1; }).join(',') || '未指定';
  const requiredNumber = (value: number | undefined) => value ?? Number.NaN;
  function chooseProduct(product: Structure) {
    const current = latest.current;
    if (current.request.structure !== productChoiceReactant.current) {
      setImportError('反应物已变化，请重新导入Product以核对两端身份。'); setProductChoices([]); return;
    }
    current.onChange({ ...current.request, settings: { ...current.request.settings,
      neb: { ...current.request.settings.neb, product, productSource: null, mapping: [], mappingConfirmed: false } } });
    onNebProductSourceChange?.(null);
  }
  async function importProduct(files: File[]) {
    const revision = ++importRevision.current;
    const originalStructure = latest.current.request.structure;
    productChoiceReactant.current = originalStructure;
    setImporting(true); setImportError(''); setProductChoices([]);
    try {
      const choices = (await importStructureFiles(files)).map(withAtomIds);
      if (revision !== importRevision.current) return;
      if (latest.current.request.structure !== originalStructure) { setImportError('导入期间反应物已变化，请重新选择Product文件。'); return; }
      if (!choices.length) throw new Error('文件中没有可用结构。');
      if (choices.length === 1) chooseProduct(choices[0]);
      else setProductChoices(choices);
    } catch (cause) { if (revision === importRevision.current) setImportError(cause instanceof Error ? cause.message : 'Product导入失败。'); }
    finally { if (revision === importRevision.current) setImporting(false); }
  }

  return <>
    {section!=='partition'&&<>
    {(s.task === 'td' || s.task === 'tdopt') && <CoreParameterGroup title="激发态" ariaLabel="激发态任务设置">      {s.task === 'tdopt' && <ExcitedStructureStageControls section="stage" frequency={s.excited.frequency} frequencyOnly={s.excited.frequencyOnly} useUks={s.excited.useUks} uksAllowed={s.excited.targetSpin==='triplet'&&s.excited.root===1} onStageChange={excited} onUksChange={useUks=>excited({useUks})}/>}
<div className="orca-grid">
        <Field label="近似"><select aria-label="近似" value={s.excited.approximation} onChange={event => excited({ approximation: event.target.value as OrcaSettings['excited']['approximation'] })}>
          <option value="td">TDDFT</option><option value="tda">TDA</option><option value="stddft">sTD-DFT</option><option value="stda">sTDA</option>
        </select></Field>
        <Field label="自旋选项"><select aria-label="自旋选项" value={s.excited.targetSpin} onChange={event => excited({ targetSpin: event.target.value as 'singlet' | 'triplet', ...(event.target.value !== 'triplet' ? { useUks: false } : {}) })}>
          <option value="singlet">单重态 S</option><option value="triplet">三重态 T</option>
        </select></Field>
        <NumberField label="求解态数" disabled={s.task==='tdopt'&&s.excited.useUks===true} value={s.excited.rootsMode!=='auto'?s.excited.roots:recommendedExcitedStates(atoms.length,s.task==='tdopt'?'tdopt':'td',s.excited.root)} min={1} step={1} onChange={value => excited({ roots: requiredNumber(value),rootsMode:value===undefined?'auto':'manual' })} />
        <NumberField label="目标Root" value={s.excited.root} min={1} step={1} onChange={value => excited({ root: requiredNumber(value), ...(value !== 1 ? { useUks: false } : {}) })} />

      </div>
      {s.task === 'tdopt' && <ExcitedStructureStageControls section="uks" frequency={s.excited.frequency} frequencyOnly={s.excited.frequencyOnly} useUks={s.excited.useUks} uksAllowed={s.excited.targetSpin==='triplet'&&s.excited.root===1} onStageChange={excited} onUksChange={useUks=>excited({useUks})}/>}
      <Check label="计算自旋轨道耦合 SOC" checked={s.excited.soc} onChange={value => excited({ soc: value })} />
      <Check label="包含三重激发态 triplets" checked={s.excited.triplets} onChange={value => excited({ triplets: value })} />
      <Check label="输出组态系数" checked={s.excited.printCoefficients} onChange={value => excited({ printCoefficients: value })} />
      {(s.excited.approximation === 'stddft' || s.excited.approximation === 'stda') && <div className="orca-grid">
        <NumberField label="sTD能量窗口 EThresh / eV（空白沿核心默认）" value={s.excited.energyWindowEV} onChange={value => excited({ energyWindowEV: value })} />
        <NumberField label="sTD选择阈值 PThresh / Eh（空白沿核心默认）" value={s.excited.selectionThresholdEh} onChange={value => excited({ selectionThresholdEh: value })} />
        <NumberField label="sTD微扰窗口 PTLimit / eV（空白沿核心默认）" value={s.excited.perturbationWindowEV} onChange={value => excited({ perturbationWindowEV: value })} />
      </div>}

    </CoreParameterGroup>}

    {optimizing&&<CoreParameterGroup title={s.task==='ts'?'TS优化':'结构优化'}><InputSettingsRow><InputSettingsField label="收敛标准"><select aria-label="优化收敛标准" value={optimization.convergence??'default'} onChange={event=>setOptimization({convergence:event.target.value as NonNullable<OrcaSettings['optimization']>['convergence']})}><option value="default">任务默认</option><option value="loose">LooseOpt</option><option value="normal">NormalOpt</option><option value="tight">TightOpt</option><option value="verytight">VeryTightOpt</option></select></InputSettingsField><div className="input-hessian-group"><InputSettingsField label="Hessian策略"><select aria-label="ORCA Hessian策略" disabled={s.task==='ts'&&!!s.ircHessianId} value={optimization.hessian??'default'} onChange={event=>setOptimization({hessian:event.target.value as NonNullable<OrcaSettings['optimization']>['hessian']})}><option value="default">{s.task==='ts'?'计算初始Hessian':'程序默认'}</option><option value="calc" disabled={!optimizerHessianSupported}>计算初始Hessian</option><option value="recalc" disabled={!optimizerHessianSupported}>周期重新计算</option></select></InputSettingsField>{optimization.hessian==='recalc'&&<InputSettingsField label="Hessian重算间隔"><NumericInput aria-label="ORCA Hessian重算间隔" stepper={true} min="1" step="1" value={optimization.recalcInterval??''} onChange={event=>setOptimization({recalcInterval:event.target.value===''?undefined:Number(event.target.value)})}/></InputSettingsField>}</div></InputSettingsRow><InputSettingsRow><OptionalCoreNumber label="优化步数" integer value={optimization.maxIterations} onChange={value=>setOptimization({maxIterations:value??undefined})}/><OptionalCoreNumber label="优化步长 / au" value={optimization.maxStep} onChange={value=>setOptimization({maxStep:value??undefined})}/></InputSettingsRow></CoreParameterGroup>}
    {withFrequency&&<CoreParameterGroup title="频率"><FrequencyCoreControls value={s.frequency} onChange={frequency=>update({frequency:{raman:frequency.raman,temperatureK:frequency.temperatureK??undefined,pressureAtm:frequency.pressureAtm??undefined}})} ramanSupported={s.method!=='xtb2'&&!(s.task==='tdopt'&&!s.excited.useUks)&&(s.version==='6.1'||getOrcaMethodProfile(s.method,s.version)?.frequency==='numeric')}/></CoreParameterGroup>}
    {s.task === 'nmr' && <div data-field="nmr-options"><Field label="计算内容"><select aria-label="计算内容" value={s.nmr} onChange={event => update({ nmr: event.target.value as OrcaSettings['nmr'] })}>
      <option value="shielding">GIAO核屏蔽</option><option value="coupling">核屏蔽及自旋耦合</option>
    </select></Field></div>}
    {s.task === 'stable' && <Field label="稳定性任务"><select aria-label="稳定性任务" value={s.stableOptimize?'opt':'check'} onChange={event=>update({stableOptimize:event.target.value==='opt'})}><option value="check">仅检测</option><option value="opt">不稳定时优化</option></select></Field>}
    {s.task === 'irc' && <CoreParameterGroup title="双向IRC"><div className="orca-grid"><Field label="初始Hessian"><select aria-label="IRC初始Hessian" value={s.ircHessianId?'read':'calc'} onChange={event=>{if(event.target.value==='calc')update({ircHessianId:undefined});else{const asset=request.assets.find(row=>row.kind==='hessian');const next=asset??{id:crypto.randomUUID(),kind:'hessian' as const,name:''};onChange({...request,assets:asset?request.assets:[...request.assets,next],settings:{...s,ircHessianId:next.id}});}}}><option value="calc">计算初始Hessian</option><option value="read">读取来源HESS</option></select></Field><NumberField label="最大迭代次数" value={s.ircMaxIterations} min={1} step={1} onChange={value=>update({ircMaxIterations:value})}/></div></CoreParameterGroup>}

    {s.task === 'neb' && <CoreParameterGroup title="NEB两端与映射" ariaLabel="NEB设置">
      <Field label="模式"><select aria-label="NEB模式" value={s.neb.variant??'ci-neb'} onChange={event=>nebParameter({variant:event.target.value as 'ci-neb'|'neb-ts'})}><option value="ci-neb">CI-NEB</option><option value="neb-ts">NEB-TS</option></select></Field>
      <MultiStructureSourcePicker label="反应物来源" value={s.neb.reactantSource ?? null} candidates={sourceCandidates} onRequestSourcePick={onRequestSourcePick} onImportSources={onImportSources} onChange={source => nebParameter({ reactantSource: source, mapping: [], mappingConfirmed: false, tsGuessMapping: [], tsGuessMappingConfirmed: false })} />
      <MultiStructureSourcePicker label="产物来源" value={boundProductSource??null} candidates={sourceCandidates} onRequestSourcePick={onRequestSourcePick} onImportSources={onImportSources} onChange={source=>{const product=source?{...structuredClone(source.structure),charge:source.charge,multiplicity:source.multiplicity}:null;neb({product,productSource:source,mapping:[]});onNebProductSourceChange?.(source);}}/>
      {showTsGuess||s.neb.tsGuess||s.neb.tsGuessSource?<><MultiStructureSourcePicker label="过渡态初猜来源（可选）" value={s.neb.tsGuessSource ?? null} candidates={sourceCandidates} onRequestSourcePick={onRequestSourcePick} onImportSources={onImportSources} onChange={source => nebParameter({ tsGuess: source ? { ...structuredClone(source.structure), charge: source.charge, multiplicity: source.multiplicity } : null, tsGuessSource: source, tsGuessMapping: [], tsGuessMappingConfirmed: false })} /><button type="button" onClick={()=>{nebParameter({tsGuess:null,tsGuessSource:null,tsGuessMapping:[],tsGuessMappingConfirmed:false});setShowTsGuess(false);}}>移除过渡态初猜</button></>:<button type="button" onClick={()=>setShowTsGuess(true)}>添加过渡态初猜</button>}
      {boundProductSource&&(!boundProductSource.confirmed||!inputStructureSourceIsCurrent(boundProductSource,sourceCandidates))&&<DismissibleNotice role="alert" className="orca-note">产物来源已变或电子态待确认，请重新核对。</DismissibleNotice>}
      {!onImportSources && <Field label="导入产物结构（可同时选择依赖文件）"><input aria-label="导入Product结构" type="file" multiple disabled={importing}
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void importProduct(files); }} /></Field>
      }
      {importing && <p className="orca-note" role="status">正在读取Product结构…</p>}
      {importError && <DismissibleNotice className="orca-note" role="alert">{importError}</DismissibleNotice>}
      {productChoices.length > 1 && <Field label="选择Product来源帧"><select aria-label="选择Product来源帧" value="" onChange={event => { const product = productChoices[Number(event.target.value)]; if (product) { chooseProduct(product); setProductChoices([]); } }}>
        <option value="">请选择具体结构帧</option>{productChoices.map((product, index) => <option key={index} value={index}>{index + 1}. {product.name} · {product.atoms.length}原子</option>)}
      </select></Field>}
      {s.neb.product && <>
        <p className="orca-note">产物：{s.neb.product.name} · {s.neb.product.atoms.length}原子</p>
        <div className="orca-grid">
          <NumberField label="产物电荷（须明确核对）" value={s.neb.product.charge} step={1} onChange={value => neb({ product: { ...s.neb.product!, charge: value ?? null } })} />
          <NumberField label="产物多重度（须明确核对）" value={s.neb.product.multiplicity} min={1} step={1} onChange={value => neb({ product: { ...s.neb.product!, multiplicity: value ?? null } })} />
        </div>
        <details className="shared-input-inline"><summary>逐原子映射（编号从1开始）</summary>
          <button type="button" disabled={!canMapByIndex(s.neb.product)} onClick={() => { if (canMapByIndex(s.neb.product)) neb({ mapping: atoms.map((atom, index) => ({ reactantId: atom.id!, productId: s.neb.product!.atoms[index].id! })) }); }}>产物按当前编号对应</button>
          {atoms.map((atom, index) => <Field key={atom.id ?? index} label={`反应物 ${index + 1} ${atom.element} → Product`}>
            <select aria-label={`反应物原子${index + 1}的Product映射`} value={s.neb.mapping.find(pair => pair.reactantId === atom.id)?.productId ?? ''}
              onChange={event => neb({ mapping: [...s.neb.mapping.filter(pair => pair.reactantId !== atom.id), ...(event.target.value && atom.id ? [{ reactantId: atom.id, productId: event.target.value }] : [])] })}>
              <option value="">请选择对应原子</option>{s.neb.product!.atoms.map((productAtom, productIndex) => <option key={productAtom.id ?? productIndex} value={productAtom.id}>{productIndex + 1} {productAtom.element}</option>)}
            </select></Field>)}
        </details>
        <Check label="已逐项确认完整一一原子映射及两端电子态" disabled={!!boundProductSource&&(!boundProductSource.confirmed||!inputStructureSourceIsCurrent(boundProductSource,sourceCandidates))} checked={s.neb.mappingConfirmed&&(!boundProductSource||boundProductSource.confirmed&&inputStructureSourceIsCurrent(boundProductSource,sourceCandidates))} onChange={value => update({ neb: { ...s.neb, mappingConfirmed: value } })} />
        <button type="button" aria-label="清除Product及映射" onClick={() => {neb({ product: null, productSource: null, mapping: [] });onNebProductSourceChange?.(null);}}>清除Product</button>
      </>}
      {s.neb.tsGuess && <>
        <p className="orca-note">TS路径初猜：{s.neb.tsGuess.name} · {s.neb.tsGuess.atoms.length}原子</p>
        {s.neb.tsGuessSource && (!s.neb.tsGuessSource.confirmed || !inputStructureSourceIsCurrent(s.neb.tsGuessSource, sourceCandidates)) && <DismissibleNotice role="alert" className="orca-note">TS初猜来源已变或电子态未确认，请重新选择并核对。</DismissibleNotice>}
        <div className="orca-grid">
          <NumberField label="TS初猜电荷（须明确核对）" value={s.neb.tsGuess.charge} step={1} onChange={value => nebParameter({ tsGuess: { ...s.neb.tsGuess!, charge: value ?? null }, tsGuessMappingConfirmed: false })} />
          <NumberField label="TS初猜多重度（须明确核对）" value={s.neb.tsGuess.multiplicity} min={1} step={1} onChange={value => nebParameter({ tsGuess: { ...s.neb.tsGuess!, multiplicity: value ?? null }, tsGuessMappingConfirmed: false })} />
        </div>
        <details className="shared-input-inline"><summary>TS初猜逐原子映射（界面编号从1开始）</summary>
          <button type="button" disabled={!canMapByIndex(s.neb.tsGuess)} onClick={() => { if (canMapByIndex(s.neb.tsGuess)) nebParameter({ tsGuessMapping: atoms.map((atom, index) => ({ reactantId: atom.id!, productId: s.neb.tsGuess!.atoms[index].id! })), tsGuessMappingConfirmed: false }); }}>过渡态初猜按当前编号对应</button>
          {atoms.map((atom, index) => <Field key={atom.id ?? index} label={`反应物 ${index + 1} ${atom.element} → TS初猜`}>
            <select aria-label={`反应物原子${index + 1}的TS初猜映射`} value={s.neb.tsGuessMapping?.find(pair => pair.reactantId === atom.id)?.productId ?? ''}
              onChange={event => nebParameter({ tsGuessMapping: [...(s.neb.tsGuessMapping ?? []).filter(pair => pair.reactantId !== atom.id), ...(event.target.value && atom.id ? [{ reactantId: atom.id, productId: event.target.value }] : [])], tsGuessMappingConfirmed: false })}>
              <option value="">请选择对应原子</option>{s.neb.tsGuess!.atoms.map((guessAtom, guessIndex) => <option key={guessAtom.id ?? guessIndex} value={guessAtom.id}>{guessIndex + 1} {guessAtom.element}</option>)}
            </select></Field>)}
        </details>
        <Check label="已确认TS初猜完整一一映射及相同电子态" disabled={!!s.neb.tsGuessSource && (!s.neb.tsGuessSource.confirmed || !inputStructureSourceIsCurrent(s.neb.tsGuessSource, sourceCandidates))} checked={!!s.neb.tsGuessMappingConfirmed && (!s.neb.tsGuessSource || s.neb.tsGuessSource.confirmed && inputStructureSourceIsCurrent(s.neb.tsGuessSource, sourceCandidates))} onChange={value => nebParameter({ tsGuessMappingConfirmed: value })} />
        <button type="button" aria-label="清除TS初猜及映射" onClick={() => nebParameter({ tsGuess: null, tsGuessSource: null, tsGuessMapping: [], tsGuessMappingConfirmed: false })}>清除TS初猜</button>
      </>}
      <div className="orca-grid">
        <NumberField label="含两端的总珠子数" value={s.neb.images} min={3} step={1} onChange={value => neb({ images: requiredNumber(value) })} />
        <Check label="开启 S-IDPP" checked={s.neb.interpolation==='sidpp'} onChange={enabled=>neb({interpolation:enabled?'sidpp':'idpp'})}/>
        {s.neb.interpolation!=='sidpp'&&<Field label="初始路径插值"><select aria-label="初始路径插值" value={s.neb.interpolation} onChange={event => neb({ interpolation: event.target.value as OrcaSettings['neb']['interpolation'] })}><option value="idpp">IDPP</option><option value="linear">线性</option></select></Field>}
      </div>
      <Check label="自由端点 Free_End" checked={s.neb.freeEnds} onChange={value => neb({ freeEnds: value })} />
      <Check label="端点预优化 PreOpt" checked={s.neb.preOptimize} onChange={value => neb({ preOptimize: value })} />

      <Check label="自定义收敛参数" checked={customConvergenceEnabled} onChange={enabled => nebParameter({ customConvergenceEnabled: enabled })} />
      {customConvergenceEnabled && <div className="neb-convergence-panel" data-testid="neb-custom-convergence">
        <NebConvergenceRow label="最大CI力" keyword="Tol_MaxF_CI" unit="Eh/Bohr" value={s.neb.convergence?.maxForceCI} defaultValue={nebDefaults.maxForceCI} onBeforeLocalReset={onBeforeLocalReset} onChange={value => nebParameter({ convergence: { ...s.neb.convergence, maxForceCI: value } })} />
        <NebConvergenceRow label="CI力RMS" keyword="Tol_RMSF_CI" unit="Eh/Bohr" value={s.neb.convergence?.rmsForceCI} defaultValue={nebDefaults.rmsForceCI} onBeforeLocalReset={onBeforeLocalReset} onChange={value => nebParameter({ convergence: { ...s.neb.convergence, rmsForceCI: value } })} />
        <NebConvergenceRow label="开启CI阈值" keyword="Tol_Turn_On_CI" unit="Eh/Bohr" value={s.neb.convergence?.turnOnCI} defaultValue={nebDefaults.turnOnCI} onBeforeLocalReset={onBeforeLocalReset} onChange={value => nebParameter({ convergence: { ...s.neb.convergence, turnOnCI: value } })} />
        <NebConvergenceRow label="最大迭代轮数" keyword="MaxIter" integer value={s.neb.convergence?.maxIterations} defaultValue={nebDefaults.maxIterations} onBeforeLocalReset={onBeforeLocalReset} onChange={value => nebParameter({ convergence: { ...s.neb.convergence, maxIterations: value } })} />
      </div>}
      {retainedNebExtras.length > 0 && <p className="orca-note" data-testid="neb-retained-extras">保留额外设置：{retainedNebExtras.join('；')}。</p>}
    </CoreParameterGroup>}


    {s.task === 'md' && <CoreParameterGroup title="分子动力学条件" ariaLabel="MD设置"><div className="orca-grid">
      <NumberField label="时间步 / fs" value={s.md.timestepFs} onChange={value => md({ timestepFs: value ?? null })} />
      <NumberField label="运行步数" value={s.md.steps} min={1} step={1} onChange={value => md({ steps: value ?? null })} />
      <NumberField label="总时长 / fs" value={s.md.durationFs} onChange={value => md({ durationFs: value })} />
      <NumberField label="初速度温度 / K" value={s.md.initialTemperatureK} min={0} onChange={value => md({ initialTemperatureK: value ?? null })} />
      <Field label="恒温器"><select aria-label="恒温器" value={s.md.thermostat} onChange={event => md({ thermostat: event.target.value as OrcaSettings['md']['thermostat'] })}>
        <option value="none">无恒温器 None</option><option value="csvr">CSVR</option><option value="nhc">NHC</option>
      </select></Field>
      {s.md.thermostat !== 'none' && <>
        <NumberField label="目标温度 / K" value={s.md.targetTemperatureK} onChange={value => md({ targetTemperatureK: value ?? null })} />
        <NumberField label="耦合时间 / fs" value={s.md.couplingTimeFs} onChange={value => md({ couplingTimeFs: value ?? null })} />
      </>}
      <NumberField label="轨迹输出步距" value={s.md.trajectoryStride} min={1} step={1} onChange={value => md({ trajectoryStride: requiredNumber(value) })} />
    </div>
    <InteractiveSelectionField label="MD活动" structure={request.structure} engine="orca" purpose="active-atoms" rowId="orca-md-active-atoms" taskId={s.task} atomIds={s.md.activeAtomIds} contextKey={s.task} onRequestSelection={onRequestSelection} remainingAtomIds={allAtomIds.filter(id => !s.md.activeAtomIds.includes(id))} draftChoices={[{label:'采用当前选区',atomIds:currentSelection}]} onConfirm={(ids,assertCurrent) => { assertMembers(ids,assertCurrent); md({activeAtomIds:[...ids]}); }} />
    <button type="button" aria-label="清空MD活动列表并恢复全部原子" onClick={() => md({activeAtomIds:[]})}>清空活动列表（全部原子）</button>
    <p className="orca-note">活动原子：{s.md.activeAtomIds.length ? atomList(s.md.activeAtomIds) : '全部原子'}</p>
    <details className="shared-input-inline"><summary>继续原MD任务</summary><div className="orca-grid">
      <AssetField label="MD重启文件" assets={request.assets} kind="restart" value={s.md.restartAssetId} onChange={value => md({ restartAssetId: value })} empty="新任务，不读取重启" />
      <Field label="原MD任务身份"><input aria-label="原MD任务身份" value={s.md.taskIdentity} onChange={event => md({ taskIdentity: event.target.value })} /></Field>
    </div><Check label="已确认重启文件属于同一任务、同序原子及相同条件" checked={s.md.restartConfirmed} onChange={value => update({ md: { ...s.md, restartConfirmed: value } })} />
    <p className="orca-note">重启文件还需在资产区填写来源身份及原子顺序证据；更改MD条件后重新确认。</p></details>
    </CoreParameterGroup>}

    </>}
  </>;
}
