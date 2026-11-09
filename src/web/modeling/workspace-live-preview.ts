import type {ModelDocument} from '../../modeling/contracts';
import {effectiveSharedFreezes} from '../../modeling/constraints';
/** Copy only currently active shared F; retained disabled definitions and
 * engine-private freezes are not the initial page's active shared set. */
export function workspaceCurrentSharedFrozenAtomIds(document:Pick<ModelDocument,'sharedConstraints'>|undefined):readonly string[]{
 return document?.sharedConstraints?effectiveSharedFreezes(document.sharedConstraints).frozenAtomIds:[];
}
/** Export ownership does not make an editable initial page a static frame. */
export function workspaceLiveViewportDocument(input:{model:ModelDocument;observationOnly?:boolean;canvasDocument?:ModelDocument;useWorkspaceImageExport?:boolean;structurePreview?:ModelDocument;runtimePreview?:ModelDocument}):ModelDocument{
 const {model,canvasDocument}=input;
 if(input.observationOnly&&canvasDocument)return canvasDocument;
 return input.structurePreview??input.runtimePreview??(input.useWorkspaceImageExport&&canvasDocument?canvasDocument:model);
}
/** Soft protection adds presentation without replacing hard-freeze ownership. */
export function workspaceDisplayFrozenAtomIds(document:ModelDocument,hardAtomIds:readonly string[],softAtomIds:readonly string[]|undefined,observationOnly:boolean):string[]|undefined{
 if(softAtomIds===undefined)return observationOnly?[...hardAtomIds]:undefined;
 const ids=new Set(document.draft.structure.atoms.map(atom=>atom.id));
 return[...new Set(observationOnly?softAtomIds:[...hardAtomIds,...softAtomIds])].filter(id=>ids.has(id));
}
