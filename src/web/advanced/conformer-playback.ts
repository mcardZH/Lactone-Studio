import type {AdvancedResultFrame,AdvancedTaskRecord} from '../../modeling/advanced/contracts';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {createConformerSnapshot,planConformerTorsionHierarchy,orderConformerPlaybackFrames,type ConformerTorsionHierarchy,type ConformerDiscreteTorsionPoint} from '../../modeling/conformers';
import type {ConformerResultCollection} from '../../modeling/conformers/trajectory';
import {conformerPlaybackFrameIndex} from '../modeling/workspace-conformer-publication';

export interface ResolvedConformerPlaybackFrame {
 blockKey:string;
 referenceSource?:AdvancedFrameSource;
 coreAtomIds:readonly string[];
 /** Only actual flexible-key sampling guesses receive a display reorder. */
 hierarchy?:ConformerTorsionHierarchy;
 discretePoints?:readonly ConformerDiscreteTorsionPoint[];
 warnings:readonly string[];
}
type Resolver=(frame:AdvancedResultFrame)=>ResolvedConformerPlaybackFrame;
const resolvers=new WeakMap<ReadonlyMap<string,AdvancedResultFrame>,Map<string,Resolver>>();
const collectionProjections=new WeakMap<ConformerResultCollection,WeakMap<Resolver,ConformerResultCollection>>();
/** One display-only projection feeds preparation, publication, table and player.
 * Keep the actual candidate objects/IDs and every scientific source untouched.
 * Non-flexible blocks (including MD and optimized frames) retain source order. */
export function projectConformerPlaybackCollection(collection:ConformerResultCollection,task:AdvancedTaskRecord|undefined):ConformerResultCollection{
 if(!task||task.id!==collection.identity.taskId||collection.frames.length<2)return collection;
 const resolve=createConformerPlaybackResolver(task);let projections=collectionProjections.get(collection);
 const cached=projections?.get(resolve);if(cached)return cached;
 const frames=orderConformerPlaybackFrames(collection.frames,{structureOf:frame=>frame.source.structure,blockKey:frame=>resolve(frame).blockKey,hierarchyFor:frame=>resolve(frame).hierarchy,discretePointsOf:frame=>resolve(frame).discretePoints}).frames;
 const projected=frames.every((frame,index)=>frame===collection.frames[index])?collection:{...collection,frames};
 if(!projections){projections=new WeakMap();collectionProjections.set(collection,projections);}projections.set(resolve,projected);
 if(projected!==collection){const stable=new WeakMap<Resolver,ConformerResultCollection>();stable.set(resolve,projected);collectionProjections.set(projected,stable);}
 return projected;
}
/** Prepare once per immutable UI task snapshot/configuration, then reuse for
 * every collection frame. No source reads, sampling, inference or state writes. */
export function createConformerPlaybackResolver(task:AdvancedTaskRecord|undefined,displayCoreIds?:readonly string[]):(frame:AdvancedResultFrame)=>ResolvedConformerPlaybackFrame{
 const byFrame=task?conformerPlaybackFrameIndex(task):new Map<string,AdvancedResultFrame>(),configuration=JSON.stringify(displayCoreIds??null);
 let owned=resolvers.get(byFrame);const existing=owned?.get(configuration);if(existing)return existing;
 if(!owned){owned=new Map();resolvers.set(byFrame,owned);}
 const runs=new Map(task?.runs.map(run=>[run.id,run]));
 const resolved=new WeakMap<AdvancedResultFrame,ResolvedConformerPlaybackFrame>(),hierarchies=new Map<string,ConformerTorsionHierarchy>();
 const resolve:Resolver=frame=>{
  const cached=resolved.get(frame);if(cached)return cached;
  const warnings:string[]=[];let ancestor=frame;const visited=new Set<string>();
  while(!ancestor.samplingOrigin&&!visited.has(ancestor.id)){visited.add(ancestor.id);const parent=ancestor.parentRef.frameId?byFrame.get(ancestor.parentRef.frameId):undefined;if(!parent)break;ancestor=parent;}
  const origin=ancestor.samplingOrigin,run=runs.get(ancestor.runId??''),mixed=run?.mixedSampling;
  const batchId=origin?.batchId??mixed?.batchId,batch=task?.mixedSampling?.batches?.find(value=>value.id===batchId);
  const referenceSource=origin?.source??mixed?.source??batch?.source??(!task?.mixedSampling?task?.spec.source:undefined);
  const cardId=origin?.cardId,cardRevision=origin&&'cardRevision' in origin&&typeof origin.cardRevision==='number'&&Number.isSafeInteger(origin.cardRevision)?origin.cardRevision:undefined;
  const savedCard=batch?.cards.find(value=>value.id===cardId&&value.configurationRevision===cardRevision);
  const card=mixed?.definition.cards.find(value=>value.id===cardId)??savedCard?.configuration??(cardRevision===undefined||cardRevision===1?batch?.definition.cards.find(value=>value.id===cardId):undefined);
  const revision=cardRevision===undefined?run?.id??frame.runId??'legacy':String(cardRevision);
  const blockKey=JSON.stringify([batchId??run?.id??frame.runId??frame.stageId,cardId??frame.stageId,revision,origin?.initialGuessId??mixed?.initialGuessId??'legacy']);
  // Soft sampling protection is not a hard XYZ freeze. MD/MTD display uses
  // the actual source constraints, otherwise every heavy atom with equal
  // weight. Flexible-key blocks retain their deterministic rigid-end plan.
  let coreAtomIds:readonly string[]=[],hierarchy:ConformerTorsionHierarchy|undefined;
  if(referenceSource){
   if(frame.kind==='guess'&&origin&&!card)warnings.push('缺少该批次该版本的柔性键定义，保持真实帧原顺序。');
   const torsions=card?.kind==='conformer-search'?card.search.torsions:!task?.mixedSampling&&task?.spec.kind==='conformer-search'?task.spec.search.torsions:undefined;
   if(torsions?.length){try{
    coreAtomIds=[...(displayCoreIds??origin?.protectedAtomIds??[])];
    const key=JSON.stringify([blockKey,coreAtomIds]);let plan=hierarchies.get(key);
    if(!plan){const snapshot=createConformerSnapshot(referenceSource.structure,referenceSource.ref,referenceSource.constraints);plan=planConformerTorsionHierarchy(snapshot,torsions.map(row=>row.torsion),coreAtomIds.length?coreAtomIds:undefined);hierarchies.set(key,plan);}
    coreAtomIds=plan.coreAtomIds;if(frame.kind==='guess')hierarchy=plan;
   }catch(error){coreAtomIds=[];warnings.push(error instanceof Error?error.message:String(error));}}
   else{
    const frozen=frame.kind==='optimized'?frame.source.constraints.frozenAtomIds:referenceSource.constraints.frozenAtomIds;
    coreAtomIds=frozen.length?[...frozen]:referenceSource.structure.atoms.flatMap(atom=>atom.element!=='H'&&atom.id?[atom.id]:[]);
   }
  }else warnings.push('缺少此批次实际初猜快照，保持原始坐标；未采用任务最初来源替代。');
  // Older saved frames kept the exact requested targets in their card's guess
  // record. Reuse that provenance rather than ranking repaired coordinates;
  // absent historical metadata remains an honest angle-based fallback.
  const guess=frame.kind==='guess'&&!origin?.discreteTorsions?.length?savedCard?.guesses?.guesses.find(guess=>guess.attempt===frame.source.ref.sourceFrameIndex):undefined;
  const discretePoints=frame.kind==='guess'?(origin?.discreteTorsions?.length?origin.discreteTorsions:guess?.torsions):undefined;
  const value={blockKey,referenceSource,coreAtomIds,hierarchy,discretePoints,warnings};resolved.set(frame,value);return value;
 };
 owned.set(configuration,resolve);return resolve;
}
