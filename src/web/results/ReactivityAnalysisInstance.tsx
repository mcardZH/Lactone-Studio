import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Structure } from '../../core/types';
import type { ModelDocument } from '../../modeling/contracts';
import type { PostprocessDocument } from '../../results/postprocess-document';
import type { SurfaceContext } from '../../results/surface-contracts';
import type { ViewportOrbitalLayer, WavefunctionMetadata } from '../../results/orbital-contracts';
import type { ReactivitySessionInfo } from '../../results/reactivity-contracts';
import ReactivityAnalysisControls from './ReactivityAnalysisControls';
import type { ReactivityProjection, ReactivityInteractionPort } from './reactivity-controls-contracts';
import { createReactivityContextPool, type ReactivityContextPool, type ReactivityDesktopController } from './reactivity-context-pool';
import type { ReactivityDesktopApi } from './reactivity-desktop-bridge';
import { reactivityContextKey } from './reactivity-presentation';
import { surfaceSourceLifetimeKey } from './surface-context-pool';
import { surfaceSourceAtomOrder } from './SurfaceAnalysisInstance';
import type { OrbitalBridge } from './useOrbitalField';

export interface ReactivityViewportProjection extends ReactivityProjection { orbitalLayer: ViewportOrbitalLayer | null }
export interface ReactivityAnalysisInstanceProps {
  analysisId: string; context: SurfaceContext; document: PostprocessDocument; structure: Structure; modelDocument: ModelDocument;
  wavefunctionAvailable: boolean; active: boolean; available?: boolean; desktop?: ReactivityDesktopApi | null;
  onProjection(value: ReactivityViewportProjection | null): void;
  onInteractionReady?(port: ReactivityInteractionPort | null): void;
  onExportImage?(): void | Promise<void>; onError(message: string): void;
}
interface Opened { info: ReactivitySessionInfo; metadata: WavefunctionMetadata; orbitalSessionId: string }
export function reactivityInstanceProjection(projection: ReactivityProjection | null, context: SurfaceContext, document: PostprocessDocument, opened: Opened | null): ReactivityViewportProjection | null {
  if (!projection || reactivityContextKey(projection.context) !== reactivityContextKey(context)) return null;
  const field = projection.orbitalField;
  const proof = document.pair && document.pair.primary === document.output?.source && document.pair.wavefunction === document.wavefunction?.source ? document.pair : null;
  const admitted = field && opened && field.sessionId === opened.orbitalSessionId && field.sourceRevision === opened.metadata.sourceRevision && opened.metadata.orbitals.some(row => row.key === field.orbitalKey);
  return { ...projection, orbitalLayer: !admitted || !field || context.documentId === undefined || context.documentRevision === undefined ? null : {
    field, documentId: context.documentId, geometryRevision: context.documentRevision, sourceToDocument: proof?.sourceToDisplay,
    ...projection.orbitalSettings,
  } };
}
export default function ReactivityAnalysisInstance(p: ReactivityAnalysisInstanceProps) {
  const desktop = p.desktop === undefined ? (typeof window === 'undefined' ? null : window.sciyueDesktop ?? null) : p.desktop;
  const key = `${p.analysisId}:${reactivityContextKey(p.context)}`, lifetime = surfaceSourceLifetimeKey(p.analysisId, p.context);
  const latest = useRef({ props: p, key }); latest.current = { props: p, key };
  const [poolState, setPoolState] = useState<{ lifetime: string; pool: ReactivityContextPool } | null>(null);
  const [owned, setOwned] = useState<{ key: string; controller: ReactivityDesktopController; opened: Opened } | null>(null);
  const [, refresh] = useState(0);
  const pool = poolState?.lifetime === lifetime ? poolState.pool : null, current = owned?.key === key ? owned : null;
  useEffect(() => {
    if (!desktop) { setPoolState(null); setOwned(null); return; }
    const created = createReactivityContextPool(); setPoolState({ lifetime, pool: created });
    const unsubscribe = created.subscribe(() => refresh(value => value + 1));
    return () => { unsubscribe(); void created.dispose().catch(error => latest.current.props.onError(String(error instanceof Error ? error.message : error))); };
  }, [desktop, lifetime, p.document.wavefunction?.readSourceText]);
  useEffect(() => {
    if (!desktop || !pool) return;
    let alive = true;
    const props = latest.current.props;
    void pool.activate({ desktop, analysisId: props.analysisId, context: props.context, document: props.document, structure: props.structure,
      active: props.active && props.available !== false && props.wavefunctionAvailable, onCleanupError: message => latest.current.props.onError(message) })
      .then(async controller => {
        if (!controller || !alive || !props.active || !props.wavefunctionAvailable || props.available === false) return;
        const opened = await controller.open();
        if (alive && latest.current.key === key) setOwned({ key, controller, opened });
      }).catch(error => { if (alive) latest.current.props.onError(String(error instanceof Error ? error.message : error)); });
    return () => { alive = false; };
  }, [desktop, pool, key, p.active, p.available, p.wavefunctionAvailable]);
  const publish = useCallback((projection: ReactivityProjection | null) => {
    if (latest.current.key !== key) return;
    latest.current.props.onProjection(reactivityInstanceProjection(projection, latest.current.props.context, latest.current.props.document, current?.opened ?? null));
  }, [key, current]);
  const interaction = useCallback((port: ReactivityInteractionPort | null) => { if (latest.current.key === key) latest.current.props.onInteractionReady?.(port); }, [key]);
  const accepted = useCallback((requestId: string) => current?.controller.accepted(requestId), [current]);
  const order = useMemo(() => surfaceSourceAtomOrder(p.structure, p.modelDocument,
    p.wavefunctionAvailable ? p.document.wavefunction?.source.metadata?.structure : undefined) ?? [], [p.structure, p.modelDocument, p.wavefunctionAvailable, p.document.wavefunction?.source.metadata]);
  return <ReactivityAnalysisControls key={lifetime} analysisId={p.analysisId} context={p.context} structure={p.structure} sourceAtomOrder={order}
    active={p.active} available={p.available} wavefunctionAvailable={p.wavefunctionAvailable} bridge={current?.controller.bridge ?? {}}
    sessionInfo={current?.opened.info} metadata={current?.opened.metadata} orbitalSessionId={current?.opened.orbitalSessionId}
    orbitalBridge={desktop as OrbitalBridge | null} progress={pool?.progress(p.context)} onProjection={publish} onInteractionReady={interaction}
    onResultAccepted={accepted} onExportImage={p.onExportImage} onError={p.onError}/>;
}
