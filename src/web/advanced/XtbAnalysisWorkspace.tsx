import {DismissibleNotice} from '../DismissibleNotice';
import {useCallback,useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {AdvancedController} from '../../modeling/advanced/controller';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {assertAdvancedIsolated} from '../../modeling/advanced/frame-source';
import type {ComputeResourceValues} from '../../modeling/resource-preferences';
import type {DisplaySettings,ModelDocument} from '../../modeling/contracts';
import type {Structure} from '../../core/types';
import type {PostprocessDocument} from '../../results/postprocess-document';
import type {TrajectoryResult} from '../../results/contracts';
import {ProjectUiScope,useProjectUiScope} from '../../projects/ui-state';
import {emptyScientificData} from '../../results/scientific-contracts';
import PostprocessResultView from '../results/PostprocessResultView';
import {PostprocessSourceCard,PostprocessSourceInformation} from '../results/PostprocessSourcePanels';
import {postprocessFileDescription} from '../results/PostprocessSidebar';
import type {AnalysisCanvas} from '../results/analysis-canvas';
import type {PostprocessPlotSnapshot} from '../results/PostprocessPresentation';
import {WorkflowContentCard,WorkflowSessionBar} from '../WorkflowPresentation';
import {InputSettingsAction,InputSettingsLayout} from '../InputSettingsLayout';
import {InputSettingsField} from '../InputSettingsFields';
import BaseElectronicStateFields from '../BaseElectronicStateFields';
import {assertConfirmedElectronicSnapshot,createElectronicStateDraft,electronicDraftSourceKey,electronicDraftValues,validateElectronicStateDraft,
 type ElectronicStateDraft,type ElectronicStateSourceContext,type ConfirmedElectronicSnapshot,type ElectronicStateDraftField} from '../../modeling/application/electronic-state-draft';
import {AdvancedMethodControls,compileAdvancedSinglepointOptions,initialAdvancedMethod,type AdvancedMethodDraft} from './AdvancedMethodControls';

/** A captured geometry preview is not a calculated result or saved wavefunction. */
export function xtbAnalysisPreview(source:ElectronicStateSourceContext):PostprocessDocument{
 const key='xtb-preview:'+JSON.stringify(source.ref),structure=structuredClone(source.structure);
 const result:TrajectoryResult={id:key,label:source.label,kind:'calculation',engine:'structure',source:{id:key,name:source.label,size:0},jobIndex:0,status:'unknown',messages:[],
  scientific:emptyScientificData(),initialStructure:structure,frames:[{index:0,sourceFrameIndex:source.ref.sourceFrameIndex,sourceStep:null,time:null,energy:null,convergence:[],sourceLine:0}],
  async getFrame(index,signal){if(signal?.aborted)throw new DOMException('读取已取消。','AbortError');if(index!==0)throw new Error('当前来源只有一个完整帧。');return structuredClone(structure);},dispose(){}};
 return{id:key,result};
}
interface Selection {source?:AdvancedFrameSource;context?:ElectronicStateSourceContext;taskId?:string;runId?:string;editingElectronic?:boolean;capturing?:boolean;captureToken?:number;error?:string}
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
 onObserve(source:AdvancedFrameSource):void;
 onCanvas(targetId:string,value:AnalysisCanvas|null):void;
 onAnalysisSelection(targetId:string,documentId:string|undefined):void;
 onOpenPlot(snapshot:PostprocessPlotSnapshot):void;
 onExtract(structure:Structure):void;onPrepareInput(structure:Structure):void;
 onError(message:string):void;
 renderManagedTaskControls?(value:{documentId:string;document:PostprocessDocument;taskId?:string;runId?:string;running:boolean}):ReactNode;
}
const statusLabels={queued:'排队中',running:'单点计算中',stopping:'正在停止',checkpoint:'等待继续',completed:'单点已完成',failed:'计算失败',stopped:'已停止'} as const;

/** Retained readers share a project, but never a document/result UI owner. */
export function XtbAnalysisResultScope(p:{ownerId:string;document:PostprocessDocument;children:ReactNode}){
 const parent=useProjectUiScope();
 return <ProjectUiScope store={parent?.store} scope={['document',p.ownerId,'xtb-analysis',p.document.id,p.document.result.id]}>{p.children}</ProjectUiScope>;
}

/** One shared analysis UI, separate from the immutable task/native/source owners. */
export default function XtbAnalysisWorkspace(p:XtbAnalysisWorkspaceProps){
 const state=useSyncExternalStore(p.controller.subscribe,p.controller.getSnapshot,p.controller.getSnapshot);
 const [selections,setSelections]=useState<Record<string,Selection>>({}),[methods,setMethods]=useState<Record<string,AdvancedMethodDraft>>({});
 const [electronicDrafts,setElectronicDrafts]=useState<Record<string,ElectronicStateDraft>>({}),[preparingOwners,setPreparingOwners]=useState<Record<string,boolean>>({});
 const latest=useRef(p);latest.current=p;
 const selectedRef=useRef(selections);selectedRef.current=selections;
 const alive=useRef(true),captureEpoch=useRef(0);
 const generationInFlight=useRef(new Set<string>());
 const [toolHosts,setToolHosts]=useState<Record<string,HTMLDivElement|null>>({});
 const hostRefs=useRef(new Map<string,(node:HTMLDivElement|null)=>void>()),canvasCallbacks=useRef(new Map<string,(value:AnalysisCanvas|null)=>void>());
 const previews=useRef(new WeakMap<ElectronicStateSourceContext,PostprocessDocument>());
 const taskOwners=useRef(new Map<string,string>());
 const previewFor=(source:ElectronicStateSourceContext)=>{let value=previews.current.get(source);if(!value){value=xtbAnalysisPreview(source);previews.current.set(source,value);}return value;};
 const hostFor=(id:string)=>{let value=hostRefs.current.get(id);if(!value){value=node=>setToolHosts(previous=>previous[id]===node?previous:{...previous,[id]:node});hostRefs.current.set(id,value);}return value;};
 const canvasFor=(id:string)=>{let value=canvasCallbacks.current.get(id);if(!value){value=canvas=>latest.current.onCanvas(id,canvas);canvasCallbacks.current.set(id,value);}return value;};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;captureEpoch.current++;};},[]);
 useEffect(()=>{
  if(!p.modelDocumentFor)return;
  const closed=Object.keys(selectedRef.current).filter(id=>!p.modelDocumentFor!(id));if(!closed.length)return;
  for(const id of closed){hostRefs.current.delete(id);canvasCallbacks.current.delete(id);latest.current.onCanvas(id,null);}
  setSelections(previous=>{const next={...previous};for(const id of closed)delete next[id];return next;});
 },[p.modelDocumentFor]);
 const capture=useCallback(async()=>{
  const current=latest.current,target=current.displayTargetId;if(!target||!current.active)return;
  const epoch=++captureEpoch.current;
  setSelections(previous=>({...previous,[target]:{...previous[target],capturing:true,captureToken:epoch,error:undefined}}));
  try{
   const context=await (current.onCaptureElectronicSource?.()??current.onCaptureSource());
   const source=current.onCaptureElectronicSource?undefined:context as AdvancedFrameSource;
   if(!alive.current||epoch!==captureEpoch.current||!latest.current.active||latest.current.displayTargetId!==target)return;
   latest.current.assertTargetCurrent?.(target);
   setSelections(previous=>({...previous,[target]:{source,context,capturing:false}}));current.onTaskSelectionChange?.(target,undefined);if(source)current.onObserve(source);
  }catch(error){if(alive.current&&epoch===captureEpoch.current&&latest.current.active&&latest.current.displayTargetId===target)setSelections(previous=>({...previous,[target]:{...(previous[target]?.taskId?previous[target]:{}),capturing:false,error:error instanceof Error?error.message:String(error)}}));}
  finally{if(alive.current)setSelections(previous=>previous[target]?.captureToken===epoch&&previous[target].capturing?{...previous,[target]:{...previous[target],capturing:false}}:previous);}
 },[]);
 // Fresh, unsubmitted tasks read the actual current scientific frame. Restoring
 // an existing task never replaces its captured source merely due to browsing.
 useEffect(()=>{captureEpoch.current++;if(p.active&&p.displayTargetId&&!selectedRef.current[p.displayTargetId]?.taskId&&!p.taskSelections?.[p.displayTargetId])void capture();},[p.active,p.displayTargetId,capture]);
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
 const source=selected?.source,context=selected?.taskId?selected.context??source:p.electronicSourceContext??selected?.context??source;
 const sourceKey=context?electronicDraftSourceKey(context):undefined;
 const draft=context&&sourceKey?(selected?.taskId&&!selected.editingElectronic?createElectronicStateDraft(context):p.electronicDrafts?.[sourceKey]??electronicDrafts[sourceKey]??createElectronicStateDraft(context)):undefined;
 const draftError=context&&draft?validateElectronicStateDraft(context,draft):'请先选择一个有效完整帧。';
 const shown=result??(context?previewFor(context):undefined);
 const busy=run?.status==='queued'||run?.status==='running'||run?.status==='stopping';
 const locked=busy||preparing||!!selected?.capturing;
 const visibleDraft=busy&&source?createElectronicStateDraft(source):draft;
 const values=visibleDraft?electronicDraftValues(visibleDraft):null;
 function changeDraft(field:ElectronicStateDraftField,text?:string){
  if(!draft||locked)return;
  const next:ElectronicStateDraft={...draft,touched:{...draft.touched,[field]:text===undefined?true:draft.touched[field]},
   ...(text===undefined?{}:field==='charge'?{chargeText:text}:{multiplicityText:text})};
  setElectronicDrafts(previous=>({...previous,[next.sourceKey]:next}));p.onElectronicDraftChange?.(structuredClone(next));
  if(owner&&selected?.taskId)setSelections(previous=>({...previous,[owner]:{...previous[owner],editingElectronic:true}}));
 }
 function act(operation:()=>void|Promise<void>){try{const value=operation();if(value)void value.catch(error=>p.onError(error instanceof Error?error.message:String(error)));}catch(error){p.onError(error instanceof Error?error.message:String(error));}}
 function generate(){
  if(!p.active||!owner||!context||!draft||selected?.capturing)throw new Error('请先选择一个有效完整帧。');
  p.assertTargetCurrent?.(owner);
  if(!p.computeResources)throw new Error(p.resourceError??'正在读取全局计算资源。');
  if(preparing||busy)throw Error('当前单点仍在处理。');
  if(draftError)throw Error(draftError);
  const submit=(prepared:AdvancedFrameSource,target:string)=>{
   if(!alive.current||!latest.current.active||latest.current.displayTargetId!==target)return;
   latest.current.assertTargetCurrent?.(target);assertAdvancedIsolated(prepared);
   const resources=latest.current.computeResources;if(!resources)throw Error(latest.current.resourceError??'正在读取全局计算资源。');
   const options=compileAdvancedSinglepointOptions({...method,threads:resources.threads});
   const taskId=latest.current.controller.createTask({kind:'singlepoint',source:prepared,options}),runId=latest.current.controller.start(taskId);
   captureEpoch.current++;
   taskOwners.current.set(taskId,target);setSelections(previous=>({...previous,[target]:{source:prepared,context:prepared,taskId,runId}}));
   latest.current.onTaskSelectionChange?.(target,{taskId,runId});
  };
  if(p.prepareElectronicSource){
   if(generationInFlight.current.has(owner))return;generationInFlight.current.add(owner);setPreparingOwners(previous=>({...previous,[owner]:true}));
   return Promise.resolve().then(()=>p.prepareElectronicSource!(context,structuredClone(draft))).then(confirmed=>{
    if(!confirmed||!alive.current)return;assertConfirmedElectronicSnapshot(confirmed,draft);submit(confirmed.source,confirmed.source.ref.documentId);
   }).finally(()=>{generationInFlight.current.delete(owner);if(alive.current)setPreparingOwners(previous=>({...previous,[owner]:false}));});
  }
  if(!source||electronicDraftSourceKey(source)!==electronicDraftSourceKey(context)||source.structure.charge!==values?.charge||source.structure.multiplicity!==values?.multiplicity)throw Error('电子态提交入口不可用，请重新取用当前帧。');
  if(p.onPrepareGeneration)return p.onPrepareGeneration(source).then(prepared=>{if(prepared)submit(prepared,prepared.ref.documentId);});
  submit(source,owner);
 }
 function selectTask(id:string){
  if(!id){void capture();return;}
  if(!owner||!p.active)return;p.assertTargetCurrent?.(owner);const selected=state.tasks.find(row=>row.id===id&&row.spec.kind==='singlepoint'&&(row.spec.source.ref.documentId===owner||taskOwners.current.get(row.id)===owner));if(!selected)return;
  if(selected.spec.kind==='singlepoint'){const options=selected.spec.options;setMethod({...initialAdvancedMethod,
   threads:options.threads,sccIterationLimit:options.maxSccIterations??initialAdvancedMethod.sccIterationLimit,
   solvationModel:options.solvation?.model??'none',solvent:options.solvation?.solvent??initialAdvancedMethod.solvent});}
  captureEpoch.current++;setSelections(previous=>({...previous,[owner]:{source:selected.spec.source,context:selected.spec.source,taskId:id,runId:selected.runs.at(-1)?.id}}));p.onObserve(selected.spec.source);
  p.onTaskSelectionChange?.(owner,{taskId:id,runId:selected.runs.at(-1)?.id});
 }
 const sourceInfo=postprocessFileDescription('xtb','wavefunction','molden');
 const displayedMethod:AdvancedMethodDraft=busy&&task?.spec.kind==='singlepoint'?{...initialAdvancedMethod,...method,
  threads:task.spec.options.threads,sccIterationLimit:task.spec.options.maxSccIterations??initialAdvancedMethod.sccIterationLimit,
  solvationModel:task.spec.options.solvation?.model??'none',solvent:task.spec.options.solvation?.solvent??initialAdvancedMethod.solvent}:method;
 const ownedTasks=state.tasks.filter(row=>row.spec.kind==='singlepoint'&&(row.spec.source.ref.documentId===owner||taskOwners.current.get(row.id)===owner));
 const configuration=<section className="postprocess-sidebar workflow-panel-content" aria-label="后处理文件与数值" data-testid="xtb-analysis-workspace" data-source-state={selected?.capturing?'reading':context?'ready':'empty'} data-result-state={result?'ready':run?.status??'uncomputed'} data-result-document-id={resultId??''} hidden={!p.active}>
  <WorkflowSessionBar label="XTB2波函数分析"/>
  <WorkflowContentCard title="计算文件" description="GFN2-xTB / 单点能 SP"><div className="postprocess-file-content engine-step-content">
   <PostprocessSourceCard title={sourceInfo.label} status={result?'ready':busy||selected?.capturing?'reading':run?.status==='failed'?'error':undefined} statusLabel={result?'✓ 已核对':run?statusLabels[run.status]:selected?.capturing?'读取当前帧中':'待生成'} className="postprocess-generated-source">
    <p className="postprocess-note">{sourceInfo.extensions}</p>
    <InputSettingsLayout className="postprocess-generation-controls"><BaseElectronicStateFields embedded chargeFieldLabel="电荷" chargeLabel="XTB2电荷" multiplicityLabel="XTB2自旋多重度"
      charge={values?.charge??NaN} multiplicity={values?.multiplicity??NaN} onChargeChange={()=>{}} onMultiplicityChange={()=>{}} disabled={!context||locked}
      rawText={visibleDraft?{charge:visibleDraft.chargeText,multiplicity:visibleDraft.multiplicityText}:{charge:'',multiplicity:''}}
      onRawTextChange={changeDraft} onRawTextBlur={field=>changeDraft(field)}
      rawInvalid={{charge:!!visibleDraft&&(!/^[+-]?\d+$/.test(visibleDraft.chargeText)||!Number.isSafeInteger(Number(visibleDraft.chargeText))||!!values&&!!draftError),multiplicity:!!visibleDraft&&(!/^\+?\d+$/.test(visibleDraft.multiplicityText)||!Number.isSafeInteger(Number(visibleDraft.multiplicityText))||Number(visibleDraft.multiplicityText)<1||!!values&&!!draftError)}}
      error={!busy&&draft&&(draft.touched.charge||draft.touched.multiplicity)?draftError:null}/>
     <fieldset disabled={locked} style={{border:0,margin:0,padding:0,minWidth:0}}><AdvancedMethodControls prefix="XTB2" value={{...displayedMethod,threads:p.computeResources?.threads??displayedMethod.threads}} onChange={setMethod} singlepoint hideThreads hideMethod/></fieldset>
     <div className="postprocess-actions"><InputSettingsAction variant="primary" disabled={!context||locked||!!draftError||!p.computeResources} onClick={()=>act(generate)}>生成波函数</InputSettingsAction>
      {busy&&task&&run&&<InputSettingsAction onClick={()=>act(()=>p.controller.stop(task.id,run.id))}>停止单点</InputSettingsAction>}
     </div>
    </InputSettingsLayout>
    <p className="postprocess-source-name">{context?.label??(selected?.capturing?'正在读取当前帧…':'当前没有有效完整帧。')}</p>
    <div className="postprocess-actions"><InputSettingsAction disabled={!p.displayTargetId||locked} onClick={()=>void capture()}>更换为当前帧</InputSettingsAction></div>
    {ownedTasks.length>0&&<InputSettingsLayout><InputSettingsField label="分析任务"><select aria-label="XTB2分析任务" value={task?.id??''} onChange={event=>selectTask(event.target.value)}><option value="">当前帧 · 新单点</option>{ownedTasks.map((row,index)=><option key={row.id} value={row.id}>单点 {index+1} · {row.spec.source.label}</option>)}</select></InputSettingsField></InputSettingsLayout>}
    {result&&<p className="postprocess-source-name">{result.wavefunction?.source.metadata?.name??result.result.source.name}</p>}
    {run&&<><p role="status" className="postprocess-note">{statusLabels[run.status]}</p>{run.error&&<DismissibleNotice identity={run.id}>{run.error}</DismissibleNotice>}</>}
    {p.resourceError&&<DismissibleNotice role="alert" className="postprocess-warning">{p.resourceError}</DismissibleNotice>}
    {selected?.error&&<DismissibleNotice role="alert">{selected.error}</DismissibleNotice>}
    {resultId&&!result&&<p role="status">{p.documents[resultId]?'来源结构已修改，撤销后可恢复此分析。':'后处理来源已关闭，任务记录保留。'}</p>}
   </PostprocessSourceCard>
   {shown&&<PostprocessSourceInformation result={shown.result} currentIndex={0} busy={busy} onExtract={()=>p.onExtract(structuredClone(shown.result.initialStructure))} onPrepareInput={()=>p.onPrepareInput(structuredClone(shown.result.initialStructure))}/>}
   {result&&resultId&&p.renderManagedTaskControls?.({documentId:resultId,document:result,taskId:task?.id,runId:run?.id,running:busy})}
  </div></WorkflowContentCard>
 </section>;
 const views=Object.entries(selections).flatMap(([id,selection])=>{
  const source=selection.context??selection.source;if(!source||p.modelDocumentFor&&!p.modelDocumentFor(id))return[];const savedTask=state.tasks.find(row=>row.id===selection.taskId),savedRun=savedTask?.runs.find(row=>row.id===selection.runId)??savedTask?.runs.at(-1);
  const documentId=savedTask&&savedRun?p.analysisBindings[`${savedTask.id}:${savedRun.id}`]:undefined,document=analysisFor(documentId,id,savedTask?.id,savedRun?.id);
  // Source attachments live in the workspace owner; this is their one shared
  // result display, confined to the advanced XTB2 entry rather than a new tab.
  return[{id,document:document??previewFor(source)}];
 });
 const resultHosts=<div className="workspace-fill-host" hidden={!p.active} data-testid="xtb-analysis-tools">{!context&&<p role="status">请选择有效完整帧以查看分析工作区。</p>}{views.map(view=><div key={view.id} ref={hostFor(view.id)} className="workspace-fill-host" hidden={view.id!==owner} data-testid="xtb-analysis-tool-host" data-document-id={view.id}/>)}</div>;
 return <>{p.configurationHost?createPortal(configuration,p.configurationHost):configuration}{p.resultHost?createPortal(resultHosts,p.resultHost):resultHosts}
  {views.map(view=><div hidden key={view.id}><XtbAnalysisResultScope ownerId={view.id} document={view.document}><PostprocessResultView document={view.document} modelDocument={p.modelDocumentFor?.(view.id)} geometryPreparation="preserve-source-graph" active={p.active&&view.id===owner} selected={p.active&&view.id===owner} toolHost={toolHosts[view.id]??null} display={p.display} onDisplay={p.onDisplay} onCanvas={canvasFor(view.id)} onOpenPlot={p.onOpenPlot} onExtract={p.onExtract} onError={p.onError}/></XtbAnalysisResultScope></div>)}
 </>;
}
