import type {MeasurementRecord,ModelCoordinate,SharedModelConstraints} from '../../core/modeling/contracts';
import type {Structure} from '../../core/types';
import type {PesGeometry,PesGroup} from '../../modeling/pes/contracts';
import {modelCoordinateKey} from '../../modeling/constraints';
import {cardSource,projectPesConstraintDefinitions} from '../../modeling/pes/request';
import {sharedScanCard} from '../../modeling/pes/expressions';
import {scanSourceKey} from '../../modeling/pes/scan-source';
import {pickerStructureIdentity} from '../../core/geometry-guides';

const typeOf=(record:MeasurementRecord)=>record.mode==='distance'?'B':record.mode==='angle'?'A':'D';
export const coordinateAnnotationKey=(record:MeasurementRecord)=>modelCoordinateKey({type:typeOf(record),atomIds:record.atomIds,images:record.images});
/** All inputs must already belong to the displayed scientific source/frame.
 * A projected alias never grants model editing even when its path also has a formal BAD. */
export function mergeCoordinateAnnotations(records:readonly MeasurementRecord[],annotations:readonly MeasurementRecord[]):MeasurementRecord[]{
  const merged=new Map<string,MeasurementRecord>();
  for(const record of [...records,...annotations]){
    const key=coordinateAnnotationKey(record),previous=merged.get(key);
    if(!previous){merged.set(key,{...record,atomIds:[...record.atomIds],...(record.displayNames?{displayNames:[...record.displayNames]}:{})});continue;}
    const displayNames=[...new Set([...(previous.displayNames??[]),...(record.displayNames??[])].filter(Boolean))];
    merged.set(key,{...previous,...(displayNames.length?{displayNames}:{}),...(previous.readOnly||record.readOnly?{readOnly:true as const}:{}),
      ...(record.displaySourceKey?{displaySourceKey:record.displaySourceKey}:{}),...(record.readOnly?{color:record.color}:{})});
  }
  return [...merged.values()];
}
export function coordinateAnnotation(row:Pick<ModelCoordinate,'type'|'atomIds'|'images'>,id:string,name:string,sourceKey:string,color='#2374d1'):MeasurementRecord{
  return {id,mode:row.type==='B'?'distance':row.type==='A'?'angle':'dihedral',atomIds:[...row.atomIds],...(row.images?{images:row.images.map(image=>[...image])}:{}),
    color,readOnly:true,displayNames:[name],displaySourceKey:sourceKey};
}
/** No current-value or target-value copy: the shared geometry guide evaluates each ready frame. */
export function frozenCoordinateAnnotations(constraints:SharedModelConstraints,structure:Structure,sourceKey:string):MeasurementRecord[]{
  if(constraints.enabled===false)return [];
  const known=new Set(structure.atoms.map(atom=>atom.id));
  return constraints.coordinates.filter(row=>row.action==='freeze').flatMap((row,index)=>row.atomIds.every(id=>known.has(id))
    ?[coordinateAnnotation(row,`annotation:${sourceKey}:freeze:${row.id??index}`,`冻结内坐标${index+1}`,sourceKey,'#2374d1')]:[]);
}
/** A card projects only into its actual source; equal atom ordinals are insufficient. */
export function pesCoordinateAnnotations(group:PesGroup,geometry:PesGeometry,sourceKey:string):MeasurementRecord[]{
  const records=frozenCoordinateAnnotations(projectPesConstraintDefinitions(group,geometry.structure).constraints,geometry.structure,sourceKey);
  const run=geometry.source?.runId?group.runs[geometry.source.runId]:undefined;
  if(run?.request.operation==='scan'&&run.nodeId===geometry.source?.nodeId){
    for(const row of run.request.coordinates)records.push(coordinateAnnotation(row,`annotation:${sourceKey}:run:${run.request.id}:${row.id}`,row.name,sourceKey));
  }
  for(const card of group.cards){
    if(card.kind!=='scan')continue;
    let source:PesGeometry;try{source=cardSource(group,card);}catch{continue;}
    if(source.documentId!==geometry.documentId||source.revision!==geometry.revision||scanSourceKey(source)!==scanSourceKey(geometry)
      ||pickerStructureIdentity(source.structure)!==pickerStructureIdentity(geometry.structure))continue;
    for(const row of sharedScanCard(card).scanCoordinates??[])records.push(coordinateAnnotation(row,`annotation:${sourceKey}:scan:${card.id}:${row.id}`,row.name,sourceKey));
  }
  return mergeCoordinateAnnotations([],records);
}
