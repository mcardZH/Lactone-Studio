import { VibronicSha256 } from '../../core/gaussian-vibronic/sha256-stream';
import { resultFile } from '../../results/input-file';
import { readPostprocessSourceBytes, type PostprocessDocument } from '../../results/postprocess-document';
import { retainRawProjectCompanionCandidates, type RawProjectCompanionDescription } from '../../projects/companion-sources';
import type { SnapshotProjectSources } from './snapshot-project';

/** Task-system composition only. Project/scientific layers consume generic
 * immutable source identities, never task-system transports or path strings. */
export async function bindSnapshotCompanionCandidates(document:PostprocessDocument,bundle:SnapshotProjectSources):Promise<void>{
 const candidates=bundle.description.files.filter(file=>{
  const c=file.companionCandidate;return c&&(c.kind==='cis'||c.kind==='orca-json')&&c.rawReadable===true&&c.originVerified===true&&c.unambiguous===true&&c.scientificState==='unknown';
 });
 if(!candidates.length)return;
 const attachment=document.output;
 // A snapshot without a parsed ORCA OUT has no safe target for these candidates.
 if(!attachment||attachment.source.kind!=='orca-output')return;
 const actual=attachment.source.result.source;
 const possible=bundle.description.files.filter(file=>file.roles.includes('primary-output')&&file.name===actual.name&&file.byteSize===actual.size);
 if(!possible.length)throw Error('原始配套候选未找到当前OUT的固定来源。');
 // Compare real retained OUT bytes, without a full-source text/Buffer fallback.
 const hash=new VibronicSha256();for(let start=0;start<actual.size;start+=1024**2)hash.update(await readPostprocessSourceBytes(attachment,start,Math.min(actual.size,start+1024**2)));
 const revision=hash.digest(),matches=possible.filter(file=>file.sha256===revision);
 if(matches.length!==1)throw Error('原始配套候选与当前OUT SHA不符或来源不唯一。');
 const output=matches[0],original=bundle.files.find(file=>file.snapshotIdentity.sourceRef===output.sourceRef),originalIdentity=original?.snapshotIdentity;
 if(!original||original.name!==output.name||original.size!==output.byteSize||originalIdentity?.sha256!==output.sha256||originalIdentity.artifactId!==output.artifactId
  ||originalIdentity.snapshotId!==bundle.description.snapshotId||originalIdentity.taskId!==bundle.description.taskId||originalIdentity.runId!==bundle.description.runId||originalIdentity.libraryId!==bundle.description.libraryId)throw Error('当前OUT原文件不属于固定快照清单。');
 const inputs:{candidateId:string;input:ReturnType<typeof resultFile>}[]=[];
 try{
  const files:RawProjectCompanionDescription['files']=candidates.map(metadata=>{
   const file=bundle.files.find(file=>file.snapshotIdentity.sourceRef===metadata.sourceRef);
   const identity=file?.snapshotIdentity;
   if(!file||file.name!==metadata.name||file.size!==metadata.byteSize||identity?.sha256!==metadata.sha256||identity.artifactId!==metadata.artifactId||identity.snapshotId!==bundle.description.snapshotId
    ||identity.taskId!==bundle.description.taskId||identity.runId!==bundle.description.runId||identity.libraryId!==bundle.description.libraryId)throw Error('候选原始文件不属于当前固定快照。');
   const c=metadata.companionCandidate!;
   const input=resultFile(file);inputs.push({candidateId:metadata.sourceRef,input});
   return{candidateId:metadata.sourceRef,artifactId:metadata.artifactId,role:c.kind==='cis'?'orcaCis':'orcaJson',name:metadata.name,bytes:metadata.byteSize,revision:metadata.sha256,
    sourceIdentity:structuredClone(metadata.sourceIdentity),classification:{kind:c.kind as 'cis'|'orca-json',rawReadable:true,originVerified:true,unambiguous:true,scientificState:'unknown',evidence:[...c.evidence]}};
  });
  const description=bundle.description;
  if(description.runId===null&&(!description.sourceSetId||!description.sourceVersion))throw Error('无运行来源的原始配套缺少固定来源集合身份。');
  const origin:RawProjectCompanionDescription['origin']=description.runId===null
   ?{kind:'fixed-external-source-set',snapshotId:description.snapshotId,taskId:description.taskId,runId:null,libraryId:description.libraryId,outputArtifactId:output.artifactId,sourceSetId:description.sourceSetId!,sourceVersion:description.sourceVersion!}
   :{kind:'fixed-external-run',snapshotId:description.snapshotId,taskId:description.taskId,runId:description.runId,libraryId:description.libraryId,outputArtifactId:output.artifactId};
  retainRawProjectCompanionCandidates(attachment,{schema:1,sourceId:actual.id,output:{name:actual.name,bytes:actual.size,revision},origin,files},inputs);
 }catch(error){const outcomes=await Promise.allSettled(inputs.map(value=>value.input.close?.()));const failures=outcomes.filter((value):value is PromiseRejectedResult=>value.status==='rejected');if(failures.length)throw new AggregateError([error,...failures.map(value=>value.reason)],'候选绑定失败，部分读取租约仍待关闭。');throw error;}
}
