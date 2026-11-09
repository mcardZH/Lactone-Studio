import type {WorkspaceRegistry,WorkspaceProjectState} from '../modeling/workspace-registry';
import {isScientificFileDocument,type PostprocessDocument,type PostprocessScientificFileDocument} from '../results/postprocess-document';
import type {TrajectoryResult} from '../results/contracts';
import {encodeResult,decodeResult,encodePostprocessDocument,decodePostprocessDocument,encodePostprocessFileDocument,decodePostprocessFileDocument,type PostprocessFileDocumentSnapshot,type TrajectoryResultSnapshot,type PostprocessDocumentSnapshot,type ProjectAssetWriter,type ProjectAssetReader} from './result-snapshot';
import {captureAnalysisProjectState,restoreAnalysisProjectState,type AnalysisProjectState} from './analysis-state';
import type {ProjectUiSnapshot} from './ui-state';
import type {AdvancedProjectSnapshot} from './advanced-snapshot';
import {conformerTaskRequiresExtendedSemantics,conformerTaskRequiresElementGeometrySemantics} from '../modeling/advanced/conformer-cluster-collection';
import {conformerTaskHasInitialVelocityProvenance,conformerTaskHasNativeSolvationProvenance} from '../modeling/advanced/initial-velocity-provenance';
import {conformerTaskRequiresAlpbSemantics} from '../modeling/advanced/conformer-solvation';
import {conformerTaskProtectionRequiresFormat5,conformerTaskSharedFreezeRequiresFormat6} from '../modeling/advanced/conformer-protection';
import {conformerDisplayRestorationRequiresFormat5,conformerDisplayRestorationRequiresFormat6,type ConformerDisplayRestoration} from '../modeling/conformers/playback-display';
import {captureImportedModelSources,restoreImportedModelSources,type ImportedModelSourcesSnapshot} from './import-sources';
import {projectCompanionVersion,postprocessFileDocumentVersion} from './companion-sources';
import {encodeAdvancedAsset,decodeAdvancedAsset} from './advanced-asset-codec';
import {createRuntimeModelStore} from '../core/modeling/model-store';
import type {ModelDocument} from '../modeling/contracts';
import type {DynamicsController,DynamicsSnapshotObservation} from '../modeling/dynamics/controller';
import {createInputExportGuard} from '../modeling/application/input-export-guard';
import {graphFingerprint} from '../core/modeling/graph';
import {getPostprocessTaskAssociationVersion} from './postprocess-task-association';

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
export interface SyWorkspaceSnapshot {
 schema:'sciyue-workspace-project/v1';registryAsset:string;
 requiredProjectFormatVersion?:2|3|4|5|6;
 results:Record<string,{result?:string;legacyResult?:string;analysisBinding?:{id:string;result:string}}>;
 sources:Record<string,string>;generated:Record<string,{assetId:string;ownerId:string;bindingId:string}>;
 /** File/job sources without a model registry entry retain their own raw assets. */
 fileSources?:Record<string,string>;
 advancedAsset?:string;ui:ProjectUiSnapshot;shell:Record<string,unknown>;analysis:AnalysisProjectState;
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
const unreadableFileSources=new Map<string,string>();
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
const text=new TextDecoder('utf-8',{fatal:true});
function refs(value:unknown,output:Set<string>,key=''){
 if(key==='assetId'&&typeof value==='string')output.add(value);
 else if((key==='frameAssets'||key==='assetReferences')&&Array.isArray(value)){for(const id of value)if(typeof id==='string')output.add(id);}
 else if(Array.isArray(value))value.forEach(item=>refs(item,output));
 else if(value&&typeof value==='object')for(const [name,item]of Object.entries(value))refs(item,output,name);
}
export async function captureWorkspaceProject(input:{registry:WorkspaceRegistry;documents:Record<string,PostprocessDocument>;fileDocuments?:Record<string,PostprocessScientificFileDocument>;preservedFileSources?:Readonly<Record<string,string>>;generated:Generated;advanced?:AdvancedProjectSnapshot;ui:ProjectUiSnapshot;shell:Record<string,unknown>;writer:ProjectAssetWriter;reuse:boolean;modelSnapshots?:ReadonlyMap<string,WorkspaceModelSnapshot>}):Promise<SyWorkspaceSnapshot>{
 if(!input.reuse&&Object.keys(input.preservedFileSources??{}).some(id=>!input.fileDocuments?.[id]))throw Error('项目有缺损的文件级来源索引，无法生成完整自包含的另存项目。');
 const snapshots=new Map([...input.modelSnapshots??[]].map(([id,value])=>[id,{...value,document:structuredClone(value.document),...(value.observation?{observation:structuredClone(value.observation)}:{})}]));
 const assertSnapshotsCurrent=()=>{for(const value of snapshots.values())value.assertCurrent();};assertSnapshotsCurrent();
 const mdSnapshotSources=checkpointSources(input.shell.mdSnapshotSources,snapshots),shell={...input.shell,...(mdSnapshotSources===undefined?{}:{mdSnapshotSources})};
 const {writer}=input,registry=input.registry.exportProjectState({saved:true}),dependencies=new Set<string>();
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
 const retain=(id:string)=>{dependencies.add(id);(writer as ProjectAssetWriter&{retainAsset?(assetId:string):void}).retainAsset?.(id);};
 const asset=async(name:string,value:unknown,category='results')=>{assertSnapshotsCurrent();const id=(await writer.write(category,name,JSON.stringify(value))).assetId;assertSnapshotsCurrent();retain(id);return id;};
 let requiresFormat5=false,resultRequiresFormat6=false;
 const saveResult=async(value:TrajectoryResult)=>{if(conformerDisplayRestorationRequiresFormat5(value))requiresFormat5=true;if(conformerDisplayRestorationRequiresFormat6((value as TrajectoryResult&{displayRestoration?:ConformerDisplayRestoration}).displayRestoration))resultRequiresFormat6=true;let pending=encodedResults.get(value);if(!pending){const cached=input.reuse?resultCache.get(value):undefined;pending=cached?Promise.resolve(cached):encodeResult(value,writer);encodedResults.set(value,pending);}const dto=await pending;resultCache.set(value,dto);refs(dto,dependencies);return asset('trajectory-index.json',dto);};
 let requiresFormat3=false;
 const saveSource=async(value:PostprocessDocument)=>{const version=projectCompanionVersion(value.output),associationVersion=getPostprocessTaskAssociationVersion(value),fileVersion=postprocessFileDocumentVersion(value);let dto=input.reuse&&sourceCompanionVersions.get(value)===version&&sourceAssociationVersions.get(value)===associationVersion&&sourceFileVersions.get(value)===fileVersion?sourceCache.get(value):undefined;if(!dto){dto=await encodePostprocessDocument(value,writer);sourceCache.set(value,dto);sourceCompanionVersions.set(value,version);sourceAssociationVersions.set(value,associationVersion);sourceFileVersions.set(value,fileVersion);}if(dto.schema===4)requiresFormat3=true;refs(dto,dependencies);return asset('source-index.json',dto);};
 const saveFileSource=async(value:PostprocessScientificFileDocument)=>{const version=postprocessFileDocumentVersion(value);let dto=input.reuse&&fileSourceVersions.get(value)===version?fileSourceCache.get(value):undefined;if(!dto){dto=await encodePostprocessFileDocument(value,writer);fileSourceCache.set(value,dto);fileSourceVersions.set(value,version);}if(dto.schema!==4||!('kind'in dto)||dto.kind!=='scientific-file')throw Error('文件级科学来源未取得对应的完整保存格式。');requiresFormat3=true;refs(dto,dependencies);return asset('scientific-file-index.json',dto);};
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
 const importedSources=await captureImportedModelSources(writer,{reuse:input.reuse?lastImportedSources:undefined,documentIds:registry.documents.map(entry=>entry.id)});refs(importedSources,dependencies);lastImportedSources=importedSources;
 const advancedData=input.advanced?await encodeAdvancedAsset(input.advanced,writer):undefined;if(advancedData){lastAdvancedReferences=advancedData.assetReferences;refs(advancedData,dependencies);}else if(input.reuse){for(const id of lastAdvancedReferences)retain(id);}else lastAdvancedReferences=[];
 const advancedAsset=advancedData?await asset('advanced-tasks.json',advancedData):input.reuse?lastAdvancedAsset:undefined;if(advancedAsset)retain(advancedAsset);lastAdvancedAsset=advancedAsset;
 if(input.advanced)lastAdvancedRequiresFormat2=input.advanced.schema===2;else if(!input.reuse)lastAdvancedRequiresFormat2=false;
 if(input.advanced)lastAdvancedRequiresFormat4=input.advanced.tasks.some(conformerTaskRequiresExtendedSemantics);else if(!input.reuse)lastAdvancedRequiresFormat4=false;
 if(input.advanced)lastAdvancedRequiresFormat5=input.advanced.tasks.some(conformerTaskProtectionRequiresFormat5);else if(!input.reuse)lastAdvancedRequiresFormat5=false;
 if(input.advanced)lastAdvancedRequiresFormat6=input.advanced.tasks.some(task=>conformerTaskRequiresElementGeometrySemantics(task)||conformerTaskHasInitialVelocityProvenance(task)||conformerTaskHasNativeSolvationProvenance(task)||conformerTaskRequiresAlpbSemantics(task)||conformerTaskSharedFreezeRequiresFormat6(task));else if(!input.reuse)lastAdvancedRequiresFormat6=false;
 const requiresFormat6=Boolean(resultRequiresFormat6||preservingUnreadable&&unreadableRequiresFormat6||advancedAsset&&lastAdvancedRequiresFormat6);
 const data:SyWorkspaceSnapshot={schema:'sciyue-workspace-project/v1',...(requiresFormat6?{requiredProjectFormatVersion:6 as const}:requiresFormat5||advancedAsset&&lastAdvancedRequiresFormat5?{requiredProjectFormatVersion:5 as const}:advancedAsset&&lastAdvancedRequiresFormat4?{requiredProjectFormatVersion:4 as const}:requiresFormat3?{requiredProjectFormatVersion:3 as const}:advancedAsset&&lastAdvancedRequiresFormat2?{requiredProjectFormatVersion:2 as const}:{}),registryAsset:await asset('workspace-models.json',registry,'models'),results,sources,...(Object.keys(fileSources).length?{fileSources}:{}),generated,...(advancedAsset?{advancedAsset}:{}),ui:input.ui,shell,analysis,importedSources,assetReferences:[],...(preservingUnreadable&&!unreadableDependencies.length?{preserveUnlistedAssets:true as const}:{})};
 // DTO cache reuse can skip every writer call; register its nested dependencies
 // independently of whether a frame/source/grid has ever been read.
 for(const id of dependencies)retain(id);data.assetReferences=[...dependencies];assertSnapshotsCurrent();return data;
}
export async function decodeWorkspaceProject(value:unknown,reader:ProjectAssetReader){
 const data=value as SyWorkspaceSnapshot;if(!data||data.schema!=='sciyue-workspace-project/v1'||!data.registryAsset||!data.ui||!data.shell)throw new Error('项目工作区格式不受支持。');
 if(data.requiredProjectFormatVersion!==undefined&&![2,3,4,5,6].includes(data.requiredProjectFormatVersion))throw new Error('项目工作区需要较新的保存格式，原项目未改变。');
 if(data.fileSources&&Object.keys(data.fileSources).length&&(data.requiredProjectFormatVersion??0)<3)throw Error('文件级科学来源缺少项目写入保护声明，原项目未改变。');
 const read=<T,>(id:string)=>reader.read(id).then(bytes=>JSON.parse(text.decode(bytes)) as T);
 const registry=await read<WorkspaceProjectState>(data.registryAsset);
 unreadableResults.clear();unreadableSources.clear();unreadableGenerated.clear();unreadableFileSources.clear();unreadableDependencies=data.assetReferences??[];unreadableRequiresFormat3=(data.requiredProjectFormatVersion??0)>=3;
 unreadableRequiresFormat5=(data.requiredProjectFormatVersion??0)>=5;
 unreadableRequiresFormat6=data.requiredProjectFormatVersion===6;
 const issues:{assetId:string;message:string}[]=[];
 const keyFor=(id:string)=>JSON.stringify([id,registry.documents.find(entry=>entry.id===id)?.epoch]);
 const results=new Map<string,{result?:TrajectoryResult;legacyResult?:TrajectoryResult;analysisBinding?:{id:string;result:TrajectoryResult}}>();
 const sources:Record<string,PostprocessDocument>={},fileSources:Record<string,PostprocessScientificFileDocument>={},generated:Generated={};
 const decodedResults=new Map<string,TrajectoryResult>();
 const loadResult=async(id:string)=>{const cached=decodedResults.get(id);if(cached)return cached;const dto=await read<TrajectoryResultSnapshot>(id),result=decodeResult(dto,reader);if(conformerDisplayRestorationRequiresFormat6((result as TrajectoryResult&{displayRestoration?:ConformerDisplayRestoration}).displayRestoration)&&(data.requiredProjectFormatVersion??0)<6)throw Error("分类型构象显示缺少项目写入保护声明。");if(conformerDisplayRestorationRequiresFormat5(result)&&(data.requiredProjectFormatVersion??0)<5)throw Error('构象显示恢复缺少项目写入保护声明。');resultCache.set(result,dto);decodedResults.set(id,result);return result;};
 const loadSource=async(id:string)=>{const dto=await read<PostprocessDocumentSnapshot>(id);if(dto.schema===4&&(data.requiredProjectFormatVersion??0)<3)throw Error('科学来源角色缺少项目写入保护声明。');const result=decodePostprocessDocument(dto,reader);sourceCache.set(result,dto);sourceCompanionVersions.set(result,projectCompanionVersion(result.output));sourceAssociationVersions.set(result,getPostprocessTaskAssociationVersion(result));sourceFileVersions.set(result,postprocessFileDocumentVersion(result));return result;};
 for(const [id,row]of Object.entries(data.results)){const target:{result?:TrajectoryResult;legacyResult?:TrajectoryResult;analysisBinding?:{id:string;result:TrajectoryResult}}={};for(const kind of ['result','legacyResult','analysisBinding']as const){const asset=kind==='analysisBinding'?row.analysisBinding?.result:row[kind];if(!asset)continue;try{const value=await loadResult(asset);if(kind==='analysisBinding')target.analysisBinding={id:row.analysisBinding!.id,result:value};else target[kind]=value;}catch(error){unreadableResults.set(keyFor(id),row);issues.push({assetId:asset,message:error instanceof Error?error.message:String(error)});}}results.set(id,target);}
 for(const [id,asset]of Object.entries(data.sources))try{sources[id]=await loadSource(asset);}catch(error){unreadableSources.set(keyFor(id),asset);issues.push({assetId:asset,message:error instanceof Error?error.message:String(error)});}
 for(const [id,asset]of Object.entries(data.fileSources??{}))try{const dto=await read<PostprocessFileDocumentSnapshot>(asset);if(dto.schema!==4||!('kind'in dto)||dto.kind!=='scientific-file')throw Error('文件级来源索引格式不一致。');const source=decodePostprocessFileDocument(dto,reader);if(!isScientificFileDocument(source)||source.id!==id)throw Error('文件级来源索引身份不一致。');fileSourceCache.set(source,dto);fileSourceVersions.set(source,postprocessFileDocumentVersion(source));fileSources[id]=source;}catch(error){unreadableFileSources.set(id,asset);issues.push({assetId:asset,message:error instanceof Error?error.message:String(error)});}
 for(const [id,row]of Object.entries(data.generated))try{generated[id]={document:await loadSource(row.assetId),ownerId:row.ownerId,bindingId:row.bindingId};}catch(error){unreadableGenerated.set(id,row);issues.push({assetId:row.assetId,message:error instanceof Error?error.message:String(error)});}
 await restoreAnalysisProjectState(data.analysis,reader);
 lastAdvancedAsset=data.advancedAsset;lastAdvancedRequiresFormat2=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=2);lastAdvancedRequiresFormat4=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=4);lastAdvancedRequiresFormat5=Boolean(data.advancedAsset&&(data.requiredProjectFormatVersion??0)>=5);lastAdvancedRequiresFormat6=Boolean(data.advancedAsset&&data.requiredProjectFormatVersion===6);lastAdvancedReferences=data.advancedAsset?[...data.assetReferences??[]]:[];lastImportedSources=data.importedSources;await restoreImportedModelSources(data.importedSources??{schema:1,sources:[],bundles:[]},reader);
 return{data,registry,results,sources,fileSources,fileSourceIssues:Object.fromEntries(unreadableFileSources),generated,issues,readAdvanced:async()=>{
   if(!data.advancedAsset)return;
   const advanced=await decodeAdvancedAsset(await read<unknown>(data.advancedAsset),reader);
   if(advanced.tasks.some(task=>conformerTaskRequiresElementGeometrySemantics(task)||conformerTaskHasInitialVelocityProvenance(task)||conformerTaskHasNativeSolvationProvenance(task)||conformerTaskRequiresAlpbSemantics(task)||conformerTaskSharedFreezeRequiresFormat6(task))&&(data.requiredProjectFormatVersion??0)<6)throw Error('等价消除或原生初速度来源缺少项目写入保护声明。');
   if(advanced.tasks.some(conformerTaskProtectionRequiresFormat5)&&(data.requiredProjectFormatVersion??0)<5)throw Error('构象保护启用或运行冻结快照缺少项目写入保护声明。');
   if(advanced.tasks.some(conformerTaskRequiresExtendedSemantics)&&(data.requiredProjectFormatVersion??0)<4)throw Error('构象匹配或抽帧语义缺少项目写入保护声明。');
   return advanced;
 }};
}
