import { scientificLinePresets, type ScientificLinePresetId } from './scientific-line-presets';
import { plotTicks, type ScientificPlotViewport } from './scientific-plot';
import type {ScatterColorScaleValue, ScatterScaleAppearance} from './scientific-scatter-scale';
import type {ResultQuantity} from './contracts';
import type {EnergyReference, EnergyUnit} from './energy';

export type PlotFamily = 'line' | 'spectrum' | 'histogram' | 'scatter' | 'fingerprint' | 'orbital' | 'contact';
export type PlotAxis = 'x' | 'y';
export type PlotDash = 'solid' | 'dash' | 'dot' | 'dash-dot';
export type PlotMarker = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross';
export type PlotFontRole = 'title' | 'x' | 'y' | 'ticks' | 'legend' | 'annotation';
export type PlotPosition = { x: number; y: number };
export type PlotFrameOffsets = { left: number; right: number; top: number; bottom: number };
export type PlotAffine = { scale: number; offset?: number };
export type PlotAxisTransforms = Partial<Record<PlotAxis, PlotAffine>>;

export const plotFonts = ['Arial', 'Calibri', 'Helvetica', 'Times New Roman', 'Cambria', 'DejaVu Sans'] as const;

export interface PlotFontStyle {
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
}

export interface PlotNote {
  content?: string;
  position?: PlotPosition;
  font?: Partial<PlotFontStyle>;
  hidden?: boolean;
}

export interface PlotStroke {
  color: string;
  width: number;
  dash: PlotDash;
}

export interface PlotPointStyle {
  marker: PlotMarker;
  size: number;
  hollow: boolean;
  edgeColor: string;
  fillColor: string;
  edgeWidth: number;
  fillOverride?: boolean;
  edgeOverride?: boolean;
}

export interface PlotSeriesStyle extends PlotStroke {
  hidden: boolean;
  points: boolean;
  fill: 'none' | 'solid' | 'gradient';
  opacity: number;
  barFillColor?: string;
  barGradient?: { base: string };
  point: PlotPointStyle;
}

export const histogramGradientBase = '#ebf4ef';

export interface PlotStyle {
  line: PlotSeriesStyle;
  stickColor?: string;
  axis: {
    color: string; width: number; frame: 'full' | 'axes'; ticks: 'in' | 'out';
    density: 'sparse' | 'standard' | 'dense'; xMinor: number; yMinor: number;
    tickSides?: Partial<Record<PlotTickSide, PlotSideTicks>>;
    tickNumbers?: Partial<Record<PlotAxis, 'auto' | 'integer'>>;
  };
  fonts: Record<PlotFontRole, PlotFontStyle>;
  canvas: { width: number; height: number; locked: boolean };
  frame: PlotFrameOffsets;
  guide: PlotStroke;
  showZero: boolean;
  showLegend: boolean;
  showAnnotation: boolean;
  scatterColors?: readonly string[];
  contactColors?: readonly string[];
  scatterOpacity?: number;
  scatterScaleStyle?: ScatterScaleAppearance;
}

export type PlotTickSide = 'left' | 'bottom' | 'right' | 'top';
export type PlotTickDirection = 'off' | 'in' | 'out' | 'both';
export interface PlotSideTicks { direction: PlotTickDirection; labels: boolean }
export function plotSideTicks(style:PlotStyle['axis'],side:PlotTickSide,hasRightAxis=false):PlotSideTicks {
  return style.tickSides?.[side] ?? (side==='left'||side==='bottom'||side==='right'&&hasRightAxis
    ? {direction:style.ticks,labels:true} : {direction:'off',labels:false});
}

export interface PlotGuide {
  id: string;
  axis: PlotAxis;
  /** Source-coordinate value, except for the built-in relative origin. */
  value: number;
  followsZero?: boolean;
  stroke?: Partial<PlotStroke>;
  label?: PlotNote;
}

export interface PlotAxisSettings {
  bounds?: [number, number];
  step?: number;
}

export interface PlotAxisEdits {
  x?: PlotAxisSettings;
  y?: PlotAxisSettings;
  guides?: PlotGuide[];
}

export interface PlotPaneEdits {
  presetId?: string;
  style?: PlotStyle;
  frame?: PlotFrameOffsets;
  /** Translation of the plotted objects in normalized paper coordinates. */
  position?: PlotPosition;
  /** Each independent horizontal variable has its own ranges and reference lines. */
  coordinates?: Record<string, PlotAxisEdits>;
  text?: Record<string, PlotNote>;
  series?: Record<string, PlotSeriesStyle>;
  points?: Record<string, PlotPointStyle>;
  showLegend?: boolean;
  showZero?: boolean;
  scatterScale?: Partial<Omit<ScatterColorScaleValue, 'title'>>;
  zoom?: {scope?: string | number; range: ScientificPlotViewport | null; back: (ScientificPlotViewport | null)[]};
}

export interface PlotInsetBox { x: number; y: number; width: number; height: number }
export interface PlotSpectrumSettings { fwhm: number; peakShape: 'gaussian' | 'lorentzian'; normalize: boolean }
export interface PlotInset extends PlotPaneEdits {
  box: PlotInsetBox;
  unit?: string;
  spectrum?: PlotSpectrumSettings;
}
export type PlotScfZero = 'original' | 'first' | 'last' | { sourceLine?: number; iteration: number; index: number };
export interface OptimizationEnergyDisplay {
  unit: EnergyUnit;
  relative: boolean;
  reference: EnergyReference;
  zeroPoint?: { frameId: string | number; overlay?: { seriesId: string; energy: ResultQuantity; frameNumber?: number } };
}
export type PlotSpectrumDisplay = 'envelope' | 'sticks' | 'both';
export interface PlotSpectrumViewEdits {
  /** Null is an explicitly cleared FWHM on the unbroadened Raman view. */
  fwhm?: number | null;
  peakShape?: PlotSpectrumSettings['peakShape'] | '';
  normalize?: boolean;
  display?: PlotSpectrumDisplay;
  axis?: 'eV' | 'nm';
  intensityUnit?: string;
  reverseX?: boolean;
  reverseY?: boolean;
  sampling?: PlotSpectrumSampling;
  range?: { axis: string; value: [number, number] } | null;
}
export type PlotSpectrumSampling = {kind:'count'|'step';value:number};
export interface PlotScreenSize { dimensions: {width: number; height: number} | null; lockedRatio: number | null }
export interface PlotFigureEdits extends PlotPaneEdits {
  conformer?: {clusterIds?: string[]};
  inset?: PlotInset;
  scf?: {unit?: EnergyUnit; zero?: PlotScfZero};
  energy?: OptimizationEnergyDisplay;
  histogram?: {unit?: string; quantity?: 'area' | 'fraction'; smooth?: boolean; showBins?: boolean};
  spectrum?: PlotSpectrumViewEdits;
  screenSize?: PlotScreenSize;
  scatterShowAll?: boolean;
}

function fontStyle(size: number): PlotFontStyle {
  return { font: 'Arial', size, bold: false, italic: false };
}

export function builtinPlotStyle(family: PlotFamily, id: ScientificLinePresetId = 'hollow'): PlotStyle {
  const sample = scientificLinePresets[id], spectrum = family === 'spectrum';
  const color = spectrum ? '#5f8caf' : sample.color;
  return {
    line: {
      color, width: spectrum ? 1.7 : sample.lineWidth, dash: 'solid', hidden: false,
      points: !spectrum, fill: spectrum ? 'solid' : 'none', opacity: .16,
      point: { marker: 'circle', size: sample.markerSize, hollow: sample.hollow, edgeColor: color, fillColor: color, edgeWidth: sample.markerBorder },
    },
    axis: { color: sample.axisColor, width: sample.axisWidth, frame: 'full', ticks: 'in', density: 'standard', xMinor: 0, yMinor: 0 },
    fonts: {
      title: fontStyle(8), x: fontStyle(7), y: fontStyle(7),
      ticks: fontStyle(6), legend: fontStyle(6), annotation: fontStyle(9),
    },
    canvas: { width: sample.pageWidthMm, height: sample.pageWidthMm, locked: false },
    frame: { left: 0, right: 0, top: 0, bottom: 0 }, guide: { color: sample.referenceColor, width: sample.referenceWidth, dash: 'solid' },
    showLegend: false, showZero: !spectrum && sample.showZero, showAnnotation: !spectrum && sample.showSelectedLabel,
  };
}

export const builtinPlotPresets = (family: PlotFamily) => {
  switch (family) {
    case 'line': return [{id:'hollow',label:'空心'}, {id:'solid',label:'实心'}];
    case 'spectrum': return [{id:'hollow',label:'谱图'}, {id:'trace',label:'纯曲线'}];
    case 'histogram': return [{id:'filled',label:'实色柱'}, {id:'gradient',label:'单色渐变'}];
    case 'scatter': return [{id:'source',label:'ES 原配色'}];
    case 'fingerprint': return [{id:'gallery',label:'图库蓝青绿'}, {id:'mist',label:'雾蓝密度'}, {id:'warm',label:'黄橙红密度'}];
    case 'orbital': case 'contact': return [{id:'source',label:'ES 默认'}];
  }
};

export function plotStyleForPreset(family: PlotFamily, id?: string): PlotStyle {
  const style = builtinPlotStyle(family, id === 'solid' ? 'solid' : 'hollow');
  if (family === 'spectrum' && id === 'trace') style.line.fill = 'none';
  if (family === 'histogram') {
    style.line = {...style.line, points:false, width:.55, fill:id==='outline'?'none':'solid',
      opacity:.68, color:'#187457', barFillColor:style.line.color};
    style.showZero = false;
    style.showAnnotation = false;
    if (id==='gradient') style.line={...style.line, fill:'gradient', opacity:1, barGradient:{base:histogramGradientBase}};
  }
  if (family === 'scatter' || family === 'fingerprint') {
    style.showLegend = true;
    style.showZero = false;
    style.showAnnotation = false;
    style.line.point = {...style.line.point, size:1.5, hollow:false, edgeWidth:0};
    if (family === 'fingerprint') {
      style.scatterColors = id === 'mist' ? ['#bfd7ea','#8cb3d9','#5b7fb9']
        : id === 'warm' ? ['#ffffcc','#fed976','#fd8d3c','#e31a1c','#800026']
          : ['#0000ff','#004cff','#00aaff','#00e5ee','#00e86b'];
    }
  }
  if (family === 'orbital' || family === 'contact') {
    style.line.points = false;
    style.showZero = false;
    style.showAnnotation = false;
  }
  return style;
}

export function displayPlotValue(value: number, affine?: PlotAffine) {
  return affine ? value * affine.scale + (affine.offset ?? 0) : value;
}

export function sourcePlotValue(value: number, affine?: PlotAffine) {
  return affine ? (value - (affine.offset ?? 0)) / affine.scale : value;
}

export function plotCoordinateRange(range: [number, number], convert: (value: number) => number): [number, number] {
  const a = convert(range[0]), b = convert(range[1]);
  return a < b ? [a, b] : [b, a];
}

export function plotAxisRange(settings: PlotAxisSettings | undefined, base: [number, number], affine?: PlotAffine): [number, number] {
  if (!settings?.bounds) return base;
  const bounds = plotCoordinateRange(settings.bounds, value => displayPlotValue(value, affine));
  return bounds.every(Number.isFinite) && bounds[0] < bounds[1] ? bounds : base;
}

export function plotEditedViewport(base: ScientificPlotViewport, edits: PlotAxisEdits | undefined, transforms?: PlotAxisTransforms): ScientificPlotViewport {
  return { x: plotAxisRange(edits?.x, base.x, transforms?.x), y: plotAxisRange(edits?.y, base.y, transforms?.y) };
}

export function editedPlotTicks(range: [number, number], pixels: number, style: PlotStyle['axis'], axis: PlotAxis, step?: number, minSpacing?:number) {
  const spacing = minSpacing === undefined
    ? style.density === 'dense' ? 42 : style.density === 'sparse' ? 100 : axis === 'x' ? 72 : 48
    : minSpacing * (style.density==='dense'?.8:style.density==='sparse'?1.5:1);
  const spaced = plotTicks(range, pixels, spacing);
  const automatic = !step && spaced.major.length < 3 && style.density !== 'sparse'
    ? plotTicks(range, pixels, spacing * .72) : spaced;
  if (!automatic.step) return automatic;
  const [lo, hi] = range;
  const whole = style.tickNumbers?.[axis] === 'integer';
  const preferred = step && step > 0 ? step : automatic.step;
  const natural = whole ? Math.max(1,Math.ceil(preferred)) : preferred;
  // In a compact pane a manual interval controls the marks. The drawing can thin their labels independently.
  const markSpacing = step && minSpacing !== undefined ? Math.max(1.5, style.width * 2) : 15;
  const visibleIntervals = Math.max(2, Math.floor(pixels / markSpacing));
  const majorStep = natural * Math.max(1, Math.ceil((hi - lo) / natural / visibleIntervals));
  const divisions = 1 + Math.max(0, Math.min(12, axis === 'x' ? style.xMinor : style.yMinor));
  const interval = majorStep / divisions;
  const start = Math.ceil(lo / interval - 1e-7), end = Math.floor(hi / interval + 1e-7);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return automatic;
  const major: number[] = [], minor: number[] = [];
  for (let ordinal = start; ordinal <= end; ordinal++) {
    const value = Number((ordinal * interval).toPrecision(14));
    (ordinal % divisions ? minor : major).push(Object.is(value, -0) ? 0 : value);
  }
  return { major: whole || major.length >= 2 || step && major.length ? major : [lo, hi], minor, step: majorStep };
}

export function plotDashArray(dash: PlotDash, width: number): string | undefined {
  switch (dash) {
    case 'dash': return `${width * 4} ${width * 2.4}`;
    case 'dot': return `${width * .9} ${width * 2.1}`;
    case 'dash-dot': return `${width * 4} ${width * 2} ${width} ${width * 2}`;
  }
}

export function plotPointKey(series: string, index: number) {
  return JSON.stringify([series, index]);
}

export function inheritedPlotFont(figure: PlotPaneEdits, style: PlotStyle, guides: readonly PlotGuide[], preferGuides = false): PlotFontStyle {
  const annotation = style.fonts.annotation;
  const labels = preferGuides ? guides.flatMap(guide => guide.label?.content ? [{ ...annotation, ...guide.label.font }] : []) : [];
  const notes = Object.entries(figure.text ?? {}).flatMap(([id, note]) =>
    id.startsWith('note:') && note.content ? [{ ...annotation, ...note.font }] : []);
  const population = labels.length ? labels : notes.length ? notes : (Object.entries(style.fonts) as [PlotFontRole, PlotFontStyle][])
    .filter(([role]) => !figure.text?.[role]?.hidden && (role !== 'legend' || (figure.showLegend ?? style.showLegend))
      && (role !== 'annotation' || style.showAnnotation))
    .map(([role, font]) => ({ ...font, ...figure.text?.[role]?.font }));
  if (!population.length) return annotation;
  const sizes = population.map(font => font.size).sort((a, b) => a - b);
  const median = (sizes[Math.floor((sizes.length - 1) / 2)] + sizes[Math.floor(sizes.length / 2)]) / 2;
  const counts = new Map<string, number>();
  for (const font of population) counts.set(font.font, 1 + (counts.get(font.font) ?? 0));
  const closest = [...population].sort((a, b) => counts.get(b.font)! - counts.get(a.font)! || Math.abs(a.size - median) - Math.abs(b.size - median))[0];
  return { ...closest, size: median, bold: false, italic: false };
}

export function boundedInsetBox(box: PlotInsetBox, minimum={width:.2,height:.2}): PlotInsetBox {
  const width=Math.min(1,Math.max(minimum.width,box.width)), height=Math.min(1,Math.max(minimum.height,box.height));
  return {width,height,x:Math.max(0,Math.min(1-width,box.x)),y:Math.max(0,Math.min(1-height,box.y))};
}

export function spectrumStickColor(style:PlotStyle,pane:PlotPaneEdits){
  return style.stickColor??pane.series?.spectrum?.color??style.line.color;
}
