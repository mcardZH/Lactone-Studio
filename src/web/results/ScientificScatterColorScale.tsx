import {useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent} from 'react';
import {plotClientPoint} from '../../results/optimization-plot-axis';
import {plotFonts} from '../../results/scientific-plot-editing';
import type {ScatterColorScaleValue, ScatterScaleMapping, ScatterScaleTickMode, ScatterScaleTitle} from '../../results/scientific-scatter-scale';
import {zeroCenteredColorStops, zeroCenteredFraction} from '../../results/zero-centered-color';
import {formatResultValue, normalizeResultNumberFormat, resultDecimals, type ResultNumberFormatMode} from '../../results/numeric-format';
import NumericInput from '../NumericInput';
import {PlotNumber} from './ScientificPlotEditor';
import {ANALYSIS_COLORBAR_LIMITS, moveAnalysisColorbarLayout, resizeAnalysisColorbarLayout, type AnalysisColorbarLayout} from './analysis-colorbar-layout';
import './ScientificScatterPlot.css';
import './scientific-scatter-color-scale.css';

export type ScatterScaleChange = (patch: Partial<ScatterColorScaleValue>, group?: string) => void;
export interface ScatterScaleFrame {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}
type Point = {x: number; y: number};

const pxPerPoint = 4 / 3;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
const normalizeValue = (value: number, log?: boolean) => log ? Math.log(Math.max(1, value)) : value;

/** Uses the same sign anchor as the ES interaction surface and scatter points. */
export function scatterScaleFraction(value: number, mapping: ScatterScaleMapping) {
  const [low, high] = mapping.range;
  if (mapping.zeroCentered) return zeroCenteredFraction(value, low, high);
  const lower = normalizeValue(low, mapping.logarithmic), upper = normalizeValue(high, mapping.logarithmic);
  return clamp((normalizeValue(value, mapping.logarithmic) - lower) / (upper - lower || 1), 0, 1);
}

export function scatterScaleStops(mapping: ScatterScaleMapping) {
  if (mapping.zeroCentered) return zeroCenteredColorStops(mapping.range[0], mapping.range[1], mapping.colors);
  return mapping.colors.map((color, i) => ({offset: i / Math.max(1, mapping.colors.length - 1), color}));
}

function scalarFraction(value: number, mapping: ScatterScaleMapping) {
  const [low, high] = mapping.range, log = mapping.logarithmic;
  const lower = normalizeValue(low, log), upper = normalizeValue(high, log);
  return clamp((normalizeValue(value, log) - lower) / (upper - lower || 1), 0, 1);
}

export function scatterScaleTicks(value: ScatterColorScaleValue): number[] {
  const [low, high] = value.range;
  if (value.tickMode === 'ends') return [low, high];
  if (value.tickMode === 'custom') {
    return [...new Set(value.tickValues.filter(n => Number.isFinite(n) && n >= low && n <= high))].sort((a, b) => a - b);
  }
  const count = clamp(Math.round(value.tickCount), 2, 10), log = value.logarithmic;
  const start = normalizeValue(low, log), span = normalizeValue(high, log) - start;
  return Array.from({length: count}, (_, i) => {
    if (i === 0) return low;
    if (i === count - 1) return high;
    const position = start + i * span / (count - 1);
    return log ? Math.exp(position) : position;
  });
}

export function scatterScaleLabel(scalar: number, value: Pick<ScatterColorScaleValue, 'numberFormat' | 'decimals'>) {
  const format = normalizeResultNumberFormat(value.numberFormat);
  const text = format ? formatResultValue(scalar, value.decimals, format) : Number(scalar.toFixed(resultDecimals(value.decimals))).toString().replace('-', '−');
  return text.startsWith('-') ? '−' + text.slice(1) : text;
}

function geometry(value: ScatterColorScaleValue, f: ScatterScaleFrame) {
  const vertical = value.direction === 'vertical';
  const plotSpan = vertical ? f.bottom - f.top : f.right - f.left;
  const span = vertical ? f.height : f.width;
  const font = value.numberPt * pxPerPoint, titleFont = (value.title.size ?? value.numberPt) * pxPerPoint;
  const showTitle = value.title.visible && Boolean(value.title.content);
  const labels = scatterScaleTicks(value).map(scalar => ({scalar, position: scalarFraction(scalar, value), name: scatterScaleLabel(scalar, value)}));
  const numberWidth = Math.max(0, ...labels.map(row => row.name.length * font * .62));
  const tickRoom = vertical ? numberWidth + 9 : font + 8;
  const titleRoom = showTitle ? titleFont + 9 : 0;
  const padding = vertical ? font / 2 + 3 : numberWidth / 2 + 3;
  const length = clamp(plotSpan * value.length / 100, 14, span - 2 * (8 + padding));
  const extent = vertical ? {width: value.thickness + tickRoom + titleRoom, height: length + padding * 2}
    : {width: length + padding * 2, height: value.thickness + tickRoom + titleRoom};
  const nominalX = vertical ? f.right + 21 : (f.left + f.right - length) / 2;
  const nominalY = vertical ? (f.top + f.bottom - length) / 2 : f.bottom + 63;
  const x = clamp(nominalX + value.dx * f.width, 8 + (vertical ? 0 : padding),
    f.width - extent.width - 8 + (vertical ? 0 : padding));
  const y = clamp(nominalY + value.dy * f.height, 8 + (vertical ? padding : 0),
    f.height - extent.height - 8 + (vertical ? padding : 0));
  const cx = x + (vertical ? value.thickness : length) / 2, cy = y + (vertical ? length : value.thickness) / 2;
  return {x, y, cx, cy, length, span, plotSpan, vertical, labels, font, titleFont, showTitle,
    width: vertical ? value.thickness : length, height: vertical ? length : value.thickness,
    extentX: x - (vertical ? 0 : padding), extentY: y - (vertical ? padding : 0), extent,
    titleX: (vertical ? x + value.thickness + tickRoom + titleFont / 2 : cx) + (value.title.dx ?? 0) * f.width,
    titleY: (vertical ? cy : y + value.thickness + tickRoom + titleFont / 2) + (value.title.dy ?? 0) * f.height};
}

interface ScatterColorScaleProps {
  value: ScatterColorScaleValue;
  frame: ScatterScaleFrame;
  onChange: ScatterScaleChange;
  onOpenSettings(at: Point): void;
  onOpenTitle(at: Point, editText?: boolean): void;
  onDeleteTitle?(): void;
  titleSelected?: boolean;
}
type DragPart = 'move' | 'start' | 'end' | 'side-start' | 'side-end' | 'title';
type ScaleGeometry = ReturnType<typeof geometry>;
interface Drag {
  id: number;
  part: DragPart;
  origin: Point;
  screen: Point;
  initial: ScatterColorScaleValue;
  rect: ScaleGeometry;
  moved: boolean;
}

/** SVG scale for the ES scatter figure. The outer owner retains undo and source identity. */
export function ScientificScatterColorScale({
  value, frame, onChange, onOpenSettings, onOpenTitle, onDeleteTitle, titleSelected,
}: ScatterColorScaleProps) {
  const gradientId = 'scatter-scale-' + useId().replace(/[^a-zA-Z0-9-]/g, '');
  const root = useRef<SVGGElement>(null), drag = useRef<Drag | null>(null);
  const bar = useRef<SVGRectElement>(null);
  const [draft, setDraft] = useState<Partial<ScatterColorScaleValue>>();
  const current = draft ? {...value, ...draft} : value;
  const rect = geometry(current, frame);
  const {x, y, vertical, length} = rect;
  const sideHit = Math.min(4, current.thickness / 3), endHit = Math.min(5, length / 4);
  const at = (event: MouseEvent<SVGElement>) => {
    const svg = root.current?.ownerSVGElement;
    return svg ? plotClientPoint(svg, event.clientX, event.clientY) : null;
  };
  function cancel() { drag.current = null; setDraft(undefined); }
  useEffect(() => {
    const win = root.current?.ownerDocument.defaultView;
    win?.addEventListener('blur', cancel);
    return () => win?.removeEventListener('blur', cancel);
  }, []);
  function start(event: PointerEvent<SVGGElement>) {
    if (event.button !== 0 || drag.current) return;
    const point = at(event);
    if (!point) return;
    const object = (event.target as Element).closest<SVGElement>('[data-scatter-scale-part]');
    if (!object) return;
    const part = object.dataset.scatterScalePart as DragPart;
    event.stopPropagation();
    event.preventDefault();
    (part === 'title' ? object : bar.current)?.focus({preventScroll: true});
    drag.current = {id:event.pointerId,part,origin:point,screen:{x:event.clientX,y:event.clientY},
      initial:value,rect:geometry(value,frame),moved:false};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function patchFor(active: Drag, dx: number, dy: number): Partial<ScatterColorScaleValue> {
    const box = active.rect, initial = active.initial;
    if (active.part === 'title') {
      const textSpan = initial.title.content.length * box.titleFont * .57;
      const halfX = (box.vertical ? box.titleFont : textSpan) / 2;
      const halfY = (box.vertical ? textSpan : box.titleFont) / 2;
      const shift = (n: number, center: number, half: number, extent: number) =>
        clamp(n, Math.min(0, half + 5 - center), Math.max(0, extent - half - 5 - center));
      return {title: {...initial.title,
        dx:(initial.title.dx ?? 0) + shift(dx,box.titleX,halfX,frame.width) / frame.width,
        dy:(initial.title.dy ?? 0) + shift(dy,box.titleY,halfY,frame.height) / frame.height}};
    }
    if (active.part === 'side-start' || active.part === 'side-end') {
      const leading = active.part === 'side-start', change = box.vertical ? dx : dy;
      const limits = ANALYSIS_COLORBAR_LIMITS.thickness;
      const thickness = clamp(initial.thickness + (leading ? -change : change), limits.min, limits.max);
      const offset = leading ? initial.thickness - thickness : 0;
      return {thickness, dx:initial.dx + (box.vertical ? offset / frame.width : 0),
        dy:initial.dy + (box.vertical ? 0 : offset / frame.height)};
    }
    const move = active.part === 'move';
    const startX = move ? box.extentX + box.extent.width / 2 : box.cx;
    const startY = move ? box.extentY + box.extent.height / 2 : box.cy;
    const anchored: AnalysisColorbarLayout = {x:startX / frame.width,y:startY / frame.height,
      length:box.length / box.span,orientation:initial.direction};
    if (move) {
      const next = moveAnalysisColorbarLayout(anchored, {x:dx,y:dy}, frame, box.extent);
      const original = geometry({...initial,dx:0,dy:0},frame);
      return {dx:(box.x-original.x) / frame.width + next.x - anchored.x,
        dy:(box.y-original.y) / frame.height + next.y - anchored.y};
    }
    const delta = (box.vertical ? dy : dx) * (active.part === 'start' ? -1 : 1);
    const extra = (box.vertical ? box.extent.height : box.extent.width) - box.length;
    const resized = resizeAnalysisColorbarLayout(anchored, delta, box.span, extra);
    return {length:clamp(resized.length * box.span / box.plotSpan * 100, 12, 100)};
  }
  function move(event: PointerEvent<SVGGElement>) {
    const active = drag.current, point = at(event);
    if (!active || !point || active.id !== event.pointerId) return;
    event.stopPropagation();
    const dx = point.x - active.origin.x, dy = point.y - active.origin.y;
    if (!active.moved && Math.hypot(event.clientX-active.screen.x,event.clientY-active.screen.y) < 4) return;
    active.moved = true;
    setDraft(patchFor(active, dx, dy));
  }
  function finish(event: PointerEvent<SVGGElement>) {
    const active = drag.current, point = at(event);
    if (!active || active.id !== event.pointerId) return;
    event.stopPropagation();
    cancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (point && active.moved) onChange(patchFor(active, point.x - active.origin.x, point.y - active.origin.y));
  }
  function inspect(event: MouseEvent<SVGGElement>) {
    const object = (event.target as Element).closest<SVGElement>('[data-scatter-scale-part]');
    const point = object && at(event);
    if (!point) return;
    event.preventDefault(); event.stopPropagation();
    if (object.dataset.scatterScalePart === 'title') onOpenTitle(point);
    else onOpenSettings(point);
  }
  function key(event: KeyboardEvent<SVGGElement>) {
    if (event.key === 'Escape' && drag.current) {event.stopPropagation();cancel();return;}
    const isTitle = (event.target as Element).closest('[data-scatter-scale-part="title"]');
    const point = isTitle ? {x:rect.titleX,y:rect.titleY} : {x:rect.cx,y:rect.cy};
    if (event.key === 'Enter' || (!isTitle && event.key === ' ')) {
      event.preventDefault();
      if (isTitle) onOpenTitle(point, true); else onOpenSettings(point);
    }
    if (isTitle && (event.key === 'Delete' || event.key === 'Backspace') && onDeleteTitle) {
      event.preventDefault();
      event.stopPropagation();
      onDeleteTitle();
    }
  }
  return <g ref={root} className="scatter-color-scale" data-scatter-color-legend="true" data-scatter-scale-direction={current.direction}
    aria-label="色尺" onPointerDown={start} onPointerMove={move} onPointerUp={finish}
    onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={key} onContextMenu={inspect}>
    <defs><linearGradient id={gradientId} x1="0%" y1={vertical ? '100%' : '0%'} x2={vertical ? '0%' : '100%'} y2="0%">
      {scatterScaleStops(current).map(stop => <stop key={stop.offset} offset={stop.offset} stopColor={stop.color}/>)}
    </linearGradient></defs>
    <rect ref={bar} x={x} y={y} width={rect.width} height={rect.height} fill={'url(#' + gradientId + ')'}
      stroke="currentColor" strokeWidth={.7} data-scatter-scale-gradient="true" data-scatter-scale-part="move"
      tabIndex={0} role="button" aria-label="色尺设置"/>
    <g fill={current.ink} fontFamily={current.font} fontSize={rect.font} pointerEvents="none">
      {rect.labels.map(row => {
        const px = vertical ? x + rect.width : x + length * row.position,
          py = vertical ? y + length * (1 - row.position) : y + rect.height;
        return <g key={row.scalar} data-scatter-scale-tick={row.scalar}>
          <line x1={px} y1={py} x2={px + (vertical ? 4 : 0)} y2={py + (vertical ? 0 : 4)} stroke={current.ink}/>
          <text x={px + (vertical ? 6 : 0)} y={py + (vertical ? 0 : rect.font / 2 + 6)}
            dominantBaseline="central" textAnchor={vertical ? 'start' : 'middle'}>{row.name}</text>
        </g>;
      })}
    </g>
    {rect.showTitle && <text x={rect.titleX} y={rect.titleY} dominantBaseline="central" textAnchor="middle"
      transform={vertical ? 'rotate(-90 ' + rect.titleX + ' ' + rect.titleY + ')' : undefined}
      fill={current.ink} fontSize={rect.titleFont} fontFamily={current.title.font ?? current.font}
      fontWeight={current.title.bold ? 700 : 400} fontStyle={current.title.italic ? 'italic' : 'normal'}
      data-scatter-scale-part="title" data-plot-hit="text" data-plot-key="bar"
      data-plot-current={titleSelected || undefined} tabIndex={0}>{current.title.content}</text>}
    {(['side-start','side-end'] as const).map(side => {
      const first = side === 'side-start';
      const px = vertical ? x + (first ? 0 : rect.width) : rect.cx;
      const py = vertical ? rect.cy : y + (first ? 0 : rect.height);
      return <g key={side} data-scatter-scale-part={side} data-scatter-scale-side={side} data-export-exclude="true"
        data-dragging={!!draft && drag.current?.part === side || undefined}>
        <rect x={vertical ? px - sideHit : x + endHit} y={vertical ? y + endHit : py - sideHit}
          width={vertical ? 2 * sideHit : length - 2 * endHit}
          height={vertical ? length - 2 * endHit : 2 * sideHit} fill="transparent"/>
        <line x1={vertical ? px : x} x2={vertical ? px : x + length}
          y1={vertical ? y : py} y2={vertical ? y + length : py} className="scatter-color-scale-edge-ink"/>
      </g>;
    })}
    {(['start','end'] as const).map(side => {
      const px = vertical ? rect.cx : x + (side === 'start' ? 0 : length),
        py = vertical ? y + (side === 'start' ? 0 : length) : rect.cy;
      return <g key={side} data-scatter-scale-part={side} data-scatter-legend-handle={side} data-export-exclude="true"
        data-dragging={!!draft && drag.current?.part === side || undefined}>
        <rect x={vertical ? x - sideHit : px - endHit} y={vertical ? py - endHit : y - sideHit}
          width={vertical ? rect.width + 2 * sideHit : 2 * endHit}
          height={vertical ? 2 * endHit : rect.height + 2 * sideHit} fill="transparent"/>
        <line x1={vertical ? x : px} x2={vertical ? x + rect.width : px}
          y1={vertical ? py : y} y2={vertical ? py : y + rect.height} className="scatter-color-scale-edge-ink"/>
      </g>;
    })}
  </g>;
}

function parseTicks(text: string) {
  const chunks = text.trim().split(/[\s,，;；]+/u).filter(Boolean);
  const values = chunks.map(Number);
  return values.every(Number.isFinite) ? [...new Set(values)].sort((a,b) => a-b) : null;
}

interface ScatterColorScaleFieldsProps {
  value: ScatterColorScaleValue;
  onChange: ScatterScaleChange;
  endEdit(): void;
}

/** Shared by the advanced inspector and the on-canvas popup. */
export function ScatterColorScaleFields({value, onChange, endEdit}: ScatterColorScaleFieldsProps) {
  const [low, high] = value.range;
  const format = normalizeResultNumberFormat(value.numberFormat);
  const [bounds, setBounds] = useState([String(low),String(high)]);
  const [ticks, setTicks] = useState(value.tickValues.join(', '));
  useEffect(() => {
    setBounds(old => Number(old[0]) === low && Number(old[1]) === high ? old : [String(low),String(high)]);
  }, [low, high]);
  const tickKey = value.tickValues.join(', ');
  useEffect(() => {
    setTicks(old => parseTicks(old)?.join(', ') === tickKey ? old : tickKey);
  }, [tickKey]);
  const validRange = (values: readonly string[]) => values.every(v => v.trim() && Number.isFinite(Number(v))) &&
    Number(values[0]) < Number(values[1]) && (!value.logarithmic || Number(values[0]) >= 1);
  const updateRange = (index: number, input: string) => {
    const next = [...bounds];next[index] = input;setBounds(next);
    if (validRange(next)) onChange({range:[Number(next[0]),Number(next[1])]}, 'color-scale-range-' + index);
  };
  const updateTitle = (title: Partial<ScatterScaleTitle>, group?: string) => onChange({title:{...value.title,...title}}, group);
  return <section className="scatter-color-scale-fields" aria-label="色尺设置" onBlur={event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) endEdit();
  }}>
    <div className="scatter-color-scale-colors">
      {value.colors.map((color, index) => {
        const name = index === 0 ? '低值色' : index === value.colors.length - 1 ? '高值色' :
          value.zeroCentered && value.colors.length === 3 ? '零点色' : '色阶 ' + (index+1);
        return <label key={index}>{name}<input type="color" aria-label={name} value={color}
          onChange={event => onChange({colors:value.colors.map((c,i) => i === index ? event.target.value : c)}, 'color-scale-stop-' + index)}/></label>;
      })}
    </div>
    <div className="plot-edit-fields">
      {['色阶下限','色阶上限'].map((name,index) => <label key={name}>{name}<NumericInput aria-label={name} step="any"
        aria-invalid={!validRange(bounds)} value={bounds[index]} onChange={event => updateRange(index,event.target.value)}/></label>)}
      <label>方向<select aria-label="色尺方向" value={value.direction}
        onChange={event => onChange({direction:event.target.value as ScatterColorScaleValue['direction']})}>
        <option value="horizontal">横向</option><option value="vertical">纵向</option>
      </select></label>
      <label>刻度方式<select aria-label="色尺刻度方式" value={value.tickMode}
        onChange={event => {
          const tickMode = event.target.value as ScatterScaleTickMode;
          onChange(tickMode === 'custom' && !value.tickValues.length
            ? {tickMode,tickValues:scatterScaleTicks(value)} : {tickMode});
        }}>
        <option value="ends">仅两端</option><option value="automatic">自动</option><option value="custom">自定义</option>
      </select></label>
      {value.tickMode === 'automatic' && <PlotNumber label="色尺刻度数" value={value.tickCount} min={2} max={10} step={1}
        onChange={tickCount => onChange({tickCount:Math.round(tickCount)}, 'color-scale-tick-count')}/>}
      {value.tickMode === 'custom' && <label className="scatter-color-scale-wide">刻度值<input aria-label="色尺刻度值" value={ticks}
        placeholder="用逗号或空格分隔" aria-invalid={parseTicks(ticks) === null}
        onChange={event => {
          const input = event.target.value;
          setTicks(input);
          const next = parseTicks(input);
          if (next) onChange({tickValues:next}, 'color-scale-tick-values');
        }}/></label>}
    </div>
    <details className="plot-edit-position"><summary>尺寸与字体</summary><div className="plot-edit-fields">
      <PlotNumber label="长度 / %" value={Math.round(value.length)} min={12} max={100} step={1}
        onChange={length => onChange({length}, 'color-scale-length')}/>
      <PlotNumber label="厚度 / px" value={value.thickness} {...ANALYSIS_COLORBAR_LIMITS.thickness} step={1}
        onChange={thickness => onChange({thickness}, 'color-scale-thickness')}/>
      <label>字体<select aria-label="色尺字体" value={value.font} onChange={event => onChange({font:event.target.value})}>
        {plotFonts.map(font => <option key={font}>{font}</option>)}
      </select></label>
      <PlotNumber label="字号 / pt" value={value.numberPt} min={5} max={24}
        onChange={numberPt => onChange({numberPt}, 'color-scale-font-size')}/>
      <label>文字颜色<input type="color" aria-label="色尺文字颜色" value={value.ink}
        onChange={event => onChange({ink:event.target.value}, 'color-scale-ink')}/></label>
      <label>数值格式<select aria-label="色尺数值格式" value={format?.mode ?? 'legacy'} onChange={event => {
        const mode = event.currentTarget.value;
        onChange({ numberFormat: mode === 'legacy' ? null : normalizeResultNumberFormat({
          mode: mode as ResultNumberFormatMode, digits: format?.digits ?? value.decimals,
        }) });
      }}><option value="legacy">原有格式</option><option value="decimal">小数位</option><option value="significant">有效数字</option></select></label>
      <PlotNumber label={format?.mode === 'significant' ? '刻度有效位数' : '刻度小数位'} value={format?.digits ?? value.decimals}
        min={format?.mode === 'significant' ? 1 : 0} max={8} step={1} onChange={digits => {
          onChange(format ? { numberFormat: { ...format, digits: Math.round(digits) } } : { decimals: Math.round(digits) }, 'color-scale-decimals');
        }}/>
    </div></details>
    <details className="plot-edit-position"><summary>标题</summary>
      <div className="plot-edit-fields">
        <label className="plot-edit-check"><input type="checkbox" checked={value.title.visible}
          onChange={event => updateTitle({visible:event.target.checked})}/>显示标题</label>
        <label className="scatter-color-scale-wide">标题文字<input aria-label="色尺标题文字" value={value.title.content}
          onChange={event => updateTitle({content:event.target.value}, 'color-scale-title')}/></label>
      </div>
    </details>
  </section>;
}
