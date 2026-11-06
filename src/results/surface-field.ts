import type { Vector3 } from '../core/types';
import { convertEnergy, type EnergyUnit } from './energy';
import type { SurfaceAnalysisResult, SurfaceAreaDistribution, SurfaceContext, SurfaceCubeQuality, SurfaceFieldPair, SurfaceFunction, SurfaceGrid, SurfaceMetric, SurfaceQuantitativeGrid, SurfaceScalarField, SurfaceStamp } from './surface-contracts';

export const SURFACE_FUNCTIONS = Object.freeze({
  esp: { label: 'ESP', atomicUnit: 'hartree/e', units: ['hartree/e', 'a.u.', 'eV', 'kcal/mol', 'kJ/mol'] },
  alie: { label: 'ALIE', atomicUnit: 'hartree', units: ['hartree', 'a.u.', 'eV', 'kcal/mol', 'kJ/mol'] },
} as const);
export function sameSurfaceContext(a: SurfaceContext, b: SurfaceContext): boolean {
  return (['sourceId', 'sourceRevision', 'jobIndex', 'sourceFrameIndex', 'generation', 'documentId', 'documentRevision', 'activationEpoch'] as const).every(key => a[key] === b[key]);
}
export function sameSurfaceStamp(a: SurfaceStamp, b: SurfaceStamp): boolean { return sameSurfaceContext(a, b) && a.requestId === b.requestId && a.analysisId === b.analysisId; }
export function validateSurfaceQuantitativeGrid(grid: SurfaceQuantitativeGrid): void {
  if (!['native-default', 'spacing'].includes(grid.mode) || grid.mode === 'spacing' && (!Number.isFinite(grid.spacingBohr) || grid.spacingBohr! <= 0)
    || grid.mode === 'native-default' && grid.spacingBohr !== undefined
    || grid.actualSpacingBohr !== undefined && (!Number.isFinite(grid.actualSpacingBohr) || grid.actualSpacingBohr <= 0)) throw new Error('定量表面网格定义无效；native-default不能夹带另一个默认格距。');
}
export function validateSurfaceCubeQuality(quality: SurfaceCubeQuality): void {
  if(quality.mode==='target-points'&&[32768,4096000].includes(quality.targetPoints)&&Object.keys(quality).length===2)return;
  if (['low', 'medium', 'high'].includes(quality.mode)) return;
  if (quality.mode === 'spacing' && Number.isFinite(quality.spacingBohr) && quality.spacingBohr > 0) return;
  if (quality.mode === 'dimensions' && quality.dimensions.length === 3 && quality.dimensions.every(n => Number.isSafeInteger(n) && n >= 2)) return;
  throw new Error('着色Cube质量定义无效。');
}
export function validateSurfaceAnalysisResult(result: SurfaceAnalysisResult): void {
  validateSurfaceQuantitativeGrid(result.quantitativeGrid);
  if (!Number.isFinite(result.isovalue) || result.isovalue <= 0 || !result.stamp.sourceId || !result.stamp.sourceRevision || !result.stamp.requestId || !result.stamp.analysisId
    || !Number.isSafeInteger(result.stamp.generation) || result.stamp.generation < 0) throw new Error('表面定量结果缺少可靠来源、代际或表面定义。');
  const regions = new Set<string>();
  for (const region of result.regions) {
    const selection = region.selection;
    if (!selection.id || regions.has(selection.id) || !['molecule', 'atoms', 'fragment'].includes(selection.kind) || new Set(selection.atomIndices).size !== selection.atomIndices.length
      || selection.atomIndices.some(index => !Number.isSafeInteger(index) || index < 1) || (selection.kind === 'molecule' ? selection.atomIndices.length !== 0 : selection.kind === 'atoms' ? selection.atomIndices.length !== 1 : selection.atomIndices.length === 0)) throw new Error('原生表面区域标识或明确原子集合无效；逐原子区域须为一个源原子。');
    regions.add(selection.id);
    if (region.area !== null && (!Number.isFinite(region.area) || region.area < 0)) throw new Error('表面区域面积无效。');
    if (region.metrics.some(metric => metric.value !== null && !Number.isFinite(metric.value))) throw new Error('未定义指标须保留null及原始值，不能发布NaN或伪0。');
    if (region.distribution) {
      validateSurfaceAreaDistribution(region.distribution);
      if (region.distribution.regionId !== selection.id || !sameSurfaceContext(region.distribution.stamp, result.stamp)
        || region.distribution.stamp.analysisId !== result.stamp.analysisId || !region.distribution.stamp.requestId) throw new Error('表面积分布不属于本次分析或当前区域。');
    }
  }
  for (const point of [...result.extrema, ...result.regions.flatMap(region => [...region.extrema])]) {
    if (!point.id || !regions.has(point.regionId) || !['minimum', 'maximum'].includes(point.type) || !['local', 'global'].includes(point.scope)
      || !finiteVector(point.position) || !Number.isFinite(point.value) || !point.valueUnit) throw new Error('表面极值的类型、来源区域、坐标或物理量无效。');
  }
}
const determinant = (a: readonly Vector3[]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
function finiteVector(value: readonly number[]): boolean { return value.length === 3 && value.every(Number.isFinite); }
function validateGrid(grid: SurfaceGrid): void {
  if (!['bohr', 'angstrom'].includes(grid.coordinateUnit) || grid.ordering !== 'z-fastest' || !finiteVector(grid.origin)
    || grid.axes.length !== 3 || grid.axes.some(axis => !finiteVector(axis)) || grid.dimensions.length !== 3 || grid.dimensions.some(n => !Number.isSafeInteger(n) || n < 2)) throw new Error('表面需要完整、有限的三维仿射标量网格。');
  const scaled = grid.axes.map(axis => { const norm = Math.hypot(...axis); return axis.map(value => value / norm) as Vector3; });
  if (!scaled.flat().every(Number.isFinite) || determinant(scaled) === 0) throw new Error('表面仿射步进矩阵退化。');
}
export function validateSurfaceScalarField(field: SurfaceScalarField): void {
  validateGrid(field.grid);
  const count = field.grid.dimensions.reduce((n, d) => n * d, 1);
  if (!Number.isSafeInteger(count) || !(field.values instanceof Float64Array) || field.values.length !== count || field.values.some(value => !Number.isFinite(value))) throw new Error('表面标量格点数据数量或数值无效。');
  if (!field.id || !field.source.id || !field.source.revision || !field.context.sourceId || !field.context.sourceRevision || !Number.isSafeInteger(field.context.generation) || field.context.generation < 0) throw new Error('表面格点缺少稳定来源与代际身份。');
  if ([field.context.jobIndex, field.context.sourceFrameIndex].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))
    || [field.context.documentRevision, field.context.activationEpoch].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new Error('表面格点来源帧或修订身份无效。');
  const precision = field.precision;
  if (!precision || !finiteVector(precision.origin) || precision.axes.length !== 3 || precision.axes.some(axis => !finiteVector(axis))
    || precision.atomCoordinates.length !== field.atoms.length || precision.atomCoordinates.some(position => !finiteVector(position))
    || precision.nuclearCharges !== undefined && (precision.nuclearCharges.length !== field.atoms.length || precision.nuclearCharges.some(value => !Number.isFinite(value)))
    || [...precision.origin, ...precision.axes.flat(), ...precision.atomCoordinates.flat(), ...(precision.nuclearCharges ?? [])].some(value => value < 0)) throw new Error('表面格点缺少可靠原始打印精度。');
  if (!field.atoms.length || field.atoms.some((atom, i) => atom.sourceIndex !== i + 1 || !Number.isSafeInteger(atom.atomicNumber) || atom.atomicNumber < 1 || atom.atomicNumber > 118 || !Number.isFinite(atom.nuclearCharge) || !finiteVector(atom.position))) throw new Error('表面格点原子身份、顺序或坐标无效。');
  if (field.validDomain.kind === 'node-mask' && (!(field.validDomain.mask instanceof Uint8Array) || field.validDomain.mask.length !== count || field.validDomain.mask.some(value => value !== 0 && value !== 1))) throw new Error('表面格点有效节点mask无效。');
  if (!['full-grid', 'node-mask', 'unknown'].includes(field.validDomain.kind)) throw new Error('未知的表面有效域定义。');
}
const agrees = (a: number, b: number, ar: number, br: number) => Math.abs(a - b) <= ar + br + 64 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
export function isSurfaceDensityAtomicUnit(unit: string | null | undefined): boolean { return ['e/bohr^3', 'e/bohr³', 'bohr^-3', 'a.u.'].includes(unit ?? ''); }
export interface SurfacePairValidation { compatible: boolean; reasons: string[] }
/** Compare already structurally validated scalar fields, independently of any
 * main-12 density/ESP or main-20 interaction role. No fit or resampling. */
export function scalarFieldCompatibilityReasons(shape: SurfaceScalarField, mapping: SurfaceScalarField): string[] {
  const reasons: string[] = [];
  if (!sameSurfaceContext(shape.context, mapping.context)) reasons.push('形状格点与映射格点没有相同的明确来源/帧/代际关联。');
  const stateA = shape.source.electronicState, stateB = mapping.source.electronicState;
  for (const key of ['charge', 'multiplicity', 'method', 'basis', 'stateLabel'] as const) if (stateA?.[key] !== undefined && stateB?.[key] !== undefined && stateA[key] !== stateB[key]) reasons.push(`Cube明确电子态元数据冲突：${key}。`);
  if (shape.grid.coordinateUnit !== mapping.grid.coordinateUnit) reasons.push('Cube空间单位不一致；未自动换单位或改数据。');
  if (shape.grid.dimensions.some((n, i) => n !== mapping.grid.dimensions[i]) || shape.grid.ordering !== mapping.grid.ordering) reasons.push('Cube点数或数值顺序不一致。');
  if (!shape.grid.origin.every((value, i) => agrees(value, mapping.grid.origin[i], shape.precision.origin[i], mapping.precision.origin[i]))
    || !shape.grid.axes.every((axis, i) => axis.every((value, j) => agrees(value, mapping.grid.axes[i][j], shape.precision.axes[i][j], mapping.precision.axes[i][j])))) reasons.push('Cube原点或完整步进向量不一致。');
  if (shape.atoms.length !== mapping.atoms.length || shape.atoms.some((atom, i) => {
    const target = mapping.atoms[i];
    return !target || atom.atomicNumber !== target.atomicNumber || atom.sourceIndex !== target.sourceIndex
      || !agrees(atom.nuclearCharge, target.nuclearCharge, shape.precision.nuclearCharges?.[i] ?? 0, mapping.precision.nuclearCharges?.[i] ?? 0)
      || atom.position.some((value, j) => !agrees(value, target.position[j], shape.precision.atomCoordinates[i][j], mapping.precision.atomCoordinates[i][j]));
  })) reasons.push('Cube逐序原子、有效核电荷或几何不一致；未自动重排或刚体对齐。');
  return reasons;
}
/** No mutation, rigid fit, translation, resampling, nearest-atom assignment or
 * electronic-state inference. Distinct external files need an explicit common context. */
export function validateSurfaceFieldPair(pair: SurfaceFieldPair): SurfacePairValidation {
  const reasons: string[] = [], shape = pair.shape, mapping = pair.mapping;
  for (const field of [shape, ...(mapping ? [mapping] : [])]) try { validateSurfaceScalarField(field); } catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
  if (!Number.isFinite(pair.isovalue) || pair.isovalue <= 0) reasons.push('密度表面等值须为正有限数。');
  if (shape.function !== 'electron-density' || !isSurfaceDensityAtomicUnit(shape.valueUnit) || shape.definitionEvidence.kind === 'unknown') reasons.push('形状格点须明确为原子单位电子密度并保留单位依据；不把轨道振幅冒密度。');
  if (shape.validDomain.kind !== 'full-grid') reasons.push('形状密度格点须有完整网格有效性；不从未算填充值生成边界。');
  if (!mapping) return { compatible: reasons.length === 0, reasons };
  if (reasons.length) return { compatible: false, reasons };
  reasons.push(...scalarFieldCompatibilityReasons(shape, mapping));
  if (mapping.function === 'unknown' || !mapping.valueUnit || mapping.definitionEvidence.kind === 'unknown') reasons.push('映射函数或单位依据缺失。');
  if ((mapping.function === 'esp' || mapping.function === 'alie') && !energyUnit(mapping.function, mapping.valueUnit ?? '')) reasons.push('已知映射函数的单位不在已确认的物理单位集合。');
  const domain = mapping.validDomain;
  if (domain.kind === 'unknown') reasons.push('映射格点有效域未知，不能把未算填充值当物理值。');
  if (domain.kind === 'node-mask' && domain.restrictedTo) {
    const binding = domain.restrictedTo;
    const matchesShape = binding.shapeSourceRevision !== undefined
      ? /^[a-f0-9]{64}$/i.test(binding.shapeSourceRevision) && binding.shapeSourceRevision === shape.source.revision
      : binding.shapeFieldId === shape.id;
    if (!matchesShape || binding.isovalue !== pair.isovalue) reasons.push('受限映射格点不适用于本次密度格点内容身份或等值。');
  }
  return { compatible: reasons.length === 0, reasons };
}

/** One validation/inverse per display field, not per mesh vertex. Input points
 * are in the field's own coordinate unit; the renderer owns display transforms. */
export function createSurfaceFieldSampler(field: SurfaceScalarField): (position: Vector3, crossingCell?: Vector3) => number | null {
  validateSurfaceScalarField(field);
  if (field.validDomain.kind === 'unknown') throw new Error('未知有效域不能用于表面取色。');
  const [a, b, c] = field.grid.axes, cross = (x: Vector3, y: Vector3): Vector3 => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const numerator = [cross(b, c), cross(c, a), cross(a, b)], denominator = a.reduce((sum, value, i) => sum + value * numerator[0][i], 0);
  const inverse = numerator.map(row => row.map(value => value / denominator));
  if (!inverse.flat().every(Number.isFinite)) throw new Error('表面仿射逆矩阵超出有限数范围。');
  const [, ny, nz] = field.grid.dimensions, origin = field.grid.origin, domain = field.validDomain;
  return (position, crossingCell) => {
    if (!finiteVector(position)) return null;
    const local = position.map((value, i) => value - origin[i]);
    const coordinates = inverse.map(row => row.reduce((sum, value, i) => sum + value * local[i], 0));
    if (coordinates.some(value => !Number.isFinite(value))) return null;
    let base: number[], fraction: number[];
    if (crossingCell) {
      // A renderer may retain the known original crossing cell at an exact
      // grid edge. This resolves affine roundoff only, never domain coverage.
      if (crossingCell.length !== 3 || crossingCell.some((value, i) => !Number.isSafeInteger(value) || value < 0 || value >= field.grid.dimensions[i] - 1)) throw new Error('表面插值单元提示无效。');
      base = crossingCell;
      fraction = coordinates.map((value, i) => {
        const raw = value - base[i], roundoff = 128 * Number.EPSILON * Math.max(1, Math.abs(value),
          inverse[i].reduce((sum, coefficient, axis) => sum + Math.abs(coefficient) * (Math.abs(position[axis]) + Math.abs(origin[axis])), 0));
        if (raw < -roundoff || raw > 1 + roundoff) throw new Error('表面插值单元提示不包含实际坐标。');
        return Math.max(0, Math.min(1, raw));
      });
    } else {
      if (coordinates.some((value, i) => value < 0 || value > field.grid.dimensions[i] - 1)) return null;
      base = coordinates.map((value, i) => Math.min(Math.floor(value), field.grid.dimensions[i] - 2));
      fraction = coordinates.map((value, i) => value - base[i]);
    }
    let result = 0;
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
      const index = ((base[0] + x) * ny + base[1] + y) * nz + base[2] + z;
      if (domain.kind === 'node-mask' && domain.mask[index] !== 1) return null;
      result += field.values[index] * (x ? fraction[0] : 1 - fraction[0]) * (y ? fraction[1] : 1 - fraction[1]) * (z ? fraction[2] : 1 - fraction[2]);
    }
    return Number.isFinite(result) ? result : null;
  };
}

function energyUnit(fn: SurfaceFunction, unit: string): EnergyUnit | null {
  if (unit === SURFACE_FUNCTIONS[fn].atomicUnit || unit === 'a.u.') return 'hartree';
  return ['eV', 'kcal/mol', 'kJ/mol'].includes(unit) ? unit as EnergyUnit : null;
}
export function convertSurfaceMappingValue(value: number, fn: SurfaceFunction, fromUnit: string, toUnit: string, power: 1 | 2 = 1): number {
  if (!Number.isFinite(value) || ![1, 2].includes(power)) throw new Error('表面数值或物理量次数无效。');
  const from = energyUnit(fn, fromUnit), to = energyUnit(fn, toUnit);
  if (!from || !to) throw new Error('未确认的表面函数单位不能换算。');
  if (from === to) return value;
  const factor = convertEnergy({ value: 1, unit: from }, to)!;
  const converted = value * factor ** power;
  if (!Number.isFinite(converted)) throw new Error('表面单位换算超出有限数范围。');
  return converted;
}
export const squaredSurfaceUnit = (unit: string) => `(${unit})²`;
export function convertSurfaceMetric(metric: SurfaceMetric, fn: SurfaceFunction, targetUnit: string): SurfaceMetric {
  if (metric.dimension !== 'mapping-value' && metric.dimension !== 'mapping-variance') return { ...metric };
  if (!metric.unit) return { ...metric };
  const power = metric.dimension === 'mapping-variance' ? 2 : 1;
  const from = power === 1 ? metric.unit : metric.unit.replace(/(?:\^2|\*\*2|²)$/, '').replace(/^\((.*)\)$/, '$1');
  if (power === 2 && from === metric.unit) throw new Error('方差来源单位没有平方量纲；未冒普通值换算。');
  const converted = convertSurfaceMappingValue(metric.value ?? 0, fn, from, targetUnit, power);
  return { ...metric, value: metric.value === null ? null : converted, unit: power === 2 ? squaredSurfaceUnit(targetUnit) : targetUnit };
}
/** Validate native area statistics without replacing its denominator, counting
 * vertices, renormalizing a cropped range or inventing regional percentages. */
export function validateSurfaceAreaDistribution(distribution: SurfaceAreaDistribution): void {
  if (!Number.isFinite(distribution.denominator.area) || distribution.denominator.area <= 0 || !distribution.denominator.definition || !['molecule', 'selected-region', 'native-other'].includes(distribution.denominator.scope)
    || !Number.isFinite(distribution.coveredArea) || distribution.coveredArea < 0) throw new Error('表面积分布缺少有效面积分母/覆盖范围。');
  for (let i = 0; i < distribution.bins.length; i++) {
    const bin = distribution.bins[i], previous = distribution.bins[i - 1];
    if (![bin.lower, bin.upper, bin.area].every(Number.isFinite) || bin.lower >= bin.upper || bin.area < 0
      || bin.fraction !== null && (!Number.isFinite(bin.fraction) || bin.fraction < 0)
      || bin.nativePercent !== undefined && (!Number.isFinite(bin.nativePercent) || bin.nativePercent < 0)) throw new Error('表面积分布区间或面积无效。');
    if (previous && (previous.upper > bin.lower || previous.upper === bin.lower && previous.upperInclusive && bin.lowerInclusive)) throw new Error('表面积分布区间重叠或边界重复计入。');
  }
}
