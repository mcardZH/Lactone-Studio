import NumericInput from '../NumericInput';
import { useMemo, useState } from 'react';
import { postprocessPlotData, postprocessPlotText, postprocessUnitLabel, type PostprocessEnergyUnit, type PostprocessPlotSnapshot } from './PostprocessPresentation';
import type { OrbitalChannel } from '../../results/scientific-contracts';
import ScientificPlot, { type ScientificPlotSeries } from './ScientificPlot';
import { formatResultValue } from '../../results/numeric-format';
import './Postprocess.css';
import './PostprocessPlot.css';

export interface PostprocessOrbitalSelection { spin: OrbitalChannel['spin']; index: number }
export interface PostprocessPlotProps { snapshot: PostprocessPlotSnapshot; compact?: boolean; onSelectOrbital?(selection: PostprocessOrbitalSelection): void }
/** One printed SCF cycle or spin channel per chart; the shared stage owns display geometry. */
export default function PostprocessPlot({ snapshot, compact = false, onSelectOrbital }: PostprocessPlotProps) {
  const adjustable = (value: number | null | undefined) => formatResultValue(value, snapshot.decimals ?? 2);
  const [unit, setUnit] = useState<PostprocessEnergyUnit>('eV'), [index, setIndex] = useState(0), [span, setSpan] = useState(6);
  const data = useMemo(() => postprocessPlotData(snapshot, unit), [snapshot, unit]);
  const cycle = data.cycles[Math.min(index, data.cycles.length - 1)], channel = data.channels[Math.min(index, data.channels.length - 1)];
  const series = useMemo<ScientificPlotSeries[]>(() => {
    if (snapshot.kind === 'scf') return cycle ? [{ id: 'scf', label: 'SCF能量', showPoints: true, points: cycle.points.map(point => ({ x: point.iteration, y: point.energy })) }] : [];
    if (!channel) return [];
    const homo = channel.frontier.homo?.index;
    const frontierPosition = homo == null ? 0 : Math.max(0, channel.orbitals.findIndex(orbital => orbital.index === homo));
    return channel.orbitals.slice(Math.max(0, frontierPosition - span + 1), frontierPosition + span + 1).filter(orbital => orbital.energy != null && Number.isFinite(orbital.energy)).map((orbital, ordinal) => {
      const frontier = orbital.index === channel.frontier.homo?.index ? 'HOMO' : orbital.index === channel.frontier.lumo?.index ? 'LUMO' : '';
      const x = ordinal % 2 ? 1.6 : .1;
      const tooltip = `${orbital.index} ${frontier} · ${adjustable(orbital.energy)} ${postprocessUnitLabel(unit)} · 占据数 ${Number.isInteger(orbital.occupation) ? String(orbital.occupation) : adjustable(orbital.occupation)}`;
      return { id: `orbital-${orbital.index}`, color: frontier ? '#c07c36' : orbital.occupation > 1e-8 ? '#2b7c83' : '#728ca8', pointLabels: true,
        points: [{ x, y: orbital.energy, index: orbital.index, tooltip }, { x: x + .85, y: orbital.energy, index: orbital.index, label: frontier || undefined, tooltip }] };
    });
  }, [snapshot.kind, snapshot.decimals, cycle, channel, span, unit]);
  const hasChart = series.some(line => line.points.some(point => point.y != null && Number.isFinite(point.y)));
  return <div className={`postprocess-plot ${compact ? 'is-compact' : ''}`}><div className="postprocess-plot-controls"><label>单位 <select aria-label={`${snapshot.kind === 'scf' ? 'SCF' : '能级图'}能量单位`} value={unit} onChange={event => setUnit(event.target.value as PostprocessEnergyUnit)}><option value="eV">eV</option><option value="hartree">Eh</option></select></label>
    {snapshot.kind === 'scf' ? <label>周期 <select aria-label="SCF 绘图周期" value={index} onChange={event => setIndex(Number(event.target.value))}>{data.cycles.map((cycle, index) => <option value={index} key={index}>周期 {index + 1}</option>)}</select></label> : <><label>通道 <select aria-label="能级图自旋通道" value={index} onChange={event => setIndex(Number(event.target.value))}>{data.channels.map((channel, index) => <option value={index} key={index}>{channel.spin}</option>)}</select></label><label>前线两侧轨道数 <NumericInput aria-label="能级图轨道数量" stepper min={1} max={30} value={span} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 30) setSpan(value); }}/></label></>}
    </div>
    {hasChart ? <ScientificPlot appearanceKey={`postprocess:${snapshot.id}:${snapshot.kind}:${index}`} plotStyle={snapshot.kind === 'levels' ? 'plain' : 'numeric'} title={`${snapshot.title} · ${snapshot.kind === 'levels' ? channel?.spin : `周期 ${index + 1}`}`} xLabel={snapshot.kind === 'scf' ? 'SCF 迭代（当前周期）' : '前线附近轨道 · 占据 / 空轨道'} yLabel={`E / ${postprocessUnitLabel(unit)}`} series={series}
      showXTicks={snapshot.kind === 'scf'} xDomain={snapshot.kind === 'levels' ? [0, 3.5] : undefined} decimals={snapshot.kind === 'levels' ? snapshot.decimals ?? 2 : undefined}
      selectionMode={snapshot.kind === 'levels' ? 'series' : 'x'}
      onSelectIndex={snapshot.kind === 'levels' && onSelectOrbital && channel ? orbital => onSelectOrbital({ spin: channel.spin, index: orbital }) : undefined}
      resetKey={`${snapshot.id}:${unit}:${index}:${span}`} metadata={{ ...data, displayedIndex: index, frontierSpan: snapshot.kind === 'levels' ? span : undefined }}
      exportFileName={`Ester-Studio-${snapshot.kind}-job-${snapshot.jobIndex + 1}-frame-${snapshot.frameIndex + 1}`} exportText={{ fileName: `Ester-Studio-${snapshot.kind}-job-${snapshot.jobIndex + 1}-frame-${snapshot.frameIndex + 1}.txt`, text: postprocessPlotText(snapshot, unit) }}/>
      : <p className="postprocess-empty">{snapshot.kind === 'scf' ? '没有当前周期逐轮能量，不能绘制 SCF 收敛过程。' : '没有当前帧已确认归属的轨道能量。'}</p>}
  </div>;
}
