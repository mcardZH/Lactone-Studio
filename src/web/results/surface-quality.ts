import type { SurfaceCubeQuality, SurfaceQuantitativeGrid, SurfaceGrid } from '../../results/surface-contracts';
import { estimatedCalculationRange } from '../../results/calculation-range';
import type { Structure } from '../../core/types';
import { BOHR_TO_ANGSTROM } from '../../core/orca/assets';
import type { CalculationQualityOption } from './AnalysisTaskLayout';

export const SURFACE_ANALYSIS_DEFAULT_SPACING = .25;
export const SURFACE_ANALYSIS_SPACING_PRESETS = { toy: 1, coarse: .5, 'native-default': SURFACE_ANALYSIS_DEFAULT_SPACING, fine: .125, artistic: .0625 } as const;
export const SURFACE_ANALYSIS_QUALITY_OPTIONS = [
  { value: 'toy', tier: 'toy' }, { value: 'coarse', tier: 'coarse' },
  { value: 'native-default', tier: 'medium' }, { value: 'fine', tier: 'fine' },
  { value: 'artistic', tier: 'artistic' }, { value: 'spacing', tier: 'custom' },
] as const satisfies readonly CalculationQualityOption[];
export const SURFACE_CUBE_QUALITY_OPTIONS = [
  { value: 'toy', tier: 'toy' }, { value: 'low', tier: 'coarse' },
  { value: 'medium', tier: 'medium' }, { value: 'high', tier: 'fine' },
  { value: 'artistic', tier: 'artistic' }, { value: 'custom', tier: 'custom' },
] as const satisfies readonly CalculationQualityOption[];
export type SurfaceCubeQualityPreset = typeof SURFACE_CUBE_QUALITY_OPTIONS[number]['value'];

/** Menu 1/2/3 target counts verified without evaluating a field. This is only a
 * geometric estimate; generation still receives the unchanged quality request. */
export function surfaceGridPreview(quality:SurfaceCubeQuality,structure:Structure,extensionBohr:number,reference?:SurfaceGrid|null) {
  const range=estimatedCalculationRange(structure,quality,extensionBohr,'quality-preview','计算范围',reference);
  if(!range)return null;
  const {grid}=range,dimensions=grid.dimensions;
  const axisSpacingBohr=grid.axes.map(axis=>Math.hypot(...axis)/(grid.coordinateUnit==='angstrom'?BOHR_TO_ANGSTROM:1));
  const extents=axisSpacingBohr.map((step,index)=>step*(dimensions[index]-1));
  const spacingBohr=quality.mode==='dimensions'?null:quality.mode==='spacing'?quality.spacingBohr:Math.cbrt(extents.reduce((a,b)=>a*b,1)/(quality.mode==='target-points'?quality.targetPoints:{low:125000,medium:512000,high:1728000}[quality.mode]));
  return {spacingBohr,axisSpacingBohr,dimensions,pointCount:dimensions.reduce((a,b)=>a*b,1),estimated:true,reference:!!reference};
}

/** Existing backend routes only; quantitative and plotting grids stay independent. */
export function surfaceQuantitativePreset(value: string, current: SurfaceQuantitativeGrid): SurfaceQuantitativeGrid {
  const spacing = SURFACE_ANALYSIS_SPACING_PRESETS[value as keyof typeof SURFACE_ANALYSIS_SPACING_PRESETS];
  return { mode: 'spacing', spacingBohr: spacing ?? current.spacingBohr ?? SURFACE_ANALYSIS_DEFAULT_SPACING };
}
/** Exact normalized values only: no nearest-tier snapping. */
export function surfaceQuantitativePresetFor(spacingBohr: number): string {
  return Object.entries(SURFACE_ANALYSIS_SPACING_PRESETS).find(([, value]) => value === spacingBohr)?.[0] ?? 'spacing';
}
export function surfaceCubePreset(value: SurfaceCubeQualityPreset, current: SurfaceCubeQuality, actual?: SurfaceGrid): SurfaceCubeQuality {
  if (value === 'toy') return { mode: 'target-points', targetPoints: 32768 };
  if (value === 'artistic') return { mode: 'target-points', targetPoints: 4096000 };
  if (value === 'custom') return current.mode === 'spacing' || current.mode === 'dimensions' ? current : actual ? {mode:'dimensions',dimensions:[...actual.dimensions]} : { mode: 'spacing', spacingBohr: NaN };
  return { mode: value };
}
export function surfaceCubePresetFor(quality: SurfaceCubeQuality): SurfaceCubeQualityPreset {
  if(quality.mode==='target-points')return quality.targetPoints===32768?'toy':'artistic';

  return quality.mode === 'dimensions' || quality.mode === 'spacing' ? 'custom' : quality.mode;
}
/** The native pair/serialization floor, independent of unknown wavefunction overhead. */
export function surfaceCubeBudgetIssue(quality: SurfaceCubeQuality, budget?: number): string | undefined {
  if (quality.mode !== 'dimensions'&&quality.mode!=='target-points') return undefined;
  const points = quality.mode==='target-points'?quality.targetPoints:quality.dimensions.reduce((product, value) => product * value, 1), bytes = points * 256;
  if (budget != null && Number.isFinite(budget) && budget > 0 && bytes > budget)
    return `当前 Cube 网格至少需要 ${(bytes / 1024 ** 2).toFixed(1)} MiB，超过内存预算 ${(budget / 1024 ** 2).toFixed(1)} MiB。请降低点数或调整资源设置。`;
  return undefined;
}
export function surfaceCubeEffectiveParameters(quality: SurfaceCubeQuality): string {
  if(quality.mode==='target-points')return `目标约 ${quality.targetPoints.toLocaleString()} 点 · 执行时按实际边界分配`;
  if (quality.mode === 'spacing') return `格距 ${quality.spacingBohr} Bohr`;
  if (quality.mode === 'dimensions') return `${quality.dimensions.join(' × ')} 点`;
  return `原生网格 ${ { low: 1, medium: 2, high: 3 }[quality.mode]} · 实际点数在生成后显示`;
}
