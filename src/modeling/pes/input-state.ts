import type { Structure } from '../../core/types';
import type { PesGeometry, PesGroup, PesNode } from './contracts';

// A confirmation is scoped to its PES group. Rendering a result or projecting
// the same source into a different workspace tab must not revoke it.
export function pesElectronicSourceKey(group: PesGroup, geometry: PesGeometry): string {
  const members = geometry.structure.atoms.map(atom => [atom.id, atom.element]).sort((a,b) =>
    String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
  return JSON.stringify([group.id, members]);
}

export function pesElectronicConfirmed(group: PesGroup, geometry: PesGeometry): boolean {
  const { confirmed, sourceKey, charge, multiplicity } = group.electronic;
  if(!confirmed||confirmed.charge!==Number(charge)||confirmed.multiplicity!==Number(multiplicity))return false;
  const key=pesElectronicSourceKey(group,geometry);
  if(sourceKey!==undefined)return key===sourceKey;
  return false;
}

export function pesComposition(structure: Structure): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { element } of structure.atoms) counts[element] = (counts[element] ?? 0) + 1;
  return counts;
}

export function pesCompositionDifference(previous: Record<string, number>, next: Record<string, number>) {
  const differences: string[] = [];
  for (const element of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const delta = (next[element] ?? 0) - (previous[element] ?? 0);
    if (delta) differences.push(`${delta > 0 ? '多' : '少'} ${Math.abs(delta)} 个 ${element}`);
  }
  return differences.join('、');
}

export class PesCompositionChange extends Error {
  constructor(difference: string, readonly continueInNewGroup: () => PesNode) {
    super(`比首次提交的结构${difference}。用当前结构在新的势能面页继续？`);
    this.name = 'PesCompositionChange';
  }
}

/** The requested new group exists; keep its editable initial selected on a validation failure. */
export class PesBranchInputError extends Error {
  constructor(readonly initial: PesNode, detail: string) {
    super(detail);
    this.name = 'PesBranchInputError';
  }
}
