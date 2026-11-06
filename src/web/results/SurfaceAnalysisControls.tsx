import {DismissibleNotice} from '../DismissibleNotice';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import {useAnalysisProjectSnapshot,rebindAnalysisContext,isRestoredAnalysisData,analysisProjectCubeArtifacts} from '../../projects/analysis-state';
import {matchingSliderRange} from '../numeric-step';
import NumericInput from '../NumericInput';
import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react';
import type { SurfaceAnalysisResult, SurfaceAreaDistribution, SurfaceCubeQuality, SurfaceFunction, SurfaceGeneratedFields, SurfaceQuantitativeGrid, SurfaceRegionResult, SurfaceRegionSelection, SurfaceScalarField } from '../../results/surface-contracts';
import { DEFAULT_SURFACE_ISOVALUE } from '../../results/surface-contracts';
import { convertSurfaceMappingValue, convertSurfaceMetric, sameSurfaceContext, SURFACE_FUNCTIONS, validateSurfaceAnalysisResult, validateSurfaceCubeQuality, validateSurfaceFieldPair, validateSurfaceScalarField } from '../../results/surface-field';
import { InputSettingsField, InputSettingsRow } from '../InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox, InputSettingsLayout } from '../InputSettingsLayout';
import { ScientificDataTable, type ScientificDataTableProps } from './ScientificDataTable';
import { ScientificPlot } from './ScientificPlot';
import { scientificTableText, type ScientificTableProjection, type ScientificTableRow, type ScientificTableFormat } from './scientific-table';
import { scientificDisplayValue as number } from './scientific-presentation';
import { DEFAULT_RESULT_DECIMALS } from '../../results/numeric-format';
import { ANALYSIS_PALETTES, toggleAnalysisRow } from './analysis-display';
import { exportBlob } from './export-image';
import { useAnalysisFeedback } from './AnalysisFeedback';
import { surfaceContextKey, surfaceDisplayUnit, surfaceDistributionSeries, surfaceDistributionSummary, surfaceDistributionTable, surfaceEspMetricTables, surfaceExtremaRange, surfaceExtremaTable, surfaceExtremumIdentity, surfaceExtremumLabel, surfaceExtremumCoordinates, surfaceExtremumPosition, surfaceMetricTable } from './surface-presentation';
import type { SurfaceAnalysisControlsProps, SurfaceCapabilityRequest, SurfaceDisplaySettings, SurfaceProjection } from './surface-controls-contracts';
import {surfaceCapabilityKey} from './surface-capability';
import { surfaceFieldDefinition, surfaceFieldDescriptor, surfaceGenerationDescriptor, type SurfaceFieldDescriptor, type SurfaceGenerationDescriptor } from './surface-ui-cache';
import { DEFAULT_MESH_FINISH } from '../../results/mesh-appearance';
import MeshFinishControls from './MeshFinishControls';
import SurfaceAppearanceControls from './SurfaceAppearanceControls';
import { mappedSurfaceAppearance } from './surface-appearance';
import { useSurfaceAppearanceDefaults } from './useSurfaceAppearanceDefaults';
import SaveSurfaceAppearanceDefault from './SaveSurfaceAppearanceDefault';
import { captureMappedAppearance, restoreMappedAppearance } from './surface-appearance-defaults';
import './Postprocess.css';
import './SurfaceInteractionControls.css';
import {createMultiwfnProgressTracker,type MultiwfnProgressSnapshot} from '../../results/multiwfn-progress';
import MultiwfnProgress from './MultiwfnProgress';
import { SpatialGridSummary, AnalysisTaskLayout, AnalysisTaskSection, CalculationQualityControl } from './AnalysisTaskLayout';
import { SURFACE_ANALYSIS_DEFAULT_SPACING, SURFACE_ANALYSIS_QUALITY_OPTIONS, SURFACE_CUBE_QUALITY_OPTIONS, surfaceCubeBudgetIssue, surfaceGridPreview, surfaceCubePreset, surfaceCubePresetFor, surfaceQuantitativePreset, surfaceQuantitativePresetFor, type SurfaceCubeQualityPreset } from './surface-quality';
import AnalysisColorbarLayoutControls from './AnalysisColorbarLayoutControls';
import { normalizeAnalysisColorbarLayout, type AnalysisColorbarLayout } from './analysis-colorbar-layout';
import './surface-analysis-controls.css';

export type { SurfaceAnalysisControlsProps, SurfaceControlsBridge, SurfaceProjection, SurfaceInteractionPort } from './surface-controls-contracts';
interface CubeSlot { name: string; field: SurfaceScalarField | null; descriptor?: SurfaceFieldDescriptor; status: 'empty' | 'reading' | 'ready' | 'error' | 'released'; message?: string; file?: File; pendingName?: string; pendingFile?: File; failedFile?: File }
interface AnalysisCache { key: string; analysis: SurfaceAnalysisResult; regions: readonly SurfaceRegionResult[]; generated?: SurfaceGeneratedFields; generation?: SurfaceGenerationDescriptor; distributions: Record<string, SurfaceAreaDistribution> }
const emptySlot = (): CubeSlot => ({ name: '', field: null, status: 'empty' });
const initialDisplay = (): SurfaceDisplaySettings => mappedSurfaceAppearance({ visible: true, opacity: .8, finish: DEFAULT_MESH_FINISH, palette: 'blue-red', rangeLocked: false, reverse: false, markersVisible: true, valuesVisible: true, coordinatesVisible: false, showAllExtremaValues: false, pinnedExtremumIds: [], hoveredExtremumId: null, hiddenExtremumIds: [] }, 'gallery-esp');
const releaseSlot = (slot: CubeSlot): CubeSlot => {
  const descriptor = slot.field ? surfaceFieldDescriptor(slot.field) : slot.descriptor;
  return { name: slot.field || descriptor ? slot.name : '', field: null, descriptor, status: descriptor ? 'released' : 'empty', message: descriptor ? '显示格点已释放，等待只读恢复。' : undefined };
};
const reasonText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
/** Verified native menu default; the request remains native-default until the user edits it. */
export { SURFACE_ANALYSIS_DEFAULT_SPACING, SURFACE_ANALYSIS_SPACING_PRESETS } from './surface-quality';
export function surfaceQualityLabel(quality: SurfaceCubeQuality) { return quality.mode === 'target-points' ? `目标约 ${quality.targetPoints.toLocaleString()} 点` : quality.mode === 'spacing' ? `${number(quality.spacingBohr)} Bohr` : quality.mode === 'dimensions' ? quality.dimensions.join(' × ') : ({ low: '低', medium: '中', high: '高' })[quality.mode]; }

function SurfaceTable(p: { title?: string; projection: ScientificTableProjection; exportProjection?: ScientificTableProjection; fileName: string; selectionScope: string; format?: ScientificTableFormat; sorting?: ScientificDataTableProps['sorting']; activeRowKey?: string; onRowActivate?: ScientificDataTableProps['onRowActivate']; onRowPreview?: ScientificDataTableProps['onRowPreview']; onClearActive?: ScientificDataTableProps['onClearActive']; expansion?: ScientificDataTableProps['expansion']; rowBindings?(row: ScientificTableRow): HTMLAttributes<HTMLTableRowElement>; rowActions?: ScientificDataTableProps['rowActions'] }) {
  const root = useRef<HTMLDivElement>(null);
  return <div ref={root} className="analysis-result"><ScientificDataTable title={p.title ?? ''} projection={p.projection} selectionScope={p.selectionScope} format={p.format} sorting={p.sorting} activeRowKey={p.activeRowKey} onRowActivate={p.onRowActivate} onRowPreview={p.onRowPreview} onClearActive={p.onClearActive} expansion={p.expansion} rowBindings={p.rowBindings} rowActions={p.rowActions} onExport={() => exportBlob(new Blob([scientificTableText(p.exportProjection ?? p.projection)], { type: 'text/plain;charset=utf-8' }), p.fileName, root.current?.ownerDocument)}/></div>;
}
function SurfaceAnalysisControlsInner(p: SurfaceAnalysisControlsProps) {
  const appearanceDefaults=useSurfaceAppearanceDefaults();
  const { notify, feedback, clear } = useAnalysisFeedback();
  const [fn, setFunction] = useState<SurfaceFunction>('esp'), [inputKind, setInputKind] = useState<'wavefunction' | 'cubes'>('wavefunction');
  const [isovalue, setIsovalue] = useState(DEFAULT_SURFACE_ISOVALUE), [quantitativeGrid, setQuantitativeGrid] = useState<SurfaceQuantitativeGrid>({ mode: 'spacing', spacingBohr: SURFACE_ANALYSIS_DEFAULT_SPACING });
  const [analysisPreset, setAnalysisPreset] = useState<string>('native-default');
  const [quality, setQuality] = useState<SurfaceCubeQuality>({ mode: 'medium' }), [scope, setScope] = useState<'molecule' | 'atoms' | 'fragment'>('molecule'), [atomIds, setAtomIds] = useState<string[]>([]), [regionId, setRegionId] = useState('');
  const [cubePreset, setCubePreset] = useState<SurfaceCubeQualityPreset>('medium');
  const [shape, setShape] = useState<CubeSlot>(emptySlot), [mappings, setMappings] = useState<Partial<Record<SurfaceFunction, CubeSlot>>>({}), [cubeUnits, setCubeUnits] = useState<Record<string, string>>({});
  const [records, setRecords] = useState<Partial<Record<SurfaceFunction, AnalysisCache>>>({}), [displays, setDisplays] = useState<Partial<Record<SurfaceFunction, SurfaceDisplaySettings>>>({}), [units, setUnits] = useState<Partial<Record<SurfaceFunction, string>>>({});
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(''), [rangeDraft, setRangeDraft] = useState<[string, string]>(['', '']);
  const [distributionBounds, setDistributionBounds] = useState<[string, string]>(['', '']), [binCount, setBinCount] = useState(50), [distributionQuantity, setDistributionQuantity] = useState<'area' | 'fraction'>('area');
  const [distributionAppearances, setDistributionAppearances] = useState<Record<string, { smooth: boolean; showBins: boolean }>>({});
  const [stateOwnerKey, setStateOwnerKey] = useState(() => surfaceContextKey(p.context));
  const [restoreRetry, setRestoreRetry] = useState(0), [restoreMessage, setRestoreMessage] = useState('');
  const [showAllMetrics, setShowAllMetrics] = useProjectState('SurfaceAnalysisControls.showAllMetrics', false);
  // Card-instance presentation only: deliberately outside scientific/frame snapshots and cache identities.
  const [extremaSort,setExtremaSort]=useProjectState<{column:string;direction:'asc'|'desc'}>('SurfaceAnalysisControls.extremaSort', {column:'identity',direction:'asc'});
  const [decimals, setDecimals] = useProjectState('SurfaceAnalysisControls.decimals', DEFAULT_RESULT_DECIMALS), [extremaDecimals, setExtremaDecimals] = useProjectState('SurfaceAnalysisControls.extremaDecimals', DEFAULT_RESULT_DECIMALS), [distributionDecimals, setDistributionDecimals] = useProjectState('SurfaceAnalysisControls.distributionDecimals', DEFAULT_RESULT_DECIMALS);
  const [extremaUnits, setExtremaUnits] = useState<Partial<Record<SurfaceFunction, string>>>({}), [distributionUnits, setDistributionUnits] = useState<Partial<Record<SurfaceFunction, string>>>({});
  const [colorbarUnits,setColorbarUnits]=useState<Partial<Record<SurfaceFunction,string>>>({});
  const [distributionError, setDistributionError] = useState('');
  const snapshot = { fn, inputKind, isovalue, quantitativeGrid, analysisPreset, quality, cubePreset, scope, atomIds, regionId, shape, mappings, cubeUnits, records, displays, units, extremaUnits, distributionUnits, colorbarUnits, rangeDraft, distributionBounds, binCount, distributionQuantity, distributionAppearances };
  const snapshots = useRef(new Map<string, typeof snapshot>()), currentSnapshot = useRef(snapshot);
  useAnalysisProjectSnapshot(`controls:surface:${projectUiSourceIdentity(p)}`,async()=>{
    const values=new Map(snapshots.current);values.set(stateOwnerKey,currentSnapshot.current);
    const complete=new Map<string,typeof snapshot>();
    for(const [key,value] of values){
      const [sourceId,sourceRevision,jobIndex,sourceFrameIndex,generation,documentId,documentRevision]=JSON.parse(key);
      const sourceContext={...p.context,sourceId,sourceRevision,jobIndex,sourceFrameIndex,generation,documentId,documentRevision};
      const cleanSlot=async(slot:CubeSlot):Promise<CubeSlot>=>{
        const {file,pendingFile,failedFile,pendingName,...saved}=slot;
        if(!saved.field&&saved.descriptor){
          if(!p.bridge.restoreCube)throw new Error('无法完整保存表面Cube：已释放格点缺少只读恢复接口。');
          const d=saved.descriptor;saved.field=await p.bridge.restoreCube({context:sourceContext,requestId:crypto.randomUUID(),fieldId:d.fieldId,sourceId:d.sourceId,sourceRevision:d.sourceRevision},new AbortController().signal);
          validateSurfaceScalarField(saved.field);if(saved.field.id!==d.fieldId||saved.field.source.revision!==d.sourceRevision)throw new Error('表面Cube恢复身份不符。');
        }
        return {...saved,status:saved.field?'ready':'empty',message:undefined};
      };
      const records=structuredClone(value.records);
      for(const [fn,record] of Object.entries(records))if(record?.generation&&!record.generated){
        if(!p.bridge.restoreFields)throw new Error('无法完整保存表面结果：已释放格点缺少只读恢复接口。');
        record.generated=await p.bridge.restoreFields({context:record.analysis.stamp,requestId:crypto.randomUUID(),analysisId:record.analysis.stamp.analysisId,generationId:record.generation.generationId},new AbortController().signal);
        if(!validateSurfaceFieldPair(record.generated.pair).compatible||record.generated.pair.shape.id!==record.generation.shapeId)throw new Error(`表面${fn}恢复身份不符。`);
      }
      complete.set(key,{...value,shape:await cleanSlot(value.shape),mappings:Object.fromEntries(await Promise.all(Object.entries(value.mappings).map(async([key,slot])=>[key,await cleanSlot(slot!)]))),records,displays:Object.fromEntries(Object.entries(value.displays).map(([key,value])=>[key,{...value,hoveredExtremumId:null}]))});
    }
    return complete;
  },saved=>{
    snapshots.current=rebindAnalysisContext(saved,p.context);const value=snapshots.current.get(surfaceContextKey(p.context));if(!value)return;
    currentSnapshot.current=value;setFunction(value.fn);setInputKind(value.inputKind);setIsovalue(value.isovalue);setQuantitativeGrid(value.quantitativeGrid);setAnalysisPreset(value.analysisPreset);setQuality(value.quality);setCubePreset(value.cubePreset);setScope(value.scope);setAtomIds(value.atomIds);setRegionId(value.regionId);setShape(value.shape);setMappings(value.mappings);setCubeUnits(value.cubeUnits);setRecords(value.records);setDisplays(value.displays);setUnits(value.units);setExtremaUnits(value.extremaUnits);setDistributionUnits(value.distributionUnits);setColorbarUnits(value.colorbarUnits);setRangeDraft(value.rangeDraft);setDistributionBounds(value.distributionBounds);setBinCount(value.binCount);setDistributionQuantity(value.distributionQuantity);setDistributionAppearances(value.distributionAppearances);setStateOwnerKey(surfaceContextKey(p.context));setBusy(null);setError('');
  },undefined,()=>{const values=new Map(snapshots.current);values.set(stateOwnerKey,currentSnapshot.current);return values;});
  if (stateOwnerKey === surfaceContextKey(p.context)) currentSnapshot.current = snapshot;
  const restoreAttempts = useRef(new Set<string>());
  const latest = useRef(p); latest.current = p;
  const lifetime = useRef({ alive: true, serial: 0, contextKey: surfaceContextKey(p.context) });
  const running = useRef<{ id: string; controller: AbortController; serial: number; cancel(): void | Promise<void> } | null>(null);
  const [taskProgress,setTaskProgress]=useState<MultiwfnProgressSnapshot|null>(null),progressRun=useRef<ReturnType<typeof createMultiwfnProgressTracker>|null>(null);
  const contextKey = surfaceContextKey(p.context);
  if (lifetime.current.contextKey !== contextKey) { lifetime.current.contextKey = contextKey; lifetime.current.serial++; running.current?.controller.abort(); }
  const stableContext = useMemo(() => p.context, [contextKey, p.context.activationEpoch]);
  const visibleTaskProgress=taskProgress&&taskProgress.identity.sourceId===p.context.sourceId&&taskProgress.identity.sourceRevision===p.context.sourceRevision&&taskProgress.identity.jobIndex===p.context.jobIndex&&taskProgress.identity.sourceFrameIndex===p.context.sourceFrameIndex&&taskProgress.identity.generation===p.context.generation?taskProgress:null;
  useEffect(()=>{progressRun.current=null;setTaskProgress(null);return p.bridge.onProgress?.(snapshot=>{
    const id=snapshot.identity,current=latest.current.context;
    if(!lifetime.current.alive||surfaceContextKey(current)!==contextKey||id.sourceId!==current.sourceId||id.sourceRevision!==current.sourceRevision||id.jobIndex!==current.jobIndex||id.sourceFrameIndex!==current.sourceFrameIndex||id.generation!==current.generation)return;
    if(progressRun.current?.identity.runId!==id.runId){if(running.current?.id!==id.runId)return;progressRun.current=createMultiwfnProgressTracker(id,value=>{if(surfaceContextKey(latest.current.context)===contextKey)setTaskProgress(value);});}
    progressRun.current.receive(snapshot);
  });},[p.bridge,contextKey]);
  const mapping = mappings[fn] ?? emptySlot();
  const storedDisplay = useMemo(() => displays[fn] ?? initialDisplay(), [displays, fn]);
  useEffect(()=>{if(!appearanceDefaults.ready||stateOwnerKey!==contextKey)return;const saved=appearanceDefaults.snapshot?.value[`surface:${fn}`];setDisplays(values=>values[fn]?values:{...values,[fn]:saved&&'colors' in saved?restoreMappedAppearance(initialDisplay(),saved):initialDisplay()});},[appearanceDefaults.ready,appearanceDefaults.snapshot,fn,stateOwnerKey,contextKey]);
  const geometryError = useCallback((field: SurfaceScalarField | null, external: boolean): string | null => {
    if (!field) return null;
    if (!p.cubeGeometryError) return external ? 'Cube 与当前来源结构的几何对应尚未核对。' : null;
    try { return p.cubeGeometryError(field); } catch (reason) { return reasonText(reason); }
  }, [p.cubeGeometryError]);
  const shapeGeometryError = geometryError(shape.field, true), mappingGeometryError = geometryError(mapping.field, true);
  const pair = useMemo(() => shape.field ? { shape: shape.field, mapping: mapping.field, isovalue } : null, [shape.field, mapping.field, isovalue]);
  const invocationGrid = useMemo<SurfaceQuantitativeGrid>(() => inputKind === 'cubes' ? { mode: 'native-default' } : quantitativeGrid, [inputKind, quantitativeGrid]);
  const capabilityRequest=useMemo<SurfaceCapabilityRequest>(()=>({context:stableContext,function:fn,isovalue,quantitativeGrid:invocationGrid,input:{kind:'wavefunction'}}),[stableContext,fn,isovalue,invocationGrid,inputKind,pair]);
  const capabilityKey=surfaceCapabilityKey(capabilityRequest),capabilityPending=p.capabilitiesKey!==undefined&&p.capabilitiesKey!==capabilityKey;
  const capability=capabilityPending||inputKind==='wavefunction'&&p.allowedWavefunctionMethods!==undefined&&!p.allowedWavefunctionMethods.includes(fn)?undefined:p.capabilities.find(item=>item.function===fn);
  const pairValidation = useMemo(() => {
    if (!pair) return null;
    const result = validateSurfaceFieldPair(pair);
    const reasons = [...result.reasons, ...(!sameSurfaceContext(pair.shape.context, stableContext) ? ['Cube 与当前来源或帧身份不同。'] : []), ...[shapeGeometryError, mappingGeometryError].filter((value): value is string => !!value)];
    return { compatible: result.compatible && reasons.length === 0, reasons };
  }, [pair, stableContext, shapeGeometryError, mappingGeometryError]);
  const fieldDefinition = (slot: CubeSlot) => slot.field ? surfaceFieldDefinition(slot.field) : slot.descriptor?.definition ?? null;
  const analysisKey = JSON.stringify([contextKey, fn, inputKind, isovalue, invocationGrid.mode, invocationGrid.spacingBohr, inputKind === 'cubes' ? [fieldDefinition(shape), fieldDefinition(mapping)] : null]);
  const cached = records[fn], record = cached?.key === analysisKey ? cached : undefined, analysis = record?.analysis ?? null;
  const selectedSourceIndices = atomIds.flatMap(id => p.sourceAtomOrder?.find(atom => atom.atomId === id)?.sourceIndex ?? []);
  const selectionIdentity = `${scope}:${[...selectedSourceIndices].sort((a, b) => a - b).join(',')}`;
  const regions = record?.regions.filter(region => scope === 'molecule' ? region.selection.kind === 'molecule' : region.selection.kind === scope && (scope === 'atoms' ? region.selection.atomIndices.length === 1 && selectedSourceIndices.includes(region.selection.atomIndices[0]) : [...region.selection.atomIndices].sort((a, b) => a - b).join(',') === [...selectedSourceIndices].sort((a, b) => a - b).join(','))) ?? [];
  const region = regions.find(item => item.selection.id === regionId) ?? regions[0] ?? null;
  const extremaViewKey = JSON.stringify([analysisKey, analysis?.stamp.analysisId, analysis?.stamp.requestId, region?.selection.id]);
  const display = useMemo(() => ({ ...storedDisplay, ...(storedDisplay.extremaByRegion?.[extremaViewKey] ?? { pinnedExtremumIds: [], hoveredExtremumId: null, hiddenExtremumIds: [] }) }), [storedDisplay, extremaViewKey]);
  const nativeExtrema = useMemo(() => region ? [...new Map([...region.extrema, ...(analysis?.extrema.filter(row => row.regionId === region.selection.id) ?? [])].map(row => [row.id, row])).values()] : [], [region, analysis]);
  const displayUnit = units[fn] ?? capability?.valueUnit ?? SURFACE_FUNCTIONS[fn].atomicUnit;
  const colorbarUnit=colorbarUnits[fn]??capability?.valueUnit??SURFACE_FUNCTIONS[fn].atomicUnit;
  const extremaUnit = extremaUnits[fn] ?? capability?.valueUnit ?? SURFACE_FUNCTIONS[fn].atomicUnit;
  const distributionUnit = distributionUnits[fn] ?? capability?.valueUnit ?? SURFACE_FUNCTIONS[fn].atomicUnit;
  const presentation = useMemo(() => {
    let unitWarning = false;
    const convertedRegion = region ? { ...region, metrics: region.metrics.map(metric => { try { return convertSurfaceMetric(metric, fn, displayUnit); } catch { unitWarning = true; return metric; } }) } : null;
    const extrema = nativeExtrema.map(row => { try { return { ...row, value: convertSurfaceMappingValue(row.value, fn, row.valueUnit, extremaUnit), valueUnit: extremaUnit }; } catch { unitWarning = true; return row; } });
    return { region: convertedRegion, extrema, unitWarning };
  }, [region, nativeExtrema, fn, displayUnit, extremaUnit]);
  const displayedRegion = presentation.region, extrema = presentation.extrema;
  const metricTables = useMemo(() => {
    if (!displayedRegion) return null;
    if (fn === 'esp') return surfaceEspMetricTables(displayedRegion, decimals);
    const complete = surfaceMetricTable(displayedRegion, decimals);
    return { summary: complete, complete };
  }, [displayedRegion, fn, decimals]);
  const rangeInUnit = (unit: string) => { try { return surfaceExtremaRange(nativeExtrema.map(row => ({ ...row, value: convertSurfaceMappingValue(row.value, fn, row.valueUnit, unit), valueUnit: unit }))); } catch { return undefined; } };
  const autoRange = useMemo(() => rangeInUnit(colorbarUnit), [nativeExtrema, fn, colorbarUnit]), colorRange = display.range ?? autoRange;
  const distributionAutoRange = useMemo(() => rangeInUnit(distributionUnit), [nativeExtrema, fn, distributionUnit]);
  const effectiveDistributionBounds: [string, string] = [distributionBounds[0] || (distributionAutoRange ? String(distributionAutoRange.min) : ''), distributionBounds[1] || (distributionAutoRange ? String(distributionAutoRange.max) : '')];
  const generated = record?.generated;
  const generatedValidation = useMemo(() => {
    if (!generated) return null;
    const result = validateSurfaceFieldPair(generated.pair), reasons = [...result.reasons, ...[geometryError(generated.pair.shape, false), geometryError(generated.pair.mapping, false)].filter((value): value is string => !!value)];
    return { compatible: result.compatible && reasons.length === 0, reasons };
  }, [generated, geometryError]);
  const shapeOnlyPair = useMemo(() => pair ? { ...pair, mapping: null } : null, [pair]);
  const shapeOnlyValid = useMemo(() => shapeOnlyPair && !shapeGeometryError && sameSurfaceContext(shapeOnlyPair.shape.context, stableContext) && validateSurfaceFieldPair(shapeOnlyPair).compatible, [shapeOnlyPair, stableContext, shapeGeometryError]);
  const visiblePair = inputKind==='cubes'||stateOwnerKey !== contextKey ? null : generatedValidation?.compatible ? generated!.pair : null;
  const distribution = region?.distribution ?? (region && record?.distributions[region.selection.id]);
  const distributionAppearanceId = `${contextKey}:${fn}:${region?.selection.id ?? ''}`;
  const distributionAppearance = distributionAppearances[distributionAppearanceId] ?? { smooth: false, showBins: true };
  const patchDistributionAppearance = (patch: Partial<typeof distributionAppearance>) => setDistributionAppearances(values => ({ ...values, [distributionAppearanceId]: { ...distributionAppearance, ...patch } }));
  const displayDistribution = useMemo(() => { if (!distribution) return null; try { return { ...distribution, valueUnit: distributionUnit, bins: distribution.bins.map(bin => ({ ...bin, lower: convertSurfaceMappingValue(bin.lower, fn, distribution.valueUnit, distributionUnit), upper: convertSurfaceMappingValue(bin.upper, fn, distribution.valueUnit, distributionUnit) })) }; } catch { return distribution; } }, [distribution, fn, distributionUnit]);
  const patchDisplay = useCallback((update: Partial<SurfaceDisplaySettings> | ((current: SurfaceDisplaySettings) => Partial<SurfaceDisplaySettings>)) => setDisplays(values => {
    const own = values[fn] ?? initialDisplay();
    const local = own.extremaByRegion?.[extremaViewKey] ?? { pinnedExtremumIds: [], hoveredExtremumId: null, hiddenExtremumIds: [] };
    const change = typeof update === 'function' ? update({ ...own, ...local }) : update;
    // Mount/context cleanup is not a user display edit. In particular it must
    // not materialize a factory record before saved defaults finish reading.
    if (Object.keys(change).length === 1 && change.hoveredExtremumId === null && local.hoveredExtremumId === null) return values;
    const { pinnedExtremumIds, hoveredExtremumId, hiddenExtremumIds, currentExtremumId, ...global } = change;
    return { ...values, [fn]: { ...own, ...global, extremaByRegion: { ...own.extremaByRegion, [extremaViewKey]: { ...local,
      ...(pinnedExtremumIds === undefined ? {} : { pinnedExtremumIds }), ...(hoveredExtremumId === undefined ? {} : { hoveredExtremumId }), ...(hiddenExtremumIds === undefined ? {} : { hiddenExtremumIds }), ...(currentExtremumId === undefined ? {} : { currentExtremumId }) } } } };
  }), [fn, extremaViewKey]);
  const cancel = useCallback(() => { const own = running.current; if (!own) return; own.controller.abort(); lifetime.current.serial++; running.current = null; setBusy(null);
    const cancelledSlot = (slot: CubeSlot): CubeSlot => slot.status === 'reading' ? { ...slot, status: 'error', message: `${slot.pendingName ?? '本次文件'}读取已取消。${slot.field ? `保留 ${slot.name}。` : ''}`, pendingName: undefined, failedFile: slot.pendingFile, pendingFile: undefined } : slot;
    setShape(cancelledSlot);
    setMappings(values => Object.fromEntries(Object.entries(values).map(([key, slot]) => [key, slot && cancelledSlot(slot)])));
    const progress=progressRun.current;progress?.stopping();void Promise.resolve(own.cancel()).then(()=>{if(lifetime.current.alive&&progressRun.current===progress)progress?.stopped(progress.getSnapshot().settlement==='cancelled-before-start'?'cancelled-before-start':'native-settled');}).catch(()=>{}); }, []);
  useEffect(() => { lifetime.current.alive = true; return () => { lifetime.current.alive = false; const own = running.current; own?.controller.abort(); if (own) void own.cancel(); running.current = null; }; }, []);
  useEffect(() => {
    if (stateOwnerKey === contextKey) return;
    cancel();
    const previous = currentSnapshot.current;
    snapshots.current.set(stateOwnerKey, { ...previous, shape: releaseSlot(previous.shape), mappings: Object.fromEntries(Object.entries(previous.mappings).map(([key, slot]) => [key, releaseSlot(slot!)])), records: Object.fromEntries(Object.entries(previous.records).map(([key, value]) => [key, { ...value!, generated: undefined, generation: value!.generated ? surfaceGenerationDescriptor(value!.generated, value!.generation?.generationId) : value!.generation }])), displays: Object.fromEntries(Object.entries(previous.displays).map(([key, value]) => [key, { ...value!, hoveredExtremumId: null }])) });
    const saved = snapshots.current.get(contextKey);
    setFunction(saved?.fn ?? 'esp'); setInputKind(saved?.inputKind ?? 'wavefunction');
    setIsovalue(saved?.isovalue ?? DEFAULT_SURFACE_ISOVALUE); setQuantitativeGrid(saved?.quantitativeGrid ?? { mode: 'spacing', spacingBohr: SURFACE_ANALYSIS_DEFAULT_SPACING }); setAnalysisPreset(saved?.analysisPreset ?? 'native-default'); setQuality(saved?.quality ?? { mode: 'medium' });
    setCubePreset(saved?.cubePreset ?? (saved?.quality ? surfaceCubePresetFor(saved.quality) : 'medium'));
    setColorbarUnits(saved?.colorbarUnits ?? {}); setExtremaUnits(saved?.extremaUnits ?? {}); setDistributionUnits(saved?.distributionUnits ?? {}); setDistributionError('');
    setDistributionAppearances(saved?.distributionAppearances ?? {});
    setScope(saved?.scope ?? 'molecule'); setAtomIds(saved?.atomIds ?? []); setRegionId(saved?.regionId ?? ''); setShape(saved?.shape ?? emptySlot()); setMappings(saved?.mappings ?? {}); setCubeUnits(saved?.cubeUnits ?? {});
    setRecords(saved?.records ?? {}); setDisplays(saved?.displays ?? {}); setUnits(saved?.units ?? {}); setRangeDraft(saved?.rangeDraft ?? ['', '']); setDistributionBounds(saved?.distributionBounds ?? ['', '']); setBinCount(saved?.binCount ?? 50); setDistributionQuantity(saved?.distributionQuantity ?? 'area');
    restoreAttempts.current.clear(); setRestoreMessage(''); setError(''); clear(); setStateOwnerKey(contextKey);
  }, [contextKey, stateOwnerKey]);
  useEffect(() => {
    if (stateOwnerKey !== contextKey || p.available === false || running.current) return;
    const generation = record?.generation, restoreGeneration = generation && !record.generated && p.bridge.restoreFields;
    const releasedSlots = [{ role: 'shape' as const, fn: undefined, slot: shape }, ...Object.entries(mappings).map(([key, slot]) => ({ role: 'mapping' as const, fn: key as SurfaceFunction, slot: slot! }))].filter(item => item.slot.descriptor && !item.slot.field);
    const slots:typeof releasedSlots = [];
    if (!restoreGeneration && !slots.length) { if (generation && !record.generated || releasedSlots.length) setRestoreMessage('显示格点已释放，等待只读恢复接口。'); return; }
    const attempt = `${contextKey}:${fn}:${generation?.generationId ?? ''}:${slots.map(item => item.slot.descriptor!.fieldId).join(',')}:${restoreRetry}`;
    if (restoreAttempts.current.has(attempt)) return;
    restoreAttempts.current.add(attempt); setRestoreMessage('显示格点恢复中…');
    void run('显示格点恢复中…', async (signal, requestId, accepts) => {
      try {
        if (restoreGeneration && generation && record) {
          const id = requestId(), result = await p.bridge.restoreFields!({ context: p.context, requestId: id, analysisId: record.analysis.stamp.analysisId, generationId: generation.generationId }, signal);
          if (!accepts()) return;
          const checked = validateSurfaceFieldPair(result.pair);
          if (!sameSurfaceContext(result.stamp, p.context) || !sameSurfaceContext(result.pair.shape.context, p.context) || result.stamp.requestId !== id || result.stamp.analysisId !== record.analysis.stamp.analysisId || result.pair.shape.id !== generation.shapeId || (result.pair.mapping?.id ?? null) !== generation.mappingId || JSON.stringify(result.quality) !== JSON.stringify(generation.quality) || result.pair.isovalue !== record.analysis.isovalue || result.pair.mapping?.function !== fn || !checked.compatible) throw new Error('只读恢复的格点数据身份或精度不匹配。');
          const invalidGeometry = geometryError(result.pair.shape, false) || geometryError(result.pair.mapping, false); if (invalidGeometry) throw new Error(invalidGeometry);
          setRecords(values => ({ ...values, [fn]: { ...values[fn]!, generated: result, generation } }));
        }
        for (const item of slots) {
          const descriptor = item.slot.descriptor!, id = requestId();
          const field = await p.bridge.restoreCube!({ context: p.context, requestId: id, fieldId: descriptor.fieldId, sourceId: descriptor.sourceId, sourceRevision: descriptor.sourceRevision }, signal);
          if (!accepts()) return;
          validateSurfaceScalarField(field);
          if (!sameSurfaceContext(field.context, p.context) || field.id !== descriptor.fieldId || field.source.id !== descriptor.sourceId || field.source.revision !== descriptor.sourceRevision || JSON.stringify(surfaceFieldDefinition(field)) !== JSON.stringify(descriptor.definition)) throw new Error('只读恢复的 Cube 与已导入 snapshot 身份不匹配。');
          const slot: CubeSlot = { ...item.slot, field, status: 'ready', message: undefined };
          if (item.role === 'shape') setShape(slot); else setMappings(values => ({ ...values, [item.fn!]: slot }));
        }
        if (accepts()) setRestoreMessage('');
      } catch (reason) { if (accepts()) setRestoreMessage(`显示格点已释放；恢复失败：${reasonText(reason)}`); throw reason; }
    });
  }, [contextKey, stateOwnerKey, fn, p.available, p.bridge.restoreFields, p.bridge.restoreCube, restoreRetry]);
  useEffect(() => { if (p.available === false) cancel(); }, [p.available, cancel]);
  useEffect(() => { setRangeDraft(['', '']); setDistributionBounds(['', '']); patchDisplay({ hoveredExtremumId: null }); }, [fn]);
  useEffect(() => { patchDisplay({ hoveredExtremumId: null }); }, [extremaViewKey]);
  useEffect(() => { if (!p.active) patchDisplay({ hoveredExtremumId: null }); }, [p.active, patchDisplay]);
  const currentExtrema = useRef(extrema); currentExtrema.current = extrema;
  const toggleExtremum = useCallback((id: string) => { if (currentExtrema.current.some(row => row.id === id)) patchDisplay(current => ({ pinnedExtremumIds: toggleAnalysisRow(current.pinnedExtremumIds, id) })); }, [patchDisplay]);
  const toggleExtremumVisible = (id: string) => { if (currentExtrema.current.some(row => row.id === id)) patchDisplay(current => ({ hiddenExtremumIds: toggleAnalysisRow(current.hiddenExtremumIds ?? [], id), hoveredExtremumId: null })); };
  const hoverExtremum = useCallback((id: string | null) => patchDisplay({ hoveredExtremumId: id && currentExtrema.current.some(row => row.id === id) ? id : null }), [patchDisplay]);
  const setColorbarLayout = useCallback((layout: AnalysisColorbarLayout) => {
    if (!lifetime.current.alive || lifetime.current.contextKey !== contextKey || latest.current.available === false) return;
    patchDisplay({ colorbarLayout: normalizeAnalysisColorbarLayout(layout) });
  }, [patchDisplay, contextKey]);
  useEffect(() => { latest.current.onInteractionReady?.({ hover: hoverExtremum, toggle: toggleExtremum, setColorbarLayout }); return () => latest.current.onInteractionReady?.(null); }, [hoverExtremum, toggleExtremum, setColorbarLayout]);
  const projection = useMemo<SurfaceProjection | null>(() => {
    if (p.available === false || stateOwnerKey !== contextKey) return null;
    const documentId = p.context.documentId, geometryRevision = p.context.documentRevision;
    const renderable = documentId != null && geometryRevision != null;
    let color;
    try { color = display.coloring!=='solid' && colorRange && visiblePair?.mapping?.valueUnit ? { min: convertSurfaceMappingValue(colorRange.min, fn, colorbarUnit, visiblePair.mapping.valueUnit), max: convertSurfaceMappingValue(colorRange.max, fn, colorbarUnit, visiblePair.mapping.valueUnit), colors: display.colors ?? ANALYSIS_PALETTES[display.palette], reverse: display.reverse } : undefined; } catch { color = undefined; }
    return { context: stableContext, function: fn, regionId: region?.selection.id ?? '', region, analysis, fields: visiblePair, display,capabilityRequest,
      surfaceLayer: visiblePair && renderable ? { pair: visiblePair, documentId, geometryRevision, visible: p.active && display.visible, opacity: display.opacity, finish: display.finish, sourceToDocument: p.sourceToDocument, color, ...(display.coloring==='solid'?{solidColor:display.solidColor??'#66cc4d'}:{}) } : null,
      surfaceExtrema: analysis && renderable ? { documentId, geometryRevision, visible: p.active, markersVisible: display.markersVisible, valuesVisible: display.valuesVisible, coordinatesVisible: display.coordinatesVisible, hiddenIds: display.hiddenExtremumIds, points: extrema.map(row => ({ id: row.id, position: surfaceExtremumPosition(row), identityLabel: surfaceExtremumIdentity(row), label: surfaceExtremumLabel(row, extremaDecimals), coordinateLabel: surfaceExtremumCoordinates(row, extremaDecimals), kind: row.type, global: row.scope === 'global' })), pinnedIds: [...new Set([...display.pinnedExtremumIds, ...(display.currentExtremumId ? [display.currentExtremumId] : [])])], hoveredId: display.hoveredExtremumId, showAllValues: false, sourceToDocument: p.sourceToDocument } : null,
      colorbar: colorRange && color ? { ...colorRange, palette: display.palette, colors: display.colors, label: `${SURFACE_FUNCTIONS[fn].label} / ${colorbarUnit}`, decimals, reverse: display.reverse, layout: display.colorbarLayout } : null };
  }, [stableContext, stateOwnerKey, contextKey, p.available, p.active, p.sourceToDocument, fn, region, analysis, visiblePair, display, extrema, colorRange, colorbarUnit,capabilityRequest,decimals,extremaDecimals]);
  const projectionCallback = useRef(p.onProjection); projectionCallback.current = p.onProjection;
  useEffect(() => { projectionCallback.current(projection); }, [projection]);
  useEffect(() => () => projectionCallback.current(null), []);

  async function run(label: string, action: (signal: AbortSignal, requestId: () => string, accepts: () => boolean) => Promise<void>) {
    if (running.current) { notify('已有表面任务正在运行。'); return; }
    if (p.available === false) { notify('当前结构已修改，撤销后可恢复此分析。'); return; }
    const bridge = p.bridge;
    const own = { id: crypto.randomUUID(), controller: new AbortController(), serial: ++lifetime.current.serial, cancel: () => bridge.cancel?.(own.id) }, capturedKey = contextKey;
    running.current = own;progressRun.current=null;setTaskProgress(null); setBusy(label); setError('');
    const accepts = () => lifetime.current.alive && lifetime.current.serial === own.serial && lifetime.current.contextKey === capturedKey && !own.controller.signal.aborted;
    const requestId = () => { own.id = crypto.randomUUID(); return own.id; };
    // An asynchronous progress subscription, not this call stack, installs the tracker.
    const currentProgress=():ReturnType<typeof createMultiwfnProgressTracker>|null=>progressRun.current;
    try { await action(own.controller.signal, requestId, accepts);const progress=currentProgress();if(accepts()&&progress?.identity.runId===own.id)progress.committed(); }
    catch (reason) { if (accepts()) { const message = reasonText(reason),progress=currentProgress();if(progress?.identity.runId===own.id)progress.failed(progress.getSnapshot().settlement??'native-settled',message); setError(message); latest.current.onError?.(message); } }
    finally { if (running.current === own) { running.current = null; if (lifetime.current.alive) setBusy(null); } }
  }
  const disabled = !!busy ||visibleTaskProgress?.phase==='stopping'|| p.available === false;
  const analysisUnavailable = !p.bridge.analyze ? '当前环境缺少分子表面分析接口。' : inputKind === 'wavefunction' ? !p.wavefunctionAvailable ? '当前帧缺少匹配波函数。' : capabilityPending?'正在核对当前来源能力。':!capability?.wavefunctionDirect ? capability?.reason ?? '当前函数不具备波函数直接分析能力。' : quantitativeGrid.mode === 'spacing' && (!Number.isFinite(quantitativeGrid.spacingBohr) || quantitativeGrid.spacingBohr! <= 0) ? '请输入正的自定义定量格距。' : ''
    : !pair ? '请载入电子密度 Cube。' : !mapping.field ? '请载入当前函数的映射 Cube。' : !pairValidation?.compatible ? pairValidation?.reasons.join('；') ?? 'Cube 尚未核对。' : capabilityPending?'正在核对当前来源能力。':!capability?.cubeInterpolation ? capability?.reason ?? '当前函数尚无 Cube 插值分析能力。' : '';
  function analyze() {
    if(inputKind==='cubes'){notify('当前不再支持外部 Cube 输入，原文件保留。');return;}
    if (analysisUnavailable) { notify(analysisUnavailable); return; }
    const context = p.context, selectedFunction = fn, key = analysisKey;
    void run('分析中…', async (signal, requestId, accepts) => {
      const id = requestId(), result = await p.bridge.analyze!({ context, requestId: id, function: selectedFunction, isovalue, quantitativeGrid: invocationGrid, input: { kind: 'wavefunction' } }, signal);
      if (!accepts()) return;
      validateSurfaceAnalysisResult(result);
      if (!sameSurfaceContext(result.stamp, context) || result.stamp.requestId !== id || !result.stamp.analysisId || result.function !== selectedFunction || result.isovalue !== isovalue || result.quantitativeGrid.mode !== invocationGrid.mode || invocationGrid.mode === 'spacing' && result.quantitativeGrid.spacingBohr !== invocationGrid.spacingBohr) throw new Error('表面分析返回的来源、请求、函数、等值或定量精度身份不匹配。');
      if (!result.regions.some(region => region.selection.kind === 'molecule')) throw new Error('原生分析未返回全分子表面结果。');
      setRecords(values => ({ ...values, [selectedFunction]: { key, analysis: result, regions: result.regions, distributions: {} } }));
      setDisplays(values => { const own = values[selectedFunction] ?? initialDisplay(); return { ...values, [selectedFunction]: { ...own, range: own.rangeLocked ? own.range : undefined, pinnedExtremumIds: [], hoveredExtremumId: null } }; });
    });
  }
  function analyzeRegion() {
    if (!analysis || !record) { notify('请先分析全分子表面。'); return; }
    if (!p.bridge.analyzeRegion || scope === 'atoms' && !capability?.atomRegions || scope === 'fragment' && !capability?.fragmentRegions) { notify(capability?.reason ?? '当前来源未开放所选区域分析。'); return; }
    if (!selectedSourceIndices.length || selectedSourceIndices.length !== atomIds.length || selectedSourceIndices.some(index => !Number.isSafeInteger(index) || index < 1) || new Set(selectedSourceIndices).size !== selectedSourceIndices.length) { notify('请确认与来源对应的原子集合。'); return; }
    const selections: SurfaceRegionSelection[] = scope === 'atoms' ? selectedSourceIndices.map(index => ({ id: `atom:${index}`, kind: 'atoms', atomIndices: [index], label: `原子 ${index}` })) : [{ id: selectionIdentity, kind: 'fragment', atomIndices: [...selectedSourceIndices], label: `片段 ${selectedSourceIndices.join(', ')}` }];
    const selectedFunction = fn;
    void run('区域分析中…', async (signal, requestId, accepts) => {
      for (const selection of selections) {
        if (!accepts()) return;
        const id = requestId(), reply = await p.bridge.analyzeRegion!({ analysis, selection, requestId: id }, signal), result = reply.region;
        if (!accepts()) return;
        if (!sameSurfaceContext(reply.stamp, analysis.stamp) || reply.stamp.analysisId !== analysis.stamp.analysisId || reply.stamp.requestId !== id || result.selection.id !== selection.id || result.selection.kind !== selection.kind || [...result.selection.atomIndices].sort().join(',') !== [...selection.atomIndices].sort().join(',')) throw new Error('返回的表面区域与所选原子集合或分析身份不一致。');
        validateSurfaceAnalysisResult({ ...analysis, regions: [...record.regions.filter(row => row.selection.id !== result.selection.id), result] });
        setRecords(values => { const current = values[selectedFunction]; return current?.key === analysisKey ? { ...values, [selectedFunction]: { ...current, regions: [...current.regions.filter(row => row.selection.id !== result.selection.id), result] } } : values; });
      }
    });
  }
  function generate() {
    if (inputKind === 'cubes') { notify('当前不再支持外部 Cube 输入，原文件保留。'); return; }
    if (!analysis || !record) { notify('请先完成当前表面分析。'); return; }
    if (!p.bridge.generate || !capability?.generation) { notify(capability?.reason ?? '当前来源未开放表面格点生成。'); return; }
    try { validateSurfaceCubeQuality(quality); } catch { notify('请填写有效的 Cube 自定义格距或三方向点数。'); return; }
    const budgetIssue = surfaceCubeBudgetIssue(quality, p.resourceBudgetBytes);
    if (budgetIssue) { notify(budgetIssue); return; }
    const selectedFunction = fn;
    void run('生成表面中…', async (signal, requestId, accepts) => {
      const id = requestId(), result = await p.bridge.generate!({ analysis, quality, requestId: id }, signal);
      if (!accepts()) return;
      const checked = validateSurfaceFieldPair(result.pair);
      const badGeometry = geometryError(result.pair.shape, false) || geometryError(result.pair.mapping, false);
      if (badGeometry) throw new Error(badGeometry);
      if (!sameSurfaceContext(result.stamp, p.context) || result.stamp.analysisId !== analysis.stamp.analysisId || result.stamp.requestId !== id || result.pair.isovalue !== isovalue || result.pair.mapping?.function !== selectedFunction || !checked.compatible || JSON.stringify(result.quality) !== JSON.stringify(quality)) throw new Error(checked.reasons.join('；') || '返回的表面网格身份、等值、函数或精度不匹配。');
      setRecords(values => { const current = values[selectedFunction]; return current?.key === analysisKey ? { ...values, [selectedFunction]: { ...current, generated: result, generation: surfaceGenerationDescriptor(result) } } : values; });
    });
  }
  function exportCube(field: SurfaceScalarField | null) {
    if(field&&isRestoredAnalysisData(field)){try{const files=analysisProjectCubeArtifacts(field);exportBlob(new Blob([files.cube],{type:'text/plain'}),'Ester-Studio-surface.cube');exportBlob(new Blob([files.metadata],{type:'application/json'}),'Ester-Studio-surface.sciyue-domain.json');}catch(error){notify(reasonText(error));}return;}
    if (!field || !p.bridge.exportCube) { notify('请先载入或生成可导出的 Cube。'); return; }
    void run('导出 Cube…', async (signal, _requestId, accepts) => { await p.bridge.exportCube!(field, signal); if (accepts()) notify('已发起 Cube 及有效域说明导出。'); });
  }
  const selectAtoms = (ids: string[], assertCurrent: () => void) => { assertCurrent(); const known = new Set(p.sourceAtomOrder?.map(row => row.atomId)); if (ids.some(id => !known.has(id)) || new Set(ids).size !== ids.length) throw new Error('原子集合与当前来源对应不明确。'); setAtomIds([...ids]); setRegionId(''); };
  function changeColorbarUnit(nextUnit: string) {
    try {
      const convertRange = (values: [string, string]): [string, string] => values.every(value => value.trim() && Number.isFinite(Number(value))) ? values.map(value => String(convertSurfaceMappingValue(Number(value), fn, colorbarUnit, nextUnit))) as [string, string] : ['', ''];
      const nextRange = display.range ? { min: convertSurfaceMappingValue(display.range.min, fn, colorbarUnit, nextUnit), max: convertSurfaceMappingValue(display.range.max, fn, colorbarUnit, nextUnit) } : undefined;
      const nextDraft = convertRange(rangeDraft);
      setColorbarUnits(values => ({ ...values, [fn]: nextUnit })); patchDisplay({ range: nextRange }); setRangeDraft(nextDraft);
    } catch (reason) { notify(reasonText(reason)); }
  }
  function restorePlotting() {
    const saved=appearanceDefaults.snapshot?.value[`surface:${fn}`];
    const defaults=saved&&'colors' in saved?restoreMappedAppearance(initialDisplay(),saved):initialDisplay();
    patchDisplay({visible:defaults.visible,opacity:defaults.opacity,palette:defaults.palette,colors:defaults.colors,finish:defaults.finish,appearancePreset:defaults.appearancePreset,coloring:defaults.coloring,solidColor:defaults.solidColor,reverse:defaults.reverse,range:undefined,rangeLocked:false,colorbarLayout:undefined});
    setColorbarUnits(values=>({...values,[fn]:SURFACE_FUNCTIONS[fn].atomicUnit}));setRangeDraft(['','']);
  }
  const changeTableUnit = (kind: 'metrics' | 'extrema' | 'distribution', next: string) => {
    if (kind === 'metrics') setUnits(values=>({...values,[fn]:next}));
    else if (kind === 'extrema') setExtremaUnits(values => ({ ...values, [fn]: next }));
    else { try { const converted = effectiveDistributionBounds.map(bound => bound.trim() ? String(convertSurfaceMappingValue(Number(bound), fn, distributionUnit, next)) : '') as [string, string]; setDistributionBounds(converted); setDistributionUnits(values => ({ ...values, [fn]: next })); } catch (reason) { setDistributionError(reasonText(reason)); } }
  };
  const tableFormat = (kind: 'metrics' | 'extrema' | 'distribution'): ScientificTableFormat => ({
    decimals: kind === 'metrics' ? decimals : kind === 'extrema' ? extremaDecimals : distributionDecimals,
    onDecimalsChange: kind === 'metrics' ? setDecimals : kind === 'extrema' ? setExtremaDecimals : setDistributionDecimals,
    unit: kind === 'metrics' ? displayUnit : kind === 'extrema' ? extremaUnit : distributionUnit,
    units: [...new Set([capability?.valueUnit ?? SURFACE_FUNCTIONS[fn].atomicUnit, ...SURFACE_FUNCTIONS[fn].units])].map(value => ({ value, label: value })),
    onUnitChange: value => changeTableUnit(kind, value),
    ariaLabel: kind === 'metrics' ? '表面指标' : kind === 'extrema' ? '表面极值' : '表面分布',
  });
  const qualityChanged = generated && JSON.stringify(generated.quality) !== JSON.stringify(quality);
  const cubeBudgetIssue = inputKind === 'wavefunction' ? surfaceCubeBudgetIssue(quality, p.resourceBudgetBytes) : undefined;
  const quantitativeSpacing = quantitativeGrid.mode === 'native-default' ? analysis?.quantitativeGrid.actualSpacingBohr ?? SURFACE_ANALYSIS_DEFAULT_SPACING : quantitativeGrid.spacingBohr;
  const cubePreview=surfaceGridPreview(quality,p.structure,6,generated?.pair.shape.grid);
  const mappingProgress = busy === '生成表面中…' || !busy && ['generate', 'generate-fields'].includes(visibleTaskProgress?.identity.operation ?? '');
  const progress = <>{busy && !visibleTaskProgress && <InputSettingsRow><output role="status">{busy}</output><InputSettingsAction onClick={cancel}>停止</InputSettingsAction></InputSettingsRow>}<MultiwfnProgress progress={visibleTaskProgress} operationLabel={mappingProgress ? '映射格点' : '分子表面'} onStop={cancel}/></>;
  const quantitativeQuality = inputKind === 'wavefunction' ? <CalculationQualityControl ariaLabel="表面定量精度" value={analysisPreset} options={SURFACE_ANALYSIS_QUALITY_OPTIONS} disabled={disabled}
    onChange={preset => { setAnalysisPreset(preset); setQuantitativeGrid(surfaceQuantitativePreset(preset, quantitativeGrid)); }}>
    <InputSettingsField label="格点间距 / Bohr"><NumericInput aria-label="表面定量格距"  min={0} step="any" value={Number.isFinite(quantitativeSpacing) ? quantitativeSpacing : ''} disabled={disabled} onChange={event => { const spacingBohr = event.currentTarget.valueAsNumber; setAnalysisPreset(surfaceQuantitativePresetFor(spacingBohr)); setQuantitativeGrid({ mode: 'spacing', spacingBohr }); }}/></InputSettingsField>
  </CalculationQualityControl> : <output>使用外部 Cube 原有网格，不重采样。</output>;
  const extremaPlotting = analysis && <><InputSettingsRow><InputSettingsCheckbox label="显示极值标记" checked={display.markersVisible} onChange={markersVisible => patchDisplay({ markersVisible })}/><InputSettingsCheckbox label="显示极值数值" checked={display.valuesVisible !== false} onChange={valuesVisible => patchDisplay({ valuesVisible })}/><InputSettingsCheckbox label="显示极值 XYZ 坐标" checked={display.coordinatesVisible === true} onChange={coordinatesVisible => patchDisplay({ coordinatesVisible })}/><InputSettingsAction disabled={!display.pinnedExtremumIds.length} onClick={() => patchDisplay({ pinnedExtremumIds: [] })}>清除固定</InputSettingsAction></InputSettingsRow>
    <InputSettingsRow><InputSettingsAction onClick={() => patchDisplay({ hiddenExtremumIds: extrema.map(row => row.id) })}>隐藏全部</InputSettingsAction><InputSettingsAction onClick={() => patchDisplay({ hiddenExtremumIds: [] })}>显示全部</InputSettingsAction><InputSettingsAction onClick={() => patchDisplay({ hiddenExtremumIds: extrema.filter(row => row.scope !== 'global').map(row => row.id) })}>仅显示全局最大／最小</InputSettingsAction></InputSettingsRow></>;
  return <section className="analysis-controls" aria-label="分子表面分析" data-testid="surface-analysis-controls" data-surface-function={fn} data-surface-state={busy ? 'running' : visiblePair?.mapping ? 'fields-ready' : analysis ? 'analysis-ready' : 'idle'} data-analysis-id={analysis?.stamp.analysisId ?? ''} data-request-id={running.current?.id ?? ''} data-source-id={p.context.sourceId} data-source-revision={p.context.sourceRevision} data-source-frame={p.context.sourceFrameIndex ?? ''} data-surface-colored={!!projection?.surfaceLayer?.color}><InputSettingsLayout>{feedback}{error && <DismissibleNotice role="alert">{error}</DismissibleNotice>}{restoreMessage && <div className="postprocess-actions"><output role="status">{restoreMessage}</output><InputSettingsAction disabled={!!busy} onClick={() => setRestoreRetry(value => value + 1)}>恢复已有显示格点</InputSettingsAction></div>}{presentation.unitWarning && <p className="postprocess-warning">部分来源单位不能换算，相关数值保留来源单位。</p>}
    <AnalysisTaskLayout variant="card" methodDetails title="分子表面定量分析" className="surface-preparation" testId="surface-quantitative-task" onRestoreQuality={inputKind === 'wavefunction' ? ()=>{setAnalysisPreset('native-default');setQuantitativeGrid({mode:'spacing',spacingBohr:SURFACE_ANALYSIS_DEFAULT_SPACING});}:undefined} qualityDisabled={disabled} setup={<><InputSettingsRow className="surface-preparation-row surface-identity-row"><InputSettingsField label="映射函数"><select aria-label="表面映射函数" value={fn} disabled={disabled} onChange={event => { setFunction(event.target.value as SurfaceFunction); setRegionId(''); setError(''); }}>{(['esp','alie'] as const).map(method=><option key={method} value={method} disabled={inputKind==='wavefunction'&&p.allowedWavefunctionMethods!==undefined&&!p.allowedWavefunctionMethods.includes(method)}>{method.toUpperCase()}</option>)}</select></InputSettingsField>
      <InputSettingsField label="ρ 等值 / a.u."><NumericInput stepper adaptiveStep={0.01} aria-label="密度表面等值"  min={0} step={.0001} value={isovalue} disabled={disabled} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) setIsovalue(value); }}/></InputSettingsField></InputSettingsRow>
      {inputKind === 'cubes' && <DismissibleNotice role="alert">旧记录引用了外部 Cube；当前不再支持此输入。请重新选择支持的波函数来源，原文件保留。</DismissibleNotice>}
      {inputKind === 'cubes' && pairValidation && !pairValidation.compatible && <p role="status" className="postprocess-warning">{pairValidation.reasons.join('；')}</p>}
    </>} quality={quantitativeQuality} actions={<InputSettingsAction variant="primary" disabled={disabled} onClick={analyze}>开始分析</InputSettingsAction>} progress={mappingProgress ? null : progress}>
      {!analysis && cached && <p className="postprocess-note">参数已变化，请显式分析当前定义。</p>}
    <AnalysisTaskSection title="分子表面定量性质">{metricTables ? <SurfaceTable projection={fn === 'esp' && !showAllMetrics ? metricTables.summary : metricTables.complete} exportProjection={metricTables.complete} fileName={`Ester-Studio-surface-${fn}-metrics.txt`} selectionScope={`metrics:${extremaViewKey}`} format={tableFormat('metrics')} expansion={fn === 'esp' ? { expanded: showAllMetrics, onToggle: () => setShowAllMetrics(value => !value) } : undefined}/> : <p className="postprocess-note">{analysis ? '当前区域尚未分析。' : '尚未分析。'}</p>}</AnalysisTaskSection>
    <AnalysisTaskSection title="分子表面性质极值点">
      {extrema.length ? <SurfaceTable projection={surfaceExtremaTable([...extrema].sort((a,b)=>(extremaSort.column==='value'?a.value-b.value:a.sourceIndex-b.sourceIndex)*(extremaSort.direction==='asc'?1:-1)), extremaDecimals)} fileName={`Ester-Studio-surface-${fn}-extrema.txt`} selectionScope={`extrema:${extremaViewKey}`} format={tableFormat('extrema')} sorting={{value:extremaSort.column,direction:extremaSort.direction,options:[{value:'identity',label:'极值编号'},{value:'value',label:'数值'}],onChange:(column,direction)=>setExtremaSort({column,direction})}} activeRowKey={display.currentExtremumId ?? undefined} onRowActivate={row => patchDisplay({ currentExtremumId: row.key })} onRowPreview={row => hoverExtremum(row?.key ?? null)} onClearActive={() => patchDisplay({ currentExtremumId: null, hoveredExtremumId: null })} rowBindings={row => ({ 'aria-selected': display.currentExtremumId === row.key })} rowActions={[
        { kind: 'visibility', text: row => (display.hiddenExtremumIds ?? []).includes(row.key) ? '显示' : '隐藏', label: row => `${(display.hiddenExtremumIds ?? []).includes(row.key) ? '显示' : '隐藏'} ${row.cells[0]}`, active: row => !(display.hiddenExtremumIds ?? []).includes(row.key), onActivate: row => toggleExtremumVisible(row.key) },
        { kind: 'pin', label: row => `${display.pinnedExtremumIds.includes(row.key) ? '取消固定' : '固定'} ${row.cells[0]}`, active: row => display.pinnedExtremumIds.includes(row.key), onActivate: row => toggleExtremum(row.key) },
      ]}/> : <p className="postprocess-note">{analysis ? '当前区域未输出极值。' : '尚未分析。'}</p>}{extremaPlotting}
    </AnalysisTaskSection>
    <AnalysisTaskSection title="面积分布">
      {distributionError && <DismissibleNotice role="alert">{distributionError}</DismissibleNotice>}
      {displayDistribution && analysis ? <><p className="postprocess-note">{surfaceDistributionSummary(displayDistribution, distributionDecimals)}</p><SurfaceTable projection={surfaceDistributionTable(displayDistribution, distributionDecimals)} fileName={`Ester-Studio-surface-${fn}-distribution.txt`} selectionScope={`distribution:${extremaViewKey}:${distribution?.stamp.requestId}`} format={tableFormat('distribution')}/><InputSettingsField label="纵轴"><select aria-label="表面分布纵轴" value={distributionQuantity} onChange={event => setDistributionQuantity(event.target.value as typeof distributionQuantity)}><option value="area">面积</option><option value="fraction">原生占比</option></select></InputSettingsField><InputSettingsRow><InputSettingsCheckbox label="平滑曲线" checked={distributionAppearance.smooth} onChange={smooth => patchDistributionAppearance({ smooth })}/><InputSettingsCheckbox label="显示原始分箱" checked={distributionAppearance.showBins} onChange={showBins => patchDistributionAppearance({ showBins })}/></InputSettingsRow><ScientificPlot plotStyle="plain" appearanceKey={`surface-distribution:${contextKey}:${distributionAppearanceId}`} onResetDefaults={() => patchDistributionAppearance({ smooth: false, showBins: true })} title={`${SURFACE_FUNCTIONS[fn].label} 面积分布`} xLabel={distributionUnit} yLabel={distributionQuantity === 'area' ? `面积 / ${surfaceDisplayUnit(displayDistribution.areaUnit)}` : '原生占比 / %'} decimals={distributionDecimals} series={surfaceDistributionSeries(displayDistribution, distributionQuantity, distributionDecimals, distributionAppearance)} resetKey={`${analysis.stamp.analysisId}:${region?.selection.id}:${distributionUnit}:${distributionQuantity}`} exportFileName={`Ester-Studio-surface-${fn}-distribution`} exportText={{ fileName: `Ester-Studio-surface-${fn}-distribution.txt`, text: scientificTableText(surfaceDistributionTable(displayDistribution, distributionDecimals)) }}/></> : <p className="postprocess-note">{analysis ? '本次定量分析未返回面积分布数据。' : '尚未分析。'}</p>}
    </AnalysisTaskSection>
    </AnalysisTaskLayout>
    <AnalysisTaskLayout variant="card" methodDetails title="分子表面着色图" testId="surface-mapping-task" onRestorePlotting={restorePlotting} onRestoreQuality={inputKind === 'wavefunction' ? ()=>{setCubePreset('medium');setQuality({mode:'medium'});}:undefined} qualityDisabled={disabled} quality={<CalculationQualityControl label="Cube 绘图质量" ariaLabel="表面Cube绘图精度" value={cubePreset} options={SURFACE_CUBE_QUALITY_OPTIONS} disabled={disabled || inputKind === 'cubes'} onChange={preset => { setCubePreset(preset); setQuality(surfaceCubePreset(preset, quality, generated&&JSON.stringify(generated.quality)===JSON.stringify(quality)?generated.pair.shape.grid:undefined)); }}>
      {cubePreset === 'custom' && <InputSettingsField label="网格定义"><select aria-label="表面Cube自定义方式" disabled={disabled || inputKind === 'cubes'} value={quality.mode === 'dimensions' ? 'dimensions' : 'spacing'} onChange={event => setQuality(event.target.value === 'dimensions' ? { mode: 'dimensions', dimensions: generated&&JSON.stringify(generated.quality)===JSON.stringify(quality)?generated.pair.shape.grid.dimensions:[NaN,NaN,NaN] } : { mode: 'spacing', spacingBohr: NaN })}><option value="spacing">格距</option><option value="dimensions">点数</option></select></InputSettingsField>}
      {cubePreset==='custom' && quality.mode !== 'dimensions' && <InputSettingsField label={`${quality.mode==='spacing'?'格距':'预计格距'} / Bohr`}><NumericInput aria-label="表面Cube格距"  min={0} step={.01} value={quality.mode==='spacing'?quality.spacingBohr||'':cubePreview?.spacingBohr?Number(cubePreview.spacingBohr.toPrecision(6)):''} disabled={disabled || inputKind === 'cubes'} onChange={event => { setCubePreset('custom'); setQuality({ mode: 'spacing', spacingBohr: event.currentTarget.valueAsNumber }); }}/></InputSettingsField>}
      {cubePreset==='custom' && quality.mode === 'dimensions' && quality.dimensions.map((value, index) => <InputSettingsField key={index} label={`${['X', 'Y', 'Z'][index]} 点数`}><NumericInput aria-label={`表面Cube${['X', 'Y', 'Z'][index]}点数`}  min={2} step={1} value={value || ''} disabled={disabled || inputKind === 'cubes'} onChange={event => { const next = Number(event.target.value); if (Number.isSafeInteger(next) && next >= 2) { setCubePreset('custom'); setQuality({ mode: 'dimensions', dimensions: quality.dimensions.map((old, axis) => axis === index ? next : old) as [number, number, number] }); } }}/></InputSettingsField>)}
      <SpatialGridSummary preview={cubePreview}/>
      {cubeBudgetIssue && <p role="status" className="postprocess-warning">{cubeBudgetIssue}</p>}
    </CalculationQualityControl>} actions={<InputSettingsAction variant="primary" disabled={disabled} onClick={generate}>{inputKind === 'cubes' ? '显示已有表面' : '生成着色表面'}</InputSettingsAction>} progress={mappingProgress ? progress : null} plotting={visiblePair ? <>
      <div className="surface-draw-flow">
      <InputSettingsRow><InputSettingsCheckbox label="显示表面" checked={display.visible} onChange={visible => patchDisplay({ visible })}/><InputSettingsField label="透明度"><input aria-label="表面透明度" type="range" {...matchingSliderRange(display.opacity,.05,1,.05)} value={display.opacity} onChange={event => patchDisplay({ opacity: Number(event.target.value) })}/><NumericInput stepper adaptiveStep={0.1} aria-label="表面透明度数值"  min={.05} max={1} step={.05} value={display.opacity} onChange={event => { const opacity = event.currentTarget.valueAsNumber; if (Number.isFinite(opacity) && opacity >= .05 && opacity <= 1) patchDisplay({ opacity }); }}/></InputSettingsField><InputSettingsAction disabled={!generated?.pair.shape || !p.bridge.exportCube} onClick={() => exportCube(generated?.pair.shape ?? null)}>导出生成密度 Cube</InputSettingsAction><InputSettingsAction disabled={!generated?.pair.mapping || !p.bridge.exportCube} onClick={() => exportCube(generated?.pair.mapping ?? null)}>导出生成映射 Cube</InputSettingsAction></InputSettingsRow>
      <SurfaceAppearanceControls label="表面" presets={['esp','density']} value={display.appearancePreset} onChange={id=>patchDisplay(mappedSurfaceAppearance(display,id))} actions={<SaveSurfaceAppearanceDefault family={`surface:${fn}`} appearance={captureMappedAppearance(display)}/>}><MeshFinishControls labelPrefix="表面" value={display.finish} onChange={finish => patchDisplay({ finish })}/>{display.coloring==='solid'&&<InputSettingsRow><InputSettingsField label="表面颜色"><input type="color" aria-label="表面单色颜色" value={display.solidColor??'#66cc4d'} onChange={event=>patchDisplay({solidColor:event.currentTarget.value})}/></InputSettingsField></InputSettingsRow>}</SurfaceAppearanceControls>
      </div>
    {display.coloring!=='solid'&&<div className="field-colorbar-settings" aria-label="色标"><InputSettingsRow><InputSettingsField label="色尺单位"><select aria-label="表面色尺单位" value={colorbarUnit} onChange={event=>changeColorbarUnit(event.target.value)}>{[...new Set([capability?.valueUnit??SURFACE_FUNCTIONS[fn].atomicUnit,...SURFACE_FUNCTIONS[fn].units])].map(unit=><option key={unit} value={unit}>{fn==='esp'&&['eV','kcal/mol','kJ/mol'].includes(unit)?`${unit}/e`:unit}</option>)}</select></InputSettingsField>{(!display.appearancePreset?.startsWith('gallery-'))&&<><InputSettingsField label="色板"><select aria-label="表面色板" value={display.colors?'custom':display.palette} onChange={event => patchDisplay({ palette: event.target.value as SurfaceDisplaySettings['palette'], colors: undefined })}><option value="blue-red">蓝–白–红</option><option value="purple-green">紫–白–绿</option><option value="viridis">Viridis</option>{display.colors&&<option value="custom" disabled>自定义色带</option>}</select></InputSettingsField><InputSettingsCheckbox label="反转色标" checked={display.reverse} onChange={reverse => patchDisplay({ reverse })}/></>}<InputSettingsCheckbox label="锁定范围" checked={display.rangeLocked} onChange={locked => patchDisplay({ rangeLocked: locked, range: locked ? colorRange : undefined })}/><InputSettingsAction onClick={() => { patchDisplay({ range: undefined, rangeLocked: false }); setRangeDraft(['', '']); }}>自适应范围</InputSettingsAction></InputSettingsRow>
      <AnalysisColorbarLayoutControls layout={display.colorbarLayout} onChange={setColorbarLayout} colorbar={projection?.colorbar}/>
      {(!display.appearancePreset?.startsWith('gallery-'))&&display.colors&&<InputSettingsRow>{display.colors.map((color,index)=><InputSettingsField key={index} label={['低值','中值','高值'][index]??String(index+1)}><input type="color" aria-label={`表面色带${index+1}颜色`} value={color} onChange={event=>patchDisplay({colors:display.colors!.map((old,position)=>position===index?event.target.value:old)})}/></InputSettingsField>)}</InputSettingsRow>}
      <InputSettingsRow><div className="analysis-control-group"><InputSettingsField label={`下限 / ${colorbarUnit}`}><NumericInput aria-label="表面色标下限"  value={rangeDraft[0]} placeholder={colorRange ? number(colorRange.min) : ''} onChange={event => setRangeDraft(values => [event.target.value, values[1]])}/></InputSettingsField><InputSettingsField label={`上限 / ${colorbarUnit}`}><NumericInput aria-label="表面色标上限"  value={rangeDraft[1]} placeholder={colorRange ? number(colorRange.max) : ''} onChange={event => setRangeDraft(values => [values[0], event.target.value])}/></InputSettingsField></div><InputSettingsAction onClick={() => { const min = Number(rangeDraft[0]), max = Number(rangeDraft[1]); if (rangeDraft.every(value => value.trim()) && [min, max].every(Number.isFinite) && min < max) patchDisplay({ range: { min, max } }); else notify('请输入递增的有限色标范围。'); }}>应用范围</InputSettingsAction></InputSettingsRow>
      {!colorRange && visiblePair?.mapping && <p className="postprocess-note">当前区域尚无可靠表面范围；仅显示形状，可分析后使用自适应色标或明确手动范围。</p>}
    </div>}
    </> : <p className="postprocess-note">尚未生成着色表面。</p>}>
      {(generated || record?.generation) && <output>已生成：{surfaceQualityLabel(generated?.quality ?? record!.generation!.quality)} · {(generated?.pair.shape.grid.dimensions ?? record!.generation!.dimensions).join(' × ')} 点{qualityChanged ? '；当前设置尚未生成。' : ''}</output>}
    </AnalysisTaskLayout>
  </InputSettingsLayout></section>;
}

export default function SurfaceAnalysisControls(p: Parameters<typeof SurfaceAnalysisControlsInner>[0]) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['SurfaceAnalysisControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><SurfaceAnalysisControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:SurfaceAnalysisControlsInner(p);
}
