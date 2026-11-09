import type {AdvancedResultFrame,AdvancedTaskRecord} from '../../modeling/advanced/contracts';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {createConformerSnapshot,planConformerTorsionHierarchy,type ConformerTorsionHierarchy,type ConformerDiscreteTorsionPoint} from '../../modeling/conformers';
import type {ConformerFrameDisplayPolicy} from '../../modeling/conformers/playback-display';
import type {ConformerResultCollection} from '../../modeling/conformers/trajectory';
import {conformerPlaybackFrameIndex} from '../modeling/workspace-conformer-publication';

export interface ResolvedConformerPlaybackFrame {
 blockKey:string;
 referenceSource?:AdvancedFrameSource;
 coreAtomIds:readonly string[];
 /** Fixed-end planning metadata; never used to reorder accepted frames. */
 hierarchy?:ConformerTorsionHierarchy;
 discretePoints?:readonly ConformerDiscreteTorsionPoint[];
 warnings:readonly string[];
 displayPolicy?:ConformerFrameDisplayPolicy|null;
}
type Resolver=(frame:AdvancedResultFrame)=>ResolvedConformerPlaybackFrame;
const resolvers=new WeakMap<ReadonlyMap<string,AdvancedResultFrame>,Map<string,Resolver>>();
/** One display-only projection feeds preparation, publication, table and player.
 * Keep the actual candidate objects/IDs and every scientific source untouched.
 * All methods retain their accepted source order. */
export function projectConformerPlaybackCollection(collection:ConformerResultCollection,task:AdvancedTaskRecord|undefined):ConformerResultCollection{
 // The accepted source sequence is authoritative, including mixed methods and
 // duplicate native ordinals. Fixed-end planning supplies transforms, not sort order.
 return collection;
}
/** Prepare once per immutable UI task snapshot/configuration, then reuse for
 * every collection frame. No source reads, sampling, inference or state writes. */
export function createConformerPlaybackResolver(task:AdvancedTaskRecord|undefined,displayCoreIds?:readonly string[]):(frame:AdvancedResultFrame)=>ResolvedConformerPlaybackFrame{
 const byFrame=task?conformerPlaybackFrameIndex(task):new Map<string,AdvancedResultFrame>(),configuration=JSON.stringify([displayCoreIds??null,
  task?.runs.map(run=>[run.id,run.mixedSampling?.definition]),task?.mixedSampling?.batches?.map(batch=>[batch.id,batch.definition,batch.cards.map(card=>[card.id,card.configurationRevision,card.configuration])]),
  !task?.mixedSampling&&task?.spec?.kind==='conformer-search'?task.spec.search.torsions:null]);
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
  const protection=origin?.protection??ancestor.source.protection??run?.protection;
  const referenceSource=protection?.reference??origin?.source??mixed?.source??batch?.source??(!task?.mixedSampling?task?.spec.source:undefined);
  const cardId=origin?.cardId,cardRevision=origin&&'cardRevision' in origin&&typeof origin.cardRevision==='number'&&Number.isSafeInteger(origin.cardRevision)?origin.cardRevision:undefined;
  const savedCard=batch?.cards.find(value=>value.id===cardId&&value.configurationRevision===cardRevision);
  const card=mixed?.definition.cards.find(value=>value.id===cardId)??savedCard?.configuration??(cardRevision===undefined||cardRevision===1?batch?.definition.cards.find(value=>value.id===cardId):undefined);
  const revision=cardRevision===undefined?run?.id??frame.runId??'legacy':String(cardRevision);
  const blockKey=JSON.stringify([batchId??run?.id??frame.runId??frame.stageId,cardId??frame.stageId,revision,origin?.initialGuessId??mixed?.initialGuessId??'legacy']);
  // Soft sampling protection is not a hard XYZ freeze. MD/MTD display uses
  // the actual source constraints, otherwise every heavy atom with equal
  // weight. Flexible-key blocks retain their deterministic rigid-end plan.
  let coreAtomIds:readonly string[]=[],hierarchy:ConformerTorsionHierarchy|undefined,flexible=false;
  const hardFrozen=protection?.hardFrozenAtomIds??referenceSource?.constraints.frozenAtomIds??[];
  const restorationAtomIds=[...new Set([...hardFrozen,...(protection?.restorationAtomIds??origin?.protectedAtomIds??[])])];
  if(referenceSource){
   if(frame.kind==='guess'&&origin&&!card)warnings.push('缺少该批次该版本的柔性键定义，保持真实帧原顺序。');
   const torsions=card?.kind==='conformer-search'?card.search.torsions:!task?.mixedSampling&&task?.spec.kind==='conformer-search'?task.spec.search.torsions:undefined;
   if(torsions?.length&&hardFrozen.length){flexible=true;coreAtomIds=[...hardFrozen];}
   else if(torsions?.length){flexible=true;try{
    coreAtomIds=[...(displayCoreIds??hardFrozen)];
    const key=JSON.stringify([blockKey,coreAtomIds]);let plan=hierarchies.get(key);
    if(!plan){const snapshot=createConformerSnapshot(referenceSource.structure,referenceSource.ref,referenceSource.constraints);plan=planConformerTorsionHierarchy(snapshot,torsions.map(row=>row.torsion),coreAtomIds.length?coreAtomIds:undefined);hierarchies.set(key,plan);}
    coreAtomIds=plan.coreAtomIds;if(frame.kind==='guess')hierarchy=plan;
   }catch(error){coreAtomIds=[];warnings.push(error instanceof Error?error.message:String(error));}}
   else{
    const frozen=frame.kind==='optimized'?frame.source.constraints.frozenAtomIds:hardFrozen;
    coreAtomIds=frozen.length?[...frozen]:referenceSource.structure.atoms.flatMap(atom=>atom.element!=='H'&&atom.id?[atom.id]:[]);
   }
  }else warnings.push('缺少此批次实际初猜快照，保持原始坐标；未采用任务最初来源替代。');
  // Older saved frames kept the exact requested targets in their card's guess
  // record. Reuse that provenance rather than ranking repaired coordinates;
  // absent historical metadata remains an honest angle-based fallback.
  const guess=frame.kind==='guess'&&!origin?.discreteTorsions?.length?savedCard?.guesses?.guesses.find(guess=>guess.attempt===frame.source.ref.sourceFrameIndex):undefined;
  const discretePoints=frame.kind==='guess'?(origin?.discreteTorsions?.length?origin.discreteTorsions:guess?.torsions):undefined;
  const displayPolicy:ConformerFrameDisplayPolicy|null=frame.kind==='optimized'||frame.kind==='singlepoint'?null:{referenceSource,strategy:hardFrozen.length?'freeze':flexible?'flexible':'rmsd',fitAtomIds:hardFrozen.length?hardFrozen:coreAtomIds,restorationAtomIds,restricted:!referenceSource||!hardFrozen.length&&(flexible&&!coreAtomIds.length||frame.kind==='guess'&&!!origin&&!card)};
  const value={blockKey,referenceSource,coreAtomIds,hierarchy,discretePoints,warnings,displayPolicy};resolved.set(frame,value);return value;
 };
 owned.set(configuration,resolve);return resolve;
}
