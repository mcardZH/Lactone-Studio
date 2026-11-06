import {transformCalculationRange} from '../../results/calculation-range';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Structure } from '../../core/types';
import type { ModelDocument } from '../../modeling/contracts';
import type { PostprocessDocument } from '../../results/postprocess-document';
import type { SurfaceContext, SurfaceScalarField } from '../../results/surface-contracts';
import { sameSurfaceContext } from '../../results/surface-field';
import type { AnalysisSelectionPort } from '../analysis-selection-intent';
import type { SurfaceMeshState, ViewportSurfaceLayer } from '../modeling/render/surface-layer';
import type { AnalysisColorbar } from './analysis-display';
import InteractionAnalysisControls from './InteractionAnalysisControls';
import InteractionFragmentSelection from './InteractionFragmentSelection';
import { assertSurfaceCubeSourceGeometry } from './surface-desktop-bridge';
import { surfaceSourceAtomOrder, surfaceSourceRounding } from './SurfaceAnalysisInstance';
import { surfaceScientificContextKey, surfaceSourceLifetimeKey } from './surface-context-pool';
import { isRestoredAnalysisData } from '../../projects/analysis-state';
import { interactionUsesStructure } from '../../results/interaction-structure-context';
import { createInteractionContextPool, type InteractionContextPool, type InteractionDesktopController } from './interaction-context-pool';
import type { InteractionDesktopApi } from './interaction-desktop-bridge';
import type { InteractionAnalysisControlsProps, InteractionInteractionPort, InteractionProjection, InteractionScatterSnapshot } from './interaction-controls-contracts';
import { INTERACTION_METHOD_REFERENCES } from '../../results/interaction-references';
import { structureInteractionAtomOrder } from '../../results/interaction-structure-context';
import { MULTIWFN_CONFIGURATION_CHANGED } from './MultiwfnPathControl';

/** The trusted structure session writes its current numeric coordinates with
 * .17g and native validates the returned Cube against that same snapshot.
 * Cube half-last-digit intervals plus the existing floating-point guard are
 * sufficient; an original XYZ source's unknown print precision is unrelated. */
export function assertInteractionCubeSourceGeometry(field: SurfaceScalarField, structure: Structure, sourceRounding: number | null,
  generatedSource: 'wavefunction' | 'structure' | null = null): void {
  assertSurfaceCubeSourceGeometry(field, structure,
    field.source.kind === 'generated-cube' && generatedSource === 'structure' ? 0 : sourceRounding);
}

export interface InteractionViewportProjection extends InteractionProjection { surfaceLayer: ViewportSurfaceLayer | null; colorbar: AnalysisColorbar | null }
/** Explicit card removal only. Navigation keeps its existing projection owner;
 * detached scatter snapshots have a separate, intentional lifetime. */
export function withoutInteractionProjection<T>(projections: Readonly<Record<string, T>>, id: string): Record<string, T> {
  if (!Object.hasOwn(projections, id)) return projections;
  const next = { ...projections }; delete next[id]; return next;
}
type InteractionMeshObserver = (state: Readonly<SurfaceMeshState>, document: Pick<ModelDocument, 'id' | 'revision'>) => void;
/** Registration is stable across parent projections/progress renders. Otherwise
 * its effect cleanup can detach the listener just before the sibling viewport
 * submits the mesh in the same passive-effects pass. */
export function createInteractionMeshObservers() {
  const observers = new Map<string, InteractionMeshObserver>();
  const bindings = new Map<string, (observer: InteractionMeshObserver | null) => void>();
  return {
    get: (id: string) => observers.get(id),
    binding(id: string) {
      let binding = bindings.get(id);
      if (!binding) { binding = observer => { if (bindings.get(id) !== binding) return; if (observer) observers.set(id, observer); else observers.delete(id); }; bindings.set(id, binding); }
      return binding;
    },
    release(id: string) { observers.delete(id); bindings.delete(id); },
  };
}
export interface InteractionAnalysisInstanceProps {
  draftState?: InteractionAnalysisControlsProps['draftState'];
  /** A modeling document owns this pool across shared-sidebar remounts. */
  contextPool?: InteractionContextPool;
  analysisId: string; context: SurfaceContext; document: PostprocessDocument | null; structure: Structure; modelDocument: ModelDocument;
  wavefunctionAvailable: boolean; active: boolean; available?: boolean; capturePort?: AnalysisSelectionPort;
  desktop?: InteractionDesktopApi | null;
  onProjection(value: InteractionViewportProjection | null): void;
  onInteractionReady?(port: InteractionInteractionPort | null): void;
  onMeshObserverReady?(observer: ((state: Readonly<SurfaceMeshState>, document: Pick<ModelDocument, 'id' | 'revision'>) => void) | null): void;
  onOpenScatter?(snapshot: InteractionScatterSnapshot): void;
  onExportImage?(): void | Promise<void>; onError(message: string): void;
}

/** The admitted source route, not a filename/method guess, controls display fit.
 * External and promolecular fields are already in the observed source geometry. */
export function interactionInstanceProjection(projection: InteractionProjection | null, context: SurfaceContext, document: PostprocessDocument | null,
  admit: (field: SurfaceScalarField) => string | null, sourceKind: (field: SurfaceScalarField) => 'wavefunction' | 'structure' | null): InteractionViewportProjection | null {
  if (!projection || !sameSurfaceContext(projection.context, context)) return null;
  const pair = projection.fields;
  const invalid = pair && [pair.shape, pair.mapping].some(field => !!admit(field));
  const proof = document?.pair && document.pair.primary === document.output?.source && document.pair.wavefunction === document.wavefunction?.source ? document.pair : undefined;
  const fit = pair && pair.shape.source.kind === 'generated-cube' && sourceKind(pair.shape) === 'wavefunction' ? proof?.sourceToDisplay : undefined;
  const color = projection.display.color ? { ...projection.display.color, zeroCentered: true } : null;
  const colorbar: AnalysisColorbar | null = pair && !invalid && color ? { min: color.min, max: color.max, palette: 'blue-red', colors: color.colors,
    decimals: projection.decimals, label: 'sign(λ₂)ρ / a.u.', reverse: color.reverse, zeroCentered: true, layout: projection.display.colorbarLayout } : null;
  return { ...projection, calculationRanges: invalid ? undefined : projection.calculationRanges?.map(range=>transformCalculationRange(range,range.estimated?undefined:fit)), surfaceLayer: !pair || invalid ? null : { pair, documentId: context.documentId!, geometryRevision: context.documentRevision!,
    visible: projection.display.visible, opacity: projection.display.opacity, finish: projection.display.finish, color: color ?? undefined, sourceToDocument: fit }, colorbar };
}

export function interactionMeshCommitted(projection: InteractionViewportProjection | null, context: SurfaceContext, state: Readonly<SurfaceMeshState>,
  document: Pick<ModelDocument, 'id' | 'revision'>): boolean {
  return interactionMeshCurrent(projection, context, state, document) && state.status === 'committed' && state.submitted && !!state.committedKey
    && state.committedKey === state.attemptKey && state.vertexCount > 0 && state.triangleCount > 0;
}
function interactionMeshCurrent(projection: InteractionViewportProjection | null, context: SurfaceContext, state: Readonly<SurfaceMeshState>,
  document: Pick<ModelDocument, 'id' | 'revision'>): boolean {
  const pair = projection?.fields;
  return !!projection && !!pair && sameSurfaceContext(projection.context, context) && document.id === context.documentId && document.revision === context.documentRevision
    && state.shapeId === pair.shape.id && state.mappingId === pair.mapping.id && state.sourceId === context.sourceId && state.sourceRevision === context.sourceRevision;
}

export default function InteractionAnalysisInstance(p: InteractionAnalysisInstanceProps) {
  const desktop = p.desktop === undefined ? (typeof window === 'undefined' ? null : window.sciyueDesktop ?? null) : p.desktop;
  const key = `${p.analysisId}:${surfaceScientificContextKey(p.context)}`, lifetime = surfaceSourceLifetimeKey(p.analysisId, p.context);
  const latest = useRef({ props: p, key }); latest.current = { props: p, key };
  const rounding = p.document ? surfaceSourceRounding(p.document, p.context) : 0;
  const [poolState, setPoolState] = useState<{ lifetime: string; pool: InteractionContextPool } | null>(null);
  const [owned, setOwned] = useState<{ key: string; controller: InteractionDesktopController } | null>(null);
  const [, refresh] = useState(0);
  const controller = owned?.key === key ? owned.controller : null;
  const pool = poolState?.lifetime === lifetime ? poolState.pool : null;
  const currentProjection = useRef<InteractionViewportProjection | null>(null);
  const [resourceBudget, setResourceBudget] = useState<number | undefined>();
  useEffect(() => {
    if (!desktop?.orbitalResourceInfo) { setResourceBudget(undefined); return; }
    let alive = true, query = 0;
    const refreshResources = () => { const token = ++query; void desktop.orbitalResourceInfo!().then(info => {
      if (alive && query === token) setResourceBudget(Number.isSafeInteger(info.memoryBudgetBytes) && info.memoryBudgetBytes > 0 ? info.memoryBudgetBytes : undefined);
    }, () => { if (alive && query === token) setResourceBudget(undefined); }); };
    refreshResources(); window.addEventListener(MULTIWFN_CONFIGURATION_CHANGED, refreshResources);
    return () => { alive = false; query++; window.removeEventListener(MULTIWFN_CONFIGURATION_CHANGED, refreshResources); };
  }, [desktop]);
  useEffect(() => {
    if (!desktop) { setPoolState(null); setOwned(null); return; }
    const created = p.contextPool ?? createInteractionContextPool(); setPoolState({ lifetime, pool: created });
    const unsubscribe = created.subscribe(() => refresh(value => value + 1));
    return () => { unsubscribe(); if (!p.contextPool) void created.dispose().catch(error => latest.current.props.onError(String(error instanceof Error ? error.message : error))); };
  }, [desktop, lifetime, p.document?.wavefunction?.readSourceText, p.contextPool]);
  useEffect(() => {
    if (!desktop || !pool) return; let alive = true; let activated: InteractionDesktopController | null = null;
    const value = latest.current.props;
    void pool.activate({ desktop, analysisId: value.analysisId, context: value.context, document: value.document, structure: value.structure,
      coordinateRoundingAngstrom: rounding, active: value.active && value.available !== false, onCleanupError: message => latest.current.props.onError(message) })
      .then(controller => { activated = controller; if (alive && controller) setOwned({ key, controller }); else if (controller) void controller.setActive(false).catch(error => latest.current.props.onError(String(error instanceof Error ? error.message : error))); }, error => { if (alive) latest.current.props.onError(String(error instanceof Error ? error.message : error)); });
    return () => { alive = false; if (activated && p.contextPool) void activated.setActive(false).catch(error => latest.current.props.onError(String(error instanceof Error ? error.message : error))); };
  }, [desktop, pool, key, p.active, p.available, rounding]);
  const admit = useCallback((field: SurfaceScalarField): string | null => {
    try {
      const props = latest.current.props;
      if (!sameSurfaceContext(field.context, props.context)) throw new Error('相互作用格点与当前来源或原帧不一致。');
      if (field.source.kind === 'generated-cube') {
        const kind = controller?.generatedFieldSource(field);
        if (!kind) {
          if(!isRestoredAnalysisData(field))throw new Error('生成格点不属于当前分析的有效会话。');
          const wave=props.document?.wavefunction?.source.metadata?.structure;
          if(wave&&props.wavefunctionAvailable){try{assertInteractionCubeSourceGeometry(field,wave,rounding,'wavefunction');return null;}catch{/* A structure method may use the paired displayed geometry. */}}
          assertInteractionCubeSourceGeometry(field,props.structure,rounding,'structure');return null;
        }
        const geometry = kind === 'wavefunction' ? props.document?.wavefunction?.source.metadata?.structure : props.structure;
        if (!geometry || kind === 'wavefunction' && !props.wavefunctionAvailable) throw new Error('当前帧没有匹配的波函数几何。');
        assertInteractionCubeSourceGeometry(field, geometry, rounding, kind);
      } else assertInteractionCubeSourceGeometry(field, props.structure, rounding);
      return null;
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  }, [controller, rounding]);
  const publish = useCallback((value: InteractionProjection | null) => {
    if (latest.current.key !== key) return;
    const projected = interactionInstanceProjection(value, latest.current.props.context, latest.current.props.document, admit,
      field => controller?.generatedFieldSource(field) ?? (isRestoredAnalysisData(field)&&value?.fields?(interactionUsesStructure(value.fields.method)?'structure':'wavefunction'):null));
    currentProjection.current = projected; latest.current.props.onProjection(projected);
  }, [key, controller, admit]);
  const meshObserver = useCallback((state: Readonly<SurfaceMeshState>, document: Pick<ModelDocument, 'id' | 'revision'>) => {
    const projection = currentProjection.current;
    if (latest.current.key !== key || !projection?.generated || !interactionMeshCurrent(projection, latest.current.props.context, state, document)) return;
    if (state.status === 'failed') pool?.meshFailed(projection.context, projection.generated.stamp.requestId, state.error ?? '相互作用网格未提交。');
    else if (interactionMeshCommitted(projection, latest.current.props.context, state, document)) pool?.meshCommitted(projection.context, projection.generated.stamp.requestId);
  }, [key, pool]);
  useEffect(() => { p.onMeshObserverReady?.(meshObserver); return () => p.onMeshObserverReady?.(null); }, [p.onMeshObserverReady, meshObserver]);
  const sourceAtomOrder = useMemo(() => p.document ? surfaceSourceAtomOrder(p.structure, p.modelDocument,
    p.wavefunctionAvailable ? p.document.wavefunction?.source.metadata?.structure : undefined) ?? [] : structureInteractionAtomOrder(p.structure),
    [p.structure, p.modelDocument, p.wavefunctionAvailable, p.document]);
  const interaction = useCallback((port: InteractionInteractionPort | null) => { if (latest.current.key === key) latest.current.props.onInteractionReady?.(port); }, [key]);
  const accepted = useCallback<NonNullable<InteractionAnalysisControlsProps['onResultAccepted']>>((requestId, operation) => {
    const projection = currentProjection.current, props = latest.current.props;
    const needsMesh = operation === 'fields' && props.active && props.available !== false && projection?.generated?.stamp.requestId === requestId && !!projection.surfaceLayer?.visible;
    pool?.accepted(requestId, operation, needsMesh);
  }, [pool]);
  const rejected = useCallback<NonNullable<InteractionAnalysisControlsProps['onResultRejected']>>((requestId, operation, reason, message) => {
    pool?.rejected(requestId, operation, reason, message);
  }, [pool]);
  const projectBridge=useMemo<InteractionAnalysisControlsProps['bridge']>(()=>({...controller?.bridge,
    restoreFields:async(request,signal)=>{const target=pool?.get(request.context);if(!target?.bridge.restoreFields)throw new Error('原相互作用格点owner不可用，无法完整保存。');return target.bridge.restoreFields(request,signal);},
    restoreCube:async(request,signal)=>{const target=pool?.get(request.context);if(!target?.bridge.restoreCube)throw new Error('原相互作用Cube owner不可用，无法完整保存。');return target.bridge.restoreCube(request,signal);},
  }),[controller,pool]);
  return <InteractionAnalysisControls key={lifetime} draftState={p.draftState} context={p.context} structure={p.structure} active={p.active} available={p.available} resourceBudgetBytes={resourceBudget}
    wavefunctionAvailable={p.wavefunctionAvailable} methods={p.wavefunctionAvailable ? ['iri', 'rdg', 'igmh', 'migm', 'igm'] : ['migm', 'igm']}
    sourceAtomOrder={sourceAtomOrder} methodReferences={INTERACTION_METHOD_REFERENCES} bridge={projectBridge} progress={pool?.progress(p.context)} cubeGeometryError={admit}
    renderFragmentSelection={p.capturePort ? props => <InteractionFragmentSelection {...props} structure={p.structure} capture={p.capturePort!}/> : undefined}
    onProjection={publish} onResultAccepted={accepted} onResultRejected={rejected} onInteractionReady={interaction} onOpenScatter={p.onOpenScatter} onExportImage={p.onExportImage} onError={p.onError}/>;
}
