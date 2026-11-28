import { getFrozenAtomIds } from '../../core/modeling/model-store';
import type { Structure, Vector3 } from '../../core/types';
import { inputSelectionIndices } from '../../core/input-selection';
import type { StructureTransformCandidate } from '../../core/modeling/contracts';
import type { CrystalResult } from '../../modeling/crystal-contracts';
import type { ModelDocument } from '../../modeling/contracts';
import { buildGeometryTransformEdit, initialGeometryTransformDraft, type GeometryTransformDraft } from '../modeling/GeometryTransformPanel';

export function structureSummary(structure: Structure) {
  const elements = new Map<string,number>();
  for (const {element} of structure.atoms) elements.set(element, (elements.get(element) ?? 0) + 1);
  return {
    atomCount: structure.atoms.length,
    composition: Object.fromEntries(elements),
    bondCount: structure.bonds?.length ?? 0,
    cell: structure.cell ?? null,
    geometryUnits: 'angstrom',
  };
}

function modelConditions(document: ModelDocument) {
  return {
    electronic: {
      charge: document.draft.structure.charge,
      multiplicity: document.draft.structure.multiplicity,
      confirmed: document.electronicStateConfirmed === true,
    },
    constraints: {
      effectiveFrozenAtomCount: getFrozenAtomIds(document).length,
      sharedFreezesEnabled: document.sharedConstraints?.enabled,
      sharedCoordinateFreezeCount: document.sharedConstraints?.coordinates.length ?? 0,
      internalCoordinateCount: document.internalCoordinates?.length ?? 0,
    },
  };
}

export function transformProduct(source: ModelDocument, output: ModelDocument) {
  return {
    ...structureSummary(output.draft.structure),
    ...modelConditions(output),
    sourceConditions: modelConditions(source),
  };
}

export function crystalTransformSummary(result: CrystalResult | undefined) {
  if (!result) return undefined;
  const { details, operation, miller, normal, interplanarSpacing } = result;
  if (!details?.symmetry || !('equivalentAtoms' in details.symmetry)) return {operation,miller,normal,interplanarSpacing,details};
  const { equivalentAtoms, ...symmetry } = details.symmetry;
  return {operation,miller,normal,interplanarSpacing,details:{...details,symmetry, equivalentAtomCount:equivalentAtoms.length}};
}

export function transformMapping(atomMapping: StructureTransformCandidate['atomMapping'], ids?: string[]) {
  if (!ids) return atomMapping;
  const source = new Set(ids);
  return atomMapping.filter(row=>source.has(row.sourceAtomId)||row.sourceAtomIds?.some(id=>source.has(id)));
}

/** Resolve stable IDs through the same reference handling used by the model panel. */
export function referencedGeometryEdit(
  edit: { type: 'rotate'; degrees: number; axis?: Vector3 } | { type: 'align'; to: Vector3; from?: Vector3 } | { type: 'mirror'; normal?: Vector3 },
  structure: Structure,
  references: { pivotAtomId?: string; axisAtomIds?: string[]; fromAtomIds?: string[]; planeAtomIds?: string[] },
  pivot?: Vector3,
  atomIds?: string[],
) {
  const indices = (atomIds: string[]) => inputSelectionIndices(structure, atomIds).map(index=>index+1).join(' ');
  const {pivotAtomId,axisAtomIds,fromAtomIds,planeAtomIds} = references;
  const draft: GeometryTransformDraft = {
    ...initialGeometryTransformDraft,
    operation: edit.type,
    scope: atomIds ? 'selected' : 'all',
    pivot: (pivot ?? [0,0,0]).join(' '),
    ...(pivotAtomId ? {pivotMode:'atom',pivotAtom:indices([pivotAtomId])} : {}),
  };
  if (edit.type === 'rotate') {
    draft.rotationMode = axisAtomIds ? 'bond' : 'vector';
    draft.bond = axisAtomIds ? indices(axisAtomIds) : draft.bond;
    draft.axis = edit.axis?.join(' ') ?? draft.axis;
    draft.degrees = String(edit.degrees);
  }
  if (edit.type === 'align') {
    draft.alignmentSource = fromAtomIds ? fromAtomIds.length === 2 ? 'pair' : 'plane' : 'vector';
    draft.referenceAtoms = fromAtomIds ? indices(fromAtomIds) : undefined;
    draft.from = edit.from?.join(' ') ?? draft.from;
    draft.to = edit.to.join(' ');
  }
  if (edit.type === 'mirror') {
    draft.mirrorMode = planeAtomIds ? 'atoms' : 'normal';
    draft.referenceAtoms = planeAtomIds ? indices(planeAtomIds) : undefined;
    draft.axis = edit.normal?.join(' ') ?? draft.axis;
  }
  const resolved = buildGeometryTransformEdit(draft, structure, atomIds ?? []);
  // The MCP vector forms default to the native core pivot. A bond or plane
  // reference already supplies its own pivot through the panel's builder.
  if (!pivot && !pivotAtomId && !axisAtomIds && !planeAtomIds && 'pivot' in resolved) delete resolved.pivot;
  return resolved;
}
