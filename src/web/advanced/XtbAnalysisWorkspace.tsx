import {GxtbAvailability,useGxtbBackend,gxtbMethodLabel,gxtbRunBlocked} from '../results/GxtbPathControl';
import {DismissibleNotice} from '../DismissibleNotice';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {AdvancedController} from '../../modeling/advanced/controller';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {assertAdvancedIsolated,captureAdvancedFrame} from '../../modeling/advanced/frame-source';
import type {ComputeResourceValues} from '../../modeling/resource-preferences';
import type {DisplaySettings,ModelDocument} from '../../modeling/contracts';
import type {Structure} from '../../core/types';
import type {PostprocessDocument} from '../../results/postprocess-document';
import type {TrajectoryResult} from '../../results/contracts';
import {ProjectUiScope,useProjectState,useProjectUiScope} from '../../projects/ui-state';
import {emptyScientificData} from '../../results/scientific-contracts';
import PostprocessResultView from '../results/PostprocessResultView';
import {PostprocessSourceCard,PostprocessSourceInformation} from '../results/PostprocessSourcePanels';
import type {AnalysisCanvas} from '../results/analysis-canvas';
import type {PostprocessPlotSnapshot} from '../results/PostprocessPresentation';
import {InputSettingsAction,InputSettingsLayout,InputSettingsSection} from '../InputSettingsLayout';
import {InputSettingsField,InputSettingsRow,InputSettingsStack} from '../InputSettingsFields';
import BaseElectronicStateFields from '../BaseElectronicStateFields';
import ConformerSolventField from './ConformerSolventField';
import {conformerSolvationDraftIssue} from './conformer-solvation-draft';
import {XTB_METHOD_LABELS} from '../../core/xtb-capabilities';
import {electronicStateWarning} from '../../core/elements';
import {advancedElectronicConfirmationMatches,advancedElectronicInputIdentity,advancedElectronicSourceConfirmationKey} from '../../modeling/advanced/electronic-confirmation';
import {submitAdvancedElectronicText} from './electronic-state-sync';
import {assertConfirmedElectronicSnapshot,createElectronicStateDraft,electronicDraftSourceKey,electronicDraftValues,electronicStateDraftForSource,validateElectronicStateDraft,
 type ElectronicStateDraft,type ElectronicStateSourceContext,type ConfirmedElectronicSnapshot,type ElectronicStateDraftField} from '../../modeling/application/electronic-state-draft';
import {compileAdvancedSinglepointOptions,initialAdvancedMethod,type AdvancedMethodDraft} from './AdvancedMethodControls';

/** A captured geometry preview is not a calculated result or saved wavefunction. */
export function xtbAnalysisPreview(source:ElectronicStateSourceContext):PostprocessDocument{
 const key='xtb-preview:'+JSON.stringify(source.ref),structure=structuredClone(source.structure);
 const result:TrajectoryResult={id:key,label:source.label,kind:'calculation',engine:'structure',source:{id:key,name:source.label,size:0},jobIndex:0,status:'unknown',messages:[],
  scientific:emptyScientificData(),initialStructure:structure,frames:[{index:0,sourceFrameIndex:source.ref.sourceFrameIndex,sourceStep:null,time:null,energy:null,convergence:[],sourceLine:0}],
  async getFrame(index,signal){if(signal?.aborted)throw new DOMException('读取已取消。','AbortError');if(index!==0)throw new Error('当前来源只有一个完整帧。');return structuredClone(structure);},dispose(){}};
 return{id:key,result};
}
interface Selection {source?:AdvancedFrameSource;context?:ElectronicStateSourceContext;taskId?:string;runId?:string;capturing?:boolean;captureToken?:number;error?:string}
export interface XtbAnalysisTaskSelection {taskId:string;runId?:string}
export interface XtbAnalysisWorkspaceProps {
 controller:Pick<AdvancedController,'getSnapshot'|'subscribe'|'createTask'|'start'|'stop'>;active:boolean;displayTargetId?:string;
 configurationHost:HTMLElement|null;resultHost:HTMLElement|null;
 computeResources:ComputeResourceValues|null;resourceError?:string;
 analysisBindings:Readonly<Record<string,string>>;documents:Readonly<Record<string,PostprocessDocument>>;
 isAnalysisAvailable?(documentId:string,targetId?:string,taskId?:string,runId?:string):boolean;
 modelDocumentFor?(targetId:string):ModelDocument|undefined;
 display:DisplaySettings;onDisplay(value:DisplaySettings):void;
 onCaptureSource():Promise<AdvancedFrameSource>;
 onCaptureElectronicSource?():Promise<ElectronicStateSourceContext>;
 electronicSourceContext?:ElectronicStateSourceContext;
 electronicDrafts?:Readonly<Record<string,ElectronicStateDraft>>;
 onElectronicDraftChange?(draft:ElectronicStateDraft):void;
 prepareElectronicSource?(source:ElectronicStateSourceContext,draft:ElectronicStateDraft):Promise<ConfirmedElectronicSnapshot|null>;
 taskSelections?:Readonly<Record<string,XtbAnalysisTaskSelection>>;
 onTaskSelectionChange?(targetId:string,selection:XtbAnalysisTaskSelection|undefined):void;
 methodDrafts?:Readonly<Record<string,AdvancedMethodDraft>>;
 onMethodDraftChange?(targetId:string,draft:AdvancedMethodDraft):void;
 onPrepareGeneration?(source:AdvancedFrameSource):Promise<AdvancedFrameSource|null>;
 assertTargetCurrent?(targetId:string):void;
 scientificFrameIdentity?:string;
 scientificFrameReady?:boolean;
 currentScientificFrameIdentity?(targetId:string):string;
 assertConfirmedSourceCurrent?(source:AdvancedFrameSource):void;
 onObserve(source:AdvancedFrameSource):void;
 onCanvas(targetId:string,value:AnalysisCanvas|null):void;
 onAnalysisSelection(targetId:string,documentId:string|undefined):void;
 onOpenPlot(snapshot:PostprocessPlotSnapshot):void;
 onExtract(structure:Structure):void;onPrepareInput(structure:Structure):void;
 onError(message:string):void;
 renderManagedTaskControls?(value:{documentId:string;document:PostprocessDocument;taskId?:string;runId?:string;running:boolean}):ReactNode;
}
const statusLabels={queued:'排队中',running:'单点计算中',stopping:'正在停止',checkpoint:'等待继续',completed:'单点已完成',failed:'计算失败',stopped:'已停止'} as const;

function confirmationSourceIdentity(source:ElectronicStateSourceContext):string{
 return advancedElectronicInputIdentity(source);
}
function savedConfirmationMatches(receipt:string|undefined,source:ElectronicStateSourceContext):boolean{
 if(!receipt)return false;
 if(receipt===confirmationSourceIdentity(source))return true;
 try{
  const old:unknown=JSON.parse(receipt);
  if(!Array.isArray(old)||old.length!==13)return false;
  return advancedElectronicInputIdentity({ref:{...source.ref,documentId:old[0],sourceId:old[1],sourceRevision:old[2],frameId:old[7],sourceFrameIndex:old[8]},structure:source.structure})===confirmationSourceIdentity(source)
   &&old[9]===source.stamp.coordinatesFingerprint&&old[10]===JSON.parse(confirmationSourceIdentity(source))[3]&&JSON.stringify(old[11])===JSON.stringify(source.structure.atoms.map(atom=>atom.id));
 }catch{return false;}
}

/** Retained readers share a project, but never a document/result UI owner. */
export function XtbAnalysisResultScope(p:{ownerId:string;document:PostprocessDocument;children:ReactNode}){
 const parent=useProjectUiScope();
 return <ProjectUiScope store={parent?.store} scope={['document',p.ownerId,'xtb-analysis',p.document.id,p.document.result.id]}>{p.children}</ProjectUiScope>;
}

/** One shared analysis UI, separate from the immutable task/native/source owners. */
export default function XtbAnalysisWorkspace(p:XtbAnalysisWorkspaceProps){
 const gxtbBackend=useGxtbBackend();
 const state=useSyncExternalStore(p.controller.subscribe,p.controller.getSnapshot,p.controller.getSnapshot);
 const [selections,setSelections]=useState<Record<string,Selection>>({}),[methods,setMethods]=useState<Record<string,AdvancedMethodDraft>>({});
 const [electronicDrafts,setElectronicDrafts]=useState<Record<string,ElectronicStateDraft>>({}),[preparingOwners,setPreparingOwners]=useState<Record<string,boolean>>({});
 const electronicDraftEchoes=useRef(new Map<string,ElectronicStateDraft|undefined>());
 const electronicEditSerials=useRef(new Map<string,number>());
 const electronicLastEdits=useRef(new Map<string,ElectronicStateDraftField>());
 const immediateDraft=useRef<ElectronicStateDraft|undefined>(undefined);
 const [confirmations,setConfirmations]=useState<Record<string,{snapshot:ConfirmedElectronicSnapshot;frameIdentity:string}>>({});
 const [savedConfirmations,setSavedConfirmations]=useProjectState<Record<string,string>>('xtb-wavefunction-confirmations',{});
 const latest=useRef(p);latest.current=p;
 const selectedRef=useRef(selections);selectedRef.current=selections;
 const alive=useRef(true),captureEpoch=useRef(0);
 const pendingFrameOwner=useRef<string|undefined>(undefined);
 const activeCapture=useRef<{target:string;epoch:number}|undefined>(undefined);
 const generationInFlight=useRef(new Set<string>());
 const [toolHosts,setToolHosts]=useState<Record<string,HTMLDivElement|null>>({});
 const hostRefs=useRef(new Map<string,(node:HTMLDivElement|null)=>void>()),canvasCallbacks=useRef(new Map<string,(value:AnalysisCanvas|null)=>void>());
 const currentViewCanvasKeys=useRef(new Map<string,string>());
 const previews=useRef(new WeakMap<ElectronicStateSourceContext,PostprocessDocument>());
 const taskOwners=useRef(new Map<string,string>());
 const previewFor=(source:ElectronicStateSourceContext)=>{let value=previews.current.get(source);if(!value){value=xtbAnalysisPreview(source);previews.current.set(source,value);}return value;};
 const hostFor=(id:string)=>{let value=hostRefs.current.get(id);if(!value){value=node=>setToolHosts(previous=>previous[id]===node?previous:{...previous,[id]:node});hostRefs.current.set(id,value);}return value;};
 const canvasFor=(id:string,document:PostprocessDocument,preview:boolean)=>{const key=JSON.stringify([id,document.id,document.result.id,preview]);let value=canvasCallbacks.current.get(key);if(!value){value=canvas=>{
  const current=currentViewCanvasKeys.current.get(id);if(current!==key&&(canvas!==null||current!==undefined))return;
  latest.current.onCanvas(id,canvas&&preview?{...canvas,displayOnlySourcePreview:true,controls:undefined,trajectoryPlayback:undefined}:canvas);
 };canvasCallbacks.current.set(key,value);}return value;};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;captureEpoch.current++;};},[]);
 useEffect(()=>{
  if(!p.modelDocumentFor)return;
  const closed=Object.keys(selectedRef.current).filter(id=>!p.modelDocumentFor!(id));if(!closed.length)return;
  for(const id of closed){hostRefs.current.delete(id);for(const key of canvasCallbacks.current.keys())if(JSON.parse(key)[0]===id)canvasCallbacks.current.delete(key);currentViewCanvasKeys.current.delete(id);latest.current.onCanvas(id,null);}
  setSelections(previous=>{const next={...previous};for(const id of closed)delete next[id];return next;});
 },[p.modelDocumentFor]);
 const capture=useCallback(async()=>{
  const current=latest.current,target=current.displayTargetId;if(!target||!current.active||current.scientificFrameReady===false)return;
  const epoch=++captureEpoch.current;
  activeCapture.current={target,epoch};
  setSelections(previous=>({...previous,[target]:{...previous[target],capturing:true,captureToken:epoch,error:undefined}}));
  try{
   const context=await (current.onCaptureElectronicSource?.()??current.onCaptureSource());
   const source=current.onCaptureElectronicSource?undefined:context as AdvancedFrameSource;
   if(!alive.current||epoch!==captureEpoch.current||!latest.current.active||latest.current.displayTargetId!==target||latest.current.scientificFrameReady===false)return;
   latest.current.assertTargetCurrent?.(target);
   setSelections(previous=>({...previous,[target]:{...previous[target],...(source?{source}:{}),context,capturing:false}}));if(source&&!selectedRef.current[target]?.taskId)current.onObserve(source);
  }catch(error){if(alive.current&&epoch===captureEpoch.current&&latest.current.active&&latest.current.displayTargetId===target&&latest.current.scientificFrameReady!==false)setSelections(previous=>({...previous,[target]:{...(previous[target]?.taskId?previous[target]:{}),capturing:false,error:error instanceof Error?error.message:String(error)}}));}
  finally{
   if(activeCapture.current?.epoch===epoch)activeCapture.current=undefined;
   if(alive.current)setSelections(previous=>previous[target]?.captureToken===epoch&&previous[target].capturing?{...previous,[target]:{...previous[target],capturing:false}}:previous);
  }
 },[]);
 // Fresh, unsubmitted tasks read the actual current scientific frame. Restoring
 // an existing task never replaces its captured source merely due to browsing.
 useEffect(()=>{
  captureEpoch.current++;
  const target=p.displayTargetId;
  const waitedForFrame=!!target&&pendingFrameOwner.current===target;
  pendingFrameOwner.current=p.active&&p.scientificFrameReady===false?target:undefined;
  if(!p.active||!target||p.scientificFrameReady===false)return;
  if((waitedForFrame||!p.electronicSourceContext)&&(p.scientificFrameIdentity!==undefined||!selectedRef.current[target]?.taskId&&!p.taskSelections?.[target]))void capture();
 },[p.active,p.displayTargetId,p.scientificFrameIdentity,p.scientificFrameReady,capture]);
 const requestedTask=p.displayTargetId?p.taskSelections?.[p.displayTargetId]:undefined;
 const requestedTaskKey=requestedTask?JSON.stringify(requestedTask):'';
 useEffect(()=>{
  const target=p.displayTargetId,saved=target?p.taskSelections?.[target]:undefined;if(!target||!saved)return;
  const task=state.tasks.find(row=>row.id===saved.taskId&&row.spec.kind==='singlepoint'&&(row.spec.source.ref.documentId===target||taskOwners.current.get(row.id)===target));
  if(!task||saved.runId&&!task.runs.some(run=>run.id===saved.runId))return;
  const runId=saved.runId??task.runs.at(-1)?.id,current=selectedRef.current[target];if(current?.taskId===saved.taskId&&current.runId===runId)return;
  captureEpoch.current++;setSelections(previous=>({...previous,[target]:{source:task.spec.source,context:task.spec.source,taskId:task.id,runId}}));
 },[p.displayTargetId,requestedTaskKey,state.tasks]);
 const owner=p.displayTargetId,selected=owner?selections[owner]:undefined;
 const preparing=!!owner&&!!preparingOwners[owner];
 const method=owner?p.methodDrafts?.[owner]??methods[owner]??initialAdvancedMethod:initialAdvancedMethod;
 const setMethod=(value:AdvancedMethodDraft)=>{if(owner){setMethods(previous=>({...previous,[owner]:value}));p.onMethodDraftChange?.(owner,structuredClone(value));}};
 const task=state.tasks.find(row=>row.id===selected?.taskId),run=task?.runs.find(row=>row.id===selected?.runId)??task?.runs.at(-1);
 const analysisFor=(id:string|undefined,targetId?:string,taskId?:string,runId?:string)=>id&&p.isAnalysisAvailable?.(id,targetId,taskId,runId)!==false?p.documents[id]:undefined;
 const resultId=task&&run?p.analysisBindings[`${task.id}:${run.id}`]:undefined,result=analysisFor(resultId,owner,task?.id,run?.id);
 useLayoutEffect(()=>{if(owner)p.onAnalysisSelection(owner,p.active&&result?resultId:undefined);},[owner,p.active,resultId,result,p.onAnalysisSelection]);
 const source=selected?.source,context=p.electronicSourceContext??selected?.context??source;
 const sourceKey=context?electronicDraftSourceKey(context):undefined;
 const externalDraft=useMemo(()=>context?electronicStateDraftForSource(context,p.electronicDrafts):undefined,[sourceKey,p.electronicDrafts]);
 // A just-typed value remains visible until its owner publishes a new object.
 // An unchanged controlled seed must not erase '-' before that round trip.
 const draft=context&&sourceKey?(electronicDrafts[sourceKey]&&electronicDraftEchoes.current.has(sourceKey)&&electronicDraftEchoes.current.get(sourceKey)===externalDraft?electronicDrafts[sourceKey]:externalDraft??electronicDrafts[sourceKey]??createElectronicStateDraft(context)):undefined;
 immediateDraft.current=draft;
 const draftError=context&&draft?validateElectronicStateDraft(context,draft):'请先选择一个有效完整帧。';
 const busy=run?.status==='queued'||run?.status==='running'||run?.status==='stopping';
 const frameReady=p.scientificFrameReady!==false;
 const locked=busy||preparing||frameReady&&!!selected?.capturing;
 const visibleDraft=draft;
 const values=visibleDraft?electronicDraftValues(visibleDraft):null;
 const frameIdentity=p.scientificFrameIdentity??sourceKey;
 const confirmed=owner?confirmations[owner]:undefined;
 const confirmedCurrent=!!confirmed&&!!values&&advancedElectronicConfirmationMatches(confirmed.snapshot.confirmationKey,context,values)
  &&values.charge===confirmed.snapshot.charge&&values.multiplicity===confirmed.snapshot.multiplicity;
 const savedConfirmation=owner?savedConfirmations[owner]:undefined;
 const currentConfirmationIdentity=context?confirmationSourceIdentity(context):undefined;
 const solvationIssue=conformerSolvationDraftIssue(method.method,method);
 const sccText=method.sccIterationLimitText??String(method.sccIterationLimit),sccInvalid=!/^\+?\d+$/.test(sccText)||!Number.isSafeInteger(Number(sccText))||Number(sccText)<1;
 function revokeConfirmation(id:string){
  setConfirmations(previous=>{if(!previous[id])return previous;const next={...previous};delete next[id];return next;});
  setSavedConfirmations(previous=>{if(!previous[id])return previous;const next={...previous};delete next[id];return next;});
 }
 // Restore a lightweight receipt by reading the live frame again. No task or
 // model edit is replayed, and only a receipt for this exact source is usable.
 useEffect(()=>{
  if(!p.active||!owner||!context||!frameIdentity||!frameReady||locked||!savedConfirmation)return;
  if(activeCapture.current?.target===owner&&activeCapture.current.epoch===captureEpoch.current)return;
  if(confirmed)return;
  if(!p.currentScientificFrameIdentity||!p.onCaptureElectronicSource||!p.assertConfirmedSourceCurrent)return;
  if(!savedConfirmationMatches(savedConfirmation,context)||!values||draftError||values.charge!==context.structure.charge||values.multiplicity!==context.structure.multiplicity){revokeConfirmation(owner);return;}
  let stopped=false;
  void p.onCaptureElectronicSource().then(actual=>{
   const current=latest.current;
   if(stopped||!alive.current||!current.active||current.displayTargetId!==owner||current.scientificFrameReady===false||current.currentScientificFrameIdentity?.(owner)!==frameIdentity||!savedConfirmationMatches(savedConfirmation,actual))return;
   const source=captureAdvancedFrame(actual.structure,actual.ref,actual.stamp,actual.label,actual.constraints);
   current.assertConfirmedSourceCurrent?.(source);
   const snapshot={source,...values,uhf:values.multiplicity-1,confirmationKey:advancedElectronicSourceConfirmationKey(source,values)};
   setConfirmations(previous=>({...previous,[owner]:{snapshot,frameIdentity}}));
  }).catch(()=>{if(!stopped&&alive.current&&latest.current.scientificFrameReady!==false)revokeConfirmation(owner);});
  return()=>{stopped=true;};
 },[p.active,owner,frameIdentity,frameReady,locked,savedConfirmation,confirmed,confirmedCurrent,currentConfirmationIdentity,draftError]);
 function publishDraft(next:ElectronicStateDraft){
  immediateDraft.current=next;
  electronicDraftEchoes.current.set(next.sourceKey,externalDraft);
  setElectronicDrafts(previous=>({...previous,[next.sourceKey]:next}));p.onElectronicDraftChange?.(structuredClone(next));
 }
 function changeDraft(field:ElectronicStateDraftField,text?:string){
  const current=immediateDraft.current;if(!current||current.sourceKey!==sourceKey)return;
  if(text!==undefined){electronicEditSerials.current.set(current.sourceKey,(electronicEditSerials.current.get(current.sourceKey)??0)+1);electronicLastEdits.current.set(current.sourceKey,field);}
  const next:ElectronicStateDraft={...current,touched:{...current.touched,[field]:text===undefined?true:current.touched[field]},
   ...(text===undefined?{}:field==='charge'?{chargeText:text}:{multiplicityText:text})};
  publishDraft(next);
 }
 function commitDraft(field:ElectronicStateDraftField,text:string){
  const current=immediateDraft.current;if(!context||!current||current.sourceKey!==sourceKey)return current;
  const submitted=submitAdvancedElectronicText(context.structure,{charge:current.chargeText,multiplicity:current.multiplicityText},field,text);
  const next={...current,chargeText:submitted.raw.charge,multiplicityText:submitted.raw.multiplicity,touched:{...current.touched,[field]:true}};
  if(next.chargeText!==current.chargeText||next.multiplicityText!==current.multiplicityText)electronicEditSerials.current.set(current.sourceKey,(electronicEditSerials.current.get(current.sourceKey)??0)+1);
  electronicLastEdits.current.delete(current.sourceKey);publishDraft(next);return next;
 }
 function act(operation:()=>void|Promise<void>){
  const failed=(error:unknown)=>{const message=error instanceof Error?error.message:String(error);if(owner)setSelections(previous=>({...previous,[owner]:{...previous[owner],error:message}}));else p.onError(message);};
  try{const value=operation();if(value)void value.catch(failed);}catch(error){failed(error);}
 }
 async function confirmCurrent(){
  const currentFrameReady=()=>latest.current.scientificFrameReady!==false;
  if(!currentFrameReady())return;
  let submittedDraft=immediateDraft.current;
  const edited=sourceKey&&electronicLastEdits.current.get(sourceKey);
  if(edited&&submittedDraft)submittedDraft=commitDraft(edited,edited==='charge'?submittedDraft.chargeText:submittedDraft.multiplicityText);
  const submittedValues=submittedDraft?electronicDraftValues(submittedDraft):null;
  const submittedError=context&&submittedDraft?validateElectronicStateDraft(context,submittedDraft):draftError;
  if(!p.active||!owner||!context||!submittedDraft||locked||!submittedValues)throw Error(submittedError??'当前帧不可确认。');
  if(submittedError)throw Error(submittedError);
  const draft=submittedDraft,values=submittedValues;
  if(generationInFlight.current.has(owner))return;
  p.assertTargetCurrent?.(owner);
  const epoch=captureEpoch.current, editSerial=electronicEditSerials.current.get(draft.sourceKey)??0,identity=p.currentScientificFrameIdentity?.(owner)??frameIdentity;
  generationInFlight.current.add(owner);
  setPreparingOwners(previous=>({...previous,[owner]:true}));
  setSelections(previous=>({...previous,[owner]:{...previous[owner],error:undefined}}));
  try{
   const actual=await (p.onCaptureElectronicSource?.()??p.onCaptureSource());
   if(!alive.current||!latest.current.active||latest.current.displayTargetId!==owner||!currentFrameReady()||epoch!==captureEpoch.current||(electronicEditSerials.current.get(draft.sourceKey)??0)!==editSerial)return;
   if((latest.current.currentScientificFrameIdentity?.(owner)??frameIdentity)!==identity||electronicDraftSourceKey(actual)!==draft.sourceKey){
    setSelections(previous=>({...previous,[owner]:{...previous[owner],context:actual}}));
    throw Error('当前科学帧已变化，请核对电子态后重新确定。');
   }
   let snapshot:ConfirmedElectronicSnapshot|null;
   if(p.prepareElectronicSource)snapshot=await p.prepareElectronicSource(actual,structuredClone(draft));
   else{
    const prepared=p.onPrepareGeneration?await p.onPrepareGeneration(actual as AdvancedFrameSource):actual as AdvancedFrameSource;
    if(!prepared)return;
    assertAdvancedIsolated(prepared);
    snapshot={source:prepared,...values,uhf:values.multiplicity-1,confirmationKey:advancedElectronicSourceConfirmationKey(prepared,values)};
   }
   if(!snapshot||!alive.current||!latest.current.active||(electronicEditSerials.current.get(draft.sourceKey)??0)!==editSerial)return;
   const target=latest.current.displayTargetId===snapshot.source.ref.documentId?snapshot.source.ref.documentId:owner;
   if(latest.current.displayTargetId!==target)return;
   latest.current.assertTargetCurrent?.(target);
   latest.current.assertConfirmedSourceCurrent?.(snapshot.source);
   assertConfirmedElectronicSnapshot(snapshot,draft);
   const currentIdentity=latest.current.currentScientificFrameIdentity?.(target)??electronicDraftSourceKey(snapshot.source);
   captureEpoch.current++;
   setConfirmations(previous=>({...previous,[target]:{snapshot,frameIdentity:currentIdentity}}));
   setSavedConfirmations(previous=>({...previous,[target]:confirmationSourceIdentity(snapshot.source)}));
   setSelections(previous=>({...previous,[target]:{...previous[target],context:snapshot.source,capturing:false,error:undefined}}));
  }finally{
   generationInFlight.current.delete(owner);
   if(alive.current)setPreparingOwners(previous=>({...previous,[owner]:false}));
  }
 }
 function generate(){
  if(gxtbRunBlocked(gxtbBackend,method.method))throw Error('请先在全局设置中配置可用的 g-xTB 程序。');
  if(latest.current.scientificFrameReady===false)return;
  if(!p.active||!owner||locked||!confirmedCurrent||!confirmed)throw Error('请先确定当前帧及电子态。');
  p.assertTargetCurrent?.(owner);
  if(!context||confirmationSourceIdentity(context)!==confirmationSourceIdentity(confirmed.snapshot.source))throw Error('当前科学帧已变化，请重新确定。');
  // A confirmation accepts q/M for this input; the new job captures the latest
  // valid metadata/constraints, while old jobs keep their original snapshot.
  const prepared=captureAdvancedFrame(context.structure,context.ref,context.stamp,context.label,context.constraints);
  p.assertConfirmedSourceCurrent?.(prepared);assertAdvancedIsolated(prepared);
  if(!p.computeResources)throw Error(p.resourceError??'正在读取全局计算资源。');
  const options=compileAdvancedSinglepointOptions({...method,threads:p.computeResources.threads});
  const taskId=p.controller.createTask({kind:'singlepoint',source:prepared,options}),runId=p.controller.start(taskId);
  captureEpoch.current++;
  taskOwners.current.set(taskId,owner);setSelections(previous=>({...previous,[owner]:{source:prepared,context:prepared,taskId,runId}}));
  p.onTaskSelectionChange?.(owner,{taskId,runId});
 }
 function selectTask(id:string){
  if(!owner||!p.active)return;p.assertTargetCurrent?.(owner);const selected=state.tasks.find(row=>row.id===id&&row.spec.kind==='singlepoint'&&(row.spec.source.ref.documentId===owner||taskOwners.current.get(row.id)===owner));if(!selected)return;
  captureEpoch.current++;setSelections(previous=>({...previous,[owner]:{source:selected.spec.source,context:selected.spec.source,taskId:id,runId:selected.runs.at(-1)?.id}}));p.onObserve(selected.spec.source);
  p.onTaskSelectionChange?.(owner,{taskId:id,runId:selected.runs.at(-1)?.id});
 }
 function chooseTask(id:string){
  if(id){selectTask(id);return;}
  if(!owner||!p.active)return;
  setSelections(previous=>({...previous,[owner]:{context:previous[owner]?.context}}));
  p.onTaskSelectionChange?.(owner,undefined);
 }
 const displayedMethod:AdvancedMethodDraft=busy&&task?.spec.kind==='singlepoint'?{...initialAdvancedMethod,...method,
  method:task.spec.options.method,sccIterationLimitText:undefined,threads:task.spec.options.threads,sccIterationLimit:task.spec.options.maxSccIterations??initialAdvancedMethod.sccIterationLimit,
  solvationModel:task.spec.options.solvation?.model??'none',solvent:task.spec.options.solvation?.solvent??initialAdvancedMethod.solvent}:method;
 const ownedTasks=state.tasks.filter(row=>row.spec.kind==='singlepoint'&&(row.spec.source.ref.documentId===owner||taskOwners.current.get(row.id)===owner));
 const configuration=<section className="postprocess-sidebar workflow-panel-content" aria-label="后处理文件与数值" data-testid="xtb-analysis-workspace" data-source-state={!frameReady||selected?.capturing?'reading':context?'ready':'empty'} data-result-state={result?'ready':run?.status??'uncomputed'} data-result-document-id={resultId??''} hidden={!p.active}>
    <InputSettingsLayout className="postprocess-generation-controls xtb-wavefunction-settings advanced-settings-surface"><InputSettingsStack>
     <InputSettingsSection title="计算设置" sectionKey="xtb-wavefunction-calculation" stack>
     <InputSettingsRow className="xtb-wavefunction-methods">
      <GxtbAvailability method={displayedMethod.method}/><InputSettingsField label="计算级别" controlWidth="select"><select aria-label="XTB计算级别" title={displayedMethod.method==='gxtb'?XTB_METHOD_LABELS.gxtb:XTB_METHOD_LABELS.gfn2} value={displayedMethod.method} disabled={locked} onChange={event=>setMethod({...method,method:event.currentTarget.value as 'gfn2'|'gxtb'})}>
       <option value="gfn2">{XTB_METHOD_LABELS.gfn2}</option><option value="gxtb">{gxtbMethodLabel(gxtbBackend)}</option>
      </select></InputSettingsField>
      <ConformerSolventField method={displayedMethod.method} value={displayedMethod} onChange={value=>setMethod({...method,...value})} ariaLabel="XTB溶剂" disabled={locked}/>
     </InputSettingsRow>
     <BaseElectronicStateFields embedded chargeFieldLabel="电荷" chargeLabel="XTB电荷" multiplicityLabel="XTB自旋多重度"
      charge={values?.charge??NaN} multiplicity={values?.multiplicity??NaN} onChargeChange={()=>{}} onMultiplicityChange={()=>{}} disabled={!context} confirmationDisabled={locked||!frameReady}
      warning={context&&values?electronicStateWarning(context.structure.atoms,values.charge,values.multiplicity):null}
      rawText={visibleDraft?{charge:visibleDraft.chargeText,multiplicity:visibleDraft.multiplicityText}:{charge:'',multiplicity:''}}
      onRawTextChange={changeDraft} onRawTextBlur={field=>changeDraft(field)} onRawTextCommit={commitDraft}
      rawInvalid={{charge:!!visibleDraft&&(!/^[+-]?\d+$/.test(visibleDraft.chargeText)||!Number.isSafeInteger(Number(visibleDraft.chargeText))||!!values&&!!draftError),multiplicity:!!visibleDraft&&(!/^\+?\d+$/.test(visibleDraft.multiplicityText)||!Number.isSafeInteger(Number(visibleDraft.multiplicityText))||Number(visibleDraft.multiplicityText)<1||!!values&&!!draftError)}}
      onConfirm={()=>act(confirmCurrent)} confirmationLabel="确定" confirmButtonText="确定" confirmed={confirmedCurrent}
      error={!busy&&draft&&(draft.touched.charge||draft.touched.multiplicity)?draftError:null}/>
     <InputSettingsRow variant="actions"><InputSettingsAction variant="primary" disabled={gxtbRunBlocked(gxtbBackend,method.method)||!confirmedCurrent||locked||!frameReady||!!solvationIssue||sccInvalid||!p.computeResources} onClick={()=>act(generate)}>生成波函数</InputSettingsAction>
      {busy&&task&&run&&<InputSettingsAction onClick={()=>act(()=>p.controller.stop(task.id,run.id))}>停止单点</InputSettingsAction>}
     </InputSettingsRow>
     <InputSettingsSection title="高级设置" sectionKey="xtb-wavefunction-advanced" level="subcard" collapsible stack>
      <InputSettingsField label="SCC迭代上限"><input className="numeric-input-direct" aria-label="XTB SCC迭代上限" inputMode="numeric" type="text" disabled={locked} aria-invalid={!busy&&sccInvalid||undefined}
       value={busy?String(displayedMethod.sccIterationLimit):sccText} onChange={event=>{const text=event.target.value,number=Number(text);setMethod({...method,sccIterationLimitText:text,...(/^\+?\d+$/.test(text)&&Number.isSafeInteger(number)&&number>0?{sccIterationLimit:number}:{})});}}/></InputSettingsField>
      {!busy&&sccInvalid&&<DismissibleNotice identity={sccText}>SCC迭代上限须为正整数。</DismissibleNotice>}
     </InputSettingsSection>
     </InputSettingsSection>
    </InputSettingsStack></InputSettingsLayout>
    {ownedTasks.length>0&&<InputSettingsLayout><InputSettingsField label="分析任务"><select aria-label="XTB分析任务" disabled={locked} value={task?.id??''} onChange={event=>chooseTask(event.target.value)}><option value="">当前帧 · 新单点</option>{ownedTasks.map((row,index)=><option key={row.id} value={row.id}>单点 {index+1} · {row.spec.source.label}</option>)}</select></InputSettingsField></InputSettingsLayout>}
    {run&&<><p role="status" className="postprocess-note">{statusLabels[run.status]}</p>{run.error&&<DismissibleNotice identity={run.id}>{run.error}</DismissibleNotice>}</>}
    {p.resourceError&&<DismissibleNotice role="alert" className="postprocess-warning">{p.resourceError}</DismissibleNotice>}
    {selected?.error&&<DismissibleNotice role="alert">{selected.error}</DismissibleNotice>}
    {resultId&&!result&&<p role="status">{p.documents[resultId]?'来源结构已修改，撤销后可恢复此分析。':'后处理来源已关闭，任务记录保留。'}</p>}
   {result&&<div className="postprocess-generated-result"><PostprocessSourceCard title="Molden 波函数文件" status="ready"><p className="postprocess-source-name">{result.wavefunction?.source.metadata?.name??result.result.source.name}</p></PostprocessSourceCard>
    <PostprocessSourceInformation result={result.result} currentIndex={0} busy={busy} onExtract={()=>p.onExtract(structuredClone(result.result.initialStructure))} onPrepareInput={()=>p.onPrepareInput(structuredClone(result.result.initialStructure))}/></div>}
   {result&&resultId&&p.renderManagedTaskControls?.({documentId:resultId,document:result,taskId:task?.id,runId:run?.id,running:busy})}
 </section>;
 const views=Object.entries(selections).flatMap(([id,selection])=>{
  const source=selection.context??selection.source;if(!source||p.modelDocumentFor&&!p.modelDocumentFor(id))return[];const savedTask=state.tasks.find(row=>row.id===selection.taskId),savedRun=savedTask?.runs.find(row=>row.id===selection.runId)??savedTask?.runs.at(-1);
  const documentId=savedTask&&savedRun?p.analysisBindings[`${savedTask.id}:${savedRun.id}`]:undefined,document=analysisFor(documentId,id,savedTask?.id,savedRun?.id);
  // Source attachments live in the workspace owner; this is their one shared
  // result display, confined to the advanced XTB2 entry rather than a new tab.
  return[{id,document:document??previewFor(source),preview:!document}];
 });
 currentViewCanvasKeys.current=new Map(views.map(view=>[view.id,JSON.stringify([view.id,view.document.id,view.document.result.id,view.preview])]));
 const resultHosts=<div className="workspace-fill-host" hidden={!p.active} data-testid="xtb-analysis-tools">{!context&&<p role="status">请选择有效完整帧以查看分析工作区。</p>}{views.map(view=><div key={view.id} ref={hostFor(view.id)} className="workspace-fill-host" hidden={view.id!==owner} data-testid="xtb-analysis-tool-host" data-document-id={view.id}/>)}</div>;
 return <>{p.configurationHost?createPortal(configuration,p.configurationHost):configuration}{p.resultHost?createPortal(resultHosts,p.resultHost):resultHosts}
  {views.map(view=><div hidden key={view.id}><XtbAnalysisResultScope ownerId={view.id} document={view.document}><PostprocessResultView document={view.document} modelDocument={p.modelDocumentFor?.(view.id)} geometryPreparation="preserve-source-graph" active={p.active&&view.id===owner} selected={p.active&&view.id===owner} toolHost={toolHosts[view.id]??null} display={p.display} onDisplay={p.onDisplay} onCanvas={canvasFor(view.id,view.document,view.preview)} startEmpty={view.preview} onOpenPlot={p.onOpenPlot} onExtract={p.onExtract} onError={p.onError}/></XtbAnalysisResultScope></div>)}
 </>;
}
