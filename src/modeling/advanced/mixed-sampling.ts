import type { Structure } from '../../core/types';
import { compareConformerGeometry } from '../conformers/clustering';
import { captureAdvancedFrame, assertAdvancedIsolated, type AdvancedFrameSource } from './frame-source';
import { graphFingerprint, coordinatesFingerprint } from '../../core/modeling/graph';

/** Stable element order is the admission contract, never an element permutation fit. */
export function captureMixedInitial(source: AdvancedFrameSource, parent: AdvancedFrameSource, editableCanonical = false) {
  assertAdvancedIsolated(source);
  if(editableCanonical){
    const structure={...source.structure,charge:parent.structure.charge,multiplicity:parent.structure.multiplicity};
    return {atomMapping:structure.atoms.map(atom=>({sourceAtomId:atom.id!,taskAtomId:atom.id!})),source:captureAdvancedFrame(structure,source.ref,
      {...source.stamp,graphFingerprint:graphFingerprint(structure)},source.label,source.constraints)};
  }
  const canonical = parent.structure.atoms;
  if (source.structure.atoms.length !== canonical.length || source.structure.atoms.some((atom, index) => atom.element !== canonical[index].element))
    throw new Error('当前帧的原子数或逐序元素与搜索初猜不兼容。');
  const atomMapping = source.structure.atoms.map((atom, index) => ({ sourceAtomId: atom.id!, taskAtomId: canonical[index].id! }));
  const mapping = new Map(atomMapping.map(pair => [pair.sourceAtomId, pair.taskAtomId]));
  const structure = structuredClone(source.structure);
  structure.atoms = structure.atoms.map((atom, index) => ({ ...atom, id: canonical[index].id, sourceIndex: canonical[index].sourceIndex }));
  structure.charge = parent.structure.charge; structure.multiplicity = parent.structure.multiplicity;
  if (structure.modelLayers) structure.modelLayers = structure.modelLayers.map(layer => ({ ...layer,
    atomIds: layer.atomIds?.map(id => mapping.get(id)!) }));
  const constraints = { ...structuredClone(source.constraints), frozenAtomIds: source.constraints.frozenAtomIds.map(id => mapping.get(id)!),
    coordinates: source.constraints.coordinates.map(row => ({ ...structuredClone(row), atomIds: row.atomIds.map(id => mapping.get(id)!) })) };
  return { atomMapping, source: captureAdvancedFrame(structure, source.ref, { ...source.stamp,
    graphFingerprint: graphFingerprint(structure), coordinatesFingerprint: coordinatesFingerprint(structure), constraintsFingerprint: JSON.stringify(constraints) },
  source.label, constraints) };
}

/** Old records win; compare geometry and identity only, never energies across methods. */
export function isMixedSamplingDuplicate(candidate: Structure, retained: readonly Structure[], threshold = .01,compare:(moving:Structure,reference:Structure)=>ReturnType<typeof compareConformerGeometry>=compareConformerGeometry): boolean {
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('采样去重阈值必须为有限非负数。');
  return retained.some(reference => {
    if (candidate.charge !== reference.charge || candidate.multiplicity !== reference.multiplicity) return false;
    const fit = compare(candidate, reference);
    return fit.comparable && fit.rmsdAngstrom < threshold;
  });
}
