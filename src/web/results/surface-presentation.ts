import type { Vector3 } from '../../core/types';
import { BOHR_TO_ANGSTROM } from '../../core/orca/assets';
import type { SurfaceAreaDistribution, SurfaceContext, SurfaceExtremum, SurfaceMetric, SurfaceRegionResult } from '../../results/surface-contracts';
import type { ScientificTableProjection } from './scientific-table';
import type { ScientificPlotPoint, ScientificPlotSeries } from './ScientificPlot';
import { DEFAULT_RESULT_DECIMALS, formatResultValue as number } from '../../results/numeric-format';

export const surfaceContextKey = (context: SurfaceContext) => JSON.stringify([context.sourceId, context.sourceRevision, context.jobIndex, context.sourceFrameIndex, context.generation, context.documentId, context.documentRevision]);
/** Display spelling only: no field-unit conversion or mutation of native receipts. */
export function surfaceDisplayUnit(unit: string | null): string {
  if (unit == null) return '未输出';
  const lengthPower = /^(?:angstrom|ångström|å)\s*(?:\^|\*\*)?\s*([23²³])$/iu.exec(unit.trim());
  return lengthPower ? `Å${lengthPower[1] === '2' || lengthPower[1] === '²' ? '²' : '³'}` : unit;
}
export function surfaceDistributionSummary(distribution: SurfaceAreaDistribution, decimals = DEFAULT_RESULT_DECIMALS): string {
  const basis = distribution.denominator.scope === 'molecule' ? '全分子面积' : distribution.denominator.scope === 'selected-region' ? '所选区域面积' : '占比分母面积';
  const unit = surfaceDisplayUnit(distribution.areaUnit);
  return `${basis} ${number(distribution.denominator.area, decimals)} ${unit} · 覆盖 ${number(distribution.coveredArea, decimals)} ${unit}`;
}
export const surfaceExtremumIdentity = (row: SurfaceExtremum) => `${row.function.toUpperCase()} · ${row.scope === 'global' ? '全局' : '局部'}${row.type === 'maximum' ? '极大' : '极小'} ${row.sourceIndex}`;
export const surfaceExtremumLabel = (row: SurfaceExtremum, decimals = DEFAULT_RESULT_DECIMALS) => `${surfaceExtremumIdentity(row)} · ${number(row.value, decimals)} ${row.valueUnit}`;
/** Coordinates describe the immutable source frame, independently from the display fit. */
export const surfaceExtremumCoordinates = (row: SurfaceExtremum, decimals = DEFAULT_RESULT_DECIMALS) => `源 XYZ / ${row.coordinateUnit === 'bohr' ? 'Bohr' : 'Å'}: ${row.position.map(value => number(value, decimals)).join(', ')}`;
export const surfaceExtremumPosition = (row: SurfaceExtremum): Vector3 => row.position.map(value => value * (row.coordinateUnit === 'bohr' ? BOHR_TO_ANGSTROM : 1)) as Vector3;
/** Native keys remain the data identity; only this presentation dictionary is localized. */
const SURFACE_METRIC_LABELS: Readonly<Record<string, string>> = {
  area: '表面积', volume: '体积', maximum: '最大值', minimum: '最小值', average: '平均值',
  'positive-average': '正值区域平均值', 'negative-average': '负值区域平均值', variance: '总方差',
  'positive-variance': '正值区域方差', 'negative-variance': '负值区域方差', balance: '电荷平衡参数 ν',
  'variance-balance': '总方差与电荷平衡参数之积', 'internal-charge-separation': '内部电荷分离度 Π', mpi: 'MPI',
  sphericity: '球形度', skewness: '总偏度', 'positive-skewness': '正值区域偏度', 'negative-skewness': '负值区域偏度',
  'positive-area': '正值区域表面积', 'negative-area': '负值区域表面积',
  'positive-area-percent': '正静电势表面比例', 'negative-area-percent': '负静电势表面比例',
  'nonpolar-area': '非极性表面积', 'polar-area': '极性表面积',
  'nonpolar-fraction-percent': '非极性表面比例', 'polar-fraction-percent': '极性表面比例',
};
export const surfaceMetricLabel = (metric: Pick<SurfaceMetric, 'key' | 'label'>) => SURFACE_METRIC_LABELS[metric.key] ?? metric.label;
export function surfaceMetricTable(region: SurfaceRegionResult, decimals = DEFAULT_RESULT_DECIMALS): ScientificTableProjection {
  return { columns: [{ key: 'metric', label: '指标' }, { key: 'value', label: '数值' }, { key: 'unit', label: '单位' }],
    rows: region.metrics.map(metric => ({ key: metric.key, cells: [surfaceMetricLabel(metric), number(metric.value, decimals), surfaceDisplayUnit(metric.unit)] })) };
}
const ESP_CORE_METRICS = [
  ['area', '表面积', 'area'], ['volume', '体积', 'volume'], ['maximum', '最大值', 'mapping-value'], ['minimum', '最小值', 'mapping-value'],
  ['positive-area-percent', '正静电势表面比例', 'dimensionless'], ['negative-area-percent', '负静电势表面比例', 'dimensionless'], ['mpi', 'MPI', 'mapping-value'],
] as const;
/** Same-region area ratios only: no sign inference, vertex counts, complement or missing-value fill. */
function surfaceSignAreaPercent(region: SurfaceRegionResult, sign: 'positive' | 'negative'): number | null {
  const metric = region.metrics.find(row => row.key === `${sign}-area` && row.dimension === 'area');
  const unit = region.areaUnit == null ? null : surfaceDisplayUnit(region.areaUnit);
  const knownAreaUnit = unit === 'Å²' || unit === 'bohr^2' || unit === 'bohr²';
  if (!metric || metric.value == null || !Number.isFinite(metric.value) || metric.value < 0 || region.area == null || !Number.isFinite(region.area) || region.area <= 0
    || !knownAreaUnit || metric.unit == null || surfaceDisplayUnit(metric.unit) !== unit) return null;
  return metric.value / region.area * 100;
}
/** The compact ESP projection and its complete TXT projection share the same unmodified region. */
export function surfaceEspMetricTables(region: SurfaceRegionResult, decimals = DEFAULT_RESULT_DECIMALS): { summary: ScientificTableProjection; complete: ScientificTableProjection } {
  const core: SurfaceMetric[] = ESP_CORE_METRICS.map(([key, label, dimension]) => {
    if (key === 'positive-area-percent' || key === 'negative-area-percent') return { key, label, dimension, value: surfaceSignAreaPercent(region, key === 'positive-area-percent' ? 'positive' : 'negative'), unit: '%' };
    const original = region.metrics.find(row => row.key === key && row.dimension === dimension);
    if (original) return { ...original, label };
    return { key, label, dimension, value: key === 'area' ? region.area : null, unit: key === 'area' ? region.areaUnit : null };
  });
  const coreKeys = new Set<string>(ESP_CORE_METRICS.map(([key]) => key));
  const summary = surfaceMetricTable({ ...region, metrics: core }, decimals);
  const complete = surfaceMetricTable({ ...region, metrics: [...core, ...region.metrics.filter(metric => !coreKeys.has(metric.key))] }, decimals);
  return { summary, complete };
}
export function surfaceExtremaTable(extrema: readonly SurfaceExtremum[], decimals = DEFAULT_RESULT_DECIMALS): ScientificTableProjection {
  return { columns: [{ key: 'point', label: '极值' }, { key: 'value', label: '数值' }, { key: 'unit', label: '单位' }],
    rows: extrema.map(row => ({ key: row.id, cells: [`${row.scope === 'global' ? '全局' : '局部'}${row.type === 'maximum' ? '极大' : '极小'} ${row.sourceIndex}`, number(row.value, decimals), row.valueUnit] })) };
}
export function surfaceExtremaRange(extrema: readonly SurfaceExtremum[]): { min: number; max: number } | undefined {
  const minima = extrema.filter(row => row.scope === 'global' && row.type === 'minimum').map(row => row.value).filter(Number.isFinite);
  const maxima = extrema.filter(row => row.scope === 'global' && row.type === 'maximum').map(row => row.value).filter(Number.isFinite);
  if (!minima.length || !maxima.length) return undefined;
  const min = Math.min(...minima), max = Math.max(...maxima);
  return min <= max ? { min, max } : undefined;
}
export function surfaceDistributionTable(distribution: SurfaceAreaDistribution, decimals = DEFAULT_RESULT_DECIMALS): ScientificTableProjection {
  return { columns: [{ key: 'interval', label: `区间 / ${surfaceDisplayUnit(distribution.valueUnit)}`, heading: '区间', headerUnit: surfaceDisplayUnit(distribution.valueUnit) }, { key: 'area', label: `面积 / ${surfaceDisplayUnit(distribution.areaUnit)}`, heading: '面积', headerUnit: surfaceDisplayUnit(distribution.areaUnit) }, { key: 'fraction', label: '占比 / %', heading: '占比', headerUnit: '%' }],
    rows: distribution.bins.map((bin, index) => ({ key: String(index), cells: [`${bin.lowerInclusive ? '[' : '('}${number(bin.lower, decimals)}, ${number(bin.upper, decimals)}${bin.upperInclusive ? ']' : ')'}`, number(bin.area, decimals), number(bin.fraction == null ? null : bin.fraction * 100, decimals)] })) };
}
/** Native areas over explicit intervals, never a vertex-count histogram. */
export function surfaceDistributionSeries(distribution: SurfaceAreaDistribution, quantity: 'area' | 'fraction', decimals = DEFAULT_RESULT_DECIMALS, appearance: { smooth?: boolean; showBins?: boolean } = {}): ScientificPlotSeries[] {
  const points = distribution.bins.map((bin) => {
    const y = quantity === 'area' ? bin.area : bin.fraction == null ? null : bin.fraction * 100;
    const unit = quantity === 'area' ? surfaceDisplayUnit(distribution.areaUnit) : '%';
    return { x: bin.lower, xEnd: bin.upper, y, label: `${number(bin.lower, decimals)} ${surfaceDisplayUnit(distribution.valueUnit)} · ${number(y, decimals)} ${unit}` };
  });
  const centers = points.map(point => ({ ...point, x: (point.x + point.xEnd) / 2 }));
  const line = appearance.smooth ? shapePreservingDistribution(points) : centers;
  return [...(appearance.showBins === false ? [] : [{ id: 'surface-distribution', label: '原始分箱', kind: 'histogram' as const, color: '#397a9a', points }]),
    { id: 'surface-distribution-centers', label: appearance.smooth ? '平滑曲线' : '分箱中心', kind: 'line', color: '#397a9a', showPoints: false, points: line }];
}

/** Display-only PCHIP at native bin centers. Runs stop at missing bins or interval
 * gaps, and every interval stays within its two endpoint values. */
function shapePreservingDistribution(bins: readonly (ScientificPlotPoint & { xEnd: number })[]): ScientificPlotPoint[] {
  const runs: ScientificPlotPoint[][] = [];
  let run: ScientificPlotPoint[] = [], previous: typeof bins[number] | undefined;
  const flush = () => { if (run.length) runs.push(run); run = []; previous = undefined; };
  for (const bin of bins) {
    if (bin.y === null || !Number.isFinite(bin.y) || !Number.isFinite(bin.x) || !Number.isFinite(bin.xEnd) || bin.xEnd <= bin.x) { flush(); continue; }
    const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(bin.x), Math.abs(previous?.xEnd ?? 0));
    if (previous && Math.abs(bin.x - previous.xEnd) > tolerance) flush();
    const point = { ...bin, x: (bin.x + bin.xEnd) / 2 };
    if (run.length && point.x <= run[run.length - 1].x) flush();
    run.push(point); previous = bin;
  }
  flush();
  return runs.flatMap((points, runIndex) => {
    const segment = `native-bin-run-${runIndex}`;
    if (points.length < 2) return points.map(point => ({ ...point, segment }));
    const n = points.length, h = points.slice(1).map((point, i) => point.x - points[i].x);
    const slope = h.map((span, i) => (points[i + 1].y! - points[i].y!) / span);
    const derivatives = new Array<number>(n).fill(0);
    const endpoint = (a: number, b: number, first: number, next: number) => {
      const value = ((2 * a + b) * first - a * next) / (a + b);
      return Math.sign(value) !== Math.sign(first) ? 0 : Math.sign(first) !== Math.sign(next) && Math.abs(value) > 3 * Math.abs(first) ? 3 * first : value;
    };
    if (n === 2) derivatives[0] = derivatives[1] = slope[0];
    else {
      derivatives[0] = endpoint(h[0], h[1], slope[0], slope[1]);
      derivatives[n - 1] = endpoint(h[n - 2], h[n - 3], slope[n - 2], slope[n - 3]);
      for (let i = 1; i < n - 1; i++) {
        if (slope[i - 1] * slope[i] <= 0) continue;
        const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
        derivatives[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
      }
    }
    const output: ScientificPlotPoint[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = points[i], b = points[i + 1], span = h[i];
      for (let step = 0; step < 16; step++) {
        if (step === 0) { output.push({ ...a, segment }); continue; }
        const t = step / 16, t2 = t * t, t3 = t2 * t;
        const value = (2 * t3 - 3 * t2 + 1) * a.y! + (t3 - 2 * t2 + t) * span * derivatives[i]
          + (-2 * t3 + 3 * t2) * b.y! + (t3 - t2) * span * derivatives[i + 1];
        output.push({ x: a.x + t * span, y: Math.max(Math.min(a.y!, b.y!), Math.min(Math.max(a.y!, b.y!), value)), segment });
      }
    }
    output.push({ ...points[n - 1], segment });
    return output;
  });
}
