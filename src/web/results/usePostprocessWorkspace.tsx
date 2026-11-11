import { useEffect, useRef, useState } from 'react';
import { type TrajectoryResult, type ResultDiagnostic, type ResultInputFile } from '../../results/contracts';
import type { Structure } from '../../core/types';
import { resultFile, type ScientificSourceFile } from '../../results/input-file';
import { identifyPostprocessSource, readPostprocessFileOutput, isScientificFileSource,postprocessFileJob, readPostprocessWavefunction, readPostprocessAuxiliary, readPostprocessNebAuxiliary,snapshotPostprocessNebAuxiliary,pairPostprocessSourcesForFrames, postprocessMetadataConflict, isUnifiedPostprocessSource, postprocessDestination, extractPostprocessModel, type PostprocessParsedResultsLease } from '../../results/postprocess-sources';
import type {NebAuxiliarySource} from '../../results/neb-auxiliary-reader';
import {readMdAuxiliary,type MdAuxiliarySource} from '../../results/md-aux-reader';
import {VibronicSha256} from '../../core/gaussian-vibronic/sha256-stream';
import {postprocessSourceExtras,retainPostprocessSourceExtras,type PostprocessSourceExtra} from '../../projects/postprocess-extra-sources';
import { composePostprocessDocument,composePostprocessFileDocument,postprocessFileDisplayDocument,selectPostprocessFileJob,projectPostprocessAttachment,retainPostprocessFileSourceBytes,createPostprocessReleaseQueue, disposePostprocessAttachments, retainPostprocessManagedSource, retainPostprocessOutputSourceText,retainPostprocessSourceBytes, observePostprocessSource, projectPostprocessStage, type PostprocessAttachment, type PostprocessDocument,type PostprocessScientificFileDocument,type PostprocessScientificFileAttachment,type PostprocessFileExtraSource } from '../../results/postprocess-document';
import type { PostprocessEngine, PostprocessTask,PostprocessSlotKey } from './PostprocessSidebar';
import {releaseOrbitalSession} from './useOrbitalField';
import {describePostprocessSource,matchingImportTargetForFrames,resolvePostprocessImportTarget,postprocessDocumentEngine,postprocessDocumentTask,preparePostprocessIncoming,preparePostprocessFileIncoming,defaultPostprocessCompanion,unaugmentedPostprocessOutput} from './postprocess-import-policy';
import DialogShell from '../DialogShell';
import type { XtbElectronicArtifactBundle } from '../../modeling/xtb/contracts';
import { readGeneratedXtbSource, validateGeneratedXtbBundle, type GeneratedXtbExpected, type GeneratedXtbSourcePackage } from '../../results/xtb-generated-source';
import { createPostprocessRetirement } from '../../modeling/application/postprocess-retirement';
import { readPreparedTrajectoryFrame } from './usePreparedTrajectory';
import {getPostprocessTaskAssociation,setPostprocessTaskAssociation} from '../../projects/postprocess-task-association';
import {resultStageChoices} from './PostprocessResultView';
import {projectTrajectoryStage} from '../../results/trajectory-stages';
import {notifyAnalysisProjectStateChanged} from '../../projects/analysis-state';
import {isExcitationSlot,updatePostprocessExcitationSlot,type ExcitationSlotKey} from './postprocess-excitation-slots';

/** Initial model handoff follows the same first source/stage as the public
 * result view. This transient projection does not replace the original source. */
export async function readInitialPostprocessStructure(document:PostprocessDocument,signal?:AbortSignal):Promise<Structure>{
  const selected=resultStageChoices(document)[0];
  if(!selected)return readPreparedTrajectoryFrame(document.result,0,signal);
  const result=await projectTrajectoryStage(selected.result,selected.stageId,signal);
  const projected=projectPostprocessStage(observePostprocessSource(document,selected.result),result);
  return readPreparedTrajectoryFrame(projected.result,0,signal);
}
/** A non-owning view of proven computed geometry. The file document continues
 * owning OUT bytes and all visited/unvisited jobs. Input echo never enters it. */
export function fileDisplayDocument(document:PostprocessScientificFileDocument):PostprocessDocument|null{
 return postprocessFileDisplayDocument(document);
}

interface Ports {
  add(result: TrajectoryResult, document?: PostprocessDocument, options?: { activate?: boolean; structure?: Structure;initialModule?:'analysis' }): string;
  replace(id: string, result: TrajectoryResult, document?: PostprocessDocument, structure?: Structure): void;
  /** Bind a source to an existing geometry without replacing its model or label. */
  attach?(id:string,result:TrajectoryResult,bindingId:string):string;
  /** Resolve protected sources before reading bytes or opening native sessions. */
  prepareRead?(targetId:string|undefined):Promise<{forceNew:true;onCreated(id:string):void}|null|undefined>;
  guardRemove?(id:string):void;
  available?(id: string): boolean;
  activate(id: string): void;
  exists(id: string): boolean;
  analyze(): void;
  reserveViews?(sessionId:string,targetId:string|null):Promise<void>;
  onError(message: string): void;
  onDiagnostics?(items: readonly ResultDiagnostic[]): void;
  /** File facts retain their own owner; no input-echo is submitted as a result. */
  onFileDocument?(document:PostprocessScientificFileDocument):void;
}
interface Pending {
  title: string; message: string; choices: { label: string; value: string }[];
  resolve(value: string): void;
}
const textError = (error: unknown) => error instanceof Error ? error.message : String(error);
const isMdExtra = (extra: PostprocessSourceExtra) => extra.format === 'orca-md-log' || extra.format === 'orca-md-statistics';
function extraInput(extra:PostprocessSourceExtra,signal?:AbortSignal):ResultInputFile {
  return {id:extra.sourceId,name:extra.name,size:extra.byteSize,readRange:extra.readRange,stream(){
    let offset=0;
    return new ReadableStream<Uint8Array>({async pull(controller){
      try {
        if(offset===extra.byteSize){controller.close();return;}
        const end=Math.min(extra.byteSize,offset+1024**2),bytes=await extra.readRange(offset,end,signal);
        offset=end;controller.enqueue(bytes);
      }catch(error){controller.error(error);}
    }});
  }};
}
async function snapshotMdAuxiliary(source:MdAuxiliarySource,signal:AbortSignal):Promise<PostprocessSourceExtra>{
  const {diagnostic}=source,identity=diagnostic.source,chunkSize=1024**2;
  const chunks:Uint8Array[]=[],hash=new VibronicSha256();
  for(let start=0;start<identity.size;start+=chunkSize){
    signal.throwIfAborted();const end=Math.min(identity.size,start+chunkSize);
    const bytes=await diagnostic.readSourceRange(start,end,signal);
    if(bytes.length!==end-start)throw Error('MD辅助原始字节长度发生变化。');
    chunks.push(bytes.slice());hash.update(bytes);
  }
  signal.throwIfAborted();const revision=hash.digest();
  if(!source.sha256||revision!==source.sha256)throw Error('MD辅助原字节与已读版本不一致，未混合保存。');
  return{name:identity.name,sourceId:identity.id,revision,byteSize:identity.size,format:source.kind==='log'?'orca-md-log':'orca-md-statistics',async readRange(start,end,readSignal){
    readSignal?.throwIfAborted();
    if(![start,end].every(Number.isSafeInteger)||start<0||end<start||end>identity.size)throw Error('MD附加原始来源范围无效。');
    const bytes=new Uint8Array(end-start);
    for(let offset=start;offset<end;){
      const chunk=chunks[Math.floor(offset/chunkSize)],local=offset%chunkSize;
      const count=Math.min(end-offset,chunk.length-local);
      bytes.set(chunk.subarray(local,local+count),offset-start);offset+=count;
    }
    return bytes;
  }};
}
interface ImportCloseState {closed:boolean;adopted?:boolean;pending?:Promise<void>;error?:unknown}
interface ImportReadOwner {
  controller:AbortController;inputs:Map<ResultInputFile,ImportCloseState>;sessions:Map<string,ImportCloseState>;
  extras:Map<PostprocessFileExtraSource,ImportCloseState>;
  targets:Set<string>;validate?():void;settled:boolean;transferred:boolean;
  done:Promise<void>;finish():void;
}

/** One source/session owner outside all view components. A hidden view does not
 * close a file or interrupt the native queue. */
export function usePostprocessWorkspace(ports: Ports, activeDocumentId: string | undefined) {
  const activeDocumentRef=useRef(activeDocumentId);activeDocumentRef.current=activeDocumentId;
  const [documents, setDocuments] = useState<Record<string, PostprocessDocument>>({});
  const [fileDocuments,setFileDocuments]=useState<Record<string,PostprocessScientificFileDocument>>({});
  const fileDocumentsRef=useRef(fileDocuments);fileDocumentsRef.current=fileDocuments;
  const [fileOwnerId,setFileOwnerId]=useState<string|null>(null);
  const fileOwnerRef=useRef(fileOwnerId);fileOwnerRef.current=fileOwnerId;
  const pendingFileCloses=useRef(new Map<string,PostprocessScientificFileDocument>());
  const documentsRef = useRef(documents); documentsRef.current = documents;
  const [generated,setGenerated]=useState<Record<string,{document:PostprocessDocument;ownerId:string;bindingId:string}>>({});
  const generatedRef=useRef(generated);generatedRef.current=generated;
  const portsRef = useRef(ports); portsRef.current = ports;
  // The source/session remains the owner while its geometry binding is
  // temporarily unavailable; Undo must restore the same cards and caches.
  const ownerId = activeDocumentId && documents[activeDocumentId] ? activeDocumentId : null;
  const [engine, setEngine] = useState<PostprocessEngine>('gaussian'), [task, setTask] = useState<PostprocessTask>('sp');
  const [stage, setStage] = useState<'software' | 'tasks' | 'files'>('software');
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<Pending | null>(null), [notice,setNotice]=useState('');
  const [readState,setReadState]=useState<'idle'|'reading'|'cancelling'>('idle');
  const sourceNotices = useRef<Record<string,string>>({});
  const pendingRef = useRef<Pending | null>(null), alive = useRef(true), requestEpoch = useRef(0), busyRef = useRef(false);
  const readOwnerRef=useRef<ImportReadOwner|null>(null);
  const closingIds=useRef(new Set<string>());
  const sourceEngine = postprocessDocumentEngine;
  const closeNative = async (id: string) => {const bridge=window.sciyueDesktop;if(!bridge?.commandOrbitals)throw Error('当前环境缺少波函数关闭接口，资源保留等待重试。');await bridge.commandOrbitals(id,{operation:'close'});releaseOrbitalSession(bridge,id);};
  const closeImportResource=(state:ImportCloseState,close:()=>void|Promise<void>,retry=false):Promise<void>=>{
    if(state.closed)return Promise.resolve();if(state.pending)return state.pending;if(state.error&&!retry)return Promise.reject(state.error);state.error=undefined;
    let operation:Promise<void>;try{operation=Promise.resolve(close());}catch(error){operation=Promise.reject(error);}
    state.pending=operation.then(()=>{state.closed=true;},error=>{state.error=error;throw error;}).finally(()=>{state.pending=undefined;});return state.pending;
  };
  const closeImportSession=(owner:ImportReadOwner,id:string,retry=false)=>{const state=owner.sessions.get(id);return state?closeImportResource(state,()=>closeNative(id),retry):closeNative(id);};
  const closeImportInput=(owner:ImportReadOwner,input:ResultInputFile,retry=false)=>{const state=owner.inputs.get(input);return state?closeImportResource(state,()=>input.close?.(),retry):Promise.resolve(input.close?.());};
  const closeImportExtra=(owner:ImportReadOwner,extra:PostprocessFileExtraSource,retry=false)=>{const state=owner.extras.get(extra);return state?closeImportResource(state,()=>extra.dispose(),retry):Promise.resolve(extra.dispose());};
  const finishReadOwner=(owner:ImportReadOwner)=>{
    if(!owner.settled||[...owner.inputs.values(),...owner.sessions.values(),...owner.extras.values()].some(state=>!state.closed))return;
    if(readOwnerRef.current===owner){readOwnerRef.current=null;busyRef.current=false;if(alive.current){setBusy(false);setReadState('idle');}}owner.finish();
  };
  const stopReadOwner=(owner:ImportReadOwner,reason:unknown=new DOMException('后处理来源读取已取消。','AbortError'),retry=false)=>{
    if(readOwnerRef.current===owner&&alive.current)setReadState('cancelling');
    if(!owner.transferred&&!owner.controller.signal.aborted)owner.controller.abort(reason);if(!owner.transferred)pendingRef.current?.resolve('cancel');
    const closing=[...owner.sessions.keys()].map(id=>closeImportSession(owner,id,retry));
    closing.push(...[...owner.inputs.keys()].map(input=>closeImportInput(owner,input,retry)));
    closing.push(...[...owner.extras.keys()].map(extra=>closeImportExtra(owner,extra,retry)));
    const stopped=Promise.allSettled(closing).then(outcomes=>{finishReadOwner(owner);const failures=outcomes.filter((value):value is PromiseRejectedResult=>value.status==='rejected');if(failures.length)throw new AggregateError(failures.map(value=>value.reason),'导入来源资源仍待实际关闭。');});void stopped.catch(()=>{});return stopped;
  };
  async function cancelRead(){const owner=readOwnerRef.current;if(!owner)return;await stopReadOwner(owner,undefined,true);await owner.done;}
  const releasesRef=useRef<ReturnType<typeof createPostprocessReleaseQueue>|null>(null);
  if(!releasesRef.current)releasesRef.current=createPostprocessReleaseQueue(closeNative);
  const releases=releasesRef.current;
  const dispose = (items: (PostprocessAttachment | undefined)[],id=fileOwnerRef.current??activeDocumentRef.current??'postprocess') => releases.releaseResources(id,{attachments:items});
  const retirementRef=useRef<ReturnType<typeof createPostprocessRetirement>|null>(null);
  if(!retirementRef.current)retirementRef.current=createPostprocessRetirement({
    read:()=>({documents:documentsRef.current,generated:generatedRef.current}),
    commit:next=>{documentsRef.current=next.documents;generatedRef.current=next.generated;setDocuments(next.documents);setGenerated(next.generated);},
    retire:id=>{closingIds.current.add(id);const owner=readOwnerRef.current;if(owner?.targets.has(id))void stopReadOwner(owner,new Error('分析来源已关闭、不可用或被替换，本次文件未覆盖它。'));},closeNative,
  });
  const retirement=retirementRef.current;
  const ask = (title: string, message: string, choices: Pending['choices']) => new Promise<string>(resolve => {
    const value = { title, message, choices, resolve: (answer: string) => { pendingRef.current = null; setPending(null); resolve(answer); } };
    pendingRef.current = value; setPending(value);
  });
  useEffect(() => {
    if (ownerId) { const value=documents[ownerId];setEngine(sourceEngine(value)); setTask(postprocessDocumentTask(value)); setStage('files');setNotice(sourceNotices.current[ownerId]??(value.output&&value.wavefunction&&!value.pair?'主输出和波函数保留为独立来源，未取得可靠配对；依赖可靠配对的分析暂不可用。':'')); }
    else setNotice('');
  }, [documents, ownerId]);
  useEffect(() => { alive.current = true; return () => {
    alive.current = false; requestEpoch.current++; pendingRef.current?.resolve('cancel');
    const owner=readOwnerRef.current;if(owner)void stopReadOwner(owner);
    for (const [id,value] of Object.entries(documentsRef.current)) void dispose([value.output, value.wavefunction,...(value.companions??[])],id).catch(() => {});
    for (const value of Object.values(generatedRef.current)) void dispose([value.document.output,value.document.wavefunction,...(value.document.companions??[])],value.ownerId).catch(()=>{});
    for(const value of [...Object.values(fileDocumentsRef.current),...pendingFileCloses.current.values()])void releases.releaseFile(value.id,value).catch(()=>{});
    void releases.retry().catch(()=>{});
    void retirement.releasePendingCloses().catch(()=>{});
  }; }, []);
  useEffect(()=>{const owner=readOwnerRef.current;if(!owner||owner.transferred||owner.controller.signal.aborted)return;try{owner.validate?.();}catch(error){void stopReadOwner(owner,error);}},[documents,generated,activeDocumentId,ports]);

  async function read(files: ScientificSourceFile[], targetId?: string | null, expectedEngine?: PostprocessEngine, mode:'smart'|'replace'='smart',newDocument?:{guard?():void;beforeCommit?(document:PostprocessDocument):Promise<void>;beforeFileCommit?(document:PostprocessScientificFileDocument):Promise<void>;onCreated?(id:string):void;canNavigate?():boolean;throwOnFailure?:boolean;signal?:AbortSignal;reuseParsedOutput?(file:ScientificSourceFile,input:ResultInputFile):PostprocessParsedResultsLease|null},replacementSlot?:{slotKey?:PostprocessSlotKey;sourceId?:string},automation?:{strictTargetId?:string;autoConfirmReplace?:boolean;throwOnFailure?:boolean;beforeCommit?(document:PostprocessDocument):Promise<void>|void;beforeFileCommit?(document:PostprocessScientificFileDocument):Promise<void>|void;onCommitted?(id:string):void}) {
    if (!files.length || busyRef.current) { if(newDocument?.throwOnFailure||automation?.throwOnFailure)throw Error(busyRef.current?'后处理正在读取其他来源，请稍后重试。':'没有可接入的完整来源。');return; }
    busyRef.current = true; setBusy(true);setReadState('reading'); setNotice(''); const epoch = ++requestEpoch.current;
    let finish!:()=>void;const done=new Promise<void>(resolve=>finish=resolve),owner:ImportReadOwner={controller:new AbortController(),inputs:new Map(),sessions:new Map(),extras:new Map(),targets:new Set(targetId?[targetId]:[]),settled:false,transferred:false,done,finish};readOwnerRef.current=owner;
    const signal=owner.controller.signal,externalAbort=()=>{void stopReadOwner(owner,newDocument?.signal?.reason);};newDocument?.signal?.addEventListener('abort',externalAbort,{once:true});if(newDocument?.signal?.aborted)externalAbort();
    const incoming: PostprocessAttachment[] = [];
    const fileIncoming:PostprocessScientificFileAttachment[]=[];
    const retainedFileExtras=new Set(Object.values(fileDocumentsRef.current).flatMap(document=>document.extraSources??[]));
    let pendingFileDocument:PostprocessScientificFileDocument|undefined;
    const initialSelectedFileId=fileOwnerRef.current,initialActiveDocumentId=activeDocumentRef.current;
    let fileBase=(targetId?fileDocumentsRef.current[targetId]:undefined)??(!targetId&&!newDocument?fileDocumentsRef.current[fileOwnerRef.current??'']:undefined);
    const initialFileBase=fileBase;
    const nebAuxiliaries:NebAuxiliarySource[]=[],mdAuxiliaries:MdAuxiliarySource[]=[],nebExtras:PostprocessSourceExtra[]=[],mdExtras:PostprocessSourceExtra[]=[];
    let nebDiagnosticsCommitted=false;
    const sourceReadWarnings: string[] = [];
    let readNotice='';const recordNotice=(next:string|((previous:string)=>string))=>{readNotice=typeof next==='function'?next(readNotice):next;};
    const diagnostics: ResultDiagnostic[] = []; let diagnosticsCommitted = false;
    let committed = false;
    let forceNew:{forceNew:true;onCreated(id:string):void}|undefined;
    const initialBase = targetId ? documentsRef.current[targetId] : undefined;
    let base = initialBase;
    // Registry view IDs and scientific document IDs are deliberately different.
    const snapshot = (id:string,value:PostprocessDocument) => {
      const output=value.output,wave=value.wavefunction,result=value.result,metadata=wave?.source.metadata,revision=metadata?.sourceRevision;
      const outputSource=output?.source,waveSource=wave?.source;
      const identity=()=>JSON.stringify([value.id,value.result.source.id,value.result.jobIndex,output?.source.result.source,output?.source.result.jobIndex,
        wave?.source.result.source,wave?.source.metadata?.sourceId,wave?.source.metadata?.sourceRevision]);
      const stamp=identity();
      return () => {if(closingIds.current.has(id)||!portsRef.current.exists(id)||portsRef.current.available?.(id)===false||documentsRef.current[id]!==value
        ||value.result!==result||value.output!==output||value.wavefunction!==wave||output?.source!==outputSource||wave?.source!==waveSource
        ||wave?.source.metadata!==metadata||metadata?.sourceRevision!==revision||identity()!==stamp)
        throw new Error('分析来源已关闭、不可用或被替换，本次文件未覆盖它。');};
    };
    const initialGuard=targetId&&initialBase?snapshot(targetId,initialBase):undefined;
    let selectedGuard:(()=>void)|undefined;
    const guard = () => { signal.throwIfAborted();newDocument?.guard?.();if (!alive.current || epoch !== requestEpoch.current) throw new Error('后处理来源读取已取消。');
      if(initialFileBase&&fileDocumentsRef.current[initialFileBase.id]!==initialFileBase)throw Error('文件来源已关闭或替换，本次读取未覆盖它。');
      if(!forceNew)initialGuard?.();selectedGuard?.(); };
    owner.validate=guard;
    try {
      if(automation?.strictTargetId&&!initialBase&&!initialFileBase){
        throw Object.assign(new Error(`Target document "${automation.strictTargetId}" does not contain an active Result Analysis output to pair onto.`),{code:'MCP_ANALYSIS_UNAVAILABLE'});
      }
      const preparation=newDocument?{forceNew:true as const,onCreated:(id:string)=>{newDocument.onCreated?.(id);if(newDocument.canNavigate?.()!==false){portsRef.current.activate(id);portsRef.current.analyze();}}}:(fileBase||automation?.strictTargetId)?undefined:await portsRef.current.prepareRead?.(targetId??activeDocumentId);
      if(preparation===null)return;
      if(preparation?.forceNew){forceNew=preparation;base=undefined;fileBase=undefined;targetId=null;owner.targets.clear();expectedEngine=undefined;mode='smart';}
      guard();
      for (const file of files) {
        guard(); const bridge = window.sciyueDesktop;
        const input = resultFile(file, bridge?.registerSelectedOutputSource && bridge.closeLaunchSource ? { register: selected => bridge.registerSelectedOutputSource!(selected), close: token => bridge.closeLaunchSource!(token), describe: token => bridge.describeLaunchSource!(token) } : undefined); let nativeSessionId: string | undefined;
        owner.inputs.set(input,{closed:false});
        try {
          const identity = await identifyPostprocessSource(input,{signal}); guard();
          if (identity.kind === 'gaussian-output' || identity.kind === 'orca-output') {
            const source=await readPostprocessFileOutput(input,{signal,reuseParsedResults:newDocument?.reuseParsedOutput?()=>{guard();return newDocument.reuseParsedOutput!(file,input);}:undefined});
            if(isScientificFileSource(source))fileIncoming.push(retainPostprocessFileSourceBytes({source},input));
            else incoming.push(retainPostprocessOutputSourceText({source},input));
          }
          else if(identity.kind==='xyz'||identity.kind==='hess')incoming.push(retainPostprocessSourceBytes({source:await readPostprocessAuxiliary(input,{signal})},input));
          else if(identity.kind==='neb-auxiliary'){
            const auxiliary=await readPostprocessNebAuxiliary(input,{signal});guard();if(!auxiliary)throw Error('NEB辅助来源内容身份已变化。');
            const extra=await snapshotPostprocessNebAuxiliary(auxiliary,{signal});guard();nebAuxiliaries.push(auxiliary);nebExtras.push(extra);continue;
          }
          else if (identity.kind === 'fchk' || identity.kind === 'molden') {
            const bridge = window.sciyueDesktop;
            if (!bridge?.openOrbitalSession) throw new Error('此运行环境缺少波函数读取后端，请使用本轮完整桌面包。OUT数值仍可独立查看。');
            nativeSessionId = `orbital-${crypto.randomUUID()}`;
            const sourceToken = await input.readCompanionSourceToken?.(signal); guard();
            if (!sourceToken) throw new Error('所选波函数没有可核对的受管来源，请重新从本机选择文件。');
            owner.sessions.set(nativeSessionId,{closed:false});
            const metadata = await bridge.openOrbitalSession({ sessionId: nativeSessionId, sourceId: input.id, name: file.name, sourceToken }); guard();
            const attachment = await retainPostprocessManagedSource({ source: await readPostprocessWavefunction(input, metadata,{signal}), nativeSessionId }, input,signal);
            incoming.push(attachment);guard();
            owner.sessions.get(nativeSessionId)!.adopted=true;
          } else if(identity.kind==='unsupported'){
            const auxiliary=await readMdAuxiliary(input,{signal});
            if(!auxiliary)throw new Error(identity.message ?? '未识别所选文件内容。');
            try{
              guard();const extra=await snapshotMdAuxiliary(auxiliary,signal);guard();
              mdAuxiliaries.push(auxiliary);mdExtras.push(extra);
            }catch(error){await auxiliary.diagnostic.dispose();throw error;}
            continue;
          } else throw new Error(identity.message ?? '请选择支持的OUT、XYZ、HESS、FCHK或Molden。');
          owner.inputs.get(input)!.adopted=true;
        } catch (error) { if (nativeSessionId&&owner.sessions.has(nativeSessionId)) await closeImportSession(owner,nativeSessionId).catch(() => {}); await closeImportInput(owner,input); guard(); if (error instanceof DOMException && error.name === 'AbortError') throw error; if (automation?.throwOnFailure) throw error; sourceReadWarnings.push(`${file.name}：${textError(error)}`); }
      }
      guard();
      if(fileIncoming.length||fileBase&&!incoming.some(item=>item.source.kind.endsWith('-output'))){
        if(fileIncoming.length>1)throw Error('多个独立主 OUT 需分别建立分析；已保留当前来源。');
        const replacingOutput=fileIncoming.length>0&&!!fileBase;
        const replacingWave=incoming.some(item=>['fchk','molden'].includes(item.source.kind))&&!!fileBase?.wavefunction;
        let useBase=fileBase;
        if(replacingOutput||replacingWave){
          const answer=automation?.autoConfirmReplace?'replace':await ask('文件槽已有来源','替换当前文件来源？其他原始来源保留；新建分析可保留原分析。',[{label:'替换当前文件',value:'replace'},{label:'新建分析',value:'new'},{label:'取消',value:'cancel'}]);guard();
          if(answer==='cancel')return;if(answer==='new')useBase=undefined;
        }
        let prepared=await preparePostprocessFileIncoming([...fileIncoming,...incoming],useBase??base,guard,{nebAuxiliaries,mdAuxiliaries,signal});guard();
        if(automation?.strictTargetId){
          if(incoming.some(item=>['fchk','molden'].includes(item.source.kind))&&(!prepared.wavefunction||prepared.sourceWarnings.length>0)){
            throw Object.assign(new Error(prepared.sourceWarnings.map(w=>w.message).join('；')||'波函数未能与当前文件分析来源可靠配对。'),{code:'MCP_WAVEFUNCTION_UNPAIRED'});
          }
          if(incoming.some(item=>['xyz','hess'].includes(item.source.kind))&&prepared.sourceWarnings.length>0){
            throw Object.assign(new Error(prepared.sourceWarnings.map(w=>w.message).join('；')||'配套文件未能与当前文件分析来源可靠配对。'),{code:'MCP_FILE_IMPORT_FAILED'});
          }
        }
        if(mode==='replace'&&useBase&&!fileIncoming.length){
          const role=(item:PostprocessAttachment)=>item.role??item.source.result.scientific?.ircEvidence?.role??(item.source.kind==='hess'?'hess':item.source.result.role);
          const ids=new Set(incoming.map(item=>item.source.result.source.id));
          const verified=prepared.companions.filter(item=>ids.has(item.source.result.source.id)&&!prepared.sourceWarnings.some(warning=>warning.sourceId===item.source.result.source.id)&&Boolean(role(item))&&role(item)!=='unknown');
          const targets=(useBase.companions??[]).filter(item=>replacementSlot?.sourceId?item.source.result.source.id===replacementSlot.sourceId:verified.length===1&&role(item)===role(verified[0]));
          if(verified.length===1&&targets.length===1&&role(verified[0])===role(targets[0])&&(!replacementSlot?.slotKey||role(verified[0])===replacementSlot.slotKey)){
            const answer=automation?.autoConfirmReplace?'replace':await ask('配套文件槽已有来源','新文件已取得相同任务角色的科学配对，替换已选择的配套来源？',[{label:'替换配套来源',value:'replace'},{label:'取消',value:'cancel'}]);guard();if(answer!=='replace')return;
            const companions=prepared.companions.filter(item=>item.source.result.source.id!==targets[0].source.result.source.id);
            prepared=await preparePostprocessFileIncoming([],{...useBase,companions},guard,{nebAuxiliaries,mdAuxiliaries,signal});guard();
          }
        }
        if(!prepared.output||!isScientificFileSource(prepared.output.source))throw Error('文件来源未得到可靠主 OUT，当前分析保留。');
        const value=composePostprocessFileDocument(useBase?.id??`analysis-file-${crypto.randomUUID()}`,prepared.output,prepared.wavefunction,prepared) as PostprocessScientificFileDocument;
        if(mdExtras.length)value.extraSources=[...value.extraSources??[],...mdExtras.map(extra=>({...extra,dispose(){}}))];
        pendingFileDocument=value;
        await newDocument?.beforeFileCommit?.(value);await automation?.beforeFileCommit?.(value);guard();
        fileDocumentsRef.current={...fileDocumentsRef.current,[value.id]:value};setFileDocuments(fileDocumentsRef.current);
        // Source-specific restrictions are shown once beside their own slot.
        sourceNotices.current[value.id]=sourceReadWarnings.join('；');
        committed=true;owner.transferred=true;
        for(const [input,state]of owner.inputs)if(state.adopted||state.closed)owner.inputs.delete(input);for(const [id,state]of owner.sessions)if(state.adopted||state.closed)owner.sessions.delete(id);owner.targets.clear();
        const canNavigate=newDocument?newDocument.canNavigate?.()!==false:fileOwnerRef.current===initialSelectedFileId&&activeDocumentRef.current===initialActiveDocumentId;
        if(canNavigate){selectFile(value.id);portsRef.current.onFileDocument?.(value);portsRef.current.analyze();}
        newDocument?.onCreated?.(value.id);automation?.onCommitted?.(value.id);
        if(useBase){
          const retained=new Set([value.output.source,...value.companions?.map(item=>item.source)??[],value.wavefunction?.source]);
          const retainedIds=new Set(value.companions?.map(item=>item.source.result.source.id));
          const outgoing=[useBase.wavefunction,...useBase.companions??[]].filter((item):item is PostprocessAttachment=>!!item&&!retained.has(item.source)&&!retainedIds.has(item.source.result.source.id));
          const issues=await releases.releaseResources(value.id,{attachments:outgoing,fileSources:!retained.has(useBase.output.source)?[useBase.output.source]:[]});if(issues.length)portsRef.current.onError(`新文件已接入；旧来源释放提示：${issues.join('；')}`);
        }
        return;
      }
      const auxiliaryOnly=(nebAuxiliaries.length>0||mdAuxiliaries.length>0)&&!incoming.length&&!!base?.output;
      const mdAuxiliaryOnly=auxiliaryOnly&&mdAuxiliaries.length>0;
      const auxiliaryDiagnostics=[...nebAuxiliaries,...mdAuxiliaries].map(source=>source.diagnostic);
      if(!incoming.length&&!auxiliaryOnly)diagnostics.push(...auxiliaryDiagnostics);
      if(!incoming.length&&diagnostics.length&&!auxiliaryOnly){if(!portsRef.current.onDiagnostics)throw new Error('当前入口无法接管文件级诊断。');portsRef.current.onDiagnostics(diagnostics);diagnosticsCommitted=true;nebDiagnosticsCommitted=auxiliaryDiagnostics.length>0;for(const input of owner.inputs.keys())if(auxiliaryDiagnostics.some(source=>source.source.id===input.id))owner.inputs.delete(input);return;}
      if (!incoming.length&&!auxiliaryOnly) throw Error(sourceReadWarnings.join('；') || '没有可用的完整来源。');
      // Reuse only already-selected retained extra bytes, never discover a path
      // mentioned by OUT. New same-name versions remain separate candidates.
      if(base?.output?.source.nebOutputContext)for(const extra of postprocessSourceExtras(base)){
        if(!['orca-neb-log','neb-interpolation'].includes(extra.format)||nebExtras.some(selected=>selected.name===extra.name&&selected.revision===extra.revision))continue;
        const file:ResultInputFile={id:extra.sourceId,name:extra.name,size:extra.byteSize,readRange:extra.readRange,stream(){let offset=0;return new ReadableStream<Uint8Array>({async pull(controller){try{if(offset===extra.byteSize){controller.close();return;}const end=Math.min(extra.byteSize,offset+1024**2),bytes=await extra.readRange(offset,end,signal);offset=end;controller.enqueue(bytes);}catch(error){controller.error(error);}}});}};
        const source=await readPostprocessNebAuxiliary(file,{signal});guard();if(source){if(source.data.source.sha256!==extra.revision)throw Error('已保留NEB辅助原始来源版本不一致。');nebAuxiliaries.push(source);}
      }
      let retainedExtras=base?postprocessSourceExtras(base):[];
      const replacedExtra=mode==='replace'&&replacementSlot?.slotKey==='md-log'&&mdExtras.length===1
        ?retainedExtras.find(extra=>extra.sourceId===replacementSlot.sourceId&&extra.format===mdExtras[0].format):undefined;
      if(replacedExtra){
        const answer=automation?.autoConfirmReplace?'replace':await ask('配套文件槽已有来源','替换选中的 MD 辅助原始文件？新文件仍须核对其实际作业和单位。',[{label:'替换配套来源',value:'replace'},{label:'取消',value:'cancel'}]);
        guard();if(answer!=='replace')return;
        retainedExtras=retainedExtras.filter(extra=>extra!==replacedExtra);
      }
      const needsMdRebind=mdExtras.length>0||incoming.some(item=>item.source.kind==='xyz'||item.source.kind==='orca-output');
      for(const extra of needsMdRebind?retainedExtras.filter(isMdExtra):[]){
        if(mdExtras.some(selected=>selected.name===extra.name&&selected.revision===extra.revision))continue;
        const source=await readMdAuxiliary(extraInput(extra,signal),{signal});
        if(source)mdAuxiliaries.push(source);guard();
        if(!source||source.sha256!==extra.revision)throw Error('已保留MD辅助原始来源版本不一致。');
      }
      const policyIncoming=auxiliaryOnly&&!mdAuxiliaryOnly?[...(base?.companions??[])]:incoming;
      const {output,enrichedOutput,wavefunction,companions,sourceWarnings}=await preparePostprocessIncoming(policyIncoming,base,guard,{nebAuxiliaries,mdAuxiliaries:needsMdRebind?mdAuxiliaries:undefined,signal});guard();
      recordNotice([...sourceReadWarnings, ...sourceWarnings.map(item => item.message)].join('；'));
      const actualEngine = output ? postprocessDestination(output.source).engine : wavefunction?.source.kind==='fchk'?'gaussian':wavefunction?.source.software??'unknown';
      const destination = output ? postprocessDestination(output.source) : null;
      if (destination && !isUnifiedPostprocessSource(output!.source)) throw new Error(`识别为 ${describePostprocessSource(output!.source)}；此任务尚未接入当前统一工作区。`);
      let matching=await matchingImportTargetForFrames(base,output,wavefunction);guard();
      let useTarget = base && (mode==='replace'||matching.reuse||(companions.length>0||auxiliaryOnly)&&!output) ? targetId! : null;
      const ordinary=incoming.length>0&&incoming.every(row=>['gaussian-output','orca-output','fchk','molden'].includes(row.source.kind));
      if(!forceNew&&!automation?.strictTargetId&&mode==='smart'&&ordinary&&Boolean(output)!==Boolean(wavefunction)){
        const candidates=Object.entries(documentsRef.current).filter(([id])=>!closingIds.current.has(id)&&portsRef.current.exists(id)&&portsRef.current.available?.(id)!==false);
        const checks=new Map(candidates.map(([id,value])=>[id,snapshot(id,value)]));
        const ids=new Map<string,typeof candidates>();
        for(const entry of candidates)ids.set(entry[1].id,[...(ids.get(entry[1].id)??[]),entry]);
        // An aliased/duplicated document identity cannot be picked by order.
        const unique=candidates.filter(([,value])=>ids.get(value.id)?.length===1);
        const resolved=await resolvePostprocessImportTarget(unique.map(([,value])=>value),output,wavefunction,initialBase?.id);guard();
        for(const check of checks.values())check();
        let chosen=resolved.targetId;
        const reasons=resolved.reasons.map(reason=>reason.message).filter((message,index,all)=>all.indexOf(message)===index).join('；');
        if(reasons)recordNotice(previous=>`${previous}；${reasons}`);
        if(resolved.status==='ambiguous'){
          const answer=await ask('选择配对分析',`多个已加载分析与此来源可靠匹配，请选择接入对象。${reasons?` ${reasons}`:''}`,[
            ...resolved.candidateIds.map(id=>({label:`接入 ${ids.get(id)![0][1].result.label}（${id}）`,value:`target:${id}`})),
            {label:'新建分析',value:'new'},{label:'取消',value:'cancel'}]);guard();
          if(answer==='cancel')return;
          chosen=answer.startsWith('target:')?answer.slice(7):undefined;
        }
        useTarget=null;base=undefined;
        if(chosen){
          const entries=ids.get(chosen);if(entries?.length!==1)throw new Error('分析来源身份不唯一，未自动接入。');
          const [key,value]=entries[0];selectedGuard=checks.get(key);owner.targets.add(key);guard();base=value;useTarget=key;
          matching=await matchingImportTargetForFrames(base,output,wavefunction);guard();
          if(!matching.reuse)throw new Error(matching.reason?.message??'所选来源已不能可靠配对。');
        }
      }
      if(automation?.strictTargetId){
        if(!base)throw Object.assign(new Error(`Analysis document not found: ${automation.strictTargetId}`),{code:'MCP_ANALYSIS_UNAVAILABLE'});
        if(wavefunction&&!output){
          if(!base.output)throw Object.assign(new Error('目标分析页缺少主输出文件，无法挂载波函数。'),{code:'MCP_FILE_IMPORT_FAILED'});
          let strictPair;
          try{
            strictPair=await pairPostprocessSourcesForFrames(base.output.source,wavefunction.source,{signal});guard();
          }catch(error){
            throw Object.assign(new Error(textError(error)),{code:'MCP_WAVEFUNCTION_UNPAIRED'});
          }
          const conflict=postprocessMetadataConflict(strictPair);
          if(conflict||strictPair.conflicts.length||strictPair.frameIndex===undefined){
            throw Object.assign(new Error(conflict??'波函数与目标输出文档电子态或几何不一致，拒绝配对。'),{code:'MCP_WAVEFUNCTION_UNPAIRED'});
          }
          matching={reuse:true,pair:strictPair};
        }else if(output&&!wavefunction&&base.wavefunction){
          let strictPair;
          try{
            strictPair=await pairPostprocessSourcesForFrames((enrichedOutput??output).source,base.wavefunction.source,{signal});guard();
          }catch(error){
            throw Object.assign(new Error(textError(error)),{code:'MCP_WAVEFUNCTION_UNPAIRED'});
          }
          const conflict=postprocessMetadataConflict(strictPair);
          if(conflict||strictPair.conflicts.length){
            throw Object.assign(new Error(conflict??'新输出与已挂载波函数不一致，拒绝替换。'),{code:'MCP_WAVEFUNCTION_UNPAIRED'});
          }
          matching={reuse:true,pair:strictPair};
        }else if(!output&&!wavefunction){
          if(!base.output||(!companions.length&&!auxiliaryOnly)||sourceWarnings.length>0){
            throw Object.assign(new Error(sourceWarnings.map(w=>w.message).join('；')||readNotice||'配套来源未能与目标输出文档可靠配对。'),{code:'MCP_FILE_IMPORT_FAILED'});
          }
        }
        useTarget=automation.strictTargetId;
      }
      const companionOnly=companions.length>0&&!output;
      const occupiedCompanion=companions.some(next=>base?.companions?.some(old=>old.source.result.role===next.source.result.role));
      // Unknown Molden may use the counterpart's pairing proof, never a renamed
      // producer. Explicitly conflicting producer metadata still fails pairing.
      let counterpartProof=false,counterpartReason:string|undefined;
      if(mode==='replace'&&base&&(output||wavefunction)){
        const counterpart={...base,...(output?{output:undefined}:{wavefunction:undefined})};
        const proof=await matchingImportTargetForFrames(counterpart,output,wavefunction);guard();
        counterpartProof=proof.reuse;counterpartReason=proof.reason?.message;
      }
      const unknownMoldenPair=counterpartProof&&(actualEngine==='unknown'&&wavefunction?.source.kind==='molden'
        ||expectedEngine==='unknown'&&base?.wavefunction?.source.kind==='molden'&&(!base.wavefunction.source.software||base.wavefunction.source.software==='unknown'));
      if (!mdAuxiliaryOnly && mode==='replace' && expectedEngine && actualEngine !== expectedEngine && !unknownMoldenPair) {
        const name=actualEngine==='gaussian'?'Gaussian':actualEngine==='orca'?'ORCA':actualEngine==='cp2k'?'CP2K':'生产软件未确认的Molden';
        if(automation?.strictTargetId)throw Object.assign(new Error(counterpartReason??`识别为 ${name} 来源，与当前页软件不一致。`),{code:'MCP_FILE_IMPORT_FAILED'});
        const answer = await ask('来源软件与当前页不同', `识别为 ${name} 来源。${counterpartReason??'与当前页软件不一致。'}原分析保持不变。`, [{ label: '新建对应分析', value: 'new' }, { label: '取消', value: 'cancel' }]); guard();
        if (answer !== 'new') return; useTarget = null;
      }
      if(!mdAuxiliaryOnly&&companionOnly&&(mode==='replace'&&base?.companions?.length||occupiedCompanion)){
        const answer=automation?.autoConfirmReplace?'replace':await ask('配套文件槽已有来源','替换已选择的配套来源？其他来源及原始文件保留。',[{label:'替换配套来源',value:'replace'},{label:'取消',value:'cancel'}]);guard();
        if(answer!=='replace')return;
      }
      if (mode==='replace' && useTarget && base && (output && base.output || wavefunction && base.wavefunction)) {
        const answer = automation?.autoConfirmReplace ? 'replace' : await ask('文件槽已有来源', '替换会释放被替换波函数的本次内存缓存；已打开图窗仍保留其来源快照。', [{ label: '替换当前文件', value: 'replace' }, { label: '新建分析', value: 'new' }, { label: '取消', value: 'cancel' }]); guard();
        if (answer === 'cancel') return; if (answer === 'new') useTarget = null;
      }
      if(companionOnly&&!useTarget)throw new Error('这些配套来源已与当前主OUT核对；独立新建时请一同提供主OUT，当前分析未改变。');
      let nextOutput = enrichedOutput??output ?? (useTarget ? base?.output : undefined), nextWave = wavefunction ?? (useTarget ? base?.wavefunction : undefined);
      let nextCompanions:readonly PostprocessAttachment[]=useTarget
        ?[...(base?.companions??[]).filter(old=>!companions.some(next=>next.source.result.role===old.source.result.role)),...companions]:companions;
      // A new OUT replaces only its own slot. Revalidate retained auxiliary
      // slots against it before committing; a failure leaves the old document intact.
      if(useTarget&&output&&nextCompanions.length){
        const retained=await preparePostprocessIncoming([output,...nextCompanions],undefined,guard,{nebAuxiliaries,mdAuxiliaries,signal});guard();
        nextOutput=retained.enrichedOutput??output;nextCompanions=retained.companions;
        if(retained.sourceWarnings.length)recordNotice(previous=>[previous,...retained.sourceWarnings.map(item=>item.message)].filter(Boolean).join('；'));
      }
      let pair=!enrichedOutput&&useTarget&&matching.reuse?matching.pair:undefined;
      if(nextOutput&&nextWave&&!pair){
        try{pair=await pairPostprocessSourcesForFrames(nextOutput.source,nextWave.source,{signal});guard();
          const conflict=postprocessMetadataConflict(pair);if(conflict)throw new Error(conflict);
        }catch(error){
          guard(); if(error instanceof DOMException&&error.name==='AbortError')throw error;
          if(automation?.strictTargetId)throw Object.assign(new Error(textError(error)),{code:'MCP_WAVEFUNCTION_UNPAIRED'});
          pair=undefined; recordNotice(previous=>[previous,`${textError(error)} 波函数保留为独立来源，依赖可靠配对的分析暂不可用。`].filter(Boolean).join('；'));
        }
      }
      if(pair?.conflicts.length){
        if(automation?.strictTargetId)throw Object.assign(new Error('几何身份已核对，但打印数值存在电子态冲突，拒绝自动配对。'),{code:'MCP_WAVEFUNCTION_UNPAIRED'});
        recordNotice(previous=>`${previous}；几何身份已核对，${pair.conflicts.length}项打印数值不一致；两槽及各自数值保留，依赖一致电子态的分析不可用。`);
      }
      if(wavefunction?.nativeSessionId)await portsRef.current.reserveViews?.(wavefunction.nativeSessionId,useTarget);
      guard();
      const displayedResult=await defaultPostprocessCompanion(nextOutput,nextCompanions);guard();
      const value = composePostprocessDocument(useTarget ? base!.id : `analysis-${crypto.randomUUID()}`, nextOutput, nextWave, pair,{companions:nextCompanions,displayedResult});
      const extras=[...(useTarget?retainedExtras:[]),...nebExtras,...mdExtras];if(extras.length)retainPostprocessSourceExtras(value,extras.filter((extra,index)=>extras.findIndex(other=>other.sourceId===extra.sourceId&&other.revision===extra.revision)===index));
      const structure = await readInitialPostprocessStructure(value,signal); guard();
      await newDocument?.beforeCommit?.(value);await automation?.beforeCommit?.(value);guard();
      const canNavigate=newDocument?newDocument.canNavigate?.()!==false:fileOwnerRef.current===initialSelectedFileId&&activeDocumentRef.current===initialActiveDocumentId;
      const documentId = useTarget ?? portsRef.current.add(value.result, value, { structure,...(!canNavigate||forceNew?{activate:false}:{}),...(forceNew?{initialModule:'analysis' as const}:{}) });
      if (useTarget) portsRef.current.replace(documentId, value.result, value, structure);
      if(canNavigate)selectFile(null);
      const priorAssociation=useTarget&&base?getPostprocessTaskAssociation(base):undefined;
      if(priorAssociation)setPostprocessTaskAssociation(value,priorAssociation);
      sourceNotices.current[documentId]=readNotice;
      documentsRef.current = { ...documentsRef.current, [documentId]: value }; setDocuments(documentsRef.current);
      if(canNavigate){setEngine(sourceEngine(value));setTask(postprocessDocumentTask(value));setStage('files');setNotice(readNotice);}committed = true;owner.transferred=true;for(const [input,state]of owner.inputs)if(state.adopted||state.closed)owner.inputs.delete(input);for(const [id,state]of owner.sessions)if(state.adopted||state.closed)owner.sessions.delete(id);owner.targets.clear();
      if(diagnostics.length){portsRef.current.onDiagnostics?.(diagnostics);diagnosticsCommitted=Boolean(portsRef.current.onDiagnostics);}
      if(forceNew)forceNew.onCreated(documentId);else if(canNavigate){portsRef.current.activate(documentId);portsRef.current.analyze();}
      automation?.onCommitted?.(documentId);
      if (useTarget && base) {const retained=new Set(nextCompanions.map(value=>value.source.result.source.id));const issues=await dispose([output ? base.output : undefined, wavefunction ? base.wavefunction : undefined,...(base.companions??[]).filter(value=>!retained.has(value.source.result.source.id))],useTarget);if(issues.length)portsRef.current.onError(`新来源已接入；旧来源释放提示：${issues.join('；')}`);}
    } catch (error) { if(newDocument?.throwOnFailure||automation?.throwOnFailure)throw error;if (alive.current) portsRef.current.onError(textError(error)); }
    finally {
      newDocument?.signal?.removeEventListener('abort',externalAbort);
      if(!committed)for(const extra of pendingFileDocument?.extraSources??[])if(!retainedFileExtras.has(extra)&&!owner.extras.has(extra))owner.extras.set(extra,{closed:false});
      try{
        if(!diagnosticsCommitted)await Promise.all(diagnostics.map(item=>Promise.resolve(item.dispose())));
        if(!nebDiagnosticsCommitted)await Promise.all([...nebAuxiliaries,...mdAuxiliaries].map(source=>source.diagnostic.dispose()));
        if(!committed){const issues=await disposePostprocessAttachments(incoming,id=>closeImportSession(owner,id));if(issues.length&&alive.current)portsRef.current.onError(`未接入的临时来源释放仍待确认：${issues.join('；')}`);}
        if(!committed)await Promise.all(fileIncoming.map(item=>item.source.dispose()));
      }finally{
        const outcomes=await Promise.allSettled([...owner.sessions.keys()].map(id=>closeImportSession(owner,id)).concat([...owner.inputs.keys()].map(input=>closeImportInput(owner,input)),[...owner.extras.keys()].map(extra=>closeImportExtra(owner,extra))));owner.settled=true;finishReadOwner(owner);
        const failed=outcomes.filter((value):value is PromiseRejectedResult=>value.status==='rejected');if(failed.length&&alive.current){setReadState('cancelling');portsRef.current.onError(`导入来源资源仍待实际关闭：${failed.map(value=>textError(value.reason)).join('；')}`);}
      }
    }
  }
  function prepareClose(id:string){
    const transaction=retirement.prepareClose(id),owner=readOwnerRef.current;
    const pendingOwner=owner&&!owner.transferred&&owner.targets.has(id)?owner:null;let committed=false;
    return{...transaction,commit(){transaction.commit();committed=true;},async release(){const released=transaction.release();if(!committed)return released;const stopped=pendingOwner?stopReadOwner(pendingOwner,new Error('分析来源已关闭、不可用或被替换，本次文件未覆盖它。')):Promise.resolve();await Promise.all([released,stopped,releases.retry(id)]);}};
  }
  async function close(id: string) {
    const transaction=prepareClose(id);transaction.commit();
    try{await transaction.release();return [];}catch(error){return(error as {issues?:string[]}).issues??[textError(error)];}
  }
  async function addGeneratedXtb(bundle: XtbElectronicArtifactBundle, expected: GeneratedXtbExpected, target?:{id:string;guard():void}, archived?: GeneratedXtbSourcePackage, options?:{guard?():void;throwOnFailure?:boolean;beforeCommit?(document:PostprocessDocument):Promise<void>;onCreated?(id:string):void}): Promise<string | null> {
    options?.guard?.();
    const existing = !archived && [...Object.entries(documentsRef.current),...Object.entries(generatedRef.current).map(([key,row])=>[key,row.document] as const)].find(([, value]) => value.wavefunction?.source.generatedXtb?.artifactId === bundle.artifactId);
    if (existing) {
      try {
        // A repeated host response is a new identity boundary, not permission to
        // bind a prior gas/solvent source to changed launching conditions.
        await validateGeneratedXtbBundle(structuredClone(bundle), structuredClone(expected));
        const owned=generatedRef.current[existing[0]],owner=owned?.ownerId??existing[0];
        target?.guard();
        if (!alive.current || closingIds.current.has(owner) || (owned?.document??documentsRef.current[existing[0]]) !== existing[1] || !portsRef.current.exists(owner)||target&&target.id!==owner) throw new Error('已接入GFN2来源已关闭或替换。');
      } catch (error) { if (alive.current) portsRef.current.onError(textError(error)); return null; }
      const provenance = existing[1].wavefunction!.source.generatedXtb!;
      const keys = ['documentId','revision','graphFingerprint','coordinatesFingerprint','constraintsFingerprint'] as const;
      if (provenance.sessionId !== bundle.sessionId || provenance.sessionId !== expected.sessionId
        || keys.some(key => provenance.stamp[key] !== bundle.stamp?.[key] || provenance.stamp[key] !== expected.request.stamp[key])
        || JSON.stringify(provenance.runIdentity) !== JSON.stringify(bundle.runIdentity)
        || expected.taskId !== undefined && (provenance.runIdentity?.taskId !== expected.taskId || provenance.runIdentity?.runId !== expected.runId)) {
        portsRef.current.onError('已接入GFN2产物的来源身份不能重新绑定。'); return null;
      }
      return existing[0];
    }
    if (busyRef.current) { const message='后处理正在读取其他来源，请稍后接入已保存的GFN2结果。';if(options?.throwOnFailure)throw Error(message);portsRef.current.onError(message); return null; }
    const bridge = window.sciyueDesktop;
    if (!bridge || (!archived && !bridge.openXtbOrbitalSession) || (archived && !bridge.openOrbitalSession)) { const message='此运行环境缺少受管GFN2波函数接入后端，原生产物已保留。';if(options?.throwOnFailure)throw Error(message);portsRef.current.onError(message); return null; }
    const epoch = ++requestEpoch.current, nativeSessionId = `orbital-${crypto.randomUUID()}`;
    busyRef.current = true; setBusy(true);
    let attachment: PostprocessAttachment | undefined, opened = false, committed = false;
    const guard = () => { options?.guard?.();if (!alive.current || epoch !== requestEpoch.current||target&&(closingIds.current.has(target.id)||!portsRef.current.exists(target.id))) throw new Error('GFN2结果接入已取消，原生产物仍保留。');target?.guard(); };
    try {
      guard();
      attachment = await readGeneratedXtbSource(bundle, expected, nativeSessionId, async (artifactId, sessionId) => { guard(); opened = true;
        const metadata = archived ? await bridge.openOrbitalSession!({ sessionId, sourceId: `xtb-${artifactId}:molden`, name: bundle.files.find(file => file.role === 'molden')!.name, text: bundle.files.find(file => file.role === 'molden')!.text }) : await bridge.openXtbOrbitalSession!(artifactId, sessionId); guard();
        return archived?.analysisPolicy ? { ...metadata, analysisPolicy: archived.analysisPolicy } : metadata;
      }); guard();
      await portsRef.current.reserveViews?.(nativeSessionId, target?.id??null); guard();
      const value = composePostprocessDocument(`analysis-${crypto.randomUUID()}`, undefined, attachment);
      await options?.beforeCommit?.(value);guard();
      if(target){
        if(!portsRef.current.attach)throw Error('当前工作区缺少原位分析绑定入口。');
        const bindingId=portsRef.current.attach(target.id,value.result,value.id);guard();
        const id=value.id;
        generatedRef.current={...generatedRef.current,[id]:{document:value,ownerId:target.id,bindingId}};setGenerated(generatedRef.current);committed=true;
        return id;
      }
      const structure = await readInitialPostprocessStructure(value); guard();
      const id = portsRef.current.add(value.result, value, { activate: false, structure });
      documentsRef.current = { ...documentsRef.current, [id]: value }; setDocuments(documentsRef.current); committed = true;
      options?.onCreated?.(id);
      return id;
    } catch (error) { if(options?.throwOnFailure)throw error;if (alive.current) portsRef.current.onError(textError(error)); return null; }
    finally {
      if (!committed) {
        if (attachment) await dispose([attachment]);
        else if (opened) await closeNative(nativeSessionId).catch(() => {});
      }
      if (alive.current && epoch === requestEpoch.current) setBusy(false);
      busyRef.current = false;
    }
  }
  async function remove(role: 'output' | 'wavefunction'|'companions',slotKey?:PostprocessSlotKey,sourceId?:string) {
    if(isExcitationSlot(slotKey)){await readExcitationFiles([],slotKey);return;}
    if(fileOwnerRef.current){await removeFileSlot(role,slotKey,sourceId);return;}
    const id = ownerId, value = id ? documentsRef.current[id] : undefined; if (!id || !value || busyRef.current) return;
    try{portsRef.current.guardRemove?.(id);}catch(error){portsRef.current.onError(textError(error));return;}
    const extras=postprocessSourceExtras(value),outgoingExtras=role==='companions'?extras.filter(item=>!sourceId||item.sourceId===sourceId):[];
    const outgoing = role==='companions'?(value.companions??[]).filter(item=>!sourceId||item.source.result.source.id===sourceId):value[role]?[value[role]]:[]; if (!outgoing.length&&!outgoingExtras.length) return;
    const output = role === 'output' ? undefined : role==='companions'?unaugmentedPostprocessOutput(value.output):value.output, wavefunction = role === 'wavefunction' ? undefined : value.wavefunction;
    if (!output && !wavefunction) { portsRef.current.onError('这是此分析的最后一个来源；请关闭结果标签释放它，或选择替换文件。'); return; }
    setBusy(true); busyRef.current = true;
    const temporaryAuxiliaries:NebAuxiliarySource[]=[],temporaryMdAuxiliaries:MdAuxiliarySource[]=[];
    try {
      if(closingIds.current.has(id)||documentsRef.current[id]!==value||!portsRef.current.exists(id))throw new Error('分析来源已关闭，未重新接入被移除的文件。');
      let companions=role==='output'?[]:role==='companions'?(value.companions??[]).filter(item=>!outgoing.includes(item)):value.companions??[];
      const remainingExtras=role==='output'?[]:extras.filter(item=>!outgoingExtras.includes(item));
      let preparedOutput=output;
      const guard=()=>{if(!alive.current||closingIds.current.has(id)||documentsRef.current[id]!==value||!portsRef.current.exists(id))throw Error('分析来源已关闭或替换，未重放移除操作。');};
      if(role==='companions'&&output){
        for(const extra of remainingExtras){
          if(isMdExtra(extra)){
            const auxiliary=await readMdAuxiliary(extraInput(extra));if(auxiliary)temporaryMdAuxiliaries.push(auxiliary);guard();
            if(!auxiliary||auxiliary.sha256!==extra.revision)throw Error('已保留MD辅助原始来源版本不一致。');
            continue;
          }
          if(!['orca-neb-log','neb-interpolation'].includes(extra.format))continue;
          const input:ResultInputFile={id:extra.sourceId,name:extra.name,size:extra.byteSize,readRange:extra.readRange,stream(){let offset=0;return new ReadableStream<Uint8Array>({async pull(controller){try{if(offset===extra.byteSize){controller.close();return;}const end=Math.min(extra.byteSize,offset+1024**2),bytes=await extra.readRange(offset,end);offset=end;controller.enqueue(bytes);}catch(error){controller.error(error);}}});}};
          const auxiliary=await readPostprocessNebAuxiliary(input);guard();if(auxiliary)temporaryAuxiliaries.push(auxiliary);
        }
        const originals=companions.map(item=>projectPostprocessAttachment(item,item.source.results[0]??item.source.result,item.source.results));
        const prepared=await preparePostprocessIncoming(originals,{...value,output:unaugmentedPostprocessOutput(output),companions:originals},guard,{nebAuxiliaries:temporaryAuxiliaries,mdAuxiliaries:temporaryMdAuxiliaries});guard();
        preparedOutput=prepared.enrichedOutput??output;companions=prepared.companions;
      }
      const displayedResult=await defaultPostprocessCompanion(preparedOutput,companions);
      if(closingIds.current.has(id)||documentsRef.current[id]!==value||!portsRef.current.exists(id))throw new Error('分析来源已关闭或切换，未重放移除操作。');
      let pair;
      if(preparedOutput&&wavefunction){try{pair=await pairPostprocessSourcesForFrames(preparedOutput.source,wavefunction.source);guard();const conflict=postprocessMetadataConflict(pair);if(conflict)throw Error(conflict);}catch(error){guard();pair=undefined;setNotice(`${textError(error)} 波函数仍保留为独立来源。`);}}
      const next = composePostprocessDocument(value.id, preparedOutput, wavefunction,pair,{companions,displayedResult});
      if(remainingExtras.length)retainPostprocessSourceExtras(next,[...remainingExtras]);
      const structure = await readInitialPostprocessStructure(next);
      if(!alive.current||closingIds.current.has(id)||documentsRef.current[id]!==value||!portsRef.current.exists(id)||portsRef.current.available?.(id)===false)throw new Error('分析来源已关闭或切换，未重放移除操作。');
      // Register outgoing leases with the retry owner only after the metadata
      // replacement has committed successfully.
      {
        portsRef.current.replace(id, next.result, next, structure); documentsRef.current = { ...documentsRef.current, [id]: next }; setDocuments(documentsRef.current);
      }
      const issues=await dispose([...outgoing,...(role==='output'?value.companions??[]:[])],id);
      if(issues.length)portsRef.current.onError(`来源已移除；native释放提示：${issues.join('；')}`);
    } catch (error) { portsRef.current.onError(textError(error)); }
    finally { await Promise.allSettled([...temporaryAuxiliaries,...temporaryMdAuxiliaries].map(item=>item.diagnostic.dispose()));setBusy(false); busyRef.current = false; }
  }
  async function readExcitationFiles(files:ScientificSourceFile[],slotKey:ExcitationSlotKey,targetId?:string|null){
    const id=targetId??ownerId,before=id?documentsRef.current[id]:undefined;
    if(busyRef.current)return;
    if(!id||!before?.output||before.output.source.kind!=='orca-output'||!before.output.source.tasks.includes('td')){portsRef.current.onError('请先读取可关联波函数的 ORCA TD 主 OUT；已有跃迁数据保持可读。');return;}
    if(files.length>1){portsRef.current.onError('每个振幅角色请选择一个原始候选文件；未按导入顺序覆盖。');return;}
    try{portsRef.current.guardRemove?.(id);}catch(error){portsRef.current.onError(textError(error));return;}
    busyRef.current=true;setBusy(true);setReadState('reading');
    const epoch=++requestEpoch.current;let finish!:()=>void;const done=new Promise<void>(resolve=>finish=resolve);
    const owner:ImportReadOwner={controller:new AbortController(),inputs:new Map(),sessions:new Map(),extras:new Map(),targets:new Set([id]),settled:false,transferred:false,done,finish};readOwnerRef.current=owner;
    const guard=()=>{owner.controller.signal.throwIfAborted();if(!alive.current||epoch!==requestEpoch.current||documentsRef.current[id]!==before||closingIds.current.has(id)||!portsRef.current.exists(id))throw Error('振幅来源已关闭或替换，本次文件未接入。');};owner.validate=guard;
    let adopted=false;
    try{
      guard();const input=files.length?resultFile(files[0]):null;if(input)owner.inputs.set(input,{closed:false});
      await updatePostprocessExcitationSlot(before.output,slotKey,input,owner.controller.signal);guard();adopted=true;
      if(input)owner.inputs.delete(input);
      const next={...before};const extras=postprocessSourceExtras(before);if(extras.length)retainPostprocessSourceExtras(next,[...extras]);
      documentsRef.current={...documentsRef.current,[id]:next};setDocuments(documentsRef.current);notifyAnalysisProjectStateChanged();owner.transferred=true;owner.targets.clear();
    }catch(error){if(alive.current)portsRef.current.onError(textError(error));}
    finally{
      const outcomes=await Promise.allSettled([...owner.inputs.keys()].map(input=>closeImportInput(owner,input)));owner.settled=true;finishReadOwner(owner);
      if(!adopted&&outcomes.some(result=>result.status==='rejected')&&alive.current)portsRef.current.onError('未接入振幅来源的读取租约仍待实际关闭，可重试停止。');
    }
  }
  function selectFile(id:string|null){
    const value=id?fileDocumentsRef.current[id]:undefined;
    if(id&&!value)return;
    fileOwnerRef.current=id;setFileOwnerId(id);
    if(value){
      setEngine(value.output.source.software==='gaussian'?'gaussian':value.output.source.software==='orca'?'orca':value.output.source.kind==='gaussian-output'?'gaussian':'orca');
      const tasks=postprocessFileJob(value.output.source)?.scientific?.tasks??value.output.source.tasks;
      const task=tasks.includes('opt')&&tasks.includes('freq')?'optfreq':tasks.find(item=>['irc','neb','scan','ts','opt','freq','td','sp'].includes(item));
      setTask((task??'trajectory') as PostprocessTask);setStage('files');setNotice(sourceNotices.current[value.id]??value.sourceWarnings?.map(row=>row.message).join('；')??'');
    }
  }
  async function selectFileJob(id:string,jobId:string){
    const before=fileDocumentsRef.current[id];if(!before||busyRef.current)return;
    busyRef.current=true;setBusy(true);
    const guard=()=>{if(!alive.current||fileDocumentsRef.current[id]!==before)throw Error('来源已关闭或替换，未切换旧作业。');};
    try{
      const output=selectPostprocessFileJob(before.output,jobId),base={...before,output};
      const prepared=await preparePostprocessFileIncoming([],base,guard);guard();
      const value=composePostprocessFileDocument(id,output,prepared.wavefunction,prepared) as PostprocessScientificFileDocument;
      sourceNotices.current[id]='';
      fileDocumentsRef.current={...fileDocumentsRef.current,[id]:value};setFileDocuments(fileDocumentsRef.current);if(fileOwnerRef.current===id){selectFile(id);portsRef.current.onFileDocument?.(value);}
    }catch(error){portsRef.current.onError(textError(error));}finally{busyRef.current=false;setBusy(false);}
  }
  async function removeFileSlot(role:'output'|'wavefunction'|'companions',_slotKey?:PostprocessSlotKey,sourceId?:string){
    const id=fileOwnerRef.current,before=id?fileDocumentsRef.current[id]:undefined;if(!id||!before||busyRef.current)return;
    if(role==='output'){portsRef.current.onError('主 OUT 持有此文件的作业信息；请关闭此来源，或选择替换文件。');return;}
    const outgoing=role==='wavefunction'?before.wavefunction?[before.wavefunction]:[]:(before.companions??[]).filter(item=>!sourceId||item.source.result.source.id===sourceId);
    if(!outgoing.length)return;
    busyRef.current=true;setBusy(true);
    const guard=()=>{if(!alive.current||fileDocumentsRef.current[id]!==before)throw Error('来源已关闭或替换，未移除旧配套。');};
    try{
      const base={...before,wavefunction:role==='wavefunction'?undefined:before.wavefunction,companions:(before.companions??[]).filter(item=>!outgoing.includes(item))};
      const prepared=await preparePostprocessFileIncoming([],base,guard);guard();
      const value=composePostprocessFileDocument(id,base.output,base.wavefunction,prepared) as PostprocessScientificFileDocument;
      fileDocumentsRef.current={...fileDocumentsRef.current,[id]:value};setFileDocuments(fileDocumentsRef.current);if(fileOwnerRef.current===id)portsRef.current.onFileDocument?.(value);
      const issues=await dispose(outgoing,id);if(issues.length)portsRef.current.onError(`来源已移除；释放提示：${issues.join('；')}`);
    }catch(error){portsRef.current.onError(textError(error));}finally{busyRef.current=false;setBusy(false);}
  }
  async function closeFile(id:string){
    const value=fileDocumentsRef.current[id]??pendingFileCloses.current.get(id);if(!value){try{await releases.retry(id);return[];}catch(error){return[textError(error)];}}
    closingIds.current.add(id);pendingFileCloses.current.set(id,value);
    const next={...fileDocumentsRef.current};delete next[id];fileDocumentsRef.current=next;setFileDocuments(next);if(fileOwnerRef.current===id)selectFile(null);
    try{
      const owner=readOwnerRef.current;if(owner?.targets.has(id)){await stopReadOwner(owner,new Error('文件来源已关闭，本次读取已取消。'));await owner.done;}
      const issues=await releases.releaseFile(id,value);if(issues.length)throw Error(issues.join('；'));await releases.retry(id);pendingFileCloses.current.delete(id);return[];
    }catch(error){return[textError(error)];}
  }
  function captureFileDocuments(){return{...fileDocumentsRef.current};}
  function restoreFileDocuments(next:Record<string,PostprocessScientificFileDocument>,selectedId:string|null=null){
    if(busyRef.current)throw Error('来源正在读取，不能恢复另一项目。');
    fileDocumentsRef.current={...next};setFileDocuments(fileDocumentsRef.current);selectFile(selectedId&&next[selectedId]?selectedId:null);
  }
  function selectEngine(value: PostprocessEngine) { if (value === 'cp2k') return; setEngine(value); setTask('sp'); setStage('tasks'); }
  function selectTask(value: PostprocessTask) { setTask(value); setStage('files'); }
  const current = ownerId ? documents[ownerId] ?? null : null;
  function extract(): Structure | null {
    if (!current) return null;
    return extractPostprocessModel((current.output ?? current.wavefunction)!.source, current.output ? current.wavefunction?.source : undefined);
  }
  function restoreProjectDocuments(next:Record<string,PostprocessDocument>,nextGenerated:Record<string,{document:PostprocessDocument;ownerId:string;bindingId:string}>={}) {
    if(busyRef.current)throw new Error('来源正在读取，不能恢复另一项目。');
    requestEpoch.current++;closingIds.current.clear();sourceNotices.current={};documentsRef.current=next;generatedRef.current=nextGenerated;setDocuments(next);setGenerated(nextGenerated);setNotice('');
  }
  return { documents, generated, ownerId, current, fileDocuments,fileOwnerId,currentFile:fileOwnerId?fileDocuments[fileOwnerId]??null:null,selectFile,selectFileJob,closeFile,captureFileDocuments,restoreFileDocuments,
    pendingFileCloses:()=>[...new Set([...pendingFileCloses.current.keys(),...releases.pending().map(item=>item.id)])],releasePendingFileCloses:async()=>{
      // Replacement cleanup can share the id of a still-live new document.
      // Retry only its retired resources; never close that current document.
      const outcomes=await Promise.allSettled([releases.retry(),...[...pendingFileCloses.current.keys()].map(async id=>{const issues=await closeFile(id);if(issues.length)throw Error(issues.join('；'));})]);
      const failed=outcomes.filter((row):row is PromiseRejectedResult=>row.status==='rejected');if(failed.length)throw new AggregateError(failed.map(row=>row.reason),'仍有文件来源资源待收尾。');
    },
    engine, task, stage, setStage, selectEngine, selectTask, busy,readState,isBusy:()=>busyRef.current, notice, read,readExcitationFiles, cancelRead, addGeneratedXtb,restoreProjectDocuments,
    getDocument:(id:string)=>documentsRef.current[id]??generatedRef.current[id]?.document,
    addArchivedGeneratedXtb:(value:GeneratedXtbSourcePackage,options?:{guard?():void;throwOnFailure?:boolean;beforeCommit?(document:PostprocessDocument):Promise<void>;onCreated?(id:string):void})=>addGeneratedXtb(value.bundle,value.expected,undefined,value,options),
    attachGeneratedToExisting:(bundle:XtbElectronicArtifactBundle,expected:GeneratedXtbExpected,id:string,guard:()=>void)=>addGeneratedXtb(bundle,expected,{id,guard}),close,prepareClose,describeClose:retirement.describeClose,pendingCloses:()=>[...retirement.pendingCloses(),...releases.pending()],releasePendingCloses:async(id?:string)=>{const outcomes=await Promise.allSettled([retirement.releasePendingCloses(id),releases.retry(id)]);const failed=outcomes.filter((row):row is PromiseRejectedResult=>row.status==='rejected');if(failed.length)throw new AggregateError(failed.map(row=>row.reason),'仍有分析来源资源待收尾。');}, remove, extract,
    dialog: pending ? <DialogShell aria-label={pending.title} className="modal workspace-import-choice" backdropClassName="modal-backdrop" onCancel={()=>pending.resolve('cancel')}><h2>{pending.title}</h2><p>{pending.message}</p><div className="modal-buttons">{pending.choices.map(choice => <button key={choice.value} onClick={() => pending.resolve(choice.value)}>{choice.label}</button>)}</div></DialogShell> : null };
}
