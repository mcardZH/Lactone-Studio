import type {AdvancedResultFrame,AdvancedClusterCollection} from '../advanced/contracts';
import type {WorkspaceTrajectoryIdentity} from '../workspace-contracts';
import type {TrajectoryResult} from '../../results/contracts';
import {assertResultNotAborted} from '../../results/contracts';
import {trajectoryViewDocument} from '../../results/playback';
import {createLazyTrajectoryResult,type LazyTrajectoryInput} from '../../results/lazy-trajectory';

export interface ConformerTrajectoryResult extends TrajectoryResult {
  readonly identity:Readonly<WorkspaceTrajectoryIdentity>;
  /** Index is the playback projection; IDs remain the original frame identity. */
  readonly frameIds:readonly string[];
  readonly protectedAtomIds:readonly string[];
}
export interface ConformerResultCollection {
  clusterCollection?:AdvancedClusterCollection;
  playbackAvailable?:boolean;
  id:string;
  identity:WorkspaceTrajectoryIdentity;
  label:string;
  frames:readonly AdvancedResultFrame[];
  includeEnergies:boolean;
}
export function createLazyConformerTrajectory(input:LazyTrajectoryInput & {identity:WorkspaceTrajectoryIdentity;frameIds:readonly string[];protectedAtomIds?:readonly string[]}):ConformerTrajectoryResult {
  const {identity,frameIds,protectedAtomIds=[],...trajectory}=input;
  const ids=new Set(trajectory.initialStructure.atoms.map(atom=>atom.id));
  if(Object.values(identity).some(value=>typeof value!=='string'||!value)||frameIds.length!==trajectory.frames.length||new Set(frameIds).size!==frameIds.length||frameIds.some(id=>!id)
    ||new Set(protectedAtomIds).size!==protectedAtomIds.length||protectedAtomIds.some(id=>!ids.has(id)))throw new Error('构象轨迹的索引或保护原子身份不一致。');
  const referenceIds=new Map(trajectory.initialStructure.atoms.map(atom=>[atom.id,atom.element]));
  return Object.assign(createLazyTrajectoryResult({...trajectory,async readFrame(index,signal){
    const structure=await trajectory.readFrame(index,signal);
    if(structure.atoms.length!==referenceIds.size||structure.atoms.some(atom=>referenceIds.get(atom.id)!==atom.element))throw new Error('构象轨迹的原子身份不一致。');
    return structure;
  }}),{identity:Object.freeze({...identity}),frameIds:Object.freeze([...frameIds]),protectedAtomIds:Object.freeze([...protectedAtomIds])});
}
const validatedSources=new WeakMap<import('../../core/types').Structure,Set<string>>();

/** Adapt the complete accepted collection to the existing trajectory reader.
 * Sources, coordinates and producer metadata are never modified by browsing. */
export function createConformerTrajectory(input:Omit<ConformerResultCollection,'id'|'includeEnergies'>&{id?:string;includeEnergies?:boolean;referenceStructure?:import('../../core/types').Structure;protectedAtomIds?:readonly string[]}):ConformerTrajectoryResult {
  const {identity}=input;
  if(Object.values(identity).some(value=>typeof value!=='string'||!value)||!input.frames.length&&!input.referenceStructure)throw new Error('构象轨迹需要完整集合身份及至少一帧或明确参考结构。');
  // Producer frame sources are frozen scientific snapshots. Retain those small
  // references; copying the entire coordinate collection on every publication
  // defeats both hot playback and project lazy loading.
  const frames=input.frames.map(frame=>Object.isFrozen(frame.source.structure)?frame:{...frame,source:{...frame.source,structure:structuredClone(frame.source.structure)}}),frameIds=frames.map(frame=>frame.id);
  const reference=input.referenceStructure??frames[0].source.structure,protectedAtomIds=[...(input.protectedAtomIds??[])];
  const referenceIds=new Map(reference.atoms.map(atom=>[atom.id,atom.element]));
  const referenceKey=reference.atoms.map(atom=>`${atom.id}:${atom.element}`).join('|');
  if(referenceIds.size!==reference.atoms.length||frames.some(frame=>{
    const structure=frame.source.structure,known=validatedSources.get(structure);if(known?.has(referenceKey))return false;
    if(reference.atoms.length!==structure.atoms.length||new Set(structure.atoms.map(atom=>atom.id)).size!==structure.atoms.length||structure.atoms.some(atom=>referenceIds.get(atom.id)!==atom.element||![atom.x,atom.y,atom.z].every(Number.isFinite)))return true;
    if(Object.isFrozen(structure)){const keys=known??new Set<string>();keys.add(referenceKey);validatedSources.set(structure,keys);}return false;
  })
    ||new Set(protectedAtomIds).size!==protectedAtomIds.length||protectedAtomIds.some(id=>!referenceIds.has(id)))throw Error('构象固定参考结构或保护原子身份不一致。');
  if(new Set(frameIds).size!==frameIds.length||frameIds.some(id=>!id)||frames.some(frame=>frame.taskId!==identity.taskId))throw new Error('构象轨迹的帧身份重复或任务不一致。');
  // Revision belongs to the reader attachment, while collection identity belongs
  // to its workspace tab. A deterministic token preserves an unchanged reader.
  const revisionText=JSON.stringify(frames.map(frame=>[frame.id,frame.source.ref,frame.source.stamp.coordinatesFingerprint,input.includeEnergies?frame.energyHartree:null]));
  let revisionHash=2166136261;for(let index=0;index<revisionText.length;index++)revisionHash=Math.imul(revisionHash^revisionText.charCodeAt(index),16777619)>>>0;
  const id=`conformer:${JSON.stringify([identity.taskId,identity.runId,identity.stageId,identity.collectionId])}:${revisionHash.toString(16)}`;
  const result:ConformerTrajectoryResult={id,label:input.label,kind:'collection',engine:'structure',identity:Object.freeze({...identity}),frameIds:Object.freeze(frameIds),protectedAtomIds:Object.freeze(protectedAtomIds),
    source:{id,name:input.label,size:0},jobIndex:0,status:'completed',messages:[],initialStructure:structuredClone(reference),
    frames:frames.map((frame,index)=>({index,sourceFrameIndex:frame.source.ref.sourceFrameIndex,sourceStep:frame.step??null,
      label:`构象 ${index+1}`,stageId:identity.stageId,sourceLine:0,convergence:[],
      time:frame.process?.kind==='sampling'?{value:frame.process.data.timeFs,unit:'fs'}:null,
      energy:input.includeEnergies&&Number.isFinite(frame.energyHartree)?{value:frame.energyHartree!,unit:'Eh'}:null})),
    async getFrame(index,signal){assertResultNotAborted(signal);if(!Number.isSafeInteger(index)||index<0||index>=frames.length)throw new Error('轨迹帧号超出范围。');return structuredClone(frames[index].source.structure);},
    dispose(){},
  };
  // Validate every frame once at the boundary, including the folded-away rows.
  frames.forEach((frame,index)=>{if(!Object.isFrozen(frame.source.structure))trajectoryViewDocument(result,frame.source.structure,index);});
  return result;
}
