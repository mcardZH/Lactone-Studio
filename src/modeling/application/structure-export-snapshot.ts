import type {Structure} from '../../core/types';
import type {ModelDocument} from '../contracts';

const sealed=new WeakSet<ModelDocument>();

/** Trusted immutable frame projection: no data copy before an actual export
 * consumer needs the frame. Source assets and editing/history trees are absent. */
export function projectStructureExportDocument(owner:ModelDocument,geometry:Structure=owner.draft.structure,displayAtoms?:Structure['atoms']):ModelDocument {
  const {id,name,format,charge,multiplicity,dimension,cell,periodicSource,periodicWorkingSource}=geometry,atoms=displayAtoms??geometry.atoms;
  const structure:Structure={id,name,format,atoms,charge,multiplicity,dimension,notes:[],cell,periodicSource,periodicWorkingSource};
  const assignments={layers:[],basis:[],fragments:[],frozenAtomIds:[]};
  return{id:owner.id,revision:owner.revision,
    draft:{structure,assignments,revision:owner.revision,selectedIds:[],touchedIds:[],assignmentIssues:[],createdFrom:{},past:[],future:[],dirty:false,
      baseAtomIds:[],baseStructure:structure,baseAssignments:assignments},
    selection:{atomIds:[],bonds:[],auxiliaryIds:[]},auxiliaryRelations:[],deletedBonds:[],canUndo:false,canRedo:false};
}

/** Geometry interchange needs no Undo tree, source input text, computation
 * assets, model selections, or editing definitions. Copy its supported geometry
 * once; all dialogs and serializers retain this same private snapshot. */
export function captureStructureExportDocument(owner:ModelDocument,geometry:Structure=owner.draft.structure,displayAtoms?:Structure['atoms']):ModelDocument {
  if(sealed.has(owner)&&geometry===owner.draft.structure&&(!displayAtoms||displayAtoms===geometry.atoms))return owner;
  const projection=projectStructureExportDocument(owner,geometry,displayAtoms),structure=structuredClone(projection.draft.structure);
  const snapshot={...projection,draft:{...projection.draft,structure,baseStructure:structure}};
  sealed.add(snapshot);return snapshot;
}
