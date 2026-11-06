import type { Structure } from '../types';
import { clone } from './graph';

/** A numbering change is a permutation, never an atom-identity or geometry edit.
 * Source center numbers/maps are historical evidence and remain unchanged. */
export function reindexStructureAtoms(structure: Structure, orderedAtomIds: readonly string[]): Structure {
  const atoms = new Map(structure.atoms.map((atom, index) => [atom.id, { atom, index }]));
  if (atoms.size !== structure.atoms.length || structure.atoms.some(atom => !atom.id)
    || orderedAtomIds.length !== structure.atoms.length || new Set(orderedAtomIds).size !== orderedAtomIds.length
    || orderedAtomIds.some(id => !atoms.has(id))) throw new Error('重新编号必须是全部稳定原子ID的完整一对一排列。');
  const indices = new Map(orderedAtomIds.map((id, index) => [atoms.get(id)!.index, index]));
  const result = clone(structure);
  result.atoms = orderedAtomIds.map(id => clone(atoms.get(id)!.atom));
  result.bonds = structure.bonds?.map(bond => {
    if (!indices.has(bond.a) || !indices.has(bond.b)) throw new Error('原有键端点索引无效，未重新编号。');
    return { ...clone(bond), a: indices.get(bond.a)!, b: indices.get(bond.b)! };
  });
  result.mapping = structure.mapping?.map(pair => {
    if (!indices.has(pair.current - 1)) throw new Error('原有序号映射引用无效，未重新编号。');
    return { ...pair, current: indices.get(pair.current - 1)! + 1 };
  });
  // A raw molfile embeds the old atom order; retaining it would offer a stale export.
  delete result.molfile;
  return result;
}
