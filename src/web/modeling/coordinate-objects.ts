import type { MeasurementRecord, MeasurementSession, ModelCoordinateObject, ModelDocument, ModelStore } from '../../modeling/contracts';
import { associatedWithObject, modelCoordinateKey } from '../../modeling/constraints';
import { retainMeasurementSession } from './measurement-state';
import { coordinateSelectionObjects } from '../../core/modeling/coordinate-selection';

export function recordObject(record:MeasurementRecord):ModelCoordinateObject {
  return {id:record.id,type:record.mode==='distance'?'B':record.mode==='angle'?'A':'D',atomIds:[...record.atomIds],...(record.images?{images:structuredClone(record.images)}:{})};
}
export function coordinateRecord(object:ModelCoordinateObject,color='#2374d1'):MeasurementRecord {
  return {id:object.id,mode:object.type==='B'?'distance':object.type==='A'?'angle':'dihedral',atomIds:[...object.atomIds],...(object.images?{images:structuredClone(object.images)}:{}),color};
}
/** Task coordinates remain visible even before the user gives them a standalone BAD identity. */
export function displayedCoordinateObjects(document:ModelDocument):ModelCoordinateObject[] {
  return coordinateSelectionObjects(document);
}
export interface ObservationCoordinateOwnership {documentId:string;recordIds:Set<string>}
export function sessionFromCoordinateObjects(previous:MeasurementSession,document:ModelDocument,observation?:ObservationCoordinateOwnership):MeasurementSession {
  const scoped=observation&&observation.documentId!==document.id?{...previous,pendingAtomIds:[],autoAtomIds:[],pendingImages:undefined,autoImages:undefined,records:[],activeRecordId:null}:previous;
  const retained=retainMeasurementSession(scoped,document.draft.structure.atoms.map(atom=>atom.id!));
  const records=displayedCoordinateObjects(document).map(object=>coordinateRecord(object,previous.records.find(record=>record.id===object.id)?.color));
  // Only records owned by this view and document may outlive native frames.
  // Formal/task objects win by both identity and physical path, never by prefix.
  const keys=new Set(records.map(record=>modelCoordinateKey(recordObject(record)))),ids=new Set(records.map(record=>record.id));
  if(observation?.documentId===document.id)records.push(...retained.records.filter(record=>observation.recordIds.has(record.id)&&!ids.has(record.id)&&!keys.has(modelCoordinateKey(recordObject(record)))));
  return {...retained,records,activeRecordId:records.some(record=>record.id===retained.activeRecordId)?retained.activeRecordId:null};
}
/** Include inactive engine snapshots, so clearing/deleting a view cannot orphan another task. */
export function coordinateAssociations(store:ModelStore,object:ModelCoordinateObject):{scope:'shared'|'gaussian'|'orca';id?:string;action:'freeze'|'scan';inactive?:true}[] {
  const document=store.getSnapshot(),result:{scope:'shared'|'gaussian'|'orca';id?:string;action:'freeze'|'scan';inactive?:true}[]=[];
  const sharedRows=(document.sharedConstraints?.coordinates??[]).filter(row=>associatedWithObject(row,object));
  const sharedProjection=(row:{action:string;type:ModelCoordinateObject['type'];atomIds:string[];images?:ModelCoordinateObject['images']})=>row.action==='freeze'&&sharedRows.some(shared=>modelCoordinateKey(shared)===modelCoordinateKey(row));
  for(const row of sharedRows)result.push({scope:'shared',id:row.id,action:row.action,...(document.sharedConstraints?.enabled===false?{inactive:true as const}:{})});
  const contexts=(['gaussian','orca'] as const).map(scope=>({scope,context:store.getContext(scope)}));
  for(const {scope,context} of contexts)for(const row of context?.coordinates??[])if(associatedWithObject(row,object)&&!(document.sharedConstraints?.canonical&&sharedProjection(row)))result.push({scope,id:row.id,action:row.action});
  for(const row of document.gaussianBoundCoordinates??[])if(row.objectId===object.id&&!sharedProjection(row)&&!result.some(item=>item.scope==='gaussian'&&item.id===row.rowId))result.push({scope:'gaussian',id:row.rowId,action:row.action,...(!row.rowEnabled?{inactive:true as const}:{})});
  if(!contexts.some(({context})=>context))for(const row of document.internalCoordinates??[])if(associatedWithObject(row,object))result.push({scope:row.source==='orca'?'orca':'gaussian',id:row.id,action:row.action});
  return result;
}

/** Observe/delete authority is view-owned; imported IDs cannot impersonate it. */
export function isObservationCoordinateRecord(store:ModelStore,session:MeasurementSession,ownership:ObservationCoordinateOwnership,id:string):boolean {
  const document=store.getSnapshot(),record=session.records.find(record=>record.id===id);
  if(ownership.documentId!==document.id||!ownership.recordIds.has(id)||!record)return false;
  if(!record.atomIds.every(id=>document.draft.structure.atoms.some(atom=>atom.id===id)))return false;
  const object=recordObject(record),key=modelCoordinateKey(object);
  if(displayedCoordinateObjects(document).some(item=>item.id===id||modelCoordinateKey(item)===key))return false;
  return coordinateAssociations(store,object).length===0;
}

/** Explicit formal deletion also retires any shadowed view observation. */
export function removeObservationCoordinate(session:MeasurementSession,ownership:ObservationCoordinateOwnership,object:ModelCoordinateObject):{session:MeasurementSession;ownership:ObservationCoordinateOwnership} {
  const key=modelCoordinateKey(object),removed=new Set(session.records.filter(record=>record.id===object.id||modelCoordinateKey(recordObject(record))===key).map(record=>record.id));
  return {ownership:{...ownership,recordIds:new Set([...ownership.recordIds].filter(id=>!removed.has(id)&&id!==object.id))},
    session:{...session,records:session.records.filter(record=>!removed.has(record.id)),activeRecordId:session.activeRecordId&&removed.has(session.activeRecordId)?null:session.activeRecordId}};
}
