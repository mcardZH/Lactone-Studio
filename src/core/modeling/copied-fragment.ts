import type { Structure, Vector3 } from '../types';
import type { ClipboardPayload, FragmentSnapshot, ModelCoordinate, PastePolicy } from '../../modeling/contracts';
import { createBuilderDraft } from '../builder-draft';
import { builderPosition, builderVector, validateBuilderValence } from '../builder-geometry';
import { updateBuilderStereo } from '../builder-stereo';
import { checkedInputLayerDraft, clone, unique } from './graph';
import { validateAttachmentPorts, rotateAttachmentDirection } from './attachment-ports';
import { avoidObviousNewAtomClashes, hasObviousPlacementClash } from './local-placement';
import { constructionBondLength, externalBondDelta, terminalHydrogenSlot } from './connection-length';
import { emptySharedConstraints, validateSharedConstraints, validateGaussianBoundCoordinates, sharedFreezeEnabledForMerge } from '../../modeling/constraints';
import { newModelId } from './hydrogen-policy';
import { isInputLayerDraft } from '../input-layer-capability';
import { migrateCanonicalFreezes } from '../../modeling/application/canonical-freezes';
import { preparePeriodicAppendFragment, periodicAppendNote, type PeriodicAppendExtraction } from './periodic-append-fragment';

export type CopiedFragmentRotation = [Vector3, Vector3, Vector3];
export interface CopiedFragmentSeed {
  sourceDocumentId: string; fragment: FragmentSnapshot; activeIndex: number; activeAtomId: string;
}
export interface CopiedFragmentPlacement {
  mode: 'independent' | 'graft'; position: Vector3; rotation?: CopiedFragmentRotation;
  targetAtomId?: string; targetPortId?: string;
  /** Optional explicit incoming-only leaving groups. Omitted means stable-ID
   * ordered safe H/port choices; target exterior atoms are never candidates. */
  consumeHydrogenIds?: readonly string[]; consumePortIds?: readonly string[];
  cell?: PastePolicy['cell'];
}
export interface CopiedFragmentResult {
  fragment: FragmentSnapshot; sourceDocumentId: string; idMap: Record<string, string>; portIdMap: Record<string, string>;
  newAtomIds: string[]; touchedIds: string[]; createdFrom: Record<string, string>;
  consumedIncomingHydrogenIds: string[]; consumedIncomingPortIds: string[]; consumedTargetPortId?: string;
}
const I: CopiedFragmentRotation = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const finite = (v: readonly number[]): v is Vector3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const identity = (r: CopiedFragmentRotation) => r.every((row,i)=>row.every((v,j)=>v===I[i][j]));
function rotation(value: CopiedFragmentRotation = I): CopiedFragmentRotation {
  if(!Array.isArray(value)||value.length!==3||!value.every(finite))throw new Error('复制片段旋转矩阵必须有限。');
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(Math.abs(value[i].reduce((sum,v,k)=>sum+v*value[j][k],0)-(i===j?1:0))>1e-8)throw new Error('复制片段只支持刚体旋转，不能缩放或扭曲。');
  if(Math.abs(builderVector.dot(value[0],builderVector.cross(value[1],value[2]))-1)>1e-8)throw new Error('复制片段旋转不能隐式镜像。');
  return clone(value);
}
const turn=(r:CopiedFragmentRotation,p:Vector3):Vector3=>identity(r)?[...p]:r.map(row=>row.reduce((sum,v,i)=>sum+v*p[i],0)) as Vector3;
/** Proper minimal rotation for a construction leaving direction. Antiparallel
 * directions use the least-aligned Cartesian basis as a deterministic axis;
 * this is not a force-field fit or a preferred physical conformation. */
function alignLeavingDirection(from:Vector3,to:Vector3):CopiedFragmentRotation {
  const unit=(v:Vector3):Vector3=>{const length=Math.hypot(...v);if(!Number.isFinite(length)||length<1e-9)throw new Error('复制接枝的实际离去方向退化，未猜测接入姿态。');return builderVector.scale(v,1/length);};
  const a=unit(from),b=unit(to),cross=builderVector.cross(a,b),sine=Math.hypot(...cross),cosine=Math.max(-1,Math.min(1,builderVector.dot(a,b)));
  if(sine<1e-12&&cosine>0)return clone(I);
  let axis:Vector3,c:number,s:number;
  if(sine<1e-12){const least=[0,1,2].sort((i,j)=>Math.abs(a[i])-Math.abs(a[j])||i-j)[0],basis:Vector3=[0,0,0];basis[least]=1;axis=unit(builderVector.cross(a,basis));c=-1;s=0;}
  else {axis=builderVector.scale(cross,1/sine);c=cosine;s=sine;}
  const [x,y,z]=axis,v=1-c;
  return rotation([[c+x*x*v,x*y*v-z*s,x*z*v+y*s],[y*x*v+z*s,c+y*y*v,y*z*v-x*s],[z*x*v-y*s,z*y*v+x*s,c+z*z*v]]);
}
function validateSnapshot(input:FragmentSnapshot):FragmentSnapshot {
  const fragment=clone(input),s=fragment.structure;
  if(s.dimension!==3||!s.atoms.length||!Array.isArray(s.bonds))throw new Error('复制片段需要显式原子的真实3D坐标和明确键图。');
  createBuilderDraft(s,fragment.assignments);
  const ids=new Set(s.atoms.map(a=>a.id!));
  fragment.assignments.layers=fragment.assignments.layers.map(checkedInputLayerDraft);
  if(s.modelLayers)s.modelLayers=s.modelLayers.map(checkedInputLayerDraft);
  for(const category of ['layers','basis','fragments'] as const){
    const rowIds=fragment.assignments[category].map(row=>row.id);
    if(rowIds.some(id=>!id)||unique(rowIds).length!==rowIds.length)throw new Error('复制片段区域身份缺失或重复。');
    for(const row of fragment.assignments[category])if(!Array.isArray(row.atomIds)||row.atomIds.some(id=>!ids.has(id)))throw new Error('复制片段区域引用了未复制原子。');
  }
  if(fragment.assignments.layers.some(row=>row.frozen!==undefined&&typeof row.frozen!=='boolean'))throw new Error('复制片段层冻结标记必须为布尔值。');
  if(fragment.assignments.frozenAtomIds.some(id=>!ids.has(id)))throw new Error('复制片段冻结引用了未复制原子。');
  for(const row of [...(s.groups??[]),...(s.modelLayers??[])])if(row.atomIds.some(id=>!ids.has(id)))throw new Error('复制片段来源区域引用了未复制原子。');
  const objects=new Set<string>();
  for(const relation of fragment.auxiliaryRelations){if(!relation.id||objects.has(relation.id)||!ids.has(relation.a)||!ids.has(relation.b)||relation.a===relation.b||relation.order!==.5||relation.kind!=='auxiliary')throw new Error('复制片段辅助关系无效。');objects.add(relation.id);}
  for(const bond of fragment.deletedBonds)if(bond.atomIds.length!==2||bond.atomIds.some(id=>!ids.has(id))||bond.image&&!bond.image.every(Number.isInteger))throw new Error('复制片段删键记录无效。');
  for(const coordinate of fragment.internalCoordinates??[]){
    const count={B:2,A:3,D:4}[coordinate.type];
    if(!count||coordinate.atomIds.length!==count||unique(coordinate.atomIds).length!==count||coordinate.atomIds.some(id=>!ids.has(id))||!['freeze','scan'].includes(coordinate.action)||!Number.isSafeInteger(coordinate.steps)||coordinate.steps<1)throw new Error('复制片段内坐标身份或动作无效。');
    if(coordinate.increment!==null&&!Number.isFinite(coordinate.increment))throw new Error('复制片段内坐标增量无效。');
    for(const key of ['value','start','end'] as const)if(coordinate[key]!==undefined&&!Number.isFinite(coordinate[key]))throw new Error('复制片段内坐标数值无效。');
    if(coordinate.values!==undefined&&(!Array.isArray(coordinate.values)||!coordinate.values.every(Number.isFinite)))throw new Error('复制片段扫描值表无效。');
  }
  validateAttachmentPorts(fragment.attachmentPorts,s);
  validateSharedConstraints(fragment.sharedConstraints ?? emptySharedConstraints(), fragment.coordinateObjects ?? [], s);
  validateGaussianBoundCoordinates(fragment.gaussianBoundCoordinates??[],fragment.coordinateObjects??[],s);
  for (const row of fragment.internalCoordinates ?? []) if (row.objectId && !(fragment.coordinateObjects ?? []).some(object => object.id === row.objectId && object.type === row.type && (JSON.stringify(object.atomIds) === JSON.stringify(row.atomIds) || JSON.stringify([...object.atomIds].reverse()) === JSON.stringify(row.atomIds)))) throw new Error('复制片段内坐标对象引用无效。');
  // Reuse clipboard's conflict boundary, excluding only valid editable empty
  // draft rows. Ordinary empty regions and overlapping scientific definitions
  // are not silently discarded or converted into a fresh scientific setup.
  const checked=createBuilderDraft(s,{...fragment.assignments,layers:fragment.assignments.layers.filter(row=>row.atomIds.length||!isInputLayerDraft(row))});
  if(checked.assignmentIssues.length)throw new Error(`复制片段区域有真实冲突：${checked.assignmentIssues.join(' ')}`);
  return fragment;
}

/** Actual copied coordinates and explicit H, not a projected/template image.
 * No saturation, Gen3D, atom renumbering or source-state inference occurs. */
export function createCopiedFragmentSeed(payload:ClipboardPayload,activeIndex=0):CopiedFragmentSeed {
  if(payload.schema!=='sciyue-model-fragment'||payload.version!==1||typeof payload.sourceDocumentId!=='string'||!payload.sourceDocumentId)throw new Error('复制片段协议或来源身份无效。');
  const fragment=validateSnapshot(payload.fragment);
  const migrated={id:payload.sourceDocumentId,revision:0,draft:createBuilderDraft(fragment.structure,fragment.assignments),selection:{atomIds:[],bonds:[],auxiliaryIds:[]},auxiliaryRelations:fragment.auxiliaryRelations,deletedBonds:fragment.deletedBonds,internalCoordinates:fragment.internalCoordinates,sharedConstraints:fragment.sharedConstraints,coordinateObjects:fragment.coordinateObjects,canUndo:false,canRedo:false};
  migrateCanonicalFreezes(migrated);fragment.assignments=migrated.draft.assignments;fragment.internalCoordinates=migrated.internalCoordinates;fragment.sharedConstraints=migrated.sharedConstraints;fragment.coordinateObjects=migrated.coordinateObjects;
  if(!Number.isSafeInteger(activeIndex)||activeIndex<0||activeIndex>=fragment.structure.atoms.length)throw new Error('复制片段活性原子索引无效。');
  return{sourceDocumentId:payload.sourceDocumentId,fragment,activeIndex,activeAtomId:fragment.structure.atoms[activeIndex].id!};
}
export function selectCopiedFragmentActive(seed:CopiedFragmentSeed,activeIndex:number):CopiedFragmentSeed {
  return createCopiedFragmentSeed({schema:'sciyue-model-fragment',version:1,sourceDocumentId:seed.sourceDocumentId,fragment:seed.fragment},activeIndex);
}
const cellKey=(s:Structure)=>JSON.stringify(s.cell?[s.cell.vectors,s.cell.pbc,s.cell.origin??[0,0,0]]:null);
const hasImages=(s:Structure)=>s.bonds!.some(b=>b.image?.some(Boolean));

/** One pure graph patch. The caller owns target stamp/MD lock/commit/Undo.
 * This never edits target or incoming, invokes a writer or repairs target H. */
export function placeCopiedFragment(targetInput:FragmentSnapshot,seedInput:CopiedFragmentSeed,options:CopiedFragmentPlacement,idFactory:()=>string=newModelId):CopiedFragmentResult {
  const target=clone(targetInput),incoming=createCopiedFragmentSeed({schema:'sciyue-model-fragment',version:1,sourceDocumentId:seedInput.sourceDocumentId,fragment:seedInput.fragment},seedInput.activeIndex);
  if(seedInput.activeAtomId!==incoming.activeAtomId)throw new Error('复制片段活性原子身份已失效。');
  if(!['independent','graft'].includes(options.mode)||!finite(options.position))throw new Error('复制片段模式或放置坐标无效。');
  let r=rotation(options.rotation);
  let source=incoming.fragment;let extraction:PeriodicAppendExtraction|undefined;
  if(options.mode==='independent'&&target.structure.atoms.length&&target.structure.cell?.pbc.some(Boolean)&&options.cell===undefined){
    const normalized=preparePeriodicAppendFragment(source,incoming.sourceDocumentId,target.structure.cell);source=normalized.fragment;extraction=normalized.extraction;
  }
  const s=source.structure,active=s.atoms[incoming.activeIndex];
  createBuilderDraft(target.structure,target.assignments);validateAttachmentPorts(target.attachmentPorts,target.structure);
  target.assignments.layers=target.assignments.layers.map(checkedInputLayerDraft);
  if(target.structure.modelLayers)target.structure.modelLayers=target.structure.modelLayers.map(checkedInputLayerDraft);
  if(options.targetAtomId&&options.targetPortId)throw new Error('复制片段不能同时替换原子和接入端口。');
  if(options.mode==='independent'&&(options.targetAtomId||options.targetPortId||options.consumeHydrogenIds?.length||options.consumePortIds?.length))throw new Error('整体追加不消费H/端口，也不替换目标原子。');
  if(options.mode==='graft'&&!options.targetAtomId&&!options.targetPortId)throw new Error('接枝需要明确目标原子或待接端。');
  const t=target.structure,oldIds=new Set(t.atoms.map(a=>a.id!)),host=options.targetAtomId?t.atoms.find(a=>a.id===options.targetAtomId):undefined;
  if(!Array.isArray(t.bonds))throw new Error('复制放置目标需要明确的原有键图。');
  if(options.targetAtomId&&!host)throw new Error('目标原子已不存在。');
  const targetPort=options.targetPortId?target.attachmentPorts?.find(p=>p.id===options.targetPortId):undefined;
  if(options.targetPortId&&!targetPort)throw new Error('目标待接端已不存在。');
  const parent=targetPort?t.atoms.find(a=>a.id===targetPort.hostAtomId):undefined;
  if(targetPort&&!parent)throw new Error('目标待接端宿主已不存在。');
  const sameCell=cellKey(t)===cellKey(s),sourceCrosses=hasImages(s),targetCrosses=hasImages(t);
  if(t.atoms.length&&(t.cell||s.cell)&&!sameCell&&(!options.cell||options.cell==='require-compatible'))throw new Error('复制片段与目标晶胞不同，请明确晶胞策略。');
  if(sourceCrosses&&!identity(r))throw new Error('跨胞复制片段不能在固定晶胞下任意旋转，未猜测图像。');
  if(options.cell==='omit'&&(sourceCrosses||targetCrosses)||!sameCell&&t.atoms.length&&sourceCrosses&&options.cell==='keep-target'||!sameCell&&t.atoms.length&&targetCrosses&&options.cell==='use-source')throw new Error('晶胞策略不能忠实保留跨胞图，未提交。');
  if(!t.atoms.length||options.cell==='use-source')t.cell=clone(s.cell);
  if(options.cell==='omit')t.cell=undefined;
  const hostIndex=host?t.atoms.findIndex(a=>a.id===host.id):-1;
  const external=hostIndex>=0?(t.bonds??[]).filter(b=>b.a===hostIndex||b.b===hostIndex):[];
  const slot=terminalHydrogenSlot(t,hostIndex,active.element);
  let connectionDirection:Vector3|undefined=targetPort?.direction;
  if(slot)connectionDirection=slot.direction;
  else if(host&&external.length===1){
    const other=external[0].a===hostIndex?external[0].b:external[0].a,delta=externalBondDelta(t,hostIndex,other),length=Math.hypot(...delta);
    if(!Number.isFinite(length)||length<1e-9)throw new Error('复制片段外部连接方向退化。');
    connectionDirection=builderVector.scale(delta,-1/length);
  }
  const connectOrder=targetPort?.order??(external.length===1?(external[0].aromatic||external[0].order===4?1.5:external[0].order):undefined);
  const frozen=new Set([...source.assignments.frozenAtomIds,...source.assignments.layers.filter(row=>row.frozen===true).flatMap(row=>row.atomIds),...(source.sharedConstraints?.enabled===false?[]:source.sharedConstraints?.frozenAtomIds??[])]);
  const protectedReferences=new Set([...(source.internalCoordinates??[]),...(source.sharedConstraints?.coordinates??[]),...(source.coordinateObjects??[]),...(source.gaussianBoundCoordinates??[])].flatMap(row=>row.atomIds));
  const eligibleHs=s.atoms.filter(atom=>atom.element==='H'&&atom.id!==active.id&&!frozen.has(atom.id!)&&!protectedReferences.has(atom.id!)&&!(source.attachmentPorts??[]).some(p=>p.hostAtomId===atom.id)).filter(atom=>{
    const index=s.atoms.indexOf(atom),edges=s.bonds!.filter(b=>b.a===index||b.b===index);
    return edges.length===1&&edges[0].kind!=='coordination'&&edges[0].order===1&&((edges[0].a===index?edges[0].b:edges[0].a)===incoming.activeIndex);
  }).map(a=>a.id!).sort();
  const eligiblePorts=(source.attachmentPorts??[]).filter(p=>p.hostAtomId===active.id&&connectOrder!==undefined&&p.order===connectOrder).map(p=>p.id).sort();
  const consumedH=[...(options.consumeHydrogenIds??[])],consumedPorts=[...(options.consumePortIds??[])];
  if(unique(consumedH).length!==consumedH.length||consumedH.some(id=>!eligibleHs.includes(id)))throw new Error('只能消耗incoming活性位自身的非冻结末端单键H。');
  if(unique(consumedPorts).length!==consumedPorts.length||consumedPorts.length>1||consumedPorts.some(id=>!eligiblePorts.includes(id)))throw new Error('incoming端口必须属于活性原子且与接入键级相符。');
  if(options.mode==='graft'&&options.consumePortIds===undefined&&eligiblePorts.length)consumedPorts.push(eligiblePorts[0]);
  const objects=new Set<string>([...oldIds,...(target.attachmentPorts??[]).map(p=>p.id),...target.auxiliaryRelations.map(row=>row.id),...(target.internalCoordinates??[]).flatMap(row=>row.id?[row.id]:[]),...(target.coordinateObjects??[]).map(row=>row.id),...(target.sharedConstraints?.coordinates??[]).flatMap(row=>row.id?[row.id]:[]),...(['layers','basis','fragments'] as const).flatMap(key=>target.assignments[key].map(row=>row.id)),...(t.modelLayers??[]).map(row=>row.id)]);
  const nextId=()=>{const id=idFactory();if(typeof id!=='string'||!id||objects.has(id))throw new Error('复制片段新身份重复或无效。');objects.add(id);return id;};
  const allIdMap=new Map(s.atoms.map(atom=>[atom.id!,host&&atom.id===active.id?host.id!:nextId()]));
  const anchor=builderPosition(active),origin:Vector3=slot?slot.origin:host?builderPosition(host):targetPort?builderVector.add(builderPosition(parent!),builderVector.scale(targetPort.direction,constructionBondLength(parent!.element,active.element,targetPort.order))):[...options.position];
  const placePoint=(p:Vector3):Vector3=>identity(r)?(origin.every((v,i)=>v===anchor[i])?[...p]:builderVector.add(p,builderVector.sub(origin,anchor))):builderVector.add(turn(r,builderVector.sub(p,anchor)),origin);
  const build=(removed:Set<string>)=>{
    const atoms=t.atoms.map(clone),mapping=new Map<number,number>();
    for(let index=0;index<s.atoms.length;index++){
      const atom=s.atoms[index];if(removed.has(atom.id!))continue;
      const p=placePoint(builderPosition(atom)),mapped={...clone(atom),id:allIdMap.get(atom.id!)!,x:p[0],y:p[1],z:p[2]};
      if(host&&index===incoming.activeIndex){mapping.set(index,hostIndex);atoms[hostIndex]={...mapped,x:origin[0],y:origin[1],z:origin[2]};}
      else{mapping.set(index,atoms.length);atoms.push(mapped);}
    }
    const bonds=[...(t.bonds??[]).map(clone),...s.bonds!.filter(b=>mapping.has(b.a)&&mapping.has(b.b)).map(b=>({...clone(b),a:mapping.get(b.a)!,b:mapping.get(b.b)!}))];
    if(targetPort)bonds.push({a:t.atoms.findIndex(a=>a.id===parent!.id),b:mapping.get(incoming.activeIndex)!,order:targetPort.order,...(targetPort.order===1.5?{fractional:true,aromatic:false}:{})});
    const inheritedIssues=[...(t.bondPerceptionIssues??[]),...(s.bondPerceptionIssues??[]).filter(issue=>issue.atomIds.every(id=>!removed.has(id))).map(issue=>({...clone(issue),atomIds:issue.atomIds.map(id=>allIdMap.get(id)!) as [string,string]}))];
    return{...clone(t),atoms,bonds,dimension:3 as const,molfile:undefined,...(inheritedIssues.length?{bondPerceptionIssues:inheritedIssues}:{})};
  };
  let removed=new Set(consumedH),candidate=build(removed);
  const activeMapped=allIdMap.get(active.id!)!;
  const validateConnection=()=>validateBuilderValence(candidate,unique([activeMapped,...(parent?[parent.id!]:[])]));
  if(options.mode==='graft'){
    try{validateConnection();}catch(error){
      if(options.consumeHydrogenIds!==undefined)throw error;
      for(const id of eligibleHs){if(removed.has(id))continue;removed.add(id);consumedH.push(id);candidate=build(removed);try{validateConnection();break;}catch{}}
      validateConnection();
    }
    // Metals/unsupported charge have no generic organic capacity. Require the
    // explicit matching construction port instead of inventing a free valence.
    if(!consumedPorts.length&&active.element!=='H'&&!['C','N','O','B','Si','P','S','F','Cl','Br','I'].includes(active.element)&&connectOrder!==undefined)throw new Error('该活性元素无已核普通接入价态，请选择其明确待接端口。');
  }
  if(connectionDirection&&options.rotation===undefined){
    // Determine the default orientation only AFTER actual valence/consumption
    // choices. A consumed local slot is authoritative before a consumed H;
    // stable-ID H order supplies one declared axis, not a multi-H physical fit.
    const slot=(source.attachmentPorts??[]).find(p=>p.id===consumedPorts[0]);
    let leaving:Vector3|undefined=slot?.direction;
    if(!leaving&&consumedH.length){
      const hydrogenIndex=s.atoms.findIndex(a=>a.id===consumedH[0]),edge=s.bonds!.find(b=>(b.a===incoming.activeIndex&&b.b===hydrogenIndex)||(b.b===incoming.activeIndex&&b.a===hydrogenIndex));
      if(edge){leaving=builderVector.sub(builderPosition(s.atoms[hydrogenIndex]),anchor);if(s.cell&&edge.image)edge.image.forEach((image,axis)=>{leaving=builderVector.add(leaving!,builderVector.scale(s.cell!.vectors[axis],image*(edge.a===incoming.activeIndex?1:-1)));});}
    }
    if(!leaving)throw new Error('复制片段没有实际消费的H或端口离去方向，请明确旋转或提供可信接入位。');
    r=alignLeavingDirection(leaving,builderVector.scale(connectionDirection,-1));
    if(sourceCrosses&&!identity(r))throw new Error('跨胞复制片段不能为接入在固定晶胞下自动旋转，未猜测图像。');
    candidate=build(removed);validateConnection();
  }
  const idMap=Object.fromEntries([...allIdMap].filter(([id])=>!removed.has(id))),remap=(id:string)=>{const mapped=idMap[id];if(!mapped)throw new Error('复制片段引用了未保留的对象。');return mapped;};
  if(extraction)candidate.notes.push(periodicAppendNote(extraction,idMap));
  const remapMembers=(ids:string[])=>ids.filter(id=>!removed.has(id)).map(remap);
  const result:FragmentSnapshot={structure:candidate,assignments:clone(target.assignments),auxiliaryRelations:clone(target.auxiliaryRelations),deletedBonds:clone(target.deletedBonds),internalCoordinates:clone(target.internalCoordinates??[]),attachmentPorts:clone((target.attachmentPorts??[]).filter(p=>p.id!==targetPort?.id)),coordinateObjects:clone(target.coordinateObjects??[]),sharedConstraints:clone(target.sharedConstraints??emptySharedConstraints())};
  if(target.gaussianBoundCoordinates)result.gaussianBoundCoordinates=clone(target.gaussianBoundCoordinates);
  for(const key of ['layers','basis','fragments'] as const)result.assignments[key].push(...source.assignments[key].map(row=>({...clone(row),id:nextId(),atomIds:remapMembers(row.atomIds)})));
  result.assignments.frozenAtomIds=unique([...result.assignments.frozenAtomIds,...source.assignments.frozenAtomIds.map(remap)]);
  result.structure.groups=[...(t.groups??[]).map(clone),...(s.groups??[]).map(row=>({...clone(row),atomIds:remapMembers(row.atomIds)}))];
  result.structure.modelLayers=[...(t.modelLayers??[]).map(clone),...(s.modelLayers??[]).map(row=>({...clone(row),id:nextId(),atomIds:remapMembers(row.atomIds)}))];
  result.auxiliaryRelations.push(...source.auxiliaryRelations.filter(row=>!removed.has(row.a)&&!removed.has(row.b)).map(row=>({...clone(row),id:nextId(),a:remap(row.a),b:remap(row.b)})));
  result.deletedBonds.push(...source.deletedBonds.filter(row=>row.atomIds.every(id=>!removed.has(id))).map(row=>({...clone(row),atomIds:row.atomIds.map(remap) as [string,string]})));
  const coordinateIdMap=new Map((source.coordinateObjects??[]).map(row=>[row.id,nextId()]));
  result.coordinateObjects!.push(...(source.coordinateObjects??[]).map(row=>({...clone(row),id:coordinateIdMap.get(row.id)!,atomIds:row.atomIds.map(remap)})));
  const rowIdMap=new Map<string,string>();const remapRowId=(id?:string)=>{if(!id)return nextId();if(!rowIdMap.has(id))rowIdMap.set(id,nextId());return rowIdMap.get(id)!;};
  const remapCoordinate=(row:ModelCoordinate):ModelCoordinate=>({...clone(row),id:remapRowId(row.id),atomIds:row.atomIds.map(remap),...(row.objectId?{objectId:coordinateIdMap.get(row.objectId)!}:{})});
  result.internalCoordinates!.push(...(source.internalCoordinates??[]).map(remapCoordinate));
  const enabled=sharedFreezeEnabledForMerge(result.sharedConstraints!,source.sharedConstraints);
  if(enabled!==undefined)result.sharedConstraints!.enabled=enabled;
  result.sharedConstraints!.frozenAtomIds=unique([...result.sharedConstraints!.frozenAtomIds,...(source.sharedConstraints?.frozenAtomIds??[]).map(remap)]);
  result.sharedConstraints!.coordinates.push(...(source.sharedConstraints?.coordinates??[]).map(remapCoordinate));
  if(source.gaussianBoundCoordinates?.length)result.gaussianBoundCoordinates=[...(result.gaussianBoundCoordinates??[]),...source.gaussianBoundCoordinates.map(row=>({...clone(row),rowId:remapRowId(row.rowId),objectId:coordinateIdMap.get(row.objectId)!,atomIds:row.atomIds.map(remap)}))];
  const portIdMap:Record<string,string>={};
  const incomingPorts=(source.attachmentPorts??[]).filter(p=>!consumedPorts.includes(p.id)&&!removed.has(p.hostAtomId)).map(port=>{const id=nextId();portIdMap[port.id]=id;return{...clone(port),id,hostAtomId:remap(port.hostAtomId),direction:turn(r,port.direction)};});
  result.attachmentPorts!.push(...incomingPorts);
  const newAtomIds=result.structure.atoms.filter(a=>!oldIds.has(a.id!)).map(a=>a.id!);
  const onRotation=(axis:Vector3,degrees:number)=>{const incomingIds=new Set(Object.values(portIdMap));result.attachmentPorts=result.attachmentPorts!.map(p=>incomingIds.has(p.id)?{...p,direction:rotateAttachmentDirection(p.direction,axis,degrees)}:p);};
  if(slot&&hasObviousPlacementClash(result.structure,[host!.id!]))throw new Error('末端H接入位存在明显重叠，未移动旧骨架或提交。');
  result.structure=avoidObviousNewAtomClashes(t,result.structure,newAtomIds,host||targetPort?{pivot:origin,axis:connectionDirection,onRotation,locked:sourceCrosses||external.length>1||options.rotation!==undefined,optimizeClearance:true}:{});
  result.structure.layout2D={...(t.layout2D??{}),...Object.fromEntries(result.structure.atoms.filter(a=>newAtomIds.includes(a.id!)).map(a=>[a.id!,{x:a.x,y:a.y}]))};
  result.structure.gaussianSource=undefined;result.structure.gaussianSources=undefined;result.structure.sourceRoute=undefined;result.structure.mapping=undefined;
  result.structure=updateBuilderStereo(result.structure).structure;
  for(const atom of targetInput.structure.atoms){if(slot&&atom.id===host!.id)continue;const kept=result.structure.atoms.find(a=>a.id===atom.id);if(!kept||![Object.is(atom.x,kept.x),Object.is(atom.y,kept.y),Object.is(atom.z,kept.z)].every(Boolean))throw new Error('复制接枝不能移动旧目标原子。');}
  validateAttachmentPorts(result.attachmentPorts,result.structure);
  validateSharedConstraints(result.sharedConstraints!,result.coordinateObjects!,result.structure);
  validateGaussianBoundCoordinates(result.gaussianBoundCoordinates??[],result.coordinateObjects!,result.structure);
  const touchedIds=unique([...newAtomIds,...(host?[host.id!]:[]),...(parent?[parent.id!]:[])]),createdFrom:Record<string,string>={};
  if(host||parent)for(const id of newAtomIds)createdFrom[id]=(host??parent)!.id!;
  return{fragment:result,sourceDocumentId:incoming.sourceDocumentId,idMap,portIdMap,newAtomIds,touchedIds,createdFrom,consumedIncomingHydrogenIds:consumedH,consumedIncomingPortIds:consumedPorts,...(targetPort?{consumedTargetPortId:targetPort.id}:{})};
}
