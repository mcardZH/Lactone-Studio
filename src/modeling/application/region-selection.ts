import type { Structure } from '../../core/types';
import { inputSelectionIds, inputSelectionIndices } from '../../core/input-selection';
import { parseAtomSelection } from '../../core/structures';
import type { TaskSelectionIntent } from '../contracts';

export interface RegionMembership { id: string; atomIds: readonly string[]; label?: string }
export interface RegionSelectionPlan {
  targetId: string; atomIds: string[]; sourceSignature: string;
  conflicts: { id: string; label: string; atomIds: string[] }[];
}
export class RegionSelectionConflict extends Error {
  constructor(readonly plan: RegionSelectionPlan) {
    super(`所选原子已属于${plan.conflicts.map(row => row.label).join('、')}。确认覆盖将把这些原子转移至当前区域。`);
    this.name = 'RegionSelectionConflict';
  }
}
export function regionMembershipSignature(rows: readonly RegionMembership[]): string {
  return JSON.stringify(rows.map(row => [row.id, row.atomIds]));
}
export function regionSelectionIdentityError(structure: Structure): string | null {
  try { inputSelectionIndices(structure, structure.atoms.map(atom => atom.id!)); return null; }
  catch (cause) { return cause instanceof Error ? cause.message : '原子身份无效，请重新提供结构。'; }
}
/** Same-purpose rows only. This application operation never interprets a
 * method, charge, theory layer, coordinate, or serialization policy. */
export function planRegionSelection(structure: Structure, rows: readonly RegionMembership[], targetId: string, atomIds: readonly string[]): RegionSelectionPlan {
  inputSelectionIndices(structure, atomIds);
  if (!rows.some(row => row.id === targetId) || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('区域身份已失效或重复，请重新选择。');
  for (const row of rows) inputSelectionIndices(structure, row.atomIds);
  const chosen = new Set(atomIds);
  return { targetId, atomIds: [...atomIds], sourceSignature: regionMembershipSignature(rows), conflicts: rows.filter(row => row.id !== targetId).flatMap(row => {
    const shared = row.atomIds.filter(id => chosen.has(id));
    return shared.length ? [{ id: row.id, label: row.label ?? row.id, atomIds: shared }] : [];
  }) };
}
/** Compute a single replacement array, preserving all row metadata. No partial
 * removal is published while the caller is still waiting for confirmation. */
export function applyRegionSelection<T extends RegionMembership>(rows: readonly T[], plan: RegionSelectionPlan, overwrite: boolean, assertCurrent: () => void): T[] {
  assertCurrent();
  if (regionMembershipSignature(rows) !== plan.sourceSignature) throw new Error('区域成员已变化，请重新选择。');
  if (plan.conflicts.length && !overwrite) throw new RegionSelectionConflict(plan);
  const chosen = new Set(plan.atomIds);
  return rows.map(row => ({ ...row, atomIds: row.id === plan.targetId ? [...plan.atomIds] : row.atomIds.filter(id => !chosen.has(id)) }));
}
export function remainingRegionAtomIds(structure: Structure, rows: readonly RegionMembership[], targetId: string): string[] {
  const elsewhere = new Set(rows.filter(row => row.id !== targetId).flatMap(row => [...row.atomIds]));
  const ids = structure.atoms.map(atom => atom.id!);
  inputSelectionIndices(structure, ids);
  return ids.filter(id => !elsewhere.has(id));
}
/** Regions accept range syntax; coordinates preserve the typed/clicked order.
 * Neither path repairs duplicate or stale stable identities. */
export function parseInteractiveSelection(text: string, structure: Structure, kind: TaskSelectionIntent['kind'] = 'atoms'): string[] {
  let indices: number[];
  if (kind === 'atoms') indices = parseAtomSelection(text, structure.atoms.length);
  else {
    const tokens = text.trim().split(/[\s,，]+/).filter(Boolean);
    if (tokens.some(token => !/^\d+$/.test(token))) throw new Error('请填写有序原子编号，以逗号或空格分隔。');
    indices = tokens.map(token => Number(token) - 1);
    const required = kind === 'coordinate' ? null : { B: 2, A: 3, D: 4 }[kind];
    if (required === null ? indices.length < 2 || indices.length > 4 : indices.length !== required) throw new Error(required === null ? '请按顺序选择2、3或4个不同原子。' : `请按顺序选择${required}个不同原子。`);
  }
  if (!indices.length) throw new Error('请先选择原子。');
  const ids = inputSelectionIds(structure, indices);
  inputSelectionIndices(structure, ids);
  return ids;
}
