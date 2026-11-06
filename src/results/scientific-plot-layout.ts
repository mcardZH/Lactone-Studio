import { optimizationPlotLayout } from './optimization-plot-axis';

/** Display geometry only. A custom height reflows axes without scaling text. */
export function scientificPlotLayout(width: number, title: string, options: { height?: number; square?: boolean; footer?: number; subtitle?: boolean; yLabelWidth?: number } = {}) {
  const base = optimizationPlotLayout(true, Math.max(220, width), title);
  const left = Math.max(base.left, Math.min(options.yLabelWidth ?? 0, base.right - 80));
  const top = base.top + (options.subtitle ? 18 : 0), footer = 56 + (options.footer ?? 0);
  const initialHeight = top + (options.square ? base.right - left : 180) + footer;
  const height = Math.max(top + footer + 80, options.height ?? initialHeight);
  return { ...base, left, top, bottom: height - footer, height };
}

export type PlotResizeDirection = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export function resizedScientificPlot(size: { width: number; height: number }, dx: number, dy: number, direction: PlotResizeDirection) {
  return { width: Math.max(220, Math.round(size.width + (direction.includes('e') ? dx : direction.includes('w') ? -dx : 0))),
    height: Math.max(220, Math.round(size.height + (direction.includes('s') ? dy : direction.includes('n') ? -dy : 0))) };
}
