import {useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import NumericInput from '../NumericInput';
import {DismissibleNotice} from '../DismissibleNotice';
import {
  histogramGradientBase, plotFonts, plotPointKey, plotSideTicks, spectrumStickColor, type PlotAxis, type PlotAxisEdits, type PlotFontRole, type PlotFontStyle, type PlotTickSide, type PlotTickDirection,
  type PlotGuide, type PlotInset, type PlotNote, type PlotPaneEdits, type PlotPosition, type PlotSeriesStyle, type PlotSpectrumSettings, type PlotStyle,
} from '../../results/scientific-plot-editing';
import type {ScientificPlotSeries, ScientificPlotViewport} from '../../results/scientific-plot';
import {plotTextInput, type PlotPresetLibrary} from './scientific-plot-figure';
import {setPlotCanvas,setPlotPointStyle,setPlotSeriesStyle} from './plot-editor-pane';

export type PlotTarget =
  | {kind: 'line'; id: string}
  | {kind: 'point'; id: string; index: number}
  | {kind: 'text' | 'guide'; id: string}
  | {kind: 'axis'; id: PlotAxis}
  | {kind: 'inset'};
export type PlotPanel = 'series' | 'axes' | 'text' | 'canvas' | 'guides' | 'inset';

export function canRemovePlotTarget(target: PlotTarget) {
  return target.kind === 'guide' || target.kind === 'inset' || target.kind === 'text' && target.id !== 'ticks';
}

export function matchesRemovedPlotTarget(active: PlotTarget, removed: PlotTarget) {
  if (removed.kind === 'inset') return true;
  if (removed.kind === 'guide' && active.kind === 'text') return active.id === `guide:${removed.id}`;
  return 'id' in active && active.kind === removed.kind && active.id === removed.id;
}

export function hasPlotSettingsTarget(target: PlotTarget, context: PlotEditorContext) {
  if (target.kind === 'guide') return context.guides.some(guide => guide.id === target.id);
  if (target.kind === 'text' && target.id.startsWith('note:')) return !!context.pane.text?.[target.id];
  if (target.kind === 'text' && target.id.startsWith('peak:')) return !!context.textDefaults[target.id];
  if (target.kind === 'text' && target.id.startsWith('guide:'))
    return context.guides.some(guide => guide.label && guide.id === target.id.slice(6));
  return true;
}

export const plotTextRoles = [
  ['title', '图标题'], ['x', 'X 轴名'], ['y', 'Y 轴名'], ['ticks', '刻度数字（X / Y）'], ['legend', '图例'], ['annotation', '帧／峰标注'],
] as const;

export interface PlotEditorContext {
  pane: PlotPaneEdits;
  style: PlotStyle;
  series: readonly ScientificPlotSeries[];
  edit(change: Partial<PlotPaneEdits>, group?: string): void;
  endEdit(): void;
  coordinates: PlotAxisEdits;
  range: ScientificPlotViewport;
  tickIntervals?: Partial<Record<PlotAxis, number>>;
  sourceValue(axis: PlotAxis, value: number): number;
  displayValue(axis: PlotAxis, value: number): number;
  stepValue(axis: PlotAxis, value: number): number;
  displayStep(axis: PlotAxis, value: number): number;
  setCoordinates(next: PlotAxisEdits, group?: string): void;
  guides: readonly PlotGuide[];
  writeGuide(guide: PlotGuide, group?: string): void;
  removeGuide(id: string): void;
  insertGuide(axis: PlotAxis): void;
  guideFont(): PlotFontStyle;
  textDefaults: Readonly<Record<string, {content: string; role: PlotFontRole; label: string; authored?: boolean}>>;
  insertText(): void;
  editText(id: string, value: Partial<PlotNote>, group?: string): void;
  removeText(id: string): void;
  seriesStyle(id: string): PlotSeriesStyle;
  resetLayout(): void;
  showLegend: boolean;
  canAnnotate: boolean;
  hasZero: boolean;
  rangeName?: string;
  scatterOpacity?: number;
  xSamplingControls?: ReactNode;
  spectrum?: { hasSticks:boolean };
}

export function PlotNumber({label, value, onChange, min, max, step = .5, placeholder, disabled}: {
  label: string; value: number | string; onChange(value: number): void; min?: number; max?: number;
  step?: number | 'any'; placeholder?: string; disabled?: boolean;
}) {
  return <label>{label}<NumericInput aria-label={label} value={value} min={min} max={max} step={step} stepper={step !== 'any'} placeholder={placeholder} disabled={disabled}
    onChange={event => {
      const text = event.target.value, number = Number(text);
      if (text.trim() && Number.isFinite(number) && (min === undefined || number >= min) && (max === undefined || number <= max)) onChange(number);
    }}/></label>;
}

function Color({label, value, onChange}: {label: string; value: string; onChange(value: string): void}) {
  return <label>{label}<input aria-label={label} type="color" value={value} onChange={event => onChange(event.target.value)}/></label>;
}

function Check({label, checked, onChange,disabled}: {label: string; checked: boolean; onChange(value: boolean): void; disabled?:boolean}) {
  return <label className="plot-edit-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/>{label}</label>;
}

function Options<T extends string>({label, value, values, onChange, disabled}: {
  label: string; value: T; values: readonly (readonly [T, string])[]; onChange(value: T): void; disabled?: boolean;
}) {
  return <label>{label}<select aria-label={label} value={value} onChange={event => onChange(event.target.value as T)} disabled={disabled}>
    {values.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
  </select></label>;
}

function Trash({label, onClick}: {label: string; onClick(): void}) {
  return <button type="button" className="plot-edit-trash" title={label} aria-label={label} onClick={onClick}>
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25">
      <path d="M2 4h12 M6 4V2h4v2 M4 4l1 10h6l1-10 M7 6v5 M9 6v5"/>
    </svg>
  </button>;
}

const dashChoices = [['solid', '实线'], ['dash', '虚线'], ['dot', '点线'], ['dash-dot', '点划线']] as const;
const markerChoices = [['circle', '圆形'], ['square', '方形'], ['triangle', '三角形'], ['diamond', '菱形'], ['cross', '十字']] as const;

function HistogramFields({context,line,edit}:{context:PlotEditorContext;line:PlotSeriesStyle;
  edit(patch:Partial<PlotSeriesStyle>,group?:string):void;
}) {
  return <>
    <div className="plot-edit-fields">
      <Options label="柱形填充" value={line.fill} values={ [['solid','实色'],['none','空心'],['gradient','渐变']] }
        onChange={fill => edit({fill})}/>
      {line.fill==='solid'&&<Color label="填色" value={line.barFillColor??line.color} onChange={barFillColor=>edit({barFillColor},'bar-fill')}/>}
      <Color label="描边色" value={line.color} onChange={color=>edit({color},'bar-outline')}/>
      <PlotNumber label="描边 / pt" value={line.width} min={0} step={.1} onChange={width=>edit({width},'bar-outline-width')}/>
      <PlotNumber label="不透明度 / %" value={line.opacity*100} min={0} max={100} step={1}
        onChange={value=>edit({opacity:value/100},'bar-opacity')}/>
      <Check label="显示图例" checked={context.showLegend} onChange={showLegend=>context.edit({showLegend})}/>
    </div>
    {line.fill==='gradient'&&<div className="plot-edit-section"><strong>渐变颜色</strong><div className="plot-edit-fields">
      <Color label="底色" value={line.barGradient?.base??histogramGradientBase} onChange={base=>edit({barGradient:{base}},'bar-gradient-base')}/>
      <Color label="顶色" value={line.barFillColor??line.color} onChange={barFillColor=>edit({barFillColor},'bar-fill')}/>
    </div></div>}
  </>;
}

function SeriesFields({context, target, focused = false}: {context: PlotEditorContext; target?: PlotTarget; focused?: boolean}) {
  const primary = context.series[0]?.id;
  const [series, setSeries] = useState(target?.kind === 'line' || target?.kind === 'point' ? target.id : primary);
  const [single, setSingle] = useState(false);
  const active = context.series.some(line => line.id === series) ? series! : primary;
  if (!active) return null;
  const activeSeries = context.series.find(item => item.id === active);
  const discrete = !!activeSeries?.pointLabels;
  const line = context.seriesStyle(active);
  const pointTarget = target?.kind === 'point' && !discrete;
  const selectedPoint = pointTarget ? plotPointKey(target.id, target.index) : undefined;
  const point = single && selectedPoint ? context.pane.points?.[selectedPoint] ?? line.point : line.point;
  const setLine = (patch: Partial<PlotSeriesStyle>, group?: string) => setPlotSeriesStyle(context,active,patch,group);
  const setPoint = (patch: Partial<typeof point>, group?: string) => setPlotPointStyle(context,active,patch,single?selectedPoint:undefined,group);
  const selector=!focused&&context.series.length>1&&<Options label="系列" value={active}
    values={context.series.map(line=>[line.id,line.label??line.id])} onChange={setSeries}/>;
  const hasBins = context.series.some(series=>series.kind==='histogram');
  if (activeSeries?.kind === 'histogram') {
    return <>{selector}<HistogramFields context={context} line={line} edit={setLine}/></>;
  }
  const sticks=context.spectrum?.hasSticks&&<div className="plot-edit-fields">
    <Color label="棒谱颜色" value={spectrumStickColor(context.style,context.pane)}
      onChange={stickColor=>context.edit({style:{...context.style,stickColor}},'stick-color')}/>
    {context.style.stickColor&&<button type="button" onClick={()=>context.edit({style:{...context.style,stickColor:undefined}})}>跟随包络色</button>}
  </div>;
  if(context.spectrum&&active==='spectrum-sticks')return <>{selector}{sticks}</>;
  return <>
    {selector}
    {!pointTarget && context.scatterOpacity === undefined && <div className="plot-edit-fields">
      <Color label="线色" value={line.color} onChange={color => setLine({color})}/>
      <PlotNumber label="线宽 / pt" value={line.width} min={.1} step={.25} onChange={width => setLine({width}, 'line-width')}/>
      <Options label="线型" value={line.dash} values={dashChoices} onChange={dash => setLine({dash})}/>
      <Check label="显示曲线" checked={!line.hidden} onChange={shown => setLine({hidden: !shown})}/>
      <Options label="曲线填色" value={line.fill} values={ [['none', '无'], ['solid', '浅填色'], ['gradient', '渐变填色']] } onChange={fill => setLine({fill})}/>
      {line.fill !== 'none' && <PlotNumber label="填色不透明度 / %" value={line.opacity * 100} min={0} max={100} step={1} onChange={value => setLine({opacity: value / 100}, 'fill-opacity')}/>}
      {!discrete && <Check label="显示图例" checked={context.showLegend} onChange={showLegend => context.edit({showLegend})}/>}
    </div>}
    {!context.spectrum&&!hasBins&&!discrete&&target?.kind !== 'line' && <>
      {selectedPoint
        ? <Options label="点样式作用于" value={single ? 'point' : 'series'} values={ [['series', '当前系列'], ['point', '仅此点']] } onChange={value => setSingle(value === 'point')}/>
        : context.scatterOpacity === undefined && <Check label="显示点" checked={line.points} onChange={points => setLine({points})}/>}
      <div className="plot-edit-fields">
        <Options label="点形" value={point.marker} values={markerChoices} onChange={marker => setPoint({marker})}/>
        <PlotNumber label="点大小 / pt" value={point.size} min={.1} onChange={size => setPoint({size}, 'point-size')}/>
        <Options label="点填充" value={point.hollow ? 'hollow' : 'solid'} values={ [['hollow', '空心'], ['solid', '实心']] } onChange={value => setPoint({hollow: value === 'hollow'})}/>
        <PlotNumber label="描边宽 / pt" value={point.edgeWidth} min={0} step={.25} onChange={edgeWidth => setPoint({edgeWidth}, 'point-edge')}/>
        <Color label="描边色" value={point.edgeColor} onChange={edgeColor => setPoint({edgeColor})}/>
        <Color label="填充色" value={point.fillColor} onChange={fillColor => setPoint({fillColor})}/>
        {context.scatterOpacity !== undefined && <PlotNumber label="点不透明度 / %" min={1} max={100} step={1}
          value={Math.round(context.scatterOpacity * 100)}
          onChange={value => context.edit({style:{...context.style,scatterOpacity:value/100}},'scatter-opacity')}/>}
      </div>
      {single && selectedPoint && context.pane.points?.[selectedPoint] && <button type="button" onClick={() => {
        const points = {...context.pane.points}; delete points[selectedPoint]; context.edit({points});
      }}>恢复系列点样式</button>}
    </>}
    {!focused&&sticks}
  </>;
}

function AxisTickInterval({context, axis}: {context: PlotEditorContext; axis: PlotAxis}) {
  const name = axis.toUpperCase(), settings = context.coordinates[axis];
  const current = settings?.step === undefined ? '' : context.displayStep(axis, settings.step);
  const automatic = context.tickIntervals?.[axis];
  const [draft, setDraft] = useState<string>();
  const apply = (step?: number) => context.setCoordinates({...context.coordinates, [axis]: {...settings, step}},
    step === undefined ? undefined : `tick-step-${axis}`);
  const label = `${name} 主刻度间隔`;
  return <>
    <label>{label}<NumericInput aria-label={label} step="any" min={Number.MIN_VALUE} value={draft ?? current}
      placeholder={automatic ? `自动 · ${Number(automatic.toPrecision(7))}` : '自动'}
      aria-invalid={!!draft?.trim() && !(Number.isFinite(Number(draft)) && Number(draft) > 0)}
      onChange={event => {
        const value = event.currentTarget.value, number = Number(value);
        setDraft(value);
        if (Number.isFinite(number) && number > 0) apply(context.stepValue(axis, number));
      }}
      onBlur={() => setDraft(undefined)}
      onKeyDown={event => {if (event.key === 'Enter') event.currentTarget.blur();}}/></label>
    <button type="button" aria-label={`${name} 恢复自动刻度`} disabled={settings?.step === undefined}
      onClick={() => {setDraft(undefined); apply();}}>恢复自动</button>
  </>;
}

function AxisFields({context, axis, heading = false}: {context: PlotEditorContext; axis: PlotAxis; heading?: boolean}) {
  const name = axis.toUpperCase(), settings = context.coordinates[axis];
  const bounds = context.range[axis];
  const [draft, setDraft] = useState<[string, string]>([String(bounds[0]), String(bounds[1])]);
  useEffect(() => setDraft([String(bounds[0]), String(bounds[1])]), [bounds[0], bounds[1]]);
  const valid = draft.every(text => text.trim() !== '' && Number.isFinite(Number(text))) && Number(draft[0]) < Number(draft[1]);
  function commit(index: 0 | 1, value: string) {
    const next: [string, string] = [...draft];
    next[index] = value; setDraft(next);
    const [lo, hi] = next.map(Number);
    if (!next.every(text => text.trim() && Number.isFinite(Number(text))) || lo >= hi) return;
    const a = context.sourceValue(axis, lo), b = context.sourceValue(axis, hi);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
      context.setCoordinates({...context.coordinates, [axis]: {...settings, bounds: a < b ? [a, b] : [b, a]}}, `axis-${axis}-${index}`);
    }
  }
  return <div className="plot-edit-section">
    {heading && <strong>{name} 轴</strong>}
    <Check label={`${name} 轴自动范围`} checked={!settings?.bounds}
      onChange={auto => context.setCoordinates({...context.coordinates, [axis]: {...settings, bounds: auto ? undefined
        : bounds.map(value => context.sourceValue(axis, value)).sort((a, b) => a - b) as [number, number]}})}/>
    <div className="plot-edit-fields">
      {([0, 1] as const).map(index => <label key={index}>{name} {index ? '上限' : '下限'}<NumericInput step="any" value={draft[index]} aria-invalid={!valid}
        aria-label={`${name} 轴${index ? '上限' : '下限'}`} onChange={event => commit(index, event.target.value)}/></label>)}
      <AxisTickInterval context={context} axis={axis}/>
      <PlotNumber label={`${name} 轴次刻度数量`} value={axis === 'x' ? context.style.axis.xMinor : context.style.axis.yMinor} min={0} max={12} step={1}
        onChange={value => context.edit({style: {...context.style, axis: {...context.style.axis, [axis === 'x' ? 'xMinor' : 'yMinor']: Math.round(value)}}}, `tick-minor-${axis}`)}/>
      <Options label={`${name} 刻度数字`} value={context.style.axis.tickNumbers?.[axis]??'auto'}
        values={ [['auto','自动精简'],['integer','整数刻度']] }
        onChange={mode=>context.edit({style:{...context.style,axis:{...context.style.axis,
          tickNumbers:{...context.style.axis.tickNumbers,[axis]:mode}}}})}/>
    </div>
  </div>;
}

const tickSideLabels:Record<PlotTickSide,string>={left:'左边',bottom:'下边',right:'右边',top:'上边'};
const tickDirections:readonly (readonly [PlotTickDirection,string])[]=[['off','关闭'],['in','向内'],['out','向外'],['both','双向']];
function Axes({context, axis}: {context: PlotEditorContext; axis?: PlotAxis}) {
  const current = context.style.axis;
  const update = (patch: Partial<typeof current>, group?: string) => context.edit({style: {...context.style, axis: {...current, ...patch}}}, group);
  return <>
    {axis==='y'?<AxisFields context={context} axis="y"/>:<>
      <AxisFields context={context} axis="x"/>{context.xSamplingControls}
      {!axis&&<AxisFields context={context} axis="y"/>}
    </>}
    <div className="plot-edit-fields">
      <Color label="轴线颜色" value={current.color} onChange={color => update({color})}/>
      <PlotNumber label="轴线宽 / pt" value={current.width} min={.1} step={.25} onChange={width => update({width}, 'axis-width')}/>
      <Options label="轴框" value={current.frame} values={ [['full', '四边'], ['axes', '左轴与下轴']] } onChange={frame => update({frame})}/>
      <Options label="自动刻度密度" value={current.density} values={ [['sparse', '疏'], ['standard', '标准'], ['dense', '密']] } onChange={density => update({density})}/>
    </div>
    <div className="plot-edit-section"><strong>四边刻度</strong>
      <div className="plot-edit-fields">{(['left','bottom','right','top'] as const).map(side=>{
        const label=tickSideLabels[side], value=plotSideTicks(current,side,!!context.textDefaults['secondary-y']);
        const change=(patch:Partial<typeof value>)=>update({tickSides:{...current.tickSides,[side]:{...value,...patch}}});
        return <div key={side}>
          <Options label={`${label}刻度`} value={value.direction} values={tickDirections} onChange={direction=>change({direction})}/>
          <Check label={`${label}数字`} checked={value.labels} disabled={value.direction==='off'} onChange={labels=>change({labels})}/>
        </div>;
      })}</div>
    </div>
  </>;
}

function FontFields({font, onChange}: {font: PlotFontStyle; onChange(value: Partial<PlotFontStyle>, group?: string): void}) {
  return <div className="plot-edit-font">
    <Options label="字体" value={font.font} values={plotFonts.map(name => [name, name])} onChange={value => onChange({font: value})}/>
    <PlotNumber label="字号 / pt" value={font.size} min={1} onChange={size => onChange({size}, 'font-size')}/>
    <button type="button" aria-label="粗体" aria-pressed={font.bold} onClick={() => onChange({bold: !font.bold})}><strong>B</strong></button>
    <button type="button" aria-label="斜体" aria-pressed={font.italic} onClick={() => onChange({italic: !font.italic})}><i>I</i></button>
  </div>;
}

function TextFields({context, id, allowContent = false, focusContent = false}: {
  context: PlotEditorContext; id: string; allowContent?: boolean; focusContent?: boolean;
}) {
  const fallback = context.textDefaults[id], guide = id.startsWith('guide:')
    ? context.guides.find(item => item.id === id.slice(6)) : undefined;
  const note = (guide ? guide.label : context.pane.text?.[id]) ?? {};
  const role = fallback?.role ?? 'annotation', font = {...context.style.fonts[role], ...note.font};
  const update = (change: Partial<PlotNote>, group?: string) => context.editText(id, change, group && `text-${id}-${group}`);
  return <>
    {allowContent && id !== 'ticks' && id !== 'legend' && id !== 'annotation' &&
      <label>文字内容<input aria-label="文字内容" autoFocus={focusContent} value={note.content ?? fallback?.content ?? ''}
        onChange={event => update({content: event.target.value}, 'content')}/></label>}
    <FontFields font={font} onChange={(changes, group) => update({font: {...note.font, ...changes}}, group)}/>
    {id !== 'ticks' && !allowContent && <details className="plot-edit-position"><summary>位置</summary><div className="plot-edit-fields">
      <PlotNumber label="X 偏移 / %" value={Math.round((note.position?.x ?? 0) * 1000) / 10} step={.5} onChange={value => update({position: {x: value / 100, y: note.position?.y ?? 0}}, 'x')}/>
      <PlotNumber label="Y 偏移 / %" value={Math.round((note.position?.y ?? 0) * 1000) / 10} step={.5} onChange={value => update({position: {x: note.position?.x ?? 0, y: value / 100}}, 'y')}/>
      <button type="button" onClick={() => update({position: undefined})}>恢复位置</button>
    </div></details>}
  </>;
}

function TextList({context}: {context: PlotEditorContext}) {
  const entries = [
    ...plotTextRoles.filter(([id]) => id === 'ticks' ? Boolean(context.textDefaults.x || context.textDefaults.y)
      : !!context.textDefaults[id] && (id !== 'annotation' || context.canAnnotate)),
    ...Object.entries(context.textDefaults).filter(([id]) => id.startsWith('peak:') || id.startsWith('legend:')).map(([id, value]) => [id, value.label] as const),
    ...Object.entries(context.pane.text ?? {}).filter(([id]) => id.startsWith('note:')).map(([id, value]) => [id, value.content || '文字'] as const),
    ...context.guides.flatMap(guide => guide.label ? [[`guide:${guide.id}`, `${guide.axis.toUpperCase()} = ${Number(context.displayValue(guide.axis, guide.value).toPrecision(8))} · 标签`] as const] : []),
  ];
  return <><div className="plot-edit-section">{entries.map(([id, label]) => {
    const deletable = id.startsWith('note:') || id.startsWith('guide:') || context.textDefaults[id]?.authored;
    const shown = id === 'legend' ? context.showLegend : id === 'annotation'
      ? (context.pane.text?.annotation?.hidden === undefined ? context.style.showAnnotation : !context.pane.text.annotation.hidden)
      : !context.pane.text?.[id]?.hidden;
    return <div key={id} className="plot-edit-item"><details><summary>{label}</summary>
      <TextFields context={context} id={id}/></details>
      <div className="plot-edit-item-action">{deletable
        ? <Trash label={`删除${label}`} onClick={() => context.removeText(id)}/>
        : id === 'ticks' ? <span>固定显示</span>
          : <Check label="显示" checked={shown} onChange={visible => id === 'legend'
            ? context.edit({showLegend: visible}) : context.editText(id, {hidden: !visible})}/>}</div>
    </div>;
  })}</div><button type="button" onClick={context.insertText}>＋ 插入文字</button></>;
}

function GuideFields({context, guide, deleteLabel = true}: {context: PlotEditorContext; guide: PlotGuide; deleteLabel?: boolean}) {
  const stroke = {...context.style.guide, ...guide.stroke};
  const value = guide.followsZero ? 0 : context.displayValue(guide.axis, guide.value);
  const writeStroke = (patch: Partial<typeof stroke>, group?: string) => context.writeGuide({...guide, stroke: {...stroke, ...patch}}, group);
  return <><div className="plot-edit-fields">
    <PlotNumber label={`${guide.axis.toUpperCase()} 值`} value={value} step="any"
      onChange={number => context.writeGuide({...guide, value: context.sourceValue(guide.axis, number), followsZero: false}, `guide-value-${guide.id}`)}/>
    <PlotNumber label="线宽 / pt" value={stroke.width} min={.1} step={.25} onChange={width => writeStroke({width}, `guide-width-${guide.id}`)}/>
    <Color label="颜色" value={stroke.color} onChange={color => writeStroke({color})}/>
    <Options label="线型" value={stroke.dash} values={dashChoices} onChange={dash => writeStroke({dash})}/>
  </div>
    {guide.label ? <><label>标签<input aria-label="参考线标签" placeholder={`${guide.axis} = ${value}`} value={guide.label.content ?? ''} onChange={event => context.editText(`guide:${guide.id}`, {content: event.target.value}, `guide-text-${guide.id}`)}/></label>
      {deleteLabel && <Trash label="删除参考线标签" onClick={() => context.removeText(`guide:${guide.id}`)}/>}</>
      : <button type="button" onClick={() => context.editText(`guide:${guide.id}`, {font: context.guideFont()})}>添加标签</button>}
  </>;
}

function Guides({context}: {context: PlotEditorContext}) {
  const sample = context.style.guide;
  const update = (patch: Partial<typeof sample>, group?: string) => context.edit({style: {...context.style, guide: {...sample, ...patch}}}, group);
  return <>
    <div className="plot-edit-actions"><button type="button" onClick={() => context.insertGuide('y')}>添加横线</button>
      <button type="button" onClick={() => context.insertGuide('x')}>添加竖线</button></div>
    {context.guides.map(guide => <div key={guide.id} className="plot-edit-item"><details>
      <summary>{guide.axis.toUpperCase()} = {guide.followsZero ? 0 : Number(context.displayValue(guide.axis, guide.value).toPrecision(8))}</summary>
      <GuideFields context={context} guide={guide}/></details>
      <div className="plot-edit-item-action"><Trash label="删除参考线" onClick={() => context.removeGuide(guide.id)}/></div>
    </div>)}
    <details><summary>新建参考线的样式</summary><div className="plot-edit-fields">
      <Color label="颜色" value={sample.color} onChange={color => update({color})}/>
      <PlotNumber label="线宽 / pt" value={sample.width} min={.1} step={.25} onChange={width => update({width}, 'guide-style-width')}/>
      <Options label="线型" value={sample.dash} values={dashChoices} onChange={dash => update({dash})}/>
    </div></details>
    <Check label="显示零线" checked={context.hasZero} onChange={showZero => context.edit({showZero})}/>
    <Check label="显示图例" checked={context.showLegend} onChange={showLegend => context.edit({showLegend})}/>
  </>;
}

function Canvas({context}: {context: PlotEditorContext}) {
  const current = context.style.canvas;
  function dimension(axis: 'width' | 'height', value: number) {
    setPlotCanvas(context,{[axis]:value},`canvas-${axis}`);
  }
  return <><div className="plot-edit-fields">
    <PlotNumber label="画布宽度 / mm" value={current.width} min={.1} onChange={value => dimension('width', value)}/>
    <PlotNumber label="画布高度 / mm" value={current.height} min={.1} onChange={value => dimension('height', value)}/>
    <Check label="锁定比例" checked={current.locked} onChange={locked=>setPlotCanvas(context,{locked})}/>
  </div><button type="button" onClick={context.resetLayout}>恢复布局</button></>;
}

export interface InsetInspector {
  inset?: PlotInset;
  fwhmUnit: string;
  settings?: PlotSpectrumSettings;
  create(): void;
  remove(): void;
  change(value: Partial<PlotInset>, group?: string): void;
}

function InsetFields({context, editor, deleteInset = true}: {context: PlotEditorContext; editor: InsetInspector; deleteInset?: boolean}) {
  if (!editor.inset) return <button type="button" onClick={editor.create}>框选副图区域</button>;
  const inset = editor.inset, spectrum = inset.spectrum ?? editor.settings;
  return <>
    <div className="plot-edit-fields">{([['x', '左侧'], ['y', '顶部'], ['width', '宽度'], ['height', '高度']] as const)
      .map(([key, label]) => <PlotNumber key={key} label={`${label} / %`} value={Math.round(inset.box[key] * 1000) / 10} min={0} max={100}
        onChange={value => editor.change({box: {...inset.box, [key]: value / 100}}, `inset-${key}`)}/>)}</div>
    <AxisFields context={context} axis="x" heading/><AxisFields context={context} axis="y" heading/>
    {spectrum && <><Options label="谱图参数" value={inset.spectrum ? 'local' : 'linked'} values={ [['linked', '跟随主图'], ['local', '独立设置']] }
      onChange={mode => editor.change({spectrum: mode === 'local' ? spectrum : undefined})}/>
      {inset.spectrum && <div className="plot-edit-fields">
        <PlotNumber label={`副图 FWHM / ${editor.fwhmUnit}`} value={spectrum.fwhm} min={Number.MIN_VALUE} step={editor.fwhmUnit === 'eV' ? .01 : 1}
          onChange={fwhm => editor.change({spectrum: {...spectrum, fwhm}}, 'inset-fwhm')}/>
        <Options label="峰形" value={spectrum.peakShape} values={ [['gaussian', 'Gaussian'], ['lorentzian', 'Lorentzian']] }
          onChange={peakShape => editor.change({spectrum: {...spectrum, peakShape}})}/>
        <Check label="归一化" checked={spectrum.normalize} onChange={normalize => editor.change({spectrum: {...spectrum, normalize}})}/>
      </div>}
    </>}
    {deleteInset && <Trash label="删除副图" onClick={editor.remove}/>}
  </>;
}

export function PlotInspector({panel, context, target, inset}: {panel: PlotPanel; context: PlotEditorContext; target?: PlotTarget; inset?: InsetInspector}) {
  return <div className="plot-edit-inspector" onBlur={event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) context.endEdit();
  }}>
    {panel === 'series' && <SeriesFields key={target?.kind === 'point' ? `${target.id}:${target.index}` : target?.kind === 'line' ? target.id : 'series'} context={context} target={target}/>}
    {panel === 'axes' && <Axes context={context}/>}
    {panel === 'text' && (target?.kind === 'text'
      ? <><TextFields context={context} id={target.id} allowContent/>
        {canRemovePlotTarget(target) && <Trash label="删除文字" onClick={() => context.removeText(target.id)}/>}</>
      : <TextList context={context}/>)}
    {panel === 'canvas' && <Canvas context={context}/>}
    {panel === 'guides' && <Guides context={context}/>}
    {panel === 'inset' && inset && <InsetFields context={context} editor={inset}/>}
  </div>;
}

export function PlotQuickPopover({title, anchor, onClose, endEdit, actions, remove, children, hasPlotPointAt}: {
  title: string; anchor: PlotPosition; onClose(): void; endEdit?(): void; actions?: ReactNode;
  hasPlotPointAt?(clientX:number,clientY:number):boolean;
  remove?(): void; children: ReactNode;
}) {
  const id = useId(), node = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const [layer, setLayer] = useState<HTMLElement|null>(null);
  const drag = useRef<{id: number; x: number; y: number; startX:number; startY:number} | null>(null);
  const moved = useRef(false);
  const current = useRef({onClose,hasPlotPointAt});
  current.current = {onClose,hasPlotPointAt};
  const [position, setPosition] = useState<PlotPosition>({x: 4, y: 4});

  useLayoutEffect(() => {
    const anchor = marker.current;
    // Keep viewport positioning outside the Settings backdrop-filter and overflow.
    setLayer(anchor?.closest('.sy-settings-panel') ? anchor.ownerDocument.body : null);
  }, []);

  function fit(wanted: PlotPosition): PlotPosition {
    const panel = node.current;
    if (!panel) return wanted;
    const viewport = panel.ownerDocument.documentElement;
    return {
      x: Math.max(4, Math.min(wanted.x, viewport.clientWidth - panel.offsetWidth - 4)),
      y: Math.max(4, Math.min(wanted.y, viewport.clientHeight - panel.offsetHeight - 4)),
    };
  }

  useLayoutEffect(() => {
    const panel = node.current, stage = marker.current?.parentElement;
    if (!panel || !stage) return;
    moved.current = false;
    drag.current = null;
    const origin = stage.getBoundingClientRect(), y = origin.top + anchor.y;
    const below = y + 10, above = y - panel.offsetHeight - 10;
    const viewport = panel.ownerDocument.documentElement;
    setPosition(fit({x: origin.left + anchor.x + 8, y: below + panel.offsetHeight > viewport.clientHeight - 4 && above >= 4 ? above : below}));
    if (!panel.contains(panel.ownerDocument.activeElement)) panel.focus({preventScroll: true});
    const Observer = panel.ownerDocument.defaultView?.ResizeObserver;
    const observer = Observer && new Observer(() => setPosition(previous => {
      const next = fit(previous);
      return next.x === previous.x && next.y === previous.y ? previous : next;
    }));
    observer?.observe(viewport);
    observer?.observe(panel);
    return () => observer?.disconnect();
  }, [anchor, layer]);

  useEffect(() => {
    const panel = node.current;
    if (!panel) return;
    const owner = panel.ownerDocument;
    let blank: {id:number; x:number; y:number} | undefined;
    const down = (event: globalThis.PointerEvent) => {
      blank = undefined;
      const target = event.target as Element | null;
      if (event.button !== 0 || moved.current || panel.contains(target)) return;
      if (target?.closest('button, input, select, textarea, label, summary, a[href], [role="button"], [contenteditable="true"], .plot-edit-popover, .scatter-color-scale, [data-plot-hit]:not([data-plot-hit="paper"]), [data-plot-interaction="layout"]')) return;
      const {clientX,clientY,pointerId} = event;
      if (target?.closest('[data-plot-hit="paper"]') && current.current.hasPlotPointAt?.(clientX,clientY)) return;
      blank = {id:pointerId,x:clientX,y:clientY};
    };
    const up = (event: globalThis.PointerEvent) => {
      const click = blank;
      blank = undefined;
      if (click && click.id === event.pointerId && !moved.current &&
          Math.hypot(event.clientX-click.x,event.clientY-click.y) < 4) current.current.onClose();
    };
    owner.addEventListener('pointerdown',down,true);
    owner.addEventListener('pointerup',up,true);
    return () => {
      owner.removeEventListener('pointerdown',down,true);
      owner.removeEventListener('pointerup',up,true);
    };
  }, [anchor, layer]);

  function start(event: PointerEvent<HTMLElement>) {
    const panel = node.current;
    if (event.button !== 0 || !panel || (event.target as Element).closest('button')) return;
    event.preventDefault();
    const bounds = panel.getBoundingClientRect();
    drag.current = {id: event.pointerId, x: event.clientX - bounds.left, y: event.clientY - bounds.top,
      startX:event.clientX,startY:event.clientY};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const active = drag.current;
    if (active?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX-active.startX,event.clientY-active.startY) >= 4) moved.current = true;
    if (moved.current) setPosition(fit({x: event.clientX - active.x, y: event.clientY - active.y}));
  }
  function stop(event: PointerEvent<HTMLElement>) {
    if (drag.current?.id === event.pointerId) drag.current = null;
  }

  const popover = <div ref={node} className="plot-edit-popover ui-control-surface" data-settings-layer={layer ? true : undefined} role="dialog" tabIndex={-1}
    aria-labelledby={id} style={{left: position.x, top: position.y}}
    onBlur={event => {
      if (event.target.matches('input, select')) endEdit?.();
    }}
    onKeyDown={event => {
      if (event.key === 'Escape') event.stopPropagation();
      if (remove && !plotTextInput(event.target) && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault(); event.stopPropagation(); remove();
      }
    }}>
    <header onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}>
      <strong id={id}>{title}</strong><button type="button" aria-label="关闭快捷设置" onClick={onClose}>×</button>
    </header>
    <div className="plot-edit-popover-body">{children}</div>
    {(actions || remove) && <footer className="plot-edit-popover-actions">{actions}
      {remove && <Trash label={`删除${title}`} onClick={remove}/>}</footer>}
  </div>;
  return <><span ref={marker} hidden />{layer ? createPortal(popover, layer) : popover}</>;
}

export function PlotQuickControls({target, context, anchor, onClose, onSetZero, onAnnotate, inset, remove, editText, hasPlotPointAt}: {
  target: PlotTarget; context: PlotEditorContext; anchor: PlotPosition; onClose(): void; onSetZero?(): void;
  hasPlotPointAt?(clientX:number,clientY:number):boolean;
  onAnnotate?(): void; inset?: InsetInspector; remove?(): void; editText?: boolean;
}) {
  const [content, setContent] = useState(!!editText);
  const guide = target.kind === 'guide' ? context.guides.find(item => item.id === target.id) : undefined;
  const bar = (target.kind === 'line' || target.kind === 'point') && context.series.find(line => line.id === target.id)?.kind === 'histogram';
  const title = bar ? '柱形' : target.kind === 'line' ? '曲线' : target.kind === 'point' ? '数据点' : target.kind === 'guide'
    ? '参考线' : target.kind === 'axis' ? `${target.id.toUpperCase()} 轴` : target.kind === 'inset' ? '副图' : context.textDefaults[target.id]?.label ?? '文字';
  return <PlotQuickPopover title={title} anchor={anchor} onClose={onClose} endEdit={context.endEdit} remove={remove} hasPlotPointAt={hasPlotPointAt}
    actions={(onSetZero || onAnnotate) && <div className="plot-edit-actions">
      {onSetZero && <button type="button" onClick={onSetZero}>设为零点</button>}
      {onAnnotate && <button type="button" onClick={onAnnotate}>添加峰标注</button>}
    </div>}>
    {target.kind === 'line' || target.kind === 'point' ? <SeriesFields context={context} target={target} focused/>
      : target.kind === 'axis' ? <Axes context={context} axis={target.id}/>
        : target.kind === 'text' ? <><TextFields context={context} id={target.id} allowContent={content} focusContent={content}/>
          {!content && target.id !== 'ticks' && target.id !== 'legend' && target.id !== 'annotation' &&
            <button type="button" onClick={() => setContent(true)}>编辑文字</button>}</>
          : guide ? <GuideFields context={context} guide={guide} deleteLabel={false}/>
            : inset ? <InsetFields context={context} editor={inset} deleteInset={false}/> : null}
  </PlotQuickPopover>;
}

const presetLabels: Record<PlotPresetLibrary['family'], string> = {
  line: '点线图预设',
  spectrum: '光谱图预设',
  histogram: '柱状图预设',
  scatter: '散点图预设',
  fingerprint: 'Hirshfeld 指纹图预设',
  orbital: '轨道能级图预设',
  contact: 'Hirshfeld 接触贡献图预设',
};

export function PlotPresetControls({library, active, onChoose, style, compact = false}: {
  library: PlotPresetLibrary; active?: string; onChoose(id: string, saved?: PlotStyle): void; style: PlotStyle; compact?: boolean;
}) {
  const [name, setName] = useState<string>(), [error, setError] = useState('');
  const items = [...library.builtins, ...library.personal];
  const chosen = items.find(preset => preset.id === (active ?? library.defaultId))?.id ?? items[0]?.id;
  function action(run: () => void) {
    try { run(); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <div className="plot-edit-presets">
    <select aria-label={presetLabels[library.family]} title="选择预设" value={chosen} onFocus={library.reload}
      onChange={event => {const id = event.target.value; if (id === 'save-as') setName(''); else onChoose(id);}}>
      <optgroup label="内置">{library.builtins.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</optgroup>
      {library.personal.length > 0 && <optgroup label="我的预设">{library.personal.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</optgroup>}
      {compact && <option value="save-as">另存为我的预设…</option>}
    </select>
    {!compact && <><button type="button" onClick={() => setName('')}>另存为我的预设</button>
      <button type="button" disabled={!chosen} onClick={() => chosen && action(() => library.makeDefault(chosen))}>设为此类图默认</button>
      <button type="button" onClick={() => onChoose(library.defaultId)}>恢复此类默认</button></>}
    {name !== undefined && <div className="plot-edit-actions"><input aria-label="预设名称" value={name} onChange={event => setName(event.target.value)}/>
      <button type="button" onClick={() => action(() => { const id = library.save(name, style); onChoose(id, style); setName(undefined); })}>保存</button>
      <button type="button" onClick={() => setName(undefined)}>取消</button></div>}
    {error && <DismissibleNotice role="alert">{error}</DismissibleNotice>}
  </div>;
}

export function PlotEditorToolbar({data, library, active, style, onChoose, onAdvanced}: {
  data?:ReactNode; library:PlotPresetLibrary; active?:string; style:PlotStyle;
  onChoose(id:string, style?:PlotStyle):void; onAdvanced():void;
}) {
  return <div className="plot-edit-toolbar" aria-label="数据与显示">
    {data&&<div className="optimization-plot-options scientific-plot-tools scientific-plot-data-controls">{data}</div>}
    <div className="plot-edit-toolbar-actions">
      <PlotPresetControls library={library} active={active} style={style} onChoose={onChoose} compact/>
      <button type="button" className="plot-edit-primary" onClick={onAdvanced}>高级绘图设置</button>
    </div>
  </div>;
}

export const plotPanels: readonly (readonly [PlotPanel, ReactNode])[] = [
  ['series', '线与点'], ['axes', '坐标轴'], ['text', '文字'], ['canvas', '画布'], ['guides', '标记'],
];
