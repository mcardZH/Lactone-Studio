import type { Structure } from '../../core/types';
import type { WorkspaceDocumentEntry } from '../workspace-registry';
import type { PesGroup } from './contracts';

export function isOrdinaryPesTabCandidate(entry: WorkspaceDocumentEntry): boolean {
  return !entry.pesGroup && !entry.conformerGroup && !entry.trajectory && !entry.result && !entry.legacyResult && !entry.analysisBinding;
}

/** Admission compares ordered elements only. Card submission owns scientific
 * validation such as periodicity and the selected electronic state. */
export function pesTabAdmissionIssue(group: PesGroup, structure: Structure): string | undefined {
  const initial = group.initialElementSequence ??
    group.nodes.find(node => node.id === group.initialNodeId)?.geometry.structure.atoms.map(atom => atom.element);
  if (!initial) return '势能面组的初始结构尚未就绪。';
  if (structure.atoms.length !== initial.length)
    return `原子数与势能面组初始结构不同（当前 ${structure.atoms.length}，初始 ${initial.length}）。`;
  const index = structure.atoms.findIndex((atom, offset) => atom.element !== initial[offset]);
  if (index >= 0)
    return `第 ${index + 1} 号原子的元素与势能面组初始结构不同（当前 ${structure.atoms[index].element}，初始 ${initial[index]}）。`;
}
