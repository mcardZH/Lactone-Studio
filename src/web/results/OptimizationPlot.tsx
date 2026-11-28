import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ResultFrameSummary } from '../../results/contracts';
import { buildEnergySeries, convertEnergy, defaultFrameEnergyDisplay, type EnergyReference, type EnergySeries,type EnergyUnit } from '../../results/energy';
import type {OptimizationEnergyDisplay} from '../../results/scientific-plot-editing';
import { pathNodeFrames, type CoordinateTrace } from '../../results/scientific-analysis';
import { plotSourceFrameIndex as sourceFrame, trajectoryDisplayAxis, trajectoryEnergyPlotText, trajectoryPlotKind, type TrajectoryPlotSourceAxis, type TrajectoryPlotResult } from '../../results/optimization-plot-axis';
import { confirmedStageCiFrame, confirmedStageTsFrame } from '../../results/trajectory-stages';
import { useProjectState } from '../../projects/ui-state';
import ScientificPlot from './ScientificPlot';
import type { ScientificPlotPoint, ScientificPlotSeries } from '../../results/scientific-plot';
import { AnalysisTaskLayout } from './AnalysisTaskLayout';
import { EnergyPlotUnit, EnergyPlotZero, energyPlotUnits,plotEnergyUnit } from './EnergyPlotControls';
import {settingEnum,settingText} from './analysis-mcp-settings';
import {objectSchema} from '../mcp/types';
import { decimalEnergyValue, energySummaryValue } from '../../results/numeric-format';
import {projectTrajectoryEnergyOverlays,type TrajectoryEnergyGap,type TrajectoryEnergyOverlay} from '../../results/trajectory-energy-extension';
import {usePlotFigure, type PlotFigureRecord} from './scientific-plot-figure';
import type {NativeMcpSettings} from './results-mcp-context';
import './OptimizationPlot.css';
import './TrajectoryAnalysisControls.css';

export interface OptimizationPlotProps {
  result: TrajectoryPlotResult; currentIndex?: number; onSelectFrame(index: number): void;
  currentConvergence?: ResultFrameSummary['convergence'];
  onSeriesChange?(series: EnergySeries): void; responsive?: boolean;
  onDraw?(): void;
  coordinateTrace?: CoordinateTrace | null;
  scanOrdinal?: boolean;
  axisControl?: ReactNode;
  scanAxisSettings?:NativeMcpSettings;
  extension?: OptimizationPlotExtension;
}
export type {OptimizationEnergyDisplay} from '../../results/scientific-plot-editing';
export interface OptimizationPlotExtension {
  overlays?:readonly TrajectoryEnergyOverlay[];
  gaps?:readonly TrajectoryEnergyGap[];
  axis?:TrajectoryPlotSourceAxis;
  controls?:ReactNode;
  display?:OptimizationEnergyDisplay;
  onDisplayChange?(value:OptimizationEnergyDisplay):void;
  onSelectOverlay?(seriesId:string,frameId:string):void;
  frameIds?:readonly string[];
  markers?: readonly { sourceIndex:number; label:'CI'|'TS' }[];
  scanPointNumbers?: boolean;
  pathMethod?: string;
  irc?: { downhill: boolean; exploration: boolean; originIsTs?: boolean };
}
const plotIdentity = (result: TrajectoryPlotResult) => `trajectory-energy:${result.id}:${result.jobIndex ?? 0}`;

function optimizationTitle(kind: ReturnType<typeof trajectoryPlotKind>, pathMethod?: string, relaxedScan?: boolean) {
  const method = pathMethod === 'ci-neb' ? 'CI-NEB' : pathMethod === 'fsm' ? 'FSM' : pathMethod === 'de-gsm' ? 'DE-GSM' : pathMethod === 'se-gsm' ? 'SE-GSM' : 'NEB';
  return { optimization: 'Optimization Energy', scan: relaxedScan ? 'Relaxed Potential Energy Scan' : 'Potential Energy Scan',
    irc: 'IRC Energy Profile', neb: `${method} Energy Profile`, trajectory: 'Trajectory Energy' }[kind];
}

export function OptimizationPlot(props:OptimizationPlotProps) {
  const {extension,responsive,result}=props;
  const scope = plotIdentity(result);
  const [savedDisplay] = useProjectState<OptimizationEnergyDisplay>('energy.display', defaultFrameEnergyDisplay, scope);
  const record = usePlotFigure(scope);
  const startingDisplay = useRef<{scope: string; value: OptimizationEnergyDisplay} | undefined>(undefined);
  const initial = startingDisplay.current?.scope === scope ? startingDisplay.current.value : extension?.display ?? savedDisplay;
  const display = record.figure.energy ?? initial;
  const displayChange = useRef(extension?.onDisplayChange);
  displayChange.current = extension?.onDisplayChange;
  useEffect(() => {if (startingDisplay.current?.scope === scope || record.figure.energy) displayChange.current?.(display);}, [scope, display]);
  const updateDisplay = (value: Partial<OptimizationEnergyDisplay>) => {
    startingDisplay.current = {scope, value: initial};
    record.replace(previous => ({...previous, energy: {...(previous.energy ?? initial), ...value}}));
  };
  const ircNotice = extension?.irc?.downhill ? '实线为实际计算的下坡轨迹，虚线是同一条轨迹的镜像。' :
    extension?.irc?.exploration ? '多个虚模，本次为路径探索。' : undefined;
  const kind = extension?.pathMethod ? 'neb' : trajectoryPlotKind(result);
  const cardTitle = { optimization: '优化能量', scan: 'SCAN 能量曲线', irc: 'IRC 能量路径', neb: '路径能量曲线', trajectory: '能量曲线' }[kind];
  return <AnalysisTaskLayout variant="card" title={cardTitle} className={`trajectory-energy-task${responsive ? ' optimization-plot-responsive' : ''}`} ariaLabel="计算能量曲线" retainCollapsedResults
    headerActions={ircNotice && <details className="pes-local-failures"><summary aria-label="查看 IRC 路径说明" title={ircNotice}>!</summary><div role="note"><p>{ircNotice}</p></div></details>}>
    <OptimizationPlotBody key={scope} {...props} display={display} updateDisplay={updateDisplay} record={record}/>
  </AnalysisTaskLayout>;
}

function OptimizationPlotBody({result,currentIndex,currentConvergence,onSelectFrame,onSeriesChange,onDraw,responsive=false,coordinateTrace,scanOrdinal=false,axisControl,scanAxisSettings,extension,display,updateDisplay,record}:
  OptimizationPlotProps&{display:OptimizationEnergyDisplay;updateDisplay(value:Partial<OptimizationEnergyDisplay>):void;record:PlotFigureRecord}) {
  const {unit,relative,reference,zeroPoint}=display;
  const [selectingZero, setSelectingZero] = useState(false);
  const kind = extension?.pathMethod ? 'neb' : trajectoryPlotKind(result);
  const scan = kind === 'scan', irc = kind === 'irc';
  const nodeLayer = !result.stages?.length && (kind === 'irc' || kind === 'scan') && result.frames.some(frame => frame.pathNode !== undefined);
  const plottedFrames = useMemo(() => nodeLayer ? pathNodeFrames(result.frames) : result.frames, [result, nodeLayer]);
  const frameIds = extension?.frameIds;
  const stage = result.stages?.length === 1 ? result.stages[0] : undefined;
  const stageCi = confirmedStageCiFrame(result, stage), stageTs = confirmedStageTsFrame(result, stage);
  const title = optimizationTitle(kind, extension?.pathMethod ?? (stageCi === undefined ? undefined : 'ci-neb'),
    extension?.scanPointNumbers || !!result.scientific?.scanCoordinates?.length);
  const sourceMarks = extension?.markers;
  const marks = useMemo(() => {
    const found = new Map<number, string>();
    const markedTs = irc ? plottedFrames.filter(frame => frame.pathDirection === 'ts') : [];
    const origin = stageTs ?? (markedTs.length === 1 ? markedTs[0].index : undefined);
    for (const frame of plottedFrames) {
      const explicit = sourceMarks?.find(mark => mark.sourceIndex === sourceFrame(frame));
      if (explicit) found.set(frame.index, explicit.label);
      else if (frame.index === stageCi) found.set(frame.index, 'CI');
      else if (irc && frame.index === origin) {
        found.set(frame.index, extension?.irc?.originIsTs === false || extension?.irc?.downhill || extension?.irc?.exploration ? 'IRC Origin' : 'TS');
      }
    }
    return found;
  }, [plottedFrames, sourceMarks, stageCi, stageTs, irc, extension?.irc]);
  const firstMark = (label: string) => {
    const matching = [...marks].filter(([, mark]) => mark === label);
    return matching.length === 1 ? matching[0][0] : undefined;
  };
  const tsIndex = firstMark('TS') ?? firstMark('IRC Origin'), ciIndex = firstMark('CI');
  const referenceFrame = reference === 'current' ? currentIndex ?? -1 : 0;
  const referenceFrameIndex = reference === 'ts' ? tsIndex : reference === 'ci' ? ciIndex :
    reference === 'point' && zeroPoint && !zeroPoint.overlay
      ? plottedFrames.find(frame => (frameIds?.[sourceFrame(frame)] ?? sourceFrame(frame)) === zeroPoint.frameId)?.index : undefined;
  const overlayReference = zeroPoint?.overlay;
  const externalReference = reference === 'point' && overlayReference
    ? extension?.overlays?.find(overlay => overlay.id === overlayReference.seriesId)?.points.find(point => point.frameId === zeroPoint.frameId)?.energy ?? overlayReference.energy
    : undefined;
  const series = useMemo(() => buildEnergySeries(plottedFrames, { unit, relative, reference, currentIndex: referenceFrame, referenceFrameIndex, externalReference }),
    [plottedFrames, unit, relative, reference, referenceFrame, referenceFrameIndex, externalReference]);
  useEffect(() => { onSeriesChange?.(series); }, [onSeriesChange, series]);
  const forward = irc && plottedFrames.some(frame => frame.pathDirection === 'forward');
  const reverse = irc && plottedFrames.some(frame => frame.pathDirection === 'reverse');
  const downhill = irc && !!extension?.irc?.downhill && !(forward && reverse) && (forward || reverse);
  const direction = downhill ? 'Downhill IRC' : forward && reverse ? 'Bidirectional IRC' : forward ? 'Forward IRC' : reverse ? 'Reverse IRC' : undefined;
  const chart = useMemo(() => {
    const axis = trajectoryDisplayAxis(result, plottedFrames, { supplied: extension?.axis, coordinateTrace, scanOrdinal,
      scanPointNumbers: extension?.scanPointNumbers, symmetricIrc: irc && (forward && reverse || downhill) });
    const gapPoint = (gap: TrajectoryEnergyGap): ScientificPlotPoint => ({
      x: scan && !axis.physical ? gap.scanPoint ?? NaN : coordinateTrace ? NaN : gap.x ?? NaN, y: null, label: gap.label,
    });
    const gapsByIndex = new Map<number, ScientificPlotPoint[]>();
    for (const gap of extension?.gaps ?? []) {
      const rows = gapsByIndex.get(gap.beforeIndex) ?? [];
      rows.push(gapPoint(gap));
      gapsByIndex.set(gap.beforeIndex, rows);
    }
    const unitLabel = plotEnergyUnit(unit);
    const points = series.points.flatMap((point, i) => {
      const frame = plottedFrames[i], readoutId = sourceFrame(frame) + 1;
      const markerLabel = marks.get(frame.index);
      const value: ScientificPlotPoint = {
        x: axis.coordinates[i] ?? NaN, y: point.value, index: point.index, readoutId, markerLabel,
        segment: frame.pathDirection === 'ts' ? undefined : frame.pathDirection,
        label: `选择帧 ${readoutId}，能量 ${point.value ?? '缺失'} ${unitLabel}`,
        tooltip: `Frame ${readoutId}${markerLabel ? ` · ${markerLabel}` : ''} · Step ${point.sourceStep ?? '—'} · ${point.value ?? '—'} ${unitLabel}`,
      };
      const gaps = gapsByIndex.get(sourceFrame(frame));
      return gaps ? [...gaps, value] : [value];
    });
    for (const gap of extension?.gaps ?? []) if (gap.beforeIndex >= result.frames.length) points.push(gapPoint(gap));
    if (extension?.irc && points.every(point => Number.isFinite(point.x))) points.sort((a, b) => a.x - b.x);
    return { points, axis, hasEnergy: points.some(point => point.y !== null && Number.isFinite(point.x)) };
  }, [plottedFrames, series, result, coordinateTrace, scan, scanOrdinal, unit, extension?.axis, extension?.gaps, extension?.scanPointNumbers,
    extension?.irc, irc, forward, reverse, downhill, marks]);
  const overlay=useMemo(()=>projectTrajectoryEnergyOverlays(extension?.overlays??[],series,result.frames.length),[extension?.overlays,series,result.frames.length]);
  const plotSeries = useMemo<ScientificPlotSeries[]>(() => [
    { id: 'energy', label: downhill ? 'Calculated Downhill Path' : 'Energy', points: chart.points },
    ...overlay.series,
    ...(downhill ? [{ id: 'downhill-mirror', label: 'Mirrored Downhill Path', dashed: true,
      points: chart.points.map(point => ({ x: -point.x, y: point.y })).reverse() }] : []),
  ], [chart.points, overlay.series, downhill]);
  const selectPoint=(index:number)=>{const point=overlay.picks.get(index);if(point)extension?.onSelectOverlay?.(point.seriesId,point.frameId);else onSelectFrame(index);};
  const zeroFromPoint = (point: ScientificPlotPoint):OptimizationEnergyDisplay['zeroPoint'] => {
    if (point.index === undefined) return;
    const other = overlay.picks.get(point.index);
    const frame = result.frames[point.index];
    if (other?.energy) {
      return {
        frameId: other.frameId, overlay: { seriesId: other.seriesId, energy: other.energy, frameNumber: other.frameNumber },
      };
    }
    if(frame?.energy)return {frameId:frameIds?.[sourceFrame(frame)]??sourceFrame(frame)};
  };
  const setZeroFromPoint = (point: ScientificPlotPoint) => {
    const zeroPoint=zeroFromPoint(point);if(!zeroPoint)return;
    updateDisplay({relative:true,reference:'point',zeroPoint});
    setSelectingZero(false);
  };
  const selected = series.points.find(point => point.index === currentIndex);
  const frame = currentIndex === undefined ? undefined : result.frames[currentIndex], convergence = currentConvergence ?? frame?.convergence ?? [];
  const rawCurrent = frame?.energy ? convertEnergy(frame.energy, unit) : null;
  const currentValue = selected ? selected.value : rawCurrent === null || relative && series.referenceValue === null ? null : rawCurrent - (relative ? series.referenceValue! : 0);
  const precision = decimalEnergyValue;
  const tsLabel = tsIndex !== undefined && marks.get(tsIndex) === 'IRC Origin' ? 'IRC 起点' : 'TS';
  const referenceNames = { first: '首帧', last: '末帧', min: '最低能量', max: '最高能量', current: '当前帧', ts: tsLabel, ci: 'CI 节点', point: '选定点' };
  const referenceSource = series.referenceIndex === null ? undefined : result.frames[series.referenceIndex];
  const referenceFrameNumber = referenceSource ? sourceFrame(referenceSource) + 1 : reference === 'point' ? overlayReference?.frameNumber : undefined;
  const referenceTarget = referenceFrameNumber === undefined ? '未知' : `帧 ${referenceFrameNumber}`;
  const text = () => trajectoryEnergyPlotText(series, chart.axis, scan || irc || kind === 'neb' || !!extension?.axis)
    +(extension?.frameIds?'\n来源\t帧\tFrame ID\n'+plottedFrames.map(frame=>[result.id,frame.index+1,extension.frameIds?.[frame.sourceFrameIndex??frame.index]??''].join('\t')).join('\n')+'\n':'')
    +(extension?.gaps?.length?'\n缺口\t横坐标\t能量\n'+extension.gaps.map(gap=>[gap.label??'未连接',
      (scan && !chart.axis.physical ? gap.scanPoint : coordinateTrace ? null : gap.x) ?? '', ''].join('\t')).join('\n')+'\n':'')
    +(overlay.series.length?'\n'+overlay.text:'');
  const hasChart = chart.hasEnergy || overlay.series.some(line => line.points.some(point => point.y !== null && Number.isFinite(point.x)));
  const drawCallback = useRef(onDraw);
  drawCallback.current = onDraw;
  useEffect(() => { if (hasChart) drawCallback.current?.(); }, [hasChart, result.id, result.frames]);
  const hasEnergy = (frame?: ResultFrameSummary) => frame !== undefined && convertEnergy(frame.energy, unit) !== null;
  const choices = [
    { value: 'first', label: referenceNames.first, disabled: !plottedFrames.some(hasEnergy) },
    { value: 'last', label: referenceNames.last, disabled: !plottedFrames.some(hasEnergy) },
    { value: 'min', label: referenceNames.min },
    { value: 'max', label: referenceNames.max },
    { value: 'current', label: referenceNames.current, disabled: !selected || !hasEnergy(frame) },
    ...(tsIndex === undefined ? [] : [{ value: 'ts', label: tsLabel, disabled: !hasEnergy(result.frames[tsIndex]) }]),
    ...(ciIndex === undefined ? [] : [{ value: 'ci', label: referenceNames.ci, disabled: !hasEnergy(result.frames[ciIndex]) }]),
  ];
  const toolbar = <>
    <EnergyPlotUnit unit={unit} onChange={next => updateDisplay({ unit: next })}/>
    <EnergyPlotZero value={relative ? reference : 'original'} choices={choices} canSelect={hasChart} selecting={selectingZero}
      pointLabel={reference === 'point' ? referenceTarget : undefined}
      onChange={next => {
        setSelectingZero(next === 'pick');
        if (next === 'original') updateDisplay({ relative: false, zeroPoint: undefined });
        else if (choices.some(choice => choice.value === next)) updateDisplay({ relative: true, reference: next as EnergyReference, zeroPoint: undefined });
      }}/>
    {axisControl}
    {extension?.controls && <span className="scientific-plot-control-group">{extension.controls}</span>}
  </>;
  const axisContext = coordinateTrace ? `scan:${coordinateTrace.kind}:${coordinateTrace.atomIndices.join(',')}` : chart.axis.label;
  const unitLabel = plotEnergyUnit(unit);
  return <>
    {currentIndex !== undefined && <div className="trajectory-energy-readout"><p className="trajectory-current-energy">帧 {currentIndex + 1} / {result.frames.length} · {currentValue === null ? '能量缺失' : `${relative ? 'ΔE' : 'E'} ${energySummaryValue(currentValue,unit)} ${unit}`}{!selected && nodeLayer ? ' · 点内迭代帧（未入节点曲线）' : ''}</p>
    {currentValue !== null && <details className="trajectory-energy-full-value"><summary>完整值</summary><span className="trajectory-energy-copy-value" aria-label="当前能量完整值" title="选择并复制完整数值" onCopy={event=>{event.clipboardData.setData('text/plain',precision(currentValue));event.preventDefault();}}>{precision(currentValue)}</span><span> {unit}</span></details>}</div>}
    {hasChart ? <ScientificPlot appearanceKey={plotIdentity(result)} figureRecord={record} toolbar={toolbar} title={title} xLabel={chart.axis.label} yLabel={`${relative ? 'Relative Energy' : 'Energy'} / ${unitLabel}`} series={plotSeries} selectedIndex={currentIndex} onSelectIndex={selectPoint}
      mcpConfigurations={scanAxisSettings?{'scan-axis':scanAxisSettings}:undefined}
      mcpConfiguration={{schema:objectSchema({unit:settingEnum(energyPlotUnits),zero:settingEnum(['original',...choices.filter(choice=>!choice.disabled).map(choice=>choice.value),'point']),
        seriesId:settingText,pointIndex:{type:'integer',minimum:0}}),
        read:()=>({kind:'trajectory-energy',unit,zero:relative?reference:'original',zeroPoint,referenceIndex:series.referenceIndex,referenceValue:series.referenceValue}),
        apply(values){
          if(selectingZero)throw new Error('请先结束轨迹曲线的交互式零点选择。');
          const patch=values as {unit?:EnergyUnit;zero?:EnergyReference|'original';seriesId?:string;pointIndex?:number};
          const target=patch.zero??(patch.pointIndex===undefined?undefined:'point');
          if((patch.pointIndex!==undefined||patch.seriesId!==undefined)&&target!=='point')throw new Error('仅点参考使用曲线和点编号。');
          const point=patch.pointIndex===undefined?undefined:plotSeries.find(row=>row.id===(patch.seriesId??'energy'))?.points[patch.pointIndex];
          const reference=target==='point'&&point?zeroFromPoint(point):undefined;
          if(target==='point'&&!reference)throw new Error('当前轨迹或对照曲线没有此点的已归属能量。');
          updateDisplay({...(patch.unit===undefined?{}:{unit:patch.unit}),...(target===undefined?{}:target==='original'?{relative:false,zeroPoint:undefined}:
            {relative:true,reference:target,zeroPoint:reference})});
        }}}
      pointReadout={{ kind: 'Frame', xUnit: chart.axis.unit, yUnit: unitLabel }} selectingZero={selectingZero} onSetZeroPoint={setZeroFromPoint}
      axisContext={axisContext} axisTransforms={{ y: { scale: convertEnergy({ value: 1, unit: 'hartree' }, unit)!, offset: relative ? -(series.referenceValue ?? 0) : 0 } }}
      responsive={responsive} xDomain={chart.axis.range} resetKey={`${result.id}:${nodeLayer}`} testId="optimization-energy-svg" ariaLabel={`作业 ${(result.jobIndex??0)+1} · ${relative ? '相对' : '原始'}能量，单位${unit}；点击曲线横向位置选择结构帧`}
      exportLabel="能量图"
      exportFileName={`Ester-Studio-opt-energy-job-${(result.jobIndex ?? 0) + 1}`} exportText={{ fileName: `Ester-Studio-energy-job-${(result.jobIndex ?? 0) + 1}.txt`, text }}
      metadata={{ schema: 'sciyue.optimization-figure.v1', source: result.source, jobIndex: result.jobIndex, display: { unit, relative, reference, referenceIndex: series.referenceIndex, referenceValue: series.referenceValue, zeroPoint },
        range: { start: 0, end: result.frames.length - 1, stride: 1 }, plottedFrameIndices: plottedFrames.map(item => item.index), frameIds:extension?.frameIds,overlays:extension?.overlays,gaps:extension?.gaps,missingIndices: series.points.filter(point => point.value === null).map(point => point.index), scope: '完整结果', pathLayer: nodeLayer ? 'last-printed-per-node' : 'all-frames' }}/>
      : <><div className="optimization-plot-options">{toolbar}</div><p className="optimization-plot-empty">{relative && series.referenceValue === null ? '参考帧没有可换算能量；请选择其他参考。' : '没有已确认单位的目标能量；结构帧仍可浏览。'}</p></>}
    {direction && <p className="optimization-plot-note" data-irc-direction={direction}>{direction}</p>}
      {(series.points.some(point => point.value === null)||!!extension?.gaps?.length) && <p className="optimization-plot-note">缺失或未知单位的能量保持空缺，曲线不跨缺项连线。</p>}
      {nodeLayer && <p className="optimization-plot-note">各节点最后已打印帧，不代表该点收敛。</p>}
    {chart.axis.status && <p className="optimization-plot-note" role="status">{chart.axis.status}</p>}
    {currentIndex !== undefined && <details className="analysis-task-section optimization-convergence"><summary>当前帧收敛指标 · {frame?.label ?? `步 ${frame?.sourceStep ?? '未知'}`}</summary>
      {convergence.length>0&&<table aria-label="当前帧收敛指标" aria-description="仅显示当前帧实际输出的判据，不借用相邻步骤的收敛结论。"><thead><tr><th>指标</th><th>值</th><th>阈值</th><th>满足</th><th>单位</th></tr></thead><tbody>{convergence.map(item => <tr key={item.label}><td>{item.label}</td><td>{item.value === null ? '未知' : item.value}</td><td>{item.threshold === null ? '未知' : item.threshold}</td><td>{item.converged === null ? '未知' : item.converged ? 'YES' : 'NO'}</td><td>{item.unit ?? '未知'}</td></tr>)}</tbody></table>}
      {!convergence.length && <p className="optimization-plot-note">当前帧未输出收敛判据。</p>}
    </details>}
  </>;
}
