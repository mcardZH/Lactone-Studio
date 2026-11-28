import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {ChemistryJob,ChemistryPort,FragmentSnapshot} from '../../modeling/contracts';
import {createChemistryPort} from '../../modeling/chemistry';
import {type TwoDImportFile} from '../../modeling/application/two-d-import';
import {createTwoDAssemblyGenerator,type TwoDAssemblyInput,type TwoDAssemblyState} from '../../modeling/application/two-d-assembly';
import type {TwoDCommitData,TwoDSourceInput} from '../../modeling/two-d';
import type {TwoDImageCrop,TwoDImageDecoded,TwoDImageSelection} from '../../modeling/two-d/image-types';
import {fullImageCrop,imageSelectionPng} from '../../modeling/two-d/static-image-decode';
import {ocrPort} from '../../modeling/ocr/port';
import type {OcrCapabilities,OcrRecognitionResult} from '../../modeling/ocr/contracts';
import {createTwoDProvenanceFiles,type TwoDProvenanceArtifact,type TwoDRecognitionProvenance} from '../../projects/two-d-provenance';
import {confirmSynchronousOperation} from '../confirmation';
import DialogShell from '../DialogShell';
import {DismissibleNotice} from '../DismissibleNotice';
import {presentTaskError} from '../task-system/TaskErrorNotice';
import TwoDEditorBridge,{type TwoDEditorRuntime,type TwoDEditorSnapshot,type TwoDGenerationGuard} from './TwoDEditorBridge';
import TwoDImageSource from './TwoDImageSource';
import {TwoDAutomaticRecognitionGate,recognitionDelivery} from './two-d-session';
import TwoDLivePreview from './TwoDLivePreview';
import {readTwoDPreviewPreferences,writeTwoDPreviewPreferences} from './two-d-preview-preferences';
import TwoDWindowResize from './TwoDWindowResize';
import {assertTwoDEditorEditKet,layoutTwoDSmiles} from './two-d-editor-service';

export type TwoDCommitGuard=TwoDGenerationGuard;
export interface TwoDReportContext {kind:'import';sourceName?:string}
export interface TwoDDraftChange {
  draftId:string;
  status:'closed'|'opening'|'ready';
  revision?:number;
  dirty:boolean;
  hasContent:boolean;
  busy:boolean;
  cropRevision?:number;
  candidateId?:string;
}
export interface TwoDImportRuntime {
  isBusy():boolean;isDirty():boolean;hasContent():boolean;
  sketch:TwoDSketchCommands;
  stop():Promise<void>;cancelGesture():void;confirmReplacement(signal?:AbortSignal):Promise<boolean>;reportError(message:string,context?:TwoDReportContext):void;
}
interface TwoDSketchCommands {
  subscribeChanges(listener:(change:TwoDDraftChange)=>void):()=>void;
  read():Promise<{status:'closed'|'opening'}|{status:'ready';snapshot:Pick<TwoDEditorSnapshot,'documentKey'|'revision'|'ket'|'dirty'|'hasContent'>;busy:boolean}>;
  apply(draftId:string,revision:number,ket:string):Promise<TwoDEditorSnapshot>;
  applySmiles(draftId:string,revision:number,smiles:string,signal?:AbortSignal):Promise<TwoDEditorSnapshot>;
  history(draftId:string,revision:number,direction:'undo'|'redo'):Promise<TwoDEditorSnapshot>;
  generate(draftId:string,revision:number,guard:TwoDCommitGuard,signal?:AbortSignal):Promise<void|string>;
  image():unknown;
  setCrop(draftId:string,revision:number,rectangle?:Pick<TwoDImageCrop,'x'|'y'|'width'|'height'>):TwoDImageCrop;
  recognize(draftId:string,revision:number,replaceEdited:boolean,signal?:AbortSignal):Promise<unknown>;
  resolveRecognition(draftId:string,revision:number,candidateId:string,accept:boolean):Promise<unknown>;
  stereochemistry(draftId:string,revision:number,shown?:boolean,retry?:boolean):Promise<unknown>;
}
interface Props {
  file:TwoDImportFile;visible?:boolean;captureGuard():TwoDCommitGuard;
  onCommit(fragment:FragmentSnapshot,sources:File[],guard:TwoDCommitGuard):Promise<void|string>;
  onClose():void;onImportFiles?(files:File[]):Promise<boolean>;
  onRuntime(runtime:TwoDImportRuntime|null):void;onBusyChange(busy:boolean):void;
  chemistryPort?:ChemistryPort;
}
interface RunningOperation {id:string;kind:'recognizing'|'generating';controller:AbortController;promise:Promise<void>;job?:ChemistryJob;ocrRequestId?:string}
interface RecognitionVersion {schema:'two-d-recognition-version/v1';sourceId:string;selection:TwoDImageSelection;result:OcrRecognitionResult}
interface PendingRecognition {source:TwoDSourceInput;metadata:RecognitionVersion}
const imageExtension={ 'image/png':'png','image/jpeg':'jpg','image/bmp':'bmp','image/tiff':'tiff','image/webp':'webp','image/gif':'gif'} as const;
function presentTwoDError(raw:string) {
  const reasons:Record<string,string>={
    'charge-mismatch':'当前图的形式电荷合计与三维请求不一致，请核对原子电荷。',
    'embedding':'ETKDGv3 未能为当前图生成三维坐标，二维草稿已保留。',
    'stereo-change':'三维生成结果未保留明确指定的立体构型，二维草稿已保留。',
    'stereo-unsupported':'当前图的部分立体构型无法保真转换，请核对楔线和相连原子。',
  };
  const match=/\b(charge-mismatch|embedding|stereo-change|stereo-unsupported):/.exec(raw);
  return match?{message:reasons[match[1]],details:raw}:presentTaskError(raw);
}
function recognitionVersion(value:unknown,sourceId:string):RecognitionVersion|undefined {
  const candidate=value as RecognitionVersion|undefined;
  return candidate?.schema==='two-d-recognition-version/v1'&&candidate.sourceId===sourceId?candidate:undefined;
}

/** The main window retains this mounted session. Visibility never owns its
 * history or OCR, and no project serializer receives the unsubmitted draft. */
export default function TwoDSessionWorkspace({file,visible=true,captureGuard,onCommit,onClose,onImportFiles,onRuntime,onBusyChange,chemistryPort}:Props){
  const [port]=useState(ocrPort),[capabilities,setCapabilities]=useState<OcrCapabilities>();
  const [stage,setStage]=useState<'idle'|'recognizing'|'generating'|'stopping'>('idle');
  const [error,setError]=useState(''),[errorIdentity,setErrorIdentity]=useState(0);
  const [importIssue,setImportIssue]=useState<{identity:number;message:string;sourceName?:string;revision:number;ket:string}|null>(null),importIssueSerial=useRef(0);
  const [snapshot,setSnapshot]=useState<TwoDEditorSnapshot>();
  const [decoded,setDecoded]=useState<TwoDImageDecoded>(),[crop,setCropState]=useState<TwoDImageCrop|null>(null);
  const cropRef=useRef<TwoDImageCrop|null>(null),cropRevision=useRef(0),imageInteraction=useRef<(()=>boolean)|null>(null);
  const setCrop=useCallback((value:TwoDImageCrop|((previous:TwoDImageCrop|null)=>TwoDImageCrop))=>{
    const next=typeof value==='function'?value(cropRef.current):value;
    if(next===cropRef.current)return;
    cropRef.current=next;cropRevision.current++;setCropState(next);
  },[]);
  const bindImageInteraction=useCallback((read:(()=>boolean)|null)=>{imageInteraction.current=read;},[]);
  const [pending,setPendingState]=useState<PendingRecognition|null>(null),pendingRef=useRef<PendingRecognition|null>(null);
  function setPending(value:PendingRecognition|null){pendingRef.current=value;setPendingState(value);}
  const [replacePrompt,setReplacePrompt]=useState(false),[editorReady,setEditorReady]=useState(false);
  const [automatic]=useState(()=>{const value=new TwoDAutomaticRecognitionGate();value.replace(file.id);return value;});
  const alive=useRef(true),operation=useRef<RunningOperation|null>(null),editor=useRef<TwoDEditorRuntime|null>(null),lastSnapshot=useRef<TwoDEditorSnapshot|undefined>(undefined);
  const sketchVisible=useRef(visible);sketchVisible.current=visible;
  const sketchListeners=useRef(new Set<(change:TwoDDraftChange)=>void>());
  const lastSketchChange=useRef<TwoDDraftChange|undefined>(undefined);
  const readSketchChange=useCallback(():TwoDDraftChange=>{
    const current=lastSnapshot.current;
    return {draftId:file.id,status:!alive.current||!sketchVisible.current?'closed':current?'ready':'opening',revision:current?.revision,
      dirty:current?.dirty??false,hasContent:current?.hasContent??false,busy:!!operation.current,
      ...(file.kind==='image'?{cropRevision:cropRevision.current,candidateId:pendingRef.current?.source.id}:{})};
  },[file.id,file.kind]);
  const publishSketchChange=useCallback(()=>{
    const next=readSketchChange(),previous=lastSketchChange.current;
    if(previous?.status===next.status&&previous.revision===next.revision&&previous.dirty===next.dirty&&previous.hasContent===next.hasContent&&previous.busy===next.busy&&previous.cropRevision===next.cropRevision&&previous.candidateId===next.candidateId)return;
    lastSketchChange.current=next;
    for(const listener of sketchListeners.current)listener(next);
  },[readSketchChange]);
  const mountGeneration=useRef(0);
  const previewPreferenceAnchor=useRef<HTMLSpanElement>(null),previewPreferenceOwner=useRef<Document|undefined>(typeof document==='undefined'?undefined:document);
  const [previewEnabled,setPreviewEnabled]=useState(()=>readTwoDPreviewPreferences(previewPreferenceOwner.current).enabled);
  const [assemblyDraft,setAssemblyDraft]=useState<{input:TwoDAssemblyInput;commit:TwoDCommitData;snapshot:TwoDEditorSnapshot}|null>(null);
  const [preview,setPreview]=useState<TwoDAssemblyState>({inputKey:null,displayedInputKey:null,status:'idle',completed:0,total:0,preview:null,complete:null,failures:[]});
  const [assemblyGenerator]=useState(()=>createTwoDAssemblyGenerator({port:chemistryPort??createChemistryPort(),onState:value=>{if(alive.current)setPreview(value);}}));
  const replacement=useRef<((accept:boolean)=>void)|null>(null);
  const sketch=useRef<TwoDSketchCommands>(null!);
  const latest=useRef({captureGuard,onCommit,onClose,onImportFiles,onBusyChange});latest.current={captureGuard,onCommit,onClose,onImportFiles,onBusyChange};
  const reportError=useCallback((message:string,context?:TwoDReportContext)=>{
    if(context?.kind==='import'){
      const current=lastSnapshot.current;
      setImportIssue({identity:++importIssueSerial.current,message,sourceName:context.sourceName,revision:current?.revision??-1,ket:current?.ket??''});
      return;
    }
    setError(message);setErrorIdentity(value=>value+1);
  },[]);
  const busy=stage!=='idle';
  useLayoutEffect(()=>{const owner=previewPreferenceAnchor.current?.ownerDocument;if(owner&&previewPreferenceOwner.current!==owner){previewPreferenceOwner.current=owner;setPreviewEnabled(readTwoDPreviewPreferences(owner).enabled);}},[]);
  const changePreviewEnabled=useCallback((enabled:boolean)=>{writeTwoDPreviewPreferences(previewPreferenceOwner.current,{enabled});setPreviewEnabled(enabled);},[]);
  const hasContent=()=>file.kind==='image'||Boolean(file.source)||Boolean(editor.current?.hasContent);
  const refreshCapabilities=useCallback(async()=>{if(!port)return;try{const value=await port.ocrCapabilities();if(alive.current)setCapabilities(value);}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause));}},[port]);
  useEffect(()=>{
    const own=++mountGeneration.current;alive.current=true;
    return()=>{
      alive.current=false;publishSketchChange();assemblyGenerator.cancel();replacement.current?.(false);replacement.current=null;
      const running=operation.current;running?.controller.abort();running?.job?.cancel();if(running?.ocrRequestId)void port?.ocrCancel(running.ocrRequestId).catch(()=>{});
      // StrictMode immediately restores this same session after its probe
      // cleanup. Cancel work now; release the cache only for a real unmount.
      queueMicrotask(()=>{if(!alive.current&&mountGeneration.current===own)assemblyGenerator.dispose();});
    };
  },[port,assemblyGenerator,publishSketchChange]);
  useEffect(()=>{if(file.kind==='image')void refreshCapabilities();},[file.kind,refreshCapabilities]);
  useEffect(()=>{onBusyChange(busy);},[busy,onBusyChange]);
  useEffect(()=>publishSketchChange(),[visible,busy,crop,pending,publishSketchChange]);
  const stop=useCallback(async()=>{assemblyGenerator.cancel();const running=operation.current;if(!running)return;running.controller.abort();if(alive.current)setStage('stopping');running.job?.cancel();if(running.ocrRequestId&&port)await port.ocrCancel(running.ocrRequestId);await running.promise.catch(()=>{});},[port,assemblyGenerator]);
  const acceptEditor=useCallback((value:TwoDEditorRuntime|null)=>{editor.current=value;setEditorReady(Boolean(value));},[]);
  const acceptSnapshot=useCallback((value:TwoDEditorSnapshot)=>{
    if(value.documentKey!==file.id)return;
    const previous=recognitionVersion(lastSnapshot.current?.sourceMetadata,file.id),next=recognitionVersion(value.sourceMetadata,file.id);
    lastSnapshot.current=value;setSnapshot(value);publishSketchChange();
    setImportIssue(previous=>previous&&value.revision>previous.revision&&value.ket!==previous.ket?null:previous);
    if(next!==previous&&next)setCrop({...next.selection.crop});
  },[file.id,publishSketchChange,setCrop]);
  const acceptAssembly=useCallback((input:TwoDAssemblyInput,commit:TwoDCommitData,value:TwoDEditorSnapshot)=>{
    if(value.documentKey!==file.id)return;
    setAssemblyDraft({input,commit,snapshot:value});
  },[file.id]);
  useEffect(()=>{
    if(!visible||!previewEnabled){if(operation.current?.kind!=='generating')assemblyGenerator.cancel();return;}
    if(busy||!assemblyDraft)return;
    void assemblyGenerator.update(assemblyDraft.input).catch(cause=>{if(alive.current)setError(cause instanceof Error?cause.message:String(cause));});
  },[visible,previewEnabled,busy,assemblyDraft?.input.key,assemblyGenerator]);
  useEffect(()=>{
    onRuntime({isBusy:()=>Boolean(operation.current),isDirty:()=>Boolean(lastSnapshot.current?.dirty),hasContent,get sketch(){return sketch.current;},
      stop,reportError,cancelGesture:()=>editor.current?.cancelGesture(),confirmReplacement:signal=>{
        if(signal?.aborted)return Promise.resolve(false);
        editor.current?.cancelGesture();replacement.current?.(false);
        return new Promise<boolean>(resolve=>{
          function finish(accepted:boolean){signal?.removeEventListener('abort',abort);resolve(accepted);}
          function abort(){if(replacement.current===finish)resolveReplacement(false);}
          replacement.current=finish;signal?.addEventListener('abort',abort,{once:true});setReplacePrompt(true);
        });
      }});
    return()=>onRuntime(null);
  },[onRuntime,stop,file.id]);
  function resolveReplacement(value:boolean){const resolve=replacement.current;replacement.current=null;setReplacePrompt(false);resolve?.(value);}
  function hide(){editor.current?.cancelGesture();if(operation.current?.kind!=='generating')assemblyGenerator.cancel();resolveReplacement(false);latest.current.onClose();}
  function start<T>(kind:RunningOperation['kind'],work:(running:RunningOperation,guard:TwoDCommitGuard)=>Promise<T>,capturedGuard?:TwoDCommitGuard,propagate=false,signal?:AbortSignal){
    if(operation.current){if(propagate)throw Error('二维画板已有正在处理的操作。');return;}
    signal?.throwIfAborted();
    let targetGuard:TwoDCommitGuard|undefined;
    // Only generation captures a project; OCR belongs to this window session.
    if(kind==='generating')try{targetGuard=capturedGuard??latest.current.captureGuard();targetGuard();}catch(cause){if(propagate)throw cause;setError(cause instanceof Error?cause.message:String(cause));return;}
    const running:RunningOperation={id:crypto.randomUUID(),kind,controller:new AbortController(),promise:Promise.resolve()};
    operation.current=running;setStage(kind);setError('');setErrorIdentity(value=>value+1);latest.current.onBusyChange(true);
    const guard:TwoDCommitGuard=()=>{if(!alive.current||operation.current!==running||running.controller.signal.aborted)throw new Error('二维操作已取消或会话已结束。');signal?.throwIfAborted();targetGuard?.();};
    guard.target=targetGuard?.target;
    const abort=()=>{if(operation.current===running)void stop().catch(cause=>reportError(cause instanceof Error?cause.message:String(cause)));};
    signal?.addEventListener('abort',abort,{once:true});
    const result=Promise.resolve().then(()=>work(running,guard)).catch(cause=>{if(alive.current&&operation.current===running&&!running.controller.signal.aborted)setError(cause instanceof Error?cause.message:String(cause));if(propagate)throw cause;}).finally(()=>{signal?.removeEventListener('abort',abort);if(operation.current===running){operation.current=null;if(alive.current){setStage('idle');latest.current.onBusyChange(false);}}});
    running.promise=result.then(()=>{},()=>{});
    return result;
  }
  function recognize(selection:TwoDImageSelection,initial=false,explicit?:{replaceEdited:boolean;signal?:AbortSignal}){
    if(!port){const message='图片识别需要桌面版和本地MolVec组件。';if(explicit)throw Error(message);setError(message);return;}
    if(!editor.current||operation.current){if(explicit)throw Error('二维操作尚未结束或编辑器未就绪。');return;}
    const dirty=lastSnapshot.current?.dirty;
    if(!explicit&&!initial&&dirty&&!confirmSynchronousOperation('重新识别将替换当前手动修改的二维结构。是否继续？'))return;
    const selected={bytes:selection.bytes.slice(),crop:{...selection.crop},...(selection.derivation?{derivation:structuredClone(selection.derivation)}:{})};
    const startedRevision=editor.current.revision,startedCropRevision=cropRevision.current;
    return start('recognizing',async(running,guard)=>{
      guard();const requestId=`ocr-${crypto.randomUUID()}`;running.ocrRequestId=requestId;
      const result=await port.ocrRecognize({requestId,engine:'molvec',imageBytes:selected.bytes});guard();
      if(result.requestId!==requestId||result.engine!=='molvec'||!result.molblock)throw new Error('识别结果身份或结构内容不匹配，未接入草稿。');
      const imageHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(selected.bytes)))].map(value=>value.toString(16).padStart(2,'0')).join('');guard();
      if(result.imageSHA256!==imageHash)throw new Error('识别结果不属于本次裁切图像，未接入草稿。');
      const candidate:PendingRecognition={source:{id:requestId,name:file.name,format:'mol',data:result.molblock},metadata:{schema:'two-d-recognition-version/v1',sourceId:file.id,selection:selected,result}};
      const runtime=editor.current;if(!runtime)throw new Error('二维编辑器尚未就绪，识别结果未采用。');
      const decision=recognitionDelivery({sourceId:file.id,currentSourceId:file.id,operationId:running.id,currentOperationId:operation.current?.id??null,aborted:running.controller.signal.aborted,startedRevision,currentRevision:runtime.revision});
      if(decision==='discard'){if(explicit)throw Error('识别来源已变化。');return;}
      const receipt={candidateId:candidate.source.id,requestId,engine:result.engine,version:result.version,crop:selected.crop,imageSHA256:result.imageSHA256};
      const stillCurrent=explicit?()=>sketchVisible.current&&cropRevision.current===startedCropRevision&&!imageInteraction.current?.():undefined;
      if(decision==='pending'||explicit&&dirty&&!explicit.replaceEdited||!await runtime.replaceSource(candidate.source,{history:'append',metadata:candidate.metadata,expectedRevision:startedRevision,preserveGesture:!!explicit,assertCurrent:explicit?guard:undefined,stillCurrent})){
        guard();setPending(candidate);return {...receipt,status:'review',recognitionState:'review',pendingCandidateId:candidate.source.id,
          nextActions:['accept','discard'],revision:runtime.revision};
      }
      guard();setPending(null);return {...receipt,status:'committed',recognitionState:'committed',pendingCandidateId:null,
        adoptedRecognitionId:requestId,nextActions:[],revision:runtime.revision};
    },undefined,!!explicit,explicit?.signal);
  }
  useEffect(()=>{
    if(file.kind!=='image'||!editorReady||snapshot?.documentKey!==file.id||!decoded?.selection||!port||operation.current||capabilities?.engines.find(value=>value.engine==='molvec')?.status!=='ready')return;
    if(automatic.claim(file.id))recognize(decoded.selection,true);
  },[file.id,file.kind,decoded,editorReady,snapshot?.documentKey,capabilities,port,automatic]);
  async function adoptPending(){
    if(!pending||!editor.current||operation.current)return;
    const candidate=pending,expected=editor.current.revision;
    try{if(await editor.current.replaceSource(candidate.source,{history:'append',metadata:candidate.metadata,expectedRevision:expected})){if(alive.current)setPending(null);}else setError('草稿又有修改，识别候选已保留，请重新选择是否采用。');}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  }
  function generate(input:TwoDAssemblyInput,commit?:TwoDCommitData,editorSnapshot?:TwoDEditorSnapshot,capturedGuard?:TwoDCommitGuard,propagate=false,signal?:AbortSignal){
    if(!commit||!editorSnapshot){if(propagate)throw Error('二维草稿缺少同版本来源资料。');setError('二维草稿缺少同版本来源资料。');return;}
    const source=editorSnapshot.source??{id:commit.source.id,name:commit.source.name,format:'ket' as const,data:commit.originalKet};
    const frozenSource={...source,data:typeof source.data==='string'?source.data:source.data.slice()},frozenCommit=structuredClone(commit),recognized=recognitionVersion(editorSnapshot.sourceMetadata,file.id),frozenRecognition=recognized&&structuredClone(recognized);
    return start('generating',async(running,ownerGuard)=>{
      const guard:TwoDCommitGuard=()=>{ownerGuard();if(editorSnapshot.documentKey!==file.id||editor.current?.revision!==editorSnapshot.revision)throw new Error('二维图已变化，未提交旧图的三维结果。');};
      guard.target=ownerGuard.target;
      const state=await assemblyGenerator.update(input);guard();
      const generated=state.inputKey===input.key&&state.displayedInputKey===input.key?state.complete:null;
      if(!generated)throw new Error(state.failures.length?state.failures.map(failure=>`${failure.label}：${failure.message}`).join('\n'):'当前二维图的完整三维结构尚未准备好，请重试。');
      frozenCommit.assembly={schema:'es-2d-assembly/v1',components:structuredClone(generated.components),layoutScale:generated.layoutScale};
      const artifacts:TwoDProvenanceArtifact[]=[];let recognition:TwoDRecognitionProvenance|undefined;
      if(file.kind==='image'){
        if(!file.mime||!file.image)throw new Error('原始图片格式或解码出处缺失，未提交三维。');
        artifacts.push({role:'source-image',name:`source-image.${imageExtension[file.mime]}`,bytes:file.bytes.slice(),mime:file.mime});
        artifacts.push({role:'image-derivation',name:'image-derivation.json',bytes:new TextEncoder().encode(JSON.stringify({originalName:file.name,sourceMime:file.mime,decoded:file.image.metadata})),mime:'application/json'});
        if(frozenRecognition){const receipt=frozenRecognition.result;
          artifacts.push({role:'recognition-input',name:'recognition-input.png',bytes:frozenRecognition.selection.bytes,mime:'image/png'});
          artifacts.push({role:'recognition-receipt',name:'recognition-receipt.json',bytes:new TextEncoder().encode(JSON.stringify(receipt)),mime:'application/json'});
          recognition={engine:receipt.engine,version:receipt.version,crop:frozenRecognition.selection.crop,originalImageRole:'source-image',inputImageRole:'recognition-input',rawCandidateRoles:['original'],model:{sha256:receipt.componentSHA256},details:{imageSHA256:receipt.imageSHA256,elapsedMs:receipt.elapsedMs,...(frozenRecognition.selection.derivation?{imageDerivation:JSON.parse(JSON.stringify(frozenRecognition.selection.derivation))}:{})}};
        }
      }
      const files=await createTwoDProvenanceFiles({source:frozenSource,commit:frozenCommit,artifacts,recognition,engines:{editor:{engine:'Ketcher',version:'3.18.0'},...((frozenSource.format??frozenCommit.source.format)!=='ket'?{parser:{engine:'Indigo',version:'1.46.0'}}:{}),generator:{engine:generated.result.engine,version:generated.result.engineVersion,method:generated.result.engine==='RDKit'?'ETKDGv3':'generate3d'}}});guard();
      const committed=await latest.current.onCommit(generated.fragment,files,guard);
      if(alive.current&&operation.current===running&&!running.controller.signal.aborted)setImportIssue(null);
      if(alive.current&&operation.current===running&&!running.controller.signal.aborted)latest.current.onClose();
      return committed;
    },capturedGuard,propagate,signal);
  }
  function requireSketch(draftId:string){
    if(!alive.current||!sketchVisible.current||file.id!==draftId)throw Error('二维草稿已关闭或更换，请重新读取。');
    if(operation.current||replacement.current)throw Error('二维画板已有正在处理的操作。');
    if(!editor.current?.ready)throw Error('二维编辑器尚未就绪。');
    return editor.current;
  }
  function requireImage(draftId:string,revision:number){
    const runtime=requireSketch(draftId);
    if(runtime.revision!==revision)throw Error('二维草稿已变化，请重新读取。');
    if(!file.image)throw Error('当前二维会话没有已解码的图片。');
    if(imageInteraction.current?.())throw Error('图片仍在框选或准备识别，请先结束当前操作。');
    return {runtime,image:file.image};
  }
  sketch.current={
    stereochemistry:(draftId,revision,shown,retry)=>requireSketch(draftId).stereochemistry(revision,shown,retry),
    subscribeChanges(listener){
      sketchListeners.current.add(listener);listener(readSketchChange());
      return ()=>{sketchListeners.current.delete(listener);};
    },
    async read(){
      if(!sketchVisible.current)return {status:'closed'};
      const runtime=editor.current;if(!runtime?.ready)return {status:'opening'};
      const {documentKey,revision,ket,dirty,hasContent}=await runtime.getSnapshot();
      if(!alive.current||!sketchVisible.current||editor.current!==runtime)throw Error('二维会话在读取期间已切换。');
      return {status:'ready',snapshot:{documentKey,revision,ket,dirty,hasContent},busy:!!operation.current};
    },
    apply(draftId,revision,ket){
      const runtime=requireSketch(draftId);
      assertTwoDEditorEditKet(ket);
      return runtime.applyKet(ket,revision,()=>{if(requireSketch(draftId)!==runtime)throw Error('二维会话已切换。');});
    },
    async applySmiles(draftId,revision,smiles,signal){
      const runtime=requireSketch(draftId);
      if(runtime.revision!==revision)throw Error('二维草稿版本已变化，请重新读取。');
      const ket=await layoutTwoDSmiles(smiles,signal);
      signal?.throwIfAborted();
      if(requireSketch(draftId)!==runtime)throw Error('二维会话已切换。');
      if(runtime.revision!==revision)throw Error('二维草稿版本已变化，请重新读取。');
      return runtime.applyKet(ket,revision,()=>{signal?.throwIfAborted();if(requireSketch(draftId)!==runtime)throw Error('二维会话已切换。');});
    },
    history(draftId,revision,direction){return requireSketch(draftId).history(direction,revision);},
    async generate(draftId,revision,guard,signal){
      const runtime=requireSketch(draftId);guard();
      const {assembly,commit,editorSnapshot}=await runtime.prepareGeneration(revision);
      if(requireSketch(draftId)!==runtime||runtime.revision!==revision)throw Error('二维草稿在生成前已变化。');
      return generate(assembly,commit,editorSnapshot,guard,true,signal);
    },
    image(){
      if(!sketchVisible.current||file.kind!=='image')return {status:'unavailable'};
      const candidate=pendingRef.current,last=recognitionVersion(lastSnapshot.current?.sourceMetadata,file.id);
      return {status:'ready',draftId:file.id,revision:editor.current?.revision,sourceName:file.name,metadata:file.image?.metadata,
        crop:cropRef.current,cropRevision:cropRevision.current,capability:capabilities?.engines.find(value=>value.engine==='molvec'),busy:!!operation.current,
        operation:operation.current?.kind??null,recognitionState:operation.current?.kind==='recognizing'?'recognizing':candidate?'review':last?'committed':'idle',
        pendingCandidateId:candidate?.source.id??null,adoptedRecognitionId:last?.result.requestId??null,
        nextActions:operation.current?[]:candidate?['accept','discard']:['crop','recognize'],
        candidate:candidate?{id:candidate.source.id,crop:candidate.metadata.selection.crop,engine:candidate.metadata.result.engine}:undefined,
        recognition:last?{requestId:last.result.requestId,crop:last.selection.crop,engine:last.result.engine,version:last.result.version}:undefined};
    },
    setCrop(draftId,revision,rectangle){
      const {image}=requireImage(draftId,revision),bounds=fullImageCrop(image.metadata),next={...bounds,...rectangle};
      if(![next.x,next.y,next.width,next.height].every(Number.isSafeInteger)||next.x<0||next.y<0||next.width<1||next.height<1||next.x+next.width>bounds.width||next.y+next.height>bounds.height)throw Error('图片选区坐标超出原图。');
      setCrop(next);return next;
    },
    async recognize(draftId,revision,replaceEdited,signal){
      const {image,runtime}=requireImage(draftId,revision),beforeCrop=cropRef.current,selected=beforeCrop??fullImageCrop(image.metadata);
      const capability=capabilities?.engines.find(value=>value.engine==='molvec');
      if(!capabilities||capability?.status!=='ready')throw Error(capability?.message??'当前桌面版没有可用的 MolVec 识别组件。');
      const selection=await imageSelectionPng(image,selected,{maxImageBytes:capabilities.maxImageBytes,maxImagePixels:capabilities.maxImagePixels});
      signal?.throwIfAborted();if(requireImage(draftId,revision).runtime!==runtime||cropRef.current!==beforeCrop)throw Error('准备识别期间图片选区已变化。');
      return recognize(selection,false,{replaceEdited,signal});
    },
    async resolveRecognition(draftId,revision,candidateId,accept){
      const {runtime}=requireImage(draftId,revision),candidate=pendingRef.current;
      if(!candidate||candidate.source.id!==candidateId)throw Error('识别候选已变化，请重新读取。');
      if(accept){
        const applied=await runtime.replaceSource(candidate.source,{history:'append',metadata:candidate.metadata,expectedRevision:revision,preserveGesture:true,
          assertCurrent:()=>{if(requireImage(draftId,revision).runtime!==runtime||pendingRef.current!==candidate)throw Error('草稿或识别候选已变化。');}});
        if(!applied)throw Error('草稿已变化，请重新读取并确认候选。');
      }
      if(pendingRef.current===candidate)setPending(null);
      return {status:accept?'committed':'discarded',draftId,revision:runtime.revision,candidateId,
        recognitionState:accept?'committed':'discarded',pendingCandidateId:null,
        ...(accept?{adoptedRecognitionId:candidateId}:{}),nextActions:[]};
    },
  };
  async function chooseComponent(){if(!port){setError('本地识别组件仅可在桌面版配置。');return;}try{const value=await port.ocrChooseComponent();if(alive.current){setCapabilities(value);setError('');}}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}
  const acceptDecoded=useCallback((value:TwoDImageDecoded)=>{setDecoded(value);setCrop(previous=>previous??value.selection?.crop??fullImageCrop(value.metadata));},[setCrop]);
  const status=stage==='recognizing'?'正在识别图片…':stage==='generating'?'正在生成三维…':stage==='stopping'?'正在停止…':'';
  const visibleError=error?presentTwoDError(error):null;
  return <DialogShell open={visible} className="two-d-import-dialog" aria-label="二维导入与建模" onCancel={hide}>
    <TwoDWindowResize visible={visible}/>
    <span ref={previewPreferenceAnchor} hidden aria-hidden="true"/>
    <TwoDEditorBridge busy={busy} editingDisabled={stage==='generating'||stage==='stopping'} visible={visible} documentKey={file.id} initialSource={file.source} sourceName={file.name}
      onAssembly={acceptAssembly} previewEnabled={previewEnabled} onPreviewEnabledChange={changePreviewEnabled}
      previewPanel={<TwoDLivePreview state={preview} inputKey={assemblyDraft?.input.fragments.length?assemblyDraft.input.key:null} active={visible&&previewEnabled} sourceKey={file.id} onRetry={()=>{if(assemblyDraft)void assemblyGenerator.update(assemblyDraft.input,{retryFailed:true}).catch(cause=>reportError(cause instanceof Error?cause.message:String(cause)));}}/>}
      onGenerate={generate} captureGenerationGuard={()=>latest.current.captureGuard()} onClose={hide} onError={reportError} onRuntime={acceptEditor} onSnapshot={acceptSnapshot}
      onImportFiles={onImportFiles?files=>void latest.current.onImportFiles?.(files):undefined} onRecognizeImage={onImportFiles?image=>void latest.current.onImportFiles?.([image]):undefined} status={status}
      onStop={()=>void stop().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))}
      sourcePanel={file.kind==='image'?<TwoDImageSource file={file} busy={busy} capabilities={capabilities} crop={crop} onSelection={setCrop} onDecoded={acceptDecoded} onInteraction={bindImageInteraction} onChooseComponent={()=>void chooseComponent()} onRecognize={selection=>recognize(selection)} onError={reportError}/>:undefined}/>
    {replacePrompt&&<div className="two-d-session-choice" role="alertdialog" aria-label="替换二维草稿"><p>导入新内容将替换当前二维草稿。</p><button onClick={()=>resolveReplacement(false)}>取消</button><button onClick={()=>resolveReplacement(true)}>替换并导入</button></div>}
    {pending&&<div className="two-d-session-choice" role="status"><p>识别期间草稿已有修改，新的识别结果尚未采用。</p><button disabled={busy} onClick={()=>void adoptPending()}>采用识别结果</button><button disabled={busy} onClick={()=>setPending(null)}>保留当前编辑</button></div>}
    {importIssue&&<DismissibleNotice role="status" className="two-d-import-notice" data-testid="two-d-import-notice" identity={importIssue.identity} onDismiss={()=>setImportIssue(null)}>
      导入{importIssue.sourceName?`“${importIssue.sourceName}”`: '新文件'}未成功：{importIssue.message}{'\n'}当前二维图未改变，可继续编辑或生成三维。
    </DismissibleNotice>}
    {visibleError&&<DismissibleNotice className="two-d-import-error" identity={errorIdentity}>{visibleError.message}{visibleError.details&&<details><summary>详情</summary><pre>{visibleError.details}</pre><button type="button" onClick={event=>{
      const clipboard=event.currentTarget.ownerDocument.defaultView?.navigator.clipboard;
      if(clipboard)void clipboard.writeText(visibleError.details!).catch(()=>{});
    }}>复制详情</button></details>}</DismissibleNotice>}
  </DialogShell>;
}
