import type { Structure } from './types';
import { updateBuilderStereo } from './builder-stereo';

/** Adopt deliberate manual Cartesian geometry as the new stereo baseline.
 * Refresh moved centres and their direct neighbours; no automatic preservation
 * assertion belongs here. Native chemistry still validates against this result.
 * This is ordered-neighbour parity, not a new CIP assignment. */
export function refreshManualStereo(original: Structure, next: Structure, touchedIDs: readonly string[]): Structure {
  const before = new Map(original.atoms.map(atom => [atom.id, atom]));
  const after = new Map(next.atoms.map(atom => [atom.id, atom]));
  if (original.atoms.length !== next.atoms.length || before.size !== original.atoms.length || after.size !== next.atoms.length ||
      original.atoms.some(atom => !atom.id || !after.has(atom.id))) throw new Error('手工几何不能改变原子身份。');
  if (next.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) throw new Error('手工几何坐标必须有限。');
  const touched = new Set(touchedIDs);
  for (const id of touched) if (!before.has(id) || !after.has(id)) throw new Error('手工几何目标已不存在。');
  const affected = new Set(touched);
  for (const structure of [original, next]) for (const bond of structure.bonds ?? []) {
    if (bond.kind === 'coordination') continue;
    const a = structure.atoms[bond.a]?.id, b = structure.atoms[bond.b]?.id;
    if (a && b && (touched.has(a) || touched.has(b))) { affected.add(a); affected.add(b); }
  }
  // A wedge can be stored from either endpoint. Include an untouched annotated
  // centre whose wedge must be regenerated after an affected neighbouring centre.
  for (const bond of next.bonds ?? []) if (bond.stereo === 1 || bond.stereo === 6) {
    const a = next.atoms[bond.a], b = next.atoms[bond.b];
    if (affected.has(a.id!) || affected.has(b.id!)) {
      if (a.stereoParity) affected.add(a.id!);
      if (b.stereoParity) affected.add(b.id!);
    }
  }
  return { ...updateBuilderStereo(next, [...affected]).structure, molfile: undefined };
}
