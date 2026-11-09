import type {ModelDocument} from './contracts';

// Ephemeral publication lineage: never serialized or recovered by matching XYZ.
const lineages=new WeakMap<ModelDocument,object>();
const scientificKeys=new WeakMap<ModelDocument,string>();
function lineage(document:ModelDocument):object{let value=lineages.get(document);if(!value){value={};lineages.set(document,value);}return value;}
function scientificKey(document:ModelDocument):string{
 const cached=scientificKeys.get(document);if(cached!==undefined)return cached;
 const {revision:_,...structure}=document.draft.structure;
 // Compare stored coordinate definitions, not a domain-derived projection.
 // Explicit F may also re-enable retained shared BADs for the next run. The
 // Store grants that lineage only to F; a standalone BAD master switch or
 // definition edit starts a new lineage and cannot reuse the old run.
 const sharedCoordinates=document.sharedConstraints?.coordinates;
 const coordinateState={
  shared:sharedCoordinates?.length?{coordinates:sharedCoordinates}:null,
  canonical:document.internalCoordinates?.some(row=>row.action==='freeze')?document.sharedConstraints?.canonical===true:null,
 };
 const key=JSON.stringify([structure,document.draft.assignments,document.auxiliaryRelations,document.deletedBonds,document.internalCoordinates,document.coordinateObjects,document.gaussianBoundCoordinates,document.gaussianBasisState,document.electronicStateConfirmed,document.attachmentPorts,coordinateState]);
 if(Object.isFrozen(document))scientificKeys.set(document,key);return key;
}
export function inheritRuntimePreviewLineage(previous:ModelDocument,next:ModelDocument):void{lineages.set(next,lineage(previous));}
/** Only the Store may extend a lineage across an explicit atom-freeze edit.
 * Equal geometry after edit -> Undo cannot revive an earlier run's preview. */
export function runtimePreviewSourceCurrent(source:ModelDocument|undefined,current:ModelDocument):boolean{
 return !!source&&source.id===current.id&&source.analysisBindingId===current.analysisBindingId
  &&(source.revision===current.revision||lineage(source)===lineage(current))&&scientificKey(source)===scientificKey(current);
}
