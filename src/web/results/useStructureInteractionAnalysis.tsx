import {DismissibleNotice} from '../DismissibleNotice';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { sha256Utf8 } from '../../core/file-identity';
import type { ModelDocument, ModelStore } from '../../modeling/contracts';
import type { SurfaceContext } from '../../results/surface-contracts';
import { createStructureInteractionContext } from '../../results/interaction-structure-context';
import type { AnalysisSelectionPort } from '../analysis-selection-intent';
import type { ModelViewportProps } from '../modeling/ModelViewport';
import type { InteractionDesktopApi } from './interaction-desktop-bridge';
import InteractionAnalysisInstance, { type InteractionViewportProjection } from './InteractionAnalysisInstance';
import type { InteractionScatterSnapshot, InteractionInteractionPort } from './interaction-controls-contracts';
import { useAnalysisAtomCapture } from './useAnalysisAtomCapture';
import { sameSurfaceContext } from '../../results/surface-field';
import InteractionStructureScatterDeck, { type StructureInteractionScatterSnapshot } from './InteractionStructureScatterDeck';
import { INTERACTION_COMPONENT_LABELS, INTERACTION_METHOD_LABELS } from './interaction-presentation';
import type { InteractionAnalysisControlsProps } from './interaction-controls-contracts';
import { createInteractionContextPool, type InteractionContextPool } from './interaction-context-pool';
import AnalysisWorkspace from './AnalysisWorkspace';
import PostprocessDisplayPanel from './PostprocessDisplayPanel';
import { currentStructureAnalysisUnavailable } from './CurrentStructureAnalysisEntry';
import {useProjectUiSnapshot} from '../../projects/ui-state';

export interface StructureInteractionAnalysisOptions {
  document: ModelDocument; active: boolean; desktop?: InteractionDesktopApi | null; store?: ModelStore;
  capturePort?: AnalysisSelectionPort;
  onOpenScatter?(snapshot: InteractionScatterSnapshot): void;
  onExportImage?(): void | Promise<void>; onError(message: string): void;
}
interface Owner {
  id: string; key: string; document: ModelDocument; context: SurfaceContext;
  draftState: NonNullable<InteractionAnalysisControlsProps['draftState']>; pool: InteractionContextPool;
  port?: InteractionInteractionPort;
  bindInteraction(port:InteractionInteractionPort|null):void;
  publish(value: InteractionViewportProjection | null): void;
  observe?: NonNullable<ModelViewportProps['onSurfaceMeshState']>;
  bind(observer: NonNullable<ModelViewportProps['onSurfaceMeshState']> | null): void;
}

/** Exact geometry identity for display reuse after Undo's monotonic revision.
 * The original source stamp/revision is preserved; this never changes a field. */
export function structureInteractionGeometryKey(document: ModelDocument): string {
  return sha256Utf8(JSON.stringify([document.id, document.draft.structure.cell ?? null, document.draft.structure.periodicSource ?? null,
    document.draft.structure.atoms.map(atom => [atom.id, atom.element, atom.x, atom.y, atom.z])]));
}

export function structureInteractionViewport(projection: InteractionViewportProjection | null, source: ModelDocument, current: ModelDocument): Partial<ModelViewportProps> {
  if (!projection || !sameSurfaceContext(projection.context, createStructureInteractionContext(source))
    || source.id !== current.id || structureInteractionGeometryKey(source) !== structureInteractionGeometryKey(current)) return {};
  const pairs = projection.highlights.pairs.map(row => {
    const atoms = row.atomIds.map(id => current.draft.structure.atoms.find(atom => atom.id === id));
    return { ...row, measurementLabel: row.label, decimals: projection.decimals,
      length: atoms.every(Boolean) ? Math.hypot(atoms[0]!.x - atoms[1]!.x, atoms[0]!.y - atoms[1]!.y, atoms[0]!.z - atoms[1]!.z) : undefined };
  });
  return { surfaceLayer: projection.surfaceLayer ? { ...projection.surfaceLayer, documentId: current.id, geometryRevision: current.revision } : undefined,
    resultAtomLabels: projection.highlights.atoms, resultBondValues: pairs, resultBondLabels: true,
    resultHighlights: { atomIds: projection.highlights.atoms.map(row => row.atomId), bondPairs: projection.highlights.pairs.map(row => row.atomIds) },
    resultColorbar: projection.colorbar ?? undefined };
}

/** Keep this hook mounted with the model workspace. `active` changes display
 * and cancels pending work; source snapshots and completed native artifacts
 * stay owned until explicit disposal or the workspace is closed. */
export function useStructureInteractionAnalysis(options: StructureInteractionAnalysisOptions): {
  controls: ReactNode; viewport: Partial<ModelViewportProps>; projection: InteractionViewportProjection | null;
  hasResults: boolean; currentSource: SurfaceContext | null; clear(): void;
} {
  const latest = useRef(options); latest.current = options;
  const [panelOpen, setPanelOpen] = useState(true);
  const analysisActive = options.active && panelOpen;
  const analysisActiveRef = useRef(analysisActive); analysisActiveRef.current = analysisActive;
  const [owners, setOwners] = useState<Owner[]>([]), [projections, setProjections] = useState<Record<string, InteractionViewportProjection | null>>({});
  const [scatter, setScatter] = useState<StructureInteractionScatterSnapshot[]>([]);
  const retained = useRef(owners); retained.current = owners;
  const savedCitationOwners=useRef<{id:string;context:SurfaceContext}[]|null>(null);
  const restoredCitationOwners=useProjectUiSnapshot<{id:string;context:SurfaceContext}[]>('structure-interaction-citation-owners',()=>[...new Map([...(savedCitationOwners.current??[]),...retained.current.map(value=>({id:value.id,context:value.context}))].map(value=>[value.id,value])).values()]);
  if(savedCitationOwners.current===null)savedCitationOwners.current=Array.isArray(restoredCitationOwners)?restoredCitationOwners:[];
  useLayoutEffect(() => () => { for (const owner of retained.current) void owner.pool.dispose().catch(error => latest.current.onError(String(error instanceof Error ? error.message : error))); }, []);
  const current = useMemo(() => {
    try { return { key: structureInteractionGeometryKey(options.document), context: createStructureInteractionContext(options.document), error: '' }; }
    catch (error) { return { key: '', context: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [options.document.id, options.document.revision, options.document.draft.structure]);
  const owner = owners.find(value => value.key === current.key) ?? null;
  useLayoutEffect(() => {
    if (!options.active || !current.context || !current.key || owner) return;
    const snapshot = structuredClone(options.document), context = current.context, id = 'structure-interaction-' + crypto.randomUUID();
    const created: Owner = { id, key: current.key, document: snapshot, context, draftState: {}, pool: createInteractionContextPool(),
      publish(value) { if (!value || !sameSurfaceContext(value.context, context)) return;
        setProjections(previous => previous[id] === value ? previous : { ...previous, [id]: value }); },
      bindInteraction(port) { created.port = port ?? undefined; },
      bind(observer) { created.observe = observer ?? undefined; } };
    setOwners(previous => previous.some(value => value.key === created.key) ? previous : [...previous, created]);
  }, [options.active, current.key, current.context, owner, owners.length, options.document]);
  const capture = useAnalysisAtomCapture({ ownerId: owner?.id ?? '', structure: options.document.draft.structure,
    documentId: options.document.id, revision: options.document.revision, sourceId: owner?.context.sourceId ?? '',
    sourceRevision: owner?.context.sourceRevision, frameIndex: 0, activationEpoch: owner?.id ?? '',
    purpose: 'interaction-fragment', active: analysisActive && !!owner, onError: options.onError });
  const cached = owner ? projections[owner.id] ?? null : null;
  const projection = analysisActive ? cached : null;
  const hasResults = !!cached?.generated || !!cached?.contributions;
  const clear = useCallback(() => { capture.cancel();savedCitationOwners.current=[]; for (const owner of retained.current) void owner.pool.dispose().catch(error => latest.current.onError(String(error instanceof Error ? error.message : error))); setOwners([]); setProjections({}); }, [capture.cancel]);
  useLayoutEffect(() => {
    if (!hasResults || !owner || !options.store || options.document.analysisBindingId === owner.id) return;
    if (options.document.analysisBindingId && !options.document.analysisBindingId.startsWith('structure-interaction-')) return;
    options.store.bindAnalysisContext?.(owner.id, options.document.id, options.document.revision);
  }, [hasResults, owner, options.store, options.document.id, options.document.revision, options.document.analysisBindingId]);
  const mesh = useCallback<NonNullable<ModelViewportProps['onSurfaceMeshState']>>((state, document) => {
    const now = latest.current;
    if (!analysisActiveRef.current || !owner || document.id !== now.document.id || document.revision !== now.document.revision
      || structureInteractionGeometryKey(now.document) !== owner.key) return;
    // Display is on the current Undo revision; mesh acceptance belongs to the
    // immutable original source owner and preserves its exact request stamp.
    owner.observe?.(state, { id: owner.document.id, revision: owner.document.revision });
  }, [owner]);
  const viewport = useMemo<Partial<ModelViewportProps>>(() => analysisActive && owner ? {
    ...structureInteractionViewport(projection, owner.document, options.document), readOnly: true,
    analysisAtomCapture: capture.viewportCapture, onSurfaceMeshState: mesh,
    resultColorbarOwnerKey: JSON.stringify([owner.id, owner.context.sourceId, owner.context.sourceRevision, owner.context.jobIndex, owner.context.sourceFrameIndex, owner.context.generation]),
    onResultColorbarLayoutChange: layout => {
      const current = latest.current;
      if (analysisActiveRef.current && structureInteractionGeometryKey(current.document) === owner.key) owner.port?.setColorbarLayout?.(layout);
    },
  } : {}, [analysisActive, owner, projection, options.document, capture.viewportCapture, mesh]);
  const content = <>
    {options.active && current.error && <DismissibleNotice role="alert">{current.error}</DismissibleNotice>}
    {owners.map(value => <div key={value.id} hidden={!options.active || value !== owner}>
      <InteractionAnalysisInstance analysisId={value.id} context={value.context} document={null} structure={value.document.draft.structure}
        draftState={value.draftState} contextPool={value.pool}
        modelDocument={value.document} wavefunctionAvailable={false} active={analysisActive && value === owner}
        available={value === owner} desktop={options.desktop} capturePort={value === owner ? options.capturePort ?? capture.selectionPort : undefined}
        onProjection={value.publish} onMeshObserverReady={value.bind} onInteractionReady={value.bindInteraction} onOpenScatter={options.onOpenScatter ?? (snapshot => {
          if (!sameSurfaceContext(snapshot.context, value.context)) return;
          setScatter(previous => [...previous, { ...snapshot, id: 'structure-scatter-' + crypto.randomUUID(),
            title: `${INTERACTION_METHOD_LABELS[snapshot.method]} · ${INTERACTION_COMPONENT_LABELS[snapshot.component]}`,
            modelName: value.document.draft.structure.name }]);
        })}
        onExportImage={options.onExportImage} onError={options.onError}/>
    </div>)}
  </>;
  const controls = <section className="analysis-workspace-host" data-testid="structure-interaction-analysis" data-document-id={options.document.id}>
    <AnalysisWorkspace key={options.document.id} sourceId={options.document.id} initialPage="interaction" active={options.active}
      unavailableReason={page => currentStructureAnalysisUnavailable(options.document, page)}
      onActive={id => setPanelOpen(id !== null)} onActivate={() => {}} onError={options.onError}
      render={(instance, active) => <PostprocessDisplayPanel result={null} structure={options.document.draft.structure}
        currentIndex={0} analysisPage={instance.kind} hideEntries active={active} wavefunctionAvailable={false}
        unavailableReason={page => currentStructureAnalysisUnavailable(options.document, page)}
        atomicDisplay={{property:null,color:false,labels:false}} onAtomicDisplay={() => {}}
        dipoleVisible={false} dipoleAvailable={false} onDipoleVisible={() => {}} onOpenPlot={() => {}}
        interactionControls={content}/>}/>
    {scatter.length > 0 && <InteractionStructureScatterDeck snapshots={scatter} active={options.active}
      onClose={id => setScatter(previous => previous.filter(value => value.id !== id))}/>}
  </section>;
  return { controls, viewport, projection, hasResults, currentSource: owner?.context ?? null, clear };
}
