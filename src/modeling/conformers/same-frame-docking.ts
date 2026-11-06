import type { AdvancedFrameSource } from '../advanced/frame-source';
import { captureAdvancedFrame } from '../advanced/frame-source';
import type { AdvancedSameFrameFragments } from '../advanced/contracts';
import { graphFingerprint, coordinatesFingerprint } from '../../core/modeling/graph';
import { atomicNumber } from '../../core/elements';

/** AB is the scientific subsystem; unselected atoms remain only in the original
 * immutable source. No bonds, fragment charge or multiplicity are inferred. */
export function prepareSameFrameDocking(source: AdvancedFrameSource, fragments: AdvancedSameFrameFragments) {
  const ids = new Set(source.structure.atoms.map(atom => atom.id!)), a = new Set(fragments.aAtomIds), b = new Set(fragments.bAtomIds);
  if (!a.size || !b.size || a.size !== fragments.aAtomIds.length || b.size !== fragments.bAtomIds.length
    || [...a, ...b].some(id => !ids.has(id)) || [...a].some(id => b.has(id))) throw new Error('A/B需来自同一帧、非空、无重复且互不重叠。');
  if (!Array.isArray(fragments.electronicStates) || fragments.electronicStates.length !== 2
    || fragments.electronicStates.some(state => state?.charge !== 0 || state.multiplicity !== 1)) throw new Error('请分别明确确认两个片段为中性闭壳层；未从完整体系猜测q/M。');
  const membership = (id: string) => a.has(id) ? 0 : b.has(id) ? 1 : 2;
  for (const bond of source.structure.bonds ?? []) if (membership(source.structure.atoms[bond.a].id!) !== membership(source.structure.atoms[bond.b].id!)) throw new Error('A/B或未参与部分之间有跨片段连接，不能静默截断。');
  const participating = new Set([...a, ...b]);
  if (source.constraints.frozenAtomIds.some(id => participating.has(id)) || source.constraints.coordinates.some(row => row.atomIds.some(id => participating.has(id)))
    || source.structure.modelLayers?.some(layer => layer.frozen && layer.atomIds.some(id => participating.has(id)))) throw new Error('参与对接片段的冻结尚无等价适配，不能静默丢弃。');
  const mapping: { sourceAtomId: string; frameAtomIndex: number; fragmentIndex: 0 | 1; fragmentAtomIndex: number }[] = [];
  const sources = [a, b].map((selected, fragmentIndex) => {
    const indices = source.structure.atoms.map((_, i) => i).filter(i => selected.has(source.structure.atoms[i].id!));
    const remap = new Map(indices.map((oldIndex, newIndex) => [oldIndex, newIndex]));
    const atoms = indices.map((index, fragmentAtomIndex) => { const atom = source.structure.atoms[index]; mapping.push({ sourceAtomId: atom.id!, frameAtomIndex: index, fragmentIndex: fragmentIndex as 0 | 1, fragmentAtomIndex }); return structuredClone(atom); });
    const electrons = atoms.reduce((sum, atom) => sum + atomicNumber(atom.element), 0);
    if (!electrons || electrons % 2) throw new Error('片段电子数不符合当前中性闭壳层aISS适用范围。');
    const structure = { ...structuredClone(source.structure), atoms, bonds: (source.structure.bonds ?? []).filter(edge => remap.has(edge.a) && remap.has(edge.b)).map(edge => ({ ...structuredClone(edge), a: remap.get(edge.a)!, b: remap.get(edge.b)! })),
      id: `${source.structure.id}-fragment-${fragmentIndex}`, name: `${source.structure.name} ${fragmentIndex === 0 ? 'A' : 'B'}`, sourceAtomIds: atoms.map(atom => atom.id!), charge: 0, multiplicity: 1,
      modelLayers: undefined, molfile: undefined, preparation: undefined };
    return captureAdvancedFrame(structure, source.ref, { ...source.stamp, graphFingerprint: graphFingerprint(structure), coordinatesFingerprint: coordinatesFingerprint(structure), constraintsFingerprint: JSON.stringify({ frozenAtomIds: [], coordinates: [] }) }, structure.name);
  }) as [AdvancedFrameSource, AdvancedFrameSource];
  return { sources, mapping, remainingAtomIds: source.structure.atoms.filter(atom => !participating.has(atom.id!)).map(atom => atom.id!) };
}
export function remainingDockingAtomIds(source: AdvancedFrameSource, aAtomIds: readonly string[]): string[] {
  const chosen = new Set(aAtomIds), ids = new Set(source.structure.atoms.map(atom => atom.id!));
  if (!chosen.size || chosen.size !== aAtomIds.length || [...chosen].some(id => !ids.has(id))) throw new Error('A片段定义无效。');
  return source.structure.atoms.filter(atom => !chosen.has(atom.id!)).map(atom => atom.id!);
}
