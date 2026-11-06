import type { Structure } from '../../core/types';
import type { HybridGeometryMetadata } from './contracts';
export function validateHybridMetadata(value: unknown, structure: Structure, objective?: number): asserts value is HybridGeometryMetadata {
  const requireValue = (valid: unknown) => { if (!valid) throw new Error('局部混合优化的来源、分区或目标元数据无效。'); };
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  const data = value as HybridGeometryMetadata, ids = new Set(structure.atoms.map(atom => atom.id));
  const pure = data.mode === 'geometry-only';
  requireValue(data.schema === 1 && (pure || data.mode === 'partial-uff-local') && data.physicalPotential === false);
  requireValue(data.scalePolicy === (pure ? 'pure-geometry-v1' : 'uff-bond-stiffness-v1') && data.objective === (pure ? 'mechanicalGeometry' : 'partialUFF(kcal/mol)/energyScale(kcal/mol)+localMechanical') && typeof data.triggerCode === 'string' && data.triggerCode.length > 0 && typeof data.regionsOverlap === 'boolean');
  for (const list of [data.problemAtomIds, data.mechanicalAtomIds, data.uffAtomIds, data.boundaryAtomIds]) requireValue(Array.isArray(list) && list.length <= ids.size && new Set(list).size === list.length && list.every(id => typeof id === 'string' && ids.has(id)));
  requireValue(data.problemAtomIds.length > 0 && data.mechanicalAtomIds.length > 0);
  requireValue(data.problemAtomIds.every(id => data.mechanicalAtomIds.includes(id)) && data.regionsOverlap === data.mechanicalAtomIds.some(id => data.uffAtomIds.includes(id)));
  if (pure) requireValue(data.uffAtomIds.length === 0 && data.uffEnergyKcalMol === 0 && data.energyScaleKcalMol === 1 && data.mechanicalAtomIds.length === ids.size && data.boundaryAtomIds.length === 0 && data.regionsOverlap === false && data.fallbackReason === 'no-uff-region');
  else requireValue(data.uffAtomIds.length > 0 && data.fallbackReason === undefined);
  requireValue(Number.isFinite(data.uffEnergyKcalMol) && Number.isFinite(data.localMechanicalObjective) && data.localMechanicalObjective >= 0 && Number.isFinite(data.energyScaleKcalMol) && data.energyScaleKcalMol > 0);
  requireValue(data.termCounts && typeof data.termCounts === 'object' && !Array.isArray(data.termCounts) && Object.values(data.termCounts).every(n => Number.isSafeInteger(n) && n >= 0));
  if (data.typingProof !== undefined || data.typingIsolationAtomIds !== undefined) {
    requireValue(['bounded-neutral-saturated-CH-chain-v1','bounded-neutral-saturated-CHF-chain-v2','native-null-typing-mask-v3'].includes(data.typingProof!) && Array.isArray(data.typingIsolationAtomIds) && data.typingIsolationAtomIds.length > 0 && new Set(data.typingIsolationAtomIds).size === data.typingIsolationAtomIds.length && data.typingIsolationAtomIds.every(id => data.mechanicalAtomIds.includes(id)));
    if(data.typingProof === 'bounded-neutral-saturated-CHF-chain-v2') requireValue(JSON.stringify([...data.typingIsolationAtomIds!].sort()) === JSON.stringify([...data.problemAtomIds].sort()));
    if(data.typingProof === 'native-null-typing-mask-v3') requireValue(data.typingIsolationAtomIds!.every(id => !data.uffAtomIds.includes(id)));
  }
  if (objective !== undefined) { const actual = data.uffEnergyKcalMol / data.energyScaleKcalMol + data.localMechanicalObjective; requireValue(Number.isFinite(objective) && Math.abs(actual - objective) <= 1e-8 * Math.max(1, Math.abs(actual))); }
}
