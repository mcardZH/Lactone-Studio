import type {Structure} from '../../core/types';
import {sha256Utf8} from '../../core/file-identity';
import {calculationRangeFromGrid,estimatedCalculationRange,prepareCalculationRange,type CalculationRangeDisplay} from '../../results/calculation-range';
import type {SurfaceContext} from '../../results/surface-contracts';
import type {HirshfeldControlsState} from './hirshfeld-controls-contracts';
import {surfaceScientificContextKey} from './surface-context-pool';

export interface HirshfeldDisplayRanges {
  actual: CalculationRangeDisplay | null;
  estimate: CalculationRangeDisplay | null;
  viewportEstimate: CalculationRangeDisplay | null;
  resultMatchesDraft: boolean;
  issue: string;
}

export function prepareHirshfeldDisplayRanges(state: HirshfeldControlsState, context: SurfaceContext, structure?: Structure): HirshfeldDisplayRanges {
  const {result,targetIds,spacingBohr,rangeExtensionBohr} = state;
  const selected = new Set(targetIds);
  const geometryChanged = !result || result.quantitativeGrid.spacingBohr !== spacingBohr
    || targetIds.length !== result.source.targetAtomIndices.length
    || result.source.targetAtomIndices.some(index => !selected.has(result.source.atoms[index - 1].stableId));
  const resultMatchesDraft = !geometryChanged && (result?.mode ?? 'closed') === state.mode;
  const actual = prepareCalculationRange(() => {
    if (!result) return null;
    const key = sha256Utf8(JSON.stringify([surfaceScientificContextKey(result.stamp),result.stamp.requestId]));
    return calculationRangeFromGrid(result.pair.shape.grid, `hirshfeld-range:actual:${key}`, 'Hirshfeld·实际计算范围');
  });
  const estimate = prepareCalculationRange(() => {
    if (!structure || rangeExtensionBohr === null || resultMatchesDraft || !selected.size) return null;
    const target = { ...structure, atoms: structure.atoms.filter(atom => selected.has(atom.id ?? '')) };
    const key = sha256Utf8(JSON.stringify([surfaceScientificContextKey(context),state.mode,spacingBohr,rangeExtensionBohr,[...selected].sort()]));
    return estimatedCalculationRange(target, {mode:'spacing',spacingBohr}, rangeExtensionBohr, `hirshfeld-range:estimate:${key}`, 'Hirshfeld·预计计算范围');
  });
  return {actual:actual.value,estimate:estimate.value,viewportEstimate:geometryChanged ? estimate.value : null,
    resultMatchesDraft,issue:actual.issue || estimate.issue};
}
