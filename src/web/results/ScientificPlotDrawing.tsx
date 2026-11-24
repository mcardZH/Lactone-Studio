import {memo, type SVGProps} from 'react';
import {scientificPlotLayout} from '../../results/scientific-plot-layout';
import {editedPlotTicks, histogramGradientBase, plotDashArray, plotPointKey, plotSideTicks, spectrumStickColor, type PlotFontRole, type PlotGuide, type PlotNote, type PlotPaneEdits, type PlotPointStyle, type PlotPosition, type PlotStyle, type PlotTickSide} from '../../results/scientific-plot-editing';
import {formatPlotTick, plotDataBounds, plotTicks, scientificPlotPaths, type ScientificPlotPoint, type ScientificPlotSeries, type ScientificPlotViewport} from '../../results/scientific-plot';
import {decimalEnergyValue, formatResultValue, fullPrecisionValue} from '../../results/numeric-format';
import {isEnergyUnit} from '../../results/energy';
import {plotFontFamily, plotPt} from './ScientificPlotSettings';

export interface PlotGeometry {
  width: number; height: number;
  position: PlotPosition;
  left: number; right: number; top: number; bottom: number;
  x(value: number): number; y(value: number): number; secondaryY(value: number): number;
  xValue(pixel: number, clamp?: boolean): number; yValue(pixel: number, clamp?: boolean): number;
  xTicks: ReturnType<typeof plotTicks>; yTicks: ReturnType<typeof plotTicks>;
  secondaryRange?: [number, number];
  secondaryTicks?: ReturnType<typeof plotTicks>;
  topTickRoom?: number;
}
export interface PlotSecondaryAxis {label: string; series: readonly ScientificPlotSeries[]; toPrimaryScale?:number}
export const plotThemeColors = ['#147d75', '#32658a', '#ad773d', '#607f88', '#627a50', '#a55f4a'] as const;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const tickText = (value: number, step: number, unit: string) => {
  const text = formatPlotTick(value, step);
  return isEnergyUnit(unit.split(' / ').at(-1)) ? decimalEnergyValue(text) : text;
};
type Ticks=ReturnType<typeof plotTicks>;
const superscripts:Record<string,string>={'-':'⁻','0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹'};
function tickLabels(ticks:Ticks,label:string,whole=false){
  const values=ticks.major, first=values[0]??0, last=values.at(-1)??0;
  const span=Math.abs(last-first), magnitude=Math.max(Math.abs(first),Math.abs(last));
  const maxLength=Math.max(0,...values.map(value=>tickText(value,ticks.step,label).length));
  const quantum=span>0?10**Math.floor(Math.log10(span)):1;
  const offset=maxLength>6&&span>0&&magnitude>=100&&Math.sign(first)===Math.sign(last)&&magnitude>50*span
    ? Math.round((first+(last-first)/2)/quantum)*quantum : 0;
  const centered=Math.max(Math.abs(first-offset),Math.abs(last-offset));
  const shiftedLength=offset===0?maxLength:Math.max(0,...values.map(value=>tickText(value-offset,ticks.step,label).length));
  const exponent=!whole&&centered>0&&(centered>=1e6||centered<.001||offset!==0&&shiftedLength>5)
    ? Math.floor(Math.log10(centered)):0;
  const factor=10**exponent||1;
  const note=[offset&&`offset ${tickText(offset,quantum,label)}`,
    exponent&&`×10${Array.from(String(exponent),digit=>superscripts[digit]).join('')}`].filter(Boolean).join(', ');
  const format=(value:number)=>tickText((value-offset)/factor,ticks.step/factor,label);
  return {format,note,digits:Math.max(0,...values.map(value=>format(value).length))};
}

function axisCaption(note:PlotNote|undefined,label:string,notation:string){
  if(!notation)return note;
  return {...note,hidden:false,content:note?.hidden?notation:`${note?.content??label} (${notation})`};
}
function wrapLabel(label: string, pixels: number, size: number): string[] {
  const limit = Math.max(4, pixels / Math.max(1, size * .56)), result: string[] = [];
  const units = (value: string) => Array.from(value).reduce((n, char) => n + (char.codePointAt(0)! > 255 ? 1.6 : 1), 0);
  for (const paragraph of label.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && units(candidate) > limit) {result.push(line); line = word;}
      else line = candidate;
      if (units(line) > limit) {
        let part = '';
        for (const char of line) {
          if (part && units(part + char) > limit) {result.push(part); part = '';}
          part += char;
        }
        line = part;
      }
    }
    if (line) result.push(line);
  }
  return result;
}

export function plotGeometry({width, height, title, subtitle, range, reverseX, reverseY, style, edits, secondary, yLabel, xStep, yStep,
  compact = false, editable, reserveRight=0, footer=0, equalAspect=false, squareFrame=false, wideFrame=false}: {
  width: number; height?: number; title: string; subtitle?: string; range: ScientificPlotViewport;
  reverseX: boolean; reverseY: boolean; style: PlotStyle; edits: PlotPaneEdits; secondary?: PlotSecondaryAxis;
  yLabel: string; xStep?: number; yStep?: number; compact?: boolean; editable: boolean;
  reserveRight?:number; footer?:number; equalAspect?:boolean; squareFrame?:boolean; wideFrame?:boolean;
}): PlotGeometry {
  const tickSize=plotPt(edits.text?.ticks?.font?.size??style.fonts.ticks.size);
  const compactTitle=!edits.text?.title?.hidden&&(edits.text?.title?.content??title);
  const xSize=plotPt(edits.text?.x?.font?.size??style.fonts.x.size);
  const base = compact ? {width, height: height!, left: edits.text?.y?.hidden?16:35, right: width - (secondary ? 39 : 12),
    top:compactTitle?19:9,bottom:height!-(edits.text?.x?.hidden?tickSize+8:tickSize+xSize+11)}
    : wideFrame && height !== undefined ? {width, height, left:Math.max(44,width*.145), right:width-Math.max(12,width*.04),
      top:Math.max(24,height*.075), bottom:height-Math.max(34,height*.11)-footer}
    : scientificPlotLayout(width, title, {height, subtitle: !!subtitle, square: true,footer});
  const spacing=(axis:'x'|'y')=>compact?Math.max(axis==='x'?12:8,tickSize*(axis==='x'?2.35:1.65)):undefined;
  const ticksY = editedPlotTicks(range.y, base.bottom - base.top, style.axis, 'y', yStep,spacing('y'));
  const yText=tickLabels(ticksY,yLabel,style.axis.tickNumbers?.y==='integer');
  const leftMarks=plotSideTicks(style.axis,'left');
  const digits=leftMarks.direction!=='off'&&leftMarks.labels?yText.digits:0;
  const ySize = plotPt(edits.text?.y?.font?.size ?? style.fonts.y.size);
  const yCaption=axisCaption(edits.text?.y,yLabel,digits?yText.note:'');
  const yRows = compact && yCaption?.hidden ? 0 : wrapLabel(yCaption?.content ?? yLabel, base.bottom-base.top+18, ySize).length;
  const labelWidth = digits * tickSize * .57 + yRows * (ySize+2) + (compact ? 12 : 20);
  const offset = squareFrame ? style.frame : edits.frame ?? style.frame;
  const secondaryBounds = secondary && plotDataBounds(secondary.series);
  const scale=secondary?.toPrimaryScale??0;
  const mapped=scale>0&&Number.isFinite(scale)?range.y.map(value=>value/scale) as [number,number]:undefined;
  const secondaryRange: [number, number] | undefined = mapped?.every(Number.isFinite) && mapped[0]<mapped[1] ? mapped
    : secondaryBounds ? [Math.min(0, secondaryBounds.y[0]), Math.max(0, secondaryBounds.y[1])] : undefined;
  const rightMarks=plotSideTicks(style.axis,'right',!!secondaryRange);
  const gutter=secondaryRange ? (compact?39:60)
    : rightMarks.direction!=='off'&&rightMarks.labels ? Math.max(0,yText.digits*tickSize*.57+17):0;
  const topMarks=plotSideTicks(style.axis,'top');
  const topTickRoom=topMarks.direction!=='off'&&topMarks.labels?tickSize+6:0;
  const margin = compact ? 3 : 12;
  const minimum = compact ? 18 : 52;
  let right = clamp(Math.min(base.right, base.width - Math.max(gutter,reserveRight)) + offset.right * base.width, margin + minimum, base.width - margin);
  let left = clamp(Math.max(base.left, labelWidth) + offset.left * base.width, margin, right - minimum);
  let bottom = clamp(base.bottom + offset.bottom * base.height, margin + minimum, base.height - margin);
  const titleSize = plotPt(edits.text?.title?.font?.size ?? style.fonts.title.size);
  const half = Math.min((left + right) / 2, base.width - (left + right) / 2);
  const subtitleHeight = subtitle ? 13 * wrapLabel(subtitle, base.width - 20, 11).length : 0;
  const label=compact?compactTitle||'':edits.text?.title?.content??title;
  const needed = wrapLabel(label, 2 * half - 10, titleSize).length * (titleSize + 2) + subtitleHeight + 10;
  let top = clamp(Math.max(base.top, needed) + offset.top * base.height + topTickRoom, margin, bottom - minimum);
  if(squareFrame&&!equalAspect) {
    const ratio=1;
    const target=Math.min(right-left,(bottom-top)*ratio);
    const midX=(left+right)/2,midY=(top+bottom)/2;
    left=midX-target/2;right=midX+target/2;top=midY-target/ratio/2;bottom=midY+target/ratio/2;
  }
  if (squareFrame && !equalAspect && edits.frame) {
    const frame=edits.frame;
    right=clamp(right+(frame.right-offset.right)*base.width,margin+minimum,base.width-margin);
    left=clamp(left+(frame.left-offset.left)*base.width,margin,right-minimum);
    bottom=clamp(bottom+(frame.bottom-offset.bottom)*base.height,margin+minimum,base.height-margin);
    top=clamp(top+(frame.top-offset.top)*base.height,margin,bottom-minimum);
  }
  if (equalAspect) {
    const ratio=(range.x[1]-range.x[0])/(range.y[1]-range.y[0]);
    const target=Math.min(right-left,(bottom-top)*ratio);
    const midX=(left+right)/2,midY=(top+bottom)/2;
    left=midX-target/2;right=midX+target/2;top=midY-target/ratio/2;bottom=midY+target/ratio/2;
  }
  const position = {x: (edits.position?.x ?? 0) * base.width, y: (edits.position?.y ?? 0) * base.height};
  left += position.x; right += position.x; top += position.y; bottom += position.y;
  const project = (value: number, [low, high]: [number, number], a: number, b: number, reverse = false) =>
    a + (reverse ? (high - value) : (value - low)) / (high - low) * (b - a);
  const value = (pixel: number, [low, high]: [number, number], a: number, b: number, reverse: boolean, bound: boolean) => {
    const raw = (pixel - a) / (b - a), fraction = bound ? clamp(raw, 0, 1) : raw;
    return low + (reverse ? 1 - fraction : fraction) * (high - low);
  };
  const axisTicks = (axis: 'x' | 'y', pixels: number, step?: number) => editable
    ? editedPlotTicks(range[axis], pixels, style.axis, axis, step,spacing(axis))
    : plotTicks(range[axis], pixels, axis === 'x' ? 76 : 48);
  return {
    ...base, position, left, right, top, bottom, secondaryRange,topTickRoom,
    secondaryTicks:secondaryRange?editedPlotTicks(secondaryRange,bottom-top,style.axis,'y',undefined,spacing('y')):undefined,
    x: v => project(v, range.x, left, right, reverseX),
    y: v => project(v, range.y, bottom, top, reverseY),
    secondaryY: v => project(v, secondaryRange ?? range.y, bottom, top, reverseY),
    xValue: (px, bound = true) => value(px, range.x, left, right, reverseX, bound),
    yValue: (py, bound = true) => value(py, range.y, bottom, top, reverseY, bound),
    xTicks: axisTicks('x', right - left, xStep), yTicks: axisTicks('y', bottom - top, yStep),
  };
}

export function resolvePlotSeriesStyle(line: ScientificPlotSeries, all: readonly ScientificPlotSeries[], style: PlotStyle, edits: PlotPaneEdits, editable: boolean) {
  const index = all.findIndex(item => item.id === line.id);
  const current=edits.series?.[line.id] ?? (index === 0 && edits.style && !line.pointLabels && !line.dashed ? style.line : {
    ...style.line,
    ...(!editable || index > 0 || line.color ? {color: line.color ?? plotThemeColors[Math.max(0, index) % plotThemeColors.length]} : {}),
    ...(line.dashed ? {dash: 'dash' as const, points: false, fill: 'none' as const} : {}),
    ...(index > 0 || line.kind === 'stick' || line.pointLabels ? {fill: 'none' as const} : {}),
    ...(line.kind==='stick'?{width:Math.min(style.line.width,1)}:{}),
  });
  return line.kind==='histogram' ? edits.series?.[line.id] ?? style.line
    : line.id==='spectrum-sticks'?{...current,color:spectrumStickColor(style,edits),width:Math.min(current.width,1)}:current;
}

export type PlotDrawingMount = {
  id: string;
  geometry: PlotGeometry;
  range: ScientificPlotViewport;
  edits: PlotPaneEdits;
  style: PlotStyle;
  title: string;
  xLabel: string;
  yLabel: string;
  subtitle?: string;
  series: readonly ScientificPlotSeries[];
  secondary?: PlotSecondaryAxis;
  peaks?: readonly ScientificPlotPoint[];
  selectedIndex?: number;
  showXTicks?: boolean;
  showLegend: boolean;
  legendLabels?: Record<string, string>;
  editable: boolean;
  showResizeHandles?: boolean;
  gripScale?: number;
  decimals?: number;
  selectionMode: 'x' | 'series';
  spectrum: boolean;
  part: 'main' | 'inset';
  activeText?: string;
  transparentPaper?: boolean;
  guides: readonly (PlotGuide & {displayValue: number})[];
  onKeyboardPoint?(point: ScientificPlotPoint): void;
};

function pathForMarker(point: PlotPointStyle, x: number, y: number) {
  const r = plotPt(point.size) / 2;
  switch (point.marker) {
    case 'triangle': return `M${x},${y - r} L${x + r},${y + r} H${x - r}Z`;
    case 'diamond': return `M${x},${y - r} L${x + r},${y} L${x},${y + r} L${x - r},${y}Z`;
    case 'square': return `M${x-r},${y-r}h${2*r}v${2*r}h${-2*r}Z`;
    case 'cross': return `M${x-r},${y}h${2*r} M${x},${y-r}v${2*r}`;
    default: return `M${x-r},${y}a${r},${r} 0 1 0 ${2*r},0a${r},${r} 0 1 0 ${-2*r},0Z`;
  }
}

function markerInk(marker: PlotPointStyle) {
  return {
    fill: marker.marker === 'cross' ? 'none' : marker.hollow ? '#fff' : marker.fillColor,
    stroke: marker.edgeColor,
    strokeWidth: plotPt(marker.edgeWidth),
  };
}

function barInk(style: ReturnType<typeof resolvePlotSeriesStyle>, gradientId: string) {
  const fill = style.fill==='gradient' ? `url(#${gradientId})`
    : style.fill==='none'?'none':style.barFillColor??style.color;
  return {fill,fillOpacity:style.opacity,stroke:style.width>0?style.color:'none',strokeWidth:plotPt(style.width)};
}

function BarGradient({id,base,tip}:{id:string;base:string;tip:string}) {
  return <linearGradient id={id} x1="0" x2="0" y1="1" y2="0">
    <stop offset="0" stopColor={base}/><stop offset="1" stopColor={tip}/>
  </linearGradient>;
}

const validPoint = (point: ScientificPlotPoint): point is ScientificPlotPoint & {y: number} =>
  point.y !== null && Number.isFinite(point.x) && Number.isFinite(point.y);

function trajectoryMarker(marker:PlotPointStyle, points:readonly ScientificPlotPoint[], g:PlotGeometry,
  xRange:readonly [number,number], yRange:readonly [number,number], projectY:(value:number)=>number):PlotPointStyle {
  const footprint=plotPt(marker.size+marker.edgeWidth);
  if (footprint <= 0 || points.length < 3) return marker;
  const bands=new Uint32Array(20);
  let previous:{x:number;y:number}|undefined, count=0;
  for(const point of points) {
    if(!validPoint(point) || point.x < xRange[0] || point.x > xRange[1] || point.y < yRange[0] || point.y > yRange[1]) {
      previous=undefined;
      continue;
    }
    const position={x:g.x(point.x),y:projectY(point.y)};
    if(previous) {
      const fraction=.8*Math.hypot(position.x-previous.x,position.y-previous.y)/footprint;
      bands[Math.min(bands.length-1,Math.floor(bands.length*fraction))]++;
      count++;
    }
    previous=position;
  }
  if(!count) return marker;
  let cumulative=0;
  const band=bands.findIndex(size=> (cumulative+=size) >= Math.ceil(count/5));
  const size=Math.max(Math.min(.7,marker.size),marker.size*(band+1)/bands.length);
  return size === marker.size ? marker : {...marker,size,edgeWidth:marker.edgeWidth*size/marker.size};
}

function textAppearance(p: PlotDrawingMount, id: string, role: PlotFontRole, x: number, y: number, note = p.edits.text?.[id]) {
  const font = {...p.style.fonts[role], ...note?.font};
  return {
    x: x + (note?.position?.x ?? 0) * p.geometry.width,
    y: y + (note?.position?.y ?? 0) * p.geometry.height,
    fontFamily: plotFontFamily(font.font), fontSize: plotPt(font.size),
    fontWeight: font.bold ? 700 : 400, fontStyle: font.italic ? 'italic' : 'normal',
    fill: '#111',
    ...(p.editable ? {'data-plot-hit': 'text', 'data-plot-key': id, 'data-plot-current': p.activeText === id || undefined} : {}),
  };
}

function TextObject({p, id, role, x, y, rotate = 0, wrap, align = 'center', label, note = p.edits.text?.[id], ...props}: {
  p: PlotDrawingMount; id: string; role: PlotFontRole; x: number; y: number; rotate?: number; wrap?: number;
  align?: 'start' | 'center' | 'end'; label: string; note?: PlotNote;
} & Omit<SVGProps<SVGTextElement>, 'x' | 'y' | 'rotate' | 'role'>) {
  if (note?.hidden || !(note?.content ?? label)) return null;
  const ink = textAppearance(p, id, role, x, y, note);
  const lines = wrap !== undefined ? wrapLabel(note?.content ?? label, wrap, ink.fontSize) : [note?.content ?? label];
  const spacing = ink.fontSize + 2, begin = align === 'start' ? 0 : -(lines.length - 1) * spacing / (align === 'end' ? 1 : 2);
  return <text {...ink} {...props} aria-label={note?.content ?? label} transform={rotate ? `rotate(${rotate} ${ink.x} ${ink.y})` : undefined}>
    {lines.length === 1 ? lines[0] : lines.map((line, index) => <tspan key={index} x={ink.x} y={ink.y + begin + index * spacing}>{line}</tspan>)}
  </text>;
}

function pointHit(line: ScientificPlotSeries, point: ScientificPlotPoint, index: number, p: PlotDrawingMount) {
  const canSeek = point.index !== undefined && !!p.onKeyboardPoint;
  const accessibleLabel = !canSeek ? undefined : p.selectionMode === 'series' ? `选择轨道 ${point.readoutId ?? point.index! + 1}`
    : point.label ?? `选择帧 ${point.index! + 1}${point.y === null ? '' : `，${p.decimals === undefined ? fullPrecisionValue(point.y) : formatResultValue(point.y, p.decimals)}`}`;
  return {
    ...(p.editable ? {'data-plot-hit': 'point', 'data-plot-key': line.id, 'data-plot-row': index} : {}),
    'data-plot-point-index': canSeek ? point.index : undefined,
    'data-plot-point-readout': !canSeek && (point.tooltip || point.readoutId !== undefined) ? true : undefined,
    role: canSeek ? 'button' : undefined, tabIndex: canSeek ? 0 : undefined,
    'aria-label': accessibleLabel,
    'aria-description': point.tooltip,
    onClick: canSeek ? (event: React.MouseEvent<SVGElement>) => {
      if (event.detail === 0) { event.stopPropagation(); p.onKeyboardPoint?.(point); }
    } : undefined,
    onKeyDown: canSeek ? (event: React.KeyboardEvent<SVGElement>) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); p.onKeyboardPoint?.(point); }
    } : undefined,
  };
}

const PlotSeriesInk = memo(function PlotSeriesInk({p, line, index}: {p: PlotDrawingMount; line: ScientificPlotSeries; index: number}) {
  const all = p.secondary ? [...p.series, ...p.secondary.series] : p.series;
  const style = resolvePlotSeriesStyle(line, all, p.style, p.edits, p.editable);
  const g = p.geometry, secondary = index >= p.series.length, projectY = secondary ? g.secondaryY : g.y;
  const strokeWidth = plotPt(style.width), dash = plotDashArray(style.dash, strokeWidth);
  const pathHit = p.editable ? {'data-plot-hit': 'line', 'data-plot-key': line.id} : {};
  const points = line.points;
  const selected = (point: ScientificPlotPoint) => p.selectedIndex !== undefined && point.index === p.selectedIndex;
  const linePaths = line.kind !== 'stick' && line.kind !== 'histogram' ? scientificPlotPaths(points, g.x, projectY) : [];
  const gradId = `${p.id}-fill-${index}`;
  const histogram = line.kind==='histogram';
  const barBaseline = clamp(projectY(0), g.top, g.bottom);
  const markerPaths: string[] = [], markerOverlays: {style: PlotPointStyle; path: string; key: string}[] = [];
  const drawsMarkers = line.kind !== 'stick' && line.kind !== 'histogram' && style.points && !p.spectrum && p.selectionMode !== 'series';
  const markerStyle = drawsMarkers ? trajectoryMarker(style.point,points,g,p.range.x,
    secondary && g.secondaryRange ? g.secondaryRange : p.range.y,projectY) : style.point;
  if (drawsMarkers) {
    points.forEach((point, row) => {
      if (!validPoint(point)) return;
      const key = plotPointKey(line.id, row), local = p.edits.points?.[key];
      const marker = local ?? markerStyle, path = pathForMarker(marker, g.x(point.x), projectY(point.y));
      if (local) markerOverlays.push({style: marker, path, key});
      else markerPaths.push(path);
    });
  }
  const drawMarker = (marker: PlotPointStyle, path: string, key?: string) =>
    <path key={key} d={path} {...markerInk(marker)} pointerEvents="none"/>;
  return <g data-series-id={line.id} data-y-axis={secondary ? 'secondary' : 'primary'}>
    {style.fill === 'gradient' && <defs>{histogram
      ? <BarGradient id={gradId} base={style.barGradient?.base??histogramGradientBase} tip={style.barFillColor??style.color}/>
      : <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stopColor={style.color} stopOpacity={style.opacity}/>
      <stop offset="1" stopColor={style.color} stopOpacity="0"/>
    </linearGradient>}</defs>}
    {!style.hidden && linePaths.map((path, i) => {
      const ends = path.match(/-?[\d.]+,-?[\d.]+/g), first = ends?.[0]?.split(',')[0], last = ends?.at(-1)?.split(',')[0];
      const y = p.spectrum ? barBaseline : g.bottom;
      const seriesPoint = p.selectionMode === 'series' ? points.find(validPoint) : undefined;
      return <g key={i}>
        {style.fill !== 'none' && first !== undefined && last !== undefined && <path d={`${path} L${last},${y} L${first},${y} Z`}
          fill={style.fill === 'gradient' ? `url(#${gradId})` : style.color} fillOpacity={style.fill === 'solid' ? style.opacity : 1} pointerEvents="none"/>}
        <path d={path} fill="none" stroke={style.color} strokeWidth={strokeWidth} strokeDasharray={dash} strokeLinecap="round"/>
        {(p.editable || seriesPoint) && <path d={path} {...pathHit} {...(seriesPoint ? pointHit(line, seriesPoint, points.indexOf(seriesPoint), p) : {})}
          stroke="transparent" strokeWidth="12" fill="none" data-plot-interaction="target"/>}
      </g>;
    })}
    {!style.hidden && line.kind === 'histogram' && points.map((point, i) =>
      validPoint(point) && Number.isFinite(point.xEnd) ? <rect key={i} data-plot-histogram-bin={i}
        {...pointHit(line, point, i, p)} pointerEvents={p.editable?'all':undefined}
        x={Math.min(g.x(point.x), g.x(point.xEnd!))} y={Math.min(barBaseline, projectY(point.y))}
        width={Math.abs(g.x(point.xEnd!) - g.x(point.x))} height={Math.abs(projectY(point.y) - barBaseline)}
        {...barInk(style,gradId)}>{!p.editable&&<title>{point.label}</title>}</rect> : null)}
    {!style.hidden && line.kind === 'stick' && points.map((point, i) => validPoint(point) && <g key={i}>
      <line x1={g.x(point.x)} x2={g.x(point.x)} y1={barBaseline} y2={projectY(point.y)}
        stroke={selected(point) ? '#a87321' : style.color} strokeWidth={selected(point) ? 2.5 : strokeWidth} strokeDasharray={dash}/>
      {(p.editable || point.index !== undefined && p.onKeyboardPoint) && <line {...pointHit(line, point, i, p)} data-plot-stick-hit="true"
        x1={g.x(point.x)} x2={g.x(point.x)} y1={barBaseline} y2={projectY(point.y)} stroke="transparent" strokeWidth="14" data-plot-interaction="target"/>}
    </g>)}
    {(markerPaths.length > 0 || markerOverlays.length > 0) && <g data-plot-markers={style.point.hollow ? 'hollow' : 'solid'}
      data-plot-marker-size-pt={markerStyle.size} data-point-count={markerPaths.length + markerOverlays.length}>{markerPaths.length > 0 && drawMarker(markerStyle, markerPaths.join(' '))}
      {markerOverlays.map(entry => drawMarker(entry.style, entry.path, entry.key))}</g>}
    {line.kind !== 'stick' && line.kind !== 'histogram' && p.selectionMode !== 'series' &&
      points.map((point, row) => validPoint(point) && (style.points || point.index !== undefined || point.readoutId !== undefined || point.tooltip)
        ? <circle key={row} {...pointHit(line, point, row, p)} cx={g.x(point.x)} cy={projectY(point.y)}
          r={Math.max(7, plotPt(style.point.size) / 2 + 2)} fill="transparent" data-plot-interaction="target">
          {!p.editable && <title>{point.tooltip ?? point.label}</title>}
        </circle> : null)}
    {line.pointLabels && points.map((point, i) => validPoint(point) && point.label
      ? <text key={i} x={g.x(point.x) + 7} y={projectY(point.y) - 7} fill={style.color}
        fontSize={plotPt(p.style.fonts.legend.size)}>{point.label}</text> : null)}
  </g>;
});

export const plotCornerGripSize = 14;
function plotHandles(geometry: PlotGeometry, scale: number) {
  const {left, right, top, bottom} = geometry, x = (left + right) / 2, y = (top + bottom) / 2;
  const length = 36 / scale, thickness=12.5 / scale, corner=plotCornerGripSize / scale;
  return [
    ['n', x, top, length, thickness], ['s', x, bottom, length, thickness],
    ['e', right, y, thickness, length], ['w', left, y, thickness, length],
    ['nw', left, top, corner, corner], ['ne', right, top, corner, corner],
    ['se', right, bottom, corner, corner], ['sw', left, bottom, corner, corner],
  ] as const;
}

function AxisTickMarks({plot,side,ticks,project,labels,ink}:{
  plot:PlotDrawingMount;side:PlotTickSide;ticks:Ticks;project(value:number):number;
  labels:ReturnType<typeof tickLabels>;ink:ReturnType<typeof textAppearance>;
}){
  const g=plot.geometry, axis=plot.style.axis, horizontal=side==='top'||side==='bottom';
  const setting=plotSideTicks(axis,side,!!g.secondaryRange);
  if(setting.direction==='off' || horizontal&&plot.showXTicks===false)return null;
  const inset=side==='left'||side==='top'?1:-1;
  const location=side==='left'?g.left:side==='right'?g.right:side==='top'?g.top:g.bottom;
  const compact=plot.part==='inset', major=compact?3:5;
  const gap=3+(setting.direction==='out'||setting.direction==='both'?major:0);
  const labelOffset=compact?gap:8;
  const labelY=(at:number)=>horizontal
    ? side==='bottom'?location+(compact?ink.fontSize*.9+gap:17):location-(compact?ink.fontSize*.25+gap:7)
    : at+(compact?ink.fontSize*.34:4);
  const labelSpace = horizontal ? labels.digits * ink.fontSize * .57 + 2 : ink.fontSize + 2;
  const markSpace = ticks.major.length > 1 ? Math.abs(project(ticks.major[1]) - project(ticks.major[0])) : Infinity;
  const labelStride = compact ? Math.max(1, Math.ceil(labelSpace / markSpace)) : 1;
  const reaches=(value:number,size:number)=>{
    const a=location+(setting.direction==='out'||setting.direction==='both'?-inset*size:0);
    const b=location+(setting.direction==='in'||setting.direction==='both'?inset*size:0);
    return horizontal?{x1:value,x2:value,y1:a,y2:b}:{x1:a,x2:b,y1:value,y2:value};
  };
  return <g data-plot-tick-side={side} data-plot-tick-direction={setting.direction}>
    {ticks.major.map((value,index)=>{
      const at=project(value);
      const physical=side==='right'&&g.secondaryRange?g.yValue(at,false):value;
      const target={'data-plot-hit':'tick','data-plot-axis':horizontal?'x':'y','data-plot-value':physical};
      return <g key={value} {...target}>
        <line {...reaches(at,major)} stroke={axis.color} strokeWidth={plotPt(axis.width)}/>
        {setting.labels&&index%labelStride===0&&<text {...ink} {...target} x={horizontal?at:location-labelOffset*inset}
          y={labelY(at)}
          textAnchor={horizontal?'middle':side==='left'?'end':'start'}>{labels.format(value)}</text>}
      </g>;
    })}
    {ticks.minor.map(value=><line key={value} {...reaches(project(value),compact?2:3)} stroke={axis.color} strokeWidth={plotPt(axis.width)}/>)}
  </g>;
}

export function ScientificPlotDrawing(p: PlotDrawingMount) {
  const g = p.geometry, axis = p.style.axis, width = plotPt(axis.width);
  const compact=p.part==='inset';
  const histogram=p.series.some(line=>line.kind==='histogram');
  const gripScale = p.gripScale || 1;
  const all = p.secondary ? [...p.series, ...p.secondary.series] : p.series;
  const clip = `${p.id}-data`, midX = (g.left + g.right) / 2, midY = (g.top + g.bottom) / 2;
  const innerMidX = midX - g.position.x;
  const tickInk = textAppearance(p, 'ticks', 'ticks', 0, 0);
  const xTicks=tickLabels(g.xTicks,p.xLabel,axis.tickNumbers?.x==='integer');
  const yTicks=tickLabels(g.yTicks,p.yLabel,axis.tickNumbers?.y==='integer');
  const rightTicks=g.secondaryTicks&&p.secondary?tickLabels(g.secondaryTicks,p.secondary.label,axis.tickNumbers?.y==='integer'):yTicks;
  const prints=(side:PlotTickSide)=>{const setting=plotSideTicks(axis,side,!!g.secondaryRange);return setting.direction!=='off'&&setting.labels;};
  const xCaption=axisCaption(p.edits.text?.x,p.xLabel,prints('top')||prints('bottom')?xTicks.note:'');
  const yCaption=axisCaption(p.edits.text?.y,p.yLabel,prints('left')||!p.secondary&&prints('right')?yTicks.note:'');
  const rightCaption=p.secondary&&axisCaption(p.edits.text?.['secondary-y'],p.secondary.label,prints('right')?rightTicks.note:'');
  const ySize = plotPt(p.edits.text?.y?.font?.size ?? p.style.fonts.y.size);
  const ySpan = g.bottom-g.top+18;
  const yRows = wrapLabel(yCaption?.content ?? p.yLabel, ySpan, ySize).length;
  const tickWidth = (prints('left')?yTicks.digits:0)*tickInk.fontSize*.57;
  const showEdge=(side:PlotTickSide)=>axis.frame==='full'||plotSideTicks(axis,side,!!g.secondaryRange).direction!=='off';
  const isSelected = (point: ScientificPlotPoint) => point.index === p.selectedIndex && Number.isFinite(point.x);
  const selected = p.selectedIndex === undefined ? undefined
    : p.peaks?.find(isSelected) ?? all.flatMap(line => line.points).find(isSelected);
  const guideLabel = (guide: PlotDrawingMount['guides'][number]) => guide.label?.content ??
    `${guide.axis} = ${Number(guide.displayValue.toPrecision(8))}`;
  const fitMark = (point: ScientificPlotPoint, yRange = p.range.y) => validPoint(point) && point.x >= p.range.x[0] && point.x <= p.range.x[1]
    && point.y >= yRange[0] && point.y <= yRange[1];
  const showAnnotation = p.edits.text?.annotation?.hidden === undefined ? p.style.showAnnotation : !p.edits.text.annotation.hidden;
  const reference = p.subtitle ? wrapLabel(p.subtitle, g.width - 20, 11) : [];
  return <g data-plot-part={p.part}>
    <defs><clipPath id={clip}><rect x={g.left} y={g.top} width={g.right - g.left} height={g.bottom - g.top}/></clipPath></defs>
    {!compact && <rect width={g.width} height={g.height} fill={p.transparentPaper?'transparent':'#fff'} data-plot-hit="paper"/>}
    {compact && <rect x={g.left} y={g.top} width={g.right-g.left} height={g.bottom-g.top} fill="#fff" pointerEvents="none"/>}
    {p.editable && <rect x={g.left} y={g.top} width={g.right-g.left} height={g.bottom-g.top}
      fill="transparent" className="plot-data-paper" data-plot-hit="paper" data-plot-interaction="zoom"/>}
    <TextObject p={p} id="title" role="title" label={p.title} x={midX} wrap={2*Math.min(innerMidX,g.width-innerMidX)-10} align="end"
      y={g.top - (compact?4:8) - (g.topTickRoom??0) - reference.length * 13} textAnchor="middle"/>
    {reference.length > 0 && <text data-plot-reference="true" x={g.width/2+g.position.x} y={g.top - 6} fill="#475569" fontSize={11} textAnchor="middle">
      {reference.map((line,index) => <tspan key={index} x={g.width/2+g.position.x} y={g.top-6-(reference.length-index-1)*13}>{line}</tspan>)}</text>}
    <TextObject p={p} id="y" role="y" label={p.yLabel} note={yCaption} x={Math.max(g.position.x + ySize + 3, g.left - tickWidth - 17 - (yRows-1)*(ySize+2))}
      y={midY} rotate={-90} wrap={ySpan} align="start" textAnchor="middle"/>
    <AxisTickMarks plot={p} side="left" ticks={g.yTicks} project={g.y} labels={yTicks} ink={tickInk}/>
    <AxisTickMarks plot={p} side="bottom" ticks={g.xTicks} project={g.x} labels={xTicks} ink={tickInk}/>
    <AxisTickMarks plot={p} side="top" ticks={g.xTicks} project={g.x} labels={xTicks} ink={tickInk}/>
    {!p.secondary&&<AxisTickMarks plot={p} side="right" ticks={g.yTicks} project={g.y} labels={yTicks} ink={tickInk}/>}
    {axis.frame === 'full'
      ? <rect data-plot-frame="true" x={g.left} y={g.top} width={g.right - g.left} height={g.bottom - g.top} fill="none" stroke={axis.color} strokeWidth={width}/>
      : <path data-plot-frame="true" d={`M${g.left},${g.top} V${g.bottom} H${g.right}`
        +(showEdge('top')?` M${g.left},${g.top} H${g.right}`:'')
        +(showEdge('right')?` M${g.right},${g.top} V${g.bottom}`:'')} fill="none" stroke={axis.color} strokeWidth={width}/>}
    {p.secondary && g.secondaryTicks && <g data-plot-axis="secondary-y">
      <AxisTickMarks plot={p} side="right" ticks={g.secondaryTicks} project={g.secondaryY} labels={rightTicks} ink={tickInk}/>
      <TextObject p={p} id="secondary-y" role="y" label={p.secondary.label} note={rightCaption} x={g.width + g.position.x - plotPt(p.style.fonts.y.size)} y={midY} rotate={90}
        wrap={g.bottom-g.top+18} align="start" textAnchor="middle"/>
    </g>}
    <g clipPath={`url(#${clip})`}>
      {p.guides.map(guide => {
        const horizontal = guide.axis === 'y', at = horizontal ? g.y(guide.displayValue) : g.x(guide.displayValue);
        const stroke = {...p.style.guide, ...guide.stroke}, width = plotPt(stroke.width);
        const line = horizontal ? {x1: g.left, x2: g.right, y1: at, y2: at} : {x1: at, x2: at, y1: g.top, y2: g.bottom};
        return <g key={guide.id}>
          <line {...line} data-plot-zero={guide.id === 'zero' || undefined} stroke={stroke.color} strokeWidth={width} strokeDasharray={plotDashArray(stroke.dash, width)}/>
          {p.editable && <line {...line} data-plot-hit="guide" data-plot-key={guide.id} data-plot-interaction="target" stroke="transparent" strokeWidth={10}/>}
          {!!guide.label && <TextObject p={p} id={`guide:${guide.id}`} role="annotation" label={guideLabel(guide)}
            x={horizontal ? g.right - 7 : at + 6} y={horizontal ? at - 7 : g.top + 17} textAnchor={horizontal ? 'end' : 'start'} note={guide.label}/>}
        </g>;
      })}
      {all.map((line, index) => <PlotSeriesInk key={line.id} p={p} line={line} index={index}/>)}
      {p.peaks && p.series[0] && p.peaks.map((point, row) => fitMark(point) && <circle key={row}
        {...pointHit(p.series[0], point, row, p)} cx={g.x(point.x)} cy={g.y(point.y!)}
        r={6} fill="transparent" data-plot-peak-anchor="true" data-plot-interaction="target"/>)}
      {selected && p.selectionMode !== 'series' && <line data-plot-source-cursor="true" x1={g.x(selected.x)} x2={g.x(selected.x)} y1={g.top} y2={g.bottom} stroke="#ca7b29"
        strokeDasharray="4 3" pointerEvents="none"/>}
      {selected && p.selectionMode !== 'series' && !p.spectrum && validPoint(selected) && <>
        <circle cx={g.x(selected.x)} cy={g.y(selected.y)} r={5} fill="#a87321" pointerEvents="none"/>
        {showAnnotation && <TextObject p={p} id="annotation" role="annotation" label={`Frame ${selected.readoutId ?? selected.index! + 1}`}
          x={g.x(selected.x) + (g.x(selected.x) < midX ? 8 : -8)} y={Math.max(g.top + plotPt(p.style.fonts.annotation.size), g.y(selected.y) - 8)}
          textAnchor={g.x(selected.x) < midX ? 'start' : 'end'} data-plot-selected-label="true"/>}
      </>}
    </g>
    {all.flatMap(line => line.points.map((point, row) => (point.markerLabel
      || !p.peaks?.length && p.edits.text?.[`peak:${plotPointKey(line.id, row)}`]?.content) &&
      fitMark(point, p.secondary?.series.includes(line) ? g.secondaryRange : p.range.y) &&
      <TextObject key={plotPointKey(line.id, row)} p={p} id={`peak:${plotPointKey(line.id, row)}`} role="annotation"
        label={point.markerLabel ?? ''} x={g.x(point.x)} y={(p.secondary?.series.includes(line)?g.secondaryY(point.y!):g.y(point.y!)) - 9} textAnchor="middle"/>))}
    {(p.peaks ?? []).map((point, row) => p.series[0] && fitMark(point) && (showAnnotation || p.edits.text?.[`peak:${plotPointKey(p.series[0].id, row)}`]?.content) &&
      <TextObject key={row} p={p} id={`peak:${plotPointKey(p.series[0].id, row)}`} role="annotation"
        label={point.label ?? tickText(point.x, g.xTicks.step, p.xLabel)} x={g.x(point.x)} y={g.y(point.y!) - 9} textAnchor="middle"/>)}
    {p.showLegend && p.selectionMode !== 'series' && <PlotLegend p={p} all={all}/>}
    <TextObject p={p} id="x" role="x" label={p.xLabel} note={xCaption} x={midX}
      y={Math.min(g.height + g.position.y - 5, g.bottom + (compact
        ? tickInk.fontSize + plotPt(p.edits.text?.x?.font?.size ?? p.style.fonts.x.size) + 7 : histogram?28:41))} textAnchor="middle"/>
    {Object.entries(p.edits.text ?? {}).map(([id, note]) => id.startsWith('note:') &&
      <TextObject key={id} p={p} id={id} role="annotation" label="Text" x={midX} y={midY} textAnchor="middle" note={note}/>)}
    {p.editable && <g data-plot-interaction="layout">
      <line data-plot-hit="axis" data-plot-axis="x" x1={g.left} x2={g.right} y1={g.bottom} y2={g.bottom} stroke="transparent" strokeWidth={9}/>
      <line data-plot-hit="axis" data-plot-axis="y" x1={g.left} x2={g.left} y1={g.top} y2={g.bottom} stroke="transparent" strokeWidth={9}/>
      {showEdge('top')&&<line data-plot-hit="axis" data-plot-axis="x" x1={g.left} x2={g.right} y1={g.top} y2={g.top} stroke="transparent" strokeWidth={9}/>}
      {showEdge('right')&&<line data-plot-hit="axis" data-plot-axis="y" x1={g.right} x2={g.right} y1={g.top} y2={g.bottom} stroke="transparent" strokeWidth={9}/>}
      {p.showResizeHandles && plotHandles(g,gripScale).map(([edge, x, y, w, h]) => <rect key={edge} data-plot-hit="resize" data-plot-key={edge}
        x={x - w / 2} y={y - h / 2} width={w} height={h} rx={3.5/gripScale} className="plot-frame-grip" data-plot-resize={edge}/>)}
    </g>}
  </g>;
}

function PlotLegend({p, all}: {p: PlotDrawingMount; all: readonly ScientificPlotSeries[]}) {
  const g = p.geometry, group = p.edits.text?.legend;
  const origin = textAppearance(p, 'legend', 'legend', g.right - Math.min(125, (g.right - g.left) / 2), g.top);
  let rowTop = origin.y + 4;
  return <g data-plot-series-legend="true" data-plot-hit={p.editable ? 'legend' : undefined} data-plot-key="legend">
    {all.map((line,index) => {
      if(line.pointLabels)return null;
      const id = `legend:${line.id}`, entry = p.edits.text?.[id], note = {...entry, font: {...group?.font, ...entry?.font}};
      const style = resolvePlotSeriesStyle(line, all, p.style, p.edits, p.editable), width = plotPt(style.width);
      const marker = style.points && !p.spectrum && line.kind !== 'stick' && line.kind !== 'histogram' ? style.point : undefined;
      const markerSize = marker ? plotPt(marker.size) : 0, fontSize = plotPt(note.font.size ?? p.style.fonts.legend.size);
      const height = Math.max(fontSize + 5, markerSize + 5), x = origin.x, y = rowTop + height / 2;
      rowTop += height;
      const gradId=`${p.id}-fill-${index}`;
      return <g key={line.id}>
        {line.kind==='histogram'
          ? <rect x={x+3} y={y-3.5} width={13} height={7} {...barInk(style,gradId)} data-plot-legend-sample="bar"/>
          : <line x1={x} x2={x + 19} y1={y} y2={y} stroke={style.color} strokeWidth={width}
            strokeDasharray={plotDashArray(style.dash, width)} data-plot-legend-sample="line"/>}
        {marker && <path d={pathForMarker(marker, x + 9.5, y)} {...markerInk(marker)} data-plot-legend-sample="point"/>}
        {p.editable && <rect x={Math.min(x, x + 9.5 - markerSize / 2) - 2} y={y - height / 2}
          width={Math.max(19, markerSize) + 4} height={height} fill="transparent" data-plot-interaction="target"/>}
        <TextObject p={p} id={id} role="legend" label={p.legendLabels?.[line.id] ?? line.label ?? line.id}
          x={x + Math.max(24, 14 + markerSize / 2)} y={y + fontSize / 3} note={note}/>
      </g>;
    })}
  </g>;
}
