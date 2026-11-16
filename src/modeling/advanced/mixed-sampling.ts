import type { Structure } from '../../core/types';
import { compareConformerGeometry } from '../conformers/clustering';
import { captureAdvancedFrame, assertAdvancedIsolated, type AdvancedFrameSource } from './frame-source';
import { graphFingerprint, coordinatesFingerprint } from '../../core/modeling/graph';
import { reindexStructureAtoms } from '../../core/modeling/graph-reindex';

/** Stable IDs from the same document take priority; other sources retain the
 * explicit element-order contract, never an inferred element permutation fit. */
export function captureMixedInitial(source: AdvancedFrameSource, parent: AdvancedFrameSource, editableCanonical = false) {
  assertAdvancedIsolated(source);
  if(editableCanonical){
    const structure={...source.structure,charge:parent.structure.charge,multiplicity:parent.structure.multiplicity};
    return {atomMapping:structure.atoms.map(atom=>({sourceAtomId:atom.id!,taskAtomId:atom.id!})),source:captureAdvancedFrame(structure,source.ref,
      {...source.stamp,graphFingerprint:graphFingerprint(structure)},source.label,source.constraints)};
  }
  const canonical = parent.structure.atoms;
  const original = source.structure.atoms;
  const byId = new Map(original.map((atom,index)=>[atom.id!,index]));
  const sameDocument = source.ref.documentId === parent.ref.documentId && source.ref.documentEpoch === parent.ref.documentEpoch;
  const stableIdentity = sameDocument && original.length === canonical.length && canonical.every(atom=>byId.has(atom.id!));
  const order = canonical.map((atom,index)=>stableIdentity?byId.get(atom.id!)!:index);
  if (original.length !== canonical.length || order.some((sourceIndex,index) => original[sourceIndex].element !== canonical[index].element))
    throw new Error('当前帧的原子数或逐序元素与搜索初猜不兼容。');
  const atomMapping = order.map((sourceIndex,index) => ({ sourceAtomId: original[sourceIndex].id!, taskAtomId: canonical[index].id! }));
  const mapping = new Map(atomMapping.map(pair => [pair.sourceAtomId, pair.taskAtomId]));
  const structure = stableIdentity?reindexStructureAtoms(source.structure,canonical.map(atom=>atom.id!)):structuredClone(source.structure);
  structure.atoms = structure.atoms.map((atom,index) => ({ ...atom, id: canonical[index].id, sourceIndex: canonical[index].sourceIndex }));
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
