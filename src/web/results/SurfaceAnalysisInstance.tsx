import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Structure } from '../../core/types';
import type { ModelDocument } from '../../modeling/contracts';
import type { PostprocessDocument } from '../../results/postprocess-document';
import type { SurfaceCapability, SurfaceContext, SurfaceScalarField } from '../../results/surface-contracts';
import { sameSurfaceContext } from '../../results/surface-field';
import type { AnalysisSelectionPort } from '../analysis-selection-intent';
import { MULTIWFN_CONFIGURATION_CHANGED } from './MultiwfnPathControl';
import SurfaceAnalysisControls from './SurfaceAnalysisControls';
import SurfaceRegionSelection from './SurfaceRegionSelection';
import { assertSurfaceCubeSourceGeometry, type SurfaceDesktopApi, type SurfaceDesktopController } from './surface-desktop-bridge';
import type { SurfaceCapabilityRequest, SurfaceControlsBridge, SurfaceInteractionPort, SurfaceProjection } from './surface-controls-contracts';
import { createSurfaceContextPool, surfaceScientificContextKey, surfaceSourceLifetimeKey, type SurfaceContextPool } from './surface-context-pool';
import {surfaceCapabilityKey} from './surface-capability';
import HirshfeldAnalysisInstance from './HirshfeldAnalysisInstance';
import type { HirshfeldProjection, HirshfeldFingerprintSnapshot } from './hirshfeld-controls-contracts';
import type { HirshfeldDesktopApi } from './hirshfeld-desktop-controller';
import { InputSettingsLayout } from '../InputSettingsLayout';
import { InputSettingsField, InputSettingsRow } from '../InputSettingsFields';
import type { SurfaceMeshState } from '../modeling/render/surface-layer';
import type { AnalysisColorbarLayout } from './analysis-colorbar-layout';
import { isRestoredAnalysisData, useAnalysisProjectSnapshot } from '../../projects/analysis-state';

export interface SurfaceAnalysisInstanceProps {
  analysisId: string; context: SurfaceContext; document: PostprocessDocument; structure: Structure; modelDocument: ModelDocument;
  wavefunctionAvailable: boolean; active: boolean; available?: boolean; capturePort?: AnalysisSelectionPort;
  /** Structure-only families do not inherit a generated source's electronic-field permissions. */
  electronicSurfaceAllowed?: boolean;
  /** Each electronic function has independent file prerequisites. */
  electronicSurfaceMethods?: readonly ('esp'|'alie')[];
  desktop?: SurfaceDesktopApi | null;
  coordinateRoundingAngstrom?: number | null;
  onProjection(value: SurfaceProjection | null): void;
  onInteractionReady?(port: SurfaceInteractionPort | null): void;
  onExportImage?(): void | Promise<void>;
  onHirshfeldProjection?(value: HirshfeldProjection | null): void;
  onSurfaceFamilyChange?(family: 'electronic' | 'hirshfeld'): void;
  onOpenHirshfeldFingerprint?(snapshot: HirshfeldFingerprintSnapshot): void;
  onHirshfeldColorbarLayoutReady?(setter: ((layout: AnalysisColorbarLayout) => void) | null): void;
  onHirshfeldMeshObserverReady?(observer: ((state: Readonly<SurfaceMeshState>, document: Pick<ModelDocument, 'id' | 'revision'>) => void) | null): void;
  onError(message: string): void;
}
const missingPorts: SurfaceControlsBridge = {};

export function surfaceSourceRounding(document: PostprocessDocument, context: SurfaceContext): number | null {
  const frame = document.result.frames.find(row => (row.sourceFrameIndex ?? row.index) === context.sourceFrameIndex);
  if (frame?.coordinateRoundingAngstrom !== undefined) return frame.coordinateRoundingAngstrom;
  const source = [document.output, document.wavefunction, ...(document.companions ?? [])].find(attachment => attachment?.source.result.source.id === document.result.source.id)?.source;
  if (!source) return null;
  return source.coordinateRoundingByFrame ? source.coordinateRoundingByFrame[context.sourceFrameIndex ?? -1] ?? null : source.coordinateRoundingAngstrom;
}

/** Ordinals refer to the accepted native source order, independently from an
 * engine's raw printed index base. No editable model reordering is inferred. */
export function surfaceSourceAtomOrder(structure: Structure, modelDocument: ModelDocument, nativeStructure?: Structure): readonly { atomId: string; sourceIndex: number }[] | undefined {
  const display = modelDocument.draft.structure.atoms, atoms = structure.atoms;
  if (atoms.length !== display.length || nativeStructure && nativeStructure.atoms.length !== atoms.length) return undefined;
  const ids = new Set<string>();
  for (let index = 0; index < atoms.length; index++) {
    const atom = atoms[index];
    if (!atom.id || ids.has(atom.id) || display[index].id !== atom.id || display[index].element !== atom.element
      || nativeStructure && nativeStructure.atoms[index].element !== atom.element) return undefined;
    ids.add(atom.id);
  }
  return atoms.map((atom, index) => ({ atomId: atom.id!, sourceIndex: index + 1 }));
}

/** Apply only an existing accepted wavefunction fit. External Cube coordinates
 * remain in their admitted source frame; field arrays are never copied here. */
export function surfaceInstanceProjection(projection: SurfaceProjection | null, context: SurfaceContext, document: PostprocessDocument,
  admitCube: (field: SurfaceScalarField) => string | null): SurfaceProjection | null {
  if (!projection || !sameSurfaceContext(projection.context, context)) return null;
  const admission = projection.fields && [projection.fields.shape, ...(projection.fields.mapping ? [projection.fields.mapping] : [])].map(admitCube).find(Boolean);
  const proof = document.pair && document.pair.primary === document.output?.source && document.pair.wavefunction === document.wavefunction?.source ? document.pair : undefined;
  const fit = projection.analysis?.route === 'wavefunction-direct' ? proof?.sourceToDisplay : undefined;
  return { ...projection,
    surfaceLayer: admission || !projection.surfaceLayer ? null : { ...projection.surfaceLayer, sourceToDocument: fit },
    surfaceExtrema: projection.surfaceExtrema ? { ...projection.surfaceExtrema, sourceToDocument: fit } : null,
    colorbar: admission ? null : projection.colorbar };
}

/** A UI lifetime shell. Native compute stays exclusively behind explicit ports;
 * hidden/unavailable views preserve completed Controls state and native caches. */
function ElectronicSurfaceAnalysisInstance(p: SurfaceAnalysisInstanceProps) {
  const desktop = p.desktop === undefined ? (typeof window === 'undefined' ? null : window.sciyueDesktop ?? null) : p.desktop;
  const key = `${p.analysisId}:${surfaceScientificContextKey(p.context)}`, lifetimeKey = surfaceSourceLifetimeKey(p.analysisId,p.context);
  const latest = useRef({ props: p, key }); latest.current = { props: p, key };
  const rounding = p.coordinateRoundingAngstrom === undefined ? surfaceSourceRounding(p.document, p.context) : p.coordinateRoundingAngstrom;
  const [owned, setOwned] = useState<{ key: string; controller: SurfaceDesktopController } | null>(null);
  const [poolState,setPoolState]=useState<{key:string;pool:SurfaceContextPool}|null>(null);
  const [capabilities, setCapabilities] = useState<{ key: string; requestKey?:string;values: readonly SurfaceCapability[] }>({ key: '', values: [] });
  const capabilityRequest = useRef('');
  const capabilityVersion=useRef(0),currentCapabilityQuery=useRef<SurfaceCapabilityRequest|null>(null),capabilityContext=useRef(key);
  if(capabilityContext.current!==key){capabilityContext.current=key;currentCapabilityQuery.current=null;capabilityRequest.current='';capabilityVersion.current++;}
  const controller = owned?.key === key ? owned.controller : null;
  const [resourceBudget, setResourceBudget] = useState<number | undefined>();
  useEffect(() => {
    if (!desktop?.orbitalResourceInfo) { setResourceBudget(undefined); return; }
    let alive = true, query = 0;
    const refreshResources = () => { const token = ++query; void desktop.orbitalResourceInfo!().then(info => {
      if (alive && query === token) setResourceBudget(Number.isSafeInteger(info.memoryBudgetBytes) && info.memoryBudgetBytes > 0 ? info.memoryBudgetBytes : undefined);
    }, () => { if (alive && query === token) setResourceBudget(undefined); }); };
    refreshResources();
    if (typeof window !== 'undefined') window.addEventListener(MULTIWFN_CONFIGURATION_CHANGED, refreshResources);
    return () => { alive = false; query++; if (typeof window !== 'undefined') window.removeEventListener(MULTIWFN_CONFIGURATION_CHANGED, refreshResources); };
  }, [desktop]);
  useEffect(()=>()=>{capabilityVersion.current++;capabilityRequest.current='';currentCapabilityQuery.current=null;},[]);

  // Construct within the effect: Strict Mode replay cleanup must never dispose
  // the controller that the next effect setup will continue to use.
  useEffect(() => {
    if (!desktop) { setPoolState(null);setOwned(null);setCapabilities({ key:'', values: [] });return; }
    const pool=createSurfaceContextPool();setPoolState({key:lifetimeKey,pool});
    return()=>{void pool.dispose().catch(error=>latest.current.props.onError(String(error instanceof Error?error.message:error)));};
  },[desktop,lifetimeKey,p.document.wavefunction?.readSourceText]);
  useEffect(()=>{
    if(!desktop||!poolState||poolState.key!==lifetimeKey)return;
    let alive=true;const props=latest.current.props;
    void poolState.pool.activate({desktop,analysisId:props.analysisId,context:props.context,document:props.document,structure:props.structure,
      coordinateRoundingAngstrom:rounding,active:props.active&&props.available!==false,onCleanupError:message=>latest.current.props.onError(message)})
      .then(own=>{if(!alive||!own)return;setOwned({key,controller:own});capabilityRequest.current='';
        const query=currentCapabilityQuery.current,requestKey=query?surfaceCapabilityKey(query):'',version=++capabilityVersion.current;
        return own.capabilities(query??undefined).then(values=>{if(alive&&latest.current.key===key&&version===capabilityVersion.current)setCapabilities({key,requestKey,values});},
          error=>{if(alive&&latest.current.key===key&&version===capabilityVersion.current)latest.current.props.onError(String(error instanceof Error?error.message:error));});},
        error=>{if(alive)latest.current.props.onError(String(error instanceof Error?error.message:error));});
    return()=>{alive=false;};
  },[desktop,poolState,lifetimeKey,key,p.active,p.available,rounding]);
  useEffect(()=>{
    if(!controller||typeof window==='undefined')return;let alive=true;
    const refresh=()=>{const query=currentCapabilityQuery.current,requestKey=query?surfaceCapabilityKey(query):'',version=++capabilityVersion.current;
      void controller.capabilities(query??undefined).then(values=>{if(alive&&latest.current.key===key&&version===capabilityVersion.current)setCapabilities({key,requestKey,values});},error=>{if(alive&&latest.current.key===key&&version===capabilityVersion.current)latest.current.props.onError(String(error instanceof Error?error.message:error));});};
    window.addEventListener(MULTIWFN_CONFIGURATION_CHANGED,refresh);return()=>{alive=false;window.removeEventListener(MULTIWFN_CONFIGURATION_CHANGED,refresh);};
  },[controller,key]);

  const admitCube = useCallback((field: SurfaceScalarField): string | null => {
    try {
      const props = latest.current.props;
      if (!sameSurfaceContext(field.context, props.context)) throw new Error('表面格点与当前来源或原帧不一致。');
      if (field.source.kind === 'generated-cube') {
        if (!controller?.ownsGeneratedField(field)) {
          if (!isRestoredAnalysisData(field)) throw new Error('生成格点不属于当前分析的有效原生会话。');
          const geometry=props.document.wavefunction?.source.metadata?.structure??props.structure;
          assertSurfaceCubeSourceGeometry(field,geometry,rounding);
        }
      } else assertSurfaceCubeSourceGeometry(field, props.structure, rounding);
      return null;
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  }, [controller, rounding]);
  const publish = useCallback((projection: SurfaceProjection | null) => {
    const state = latest.current;
    if (state.key !== key) return;
    state.props.onProjection(surfaceInstanceProjection(projection,state.props.context,state.props.document,admitCube));
    if (!projection || !sameSurfaceContext(projection.context, state.props.context)) return;
    const query=projection.capabilityRequest;currentCapabilityQuery.current=query??null;
    const queryKey=query?surfaceCapabilityKey(query):'',requestKey = `${key}:${queryKey}:${projection.analysis?.stamp.requestId ?? ''}`;
    if (controller && capabilityRequest.current !== requestKey) {
      capabilityRequest.current = requestKey;
      const version=++capabilityVersion.current;
      void controller.capabilities(query).then(values => {
        if (latest.current.key === key && capabilityRequest.current === requestKey&&version===capabilityVersion.current) setCapabilities({ key,requestKey:queryKey,values });
      }, error => { if (latest.current.key === key&&capabilityRequest.current===requestKey&&version===capabilityVersion.current) latest.current.props.onError(String(error instanceof Error ? error.message : error)); });
    }
  }, [controller, key, admitCube]);
  const interaction = useCallback((port: SurfaceInteractionPort | null) => { if (latest.current.key === key) latest.current.props.onInteractionReady?.(port); }, [key]);
  const sourceAtomOrder = useMemo(() => surfaceSourceAtomOrder(p.structure, p.modelDocument,
    p.wavefunctionAvailable ? p.document.wavefunction?.source.metadata?.structure : undefined), [p.structure, p.modelDocument, p.wavefunctionAvailable, p.document.wavefunction?.source.metadata]);
  const projectPorts=useMemo<SurfaceControlsBridge>(()=>({...controller?.ports,
    restoreFields:async(request,signal)=>{const target=poolState?.pool.get(request.context);if(!target?.ports.restoreFields)throw new Error('原表面格点owner不可用，无法完整保存。');return target.ports.restoreFields(request,signal);},
    restoreCube:async(request,signal)=>{const target=poolState?.pool.get(request.context);if(!target?.ports.restoreCube)throw new Error('原表面Cube owner不可用，无法完整保存。');return target.ports.restoreCube(request,signal);},
  }),[controller,poolState]);
  return <SurfaceAnalysisControls key={lifetimeKey} context={p.context} structure={p.structure} active={p.active} available={p.available}
    wavefunctionAvailable={p.wavefunctionAvailable} allowedWavefunctionMethods={p.electronicSurfaceMethods} capabilities={capabilities.key === key ? capabilities.values : []} capabilitiesKey={capabilities.key===key?capabilities.requestKey??'':''} bridge={controller?projectPorts:missingPorts}
    cubeGeometryError={admitCube} sourceAtomOrder={sourceAtomOrder} resourceBudgetBytes={resourceBudget}
    renderRegionSelection={p.capturePort ? props => <SurfaceRegionSelection {...props} structure={p.structure} capture={p.capturePort!}/> : undefined}
    onProjection={publish} onInteractionReady={interaction} onExportImage={p.onExportImage} onError={p.onError}/>;
}

/** One workspace entry with independent scientific families. After first entry,
 * each child stays mounted so browsing never discards its accepted result. */
export default function SurfaceAnalysisInstance(p: SurfaceAnalysisInstanceProps) {
  const electronicAllowed = p.electronicSurfaceAllowed !== false;
  const [selectedFamily, setFamily] = useState<'electronic' | 'hirshfeld'>(() => electronicAllowed ? 'electronic' : 'hirshfeld');
  const family = electronicAllowed ? selectedFamily : 'hirshfeld';
  const [hirshfeldCreated, setHirshfeldCreated] = useState(!electronicAllowed);
  useAnalysisProjectSnapshot(`surface-family:${JSON.stringify([p.context.documentId,p.analysisId,p.context.sourceId,p.context.sourceRevision])}`,()=>({selectedFamily,hirshfeldCreated}),saved=>{setFamily(saved.selectedFamily);setHirshfeldCreated(saved.hirshfeldCreated);},p.onError,()=>null);
  const latest = useRef({ props: p, family }); latest.current = { props: p, family };
  const electronicProjection = useCallback((value: SurfaceProjection | null) => { if (latest.current.family === 'electronic') latest.current.props.onProjection(value); }, []);
  const hsProjection = useCallback((value: HirshfeldProjection | null) => { if (latest.current.family === 'hirshfeld') latest.current.props.onHirshfeldProjection?.(value); }, []);
  useEffect(() => { latest.current.props.onSurfaceFamilyChange?.(family); if (family === 'hirshfeld') { setHirshfeldCreated(true); latest.current.props.onProjection(null); } }, [family]);
  return <><InputSettingsLayout><InputSettingsRow><InputSettingsField label="分析任务"><select aria-label="分子表面类型" value={family} onChange={event => {
    const value = event.currentTarget.value === 'hirshfeld' ? 'hirshfeld' : 'electronic';
    if (value === 'electronic' && !electronicAllowed) return;
    if (value === 'hirshfeld') setHirshfeldCreated(true); setFamily(value); p.onProjection(null); p.onHirshfeldProjection?.(null); p.onSurfaceFamilyChange?.(value);
  }}><option value="electronic" disabled={!electronicAllowed}>定量分析分子表面</option><option value="hirshfeld">Hirshfeld表面分析</option></select></InputSettingsField></InputSettingsRow></InputSettingsLayout>
    <div hidden={family !== 'electronic'}><ElectronicSurfaceAnalysisInstance {...p} active={p.active && electronicAllowed && family === 'electronic'} onProjection={electronicProjection}/></div>
    {(hirshfeldCreated || family === 'hirshfeld') && <div hidden={family !== 'hirshfeld'}><HirshfeldAnalysisInstance analysisId={p.analysisId + ':hirshfeld'} context={p.context} structure={p.structure}
      active={p.active && family === 'hirshfeld'} available={p.available} capturePort={p.capturePort} onProjection={hsProjection} desktop={p.desktop as HirshfeldDesktopApi | null | undefined}
      onExportImage={p.onExportImage} onOpenFingerprint={p.onOpenHirshfeldFingerprint} onColorbarLayoutReady={p.onHirshfeldColorbarLayoutReady} onMeshObserverReady={p.onHirshfeldMeshObserverReady} onError={p.onError}/></div>}</>;
}
