import type {Structure} from '../../core/types';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import type {ModelDocument} from '../../modeling/contracts';

/** Metadata, electronic state, selection and protection are independent inputs.
 * Only geometry/topology invalidates an already captured frame here. */
export function workspaceSourceGeometryKey(structure:Structure):string{
 return JSON.stringify({atoms:structure.atoms.map(atom=>[atom.id,atom.element,atom.x,atom.y,atom.z]),bonds:structure.bonds?.map(bond=>[bond.a,bond.b,bond.order,bond.image]),cell:structure.cell,dimension:structure.dimension,periodicSource:structure.periodicSource});
}

/** Confirmation follows scientific geometry, electronic state and frame identity,
 * never camera/style or the selection of an older analysis task in the sidebar. */
export function workspaceXtbScientificFrameIdentity(value:{projectEpoch:number;documentId:string;documentEpoch:string;sourceEpoch:number;structure:Structure;frameKey:string}):string{
 return JSON.stringify([value.projectEpoch,value.documentId,value.documentEpoch,value.sourceEpoch,
  workspaceSourceGeometryKey(value.structure),value.structure.charge,value.structure.multiplicity,value.frameKey]);
}

export function workspaceRetainedSourceGeometryMatches(original:AdvancedFrameSource|undefined,source:AdvancedFrameSource):boolean{
 return Boolean(original&&JSON.stringify(original.ref)===JSON.stringify(source.ref)&&original.coordinateUnit===source.coordinateUnit&&workspaceSourceGeometryKey(original.structure)===workspaceSourceGeometryKey(source.structure));
}

/** Project current shared protection only onto the same owner's scientific
 * geometry. Display fitting/preview remains untouched; other frames keep their
 * own immutable protection rather than inheriting the working document's. */
export function workspaceCurrentProtectionDocument(observed:ModelDocument,current:ModelDocument,scientificStructure:Structure=observed.draft.structure):ModelDocument{
 if(observed.id!==current.id||observed.sharedConstraints===current.sharedConstraints)return observed;
 const owner=current.draft.structure;
 if(scientificStructure!==owner&&(scientificStructure.atoms.length!==owner.atoms.length||scientificStructure.atoms.some((atom,index)=>{
  const source=owner.atoms[index];return atom.id!==source.id||atom.element!==source.element||atom.x!==source.x||atom.y!==source.y||atom.z!==source.z;
 })||workspaceSourceGeometryKey(scientificStructure)!==workspaceSourceGeometryKey(owner)))return observed;
 return{...observed,sharedConstraints:current.sharedConstraints};
}
