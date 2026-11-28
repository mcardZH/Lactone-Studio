import type {WorkspaceRegistry,WorkspaceProjectState} from '../modeling/workspace-registry';
import {isScientificFileDocument,type PostprocessDocument,type PostprocessScientificFileDocument} from '../results/postprocess-document';
import type {TrajectoryResult} from '../results/contracts';
import {encodeResult,decodeResult,encodePostprocessDocument,decodePostprocessDocument,encodePostprocessFileDocument,decodePostprocessFileDocument,nativeMDRequiresFormat8,structureRequiresXtbFormat8,trajectorySnapshotRequiresFormat8,postprocessSnapshotRequiresFormat8,type PostprocessFileDocumentSnapshot,type TrajectoryResultSnapshot,type PostprocessDocumentSnapshot,type ProjectAssetWriter,type ProjectAssetReader} from './result-snapshot';
import {postprocessSnapshotRequiresFormat19,prepareProjectPostprocessNumerics,prepareProjectResultNumerics,trajectorySnapshotRequiresFormat19} from './result-snapshot';
import {captureAnalysisProjectState,prepareAnalysisProjectRestore,type AnalysisProjectState} from './analysis-state';
import {ProjectUiStore,type ProjectUiSnapshot} from './ui-state';
import type {AdvancedProjectSnapshot} from './advanced-snapshot';
import {conformerTaskRequiresExtendedSemantics,conformerTaskRequiresElementGeometrySemantics,conformerTaskRequiresNativeDefaultSemantics,conformerTaskRequiresSharedOptimizer,conformerTaskRequiresMdIntegrator} from '../modeling/advanced/conformer-cluster-collection';
import {conformerTaskHasInitialVelocityProvenance,conformerTaskHasNativeSolvationProvenance} from '../modeling/advanced/initial-velocity-provenance';
import {conformerTaskRequiresAlpbSemantics,conformerTaskRequiresXtbV208Semantics} from '../modeling/advanced/conformer-solvation';
import {conformerTaskProtectionRequiresFormat5,conformerTaskSharedFreezeRequiresFormat6} from '../modeling/advanced/conformer-protection';
import {conformerDisplayRestorationRequiresFormat5,conformerDisplayRestorationRequiresFormat6,type ConformerDisplayRestoration} from '../modeling/conformers/playback-display';
import {captureImportedModelSources,prepareImportedModelSourcesRestore,type ImportedModelSourcesSnapshot} from './import-sources';
import {projectCompanionVersion,postprocessFileDocumentVersion} from './companion-sources';
import {encodeAdvancedAsset,decodeAdvancedAsset,mergeRetainedAdvancedTasks,type RetainedAdvancedTasks} from './advanced-asset-codec';
import {createRuntimeModelStore,prepareRestoredModelStoreHistories} from '../core/modeling/model-store';
import type {ModelDocument} from '../modeling/contracts';
import type {ModelProjectHistoryEntry} from '../core/modeling/contracts';
import type {Structure} from '../core/types';
import type {AdvancedCalculationResult,AdvancedResultFrame,AdvancedTaskRecord} from '../modeling/advanced/contracts';
import type {DynamicsController,DynamicsSnapshotObservation} from '../modeling/dynamics/controller';
import {createInputExportGuard} from '../modeling/application/input-export-guard';
import {graphFingerprint} from '../core/modeling/graph';
import {getPostprocessTaskAssociationVersion} from './postprocess-task-association';
import {isProjectAssetId,projectWorkspaceShell,type WorkspaceRestoreIssue} from './workspace-shell-restore';
import {projectAssetSha256,projectFormatFloor,type ProjectFormatVersion} from './desktop-bridge';
import type {PesProjectSnapshot} from '../modeling/pes/contracts';
import {preparePesIndex,WorkspacePesAsset,capturePesAsset} from './pes-asset-codec';
import {requiresProjectFormat15} from './format15';
import {requiresProjectFormat16} from './format16';
export type {WorkspacePesAsset} from './pes-asset-codec';

/** Capture-only overrides. Runtime identity/validators never enter the project DTO. */
export interface WorkspaceModelSnapshot {document:ModelDocument;sourceRevision:number;frameSeq:number;observation?:DynamicsSnapshotObservation;assertCurrent():void}
export interface WorkspaceMDCheckpointSource {documentId:string;sourceRevision:number;frameSeq:number;snapshotRevision:number;graphFingerprint:string;observation?:DynamicsSnapshotObservation}
interface WorkspaceMDCheckpointSources {schema:1;records:WorkspaceMDCheckpointSource[]}
/** Records that no longer match remain historical evidence, never current results. */
export function currentWorkspaceMDCheckpointSource(value:unknown,document:ModelDocument):WorkspaceMDCheckpointSource|undefined{
 const source=value as Partial<WorkspaceMDCheckpointSources>|null;
 if(source?.schema!==1||!Array.isArray(source.records))return;
 return [...source.records].reverse().find(row=>row&&row.documentId===document.id&&row.snapshotRevision===document.revision&&row.graphFingerprint===graphFingerprint(document.draft.structure));
}
function checkpointSources(prior:unknown,snapshots:ReadonlyMap<string,WorkspaceModelSnapshot>):unknown{
 if(!snapshots.size)return prior;
 const source=prior as WorkspaceMDCheckpointSources|undefined;
 if(prior!==undefined&&(!source||source.schema!==1||!Array.isArray(source.records)))throw Error('项目MD快照来源格式较新或无效，原记录保留；未覆盖保存。');
 const records=structuredClone(source?.records??[]);
 for(const [documentId,value]of snapshots){
  const record:WorkspaceMDCheckpointSource={documentId,sourceRevision:value.sourceRevision,frameSeq:value.frameSeq,snapshotRevision:value.document.revision,graphFingerprint:graphFingerprint(value.document.draft.structure),...(value.observation?{observation:structuredClone(value.observation)}:{})};
  if(!records.some(row=>JSON.stringify(row)===JSON.stringify(record)))records.push(record);
 }
 return {...source,schema:1,records};
}
type SnapshotRuntime=Pick<DynamicsController,'getSnapshot'|'captureSnapshot'>;
export async function captureWorkspaceModelSnapshots(input:{registry:WorkspaceRegistry;runtimeOwner(id:string):SnapshotRuntime|undefined;generation():number}):Promise<Map<string,WorkspaceModelSnapshot>>{
 const rows=input.registry.getSnapshot().documents.flatMap(entry=>{
  const owner=input.runtimeOwner(entry.id),state=owner?.getSnapshot();
  if(!owner||state?.mode!=='md'||!['starting','running','stopping'].includes(state.status))return [];
  const guard=createInputExportGuard(()=>{
   const current=input.registry.document(entry.id),runtime=input.runtimeOwner(entry.id),model=current.store.getSnapshot();
   if(current.store!==entry.store||current.epoch!==entry.epoch)throw Error('项目保存期间MD工作源已更换。');
   return {alive:true,active:true,generation:input.generation(),documentId:model.id,revision:model.revision,structure:model.draft.structure,runtimeOwner:runtime,runtimeSessionId:runtime?.getSnapshot().sessionId,conditions:''};
  });
  return [{entry,owner,guard}];
 });
 const captured=await Promise.all(rows.map(async({entry,owner,guard})=>{
  const snapshot=await owner.captureSnapshot();guard.afterSnapshot(snapshot);
  if(!snapshot.detached||!snapshot.modelDocument||snapshot.modelDocument.id!==entry.id||JSON.stringify(snapshot.modelDocument.draft.structure)!==JSON.stringify(snapshot.structure))throw Error('MD项目快照缺少已接受的完整模型状态。');
  return [entry.id,{document:structuredClone(snapshot.modelDocument),sourceRevision:snapshot.workingSource!.revision,frameSeq:snapshot.seq,...(snapshot.observation?{observation:structuredClone(snapshot.observation)}:{}),assertCurrent:guard.assertCurrent}] as const;
 }));
 const snapshots=new Map(captured);for(const value of snapshots.values())value.assertCurrent();return snapshots;
}
/** A detached checkpoint does not save the different working model's baseline. */
export function markCapturedWorkspaceModelsApplied(registry:WorkspaceRegistry,revisions:ReadonlyMap<string,number>,snapshots:ReadonlyMap<string,WorkspaceModelSnapshot>):void{
 for(const entry of registry.getSnapshot().documents)if(!snapshots.has(entry.id)&&revisions.get(entry.id)===entry.store.getSnapshot().revision)entry.store.markApplied();
}

type Generated=Record<string,{document:PostprocessDocument;ownerId:string;bindingId:string}>;
export interface WorkspaceHistoryArchiveReference {
 assetId:string;
 documentIds:string[];
 assetReferences:string[];
}
export interface SyWorkspaceSnapshot {
 schema:'sciyue-workspace-project/v1';registryAsset:string;
 requiredProjectFormatVersion?:Exclude<ProjectFormatVersion,1>;
 results:Record<string,{result?:string;legacyResult?:string;analysisBinding?:{id:string;result:string}}>;
 sources:Record<string,string>;generated:Record<string,{assetId:string;ownerId:string;bindingId:string}>;
 /** File/job sources without a model registry entry retain their own raw assets. */
 fileSources?:Record<string,string>;
 advancedAsset?:string;pesAsset?:string;pesAssetReferences?:string[];ui:ProjectUiSnapshot;shell:Record<string,unknown>;analysis:AnalysisProjectState;
 historyArchives?:WorkspaceHistoryArchiveReference[];
 /** Includes nested immutable DTO dependencies, including lazy/unvisited ones. */
 assetReferences:string[];
 preserveUnlistedAssets?:true;
 importedSources?:ImportedModelSourcesSnapshot;
}
const resultCache=new WeakMap<TrajectoryResult,TrajectoryResultSnapshot>(),sourceCache=new WeakMap<PostprocessDocument,PostprocessDocumentSnapshot>();
const sourceCompanionVersions=new WeakMap<PostprocessDocument,number>();
const sourceAssociationVersions=new WeakMap<PostprocessDocument,number>();
const sourceFileVersions=new WeakMap<PostprocessDocument,string>();
const fileSourceCache=new WeakMap<PostprocessScientificFileDocument,PostprocessFileDocumentSnapshot>();
const fileSourceVersions=new WeakMap<PostprocessScientificFileDocument,string>();
const unreadableResults=new Map<string,SyWorkspaceSnapshot['results'][string]>(),unreadableSources=new Map<string,string>(),unreadableGenerated=new Map<string,SyWorkspaceSnapshot['generated'][string]>();
let unreadableRequiresFormat3=false;
let unreadableDependencies:string[]=[];
let lastImportedSources:ImportedModelSourcesSnapshot|undefined;
let lastAdvancedAsset:string|undefined;
let lastAdvancedReferences:string[]=[];
let lastAdvancedRequiresFormat2=false;
let lastAdvancedRequiresFormat4=false;
let lastAdvancedRequiresFormat5=false;
let unreadableRequiresFormat5=false;
let lastAdvancedRequiresFormat6=false;
let unreadableRequiresFormat6=false;
let lastAdvancedRequiresFormat8=false;
let unreadableRequiresFormat8=false;
let lastAdvancedRequiresFormat10=false;
let lastAdvancedRequiresFormat15=false;
let lastAdvancedRequiresFormat17=false;
let lastAdvancedRequiresFormat18=false;
let unreadableRequiresFormat15=false;
let unreadableRequiresFormat19=false;
interface AdvancedAssetReference {assetId?:string;formatVersion?:number}
interface AdvancedReaderState {current:AdvancedAssetReference;reader:ProjectAssetReader;retained?:RetainedAdvancedTasks}
let restoredAdvancedReader:AdvancedReaderState|undefined;
const advancedRecoveryByRegistry=new WeakMap<WorkspaceRegistry,AdvancedReaderState>();
const text=new TextDecoder('utf-8',{fatal:true});
const pendingCaptures=new WeakMap<object,()=>void>();
/** Keep untouched archive payloads in the source project. Its reader is the
 * same project router that rebinds synchronously after a successful Save As. */
class WorkspaceHistoryArchives {
 constructor(private rows:WorkspaceHistoryArchiveReference[],private readonly reader:ProjectAssetReader){}
 async capture(documentIds:ReadonlySet<string>,writer:ProjectAssetWriter,reuse:boolean,retain:(id:string)=>void){
  const rows=this.rows.filter(row=>row.documentIds.some(id=>documentIds.has(id)));
  const copied=new Set<string>();
  for(const row of rows)for(const id of [row.assetId,...row.assetReferences]){
   if(copied.has(id))continue;
   if(!reuse){
    let bytes:Uint8Array;
    try{bytes=await this.reader.read(id);}
    catch(error){throw Error(`项目历史档案资产无法读取（${id}），原引用已保留。`,{cause:error});}
    if(await projectAssetSha256(bytes)!==id)throw Error(`项目历史档案资产校验失败（${id}），原引用已保留。`);
    const original=id===row.assetId;
    const saved=await writer.write(original?'models':'sources',original?'workspace-history-original.json':'workspace-history-dependency',bytes);
    if(saved.assetId!==id)throw Error('项目历史档案另存回执与来源不一致。');
   }
   copied.add(id);retain(id);
  }
  return rows;
 }
 commit(rows:WorkspaceHistoryArchiveReference[]){this.rows=rows;}
}
const workspaceHistoryArchives=new WeakMap<WorkspaceRegistry,WorkspaceHistoryArchives>();
/** Publish cache identities only after the project host commits this DTO. */
export function commitWorkspaceProjectCapture(value:unknown):void {
 if(!value||typeof value!=='object')return;
 const publish=pendingCaptures.get(value);
 pendingCaptures.delete(value);
 publish?.();
}
function refs(value:unknown,output:Set<string>,key=''){
 if(key==='assetId'&&typeof value==='string')output.add(value);
 else if((key==='frameAssets'||key==='assetReferences')&&Array.isArray(value)){for(const id of value)if(typeof id==='string')output.add(id);}
 else if(Array.isArray(value))value.forEach(item=>refs(item,output));
 else if(value&&typeof value==='object')for(const [name,item]of Object.entries(value))refs(item,output,name);
}
const workspaceModelRows=(registry:WorkspaceProjectState)=>[...registry.documents,...(Array.isArray(registry.detachedDocuments)?registry.detachedDocuments:[])];
const hasEmbeddedHistoryArchive=(registry:WorkspaceProjectState)=>workspaceModelRows(registry).some(row=>row?.model?.projectHistoryArchive!==undefined);
function readHistoryArchiveReferences(data:SyWorkspaceSnapshot):WorkspaceHistoryArchiveReference[]{
 if(data.historyArchives===undefined)return [];
 if((data.requiredProjectFormatVersion??0)<10)throw Error('项目历史档案缺少格式 10 写入保护声明。');
 const declared=new Set(data.assetReferences), seen=new Set<string>();
 const known=(id:unknown):id is string=>isProjectAssetId(id)&&declared.has(id);
 if(!Array.isArray(data.historyArchives)||data.historyArchives.some(row=>{
  if(!row||!known(row.assetId)||seen.has(row.assetId)||!Array.isArray(row.documentIds)||!row.documentIds.length||
    row.documentIds.some(id=>typeof id!=='string'||!id)||new Set(row.documentIds).size!==row.documentIds.length||
    !Array.isArray(row.assetReferences)||new Set(row.assetReferences).size!==row.assetReferences.length||
    row.assetReferences.some(id=>id===row.assetId||!known(id)))return true;
  seen.add(row.assetId);return false;
 }))throw Error('项目历史档案引用无效，原项目未改变。');
 return structuredClone(data.historyArchives);
}
function originalHistoryAssetReferences(data:SyWorkspaceSnapshot,existing:WorkspaceHistoryArchiveReference[]):string[]{
 const references=new Set<string>();refs(data,references);
 const indexed=[data.advancedAsset,data.pesAsset,...Object.values(data.sources),...Object.values(data.fileSources??{}),
  ...Object.values(data.results).flatMap(row=>[row.result,row.legacyResult,row.analysisBinding?.result])];
 for(const id of indexed)if(isProjectAssetId(id))references.add(id);
 references.delete(data.registryAsset);
 for(const row of existing)references.delete(row.assetId);
 return [...references].filter(isProjectAssetId);
}
/** Older writers would omit archived drafts or collect an unrecognized batch asset. */
function requiresRecoveryFormat7(registry:WorkspaceProjectState,shell:unknown):boolean{
 const nonemptyEntries=(value:unknown,meaningful:(entry:unknown)=>boolean)=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).some(meaningful));
 const nonemptyRows=(entry:unknown)=>Array.isArray(entry)&&entry.length>0;
 const fields=shell&&typeof shell==='object'?shell as Record<string,unknown>:{};
 return isProjectAssetId(fields.borrowedBatchAsset)||nonemptyEntries(fields.preservedInvalidShellFields,nonemptyRows)||
   [...registry.documents,...(Array.isArray(registry.detachedDocuments)?registry.detachedDocuments:[])].some(row=>
    nonemptyEntries(row?.retiredInputDrafts,nonemptyRows)||
    nonemptyEntries(row?.inputDraftCopyIssues,entry=>typeof entry==='string'&&entry.length>0));
}
const objectRecord=(value:unknown):Record<string,unknown>|undefined=>
 value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const recordValues=(value:unknown):unknown[]=>Object.values(objectRecord(value)??{});

function modelRequiresXtbFormat8(model:ModelDocument|undefined):boolean{
 return structureRequiresXtbFormat8(model?.draft?.structure)||structureRequiresXtbFormat8(model?.draft?.baseStructure)||
  structureRequiresXtbFormat8(model?.cellCheckpoint?.structure);
}
function historyRequiresXtbFormat8(entry:ModelProjectHistoryEntry):boolean{
 if(entry?.kind==='structure')return modelRequiresXtbFormat8(entry.document);
 return entry?.kind==='linked'&&!!entry.token?.members?.some(({before,after})=>
  before?.kind==='structure'&&modelRequiresXtbFormat8(before.document)||after?.kind==='structure'&&modelRequiresXtbFormat8(after.document));
}
const legacyXtbIdentityFields=new Set(['schema','engine','kind','version','sourceCommit','buildId','compiler',
 'toolchainArchiveSha256','sourceReceiptSha256','scientificPinsSha256','runtimeMemberDigest','parameterDigest','sha256']);
function isLegacyNativeRfResult(result:AdvancedCalculationResult):boolean{
 const meta=result.metadata,identity=objectRecord(meta?.engineIdentity);
 // The format-5 era host already stored this converged RF provenance. The
 // later runtime identities add variant-specific fields to the same v1 schema.
 return result.status==='completed'&&meta?.engine==='xtb'&&meta.version==='6.7.0'&&meta.converged===true&&
  meta.calculation==='optimize'&&meta.optimizer==='rf'&&meta.periodic===undefined&&meta.sccIterationLimit===undefined&&
  ['gfn0','gfn1','gfn2','gfnff'].includes(meta.method)&&identity?.schema==='sciyue-xtb-engine-identity/v1'&&
  identity.engine==='xtb'&&identity.kind==='bundled-independent-rebuild'&&identity.version===meta.version&&
  typeof identity.sourceCommit==='string'&&/^[a-f0-9]{40}$/.test(identity.sourceCommit)&&typeof identity.buildId==='string'&&!!identity.buildId&&
  [identity.runtimeMemberDigest,identity.parameterDigest,identity.sha256].every(isProjectAssetId)&&
  Object.keys(identity).every(key=>legacyXtbIdentityFields.has(key));
}
function advancedResultRequiresXtbFormat8(result:AdvancedCalculationResult):boolean{
 const meta=result.metadata;
 return result.status==='unconverged'||!!(meta&&(meta.method==='gxtb'||meta.converged===false||meta.convergenceStatus!==undefined||
  ((meta.engineIdentity!==undefined||meta.optimizer!==undefined)&&!isLegacyNativeRfResult(result))||meta.moldenConversion!==undefined||
  meta.periodic&&'optimizer'in meta.periodic&&meta.periodic.optimizer==='native-fire'));
}
function advancedFrameRequiresXtbFormat8(frame:AdvancedResultFrame):boolean{
 const native=frame.process?.kind==='sampling'?frame.process.data.nativeMD:undefined;
 return structureRequiresXtbFormat8(frame.source?.structure)||!!(native&&(native.method==='gxtb'||native.engineIdentity!==undefined||
  native.seedTreatment==='native-controlled'||native.seedTreatment==='native-program-random'||!!native.nativeProtection?.constraints?.length));
}
function advancedTaskRequiresXtbFormat8(task:AdvancedTaskRecord):boolean{
 return conformerTaskRequiresXtbV208Semantics(task)||!!(task.guessFrames?.some(advancedFrameRequiresXtbFormat8)||
  task.runs?.some(run=>run.frames?.some(advancedFrameRequiresXtbFormat8)||run.results?.some(advancedResultRequiresXtbFormat8)||
   run.stages?.some(stage=>stage.results?.some(advancedResultRequiresXtbFormat8))));
}
/** Only these persisted model/provenance and per-owner control slots carry the new semantics. */
function workspaceRequiresXtbFormat8(registry:WorkspaceProjectState,shell:unknown,ui:ProjectUiSnapshot):boolean{
 const fields=objectRecord(shell),uiValues=ui?.values??{},checkpoint=objectRecord(fields?.mdSnapshotSources);
 if(recordValues(fields?.xtbMethodDrafts).some(value=>{
  const draft=objectRecord(value);
  return draft?.method==='gxtb'||typeof draft?.sccIterationLimitText==='string';
 })||recordValues(uiValues[JSON.stringify(['workspace','xtb-wavefunction-confirmations'])]).some(value=>typeof value==='string'&&value.length>0))return true;
 if(checkpoint?.schema===1&&Array.isArray(checkpoint.records)&&checkpoint.records.some(row=>{
  const observation=(row as WorkspaceMDCheckpointSource|null)?.observation;
  const native=observation?.nativeMD;
  return !!observation?.aseMD||native?.method==='gxtb'||nativeMDRequiresFormat8(native,native?.method);
 }))return true;
 if(recordValues(fields?.advancedObservations).some(row=>structureRequiresXtbFormat8(objectRecord(row)?.structure as Structure|undefined)))return true;
 return [...registry.documents,...(Array.isArray(registry.detachedDocuments)?registry.detachedDocuments:[])].some(row=>{
  const model=row?.model, id=row?.id;
  const mdDraft=objectRecord(uiValues[JSON.stringify(['document',id,'modeling-md-draft',id])]);
  const bondSolvent=uiValues[JSON.stringify(['document',id,'bond-perception-solvent',id])];
  const defaultMDMethod=model?.document?.draft?.structure?.cell?.pbc?.some(Boolean)?'gfn2':'auto';
  const changedMD=mdDraft&&(typeof mdDraft.method==='string'&&mdDraft.method!==defaultMDMethod||
   typeof mdDraft.temperature==='string'&&mdDraft.temperature!=='300'||mdDraft.solvation!==undefined||
   mdDraft.integrator==='ase'||mdDraft.shakeHydrogenBonds===true);
  return changedMD||
   typeof bondSolvent==='string'&&bondSolvent!=='none'||
   modelRequiresXtbFormat8(model?.document)||structureRequiresXtbFormat8(model?.baseline?.structure)||
   structureRequiresXtbFormat8(row?.derivation?.sourceStructure)||
   model?.past?.some(historyRequiresXtbFormat8)||model?.future?.some(historyRequiresXtbFormat8);
 });
}
export async function captureWorkspaceProject(input:{registry:WorkspaceRegistry;documents:Record<string,PostprocessDocument>;fileDocuments?:Record<string,PostprocessScientificFileDocument>;preservedFileSources?:Readonly<Record<string,string>>;generated:Generated;advanced?:AdvancedProjectSnapshot;pes?:PesProjectSnapshot;retainedPes?:WorkspacePesAsset;ui:ProjectUiSnapshot;shell:Record<string,unknown>;writer:ProjectAssetWriter;reader?:ProjectAssetReader;reuse:boolean;modelSnapshots?:ReadonlyMap<string,WorkspaceModelSnapshot>}):Promise<SyWorkspaceSnapshot>{
 if(!input.reuse&&Object.keys(input.preservedFileSources??{}).some(id=>!input.fileDocuments?.[id]))throw Error('项目有缺损的文件级来源索引，无法生成完整自包含的另存项目。');
 const snapshots=new Map([...input.modelSnapshots??[]].map(([id,value])=>[id,{...value,document:structuredClone(value.document),...(value.observation?{observation:structuredClone(value.observation)}:{})}]));
 const assertSnapshotsCurrent=()=>{for(const value of snapshots.values())value.assertCurrent();};assertSnapshotsCurrent();
 const mdSnapshotSources=checkpointSources(input.shell.mdSnapshotSources,snapshots),shell={...input.shell,...(mdSnapshotSources===undefined?{}:{mdSnapshotSources})};
 const {writer}=input,registry=input.registry.exportProjectState({saved:true}),dependencies=new Set<string>();
 const afterCommit:(()=>void)[]=[];
 const advancedReader=restoredAdvancedReader;
 const preparedPes=input.pes===undefined?undefined:preparePesIndex(input.pes,{numeric:Boolean(writer.writeRange)});
 for(const [id,value]of snapshots){
  const target=registry.documents.find(entry=>entry.id===id);
  if(!target||target.model.document.revision!==value.sourceRevision||value.document.id!==id)throw Error('项目保存期间MD工作源修订已变化。');
  // Existing Store serialization supplies a valid clean checkpoint. Preserve the
  // working document's bounded history/contexts and historical source attachments.
  // Current analysis/bond-order validity comes only from the accepted run model.
  const projected=createRuntimeModelStore(value.document).exportProjectState!({saved:true});
  target.model.document=projected.document;target.model.baseline=projected.baseline;
  target.model.document.canUndo=target.model.past.length>0;target.model.document.canRedo=target.model.future.length>0;
 }
 const encodedResults=new Map<TrajectoryResult,Promise<TrajectoryResultSnapshot>>();
 const projectWriter=writer as ProjectAssetWriter&{retainAsset?(assetId:string):void;hasAsset?(assetId:string):boolean};
 const retain=(id:string)=>{dependencies.add(id);projectWriter.retainAsset?.(id);};
 let payloadRequiresFormat15=false;
 const asset=async(name:string,value:unknown,category='results')=>{assertSnapshotsCurrent();if(requiresProjectFormat15(value))payloadRequiresFormat15=true;const id=(await writer.write(category,name,JSON.stringify(value))).assetId;assertSnapshotsCurrent();retain(id);return id;};
 let requiresFormat5=false,resultRequiresFormat6=false,resultRequiresFormat8=false,resultRequiresFormat19=false;
 const saveResult=async(value:TrajectoryResult)=>{if(conformerDisplayRestorationRequiresFormat5(value))requiresFormat5=true;if(conformerDisplayRestorationRequiresFormat6((value as TrajectoryResult&{displayRestoration?:ConformerDisplayRestoration}).displayRestoration))resultRequiresFormat6=true;let pending=encodedResults.get(value);if(!pending){const cached=input.reuse?resultCache.get(value):undefined;pending=cached?Promise.resolve(cached):encodeResult(value,writer);encodedResults.set(value,pending);}const dto=await pending;if(trajectorySnapshotRequiresFormat8(dto))resultRequiresFormat8=true;if(trajectorySnapshotRequiresFormat19(dto))resultRequiresFormat19=true;afterCommit.push(()=>{resultCache.set(value,dto);});refs(dto,dependencies);return asset('trajectory-index.json',dto);};
 let requiresFormat3=false;
 const saveSource=async(value:PostprocessDocument)=>{
  const version=projectCompanionVersion(value.output),associationVersion=getPostprocessTaskAssociationVersion(value),fileVersion=postprocessFileDocumentVersion(value);
  const cached=input.reuse&&sourceCompanionVersions.get(value)===version&&sourceAssociationVersions.get(value)===associationVersion&&sourceFileVersions.get(value)===fileVersion?sourceCache.get(value):undefined;
  const dto=cached??await encodePostprocessDocument(value,writer);
  if(!cached)afterCommit.push(()=>{sourceCache.set(value,dto);sourceCompanionVersions.set(value,version);sourceAssociationVersions.set(value,associationVersion);sourceFileVersions.set(value,fileVersion);});
  if(dto.schema===4)requiresFormat3=true;
  if(postprocessSnapshotRequiresFormat8(dto))resultRequiresFormat8=true;
  if(postprocessSnapshotRequiresFormat19(dto))resultRequiresFormat19=true;
  refs(dto,dependencies);return asset('source-index.json',dto);
 };
 const saveFileSource=async(value:PostprocessScientificFileDocument)=>{
  const version=postprocessFileDocumentVersion(value),cached=input.reuse&&fileSourceVersions.get(value)===version?fileSourceCache.get(value):undefined;
  const dto=cached??await encodePostprocessFileDocument(value,writer);
  if(dto.schema!==4||!('kind'in dto)||dto.kind!=='scientific-file')throw Error('文件级来源未取得对应的完整保存格式。');
  if(!cached)afterCommit.push(()=>{fileSourceCache.set(value,dto);fileSourceVersions.set(value,version);});
  if(postprocessSnapshotRequiresFormat8(dto))resultRequiresFormat8=true;
  if(postprocessSnapshotRequiresFormat19(dto))resultRequiresFormat19=true;
  requiresFormat3=true;refs(dto,dependencies);return asset('scientific-file-index.json',dto);
 };
 const results:SyWorkspaceSnapshot['results']={},sources:Record<string,string>={},fileSources:Record<string,string>={},generated:SyWorkspaceSnapshot['generated']={};
 const currentDocuments=input.registry.getSnapshot().documents;
 for(const entry of currentDocuments){const key=JSON.stringify([entry.id,entry.epoch]),unreadable=unreadableResults.get(key),row:SyWorkspaceSnapshot['results'][string]=unreadable?structuredClone(unreadable):{};if(unreadable&&!input.reuse)throw new Error('项目有缺损的结果索引，无法生成完整自包含的另存项目。');if(unreadable)for(const id of [unreadable.result,unreadable.legacyResult,unreadable.analysisBinding?.result])if(id)retain(id);if(entry.result)row.result=await saveResult(entry.result);if(entry.legacyResult)row.legacyResult=await saveResult(entry.legacyResult);if(entry.analysisBinding)row.analysisBinding={id:entry.analysisBinding.id,result:await saveResult(entry.analysisBinding.result)};if(Object.keys(row).length)results[entry.id]=row;
  const source=unreadableSources.get(key);if(source&&!input.documents[entry.id]){if(!input.reuse)throw new Error('项目有缺损的来源索引，无法生成完整自包含的另存项目。');sources[entry.id]=source;retain(source);}
 }
 for(const [id,document]of Object.entries(input.documents))sources[id]=await saveSource(document);
 for(const [id,document]of Object.entries(input.fileDocuments??{})){if(id!==document.id)throw Error('文件级来源身份与项目索引不一致。');fileSources[id]=await saveFileSource(document);}
 for(const [id,assetId]of Object.entries(input.preservedFileSources??{}))if(!fileSources[id]){if(!input.reuse)throw Error('项目有缺损的文件级来源索引，无法生成完整自包含的另存项目。');fileSources[id]=assetId;retain(assetId);requiresFormat3=true;}
 for(const [id,value]of Object.entries(input.generated))generated[id]={assetId:await saveSource(value.document),ownerId:value.ownerId,bindingId:value.bindingId};
 for(const [id,value]of unreadableGenerated)if(!generated[id]&&currentDocuments.some(entry=>entry.id===value.ownerId)){if(!input.reuse)throw new Error('项目有缺损的派生结果索引，无法完整另存。');generated[id]=value;retain(value.assetId);}
 const preservingUnreadable=Object.keys(results).some(id=>currentDocuments.some(entry=>entry.id===id&&unreadableResults.has(JSON.stringify([entry.id,entry.epoch]))))||Object.values(sources).some(id=>[...unreadableSources.values()].includes(id))||Object.keys(generated).some(id=>unreadableGenerated.has(id))||Object.keys(fileSources).some(id=>Object.hasOwn(input.preservedFileSources??{},id));
 if(preservingUnreadable&&unreadableRequiresFormat3)requiresFormat3=true;
 if(preservingUnreadable&&unreadableRequiresFormat5)requiresFormat5=true;
 if(preservingUnreadable)for(const id of unreadableDependencies)retain(id);
 const analysis=await captureAnalysisProjectState(writer,{reuse:input.reuse});refs(analysis,dependencies);
 // File-level diagnostics have no model attachment. Their original source
 // chunks still belong to this project generation and must survive asset GC.
 refs(input.shell.sourceDiagnostics,dependencies);
 if(isProjectAssetId(input.shell.borrowedBatchAsset)&&projectWriter.hasAsset?.(input.shell.borrowedBatchAsset)!==false)retain(input.shell.borrowedBatchAsset);
 const importedSources=await captureImportedModelSources(writer,{reuse:input.reuse?lastImportedSources:undefined,documentIds:registry.documents.map(entry=>entry.id)});refs(importedSources,dependencies);
 const recovery=advancedRecoveryByRegistry.get(input.registry);
 const retained=recovery?.retained;
 let advancedData=input.advanced?await encodeAdvancedAsset(input.advanced,writer):undefined;
 if(advancedData&&retained&&recovery){
  if(!input.reuse){
   for(const id of retained.graph.assetReferences){
    let bytes:Uint8Array;
    try{bytes=await recovery.reader.read(id);}
    catch(error){throw Error('受限高级任务的原始结构无法完整另存，已保留原项目。',{cause:error});}
    if(await projectAssetSha256(bytes)!==id)throw Error('受限高级任务的结构校验失败，已保留原项目。');
    if((await writer.write('trajectories',id+'.json',bytes)).assetId!==id)throw Error('另存高级任务结构的回执与来源不一致。');
   }
  }
  advancedData=mergeRetainedAdvancedTasks(advancedData,retained);
 }
 const advancedReferences=advancedData?.assetReferences??(input.reuse?lastAdvancedReferences:[]);
 if(advancedData)for(const id of advancedReferences)dependencies.add(id);
 else for(const id of advancedReferences)retain(id);
 const advancedAsset=advancedData?await asset('advanced-tasks.json',advancedData):input.reuse?lastAdvancedAsset:undefined;
 if(advancedAsset)retain(advancedAsset);
 const pesCapture=input.pes===undefined?undefined:await capturePesAsset(input.pes,writer,input.reuse,preparedPes,input.reader);
 const pesAsset=input.pes===undefined
  ?input.reuse?input.retainedPes?.assetId:await input.retainedPes?.copyTo(writer)
  :pesCapture?.assetId;
 const pesAssetReferences=pesCapture?.assetReferences??[...input.retainedPes?.assetReferences??[]];
 if(pesAsset)retain(pesAsset);
 for(const id of pesAssetReferences)retain(id);
 const advancedFormat2=input.advanced?input.advanced.schema===2:input.reuse&&lastAdvancedRequiresFormat2;
 const advancedFormat4=input.advanced?input.advanced.tasks.some(conformerTaskRequiresExtendedSemantics):input.reuse&&lastAdvancedRequiresFormat4;
 const advancedFormat5=input.advanced?input.advanced.tasks.some(conformerTaskProtectionRequiresFormat5):input.reuse&&lastAdvancedRequiresFormat5;
 const advancedFormat6=input.advanced?input.advanced.tasks.some(task=>conformerTaskRequiresElementGeometrySemantics(task)||conformerTaskHasInitialVelocityProvenance(task)||conformerTaskHasNativeSolvationProvenance(task)||conformerTaskRequiresAlpbSemantics(task)||conformerTaskSharedFreezeRequiresFormat6(task)):input.reuse&&lastAdvancedRequiresFormat6;
 const advancedFormat8=input.advanced?input.advanced.tasks.some(advancedTaskRequiresXtbFormat8):input.reuse&&lastAdvancedRequiresFormat8;
 const advancedFormat10=input.advanced?input.advanced.tasks.some(conformerTaskRequiresNativeDefaultSemantics):input.reuse&&lastAdvancedRequiresFormat10;
 const advancedFormat15=input.advanced?requiresProjectFormat15(input.advanced):input.reuse&&lastAdvancedRequiresFormat15;
 const advancedFormat17=input.advanced?input.advanced.tasks.some(conformerTaskRequiresSharedOptimizer):input.reuse&&lastAdvancedRequiresFormat17;
 const advancedFormat18=input.advanced?input.advanced.tasks.some(conformerTaskRequiresMdIntegrator):input.reuse&&lastAdvancedRequiresFormat18;
 const retainedShellRefs=new Set<string>();refs(input.shell.preservedInvalidShellFields,retainedShellRefs);
 for(const id of retainedShellRefs)if(isProjectAssetId(id)){
  if(input.reuse&&projectWriter.hasAsset?.(id)===false)continue;
  if(!input.reuse&&!dependencies.has(id))throw Error('项目保留有损坏状态的原始资产引用，无法生成完整自包含的另存项目。');
  retain(id);
 }
 const requiresFormat6=Boolean(resultRequiresFormat6||preservingUnreadable&&unreadableRequiresFormat6||advancedAsset&&advancedFormat6);
 const requiresFormat8=resultRequiresFormat8||preservingUnreadable&&unreadableRequiresFormat8||
  Boolean(advancedAsset&&advancedFormat8)||workspaceRequiresXtbFormat8(registry,shell,input.ui);
 const historyOwner=workspaceHistoryArchives.get(input.registry);
 const historyArchives=await historyOwner?.capture(new Set(workspaceModelRows(registry).map(row=>row.id)),writer,input.reuse,retain);
 const requiresFormat10=Boolean(historyArchives?.length||hasEmbeddedHistoryArchive(registry)||advancedAsset&&advancedFormat10);
 const requiresFormat11=Boolean(pesCapture?.requiresFormat11||input.pes===undefined&&input.retainedPes?.requiresFormat11);
 const requiresFormat12=Boolean(pesCapture?.requiresFormat12||input.pes===undefined&&input.retainedPes?.requiresFormat12);
 const requiresFormat13=Boolean(pesCapture?.requiresFormat13||input.pes===undefined&&input.retainedPes?.requiresFormat13);
 const requiresFormat14=workspaceModelRows(registry).some(row=>Object.keys(row.model.document.frameBondOverrides??{}).length>0);
 const requiresFormat15=Boolean(payloadRequiresFormat15||pesCapture?.requiresFormat15||input.pes===undefined&&input.retainedPes?.requiresFormat15||
   advancedAsset&&advancedFormat15||preservingUnreadable&&unreadableRequiresFormat15||requiresProjectFormat15([registry,shell,input.ui]));
 const requiresFormat16=Boolean(pesCapture?.requiresFormat16||input.pes===undefined&&input.retainedPes?.requiresFormat16||requiresProjectFormat16([registry,shell,input.ui]));
 const pesRequiresFormat19=Boolean(pesCapture?.requiresFormat19||input.pes===undefined&&input.retainedPes?.requiresFormat19);
 const requiresFormat19=pesRequiresFormat19||resultRequiresFormat19||preservingUnreadable&&unreadableRequiresFormat19;
 const computedFormat=requiresFormat19?19:advancedAsset&&advancedFormat18?18:advancedAsset&&advancedFormat17?17:requiresFormat16?16:requiresFormat15?15:requiresFormat14?14:requiresFormat13?13:requiresFormat12?12:requiresFormat11?11:requiresFormat10?10:pesAsset?9:requiresFormat8?8:requiresRecoveryFormat7(registry,shell)?7:requiresFormat6?6:
   requiresFormat5||advancedAsset&&advancedFormat5?5:advancedAsset&&advancedFormat4?4:requiresFormat3?3:advancedAsset&&advancedFormat2?2:undefined;
 const retainedFormat=retained&&recovery?.current.formatVersion;
 const requiredProjectFormatVersion=retainedFormat&&retainedFormat>(computedFormat??1)
  ?retainedFormat as Exclude<ProjectFormatVersion,1>:computedFormat;
 const data:SyWorkspaceSnapshot={schema:'sciyue-workspace-project/v1',...(requiredProjectFormatVersion?{requiredProjectFormatVersion}:{}),registryAsset:await asset('workspace-models.json',registry,'models'),results,sources,...(Object.keys(fileSources).length?{fileSources}:{}),generated,...(advancedAsset?{advancedAsset}:{}),...(pesAsset?{pesAsset}:{}),...(pesAssetReferences.length?{pesAssetReferences}:{}),...(historyArchives?.length?{historyArchives}:{}),ui:input.ui,shell,analysis,importedSources,assetReferences:[],...(preservingUnreadable&&!unreadableDependencies.length?{preserveUnlistedAssets:true as const}:{})};
 // DTO cache reuse can skip every writer call; register its nested dependencies
 // independently of whether a frame/source/grid has ever been read.
 for(const id of dependencies)retain(id);data.assetReferences=[...dependencies];assertSnapshotsCurrent();
 pendingCaptures.set(data,()=>{
  for(const publish of afterCommit)publish();
  pesCapture?.commit?.();
  if(input.retainedPes&&(!input.reuse||input.retainedPes.assetId!==pesAsset))input.retainedPes.rebind(pesAsset,pesAssetReferences,requiresFormat11,requiresFormat12,requiresFormat13,requiresFormat15,requiresFormat16,pesRequiresFormat19);
  if(historyArchives)historyOwner?.commit(historyArchives);
  lastImportedSources=importedSources;lastAdvancedAsset=advancedAsset;lastAdvancedReferences=advancedReferences;
  lastAdvancedRequiresFormat2=advancedFormat2;lastAdvancedRequiresFormat4=advancedFormat4;
  lastAdvancedRequiresFormat5=advancedFormat5;lastAdvancedRequiresFormat6=advancedFormat6;lastAdvancedRequiresFormat8=advancedFormat8;
  lastAdvancedRequiresFormat10=advancedFormat10;
  lastAdvancedRequiresFormat15=advancedFormat15;
  lastAdvancedRequiresFormat17=advancedFormat17;
  lastAdvancedRequiresFormat18=advancedFormat18;
  if(advancedReader&&advancedReader===restoredAdvancedReader&&
    (advancedReader.current.assetId!==advancedAsset||advancedReader.current.formatVersion!==data.requiredProjectFormatVersion))
   advancedReader.current={assetId:advancedAsset,formatVersion:data.requiredProjectFormatVersion};
 });
 return data;
}
export async function decodeWorkspaceProject(value:unknown,reader:ProjectAssetReader,options:{deferPublication?:boolean;transientAdvancedReads?:boolean}={}){
 const data=value as SyWorkspaceSnapshot;
 const record=(candidate:unknown):boolean=>Boolean(candidate&&typeof candidate==='object'&&!Array.isArray(candidate));
 if(!data||data.schema!=='sciyue-workspace-project/v1'||typeof data.registryAsset!=='string'||!data.registryAsset||
   !record(data.results)||!record(data.sources)||!record(data.generated)||data.fileSources!==undefined&&!record(data.fileSources))
  throw new Error('项目工作区格式不受支持。');
 if(data.requiredProjectFormatVersion!==undefined&&projectFormatFloor(data.requiredProjectFormatVersion)<2)throw new Error('项目工作区保存格式无效，原项目未改变。');
 if(data.fileSources&&Object.keys(data.fileSources).length&&(data.requiredProjectFormatVersion??0)<3)throw Error('文件级科学来源缺少项目写入保护声明，原项目未改变。');
 if(data.pesAsset!==undefined&&(data.requiredProjectFormatVersion??0)<9)throw Error('势能面资产缺少格式 9 写入保护声明，原项目未改变。');
 if(data.pesAssetReferences!==undefined&&(data.requiredProjectFormatVersion??0)<11)throw Error('路径轮结构资产缺少格式 11 写入保护声明，原项目未改变。');
 const read=<T,>(id:string)=>reader.read(id).then(bytes=>JSON.parse(text.decode(bytes)) as T);
 const registryBytes=await reader.read(data.registryAsset);
 const originalRegistry=JSON.parse(text.decode(registryBytes)) as WorkspaceProjectState;
 if(originalRegistry?.schema!=='sciyue-workspace-project'||originalRegistry.version!==1||!Array.isArray(originalRegistry.documents)||!originalRegistry.documents.every(record))
  throw new Error('项目文档索引无效。');
 if(!Object.values(data.results).every(record)||!Object.values(data.generated).every(record)||
   data.assetReferences!==undefined&&(!Array.isArray(data.assetReferences)||data.assetReferences.some(id=>typeof id!=='string'||!id)))
  throw new Error('项目结果或资产依赖索引无效。');
 if(data.pesAsset!==undefined&&(!isProjectAssetId(data.pesAsset)||!data.assetReferences?.includes(data.pesAsset)))
  throw Error('项目势能面资产引用无效，原项目未改变。');
 if(data.pesAssetReferences!==undefined&&(!data.pesAsset||!Array.isArray(data.pesAssetReferences)||new Set(data.pesAssetReferences).size!==data.pesAssetReferences.length||data.pesAssetReferences.some(id=>!isProjectAssetId(id)||!data.assetReferences?.includes(id))))
  throw Error('项目路径轮结构资产引用无效，原项目未改变。');
 const historyArchives=readHistoryArchiveReferences(data);
 const modelRows=workspaceModelRows(originalRegistry);
 const preparedHistory=prepareRestoredModelStoreHistories(modelRows.map(row=>row?.model));
 let registry=originalRegistry;
 if(preparedHistory.limited){
  if(!isProjectAssetId(data.registryAsset)||await projectAssetSha256(registryBytes)!==data.registryAsset)
   throw Error('原项目历史档案校验失败，当前项目未被替换。');
  const documentIds=modelRows.filter((row,index)=>row.model!==preparedHistory.models[index]).map(row=>row.id);
  if(!historyArchives.some(row=>row.assetId===data.registryAsset))historyArchives.push({assetId:data.registryAsset,documentIds,assetReferences:originalHistoryAssetReferences(data,historyArchives)});
  const preparedRows=modelRows.map((row,index)=>({...row,model:preparedHistory.models[index]}));
  registry={...originalRegistry,documents:preparedRows.slice(0,originalRegistry.documents.length),
   ...(Array.isArray(originalRegistry.detachedDocuments)?{detachedDocuments:preparedRows.slice(originalRegistry.documents.length)}:{})};
 }
 if(hasEmbeddedHistoryArchive(registry)&&(data.requiredProjectFormatVersion??0)<10)
  throw Error('项目模型历史档案缺少格式 10 写入保护声明，原项目未改变。');
 if(workspaceModelRows(registry).some(row=>Object.keys(row.model.document.frameBondOverrides??{}).length>0)&&(data.requiredProjectFormatVersion??0)<14)
  throw Error('逐帧显示键图缺少格式 14 写入保护声明，原项目未改变。');
 if(requiresProjectFormat15([registry,data.shell,data.ui])&&(data.requiredProjectFormatVersion??0)<15)
  throw Error('新模型或输入来源缺少格式 15 写入保护声明，原项目未改变。');
 if(requiresRecoveryFormat7(registry,data.shell)&&(data.requiredProjectFormatVersion??0)<7)
  throw Error('项目恢复状态缺少格式 7 写入保护声明，原项目未改变。');
 if((data.requiredProjectFormatVersion??0)<8&&workspaceRequiresXtbFormat8(registry,data.shell,data.ui))
  throw Error('xTB配置或模型来源缺少格式 8 写入保护声明，原项目未改变。');
 const pesAsset=data.pesAsset?new WorkspacePesAsset(data.pesAsset,reader,data.pesAssetReferences,(data.requiredProjectFormatVersion??0)>=11,(data.requiredProjectFormatVersion??0)>=12,(data.requiredProjectFormatVersion??0)>=13,(data.requiredProjectFormatVersion??0)>=15,(data.requiredProjectFormatVersion??0)>=16,(data.requiredProjectFormatVersion??0)>=19):undefined;
 // These validations must finish before the Shell releases or replaces its
 // current graph. The prepared owner functions only publish validated data.
 if(!record(data.ui?.values))throw Error('项目界面状态版本或数据无效。');
 new ProjectUiStore(data.ui);
 const publishAnalysis=prepareAnalysisProjectRestore(data.analysis,reader);
 const publishImported=prepareImportedModelSourcesRestore(data.importedSources??{schema:1,sources:[],bundles:[]},reader);
 const issues:WorkspaceRestoreIssue[]=[];
 for(const row of workspaceModelRows(registry)){
  const limit=row?.model?.document?.projectHistoryLimited;
  if(limit){
   const archive=historyArchives.find(item=>item.documentIds.includes(row.id));
   const archived=archive||row.model.projectHistoryArchive?.length;
   issues.push({assetId:archive?.assetId??data.registryAsset,
    message:`${row.label} 的历史恢复受限（Undo ${limit.omittedPast} 步、Redo ${limit.omittedFuture} 步）。${archived?'原始历史档案已保留。':''}`});
  }
 }
 const {shell,retainedShell,diagnostics}=projectWorkspaceShell(data.shell,reader,issues);
 const advancedReader:AdvancedReaderState={current:{assetId:data.advancedAsset,formatVersion:data.requiredProjectFormatVersion},reader};
 const missingResults=new Map<string,SyWorkspaceSnapshot['results'][string]>(),missingSources=new Map<string,string>();
 const missingGenerated=new Map<string,SyWorkspaceSnapshot['generated'][string]>(),missingFileSources=new Map<string,string>();
 const keyFor=(id:string)=>JSON.stringify([id,registry.documents.find(entry=>entry.id===id)?.epoch]);
 const results=new Map<string,{result?:TrajectoryResult;legacyResult?:TrajectoryResult;analysisBinding?:{id:string;result:TrajectoryResult}}>();
 const sources:Record<string,PostprocessDocument>={},fileSources:Record<string,PostprocessScientificFileDocument>={},generated:Generated={};
 const decodedResults=new Map<string,TrajectoryResult>();
 let foundUnprotectedFormat8=false;
 let foundUnprotectedFormat15=false;
 let foundUnprotectedFormat19=false;
 const checkResultFormat19=(required:boolean)=>{
  if(!required||(data.requiredProjectFormatVersion??0)>=19)return;
  foundUnprotectedFormat19=true;
  throw Error('项目二进制数值或轨迹缺少格式 19 写入保护声明，原资产引用已保留。');
 };
 const checkResultFormat15=(dto:unknown)=>{
  if(!requiresProjectFormat15(dto)||(data.requiredProjectFormatVersion??0)>=15)return;
  foundUnprotectedFormat15=true;
  throw Error('外部程序来源缺少格式 15 写入保护声明，原资产引用已保留。');
 };
 const checkResultFormat8=(required:boolean)=>{
  if(!required||(data.requiredProjectFormatVersion??0)>=8)return;
  foundUnprotectedFormat8=true;
  throw Error('xTB结果或构象显示缺少格式 8 写入保护声明，原资产引用已保留。');
 };
 const loadResult=async(id:string)=>{const cached=decodedResults.get(id);if(cached)return cached;const dto=await read<TrajectoryResultSnapshot>(id);checkResultFormat15(dto);checkResultFormat8(trajectorySnapshotRequiresFormat8(dto));checkResultFormat19(trajectorySnapshotRequiresFormat19(dto));const result=decodeResult(dto,reader,await prepareProjectResultNumerics([dto],reader));if(conformerDisplayRestorationRequiresFormat6((result as TrajectoryResult&{displayRestoration?:ConformerDisplayRestoration}).displayRestoration)&&(data.requiredProjectFormatVersion??0)<6)throw Error("分类型构象显示缺少项目写入保护声明。");if(conformerDisplayRestorationRequiresFormat5(result)&&(data.requiredProjectFormatVersion??0)<5)throw Error('构象显示恢复缺少项目写入保护声明。');resultCache.set(result,dto);decodedResults.set(id,result);return result;};
 const loadSource=async(id:string)=>{const dto=await read<PostprocessDocumentSnapshot>(id);checkResultFormat15(dto);if(dto.schema===4&&(data.requiredProjectFormatVersion??0)<3)throw Error('科学来源角色缺少项目写入保护声明。');checkResultFormat8(postprocessSnapshotRequiresFormat8(dto));checkResultFormat19(postprocessSnapshotRequiresFormat19(dto));const result=decodePostprocessDocument(dto,reader,await prepareProjectPostprocessNumerics(dto,reader));sourceCache.set(result,dto);sourceCompanionVersions.set(result,projectCompanionVersion(result.output));sourceAssociationVersions.set(result,getPostprocessTaskAssociationVersion(result));sourceFileVersions.set(result,postprocessFileDocumentVersion(result));return result;};
 for(const [id,row]of Object.entries(data.results)){const target:{result?:TrajectoryResult;legacyResult?:TrajectoryResult;analysisBinding?:{id:string;result:TrajectoryResult}}={};for(const kind of ['result','legacyResult','analysisBinding']as const){const asset=kind==='analysisBinding'?row.analysisBinding?.result:row[kind];if(!asset)continue;try{const value=await loadResult(asset);if(kind==='analysisBinding')target.analysisBinding={id:row.analysisBinding!.id,result:value};else target[kind]=value;}catch(error){missingResults.set(keyFor(id),row);issues.push({assetId:asset,message:error instanceof Error?error.message:String(error)});}}results.set(id,target);}
 for(const [id,asset]of Object.entries(data.sources))try{sources[id]=await loadSource(asset);}catch(error){missingSources.set(keyFor(id),asset);issues.push({assetId:asset,message:error instanceof Error?error.message:String(error)});}
 for(const [id,asset]of Object.entries(data.fileSources??{}))try{const dto=await read<PostprocessFileDocumentSnapshot>(asset);checkResultFormat15(dto);if(dto.schema!==4||!('kind'in dto)||dto.kind!=='scientific-file')throw Error('文件级来源索引格式不一致。');checkResultFormat8(postprocessSnapshotRequiresFormat8(dto));checkResultFormat19(postprocessSnapshotRequiresFormat19(dto));const source=decodePostprocessFileDocument(dto,reader,await prepareProjectPostprocessNumerics(dto,reader));if(!isScientificFileDocument(source)||source.id!==id)throw Error('文件级来源索引身份不一致。');fileSourceCache.set(source,dto);fileSourceVersions.set(source,postprocessFileDocumentVersion(source));fileSources[id]=source;}catch(error){missingFileSources.set(id,asset);issues.push({assetId:asset,message:error instanceof Error?error.message:String(error)});}
 for(const [id,row]of Object.entries(data.generated))try{generated[id]={document:await loadSource(row.assetId),ownerId:row.ownerId,bindingId:row.bindingId};}catch(error){missingGenerated.set(id,row);issues.push({assetId:row.assetId,message:error instanceof Error?error.message:String(error)});}
 let publication:Promise<void>|undefined;
 const boundArchives=new WeakSet<WorkspaceRegistry>();
 const publish=async(owner?:WorkspaceRegistry)=>{
 await (publication??=(async()=>{
  await publishImported(error=>issues.push({assetId:'importedSources',message:'旧模型来源仍待释放：'+(error instanceof Error?error.message:String(error))}));
  await publishAnalysis();
  const replace=<T,>(target:Map<string,T>,source:ReadonlyMap<string,T>)=>{target.clear();for(const [id,value]of source)target.set(id,value);};
  replace(unreadableResults,missingResults);replace(unreadableSources,missingSources);
  replace(unreadableGenerated,missingGenerated);
  const archiveIds=new Set(historyArchives.map(row=>row.assetId));
  unreadableDependencies=(data.assetReferences??[]).filter(id=>!archiveIds.has(id));unreadableRequiresFormat3=(data.requiredProjectFormatVersion??0)>=3;
  unreadableRequiresFormat5=(data.requiredProjectFormatVersion??0)>=5;unreadableRequiresFormat6=(data.requiredProjectFormatVersion??0)>=6;
  unreadableRequiresFormat8=foundUnprotectedFormat8||(data.requiredProjectFormatVersion??0)>=8;
  unreadableRequiresFormat15=foundUnprotectedFormat15||(data.requiredProjectFormatVersion??0)>=15;
  unreadableRequiresFormat19=foundUnprotectedFormat19||(data.requiredProjectFormatVersion??0)>=19;
  lastAdvancedAsset=data.advancedAsset;lastAdvancedRequiresFormat2=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=2);lastAdvancedRequiresFormat4=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=4);lastAdvancedRequiresFormat5=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=5);lastAdvancedRequiresFormat6=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=6);lastAdvancedReferences=data.advancedAsset?(data.assetReferences??[]).filter(id=>id!==data.pesAsset&&!archiveIds.has(id)):[];lastImportedSources=data.importedSources;
  lastAdvancedRequiresFormat8=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=8);
  lastAdvancedRequiresFormat10=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=10);
  lastAdvancedRequiresFormat15=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=15);
  lastAdvancedRequiresFormat17=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=17);
  lastAdvancedRequiresFormat18=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=18);
  restoredAdvancedReader=advancedReader;
 })());
 if(owner&&!boundArchives.has(owner)){
  advancedRecoveryByRegistry.set(owner,advancedReader);
  boundArchives.add(owner);
  if(historyArchives.length)workspaceHistoryArchives.set(owner,new WorkspaceHistoryArchives(structuredClone(historyArchives),reader));
  else workspaceHistoryArchives.delete(owner);
 }
 };
 if(!options.deferPublication)await publish();
 return{data,shell,retainedShell,diagnostics,registry,results,sources,fileSources,fileSourceIssues:Object.fromEntries(missingFileSources),generated,issues,publish,pesAsset,readPes:async()=>pesAsset?.read(),unavailableAdvancedTaskIds:()=>advancedReader.retained?.unavailable??[],readAdvanced:async()=>{
   for(;;){
    const reference=advancedReader.current;
    if(!reference.assetId)return;
    let advanced:AdvancedProjectSnapshot;
    let retained:RetainedAdvancedTasks|undefined;
    try{advanced=await decodeAdvancedAsset(await read<unknown>(reference.assetId),reader,rows=>{retained=rows;},{transientReads:options.transientAdvancedReads});}
    catch(error){if(advancedReader.current!==reference)continue;throw error;}
    // A read can overlap successful Save As and the router's synchronous
    // rebind. Retry only when this exact restored owner's reference changed.
    if(advancedReader.current!==reference)continue;
    const format=reference.formatVersion??0;
    if(format<18&&advanced.tasks.some(conformerTaskRequiresMdIntegrator)){
     if(restoredAdvancedReader===advancedReader)lastAdvancedRequiresFormat18=true;
     throw Error('此采样配置需要项目格式 18。原始采样资产已保留。');
    }
    if(format<17&&advanced.tasks.some(conformerTaskRequiresSharedOptimizer)){
     if(restoredAdvancedReader===advancedReader)lastAdvancedRequiresFormat17=true;
     throw Error('构象共用优化缺少格式 17 写入保护声明，原资产引用已保留。');
    }
    if(format<15&&requiresProjectFormat15(advanced)){
     if(restoredAdvancedReader===advancedReader)lastAdvancedRequiresFormat15=true;
     throw Error('外部程序任务缺少格式 15 写入保护声明，原资产引用已保留。');
    }
    if(format<10&&advanced.tasks.some(conformerTaskRequiresNativeDefaultSemantics)){
     if(restoredAdvancedReader===advancedReader)lastAdvancedRequiresFormat10=true;
     throw Error('构象优化原生默认步数缺少格式 10 写入保护声明，原资产引用已保留。');
    }
    if(format<8&&advanced.tasks.some(advancedTaskRequiresXtbFormat8)){
     if(restoredAdvancedReader===advancedReader)lastAdvancedRequiresFormat8=true;
     throw Error('xTB任务缺少格式 8 写入保护声明，原资产引用已保留。');
    }
    if(advanced.tasks.some(task=>conformerTaskRequiresElementGeometrySemantics(task)||conformerTaskHasInitialVelocityProvenance(task)||conformerTaskHasNativeSolvationProvenance(task)||conformerTaskRequiresAlpbSemantics(task)||conformerTaskSharedFreezeRequiresFormat6(task))&&format<6)throw Error('等价消除或原生初速度来源缺少项目写入保护声明。');
    if(advanced.tasks.some(conformerTaskProtectionRequiresFormat5)&&format<5)throw Error('构象保护启用或运行冻结快照缺少项目写入保护声明。');
    if(advanced.tasks.some(conformerTaskRequiresExtendedSemantics)&&format<4)throw Error('构象匹配或抽帧语义缺少项目写入保护声明。');
    advancedReader.retained=retained;
    return advanced;
   }
 }};
}
