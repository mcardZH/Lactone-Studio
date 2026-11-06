import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Structure } from '../../core/types';
import type { SurfaceContext } from '../../results/surface-contracts';
import { calculationRangeFromGrid, estimatedCalculationRange } from '../../results/calculation-range';
import { sameSurfaceContext } from '../../results/surface-field';
import { hirshfeldClusterFromStructure, hirshfeldSelection } from '../../results/hirshfeld-presentation';
import type { AnalysisSelectionPort } from '../analysis-selection-intent';
import { ANALYSIS_PALETTES } from './analysis-display';
import { initialHirshfeldState, type HirshfeldControlsState, type HirshfeldProjection, type HirshfeldFingerprintSnapshot } from './hirshfeld-controls-contracts';
import { createHirshfeldRun, type HirshfeldCompletedSession, type HirshfeldDesktopApi } from './hirshfeld-desktop-controller';
import { surfaceScientificContextKey, surfaceSourceLifetimeKey } from './surface-context-pool';
import { createMultiwfnProgressTracker, type MultiwfnProgressSnapshot } from '../../results/multiwfn-progress';
import type { AnalysisColorbarLayout } from './analysis-colorbar-layout';
import type { ModelDocument } from '../../modeling/contracts';
import type { SurfaceMeshState } from '../modeling/render/surface-layer';
import HirshfeldAnalysisControls from './HirshfeldAnalysisControls';
import type { OrbitalResourceInfo } from '../../results/orbital-contracts';
import type { HirshfeldSessionInfo } from '../../results/hirshfeld-contracts';
import { MULTIWFN_CONFIGURATION_CHANGED } from './MultiwfnPathControl';
import { useSurfaceAppearanceDefaults } from './useSurfaceAppearanceDefaults';
import { restoreHirshfeldAppearance } from './surface-appearance-defaults';
import {useComputeResources} from '../useComputeResources';
import { analysisProjectCubeArtifacts, notifyAnalysisProjectStateChanged, rebindAnalysisContext, useAnalysisProjectSnapshot } from '../../projects/analysis-state';
import { exportBlob } from './export-image';

export interface HirshfeldAnalysisInstanceProps { analysisId: string; context: SurfaceContext; structure: Structure; active: boolean; available?: boolean;
  capturePort?: AnalysisSelectionPort; desktop?: HirshfeldDesktopApi | null; sourceError?: string;
  onProjection(value: HirshfeldProjection | null): void; onExportImage?(): void | Promise<void>; onOpenFingerprint?(snapshot: HirshfeldFingerprintSnapshot): void; onError(message: string): void;
  onColorbarLayoutReady?(setter: ((layout: AnalysisColorbarLayout) => void) | null): void;
  onMeshObserverReady?(observer: ((state: Readonly<SurfaceMeshState>, document: Pick<ModelDocument, 'id' | 'revision'>) => void) | null): void }
export function hirshfeldProjection(state: HirshfeldControlsState, context: SurfaceContext, structure?: Structure): HirshfeldProjection | null {
  const result = state.result;
  const target = structure ? { ...structure, atoms: structure.atoms.filter(atom => state.targetIds.includes(atom.id ?? '')) } : null;
  const changed = !!result && (result.quantitativeGrid.spacingBohr !== state.spacingBohr || state.targetIds.length !== result.source.targetAtomIndices.length || result.source.targetAtomIndices.some(index => !state.targetIds.includes(result.source.atoms[index - 1].stableId)));
  const actual = result && state.showRange ? calculationRangeFromGrid(result.pair.shape.grid, `${result.stamp.requestId}:actual`, 'Hirshfeld·实际计算范围') : null;
  const estimate = target && state.rangeExtensionBohr !== null && (!result || changed) ? estimatedCalculationRange(target, { mode: 'spacing', spacingBohr: state.spacingBohr }, state.rangeExtensionBohr, `${context.sourceId}:${state.spacingBohr}:${state.targetIds.join(',')}`, 'Hirshfeld·预计计算范围') : null;
  const calculationRanges = state.showRange ? [actual, estimate].filter((value): value is NonNullable<typeof value> => !!value) : [];
  if (!result) return calculationRanges.length ? { context, result: null, calculationRanges, display: state.display, surfaceLayer: null, colorbar: null, hiddenAtomIds: [], selectedContact: null } : null;
  // Rebind observation epoch only after an exact source/frame/revision key match.
  // Original native stamps remain untouched for restore and scientific export.
  if (surfaceScientificContextKey(result.stamp) !== surfaceScientificContextKey(context)) return null;
  let min = Infinity, max = -Infinity;
  for (const sample of result.vertices) { min = Math.min(min, sample.dnorm); max = Math.max(max, sample.dnorm); }
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = -.5; max = 1; }
  if (min === max) { min -= .01; max += .01; }
  const range = state.display.range ?? { min, max }, colors = state.display.colors ?? ANALYSIS_PALETTES['blue-red'];
  const pair = sameSurfaceContext(result.pair.shape.context, context) ? result.pair : { ...result.pair,
    shape: { ...result.pair.shape, context }, mapping: { ...result.pair.mapping, context } };
  return { context, result, calculationRanges, display: state.display, selectedContact: state.selectedContact,
    hiddenAtomIds: state.display.showEnvironment ? [] : result.source.environmentAtomIndices.map(index => result.source.atoms[index - 1].stableId),
    surfaceLayer: context.documentId && context.documentRevision !== undefined ? { pair, documentId: context.documentId, geometryRevision: context.documentRevision,
      visible: state.display.visible, opacity: state.display.opacity, finish: state.display.finish,
      color: { ...range, colors, zeroCentered: true, reverse: state.display.reverse }, contactFocus: { source: result.source, contact: state.selectedContact } } : null,
    colorbar: { ...range, colors, zeroCentered: true, palette: 'blue-red', decimals: 2, label: 'dnorm', reverse: state.display.reverse, layout: state.display.colorbarLayout } };
}

/** Per-source/frame scientific results and Local display state. Only the
 * explicit calculate action opens a native session or invokes science. */
export default function HirshfeldAnalysisInstance(p: HirshfeldAnalysisInstanceProps) {
  const desktop = p.desktop === undefined ? (typeof window === 'undefined' ? null : window.sciyueDesktop as HirshfeldDesktopApi | undefined) : p.desktop;
  const key = surfaceScientificContextKey(p.context), lifetime = surfaceSourceLifetimeKey(p.analysisId, p.context);
  const latest = useRef(p); latest.current = p;
  const stores = useRef(new Map<string, HirshfeldControlsState>()), completed = useRef(new Map<string, HirshfeldCompletedSession>());
  const activeRun = useRef<{ key: string; token: string; run: ReturnType<typeof createHirshfeldRun> } | null>(null);
  const [planningVersion, setPlanningVersion] = useState(0), [, render] = useState(0), [runningKey, setRunningKey] = useState<string | null>(null), [progress, setProgress] = useState<MultiwfnProgressSnapshot | null>(null);
  const [resourceDefaults, setResourceDefaults] = useState<OrbitalResourceInfo | null>(null), [resourceReadError, setResourceReadError] = useState('');
  const appearanceDefaults = useSurfaceAppearanceDefaults();
  const pendingAppearance = useRef(new Map<string, HirshfeldControlsState['display']>());
  const globalResources=useComputeResources(desktop??undefined);
  const [openInfo, setOpenInfo] = useState<{ key: string; token: string; info: HirshfeldSessionInfo } | null>(null);
  const alive = useRef(true), serial = useRef(0);
  useAnalysisProjectSnapshot(`hirshfeld:${JSON.stringify([p.context.documentId,lifetime])}`, () => new Map([...stores.current].map(([id, value]) => [id, { ...value, error: '', grantPresentation: 'previous' as const }])), saved => {
    stores.current = rebindAnalysisContext(saved, latest.current.context);
    render(value => value + 1);
  }, message => latest.current.onError(message),()=>stores.current);
  const progressRun = useRef<ReturnType<typeof createMultiwfnProgressTracker> | null>(null);
  const currentProgress = () => progressRun.current;
  let state = stores.current.get(key); if (!state) { state = initialHirshfeldState(); const saved = appearanceDefaults.snapshot?.value['surface:hirshfeld']; if (appearanceDefaults.ready && saved && 'colors' in saved) state.display = restoreHirshfeldAppearance(state.display, saved); else if (!appearanceDefaults.ready) pendingAppearance.current.set(key, state.display); stores.current.set(key, state); }
  const current = state;
  useEffect(() => { if (!appearanceDefaults.ready) return; const saved = appearanceDefaults.snapshot?.value['surface:hirshfeld']; let changed = false; for (const [id, baseline] of pendingAppearance.current) { const value = stores.current.get(id); if (value?.display === baseline && saved && 'colors' in saved) { stores.current.set(id, { ...value, display: restoreHirshfeldAppearance(value.display, saved) }); changed = true; } } pendingAppearance.current.clear(); if (changed) render(value => value + 1); }, [appearanceDefaults.ready, appearanceDefaults.snapshot]);
  useEffect(() => {
    let active = true, query = 0;
    const refresh = () => { const own = ++query;if(globalResources.loading||globalResources.error||!globalResources.snapshot){setResourceDefaults(null);setResourceReadError(globalResources.error||'正在读取全局计算资源。');return;} if (!desktop?.orbitalResourceInfo) { setResourceDefaults(null); setResourceReadError('当前环境不能读取本机资源配置。'); return; }
      void desktop.orbitalResourceInfo().then(info => { if (!active || own !== query) return;
        if (![info.threads, info.logicalCpuCount, info.memoryBudgetBytes, info.totalPhysicalMemoryBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('本机资源配置回执无效。');
        if(info.computeResourceVersion!==globalResources.snapshot!.revision)throw new Error('计算资源配置已变化，请等待当前配置回执。');
        setResourceDefaults(info); setResourceReadError('');
      }).catch(error => { if (active && own === query) { setResourceDefaults(null); setResourceReadError(error instanceof Error ? error.message : String(error)); } }); };
    refresh(); if (typeof window !== 'undefined') window.addEventListener(MULTIWFN_CONFIGURATION_CHANGED, refresh);
    return () => { active = false; query++; if (typeof window !== 'undefined') window.removeEventListener(MULTIWFN_CONFIGURATION_CHANGED, refresh); };
  }, [desktop,globalResources.loading,globalResources.error,globalResources.snapshot?.revision]);
  const change = useCallback((patch: Partial<HirshfeldControlsState>) => { const old = stores.current.get(key) ?? initialHirshfeldState(); stores.current.set(key, { ...old, ...patch,
    ...(old.result && (patch.resourceDraft || patch.targetIds || patch.spacingBohr !== undefined || patch.mode !== undefined) ? { grantPresentation: 'previous' as const } : {}) }); render(value => value + 1); }, [key]);
  const setColorbarLayout = useCallback((colorbarLayout: AnalysisColorbarLayout) => { const old = stores.current.get(key); if (old) change({ display: { ...old.display, colorbarLayout } }); }, [key, change]);
  useEffect(() => { latest.current.onColorbarLayoutReady?.(setColorbarLayout); return () => latest.current.onColorbarLayoutReady?.(null); }, [setColorbarLayout]);
  const admission = useMemo(() => { try { return { cluster: hirshfeldClusterFromStructure(p.structure, p.context), error: p.sourceError ?? '' }; }
    catch (error) { return { cluster: null, error: error instanceof Error ? error.message : String(error) }; } }, [p.structure, key, p.sourceError]);
  useEffect(() => {
    if (!current.showRange || current.rangeExtensionBohr !== null || !desktop?.openHirshfeldSession || !desktop.closeSurfaceSession || !admission.cluster || !p.active || runningKey === key || !resourceDefaults) return;
    let valid = true; const sessionId = `${p.analysisId}:hs-plan-${Date.now()}-${++serial.current}`;
    void desktop.openHirshfeldSession({ sessionId, source: { kind: 'hirshfeld-cluster', context: { ...p.context }, cluster: admission.cluster } }).then(info => {
      if (valid && alive.current && surfaceScientificContextKey(latest.current.context) === key) {
        if (!info.planning || !Number.isFinite(info.planning.extensionBohr) || info.planning.extensionBohr <= 0) throw new Error('当前后端未返回计算范围规划。');
        change({ rangeExtensionBohr: info.planning.extensionBohr, rangeError: '' });
      }
    }).catch(error => { if (valid && alive.current) change({ rangeError: error instanceof Error ? error.message : String(error) }); })
      .finally(() => { void desktop.closeSurfaceSession!(sessionId).catch(error => latest.current.onError(String(error))); });
    return () => { valid = false; };
  }, [current.showRange, current.rangeExtensionBohr, key, p.active, runningKey, resourceDefaults, admission.cluster, desktop, planningVersion]);
  useEffect(() => { const clearPlanning = () => { for (const [id, value] of stores.current) stores.current.set(id, { ...value, rangeExtensionBohr: null, rangeError: '' }); setPlanningVersion(value => value + 1); }; window.addEventListener(MULTIWFN_CONFIGURATION_CHANGED, clearPlanning); return () => window.removeEventListener(MULTIWFN_CONFIGURATION_CHANGED, clearPlanning); }, []);
  const stop = useCallback(() => { const owned = activeRun.current; if (!owned) return; activeRun.current = null;
    setRunningKey(null); setOpenInfo(null); const tracker = progressRun.current; tracker?.stopping(); void owned.run.cancel().then(() => { if (progressRun.current === tracker) tracker?.stopped('native-settled'); }).catch(error => latest.current.onError(String(error instanceof Error ? error.message : error))); }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    return () => { const run = activeRun.current; activeRun.current = null; void run?.run.cancel().catch(error => latest.current.onError(String(error)));
      for (const entry of completed.current.values()) void entry.close().catch(error => latest.current.onError(String(error)));
      completed.current.clear(); stores.current.clear(); pendingAppearance.current.clear(); };
  }, [lifetime, desktop]);
  useEffect(() => {
    if (!p.active || p.available === false || activeRun.current && activeRun.current.key !== key) stop();
    let changed = false; for (const [entryKey, value] of stores.current) if ((entryKey !== key || !p.active || p.available === false) && value.result && value.grantPresentation !== 'previous') {
      stores.current.set(entryKey, { ...value, grantPresentation: 'previous' }); changed = true;
    } if (changed) render(value => value + 1);
  }, [key, p.active, p.available, stop]);
  useEffect(() => desktop?.onMultiwfnProgress?.(snapshot => { const run = activeRun.current;
    if (run && snapshot.identity.sessionId === run.run.sessionId && snapshot.identity.analysisId === p.analysisId
      && snapshot.identity.runId === run.token) { if (progressRun.current?.identity.runId !== run.token) progressRun.current = createMultiwfnProgressTracker(snapshot.identity, value => { if (alive.current) setProgress(value); });
      progressRun.current.receive(snapshot); } }), [desktop, p.analysisId]);
  const meshObserver = useCallback((mesh: Readonly<SurfaceMeshState>, actual: Pick<ModelDocument, 'id' | 'revision'>) => {
    const result = stores.current.get(key)?.result, tracker = progressRun.current;
    if (!result || !tracker || tracker.identity.runId !== result.stamp.requestId || mesh.shapeId !== result.pair.shape.id || mesh.mappingId !== result.pair.mapping.id
      || actual.id !== latest.current.context.documentId || actual.revision !== latest.current.context.documentRevision) return;
    if (mesh.status === 'failed') tracker.failed('native-settled', mesh.error);
    else if (mesh.status === 'committed' && mesh.submitted && mesh.committedKey === mesh.attemptKey && mesh.vertexCount > 0 && mesh.triangleCount > 0) tracker.renderCommitted();
  }, [key]);
  useEffect(() => { latest.current.onMeshObserverReady?.(meshObserver); return () => latest.current.onMeshObserverReady?.(null); }, [meshObserver]);
  useEffect(() => { latest.current.onProjection(p.active && p.available !== false ? hirshfeldProjection(current, p.context, p.structure) : null); }, [current, p.active, p.available, key, p.context.activationEpoch, p.structure]);
  const calculate = async () => {
    if (!desktop || !admission.cluster || admission.error || resourceReadError || !resourceDefaults || !p.active || p.available === false || activeRun.current) return;
    const token = `hs-${Date.now()}-${++serial.current}`, context = { ...p.context }, sessionId = `${p.analysisId}:${token}`;
    try {
      const selection = hirshfeldSelection(admission.cluster, current.targetIds), request = { stamp: { ...context, analysisId: p.analysisId, requestId: token },
        ...selection, mode: current.mode, quantitativeGrid: { mode: 'spacing' as const, spacingBohr: current.spacingBohr }, mapping: 'dnorm' as const };
      const run = createHirshfeldRun(desktop, admission.cluster, context, p.analysisId, sessionId, request, {
        onSessionInfo: info => { if (alive.current && activeRun.current?.token === token && sameSurfaceContext(latest.current.context, context)) { setOpenInfo({ key, token, info }); if (info.planning) change({ rangeExtensionBohr: info.planning.extensionBohr }); } } }), owned = { key, token, run };
      activeRun.current = owned; setRunningKey(key); setOpenInfo(null); progressRun.current = null; setProgress(null); change({ error: '', grantPresentation: 'previous' });
      const accepted = await run.run();
      if (!alive.current || activeRun.current !== owned || !sameSurfaceContext(latest.current.context, context)) { await accepted.close(); return; }
      const previous = completed.current.get(key); completed.current.set(key, accepted);
      stores.current.set(key, { ...(stores.current.get(key) ?? current), result: accepted.result, selectedContact: null, error: '', grantPresentation: 'current' });
      notifyAnalysisProjectStateChanged();
      currentProgress()?.committed({ required: latest.current.active && latest.current.available !== false && (stores.current.get(key)?.display.visible ?? true) });
      activeRun.current = null; setRunningKey(null); setOpenInfo(null); render(value => value + 1);
      if (previous) void previous.close().catch(error => latest.current.onError(String(error)));
    } catch (error) {
      if (activeRun.current?.token === token) { activeRun.current = null; setRunningKey(null); setOpenInfo(null); progressRun.current?.failed('native-settled', error instanceof Error ? error.message : String(error));
        const message = error instanceof Error ? error.message : String(error); change({ error: message }); }
    }
  };
  const exportCube = (role: 'shape' | 'mapping') => { const owner = completed.current.get(key); if (!owner) {
    const field = stores.current.get(key)?.result?.pair[role]; if (!field) { p.onError('当前Hirshfeld格点不可用。'); return; }
    try { const saved = analysisProjectCubeArtifacts(field, `Hirshfeld ${role}`); exportBlob(new Blob([saved.cube], { type: 'text/plain;charset=utf-8' }), `hirshfeld-${role}.cube`); exportBlob(new Blob([saved.metadata], { type: 'application/json' }), `hirshfeld-${role}.metadata.json`); } catch (error) { p.onError(error instanceof Error ? error.message : String(error)); }
    return;
  }
    void owner.exportField(role).catch(error => latest.current.onError(String(error instanceof Error ? error.message : error))); };
  return <HirshfeldAnalysisControls structure={p.structure} context={p.context} state={current} disabled={!p.active || p.available === false || !desktop}
    running={runningKey === key} sourceError={admission.error} capturePort={p.capturePort} progress={progress?.identity.sourceFrameIndex === p.context.sourceFrameIndex ? progress : null}
    resourceDefaults={resourceDefaults} resourceError={resourceReadError} sessionInfo={runningKey === key ? openInfo?.key === key ? openInfo.info : null : current.result?.sessionInfo ?? null}
    onChange={change} onCalculate={() => { void calculate(); }} onStop={stop} onExportCube={exportCube} onExportImage={p.onExportImage} onOpenFingerprint={p.onOpenFingerprint}/>;
}
