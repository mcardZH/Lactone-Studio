import type { InteractionGridQuality, InteractionMethod } from '../../results/interaction-contracts';
import { validateInteractionGridQuality } from '../../results/interaction-field';
import type { CalculationQualityTier } from './AnalysisTaskLayout';

export const INTERACTION_QUALITY_OPTIONS = (['toy', 'coarse', 'medium', 'fine', 'artistic', 'custom'] as const).map(tier => ({ value: tier, tier }));
export function interactionQualityTier(quality: InteractionGridQuality): CalculationQualityTier {
  return quality.mode==='target-points'?(quality.targetPoints===32768?'toy':'artistic'):quality.mode === 'low' ? 'coarse' : quality.mode === 'medium' ? 'medium' : quality.mode === 'high' ? 'fine' : 'custom';
}
export function interactionQualityPreset(tier: CalculationQualityTier, current: InteractionGridQuality, actual?: readonly [number,number,number]): InteractionGridQuality {
  if (tier === 'toy') return { mode: 'target-points', targetPoints: 32768 };
  if (tier === 'artistic') return { mode: 'target-points', targetPoints: 4096000 };
  if (tier === 'coarse' || tier === 'medium' || tier === 'fine') return { mode: tier === 'coarse' ? 'low' : tier === 'fine' ? 'high' : 'medium' };
  return current.mode === 'spacing' || current.mode === 'dimensions' ? current : actual ? {mode:'dimensions',dimensions:[...actual]} : { mode: 'spacing', spacingBohr: NaN };
}
export function interactionQualityParameters(quality: InteractionGridQuality, actualDimensions?: readonly [number, number, number]): string {
  if(quality.mode==='target-points')return `目标约 ${quality.targetPoints.toLocaleString()} 点 · 执行时按实际边界分配`;
  const actual = actualDimensions ? `${actualDimensions.join(' × ')} 点 · 总点数 ${actualDimensions.reduce((total, value) => total * value, 1)}` : null;
  if (quality.mode === 'dimensions') return `${quality.dimensions.join(' × ')} 点 · 总点数 ${quality.dimensions.reduce((total, value) => total * value, 1)}`;
  if (quality.mode === 'spacing') return Number.isFinite(quality.spacingBohr) ? `格距 ${quality.spacingBohr} Bohr${actual ? ` · ${actual}` : ''}` : '请输入实际格距 / Bohr';
  return actual ?? `原生${quality.mode === 'low' ? '约 125000' : quality.mode === 'high' ? '约 1728000' : '约 512000'}点`;
}
/** Validate the requested grid definition. Resource estimates are advisory;
 * the native operation keeps its real shared grant and complete grid. */
export function interactionQualityIssue(quality: InteractionGridQuality, _method: InteractionMethod, _resourceBudgetBytes?: number): string | null {
  try { validateInteractionGridQuality(quality); } catch (error) { return error instanceof Error ? error.message : String(error); }
  return null;
}
