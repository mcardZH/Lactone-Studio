import type {Structure} from '../../core/types';
import type {TrajectoryResult} from '../../results/contracts';
import type {AdvancedResultFrame} from '../advanced/contracts';
import type {AdvancedFrameSource} from '../advanced/frame-source';
import {sha256Utf8} from '../../core/file-identity';
import {superposeViewAtoms} from '../view-superposition';

/** Pure run facts only. Scientific trajectory assets remain raw. */
export interface ConformerDisplayRestoration {
  schema:1;
  references:{sourceRef:AdvancedFrameSource['ref'];coordinatesFingerprint:string;structure:Structure;restorationAtomIds:string[];strategy?:'freeze'|'flexible'|'rmsd';fitAtomIds?:string[]}[];
  frameReferences:(number|null)[];
  unavailableFrameIndices?:number[];
}
export interface ConformerFrameDisplayPolicy {referenceSource?:AdvancedFrameSource;strategy:'freeze'|'flexible'|'rmsd';fitAtomIds:readonly string[];restorationAtomIds:readonly string[];restricted?:boolean}
type DisplayResult=TrajectoryResult&{displayRestoration?:ConformerDisplayRestoration};
export interface ConformerPlaybackDisplay {structure:Structure;restored:boolean;aligned:boolean;restriction?:string}
const batches=new WeakMap<TrajectoryResult,Map<number,ConformerPlaybackDisplay>>();
const projections=new WeakMap<Structure,ConformerPlaybackDisplay>();
export function createConformerDisplayRestoration(frames:readonly AdvancedResultFrame[],policies?:readonly (ConformerFrameDisplayPolicy|null)[]):ConformerDisplayRestoration|undefined {
  const references:ConformerDisplayRestoration['references']=[],keys=new Map<string,number>(),unavailableFrameIndices:number[]=[];
  const frameReferences=frames.map((frame,frameIndex)=>{
    // Optimization outputs already obey their own strict freeze contract.
    const origin=frame.samplingOrigin;if(frame.kind==='optimized'||frame.kind==='singlepoint')return null;
    const policy=policies?.[frameIndex];if(policy===null)return null;
    const protection=origin?.protection??(frame.process?.kind==='sampling'||frame.kind==='sampling-trajectory'||frame.kind==='sampled-candidate'?frame.source.protection:undefined),source=policy?policy.referenceSource:protection?.reference??origin?.source;
    if(policy?.restricted){unavailableFrameIndices.push(frameIndex);return null;}
    if(!source?.structure){if(policy||origin||protection)unavailableFrameIndices.push(frameIndex);return null;}
    const ids=[...(policy?.restorationAtomIds??protection?.restorationAtomIds??origin?.protectedAtomIds??[])];
    const item={sourceRef:structuredClone(source.ref),coordinatesFingerprint:source.stamp.coordinatesFingerprint,structure:structuredClone(source.structure),restorationAtomIds:ids,...(policy?{strategy:policy.strategy,fitAtomIds:[...policy.fitAtomIds]}:{})};
    const key=sha256Utf8(JSON.stringify(item));let index=keys.get(key);
    if(index===undefined){index=references.length;references.push(item);keys.set(key,index);}return index;
  });
  return references.length||unavailableFrameIndices.length?{schema:1,references,frameReferences,...(unavailableFrameIndices.length?{unavailableFrameIndices}:{})}:undefined;
}
export function validateConformerDisplayRestoration(value:ConformerDisplayRestoration|undefined,count:number):void {
  if(!value)return;
  if(value.schema!==1||!Array.isArray(value.references)||!Array.isArray(value.frameReferences)||value.frameReferences.length!==count
    ||value.frameReferences.some(index=>index!==null&&(!Number.isSafeInteger(index)||index<0||index>=value.references.length))
    ||value.unavailableFrameIndices?.some(index=>!Number.isSafeInteger(index)||index<0||index>=count))throw Error('构象显示恢复索引无效。');
  for(const reference of value.references){const ids=new Set(reference.structure.atoms.map(atom=>atom.id));
    if(ids.size!==reference.structure.atoms.length||new Set(reference.restorationAtomIds).size!==reference.restorationAtomIds.length
      ||reference.restorationAtomIds.some(id=>!ids.has(id))||reference.structure.atoms.some(atom=>![atom.x,atom.y,atom.z].every(Number.isFinite))
      ||reference.strategy!==undefined&&!['freeze','flexible','rmsd'].includes(reference.strategy)
      ||reference.fitAtomIds!==undefined&&(!Array.isArray(reference.fitAtomIds)||new Set(reference.fitAtomIds).size!==reference.fitAtomIds.length||reference.fitAtomIds.some(id=>!ids.has(id)))
      ||(reference.strategy!==undefined)!==(reference.fitAtomIds!==undefined))throw Error('构象显示恢复参考无效。');}
}
export function conformerDisplayRestorationRequiresFormat5(result:TrajectoryResult):boolean {
  return !!(result as DisplayResult).displayRestoration?.references.some(reference=>reference.restorationAtomIds.length);
}
export function conformerDisplayRestorationRequiresFormat6(value:ConformerDisplayRestoration|undefined):boolean {
  return !!value?.references.some(reference=>reference.strategy!==undefined||reference.fitAtomIds!==undefined);
}
export function releaseConformerPlaybackDisplay(result:TrajectoryResult):void {batches.delete(result);}
/** Called during the existing complete raw-frame admission. No IO or fitting on seeks. */
export function prepareConformerPlaybackDisplay(result:TrajectoryResult,index:number,raw:Structure):void {
  const metadata=(result as DisplayResult).displayRestoration;if(!metadata)return;
  let batch=batches.get(result);if(!batch){batch=new Map();batches.set(result,batch);}if(batch.has(index))return;
  const entry=metadata.frameReferences[index],reference=entry==null?undefined:metadata.references[entry];
  if(!reference){batch.set(index,{structure:raw,restored:false,aligned:false,...(metadata.unavailableFrameIndices?.includes(index)?{restriction:'本帧缺少可靠的运行参考，保留原始显示。'}:{})});return;}
  const original=new Map(reference.structure.atoms.map(atom=>[atom.id,atom]));
  const restricted=(message:string)=>batch!.set(index,{structure:raw,restored:false,aligned:false,restriction:message});
  if(original.size!==raw.atoms.length||raw.atoms.some(atom=>original.get(atom.id)?.element!==atom.element)){restricted('本帧缺少可靠的运行参考原子对应，保留原始显示。');return;}
  const ids=reference.fitAtomIds??(reference.restorationAtomIds.length?reference.restorationAtomIds:reference.structure.atoms.filter(atom=>atom.element!=='H').map(atom=>atom.id!));
  // Historical all-H structures keep their original display when heavy anchors do not exist.
  if(!ids.length){batch.set(index,{structure:raw,restored:false,aligned:false});return;}
  const selected=new Set(ids),fit=superposeViewAtoms({movingAtoms:raw.atoms.filter(atom=>selected.has(atom.id!)),referenceAtoms:reference.structure.atoms.filter(atom=>selected.has(atom.id!)),pairs:ids.map(id=>({movingAtomId:id,referenceAtomId:id})),mappingConfirmed:true});
  if(!fit.ok){restricted('本帧运行参考无法叠合，保留原始显示。');return;}
  const {rotation,translation}=fit.transform,restore=new Set(reference.restorationAtomIds);
  const atoms=raw.atoms.map(atom=>{
    if(restore.has(atom.id!)){const ref=original.get(atom.id)!;return{...atom,x:ref.x,y:ref.y,z:ref.z};}
    const point=[atom.x,atom.y,atom.z],moved=rotation.map((row,i)=>row.reduce((sum,v,j)=>sum+v*point[j],translation[i]));
    return{...atom,x:moved[0],y:moved[1],z:moved[2]};
  });
  batch.set(index,{structure:{...raw,atoms},restored:restore.size>0,aligned:true});
}
export function conformerPlaybackDisplay(result:TrajectoryResult,index:number,raw:Structure):ConformerPlaybackDisplay {
  const cached=batches.get(result)?.get(index);if(!cached)return{structure:raw,restored:false,aligned:false};
  if(!cached.aligned)return{...cached,structure:raw};
  const existing=projections.get(raw);if(existing?.structure.atoms===cached.structure.atoms)return existing;
  const projection={...cached,structure:{...raw,atoms:cached.structure.atoms}};projections.set(raw,projection);return projection;
}
/** A visual-only adapter. Raw XYZ/trajectory export must use the original result. */
export function conformerVisualTrajectory(result:TrajectoryResult):TrajectoryResult {
  if(!(result as DisplayResult).displayRestoration)return result;
  return{...result,async getFrame(index,signal){const raw=await result.getFrame(index,signal);return structuredClone(conformerPlaybackDisplay(result,index,raw).structure);},dispose(){}};
}
