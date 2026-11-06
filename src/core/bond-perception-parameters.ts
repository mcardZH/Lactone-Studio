/** Shared geometric meaning for finite and periodic empirical perception.
 * Factor bounds multiply the sum of covalent radii; pair overrides are Å. */
export interface EmpiricalBondPerceptionParameters {
  minDistanceFactor: number;
  maxDistanceFactor: number;
  bondOrderMode: 'auto-organic' | 'connectivity-only';
  pairOverrides: { elements: [string, string]; minDistance: number; maxDistance: number }[];
  excludedElements: string[];
}
export const DEFAULT_EMPIRICAL_BOND_PARAMETERS: EmpiricalBondPerceptionParameters = {
  minDistanceFactor: .60, maxDistanceFactor: 1.20, bondOrderMode: 'auto-organic', pairOverrides: [], excludedElements: [],
};
export const elementPairKey = (a: string, b: string): string => [a, b].sort().join(':');
export function validateEmpiricalBondParameters(value: EmpiricalBondPerceptionParameters): EmpiricalBondPerceptionParameters {
  if (!value || !Number.isFinite(value.minDistanceFactor) || !Number.isFinite(value.maxDistanceFactor)
      || value.minDistanceFactor < 0 || value.maxDistanceFactor <= value.minDistanceFactor || value.maxDistanceFactor > 3
      || !['auto-organic', 'connectivity-only'].includes(value.bondOrderMode)
      || !Array.isArray(value.pairOverrides) || !Array.isArray(value.excludedElements)) throw new Error('成键距离上下限或键型方式无效。');
  const symbol = (entry: unknown): entry is string => typeof entry === 'string' && /^[A-Z][a-z]?$/.test(entry);
  if (!value.excludedElements.every(symbol) || new Set(value.excludedElements).size !== value.excludedElements.length) throw new Error('排除元素无效或重复。');
  const seen = new Set<string>();
  for (const entry of value.pairOverrides) {
    if (!entry || !Array.isArray(entry.elements) || entry.elements.length !== 2 || !entry.elements.every(symbol)
        || !Number.isFinite(entry.minDistance) || !Number.isFinite(entry.maxDistance) || entry.minDistance < 0
        || entry.maxDistance <= entry.minDistance || entry.maxDistance > 20) throw new Error('元素对距离需满足 0 ≤ 下限 < 上限 ≤ 20 Å。');
    const key = elementPairKey(...entry.elements);
    if (seen.has(key)) throw new Error('同一元素对只能设置一项距离覆盖。');
    seen.add(key);
  }
  return structuredClone(value);
}
export function empiricalPairBounds(parameters: EmpiricalBondPerceptionParameters, a: string, b: string, radiusSum: number): [number, number] | null {
  if (parameters.excludedElements.includes(a) || parameters.excludedElements.includes(b)) return null;
  const override = parameters.pairOverrides.find(entry => elementPairKey(...entry.elements) === elementPairKey(a, b));
  return override ? [override.minDistance, override.maxDistance] : [Math.max(.35, radiusSum * parameters.minDistanceFactor), radiusSum * parameters.maxDistanceFactor];
}
