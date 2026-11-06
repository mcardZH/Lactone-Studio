import {DismissibleNotice} from '../DismissibleNotice';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState,useProjectUiRestored} from '../../projects/ui-state';
import {isRestoredAnalysisData} from '../../projects/analysis-state';
import {matchingSliderRange} from '../numeric-step';
import NumericInput from '../NumericInput';
import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import type { OrbitalField, OrbitalGridSpec, OrbitalResourceInfo, WavefunctionMetadata } from '../../results/orbital-contracts';
import type { DesktopBridge } from '../../modeling/contracts';
import { exportBlob } from './export-image';
import { InputSettingsLayout, InputSettingsCheckbox, InputSettingsAction } from '../InputSettingsLayout';
import AnalysisControls, { type AnalysisControlsContext, type AnalysisHighlightProps } from './AnalysisControls';
import { useAnalysisFeedback } from './AnalysisFeedback';
import OrbitalList, { type OrbitalListProps } from './OrbitalList';
import { ORBITAL_QUALITY_LEVELS, orbitalElectronMark } from './orbital-list-presentation';
import { DEFAULT_ORBITAL_SAMPLING, orbitalGridFor, useOrbitalField, projectOrbitalCubeArtifacts, type OrbitalBridge, type OrbitalSampling } from './useOrbitalField';
import { MULTIWFN_CONFIGURATION_CHANGED } from './MultiwfnPathControl';
import {useComputeResources} from '../useComputeResources';
import type {ComputeResourcePreferencesBridge} from '../../modeling/resource-preferences';
import MultiwfnProgress from './MultiwfnProgress';
import './orbital.css';
import type {TrajectoryResult} from '../../results/contracts';
import {printedOrbitalList} from './PrintedFrameProperties';
import {resolveNativeOrbitalKey} from '../../results/orbital-selection';
import type {PostprocessSourcePair} from '../../results/postprocess-sources';
import { DEFAULT_ORBITAL_LAYER, ORBITAL_COLOR_PRESETS, orbitalColorPreset, type OrbitalLayerSettings } from './orbital-display';
import MeshFinishControls from './MeshFinishControls';
import SurfaceAppearanceControls from './SurfaceAppearanceControls';
import { orbitalAppearance } from './surface-appearance';
import { useSurfaceAppearanceDefaults } from './useSurfaceAppearanceDefaults';
import SaveSurfaceAppearanceDefault from './SaveSurfaceAppearanceDefault';
import { captureOrbitalAppearance, restoreOrbitalAppearance } from './surface-appearance-defaults';
import {SpatialGridSummary,AnalysisTaskLayout,AnalysisTaskSection,AnalysisPlotSettings,CalculationQualityControl,type CalculationQualityTier} from './AnalysisTaskLayout';

export type { OrbitalLayerSettings } from './orbital-display';
export interface OrbitalControlsProps extends AnalysisHighlightProps {
  metadata: WavefunctionMetadata | null; nativeSessionId: string | null;
  selectedKey?: string | null; onSelectedKey?(key: string | null): void;
  onField(field: OrbitalField | null): void; onError(message: string): void;
  onLayerSettings(settings: OrbitalLayerSettings): void; onExportImage?(): void | Promise<void>;
  active?: boolean; cancelOnInactive?: boolean; bridge?: OrbitalBridge & Pick<DesktopBridge, 'orbitalResourceInfo'> & Partial<ComputeResourcePreferencesBridge>; analysis?: AnalysisControlsContext;
  sourceResult?:TrajectoryResult|null;sourceFrameIndex?:number;wavefunctionAvailable?:boolean;
  sourcePair?:PostprocessSourcePair;
  decimals?:number;onDecimalsChange?(value:number):void;
}
const DEFAULT_LAYER = DEFAULT_ORBITAL_LAYER;
const bytes = (value: number) => `${(value / 1024 ** 3).toFixed(3)} GiB`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const safeName = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'orbital';
export const orbitalOccupationSymbol = orbitalElectronMark;
export function OrbitalResourceSummary({info}:{info:OrbitalResourceInfo}) {
  const threadSource=info.computeResourceVersion?'全局设置':info.threadSource==='settings'?'settings.ini':info.threadSource==='logical-cpus'?'逻辑处理器':'本实例设置';
  return <p className="orbital-resource-summary">线程 {info.threads}（{threadSource}）；内存预算 {bytes(info.memoryBudgetBytes)}（{info.computeResourceVersion?'全局软预算':info.memorySource==='physical-ram'?'总物理内存':'本实例设置'}，非预留）。{info.nativeMemoryBudgetBytes!==undefined?`本次可用软预算 ${bytes(info.nativeMemoryBudgetBytes)}。`:''}{info.temporaryOverrides.some(value=>value.changed)?'本次临时覆盖；其他配置保留。':''}</p>;
}
/** Kept as the public list presentation export for adjacent consumers. */
export function OrbitalSelectionList(props: OrbitalListProps) { return <OrbitalList {...props}/>; }
export type OrbitalQuality = typeof ORBITAL_QUALITY_LEVELS[number]['id'] | 'custom';
const qualityTiers: Record<OrbitalQuality,CalculationQualityTier> = {toy:'toy',rough:'coarse',normal:'medium',fine:'fine',art:'artistic',custom:'custom'};
export const orbitalQualitySpacing=(quality:OrbitalQuality,customSpacing:number)=>quality==='custom'?customSpacing:ORBITAL_QUALITY_LEVELS.find(value=>value.id===quality)!.spacing;
/** One projection of exact orbital planning and retained field grids; never samples a field. */
export function OrbitalSpatialGridSummary({planned,actual}:{planned:OrbitalGridSpec|null;actual?:OrbitalGridSpec|null}) {
  const project=(grid:OrbitalGridSpec,estimated:boolean)=>({dimensions:grid.dimensions,pointCount:grid.dimensions.reduce((total,value)=>total*value,1),axisSpacingBohr:grid.axes.map(axis=>Math.hypot(...axis)),estimated});
  const same=planned&&actual&&JSON.stringify(planned)===JSON.stringify(actual);
  return <SpatialGridSummary unit="Å" actual={actual?project(actual,false):null} preview={planned&&!same?project(planned,true):null}/>;
}
export function OrbitalCalculationQuality({quality,spacing,onChange,label='轨道显示质量',disabled=false}:{quality:OrbitalQuality;spacing:number;onChange(quality:OrbitalQuality,spacing:number):void;label?:string;disabled?:boolean}) {
  return <CalculationQualityControl label="质量" value={quality} ariaLabel={label} disabled={disabled} options={[...ORBITAL_QUALITY_LEVELS.map(level=>({value:level.id as OrbitalQuality,tier:qualityTiers[level.id]})),{value:'custom',tier:'custom'}]} onChange={next=>onChange(next,orbitalQualitySpacing(next,spacing))}>
    {quality==='custom'?<label>格距 / Å<NumericInput aria-label={`${label}格距`}  min={.000001} step={.01} value={spacing} disabled={disabled} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&value>0)onChange('custom',value);}}/></label>:<output className="analysis-quality-effective" aria-label={`${label}格距`}>格距 {orbitalQualitySpacing(quality,spacing)} Å</output>}
  </CalculationQualityControl>;
}
/** Keeps the named library separate from the currently edited Local layer. */
export function OrbitalAppearanceOptions({value,onChange,children}:{value:OrbitalLayerSettings;onChange(value:OrbitalLayerSettings):void;children:ReactNode}) {
  const defaults = useSurfaceAppearanceDefaults();
  const [name,setName] = useProjectState('OrbitalControls.name', '');
  const [selection,setSelection] = useProjectState<{name:string;appearance:string}|null>('OrbitalControls.selection', null);
  const current = JSON.stringify(captureOrbitalAppearance(value));
  const selected = selection?.appearance === current ? selection.name : undefined;
  const named = defaults.snapshot?.namedOrbitalPresets ?? [];
  const selectNamed = (id:string) => {
    const row = named.find(item => `saved:${item.name}` === id);
    if (!row) return;
    const next = restoreOrbitalAppearance(value,{...row.appearance,presetId:'custom'});
    setSelection({name:id,appearance:JSON.stringify(captureOrbitalAppearance(next))});
    onChange(next);
  };
  const save = async () => {
    const requestedName = name;
    try { await defaults.saveNamed(requestedName.trim(),captureOrbitalAppearance(value)); setName(currentName=>currentName===requestedName?'':currentName); }
    catch { /* Shared preference action reports the accepted failure. */ }
  };
  return <SurfaceAppearanceControls label="轨道" presets={['orbital']} value={value.appearancePreset}
    namedPresets={named.map(row=>({id:`saved:${row.name}`,label:row.name}))} selectedNamedPreset={selected} onNamedPreset={selectNamed}
    onChange={id=>{setSelection(null);onChange(orbitalAppearance(value,id));}}
    actions={<SaveSurfaceAppearanceDefault family="orbital" appearance={captureOrbitalAppearance(value)}/>}>
    {children}
    <div className="orbital-draw-row orbital-draw-flow">
      <label>预设名称 <input className="appearance-preset-name" aria-label="轨道外观预设名称" type="text" maxLength={80} value={name} onChange={event=>setName(event.target.value)}/></label>
      <button type="button" aria-label="轨道保存命名预设" disabled={!name.trim()||!defaults.ready||!defaults.snapshot?.writable||defaults.busy} onClick={()=>void save()}>保存为新预设</button>
    </div>
  </SurfaceAppearanceControls>;
}
export function OrbitalDrawOptions({value,onChange,qualityControl,embedded=false}:{value:OrbitalLayerSettings;onChange(value:OrbitalLayerSettings):void;qualityControl?:ReactNode;embedded?:boolean}) {
  const patch = (next: Partial<OrbitalLayerSettings>) => onChange({ ...value, ...next });
  const numeric = (key: 'opacity' | 'isovalue', raw: string) => { const parsed = Number(raw); if (!Number.isFinite(parsed) || key === 'opacity' && (parsed < 0 || parsed > 1) || key === 'isovalue' && parsed <= 0) return; patch({ [key]: parsed }); };
  const controls=<>
    <OrbitalAppearanceOptions value={value} onChange={onChange}>
      <div className="orbital-draw-row orbital-draw-appearance orbital-draw-flow">
      <label>配色 <select aria-label="轨道配色" value={orbitalColorPreset(value)} onChange={event=>{const preset=ORBITAL_COLOR_PRESETS.find(row=>row.id===event.target.value);if(preset)patch({positiveColor:preset.positiveColor,negativeColor:preset.negativeColor});}}>{ORBITAL_COLOR_PRESETS.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}<option value="custom" disabled>自定义</option></select></label>
      <div className="orbital-draw-color-pair"><label>正 <input aria-label="轨道正相位颜色" type="color" value={value.positiveColor} onChange={event=>patch({positiveColor:event.target.value})}/></label><label>负 <input aria-label="轨道负相位颜色" type="color" value={value.negativeColor} onChange={event=>patch({negativeColor:event.target.value})}/></label></div>
      <MeshFinishControls inline labelPrefix="轨道" value={value.finish} onChange={finish=>patch({finish})}/>
      </div>
    </OrbitalAppearanceOptions>
    <div className="orbital-draw-row orbital-draw-appearance orbital-draw-flow"><InputSettingsCheckbox label="显示轨道" ariaLabel="显示轨道等值面" checked={value.visible} onChange={visible=>patch({visible})}/><select aria-label="轨道显示相位" value={value.phase ?? 'both'} onChange={event=>patch({phase:event.target.value as OrbitalLayerSettings['phase']})}><option value="both">正负双相位</option><option value="positive">仅正相位</option><option value="negative">仅负相位</option></select>
      {qualityControl&&<div className="orbital-draw-quality">{qualityControl}</div>}
    </div>
    <div className="orbital-draw-row orbital-draw-numbers"><label className="orbital-numeric-control"><span>不透明度</span><input aria-label="轨道不透明度滑杆" type="range" {...matchingSliderRange(value.opacity,0,1,.01)} value={value.opacity} onChange={event=>numeric('opacity',event.target.value)}/><NumericInput stepper adaptiveStep={0.1} aria-label="轨道不透明度"  min={0} max={1} step={.01} value={value.opacity} onChange={event=>numeric('opacity',event.target.value)}/></label><label className="orbital-numeric-control" title="等值单位 bohr⁻³ᐟ²"><span>等值</span><input aria-label="轨道等值滑杆" type="range" {...matchingSliderRange(value.isovalue,.001,.2,.001)} value={value.isovalue} onChange={event=>numeric('isovalue',event.target.value)}/><NumericInput stepper adaptiveStep={0.01} aria-label="轨道等值"  min={.000001} step={.001} value={value.isovalue} onChange={event=>numeric('isovalue',event.target.value)}/></label></div>
  </>;
  return embedded?<div className="orbital-draw-options is-embedded" aria-label="轨道绘制选项">{controls}</div>:<AnalysisPlotSettings><div className="orbital-draw-options is-embedded" aria-label="轨道绘制选项">{controls}</div></AnalysisPlotSettings>;
}
function OrbitalControlsInner(props: OrbitalControlsProps) {
  const appearanceDefaults=useSurfaceAppearanceDefaults(),appearanceInitialized=useRef(useProjectUiRestored());
  const { notify, feedback } = useAnalysisFeedback();
  const [localDecimals,setLocalDecimals]=useProjectState('OrbitalControls.localDecimals', 2),decimals=props.decimals??localDecimals;
  const setDecimals=(value:number)=>{setLocalDecimals(value);props.onDecimalsChange?.(value);};
  const bridge = props.bridge ?? (typeof window === 'undefined' ? null : window.sciyueDesktop ?? null);
  const canCompute=Boolean(props.nativeSessionId&&props.metadata&&props.wavefunctionAvailable!==false);
  const printed=useMemo(()=>printedOrbitalList(props.sourceResult??null,props.sourceFrameIndex??0),[props.sourceResult,props.sourceFrameIndex]);
  const list=printed??(canCompute?props.metadata:null);
  const identity = JSON.stringify([props.nativeSessionId,list?.sourceId,list?.sourceRevision]);
  const selectionIdentity = JSON.stringify([list?.sourceId,list?.sourceRevision,props.sourceFrameIndex??0]);
  const [selection,setSelection] = useProjectState<{identity:string;key:string|null}>('OrbitalControls.selection', {identity:selectionIdentity,key:null});
  const nativeKey=(key:string|null)=>canCompute?resolveNativeOrbitalKey({metadata:props.metadata,list,printed:!!printed,key,sourceResult:props.sourceResult,sourceFrameIndex:props.sourceFrameIndex,sourcePair:props.sourcePair}):null;
  const localSelected=selection.identity===selectionIdentity?selection.key:null;
  const selected = canCompute&&props.selectedKey!==undefined&&props.selectedKey!==nativeKey(localSelected)?props.selectedKey?list?.orbitals.find(row=>nativeKey(row.key)===props.selectedKey)?.key??null:null:localSelected;
  const selectedKey = nativeKey(selected);
  const [quality,setQuality] = useProjectState<OrbitalQuality>('OrbitalControls.quality', 'normal'),[customSpacing,setCustomSpacing]=useProjectState('OrbitalControls.customSpacing', .15);
  const [resources,setResources] = useState<OrbitalSampling>({...DEFAULT_ORBITAL_SAMPLING});
  const [resourceInfo,setResourceInfo]=useState<OrbitalResourceInfo|null>(null),[resourceReady,setResourceReady]=useState(false);
  const globalResources=useComputeResources(bridge??undefined);
  const [unit,setUnit] = useProjectState<'eV'|'hartree'>('OrbitalControls.unit', 'eV'),[layer,setLayer] = useProjectState<OrbitalLayerSettings>('OrbitalControls.layer', {...DEFAULT_LAYER});
  useEffect(()=>{if(!appearanceDefaults.ready||appearanceInitialized.current)return;appearanceInitialized.current=true;const saved=appearanceDefaults.snapshot?.value.orbital;if(saved&&'colors' in saved)setLayer(old=>restoreOrbitalAppearance(old,saved));},[appearanceDefaults.ready,appearanceDefaults.snapshot]);
  const changeLayer=(next:OrbitalLayerSettings)=>{appearanceInitialized.current=true;setLayer(next);};
  const [exporting,setExporting] = useState(false),[localError,setLocalError] = useState('');
  const [computeRequest,setComputeRequest]=useState<{identity:string;token:object;sampling:OrbitalSampling}|null>(null);
  const callbacks = useRef(props); callbacks.current=props; const liveIdentity=useRef(identity);liveIdentity.current=identity;
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    let alive=true,serial=0;
    const refresh=async()=>{
      const own=++serial;
      if(!canCompute){setResourceReady(true);return;}
      if(globalResources.loading||globalResources.error||!globalResources.snapshot){setResourceReady(false);if(globalResources.error)setLocalError(globalResources.error);return;}
      if(!bridge?.orbitalResourceInfo){setResourceReady(false);return;}
      try{
        const info=await bridge.orbitalResourceInfo();
        if(!alive||own!==serial)return;
        if(!Number.isSafeInteger(info.threads)||info.threads<=0||!Number.isSafeInteger(info.memoryBudgetBytes)||info.memoryBudgetBytes<=0)throw new Error('本机资源配置回执无效。');
        if(info.computeResourceVersion!==globalResources.snapshot.revision)throw new Error('计算资源配置已变化，请等待当前配置回执。');
        setResourceInfo(info);setResources(old=>({...old,threads:info.threads,memoryBudgetBytes:info.memoryBudgetBytes}));setResourceReady(true);
      }catch(error){if(alive&&own===serial){setLocalError(message(error));setResourceReady(false);}}
    };
    void refresh();const changed=()=>void refresh();
    if(typeof window!=='undefined')window.addEventListener(MULTIWFN_CONFIGURATION_CHANGED,changed);
    return()=>{alive=false;serial++;if(typeof window!=='undefined')window.removeEventListener(MULTIWFN_CONFIGURATION_CHANGED,changed);};
  },[bridge,canCompute,globalResources.loading,globalResources.error,globalResources.snapshot?.revision]);
  const spacing=orbitalQualitySpacing(quality,customSpacing);
  const sampling=useMemo(()=>({...resources,spacingAngstrom:spacing}),[resources,spacing]);
  const {controller,state,field}=useOrbitalField({bridge,metadata:canCompute?props.metadata:null,sessionId:canCompute?props.nativeSessionId:null,selectedKey,active:props.active!==false,cancelOnInactive:props.cancelOnInactive,computeIntent:computeRequest?.identity===identity?computeRequest.token:null,sampling:computeRequest?.identity===identity?computeRequest.sampling:sampling,onError: text=>{setLocalError(text);callbacks.current.onError(text);}});
  useEffect(()=>{callbacks.current.onField(field);return()=>callbacks.current.onField(null);},[field,identity]);
  useEffect(()=>{callbacks.current.onLayerSettings(layer);},[layer,identity]);
  const gridResult=useMemo(()=>{if(!props.metadata)return{grid:null,error:''};try{return{grid:orbitalGridFor(props.metadata,sampling),error:''};}catch(error){return{grid:null,error:message(error)};}},[props.metadata,sampling]);
  const status=state.planning?'正在准备当前轨道…':state.progress?.status==='running'||state.progress?.status==='queued'?'正在计算当前轨道…':field?'当前轨道可用':selectedKey?state.error||'当前轨道未缓存':'';
  const busy=state.planning||state.progress?.status==='running'||state.progress?.status==='queued';
  function requestCompute(key=selectedKey){if(key&&resourceReady)setComputeRequest({identity,token:{},sampling:{...sampling}});}
  function choose(key:string){const next=key;setSelection({identity:selectionIdentity,key:next});const computeKey=nativeKey(next);if(computeKey!==selectedKey)props.onSelectedKey?.(computeKey);if(computeKey){if(!resourceReady||state.backend?.configured===false)notify('请先配置本机 Multiwfn');else if(key!==selected||!field)requestCompute(computeKey);}else if(next&&canCompute)notify('此轨道只有来源数值，未找到匹配的已保存系数。');setLocalError('');}
  async function exportCube(){if(exporting)return;if(field&&isRestoredAnalysisData(field)&&props.metadata){try{const files=projectOrbitalCubeArtifacts(field,props.metadata);exportBlob(new Blob([files.cube],{type:'text/plain'}),'Ester-Studio-orbital.cube');exportBlob(new Blob([files.metadata],{type:'application/json'}),'Ester-Studio-orbital.sciyue-domain.json');}catch(error){setLocalError(message(error));}return;}if(!field||!props.nativeSessionId||!selectedKey){notify('请先选择并计算轨道');return;}if(!bridge?.exportOrbitalCube){notify('当前环境不支持 Cube 导出');return;}const started=identity;setExporting(true);try{const text=await bridge.exportOrbitalCube(props.nativeSessionId,selectedKey);if(!mounted.current||liveIdentity.current!==started)return;if(!text?.trim())throw new Error('轨道 Cube 导出回执为空。');exportBlob(new Blob([text],{type:'text/plain;charset=utf-8'}),`${safeName(props.metadata?.name??'wavefunction')}-${safeName(selectedKey)}.cube`);}catch(error){if(mounted.current&&liveIdentity.current===started)setLocalError(message(error));}finally{if(mounted.current)setExporting(false);}}
  const diagnostics=canCompute&&<details className="orbital-diagnostics"><summary>采样与后端详情</summary>
    <p>当前来源：{props.metadata?.name}</p><p>状态：{state.backend?.configured?'Multiwfn 已配置':'未配置 Multiwfn'}</p>{state.backend?.path&&<p className="orbital-backend-path">{state.backend.path}</p>}
    <div className="orbital-resource-grid"><label>边界留白 / Å<NumericInput aria-label="轨道边界留白"  min={.01} step={.5} value={resources.paddingAngstrom} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&value>0&&value!==resources.paddingAngstrom){setResources(old=>({...old,paddingAngstrom:value}));}}}/></label></div>
    {(state.progress?.resources??state.plan?.resources??resourceInfo)&&<OrbitalResourceSummary info={(state.progress?.resources??state.plan?.resources??resourceInfo)!}/>}
    {gridResult.grid&&<p>网格 {gridResult.grid.dimensions.join(' × ')}；内存预算 {bytes(resources.memoryBudgetBytes)}</p>}{state.plan&&<p>当前内存估计 {bytes(state.plan.totalBytes)}</p>}{state.error&&<DismissibleNotice>{state.error}</DismissibleNotice>}
  </details>;
  return <InputSettingsLayout><section className="orbital-controls" data-testid="orbital-controls" aria-label="轨道">
    <AnalysisTaskLayout variant="card" title={props.analysis?.generatedXtb?'空间分子轨道':'分子轨道'} onRestoreQuality={canCompute?()=>{setQuality('normal');setCustomSpacing(.15);}:undefined} qualityDisabled={busy}
      quality={canCompute&&<><OrbitalCalculationQuality quality={quality} spacing={spacing} onChange={(next,value)=>{setQuality(next);setCustomSpacing(value);}}/>{(gridResult.grid||field?.grid)&&<OrbitalSpatialGridSummary planned={gridResult.grid} actual={field?.grid}/>}{selectedKey&&computeRequest?.identity===identity&&JSON.stringify(computeRequest.sampling)!==JSON.stringify(sampling)&&<InputSettingsAction disabled={!resourceReady||busy||!!gridResult.error} onClick={()=>requestCompute()}>应用质量</InputSettingsAction>}</>}
      progress={canCompute&&<><MultiwfnProgress progress={state.taskProgress??null} operationLabel="轨道格点生成" onStop={()=>{void controller?.stop().catch(error=>setLocalError(message(error)));}}/>{busy&&!state.taskProgress&&<div className="orbital-planning-progress"><output role="status">{status}</output><InputSettingsAction onClick={()=>{void controller?.stop().catch(error=>setLocalError(message(error)));}}>停止</InputSettingsAction></div>}</>}
      >
    {list&&<AnalysisTaskSection title="轨道列表"><OrbitalList metadata={list} selectedKey={selected} unit={unit} decimals={decimals} onDecimalsChange={setDecimals} onUnit={setUnit} onChoose={choose} active={props.active!==false} readOnly={!canCompute}/></AnalysisTaskSection>}
    {canCompute&&<AnalysisTaskSection title="轨道绘图" onRestore={()=>{const saved=appearanceDefaults.snapshot?.value.orbital,base={...DEFAULT_LAYER,isovalue:layer.isovalue};changeLayer(saved && 'colors' in saved ? restoreOrbitalAppearance(base,saved):base);}}><OrbitalDrawOptions embedded value={layer} onChange={changeLayer}/><details className="orbital-export-menu"><summary>导出</summary><InputSettingsAction disabled={exporting||!field} onClick={()=>void exportCube()}>当前轨道 Cube</InputSettingsAction>{props.onExportImage&&<InputSettingsAction disabled={!field} onClick={()=>void props.onExportImage?.()}>当前视图图片</InputSettingsAction>}</details></AnalysisTaskSection>}
    {!canCompute?<p className="postprocess-note">{list?'当前帧缺少匹配波函数，轨道数值仍可查看；轨道格点与组成计算不可用。':'当前帧没有可靠轨道数值；请补入来源或匹配波函数。'}</p>:<>
      {localError&&<DismissibleNotice role="alert">{localError}</DismissibleNotice>}{gridResult.error&&<DismissibleNotice role="alert">{gridResult.error}</DismissibleNotice>}
    </>}{diagnostics}{feedback}</AnalysisTaskLayout>
    {canCompute&&<AnalysisControls key={identity} kind="composition" context={props.analysis} orbitalKey={selectedKey} active={props.active!==false} cancelOnInactive={props.cancelOnInactive} defaultMethod={props.analysis?.generatedXtb?'scpa':'mulliken'} autoCalculate={false} onAtomHighlight={props.onAtomHighlight}/>}
  </section></InputSettingsLayout>;
}

export default function OrbitalControls(p: Parameters<typeof OrbitalControlsInner>[0]) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['OrbitalControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><OrbitalControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:OrbitalControlsInner(p);
}
