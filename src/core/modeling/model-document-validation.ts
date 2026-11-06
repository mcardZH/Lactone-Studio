import type { Structure, Vector3 } from '../types';
import { validateBondSemantics, validateBondPerceptionIssues } from '../bond-semantics';
import { builderCoordinateValue } from '../builder-geometry';
import { cellInverse, validatePeriodicEndpointImages } from '../periodic';
import type { ModelCoordinate, ModelDocument } from './contracts';
import { bondKey, bondReference, checkedInputLayerDraft, getFrozenAtomIds, referenceKey, unique } from './graph';
import { validateAttachmentPorts } from './attachment-ports';
import { coordinateSelectionObjects } from './coordinate-selection';
import { effectiveModelCoordinates, effectiveModelConstraints, emptySharedConstraints, retainSharedConstraints, validateSharedConstraints, validateGaussianBoundCoordinates } from '../../modeling/constraints';

/** Candidate document checks and normalization only. Publication, approvals and Undo belong to the Store. */
/** Match the native constraint contract; fixed Cartesian coordinates are
 * checked separately with Object.is and have no numeric tolerance. */
export const MODEL_CONSTRAINT_TOLERANCE = { distanceAngstrom: 1e-6, angleRadians: 1e-5 } as const;

export const finiteVector = (vector: Vector3) => Array.isArray(vector) && vector.length === 3 && vector.every(Number.isFinite);

export function validateCoordinates(coordinates: readonly ModelCoordinate[], structure: Structure): void {
  const ids = new Set(structure.atoms.map(atom => atom.id!));
  for (const coordinate of coordinates) {
    const count = coordinate.type === 'B' ? 2 : coordinate.type === 'A' ? 3 : coordinate.type === 'D' ? 4 : 0;
    if (!count || coordinate.atomIds.length !== count || coordinate.atomIds.some(id => !ids.has(id))) throw new Error('内坐标原子引用不完整或重复。');
    validatePeriodicEndpointImages(structure,coordinate.atomIds,coordinate.images);
    if (!['freeze', 'scan'].includes(coordinate.action) || !Number.isInteger(coordinate.steps) || coordinate.steps < 1) throw new Error('内坐标F/S或扫描步数/增量无效。');
    if (coordinate.source === 'orca') {
      const valid = (value: number | undefined) => value !== undefined && Number.isFinite(value) && (coordinate.type === 'B' ? value > 0 : coordinate.type === 'A' ? value > 0 && value < 180 : true);
      if (coordinate.action === 'freeze' && coordinate.value !== undefined && !valid(coordinate.value)) throw new Error('ORCA冻结目标无效。');
      if (coordinate.action === 'scan') {
        if (coordinate.values !== undefined) {
          if (!Array.isArray(coordinate.values) || coordinate.values.length < 2 || coordinate.steps !== coordinate.values.length || !coordinate.values.every(valid)
            || coordinate.values.every(value => value === coordinate.values![0]) || coordinate.start !== undefined || coordinate.end !== undefined) throw new Error('ORCA扫描数值列表无效或与范围混用。');
        } else if (!valid(coordinate.start) || !valid(coordinate.end) || coordinate.start === coordinate.end || coordinate.steps < 2) throw new Error('ORCA扫描范围无效。');
      }
    } else if (coordinate.action === 'scan' && (!Number.isFinite(coordinate.increment) || coordinate.increment === 0)) throw new Error('内坐标F/S或扫描步数/增量无效。');
  }
}

/** Manual transforms may move an unselected branch. Check actual XYZ rather
 * than the selected/touched list, and leave metadata/history untouched on failure. */
export function assertFrozenCoordinatesPreserved(document: ModelDocument, candidate: Structure): void {
  const frozen = new Set(getFrozenAtomIds(document));
  const positions = new Map(candidate.atoms.map(atom => [atom.id, atom]));
  for (const atom of document.draft.structure.atoms) {
    if (!frozen.has(atom.id!)) continue;
    const next = positions.get(atom.id);
    if (!next || !Object.is(atom.x, next.x) || !Object.is(atom.y, next.y) || !Object.is(atom.z, next.z)) throw new Error('手工变换不能改变明确冻结原子；请先调整移动范围或明确解除冻结。');
  }
  for(const coordinate of effectiveModelCoordinates(document).filter(row=>row.action==='freeze')){
    const before=builderCoordinateValue(document.draft.structure,coordinate.type,coordinate.atomIds,coordinate.images),after=builderCoordinateValue(candidate,coordinate.type,coordinate.atomIds,coordinate.images);
    const delta=coordinate.type==='D'?Math.abs(((after-before+540)%360)-180):Math.abs(after-before);
    if((coordinate.type==='B'?delta:delta*Math.PI/180)>(coordinate.type==='B'?MODEL_CONSTRAINT_TOLERANCE.distanceAngstrom:MODEL_CONSTRAINT_TOLERANCE.angleRadians))throw new Error('手工变换不能改变明确冻结的内坐标。');
  }
}

export function validateExtras(document: ModelDocument): void {
  if (document.cellCheckpoint) {
    const saved = document.cellCheckpoint;
    if ('cellCheckpoint' in saved) throw new Error('晶胞存档点不能嵌套。');
    if (saved.structure.cell) cellInverse(saved.structure.cell);
    const ids = saved.structure.atoms.map(atom => atom.id);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length || saved.structure.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) throw new Error('晶胞存档点的原子身份或坐标无效。');
    validateExtras({ ...document, ...saved, cellCheckpoint: undefined, draft: { ...document.draft, structure: saved.structure, assignments: saved.assignments } });
  }
  validateSharedConstraints(document.sharedConstraints??emptySharedConstraints(),document.coordinateObjects??[],document.draft.structure);
  validateGaussianBoundCoordinates(document.gaussianBoundCoordinates??[],document.coordinateObjects??[],document.draft.structure);
  if(document.sharedConstraints?.frozenAtomIds.length||document.sharedConstraints?.coordinates.length)effectiveModelConstraints(document);else effectiveModelCoordinates(document);
  document.draft.assignments.layers.forEach(checkedInputLayerDraft);
  document.draft.structure.modelLayers?.forEach(checkedInputLayerDraft);
  validateAttachmentPorts(document.attachmentPorts, document.draft.structure);
  for(const bond of document.draft.structure.bonds??[])validateBondSemantics(bond,document.draft.structure);
  validateBondPerceptionIssues(document.draft.structure);
  const ids = new Set(document.draft.structure.atoms.map(atom => atom.id));
  const relations = new Set<string>(), pairs = new Set<string>();
  for (const relation of document.auxiliaryRelations) {
    if (!relation.id || relations.has(relation.id) || !ids.has(relation.a) || !ids.has(relation.b) || relation.a === relation.b || relation.order !== .5 || relation.kind !== 'auxiliary') throw new Error('辅助关系身份或端点无效。');
    relations.add(relation.id);
    const pair = bondKey([relation.a, relation.b]);
    if (pairs.has(pair)) throw new Error('辅助关系重复。');
    pairs.add(pair);
  }
  for (const deleted of document.deletedBonds) {
    if (deleted.atomIds.length !== 2 || !deleted.atomIds.every(id => ids.has(id))) throw new Error('删键记录引用无效端点。');
    validatePeriodicEndpointImages(document.draft.structure, deleted.atomIds, [[0,0,0],deleted.image??[0,0,0]]);
  }
  validateCoordinates(document.internalCoordinates ?? [], document.draft.structure);
}

export function cleanDocument(document: ModelDocument): void {
  const structure = document.draft.structure, ids = new Set(structure.atoms.map(atom => atom.id!));
  const bonds = new Set((structure.bonds ?? []).map(bond => referenceKey(bondReference(structure, bond))));
  document.auxiliaryRelations = document.auxiliaryRelations.filter(relation => ids.has(relation.a) && ids.has(relation.b));
  document.deletedBonds = document.deletedBonds.filter(reference => reference.atomIds.every(id => ids.has(id)) && !bonds.has(referenceKey(reference)));
  document.internalCoordinates = (document.internalCoordinates ?? []).filter(coordinate => coordinate.atomIds.every(id => ids.has(id)));
  if(document.sharedConstraints)document.sharedConstraints=retainSharedConstraints(document.sharedConstraints,ids);
  if(document.coordinateObjects)document.coordinateObjects=document.coordinateObjects.filter(object=>object.atomIds.every(id=>ids.has(id)));
  if(document.gaussianBoundCoordinates)document.gaussianBoundCoordinates=document.gaussianBoundCoordinates.filter(row=>row.atomIds.every(id=>ids.has(id))&&(document.coordinateObjects??[]).some(object=>object.id===row.objectId));
  document.attachmentPorts = (document.attachmentPorts ?? []).filter(port => ids.has(port.hostAtomId));
  document.selection.atomIds = unique(document.selection.atomIds).filter(id => ids.has(id));
  document.selection.bonds = document.selection.bonds.filter(reference => bonds.has(referenceKey(reference)));
  const auxiliaryIds = new Set(document.auxiliaryRelations.map(relation => relation.id));
  document.selection.auxiliaryIds = unique(document.selection.auxiliaryIds).filter(id => auxiliaryIds.has(id));
  const portIds = new Set(document.attachmentPorts.map(port => port.id));
  document.selection.portIds = unique(document.selection.portIds ?? []).filter(id => portIds.has(id));
  if(document.selection.coordinateIds!==undefined){
    if(!Array.isArray(document.selection.coordinateIds)||document.selection.coordinateIds.some(id=>typeof id!=='string'))throw new Error('内坐标选区必须是稳定对象ID数组。');
    const coordinateIds=new Set(coordinateSelectionObjects(document).map(object=>object.id));
    document.selection.coordinateIds=unique(document.selection.coordinateIds).filter(id=>coordinateIds.has(id));
  }
  document.draft.selectedIds = [...document.selection.atomIds];
  validateExtras(document);
}

