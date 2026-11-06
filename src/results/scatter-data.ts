import { formatResultValue, fullPrecisionValue } from './numeric-format';
import type { ScientificPlotViewport } from './scientific-plot';

/** Paired source columns. A supplied domain mask is explicit, never inferred from zeros. */
export interface ScientificScatterData { x: ArrayLike<number>; y: ArrayLike<number>; valid?: ArrayLike<number> }
export interface ScientificScatterPoint { index: number; x: number; y: number }
export interface ScatterPlotBounds { left: number; right: number; top: number; bottom: number }

export function scatterDataSummary(data: ScientificScatterData): {
  count: number; excluded: number; nonfinite: number; viewport: ScientificPlotViewport | null;
} {
  if (!Number.isSafeInteger(data.x.length) || data.x.length < 0 || data.x.length !== data.y.length || data.valid && data.valid.length !== data.x.length)
    throw new Error('散点 X/Y 与有效域必须逐点配对。');
  let count = 0, excluded = 0, nonfinite = 0, xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < data.x.length; i++) {
    if (data.valid && data.valid[i] !== 0 && data.valid[i] !== 1) throw new Error('散点有效域必须为明确的 0/1 掩码。');
    const x = data.x[i], y = data.y[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`散点第 ${i + 1} 行 X/Y 必须是有限数值。`);
    if (data.valid?.[i] === 0) { excluded++; continue; }
    count++; xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
  }
  const pad = (low: number, high: number): [number, number] => {
    const amount = high === low ? Math.max(Math.abs(low) * .01, 1e-6) : (high - low) * .03;
    return [low - amount, high + amount];
  };
  return { count, excluded, nonfinite, viewport: count ? { x: pad(xmin, xmax), y: pad(ymin, ymax) } : null };
}

export function scatterPointValid(data: ScientificScatterData, index: number): boolean {
  return data.valid?.[index] !== 0 && Number.isFinite(data.x[index]) && Number.isFinite(data.y[index]);
}
export function scatterScreenPoint(x: number, y: number, viewport: ScientificPlotViewport, bounds: ScatterPlotBounds): { x: number; y: number } {
  return { x: bounds.left + (x - viewport.x[0]) / (viewport.x[1] - viewport.x[0]) * (bounds.right - bounds.left),
    y: bounds.bottom - (y - viewport.y[0]) / (viewport.y[1] - viewport.y[0]) * (bounds.bottom - bounds.top) };
}
/** Exact source values and deterministic source-order ties; no model-selection semantics. */
export function nearestScatterPoint(data: ScientificScatterData, position: { x: number; y: number }, viewport: ScientificPlotViewport,
  bounds: ScatterPlotBounds, radius = 8): ScientificScatterPoint | null {
  let chosen: ScientificScatterPoint | null = null, distance = radius * radius;
  for (let i = 0; i < data.x.length; i++) {
    if (!scatterPointValid(data, i)) continue;
    const x = data.x[i], y = data.y[i];
    if (x < viewport.x[0] || x > viewport.x[1] || y < viewport.y[0] || y > viewport.y[1]) continue;
    const p = scatterScreenPoint(x, y, viewport, bounds), next = (p.x - position.x) ** 2 + (p.y - position.y) ** 2;
    if (next <= distance && (chosen === null || next < distance)) { distance = next; chosen = { index: i, x, y }; }
  }
  return chosen;
}

/** All valid paired source rows, regardless of the current display viewport. */
export function scatterDataText(data: ScientificScatterData, labels: { x: string; y: string }, decimals: number | 'raw' = 2): string {
  scatterDataSummary(data);
  const format = decimals === 'raw' ? fullPrecisionValue : (value: number) => formatResultValue(value, decimals);
  const lines = [`${labels.x.replace(/[\r\n\t]/g, ' ')}\t${labels.y.replace(/[\r\n\t]/g, ' ')}`];
  for (let i = 0; i < data.x.length; i++) if (scatterPointValid(data, i)) lines.push(`${format(data.x[i])}\t${format(data.y[i])}`);
  return lines.join('\n') + '\n';
}
