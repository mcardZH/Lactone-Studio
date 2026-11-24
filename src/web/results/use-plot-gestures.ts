import {useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject} from 'react';
import {plotClientPoint} from '../../results/optimization-plot-axis';
import {zoomPlotViewport, type ScientificPlotPoint, type ScientificPlotSeries, type ScientificPlotViewport} from '../../results/scientific-plot';
import {boundedInsetBox, plotSideTicks, type PlotAxis, type PlotFigureEdits, type PlotFrameOffsets, type PlotGuide, type PlotNote, type PlotPaneEdits, type PlotPosition} from '../../results/scientific-plot-editing';
import type {PlotGeometry} from './ScientificPlotDrawing';
import type {PlotEditorContext, PlotTarget} from './ScientificPlotEditor';
import {withPlotGuide} from './plot-editor-pane';

export type PlotPart = 'main' | 'inset';
export type PlotHit = {part: PlotPart; kind: string; key: string; row: number; axis: PlotAxis; peak: boolean; axisValue?:number};
export interface InteractivePlotPane {
  context: PlotEditorContext; geometry: PlotGeometry; axisKey: string; offset: PlotPosition;
  secondarySeries?: readonly ScientificPlotSeries[];
  nearest?(position: PlotPosition): ScientificPlotPoint | null;
}
export interface PlotSelection {part: PlotPart; target: PlotTarget; location: PlotPosition; point?: ScientificPlotPoint; editText?: boolean}
type DragKind = 'zoom' | 'make-inset' | 'shift' | 'resize' | 'text' | 'guide' | 'inset-shift' | 'inset-resize' | 'pick';
type InkBounds = {start: PlotPosition; end: PlotPosition};
type Gesture = {id: number; start: PlotPosition; hit: PlotHit; pane: InteractivePlotPane; outer: PlotGeometry;
  original: PlotFigureEdits; kind: DragKind; note?: PlotNote; guide?: PlotGuide;
  ink?: InkBounds; middle?: boolean; dragged?: boolean};

export const clampPlot = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
export const insidePlot = (point: PlotPosition, g: PlotGeometry) => point.x >= g.left && point.x <= g.right && point.y >= g.top && point.y <= g.bottom;
export const isPlotAxisHit = (hit: PlotHit) => hit.kind === 'axis' || hit.kind === 'tick';
export function minimumInsetSize(outer:PlotGeometry,inset?:PlotGeometry){
  const width=inset?inset.width-(inset.right-inset.left)+24:62;
  const height=inset?inset.height-(inset.bottom-inset.top)+24:69;
  return {width:Math.min(1,width/outer.width),height:Math.min(1,height/outer.height)};
}

export function usePlotResizePart(stage: RefObject<HTMLDivElement | null>) {
  const [resizePart, setResizePart] = useState<PlotPart>();
  useEffect(() => {
    const owner = stage.current?.ownerDocument;
    if (!resizePart || !owner) return;
    const dismissOutside = (event: globalThis.PointerEvent) => {
      if (!stage.current?.contains(event.target as Node)) setResizePart(undefined);
    };
    owner.addEventListener('pointerdown', dismissOutside, true);
    return () => owner.removeEventListener('pointerdown', dismissOutside, true);
  }, [resizePart, stage]);
  return [resizePart, setResizePart] as const;
}

export function plotHit(target: EventTarget | null): PlotHit {
  const element = target as Element | null;
  const node = element?.closest?.<SVGElement>('[data-plot-hit]');
  const part = element?.closest?.('[data-plot-part]')?.getAttribute('data-plot-part') === 'inset' ? 'inset' : 'main';
  const axisValue = Number(node?.dataset.plotValue);
  return {part, kind: node?.dataset.plotHit ?? 'paper', key: node?.dataset.plotKey ?? '', row: Number(node?.dataset.plotRow),
    axis: node?.dataset.plotAxis === 'y' ? 'y' : 'x', peak: node?.dataset.plotPeakAnchor === 'true',
    ...(Number.isFinite(axisValue) ? {axisValue} : {})};
}

export function targetFromPlotHit(hit: PlotHit): PlotTarget | undefined {
  switch (hit.kind) {
    case 'point': return {kind: 'point', id: hit.key, index: hit.row};
    case 'line': return {kind: 'line', id: hit.key};
    case 'text': return {kind: 'text', id: hit.key};
    case 'legend': return {kind: 'text', id: 'legend'};
    case 'tick': case 'axis': return {kind: 'axis', id: hit.axis};
    case 'inset-frame': case 'inset-resize': return {kind: 'inset'};
    case 'guide': return {kind: 'guide', id: hit.key};
  }
}

export function editPlotPane(figure: PlotFigureEdits, part: PlotPart, change: Partial<PlotPaneEdits>): PlotFigureEdits {
  return part === 'main' ? {...figure, ...change} : figure.inset ? {...figure, inset: {...figure.inset, ...change}} : figure;
}

function resizeFrame(active: Gesture, dx: number, dy: number): PlotFrameOffsets {
  const {pane: {geometry: g, context}, hit} = active, frame = {...(context.pane.frame ?? context.style.frame)};
  const margin = hit.part === 'inset' ? 3 : 12, minimum = hit.part === 'inset' ? 28 : 52;
  const left = margin + Math.max(0, g.position.x), right = g.width - margin + Math.min(0, g.position.x);
  const top = margin + Math.max(0, g.position.y), bottom = g.height - margin + Math.min(0, g.position.y);
  if (hit.key.includes('w')) frame.left += clampPlot(dx, left - g.left, g.right - minimum - g.left) / g.width;
  if (hit.key.includes('e')) frame.right += clampPlot(dx, g.left + minimum - g.right, right - g.right) / g.width;
  if (hit.key.includes('n')) frame.top += clampPlot(dy, top - g.top, g.bottom - minimum - g.top) / g.height;
  if (hit.key.includes('s')) frame.bottom += clampPlot(dy, g.top + minimum - g.bottom, bottom - g.bottom) / g.height;
  return frame;
}

function legendHit(hit: PlotHit) {
  return hit.kind === 'legend' || hit.kind === 'text' && hit.key.startsWith('legend:');
}

function plotInkBounds(svg: SVGSVGElement, nodes: Iterable<Element>, offset: PlotPosition): InkBounds | undefined {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const node of nodes) {
    const bounds = node.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    const start = plotClientPoint(svg, bounds.left, bounds.top), end = plotClientPoint(svg, bounds.right, bounds.bottom);
    if (!start || !end) continue;
    left = Math.min(left, start.x); right = Math.max(right, end.x);
    top = Math.min(top, start.y); bottom = Math.max(bottom, end.y);
  }
  if (Number.isFinite(left)) return {start: {x: left - offset.x, y: top - offset.y}, end: {x: right - offset.x, y: bottom - offset.y}};
}

function shiftFigure(original: PlotFigureEdits, g: PlotGeometry, dx: number, dy: number, ink?: InkBounds) {
  const {inset} = original, box = inset?.box;
  const left = Math.max(12 - g.left, ink ? 3 - ink.start.x : -Infinity, box ? -box.x * g.width : -Infinity);
  const right = Math.min(g.width - 12 - g.right, ink ? g.width - 3 - ink.end.x : Infinity, box ? (1 - box.x - box.width) * g.width : Infinity);
  const top = Math.max(12 - g.top, ink ? 3 - ink.start.y : -Infinity, box ? -box.y * g.height : -Infinity);
  const bottom = Math.min(g.height - 12 - g.bottom, ink ? g.height - 3 - ink.end.y : Infinity, box ? (1 - box.y - box.height) * g.height : Infinity);
  const x = clampPlot(dx, Math.min(left, 0), Math.max(right, 0)) / g.width;
  const y = clampPlot(dy, Math.min(top, 0), Math.max(bottom, 0)) / g.height;
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return;
  return {...original, position: {x: (original.position?.x ?? 0) + x, y: (original.position?.y ?? 0) + y},
    ...(inset && box ? {inset: {...inset, box: {...box, x: box.x + x, y: box.y + y}}} : {})};
}

function snapGuide(pane: InteractivePlotPane, axis: PlotAxis, point: PlotPosition) {
  const g = pane.geometry, pixel = axis === 'x' ? point.x : point.y, project = axis === 'x' ? g.x : g.y;
  let best = axis === 'x' ? g.xValue(pixel) : g.yValue(pixel), distance = 7;
  const rightTicks = plotSideTicks(pane.context.style.axis, 'right', !!g.secondaryRange);
  const ticks = axis === 'x' ? g.xTicks.major : [
    ...g.yTicks.major,
    ...(g.secondaryTicks && rightTicks.direction !== 'off' ? g.secondaryTicks.major.map(tick => g.yValue(g.secondaryY(tick), false)) : []),
  ];
  for (const tick of ticks) {
    const diff = Math.abs(project(tick) - pixel);
    if (diff < distance) { distance = diff; best = tick; }
  }
  for (const line of pane.context.series) {
    const secondary = pane.secondarySeries?.includes(line);
    const projectY = secondary ? g.secondaryY : g.y;
    for (const data of line.points) {
      if (data.y === null || !Number.isFinite(data.x) || !Number.isFinite(data.y)) continue;
      const y = projectY(data.y);
      const diff = Math.hypot(g.x(data.x) - point.x, y - point.y);
      if (diff < distance) {
        distance = diff;
        best = axis === 'x' ? data.x : secondary ? g.yValue(y, false) : data.y;
      }
    }
  }
  const nearest=pane.nearest?.(point);
  if(nearest?.y!=null && Math.hypot(g.x(nearest.x)-point.x,g.y(nearest.y)-point.y)<distance) best=nearest[axis]!;
  return pane.context.sourceValue(axis, best);
}

function dragValue(active: Gesture, end: PlotPosition) {
  const {original, outer, pane, hit, kind} = active, g = pane.geometry, dx = end.x - active.start.x, dy = end.y - active.start.y;
  const patch = (value: Partial<PlotPaneEdits>) => editPlotPane(original, hit.part, value);
  if (kind === 'shift') return shiftFigure(original, g, dx, dy, active.ink);
  if (kind === 'resize') {
    const old = pane.context.pane.frame ?? pane.context.style.frame, frame = resizeFrame(active, dx, dy);
    if (frame.left !== old.left || frame.right !== old.right || frame.top !== old.top || frame.bottom !== old.bottom) return patch({frame});
    return;
  }
  if (kind === 'inset-shift' || kind === 'inset-resize') {
    if (!original.inset) return;
    const box = original.inset.box;
    let next;
    if(kind==='inset-shift'){
      const ink=active.ink;
      const x=ink?clampPlot(dx,Math.min(0,-pane.offset.x-ink.start.x),Math.max(0,outer.width-pane.offset.x-ink.end.x)):dx;
      const y=ink?clampPlot(dy,Math.min(0,-pane.offset.y-ink.start.y),Math.max(0,outer.height-pane.offset.y-ink.end.y)):dy;
      next=boundedInsetBox({...box,x:box.x+x/outer.width,y:box.y+y/outer.height},box);
    }else{
      const minimum=minimumInsetSize(outer,g);
      const w=Math.min(box.width,minimum.width),h=Math.min(box.height,minimum.height);
      let left=box.x,top=box.y,right=left+box.width,bottom=top+box.height;
      if(hit.key.includes('w'))left=clampPlot(left+dx/outer.width,0,right-w);
      if(hit.key.includes('e'))right=clampPlot(right+dx/outer.width,left+w,1);
      if(hit.key.includes('n'))top=clampPlot(top+dy/outer.height,0,bottom-h);
      if(hit.key.includes('s'))bottom=clampPlot(bottom+dy/outer.height,top+h,1);
      next={x:left,y:top,width:right-left,height:bottom-top};
    }
    if (next.x !== box.x || next.y !== box.y || next.width !== box.width || next.height !== box.height)
      return {...original, inset: {...original.inset, box: next}};
    return;
  }
  if (kind === 'text') {
    const ink = active.ink;
    const x = ink ? clampPlot(dx, Math.min(0, 3 - ink.start.x), Math.max(0, g.width - 3 - ink.end.x)) : dx;
    const y = ink ? clampPlot(dy, Math.min(0, 3 - ink.start.y), Math.max(0, g.height - 3 - ink.end.y)) : dy;
    if (x === 0 && y === 0) return;
    const note = {...active.note, position: {x: (active.note?.position?.x ?? 0) + x / g.width, y: (active.note?.position?.y ?? 0) + y / g.height}};
    const guide = hit.key.startsWith('guide:') ? pane.context.guides.find(item => item.id === hit.key.slice(6)) : undefined;
    return guide ? patch(withPlotGuide(pane.context.pane, pane.axisKey, {...guide, label: note}))
      : patch({text: {...pane.context.pane.text, [legendHit(hit) ? 'legend' : hit.key]: note}});
  }
  if (kind === 'guide' && active.guide) {
    const value = snapGuide(pane, active.guide.axis, end);
    return patch(withPlotGuide(pane.context.pane, pane.axisKey, {...active.guide, value, followsZero: false}));
  }
}

export function usePlotGestures(props: {
  figure: PlotFigureEdits; main?: InteractivePlotPane; inset?: InteractivePlotPane;
  stage: RefObject<HTMLDivElement | null>;
  makeInset: boolean; selectingZero?: boolean; reverseX?: boolean; reverseY?: boolean;
  select(hit: PlotHit, local: PlotPosition): void;
  inspect(hit: PlotHit, at: PlotPosition, local: PlotPosition): void;
  hover(hit: PlotHit, at: PlotPosition, local?: PlotPosition): void;
  location(event: {clientX: number; clientY: number}): PlotPosition;
  preview(draft?: PlotFigureEdits): void; commit(figure: PlotFigureEdits): void;
  zoom(view: ScientificPlotViewport, part: PlotPart, makeInset: boolean): void;
}) {
  const gesture = useRef<Gesture | undefined>(undefined);
  const [box, setBox] = useState<{start: PlotPosition; end: PlotPosition}>();
  const [resizePart, setResizePart] = usePlotResizePart(props.stage);
  const point = (event: MouseEvent<SVGSVGElement>) => plotClientPoint(event.currentTarget, event.clientX, event.clientY);
  const local = (position: PlotPosition, pane: InteractivePlotPane) => ({x: position.x - pane.offset.x, y: position.y - pane.offset.y});
  return {
    box,
    resizePart,
    inProgress:()=>!!gesture.current,
    hideResizeHandles() { setResizePart(undefined); },
    cancel() { gesture.current = undefined; props.preview(undefined); setBox(undefined); setResizePart(undefined); },
    contextMenu(event: MouseEvent<SVGSVGElement>) {
      event.preventDefault();
      event.stopPropagation();
      if (gesture.current) return;
      const hit = plotHit(event.target), pane = hit.part === 'inset' ? props.inset : props.main, at = point(event);
      if (pane && at) props.inspect(hit, props.location(event), local(at, pane));
    },
    start(event: PointerEvent<SVGSVGElement>) {
      if (gesture.current || !props.main || event.button !== 0 && event.button !== 1) return;
      const middle = event.button === 1;
      const target = plotHit(event.target), hit: PlotHit = middle ? {...target, part: 'main'} : target;
      const pane = hit.part === 'inset' ? props.inset : props.main, at = point(event);
      if (!pane || !at) return;
      const inset = hit.part === 'inset';
      const start = local(at, pane), inside = insidePlot(start, pane.geometry);
      let kind: DragKind = 'pick';
      if (middle || inset) event.preventDefault();
      if (middle) kind = 'shift';
      else if (!inset && props.makeInset && inside) kind = 'make-inset';
      else if (inset || !props.selectingZero) {
        switch (hit.kind) {
          case 'paper': case 'point': case 'line':
            if (inset) kind = 'inset-shift';
            else if (inside) kind = 'zoom';
            break;
          case 'legend': case 'text': if (hit.key !== 'ticks') kind = 'text'; break;
          case 'guide': case 'tick': kind = 'guide'; break;
          case 'resize': kind = inset ? 'inset-resize' : 'resize'; break;
        }
      }
      const {context} = pane;
      const guide = hit.kind === 'guide' ? context.guides.find(item => item.id === hit.key)
        : hit.kind === 'tick' ? {id: crypto.randomUUID?.() ?? 'guide-'+Date.now()+'-'+Math.random(), axis: hit.axis, value: 0} : undefined;
      const legend = legendHit(hit);
      const note = hit.key.startsWith('guide:') ? context.guides.find(item => item.id === hit.key.slice(6))?.label : context.pane.text?.[legend ? 'legend' : hit.key];
      const inkTarget = kind === 'text' ? (event.target as Element).closest(legend ? '[data-plot-series-legend]' : '[data-plot-hit="text"]') : undefined;
      const inkNodes = kind === 'shift' || kind==='inset-shift'
        ? [...event.currentTarget.querySelectorAll(kind === 'shift' ? 'text, [data-plot-series-legend]'
          : '[data-plot-part="inset"] :is(text, [data-plot-series-legend])')]
            .filter(node=>!node.closest('[clip-path]'))
        : inkTarget ? [inkTarget] : [];
      gesture.current = {id: event.pointerId, start, hit, pane, outer: props.main.geometry, original: props.figure, kind,
        note, guide, middle,
        ink: plotInkBounds(event.currentTarget, inkNodes, pane.offset)};
      props.hover({...hit, kind: 'paper'}, props.location(event));
      event.currentTarget.focus({preventScroll: true});
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    move(event: PointerEvent<SVGSVGElement>) {
      const active = gesture.current;
      if (!active) {
        if (!event.buttons) {
          const hit = plotHit(event.target), pane = hit.part === 'inset' ? props.inset : props.main;
          const position = (hit.kind === 'point' || hit.kind==='paper' && !!pane?.nearest) && pane ? point(event) : null;
          props.hover(hit, props.location(event), position && pane ? local(position, pane) : undefined);
        }
        return;
      }
      if (active.id !== event.pointerId) return;
      const at = point(event); if (!at) return;
      const end = local(at, active.pane);
      if (Math.hypot(end.x - active.start.x, end.y - active.start.y) < 4) {
        props.preview(undefined); setBox(undefined); return;
      }
      active.dragged = true;
      if (active.kind === 'make-inset' || active.kind === 'zoom') {
        setBox({start: {x: active.start.x + active.pane.offset.x, y: active.start.y + active.pane.offset.y}, end: at});
      } else if (active.kind !== 'pick') {
        props.preview(dragValue(active, end));
      }
    },
    finish(event: PointerEvent<SVGSVGElement>, cancelled = false) {
      const active = gesture.current;
      if (!active || active.id !== event.pointerId) return;
      gesture.current = undefined; props.preview(undefined); setBox(undefined);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      const at = !cancelled && point(event);
      if (!at) return;
      const end = local(at, active.pane);
      const moved = Math.hypot(end.x - active.start.x, end.y - active.start.y) >= 4;
      if (!moved) {
        if (active.middle || active.dragged) return;
        const hit = active.hit.kind === 'resize' && active.hit.key === 'w'
          ? {...active.hit, kind:'axis', axis:'y' as const} : active.hit;
        if (isPlotAxisHit(hit)) setResizePart(hit.part);
        props.select(hit, end);
        return;
      }
      if (active.kind === 'guide' && active.hit.kind === 'tick' && !insidePlot(end, active.pane.geometry)) return;
      const next = dragValue(active, end);
      if (next) { props.commit(next); return; }
      if (active.kind === 'zoom' || active.kind === 'make-inset') {
        const view = zoomPlotViewport(active.pane.context.range, active.start, end, active.pane.geometry, props.reverseX, props.reverseY);
        if (view) props.zoom(view, active.hit.part, active.kind === 'make-inset');
      }
    },
  };
}
