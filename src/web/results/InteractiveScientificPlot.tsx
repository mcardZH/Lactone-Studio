import {useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {assertResultNotAborted} from '../../results/contracts';
import {boundedInsetBox, plotCoordinateRange, plotPointKey, type PlotFigureEdits, type PlotInset, type PlotPaneEdits, type PlotPosition, type PlotStyle} from '../../results/scientific-plot-editing';
import {nearestScientificPlotIndex, nearestScientificStickIndex, plotDataBounds, validPlotViewport, type ScientificPlotPoint, type ScientificPlotSeries, type ScientificPlotViewport} from '../../results/scientific-plot';
import {fullPrecisionValue, formatResultValue, decimalEnergyValue} from '../../results/numeric-format';
import {DismissibleNotice} from '../DismissibleNotice';
import {useScientificPlotViewport, type ScientificPlotProps} from './ScientificPlot';
import {plotFontFamily, usePlotAppearance, usePlotFont} from './ScientificPlotSettings';
import {useScientificPlotSize} from './ScientificPlotSize';
import {usePlotFigure, usePlotPresetLibrary, fallbackPlotStyle, plotPresetSnapshot, applyPlotPreset, figureViewport, plotTextInput, type PlotFigureRecord} from './scientific-plot-figure';
import {editCurrentPlot,plotCanvasConfiguration,plotEditorPane,plotPartCapabilities, plotMapping, insetCoordinateKey} from './plot-editor-pane';
import {plotGeometry, ScientificPlotDrawing} from './ScientificPlotDrawing';
import {canRemovePlotTarget, hasPlotSettingsTarget, matchesRemovedPlotTarget, PlotEditorToolbar, PlotInspector, PlotPresetControls, PlotQuickControls, plotPanels, type InsetInspector, type PlotPanel, type PlotTarget} from './ScientificPlotEditor';
import {editPlotPane, usePlotGestures, targetFromPlotHit, insidePlot, isPlotAxisHit, clampPlot, minimumInsetSize,
  type InteractivePlotPane, type PlotHit, type PlotPart, type PlotSelection} from './use-plot-gestures';
import {PlotSettingsWindow} from './VisualizationPresetDialog';
import {captureScientificSvgPng, serializeOptimizationSvg} from './optimization-export';
import {exportBlob} from './export-image';
import {ScientificImageCopyButton} from '../ScientificImageCopyButton';
import {ScientificPlotExportMenu} from './ScientificPlotExportMenu';
import {ResultsMcpPlotRegistration,type NativeMcpSettings,type PlotExportFormat} from './results-mcp-context';
import {settingArray,settingBool,settingEnum,settingPositive} from './analysis-mcp-settings';
import {objectSchema} from '../mcp/types';
import './scientific-plot-editing.css';

const available = (value: ScientificPlotViewport | null | undefined): ScientificPlotViewport => value ?? {x: [0, 1], y: [0, 1]};

function plottedBounds(series:readonly ScientificPlotSeries[],startsAtZero:boolean) {
  const bounds=plotDataBounds(series);
  if(bounds && startsAtZero && bounds.y[0]<0 && series.every(line=>line.points.every(point=>point.y===null||point.y>=0))
    && bounds.y[1]>0)
    bounds.y[0]=0;
  return bounds;
}

function orderedPlotPoints(series: readonly ScientificPlotSeries[]) {
  return series.map(line => line.kind === 'stick' || line.kind === 'histogram' ? null : {
    id: line.id,
    points: line.points.flatMap((point, row) => point.y !== null && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? [{point, row}] : []).sort((a,b) => a.point.x-b.point.x),
  }).filter(item => item !== null);
}

function closestPlotRow(hit: PlotHit, at: PlotPosition, pane: InteractivePlotPane, ordered: ReturnType<typeof orderedPlotPoints>): PlotHit {
  const g = pane.geometry;
  const limits = [g.xValue(at.x-8, false),g.xValue(at.x+8,false)].sort((a,b)=>a-b);
  let score = 64, closer = hit;
  for (const line of ordered) {
    let first = 0, last = line.points.length;
    while (first < last) {
      const mid = (first+last) >>> 1;
      if (line.points[mid].point.x < limits[0]) first = mid+1;
      else last = mid;
    }
    for (let index=first; index<line.points.length && line.points[index].point.x<=limits[1]; index++) {
      const entry = line.points[index], point = entry.point;
      const distance = (g.x(point.x)-at.x)**2+(g.y(point.y!)-at.y)**2;
      if (distance < score) {score=distance; closer={...hit,key:line.id,row:entry.row};}
    }
  }
  return closer;
}

function closestOrbitalLevel(hit: PlotHit, at: PlotPosition, pane: InteractivePlotPane): PlotHit {
  const {context, geometry} = pane;
  let best = hit;
  let bestDistance = Infinity;
  for (const line of context.series) {
    if (context.seriesStyle(line.id).hidden) continue;
    const [start, end] = line.points;
    if (start?.y == null || !end || !Number.isFinite(start.y)) continue;
    const y = geometry.y(start.y);
    if (y < geometry.top || y > geometry.bottom) continue;
    const x1 = geometry.x(start.x), x2 = geometry.x(end.x);
    const left = Math.max(geometry.left, Math.min(x1, x2));
    const right = Math.min(geometry.right, Math.max(x1, x2));
    if (!(left <= right)) continue;
    const dx = Math.max(left - at.x, at.x - right, 0);
    const distance = dx ** 2 + (y - at.y) ** 2;
    if (distance < bestDistance || distance === bestDistance && line.id === hit.key) {
      best = {...hit, key: line.id, row: 0};
      bestDistance = distance;
    }
  }
  return best;
}

function nearestVisibleFrameByEnergy(pane:InteractivePlotPane, value:number, current?:number):number|undefined {
  const {x,y} = pane.context.range;
  const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(value), y[1] - y[0]);
  let index:number|undefined, distance=Infinity, frameDistance=Infinity;
  for (const line of pane.context.series) {
    if (pane.context.pane.series?.[line.id]?.hidden ?? pane.context.style.line.hidden) continue;
    for (const point of line.points) {
      if (point.index === undefined || point.y === null || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
          point.x < x[0] || point.x > x[1] || point.y < y[0] || point.y > y[1]) continue;
      const nextDistance = Math.abs(point.y-value);
      const nextFrameDistance = Math.abs(point.index-(current ?? 0));
      if (nextDistance < distance - tolerance ||
          Math.abs(nextDistance-distance) <= tolerance && nextFrameDistance < frameDistance) {
        index=point.index; distance=nextDistance; frameDistance=nextFrameDistance;
      }
    }
  }
  return index;
}

export default function InteractiveScientificPlot(p: ScientificPlotProps) {
  const appearance = usePlotAppearance(p.appearanceKey, p.plotStyle !== 'spectrum');
  const identity = p.appearanceKey ?? p.exportFileName ?? appearance.key;
  const props = {...p, appearance, identity};
  return p.figureRecord ? <PlotEditor {...props} record={p.figureRecord}/> : <LocalPlotEditor {...props}/>;
}

type PlotEditorProps = ScientificPlotProps & {appearance: ReturnType<typeof usePlotAppearance>; identity: string | number};
function LocalPlotEditor(p: PlotEditorProps) {
  const record = usePlotFigure(p.identity);
  return <PlotEditor {...p} record={record}/>;
}

function PlotEditor({record, appearance, identity, ...p}: PlotEditorProps & {record: PlotFigureRecord}) {
  const spectrum = p.plotStyle === 'spectrum', histogram = p.plotStyle === 'histogram', orbital=p.plotStyle==='orbital', source = p.spectrumInset;
  const supportsInset=Boolean(source)||!spectrum&&!histogram&&!orbital;
  const family=spectrum?'spectrum':histogram?'histogram':orbital?'orbital':'line';
  const category=spectrum?p.plotPresetScope??'uv-vis':family;
  const legacy = appearance.value, library = usePlotPresetLibrary(family,p.plotPresetScope);
  const [draft, preview] = useState<PlotFigureEdits>();
  const figure = draft ?? record.figure, inset = supportsInset ? figure.inset : undefined;
  const style = figure.style ?? fallbackPlotStyle(library, appearance.stored);
  useEffect(()=>{
    if(!record.figure.style)record.initializeStyle(style,appearance.stored.linePreset??library.defaultId??library.builtins[0]?.id);
  },[record.figure.style,style,identity]);
  const axisKey = p.axisContext ?? 'default', axes = figure.coordinates?.[axisKey] ?? {};
  const mapping = plotMapping(p.axisTransforms, source?.axisUnit), insetMapping = plotMapping(source?undefined:p.axisTransforms, source?.axisUnit);
  const full = useMemo(() => {
    const data = plottedBounds(p.series,spectrum||histogram);
    if(!data)return data;
    const x=p.xDomain&&p.xDomain.every(Number.isFinite)&&p.xDomain[0]<p.xDomain[1]?p.xDomain:data.x;
    const scale=p.secondaryYAxis?.toPrimaryScale;
    if(spectrum&&scale&&Number.isFinite(scale)&&scale>0)for(const line of p.secondaryYAxis!.series)for(const point of line.points){
      if(point.y!==null&&Number.isFinite(point.y)&&point.x>=x[0]&&point.x<=x[1])data.y[1]=Math.max(data.y[1],point.y*scale*1.12);
    }
    return {...data,x};
  }, [p.series,p.secondaryYAxis,p.xDomain?.[0],p.xDomain?.[1],spectrum,histogram]);
  const canonical = full && mapping.viewport(full, true);
  const baseView=canonical && {x:axes.x?.bounds??canonical.x,y:axes.y?.bounds??canonical.y};
  const zoomScope = p.axisTransforms || source?.axisUnit ? axisKey : p.resetKey;
  const restored = useScientificPlotViewport(baseView, {
    viewport: p.viewport && mapping.viewport(p.viewport, true),
    onViewportChange: p.onViewportChange && (value => p.onViewportChange?.(value && mapping.viewport(value))),
    resetKey: zoomScope,
    appearanceKey: JSON.stringify(['editor', identity, axisKey]),
  });
  const view=figureViewport(record,baseView,restored.zoomed?restored.viewport:null,zoomScope);
  const zoomCallback=useRef(p.onViewportChange);zoomCallback.current=p.onViewportChange;
  const trackedZoom=record.figure.zoom?.scope===zoomScope?record.figure.zoom:undefined;
  useEffect(()=>{if(trackedZoom)zoomCallback.current?.(trackedZoom.range&&mapping.viewport(trackedZoom.range));},[trackedZoom]);
  const range = view.viewport && mapping.viewport(view.viewport);
  const sizing = useScientificPlotSize(identity,record), svg = useRef<SVGSVGElement>(null), stage = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null);
  const assignStage = useCallback((node: HTMLDivElement | null) => {stage.current = node; sizing.stageRef(node);}, [sizing.stageRef]);
  const id = `chart-${useId().replace(/[^a-z0-9-]/gi, '')}`;
  usePlotFont(host.current?.ownerDocument);
  const [advanced, setAdvanced] = useState(false), [panel, setPanel] = useState<PlotPanel>('series'), [part, setPart] = useState<PlotPart>('main');
  const [selected, setSelected] = useState<PlotSelection>(), [hover, setHover] = useState<{point: ScientificPlotPoint; location: PlotPosition}>();
  const [creatingInset, setCreatingInset] = useState(false);
  const [message, setMessage] = useState(''), [exporting, setExporting] = useState(false), exportController = useRef<AbortController | null>(null);
  const closeSettings = () => {
    setSelected(undefined);
    svg.current?.focus({preventScroll: true});
  };
  function dismissRemovedObject(which: PlotPart, target: PlotTarget) {
    if (selected?.part === which && matchesRemovedPlotTarget(selected.target, target)) closeSettings();
  }
  const location = ({clientX, clientY}: {clientX: number; clientY: number}) => {
    const rect = stage.current?.getBoundingClientRect();
    return {x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0)};
  };
  function selectTarget(which: PlotPart, target: PlotTarget, at: PlotPosition = {x: 16, y: 16}, point?: ScientificPlotPoint, editText = false) {
    setPart(which); setSelected({part: which, target, location: at, point, editText});
    if (advanced) setPanel(target.kind === 'axis' ? 'axes' : target.kind === 'text' ? 'text' : target.kind === 'guide' ? 'guides' : target.kind === 'inset' ? 'inset' : 'series');
  }
  useEffect(() => {setExporting(false); return () => exportController.current?.abort();}, [p.resetKey]);

  const insetAxes = inset?.coordinates?.[insetCoordinateKey] ?? {};
  const insetX = insetAxes.x?.bounds && plotCoordinateRange(insetAxes.x.bounds, value => insetMapping.displayValue('x', value));
  const insetY = insetAxes.y?.bounds && plotCoordinateRange(insetAxes.y.bounds, value => insetMapping.displayValue('y', value));
  const insetBuilder = source?.build;
  const insetSettings = inset && (inset.spectrum ?? source?.settings);
  const projection = useMemo(() => {
    if (!insetSettings || !insetBuilder) return null;
    try { return {data: insetBuilder(insetSettings, insetX), error: ''}; }
    catch (cause) { return {data: null, error: cause instanceof Error ? cause.message : String(cause)}; }
  }, [insetBuilder, insetSettings, insetX?.[0], insetX?.[1]]);
  const insetSeries = projection?.data?.series ?? p.series, insetSecondary = projection?.data ? projection.data.secondaryYAxis : p.secondaryYAxis;
  const mainOrder = useMemo(() => orderedPlotPoints(p.series), [p.series]);
  const insetOrder = useMemo(() => insetSeries === p.series ? mainOrder : orderedPlotPoints(insetSeries), [insetSeries, p.series, mainOrder]);
  const insetPeaks = projection?.data?.peaks ?? p.spectrumPeaks;
  const builtRange = inset && plottedBounds(insetSeries,spectrum);
  const insetRange = builtRange && {x: insetX ?? builtRange.x, y: insetY ?? builtRange.y};
  const insetStyle = inset?.style ?? {...style, line:{...style.line,width:Math.min(style.line.width,1)}, showAnnotation: false, showLegend: false,
    fonts: Object.fromEntries(Object.entries(style.fonts).map(([key, font]) => [key, {...font, size: Math.min(font.size, key === 'ticks' ? 4.5 : 5.5)}])) as PlotStyle['fonts'],
    frame: {left: 0, right: 0, top: 0, bottom: 0}};
  const titles = {title: legacy.title ?? p.title, x: legacy.xLabel ?? p.xLabel, y: legacy.yLabel ?? p.yLabel, secondary: p.secondaryYAxis?.label};
  const insetTitles = {...titles, title: 'Inset', y: projection?.data?.yLabel ?? titles.y, secondary: insetSecondary?.label};
  const nominalWidth = style.canvas.width * 96 / 25.4, nominalHeight = style.canvas.height * 96 / 25.4;
  const drawingScale = Math.max(1, 220 / nominalWidth, 220 / nominalHeight);
  const mainGeometry = range && validPlotViewport(range) ? plotGeometry({width: nominalWidth * drawingScale, height: nominalHeight * drawingScale,
    title: titles.title, yLabel: titles.y, subtitle: p.subtitle, range, edits: figure, style, editable: true, secondary: p.secondaryYAxis,
    squareFrame:style.canvas.width === style.canvas.height, wideFrame:true,
    reverseX: !!p.reverseX, reverseY: !!p.reverseY,
    xStep: axes.x?.step === undefined ? undefined : mapping.displayStep('x', axes.x.step),
    yStep: axes.y?.step === undefined ? undefined : mapping.displayStep('y', axes.y.step)}) : undefined;
  const insetBox = inset && mainGeometry && {x: inset.box.x * mainGeometry.width, y: inset.box.y * mainGeometry.height,
    width: inset.box.width * mainGeometry.width, height: inset.box.height * mainGeometry.height};
  const insetGeometry = inset && insetBox && validPlotViewport(insetRange) ? plotGeometry({...insetBox, range: insetRange,
    title: insetTitles.title, yLabel: insetTitles.y, edits: inset, style: insetStyle, editable: true, compact: true, secondary: insetSecondary,
    reverseX: !!p.reverseX, reverseY: !!p.reverseY, xStep: insetAxes.x?.step, yStep: insetAxes.y?.step}) : undefined;

  function update(which: PlotPart, change: Partial<PlotPaneEdits>, group?: string) {
    record.replace(previous => {
      const next=editPlotPane(previous,which,change), proposed=change.coordinates?.[axisKey], before=previous.coordinates?.[axisKey];
      if (which === 'main' && 'position' in change && !change.position && previous.position && next.inset) {
        const {x, y} = previous.position, box = next.inset.box;
        next.inset = {...next.inset, box: boundedInsetBox({...box, x: box.x - x, y: box.y - y},box)};
      }
      const rangeChanged=proposed && (proposed.x?.bounds!==before?.x?.bounds||proposed.y?.bounds!==before?.y?.bounds);
      return which==='main' && rangeChanged && view.zoomed ? {...next,zoom:{scope:zoomScope,range:null,back:[]}} : next;
    }, group && which+'-'+group);
  }
  const main = {...plotEditorPane({pane: figure, style, range: available(range), axisKey, mapping, titles,
    series: [...p.series, ...(p.secondaryYAxis?.series ?? [])], peaks: p.spectrumPeaks, canAnnotate: spectrum || !!p.onSelectIndex,
    edit: (value, group) => update('main', value, group), endEdit: record.endGroup, onDismiss: target => dismissRemovedObject('main', target),
    onTarget: target => selectTarget('main', target, undefined, undefined, true), legacyNames: legacy.names}),
    tickIntervals:{x:mainGeometry?.xTicks.step,y:mainGeometry?.yTicks.step},
    xSamplingControls:p.xSamplingControls,spectrum:spectrum?{hasSticks:!!p.hasSpectrumSticks}:undefined};
  const child = inset && {...plotEditorPane({pane: inset, style: insetStyle, range: available(insetRange), axisKey: insetCoordinateKey, mapping: insetMapping,
    titles: insetTitles, series: [...insetSeries, ...(insetSecondary?.series ?? [])], peaks: insetPeaks, canAnnotate: true,
    edit: (value, group) => update('inset', value, group), endEdit: record.endGroup, onDismiss: target => dismissRemovedObject('inset', target),
    onTarget: target => selectTarget('inset', target, undefined, undefined, true)}),
    tickIntervals:{x:insetGeometry?.xTicks.step,y:insetGeometry?.yTicks.step},
    spectrum:spectrum?{hasSticks:insetSeries.some(line=>line.kind==='stick')}:undefined};
  const panes: Partial<Record<PlotPart, InteractivePlotPane>> = {
    main: mainGeometry && {context: main, geometry: mainGeometry, offset: {x: 0, y: 0}, axisKey, secondarySeries: p.secondaryYAxis?.series},
    inset: child && insetGeometry && insetBox ? {context: child, geometry: insetGeometry, offset: insetBox, axisKey: insetCoordinateKey,
      secondarySeries: insetSecondary?.series} : undefined,
  };
  const controlsFor = (which: PlotPart) => which === 'inset' && child ? child : main;
  const current = controlsFor(part);
  const focused = selected?.part === 'inset' ? child : main;
  const canInspect = !!selected && !!focused && hasPlotSettingsTarget(selected.target, focused);
  useEffect(() => {if (selected && !canInspect) setSelected(undefined);}, [selected, canInspect]);
  const findPoint = (hit: PlotHit) => hit.peak ? (hit.part === 'main' ? p.spectrumPeaks : insetPeaks)?.[hit.row]
    : controlsFor(hit.part).series.find(line => line.id === hit.key)?.points[hit.row];
  function resolveHit(hit: PlotHit, at?: PlotPosition) {
    const pane = panes[hit.part], order = hit.part === 'inset' ? insetOrder : mainOrder;
    if (hit.kind !== 'point' || spectrum || histogram || !at || !pane) return hit;
    return orbital ? closestOrbitalLevel(hit, at, pane) : closestPlotRow(hit, at, pane, order);
  }
  function pick(point?: ScientificPlotPoint) {
    if (p.selectingZero && point) p.onSetZeroPoint?.(point);
    else if (point?.index !== undefined) p.onSelectIndex?.(point.index);
  }
  function applyRange(viewport: ScientificPlotViewport, which: PlotPart, create: boolean) {
    if (create && mainGeometry) {
      const g = mainGeometry;
      const width = Math.min(.43, (g.right-g.left) / g.width * .87), height = Math.min(.42, (g.bottom-g.top) / g.height * .72);
      const box = boundedInsetBox({x: g.right / g.width - width - .02, y: g.top / g.height + .02, width, height},minimumInsetSize(g));
      const x = plotCoordinateRange(viewport.x, value => mapping.sourceValue('x', value));
      const y = plotCoordinateRange(viewport.y, value => insetMapping.sourceValue('y', value));
      record.replace(previous => ({...previous, inset: {box, unit: source?.axisUnit,
        text: {x: {hidden: true}, y: {hidden: true}, 'secondary-y': {hidden: true}},
        coordinates: {[insetCoordinateKey]: {x: {bounds: x}, y: {bounds: y}}}}}));
      setCreatingInset(false); setPart('inset'); setPanel('inset');
    } else if (which === 'main') view.zoom(mapping.viewport(viewport, true));
  }
  const gesture = usePlotGestures({
    figure: record.figure, stage, ...panes, makeInset: creatingInset, selectingZero: p.selectingZero, reverseX: p.reverseX, reverseY: p.reverseY,
    location, preview, commit: record.replace, zoom: applyRange,
    hover(hit, at, local) {
      const point = hit.kind === 'point' && findPoint(resolveHit(hit, local));
      setHover(previous => point ? previous?.point === point ? previous : {point, location: at} : undefined);
    },
    select(rawHit, local) {
      if(rawHit.part==='inset')return;
      const hit = resolveHit(rawHit, local);
      const point = findPoint(hit);
      if (point) {pick(point); return;}
      const pane = panes[hit.part], geometry = pane?.geometry;
      if (!pane || !geometry || !p.onSelectIndex || p.selectingZero) return;
      if (hit.part === 'main' && hit.axis === 'y' && isPlotAxisHit(hit) && p.pointReadout?.kind === 'Frame') {
        const index = nearestVisibleFrameByEnergy(pane,hit.axisValue ?? geometry.yValue(local.y),p.selectedIndex);
        if (index !== undefined) p.onSelectIndex(index);
        return;
      }
      if (orbital || !insidePlot(local, geometry) || (hit.kind !== 'line' && hit.kind !== 'paper')) return;
      const data = controlsFor(hit.part).series, secondary = hit.part === 'inset' ? insetSecondary : p.secondaryYAxis;
      const index = nearestScientificStickIndex(secondary?.series ?? data, local, geometry.x, secondary ? geometry.secondaryY : geometry.y)
        ?? (!spectrum ? nearestScientificPlotIndex(data, geometry.xValue(local.x)) : null);
      if (index !== null) p.onSelectIndex(index);
    },
    inspect(rawHit, at, local) {
      const hit = resolveHit(rawHit, local);
      const target = targetFromPlotHit(hit) ?? (hit.part === 'inset' && hit.kind === 'paper' ? {kind:'inset'} : undefined);
      if (target) selectTarget(hit.part, target, at, findPoint(hit));
    },
  });
  const activeAxis = useRef(JSON.stringify([identity, axisKey]));
  useEffect(() => {
    const key = JSON.stringify([identity, axisKey]);
    if (activeAxis.current !== key) {activeAxis.current = key; gesture.cancel(); setSelected(undefined); setHover(undefined); setCreatingInset(false);}
  }, [identity, axisKey]);

  const insetControls: InsetInspector | undefined = supportsInset ? {
    inset, fwhmUnit: source?.fwhmUnit??'', settings: source?.settings,
    create() {setCreatingInset(true);},
    remove() {
      record.replace(previous => ({...previous, inset: undefined}));
      setPart('main'); setPanel('series'); dismissRemovedObject('inset', {kind:'inset'});
    },
    change(change: Partial<PlotInset>, group) {
      record.replace(previous => previous.inset ? {...previous, inset: {...previous.inset, ...change,
        box:change.box?boundedInsetBox(change.box,mainGeometry?minimumInsetSize(mainGeometry,insetGeometry):undefined)
          :previous.inset.box}}:previous,group);
    },
  }:undefined;
  function removeTarget() {
    if (!selected) return;
    const {target, part} = selected, edit = controlsFor(part);
    if (target.kind === 'text') edit.removeText(target.id);
    else if (target.kind === 'guide') edit.removeGuide(target.id);
    else if (target.kind === 'inset') insetControls?.remove();
  }
  function keyboard(event: KeyboardEvent) {
    if (plotTextInput(event.target)) return;
    const key = event.key.toLowerCase(), modifier = event.ctrlKey || event.metaKey;
    if (modifier && (key === 'z' || key === 'y')) {
      event.preventDefault(); event.stopPropagation();
      if (key === 'y' || event.shiftKey) record.redo(); else record.undo();
    } else if (key === 'escape' && (creatingInset || gesture.resizePart)) {
      event.preventDefault(); event.stopPropagation(); setCreatingInset(false); gesture.hideResizeHandles();
    }
  }

  const capture = (doc: Document, signal: AbortSignal) => captureScientificSvgPng(svg.current, doc, signal);
  async function captureExport(format:PlotExportFormat,signal:AbortSignal) {
    const node=svg.current;
    if(!node?.isConnected)throw new Error('图窗尚未准备好或已关闭。');
    const data=format==='raw'?p.exportRawText:p.exportText;
    if((format==='raw'||format==='txt')&&!data)throw new Error('当前图形没有该格式的导出。');
    const blob=format==='png'?await capture(node.ownerDocument,signal)
      :format==='svg'?new Blob([serializeOptimizationSvg(node)],{type:'image/svg+xml;charset=utf-8'})
      :new Blob([typeof data?.text==='function'?data.text():data?.text??''],{type:'text/plain;charset=utf-8'});
    assertResultNotAborted(signal);
    return {blob,filename:(format==='txt'||format==='raw')&&data?data.fileName:`${p.exportFileName??'Ester-Studio-plot'}.${format}`};
  }
  const choose = (which: PlotPart, id: string, saved?: PlotStyle) =>
    update(which, saved ? {presetId: id} : applyPlotPreset(controlsFor(which).pane, id, library.style(id)));
  const assertFigureIdle=()=>{if(draft||gesture.inProgress()||creatingInset)throw new Error('图形手势正在进行。');};
  const insetConfiguration:NativeMcpSettings|undefined=insetControls&&{
    schema:objectSchema({action:settingEnum(inset?['update','remove']:['create']),
      range:{...objectSchema({x:settingArray({type:'number'},2,2),y:settingArray({type:'number'},2,2)},['x','y']),description:'Two ascending limits per axis in displayed units. Required when creating an inset.'},
      ...(inset?{box:{...objectSchema({x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1},
        width:{type:'number',exclusiveMinimum:0,maximum:1},height:{type:'number',exclusiveMinimum:0,maximum:1}}),description:'Inset position and size as fractions of the plot area. Use with action=update.'}}:{}),
      ...(source?{spectrum:objectSchema({mode:settingEnum(['linked','local']),fwhm:settingPositive,peakShape:settingEnum(['gaussian','lorentzian']),normalize:settingBool})}:{})},['action']),
    read:()=>({inset:inset??null,range:insetRange,mainRange:range,mainSettings:source?.settings,fwhmUnit:source?.fwhmUnit}),
    apply(values){
      assertFigureIdle();
      const {action,range:viewport,box,spectrum}=values as {action:'create'|'update'|'remove';range?:ScientificPlotViewport;box?:Partial<PlotInset['box']>;
        spectrum?:{mode?:'linked'|'local'}&Partial<NonNullable<PlotInset['spectrum']>>};
      if(viewport&&(!validPlotViewport(viewport)||source?.axisUnit==='nm'&&viewport.x[0]<=0))throw new Error('副图范围无效。');
      if(action==='create'){
        if(inset||!mainGeometry||!viewport||box||spectrum)throw new Error('新建副图需要一个有效的坐标范围。框位置和独立展宽在创建后编辑。');
        applyRange(viewport,'main',true);return;
      }
      if(!inset)throw new Error('当前主图没有副图。');
      if(action==='remove'){
        if(viewport||box||spectrum)throw new Error('关闭副图时请单独提交移除动作。');
        insetControls.remove();return;
      }
      if(!viewport&&!box&&!spectrum)throw new Error('请选择要修改的副图参数。');
      const patch:Partial<PlotInset>={};
      if(viewport){
        const mapped=insetMapping.viewport(viewport,true),previous=inset.coordinates?.[insetCoordinateKey];
        if(!validPlotViewport(mapped))throw new Error('副图范围无法转换为当前数据单位。');
        patch.coordinates={...inset.coordinates,[insetCoordinateKey]:{...previous,x:{...previous?.x,bounds:mapped.x},y:{...previous?.y,bounds:mapped.y}}};
      }
      if(box)patch.box={...inset.box,...box};
      if(spectrum){
        const {mode,...broadening}=spectrum,existing=inset.spectrum??insetControls.settings;
        if(mode==='linked'&&Object.keys(broadening).length)throw new Error('跟随主图时使用主图展宽。');
        if(mode!=='linked'&&!existing)throw new Error('该图形没有可编辑的副图展宽。');
        patch.spectrum=mode==='linked'?undefined:{...existing!,...broadening};
      }
      insetControls.change(patch);
    },
  };
  const mcpPort=mainGeometry&&range?<ResultsMcpPlotRegistration chartId={id} chartKey={p.appearanceKey===undefined?undefined:String(p.appearanceKey)} figureIdentity={`${identity}:${String(p.resetKey)}`} port={{
    read:()=>{
      const mainPart=plotPartCapabilities(main);
      return {title:figure.text?.title?.content??titles.title,xLabel:figure.text?.x?.content??titles.x,yLabel:figure.text?.y?.content??titles.y,
        family,figure,range,metadata:p.metadata,formats:['svg','png',...(p.exportText?['txt' as const]:[]),...(p.exportRawText?['raw' as const]:[])],
        series:mainPart.series,textIds:mainPart.textIds,edits:mainPart.editOperations,parts:child?['main','inset']:['main'],
        partCapabilities:{main:mainPart,...(child?{inset:plotPartCapabilities(child)}:{})},
        presets:[...library.builtins,...library.personal].map(({id,label})=>({id,label})),defaultPresetId:library.defaultId,canUndo:record.canUndo,canRedo:record.canRedo};
    },
    edit:(change,which='main')=>{
      assertFigureIdle();
      if(which==='inset'&&!child)throw new Error('当前主图没有副图。');
      editCurrentPlot(change,which==='inset'?child!:main,record);
    },
    configuration:{canvas:plotCanvasConfiguration(main,assertFigureIdle),...Object.fromEntries(Object.entries(p.mcpConfigurations??{}).map(([scope,settings])=>[scope,
      {...settings,apply:(patch:Record<string,unknown>)=>{assertFigureIdle();settings.apply(patch);}}])),...(p.mcpConfiguration?{presentation:{...p.mcpConfiguration,
      apply:(patch:Record<string,unknown>)=>{assertFigureIdle();p.mcpConfiguration!.apply(patch);}}}:{}),...(insetConfiguration?{inset:insetConfiguration}:{})},
    preset:presetId=>{assertFigureIdle();choose('main',presetId);},
    savePreset:label=>{
      assertFigureIdle();
      const snapshot=plotPresetSnapshot(style,figure),id=library.save(label,snapshot);choose('main',id,snapshot);return id;
    },
    defaultPreset:library.makeDefault,
    export:(format,signal)=>captureExport(format,signal),
    canSelectPoint:Boolean(p.onSelectIndex&&!p.selectingZero),
    point(seriesId,pointIndex,action){
      const series=main.series.find(item=>item.id===seriesId),point=series?.points[pointIndex];
      if(!point)return;
      if(action==='select'){
        assertFigureIdle();
        if(!p.onSelectIndex||p.selectingZero||point.index===undefined||
          (main.pane.series?.[seriesId]?.hidden??main.style.line.hidden))return;
        pick(point);
      }
      return point;
    },
    isVisible:()=>!!svg.current?.getClientRects().length,
  }}/>:null;
  async function exportFigure(format: 'svg' | 'png' | 'txt') {
    const node = svg.current;
    if (!node || exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller; setExporting(true); setMessage('');
    try {
      const {blob,filename}=await captureExport(format,controller.signal);
      exportBlob(blob,filename,node.ownerDocument);
      setMessage(`已发起 ${format.toUpperCase()} 下载。`);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '图表导出失败。');
    } finally {
      if (exportController.current === controller) exportController.current = null;
      if (!controller.signal.aborted) setExporting(false);
    }
  }

  if (!mainGeometry || !range) return <div ref={host}><p className="optimization-plot-empty">没有可绘制的数值。</p></div>;
  const box = gesture.box, geometry = mainGeometry;
  const actions = <div className="optimization-plot-options scientific-plot-tools scientific-plot-actions" aria-label="图像操作">
    <button type="button" disabled={!view.canGoBack} onClick={view.back}>返回上一级</button>
    <button type="button" onClick={() => view.reset()}>恢复视图</button>
    <button type="button" onClick={current.resetLayout}>恢复布局</button>
    <button type="button" onClick={current.insertText}>插入文字</button>
    {!orbital&&<label className="plot-edit-check"><input type="checkbox" checked={current.showLegend} onChange={event => current.edit({showLegend: event.target.checked})}/>显示图例</label>}
    {insetControls && <button type="button" aria-pressed={creatingInset} onClick={insetControls.create}>框选副图区域</button>}
    <button type="button" disabled={!record.canUndo} onClick={record.undo}>撤销</button>
    <button type="button" disabled={!record.canRedo} onClick={record.redo}>重做</button>
    <ScientificImageCopyButton resetKey={p.resetKey} capture={capture}/>
    <ScientificPlotExportMenu disabled={exporting} options={[
      {key: 'svg', label: `${p.exportLabel ? `${p.exportLabel} · ` : ''}SVG`, run: () => void exportFigure('svg')},
      {key: 'png', label: `${p.exportLabel ? `${p.exportLabel} · ` : ''}PNG`, run: () => void exportFigure('png')},
      ...(p.exportText ? [{key: 'txt', label: '数据 TXT', run: () => void exportFigure('txt')}] : []),
    ]}/>{p.children}
  </div>;
  const stageHeight = Math.round(sizing.width * geometry.height / geometry.width);
  const displayScale = Math.min(sizing.width / geometry.width, stageHeight / geometry.height);
  function drawing(which: PlotPart) {
    const sub = which === 'inset', pane = panes[which]!, edit = pane.context, labels = sub ? insetTitles : titles;
    return <ScientificPlotDrawing id={`${id}-${which}`} geometry={pane.geometry} range={edit.range} part={which} edits={edit.pane} style={edit.style}
      title={labels.title} xLabel={labels.x} yLabel={labels.y} subtitle={sub ? undefined : p.subtitle}
      series={sub ? insetSeries : p.series} secondary={sub ? insetSecondary : p.secondaryYAxis} peaks={sub ? insetPeaks : p.spectrumPeaks}
      legendLabels={sub ? undefined : legacy.names}
      selectedIndex={sub?undefined:p.selectedIndex} showXTicks={p.showXTicks} showLegend={edit.showLegend} editable
      selectionMode={p.selectionMode??'x'} spectrum={spectrum} decimals={p.decimals}
      showResizeHandles={gesture.resizePart === which} gripScale={displayScale}
      guides={edit.guides.map(guide => ({...guide, displayValue: guide.followsZero ? 0 : edit.displayValue(guide.axis, guide.value)}))}
      activeText={selected?.part === which && selected.target.kind === 'text' ? selected.target.id : undefined}
      onKeyboardPoint={!sub&&(p.onSelectIndex||p.onSetZeroPoint)?pick:undefined}/>;
  }
  const renderedHeight = stage.current?.clientHeight ?? stageHeight;
  const tooltip = hover && !canInspect && hover.point.y !== null && <PlotPointReadout {...hover} p={p}
    width={stage.current?.clientWidth ?? 320} height={renderedHeight}/>;
  const annotate = spectrum && selected?.target.kind === 'point' && selected.point && focused ? () => {
    const {part, target, point, location} = selected;
    if (target.kind !== 'point' || !point) return;
    const peaks = part === 'inset' ? insetPeaks : p.spectrumPeaks;
    const primary = part === 'inset' ? insetSeries[0] : p.series[0];
    const row = peaks?.findIndex(item => item.index !== undefined && item.index === point.index) ?? -1;
    const labelId = `peak:${plotPointKey(row >= 0 && primary ? primary.id : target.id, row >= 0 ? row : target.index)}`;
    if (focused.pane.text?.[labelId]?.content === undefined) {
      focused.editText(labelId, {content: `${Number(point.x.toPrecision(7))}${p.pointReadout?.xUnit ? ' ' + p.pointReadout.xUnit : ''}`});
    }
    selectTarget(part, {kind: 'text', id: labelId}, location, undefined, true);
  } : undefined;
  const canvas = <div className="scientific-plot-viewport"><div ref={assignStage} className="scientific-plot-stage" style={sizing.style(stageHeight)}>
    <svg ref={svg} xmlns="http://www.w3.org/2000/svg" width={geometry.width} height={geometry.height} viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      className={`optimization-energy-svg scientific-plot-svg is-editable${creatingInset || p.selectingZero ? ' is-picking' : ''}`}
      role="group" tabIndex={0} aria-label={p.ariaLabel ?? p.title} data-testid={p.testId} fontFamily={plotFontFamily(style.fonts.ticks.font)}
      data-plot-style={p.plotStyle ?? 'numeric'} data-line-preset={spectrum ? undefined : style.line.point.hollow ? 'hollow' : 'solid'}
      data-plot-page-mm={style.canvas.width} data-plot-page-height-mm={style.canvas.height}
      data-plot-left={geometry.left} data-plot-right={geometry.right} data-plot-top={geometry.top} data-plot-bottom={geometry.bottom}
      data-x-min={range.x[0]} data-x-max={range.x[1]} data-y-min={range.y[0]} data-y-max={range.y[1]} data-reverse-x={p.reverseX ?? false} data-reverse-y={p.reverseY ?? false}
      onPointerDown={gesture.start} onPointerMove={gesture.move} onPointerUp={event => gesture.finish(event)} onPointerCancel={event => gesture.finish(event, true)}
      onLostPointerCapture={event=>gesture.finish(event,true)} onAuxClick={event=>{if(event.button===1)event.preventDefault();}}
      onPointerLeave={() => setHover(undefined)} onContextMenu={gesture.contextMenu}>
      <title>{main.pane.text?.title?.content ?? titles.title}</title><desc>{`${titles.x}；${titles.y}`}</desc>
      <metadata>{JSON.stringify({...(p.metadata && typeof p.metadata === 'object' ? p.metadata : {metadata: p.metadata}), appearance: style,
        viewport: range, reverseX: p.reverseX ?? false, reverseY: p.reverseY ?? false,
        ...(p.secondaryYAxis ? {secondaryYAxis: {label: p.secondaryYAxis.label, range: geometry.secondaryRange,
          toPrimaryScale:p.secondaryYAxis.toPrimaryScale}} : {}),
        ...(inset ? {inset: {box: inset.box, viewport: insetRange, spectrum: inset.spectrum}} : {}),
      })}</metadata>
      {drawing('main')}
      {insetBox && insetGeometry && <g data-plot-part="inset" data-plot-inset="true" transform={`translate(${insetBox.x} ${insetBox.y})`}>
        {drawing('inset')}
      </g>}
      {box && <rect data-plot-interaction="zoom" x={Math.min(box.start.x, box.end.x)} y={Math.min(box.start.y, box.end.y)}
        width={Math.abs(box.start.x-box.end.x)} height={Math.abs(box.start.y-box.end.y)} fill="#227e681c" stroke="#227e68" pointerEvents="none"/>}
    </svg>
    {tooltip}
    {canInspect && selected && focused && <PlotQuickControls key={JSON.stringify([selected.part, selected.target, selected.editText])}
      context={focused} target={selected.target} anchor={selected.location} onClose={closeSettings} inset={insetControls}
      editText={selected.editText} onAnnotate={annotate}
      onSetZero={selected.point && selected.part === 'main' && p.onSetZeroPoint ? () => p.onSetZeroPoint?.(selected.point!) : undefined}
      remove={canRemovePlotTarget(selected.target) ? removeTarget : undefined}/>}
  </div></div>;
  const notices = (message || projection?.error) && <DismissibleNotice role={projection?.error ? 'alert' : 'status'}>{projection?.error || message}</DismissibleNotice>;
  const content = <>{canvas}{actions}{notices}</>;
  return <div ref={host} className={`scientific-plot interactive-scientific-plot${p.responsive !== false ? ' optimization-plot-responsive' : ''}`} onKeyDown={keyboard}>
    {mcpPort}
    <PlotEditorToolbar data={p.toolbar} library={library} active={figure.presetId??appearance.stored.linePreset}
      onChoose={(id,saved)=>choose('main',id,saved)} style={plotPresetSnapshot(style,figure)} onAdvanced={()=>{gesture.hideResizeHandles();setAdvanced(true);}}/>
    {advanced ? <PlotSettingsWindow category={category} ownerDocument={host.current?.ownerDocument} onKeyDown={keyboard} onClose={() => {gesture.hideResizeHandles();setSelected(undefined);setAdvanced(false); setPart('main'); setCreatingInset(false);}}
      figure={content} sidebar={<>
        <PlotPresetControls library={library} active={current.pane.presetId ?? appearance.stored.linePreset} style={plotPresetSnapshot(current.style, current.pane)}
          onChoose={(id, saved) => choose(part, id, saved)}/>
        <nav className="plot-edit-tabs" aria-label="绘图参数">
          {plotPanels.filter(([key])=>part!=='inset'||key!=='canvas').map(([key,label])=>
            <button key={key} type="button" aria-selected={panel===key} onClick={()=>setPanel(key)}>
              {histogram&&key==='series'?'柱形':label}</button>)}
          {insetControls && <button type="button" aria-selected={panel === 'inset'} onClick={() => {setPart(inset ? 'inset' : 'main'); setPanel('inset');}}>副图</button>}
        </nav>
        {inset && <label>编辑对象<select value={part} aria-label="编辑对象" onChange={event => {
          const next=event.target.value as PlotPart;
          setPart(next);
          if(next==='inset'&&panel==='canvas')setPanel('inset');
        }}>
          <option value="main">主图</option><option value="inset">副图</option>
        </select></label>}
        <PlotInspector panel={panel} context={panel === 'inset' && child ? child : current}
          target={canInspect && selected?.part === part ? selected.target : undefined} inset={insetControls}/>
      </>}/> : content}
  </div>;
}

function PlotPointReadout({point, location, width, height, p}: {
  point: ScientificPlotPoint; location: PlotPosition; width: number; height: number; p: ScientificPlotProps;
}) {
  const config = p.pointReadout, label = config?.kind ?? (p.plotStyle === 'spectrum' ? 'Peak' : point.index === undefined ? 'Point' : 'Frame');
  const index = point.readoutId ?? (label === 'Iteration' || label === 'Source Node' ? point.x : point.index === undefined ? '' : point.index + 1);
  const value = (number: number, unit?: string) => {
    const text = p.decimals === undefined ? fullPrecisionValue(number) : formatResultValue(number, p.decimals);
    return (unit === 'Eh' || unit === 'hartree' ? decimalEnergyValue(text) : text) + (unit ? ` ${unit}` : '');
  };
  return <div className="plot-point-readout" data-testid="plot-point-readout" style={{
    left: clampPlot(location.x + 9, 5, Math.max(5, width - 164)),
    top: clampPlot(location.y - 25, 3, Math.max(3, height - 51)),
  }}>{label==='Orbital'&&point.tooltip ? point.tooltip.split('\n').map((line,i)=><span key={i}>{line}</span>):<>
    <span>{label} {index}{label === 'Source Node' && point.markerLabel ? ` · ${point.markerLabel}` : ''}</span>
    <span>X {label==='Bin'&&point.xEnd!==undefined
      ? `${value(point.x)} – ${value(point.xEnd,config?.xUnit)}` : value(point.x,config?.xUnit)}</span>
    <span>Y {value(point.y!, config?.yUnit)}</span></>}</div>;
}
