import type { Structure } from '../../core/types';
import { formatAtomSelection, parseAtomSelection } from '../../core/structures';
import { inputSelectionIndices } from '../../core/input-selection';

export type AtomSelectionTextResult = { status: 'valid'; atomIds: string[] } | { status: 'incomplete' | 'invalid'; message: string };

/** Numbering is display-only. Resolve each complete edit to the current stable IDs. */
export function parseAtomSelectionText(text: string, structure: Structure): AtomSelectionTextResult {
  const normalized = text.trim().replace(/，/g, ',');
  if (normalized && /(?:\d\s*-\s*|,)$/u.test(normalized)) return { status: 'incomplete', message: '编号尚未完整，保留上次有效选择。' };
  try {
    // Validate the complete ID list too, including an empty-number edit.
    inputSelectionIndices(structure, structure.atoms.map(atom => atom.id ?? ''));
    return { status: 'valid', atomIds: parseAtomSelection(normalized, structure.atoms.length).map(index => structure.atoms[index].id!) };
  } catch (cause) { return { status: 'invalid', message: cause instanceof Error ? cause.message : String(cause) }; }
}

export function selectedAtomNumbers(structure: Structure, atomIds: readonly string[]): string {
  return formatAtomSelection(inputSelectionIndices(structure, atomIds));
}

/** Geometry/view edits keep seeds. A new document, ID order or explicit chemical
 * graph invalidates them; never infer an edge from coordinates or auxiliary lines. */
export function atomSelectionGraphKey(documentId: string, structure: Structure): string {
  return JSON.stringify([documentId, structure.id, structure.atoms.map(atom => [atom.id, atom.element, atom.formalCharge ?? 0]),
    (structure.bonds ?? []).map(bond => [bond.a, bond.b, bond.order, bond.kind ?? 'covalent', bond.aromatic ?? false, bond.fractional ?? false, bond.stereo ?? 0, bond.image ?? [0, 0, 0]])]);
}

/** Fixed multiseed BFS on explicit Bond endpoints. Every chemical edge costs
 * one step, independent of bond order; periodic endpoints remain existing IDs. */
export function expandAtomSelectionByBonds(structure: Structure, seedIds: readonly string[], depth: number): string[] {
  if (!Number.isInteger(depth) || depth < 0 || depth > 4) throw new Error('键选深度须为0–4之间的整数。');
  const seeds = [...new Set(seedIds)], indices = inputSelectionIndices(structure, seeds);
  const neighbors = structure.atoms.map(() => new Set<number>());
  for (const bond of structure.bonds ?? []) {
    if (!Number.isInteger(bond.a) || !Number.isInteger(bond.b) || bond.a < 0 || bond.b < 0 || bond.a >= neighbors.length || bond.b >= neighbors.length) throw new Error('现有化学键图引用了失效原子。');
    neighbors[bond.a].add(bond.b); neighbors[bond.b].add(bond.a);
  }
  const seen = new Set(indices); let frontier = indices;
  for (let step = 0; step < depth && frontier.length; step++) {
    const next: number[] = [];
    for (const index of frontier) for (const neighbor of neighbors[index]) if (!seen.has(neighbor)) { seen.add(neighbor); next.push(neighbor); }
    frontier = next;
  }
  return structure.atoms.flatMap((atom, index) => seen.has(index) ? [atom.id!] : []);
}
