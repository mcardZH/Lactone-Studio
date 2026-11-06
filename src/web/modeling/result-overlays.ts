import type {Structure,Vector3} from '../../core/types';
import type {ScreenPoint,PickResult,MeasurementRecord} from '../../modeling/contracts';
import {projectMeasurementLabels,type ViewportStateMarker} from './viewport-overlays';
import {MEASUREMENT_COLOR} from './render/adapter';
import {builderExplicitGeometryFrame} from '../../core/builder-geometry';
import {formatResultValue} from '../../results/numeric-format';

export interface ViewportResultBondValue {atomIds:[string,string];value:number;label:string;measurementLabel?:string;color?:string;length?:number;comparisonVisible?:boolean;decimals?:number}
export interface ViewportResultAtomLabel {atomId:string;label:string}
export interface ViewportResultHighlights {atomIds:readonly string[];bondPairs:readonly [string,string][]}
/** Match current visible atom numbering by stable ID, independently of global
 * number/element switches. sourceIndex remains provenance, never a guess at a
 * current displayed ordinal. Pair direction is canonical in display order. */
export function resultTargetLabel(structure:Structure,atomIds:readonly string[],body:string):string|null{
 if(atomIds.length<1||atomIds.length>2||new Set(atomIds).size!==atomIds.length)return null;
 const indices=atomIds.map(id=>structure.atoms.findIndex(atom=>atom.id===id));
 if(indices.some(index=>index<0))return null;
 const identity=indices.sort((a,b)=>a-b).map(index=>`${index+1}${structure.atoms[index].element}`).join('–');
 return identity+(body?'\n'+body:'');
}
/** Analysis owns this disposable presentation; the document selection, graph,
 * user measurements and Undo stay untouched. Both paths use modeling renderers. */
export function resultSelectionPresentation(structure:Structure,value?:ViewportResultHighlights){
 const known=new Set(structure.atoms.map(atom=>atom.id)),pairs=new Map<string,[string,string]>();
 for(const pair of value?.bondPairs??[]){if(pair[0]===pair[1]||pair.some(id=>!known.has(id)))continue;const ordered=[...pair].sort() as [string,string],key=JSON.stringify(ordered);if(!pairs.has(key))pairs.set(key,ordered);}
 // The same validated pair owns both endpoint outlines and its midpoint
 // annotation. This remains independent of the editable atom selection.
 const atomIds=[...new Set([...(value?.atomIds??[]),...[...pairs.values()].flat()])].filter(id=>known.has(id));
 const records:MeasurementRecord[]=[...pairs].map(([key,pair])=>({id:`result-distance:${key}`,mode:'distance',atomIds:pair,color:MEASUREMENT_COLOR}));
 // Atom IDs are display highlights only, never selection badges or editable
 // coordinate markers. The adapter reuses the ordinary hover outline.
 const markers:ViewportStateMarker[]=[];
 return{atomIds,records,markers};
}
export function resultMeasurementValueLabel(record:MeasurementRecord,valueLabel:string,values:readonly ViewportResultBondValue[]=[]){
 const row=values.find(row=>record.atomIds.length===2&&record.atomIds.every(id=>row.atomIds.includes(id)));
 const length=row?.decimals!==undefined&&Number.isFinite(row.length)?`${formatResultValue(row.length,row.decimals)} Å`:valueLabel;
 return length+(row?'\n'+(row.measurementLabel??row.label.split(' · ')[0]):'');
}
export interface ResultProjectionInputs {
 bondValues?:readonly ViewportResultBondValue[];
 atomLabels?:readonly ViewportResultAtomLabel[];
 highlights?:ViewportResultHighlights;
}
/** Projected rows are rendered only for their exact input references. Equal
 * serialized content is insufficient when a parent republishes pinned rows. */
export function sameResultProjectionInputs(previous:ResultProjectionInputs|null,current:ResultProjectionInputs){
 return previous!==null&&previous.bondValues===current.bondValues&&previous.atomLabels===current.atomLabels&&previous.highlights===current.highlights;
}
export function projectResultHighlights(structure:Structure,value:ViewportResultHighlights,project:(position:Vector3)=>ScreenPoint,offset:ScreenPoint){
 const ids=[...new Set([...value.atomIds,...value.bondPairs.flat()])];
 const atoms=ids.flatMap(id=>{const atom=structure.atoms.find(atom=>atom.id===id);if(!atom)return[];const p=project([atom.x,atom.y,atom.z]);return Number.isFinite(p.x)&&Number.isFinite(p.y)?[{id,x:p.x-offset.x,y:p.y-offset.y}]:[];});
 return{atoms,bonds:projectResultBondHighlights(structure,value.bondPairs,project,offset)};
}
export function projectResultBondColors(structure:Structure,values:readonly ViewportResultBondValue[],project:(position:Vector3)=>ScreenPoint,offset:ScreenPoint){
 return values.filter(value=>Number.isFinite(value.value)).flatMap(value=>projectResultBondHighlights(structure,[value.atomIds],project,offset).filter(row=>row.bonded).map(row=>({...row,color:value.color??'#3673a8'})));
}
export function resultBondHoverText(pick:PickResult,values:readonly ViewportResultBondValue[]):string|null{
 if(pick.kind!=='bond'||pick.image?.some(Boolean))return null;
 const row=values.find(row=>row.atomIds.includes(pick.atomIds[0])&&row.atomIds.includes(pick.atomIds[1]));
 return row&&Number.isFinite(row.length)?`${formatResultValue(row.length,row.decimals??3)} Å\n${row.measurementLabel??row.label.split(' · ')[0]}`:null;
}
/** Pointer and pin labels use the same atom/bond anchor, not an offset guide. */
function atomLabelAnchor(point:ScreenPoint,offset:ScreenPoint):ScreenPoint|null{
 return Number.isFinite(point.x)&&Number.isFinite(point.y)?{x:point.x-offset.x+13,y:point.y-offset.y+15}:null;
}
export function projectResultLabelAnchor(structure:Structure,ids:readonly string[],project:(position:Vector3)=>ScreenPoint,offset:ScreenPoint):ScreenPoint|null{
 if(ids.length===1){const atom=structure.atoms.find(atom=>atom.id===ids[0]);return atom?atomLabelAnchor(project([atom.x,atom.y,atom.z]),offset):null;}
 if(ids.length!==2||ids[0]===ids[1])return null;
 const ordered=[...ids].sort();
 const record:MeasurementRecord={id:'result-distance:'+JSON.stringify(ordered),mode:'distance',atomIds:ordered,color:MEASUREMENT_COLOR};
 const label=projectResultMeasurementLabels(structure,[record],project,offset)[0];
 return label?{x:label.x,y:label.y}:null;
}
/** Result-owned distance labels share the real pair midpoint. User measurement
 * records keep their existing guide anchors, even with an identical record id. */
export function projectResultMeasurementLabels(structure:Structure,records:readonly MeasurementRecord[],project:(position:Vector3)=>ScreenPoint,offset:ScreenPoint){
 return projectMeasurementLabels(structure.atoms,records,project,offset,structure).flatMap(label=>{
  if(label.error)return [{...label,analysis:true as const}];
  try {
   const framed=builderExplicitGeometryFrame(structure,'B',label.record.atomIds).structure.atoms;
   const pair=label.record.atomIds.map(id=>framed.find(atom=>atom.id===id));
   if(pair.length!==2||pair.some(atom=>!atom))return [];
   const [a,b]=pair as [NonNullable<typeof pair[number]>,NonNullable<typeof pair[number]>];
   const screen=project([(a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2]);
   return Number.isFinite(screen.x)&&Number.isFinite(screen.y)?[{...label,analysis:true as const,x:screen.x-offset.x,y:screen.y-offset.y}]:[];
  }catch{return [];}
 });
}
export function projectResultAtomLabels(structure:Structure,values:readonly ViewportResultAtomLabel[],project:(position:Vector3)=>ScreenPoint,offset:ScreenPoint){
 const atoms=new Map(structure.atoms.map(atom=>[atom.id,atom]));
 return values.flatMap(row=>{const atom=atoms.get(row.atomId);if(!atom)return[];const point=atomLabelAnchor(project([atom.x,atom.y,atom.z]),offset);return point?[{...row,...point}]:[];});
}
export function resultBondHover(pick:PickResult,values:readonly ViewportResultBondValue[]):string|null{
 if(pick.kind!=='bond'||pick.image?.some(Boolean))return null;
 const row=values.find(row=>Number.isFinite(row.value)&&(row.atomIds[0]===pick.atomIds[0]&&row.atomIds[1]===pick.atomIds[1]||row.atomIds[0]===pick.atomIds[1]&&row.atomIds[1]===pick.atomIds[0]));
 return row?.label??null;
}
/** Continuous results annotate even absent/weak graph edges; never create a
 * chemical bond, proxy, selection command, or discrete bond-order assignment. */
export function projectResultBondLabels(structure:Structure,values:readonly ViewportResultBondValue[],project:(position:Vector3)=>ScreenPoint,offset:ScreenPoint){
 return values.flatMap(row=>{
  if(row.atomIds[0]===row.atomIds[1]||(!Number.isFinite(row.value)&&!row.comparisonVisible))return[];
  const ordered=[...row.atomIds].sort();
  const record:MeasurementRecord={id:'result-distance:'+JSON.stringify(ordered),mode:'distance',atomIds:ordered,color:MEASUREMENT_COLOR};
  const label=projectResultMeasurementLabels(structure,[record],project,offset)[0];
  return label?[{...row,x:label.x,y:label.y,valueLabel:resultMeasurementValueLabel(record,label.valueLabel,[row])}]:[];
 });
}
/** Display-only pair emphasis. Absent graph edges stay dashed, never topology. */
export function projectResultBondHighlights(structure:Structure,pairs:readonly [string,string][],project:(position:Vector3)=>ScreenPoint,offset:ScreenPoint){
 return pairs.flatMap(ids=>{const indices=ids.map(id=>structure.atoms.findIndex(atom=>atom.id===id)),[a,b]=indices.map(index=>structure.atoms[index]);if(!a||!b||a===b)return[];
  const first=project([a.x,a.y,a.z]),second=project([b.x,b.y,b.z]);if(![first.x,first.y,second.x,second.y].every(Number.isFinite))return[];
  const bonded=Boolean(structure.bonds?.some(bond=>(bond.a===indices[0]&&bond.b===indices[1]||bond.b===indices[0]&&bond.a===indices[1])&&!bond.image?.some(Boolean)));
  return[{atomIds:ids,x1:first.x-offset.x,y1:first.y-offset.y,x2:second.x-offset.x,y2:second.y-offset.y,bonded}];
 });
}
