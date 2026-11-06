import type { BuilderAssignment } from '../../core/builder-draft';

export interface BasisMembershipConflict { regionId: string; label: string; atomIds: string[] }

/** Prepare a reviewable transfer without touching the store. Confirmation owns
 * only conflicting members, preserving each region's unrelated members. */
export function planBasisMembershipTransfer<T extends BuilderAssignment>(regions: readonly T[], targetId: string, atomIds: readonly string[]): { regions: T[]; conflicts: BasisMembershipConflict[] } {
  if (!targetId || new Set(regions.map(region => region.id)).size !== regions.length || !regions.some(region => region.id === targetId)) throw new Error('目标基组区域身份缺失或重复。');
  if (atomIds.some(id => !id) || new Set(atomIds).size !== atomIds.length) throw new Error('基组移交选择含缺失或重复原子身份。');
  const selected = new Set(atomIds), conflicts: BasisMembershipConflict[] = [];
  const next = regions.map(region => {
    if (region.id === targetId) return { ...structuredClone(region), atomIds: [...atomIds] };
    const members = region.atomIds.filter(id => selected.has(id));
    if (members.length) conflicts.push({ regionId: region.id, label: region.label ?? region.id, atomIds: members });
    return { ...structuredClone(region), atomIds: region.atomIds.filter(id => !selected.has(id)) };
  });
  return { regions: next, conflicts };
}
