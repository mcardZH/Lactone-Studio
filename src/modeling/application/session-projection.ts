import type { Structure } from '../../core/types';
import { builderApplyResult, commitBuilderTransaction, createBuilderDraft, type BuilderAssignments } from '../../core/builder-draft';
import type { ModelCoordinate, ModelDocument } from '../contracts';

/** Electronic-state writes do not create an Undo revision. They nevertheless
 * change the shared structure consumed by both input writers and task sources. */
export function sessionProjectionKey(document:ModelDocument):string {
  return JSON.stringify([document.id,document.revision,document.draft.structure.charge??null,document.draft.structure.multiplicity??null,document.electronicStateConfirmed??false]);
}

export function projectSessionAtomSelection(document: ModelDocument): number[] {
  if (!document.selection.atomIds.length) return [];
  const byId = new Map(document.draft.structure.atoms.map((atom, index) => [atom.id, index]));
  return document.selection.atomIds.flatMap(id => {
    const index = byId.get(id);
    return index === undefined ? [] : [index];
  });
}

/** Selection-only transactions leave the structure projection key unchanged.
 * Renumbering increments the revision and may change the selected indices. */
export function changedSessionAtomSelection(previous: ModelDocument, current: ModelDocument): number[] | undefined {
  const before = previous.selection.atomIds, after = current.selection.atomIds;
  if (previous.id === current.id && previous.revision === current.revision && before.length === after.length
    && before.every((id, index) => id === after[index])) return undefined;
  return projectSessionAtomSelection(current);
}

/** An editable empty document is not an input-file geometry. Keep the canonical
 * empty structure in the model store, but expose null to both formal writers. */
export function formalInputStructure(structure:Structure|null):Structure|null {
  return structure?.atoms.length ? structure : null;
}

/** The Store owns electronic-state reconciliation with physical edits. A view
 * revision or its private confirmation flag never rewrites a chosen q/M. */
export function projectSessionElectronicState(
  _previous:Pick<ModelDocument,'id'|'revision'>,
  document:ModelDocument,
  _previousStructure:Structure|null,
  nextStructure:Structure,
  current:{charge:number;multiplicity:number},
  _preserveMultiplicity:boolean,
):{charge:number;multiplicity:number} {
  return {
    charge:document.draft.structure.charge??nextStructure.charge??current.charge,
    multiplicity:document.draft.structure.multiplicity??nextStructure.multiplicity??current.multiplicity,
  };
}

/** Rebase the shared geometry onto each engine's own stable-ID memberships.
 * This is a projection of one document, never another editable model store. */
export function projectSessionModel(document: ModelDocument, previous: Structure | null, assignments: BuilderAssignments, coordinates: ModelCoordinate[], active: boolean) {
  const base = createBuilderDraft(previous, assignments);
  // ModelStore already owns the authoritative stereo baseline, including
  // deliberate manual inversions. Engine projections retain its exact tags;
  // they still validate/rebase memberships but must not infer stereo again.
  const draft = commitBuilderTransaction(base, document.draft.structure, document.draft.touchedIds, document.draft.createdFrom, false);
  const currentElements = new Map(draft.structure.atoms.map(atom => [atom.id, atom.element]));
  const replaced = new Set(previous?.atoms.filter(atom => atom.id && currentElements.get(atom.id) !== atom.element).map(atom => atom.id!));
  const retainsAtom = (id: string) => currentElements.has(id) && !replaced.has(id);
  if (active) draft.assignments = structuredClone(document.draft.assignments);
  else draft.assignments.frozenAtomIds = draft.assignments.frozenAtomIds.filter(retainsAtom);
  const result = builderApplyResult(draft);
  // Source coordinates may have been inferred when opening a file; stale-base
  // validation still compares against exactly the engine's current projection.
  if (previous) {
    result.baseStructure = structuredClone(previous);
    result.baseAtomIds = previous.atoms.map(a => a.id!);
    result.baseRevision = previous.revision ?? 0;
  }
  return { ...result, internalCoordinates: structuredClone(active ? document.internalCoordinates ?? [] : coordinates.filter(c =>
      c.atomIds.every(id => c.action === 'freeze' ? retainsAtom(id) : currentElements.has(id)))),
    ...(document.gaussianBasisState!==undefined?{gaussianBasisState:structuredClone(document.gaussianBasisState)}:{}),
    ...(document.gaussianBoundCoordinates!==undefined?{gaussianBoundCoordinates:structuredClone(document.gaussianBoundCoordinates),coordinateObjects:structuredClone(document.coordinateObjects??[])}:{}) };
}
