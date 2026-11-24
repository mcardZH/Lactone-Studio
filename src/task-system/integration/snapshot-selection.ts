import type {SnapshotProjectSources,SnapshotScientificSourceFile} from './snapshot-project';
import type {MonitorSnapshotTarget} from '../application-contracts';
import type {SourceBoundary} from '../contracts';
import type {TrajectoryResult} from '../../results/contracts';
import {attachTrajectoryStages} from '../../results/trajectory-stages';

/** Confirm the adopted fixed asset still belongs to the selected monitor publication. */
export function assertSnapshotMonitorTarget(bundle:SnapshotProjectSources,target:MonitorSnapshotTarget):void {
  const {description}=bundle;
  if(description.runId!==target.runId || target.runId===null &&
    (description.sourceSetId!==target.sourceSetId || description.sourceVersion!==target.sourceVersion))
    throw Error('固定快照与监控页面选择的运行或来源版本不一致。');
  const expected=target.source;
  if(!expected)return;
  const file=description.files.find(value=>value.artifactId===expected.artifactId);
  const boundary=file?.provenance?.sourceBoundary as SourceBoundary|undefined;
  const source=expected.boundary.fileIdentity,fixed=boundary?.fileIdentity;
  const range=expected.boundary.publishedByteRange;
  const completeObservation=expected.boundary.readByteRange.start===range.start&&expected.boundary.readByteRange.end===range.end;
  if(!file||!fixed||fixed.fileId!==source.fileId||fixed.path!==source.path||fixed.environmentId!==source.environmentId||
    file.range.offset!==range.start||file.range.length!==range.end-range.start||
    completeObservation&&expected.observedSha256&&file.sha256!==expected.observedSha256)
    throw Error('固定快照字节与监控页面显示的原始来源不一致。');
}

/** The snapshot reader gives jobs new IDs. Keep the source job, native stage,
 * source-line anchor and original ordinal, then map into the local stage player. */
export function resolveSnapshotMonitorFrame(result:TrajectoryResult,frame:NonNullable<MonitorSnapshotTarget['frame']>):number|undefined {
  if(result.jobIndex!==frame.jobIndex)return;
  const stage=attachTrajectoryStages(result).stages?.find(item=>item.id===frame.stageId);
  const matches=stage?.frameIndices.flatMap((sourceIndex,index)=>{
    const source=result.frames[sourceIndex];
    return source&&(source.sourceFrameIndex??sourceIndex)===frame.sourceFrameIndex&&source.sourceLine===frame.sourceLine?[index]:[];
  });
  return matches?.length===1?matches[0]:undefined;
}

/** Raw restart/auxiliary bytes remain in the fixed snapshot. Only supported
 * result slots enter the existing source readers; paths/extensions confer no role. */
export function snapshotPostprocessSources(bundle:SnapshotProjectSources):SnapshotScientificSourceFile[]{
  const directWavefunctions=new Set(['gaussian-formatted-checkpoint','fchk','molden']);
  const selected=bundle.files.filter(file=>{
    const metadata=bundle.description.files.find(row=>row.sourceRef===file.snapshotIdentity.sourceRef);
    if(!metadata)throw Error('快照来源未列入固定清单。');
    if(metadata.representation==='binary')return false;
    if(metadata.roles.some(role=>['primary-output','trajectory','modes'].includes(role)))return true;
    return metadata.roles.includes('wavefunction')&&directWavefunctions.has(metadata.format??'');
  });
  if(!selected.length)throw Error('当前快照尚无可直接读取的OUT、轨迹、HESS、FCHK或Molden来源。');
  return selected;
}
