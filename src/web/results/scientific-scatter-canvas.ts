import { scatterPointValid, scatterScreenPoint, type ScientificScatterData, type ScatterPlotBounds } from '../../results/scatter-data';
import type { ScientificPlotViewport } from '../../results/scientific-plot';

/** Every valid in-view point is painted in source order. Batching changes scheduling, not data. */
export function paintScatterBatch(context: Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'beginPath' | 'rect' | 'clip' | 'arc' | 'fill' | 'fillStyle' | 'globalAlpha'>,
  data: ScientificScatterData, viewport: ScientificPlotViewport, bounds: ScatterPlotBounds, colorForX: (x: number) => string,
  pointSize: number, opacity: number, start = 0, end = data.x.length, colorForPoint?: (index: number, x: number, y: number) => string): number {
  let count = 0;
  context.save(); context.beginPath(); context.rect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top); context.clip();
  context.globalAlpha = opacity;
  try {
    for (let i = start; i < Math.min(end, data.x.length); i++) {
      if (!scatterPointValid(data, i)) continue;
      const x = data.x[i], y = data.y[i];
      if (x < viewport.x[0] || x > viewport.x[1] || y < viewport.y[0] || y > viewport.y[1]) continue;
      const p = scatterScreenPoint(x, y, viewport, bounds);
      context.fillStyle = colorForPoint?.(i, x, y) ?? colorForX(x); context.beginPath(); context.arc(p.x, p.y, pointSize / 2, 0, Math.PI * 2); context.fill(); count++;
    }
  } finally { context.restore(); }
  return count;
}

/** Bounded vector export only; nodes are created in the exporting document, never on screen. */
export function appendScatterVectorPoints(parent: SVGElement, data: ScientificScatterData, viewport: ScientificPlotViewport,
  bounds: ScatterPlotBounds, colorForX: (x: number) => string, pointSize: number, opacity: number, colorForPoint?: (index: number, x: number, y: number) => string): number {
  let count = 0;
  for (let i = 0; i < data.x.length; i++) {
    if (!scatterPointValid(data, i) || data.x[i] < viewport.x[0] || data.x[i] > viewport.x[1] || data.y[i] < viewport.y[0] || data.y[i] > viewport.y[1]) continue;
    const p = scatterScreenPoint(data.x[i], data.y[i], viewport, bounds), point = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [name, value] of Object.entries({ cx: p.x, cy: p.y, r: pointSize / 2, fill: colorForPoint?.(i, data.x[i], data.y[i]) ?? colorForX(data.x[i]), opacity })) point.setAttribute(name, String(value));
    parent.appendChild(point); count++;
  }
  return count;
}
