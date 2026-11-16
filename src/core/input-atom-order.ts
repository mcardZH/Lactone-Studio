import type { Atom } from './types';

/** Input-only correspondence: each selected snapshot keeps its displayed order.
 * No symmetry search, alignment, atom permutation, or source mutation. */
export function inputAtomOrder(reference: readonly Atom[] | null | undefined, target: readonly Atom[] | null | undefined) {
  const mapping: { reactantId: string; productId: string }[] = [];
  if (!Array.isArray(reference) || !Array.isArray(target) || !reference.length || !target.length) return { mapping, issue: '需要两个完整结构才能按显示顺序对应。' };
  if (reference.length !== target.length) return { mapping, issue: `原子数量不一致：反应物 ${reference.length}，当前来源 ${target.length}。` };
  if (reference.some(atom => !atom?.id) || target.some(atom => !atom?.id)
    || new Set(reference.map(atom => atom.id)).size !== reference.length || new Set(target.map(atom => atom.id)).size !== target.length) return { mapping, issue: '当前结构原子身份缺失或重复，请重新选择完整来源。' };
  const mismatch = reference.findIndex((atom, index) => atom.element !== target[index].element);
  if (mismatch >= 0) return { mapping, issue: `第 ${mismatch + 1} 个原子的元素不一致：反应物 ${reference[mismatch].element}，当前来源 ${target[mismatch].element}。` };
  return { mapping: reference.map((atom, index) => ({ reactantId: atom.id!, productId: target[index].id! })), issue: null };
}
