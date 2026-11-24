import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {useProjectState} from '../../projects/ui-state';
import type { ReactNode } from 'react';
import { assertResultNotAborted } from '../../results/contracts';
import { plotClientPoint } from '../../results/optimization-plot-axis';
import { scientificPlotLayout } from '../../results/scientific-plot-layout';
import {defaultScientificLinePreset,scientificLinePresets,type ScientificLinePreset,type ScientificLinePresetId} from '../../results/scientific-line-presets';
import { useScientificPlotSize } from './ScientificPlotSize';
import { formatPlotTick, nearestScientificPlotIndex, nearestScientificStickIndex, plotDataBounds, plotTicks, scientificPlotPaths, validPlotViewport, zoomPlotViewport } from '../../results/scientific-plot';
import type { ScientificPlotPoint, ScientificPlotSeries, ScientificPlotViewport } from '../../results/scientific-plot';
import { exportBlob } from './export-image';
import { decimalEnergyValue, formatResultValue, fullPrecisionValue } from '../../results/numeric-format';
import { isEnergyUnit } from '../../results/energy';
import { captureScientificSvgPng, serializeOptimizationSvg } from './optimization-export';
import './OptimizationPlot.css';
import { ScientificPlotExportMenu } from './ScientificPlotExportMenu';
import { ScientificImageCopyButton } from '../ScientificImageCopyButton';
import { ScientificPlotSettings, usePlotAppearance, usePlotFont, plotFontFamily, plotPt,type PlotAppearance } from './ScientificPlotSettings';
import InteractiveScientificPlot from './InteractiveScientificPlot';
import {ResultsMcpPlotRegistration,type NativeMcpSettings,type PlotExportFormat} from './results-mcp-context';
import {settingBool,settingEnum} from './analysis-mcp-settings';
import {objectSchema} from '../mcp/types';
import type {PlotFigureRecord} from './scientific-plot-figure';
import type { PlotAxisTransforms, PlotSpectrumSettings } from '../../results/scientific-plot-editing';
import type { PlotSecondaryAxis } from './ScientificPlotDrawing';
import {isPlotAxisHit,plotHit,usePlotResizePart} from './use-plot-gestures';

export type { ScientificPlotPoint, ScientificPlotSeries, ScientificPlotViewport };
/** SciYue --teal primary, followed by restrained contrasting theme companions. */
export const SCIENTIFIC_PLOT_THEME_COLORS = ['#147d75', '#32658a', '#ad773d', '#607f88', '#627a50', '#a55f4a'] as const;
const plotSeriesColor = (line: ScientificPlotSeries, index: number, preset?: ScientificLinePreset) => line.color
  ?? (index === 0 && preset ? preset.color : SCIENTIFIC_PLOT_THEME_COLORS[index % SCIENTIFIC_PLOT_THEME_COLORS.length]);
function wrapPlotText(value: string, maxUnits: number): string[] {
  const lines: string[] = []; let line = '', units = 0;
  for (const char of value) { const width = char.codePointAt(0)! > 255 ? 1.7 : 1; if (line && (units + width > maxUnits || char === '\n')) { lines.push(line); line = ''; units = 0; } if (char !== '\n') { line += char; units += width; } }
  if (line || !lines.length) lines.push(line); return lines;
}

/** Stable data-space layer: resizing changes one parent transform rather than
 * recalculating and writing hundreds of point coordinates and SVG paths. */
const DataSpaceLine = memo(function DataSpaceLine({ line, color, xmin, xmax, ymin, ymax, reverseX, reverseY, onSelectIndex, decimals, markers, energyX, energyY, preset }: {
  line: ScientificPlotSeries; color: string; xmin: number; xmax: number; ymin: number; ymax: number;
  reverseX: boolean; reverseY: boolean; onSelectIndex?: (index: number) => void; decimals?: number; markers: boolean; energyX:boolean;energyY:boolean;
  preset?: ScientificLinePreset;
}) {
  const px = (value: number) => (reverseX ? 1 - (value - xmin) / (xmax - xmin) : (value - xmin) / (xmax - xmin)) * 10000;
  const py = (value: number) => (reverseY ? (value - ymin) / (ymax - ymin) : 1 - (value - ymin) / (ymax - ymin)) * 10000;
  const valid = line.points.filter(point => point.y !== null && Number.isFinite(point.x) && Number.isFinite(point.y));
  const number = (value: number, energy=false) => {const text=decimals === undefined ? fullPrecisionValue(value) : formatResultValue(value, decimals);return energy?decimalEnergyValue(text):text;};
  const markerPath = markers && !line.dashed ? valid.map(point => `M${px(point.x)},${py(point.y!)} l0,0`).join(' ') : '';
  const markerWidth = preset ? plotPt(preset.markerSize + preset.markerBorder) : 6.8;
  return <>
    {scientificPlotPaths(line.points, px, py).map((path, index) => <path key={index} d={path} fill="none" stroke={color} strokeWidth={preset ? plotPt(preset.lineWidth) : 2.4} strokeDasharray={line.dashed ? '6 4' : undefined} vectorEffect="non-scaling-stroke"/>)}
    {markerPath && <path data-plot-markers={preset?.hollow ? 'hollow' : 'solid'} data-point-count={valid.length} d={markerPath} fill="none" stroke={color} strokeWidth={markerWidth} strokeLinecap="round" vectorEffect="non-scaling-stroke" pointerEvents="none"/>}
    {markerPath && preset?.hollow && <path d={markerPath} fill="none" stroke="white" strokeWidth={plotPt(preset.markerSize - preset.markerBorder)} strokeLinecap="round" vectorEffect="non-scaling-stroke" pointerEvents="none"/>}
    {valid.map((point, index) => {
      const frame = point.index;
      const selectable = onSelectIndex !== undefined && frame !== undefined;
      if (!selectable && !point.tooltip) return null;
      const d = `M${px(point.x)},${py(point.y!)} l0,0`;
      const target = {d,fill:'none',stroke:'transparent',strokeWidth:16,strokeLinecap:'round' as const,vectorEffect:'non-scaling-stroke'};
      if (!selectable) return <path key={index} {...target} data-plot-point-readout="true"><title>{point.tooltip}</title></path>;
      return <path key={index} {...target} data-plot-point-index={frame} role="button" tabIndex={0}
        aria-label={point.label ?? `选择帧 ${frame + 1}，${number(point.y!,energyY)}`} style={{ cursor: 'pointer' }}
        onClick={event => { if (event.detail === 0) { event.stopPropagation(); onSelectIndex(frame); } }}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectIndex(frame); } }}>
        <title>{point.tooltip ?? point.label ?? `${number(point.x,energyX)} · ${number(point.y!,energyY)}`}</title>
      </path>;
    })}
  </>;
});
export interface ScientificPlotProps {
  mcpConfiguration?:NativeMcpSettings;
  title: string; xLabel: string; yLabel: string; series: readonly ScientificPlotSeries[];
  selectedIndex?: number; onSelectIndex?(index: number): void;
  /** Energy/trajectory picks seek by X; discrete levels select only their own series. */
  selectionMode?: 'x' | 'series';
  reverseX?: boolean; reverseY?: boolean;
  viewport?: ScientificPlotViewport | null; onViewportChange?(value: ScientificPlotViewport | null): void;
  resetKey?: string | number; exportFileName?: string; exportText?: { fileName: string; text: string | (()=>string) };
  ariaLabel?: string; testId?: string; metadata?: unknown; height?: number; responsive?: boolean; children?: ReactNode;
  exportLabel?: string; subtitle?: string;
  /** Controls of this figure, composed into its owning toolbar. */
  toolbar?: ReactNode;
  xSamplingControls?: ReactNode;
  hasSpectrumSticks?: boolean;
  onResetDefaults?(): void;
  xDomain?: [number, number];
  showXTicks?: boolean;
  /** Data-point fallback text only; axis ticks keep their zoom-aware precision. */
  decimals?: number;
  /** Raw sticks retain their own intensity unit and scale alongside a broadened curve. */
  secondaryYAxis?: PlotSecondaryAxis;
  /** Stable source + figure identity, independent of scientific display settings. */
  appearanceKey?: string | number;
  /** The result projection and the editor can share one figure history. */
  figureRecord?: PlotFigureRecord;
  /** Spectra never carry point markers, including the selected raw stick. */
  plotStyle?: 'numeric' | 'spectrum' | 'histogram' | 'orbital' | 'plain';
  plotPresetScope?: string;
  pointReadout?: {kind: 'Frame' | 'Iteration' | 'Source Node' | 'Mode' | 'State' | 'Bin' | 'Orbital'; xUnit?: string; yUnit?: string};
  onSetZeroPoint?(point: ScientificPlotPoint): void;
  selectingZero?: boolean;
  axisTransforms?: PlotAxisTransforms;
  axisContext?: string;
  spectrumPeaks?: readonly ScientificPlotPoint[];
  spectrumInset?: {
    fwhmUnit: string; settings: PlotSpectrumSettings; axisUnit?: string;
    convertRange?(range: [number, number], fromUnit: string): [number, number] | undefined;
    build(settings: PlotSpectrumSettings, range?: [number, number]): {
      series: readonly ScientificPlotSeries[]; secondaryYAxis?: PlotSecondaryAxis; yLabel?: string; peaks?: readonly ScientificPlotPoint[];
    };
  };
}

export function ScientificPlot(p: ScientificPlotProps) {
  const continuous = p.selectionMode !== 'series' && !p.secondaryYAxis && p.series.length > 0
    && p.series.every(line => (line.kind === undefined || line.kind === 'line') && !line.pointLabels)
    && (p.plotStyle !== 'plain' || p.series.some(line => line.showPoints));
  return (p.plotStyle === 'spectrum' || p.plotStyle === 'histogram' || p.plotStyle === 'orbital' || continuous)
    ? <InteractiveScientificPlot {...p}/> : <OrdinaryScientificPlot {...p}/>;
}

/** Display-only history. Scientific selection and the input arrays are never changed by zoom. */
export function useScientificPlotViewport(full: ScientificPlotViewport | null, options: Pick<ScientificPlotProps, 'viewport' | 'onViewportChange' | 'resetKey' | 'appearanceKey'> = {}) {
  const [local, setLocal] = useProjectState<ScientificPlotViewport | null>('plot.viewport',null,options.appearanceKey??options.resetKey);
  const [history, setHistory] = useState<(ScientificPlotViewport | null)[]>([]);
  const previousKey = useRef(options.resetKey), callback = useRef(options.onViewportChange); callback.current = options.onViewportChange;
  const controlled = options.viewport !== undefined;
  const chosen = controlled ? options.viewport : local;
  const viewport = validPlotViewport(chosen) ? chosen : full;
  const set = (value: ScientificPlotViewport | null) => { if (!controlled) setLocal(value); callback.current?.(value); };
  useEffect(() => {
    if (previousKey.current === options.resetKey) return;
    previousKey.current = options.resetKey; setLocal(null); setHistory([]); callback.current?.(null);
  }, [options.resetKey]);
  return { viewport, canGoBack: history.length > 0, zoomed: validPlotViewport(chosen),
    zoom(value: ScientificPlotViewport) { if (!validPlotViewport(value)) return; setHistory(current => [...current, validPlotViewport(chosen) ? chosen : null]); set(value); },
    back() { if (!history.length) return; set(history[history.length - 1]); setHistory(current => current.slice(0, -1)); },
    reset() { setHistory([]); set(null); },
  };
}

function OrdinaryScientificPlot({ title, xLabel, yLabel, series, selectedIndex, onSelectIndex, selectionMode = 'x', reverseX = false, reverseY = false,
  viewport: controlledViewport, onViewportChange, resetKey, exportFileName = 'Ester-Studio-plot', exportText, ariaLabel = title,
  testId, metadata, height, responsive = true, children, exportLabel = '', subtitle, xDomain, showXTicks = true, decimals, secondaryYAxis, toolbar, onResetDefaults, appearanceKey, plotStyle = 'numeric',mcpConfiguration }: ScientificPlotProps) {
  const linePresets = !secondaryYAxis && selectionMode === 'x' && plotStyle !== 'spectrum'
    && series.length > 0 && series.every(line => (line.kind === undefined || line.kind === 'line') && !line.pointLabels)
    && (plotStyle === 'numeric' || series.some(line => line.showPoints));
  const appearance = usePlotAppearance(appearanceKey, linePresets), textStyle = appearance.value, preset = appearance.preset;
  const yAxisSize = textStyle.yAxisSize ?? textStyle.axisSize;
  const axisColor = preset?.axisColor ?? '#111111';
  const axisStroke = preset ? plotPt(preset.axisWidth) : 1;
  const tickDirection = preset?.inwardTicks || plotStyle === 'spectrum' ? -1 : 1;
  const displayTitle = textStyle.title ?? title, displayX = textStyle.xLabel ?? xLabel, displayY = textStyle.yLabel ?? yLabel;
  const energyX=isEnergyUnit(xLabel.split(' / ').at(-1)),energyY=isEnergyUnit(yLabel.split(' / ').at(-1));
  const dataNumber = (value: number, energy=false) => {const text=decimals === undefined ? fullPrecisionValue(value) : formatResultValue(value, decimals);return energy?decimalEnergyValue(text):text;};
  const axisNumber=(value:number,step:number,energy:boolean)=>{const text=formatPlotTick(value,step);return energy?decimalEnergyValue(text):text;};
  const hostRef = useRef<HTMLDivElement>(null), svgRef = useRef<SVGSVGElement>(null);
  const sizing = useScientificPlotSize(appearanceKey??exportFileName);
  const stage=useRef<HTMLDivElement>(null);
  const assignStage=useCallback((node:HTMLDivElement|null)=>{stage.current=node;sizing.stageRef(node);},[sizing.stageRef]);
  const [resizePart,setResizePart]=usePlotResizePart(stage);
  usePlotFont(hostRef.current?.ownerDocument);
  const [message, setMessage] = useState(''), [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; end: { x: number; y: number }; pointerId: number; directIndex?: number } | null>(null);
  const dragRef = useRef<typeof drag>(null), suppressClick = useRef(false);
  const clipId = `plot-${useId().replace(/:/g, '')}`;
  const layoutTitle = preset && !displayTitle ? title : displayTitle;
  let layout = scientificPlotLayout(sizing.width, layoutTitle, {
    height: sizing.height ?? height ?? (preset ? Math.max(220, Math.round(sizing.width / preset.ratio)) : undefined), subtitle: !!subtitle, square: true,
  });
  const titleLines = layoutTitle ? wrapPlotText(layoutTitle, Math.max(8, (layout.width - 32) / (plotPt(textStyle.titleSize) * .6))) : [];
  const subtitleLines = subtitle ? wrapPlotText(subtitle, Math.max(8,(layout.width - 32) / 7.2)) : [];
  const subtitleSpace = Math.max(0,subtitleLines.length - 1) * 16;
  const titleSpace = titleLines.length ? Math.max(0, titleLines.length * (plotPt(textStyle.titleSize) + 4) - layout.titleLines.length * 18) : -layout.titleLines.length * 18;
  const footerSpace = Math.max(0, plotPt(textStyle.axisSize) - 14) + Math.max(0, plotPt(textStyle.tickSize) - 12);
  layout = { ...layout, top: layout.top + titleSpace + subtitleSpace, bottom: Math.max(layout.top + titleSpace + subtitleSpace + 60, layout.bottom - footerSpace), height: Math.max(layout.height, layout.top + titleSpace + subtitleSpace + 116) };
  layout = { ...layout, left: Math.max(layout.left, 62 + Math.max(0, plotPt(yAxisSize) - 14) * 2) };
  const full = useMemo(() => { const data = plotDataBounds(series); return data && xDomain && Number.isFinite(xDomain[0]) && Number.isFinite(xDomain[1]) && xDomain[0] < xDomain[1] ? { ...data, x: xDomain } : data; }, [series, xDomain]);
  const view = useScientificPlotViewport(full, { viewport: controlledViewport, onViewportChange, resetKey,appearanceKey:appearanceKey??exportFileName });
  const range = view.viewport;
  if (range) {
    const ticks = plotTicks(range.y, layout.bottom - layout.top, 48);
    const labelWidth = Math.max(...ticks.major.map(value => axisNumber(value, ticks.step,energyY).length), 0) * plotPt(textStyle.tickSize) * .6 + 14;
    layout = { ...layout, left: Math.max(layout.left, Math.min(labelWidth + 34, layout.right - 100)) };
  }
  const secondaryBounds = secondaryYAxis ? plotDataBounds(secondaryYAxis.series) : null;
  const secondaryRange: [number, number] | undefined = secondaryBounds ? [Math.min(0, secondaryBounds.y[0]), Math.max(0, secondaryBounds.y[1])] : undefined;
  const secondaryTicks = secondaryRange ? plotTicks(secondaryRange, layout.bottom - layout.top, 48) : undefined;
  if (secondaryTicks) layout = { ...layout, right: Math.max(layout.left + 80, layout.width - Math.max(62, ...secondaryTicks.major.map(value => axisNumber(value, secondaryTicks.step,isEnergyUnit(secondaryYAxis?.label.split(' / ').at(-1))).length * 7 + 40))) };
  const frameOffsets = preset?.frameOffsets;
  const frameShift = frameOffsets ? { left: frameOffsets.left * layout.width, top: frameOffsets.top * layout.height } : { left: 0, top: 0 };
  if (frameOffsets) {
    const left = layout.left + frameShift.left, top = layout.top + frameShift.top;
    layout = { ...layout, left, top,
      right: Math.max(left + 60, layout.right + frameOffsets.right * layout.width),
      bottom: Math.max(top + 60, layout.bottom + frameOffsets.bottom * layout.height) };
  }
  useEffect(() => { setExporting(false); return () => { exportController.current?.abort(); }; }, [resetKey]);
  const sampled = useMemo(() => [...series.map(line => ({ ...line, secondary: false })), ...(secondaryYAxis?.series.map(line => ({ ...line, secondary: true })) ?? [])], [series, secondaryYAxis]);
  const paths = useMemo(() => {
    if (!range) return sampled.map(() => [] as string[]);
    const px = (value: number) => layout.left + (reverseX ? 1 - (value - range.x[0]) / (range.x[1] - range.x[0]) : (value - range.x[0]) / (range.x[1] - range.x[0])) * (layout.right - layout.left);
    const py = (value: number, bounds: readonly [number, number]) => layout.bottom - (reverseY ? 1 - (value - bounds[0]) / (bounds[1] - bounds[0]) : (value - bounds[0]) / (bounds[1] - bounds[0])) * (layout.bottom - layout.top);
    return sampled.map(line => line.kind === 'stick' || line.kind === 'histogram' || selectionMode === 'x' && !line.pointLabels ? [] : scientificPlotPaths(line.points, px, value => py(value, line.secondary && secondaryRange ? secondaryRange : range.y)));
  }, [sampled, range?.x[0], range?.x[1], range?.y[0], range?.y[1], layout.left, layout.right, layout.top, layout.bottom, reverseX, reverseY, secondaryRange?.[0], secondaryRange?.[1], selectionMode]);
  const selectableSeries = secondaryYAxis ? secondaryYAxis.series : series;
  const capturePng = (owner: Document, signal: AbortSignal) => captureScientificSvgPng(svgRef.current, owner, signal);
  async function captureExport(format:PlotExportFormat,signal:AbortSignal) {
    const svg=svgRef.current;if(!svg?.isConnected)throw new Error('图窗尚未准备好或已关闭。');
    if(format==='raw'||format==='txt'&&!exportText)throw new Error('当前图形没有该格式的导出。');
    const blob=format==='png'?await capturePng(svg.ownerDocument,signal):new Blob([
      format==='txt'?typeof exportText?.text==='function'?exportText.text():exportText?.text??'':serializeOptimizationSvg(svg),
    ],{type:format==='svg'?'image/svg+xml;charset=utf-8':'text/plain;charset=utf-8'});
    assertResultNotAborted(signal);
    return {blob,filename:format==='txt'?exportText!.fileName:`${exportFileName}.${format}`};
  }
  const mcpAppearance=useMemo(()=>({text:{title:{content:appearance.stored.title},x:{content:appearance.stored.xLabel},y:{content:appearance.stored.yLabel}},
    presetId:appearance.stored.linePreset}),[appearance.stored]);
  const assertFigureIdle=()=>{if(dragRef.current)throw new Error('图形手势正在进行。');};
  const fontSize={type:'number',minimum:5,maximum:36};
  const mcpPort=range?<ResultsMcpPlotRegistration chartId={clipId} figureIdentity={`${appearance.key}:${String(resetKey)}`} port={{
    read:()=>({title:displayTitle,xLabel:displayX,yLabel:displayY,family:'legacy',figure:mcpAppearance,range,metadata,
      series:sampled.map(({id,label,points})=>({id,label,pointCount:points.length})),textIds:['title','x','y'],edits:['text','axis-range','undo'],
      formats:['svg','png',...(exportText?['txt' as const]:[])],presets:preset?Object.entries(scientificLinePresets).map(([id,value])=>({id,label:value.label})):[],
      defaultPresetId:preset?defaultScientificLinePreset:undefined,canUndo:view.canGoBack,canRedo:false}),
    edit(change,part='main'){
      assertFigureIdle();
      if(part==='inset')throw new Error('当前图面没有副图。');
      if(change.operation==='text')appearance.update({[change.role==='x'?'xLabel':change.role==='y'?'yLabel':'title']:change.text});
      else if(change.operation==='axis-range'&&full)view.zoom({...range,[change.axis]:change.bounds??full[change.axis]});
      else if(change.operation==='undo')view.back();
      else throw new Error('当前图面仅能修改标题、坐标轴文本和显示范围。');
    },
    preset(id){assertFigureIdle();if(!preset||!Object.hasOwn(scientificLinePresets,id))throw new Error('当前图面没有此预设。');appearance.update({linePreset:id as ScientificLinePresetId});},
    configuration:{appearance:{schema:objectSchema({font:settingEnum(['DejaVu Sans','Arial']),titleSize:fontSize,axisSize:fontSize,yAxisSize:fontSize,tickSize:fontSize,legendSize:fontSize,reset:settingBool}),
      read:()=>textStyle,apply(values){assertFigureIdle();const {reset,...patch}=values as Partial<PlotAppearance>&{reset?:boolean};
        if(reset&&Object.keys(patch).length)throw new Error('恢复图形默认设置请单独提交。');
        if(reset){appearance.reset();sizing.reset();onResetDefaults?.();}else appearance.update(patch);}},
      ...(mcpConfiguration?{presentation:{...mcpConfiguration,apply:(patch:Record<string,unknown>)=>{assertFigureIdle();mcpConfiguration.apply(patch);}}}:{})},
    export:captureExport,isVisible:()=>!!svgRef.current?.getClientRects().length,
  }}/>:null;
  const exportFigure = async (format: 'png' | 'svg' | 'txt') => {
    const svg = svgRef.current; if (!svg || exporting) return;
    const controller = new AbortController(); exportController.current = controller; setExporting(true); setMessage('');
    try {
      const {blob,filename}=await captureExport(format,controller.signal);
      exportBlob(blob,filename,svg.ownerDocument);
      setMessage(`已发起 ${format.toUpperCase()} 下载。`);
    } catch (error) { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '图表导出失败。'); }
    finally { if (exportController.current === controller) exportController.current = null; if (!controller.signal.aborted) setExporting(false); }
  };
  if (!range) return <div ref={hostRef}><p className="optimization-plot-empty">没有可绘制的数值。</p></div>;
  const x = (value: number) => layout.left + (reverseX ? 1 - (value - range.x[0]) / (range.x[1] - range.x[0]) : (value - range.x[0]) / (range.x[1] - range.x[0])) * (layout.right - layout.left);
  const y = (value: number) => layout.bottom - (reverseY ? 1 - (value - range.y[0]) / (range.y[1] - range.y[0]) : (value - range.y[0]) / (range.y[1] - range.y[0])) * (layout.bottom - layout.top);
  const secondaryY = (value: number) => layout.bottom - (reverseY ? 1 - (value - secondaryRange![0]) / (secondaryRange![1] - secondaryRange![0]) : (value - secondaryRange![0]) / (secondaryRange![1] - secondaryRange![0])) * (layout.bottom - layout.top);
  const xTicks = plotTicks(range.x, layout.right - layout.left), yTicks = plotTicks(range.y, layout.bottom - layout.top, 48);
  const inside = (point: { x: number; y: number }) => point.x >= layout.left && point.x <= layout.right && point.y >= layout.top && point.y <= layout.bottom;
  const stickIndex = (position: { x: number; y: number }) => nearestScientificStickIndex(selectableSeries, position, x, secondaryYAxis && secondaryRange ? secondaryY : y);
  const seek = (position: { x: number; y: number }) => {
    if (!inside(position) || selectionMode === 'series') return;
    const f = (position.x - layout.left) / (layout.right - layout.left);
    const index = stickIndex(position) ?? nearestScientificPlotIndex(selectableSeries, range.x[0] + (reverseX ? 1 - f : f) * (range.x[1] - range.x[0]));
    if (index !== null) onSelectIndex?.(index);
  };
  const selected = selectedIndex === undefined ? undefined : selectableSeries.flatMap(line => line.points).find(point => selectedIndex !== undefined && point.index === selectedIndex);
  const selectedY = secondaryYAxis && secondaryRange ? secondaryY : y;
  const selectedLabel = preset?.showSelectedLabel && selectedIndex !== undefined && selected?.y != null
    && inside({ x: x(selected.x), y: y(selected.y) }) ? `Frame ${selectedIndex + 1}` : null;
  const annotationOnRight = selected ? x(selected.x) < (layout.left + layout.right) / 2 : false;
  const plotActions = <div className="optimization-plot-options scientific-plot-tools scientific-plot-actions" aria-label="图像操作">
      <button type="button" disabled={!view.canGoBack} onClick={view.back}>返回上一级</button>
      <button type="button" onClick={() => { view.reset(); sizing.reset(); }}>恢复视图</button>
      <ScientificImageCopyButton resetKey={resetKey} capture={capturePng}/>
      <ScientificPlotExportMenu disabled={exporting} options={[
        { key: 'svg', label: `${exportLabel ? `${exportLabel} · ` : ''}SVG`, run: () => void exportFigure('svg') },
        { key: 'png', label: `${exportLabel ? `${exportLabel} · ` : ''}PNG`, run: () => void exportFigure('png') },
        ...(exportText ? [{ key: 'txt', label: '数据 TXT', run: () => void exportFigure('txt') }] : []),
      ]}/>{children}
    </div>;
  return <div ref={hostRef} className={`scientific-plot${responsive ? ' optimization-plot-responsive' : ''}`}>
    {mcpPort}
    {toolbar && <div className="optimization-plot-options scientific-plot-tools scientific-plot-data-controls" aria-label="数据与显示">{toolbar}</div>}
    <ScientificPlotSettings appearance={{ ...appearance, reset: () => { appearance.reset(); sizing.reset(); onResetDefaults?.(); } }} title={title} xLabel={xLabel} yLabel={yLabel} names={sampled.map(line => ({ id: line.id, label: line.label ?? line.id }))}>{sizing.controls(layout.height)}</ScientificPlotSettings>
    <div className="scientific-plot-viewport"><div ref={assignStage} className="scientific-plot-stage" style={sizing.style(layout.height)}>
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} className="optimization-energy-svg scientific-plot-svg" role="group" aria-label={ariaLabel} data-testid={testId}
      fontFamily={plotFontFamily(textStyle.font)} data-plot-style={plotStyle} data-line-preset={preset ? (preset.hollow ? 'hollow' : 'solid') : undefined} data-plot-page-mm={preset?.pageWidthMm} data-plot-left={layout.left} data-plot-right={layout.right} data-plot-top={layout.top} data-plot-bottom={layout.bottom}
      data-x-min={range.x[0]} data-x-max={range.x[1]} data-y-min={range.y[0]} data-y-max={range.y[1]} data-reverse-x={reverseX} data-reverse-y={reverseY}
      onPointerDown={event => { if (event.button !== 0 || isPlotAxisHit(plotHit(event.target))) return; const point = plotClientPoint(event.currentTarget, event.clientX, event.clientY); if (!point || !inside(point)) return;
        const targetIndex = (event.target as Element).closest?.('[data-plot-point-index]')?.getAttribute('data-plot-point-index');
        const next = { start: point, end: point, pointerId: event.pointerId, directIndex: stickIndex(point) ?? (targetIndex == null ? undefined : Number(targetIndex)) }; dragRef.current = next; setDrag(next); event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={event => { const active = dragRef.current; if (!active || active.pointerId !== event.pointerId) return; const point = plotClientPoint(event.currentTarget, event.clientX, event.clientY); if (!point) return; const next = { ...active, end: point }; dragRef.current = next; setDrag(next); }}
      onPointerUp={event => { const active = dragRef.current; if (!active || active.pointerId !== event.pointerId) return; const point = plotClientPoint(event.currentTarget, event.clientX, event.clientY) ?? active.end; dragRef.current = null; setDrag(null); event.currentTarget.releasePointerCapture?.(event.pointerId); suppressClick.current = true;
        if (Math.abs(point.x - active.start.x) >= 5 && Math.abs(point.y - active.start.y) >= 5) { const next = zoomPlotViewport(range, active.start, point, layout, reverseX, reverseY); if (next) view.zoom(next); }
        else if (Math.hypot(point.x - active.start.x, point.y - active.start.y) < 5) { if (active.directIndex !== undefined) onSelectIndex?.(active.directIndex); else seek(point); } }}
      onPointerCancel={() => { dragRef.current = null; setDrag(null); suppressClick.current = true; }}
      onClick={event => {
        if (isPlotAxisHit(plotHit(event.target))) {suppressClick.current=false;setResizePart('main');event.currentTarget.focus({preventScroll:true});return;}
        if (suppressClick.current) { suppressClick.current = false; return; }
        const point = plotClientPoint(event.currentTarget, event.clientX, event.clientY); if (point) seek(point); }}
      tabIndex={0} onKeyDown={event=>{if(event.key==='Escape'&&resizePart){event.stopPropagation();setResizePart(undefined);}}}>
      <title>{displayTitle || ariaLabel}</title><desc>{`${displayX}；${displayY}${secondaryYAxis ? `；棒谱：${secondaryYAxis.label}` : ''}；单击定位，拖框缩放；缺项不连线。`}</desc><metadata>{JSON.stringify({ ...(metadata && typeof metadata === 'object' ? metadata : { metadata }), appearance: textStyle, viewport: range, reverseX, reverseY, ...(secondaryYAxis ? { secondaryYAxis: { label: secondaryYAxis.label, range: secondaryRange } } : {}) })}</metadata>
      <defs><clipPath id={clipId}><rect x={layout.left} y={layout.top} width={layout.right - layout.left} height={layout.bottom - layout.top}/></clipPath></defs>
      <rect width={layout.width} height={layout.height} fill="white"/>
      {displayTitle && titleLines.map((line, index) => <text key={index} x={preset ? (layout.left + layout.right) / 2 : layout.width / 2} y={plotPt(textStyle.titleSize) + 9 + frameShift.top + index * (plotPt(textStyle.titleSize) + 4)} textAnchor="middle" fill="#111111" fontSize={plotPt(textStyle.titleSize)}>{line}</text>)}
      {subtitleLines.length>0 && <text x={16} y={layout.top - 30 - subtitleSpace} fill="var(--ui-note-ink,#475569)" fontSize="12" data-plot-reference="true">{subtitleLines.map((line,index)=><tspan key={index} x={16} dy={index?16:0}>{line}</tspan>)}</text>}
      <text transform={`translate(${18 + frameShift.left} ${(layout.top + layout.bottom) / 2}) rotate(-90)`} textAnchor="middle" fill="#111111" fontSize={plotPt(yAxisSize)}>{displayY}</text>
      {yTicks.major.map(value => <g key={value} data-plot-hit="tick" data-plot-axis="y"><line x1={layout.left - 5 * tickDirection} x2={layout.left} y1={y(value)} y2={y(value)} stroke={axisColor} strokeWidth={axisStroke}/><text x={layout.left - 8} y={y(value) + 4} textAnchor="end" fill="#111111" fontSize={plotPt(textStyle.tickSize)}>{axisNumber(value, yTicks.step,energyY)}</text></g>)}
      {!preset && yTicks.minor.map(value => <line key={value} x1={layout.left - 3 * tickDirection} x2={layout.left} y1={y(value)} y2={y(value)} stroke={axisColor}/>)}
      <rect data-plot-frame="true" x={layout.left} y={layout.top} width={layout.right - layout.left} height={layout.bottom - layout.top} fill="none" stroke={axisColor} strokeWidth={preset ? axisStroke : plotPt(1.1)}/>
      {secondaryYAxis && secondaryTicks && <g data-plot-axis="secondary-y">
        {secondaryTicks.major.map(value => <g key={value}><line x1={layout.right} x2={layout.right + 5} y1={secondaryY(value)} y2={secondaryY(value)} stroke="#111111"/><text x={layout.right + 8} y={secondaryY(value) + 4} fill="#111111" fontSize={plotPt(textStyle.tickSize)}>{axisNumber(value, secondaryTicks.step,isEnergyUnit(secondaryYAxis?.label.split(' / ').at(-1)))}</text></g>)}
        <text transform={`translate(${layout.width - 10} ${(layout.top + layout.bottom) / 2}) rotate(-90)`} textAnchor="middle" fill="#111111" fontSize={plotPt(textStyle.axisSize)}>{appearance.name(secondaryYAxis.series[0]?.id ?? 'secondary', secondaryYAxis.label)}</text>
      </g>}
      {showXTicks && !preset && xTicks.minor.map(value => <line key={value} x1={x(value)} x2={x(value)} y1={layout.bottom} y2={layout.bottom + 3 * tickDirection} stroke={axisColor}/>)}
      {showXTicks && xTicks.major.map(value => <g key={value} data-plot-hit="tick" data-plot-axis="x"><line x1={x(value)} x2={x(value)} y1={layout.bottom} y2={layout.bottom + 5 * tickDirection} stroke={axisColor} strokeWidth={axisStroke}/><text x={x(value)} y={layout.bottom + 21} textAnchor="middle" fill="#111111" fontSize={plotPt(textStyle.tickSize)}>{axisNumber(value, xTicks.step,energyX)}</text></g>)}
      {plotStyle === 'spectrum' && <g data-spectrum-mirrored-ticks="true">{xTicks.major.map(v => <line key={`x-${v}`} x1={x(v)} x2={x(v)} y1={layout.top} y2={layout.top + 5} stroke="#111"/>)}{xTicks.minor.map(v => <line key={`xm-${v}`} x1={x(v)} x2={x(v)} y1={layout.top} y2={layout.top + 3} stroke="#111"/>)}{!secondaryYAxis && yTicks.major.map(v => <line key={`y-${v}`} x1={layout.right} x2={layout.right - 5} y1={y(v)} y2={y(v)} stroke="#111"/>)}</g>}
      <g clipPath={`url(#${clipId})`}>
        {preset?.showZero && range.y[0] < 0 && range.y[1] > 0 && <line data-plot-zero="true" x1={layout.left} x2={layout.right} y1={y(0)} y2={y(0)} stroke={preset.referenceColor} strokeWidth={plotPt(preset.referenceWidth)}/>}
        {sampled.map((line, lineIndex) => { const color = plotSeriesColor(line, lineIndex, preset), lineY = line.secondary && secondaryRange ? secondaryY : y; return <g key={line.id} data-series-id={line.id} data-y-axis={line.secondary ? 'secondary' : 'primary'}><title>{appearance.name(line.id, line.label ?? line.id)}</title>
          {line.kind === 'histogram' ? line.points.map((point, i) => point.y === null || !Number.isFinite(point.y) || !Number.isFinite(point.xEnd) ? null : <rect key={i} data-plot-histogram-bin={i} x={Math.min(x(point.x), x(point.xEnd!))} y={Math.min(lineY(0), lineY(point.y))} width={Math.abs(x(point.xEnd!) - x(point.x))} height={Math.abs(lineY(point.y) - lineY(0))} fill="#b8d8eb" stroke={color} strokeWidth="1"><title>{point.label}</title></rect>) : line.kind !== 'stick' && selectionMode === 'x' && !line.pointLabels ?
          <g transform={`translate(${layout.left} ${layout.top}) scale(${(layout.right - layout.left) / 10000} ${(layout.bottom - layout.top) / 10000})`}><DataSpaceLine line={line} color={color} preset={preset} xmin={range.x[0]} xmax={range.x[1]} ymin={(line.secondary && secondaryRange ? secondaryRange : range.y)[0]} ymax={(line.secondary && secondaryRange ? secondaryRange : range.y)[1]} reverseX={reverseX} reverseY={reverseY} onSelectIndex={onSelectIndex} decimals={decimals} energyX={energyX} energyY={line.secondary?isEnergyUnit(secondaryYAxis?.label.split(' / ').at(-1)):energyY} markers={plotStyle !== 'spectrum' && (plotStyle === 'numeric' || !!line.showPoints)}/></g> : line.kind === 'stick' ? line.points.map((point, i) => point.y === null || !Number.isFinite(point.x) || !Number.isFinite(point.y) ? null : <g key={i}>
            <line x1={x(point.x)} x2={x(point.x)} y1={lineY(0)} y2={lineY(point.y)} stroke={selectedIndex !== undefined && point.index === selectedIndex ? '#3b9660' : color} strokeWidth={selectedIndex !== undefined && point.index === selectedIndex ? 2.5 : 1.5}/>
            {onSelectIndex && point.index !== undefined && <line data-plot-stick-hit="true" data-plot-point-index={point.index} role="button" tabIndex={0} aria-label={point.tooltip ?? point.label ?? `选择模式 ${point.index}`} aria-pressed={selectedIndex !== undefined && point.index === selectedIndex}
              x1={x(point.x)} x2={x(point.x)} y1={lineY(0)} y2={lineY(point.y)} stroke="transparent" strokeWidth="16" strokeLinecap="round" style={{cursor:'pointer'}}
              onClick={event => { if (event.detail === 0) { event.stopPropagation(); onSelectIndex(point.index!); } }} onKeyDown={event => { if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelectIndex(point.index!);} }}><title>{point.tooltip ?? point.label ?? `${dataNumber(point.x,energyX)} · ${dataNumber(point.y,line.secondary?isEnergyUnit(secondaryYAxis?.label.split(' / ').at(-1)):energyY)}`}</title></line>}
          </g>) : paths[lineIndex].map((path, i) => { const point = line.points.find(point => point.index !== undefined), selectable = selectionMode === 'series' && onSelectIndex && point?.index !== undefined;
            return <g key={i}><path d={path} fill="none" stroke={color} strokeWidth="2.4" strokeDasharray={line.dashed ? '6 4' : undefined}/>{selectable && <path d={path} fill="none" stroke="transparent" strokeWidth="12" data-plot-point-index={point.index} role="button" tabIndex={0} aria-label={point.tooltip ?? point.label ?? line.label ?? line.id}
              onClick={event => { if(event.detail===0){event.stopPropagation();onSelectIndex!(point.index!);} }} onKeyDown={event => { if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelectIndex!(point.index!);} }}/>}</g>; })}
          {plotStyle !== 'spectrum' && onSelectIndex && selectionMode === 'x' && (line.kind === 'stick' || line.pointLabels) && line.points.map((point, i) => point.index === undefined || point.y === null || !Number.isFinite(point.y) || !Number.isFinite(point.x) ? null : <circle key={i} data-plot-point-index={point.index} role="button" tabIndex={0} aria-label={point.label ?? `选择帧 ${point.index + 1}，${dataNumber(point.y,line.secondary?isEnergyUnit(secondaryYAxis?.label.split(' / ').at(-1)):energyY)}`} aria-pressed={selectedIndex !== undefined && point.index === selectedIndex} cx={x(point.x)} cy={lineY(point.y)} r={selectedIndex !== undefined && point.index === selectedIndex ? 5 : 3.5} fill={selectedIndex !== undefined && point.index === selectedIndex ? '#ca7b29' : color}
            onClick={event => { if (event.detail === 0) { event.stopPropagation(); onSelectIndex(point.index!); } }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectIndex(point.index!); } }}><title>{point.tooltip ?? point.label ?? `${dataNumber(point.x,energyX)} · ${dataNumber(point.y,line.secondary?isEnergyUnit(secondaryYAxis?.label.split(' / ').at(-1)):energyY)}`}</title></circle>)}
          {line.pointLabels && line.points.map((point, i) => (point.label || textStyle.names[line.id] !== undefined && i === line.points.length - 1) && point.y !== null && Number.isFinite(point.x) && Number.isFinite(point.y) ? <text key={`label-${i}`} x={x(point.x) + 7} y={lineY(point.y) - 7} fill={color} fontSize={plotPt(textStyle.legendSize)} pointerEvents="none">{appearance.name(line.id, point.label ?? line.label ?? line.id)}</text> : null)}
        </g>; })}
        {selected && Number.isFinite(selected.x) && <line x1={x(selected.x)} x2={x(selected.x)} y1={layout.top} y2={layout.bottom} stroke="#ca7b29" strokeDasharray="4 3"/>}
        {plotStyle !== 'spectrum' && selected?.y != null && Number.isFinite(selected.y) && <circle cx={x(selected.x)} cy={selectedY(selected.y)} r="5" fill="#ca7b29" pointerEvents="none"/>}
        {selectedLabel && selected?.y != null && Number.isFinite(selected.x) && Number.isFinite(selected.y) && <text data-plot-selected-label="true"
          x={x(selected.x) + (annotationOnRight ? 8 : -8)} y={Math.max(layout.top + plotPt(textStyle.annotationSize ?? textStyle.legendSize), y(selected.y) - 8)}
          textAnchor={annotationOnRight ? 'start' : 'end'} fill="#111111" fontSize={plotPt(textStyle.annotationSize ?? textStyle.legendSize)} pointerEvents="none">{selectedLabel}</text>}
      </g>
      {((plotStyle !== 'plain' && sampled.length > 1) || Object.keys(textStyle.names).length > 0) && selectionMode !== 'series' && <g data-plot-series-legend="true">{(() => { let nextY = layout.top + 18; return sampled.filter(line => !line.pointLabels).map(line => { const lines = wrapPlotText(appearance.name(line.id, line.label ?? line.id), Math.max(5, (layout.right - layout.left - 64) / (plotPt(textStyle.legendSize) * .6))), top = nextY; nextY += lines.length * (plotPt(textStyle.legendSize) + 4) + 4; return <g key={line.id} transform={`translate(${layout.left + 12} ${top})`}><line x1={0} x2={22} stroke={plotSeriesColor(line, sampled.indexOf(line), preset)} strokeWidth={preset ? plotPt(preset.lineWidth) : 2.4} strokeDasharray={line.dashed && preset ? '6 4' : undefined}/><text x={28} y={4} fontSize={plotPt(textStyle.legendSize)} fill="#111">{lines.map((label, j) => <tspan key={j} x={28} dy={j ? plotPt(textStyle.legendSize) + 4 : 0}>{label}</tspan>)}</text></g>; }); })()}</g>}
      <text x={(layout.left + layout.right) / 2} y={layout.bottom + 45} textAnchor="middle" fill="#111111" fontSize={plotPt(textStyle.axisSize)}>{displayX}</text>
      <g data-plot-interaction="layout" stroke="transparent" strokeWidth={9}>
        <line data-plot-hit="axis" data-plot-axis="x" x1={layout.left} x2={layout.right} y1={layout.bottom} y2={layout.bottom}/>
        <line data-plot-hit="axis" data-plot-axis="y" x1={layout.left} x2={layout.left} y1={layout.top} y2={layout.bottom}/>
      </g>
      {drag && <rect data-plot-interaction="zoom" x={Math.max(layout.left, Math.min(drag.start.x, drag.end.x))} y={Math.max(layout.top, Math.min(drag.start.y, drag.end.y))} width={Math.max(0, Math.min(layout.right, Math.max(drag.start.x, drag.end.x)) - Math.max(layout.left, Math.min(drag.start.x, drag.end.x)))} height={Math.max(0, Math.min(layout.bottom, Math.max(drag.start.y, drag.end.y)) - Math.max(layout.top, Math.min(drag.start.y, drag.end.y)))} fill="#397a9a22" stroke="#397a9a" pointerEvents="none"/>}
    </svg>{resizePart === 'main' && sizing.handles}</div></div>{plotActions}{message && <p className="optimization-plot-note" role="status">{message}</p>}
  </div>;
}
export default ScientificPlot;
