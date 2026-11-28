import { normalizeResultNumberFormat, type ResultNumberFormat } from '../../results/numeric-format';

export const ANALYSIS_COLORBAR_FONTS = {
  system: { label: '系统默认', css: 'system-ui, "Microsoft YaHei", sans-serif' },
  arial: { label: 'Arial', css: 'Arial, sans-serif' },
  serif: { label: 'Times New Roman', css: '"Times New Roman", serif' },
} as const;

export type AnalysisColorbarFont = keyof typeof ANALYSIS_COLORBAR_FONTS;
export type AnalysisColorbarOrientation = 'horizontal' | 'vertical';

/** Position is the normalized centre. Length is relative to the active axis. */
export interface AnalysisColorbarLayout {
  x: number;
  y: number;
  length: number;
  orientation?: AnalysisColorbarOrientation;
  thickness?: number;
  fontFamily?: AnalysisColorbarFont;
  fontSize?: number;
  ink?: string;
  numberFormat?: ResultNumberFormat;
}
type NormalizedColorbarLayout = Required<Omit<AnalysisColorbarLayout, 'numberFormat'>> & Pick<AnalysisColorbarLayout, 'numberFormat'>;
export const ANALYSIS_COLORBAR_LIMITS = {
  length: { min: .12, max: .9 },
  thickness: { min: 4, max: 40 },
  fontSize: { min: 8, max: 32 },
};

export const DEFAULT_ANALYSIS_COLORBAR_LAYOUT: Readonly<NormalizedColorbarLayout> = Object.freeze({
  x: .82, y: .9, length: .22, orientation: 'horizontal', thickness: 10, fontFamily: 'arial', fontSize: 12, ink: '#000000',
});

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;

export function normalizeAnalysisColorbarLayout(layout?: Partial<AnalysisColorbarLayout> | null): NormalizedColorbarLayout {
  const base = DEFAULT_ANALYSIS_COLORBAR_LAYOUT;
  const { length, thickness, fontSize } = ANALYSIS_COLORBAR_LIMITS;
  const numberFormat = normalizeResultNumberFormat(layout?.numberFormat);
  return {
    ...(numberFormat && { numberFormat }),
    x: bounded(layout?.x, base.x, 0, 1),
    y: bounded(layout?.y, base.y, 0, 1),
    length: bounded(layout?.length, base.length, length.min, length.max),
    orientation: layout?.orientation === 'vertical' ? 'vertical' : base.orientation,
    thickness: bounded(layout?.thickness, base.thickness, thickness.min, thickness.max),
    fontFamily: layout?.fontFamily && Object.hasOwn(ANALYSIS_COLORBAR_FONTS, layout.fontFamily) ? layout.fontFamily : base.fontFamily,
    fontSize: bounded(layout?.fontSize, base.fontSize, fontSize.min, fontSize.max),
    ink: typeof layout?.ink === 'string' && /^#[0-9a-f]{6}$/i.test(layout.ink) ? layout.ink : base.ink,
  };
}

export interface AnalysisColorbarSize { width: number; height: number }
interface Box { x: number; y: number; width: number; height: number }
interface LegendText { text: string; x: number; baseline: number; anchor: 'start' | 'end' }
export interface AnalysisColorbarRect {
  left: number;
  top: number;
  width: number;
  height: number;
  padding: number;
  fontSize: number;
  lineHeight: number;
  labelLines: string[];
  labelHeight: number;
  gradient: Box;
  text: LegendText[];
  orientation: AnalysisColorbarOrientation;
  fontFamily: string;
  ink: string;
}

export const FALLBACK_COLORBAR_VIEWPORT: Readonly<AnalysisColorbarSize> = { width: 800, height: 600 };

// Detached analysis controls are rendered into another document by the same
// React owner. Keep the viewport lookup tied to that field and release it on unmount.
const colorbarViewports = new Map<string, Set<HTMLElement>>();

export function registerAnalysisColorbarViewport(sourceKey: string, viewport: HTMLElement): () => void {
  const own = colorbarViewports.get(sourceKey) ?? new Set<HTMLElement>();
  own.add(viewport);
  colorbarViewports.set(sourceKey, own);
  return () => {
    own.delete(viewport);
    if (!own.size && colorbarViewports.get(sourceKey) === own) colorbarViewports.delete(sourceKey);
  };
}

export function displayedColorbarViewport(sourceKey: string | undefined, doc: Document): AnalysisColorbarSize | undefined {
  if (!sourceKey) return;
  const candidates = [...(colorbarViewports.get(sourceKey) ?? [])].filter(viewport => viewport.isConnected).map(viewport => {
    const { width, height } = viewport.getBoundingClientRect();
    return { doc: viewport.ownerDocument, width, height };
  }).filter(({ width, height }) => width > 0 && height > 0);
  const local = candidates.filter(candidate => candidate.doc === doc);
  const match = local.length === 1 ? local[0] : candidates.length === 1 ? candidates[0] : undefined;
  return match && { width: match.width, height: match.height };
}

function labelLines(label: string, available: number, fontSize: number): string[] {
  const lines: string[] = [];
  let line = '', used = 0;
  for (const char of label) {
    if (char === '\n') { lines.push(line); line = ''; used = 0; continue; }
    const size = fontSize * (char.charCodeAt(0) > 255 ? 1 : .6);
    if (line && used + size > available) { lines.push(line); line = ''; used = 0; }
    line += char;
    used += size;
  }
  lines.push(line);
  return lines;
}

/** Local coordinates for SVG, the live overlay, and the figure canvas. */
export function resolveAnalysisColorbarRect(layout: AnalysisColorbarLayout | undefined, size: AnalysisColorbarSize, label: string,
  scale = 1, values: readonly [string, string] = ['', '']): AnalysisColorbarRect {
  if (![size.width, size.height, scale].every(value => Number.isFinite(value) && value > 0))
    throw new Error('色标视口尺寸必须为正有限值。');

  const normalized = normalizeAnalysisColorbarLayout(layout);
  const vertical = normalized.orientation === 'vertical';
  const margin = Math.min(8 * scale, size.width / 8, size.height / 8);
  const padding = Math.min(8 * scale, size.width / 8);
  const gap = 4 * scale, fontSize = normalized.fontSize * scale, lineHeight = fontSize * 4 / 3;
  const maxWidth = size.width - 2 * margin;
  const thickness = Math.min(normalized.thickness * scale, vertical ? maxWidth - 2 * padding : size.height - 2 * margin);
  const valueWidths = values.map(value => value.length * fontSize * .6);
  const valueWidth = Math.max(...valueWidths);
  const captionWidth = Array.from(label).reduce((width, char) => width + fontSize * (char.charCodeAt(0) > 255 ? 1 : .6), 0);
  const width = vertical
    ? Math.min(maxWidth, Math.max(thickness + gap + valueWidth, Math.min(14 * fontSize, captionWidth)) + 2 * padding)
    : Math.min(maxWidth, Math.max((valueWidth + 2 * padding), normalized.length * size.width));
  const lines = labelLines(label, Math.max(fontSize, width - 2 * padding), fontSize);
  const labelHeight = lines.length * lineHeight;
  const barTop = padding + labelHeight + gap;
  const gradient: Box = vertical
    ? { x: padding, y: barTop, width: thickness, height: Math.max(lineHeight * 2, Math.min(size.height - 2 * margin - barTop - padding, normalized.length * size.height)) }
    : { x: padding, y: barTop, width: width - 2 * padding, height: thickness };
  const labelText: LegendText[] = lines.map((text, index) => ({ text, x: padding, baseline: padding + index * lineHeight + fontSize, anchor: 'start' }));
  const stackValues = !vertical && valueWidths[0] + valueWidths[1] + 2 * gap > gradient.width;
  const valuesTop = barTop + gradient.height + gap;
  const valueX = gradient.x + gradient.width + gap;
  const text: LegendText[] = vertical
    ? [...labelText, { text: values[0], x: valueX, baseline: barTop + gradient.height - lineHeight + fontSize, anchor: 'start' },
      { text: values[1], x: valueX, baseline: barTop + fontSize, anchor: 'start' }]
    : [...labelText, { text: values[0], x: padding, baseline: valuesTop + fontSize, anchor: 'start' },
      { text: values[1], x: width - padding, baseline: valuesTop + (stackValues ? lineHeight : 0) + fontSize, anchor: 'end' }];
  const height = (vertical ? barTop + gradient.height : valuesTop + (stackValues ? 2 : 1) * lineHeight) + padding;
  const left = clamp(normalized.x * size.width - width / 2, margin, size.width - width - margin);
  const top = clamp(normalized.y * size.height - height / 2, margin, size.height - height - margin);
  return { left, top, width, height, padding, fontSize, lineHeight, labelLines: lines, labelHeight, gradient, text,
    orientation: normalized.orientation, fontFamily: ANALYSIS_COLORBAR_FONTS[normalized.fontFamily].css, ink: normalized.ink };
}

export function moveAnalysisColorbarLayout(layout: AnalysisColorbarLayout, delta: { x: number; y: number }, size: AnalysisColorbarSize,
  bounds?: Pick<AnalysisColorbarRect, 'width' | 'height'>): AnalysisColorbarLayout {
  if (![delta.x, delta.y, size.width, size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0)
    throw new Error('色标拖动范围无效。');
  const normalized = normalizeAnalysisColorbarLayout(layout);
  const margin = Math.min(8, size.width / 8, size.height / 8);
  const halfX = Math.min(.5, ((bounds?.width ?? normalized.length * size.width) / 2 + margin) / size.width);
  const halfY = Math.min(.5, ((bounds?.height ?? 0) / 2 + margin) / size.height);
  return { ...normalized, x: clamp(normalized.x + delta.x / size.width, halfX, 1 - halfX),
    y: clamp(normalized.y + delta.y / size.height, halfY, 1 - halfY) };
}

export function resizeAnalysisColorbarLayout(layout: AnalysisColorbarLayout, delta: number, span: number, extra = 0): AnalysisColorbarLayout {
  if (![delta, span, extra].every(Number.isFinite) || span <= 0) throw new Error('色标长度范围无效。');
  const normalized = normalizeAnalysisColorbarLayout(layout), margin = Math.min(8, span / 8);
  const centre = normalized.orientation === 'vertical' ? normalized.y : normalized.x;
  const { min, max } = ANALYSIS_COLORBAR_LIMITS.length;
  const available = (2 * Math.min(centre * span - margin, (1 - centre) * span - margin) - extra) / span;
  return { ...normalized, length: clamp(normalized.length + 2 * delta / span, min, Math.max(min, Math.min(max, available))) };
}
