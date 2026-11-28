import type { ScientificScatterData } from '../../results/scatter-data';
import type { ScientificPlotViewport } from '../../results/scientific-plot';
import type { PlotPointStyle } from '../../results/scientific-plot-editing';
import type { ScatterPlotBounds } from '../../results/scatter-data';
import { appendScatterVectorPoints } from './scientific-scatter-canvas';
import { serializeOptimizationSvg } from './optimization-export';
let nextSnapshotId = 0;

/** An interrupted batch must reject even when its window is hidden and RAF pauses. */
export function waitForScatterFrame(win: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>, signals: readonly (AbortSignal | undefined)[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    const cleanup = () => { for (const signal of signals) signal?.removeEventListener('abort', abort); };
    const abort = () => { win.cancelAnimationFrame(frame); cleanup(); reject(new DOMException('散点快照已取消或过期。', 'AbortError')); };
    for (const signal of signals) signal?.addEventListener('abort', abort, { once: true });
    if (signals.some(signal => signal?.aborted)) { abort(); return; }
    frame = win.requestAnimationFrame(() => { cleanup(); resolve(); });
  });
}

/** Captures the actual axes/metadata and the complete current point layer. No download. */
export const SCATTER_PAPER_FILL = 'white';

export function scatterSvgSnapshot(source: SVGSVGElement, pixels: HTMLCanvasElement, options: {
  data: ScientificScatterData; range: ScientificPlotViewport; layout: ScatterPlotBounds & {width:number;height:number};
  colorForX(value: number): string; colorForPoint?(index: number, x: number, y: number): string;
  size: number; alpha: number; raster: boolean;
  appearance?(index: number): PlotPointStyle;
}): string {
  const { data, range, layout, colorForX, colorForPoint, size, alpha, raster } = options;
  const copy = source.cloneNode(true) as SVGSVGElement, doc = source.ownerDocument;
  const background = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('width', String(layout.width)); background.setAttribute('height', String(layout.height)); background.setAttribute('fill', SCATTER_PAPER_FILL);
  copy.insertBefore(background, copy.firstChild);
  if (!raster) {
    const clipId = `scatter-export-clip-${++nextSnapshotId}`;
    const points = doc.createElementNS('http://www.w3.org/2000/svg', 'g'); points.setAttribute('clip-path', `url(#${clipId})`);
    const defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs'), clip = doc.createElementNS('http://www.w3.org/2000/svg', 'clipPath'), area = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    clip.setAttribute('id', clipId);
    for (const [name, value] of Object.entries({ x: layout.left, y: layout.top, width: layout.right - layout.left, height: layout.bottom - layout.top })) area.setAttribute(name, String(value));
    clip.appendChild(area); defs.appendChild(clip); copy.insertBefore(defs, background.nextSibling);
    appendScatterVectorPoints(points, data, range, layout, colorForX, size, alpha, colorForPoint, options.appearance);
    copy.insertBefore(points, defs.nextSibling);
  } else {
    const png = pixels.toDataURL('image/png');
    if (!png.startsWith('data:image/png;base64,')) throw new Error('散点图点层 PNG 编码失败。');
    const image = doc.createElementNS('http://www.w3.org/2000/svg', 'image'); image.setAttribute('width', String(layout.width)); image.setAttribute('height', String(layout.height)); image.setAttribute('href', png);
    copy.insertBefore(image, background.nextSibling);
  }
  return serializeOptimizationSvg(copy);
}
