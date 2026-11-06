import type { Structure } from './types';

/** Resolve committed IDs in current input order. Never sort a coordinate or
 * silently drop a stale member to repair a scientific selection. */
export function inputSelectionIndices(structure: Structure, atomIds: readonly string[]): number[] {
  const ids = structure.atoms.map(atom => atom.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('当前结构原子身份缺失或重复。');
  if (new Set(atomIds).size !== atomIds.length) throw new Error('选择中不能重复同一原子。');
  return atomIds.map(id => {
    const index = ids.indexOf(id);
    if (index < 0) throw new Error('选择引用了已失效的原子，请重新选择。');
    return index;
  });
}

/** Legacy form numbers are a display adapter only; persisted capture uses IDs. */
export function inputSelectionIds(structure: Structure, indices: readonly number[]): string[] {
  if (new Set(indices).size !== indices.length) throw new Error('选择中不能重复同一原子。');
  return indices.map(index => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= structure.atoms.length) throw new Error('选择原子编号越界。');
    const id = structure.atoms[index].id;
    if (!id) throw new Error('所选原子缺少稳定身份。');
    return id;
  });
}
