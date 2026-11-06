import { useEffect, useRef, useState } from 'react';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,useProjectUiRestored,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import {useAnalysisProjectSnapshot,loadAnalysisProjectSnapshot} from '../../projects/analysis-state';
import type { Structure } from '../../core/types';
import { inputSelectionIndices } from '../../core/input-selection';
import { confirmCoordinateSelection } from '../../modeling/application/coordinate-selection';
import type { TrajectoryResult } from '../../results/contracts';
import { trajectoryPlotAxis, trajectoryPlotKind } from '../../results/optimization-plot-axis';
import { traceInternalCoordinate, type CoordinateTrace } from '../../results/scientific-analysis';
import InteractiveSelectionField, { SelectionAddButton, SelectionRemoveButton } from '../InteractiveSelectionField';
import { assertAnalysisSelectionPort, type AnalysisSelectionPort } from '../analysis-selection-intent';
import CoordinatePlot from './CoordinatePlot';
import { OptimizationPlot } from './OptimizationPlot';
import { AnalysisTaskLayout, AnalysisTaskSection } from './AnalysisTaskLayout';
import './TrajectoryAnalysisControls.css';

export interface TrajectoryAnalysisControlsProps {
  result: TrajectoryResult; currentIndex: number; structure: Structure | null; active: boolean;
  capturePort?: AnalysisSelectionPort;
  onSeek(index: number): void; onPause(): void; onError(message: string): void;
}
interface TraceEntry { id: string; trace: CoordinateTrace }
const traceId = (trace: Pick<CoordinateTrace, 'kind' | 'atomIndices'>) => `${trace.kind}:${trace.atomIndices.join(',')}`;
const traceLabel = (trace: CoordinateTrace) => `${{ B: '键长', A: '键角', D: '二面角' }[trace.kind]} (${trace.atomIndices.map(index => index + 1).join(', ')}) / ${trace.unit === 'angstrom' ? 'Å' : '°'}`;

/** A single explicit 1D source definition is enough; method names and filenames are never definitions. */
export function trajectoryScanDefinition(result: TrajectoryResult): { kind: CoordinateTrace['kind']; atomIndices: number[] } | null {
  if (trajectoryPlotKind(result) !== 'scan' || result.scientific?.scanCoordinates?.length !== 1) return null;
  const definition = result.scientific.scanCoordinates[0], kind = ({ bond: 'B', angle: 'A', dihedral: 'D' } as const)[definition.kind];
  const count = kind === 'B' ? 2 : kind === 'A' ? 3 : 4;
  if (definition.atomIndices.length !== count || new Set(definition.atomIndices).size !== count || definition.atomIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= result.initialStructure.atoms.length)
    || definition.unit !== (kind === 'B' ? 'angstrom' : 'degree')) return null;
  return { kind, atomIndices: [...definition.atomIndices] };
}

/** Shared ordered-selection validation followed only by source geometry reads; no store or QM operation. */
export async function traceTrajectorySelection(result: TrajectoryResult, structure: Structure, atomIds: readonly string[], signal?: AbortSignal, isCurrent: () => boolean = () => true): Promise<CoordinateTrace | null> {
  if (!isCurrent() || signal?.aborted) return null;
  const selection = confirmCoordinateSelection(structure, atomIds);
  const indices = inputSelectionIndices(result.initialStructure, atomIds);
  if (indices.some((index, i) => result.initialStructure.atoms[index].element !== structure.atoms[selection.atoms[i] - 1]?.element)) throw new Error('分析原子与来源结构不对应。');
  const trace = await traceInternalCoordinate(result, selection.type, indices, signal);
  return isCurrent() && !signal?.aborted ? trace : null;
}

function TrajectoryAnalysisControlsInner(p: TrajectoryAnalysisControlsProps) {
  const snapshotKey=`controls:coordinate-traces:${projectUiSourceIdentity(p)}`;
  const [restoring,setRestoring]=useState(useProjectUiRestored());
  const [traceOwner, setTraceOwner] = useState(p.result);
  const [editor, setEditor] = useState(false);
  const [entries, setEntries] = useState<TraceEntry[]>([]), [scanX, setScanX] = useState('source');
  const [defaultTrace, setDefaultTrace] = useState<CoordinateTrace | null>(null), [tracing, setTracing] = useState(false);
  const mounted = useRef(true), traceController = useRef<AbortController | null>(null), defaultController = useRef<AbortController | null>(null);
  const latest = useRef(p); latest.current = p;
  const source = useRef(p.result); if (source.current !== p.result) { traceController.current?.abort(); defaultController.current?.abort(); source.current = p.result; }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; traceController.current?.abort(); defaultController.current?.abort(); }; }, []);
  useEffect(() => { setTraceOwner(p.result); setEntries([]); setScanX('source'); setDefaultTrace(null); setEditor(false); setTracing(false); }, [p.result]);
  useEffect(() => { if (!p.active) { traceController.current?.abort(); defaultController.current?.abort(); setEditor(false); setTracing(false); } }, [p.active]);
  useAnalysisProjectSnapshot(snapshotKey,()=>({entries,scanX,defaultTrace,editor}),saved=>{setEntries(saved.entries);setScanX(saved.scanX);setDefaultTrace(saved.defaultTrace);setEditor(saved.editor);setTraceOwner(p.result);setTracing(false);},p.onError,()=>null);
  useEffect(()=>{if(restoring)void loadAnalysisProjectSnapshot(snapshotKey).then(()=>setRestoring(false),()=>setRestoring(false));},[snapshotKey,restoring]);
  useEffect(() => {
    if (restoring || !p.active || traceOwner === p.result && defaultTrace || trajectoryPlotAxis(p.result, p.result.frames).physical) return;
    const definition = trajectoryScanDefinition(p.result); if (!definition) return;
    const result = p.result, controller = new AbortController(); defaultController.current = controller;
    void traceInternalCoordinate(result, definition.kind, definition.atomIndices, controller.signal).then(trace => {
      if (mounted.current && latest.current.result === result && latest.current.active && !controller.signal.aborted) setDefaultTrace(trace);
    }).catch(error => { if (!controller.signal.aborted && mounted.current && latest.current.result === result && latest.current.active) latest.current.onError(error instanceof Error ? error.message : '扫描坐标读取失败。'); });
    return () => { controller.abort(); if (defaultController.current === controller) defaultController.current = null; };
  }, [p.result, p.active, defaultTrace, traceOwner,restoring]);
  const visibleEntries = traceOwner === p.result ? entries : [];
  const scan = trajectoryPlotKind(p.result) === 'scan';
  const override = scan && traceOwner === p.result ? scanX === 'source' ? defaultTrace : visibleEntries.find(entry => entry.id === scanX)?.trace ?? null : null;
  const seek = (index: number) => { if (!latest.current.active) return; latest.current.onPause(); latest.current.onSeek(index); };
  const sourceCurrent = (result: TrajectoryResult) => mounted.current && latest.current.result === result && latest.current.active;
  const confirm = (ids: string[], assertCurrent: () => void, replaceId?: string) => {
    assertCurrent(); const current = latest.current; if (!current.structure || !sourceCurrent(current.result)) throw new Error('分析来源已变化，请重新选择。');
    const selection = confirmCoordinateSelection(current.structure, ids), indices = inputSelectionIndices(current.result.initialStructure, ids);
    const id = traceId({ kind: selection.type, atomIndices: indices });
    current.onPause();
    // Confirmation replaces only this statistic; duplicate targets retain one entry.
    const commit = (trace: CoordinateTrace) => { setEntries(values => {
      const position = replaceId ? values.findIndex(entry => entry.id === replaceId) : values.length;
      const remaining = values.filter(entry => entry.id !== id && entry.id !== replaceId);
      remaining.splice(Math.min(Math.max(position, 0), remaining.length), 0, { id, trace }); return remaining;
    }); if (replaceId && scanX === replaceId) setScanX(id); setEditor(false); };
    const existing = entries.find(entry => entry.id === id);
    if (existing) { commit(existing.trace); return; }
    if (traceOwner === current.result && defaultTrace && traceId(defaultTrace) === id) { commit(defaultTrace); return; }
    const result = current.result, structure = current.structure, controller = new AbortController(); traceController.current?.abort(); traceController.current = controller; setTracing(true);
    void traceTrajectorySelection(result, structure, ids, controller.signal, () => sourceCurrent(result)).then(trace => {
      if (!trace || traceController.current !== controller) return;
      commit(trace);
    }).catch(error => { if (!controller.signal.aborted && sourceCurrent(result)) latest.current.onError(error instanceof Error ? error.message : '内坐标统计失败。'); })
      .finally(() => { if (traceController.current === controller) { traceController.current = null; if (mounted.current) setTracing(false); } });
  };
  const remove = (id?: string) => { if (!id) { traceController.current?.abort(); setTracing(false); setEditor(false); return; } setEntries(values => values.filter(entry => entry.id !== id)); if (scanX === id) setScanX('source'); };
  const selectionField = (entry?: TraceEntry) => {
    const label = entry ? `内坐标${visibleEntries.indexOf(entry) + 1}` : `内坐标${visibleEntries.length + 1}`;
    const atomIds = entry?.trace.atomIndices.map(index => p.result.initialStructure.atoms[index].id!) ?? [];
    const base = { structure: p.structure, label, rowId: `trajectory-coordinate:${entry?.id ?? 'new'}`, kind: 'coordinate' as const, atomIds, wrapActions:true, disabled: !p.active || tracing,
      onConfirm: (ids: string[], guard: () => void) => confirm(ids, guard, entry?.id) };
    return p.capturePort ? <InteractiveSelectionField {...base} captureOwner={p.capturePort.owner} contextKey={p.capturePort.contextKey} analysisPurpose="advanced-coordinate"
      onRequestAnalysisSelection={intent => { assertAnalysisSelectionPort(p.capturePort!); p.onPause(); return p.capturePort!.requestSelection(intent); }}/>
      : <InteractiveSelectionField {...base} engine={p.result.engine === 'orca' ? 'orca' : 'gaussian'} purpose="coordinate" taskId={`analysis:${p.result.id}`} contextKey={p.result.id}/>;
  };
  return <div className="trajectory-analysis-controls" data-testid="trajectory-analysis-controls">
    <OptimizationPlot result={p.result} currentIndex={p.currentIndex} onSelectFrame={seek} coordinateTrace={override} responsive/>
    <AnalysisTaskLayout variant="card" title="内坐标变化" className="trajectory-coordinate-task"
      headerActions={<SelectionAddButton label="添加内坐标" disabled={!p.active || !p.structure || tracing || editor} onClick={() => { p.onPause(); setEditor(true); }}/>}
      progress={tracing ? <div className="trajectory-read-progress"><span role="status">读取来源结构…</span><button type="button" onClick={() => { traceController.current?.abort(); setTracing(false); }}>取消统计</button></div> : null}
      setup={scan && visibleEntries.length > 0 ? <label>扫描横轴 <select aria-label="扫描横轴" value={scanX} onChange={event => setScanX(event.target.value)}><option value="source">{defaultTrace || trajectoryPlotAxis(p.result, p.result.frames).physical ? '来源扫描坐标' : '扫描点序号'}</option>{visibleEntries.map(entry => <option key={entry.id} value={entry.id}>{traceLabel(entry.trace)}</option>)}</select></label> : undefined}>
    {visibleEntries.map((entry, index) => <AnalysisTaskSection key={entry.id} title={`内坐标${index + 1} · ${{B:'键长',A:'键角',D:'二面角'}[entry.trace.kind]}`} controls={<SelectionRemoveButton label={`删除内坐标${index + 1}`} disabled={tracing} onClick={() => remove(entry.id)}/>}>
      {selectionField(entry)}
      <output className="trajectory-coordinate-current">当前值 {entry.trace.points.find(point => point.frameIndex === p.currentIndex)?.value?.toFixed(3) ?? '未输出'} {entry.trace.unit === 'angstrom' ? 'Å' : '°'}</output>
      <CoordinatePlot appearanceKey={`${p.result.id}:coordinate:${entry.id}`} trace={entry.trace} currentIndex={p.currentIndex} onSelectFrame={seek}/>
    </AnalysisTaskSection>)}
    {editor && p.active && traceOwner === p.result && <AnalysisTaskSection title={`内坐标${visibleEntries.length + 1}`} testId="trajectory-coordinate-editor" controls={<SelectionRemoveButton label="删除未确认内坐标" onClick={() => remove()}/>}>
      {selectionField()}
    </AnalysisTaskSection>}
    {!visibleEntries.length && !editor && <p className="trajectory-empty">添加内坐标后统计键长、键角或二面角随帧的变化。</p>}
    </AnalysisTaskLayout>
  </div>;
}

export default function TrajectoryAnalysisControls(p:TrajectoryAnalysisControlsProps){const project=useProjectUiScope();return project?<ProjectUiScope scope={['TrajectoryAnalysisControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><TrajectoryAnalysisControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:TrajectoryAnalysisControlsInner(p);}
