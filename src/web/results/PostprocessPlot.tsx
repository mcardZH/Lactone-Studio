import NumericInput from '../NumericInput';
import { useMemo, useState } from 'react';
import { postprocessPlotData, postprocessPlotText, postprocessUnitLabel, type PostprocessEnergyUnit, type PostprocessPlotSnapshot } from './PostprocessPresentation';
import { convertEnergy, defaultFrameEnergyDisplay, type EnergyUnit } from '../../results/energy';
import { useProjectState } from '../../projects/ui-state';
import type { OrbitalChannel } from '../../results/scientific-contracts';
import ScientificPlot, { type ScientificPlotSeries } from './ScientificPlot';
import {formatEnergyValue, formatResultValue } from '../../results/numeric-format';
import { EnergyPlotUnit, EnergyPlotZero, energyPlotUnits,plotEnergyUnit } from './EnergyPlotControls';
import {usePlotFigure} from './scientific-plot-figure';
import type {PlotScfZero} from '../../results/scientific-plot-editing';
import {settingEnum} from './analysis-mcp-settings';
import {objectSchema} from '../mcp/types';
import './Postprocess.css';
import './PostprocessPlot.css';

export interface PostprocessOrbitalSelection { spin: OrbitalChannel['spin']; index: number }
export interface PostprocessPlotProps { snapshot: PostprocessPlotSnapshot; compact?: boolean; orbitalDisplayOffset?: number; onSelectOrbital?(selection: PostprocessOrbitalSelection): void }
/** One printed SCF cycle or spin channel per chart; the shared stage owns display geometry. */
export default function PostprocessPlot(props: PostprocessPlotProps) {
  return props.snapshot.kind === 'scf' ? <ScfPlot {...props}/> : <OrbitalPlot {...props}/>;
}

function ScfPlot({ snapshot, compact }: PostprocessPlotProps) {
  const scope = `postprocess:${snapshot.id}:scf`;
  const [savedUnit] = useProjectState<EnergyUnit>('scf.energy-unit', defaultFrameEnergyDisplay.unit, scope);
  const [cycleKey, setCycle] = useProjectState<string>('scf.cycle', '', scope);
  const [zeroByCycle] = useProjectState<Record<string, PlotScfZero>>('scf.zero', {}, scope);
  const [pickingCycle, setPickingCycle] = useState<string | null>(null);
  const cycles = snapshot.scfCycles.map((cycle, index) => ({
    cycle, index, key: JSON.stringify([cycle.sourceId ?? snapshot.source.id, cycle.sourceLine, index]),
    available: cycle.points.some(point => point.energy !== null && Number.isFinite(point.iteration)),
  }));
  const chosen = cycles.find(row => row.key === cycleKey && row.available) ?? cycles.find(row => row.available);
  const appearanceKey = `${scope}:${chosen?.key ?? ''}`;
  const record = usePlotFigure(appearanceKey);
  const unit = record.figure.scf?.unit ?? savedUnit;
  const data = useMemo(() => postprocessPlotData(snapshot, unit), [snapshot, unit]);
  if (!chosen) return <p className="postprocess-empty">没有当前周期逐轮能量，不能绘制 SCF 收敛过程。</p>;
  const {index, key} = chosen, cycle = data.cycles[index];
  const zero = record.figure.scf?.zero ?? zeroByCycle[key] ?? defaultFrameEnergyDisplay.reference;
  const validEnergy = (point: typeof cycle.points[number]) => point.energy !== null && Number.isFinite(point.iteration);
  const first = cycle.points.findIndex(validEnergy);
  let last = cycle.points.length - 1;
  while (last >= 0 && !validEnergy(cycle.points[last])) last--;
  const zeroIndex = zero === 'first' ? first : zero === 'last' ? last : zero === 'original' ? -1 : cycle.points.findIndex((point, i) =>
    point.iteration === zero.iteration && (zero.sourceLine === undefined ? i === zero.index : point.sourceLine === zero.sourceLine));
  const zeroPoint = cycle.points[zeroIndex], zeroValue = zeroPoint?.energy ?? null;
  const relative = zeroValue !== null;
  const changeScf=(patch:{unit?:EnergyUnit;zero?:PlotScfZero})=>record.replace(previous=>({...previous,scf:{...previous.scf,...patch}}));
  const setZero = (value: PlotScfZero) => changeScf({zero:value});
  const chooseCycle=(cycleIndex:number)=>{setPickingCycle(null);setCycle(cycles[cycleIndex]?.key??'');};
  const selectingZero = pickingCycle === key;
  const fileName = `Ester-Studio-scf-job-${snapshot.jobIndex + 1}-frame-${snapshot.frameIndex + 1}`;
  const toolbar = <>
    <EnergyPlotUnit unit={unit} onChange={unit=>changeScf({unit})} label="SCF能量单位"/>
    <label>周期 <select aria-label="SCF 绘图周期" value={index} onChange={event=>chooseCycle(Number(event.target.value))}>
      {cycles.map(row => <option key={row.key} value={row.index} disabled={!row.available} title={`${row.cycle.sourceName ?? snapshot.source.name} · Line ${row.cycle.sourceLine}`}>周期 {row.index + 1}</option>)}
    </select></label>
    <EnergyPlotZero value={relative ? typeof zero === 'string' ? zero : 'point' : 'original'} selecting={selectingZero} canSelect
      pointLabel={typeof zero === 'object' && relative ? `迭代 ${zeroPoint.iteration}` : undefined}
      choices={[{ value: 'first', label: '首点', disabled: first < 0 }, { value: 'last', label: '末点', disabled: last < 0 }]}
      onChange={next => { setPickingCycle(next === 'pick' ? key : null); if (next === 'original' || next === 'first' || next === 'last') setZero(next); }}/>
  </>;
  const unitLabel = plotEnergyUnit(unit);
  return <div className={`postprocess-plot${compact ? ' is-compact' : ''}`}>
    <ScientificPlot appearanceKey={appearanceKey} figureRecord={record} resetKey={key} toolbar={toolbar}
      mcpConfiguration={{schema:objectSchema({unit:settingEnum(energyPlotUnits),cycleIndex:settingEnum(cycles.filter(row=>row.available).map(row=>row.index)),
        zero:settingEnum(['original','first','last','point']),pointIndex:{type:'integer',minimum:0}}),
        read:()=>({kind:'scf',unit,cycleIndex:index,cycles:cycles.map(row=>({index:row.index,available:row.available,sourceLine:row.cycle.sourceLine})),zero,zeroIndex}),
        apply(values){
          if(selectingZero)throw new Error('请先结束 SCF 曲线的交互式零点选择。');
          const patch=values as Partial<{unit:EnergyUnit;cycleIndex:number;zero:'original'|'first'|'last'|'point';pointIndex:number}>;
          if(patch.cycleIndex!==undefined&&patch.cycleIndex!==index){
            if(patch.unit!==undefined||patch.zero!==undefined||patch.pointIndex!==undefined)throw new Error('请先切换周期，再编辑该周期的单位和零点。');
            chooseCycle(patch.cycleIndex);return;
          }
          const zeroChoice=patch.zero??(patch.pointIndex===undefined?undefined:'point');
          if(patch.pointIndex!==undefined&&zeroChoice!=='point')throw new Error('仅点参考使用迭代序号。');
          const point=patch.pointIndex===undefined?undefined:cycle.points[patch.pointIndex];
          if(zeroChoice==='point'&&(!point||!validEnergy(point)))throw new Error('所选迭代没有可用的 SCF 能量。');
          const nextZero=zeroChoice==='point'?{sourceLine:point!.sourceLine,iteration:point!.iteration,index:patch.pointIndex!}:zeroChoice;
          if(nextZero!==undefined||patch.unit!==undefined)changeScf({...(nextZero!==undefined?{zero:nextZero}:{}),...(patch.unit!==undefined?{unit:patch.unit}:{})});
        }}}
      title="SCF Convergence" xLabel="SCF Iteration" yLabel={`${relative ? 'Relative Energy' : 'Energy'} / ${unitLabel}`}
      pointReadout={{ kind: 'Iteration', yUnit: unitLabel }} testId="scf-energy-svg"
      series={[{ id: 'scf', label: 'Energy', showPoints: true, points: cycle.points.map((point, i) => ({
        x: point.iteration, y: point.energy === null ? null : point.energy - (zeroValue ?? 0),
        index: i, readoutId: point.iteration, label: `Iteration ${point.iteration}`,
        tooltip: `${cycle.sourceName ?? snapshot.source.name} · Line ${point.sourceLine ?? cycle.sourceLine}`,
      })) }]}
      selectingZero={selectingZero} onSetZeroPoint={point => {
        if (point.index === undefined) return;
        const source = cycle.points[point.index];
        if (!source || source.energy === null) return;
        setZero({ sourceLine: source.sourceLine, iteration: source.iteration, index: point.index });
        setPickingCycle(null);
      }}
      axisTransforms={{ y: { scale: convertEnergy({ value: 1, unit: 'hartree' }, unit)!, offset: -(zeroValue ?? 0) } }}
      metadata={{ ...data, displayedIndex: index, zeroIteration: relative ? zeroPoint.iteration : undefined }}
      exportFileName={fileName} exportText={{ fileName: `${fileName}.txt`,
        text: () => postprocessPlotText(snapshot, unit, relative ? { cycleIndex: index, zeroIndex } : undefined) }}/>
  </div>;
}

function OrbitalPlot({ snapshot, compact = false, orbitalDisplayOffset = snapshot.orbitalDisplayOffset ?? 0, onSelectOrbital }: PostprocessPlotProps) {
  const adjustable = (value: number | null | undefined) => formatResultValue(value, snapshot.decimals ?? 2);
  const [index, setIndex] = useState(0), [span, setSpan] = useState(6);
  const appearanceKey = `postprocess:${snapshot.id}:${snapshot.kind}:${index}`;
  const record = usePlotFigure(appearanceKey);
  const unit:PostprocessEnergyUnit = record.figure.energy?.unit === 'hartree' ? 'hartree' : 'eV';
  const setUnit = (next:PostprocessEnergyUnit) => record.replace(previous => ({...previous, energy:{unit:next,relative:false,reference:'first'}}));
  const data = useMemo(() => postprocessPlotData(snapshot, unit), [snapshot, unit]);
  const channel = data.channels[Math.min(index, data.channels.length - 1)];
  const series = useMemo<ScientificPlotSeries[]>(() => {
    if (!channel) return [];
    const homo = channel.frontier.homo?.index;
    const frontierPosition = homo == null ? 0 : Math.max(0, channel.orbitals.findIndex(orbital => orbital.index === homo));
    return channel.orbitals.slice(Math.max(0, frontierPosition - span + 1), frontierPosition + span + 1).filter(orbital => orbital.energy != null && Number.isFinite(orbital.energy)).map((orbital, ordinal) => {
      const frontier = orbital.index === channel.frontier.homo?.index ? 'HOMO' : orbital.index === channel.frontier.lumo?.index ? 'LUMO' : '';
      const x = ordinal % 2 ? 1.6 : .1;
      const occupation = Number.isInteger(orbital.occupation) ? String(orbital.occupation) : adjustable(orbital.occupation);
      const displayIndex=orbital.index+orbitalDisplayOffset;
      const tooltip = `Orbital ${displayIndex}${frontier ? ` · ${frontier}` : ''}\nEnergy ${formatEnergyValue(orbital.energy,snapshot.decimals??2)} ${postprocessUnitLabel(unit)}\nOccupation ${occupation}`;
      return { id: `orbital-${orbital.index}`, label:`Orbital ${displayIndex}`, color: frontier ? '#c07c36' : orbital.occupation > 1e-8 ? '#2b7c83' : '#728ca8', pointLabels: true,
        points: [{ x, y: orbital.energy, index: orbital.index, readoutId:displayIndex, tooltip }, { x: x + .85, y: orbital.energy, index: orbital.index, readoutId:displayIndex, label: frontier || undefined, tooltip }] };
    });
  }, [snapshot.decimals, channel, span, unit, orbitalDisplayOffset]);
  const hasChart = series.some(line => line.points.some(point => point.y != null && Number.isFinite(point.y)));
  const toolbar = <><label>单位 <select aria-label="能级图能量单位" value={unit} onChange={event => setUnit(event.target.value as PostprocessEnergyUnit)}><option value="eV">eV</option><option value="hartree">Eh</option></select></label>
    <label>通道 <select aria-label="能级图自旋通道" value={index} onChange={event => setIndex(Number(event.target.value))}>{data.channels.map((channel, index) => <option value={index} key={index}>{channel.spin}</option>)}</select></label><label>前线两侧轨道数 <NumericInput aria-label="能级图轨道数量" stepper min={1} max={30} value={span} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 30) setSpan(value); }}/></label>
    </>;
  return <div className={`postprocess-plot ${compact ? 'is-compact' : ''}`}>
    {hasChart ? <ScientificPlot appearanceKey={appearanceKey} figureRecord={record} toolbar={toolbar} plotStyle="orbital"
      mcpConfiguration={{schema:objectSchema({unit:settingEnum(['eV','hartree']),channelIndex:settingEnum(data.channels.map((_,i)=>i)),span:{type:'integer',minimum:1,maximum:30}}),
        read:()=>({kind:'orbital-levels',unit,channelIndex:index,channels:data.channels.map(item=>item.spin),span}),
        apply(values){
          const patch=values as Partial<{unit:PostprocessEnergyUnit;channelIndex:number;span:number}>;
          if(patch.channelIndex!==undefined&&patch.channelIndex!==index&&patch.unit!==undefined)throw new Error('请先切换轨道通道，再修改该通道的能量单位。');
          if(patch.channelIndex!==undefined)setIndex(patch.channelIndex);
          if(patch.unit!==undefined)setUnit(patch.unit);
          if(patch.span!==undefined)setSpan(patch.span);
        }}}
      title={`Frontier Orbital Levels · ${channel?.spin}`} xLabel="Frontier Orbitals" yLabel={`Energy / ${postprocessUnitLabel(unit)}`} series={series}
      showXTicks={false} xDomain={[0, 3.5]} decimals={snapshot.decimals ?? 2} selectionMode="series" testId="orbital-levels-svg"
      pointReadout={{kind:'Orbital',yUnit:postprocessUnitLabel(unit)}} axisTransforms={{y:{scale:convertEnergy({value:1,unit:'hartree'},unit)!}}}
      onSelectIndex={onSelectOrbital && channel ? orbital => onSelectOrbital({ spin: channel.spin, index: orbital }) : undefined}
      resetKey={`${snapshot.id}:${unit}:${index}:${span}`} metadata={{ ...data, displayedIndex: index, frontierSpan: span }}
      exportFileName={`Ester-Studio-${snapshot.kind}-job-${snapshot.jobIndex + 1}-frame-${snapshot.frameIndex + 1}`} exportText={{ fileName: `Ester-Studio-${snapshot.kind}-job-${snapshot.jobIndex + 1}-frame-${snapshot.frameIndex + 1}.txt`, text: postprocessPlotText({ ...snapshot, orbitalDisplayOffset }, unit) }}/>
      : <><div className="postprocess-plot-controls">{toolbar}</div><p className="postprocess-empty">没有当前帧已确认归属的轨道能量。</p></>}
  </div>;
}
