import {useCallback,useEffect,useRef,useState} from 'react';
import type {Structure} from '../../core/types';
import type {ChemistryJob,FragmentSnapshot} from '../../modeling/contracts';
import {createChemistryPort} from '../../modeling/chemistry';
import {generateTwoDFragment,type TwoDImportFile} from '../../modeling/application/two-d-import';
import type {TwoDCommitData,TwoDSourceInput} from '../../modeling/two-d';
import type {TwoDImageCrop,TwoDImageDecoded,TwoDImageSelection} from '../../modeling/two-d/image-types';
import {fullImageCrop} from '../../modeling/two-d/static-image-decode';
import {ocrPort} from '../../modeling/ocr/port';
import type {OcrCapabilities,OcrRecognitionResult} from '../../modeling/ocr/contracts';
import {createTwoDProvenanceFiles,type TwoDProvenanceArtifact,type TwoDRecognitionProvenance} from '../../projects/two-d-provenance';
import {confirmSynchronousOperation} from '../confirmation';
import DialogShell from '../DialogShell';
import {DismissibleNotice} from '../DismissibleNotice';
import TwoDEditorBridge,{type TwoDEditorRuntime,type TwoDEditorSnapshot} from './TwoDEditorBridge';
import TwoDImageSource from './TwoDImageSource';
import {TwoDAutomaticRecognitionGate,recognitionDelivery} from './two-d-session';

export type TwoDCommitGuard=(()=>void)&{target?:{kind:'new'}|{kind:'replace';documentId:string;revision:number}};
export interface TwoDImportRuntime {
  isBusy():boolean;isDirty():boolean;hasContent():boolean;
  stop():Promise<void>;cancelGesture():void;confirmReplacement():Promise<boolean>;reportError(message:string):void;
}
interface Props {
  file:TwoDImportFile;visible?:boolean;captureGuard():TwoDCommitGuard;
  onCommit(fragment:FragmentSnapshot,sources:File[],guard:TwoDCommitGuard):Promise<void>;
  onClose():void;onImportFiles(files:File[]):Promise<boolean>;
  onRuntime(runtime:TwoDImportRuntime|null):void;onBusyChange(busy:boolean):void;
}
interface RunningOperation {id:string;kind:'recognizing'|'generating';controller:AbortController;promise:Promise<void>;job?:ChemistryJob;ocrRequestId?:string}
interface RecognitionVersion {schema:'two-d-recognition-version/v1';sourceId:string;selection:TwoDImageSelection;result:OcrRecognitionResult}
interface PendingRecognition {source:TwoDSourceInput;metadata:RecognitionVersion}
const imageExtension={ 'image/png':'png','image/jpeg':'jpg','image/bmp':'bmp','image/tiff':'tiff','image/webp':'webp','image/gif':'gif'} as const;
function recognitionVersion(value:unknown,sourceId:string):RecognitionVersion|undefined {
  const candidate=value as RecognitionVersion|undefined;
  return candidate?.schema==='two-d-recognition-version/v1'&&candidate.sourceId===sourceId?candidate:undefined;
}

/** The main window retains this mounted session. Visibility never owns its
 * history or OCR, and no project serializer receives the unsubmitted draft. */
export default function TwoDSessionWorkspace({file,visible=true,captureGuard,onCommit,onClose,onImportFiles,onRuntime,onBusyChange}:Props){
  const [port]=useState(ocrPort),[capabilities,setCapabilities]=useState<OcrCapabilities>();
  const [stage,setStage]=useState<'idle'|'recognizing'|'generating'|'stopping'>('idle');
  const [error,setError]=useState(''),[errorIdentity,setErrorIdentity]=useState(0);
  const [snapshot,setSnapshot]=useState<TwoDEditorSnapshot>();
  const [decoded,setDecoded]=useState<TwoDImageDecoded>(),[crop,setCrop]=useState<TwoDImageCrop|null>(null);
  const [pending,setPending]=useState<PendingRecognition|null>(null),[replacePrompt,setReplacePrompt]=useState(false),[editorReady,setEditorReady]=useState(false);
  const [automatic]=useState(()=>{const value=new TwoDAutomaticRecognitionGate();value.replace(file.id);return value;});
  const alive=useRef(true),operation=useRef<RunningOperation|null>(null),editor=useRef<TwoDEditorRuntime|null>(null),lastSnapshot=useRef<TwoDEditorSnapshot|undefined>(undefined);
  const replacement=useRef<((accept:boolean)=>void)|null>(null);
  const latest=useRef({captureGuard,onCommit,onClose,onImportFiles,onBusyChange});latest.current={captureGuard,onCommit,onClose,onImportFiles,onBusyChange};
  const reportError=useCallback((message:string)=>{setError(message);setErrorIdentity(value=>value+1);},[]);
  const busy=stage!=='idle';
  const hasContent=()=>file.kind==='image'||Boolean(file.source)||Boolean(editor.current?.hasContent);
  const refreshCapabilities=useCallback(async()=>{if(!port)return;try{const value=await port.ocrCapabilities();if(alive.current)setCapabilities(value);}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause));}},[port]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;replacement.current?.(false);replacement.current=null;const running=operation.current;running?.controller.abort();running?.job?.cancel();if(running?.ocrRequestId)void port?.ocrCancel(running.ocrRequestId).catch(()=>{});};},[port]);
  useEffect(()=>{if(file.kind==='image')void refreshCapabilities();},[file.kind,refreshCapabilities]);
  useEffect(()=>{onBusyChange(busy);},[busy,onBusyChange]);
  const stop=useCallback(async()=>{const running=operation.current;if(!running)return;running.controller.abort();if(alive.current)setStage('stopping');running.job?.cancel();if(running.ocrRequestId&&port)await port.ocrCancel(running.ocrRequestId);await running.promise.catch(()=>{});},[port]);
  const acceptEditor=useCallback((value:TwoDEditorRuntime|null)=>{editor.current=value;setEditorReady(Boolean(value));},[]);
  const acceptSnapshot=useCallback((value:TwoDEditorSnapshot)=>{
    if(value.documentKey!==file.id)return;
    const previous=recognitionVersion(lastSnapshot.current?.sourceMetadata,file.id),next=recognitionVersion(value.sourceMetadata,file.id);
    lastSnapshot.current=value;setSnapshot(value);
    if(next!==previous&&next)setCrop({...next.selection.crop});
  },[file.id]);
  useEffect(()=>{
    onRuntime({isBusy:()=>Boolean(operation.current),isDirty:()=>Boolean(lastSnapshot.current?.dirty),hasContent,
      stop,reportError,cancelGesture:()=>editor.current?.cancelGesture(),confirmReplacement:()=>{editor.current?.cancelGesture();replacement.current?.(false);return new Promise<boolean>(resolve=>{replacement.current=resolve;setReplacePrompt(true);});}});
    return()=>onRuntime(null);
  },[onRuntime,stop,file.id]);
  function resolveReplacement(value:boolean){const resolve=replacement.current;replacement.current=null;setReplacePrompt(false);resolve?.(value);}
  function hide(){editor.current?.cancelGesture();resolveReplacement(false);latest.current.onClose();}
  function start(kind:RunningOperation['kind'],work:(running:RunningOperation,guard:TwoDCommitGuard)=>Promise<void>){
    if(operation.current)return;
    let targetGuard:TwoDCommitGuard|undefined;
    // Only generation captures a project; OCR belongs to this window session.
    if(kind==='generating')try{targetGuard=latest.current.captureGuard();targetGuard();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));return;}
    const running:RunningOperation={id:crypto.randomUUID(),kind,controller:new AbortController(),promise:Promise.resolve()};
    operation.current=running;setStage(kind);setError('');setErrorIdentity(value=>value+1);latest.current.onBusyChange(true);
    const guard:TwoDCommitGuard=()=>{if(!alive.current||operation.current!==running||running.controller.signal.aborted)throw new Error('二维操作已取消或会话已结束。');targetGuard?.();};
    guard.target=targetGuard?.target;
    running.promise=Promise.resolve().then(()=>work(running,guard)).catch(cause=>{if(alive.current&&operation.current===running&&!running.controller.signal.aborted)setError(cause instanceof Error?cause.message:String(cause));}).finally(()=>{if(operation.current===running){operation.current=null;if(alive.current){setStage('idle');latest.current.onBusyChange(false);}}});
  }
  function recognize(selection:TwoDImageSelection,initial=false){
    if(!port){setError('图片识别需要桌面版和本地MolVec组件。');return;}
    if(!editor.current||operation.current)return;
    if(!initial&&lastSnapshot.current?.dirty&&!confirmSynchronousOperation('重新识别将替换当前手动修改的二维结构。是否继续？'))return;
    const selected={bytes:selection.bytes.slice(),crop:{...selection.crop},...(selection.derivation?{derivation:structuredClone(selection.derivation)}:{})};
    const startedRevision=editor.current.revision;
    start('recognizing',async(running,guard)=>{
      guard();const requestId=`ocr-${crypto.randomUUID()}`;running.ocrRequestId=requestId;
      const result=await port.ocrRecognize({requestId,engine:'molvec',imageBytes:selected.bytes});guard();
      if(result.requestId!==requestId||result.engine!=='molvec'||!result.molblock)throw new Error('识别结果身份或结构内容不匹配，未接入草稿。');
      const imageHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(selected.bytes)))].map(value=>value.toString(16).padStart(2,'0')).join('');guard();
      if(result.imageSHA256!==imageHash)throw new Error('识别结果不属于本次裁切图像，未接入草稿。');
      const candidate:PendingRecognition={source:{id:requestId,name:file.name,format:'mol',data:result.molblock},metadata:{schema:'two-d-recognition-version/v1',sourceId:file.id,selection:selected,result}};
      const runtime=editor.current;if(!runtime)throw new Error('二维编辑器尚未就绪，识别结果未采用。');
      const decision=recognitionDelivery({sourceId:file.id,currentSourceId:file.id,operationId:running.id,currentOperationId:operation.current?.id??null,aborted:running.controller.signal.aborted,startedRevision,currentRevision:runtime.revision});
      if(decision==='discard')return;
      if(decision==='pending'||!await runtime.replaceSource(candidate.source,{history:'append',metadata:candidate.metadata,expectedRevision:startedRevision})){guard();setPending(candidate);return;}
      guard();setPending(null);
    });
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
  function generate(structure:Structure,commit?:TwoDCommitData,editorSnapshot?:TwoDEditorSnapshot){
    if(!commit||!editorSnapshot){setError('二维草稿缺少同版本来源资料。');return;}
    const source=editorSnapshot.source??{id:commit.source.id,name:commit.source.name,format:'ket' as const,data:commit.originalKet};
    const frozenSource={...source,data:typeof source.data==='string'?source.data:source.data.slice()},frozenCommit=structuredClone(commit),recognized=recognitionVersion(editorSnapshot.sourceMetadata,file.id),frozenRecognition=recognized&&structuredClone(recognized);
    start('generating',async(running,guard)=>{
      const generated=await generateTwoDFragment(structure,{port:createChemistryPort(),signal:running.controller.signal,guard,onJob:job=>{running.job=job??undefined;}});guard();
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
      await latest.current.onCommit(generated.fragment,files,guard);
      if(alive.current&&operation.current===running&&!running.controller.signal.aborted)latest.current.onClose();
    });
  }
  async function chooseComponent(){if(!port){setError('本地识别组件仅可在桌面版配置。');return;}try{const value=await port.ocrChooseComponent();if(alive.current){setCapabilities(value);setError('');}}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}
  const acceptDecoded=useCallback((value:TwoDImageDecoded)=>{setDecoded(value);setCrop(previous=>previous??value.selection?.crop??fullImageCrop(value.metadata));},[]);
  const status=stage==='recognizing'?'正在识别图片…':stage==='generating'?'正在生成三维…':stage==='stopping'?'正在停止…':'';
  return <DialogShell open={visible} className="two-d-import-dialog" aria-label="二维导入与建模" onCancel={hide}>
    <TwoDEditorBridge busy={busy} editingDisabled={stage==='generating'||stage==='stopping'} visible={visible} documentKey={file.id} initialSource={file.source} sourceName={file.name}
      onGenerate={generate} onClose={hide} onError={reportError} onRuntime={acceptEditor} onSnapshot={acceptSnapshot}
      onImportFiles={files=>void latest.current.onImportFiles(files)} onRecognizeImage={image=>void latest.current.onImportFiles([image])} status={status}
      onStop={()=>void stop().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))}
      sourcePanel={file.kind==='image'?<TwoDImageSource file={file} busy={busy} capabilities={capabilities} crop={crop} onSelection={setCrop} onDecoded={acceptDecoded} onChooseComponent={()=>void chooseComponent()} onRecognize={selection=>recognize(selection)} onError={reportError}/>:undefined}/>
    {replacePrompt&&<div className="two-d-session-choice" role="alertdialog" aria-label="替换二维草稿"><p>导入新内容将替换当前二维草稿。</p><button onClick={()=>resolveReplacement(false)}>取消</button><button onClick={()=>resolveReplacement(true)}>替换并导入</button></div>}
    {pending&&<div className="two-d-session-choice" role="status"><p>识别期间草稿已有修改，新的识别结果尚未采用。</p><button disabled={busy} onClick={()=>void adoptPending()}>采用识别结果</button><button disabled={busy} onClick={()=>setPending(null)}>保留当前编辑</button></div>}
    {error&&<DismissibleNotice className="two-d-import-error" identity={errorIdentity}>{error}</DismissibleNotice>}
  </DialogShell>;
}
