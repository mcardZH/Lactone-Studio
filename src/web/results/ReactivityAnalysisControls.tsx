import {DismissibleNotice} from '../DismissibleNotice';
import { useEffect, useMemo, useRef, useState } from 'react';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity} from '../../projects/ui-state';
import {useAnalysisProjectSnapshot,rebindAnalysisContext} from '../../projects/analysis-state';
import type { ReactivityAnalysisResult } from '../../results/reactivity-contracts';
import { sameSurfaceStamp } from '../../results/surface-field';
import { analysisRange, activeAnalysisRows, toggleAnalysisRow } from './analysis-display';
import { InputSettingsLayout, InputSettingsCheckbox } from '../InputSettingsLayout';
import { ScientificDataTable } from './ScientificDataTable';
import MultiwfnProgress from './MultiwfnProgress';
import { OrbitalDrawOptions, OrbitalCalculationQuality, OrbitalSpatialGridSummary, orbitalQualitySpacing, type OrbitalQuality } from './OrbitalControls';
import { DEFAULT_ORBITAL_LAYER, type OrbitalLayerSettings } from './orbital-display';
import { DEFAULT_ORBITAL_SAMPLING, orbitalGridFor, useOrbitalField } from './useOrbitalField';
import { AnalysisTaskLayout, AnalysisTaskSection } from './AnalysisTaskLayout';
import AnalysisColorbarLayoutControls from './AnalysisColorbarLayoutControls';
import type {AnalysisColorbarLayout} from './analysis-colorbar-layout';
import {normalizeAnalysisColorbarLayout} from './analysis-colorbar-layout';
import { exportBlob } from './export-image';
import { reactivityAtomDisplay, reactivityAtomTable, reactivityContextKey, reactivityFrontierRows, reactivityGlobalTable, reactivityNativeOrbitalKey, reactivityText, REACTIVITY_ATOM_ALL, REACTIVITY_ATOM_LABELS, REACTIVITY_GLOBAL_ALL, REACTIVITY_GLOBAL_LABELS, reactivityMetricUnit } from './reactivity-presentation';
import type { ReactivityAnalysisControlsProps, ReactivityAtomMetric } from './reactivity-controls-contracts';

interface CardState {
  result: ReactivityAnalysisResult | null; decimals: number; globalDecimals: number; metric: ReactivityAtomMetric; color: boolean;
  pinned: string[]; hover: string | null; current: string | null; globalExpanded: boolean; atomExpanded: boolean;
  selected: string | null; layer: OrbitalLayerSettings; quality: OrbitalQuality; spacing: number; appliedSpacing: number; colorbarLayout?:AnalysisColorbarLayout;
  busy: boolean; stopping: boolean; error: string; request: { id: string; abort: AbortController; cancel(): void | Promise<void> } | null;
}
const fresh = (): CardState => ({ result: null, decimals: 2, globalDecimals: 2, metric: 'dual', color: false, pinned: [], hover: null, current: null, globalExpanded: false, atomExpanded: false,
  selected: null, layer: { ...DEFAULT_ORBITAL_LAYER }, quality: 'normal', spacing:.15, appliedSpacing:.15, busy: false, stopping: false, error: '', request: null });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function ReactivityAnalysisControlsInner(p: ReactivityAnalysisControlsProps) {
  const key = `${p.analysisId}:${reactivityContextKey(p.context)}`;
  const cache = useRef(new Map<string, CardState>());
  if (!cache.current.has(key)) cache.current.set(key, fresh());
  const card = cache.current.get(key)!;
  const [, render] = useState(0), latest = useRef(p), liveKey = useRef(key), mounted = useRef(true);
  latest.current = p; liveKey.current = key;
  const refresh = () => { if (mounted.current) render(value => value + 1); };
  useAnalysisProjectSnapshot(`controls:reactivity:${p.analysisId}:${projectUiSourceIdentity(p)}`,
    () => new Map([...cache.current].map(([key,state]) => [key,{...state,busy:false,stopping:false,request:null,hover:null}])),
    saved => { cache.current = rebindAnalysisContext(saved,p.context); refresh(); },undefined,()=>cache.current);
  const update = (patch: Partial<CardState>) => { Object.assign(card, patch); refresh(); };
  const cancel = (request: NonNullable<CardState['request']>) => { request.abort.abort(); void Promise.resolve().then(() => request.cancel()).catch(error => latest.current.onError?.(message(error))); };
  const [intent, setIntent] = useState<{ key: string; token: object } | null>(null);
  const frontier = reactivityFrontierRows(card.result?.frontier ?? p.sessionInfo?.frontier ?? []);
  const selected = frontier.find(row => row.orbital.key === card.selected)?.orbital;
  const selectedNativeKey = reactivityNativeOrbitalKey(selected, p.metadata);
  const permitted = p.active && p.available !== false && p.wavefunctionAvailable;
  const canDraw = permitted && p.sessionInfo?.capabilities.orbitalDisplay !== false && !!p.metadata && !!p.orbitalSessionId && !!p.orbitalBridge;
  const spacing = orbitalQualitySpacing(card.quality,card.spacing);
  const resources = p.sessionInfo?.resources;
  const sampling = useMemo(() => ({ ...DEFAULT_ORBITAL_SAMPLING, spacingAngstrom: card.appliedSpacing,
    ...(resources ? { threads: resources.threads, memoryBudgetBytes: resources.memoryBudgetBytes } : {}) }), [card.appliedSpacing, resources?.threads, resources?.memoryBudgetBytes]);
  const qualityPending = !!selected && spacing !== card.appliedSpacing;
  const gridPreview = useMemo(() => {
    if (!p.metadata) return { grid: null, error: '' };
    try { return { grid: orbitalGridFor(p.metadata, { ...sampling, spacingAngstrom: spacing }), error: '' }; }
    catch (error) { return { grid: null, error: message(error) }; }
  }, [p.metadata, sampling, spacing]);
  const gridError = gridPreview.error;
  const orbital = useOrbitalField({ bridge: p.orbitalBridge ?? null, metadata: canDraw ? p.metadata ?? null : null,
    sessionId: canDraw ? p.orbitalSessionId ?? null : null, selectedKey: selectedNativeKey, active: permitted,
    computeIntent: intent?.key === key ? intent.token : null, sampling,
    onError: error => { card.error = error; refresh(); latest.current.onError?.(error); } });
  const orbitalBusy = orbital.state.planning || orbital.state.progress?.status === 'queued' || orbital.state.progress?.status === 'running';
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const state of cache.current.values()) if (state.request) cancel(state.request);
      cache.current.clear();
    };
  }, []);
  useEffect(() => {
    // A pending intent is one user action, not permission to compute on a later frame.
    setIntent(null);
    for (const [otherKey, state] of cache.current) if (otherKey !== key || !permitted) {
      state.hover = null;
      const request = state.request;
      if (request) { state.request = null; state.busy = false; state.stopping = false; cancel(request); }
    }
  }, [key, permitted]);
  const scalarValues = useMemo(() => reactivityAtomDisplay(card.result, card.metric, p.sourceAtomOrder, p.structure, card.decimals), [card.result, card.metric, p.sourceAtomOrder, p.structure, card.decimals]);
  const shown = activeAnalysisRows([...new Set([...card.pinned, ...(card.current ? [card.current] : [])])], card.hover);
  const highlights = scalarValues.filter(row => {
    const source = p.sourceAtomOrder.find(item => item.atomId === row.atomId)?.sourceIndex;
    return source !== undefined && shown.includes(`atom:${source}`);
  });
  const range = analysisRange(scalarValues.map(row => row.value), { color: true, labels: false, spin: false }, card.metric === 'dual');
  const projectionSignature = JSON.stringify([key, card.decimals, card.metric, card.color, card.pinned, card.hover, card.current, card.layer, card.colorbarLayout, scalarValues]);
  useEffect(() => {
    latest.current.onProjection(!permitted ? null : { context: latest.current.context, result: card.result, decimals: card.decimals, metric: card.metric,
      scalarValues, color: card.color, highlights, colorbar: card.color && range ? { ...range, palette: 'blue-red', decimals: card.decimals,layout:card.colorbarLayout,
        label: `${REACTIVITY_ATOM_LABELS[card.metric]}${reactivityMetricUnit(card.metric) ? ` / ${reactivityMetricUnit(card.metric)}` : ''}` } : null,
      orbitalField: orbital.field, orbitalSettings: card.layer });
  }, [projectionSignature, card.result, permitted, orbital.field, p.context.activationEpoch]);
  useEffect(() => {
    const port = { hover(value: string | null) { if (liveKey.current === key) update({ hover: value }); },
      toggle(value: string) { if (liveKey.current === key) update({ pinned: toggleAnalysisRow(card.pinned, value) }); },
      setColorbarLayout(value:AnalysisColorbarLayout){if(liveKey.current===key)update({colorbarLayout:normalizeAnalysisColorbarLayout(value)});} };
    latest.current.onInteractionReady?.(port);
    return () => latest.current.onInteractionReady?.(null);
  }, [key, p.onInteractionReady]);
  useEffect(() => () => latest.current.onProjection(null), []);
  async function calculate() {
    const analyze = p.bridge.analyze;
    if (!permitted || !analyze || card.busy || orbitalBusy) return;
    const id = crypto.randomUUID(), abort = new AbortController(), context = { ...p.context }, bridge = p.bridge;
    update({ busy: true, stopping: false, error: '', request: { id, abort, cancel: () => bridge.cancel?.(id) } });
    try {
      const result = await analyze({ stamp: { ...context, analysisId: p.analysisId, requestId: id } }, abort.signal);
      if (abort.signal.aborted || !mounted.current || card.request?.id !== id) return;
      if (!sameSurfaceStamp(result.stamp, { ...context, analysisId: p.analysisId, requestId: id })) throw Error('反应性结果与当前分析、来源或帧不一致。');
      card.result = result; latest.current.onResultAccepted?.(id);
    } catch (error) {
      if (!abort.signal.aborted && mounted.current && card.request?.id === id) { card.error = message(error); latest.current.onError?.(card.error); }
    } finally { if (card.request?.id === id) { card.busy = false; card.stopping = false; card.request = null; refresh(); } }
  }
  function stop() { const request = card.request; if (request) { update({ stopping: true }); cancel(request); } }
  const unavailable = !p.wavefunctionAvailable || p.available === false;
  const reasons = card.result ? REACTIVITY_GLOBAL_ALL.flatMap(metric => card.result!.globalMetrics[metric]?.value == null && card.result!.globalMetrics[metric]?.reason ? [`${REACTIVITY_GLOBAL_LABELS[metric]}：${card.result!.globalMetrics[metric].reason}`] : []) : [];
  const notices = [...new Set([...(card.result?.notices ?? p.sessionInfo?.notices ?? []), ...(card.result?.capabilities.reasons ?? p.sessionInfo?.capabilities.reasons ?? [])])];
  return <InputSettingsLayout><section className="orbital-controls" data-testid="reactivity-controls" aria-label="FMO 反应性">
    <AnalysisTaskLayout variant="card" title="FMO 反应性" setup={<span>冻结轨道近似 · Hirshfeld 分区</span>} actions={<>
      <button type="button" className="button button-primary" disabled={!permitted || !p.bridge.analyze || card.busy || orbitalBusy} onClick={() => void calculate()}>{card.result ? '重新计算反应性' : '计算反应性'}</button>
      {card.result && <button type="button" onClick={() => card.result && exportBlob(new Blob([reactivityText(card.result, card.decimals, card.globalDecimals)], { type: 'text/plain;charset=utf-8' }), 'Ester-Studio-fmo-reactivity.txt')}>导出完整报告 TXT</button>}
    </>} progress={<>
      <MultiwfnProgress progress={p.progress ?? null} operationLabel="FMO 原子反应性" onStop={stop}/>
      {card.busy && !p.progress && <div className="orbital-draw-row"><span role="status">{card.stopping ? '正在等待计算停止…' : '正在计算反应性…'}</span><button type="button" disabled={card.stopping} onClick={stop}>{card.stopping ? '正在停止…' : '停止反应性计算'}</button></div>}
    </>}>
    {unavailable && <p role="status">当前帧没有匹配波函数；请补入来源或匹配波函数。</p>}
    {card.error && <DismissibleNotice role="alert">{card.error}</DismissibleNotice>}
    <AnalysisTaskSection title="全局反应性">
      {card.result ? <>
      <ScientificDataTable exportFileName="Ester-Studio-fmo-global.txt" expansion={{expanded:card.globalExpanded,onToggle:()=>update({globalExpanded:!card.globalExpanded})}} projection={reactivityGlobalTable(card.result, card.globalDecimals, card.globalExpanded)} selectionScope={`${key}:global`} layout="metrics" format={{decimals:card.globalDecimals,onDecimalsChange:globalDecimals=>update({globalDecimals}),ariaLabel:'反应性全局量'}} rowBindings={row => ({ title: card.result!.globalMetrics[row.key as keyof typeof card.result.globalMetrics]?.reason })}/>
      {!!reasons.length && <details><summary>缺失量说明</summary>{reasons.map(reason => <p key={reason}>{reason}</p>)}</details>}
      </> : <p role="status">尚未计算。</p>}
    </AnalysisTaskSection>
    <AnalysisTaskSection title="原子反应性 · Hirshfeld 分区">
      {card.result?.atoms.length ? <>
        <ScientificDataTable onClearActive={()=>update({hover:null,current:null})} exportFileName="Ester-Studio-fmo-atoms.txt" expansion={{expanded:card.atomExpanded,onToggle:()=>update({atomExpanded:!card.atomExpanded})}} projection={reactivityAtomTable(card.result, card.decimals, card.atomExpanded)} selectionScope={`${key}:atoms`} format={{decimals:card.decimals,onDecimalsChange:decimals=>update({decimals}),ariaLabel:'反应性原子量'}} onRowActivate={row=>update({current:row.key})} activeRowKey={card.current??undefined}
          rowBindings={row => ({'aria-selected':card.current===row.key,onPointerEnter:()=>update({hover:row.key}),onPointerLeave:()=>update({hover:null})})}
          rowAction={{kind:'pin',label:row=>`${card.pinned.includes(row.key)?'取消固定':'固定'} ${row.cells[0]}`,active:row=>card.pinned.includes(row.key),onActivate:row=>update({pinned:toggleAnalysisRow(card.pinned,row.key)})}}/>
        <div className="orbital-draw-row"><label>显示量 <select aria-label="反应性原子显示量" value={card.metric} onChange={event => update({ metric: event.target.value as ReactivityAtomMetric })}>{REACTIVITY_ATOM_ALL.map(metric => <option key={metric} value={metric}>{REACTIVITY_ATOM_LABELS[metric]}</option>)}</select></label><InputSettingsCheckbox label="原子着色" checked={card.color} onChange={color => update({ color })}/></div>
        {card.color&&<AnalysisColorbarLayoutControls layout={card.colorbarLayout} onChange={colorbarLayout=>update({colorbarLayout})}/>}
      </> : <p role="status">{card.result ? card.result.capabilities.reasons.join('；') || '当前来源未提供可用的原子反应性。' : '尚未计算。'}</p>}
    </AnalysisTaskSection>
    </AnalysisTaskLayout>
    {frontier.length ? <>
      <AnalysisTaskLayout variant="card" title="前线轨道" setup={<label>轨道 <select aria-label="反应性前线轨道" disabled={!canDraw || card.busy} value={card.selected ?? ''} onChange={event => {
        const next = event.target.value || null;
        update({ selected: next, appliedSpacing: !gridError ? spacing : card.appliedSpacing });
        setIntent(canDraw && !card.busy && next && !gridError ? { key, token: {} } : null);
      }}><option value="">选择前线轨道</option>{frontier.map(row => <option key={row.orbital.key} value={row.orbital.key}>{row.label}</option>)}</select></label>}
        quality={canDraw&&<><OrbitalCalculationQuality quality={card.quality} spacing={spacing} label="反应性轨道显示质量" disabled={card.busy} onChange={(quality,spacing)=>{setIntent(null);update({quality,spacing});}}/>
          {(gridPreview.grid||orbital.field?.grid) && <OrbitalSpatialGridSummary planned={gridPreview.grid} actual={orbital.field?.grid}/>}</>}
        actions={qualityPending ? <><span role="status">网格参数待应用</span><button type="button" disabled={!canDraw || !selectedNativeKey || card.busy || !!gridError} onClick={() => {
          update({ appliedSpacing: spacing }); setIntent({ key, token: {} });
        }}>应用质量</button></> : null}
        progress={<MultiwfnProgress progress={orbital.state.taskProgress ?? null} operationLabel="前线轨道格点" onStop={() => void orbital.controller?.stop().catch(error => update({ error: message(error) }))}/>}
        plotting={canDraw && orbital.field ? <OrbitalDrawOptions embedded value={card.layer} onChange={layer => update({ layer })}/> : null}>
      {card.selected && !selectedNativeKey && <p role="status">所选前线轨道缺少匹配的波函数系数。</p>}
      {!card.selected && <p role="status">选择前线轨道后显示其轨道格点。</p>}
      {gridError&&<DismissibleNotice role="alert">{gridError}</DismissibleNotice>}
      </AnalysisTaskLayout>
    </> : !unavailable && <p role="status">当前来源没有可靠的前线轨道。</p>}
    {!!notices.length && <details><summary>来源与适用范围</summary>{notices.map(notice => <p key={notice}>{notice}</p>)}</details>}
  </section></InputSettingsLayout>;
}

export default function ReactivityAnalysisControls(p: ReactivityAnalysisControlsProps) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['ReactivityAnalysisControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><ReactivityAnalysisControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:ReactivityAnalysisControlsInner(p);
}
