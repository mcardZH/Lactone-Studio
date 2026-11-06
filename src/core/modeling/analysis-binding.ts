import type { Structure } from '../types';
import { createBuilderDraft, type BuilderDraft } from '../builder-draft';
import { graphFingerprint, coordinatesFingerprint } from './graph';

/** This gate detects scientific changes, not camera, selections, task
 * assignments, freezes or bookkeeping revisions. Atom ordering is included:
 * source tables and wavefunction coefficients retain their source indices. */
export function analysisGeometryChanged(before: Structure, after: Structure): boolean {
  return graphFingerprint(before) !== graphFingerprint(after)
    || coordinatesFingerprint(before) !== coordinatesFingerprint(after)
    || JSON.stringify(before.atoms.map(atom => [atom.id, atom.stereoParity ?? 0])) !== JSON.stringify(after.atoms.map(atom => [atom.id, atom.stereoParity ?? 0]))
    || JSON.stringify((before.bonds ?? []).map(bond => [bond.a, bond.b, bond.stereo ?? 0])) !== JSON.stringify((after.bonds ?? []).map(bond => [bond.a, bond.b, bond.stereo ?? 0]));
}

/** Validate using the existing model validator, but do not adopt the builder's
 * inferred graph/layout/atom hints in place of an already resolved source. */
export function analysisSourceDraft(structure: Structure, bindingId: string): BuilderDraft {
  if (typeof bindingId !== 'string' || !bindingId.trim()) throw new Error('后处理绑定身份不能为空。');
  const ids = structure.atoms.map(atom => atom.id);
  if (!ids.length || ids.some(id => !id) || new Set(ids).size !== ids.length || !Array.isArray(structure.bonds)) throw new Error('后处理模型需要固定原子身份及已解析的显示键。');
  const draft = createBuilderDraft(structure);
  draft.structure = structuredClone(structure);
  draft.baseStructure = structuredClone(structure);
  draft.baseAtomIds = ids as string[];
  return draft;
}

export class ScientificEditCancelledError extends Error {
  readonly code = 'scientific-edit-cancelled';
  constructor() { super('已取消模型修改；后处理信息保持不变。'); this.name = 'ScientificEditCancelledError'; }
}
