interface DocumentIdentity {id:string;epoch:string}
/** A late transport rejection belongs only to the still-registered document
 * epoch and exact adapter instance. Unavailable current owners still report. */
export function workspaceOwnerCallbackCurrent(expected:DocumentIdentity,owner:object,currentDocument:DocumentIdentity|undefined,currentOwner:object|undefined,status:string):boolean{
 return Boolean(currentDocument&&currentDocument.id===expected.id&&currentDocument.epoch===expected.epoch&&currentOwner===owner&&status!=='disposed');
}
