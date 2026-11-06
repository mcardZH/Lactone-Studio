import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import {useProjectState} from '../../projects/ui-state';
import type { ReactNode } from 'react';
import { assertResultNotAborted } from '../../results/contracts';
import { plotClientPoint } from '../../results/optimization-plot-axis';
import { scientificPlotLayout } from '../../results/scientific-plot-layout';
import { useScientificPlotSize } from './ScientificPlotSize';
import { formatPlotTick, nearestScientificPlotIndex, nearestScientificStickIndex, plotDataBounds, plotTicks, scientificPlotPaths, validPlotViewport, zoomPlotViewport } from '../../results/scientific-plot';
import type { ScientificPlotPoint, ScientificPlotSeries, ScientificPlotViewport } from '../../results/scientific-plot';
import { exportBlob } from './export-image';
import { formatResultValue, fullPrecisionValue } from '../../results/numeric-format';
import { optimizationSvgPng, serializeOptimizationSvg } from './optimization-export';
import './OptimizationPlot.css';
import { ScientificPlotExportMenu } from './ScientificPlotExportMenu';
import { ScientificPlotSettings, usePlotAppearance, usePlotFont, plotFontFamily, plotPt } from './ScientificPlotSettings';

export type { ScientificPlotPoint, ScientificPlotSeries, ScientificPlotViewport };
/** SciYue --teal primary, followed by restrained contrasting theme companions. */
export const SCIENTIFIC_PLOT_THEME_COLORS = ['#147d75', '#32658a', '#ad773d', '#607f88', '#627a50', '#a55f4a'] as const;
const plotSeriesColor = (line: ScientificPlotSeries, index: number) => line.color ?? SCIENTIFIC_PLOT_THEME_COLORS[index % SCIENTIFIC_PLOT_THEME_COLORS.length];
function wrapPlotText(value: string, maxUnits: number): string[] {
  const lines: string[] = []; let line = '', units = 0;
  for (const char of value) { const width = char.codePointAt(0)! > 255 ? 1.7 : 1; if (line && (units + width > maxUnits || char === '\n')) { lines.push(line); line = ''; units = 0; } if (char !== '\n') { line += char; units += width; } }
  if (line || !lines.length) lines.push(line); return lines;
}

/** Stable data-space layer: resizing changes one parent transform rather than
 * recalculating and writing hundreds of point coordinates and SVG paths. */
const DataSpaceLine = memo(function DataSpaceLine({ line, color, xmin, xmax, ymin, ymax, reverseX, reverseY, onSelectIndex, decimals, markers }: {
  line: ScientificPlotSeries; color: string; xmin: number; xmax: number; ymin: number; ymax: number;
  reverseX: boolean; reverseY: boolean; onSelectIndex?: (index: number) => void; decimals?: number; markers: boolean;
}) {
  const px = (value: number) => (reverseX ? 1 - (value - xmin) / (xmax - xmin) : (value - xmin) / (xmax - xmin)) * 10000;
  const py = (value: number) => (reverseY ? (value - ymin) / (ymax - ymin) : 1 - (value - ymin) / (ymax - ymin)) * 10000;
  const valid = line.points.filter(point => point.y !== null && Number.isFinite(point.x) && Number.isFinite(point.y));
  const number = (value: number) => decimals === undefined ? fullPrecisionValue(value) : formatResultValue(value, decimals);
  return <>
    {scientificPlotPaths(line.points, px, py).map((path, index) => <path key={index} d={path} fill="none" stroke={color} strokeWidth="2.4" vectorEffect="non-scaling-stroke"/>)}
    {markers && <path data-plot-markers="solid" data-point-count={valid.length} d={valid.map(point => `M${px(point.x)},${py(point.y!)} l0,0`).join(' ')} fill="none" stroke={color} strokeWidth="6.8" strokeLinecap="round" vectorEffect="non-scaling-stroke" pointerEvents="none"/>}
    {onSelectIndex && valid.map((point, index) => point.index === undefined ? null : <path key={index} d={`M${px(point.x)},${py(point.y!)} l0,0`} data-plot-point-index={point.index}
      role="button" tabIndex={0} aria-label={point.label ?? `选择帧 ${point.index + 1}，${number(point.y!)}`}
      fill="none" stroke="transparent" strokeWidth="16" strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{ cursor: 'pointer' }}
      onClick={event => { if (event.detail === 0) { event.stopPropagation(); onSelectIndex(point.index!); } }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectIndex(point.index!); } }}>
      <title>{point.tooltip ?? point.label ?? `${number(point.x)} · ${number(point.y!)}`}</title>
    </path>)}
  </>;
});
export interface ScientificPlotProps {
  title: string; xLabel: string; yLabel: string; series: readonly ScientificPlotSeries[];
  selectedIndex?: number; onSelectIndex?(index: number): void;
  /** Energy/trajectory picks seek by X; discrete levels select only their own series. */
  selectionMode?: 'x' | 'series';
  reverseX?: boolean; reverseY?: boolean;
  viewport?: ScientificPlotViewport | null; onViewportChange?(value: ScientificPlotViewport | null): void;
  resetKey?: string | number; exportFileName?: string; exportText?: { fileName: string; text: string };
  ariaLabel?: string; testId?: string; metadata?: unknown; height?: number; responsive?: boolean; children?: ReactNode;
  exportLabel?: string; subtitle?: string;
  /** Controls of this figure, composed into its owning toolbar. */
  toolbar?: ReactNode;
  onResetDefaults?(): void;
  xDomain?: [number, number];
  showXTicks?: boolean;
  /** Data-point fallback text only; axis ticks keep their zoom-aware precision. */
  decimals?: number;
  /** Raw sticks retain their own intensity unit and scale alongside a broadened curve. */
  secondaryYAxis?: { label: string; series: readonly ScientificPlotSeries[] };
  /** Stable source + figure identity, independent of scientific display settings. */
  appearanceKey?: string | number;
  /** Spectra never carry point markers, including the selected raw stick. */
  plotStyle?: 'numeric' | 'spectrum' | 'plain';
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

export function ScientificPlot({ title, xLabel, yLabel, series, selectedIndex, onSelectIndex, selectionMode = 'x', reverseX = false, reverseY = false,
  viewport: controlledViewport, onViewportChange, resetKey, exportFileName = 'Ester-Studio-plot', exportText, ariaLabel = title,
  testId, metadata, height, responsive = true, children, exportLabel = '', subtitle, xDomain, showXTicks = true, decimals, secondaryYAxis, toolbar, onResetDefaults, appearanceKey, plotStyle = 'numeric' }: ScientificPlotProps) {
  const appearance = usePlotAppearance(appearanceKey), textStyle = appearance.value;
  const displayTitle = textStyle.title ?? title, displayX = textStyle.xLabel ?? xLabel, displayY = textStyle.yLabel ?? yLabel;
  const dataNumber = (value: number) => decimals === undefined ? fullPrecisionValue(value) : formatResultValue(value, decimals);
  const hostRef = useRef<HTMLDivElement>(null), svgRef = useRef<SVGSVGElement>(null);
  const sizing = useScientificPlotSize(appearanceKey??exportFileName);
  usePlotFont(hostRef.current?.ownerDocument);
  const [message, setMessage] = useState(''), [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; end: { x: number; y: number }; pointerId: number; directIndex?: number } | null>(null);
  const dragRef = useRef<typeof drag>(null), suppressClick = useRef(false);
  const clipId = `plot-${useId().replace(/:/g, '')}`;
  let layout = scientificPlotLayout(sizing.width, displayTitle, { height: sizing.height ?? height, subtitle: !!subtitle, square: true });
  const titleLines = wrapPlotText(displayTitle, Math.max(8, (layout.width - 32) / (plotPt(textStyle.titleSize) * .6)));
  const titleSpace = Math.max(0, titleLines.length * (plotPt(textStyle.titleSize) + 4) - layout.titleLines.length * 18);
  const footerSpace = Math.max(0, plotPt(textStyle.axisSize) - 14) + Math.max(0, plotPt(textStyle.tickSize) - 12);
  layout = { ...layout, titleLines, top: layout.top + titleSpace, bottom: Math.max(layout.top + titleSpace + 60, layout.bottom - footerSpace), height: Math.max(layout.height, layout.top + titleSpace + 116) };
  layout = { ...layout, left: Math.max(layout.left, 62 + Math.max(0, plotPt(textStyle.axisSize) - 14) * 2) };
  const full = useMemo(() => { const data = plotDataBounds(series); return data && xDomain && Number.isFinite(xDomain[0]) && Number.isFinite(xDomain[1]) && xDomain[0] < xDomain[1] ? { ...data, x: xDomain } : data; }, [series, xDomain]);
  const view = useScientificPlotViewport(full, { viewport: controlledViewport, onViewportChange, resetKey,appearanceKey:appearanceKey??exportFileName });
  const range = view.viewport;
  if (range) {
    const ticks = plotTicks(range.y, layout.bottom - layout.top, 48);
    const labelWidth = Math.max(...ticks.major.map(value => formatPlotTick(value, ticks.step).length), 0) * plotPt(textStyle.tickSize) * .6 + 14;
    layout = { ...layout, left: Math.max(layout.left, Math.min(labelWidth + 34, layout.right - 100)) };
  }
  const secondaryBounds = secondaryYAxis ? plotDataBounds(secondaryYAxis.series) : null;
  const secondaryRange: [number, number] | undefined = secondaryBounds ? [Math.min(0, secondaryBounds.y[0]), Math.max(0, secondaryBounds.y[1])] : undefined;
  const secondaryTicks = secondaryRange ? plotTicks(secondaryRange, layout.bottom - layout.top, 48) : undefined;
  if (secondaryTicks) layout = { ...layout, right: Math.max(layout.left + 80, layout.width - Math.max(62, ...secondaryTicks.major.map(value => formatPlotTick(value, secondaryTicks.step).length * 7 + 40))) };
  useEffect(() => { setExporting(false); return () => { exportController.current?.abort(); }; }, [resetKey]);
  const sampled = useMemo(() => [...series.map(line => ({ ...line, secondary: false })), ...(secondaryYAxis?.series.map(line => ({ ...line, secondary: true })) ?? [])], [series, secondaryYAxis]);
  const paths = useMemo(() => {
    if (!range) return sampled.map(() => [] as string[]);
    const px = (value: number) => layout.left + (reverseX ? 1 - (value - range.x[0]) / (range.x[1] - range.x[0]) : (value - range.x[0]) / (range.x[1] - range.x[0])) * (layout.right - layout.left);
    const py = (value: number, bounds: readonly [number, number]) => layout.bottom - (reverseY ? 1 - (value - bounds[0]) / (bounds[1] - bounds[0]) : (value - bounds[0]) / (bounds[1] - bounds[0])) * (layout.bottom - layout.top);
    return sampled.map(line => line.kind === 'stick' || line.kind === 'histogram' || selectionMode === 'x' && !line.pointLabels ? [] : scientificPlotPaths(line.points, px, value => py(value, line.secondary && secondaryRange ? secondaryRange : range.y)));
  }, [sampled, range?.x[0], range?.x[1], range?.y[0], range?.y[1], layout.left, layout.right, layout.top, layout.bottom, reverseX, reverseY, secondaryRange?.[0], secondaryRange?.[1], selectionMode]);
  const selectableSeries = secondaryYAxis ? secondaryYAxis.series : series;
  const exportFigure = async (format: 'png' | 'svg' | 'txt') => {
    const svg = svgRef.current; if (!svg || exporting) return;
    const controller = new AbortController(); exportController.current = controller; setExporting(true); setMessage('');
    try {
      const text = format === 'txt' ? exportText?.text ?? '' : serializeOptimizationSvg(svg);
      const blob = format === 'png' ? await optimizationSvgPng(text, svg.ownerDocument, controller.signal)
        : new Blob([text], { type: format === 'svg' ? 'image/svg+xml;charset=utf-8' : 'text/plain;charset=utf-8' });
      assertResultNotAborted(controller.signal);
      exportBlob(blob, format === 'txt' ? exportText!.fileName : `${exportFileName}.${format}`, svg.ownerDocument);
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
  return <div ref={hostRef} className={`scientific-plot${responsive ? ' optimization-plot-responsive' : ''}`}>
    <ScientificPlotSettings appearance={{ ...appearance, reset: () => { appearance.reset(); onResetDefaults?.(); } }} title={title} xLabel={xLabel} yLabel={yLabel} names={sampled.map(line => ({ id: line.id, label: line.label ?? line.id }))}/>
    <div className="optimization-plot-options scientific-plot-tools">
      {toolbar}
      {sizing.controls(layout.height)}
      <button type="button" disabled={!view.canGoBack} onClick={view.back}>返回上一级</button>
      <button type="button" onClick={() => { view.reset(); sizing.reset(); }}>恢复视图</button>
      <ScientificPlotExportMenu disabled={exporting} options={[
        { key: 'svg', label: `${exportLabel ? `${exportLabel} · ` : ''}SVG`, run: () => void exportFigure('svg') },
        { key: 'png', label: `${exportLabel ? `${exportLabel} · ` : ''}PNG`, run: () => void exportFigure('png') },
        ...(exportText ? [{ key: 'txt', label: '数据 TXT', run: () => void exportFigure('txt') }] : []),
      ]}/>{children}
    </div>
    <div className="scientific-plot-viewport"><div ref={sizing.stageRef} className="scientific-plot-stage" style={sizing.style(layout.height)}>
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} className="optimization-energy-svg scientific-plot-svg" role="group" aria-label={ariaLabel} data-testid={testId}
      fontFamily={plotFontFamily(textStyle.font)} data-plot-style={plotStyle} data-plot-left={layout.left} data-plot-right={layout.right} data-plot-top={layout.top} data-plot-bottom={layout.bottom}
      data-x-min={range.x[0]} data-x-max={range.x[1]} data-y-min={range.y[0]} data-y-max={range.y[1]} data-reverse-x={reverseX} data-reverse-y={reverseY}
      onPointerDown={event => { if (event.button !== 0) return; const point = plotClientPoint(event.currentTarget, event.clientX, event.clientY); if (!point || !inside(point)) return;
        const targetIndex = (event.target as Element).closest?.('[data-plot-point-index]')?.getAttribute('data-plot-point-index');
        const next = { start: point, end: point, pointerId: event.pointerId, directIndex: stickIndex(point) ?? (targetIndex == null ? undefined : Number(targetIndex)) }; dragRef.current = next; setDrag(next); event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={event => { const active = dragRef.current; if (!active || active.pointerId !== event.pointerId) return; const point = plotClientPoint(event.currentTarget, event.clientX, event.clientY); if (!point) return; const next = { ...active, end: point }; dragRef.current = next; setDrag(next); }}
      onPointerUp={event => { const active = dragRef.current; if (!active || active.pointerId !== event.pointerId) return; const point = plotClientPoint(event.currentTarget, event.clientX, event.clientY) ?? active.end; dragRef.current = null; setDrag(null); event.currentTarget.releasePointerCapture?.(event.pointerId); suppressClick.current = true;
        if (Math.abs(point.x - active.start.x) >= 5 && Math.abs(point.y - active.start.y) >= 5) { const next = zoomPlotViewport(range, active.start, point, layout, reverseX, reverseY); if (next) view.zoom(next); }
        else if (Math.hypot(point.x - active.start.x, point.y - active.start.y) < 5) { if (active.directIndex !== undefined) onSelectIndex?.(active.directIndex); else seek(point); } }}
      onPointerCancel={() => { dragRef.current = null; setDrag(null); suppressClick.current = true; }}
      onClick={event => { if (suppressClick.current) { suppressClick.current = false; return; } const point = plotClientPoint(event.currentTarget, event.clientX, event.clientY); if (point) seek(point); }}>
      <title>{displayTitle}</title><desc>{`${displayX}；${displayY}${secondaryYAxis ? `；棒谱：${secondaryYAxis.label}` : ''}；单击定位，拖框缩放；缺项不连线。`}</desc><metadata>{JSON.stringify({ ...(metadata && typeof metadata === 'object' ? metadata : { metadata }), appearance: textStyle, viewport: range, reverseX, reverseY, ...(secondaryYAxis ? { secondaryYAxis: { label: secondaryYAxis.label, range: secondaryRange } } : {}) })}</metadata>
      <defs><clipPath id={clipId}><rect x={layout.left} y={layout.top} width={layout.right - layout.left} height={layout.bottom - layout.top}/></clipPath></defs>
      <rect width={layout.width} height={layout.height} fill="white"/>
      {layout.titleLines.map((line, index) => <text key={index} x={layout.width / 2} y={plotPt(textStyle.titleSize) + 9 + index * (plotPt(textStyle.titleSize) + 4)} textAnchor="middle" fill="#111111" fontSize={plotPt(textStyle.titleSize)}>{line}</text>)}
      {subtitle && <text x={layout.left} y={layout.top - 30} fill="#475569" fontSize="12">{subtitle}</text>}
      <text transform={`translate(${18} ${(layout.top + layout.bottom) / 2}) rotate(-90)`} textAnchor="middle" fill="#111111" fontSize={plotPt(textStyle.axisSize)}>{displayY}</text>
      {yTicks.major.map(value => <g key={value}><line x1={layout.left + (plotStyle === 'spectrum' ? 5 : -5)} x2={layout.left} y1={y(value)} y2={y(value)} stroke="#111111"/><text x={layout.left - 8} y={y(value) + 4} textAnchor="end" fill="#111111" fontSize={plotPt(textStyle.tickSize)}>{formatPlotTick(value, yTicks.step)}</text></g>)}
      {yTicks.minor.map(value => <line key={value} x1={layout.left + (plotStyle === 'spectrum' ? 3 : -3)} x2={layout.left} y1={y(value)} y2={y(value)} stroke="#111111"/>)}
      <rect data-plot-frame="true" x={layout.left} y={layout.top} width={layout.right - layout.left} height={layout.bottom - layout.top} fill="none" stroke="#111111" strokeWidth={1.1 * 4 / 3}/>
      {secondaryYAxis && secondaryTicks && <g data-plot-axis="secondary-y">
        {secondaryTicks.major.map(value => <g key={value}><line x1={layout.right} x2={layout.right + 5} y1={secondaryY(value)} y2={secondaryY(value)} stroke="#111111"/><text x={layout.right + 8} y={secondaryY(value) + 4} fill="#111111" fontSize={plotPt(textStyle.tickSize)}>{formatPlotTick(value, secondaryTicks.step)}</text></g>)}
        <text transform={`translate(${layout.width - 10} ${(layout.top + layout.bottom) / 2}) rotate(-90)`} textAnchor="middle" fill="#111111" fontSize={plotPt(textStyle.axisSize)}>{appearance.name(secondaryYAxis.series[0]?.id ?? 'secondary', secondaryYAxis.label)}</text>
      </g>}
      {showXTicks && xTicks.minor.map(value => <line key={value} x1={x(value)} x2={x(value)} y1={layout.bottom} y2={layout.bottom + (plotStyle === 'spectrum' ? -3 : 3)} stroke="#111111"/>)}
      {showXTicks && xTicks.major.map(value => <g key={value}><line x1={x(value)} x2={x(value)} y1={layout.bottom} y2={layout.bottom + (plotStyle === 'spectrum' ? -5 : 5)} stroke="#111111"/><text x={x(value)} y={layout.bottom + 21} textAnchor="middle" fill="#111111" fontSize={plotPt(textStyle.tickSize)}>{formatPlotTick(value, xTicks.step)}</text></g>)}
      {plotStyle === 'spectrum' && <g data-spectrum-mirrored-ticks="true">{xTicks.major.map(v => <line key={`x-${v}`} x1={x(v)} x2={x(v)} y1={layout.top} y2={layout.top + 5} stroke="#111"/>)}{xTicks.minor.map(v => <line key={`xm-${v}`} x1={x(v)} x2={x(v)} y1={layout.top} y2={layout.top + 3} stroke="#111"/>)}{!secondaryYAxis && yTicks.major.map(v => <line key={`y-${v}`} x1={layout.right} x2={layout.right - 5} y1={y(v)} y2={y(v)} stroke="#111"/>)}</g>}
      <g clipPath={`url(#${clipId})`}>
        {sampled.map((line, lineIndex) => { const color = plotSeriesColor(line, lineIndex), lineY = line.secondary && secondaryRange ? secondaryY : y; return <g key={line.id} data-series-id={line.id} data-y-axis={line.secondary ? 'secondary' : 'primary'}><title>{appearance.name(line.id, line.label ?? line.id)}</title>
          {line.kind === 'histogram' ? line.points.map((point, i) => point.y === null || !Number.isFinite(point.y) || !Number.isFinite(point.xEnd) ? null : <rect key={i} data-plot-histogram-bin={i} x={Math.min(x(point.x), x(point.xEnd!))} y={Math.min(lineY(0), lineY(point.y))} width={Math.abs(x(point.xEnd!) - x(point.x))} height={Math.abs(lineY(point.y) - lineY(0))} fill="#b8d8eb" stroke={color} strokeWidth="1"><title>{point.label}</title></rect>) : line.kind !== 'stick' && selectionMode === 'x' && !line.pointLabels ?
          <g transform={`translate(${layout.left} ${layout.top}) scale(${(layout.right - layout.left) / 10000} ${(layout.bottom - layout.top) / 10000})`}><DataSpaceLine line={line} color={color} xmin={range.x[0]} xmax={range.x[1]} ymin={(line.secondary && secondaryRange ? secondaryRange : range.y)[0]} ymax={(line.secondary && secondaryRange ? secondaryRange : range.y)[1]} reverseX={reverseX} reverseY={reverseY} onSelectIndex={onSelectIndex} decimals={decimals} markers={plotStyle !== 'spectrum' && (plotStyle === 'numeric' || !!line.showPoints)}/></g> : line.kind === 'stick' ? line.points.map((point, i) => point.y === null || !Number.isFinite(point.x) || !Number.isFinite(point.y) ? null : <g key={i}>
            <line x1={x(point.x)} x2={x(point.x)} y1={lineY(0)} y2={lineY(point.y)} stroke={selectedIndex !== undefined && point.index === selectedIndex ? '#3b9660' : color} strokeWidth={selectedIndex !== undefined && point.index === selectedIndex ? 2.5 : 1.5}/>
            {onSelectIndex && point.index !== undefined && <line data-plot-stick-hit="true" data-plot-point-index={point.index} role="button" tabIndex={0} aria-label={point.tooltip ?? point.label ?? `选择模式 ${point.index}`} aria-pressed={selectedIndex !== undefined && point.index === selectedIndex}
              x1={x(point.x)} x2={x(point.x)} y1={lineY(0)} y2={lineY(point.y)} stroke="transparent" strokeWidth="16" strokeLinecap="round" style={{cursor:'pointer'}}
              onClick={event => { if (event.detail === 0) { event.stopPropagation(); onSelectIndex(point.index!); } }} onKeyDown={event => { if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelectIndex(point.index!);} }}><title>{point.tooltip ?? point.label ?? `${dataNumber(point.x)} · ${dataNumber(point.y)}`}</title></line>}
          </g>) : paths[lineIndex].map((path, i) => { const point = line.points.find(point => point.index !== undefined), selectable = selectionMode === 'series' && onSelectIndex && point?.index !== undefined;
            return <g key={i}><path d={path} fill="none" stroke={color} strokeWidth="2.4"/>{selectable && <path d={path} fill="none" stroke="transparent" strokeWidth="12" data-plot-point-index={point.index} role="button" tabIndex={0} aria-label={point.tooltip ?? point.label ?? line.label ?? line.id}
              onClick={event => { if(event.detail===0){event.stopPropagation();onSelectIndex!(point.index!);} }} onKeyDown={event => { if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelectIndex!(point.index!);} }}/>}</g>; })}
          {plotStyle !== 'spectrum' && onSelectIndex && selectionMode === 'x' && (line.kind === 'stick' || line.pointLabels) && line.points.map((point, i) => point.index === undefined || point.y === null || !Number.isFinite(point.y) || !Number.isFinite(point.x) ? null : <circle key={i} data-plot-point-index={point.index} role="button" tabIndex={0} aria-label={point.label ?? `选择帧 ${point.index + 1}，${dataNumber(point.y)}`} aria-pressed={selectedIndex !== undefined && point.index === selectedIndex} cx={x(point.x)} cy={lineY(point.y)} r={selectedIndex !== undefined && point.index === selectedIndex ? 5 : 3.5} fill={selectedIndex !== undefined && point.index === selectedIndex ? '#ca7b29' : color}
            onClick={event => { if (event.detail === 0) { event.stopPropagation(); onSelectIndex(point.index!); } }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectIndex(point.index!); } }}><title>{point.tooltip ?? point.label ?? `${dataNumber(point.x)} · ${dataNumber(point.y)}`}</title></circle>)}
          {line.pointLabels && line.points.map((point, i) => (point.label || textStyle.names[line.id] !== undefined && i === line.points.length - 1) && point.y !== null && Number.isFinite(point.x) && Number.isFinite(point.y) ? <text key={`label-${i}`} x={x(point.x) + 7} y={lineY(point.y) - 7} fill={color} fontSize={plotPt(textStyle.legendSize)} pointerEvents="none">{appearance.name(line.id, point.label ?? line.label ?? line.id)}</text> : null)}
        </g>; })}
        {selected && Number.isFinite(selected.x) && <line x1={x(selected.x)} x2={x(selected.x)} y1={layout.top} y2={layout.bottom} stroke="#ca7b29" strokeDasharray="4 3"/>}
        {plotStyle !== 'spectrum' && selected?.y != null && Number.isFinite(selected.y) && <circle cx={x(selected.x)} cy={selectedY(selected.y)} r="5" fill="#ca7b29" pointerEvents="none"/>}
      </g>
      {((plotStyle !== 'plain' && sampled.length > 1) || Object.keys(textStyle.names).length > 0) && selectionMode !== 'series' && <g data-plot-series-legend="true">{(() => { let nextY = layout.top + 18; return sampled.filter(line => !line.pointLabels).map(line => { const lines = wrapPlotText(appearance.name(line.id, line.label ?? line.id), Math.max(5, (layout.right - layout.left - 64) / (plotPt(textStyle.legendSize) * .6))), top = nextY; nextY += lines.length * (plotPt(textStyle.legendSize) + 4) + 4; return <g key={line.id} transform={`translate(${layout.left + 12} ${top})`}><line x1={0} x2={22} stroke={plotSeriesColor(line, sampled.indexOf(line))} strokeWidth={2.4}/><text x={28} y={4} fontSize={plotPt(textStyle.legendSize)} fill="#111">{lines.map((label, j) => <tspan key={j} x={28} dy={j ? plotPt(textStyle.legendSize) + 4 : 0}>{label}</tspan>)}</text></g>; }); })()}</g>}
      <text x={(layout.left + layout.right) / 2} y={layout.bottom + 45} textAnchor="middle" fill="#111111" fontSize={plotPt(textStyle.axisSize)}>{displayX}</text>
      {drag && <rect data-plot-interaction="zoom" x={Math.max(layout.left, Math.min(drag.start.x, drag.end.x))} y={Math.max(layout.top, Math.min(drag.start.y, drag.end.y))} width={Math.max(0, Math.min(layout.right, Math.max(drag.start.x, drag.end.x)) - Math.max(layout.left, Math.min(drag.start.x, drag.end.x)))} height={Math.max(0, Math.min(layout.bottom, Math.max(drag.start.y, drag.end.y)) - Math.max(layout.top, Math.min(drag.start.y, drag.end.y)))} fill="#397a9a22" stroke="#397a9a" pointerEvents="none"/>}
    </svg>{sizing.handles}</div></div>{message && <p className="optimization-plot-note" role="status">{message}</p>}
  </div>;
}
export default ScientificPlot;
