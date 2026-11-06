import type { Structure } from '../core/types';
import { validatePeriodicEndpointImages } from '../core/periodic';
import type { GaussianBoundCoordinateDefinition, ModelCoordinate, ModelCoordinateObject, ModelDocument, SharedModelConstraints } from './contracts';

export const emptySharedConstraints=():SharedModelConstraints=>({frozenAtomIds:[],coordinates:[]});
/** Execution-only projection. Definitions and master state stay on the owner. */
export function effectiveSharedFreezes(shared:SharedModelConstraints):SharedModelConstraints {
  return shared.enabled===false?{...shared,frozenAtomIds:[],coordinates:[]}:shared;
}
/** A single master switch cannot represent two contradictory source states.
 * Empty targets adopt the copied definitions' switch; populated targets must
 * agree, so paste never silently enables or disables either frozen set. */
export function sharedFreezeEnabledForMerge(target:SharedModelConstraints,source?:SharedModelConstraints):boolean|undefined {
  if(!source||!source.frozenAtomIds.length&&!source.coordinates.length)return target.enabled;
  if(!target.frozenAtomIds.length&&!target.coordinates.length)return source.enabled;
  if((target.enabled!==false)!==(source.enabled!==false))throw new Error('源与目标的冻结启用状态不同；请先明确统一状态后合并，冻结定义未修改。');
  return target.enabled;
}
/** B/A/D paths and their exact reverse denote the same physical coordinate. */
export function modelCoordinateKey(row:Pick<ModelCoordinate,'type'|'atomIds'|'images'>):string {
  const images=row.images??row.atomIds.map(()=>[0,0,0]);
  const normalized=(indices:number[])=>JSON.stringify(indices.map(index=>[row.atomIds[index],images[index].map((value,axis)=>value-images[indices[0]][axis])]));
  if(!row.images||row.images.every(image=>image.every(value=>value===0))){const forward=JSON.stringify(row.atomIds),reverse=JSON.stringify([...row.atomIds].reverse());return row.type+':'+(forward<reverse?forward:reverse);}
  const forward=normalized(row.atomIds.map((_,index)=>index)),reverse=normalized(row.atomIds.map((_,index)=>row.atomIds.length-1-index));
  return row.type+':'+(forward<reverse?forward:reverse);
}
export function validateCoordinateObject(object:ModelCoordinateObject,structure:Structure):void {
  const count={B:2,A:3,D:4}[object.type],known=new Set(structure.atoms.map(atom=>atom.id));
  if(!object.id||typeof object.id!=='string'||!count||!Array.isArray(object.atomIds)||object.atomIds.length!==count||object.atomIds.some(id=>!known.has(id)))throw new Error('B/A/D对象身份或有序原子引用无效。');
  validatePeriodicEndpointImages(structure,object.atomIds,object.images);
}
export function assertImageCoordinateExecutionSupported(coordinates:readonly ModelCoordinate[]):void {
  if(coordinates.some(row=>row.images?.some(image=>image.some(Boolean))))throw new Error('当前后端未验证跨镜像B/A/D执行；请明确调整本次约束，不会静默只冻结基胞原子。');
}
export function validateSharedConstraints(shared:SharedModelConstraints,objects:readonly ModelCoordinateObject[],structure:Structure):void {
  if(shared.enabled!==undefined&&typeof shared.enabled!=='boolean')throw new Error('共有冻结启用状态须为布尔值。');
  if(shared.canonical!==undefined&&shared.canonical!==true)throw new Error('共有冻结owner标记无效。');
  const known=new Set(structure.atoms.map(atom=>atom.id));
  if(!Array.isArray(shared.frozenAtomIds)||new Set(shared.frozenAtomIds).size!==shared.frozenAtomIds.length||shared.frozenAtomIds.some(id=>!known.has(id)))throw new Error('共有冻结原子引用缺失或重复。');
  const objectIds=new Set<string>(),keys=new Set<string>();
  for(const object of objects){validateCoordinateObject(object,structure);if(objectIds.has(object.id)||keys.has(modelCoordinateKey(object)))throw new Error('B/A/D对象身份或同一坐标重复。');objectIds.add(object.id);keys.add(modelCoordinateKey(object));}
  const rows=new Set<string>(),rowIds=new Set<string>();
  for(const row of shared.coordinates){
    validateCoordinateObject({...row,id:row.id??''},structure);
    if(rowIds.has(row.id!))throw new Error('共有内坐标冻结行身份重复。');rowIds.add(row.id!);
    const object=objects.find(object=>object.id===row.objectId);
    const validTarget=row.value===undefined||shared.canonical===true&&row.source==='orca'&&Number.isFinite(row.value)&&(row.type==='B'?row.value>0:row.type==='A'?row.value>0&&row.value<180:true);
    if(row.action!=='freeze'||row.source!==undefined&&row.source!=='orca'||!validTarget||row.start!==undefined||row.end!==undefined||row.values!==undefined||row.steps!==1||row.increment!==null||!object||modelCoordinateKey(object)!==modelCoordinateKey(row))throw new Error('共有B/A/D冻结须绑定现有对象与有效目标，不能携带扫描定义。');
    if(rows.has(modelCoordinateKey(row)))throw new Error('同一共有内坐标冻结重复。');rows.add(modelCoordinateKey(row));
  }
}
export function validateGaussianBoundCoordinates(definitions:readonly GaussianBoundCoordinateDefinition[],objects:readonly ModelCoordinateObject[],structure:Structure):void {
  const ids=new Set<string>();
  for(const row of definitions){
    if(!row.rowId||typeof row.rowId!=='string'||ids.has(row.rowId)||typeof row.rowEnabled!=='boolean'||typeof row.stepsText!=='string'||typeof row.incrementText!=='string'||!['freeze','scan'].includes(row.action))throw new Error('Gaussian已绑定行元数据身份、开关或文本无效。');
    ids.add(row.rowId);validateCoordinateObject({id:row.objectId,type:row.type,atomIds:row.atomIds},structure);
    const object=objects.find(object=>object.id===row.objectId);
    if(!object||modelCoordinateKey(object)!==modelCoordinateKey(row))throw new Error('Gaussian已绑定行引用缺失或不对应的B/A/D对象。');
    if(row.action==='scan'){
      const steps=Number(row.stepsText),increment=Number(row.incrementText);
      if(!row.stepsText.trim()||!row.incrementText.trim()||!Number.isSafeInteger(steps)||steps<1||steps>10000||!Number.isFinite(increment)||increment===0)throw new Error('Gaussian已绑定扫描须有完整次数与非零有限增量。');
    }
  }
}
export function mergeModelCoordinates(privateRows:readonly ModelCoordinate[],sharedRows:readonly ModelCoordinate[]):ModelCoordinate[] {
  const rows:ModelCoordinate[]=[],byKey=new Map<string,ModelCoordinate>();
  for(const row of [...privateRows,...sharedRows]){
    const key=modelCoordinateKey(row),old=byKey.get(key);
    if(old){
      if(old.action!==row.action)throw new Error('同一内坐标不能同时冻结和扫描；请先移除相冲突的来源约束。');
      if(old.action==='freeze'&&(old.value!==undefined||row.value!==undefined)&&old.value!==row.value)throw new Error('同一内坐标的共有当前值冻结与任务指定目标冲突。');
      if(old.action==='scan'&&JSON.stringify([old.steps,old.increment,old.start,old.end,old.values])!==JSON.stringify([row.steps,row.increment,row.start,row.end,row.values]))throw new Error('同一内坐标含不同扫描定义。');
      continue;
    }
    byKey.set(key,row);rows.push(structuredClone(row));
  }
  return rows;
}
export function effectiveModelCoordinates(document:Pick<ModelDocument,'internalCoordinates'|'sharedConstraints'>):ModelCoordinate[] {
  return mergeModelCoordinates(document.sharedConstraints?.canonical?(document.internalCoordinates??[]).filter(row=>row.action!=='freeze'):document.internalCoordinates??[],document.sharedConstraints?.enabled===false?[]:document.sharedConstraints?.coordinates??[]);
}
export function assertAtomScanCompatibility(frozenAtomIds:readonly string[],coordinates:readonly ModelCoordinate[]):void {
  const frozen=new Set(frozenAtomIds);
  if(coordinates.some(row=>row.action==='scan'&&row.atomIds.every(id=>frozen.has(id))))throw new Error('扫描坐标涉及的全部原子均已冻结，不能同时改变该坐标。');
}
export function effectiveModelConstraints(document:Pick<ModelDocument,'draft'|'internalCoordinates'|'sharedConstraints'>):SharedModelConstraints {
  const result={frozenAtomIds:[...new Set([...(document.sharedConstraints?.canonical?[]:document.draft.assignments.frozenAtomIds),...document.draft.assignments.layers.filter(layer=>layer.frozen).flatMap(layer=>layer.atomIds),...(document.sharedConstraints?.enabled===false?[]:document.sharedConstraints?.frozenAtomIds??[])])],coordinates:effectiveModelCoordinates(document)};
  assertAtomScanCompatibility(result.frozenAtomIds,result.coordinates);return result;
}
export interface ModelConstraintSource {scope:'shared'|'gaussian'|'orca'|'layer';kind:'atom'|'coordinate';id:string;atomIds:string[];images?:import('../core/types').Vector3[];action:'freeze'|'scan';removable:boolean;objectId?:string;label:string}
/** Provenance is kept separate from deduplicated effective physics. Derived layer locks are read-only here. */
export function modelConstraintSources(document:Pick<ModelDocument,'draft'|'internalCoordinates'|'sharedConstraints'>,engine:'gaussian'|'orca'):ModelConstraintSource[] {
  const atoms=(scope:'shared'|'gaussian'|'orca',ids:string[])=>ids.map(id=>({scope,kind:'atom' as const,id,atomIds:[id],action:'freeze' as const,removable:true,label:scope==='shared'?'建模共有冻结':`${scope==='gaussian'?'Gaussian':'ORCA'}任务冻结`}));
  const rows=(scope:'shared'|'gaussian'|'orca',coordinates:ModelCoordinate[])=>coordinates.map((row,index)=>({scope,kind:'coordinate' as const,id:row.id??`${scope}-coordinate-${index}`,atomIds:[...row.atomIds],...(row.images?{images:structuredClone(row.images)}:{}),action:row.action,removable:Boolean(row.id),objectId:row.objectId,label:`${scope==='shared'?'建模共有':scope==='gaussian'?'Gaussian':'ORCA'} ${row.type} ${row.action==='freeze'?'冻结':'扫描'}`}));
  return [...atoms('shared',document.sharedConstraints?.enabled===false?[]:document.sharedConstraints?.frozenAtomIds??[]),...rows('shared',document.sharedConstraints?.enabled===false?[]:document.sharedConstraints?.coordinates??[]),...atoms(engine,document.sharedConstraints?.canonical?[]:document.draft.assignments.frozenAtomIds),...rows(engine,document.sharedConstraints?.canonical?(document.internalCoordinates??[]).filter(row=>row.action!=='freeze'):document.internalCoordinates??[]),...document.draft.assignments.layers.filter(layer=>layer.frozen).map(layer=>({scope:'layer' as const,kind:'atom' as const,id:layer.id,atomIds:[...layer.atomIds],action:'freeze' as const,removable:false,label:layer.label??'层活动范围限制'}))];
}
export function associatedWithObject(row:ModelCoordinate,object:ModelCoordinateObject):boolean {return row.objectId===object.id||modelCoordinateKey(row)===modelCoordinateKey(object);}
export function retainSharedConstraints(shared:SharedModelConstraints,ids:ReadonlySet<string>):SharedModelConstraints {
  return {...shared,frozenAtomIds:shared.frozenAtomIds.filter(id=>ids.has(id)),coordinates:shared.coordinates.filter(row=>row.atomIds.every(id=>ids.has(id)))};
}
