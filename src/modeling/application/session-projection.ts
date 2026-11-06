import type { Structure } from '../../core/types';
import { builderApplyResult, commitBuilderTransaction, createBuilderDraft, type BuilderAssignments } from '../../core/builder-draft';
import type { ModelCoordinate, ModelDocument } from '../contracts';
import { builderCommittedCharge } from '../../core/builder-integration';
import { suggestedMultiplicity } from '../../core/elements';

/** Electronic-state writes do not create an Undo revision. They nevertheless
 * change the shared structure consumed by both input writers and task sources. */
export function sessionProjectionKey(document:ModelDocument):string {
  return JSON.stringify([document.id,document.revision,document.draft.structure.charge??null,document.draft.structure.multiplicity??null,document.electronicStateConfirmed??false]);
}

/** An editable empty document is not an input-file geometry. Keep the canonical
 * empty structure in the model store, but expose null to both formal writers. */
export function formalInputStructure(structure:Structure|null):Structure|null {
  return structure?.atoms.length ? structure : null;
}

/** Only a model transaction can warrant a new suggested spin. Electronic-state
 * edits deliberately have no Undo revision and must preserve even an invalid
 * explicit spin so the existing mathematical validator can reject it. */
export function projectSessionElectronicState(
  previous:Pick<ModelDocument,'id'|'revision'>,
  document:ModelDocument,
  previousStructure:Structure|null,
  nextStructure:Structure,
  current:{charge:number;multiplicity:number},
  preserveMultiplicity:boolean,
):{charge:number;multiplicity:number} {
  if(previous.id===document.id&&previous.revision===document.revision)return {
    charge:document.draft.structure.charge??current.charge,
    multiplicity:document.draft.structure.multiplicity??current.multiplicity,
  };
  const charge=builderCommittedCharge(previousStructure,nextStructure,current.charge);
  return {charge,multiplicity:preserveMultiplicity?current.multiplicity:suggestedMultiplicity(nextStructure.atoms,charge)};
}

/** Rebase the shared geometry onto each engine's own stable-ID memberships.
 * This is a projection of one document, never another editable model store. */
export function projectSessionModel(document: ModelDocument, previous: Structure | null, assignments: BuilderAssignments, coordinates: ModelCoordinate[], active: boolean) {
  const base = createBuilderDraft(previous, assignments);
  // ModelStore already owns the authoritative stereo baseline, including
  // deliberate manual inversions. Engine projections retain its exact tags;
  // they still validate/rebase memberships but must not infer stereo again.
  const draft = commitBuilderTransaction(base, document.draft.structure, document.draft.touchedIds, document.draft.createdFrom, false);
  if (active) draft.assignments = structuredClone(document.draft.assignments);
  const result = builderApplyResult(draft);
  // Source coordinates may have been inferred when opening a file; stale-base
  // validation still compares against exactly the engine's current projection.
  if (previous) {
    result.baseStructure = structuredClone(previous);
    result.baseAtomIds = previous.atoms.map(a => a.id!);
    result.baseRevision = previous.revision ?? 0;
  }
  const ids = new Set(result.structure.atoms.map(a => a.id));
  return { ...result, internalCoordinates: structuredClone(active ? document.internalCoordinates ?? [] : coordinates.filter(c => c.atomIds.every(id => ids.has(id)))),
    ...(document.gaussianBasisState!==undefined?{gaussianBasisState:structuredClone(document.gaussianBasisState)}:{}),
    ...(document.gaussianBoundCoordinates!==undefined?{gaussianBoundCoordinates:structuredClone(document.gaussianBoundCoordinates),coordinateObjects:structuredClone(document.coordinateObjects??[])}:{}) };
}
