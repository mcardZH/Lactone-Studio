import type {Structure} from '../../core/types';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import type {ModelDocument} from '../../modeling/contracts';

/** Metadata, electronic state, selection and protection are independent inputs.
 * Only geometry/topology invalidates an already captured frame here. */
export function workspaceSourceGeometryKey(structure:Structure):string{
 return JSON.stringify({atoms:structure.atoms.map(atom=>[atom.id,atom.element,atom.x,atom.y,atom.z]),bonds:structure.bonds?.map(bond=>[bond.a,bond.b,bond.order,bond.image]),cell:structure.cell,dimension:structure.dimension,periodicSource:structure.periodicSource});
}

export function workspaceRetainedSourceGeometryMatches(original:AdvancedFrameSource|undefined,source:AdvancedFrameSource):boolean{
 return Boolean(original&&JSON.stringify(original.ref)===JSON.stringify(source.ref)&&original.coordinateUnit===source.coordinateUnit&&workspaceSourceGeometryKey(original.structure)===workspaceSourceGeometryKey(source.structure));
}

/** Project current shared protection only onto the same owner's scientific
 * geometry. Display fitting/preview remains untouched; other frames keep their
 * own immutable protection rather than inheriting the working document's. */
export function workspaceCurrentProtectionDocument(observed:ModelDocument,current:ModelDocument,scientificStructure:Structure=observed.draft.structure):ModelDocument{
 if(observed.id!==current.id||workspaceSourceGeometryKey(scientificStructure)!==workspaceSourceGeometryKey(current.draft.structure))return observed;
 return{...observed,sharedConstraints:current.sharedConstraints};
}
