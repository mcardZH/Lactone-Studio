import type {ModelDocument,FragmentSnapshot} from '../../modeling/contracts';
import {createBuilderDraft} from '../../core/builder-draft';
import {modelCoordinateKey,validateSharedConstraints} from '../../modeling/constraints';
import type {TrajectoryResult} from '../../results/contracts';
import {makeDocumentStamp} from '../../core/modeling/model-store';
import {captureAdvancedFrame,sameAdvancedFrame,type AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import type {AdvancedControllerState} from '../../modeling/advanced/contracts';
import type {PostprocessDocument} from '../../results/postprocess-document';
import type {AnalysisCanvas} from '../results/analysis-canvas';
import {readPreparedTrajectoryFrame} from '../results/usePreparedTrajectory';
import {graphFingerprint} from '../../core/modeling/graph';
import {baseElectronicStateError} from '../../core/base-electronic-state';
import {advancedDisplayDocument} from './advanced-display';
import type {ElectronicStateSourceContext} from '../../modeling/application/electronic-state-draft';

/** Local task overrides retain source identity and exact coordinates. Running
 * tasks continue owning the earlier immutable source object. */
export function overrideAdvancedTaskSource(source:AdvancedFrameSource,patch:{charge?:number;multiplicity?:number;protectionAtomIds?:readonly string[]}):AdvancedFrameSource{
 const structure={...source.structure,charge:patch.charge??source.structure.charge,multiplicity:patch.multiplicity??source.structure.multiplicity};
 const error=baseElectronicStateError(structure,{charge:structure.charge!,multiplicity:structure.multiplicity!});if(error)throw Error(error);
 const constraints=patch.protectionAtomIds===undefined?source.constraints:{...source.constraints,frozenAtomIds:[...patch.protectionAtomIds]};
 const next={...source,structure,constraints};
 const stamp=patch.protectionAtomIds===undefined?{...source.stamp,graphFingerprint:graphFingerprint(structure)}:makeDocumentStamp(advancedDisplayDocument({id:source.ref.documentId,revision:source.ref.revision},next));
 return captureAdvancedFrame(structure,source.ref,stamp,source.label,constraints);
}

/** Stage projections have their own result ID but retain a bound source/job. */
export function boundAdvancedCanvasResult(binding:PostprocessDocument|undefined,canvas:AnalysisCanvas|undefined):TrajectoryResult|undefined{
 if(!binding||!canvas?.result)return undefined;
 const sources=[binding.result,...[binding.output,binding.wavefunction,...(binding.companions??[])].flatMap(attachment=>attachment?[attachment.source.result,...attachment.source.results]:[])];
 return sources.some(result=>result.source.id===canvas.result!.source.id&&result.jobIndex===canvas.result!.jobIndex)?canvas.result:undefined;
}

/** A plain model has neither a result nor collection/source IDs. Missing IDs
 * are not matching identities merely because undefined === undefined. */
export function matchesAdvancedSourceCollection(source:AdvancedFrameSource,result:TrajectoryResult|undefined):result is TrajectoryResult{
 return Boolean(result&&source.ref.collectionId&&source.ref.sourceId&&result.id===source.ref.collectionId&&result.source.id===source.ref.sourceId);
}

/** A retained task owns its immutable input and frames independently of model tabs. */
export function retainedAdvancedSource(state:AdvancedControllerState,source:AdvancedFrameSource):boolean{
 const equal=(owned:AdvancedFrameSource)=>sameAdvancedFrame(owned.ref,source.ref)&&owned.coordinateUnit===source.coordinateUnit
  &&JSON.stringify(owned.stamp)===JSON.stringify(source.stamp)&&JSON.stringify(owned.structure)===JSON.stringify(source.structure)
  &&JSON.stringify(owned.constraints)===JSON.stringify(source.constraints);
 if(state.tasks.some(task=>task.mixedSampling?.initialGuesses.some(initial=>equal(initial.source))
  ||task.runs.some(run=>run.mixedSampling&&equal(run.mixedSampling.source))))return true;
 if(source.ref.taskId){const task=state.tasks.find(row=>row.id===source.ref.taskId);if(!task)return false;
  const frame=source.ref.runId?task.runs.find(run=>run.id===source.ref.runId)?.frames.find(row=>row.id===source.ref.frameId):task.guessFrames.find(row=>row.id===source.ref.frameId);
  return Boolean(frame&&equal(frame.source));
 }
 return state.tasks.some(task=>equal(task.spec.source));
}

/** Read the scientific frame again: animations/alignment never become inputs. */
type WorkspaceFrameCapture = {document:ModelDocument;documentEpoch:string;label:string;result?:TrajectoryResult;frameIndex?:number;signal?:AbortSignal;guard():void};

/** The raw editing path keeps unknown q/M. It shares the same scientific frame
 * read and before/after owner guard as executable capture, without inventing an
 * electronic state or relaxing captureAdvancedFrame's calculation contract. */
async function captureWorkspaceFrame<T>(p:WorkspaceFrameCapture,consume:(source:ElectronicStateSourceContext)=>T):Promise<T>{
 p.guard();
 if(p.signal?.aborted)throw Error('读取已取消。');
 if(p.result&&(p.frameIndex===undefined||!Number.isSafeInteger(p.frameIndex)||p.frameIndex<0||p.frameIndex>=p.result.frames.length))throw Error('请先在来源轨迹中显示所需的完整帧。');
 const structure=p.result?await readPreparedTrajectoryFrame(p.result,p.frameIndex!,p.signal):p.document.draft.structure;p.guard();if(p.signal?.aborted)throw Error('读取已取消。');
 const scientific={...p.document,draft:{...p.document.draft,structure}},frame=p.frameIndex===undefined?undefined:p.result?.frames[p.frameIndex];
 if(!structure.atoms.length||structure.atoms.some(atom=>!atom.id||![atom.x,atom.y,atom.z].every(Number.isFinite))
  ||new Set(structure.atoms.map(atom=>atom.id)).size!==structure.atoms.length)throw Error('当前帧需要完整有限坐标和唯一原子身份。');
 const constraints=p.document.sharedConstraints??{frozenAtomIds:[],coordinates:[]},ids=new Set(structure.atoms.map(atom=>atom.id));
 if(constraints.frozenAtomIds.some(id=>!ids.has(id))||constraints.coordinates.some(row=>row.atomIds.some(id=>!ids.has(id))))throw Error('当前帧的冻结定义不匹配原子身份。');
 return consume({structure:structuredClone(structure),ref:{documentId:p.document.id,documentEpoch:p.documentEpoch,revision:p.document.revision,
  ...(p.result?{sourceId:p.result.source.id,collectionId:p.result.id,frameId:`${p.result.id}:${frame?.sourceFrameIndex??p.frameIndex}`,stageId:frame?.stageId,sourceFrameIndex:frame?.sourceFrameIndex??p.frameIndex}: {})},
  stamp:makeDocumentStamp(scientific),label:p.label+(p.frameIndex===undefined?'':` · 帧 ${p.frameIndex+1}`),constraints:structuredClone(constraints),coordinateUnit:'angstrom'});
}
export function captureWorkspaceElectronicSourceContext(p:WorkspaceFrameCapture):Promise<ElectronicStateSourceContext>{
 return captureWorkspaceFrame(p,source=>source);
}
export function captureWorkspaceAdvancedSource(p:WorkspaceFrameCapture):Promise<AdvancedFrameSource>{
 return captureWorkspaceFrame(p,source=>captureAdvancedFrame(source.structure,source.ref,source.stamp,source.label,source.constraints));
}

/** Model-copy bookkeeping for an editing context, not a calculation capture.
 * Unknown q/M remain unknown until the target Store commits the explicit edit. */
export function electronicSourceEditingFragment(source:ElectronicStateSourceContext):FragmentSnapshot{
 if(source.coordinateUnit!=='angstrom')throw Error('编辑来源坐标单位不明确。');
 const structure=structuredClone(source.structure);structure.preparation=undefined;
 const sharedConstraints=structuredClone(source.constraints);sharedConstraints.canonical=true;
 const coordinateObjects=sharedConstraints.coordinates.map(row=>{
  row.objectId??=`advanced-frame-coordinate:${modelCoordinateKey(row)}`;row.id??=`advanced-frame-freeze:${row.objectId}`;
  return {id:row.objectId,type:row.type,atomIds:[...row.atomIds],...(row.images?{images:structuredClone(row.images)}:{})};
 });
 validateSharedConstraints(sharedConstraints,coordinateObjects,structure);
 return {structure,assignments:createBuilderDraft(structure).assignments,auxiliaryRelations:[],deletedBonds:[],internalCoordinates:[],sharedConstraints,coordinateObjects};
}

/** Explicit, bounded collection read. It never drives a player or requests a
 * calculator. Every retained item is a complete immutable scientific frame. */
export async function captureWorkspaceAdvancedCollection(p:{document:ModelDocument;documentEpoch:string;label:string;result:TrajectoryResult;indices:readonly number[];stageId?:string;signal?:AbortSignal;guard():void}):Promise<AdvancedFrameSource[]>{
 p.guard();
 if(!p.indices.length||new Set(p.indices).size!==p.indices.length||p.indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=p.result.frames.length))throw Error('请选择不重复的真实源帧；没有自动抽帧。');
 const stages=new Set(p.indices.map(i=>p.result.frames[i].stageId));
 if(stages.size>1||p.stageId!==undefined&&[...stages][0]!==p.stageId)throw Error('叠合范围不能跨科学阶段，请在同一真实过程集合内选择。');
 const frames:AdvancedFrameSource[]=[];
 for(const frameIndex of p.indices){const source=await captureWorkspaceAdvancedSource({...p,frameIndex});frames.push(source);}
 p.guard();return frames;
}
