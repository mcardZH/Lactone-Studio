import type {ResultDiagnostic,ResultFrameSummary,TrajectoryResult} from '../../results/contracts';
import {traceInternalCoordinate,trajectoryScanDefinition} from '../../results/scientific-analysis';
import {attachTrajectoryStages} from '../../results/trajectory-stages';

type Job=TrajectoryResult|ResultDiagnostic;

export function jobEvidence(result:Job) {
  const diagnostics=result.scientific?.diagnostics;
  return {
    resultId:result.id,jobIndex:result.jobIndex,status:result.status,
    integrity:diagnostics?.integrity,termination:diagnostics?.termination??{status:'not-observed'},
    taskStates:diagnostics?.tasks??[],errors:diagnostics?.errors??[],
    availableFrameCount:result.kind==='diagnostic'?0:result.frames.length,
  };
}

export function fileTermination(jobs:readonly Job[]) {
  const lastLine=(job:Job)=>{
    const data=job.scientific,diagnostics=data?.diagnostics;
    return Math.max(job.kind==='diagnostic'?0:job.frames.at(-1)?.sourceLine??0,data?.inputGeometry?.endSourceLine??0,
      diagnostics?.termination.sourceLine??0,diagnostics?.errors.at(-1)?.sourceLine??0,
      diagnostics?.tasks.at(-1)?.sourceLine??0,diagnostics?.scf.at(-1)?.sourceLine??0);
  };
  // Jobs and geometry-less diagnostics can be published in separate arrays.
  // Resolve ordering within one job by the available native line anchors.
  const last=jobs.reduce<Job|undefined>((latest,job)=>{
    if(!latest)return job;
    if(latest.jobIndex!==null&&job.jobIndex!==null&&latest.jobIndex!==job.jobIndex)return job.jobIndex>latest.jobIndex?job:latest;
    return lastLine(job)>=lastLine(latest)?job:latest;
  },undefined);
  return last?{resultId:last.id,jobIndex:last.jobIndex,resultStatus:last.status,
    ...jobEvidence(last).termination}:undefined;
}

export function completedScan(result:TrajectoryResult) {
  if(!result.scientific?.tasks.includes('scan')&&result.role!=='scan-point-set'&&!result.stages?.some(stage=>stage.kind==='scan-points'))return;
  const stage=attachTrajectoryStages(result).stages?.find(stage=>stage.kind==='scan-points');
  if(!stage)return;
  const frames=stage.frameIndices.flatMap(index=>result.frames[index]?[result.frames[index]]:[]);
  return {stage,frames,resultId:`${result.id}:stage:${stage.id}`};
}

function scanFrame(frame:ResultFrameSummary) {
  return {frameIndex:frame.index,sourceFrameIndex:frame.sourceFrameIndex??frame.index,sourceLine:frame.sourceLine,
    point:frame.pathNode,energy:frame.energy,coordinate:frame.coordinate};
}

export async function scanReceipt(result:TrajectoryResult,options:{start:number;count:number;coordinates:boolean;signal?:AbortSignal}) {
  const scan=completedScan(result),frames=scan?.frames??[],last=frames.at(-1),lastReadable=result.frames.at(-1);
  const {start,count,coordinates,signal}=options;
  const measuredFrames=frames.slice(start,start+count);
  if(last&&!measuredFrames.includes(last))measuredFrames.push(last);
  const definition=coordinates?trajectoryScanDefinition(result):null;
  const trace=definition&&measuredFrames.length?await traceInternalCoordinate({
      ...result,frames:measuredFrames,getFrame:(index,signal)=>result.getFrame(measuredFrames[index].index,signal),
    },definition.kind,definition.atomIndices,signal):undefined;
  const values=new Map(trace?.points.map(row=>[measuredFrames[row.frameIndex].index,row.value]));
  const project=(frame:ResultFrameSummary)=>{
    const value=values.get(frame.index);
    return {...scanFrame(frame),...(trace&&value!=null?{measuredCoordinate:{value,unit:trace.unit,atomIndices:trace.atomIndices}}:{})};
  };
  const diagnostics=result.scientific?.diagnostics;
  return {stageId:scan?.stage.id,stageResultId:scan?.resultId,completedPointCount:frames.length,
    start,points:frames.slice(start,start+count).map(project),lastCompletedPoint:last?project(last):null,
    lastReadableFrame:lastReadable?scanFrame(lastReadable):null,scanCoordinates:result.scientific?.scanCoordinates??[],
    latestScfStatus:diagnostics?.scf.at(-1),latestScfCycle:result.scientific?.scfCycles.at(-1),
    ...jobEvidence(result),
  };
}

export function pngImageSize(bytes:Uint8Array) {
  if(bytes.length<24)return undefined;
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(data.getUint32(0)!==0x89504e47||data.getUint32(4)!==0x0d0a1a0a||data.getUint32(8)!==13||data.getUint32(12)!==0x49484452)return undefined;
  const width=data.getUint32(16),height=data.getUint32(20);
  return width&&height?{width,height}:undefined;
}
