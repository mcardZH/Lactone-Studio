import type { SurfaceContext } from '../results/surface-contracts';
import { isScientificFileDocument, type PostprocessAttachment, type PostprocessFileAttachment, type PostprocessFileDocument } from '../results/postprocess-document';
import { isScientificFileSource } from '../results/postprocess-sources';
import type { ProjectAssetReader, ProjectAssetWriter } from './result-snapshot';
import { readPostprocessSourceBytes } from '../results/postprocess-document';
import { assertResultNotAborted, type ResultInputFile } from '../results/contracts';
import { VibronicSha256 } from '../core/gaussian-vibronic/sha256-stream';
export type ProjectCompanionRole = 'output' | 'orcaJson' | 'orcaCis';
export interface ProjectCompanionFile { role: ProjectCompanionRole; name: string; revision: string; bytes: number }
export interface ProjectCompanionDescription { sourceId: string; context: SurfaceContext; files: ProjectCompanionFile[] }
export interface ProjectCompanionBundleSnapshot extends Omit<ProjectCompanionDescription,'files'> { files: (ProjectCompanionFile & { chunks: { assetId: string; bytes: number }[] })[] }
export interface RawProjectCompanionClassification {
 kind:'cis'|'orca-json';rawReadable:true;originVerified:true;unambiguous:true;scientificState:'unknown';evidence:string[];
}
export type RawProjectCompanionOrigin = {kind:'fixed-external-run';snapshotId:string;taskId:string;runId:string;libraryId:string;outputArtifactId:string}
 | {kind:'fixed-external-source-set';snapshotId:string;taskId:string;runId:null;libraryId:string;outputArtifactId:string;sourceSetId:string;sourceVersion:string}
 | {kind:'explicit-user-selection';snapshotId:string;outputSourceId:string};
export interface RawProjectCompanionDescription {
 schema:1;sourceId:string;output:{name:string;bytes:number;revision:string};
 origin:RawProjectCompanionOrigin;
 files:{candidateId:string;artifactId:string;role:'orcaJson'|'orcaCis';name:string;bytes:number;revision:string;sourceIdentity:Record<string,unknown>;classification:RawProjectCompanionClassification}[];
}
export interface ProjectRawCompanionBundleSnapshot extends Omit<RawProjectCompanionDescription,'files'> {
 files:(RawProjectCompanionDescription['files'][number]&{chunks:{assetId:string;bytes:number}[]})[];
}
export interface ProjectCompanionBridge {
 describeExcitationProjectCompanions?(sessionId: string): Promise<ProjectCompanionDescription | null>;
 readExcitationProjectCompanion?(sessionId: string, role: ProjectCompanionRole, start: number, end: number): Promise<Uint8Array>;
 releaseExcitationProjectCompanions?(sessionId: string): Promise<{ released: boolean }>;
 beginProjectCompanionBundle?(request: { files: ProjectCompanionFile[];mode?:'explicit-raw-candidates-v1' }): Promise<{ bundleId: string }>;
 appendProjectCompanionBundle?(bundleId: string, role: ProjectCompanionRole, start: number, bytes: Uint8Array): Promise<{ written: number }>;
 commitProjectCompanionBundle?(bundleId: string): Promise<{ bundleId: string; sourceToken: string }>;
 abortProjectCompanionBundle?(bundleId: string): Promise<{ closed: boolean }>;
 closeProjectCompanionBundle?(bundleId: string): Promise<{ closed: boolean }>;
}
const CHUNK=1024**2;
type RawLive={description:RawProjectCompanionDescription;inputs:Map<string,ResultInputFile>};
type Binding={live:Map<string,ProjectCompanionBridge>;saved?:ProjectCompanionBundleSnapshot[];reader?:ProjectAssetReader;uploads:Map<string,Promise<{bundleId:string;sourceToken:string}>>;api?:ProjectCompanionBridge;version:number;closed:boolean;rawSelection?:string;
 rawLive:Map<string,RawLive>;rawSaved?:ProjectRawCompanionBundleSnapshot[];rawUploads:Map<string,{api:ProjectCompanionBridge;task:Promise<{bundleId:string;sourceToken:string}>}>;pendingAborts:Map<string,ProjectCompanionBridge>;closing?:Promise<void>};
const bindings=new WeakMap<PostprocessAttachment['source'],Binding>();
let revision=0;
const contextKey=(c:SurfaceContext)=>JSON.stringify([c.sourceId,c.sourceRevision,c.jobIndex,c.sourceFrameIndex,c.generation,c.documentId,c.documentRevision]);
const signature=(b:ProjectCompanionDescription)=>JSON.stringify([contextKey(b.context),b.sourceId,b.files.map(f=>[f.role,f.name,f.revision,f.bytes])]);
async function closeBinding(own:Binding):Promise<void>{
 if(own.closing)return own.closing;own.closed=true;
 own.closing=(async()=>{
  const outcomes=await Promise.allSettled([
   ...[...own.live].map(async([id,api])=>{if(!api.releaseExcitationProjectCompanions)throw Error('配套来源关闭入口不可用。');await api.releaseExcitationProjectCompanions(id);own.live.delete(id);}),
   ...[...own.uploads].map(async([key,task])=>{const uploaded=await task,api=own.api??desktop();if(!api?.closeProjectCompanionBundle)throw Error('配套来源关闭入口不可用。');await api.closeProjectCompanionBundle(uploaded.bundleId);own.uploads.delete(key);}),
   ...[...own.rawLive].map(async([key,live])=>{const closed=await Promise.allSettled([...live.inputs.values()].map(input=>input.close?.()));const failures=closed.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'候选来源读取租约仍待关闭。');own.rawLive.delete(key);}),
   ...[...own.rawUploads].map(async([key,pending])=>{let uploaded;try{uploaded=await pending.task;}catch{own.rawUploads.delete(key);return;}if(!pending.api.closeProjectCompanionBundle)throw Error('候选来源关闭入口不可用。');await pending.api.closeProjectCompanionBundle(uploaded.bundleId);own.rawUploads.delete(key);}),
  ]);
  const aborts=await Promise.allSettled([...own.pendingAborts].map(async([id,api])=>{await api.abortProjectCompanionBundle!(id);own.pendingAborts.delete(id);}));
  const failures=[...outcomes,...aborts].filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'部分配套来源owner仍待实际关闭。');
 })().finally(()=>{own.closing=undefined;});return own.closing;
}
function binding(attachment:PostprocessAttachment){let b=bindings.get(attachment.source);if(b)return b;b={live:new Map(),uploads:new Map(),rawLive:new Map(),rawUploads:new Map(),pendingAborts:new Map(),version:0,closed:false,...(attachment.source.excitationCompanionSelection==='none'?{rawSelection:'none'}:{})};bindings.set(attachment.source,b);const own=b;
 for(const result of new Set([attachment.source.result,...attachment.source.results])){const dispose=result.dispose.bind(result);result.dispose=async()=>{await closeBinding(own);return dispose();};}return b;}
const desktop=():ProjectCompanionBridge|undefined=>typeof window==='undefined'?undefined:window.sciyueDesktop;
export function retainExcitationProjectCompanions(attachment:PostprocessAttachment,sessionId:string,api:ProjectCompanionBridge):void {const b=binding(attachment);b.live.set(sessionId,api);b.version=++revision;}
export function projectCompanionVersion(attachment?:PostprocessFileAttachment):number{return attachment&&!isScientificFileSource(attachment.source)?bindings.get(attachment.source)?.version??0:0;}
/** Cache invalidation only: immutable job/source facts and live TD selection revisions, no source IO. */
export function postprocessFileDocumentVersion(document:PostprocessFileDocument):string{
 const attachment=(value:PostprocessFileAttachment|undefined)=>value?[isScientificFileSource(value.source)?value.source.identity.id:value.source.result.source.id,value.role??null,projectCompanionVersion(value),isScientificFileSource(value.source)?value.source.selectedJobId??null:value.source.excitationCompanionSelection??null]:null;
 return JSON.stringify([document.id,isScientificFileDocument(document)?document.output.source.selectedJobId??null:document.result.id,attachment(document.output),attachment(document.wavefunction),...(document.companions??[]).map(attachment),isScientificFileDocument(document)?document.displayResult?.id??null:document.wavefunctionFrameIndex??null,isScientificFileDocument(document)?document.extraSources?.map(source=>[source.sourceId,source.revision,source.byteSize,source.format,source.role??null])??[]:[]]);
}
export function restoreProjectCompanionBundles(attachment:PostprocessAttachment,bundles:ProjectCompanionBundleSnapshot[],reader:ProjectAssetReader):void{
 if(!Array.isArray(bundles))throw new Error('项目ORCA配套索引无效。');if(!bundles.length)return;
 for(const bundle of bundles){if(bundle.sourceId!==attachment.source.result.source.id||bundle.context.sourceId!==bundle.sourceId||!Array.isArray(bundle.files)||bundle.files.length<2||bundle.files.length>3)throw new Error('项目ORCA配套来源身份无效。');const roles=new Set<string>();let total=0;
  for(const file of bundle.files){if(!['output','orcaJson','orcaCis'].includes(file.role)||roles.has(file.role)||typeof file.name!=='string'||/[\\/:]/.test(file.name)||!/^[a-f0-9]{64}$/.test(file.revision)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!Array.isArray(file.chunks)||file.chunks.some(chunk=>typeof chunk.assetId!=='string'||!Number.isSafeInteger(chunk.bytes)||chunk.bytes<=0||chunk.bytes>CHUNK)||file.chunks.reduce((sum,chunk)=>sum+chunk.bytes,0)!==file.bytes)throw new Error('项目ORCA配套文件或分块索引无效。');roles.add(file.role);total+=file.bytes;}
  if(!roles.has('output')||!Number.isSafeInteger(total))throw new Error('项目ORCA配套大小无效。');
 }const b=binding(attachment);b.saved=structuredClone(bundles);b.reader=reader;
}
/** Only source snapshots already bound by an opened native session are read.
 * No sibling lookup or original absolute path is available here. */
export async function captureProjectCompanionBundles(attachment:PostprocessAttachment,writer:ProjectAssetWriter):Promise<ProjectCompanionBundleSnapshot[]|undefined>{
 const b=bindings.get(attachment.source);if(!b)return undefined;if(b.closed)throw new Error('ORCA配套来源已关闭。');
 const output:ProjectCompanionBundleSnapshot[]=[],seen=new Set<string>();
 for(const saved of b.saved??[]){const files:ProjectCompanionBundleSnapshot['files']=[];for(const file of saved.files){const chunks=[];for(const chunk of file.chunks){const bytes=await b.reader!.read(chunk.assetId);if(bytes.byteLength!==chunk.bytes)throw new Error('项目ORCA配套原始分块损坏。');chunks.push({...await writer.write('sources',file.name,bytes),bytes:bytes.byteLength});}files.push({...file,chunks});}output.push({...saved,files});seen.add(signature(saved));}
 for(const [sessionId,api]of b.live){if(!api.describeExcitationProjectCompanions||!api.readExcitationProjectCompanion)throw new Error('当前版本缺少已绑定ORCA配套快照的保存入口。');const description=await api.describeExcitationProjectCompanions(sessionId);if(!description)continue;if(description.sourceId!==attachment.source.result.source.id)throw new Error('ORCA配套快照不属于当前OUT。');if(seen.has(signature(description)))continue;
  const files:ProjectCompanionBundleSnapshot['files']=[];for(const file of description.files){const chunks=[];for(let start=0;start<file.bytes;start+=CHUNK){const end=Math.min(file.bytes,start+CHUNK),bytes=await api.readExcitationProjectCompanion(sessionId,file.role,start,end);if(bytes.byteLength!==end-start)throw new Error('ORCA配套快照读取不完整。');chunks.push({...await writer.write('sources',file.name,bytes),bytes:bytes.byteLength});}files.push({...file,chunks});}output.push({...description,files});seen.add(signature(description));
 }
 return output.length?output:undefined;
}
/** Undefined means this attachment has no saved bundle; callers may use their
 * original live capability. A saved bundle never falls back to old disk paths. */
export async function projectCompanionSourceToken(attachment:PostprocessAttachment,context:SurfaceContext,api:ProjectCompanionBridge=desktop()??{},outputIdentity?:{sourceId:string;revision:string}):Promise<{restored:boolean;token?:string}>{
 if(attachment.source.excitationCompanionSelection==='none')return{restored:true};
 const b=bindings.get(attachment.source);if(!b)return{restored:false};if(b.closed)throw new Error('项目ORCA配套来源已关闭。');
 if(b.rawSelection)return rawCompanionSourceToken(attachment,b,api,outputIdentity);
 if(!b.saved?.some(bundle=>contextKey(bundle.context)===contextKey(context)))return rawCompanionSourceToken(attachment,b,api,outputIdentity);
 b.api=api;
 const matches=b.saved.filter(bundle=>contextKey(bundle.context)===contextKey(context));
 if(!matches.length)return{restored:true};if(matches.length>1)throw new Error('当前原帧有多个不同的ORCA配套快照，请重新明确分析来源。');
 const bundle=matches[0],key=signature(bundle);let pending=b.uploads.get(key);if(!pending){pending=(async()=>{
  if(!api.beginProjectCompanionBundle||!api.appendProjectCompanionBundle||!api.commitProjectCompanionBundle||!api.abortProjectCompanionBundle)throw new Error('当前版本缺少项目ORCA配套恢复入口。');
  const {bundleId}=await api.beginProjectCompanionBundle({files:bundle.files.map(({chunks:_chunks,...file})=>file)});
  try{for(const file of bundle.files){let start=0;for(const chunk of file.chunks){const bytes=await b.reader!.read(chunk.assetId);if(bytes.byteLength!==chunk.bytes)throw new Error('项目ORCA配套分块损坏。');for(let offset=0;offset<bytes.byteLength;offset+=CHUNK){const part=bytes.subarray(offset,Math.min(bytes.byteLength,offset+CHUNK));const receipt=await api.appendProjectCompanionBundle(bundleId,file.role,start,part);if(receipt.written!==part.byteLength)throw new Error('项目ORCA配套上传未完成。');start+=part.byteLength;}}if(start!==file.bytes)throw new Error('项目ORCA配套总长度不符。');}return await api.commitProjectCompanionBundle(bundleId);}catch(error){await api.abortProjectCompanionBundle(bundleId).catch(()=>{});throw error;}
 })();b.uploads.set(key,pending);void pending.catch(()=>{if(b.uploads.get(key)===pending)b.uploads.delete(key);});}
 return{restored:true,token:(await pending).sourceToken};
}

const sha=/^[a-f0-9]{64}$/;
const safeName=(name:unknown):name is string=>typeof name==='string'&&Boolean(name)&&name!=='.'&&name!=='..'&&!/[\\/:\0]/.test(name);
const rawSignature=(bundle:RawProjectCompanionDescription)=>JSON.stringify([bundle.sourceId,bundle.output,bundle.origin,bundle.files.map(file=>[file.candidateId,file.role,file.name,file.bytes,file.revision])]);
function validateRawDescription(attachment:PostprocessAttachment,bundle:RawProjectCompanionDescription):void{
 const identity=attachment.source.result.source;
 if(attachment.source.kind!=='orca-output'||bundle.schema!==1||bundle.sourceId!==identity.id||!bundle.output||bundle.output.name!==identity.name||bundle.output.bytes!==identity.size||!sha.test(bundle.output.revision)
  ||!bundle.origin||!bundle.origin.snapshotId
  ||(bundle.origin.kind==='explicit-user-selection'?bundle.origin.outputSourceId!==identity.id:!['fixed-external-run','fixed-external-source-set'].includes(bundle.origin.kind)||![bundle.origin.taskId,bundle.origin.libraryId,bundle.origin.outputArtifactId].every(value=>typeof value==='string'&&Boolean(value))||(bundle.origin.kind==='fixed-external-run'?typeof bundle.origin.runId!=='string'||!bundle.origin.runId:bundle.origin.runId!==null||![bundle.origin.sourceSetId,bundle.origin.sourceVersion].every(value=>typeof value==='string'&&Boolean(value))))
  ||!Array.isArray(bundle.files)||bundle.files.length<1||bundle.files.length>2)throw Error('原始配套候选的OUT或出处身份无效。');
 const ids=new Set<string>(),roles=new Set<string>();
 for(const file of bundle.files){const c=file.classification;
  if(!file.candidateId||ids.has(file.candidateId)||!file.artifactId||!['orcaCis','orcaJson'].includes(file.role)||roles.has(file.role)||!safeName(file.name)||!sha.test(file.revision)||!Number.isSafeInteger(file.bytes)||file.bytes<=0
   ||!c||c.kind!==(file.role==='orcaCis'?'cis':'orca-json')||c.rawReadable!==true||c.originVerified!==true||c.unambiguous!==true||c.scientificState!=='unknown'||!Array.isArray(c.evidence)||!c.evidence.every(value=>typeof value==='string')
   ||!file.sourceIdentity||typeof file.sourceIdentity!=='object'||Array.isArray(file.sourceIdentity))throw Error('原始配套候选身份或原分类状态无效。');
  ids.add(file.candidateId);roles.add(file.role);
 }
}
/** Takes ownership of these already-retained inputs only after all validation.
 * Scientific compatibility remains unknown; no native session/context is made. */
export function retainRawProjectCompanionCandidates(attachment:PostprocessAttachment,description:RawProjectCompanionDescription,inputs:readonly{candidateId:string;input:ResultInputFile}[]):void{
 validateRawDescription(attachment,description);
 const byId=new Map(inputs.map(row=>[row.candidateId,row.input]));
 if(byId.size!==inputs.length||byId.size!==description.files.length||description.files.some(file=>{const input=byId.get(file.candidateId);return !input||input.name!==file.name||input.size!==file.bytes;}))throw Error('候选原始来源与固定清单不对应。');
 const b=binding(attachment);if(b.closed)throw Error('原始配套候选来源已关闭。');
 const key=rawSignature(description);if(b.rawLive.has(key))throw Error('该候选原始来源已经登记。');
 b.rawLive.set(key,{description:structuredClone(description),inputs:byId});b.version=++revision;
}
export function listExplicitExcitationCompanions(attachment:PostprocessAttachment):ProjectCompanionFile[]{
 const b=bindings.get(attachment.source);if(!b||b.closed)return[];
 const bundles=[...[...b.rawLive.values()].map(value=>value.description),...b.rawSaved??[]].filter(value=>!b.rawSelection||rawSignature(value)===b.rawSelection);
 return bundles.flatMap(value=>value.files.map(file=>({role:file.role,name:file.name,revision:file.revision,bytes:file.bytes})));
}
/** Merge one card with the retained other role, including lazy saved assets. */
export async function updateExplicitExcitationCompanion(attachment:PostprocessAttachment,role:'orcaJson'|'orcaCis',input:ResultInputFile|null,signal?:AbortSignal):Promise<ProjectCompanionFile[]>{
 const b=bindings.get(attachment.source),files:{role:'orcaJson'|'orcaCis';input:ResultInputFile}[]=[];
 if(b&&!b.closed&&b.rawSelection!=='none'){
  const live=[...b.rawLive.values()].filter(value=>!b.rawSelection||rawSignature(value.description)===b.rawSelection),saved=(b.rawSaved??[]).filter(value=>!b.rawSelection||rawSignature(value)===b.rawSelection);
  if(live.length+saved.length>1)throw Error('现有多份振幅候选需先明确选择，未按导入顺序覆盖。');
  if(live[0])for(const file of live[0].description.files)if(file.role!==role)files.push({role:file.role,input:live[0].inputs.get(file.candidateId)!});
  if(saved[0])for(const file of saved[0].files)if(file.role!==role){const raw:ResultInputFile={id:file.artifactId,name:file.name,size:file.bytes,
   stream(){let index=0;return new ReadableStream<Uint8Array>({async pull(controller){if(b.closed)return controller.error(Error('振幅来源已关闭。'));if(index===file.chunks.length)return controller.close();const chunk=file.chunks[index++],bytes=await b.reader!.read(chunk.assetId);if(bytes.length!==chunk.bytes)return controller.error(Error('振幅候选分块损坏。'));controller.enqueue(bytes);}});},
   async readRange(start,end,readSignal){assertResultNotAborted(readSignal);if(b.closed||![start,end].every(Number.isSafeInteger)||start<0||end<start||end>file.bytes)throw Error('振幅候选读取范围无效或已关闭。');const output=new Uint8Array(end-start);let offset=0;for(const chunk of file.chunks){const next=offset+chunk.bytes;if(next>start&&offset<end){const bytes=await b.reader!.read(chunk.assetId);assertResultNotAborted(readSignal);if(b.closed||bytes.length!==chunk.bytes)throw Error('振幅候选分块损坏。');const first=Math.max(start,offset),last=Math.min(end,next);output.set(bytes.subarray(first-offset,last-offset),first-start);}offset=next;}return output;},close(){/* Borrowed saved asset, owned by the OUT source. */}};files.push({role:file.role,input:raw});}
 }
 if(input)files.push({role,input});
 return retainExplicitExcitationCompanions(attachment,files,signal);
}
/** User selection establishes an immutable candidate set, not scientific compatibility.
 * Native amplitude/state checks still gate NTO/electron-hole calculations. */
export async function retainExplicitExcitationCompanions(attachment:PostprocessAttachment,files:readonly{role:'orcaJson'|'orcaCis';input:ResultInputFile}[],signal?:AbortSignal):Promise<ProjectCompanionFile[]>{
 if(attachment.source.kind!=='orca-output'||!attachment.source.tasks.includes('td'))throw Error('显式振幅候选只接入ORCA TD来源。');
 if(new Set(files.map(file=>file.role)).size!==files.length||files.some(file=>!['orcaJson','orcaCis'].includes(file.role)||!safeName(file.input.name)||!Number.isSafeInteger(file.input.size)||file.input.size<=0))throw Error('振幅候选角色、名称或长度无效。');
 const identity=attachment.source.result.source,hash=new VibronicSha256();
 for(let start=0;start<identity.size;start+=CHUNK){const end=Math.min(identity.size,start+CHUNK),bytes=await readPostprocessSourceBytes(attachment,start,end,signal);assertResultNotAborted(signal);hash.update(bytes);}
 const output={name:identity.name,bytes:identity.size,revision:hash.digest()},snapshotId=crypto.randomUUID();
 const rows:RawProjectCompanionDescription['files']=[];
 for(const file of files){const digest=new VibronicSha256();for(let start=0;start<file.input.size;start+=CHUNK){const end=Math.min(file.input.size,start+CHUNK),bytes=await file.input.readRange(start,end,signal);assertResultNotAborted(signal);if(bytes.length!==end-start)throw Error('振幅候选在选择时变化。');digest.update(bytes);}
  rows.push({candidateId:`explicit:${snapshotId}:${file.role}`,artifactId:file.input.id,role:file.role,name:file.input.name,bytes:file.input.size,revision:digest.digest(),sourceIdentity:{id:file.input.id,name:file.input.name,size:file.input.size},classification:{kind:file.role==='orcaCis'?'cis':'orca-json',rawReadable:true,originVerified:true,unambiguous:true,scientificState:'unknown',evidence:['用户显式选择并绑定OUT及候选完整SHA；软件/job/电子态与振幅仍待原生验证']}});
 }
 assertResultNotAborted(signal);
 const b=binding(attachment);if(b.closed)throw Error('振幅来源owner已关闭。');
 if(!files.length){b.rawSelection='none';attachment.source.excitationCompanionSelection='none';b.version=++revision;return[];}
 const description:RawProjectCompanionDescription={schema:1,sourceId:identity.id,output,origin:{kind:'explicit-user-selection',snapshotId,outputSourceId:identity.id},files:rows};
 retainRawProjectCompanionCandidates(attachment,description,rows.map((row,index)=>({candidateId:row.candidateId,input:files[index].input})));
 b.rawSelection=rawSignature(description);attachment.source.excitationCompanionSelection='explicit';b.version=++revision;
 return rows.map(row=>({role:row.role,name:row.name,bytes:row.bytes,revision:row.revision}));
}
/** The raw OUT SHA is independent from any wavefunction SurfaceContext revision. */
export function rawProjectCompanionOutputIdentity(attachment:PostprocessAttachment):{sourceId:string;name:string;size:number;revision:string}|undefined{
 const b=bindings.get(attachment.source);if(!b)return undefined;if(b.closed)throw Error('原始配套候选来源已关闭。');
 const bundles=[...[...b.rawLive.values()].map(value=>value.description),...b.rawSaved??[]].filter(value=>!b.rawSelection||rawSignature(value)===b.rawSelection);if(!bundles.length)return undefined;
 const first=bundles[0];for(const value of bundles)if(value.sourceId!==first.sourceId||JSON.stringify(value.output)!==JSON.stringify(first.output))throw Error('原始候选集合的OUT身份冲突。');
 return{sourceId:first.sourceId,name:first.output.name,size:first.output.bytes,revision:first.output.revision};
}
export function restoreRawProjectCompanionCandidates(attachment:PostprocessAttachment,bundles:ProjectRawCompanionBundleSnapshot[],reader:ProjectAssetReader,outputRevision:string|undefined):void{
 if(!Array.isArray(bundles)||!bundles.length||!outputRevision||!sha.test(outputRevision))throw Error('原始配套候选索引或OUT SHA无效。');
 for(const bundle of bundles){validateRawDescription(attachment,bundle);if(bundle.output.revision!==outputRevision)throw Error('原始候选集合与保存OUT SHA不一致。');
  for(const file of bundle.files)if(!Array.isArray(file.chunks)||file.chunks.some(chunk=>!chunk.assetId||!Number.isSafeInteger(chunk.bytes)||chunk.bytes<=0||chunk.bytes>CHUNK)||file.chunks.reduce((sum,chunk)=>sum+chunk.bytes,0)!==file.bytes)throw Error('原始配套候选分块索引无效。');
 }
 const b=binding(attachment);b.rawSaved=structuredClone(bundles);b.reader=reader;
 const explicit=bundles.filter(bundle=>bundle.origin.kind==='explicit-user-selection');if(explicit.length===1)b.rawSelection=rawSignature(explicit[0]);
}
/** Saved candidates are copied even when never materialized or used in native analysis. */
export async function captureRawProjectCompanionCandidates(attachment:PostprocessAttachment,writer:ProjectAssetWriter):Promise<ProjectRawCompanionBundleSnapshot[]|undefined>{
 const b=bindings.get(attachment.source);if(!b)return undefined;if(b.closed)throw Error('原始配套候选来源已关闭。');
 const output:ProjectRawCompanionBundleSnapshot[]=[],seen=new Set<string>();
 for(const saved of b.rawSaved??[]){if(b.rawSelection&&rawSignature(saved)!==b.rawSelection)continue;const files:ProjectRawCompanionBundleSnapshot['files']=[];
  for(const file of saved.files){const chunks=[],hash=new VibronicSha256();for(const chunk of file.chunks){if(b.closed)throw Error('原始配套候选来源已关闭。');const bytes=await b.reader!.read(chunk.assetId);if(bytes.byteLength!==chunk.bytes)throw Error('项目原始候选分块损坏。');hash.update(bytes);chunks.push({...await writer.write('sources',file.name,bytes),bytes:bytes.byteLength});}if(hash.digest()!==file.revision)throw Error('项目原始候选SHA不符。');files.push({...structuredClone(file),chunks});}
  output.push({...structuredClone(saved),files});seen.add(rawSignature(saved));
 }
 for(const live of b.rawLive.values()){if(b.rawSelection&&rawSignature(live.description)!==b.rawSelection||seen.has(rawSignature(live.description)))continue;const files:ProjectRawCompanionBundleSnapshot['files']=[];
  for(const file of live.description.files){const chunks=[],hash=new VibronicSha256(),input=live.inputs.get(file.candidateId)!;for(let start=0;start<file.bytes;start+=CHUNK){if(b.closed)throw Error('原始配套候选来源已关闭。');const end=Math.min(file.bytes,start+CHUNK),bytes=await input.readRange(start,end);if(bytes.byteLength!==end-start)throw Error('候选原始字节读取不完整。');hash.update(bytes);chunks.push({...await writer.write('sources',file.name,bytes),bytes:bytes.byteLength});}if(hash.digest()!==file.revision)throw Error('候选原始字节SHA不符。');files.push({...file,chunks});}
  output.push({...structuredClone(live.description),files});seen.add(rawSignature(live.description));
 }
 if(b.closed)throw Error('原始配套候选来源已关闭。');return output.length?output:undefined;
}
async function rawCompanionSourceToken(attachment:PostprocessAttachment,b:Binding,api:ProjectCompanionBridge,identity?:{sourceId:string;revision:string}):Promise<{restored:boolean;token?:string}>{
 if(b.rawSelection==='none')return{restored:true};
 const candidates=[...(b.rawSaved??[]).map(bundle=>({bundle,live:undefined as RawLive|undefined})),...[...b.rawLive.values()].map(live=>({bundle:live.description,live}))].filter(value=>!b.rawSelection||rawSignature(value.bundle)===b.rawSelection);
 if(!candidates.length)return{restored:Boolean(b.saved)};
 if(!identity||identity.sourceId!==attachment.source.result.source.id||!sha.test(identity.revision))throw Error('项目原始候选恢复缺少当前OUT真实身份。');
 const matches=candidates.filter(({bundle})=>bundle.sourceId===identity.sourceId&&bundle.output.revision===identity.revision);
 if(!matches.length)return{restored:true};if(matches.length!==1)throw Error('该OUT有多个不同的原始配套候选集合，不能自动选择。');
 const {bundle,live}=matches[0],key=rawSignature(bundle);let pending=b.rawUploads.get(key);
 if(!pending){
  const task=(async()=>{
   if(!api.beginProjectCompanionBundle||!api.appendProjectCompanionBundle||!api.commitProjectCompanionBundle||!api.abortProjectCompanionBundle)throw Error('当前版本缺少原始配套候选恢复入口。');
   const files:ProjectCompanionFile[]=[{role:'output',...bundle.output},...bundle.files.map(file=>({role:file.role,name:file.name,bytes:file.bytes,revision:file.revision}))];
   const {bundleId}=await api.beginProjectCompanionBundle({files,mode:'explicit-raw-candidates-v1'});
   try{
    const append=async(role:ProjectCompanionRole,start:number,bytes:Uint8Array)=>{if(b.closed)throw Error('原始候选来源恢复已取消。');const receipt=await api.appendProjectCompanionBundle!(bundleId,role,start,bytes);if(receipt.written!==bytes.byteLength)throw Error('原始候选来源上传未完成。');};
    for(let start=0;start<bundle.output.bytes;start+=CHUNK){const bytes=await readPostprocessSourceBytes(attachment,start,Math.min(bundle.output.bytes,start+CHUNK));await append('output',start,bytes);}
    for(const file of bundle.files){let start=0;if(live){const input=live.inputs.get(file.candidateId)!;for(;start<file.bytes;){const end=Math.min(file.bytes,start+CHUNK),bytes=await input.readRange(start,end);if(bytes.length!==end-start)throw Error('原始候选字节变化。');await append(file.role,start,bytes);start=end;}}
     else{for(const chunk of (file as ProjectRawCompanionBundleSnapshot['files'][number]).chunks){if(b.closed)throw Error('原始候选来源恢复已取消。');const bytes=await b.reader!.read(chunk.assetId);if(bytes.byteLength!==chunk.bytes)throw Error('项目原始候选分块损坏。');await append(file.role,start,bytes);start+=bytes.byteLength;}}if(start!==file.bytes)throw Error('原始候选来源总长度不符。');}
    const receipt=await api.commitProjectCompanionBundle(bundleId);if(!receipt.bundleId||receipt.bundleId!==bundleId||!receipt.sourceToken)throw Error('原始候选来源恢复回执无效。');return receipt;
   }catch(error){try{await api.abortProjectCompanionBundle(bundleId);}catch{b.pendingAborts.set(bundleId,api);}throw error;}
  })();
  pending={api,task};b.rawUploads.set(key,pending);const current=pending;void task.catch(()=>{if(b.rawUploads.get(key)===current)b.rawUploads.delete(key);});
 }
 const result=await pending.task;if(b.closed)throw Error('原始候选来源已关闭。');return{restored:true,token:result.sourceToken};
}
