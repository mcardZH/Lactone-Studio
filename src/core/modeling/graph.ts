import type { Bond, Structure, Vector3 } from '../types';
import type { BondRef, DeletedBond, ModelDocument } from '../../modeling/contracts';
import type { BuilderAssignment } from '../builder-draft';
import { getInputLayerDraftRole, migrateInputLayerDraft, isInputLayerDraft } from '../input-layer-capability';
import { clearBondEvidence } from '../bond-semantics';

export const unique = <T,>(values: readonly T[]): T[] => [...new Set(values)];
export const clone = <T,>(value: T): T => structuredClone(value);
export const emptySelection = () => ({ atomIds: [], bonds: [], auxiliaryIds: [] });
/** Draft semantics are independent of regenerated IDs. Refuse malformed roles
 * rather than silently losing the capability gate when cloning a layer. */
export function checkedInputLayerDraft<T extends BuilderAssignment>(layer:T):T {
  const role=getInputLayerDraftRole(layer);
  if(role.status==='invalid')throw new Error(role.error);
  return migrateInputLayerDraft(clone(layer));
}

export function atomIndex(structure: Structure, id: string): number {
  const index = structure.atoms.findIndex(atom => atom.id === id);
  if (index < 0) throw new Error(`原子 ${id} 已不存在。`);
  return index;
}

export function bondKey(ids: readonly [string, string], image: Vector3 = [0, 0, 0]): string {
  const reverse = ids[0] > ids[1] || ids[0] === ids[1] && (image.find(value=>value!==0)??0)<0;
  return JSON.stringify([...(reverse ? [ids[1], ids[0]] : ids), image.map(value => reverse ? -value : value)]);
}

export function bondReference(structure: Structure, bond: Bond): BondRef {
  const a = structure.atoms[bond.a]?.id, b = structure.atoms[bond.b]?.id;
  if (!a || !b) throw new Error('键端点身份不完整。');
  return { kind: 'bond', atomIds: [a, b], ...(bond.image ? { image: clone(bond.image) } : {}) };
}

export function referenceKey(reference: Pick<BondRef | DeletedBond, 'atomIds' | 'image'>): string {
  return bondKey(reference.atomIds, reference.image);
}

export function graphFingerprint(structure: Structure): string {
  return JSON.stringify({
    atoms: structure.atoms.map(atom => [atom.id, atom.element, atom.formalCharge ?? 0, atom.aromaticHydrogen ?? false]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    bonds: (structure.bonds ?? []).map(bond => [referenceKey(bondReference(structure, bond)), bond.aromatic || bond.order === 1.5 || bond.order === 4 ? 1.5 : bond.order, bond.kind ?? 'covalent', ...(bond.fractional === true ? ['fractional'] : []), ...(bond.orderKnown===false?['unknown-order']:[])]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    cell: structure.cell ?? null, charge: structure.charge, multiplicity: structure.multiplicity,
  });
}

export function coordinatesFingerprint(structure: Structure): string {
  return JSON.stringify(structure.atoms.map(atom => [atom.id, atom.x, atom.y, atom.z]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** Auxiliary relations live outside Structure.bonds and cannot join a
 * component. An explicit coordination bond remains a real model connection. */
export function getConnectedComponent(structure: Structure, atomId: string): string[] {
  const start = atomIndex(structure, atomId), seen = new Set([start]), todo = [start];
  while (todo.length) {
    const current = todo.pop()!;
    for (const bond of structure.bonds ?? []) {
      const other = bond.a === current ? bond.b : bond.b === current ? bond.a : -1;
      if (other >= 0 && !seen.has(other)) { seen.add(other); todo.push(other); }
    }
  }
  return structure.atoms.flatMap((atom, index) => seen.has(index) ? [atom.id!] : []);
}

/** Resolve current memberships each time: attached/pasted atoms immediately inherit frozen layers. */
export function getFrozenAtomIds(document: Pick<ModelDocument, 'draft'|'sharedConstraints'>): string[] {
  const assignments = document.draft.assignments;
  const frozen = new Set([...(document.sharedConstraints?.canonical?[]:assignments.frozenAtomIds),...(document.sharedConstraints?.enabled===false?[]:document.sharedConstraints?.frozenAtomIds??[]),
    ...assignments.layers.filter(layer => layer.frozen === true).flatMap(layer => layer.atomIds)]);
  return document.draft.structure.atoms.flatMap(atom => atom.id && frozen.has(atom.id) ? [atom.id] : []);
}

export function getMovableAtomIds(document: ModelDocument, scope: 'all' | 'selection'): string[] {
  const frozen = new Set(getFrozenAtomIds(document));
  const chosen = scope === 'selection' ? new Set(document.selection.atomIds) : null;
  return document.draft.structure.atoms.flatMap(atom => !frozen.has(atom.id!) && (!chosen || chosen.has(atom.id!)) ? [atom.id!] : []);
}

/** Exact subset operation. Neither hydrogens nor boundary atoms are added. */
export function subsetStructure(structure: Structure, ids: readonly string[]): Structure {
  const chosen = new Set(ids), map = new Map<number, number>();
  const atoms = structure.atoms.filter((atom, index) => {
    if (!chosen.has(atom.id!)) return false;
    map.set(index, map.size); return true;
  });
  const bonds = (structure.bonds ?? []).filter(bond => map.has(bond.a) && map.has(bond.b)).map(bond => ({ ...bond, a: map.get(bond.a)!, b: map.get(bond.b)! }));
  const subset: Structure = { ...clone(structure), atoms: clone(atoms), bonds: clone(bonds), molfile: undefined,
    layout2D: structure.layout2D ? Object.fromEntries(Object.entries(structure.layout2D).filter(([id]) => chosen.has(id))) : undefined,
    groups: structure.groups?.map(group => ({ ...group, atomIds: group.atomIds.filter(id => chosen.has(id)) })).filter(group => group.atomIds.length),
    modelLayers: structure.modelLayers?.map(layer => ({ ...checkedInputLayerDraft(layer), atomIds: layer.atomIds.filter(id => chosen.has(id)) })).filter(layer => layer.atomIds.length || isInputLayerDraft(layer)),
    mapping: structure.mapping?.flatMap(pair => map.has(pair.current - 1) ? [{ original: pair.original, current: map.get(pair.current - 1)! + 1 }] : []),
    gaussianSource: undefined, gaussianSources: undefined, sourceRoute: undefined,
  };
  if (atoms.length !== structure.atoms.length) clearBondEvidence(subset);
  return subset;
}

export function removeAtoms(structure: Structure, removed: Set<string>): Structure {
  return subsetStructure(structure, structure.atoms.flatMap(atom => removed.has(atom.id!) ? [] : [atom.id!]));
}
