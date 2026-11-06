import type { FragmentSnapshot, ModelDocument, StructureTransformCandidate } from './contracts';
import { mapStructureTransformContext, mapStructureTransformDocument } from './structure-transform-document';
import type { WorkspaceContext } from '../../modeling/workspace-contracts';

/** Pure preflight: all mapping validation finishes before a new tab is created. */
export function prepareDerivedStructure(document:ModelDocument,candidate:StructureTransformCandidate,contexts:Partial<Record<'gaussian'|'orca',WorkspaceContext>>={}) {
  const mapped=mapStructureTransformDocument(document,candidate);
  const nextContexts:Partial<Record<'gaussian'|'orca',WorkspaceContext>>={};
  for(const engine of ['gaussian','orca'] as const)if(contexts[engine])nextContexts[engine]=mapStructureTransformContext(document,candidate,contexts[engine]!);
  const structure=structuredClone(mapped.draft.structure);
  if(document.draft.structure.periodicWorkingSource&&!structure.periodicWorkingSource)structure.periodicWorkingSource=structuredClone(document.draft.structure.periodicWorkingSource);
  // Source job records remain on the parent and lineage snapshot. They must not
  // become defaults, restored freezes, or valid calculation data in the child.
  delete structure.gaussianSource;delete structure.gaussianSources;delete structure.orcaSource;
  delete structure.sourceRoute;delete structure.molfile;delete structure.preparation;
  structure.bonds=structure.bonds?.map(({mbo,...bond})=>bond);
  const fragment:FragmentSnapshot={structure,assignments:mapped.draft.assignments,
    internalCoordinates:mapped.internalCoordinates??[],auxiliaryRelations:mapped.auxiliaryRelations,deletedBonds:mapped.deletedBonds,
    sharedConstraints:mapped.sharedConstraints,coordinateObjects:mapped.coordinateObjects,
    gaussianBoundCoordinates:mapped.gaussianBoundCoordinates,attachmentPorts:mapped.attachmentPorts};
  return {fragment,contexts:nextContexts,electronicStateConfirmed:mapped.electronicStateConfirmed===true};
}

/** Excludes revision, camera, selection, save baseline and transient results. */
export function derivedDocumentContent(document:ModelDocument):string {
  const structure=structuredClone(document.draft.structure);delete structure.revision;
  return JSON.stringify([structure,document.draft.assignments,document.electronicStateConfirmed===true,
    document.internalCoordinates,document.sharedConstraints,document.coordinateObjects,document.gaussianBoundCoordinates,
    document.attachmentPorts,document.auxiliaryRelations,document.deletedBonds]);
}
