import { ScientificPlotSettings, usePlotAppearance, usePlotFont, plotFontFamily, plotPt } from './ScientificPlotSettings';
import {useProjectState} from '../../projects/ui-state';
import {matchingSliderRange} from '../numeric-step';
import NumericInput from '../NumericInput';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { assertResultNotAborted } from '../../results/contracts';
import { plotClientPoint } from '../../results/optimization-plot-axis';
import { scientificPlotLayout } from '../../results/scientific-plot-layout';
import { useScientificPlotSize } from './ScientificPlotSize';
import { formatPlotTick, plotTicks, validPlotViewport, zoomPlotViewport, type ScientificPlotViewport } from '../../results/scientific-plot';
import { nearestScatterPoint, scatterDataSummary, scatterDataText, scatterScreenPoint, type ScientificScatterData, type ScientificScatterPoint } from '../../results/scatter-data';
import { formatResultValue } from '../../results/numeric-format';
import { useScientificPlotViewport } from './ScientificPlot';
import { exportBlob } from './export-image';
import { optimizationSvgPng } from './optimization-export';
import { paintScatterBatch } from './scientific-scatter-canvas';
import { scatterSvgSnapshot, waitForScatterFrame } from './scientific-scatter-export';
import './OptimizationPlot.css';
import './ScientificScatterPlot.css';
import { ScientificPlotExportMenu } from './ScientificPlotExportMenu';
import { usePlotFrameUpdate } from './scientific-plot-frame';
import { dragScatterLegend, scatterLegendLayout, type ScatterLegendGesture, type ScatterLegendLayout } from './scientific-scatter-legend';

export type { ScientificScatterData, ScientificScatterPoint, ScientificPlotViewport };
export interface ScientificScatterExportHandle {
  /** Waits for this scene's complete point layer; stale or cancelled scenes reject. */
  snapshotSvg(signal?: AbortSignal): Promise<string>;
  ownerDocument: Document;
}
export interface ScientificScatterPlotProps {
  title: string; xLabel: string; yLabel: string; appearanceKey?: string | number; data: ScientificScatterData;
  /** Pass the SAME mapping function/settings as the 3D field; no independent color interpolation. */
  colorForX(value: number): string;
  /** Optional same-point presentation used by both screen and vector export. */
  colorForPoint?(index: number, x: number, y: number): string;
  colorLegend?: { min: number; max: number; label?: string };
  pointSize?: number; onPointSizeChange?(value: number): void;
  opacity?: number; onOpacityChange?(value: number): void;
  viewport?: ScientificPlotViewport | null; onViewportChange?(value: ScientificPlotViewport | null): void;
  /** A viewing preset, independent of the full dataset and the 3D color range. */
  initialViewport?: ScientificPlotViewport | null;
  resetKey?: string | number; height?: number; decimals?: number;
  exportFileName?: string; metadata?: unknown; ariaLabel?: string; testId?: string;
  exportHandle?(api: ScientificScatterExportHandle | null): void;
  onPointSelect?(point: ScientificScatterPoint | null): void; children?: ReactNode;
}
const bounded = (value: number, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export const SCATTER_VECTOR_EXPORT_LIMIT = 20000;
const editableCopyTarget = (target: EventTarget | null) => Boolean((target as Element | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));

/** Canvas point layer + bounded SVG axes. No point DOM, decimation or scientific-state writes. */
export function ScientificScatterPlot({ title, xLabel, yLabel, data, colorForX, colorForPoint, colorLegend, pointSize, onPointSizeChange, opacity, onOpacityChange,
  viewport, onViewportChange, initialViewport, resetKey, height, decimals = 2, exportFileName = 'Ester-Studio-scatter', metadata, ariaLabel = title,
  testId = 'scientific-scatter-plot', exportHandle, onPointSelect, children, appearanceKey }: ScientificScatterPlotProps) {
  const appearance = usePlotAppearance(appearanceKey), textStyle = appearance.value;
  const displayTitle = textStyle.title ?? title, displayX = textStyle.xLabel ?? xLabel, displayY = textStyle.yLabel ?? yLabel;
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), svg = useRef<SVGSVGElement>(null);
  const sizing = useScientificPlotSize(appearanceKey??exportFileName);
  usePlotFont(host.current?.ownerDocument);
  const [localSize, setLocalSize] = useProjectState('scatter.pointSize',2,appearanceKey??exportFileName), [localOpacity, setLocalOpacity] = useProjectState('scatter.opacity',.65,appearanceKey??exportFileName);
  const [legendPosition, setLegendPosition] = useProjectState<ScatterLegendLayout | null>('scatter.legendPosition',null,appearanceKey??exportFileName);
  const legendDrag = useRef<{ start: ScatterLegendLayout; point: { x: number; y: number }; mode: ScatterLegendGesture; pointerId: number } | null>(null);
  const legendFrame = usePlotFrameUpdate<ScatterLegendLayout>(next => setLegendPosition(previous => previous?.x === next.x && previous.y === next.y && previous.width === next.width ? previous : next));
  const styleFrame = usePlotFrameUpdate<{ size?: number; alpha?: number }>(next => {
    if (next.size !== undefined && next.size !== size) { if (pointSize === undefined) setLocalSize(next.size); onPointSizeChange?.(next.size); }
    if (next.alpha !== undefined && next.alpha !== alpha) { if (opacity === undefined) setLocalOpacity(next.alpha); onOpacityChange?.(next.alpha); }
    pendingStyle.current = {};
  });
  const pendingStyle = useRef<{ size?: number; alpha?: number }>({});
  const [selected, setSelected] = useState<ScientificScatterPoint | null>(null), [message, setMessage] = useState('');
  const [copyAll, setCopyAll] = useState(false);
  const legendId = `scatter-legend-${useId().replace(/:/g, '')}`;
  const [paintState, setPaintState] = useState<'drawing' | 'ready' | 'error'>('drawing'), [exporting, setExporting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const drag = useRef<{ start: { x: number; y: number }; end: { x: number; y: number }; pointerId: number } | null>(null);
  const [dragBox, setDragBox] = useState<typeof drag.current>(null);
  const canvasDocument = canvas.current?.ownerDocument;
  const summary = useMemo(() => { try { return { ...scatterDataSummary(data), error: '' }; } catch (error) {
    return { count: 0, excluded: 0, nonfinite: 0, viewport: null, error: error instanceof Error ? error.message : '散点数据无效。' };
  } }, [data]);
  const [showAll, setShowAll] = useProjectState('scatter.showAll',false,appearanceKey??exportFileName);
  const defaultRange = !showAll && validPlotViewport(initialViewport) ? initialViewport : summary.viewport;
  const view = useScientificPlotViewport(defaultRange, { viewport, onViewportChange, resetKey,appearanceKey:appearanceKey??exportFileName }), range = view.viewport;
  const size = bounded(pointSize ?? localSize, .5, 10, 2), alpha = bounded(opacity ?? localOpacity, .01, 1, .65);
  const rasterSvg = summary.count > SCATTER_VECTOR_EXPORT_LIMIT;
  let layout = scientificPlotLayout(sizing.width, displayTitle, { height: sizing.height ?? height, square: true, footer: colorLegend ? 52 : 0 });
  const preliminaryY = range ? plotTicks(range.y, layout.bottom - layout.top, 48) : { major: [], minor: [], step: 1 };
  layout = scientificPlotLayout(sizing.width, displayTitle, { height: sizing.height ?? height, square: true, footer: colorLegend ? 52 : 0,
    yLabelWidth: Math.max(0, ...preliminaryY.major.map(value => formatPlotTick(value, preliminaryY.step).length)) * 7 + 14 });
  const yt = range ? plotTicks(range.y, layout.bottom - layout.top, 48) : preliminaryY;
  const xt = range ? plotTicks(range.x, layout.right - layout.left) : { major: [], minor: [], step: 1 };
  const legendLayout = scatterLegendLayout(layout, legendPosition);
  // Cache only visited source colors. Size, opacity and geometry changes reuse
  // the mapping without copying or reducing the scientific columns.
  const pointColor = useMemo(() => {
    const colors: string[] = [];
    return (index: number, x: number, y: number) => colors[index] ?? (colors[index] = colorForPoint?.(index, x, y) ?? colorForX(x));
  }, [data, colorForX, colorForPoint]);
  const paintIdentity = useMemo(() => ({}), [data, summary.count, range?.x[0], range?.x[1], range?.y[0], range?.y[1], layout.width, layout.height, layout.left, layout.right, layout.top, layout.bottom, colorForX, colorForPoint, size, alpha, canvasDocument]);
  const sceneIdentity = useMemo(() => ({}), [paintIdentity, textStyle, title, xLabel, yLabel, ariaLabel, colorLegend, legendLayout.x, legendLayout.y, legendLayout.width, metadata, selected, decimals, resetKey]);
  const scene = useRef(sceneIdentity); scene.current = sceneIdentity;
  const painted = useRef<object | null>(null), paintError = useRef<{ identity: object; error: unknown } | null>(null);
  const paintCounters=useRef({generations:0,commits:0});
  useEffect(() => { setShowAll(false); legendFrame.cancel(); setLegendPosition(null); legendDrag.current = null; }, [resetKey]);
  useEffect(() => { setSelected(null); setCopyAll(false); drag.current = null; setDragBox(null); styleFrame.cancel(); pendingStyle.current = {}; }, [data, resetKey]);
  useEffect(() => { setExporting(false); return () => { controller.current?.abort(); }; }, [data, resetKey]);
  useEffect(() => {
    const node = canvas.current, win = node?.ownerDocument.defaultView; if (!node || !win || !range || !summary.count) return;
    paintCounters.current.generations++;if(host.current?.dataset)host.current.dataset.scatterPaintGenerations=String(paintCounters.current.generations);
    const buffer = node.ownerDocument.createElement('canvas'), context = buffer.getContext('2d');
    if (!context) { paintError.current = { identity: paintIdentity, error: new Error('散点画布不可用。') }; setPaintState('error'); setMessage('散点画布不可用。'); return; }
    const ratio = Math.min(2, win.devicePixelRatio || 1);
    buffer.width = Math.round(layout.width * ratio); buffer.height = Math.round(layout.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.fillStyle = '#fff'; context.fillRect(0, 0, layout.width, layout.height);
    let frame = 0, offset = 0, cancelled = false; painted.current = null; paintError.current = null; setPaintState('drawing'); setMessage('');
    const paint = () => {
      if (cancelled) return;
      try {
        const started = performance.now();
        do { const end = Math.min(data.x.length, offset + 1024); paintScatterBatch(context, data, range, layout, colorForX, size, alpha, offset, end, pointColor); offset = end; }
        while (offset < data.x.length && performance.now() - started < 8);
        if (offset < data.x.length) frame = win.requestAnimationFrame(paint);
        else {
          const visible = node.getContext('2d'); if (!visible) throw new Error('散点画布不可用。');
          // Only complete latest frames reach the visible canvas. Cancellation
          // releases the private buffer and leaves the previous full image intact.
          if (node.width !== buffer.width) node.width = buffer.width;
          if (node.height !== buffer.height) node.height = buffer.height;
          visible.setTransform(1, 0, 0, 1, 0, 0); visible.drawImage(buffer, 0, 0);
          paintCounters.current.commits++;if(host.current?.dataset)host.current.dataset.scatterPaintCommits=String(paintCounters.current.commits);
          painted.current = paintIdentity; buffer.width = 0; buffer.height = 0; setPaintState('ready');
        }
      } catch (error) { buffer.width = 0; buffer.height = 0; paintError.current = { identity: paintIdentity, error }; setPaintState('error'); setMessage(error instanceof Error ? error.message : '散点绘制失败。'); }
    };
    frame = win.requestAnimationFrame(paint);
    return () => { cancelled = true; if (painted.current === paintIdentity) painted.current = null; win.cancelAnimationFrame(frame); buffer.width = 0; buffer.height = 0; };
  }, [paintIdentity]);
  useEffect(() => {
    const source = svg.current, pixels = canvas.current;
    if (!exportHandle) return;
    if (!source || !pixels || !range || summary.error || !summary.count) { exportHandle(null); return; }
    let active = true; const lifetime = new AbortController();
    const assertCurrent = (signal?: AbortSignal) => {
      assertResultNotAborted(signal);
      if (!active || scene.current !== sceneIdentity || svg.current !== source || canvas.current !== pixels) throw new Error('散点图已切换或关闭，请重新导出当前图。');
    };
    exportHandle({ ownerDocument: source.ownerDocument, snapshotSvg: async signal => {
      assertCurrent(signal);
      const win = source.ownerDocument.defaultView;
      if (!win) throw new Error('散点图窗口已关闭。');
      while (painted.current !== paintIdentity) {
        assertCurrent(signal);
        if (paintError.current?.identity === paintIdentity) throw paintError.current.error;
        await waitForScatterFrame(win, [signal, lifetime.signal]);
      }
      assertCurrent(signal);
      const text = scatterSvgSnapshot(source, pixels, { data, range, layout, colorForX, colorForPoint, size, alpha, raster: rasterSvg });
      await Promise.resolve(); assertCurrent(signal); return text;
    } });
    return () => { active = false; lifetime.abort(); exportHandle(null); };
  }, [exportHandle, sceneIdentity]);
  const exportFigure = async (kind: 'svg' | 'png' | 'txt' | 'raw') => {
    const source = svg.current, pixels = canvas.current; if (!source || !pixels || exporting) return;
    const job = new AbortController(); controller.current = job; setExporting(true); setMessage('');
    try {
      let blob: Blob;
      if (kind === 'txt' || kind === 'raw') blob = new Blob([scatterDataText(data, { x: xLabel, y: yLabel }, kind === 'raw' ? 'raw' : decimals)], { type: 'text/plain;charset=utf-8' });
      else {
        if (painted.current !== paintIdentity) throw new Error('散点绘制尚未完成。');
        const text = scatterSvgSnapshot(source, pixels, { data, range: range!, layout, colorForX, colorForPoint, size, alpha, raster: kind !== 'svg' || rasterSvg });
        blob = kind === 'png' ? await optimizationSvgPng(text, source.ownerDocument, job.signal) : new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
      }
      assertResultNotAborted(job.signal);
      if (kind !== 'txt' && kind !== 'raw' && scene.current !== sceneIdentity) throw new Error('散点图已切换，请重新导出当前图。');
      exportBlob(blob, `${exportFileName}${kind === 'raw' ? '-raw' : ''}.${kind === 'raw' ? 'txt' : kind}`, source.ownerDocument);
      setMessage(`已发起 ${kind === 'raw' ? '原始数据 TXT' : kind.toUpperCase()} 下载。`);
    } catch (error) { if (!job.signal.aborted) setMessage(error instanceof Error ? error.message : '散点导出失败。'); }
    finally { if (controller.current === job) controller.current = null; if (!job.signal.aborted) setExporting(false); }
  };
  const applyRange = (axis: 'x' | 'y', end: 0 | 1, value: number) => {
    if (!range) return; const next = { x: [...range.x] as [number, number], y: [...range.y] as [number, number] }; next[axis][end] = value;
    if (validPlotViewport(next)) view.zoom(next);
  };
  const changeSize = (value: number) => { pendingStyle.current = { ...pendingStyle.current, size: bounded(value, .5, 10, size) }; styleFrame.schedule(pendingStyle.current, host.current?.ownerDocument.defaultView); };
  const changeOpacity = (value: number) => { pendingStyle.current = { ...pendingStyle.current, alpha: bounded(value, .01, 1, alpha) }; styleFrame.schedule(pendingStyle.current, host.current?.ownerDocument.defaultView); };
  const finishLegend = (event: PointerEvent<SVGGElement>) => {
    if (legendDrag.current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); legendFrame.flush(); legendDrag.current = null; event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  if (!range || summary.error || !summary.count) return <div ref={host} className="scientific-plot scientific-scatter-plot" data-testid={testId} data-point-count="0" data-sampled="false" data-paint-state={summary.error ? 'error' : 'empty'}><p className="optimization-plot-empty" role="status">{summary.error || '没有可绘制的有效散点。'}</p></div>;
  const at = (x: number, y: number) => scatterScreenPoint(x, y, range, layout);
  const inside = (p: { x: number; y: number }) => p.x >= layout.left && p.x <= layout.right && p.y >= layout.top && p.y <= layout.bottom;
  const marker = selected ? at(selected.x, selected.y) : null;
  return <div ref={host} className="scientific-plot scientific-scatter-plot" tabIndex={0} aria-label="可复制散点数据" data-copy-all={copyAll || undefined} data-testid={testId} data-point-count={summary.count} data-source-point-count={data.x.length} data-sampled="false" data-paint-state={paintState}
    onKeyDown={event => {
      if (editableCopyTarget(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); setCopyAll(true); }
      else if (event.key === 'Escape' && copyAll) { event.stopPropagation(); setCopyAll(false); }
    }}
    onCopy={event => { if (!copyAll || editableCopyTarget(event.target)) return; event.clipboardData.setData('text/plain', scatterDataText(data, { x: xLabel, y: yLabel }, decimals)); event.preventDefault(); event.stopPropagation(); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCopyAll(false); }}>
    <ScientificPlotSettings appearance={appearance} title={title} xLabel={xLabel} yLabel={yLabel} names={colorLegend?.label ? [{ id: 'color-legend', label: colorLegend.label }] : []}/>
    <div className="optimization-plot-options scientific-plot-tools scientific-scatter-tools" onPointerUp={() => styleFrame.flush()} onBlur={() => styleFrame.flush()}>
      {children}
      {(['x', 'y'] as const).map(axis => <label key={axis}>{axis.toUpperCase()}范围
        <NumericInput aria-label={`${axis.toUpperCase()}轴最小值`}  step="any" value={range[axis][0]} onChange={event => { if (event.currentTarget.value !== '') applyRange(axis, 0, event.currentTarget.valueAsNumber); }}/>
        <span>—</span><NumericInput aria-label={`${axis.toUpperCase()}轴最大值`}  step="any" value={range[axis][1]} onChange={event => { if (event.currentTarget.value !== '') applyRange(axis, 1, event.currentTarget.valueAsNumber); }}/></label>)}
      <label>点大小<input aria-label="散点大小滑杆" type="range" min="0.5" max="10" step="0.5" value={size} onChange={event => changeSize(event.currentTarget.valueAsNumber)}/><NumericInput aria-label="散点大小"  min="0.5" max="10" step="0.5" value={size} onChange={event => changeSize(event.currentTarget.valueAsNumber)}/></label>
      <label>透明度<input aria-label="散点透明度滑杆" type="range" {...matchingSliderRange(alpha,.01,1,.01)} value={alpha} onChange={event => changeOpacity(event.currentTarget.valueAsNumber)}/><NumericInput aria-label="散点透明度" stepper adaptiveStep={0.1} min="0.01" max="1" step="0.01" value={alpha} onChange={event => changeOpacity(event.currentTarget.valueAsNumber)}/></label>
      {sizing.controls(layout.height)}
      <button type="button" disabled={!view.canGoBack} onClick={view.back}>返回上一级</button>
      <button type="button" onClick={() => { setShowAll(false); view.reset(); sizing.reset(); legendFrame.cancel(); setLegendPosition(null); changeSize(2); changeOpacity(.65); styleFrame.flush(); }}>恢复视图</button>
      {validPlotViewport(initialViewport) && summary.viewport && (initialViewport.x[0] !== summary.viewport.x[0] || initialViewport.x[1] !== summary.viewport.x[1] || initialViewport.y[0] !== summary.viewport.y[0] || initialViewport.y[1] !== summary.viewport.y[1]) &&
        <button type="button" disabled={showAll && !view.zoomed} onClick={() => { setShowAll(true); view.reset(); }}>全图</button>}
      <ScientificPlotExportMenu disabled={exporting} options={[
        { key: 'svg', label: rasterSvg ? 'SVG（嵌入点图）' : 'SVG', disabled: paintState !== 'ready', run: () => void exportFigure('svg') },
        { key: 'png', label: 'PNG', disabled: paintState !== 'ready', run: () => void exportFigure('png') },
        { key: 'txt', label: '所见格式 TXT', run: () => void exportFigure('txt') },
        { key: 'raw', label: '原始数据 TXT', run: () => void exportFigure('raw') },
      ]}/>
      <button type="button" aria-pressed={copyAll} title="选择全部有效点，按 Ctrl/Cmd+C 复制" onClick={() => { setCopyAll(true); host.current?.focus({ preventScroll: true }); }}>选择全部数据</button>
    </div>
    <div className="scientific-plot-viewport"><div ref={sizing.stageRef} className="scientific-scatter-stage scientific-plot-stage" style={sizing.style(layout.height)}>
      <canvas ref={canvas} aria-hidden="true"/>
      <svg ref={svg} xmlns="http://www.w3.org/2000/svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={ariaLabel} className="scientific-plot-svg" fontFamily={plotFontFamily(textStyle.font)}
        data-x-min={range.x[0]} data-x-max={range.x[1]} data-y-min={range.y[0]} data-y-max={range.y[1]}
        data-plot-left={layout.left} data-plot-right={layout.right} data-plot-top={layout.top} data-plot-bottom={layout.bottom}
        onPointerDown={event => { if (event.button !== 0) return; const p = plotClientPoint(event.currentTarget, event.clientX, event.clientY); if (!p || !inside(p)) return;
          host.current?.focus({ preventScroll: true });
          drag.current = { start: p, end: p, pointerId: event.pointerId }; setDragBox(drag.current); event.currentTarget.setPointerCapture?.(event.pointerId); }}
        onPointerMove={event => { const active = drag.current; if (!active || active.pointerId !== event.pointerId) return; const p = plotClientPoint(event.currentTarget, event.clientX, event.clientY); if (!p) return; drag.current = { ...active, end: p }; setDragBox(drag.current); }}
        onPointerUp={event => { const active = drag.current; if (!active || active.pointerId !== event.pointerId) return; drag.current = null; setDragBox(null); event.currentTarget.releasePointerCapture?.(event.pointerId);
          const p = plotClientPoint(event.currentTarget, event.clientX, event.clientY) ?? active.end;
          if (Math.abs(p.x - active.start.x) >= 5 && Math.abs(p.y - active.start.y) >= 5) { const next = zoomPlotViewport(range, active.start, p, layout); if (next) view.zoom(next); }
          else if (Math.hypot(p.x - active.start.x, p.y - active.start.y) < 5) { const next = nearestScatterPoint(data, p, range, layout); setSelected(next); onPointSelect?.(next); }
        }} onPointerCancel={() => { drag.current = null; setDragBox(null); }} onLostPointerCapture={() => { drag.current = null; setDragBox(null); }}>
        <defs></defs><title>{displayTitle}</title><desc>{`${xLabel}；${yLabel}；全量有效点，无显示抽样；拖框缩放，单击查看数值。SVG使用${rasterSvg ? '嵌入点图和矢量坐标轴' : '可编辑矢量圆点和坐标轴'}。`}</desc>
        <metadata>{JSON.stringify({ metadata, appearance: textStyle, viewport: range, pointSize: size, opacity: alpha, colorLegend, ...(colorLegend ? { colorLegendLayout: legendLayout } : {}), pointCount: summary.count, sampled: false, svgPointLayer: rasterSvg ? 'raster' : 'vector' })}</metadata>
        {layout.titleLines.map((line, i) => <text key={i} x={layout.width / 2} y={24 + i * 18} textAnchor="middle" fill="#1e293b" fontSize={plotPt(textStyle.titleSize)}>{line}</text>)}
        <text x={layout.left} y={layout.top - 12} fill="#334155" fontSize={plotPt(textStyle.axisSize)}>{displayY}</text>
        {yt.major.map(value => <g key={value}><line x1={layout.left - 5} x2={layout.left} y1={at(0, value).y} y2={at(0, value).y} stroke="#64748b"/><text x={layout.left - 8} y={at(0, value).y + 4} textAnchor="end" fill="#64748b" fontSize={plotPt(textStyle.tickSize)}>{formatPlotTick(value, yt.step)}</text></g>)}
        {yt.minor.map(value => <line key={value} x1={layout.left - 3} x2={layout.left} y1={at(0, value).y} y2={at(0, value).y} stroke="#94a3b8"/>)}
        <rect data-plot-frame="true" x={layout.left} y={layout.top} width={layout.right - layout.left} height={layout.bottom - layout.top} fill="none" stroke="#111827"/>
        {xt.minor.map(value => <line key={value} x1={at(value, 0).x} x2={at(value, 0).x} y1={layout.bottom} y2={layout.bottom + 3} stroke="#94a3b8"/>)}
        {xt.major.map(value => <g key={value}><line x1={at(value, 0).x} x2={at(value, 0).x} y1={layout.bottom} y2={layout.bottom + 5} stroke="#64748b"/><text x={at(value, 0).x} y={layout.bottom + 21} textAnchor="middle" fill="#64748b" fontSize={plotPt(textStyle.tickSize)}>{formatPlotTick(value, xt.step)}</text></g>)}
        <text x={(layout.left + layout.right) / 2} y={layout.bottom + 45} textAnchor="middle" fill="#334155" fontSize={plotPt(textStyle.axisSize)}>{displayX}</text>
        {colorLegend && <g data-scatter-color-legend="true" aria-label={colorLegend.label ?? xLabel} className="scientific-scatter-legend" tabIndex={0}
          onPointerDown={event => {
            if (event.button !== 0) return;
            const point = svg.current && plotClientPoint(svg.current, event.clientX, event.clientY); if (!point) return;
            event.preventDefault(); event.stopPropagation(); legendFrame.flush();
            const handle = (event.target as Element).closest('[data-scatter-legend-handle]')?.getAttribute('data-scatter-legend-handle');
            legendDrag.current = { start: legendLayout, point, mode: handle === 'left' || handle === 'right' ? handle : 'move', pointerId: event.pointerId };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={event => {
            const active = legendDrag.current; if (!active || active.pointerId !== event.pointerId) return;
            event.preventDefault(); event.stopPropagation();
            const point = svg.current && plotClientPoint(svg.current, event.clientX, event.clientY); if (!point) return;
            legendFrame.schedule(dragScatterLegend(active.start, active.mode, point.x - active.point.x, point.y - active.point.y, layout), event.currentTarget.ownerDocument.defaultView);
          }} onPointerUp={finishLegend} onPointerCancel={finishLegend}
          onLostPointerCapture={() => { legendFrame.flush(); legendDrag.current = null; }} onClick={event => event.stopPropagation()}>
          <title>拖动色尺移动位置，拖动两端调整长度</title>
          <defs><linearGradient id={legendId} x1="0%" y1="0%" x2="100%" y2="0%">
            {Array.from({ length: 17 }, (_, i) => <stop key={i} offset={`${i / 16 * 100}%`} stopColor={colorForX(colorLegend.min + (colorLegend.max - colorLegend.min) * i / 16)}/>)}
          </linearGradient></defs>
          {colorLegend.label && <text x={legendLayout.x} y={legendLayout.y - 8} textAnchor="middle" fill="#64748b" fontSize={plotPt(textStyle.tickSize)}>{appearance.name('color-legend', colorLegend.label)}</text>}
          <rect x={legendLayout.x - legendLayout.width / 2} y={legendLayout.y} width={legendLayout.width} height="10" fill={`url(#${legendId})`} stroke="#d8e2ea"/>
          <text x={legendLayout.x - legendLayout.width / 2} y={legendLayout.y + 26} textAnchor="middle" fill="#64748b" fontSize={plotPt(textStyle.tickSize)}>{formatResultValue(colorLegend.min, decimals)}</text>
          <text x={legendLayout.x + legendLayout.width / 2} y={legendLayout.y + 26} textAnchor="middle" fill="#64748b" fontSize={plotPt(textStyle.tickSize)}>{formatResultValue(colorLegend.max, decimals)}</text>
          <g data-plot-interaction="legend-handles">
            <rect x={legendLayout.x - legendLayout.width / 2 - 8} y={legendLayout.y - 20} width={legendLayout.width + 16} height="52" fill="transparent"/>
            {(['left', 'right'] as const).map(side => <g key={side} data-scatter-legend-handle={side} style={{ cursor: 'ew-resize' }}>
              <rect x={legendLayout.x + (side === 'left' ? -1 : 1) * legendLayout.width / 2 - 8} y={legendLayout.y - 4} width="16" height="18" fill="transparent"/>
              <path d={`M ${legendLayout.x + (side === 'left' ? -1 : 1) * legendLayout.width / 2} ${legendLayout.y - 1} l 5 6 l -5 6 l -5 -6 Z`} fill="white" stroke="#397a9a" pointerEvents="none"/>
            </g>)}
          </g>
        </g>}
        {marker && inside(marker) && <circle cx={marker.x} cy={marker.y} r={Math.max(4, size)} fill="none" stroke="#1e293b" pointerEvents="none"/>}
        {dragBox && <rect data-plot-interaction="zoom" x={Math.max(layout.left, Math.min(dragBox.start.x, dragBox.end.x))} y={Math.max(layout.top, Math.min(dragBox.start.y, dragBox.end.y))}
          width={Math.max(0, Math.min(layout.right, Math.max(dragBox.start.x, dragBox.end.x)) - Math.max(layout.left, Math.min(dragBox.start.x, dragBox.end.x)))} height={Math.max(0, Math.min(layout.bottom, Math.max(dragBox.start.y, dragBox.end.y)) - Math.max(layout.top, Math.min(dragBox.start.y, dragBox.end.y)))} fill="#397a9a22" stroke="#397a9a" pointerEvents="none"/>}
      </svg>{sizing.handles}
    </div></div>
    <p className="optimization-plot-note" role="status">{summary.count} 点 · 全量{summary.excluded ? ` · 有效域外 ${summary.excluded} 点` : ''}{summary.nonfinite ? ` · 非有限值 ${summary.nonfinite} 点` : ''}{paintState === 'drawing' ? ' · 绘制中' : ''}{selected ? ` · ${xLabel}: ${formatResultValue(selected.x, decimals)}；${yLabel}: ${formatResultValue(selected.y, decimals)}` : ''}</p>
    {message && <p className="optimization-plot-note" role="status">{message}</p>}
  </div>;
}
export default ScientificScatterPlot;
