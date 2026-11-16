import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TrajectoryResult } from '../../results/contracts';
import { buildEnergySeries, convertEnergy, type EnergyReference, type EnergySeries, type EnergyUnit } from '../../results/energy';
import { pathNodeFrames, type CoordinateTrace } from '../../results/scientific-analysis';
import { trajectoryEnergyPlotText, trajectoryPlotAxis, trajectoryPlotKind } from '../../results/optimization-plot-axis';
import ScientificPlot from './ScientificPlot';
import { AnalysisTaskLayout } from './AnalysisTaskLayout';
import { decimalEnergyValue, energySummaryValue } from '../../results/numeric-format';
import {projectTrajectoryEnergyOverlays,type TrajectoryEnergyGap,type TrajectoryEnergyOverlay} from '../../results/trajectory-energy-extension';
import './OptimizationPlot.css';
import './TrajectoryAnalysisControls.css';

export interface OptimizationPlotProps {
  result: TrajectoryResult; currentIndex: number; onSelectFrame(index: number): void;
  onSeriesChange?(series: EnergySeries): void; responsive?: boolean;
  coordinateTrace?: CoordinateTrace | null;
  extension?: OptimizationPlotExtension;
}
export interface OptimizationEnergyDisplay {unit:EnergyUnit;relative:boolean;reference:EnergyReference}
export interface OptimizationPlotExtension {
  overlays?:readonly TrajectoryEnergyOverlay[];
  gaps?:readonly TrajectoryEnergyGap[];
  axis?:{label:string;coordinates:readonly (number|null)[]};
  controls?:ReactNode;
  display?:OptimizationEnergyDisplay;
  onDisplayChange?(value:OptimizationEnergyDisplay):void;
  onSelectOverlay?(seriesId:string,frameId:string):void;
  frameIds?:readonly string[];
}
export function OptimizationPlot({ result, currentIndex, onSelectFrame, onSeriesChange, responsive = false, coordinateTrace, extension }: OptimizationPlotProps) {
  const [localDisplay,setLocalDisplay]=useState<OptimizationEnergyDisplay>({unit:'hartree',relative:false,reference:'first'});
  const display=extension?.display??localDisplay,{unit,relative,reference}=display;
  const updateDisplay=(value:Partial<OptimizationEnergyDisplay>)=>{const next={...display,...value};if(extension?.onDisplayChange)extension.onDisplayChange(next);else setLocalDisplay(next);};
  // The owning card supplies the generic heading; a saved custom figure title still wins.
  const title = '';
  const referenceFrame = reference === 'current' ? currentIndex : 0;
  const kind = trajectoryPlotKind(result);
  const nodeLayer = !result.stages?.length && (kind === 'irc' || kind === 'scan') && result.frames.some(frame => frame.pathNode !== undefined);
  const plottedFrames = useMemo(() => nodeLayer ? pathNodeFrames(result.frames) : result.frames, [result, nodeLayer]);
  const series = useMemo(() => buildEnergySeries(plottedFrames, { unit, relative, reference, currentIndex: referenceFrame }), [plottedFrames, unit, relative, reference, referenceFrame]);
  useEffect(() => { onSeriesChange?.(series); }, [onSeriesChange, series]);
  const chart = useMemo(() => {
    const axis = extension?.axis?{...extension.axis,coordinates:[...extension.axis.coordinates],physical:true,range:undefined,status:undefined}:trajectoryPlotAxis(result, plottedFrames, coordinateTrace);
    const points = series.points.flatMap((point, i) => {
      const value={ x: axis.coordinates[i] ?? NaN, y: point.value, index: point.index,
      segment: plottedFrames[i]?.pathDirection === 'ts' ? undefined : plottedFrames[i]?.pathDirection,
      label: `选择帧 ${point.index + 1}，能量 ${point.value ?? '缺失'} ${unit}`, tooltip: `帧 ${point.index + 1} · 步 ${point.sourceStep ?? '未知'} · ${point.value} ${unit}` };
      const sourceIndex=plottedFrames[i]?.sourceFrameIndex??point.index;
      return [...(extension?.gaps??[]).filter(gap=>gap.beforeIndex===sourceIndex).map(gap=>({x:coordinateTrace?NaN:gap.x??NaN,y:null,label:gap.label})),value];
    });
    for(const gap of extension?.gaps??[])if(gap.beforeIndex>=result.frames.length)points.push({x:coordinateTrace?NaN:gap.x??NaN,y:null,label:gap.label});
    return { points, axis, axisLabel: axis.label,
      hasEnergy: points.some(point => point.y !== null) };
  }, [plottedFrames, series, result, coordinateTrace, unit,extension?.axis,extension?.gaps]);
  const overlay=useMemo(()=>projectTrajectoryEnergyOverlays(extension?.overlays??[],series,result.frames.length),[extension?.overlays,series,result.frames.length]);
  const plotSeries=[{id:'energy',label:result.label||'能量',points:chart.points},...overlay.series];
  const selectPoint=(index:number)=>{const point=overlay.picks.get(index);if(point)extension?.onSelectOverlay?.(point.seriesId,point.frameId);else onSelectFrame(index);};
  const selected = series.points.find(point => point.index === currentIndex);
  const frame = result.frames[currentIndex], convergence = frame?.convergence ?? [];
  const rawCurrent = frame?.energy ? convertEnergy(frame.energy, unit) : null;
  const currentValue = selected ? selected.value : rawCurrent === null || relative && series.referenceValue === null ? null : rawCurrent - (relative ? series.referenceValue! : 0);
  const precision = decimalEnergyValue;
  const referenceLabel = relative ? `${overlay.series.length?`${result.label} · `:''}${{ first: '首帧', last: '末帧', min: '最低能量', max: '最高能量', current: '当前帧', ts: '来源 TS' }[reference]}参考：${series.referenceIndex === null ? '未知' : `帧 ${series.referenceIndex + 1}`}；E₀=${series.referenceValue === null ? '未知' : precision(series.referenceValue)} ${unit}` : undefined;
  const scan = kind === 'scan';
  const text = useMemo(() => trajectoryEnergyPlotText(series, chart.axis, scan||!!extension?.axis)
    +(extension?.frameIds?'\n来源\t帧\tFrame ID\n'+plottedFrames.map(frame=>[result.id,frame.index+1,extension.frameIds?.[frame.sourceFrameIndex??frame.index]??''].join('\t')).join('\n')+'\n':'')
    +(extension?.gaps?.length?'\n缺口\t横坐标\t能量\n'+extension.gaps.map(gap=>[gap.label??'未连接',gap.x??'',''].join('\t')).join('\n')+'\n':'')
    +(overlay.series.length?'\n'+overlay.text:''), [series, chart.axis, scan,overlay,extension?.axis,extension?.frameIds,extension?.gaps,plottedFrames,result.id]);
  const toolbar = <>
      <label>能量 <select aria-label="能量显示" value={relative ? 'relative' : 'absolute'} onChange={event => updateDisplay({relative:event.target.value === 'relative'})}><option value="absolute">原始能量</option><option value="relative">相对能量</option></select></label>
      <label>单位 <select aria-label="能量单位" value={unit} onChange={event => updateDisplay({unit:event.target.value as EnergyUnit})}>{(['hartree', 'eV', 'kJ/mol', 'kcal/mol'] as const).map(value => <option key={value}>{value}</option>)}</select></label>
      {relative && <label>零点 <select aria-label="能量参考" value={reference} onChange={event => updateDisplay({reference:event.target.value as EnergyReference})}><option value="first">首帧</option><option value="last">末帧</option><option value="min">最低能量</option><option value="max">最高能量</option><option value="current">当前帧</option><option value="ts">来源 TS</option></select></label>}
      {extension?.controls && <span className="scientific-plot-control-group">{extension.controls}</span>}
    </>;
  return <AnalysisTaskLayout variant="card" title="能量曲线" className={`trajectory-energy-task${responsive ? ' optimization-plot-responsive' : ''}`} ariaLabel="计算能量曲线">
    <div className="trajectory-energy-readout"><p className="trajectory-current-energy">帧 {currentIndex + 1} / {result.frames.length} · {currentValue === null ? '能量缺失' : `${relative ? 'ΔE' : 'E'} ${energySummaryValue(currentValue,unit)} ${unit}`}{!selected && nodeLayer ? ' · 点内迭代帧（未入节点曲线）' : ''}</p>
    {currentValue !== null && <details className="trajectory-energy-full-value"><summary>完整值</summary><span className="trajectory-energy-copy-value" aria-label="当前能量完整值" title="选择并复制完整数值" onCopy={event=>{event.clipboardData.setData('text/plain',precision(currentValue));event.preventDefault();}}>{precision(currentValue)}</span><span> {unit}</span></details>}</div>
    {chart.hasEnergy||overlay.series.some(line=>line.points.some(point=>point.y!==null)) ? <ScientificPlot appearanceKey={`trajectory-energy:${result.id}:${result.jobIndex ?? 0}`} toolbar={toolbar} title={title} xLabel={chart.axisLabel} yLabel={`${relative ? 'ΔE' : 'E'} / ${unit}`} series={plotSeries} selectedIndex={currentIndex} onSelectIndex={selectPoint}
      responsive={responsive} xDomain={chart.axis.range} resetKey={`${result.id}:${nodeLayer}:${unit}:${relative}:${reference}:${coordinateTrace?.kind}:${coordinateTrace?.atomIndices.join(',')}`} testId="optimization-energy-svg" ariaLabel={`作业 ${(result.jobIndex??0)+1} · ${relative ? '相对' : '原始'}能量，单位${unit}；点击曲线横向位置选择结构帧`}
      exportLabel="能量图" subtitle={referenceLabel}
      exportFileName={`Ester-Studio-opt-energy-job-${(result.jobIndex ?? 0) + 1}`} exportText={{ fileName: `Ester-Studio-energy-job-${(result.jobIndex ?? 0) + 1}.txt`, text }}
      metadata={{ schema: 'sciyue.optimization-figure.v1', source: result.source, jobIndex: result.jobIndex, display: { unit, relative, reference, referenceIndex: series.referenceIndex, referenceValue: series.referenceValue },
        range: { start: 0, end: result.frames.length - 1, stride: 1 }, plottedFrameIndices: plottedFrames.map(item => item.index), frameIds:extension?.frameIds,overlays:extension?.overlays,gaps:extension?.gaps,missingIndices: series.points.filter(point => point.value === null).map(point => point.index), scope: '完整结果', pathLayer: nodeLayer ? 'last-printed-per-node' : 'all-frames' }}/>
      : <><div className="optimization-plot-options">{toolbar}</div><p className="optimization-plot-empty">{relative && series.referenceValue === null ? '参考帧没有可换算能量；请选择其他参考。' : '没有已确认单位的目标能量；结构帧仍可浏览。'}</p></>}
      {(series.points.some(point => point.value === null)||!!extension?.gaps?.length) && <p className="optimization-plot-note">缺失或未知单位的能量保持空缺，曲线不跨缺项连线。</p>}
      {nodeLayer && <p className="optimization-plot-note">各节点最后已打印帧，不代表该点收敛。</p>}
    {chart.axis.status && <p className="optimization-plot-note" role="status">{chart.axis.status}</p>}
    <details className="analysis-task-section optimization-convergence"><summary>当前帧收敛指标 · {frame?.label ?? `步 ${frame?.sourceStep ?? '未知'}`}</summary>
      {convergence.length>0&&<table aria-label="当前帧收敛指标" aria-description="仅显示当前帧实际输出的判据，不借用相邻步骤的收敛结论。"><thead><tr><th>指标</th><th>值</th><th>阈值</th><th>满足</th><th>单位</th></tr></thead><tbody>{convergence.map(item => <tr key={item.label}><td>{item.label}</td><td>{item.value === null ? '未知' : item.value}</td><td>{item.threshold === null ? '未知' : item.threshold}</td><td>{item.converged === null ? '未知' : item.converged ? 'YES' : 'NO'}</td><td>{item.unit ?? '未知'}</td></tr>)}</tbody></table>}
      {!convergence.length && <p className="optimization-plot-note">当前帧未输出收敛判据。</p>}
    </details>
  </AnalysisTaskLayout>;
}
