import {useCallback, useMemo, useRef} from 'react';
import type {PesPathRecord, PesRun} from '../../modeling/pes/contracts';
import {pesPathRecordVersion} from '../../modeling/pes/path-records';
import type {ResultFrameSummary} from '../../results/contracts';
import type {TrajectoryPlotResult} from '../../results/optimization-plot-axis';
import {ProjectUiScope,projectUiSourceIdentity,type useProjectUiScope} from '../../projects/ui-state';
import {OptimizationPlot, type OptimizationPlotExtension} from '../results/OptimizationPlot';
import {PesSelect} from './pes-fields';
import {pesPathEnergyOverlays, pesPathRecordLabel} from './PesPathHistory';
import type {TrajectoryEnergyOverlay} from '../../results/trajectory-energy-extension';
import {ResultsMcpInlinePlotSource} from '../results/results-mcp-context';

export interface PesPathEnergyPlotProps {
  request: PesRun['request'];
  record: PesPathRecord;
  records: readonly PesPathRecord[];
  overlays: readonly string[];
  axis: 'bead' | 'arc';
  onAxisChange(axis: 'bead' | 'arc'): void;
  currentFrameId?: string;
  currentConvergence?: ResultFrameSummary['convergence'];
  projectUi?: ReturnType<typeof useProjectUiScope>;
  onView(recordId: string, frameId?: string): void;
  onDraw?(recordId: string): void;
}

/** Curves consume the retained scalar index. Selecting a point opens the
 * existing structural record through its owner and read lease. */
export function PesPathEnergyPlot(p: PesPathEnergyPlotProps) {
  const {request, records, overlays, axis, currentFrameId, onView, onDraw, onAxisChange} = p;
  const recordVersion = useMemo(() => pesPathRecordVersion(p.record), [p.record]);
  const record = useMemo(() => p.record, [recordVersion]);
  const visibleOverlays = records.filter(item => item.id !== record.id && overlays.includes(item.id));
  const retainedOverlays = useRef<{axis: typeof axis; records: readonly PesPathRecord[]; value: TrajectoryEnergyOverlay[]} | undefined>(undefined);
  const previousOverlays = retainedOverlays.current;
  if (!previousOverlays || previousOverlays.axis !== axis || previousOverlays.records.length !== visibleOverlays.length ||
      visibleOverlays.some((item, index) => {
        const previous = previousOverlays.records[index];
        return item.id !== previous.id || item.frames !== previous.frames || item.connections !== previous.connections;
      })) {
    retainedOverlays.current = {axis, records: visibleOverlays,
      value: pesPathEnergyOverlays(visibleOverlays, visibleOverlays.map(item => item.id), axis)};
  }
  const overlayProjection = retainedOverlays.current!.value;
  const result = useMemo<TrajectoryPlotResult>(() => {
    const id = `${request.id}:${record.id}`;
    const frames: ResultFrameSummary[] = record.frames.map((frame, index) => ({
      index, sourceStep: frame.step, time: null, sourceLine: 0, convergence: [], label: frame.status,
      energy: typeof frame.energyHartree === 'number' && Number.isFinite(frame.energyHartree)
        ? {value: frame.energyHartree, unit: 'hartree'} : null,
      energyQuantity: 'electronic',
      ...(typeof frame.bead === 'number' ? {sourcePathImage: frame.bead, pathImage: frame.bead} : {}),
    }));
    return {id: `${id}:stage:neb-path`, jobIndex: 0, kind: 'trajectory', role: 'neb-path', frames,
      source: {id, name: `${record.phase} · Round ${record.step}`, size: 0,
        nativeJobName: request.algorithm}};
  }, [request.id, request.algorithm, record.id, record.phase, record.step, record.frames]);
  const extension = useMemo<OptimizationPlotExtension>(() => {
    const projected = pesPathEnergyOverlays([record], [record.id], axis)[0];
    return {
      pathMethod: request.algorithm,
      frameIds: record.frames.map(frame => frame.id),
      axis: {label: axis === 'arc' ? 'Path Length (Å)' : 'Image Index',
        unit: axis === 'arc' ? 'Å' : undefined, coordinates: projected.points.map(point => point.x)},
      gaps: projected.points.flatMap((point, index) => point.breakBefore ? [{beforeIndex: index, x: point.x}] : []),
      markers: projected.points.flatMap((point, sourceIndex) => point.markerLabel ? [{sourceIndex, label: point.markerLabel}] : []),
      overlays: overlayProjection,
      onSelectOverlay: onView,
      controls: <PesSelect label="路径横轴" value={axis}
        options={{bead: '珠子序号', arc: '累计路径长度 / Å'}}
        onChange={value => onAxisChange(value as 'bead' | 'arc')}/>,
    };
  }, [request.algorithm, record.id, record.frames, record.connections, axis, overlayProjection, onView, onAxisChange]);
  const matchedIndex = currentFrameId === undefined ? -1 : record.frames.findIndex(frame => frame.id === currentFrameId);
  const currentIndex = matchedIndex < 0 ? undefined : matchedIndex;
  const selectFrame = useCallback((index: number) => {
    const frame = record.frames[index];
    if (frame) onView(record.id, frame.id);
  }, [record.id, record.frames, onView]);
  const drawn = useCallback(() => onDraw?.(record.id), [record.id, onDraw]);
  // Use the same saved figure key the trajectory stage used before curves
  // could display independently of the current structure.
  const plot = <ResultsMcpInlinePlotSource kind="pes-path-energy" collectionId={record.id} runId={request.runIdentity.runId}>
    <OptimizationPlot result={result} currentIndex={currentIndex} onSelectFrame={selectFrame}
    currentConvergence={currentIndex === undefined ? undefined : p.currentConvergence}
    onDraw={drawn} extension={extension} responsive/>
  </ResultsMcpInlinePlotSource>;
  const project = p.projectUi;
  const analysisSource = JSON.stringify([result.source.id, result.source.id, null, result.jobIndex]);
  return <div data-testid="pes-path-energy-plot" data-record-id={record.id}
    data-phase={record.phase} data-step={record.step} data-record-kind={p.record.kind}>
    <p className="postprocess-note">曲线 {pesPathRecordLabel(p.record)}
      {currentFrameId && currentIndex === undefined ? ' · 当前结构帧属于其他路径记录' : ''}</p>
    {project ? <ProjectUiScope store={project.store} scope={[...project.scope,'analysis-workspace',analysisSource,
      'TrajectoryAnalysisControls',projectUiSourceIdentity({result})]}>{plot}</ProjectUiScope> : plot}
  </div>;
}
