import NumericInput from '../NumericInput';
import {useProjectState} from '../../projects/ui-state';
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { normalizedPlotWidth } from '../../results/optimization-plot-axis';
import { resizedScientificPlot, type PlotResizeDirection } from '../../results/scientific-plot-layout';
import { usePlotFrameUpdate } from './scientific-plot-frame';

const directions: PlotResizeDirection[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];
const directionLabels = {n:'上边',e:'右边',s:'下边',w:'左边',ne:'右上角',nw:'左上角',se:'右下角',sw:'左下角'};
/** Retain the last nonzero dimensions while hidden. Every observer/listener belongs
 * to the stage's current document, including charts moved into another window. */
export function useScientificPlotSize(identity?:string|number) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const assign = useRef((stage: HTMLDivElement | null) => { stageRef.current = stage; setNode(stage); });
  const [width, setWidth] = useState(320), [custom, setCustom] = useProjectState<{ width: number; height: number } | null>('plot.dimensions',null,identity);
  const customRef = useRef(custom); customRef.current = custom;
  const [lockedRatio, setLockedRatio] = useProjectState<number | null>('plot.lockedRatio',null,identity);
  const commitSize = (next: { width: number; height: number }) => setCustom(previous => {
    const stage = stageRef.current;
    const unchanged = previous ? previous.width === next.width && previous.height === next.height
      : stage?.clientWidth === next.width && stage.clientHeight === next.height;
    return unchanged ? previous : next;
  });
  const resizeFrame = usePlotFrameUpdate(commitSize);
  const gesture = useRef<{ x: number; y: number; width: number; height: number; pointerId: number; direction: PlotResizeDirection } | null>(null);
  const owner = node?.ownerDocument;
  useEffect(() => {
    const stage = stageRef.current, doc = stage?.ownerDocument, win = doc?.defaultView;
    if (!stage || !doc || !win) return;
    const pane = stage.closest<HTMLElement>('.postprocess-plot-window')?.closest<HTMLElement>('.model-document-pane');
    let paneSize = pane && pane.clientWidth > 0 && pane.clientHeight > 0 ? { width: pane.clientWidth, height: pane.clientHeight } : null;
    const measure = () => {
      // A drag already owns explicit dimensions. Observing that same change must
      // not enqueue a second, unused automatic-width render for each frame.
      if (!customRef.current) setWidth(previous => normalizedPlotWidth(stage.clientWidth, previous));
      if (!pane || pane.clientWidth <= 0 || pane.clientHeight <= 0) return;
      const next = { width: pane.clientWidth, height: pane.clientHeight };
      if (paneSize && (paneSize.width !== next.width || paneSize.height !== next.height) && stage.clientWidth > 0 && stage.clientHeight > 0) {
        const deltaHeight = next.height - paneSize.height;
        const width = Math.max(220, Math.round(stage.parentElement?.clientWidth ?? stage.clientWidth));
        setCustom(previous => { const height = Math.max(220, Math.round((previous?.height ?? stage.clientHeight) + deltaHeight));
          const next = lockedRatio ? ratioDimensions(width, width / lockedRatio) : { width, height };
          return previous?.width === next.width && previous.height === next.height ? previous : next; });
      }
      paneSize = next;
    };
    measure();
    const observer = win.ResizeObserver ? new win.ResizeObserver(measure) : null;
    observer?.observe(stage); if (pane) observer?.observe(pane); win.addEventListener('resize', measure); win.addEventListener('pageshow', measure); doc.addEventListener('visibilitychange', measure);
    return () => { observer?.disconnect(); win.removeEventListener('resize', measure); win.removeEventListener('pageshow', measure); doc.removeEventListener('visibilitychange', measure); resizeFrame.cancel(); gesture.current = null; };
  }, [node, owner, lockedRatio]);
  const finish = (event: PointerEvent<HTMLSpanElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); resizeFrame.flush();
    gesture.current = null; event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const dimensions = (renderedHeight: number) => ({ width: custom?.width ?? width, height: renderedHeight });
  const setDimension = (axis: 'width' | 'height', value: number, fallbackHeight: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    const current = dimensions(fallbackHeight);
    if (Math.round(value) === current[axis]) return;
    resizeFrame.cancel(); commitSize(lockedRatio
      ? ratioDimensions(axis === 'width' ? value : value * lockedRatio, axis === 'height' ? value : value / lockedRatio)
      : { width: Math.max(220, Math.round(axis === 'width' ? value : current.width)), height: Math.max(220, Math.round(axis === 'height' ? value : current.height)) });
  };
  return { stageRef: assign.current, width: custom?.width ?? width, height: custom?.height,
    style: (height: number): CSSProperties => ({ width: custom ? custom.width : '100%', height }),
    reset() { resizeFrame.cancel(); setCustom(null); setLockedRatio(null); },
    controls: (height: number) => { const current = dimensions(height); return <span className="scientific-plot-size-controls" aria-label="图尺寸">
      <label>宽 / px<NumericInput aria-label="图宽"  min={220} step={1} value={current.width} onChange={event => setDimension('width', event.currentTarget.valueAsNumber, height)}/></label>
      <label>高 / px<NumericInput aria-label="图高"  min={220} step={1} value={current.height} onChange={event => setDimension('height', event.currentTarget.valueAsNumber, height)}/></label>
      <label>比例<output aria-label="图宽高比">{Number((current.width / current.height).toFixed(3))}</output></label>
      <label><input aria-label="锁定图比例" type="checkbox" checked={lockedRatio !== null} onChange={event => setLockedRatio(event.currentTarget.checked ? current.width / current.height : null)}/>锁定比例</label>
    </span>; },
    handles: directions.map(direction => <span key={direction} className="scientific-plot-resize" data-plot-resize={direction} aria-hidden="true" title={`拖动${directionLabels[direction]}调整图尺寸`} style={{ cursor: `${direction}-resize` }}
      onPointerDown={event => { if (event.button !== 0 || !stageRef.current) return; event.preventDefault(); event.stopPropagation(); const stage = stageRef.current;
        gesture.current = { x: event.clientX, y: event.clientY, width: stage.clientWidth, height: stage.clientHeight, pointerId: event.pointerId, direction }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={event => { const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return; event.preventDefault(); event.stopPropagation();
        const next = resizedScientificPlot(active, event.clientX - active.x, event.clientY - active.y, active.direction);
        const win = stageRef.current?.ownerDocument.defaultView;
        if (!lockedRatio) resizeFrame.schedule(next, win);
        else {
          const useHeight = active.direction === 'n' || active.direction === 's' || (active.direction.length === 2 && Math.abs(next.height / active.height - 1) > Math.abs(next.width / active.width - 1));
          resizeFrame.schedule(useHeight ? ratioDimensions(next.height * lockedRatio, next.height) : ratioDimensions(next.width, next.width / lockedRatio), win);
        } }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { resizeFrame.flush(); gesture.current = null; }}/>) };
}

function ratioDimensions(width: number, height: number) {
  const scale = Math.max(1, 220 / width, 220 / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
