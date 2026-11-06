import {useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {AdvancedController} from '../../modeling/advanced/controller';
import type {AdvancedTaskSpec,AdvancedRunStatus,AdvancedTaskRun,AdvancedSameFrameFragments,AdvancedOptimizationStageConfig,AdvancedResultFrame,AdvancedTaskRecord} from '../../modeling/advanced/contracts';
import {DEFAULT_ADVANCED_RUN_BUDGET} from '../../modeling/advanced/contracts';
import type {ConformerResultCollection} from '../../modeling/conformers/trajectory';
export type {ConformerResultCollection} from '../../modeling/conformers/trajectory';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {sameAdvancedFrame} from '../../modeling/advanced/frame-source';
import {createConformerSnapshot,discoverConformerTorsionRows,inspectManualConformerTorsion,inspectConformerTorsion,allocateConformerTorsionPoints,conformerTorsionCombinationCount,planConformerTorsionHierarchy,createConformerTorsionPreview,orderConformerTorsionFrames,type TorsionAtoms} from '../../modeling/conformers';
import {overrideAdvancedTaskSource} from './capture-source';
import {baseElectronicStateError} from '../../core/base-electronic-state';
import {molecularFormula} from '../../core/elements';
import {ScientificDataTable} from '../results/ScientificDataTable';
import {InputSettingsCard,InputSettingsField,InputSettingsRow} from '../InputSettingsFields';
import {InputSettingsLayout,InputSettingsAction,InputSettingsCheckbox,InputSettingsSection} from '../InputSettingsLayout';
import {WorkflowSessionBar,WorkflowContentCard} from '../WorkflowPresentation';
import {compileAdvancedMethod,initialAdvancedMethod} from './AdvancedMethodControls';
import type {AnalysisAtomCapture} from '../modeling/ModelViewport';
import {useAnalysisAtomCapture} from '../results/useAnalysisAtomCapture';
import {AdvancedPathControls,AdvancedSamplingControls,AdvancedRegionField} from './AdvancedProcessControls';
import {compilePath,compileSampling,initialPathDraft,initialSamplingDraft,changeSamplingOperation} from './process-config';
import {suggestConformerSamplingSphere} from '../../modeling/advanced/sampling-contracts';
import {advancedFrameCollections,advancedFrameTable,processStageLabel,advancedCheckpointAvailable,advancedSamplingTimeProgress,advancedConformerWorkProgress,advancedOptimizationTimeProgress} from './advanced-process-presentation';
import {conformerSamplingSchedule,conformerSamplingBudgetPlan,conformerWorkProgressLabel} from '../../modeling/advanced/sampling-progress';
import {createSamplingSphereDraft,applySamplingSphereRadiusChange,sameSamplingSphereSource,type SamplingSphereDraft,type SamplingSphereRadiusChange} from '../../modeling/advanced/sampling-sphere';
import SamplingSphereEditor from './SamplingSphereEditor';
import {observeSamplingTime,samplingTimeEstimate,samplingRemainingLabel,samplingFinishLabel,type SamplingTimeObservation} from './sampling-time-estimate';

import {createAdvancedDisplay,retainedDisplayFrames,sameDisplaySource,type AdvancedDisplayFit,type AdvancedCanvasLayers,type AdvancedSourceCollectionInfo} from './advanced-display';
import {activateMultiframeDisplay,validateSamplingSphereDisplay,type MultiframeDisplayPlan} from '../../modeling/view-multiframe';
import {trajectoryIndices} from '../../results/contracts';
import {initialDockingDraft} from './AdvancedDockingControls';
import AdvancedWorkflowNavigation,{type AdvancedSection,type ConformerSamplingChoice} from './AdvancedWorkflowNavigation';
import ConformerOptimizationStages,{type ConformerOptimizationDraft} from './ConformerOptimizationStages';
import {buildAdvancedClusterCollection,conformerUpstreamSummary} from '../../modeling/advanced/conformer-cluster-collection';
import ConformerTorsionControls,{type ConformerTorsionDraft} from './ConformerTorsionControls';
import ConformerStageResults from './ConformerStageResults';
import {restoreConformerTaskDraft} from './conformer-draft-hydration';
import {convertEnergy} from '../../results/energy';
import type {AdvancedInputTemplate} from '../../modeling/application/advanced-frame-output';
import type {AdvancedOutputBridge} from '../../modeling/advanced/output-contracts';
import AdvancedFrameOutputControls from './AdvancedFrameOutputControls';
import MixedConformerWorkspace from './MixedConformerWorkspace';
import NumericInput from '../NumericInput';
import {DismissibleNotice} from '../DismissibleNotice';
import {advancedElectronicConfirmationKey,advancedElectronicDraftState,validAdvancedElectronicDraft,type AdvancedElectronicState} from './electronic-state-sync';
import './advanced-workspace.css';

export interface AdvancedWorkspaceProps {
 contextKey?:string;contextTaskId?:string;onTaskCreated?(taskId:string,source:AdvancedFrameSource):void;
 onPrepareNewTaskSource?(source:AdvancedFrameSource):Promise<AdvancedFrameSource|null>;
 onReadConformerInitialSource?(taskId:string):AdvancedFrameSource;
 onConformerElectronicStateChange?(taskId:string,initialId:string,source:AdvancedFrameSource,state:AdvancedElectronicState):void;
 onConformerInitialFrame?(taskId:string,initialId:string,source:AdvancedFrameSource):void;
 activeConformerInitial?:{taskId:string;initialId:string};
 onProtectionChange?(source:AdvancedFrameSource,atomIds:readonly string[]):void;sourceProtectionAtomIds?:readonly string[];
 onCommitConformerCoreChange?(taskId:string,atomIds:readonly string[]):Promise<boolean>|boolean;
 onElectronicStateChange?(source:AdvancedFrameSource,state:AdvancedElectronicState):void;sourceElectronicState?:AdvancedElectronicState;
 controller:AdvancedController;
 active:boolean;
 activeSection?:AdvancedSection|null;onSectionChange?(section:AdvancedSection|null):void;navigationInShell?:boolean;
 samplingOperation?:ConformerSamplingChoice|null;onSamplingOperationChange?(value:ConformerSamplingChoice|null):void;
 onOpenConformerCollection?(collection:ConformerResultCollection,frameId?:string,options?:{activate?:boolean}):void;
 activeConformerFrame?:{taskId:string;collectionId:string;frameId:string};
 onConformerFrameOrder?(collectionId:string,frames:readonly AdvancedResultFrame[]):void;
 onConformerViewControls?(controls:ReactNode|undefined):void;
 onSphereDraft?(draft:SamplingSphereDraft|undefined):void;sphereRadiusChange?:SamplingSphereRadiusChange|null;
 computeResources?:{threads:number;memoryBudgetBytes:number}|null;
 onTaskHighlights?(value:{source:AdvancedFrameSource;atomIds:readonly string[]}|undefined):void;
 displayTargetId?:string;
 displayedSource?:AdvancedFrameSource;
 onCaptureProjection?(capture:AnalysisAtomCapture|undefined):void;
 onDisplayLayers?(layers:AdvancedCanvasLayers|undefined):void;
 sourceCollectionInfo?(source:AdvancedFrameSource):AdvancedSourceCollectionInfo|undefined;
 onReadSourceCollection?(source:AdvancedFrameSource,indices:number[],signal?:AbortSignal):Promise<AdvancedFrameSource[]>;
 onCaptureInputTemplate?():AdvancedInputTemplate|undefined;
 outputBridge?:AdvancedOutputBridge|null;
 configurationHost:HTMLElement|null;
 resultHost:HTMLElement|null;
 onCaptureSource():Promise<AdvancedFrameSource>;
 onCaptureInitialSource?():Promise<AdvancedFrameSource>;
 onObserve(source:AdvancedFrameSource):void;
 onExtract(source:AdvancedFrameSource):void;
 onPrepareInput(source:AdvancedFrameSource):void;
 onPrepareBatchInput?(sources:readonly AdvancedFrameSource[],coreIds:readonly string[],activeFrameId?:string):void|Promise<void>;
 onOpenAnalysis?(taskId:string,runId:string):void;
 onError(message:string):void;
}
/** Progress-only snapshots do not change a fixed result collection. */
export function conformerCollectionRevision(task:AdvancedTaskRecord|undefined):string {
 if(!task)return '';
 const workflow=task.conformerWorkflow;
 return JSON.stringify([task.id,workflow?.candidateSet?.id,workflow?.candidateSet?.producerRunId,workflow?.candidateSet?.revision,workflow?.candidateSet?.valid,
  workflow?.candidateSet?.frameIds,workflow?.stages.map(stage=>[stage.stageId,stage.producerRunId,stage.stageRunId,stage.collectionId,stage.revision,stage.valid,stage.completed,stage.representativeFrameIds,stage.resultFrameIds])]);
}
/** Activate only this run's published nonempty result, including a real stop.
 * An empty optimization stage must not redirect to a different stage/run. */
export function conformerTerminalResultCollection(collections:readonly ConformerResultCollection[],run:AdvancedTaskRun|undefined):ConformerResultCollection|undefined {
 if(!run||!['completed','checkpoint','stopped'].includes(run.status))return;
 const owned=collections.filter(collection=>collection.frames.length>0&&collection.identity.runId===run.id);
 return run.intent==='sampling'?owned.find(collection=>!collection.includeEnergies):owned.filter(collection=>collection.includeEnergies).at(-1);
}
/** New batches read the task's initial document even from a result tab. Existing
 * continuation keeps its captured batch/last-frame source. */
export function refreshConformerSamplingInitial(controller:Pick<AdvancedController,'updateInitialSource'|'getSnapshot'>,task:AdvancedTaskRecord,mode:'continue'|'append'|'restart',read?:AdvancedWorkspaceProps['onReadConformerInitialSource']):AdvancedTaskRecord {
 if((mode!=='continue'||!task.mixedSampling?.currentBatchId)&&read)controller.updateInitialSource(task.id,read(task.id));
 return controller.getSnapshot().tasks.find(value=>value.id===task.id)??task;
}
export function buildConformerResultCollections(task:AdvancedTaskRecord|undefined,stages:readonly ConformerOptimizationDraft[],previous:readonly ConformerResultCollection[]=[]):ConformerResultCollection[]{
 if(!task)return[];
 const workflow=task.conformerWorkflow,allFrames=[...task.guessFrames,...task.runs.flatMap(run=>run.frames)],frameMap=new Map(allFrames.map(frame=>[frame.id,frame]));
 const candidates=workflow?.candidateSet,frames=candidates?.frameIds.flatMap(id=>frameMap.has(id)?[frameMap.get(id)!]:[])??[];
 const producer=candidates?.producerRunId??frames[0]?.runId??task.runs.slice().reverse().find(run=>run.intent==='sampling'||run.sampling)?.id??candidates?.id??'';
 const candidateId=candidates?.id??`pending:${task.id}:sampling`;
 const result:ConformerResultCollection[]=[{id:candidateId,label:'采样轨迹',frames,identity:{taskId:task.id,runId:producer,stageId:frames[0]?.stageId??'sampling',collectionId:candidateId},includeEnergies:false}];
 for(const [index,configuration] of stages.entries()){
  const stage=workflow?.stages.find(row=>row.stageId===configuration.id);
  const id=stage?.collectionId??`pending:${task.id}:${configuration.id}`;
  const pendingRun=task.runs.slice().reverse().find(run=>run.stages.some(row=>row.configurationId===configuration.id||row.id===configuration.id)),pendingStage=pendingRun?.stages.find(row=>row.configurationId===configuration.id||row.id===configuration.id);
  const clusterCollection=stage?buildAdvancedClusterCollection(task,configuration.id):undefined;
  const available=clusterCollection?.clusters.flatMap(row=>!row.unavailableReason&&row.representativeFrameId&&frameMap.has(row.representativeFrameId)?[frameMap.get(row.representativeFrameId)!]:[])??[];
  const label=`优化${index+1}归簇`;
  result.push({id,label,frames:available,clusterCollection,playbackAvailable:!clusterCollection?.clusters.some(row=>row.unavailableReason||!row.representativeFrameId)&&clusterCollection?.settlement!=='needs-clustering',identity:{taskId:task.id,runId:stage?.producerRunId??pendingRun?.id??'',stageId:stage?.stageRunId??pendingStage?.id??configuration.id,collectionId:id},includeEnergies:true});
 }
 const retained=new Map(previous.map(collection=>[collection.id,collection]));
 return result.map(collection=>{const old=retained.get(collection.id);return old&&JSON.stringify(old.clusterCollection)===JSON.stringify(collection.clusterCollection)&&old.label===collection.label&&old.includeEnergies===collection.includeEnergies&&old.identity.runId===collection.identity.runId&&old.identity.stageId===collection.identity.stageId&&old.frames.length===collection.frames.length&&old.frames.every((frame,index)=>frame.id===collection.frames[index].id&&frame.energyHartree===collection.frames[index].energyHartree&&frame.source.stamp.coordinatesFingerprint===collection.frames[index].source.stamp.coordinatesFingerprint)?old:collection;});
}
const STATUS:Record<AdvancedRunStatus,string>={queued:'排队中',running:'运行中',stopping:'正在停止',checkpoint:'等待继续',completed:'已完成',failed:'失败',stopped:'已停止'};
const DOCKING_PHASES:Record<string,string>={'monomer-precomputation':'单体预计算',screening:'初筛','stack-search':'堆叠搜索','angular-search':'角度搜索','genetic-search':'遗传搜索','native-refinement':'原生精化'};
const TASK_LABELS:Record<AdvancedTaskSpec['kind'],string>={singlepoint:'GFN2 单点后处理',optimization:'独立结构优化','conformer-search':'柔性键构象搜索',path:'反应路径',sampling:'构象采样',docking:'双分子对接'};
type ConfiguredTaskKind='path'|'sampling'|'conformer-search'|'docking';
const DOCKING_PAUSED='本版已暂停双分子对接；历史结果仍可浏览，可选择其他采样方式新建任务。';
const EMPTY_CAPTURE_STRUCTURE={id:'advanced-empty',name:'',format:'xyz' as const,notes:[],atoms:[],charge:null,multiplicity:null};
const sameTaskGeometrySource=(a:AdvancedFrameSource|null|undefined,b:AdvancedFrameSource|null|undefined)=>Boolean(a&&b&&sameAdvancedFrame(a.ref,b.ref)&&a.stamp.coordinatesFingerprint===b.stamp.coordinatesFingerprint);
export function conformerSamplingConfigKey(spec:AdvancedTaskSpec):string{
 const source={ref:spec.source.ref,stamp:spec.source.stamp};
 if(spec.kind==='sampling'){const{threads,memoryBudgetBytes,...sampling}=spec.sampling;return JSON.stringify({kind:spec.kind,source,sampling});}
 if(spec.kind==='docking'){const{threads,...docking}=spec.docking;return JSON.stringify({kind:spec.kind,source,fragments:spec.fragments,docking});}
 if(spec.kind==='conformer-search'){const{stages,checkpointAfterGuesses,...search}=spec.search;return JSON.stringify({kind:spec.kind,source,search});}
 return '';
}
export function AdvancedDockingProgress({docking}:{docking:NonNullable<AdvancedTaskRun['docking']>}){
 const failure=docking.nativeRefinement,terminal=docking.terminal;
 const acceptedSearch=Boolean(docking.acceptedSearchCheckpoint);
 const raw=failure?JSON.stringify({nativeRefinement:failure,...terminal&&'diagnosticDirectory'in terminal?{diagnosticDirectory:terminal.diagnosticDirectory}:{},...terminal&&'artifacts'in terminal?{artifacts:terminal.artifacts}:{}},null,2):null;
 return <InputSettingsSection level="subcard" title="对接过程" collapsible defaultOpen>
  <p className="muted-note" role="status">{acceptedSearch&&failure?'原生精修失败，使用完整搜索候选继续优化':DOCKING_PHASES[docking.phaseEvents.at(-1)?.phase??'']??'等待对接'} · 物理求值次数未报告</p>
  {failure&&!acceptedSearch&&<DismissibleNotice role="alert">原生精修失败</DismissibleNotice>}
  {docking.rejectedCompletion&&<DismissibleNotice role="alert">{docking.rejectedCompletion.reason}</DismissibleNotice>}
  {raw&&<InputSettingsSection level="inline" title="原生精修详情" collapsible><InputSettingsField label="原始详情"><textarea aria-label="aISS原生精修原始详情" readOnly rows={8} value={raw}/></InputSettingsField></InputSettingsSection>}
 </InputSettingsSection>;
}
export function AdvancedSamplingTimeRemaining(p:{controller:Pick<AdvancedController,'getSnapshot'|'subscribe'>;taskId:string;runId:string;active:boolean;stageId?:string}){
 const read=()=>p.stageId?advancedOptimizationTimeProgress(p.controller.getSnapshot(),p.taskId,p.runId,p.stageId):advancedSamplingTimeProgress(p.controller.getSnapshot(),p.taskId,p.runId);
 const observation=useRef<SamplingTimeObservation|null>(null),[,refresh]=useState(0);
 useEffect(()=>{
  observation.current=null;
  const sample=()=>{const progress=read(),next=observeSamplingTime(observation.current,progress,performance.now(),Date.now());if(next!==observation.current){observation.current=next;refresh(value=>value+1);}};
  sample();return p.controller.subscribe(sample);
 },[p.controller,p.taskId,p.runId,p.stageId]);
 const progress=read();
 useEffect(()=>{if(!p.active||!progress)return;const timer=setInterval(()=>refresh(value=>value+1),1000);return()=>clearInterval(timer);},[p.active,progress?.identity]);
 if(!p.active||!progress)return null;
 const epochMs=Date.now(),atMs=performance.now(),estimate=samplingTimeEstimate(observation.current,progress,atMs,epochMs);
 return <p className="muted-note" role="status" aria-label="本次采样时间估计">预计剩余：{estimate?.kind==='ready'?<>{samplingRemainingLabel(estimate.remainingMs)} · 预计完成（本地）：<time dateTime={new Date(estimate.finishEpochMs).toISOString()}>{samplingFinishLabel(estimate.finishEpochMs,epochMs)}</time></>:estimate?.kind==='awaiting-receipt'?'等待结束回执':'估算中'}</p>;
}
export function ConformerWorkProgressDisplay(p:{controller:AdvancedController;taskId:string;run:AdvancedTaskRun;stageId?:string;active:boolean;onStop():void;summary?:'default'|'phase';showStop?:boolean}){
 const progress=advancedConformerWorkProgress(p.controller.getSnapshot(),p.taskId,p.run.id,p.stageId);
 const stage=p.stageId?p.run.stages.find(row=>row.id===p.stageId||row.configurationId===p.stageId):undefined;
 if(!progress&&!['queued','running','stopping','failed','stopped'].includes(p.run.status))return null;
 const running=['queued','running','stopping'].includes(p.run.status);
 return <div className="conformer-work-progress" data-testid={p.stageId?`conformer-progress-${p.stageId}`:'conformer-sampling-progress'}>
  <div className="conformer-progress-row"><p role="status">{p.summary==='phase'?STATUS[p.run.status]:progress?conformerWorkProgressLabel(progress):STATUS[p.run.status]}{progress?.phase==='finishing'?' · 正在收尾':p.run.status==='stopping'?' · 正在停止':''}</p>{running&&p.showStop!==false&&<button type="button" className="shared-input-action conformer-stop-action" disabled={p.run.status==='stopping'} onClick={p.onStop}>{p.run.status==='stopping'?'正在停止':'停止'}</button>}</div>
  {progress?.total!==null&&progress?.total!==undefined&&progress.total>0&&<progress aria-label={p.stageId?'优化处理进度':'采样帧进度'} max={progress.total} value={Math.min(progress.total,progress.completed)}/>}
  {p.run.backgroundProgress&&<><p role="status">{p.run.backgroundProgress.phase==='generate'?'柔性键生成':p.run.backgroundProgress.phase==='deduplicate'?'候选去重':'结果归簇'} · 已处理 {p.run.backgroundProgress.completed}{p.run.backgroundProgress.total===null?'':`/${p.run.backgroundProgress.total}`}</p><progress aria-label="后台处理进度" max={p.run.backgroundProgress.total??undefined} value={p.run.backgroundProgress.total===null?undefined:p.run.backgroundProgress.completed}/></>}
  {running&&<AdvancedSamplingTimeRemaining controller={p.controller} taskId={p.taskId} runId={p.run.id} stageId={p.stageId} active={p.active}/>}
  {p.run.error&&<DismissibleNotice identity={p.run.id}>{p.run.error}</DismissibleNotice>}{p.run.stopReason&&<p role="status">{p.run.stopReason}</p>}
 </div>;
}
/** Persistent configuration and task browsing; the shell owns the only canvas. */
export default function AdvancedWorkspace(p:AdvancedWorkspaceProps){
 if(p.activeSection==='conformer')return <MixedConformerWorkspace key={p.contextTaskId??p.contextKey??'mixed-default'} {...p}/>;
 return <LegacyAdvancedWorkspace {...p}/>;
}
function LegacyAdvancedWorkspace(p:AdvancedWorkspaceProps){
 const state=useSyncExternalStore(p.controller.subscribe,p.controller.getSnapshot,p.controller.getSnapshot);
 const [source,setSource]=useState<AdvancedFrameSource|null>(null),[capturing,setCapturing]=useState(false);
 const [electronicDraft,setElectronicDraft]=useState<{charge:number;multiplicity:number}>({charge:0,multiplicity:1});
 const [confirmedElectronic,setConfirmedElectronic]=useState('');
 const electronicConfirmationKey=advancedElectronicConfirmationKey(source,electronicDraft),electronicConfirmed=confirmedElectronic===electronicConfirmationKey;
 const captureRequest=useRef(0),autoCaptureAttempt=useRef('');
 const hydration=useRef<{taskId:string;key?:string}|null>(null),restoredTorsionSource=useRef<AdvancedFrameSource|null>(null);
 const restoredClustering=useRef(new Map<string,{displayValue:number;clustering:AdvancedOptimizationStageConfig['clustering']}>());
 const [historicalReason,setHistoricalReason]=useState('');
 const [localSection,setLocalSection]=useState<AdvancedSection|null>(null),section=p.activeSection===undefined?localSection:p.activeSection;
 const [localSamplingOperation,setLocalSamplingOperation]=useState<ConformerSamplingChoice|null>(null),samplingOperation=p.samplingOperation===undefined?localSamplingOperation:p.samplingOperation;
 const changeSection=(value:AdvancedSection|null)=>{setLocalSection(value);p.onSectionChange?.(value);};
 useEffect(()=>{setCapturing(false);return()=>{captureRequest.current++;autoCaptureAttempt.current='';};},[p.active,p.displayTargetId,section]);
 const [kind,setKind]=useState<ConfiguredTaskKind>('sampling');
 const lastConformerKind=useRef<Exclude<ConfiguredTaskKind,'path'>>('sampling');
 const points=3,[candidateLimit,setCandidateLimit]=useState(2000),[expectedTarget,setExpectedTarget]=useState<number|null>(2000),[targetText,setTargetText]=useState('2000');
 const [hoverTorsion,setHoverTorsion]=useState<string|null>(null),[previewTorsion,setPreviewTorsion]=useState<string|null>(null);
 const [torsionRows,setTorsionRows]=useState<ConformerTorsionDraft[]>([]),[activeTorsion,setActiveTorsion]=useState(''),[taskId,setTaskId]=useState<string|null>(null),[selectedFrame,setSelectedFrame]=useState<{targetId?:string;id:string}|null>(null),[runId,setRunId]=useState<string|null>(null);
 const frameId=p.activeConformerFrame?.taskId===taskId?p.activeConformerFrame.frameId:selectedFrame?.targetId===p.displayTargetId?selectedFrame?.id:null;
 const setFrameId=(id:string|null)=>setSelectedFrame(id?{targetId:p.displayTargetId,id}:null);
 const [stages,setStages]=useState<ConformerOptimizationDraft[]>([{id:'stage-1',method:{...initialAdvancedMethod,maxSteps:500},energyThresholdKcalMol:.25,rmsdThresholdAngstrom:.1,rmsdMatching:'symmetry',inputStride:1,advanceCount:10,checkpointAfter:true}]);
 const [path,setPath]=useState({...initialPathDraft}),[sampling,setSampling]=useState({...initialSamplingDraft}),[product,setProduct]=useState<AdvancedFrameSource|null>(null),[collectionId,setCollectionId]=useState('');
 const [sphereDraft,setSphereDraft]=useState<SamplingSphereDraft|null>(null);
 const pendingCompletion=useRef<{taskId:string;runId:string;targetId?:string;source:AdvancedFrameSource;stageId?:string;sampling:boolean}|null>(null);
 const chooseSampling=(value:ConformerSamplingChoice|null)=>{setLocalSamplingOperation(value);p.onSamplingOperationChange?.(value);if(value===null)return;if(kind==='docking'){hydration.current=null;setHistoricalReason('');setTaskId(null);setRunId(null);setFrameId(null);}if(value==='conformer-search'){lastConformerKind.current=value;setKind(value);}else{lastConformerKind.current='sampling';setKind('sampling');setSampling(previous=>previous.operation===value?previous:changeSamplingOperation(previous,value));}};
 useEffect(()=>{if(samplingOperation!==null){if(samplingOperation==='conformer-search'){lastConformerKind.current='conformer-search';setKind('conformer-search');}else{lastConformerKind.current='sampling';setKind('sampling');setSampling(previous=>previous.operation===samplingOperation?previous:changeSamplingOperation(previous,samplingOperation));}}},[samplingOperation]);
 const [docking,setDocking]=useState({...initialDockingDraft});
 const [fragments,setFragments]=useState<AdvancedSameFrameFragments>({aAtomIds:[],bAtomIds:[],electronicStates:[{charge:0,multiplicity:1},{charge:0,multiplicity:1}]}),[fragmentStatesConfirmed,setFragmentStatesConfirmed]=useState(false);
 const [inputTemplate,setInputTemplate]=useState<AdvancedInputTemplate|null>(null);
 const [displayMode,setDisplayMode]=useState<AdvancedDisplayFit>('raw'),[displayRange,setDisplayRange]=useState<{key:string;start:number;end:number}>({key:'',start:0,end:0}),[displayError,setDisplayError]=useState('');
 const [displayStride,setDisplayStride]=useState(1);
 const [overlay,setOverlay]=useState<{targetId?:string;collectionId:string;plan:MultiframeDisplayPlan;source:AdvancedFrameSource}|null>(null),[spherePreview,setSpherePreview]=useState<{targetId?:string;source:AdvancedFrameSource}|null>(null);
 const [sourceRange,setSourceRange]=useState<{key:string;start:number;end:number}>({key:'',start:0,end:0}),[sourceFrames,setSourceFrames]=useState<{collectionId:string;frames:{id:string;source:AdvancedFrameSource}[]}|null>(null),[readingFrames,setReadingFrames]=useState(false);
 const displayReadEpoch=useRef(0),displayAlive=useRef(true),displayReadAbort=useRef<AbortController|null>(null);useEffect(()=>{displayAlive.current=true;return()=>{displayAlive.current=false;displayReadEpoch.current++;displayReadAbort.current?.abort();};},[]);
 useEffect(()=>{displayReadEpoch.current++;displayReadAbort.current?.abort();displayReadAbort.current=null;setReadingFrames(false);},[p.active,p.displayTargetId,source]);
 const currentSource=source;
 function acceptSphereDraft(next:SamplingSphereDraft){if(!currentSource||!sameSamplingSphereSource(next,{sourceDocumentId:currentSource.ref.documentId,sourceRevision:currentSource.ref.revision}))return;setSphereDraft(next);setSampling(previous=>({...previous,spherePaddingAngstrom:next.marginAngstrom,sphere:{...previous.sphere,centerAngstrom:next.centerAngstrom,radiusAngstrom:next.radiusAngstrom}}));}
 function refitSphere(){if(currentSource)acceptSphereDraft({...createSamplingSphereDraft(currentSource.ref.documentId,currentSource.ref.revision,currentSource.structure.atoms.map(atom=>[atom.x,atom.y,atom.z]),sampling.spherePaddingAngstrom),previewEnabled:sphereDraft?.previewEnabled??true});}
 function changeSampling(next:typeof sampling){setSampling(next);if(currentSource&&JSON.stringify(next.coreIds)!==JSON.stringify(sampling.coreIds)){const updated=overrideAdvancedTaskSource(currentSource,{protectionAtomIds:next.coreIds});restoredTorsionSource.current=updated;setSource(updated);hydration.current=null;p.onProtectionChange?.(updated,next.coreIds);}if(currentSource&&next.sphereEnabled&&!sampling.sphereEnabled){const draft=createSamplingSphereDraft(currentSource.ref.documentId,currentSource.ref.revision,currentSource.structure.atoms.map(atom=>[atom.x,atom.y,atom.z]),next.spherePaddingAngstrom);setSphereDraft(draft);}}
 function changeElectronicState(patch:Partial<typeof electronicDraft>){const next={...electronicDraft,...patch};if(currentSource&&validAdvancedElectronicDraft(next))p.onElectronicStateChange?.(currentSource,{...next,confirmed:false});setConfirmedElectronic('');setElectronicDraft(next);}
 function commitElectronicState(){if(!currentSource)return;const issue=baseElectronicStateError(currentSource.structure,electronicDraft);if(issue)throw Error(issue);const updated=overrideAdvancedTaskSource(currentSource,electronicDraft);p.onElectronicStateChange?.(currentSource,{...electronicDraft,confirmed:false});restoredTorsionSource.current=updated;setSource(updated);hydration.current=null;setConfirmedElectronic(advancedElectronicConfirmationKey(updated,electronicDraft));}
 useEffect(()=>{if(!currentSource||p.sourceProtectionAtomIds===undefined||p.displayTargetId!==currentSource.ref.documentId&&(!p.contextTaskId||p.contextTaskId!==taskId))return;const ids=p.sourceProtectionAtomIds;if(ids.some(id=>!currentSource.structure.atoms.some(atom=>atom.id===id)))return;if(JSON.stringify(ids)===JSON.stringify(currentSource.constraints.frozenAtomIds))return;const updated=overrideAdvancedTaskSource(currentSource,{protectionAtomIds:ids});restoredTorsionSource.current=updated;setSource(updated);setSampling(previous=>({...previous,coreIds:[...ids]}));hydration.current=null;},[JSON.stringify(p.sourceProtectionAtomIds),currentSource?.ref.documentId,p.contextTaskId,taskId]);
 useEffect(()=>{if(!currentSource){setSphereDraft(null);return;}setSphereDraft(previous=>previous&&sameSamplingSphereSource(previous,{sourceDocumentId:currentSource.ref.documentId,sourceRevision:currentSource.ref.revision})?previous:createSamplingSphereDraft(currentSource.ref.documentId,currentSource.ref.revision,currentSource.structure.atoms.map(atom=>[atom.x,atom.y,atom.z]),sampling.spherePaddingAngstrom));},[currentSource]);
 useEffect(()=>{if(!p.sphereRadiusChange||!sphereDraft||!p.active||section!=='conformer'||!sampling.sphereEnabled||!sphereDraft.previewEnabled||!sameDisplaySource(currentSource,p.displayedSource))return;try{const next=applySamplingSphereRadiusChange(sphereDraft,p.sphereRadiusChange);if(next!==sphereDraft)acceptSphereDraft(next);}catch(error){p.onError(error instanceof Error?error.message:String(error));}},[p.sphereRadiusChange]);
 const selectionEnabled=Boolean(p.active&&section&&currentSource&&sameTaskGeometrySource(p.displayedSource,currentSource));
 const captureOptions={ownerId:'advanced-configuration',structure:currentSource?.structure??EMPTY_CAPTURE_STRUCTURE,documentId:currentSource?.ref.documentId??'',revision:currentSource?.ref.revision??0,sourceId:JSON.stringify(currentSource?.ref??''),frameIndex:currentSource?.ref.sourceFrameIndex??0,activationEpoch:p.displayTargetId??'',active:selectionEnabled};
 const coordinateCapture=useAnalysisAtomCapture({...captureOptions,purpose:'advanced-coordinate'}),regionCapture=useAnalysisAtomCapture({...captureOptions,purpose:'advanced-region'});
 useEffect(()=>{if(section==='path')setKind('path');else if(section==='conformer')setKind(lastConformerKind.current);},[section]);
 useEffect(()=>{if(restoredTorsionSource.current===currentSource){restoredTorsionSource.current=null;return;}if(!currentSource){setTorsionRows([]);return;}try{setTorsionRows(allocateConformerTorsionPoints(discoverConformerTorsionRows(createConformerSnapshot(currentSource.structure,currentSource.ref,currentSource.constraints)),expectedTarget));}catch{setTorsionRows([]);}},[currentSource]);
 useEffect(()=>{if(p.active&&section==='conformer'&&kind==='conformer-search'&&currentSource){const row=torsionRows.find(row=>row.id===(hoverTorsion??activeTorsion));p.onTaskHighlights?.(row?{source:currentSource,atomIds:row.atomIds}:undefined);}else p.onTaskHighlights?.(undefined);return()=>p.onTaskHighlights?.(undefined);},[p.active,section,kind,currentSource,torsionRows,activeTorsion,hoverTorsion,p.onTaskHighlights]);
 const visibleTasks=state.tasks.filter(row=>section==='path'?row.spec.kind==='path':['sampling','conformer-search','docking'].includes(row.spec.kind));
 const task=visibleTasks.find(row=>row.id===taskId),run=task?.runs.find(row=>row.id===runId)??task?.runs.at(-1);
 const electronicBusy=Boolean(run&&['queued','running','stopping'].includes(run.status));
 const sourceElectronic=advancedElectronicDraftState(currentSource,p.sourceElectronicState,p.displayedSource,p.displayTargetId,electronicBusy);
 const electronicSourceKey=advancedElectronicConfirmationKey(currentSource,sourceElectronic);
 useEffect(()=>{if(!currentSource)return;if(sourceElectronic.charge!==electronicDraft.charge||sourceElectronic.multiplicity!==electronicDraft.multiplicity)setConfirmedElectronic('');setElectronicDraft(sourceElectronic);},[electronicSourceKey]);
 const frames=run?.frames.length?run.frames:task?.guessFrames??[];
 const collections=advancedFrameCollections(frames,run),selectedCollection=collections.find(row=>row.id===collectionId)??collections[0],visibleFrames=selectedCollection?.frames??[];
 const observed=task?[...task.guessFrames,...task.runs.flatMap(row=>row.frames)].find(frame=>frame.id===frameId):undefined;
 const coreReference=task?.spec.source??currentSource,sourceInfo=currentSource?p.sourceCollectionInfo?.(currentSource):undefined;
 const coreFrameAtoms=new Map(visibleFrames[0]?.source.structure.atoms.map(atom=>[atom.id,atom.element])??[]),taskCoreAvailable=Boolean(coreReference&&visibleFrames.length&&coreReference.structure.atoms.every(atom=>coreFrameAtoms.get(atom.id)===atom.element));
 const [coreSelection,setCoreSelection]=useState<{source:AdvancedFrameSource;ids:string[]}|null>(null);
 const currentViewState=()=>({targetId:p.displayTargetId,source,taskId,selectedFrame,runId,stages,path,sampling,sphereDraft,product,collectionId,docking,fragments,fragmentStatesConfirmed,torsionRows,activeTorsion,candidateLimit,expectedTarget,targetText,kind,samplingOperation,inputTemplate,displayMode,displayRange,displayStride,overlay,spherePreview,sourceRange,sourceFrames,displayError,coreSelection,historicalReason,hydration:hydration.current?{...hydration.current}:null,clustering:restoredClustering.current});
 const initialViewState=useRef(currentViewState()),viewStates=useRef(new Map<string,ReturnType<typeof currentViewState>>()),lastViewSection=useRef<string|null>(null),createdContextTask=useRef<string|null>(null),[viewEpoch,setViewEpoch]=useState(0);
 const viewKey=JSON.stringify([p.contextKey??'default',section]);
 const viewChanging=(section==='conformer'||section==='path')&&lastViewSection.current!==viewKey;
 if((section==='conformer'||section==='path')&&lastViewSection.current===viewKey)viewStates.current.set(viewKey,currentViewState());
 useEffect(()=>{
  if(section!=='conformer'&&section!=='path'||lastViewSection.current===viewKey)return;
  captureRequest.current++;
  if(p.contextTaskId&&createdContextTask.current===p.contextTaskId){lastViewSection.current=viewKey;createdContextTask.current=null;viewStates.current.set(viewKey,currentViewState());setViewEpoch(value=>value+1);return;}
  const saved=viewStates.current.get(viewKey),restored=saved??initialViewState.current;lastViewSection.current=viewKey;
  restoredTorsionSource.current=restored.source;hydration.current=restored.hydration;restoredClustering.current=restored.clustering;
  setSource(restored.source);setTaskId(restored.taskId);setSelectedFrame(restored.selectedFrame);setRunId(restored.runId);setStages(restored.stages);setPath(restored.path);setSampling(restored.sampling);setProduct(restored.product);setCollectionId(restored.collectionId);setDocking(restored.docking);setFragments(restored.fragments);setFragmentStatesConfirmed(restored.fragmentStatesConfirmed);setTorsionRows(restored.torsionRows);setActiveTorsion(restored.activeTorsion);setCandidateLimit(restored.candidateLimit);setInputTemplate(restored.inputTemplate);setDisplayMode(restored.displayMode);setDisplayRange(restored.displayRange);setDisplayStride(restored.displayStride);setOverlay(null);setSpherePreview(restored.spherePreview);setSourceRange(restored.sourceRange);setSourceFrames(restored.sourceFrames);setDisplayError(restored.displayError);setCoreSelection(restored.coreSelection);setHistoricalReason(restored.historicalReason);setViewEpoch(value=>value+1);
  setSphereDraft(restored.sphereDraft);
  setExpectedTarget(restored.expectedTarget);setTargetText(restored.targetText);setKind(section==='path'?'path':restored.kind);lastConformerKind.current=restored.kind==='path'?'sampling':restored.kind;
  if(saved){setLocalSamplingOperation(restored.samplingOperation);p.onSamplingOperationChange?.(restored.samplingOperation);}
  setHoverTorsion(null);setPreviewTorsion(null);
  if(p.contextTaskId&&state.tasks.some(task=>task.id===p.contextTaskId)&&restored.taskId!==p.contextTaskId)selectConformerTask(p.contextTaskId,false);
  if(section==='path'&&restored.source&&p.active&&restored.targetId===p.displayTargetId)p.onObserve(restored.source);
 },[viewKey]);
 const coreIds=sameDisplaySource(coreSelection?.source,coreReference)?coreSelection!.ids:[];
 const coreCapture=useAnalysisAtomCapture({...captureOptions,ownerId:'advanced-display-core',structure:coreReference?.structure??EMPTY_CAPTURE_STRUCTURE,documentId:coreReference?.ref.documentId??'',revision:coreReference?.ref.revision??0,sourceId:JSON.stringify(coreReference?.ref??''),frameIndex:coreReference?.ref.sourceFrameIndex??0,active:Boolean(p.active&&section&&displayMode==='core'&&coreReference&&sameDisplaySource(p.displayedSource,coreReference)),purpose:'advanced-region'});
 const captureProjection=coreCapture.viewportCapture??coordinateCapture.viewportCapture??regionCapture.viewportCapture;
 useEffect(()=>{p.onCaptureProjection?.(captureProjection);return()=>p.onCaptureProjection?.(undefined);},[captureProjection,p.onCaptureProjection]);
 const shownOverlay=overlay?.targetId===p.displayTargetId&&sameDisplaySource(overlay?.source,p.displayedSource)?overlay:null;
 const sphereState=useMemo(()=>{if(kind!=='sampling'||!sampling.sphereEnabled||!sphereDraft?.previewEnabled||!sameDisplaySource(currentSource,p.displayedSource))return{};try{validateSamplingSphereDisplay(sampling.sphere);return{sphere:sampling.sphere};}catch(cause){return{error:cause instanceof Error?cause.message:String(cause)};}},[kind,sampling.sphereEnabled,sampling.sphere,sphereDraft,currentSource,p.displayedSource]);
 useEffect(()=>{p.onSphereDraft?.(p.active&&section==='conformer'&&sphereState.sphere&&sphereDraft?sphereDraft:undefined);return()=>p.onSphereDraft?.(undefined);},[p.active,section,sphereState.sphere,sphereDraft,p.onSphereDraft]);
 const previewOwner=hoverTorsion??previewTorsion;
 const torsionPreview=useMemo(()=>{if(!p.active||section!=='conformer'||kind!=='conformer-search'||!currentSource||!sameTaskGeometrySource(currentSource,p.displayedSource)||!previewOwner)return null;const row=torsionRows.find(row=>row.id===previewOwner);if(!row||row.atomIds.length!==4)return null;try{const snapshot=createConformerSnapshot(currentSource.structure,currentSource.ref,currentSource.constraints),checked=(row.origin==='manual'?inspectManualConformerTorsion:inspectConformerTorsion)(snapshot,row.atomIds as TorsionAtoms);if(!checked.accepted)return null;return{snapshot,torsion:planConformerTorsionHierarchy(snapshot,[checked.torsion],coreIds.length?coreIds:undefined).torsions[0].torsion};}catch{return null;}},[p.active,section,kind,currentSource,p.displayedSource,previewOwner,torsionRows,coreIds.join('|')]);
 useEffect(()=>{const displayed=p.displayedSource;if(!p.active||!section||!displayed){p.onDisplayLayers?.(undefined);return;}let animation=0;const started=performance.now();const emit=(now:number)=>{let previewStructure;try{if(torsionPreview)previewStructure=createConformerTorsionPreview(torsionPreview.snapshot,torsionPreview.torsion,(now-started)/4000);}catch{setHoverTorsion(null);setPreviewTorsion(null);}p.onDisplayLayers?.(shownOverlay||sphereState.sphere||previewStructure?{targetId:p.displayTargetId,source:displayed,multiframeDisplay:shownOverlay?.plan,samplingSphere:sphereState.sphere,previewStructure}:undefined);if(torsionPreview)animation=requestAnimationFrame(emit);};emit(started);return()=>{if(animation)cancelAnimationFrame(animation);p.onDisplayLayers?.(undefined);};},[p.active,section,p.displayTargetId,p.displayedSource,p.onDisplayLayers,shownOverlay,sphereState.sphere,torsionPreview]);
 useEffect(()=>{setHoverTorsion(null);setPreviewTorsion(null);},[p.active,section,kind,p.contextKey]);
 const act=(action:()=>unknown|Promise<unknown>)=>{try{void Promise.resolve(action()).catch(cause=>p.onError(cause instanceof Error?cause.message:String(cause)));}catch(cause){p.onError(cause instanceof Error?cause.message:String(cause));}};
 function activateDisplayFrame(frame:{id:string;source:AdvancedFrameSource}){if(shownOverlay){if(shownOverlay.plan.frames.some(row=>row.key===frame.id))setOverlay({...shownOverlay,source:frame.source,plan:activateMultiframeDisplay(shownOverlay.plan,frame.id)});else setOverlay(null);}p.onObserve(frame.source);}
 const outputCandidates=task?visibleFrames:sourceFrames&&sourceInfo&&sourceFrames.collectionId===sourceInfo.id?sourceFrames.frames:currentSource?[{id:currentSource.ref.frameId??'current-source',source:currentSource}]:[];
 async function capture(initial=false){const request=++captureRequest.current;setCapturing(true);try{const next=await(initial&&p.onCaptureInitialSource?p.onCaptureInitialSource():p.onCaptureSource());if(request!==captureRequest.current||!displayAlive.current)return;hydration.current=null;setHistoricalReason('');setSource(next);setFrameId(null);setTaskId(null);setRunId(null);setProduct(null);setHoverTorsion(null);setPreviewTorsion(null);setFragments({aAtomIds:[],bAtomIds:[],electronicStates:[{charge:0,multiplicity:1},{charge:0,multiplicity:1}]});setFragmentStatesConfirmed(false);setPath({...path,coordinateIds:[],additionalCoordinates:[],mapping:[],mappingConfirmed:false});setSampling({...sampling,coreIds:[...next.constraints.frozenAtomIds],metaIds:[],sphere:suggestConformerSamplingSphere(next.structure,sampling.spherePaddingAngstrom)});p.onObserve(next);}catch(cause){if(request===captureRequest.current)p.onError(cause instanceof Error?cause.message:String(cause));}finally{if(request===captureRequest.current)setCapturing(false);}}
 useEffect(()=>{const key=JSON.stringify([p.contextKey??'default',p.displayTargetId??p.displayedSource?.ref.documentId??'current']);if(viewChanging||!p.active||!section||!p.displayedSource||source||autoCaptureAttempt.current===key)return;autoCaptureAttempt.current=key;void capture(true);},[p.active,section,p.contextKey,p.displayTargetId,p.displayedSource,source,viewEpoch]);
 const optimizationStages=(drafts=stages)=>drafts.map((stage,index)=>{
  const restored=restoredClustering.current.get(stage.id),unchangedEnergy=restored?.displayValue===stage.energyThresholdKcalMol;
  if(!Number.isSafeInteger(stage.inputStride??1)||(stage.inputStride??1)<1)throw Error('抽帧间隔须为正整数。');
  return{id:stage.id,inputStride:stage.inputStride??1,...(index?{inputClusterCount:stage.inputClusterCount??10}:{}),checkpointAfter:true,clustering:{...restored?.clustering,rmsdMatching:stage.rmsdMatching??'symmetry',rmsdThresholdAngstrom:stage.rmsdThresholdAngstrom,...(unchangedEnergy?{}:{maxDeltaEnergyHartree:convertEnergy({value:stage.energyThresholdKcalMol,unit:'kcal/mol'},'hartree')!})},method:compileAdvancedMethod({...stage.method,threads:['MMFF94','MMFF94s','UFF'].includes(stage.method.method)?1:p.computeResources?.threads??stage.method.threads})};
 });
 function spec():AdvancedTaskSpec{
  if(kind==='docking')throw Error(DOCKING_PAUSED);
  if(!currentSource)throw Error('请先取用当前完整结构帧。');
  const electronicError=baseElectronicStateError(currentSource.structure,electronicDraft);if(electronicError)throw Error(electronicError);
  if(!electronicConfirmed)throw Error('请先确认本次任务的电荷与自旋多重度。');
  if(kind==='path')return{kind,source:currentSource,path:compilePath({...path,threads:p.computeResources?.threads??path.threads},currentSource,product),...(product?{productSource:product}:{})};
  if(stages.some(stage=>!Number.isFinite(stage.rmsdThresholdAngstrom)||stage.rmsdThresholdAngstrom<=0))throw Error('各级归簇RMSD须为正数。');
  const configuredStages=optimizationStages();
  if(kind==='sampling'){const options=compileSampling({...sampling,threads:p.computeResources?.threads??sampling.threads,memoryBudgetBytes:p.computeResources?.memoryBudgetBytes},currentSource),plan=conformerSamplingBudgetPlan(options,currentSource.structure.atoms.length,{maxRetainedFrames:DEFAULT_ADVANCED_RUN_BUDGET.maxRetainedFrames,maxRetainedCoordinates:DEFAULT_ADVANCED_RUN_BUDGET.maxRetainedCoordinates});return{kind,source:currentSource,budget:{maxCandidates:plan.candidateCount},sampling:options,optimizationStages:configuredStages,checkpointAfterSampling:true};}
  const snapshot=createConformerSnapshot(currentSource.structure,currentSource.ref,currentSource.constraints);
  const torsions=torsionRows.filter(row=>row.enabled).map(row=>{if(row.atomIds.length!==4)throw Error('请确认每个柔性键的四原子定义。');const inspected=(row.origin==='manual'?inspectManualConformerTorsion:inspectConformerTorsion)(snapshot,row.atomIds as TorsionAtoms);if(!inspected.accepted)throw Error(`柔性键不可旋转：${inspected.reason}`);return{torsion:inspected.torsion,pointCount:row.pointCount,pointCountMode:row.pointCountMode};});
  if(!torsions.length)throw Error('请选择至少一个有效柔性键。');
  const combinationProduct=BigInt(conformerTorsionCombinationCount(torsionRows)),capacity=expectedTarget??Number(combinationProduct);
  if(!Number.isSafeInteger(capacity)||capacity<1)throw Error('组合数超出本次可处理容量，请填写预期有效帧数。');
  return{kind:'conformer-search',source:currentSource,budget:{maxCandidates:capacity},search:{torsions,quantity:expectedTarget===null?{mode:'per-torsion',pointsPerTorsion:points}:{mode:'total-effective',targetCount:expectedTarget,pointsPerTorsion:points,automaticPointAllocation:true},samplingLimits:{maxCandidates:capacity},stages:configuredStages,checkpointAfterGuesses:true}};
 }
 function bindCreatedTask(id:string){createdContextTask.current=id;p.onTaskCreated?.(id,currentSource!);}
 function create(start:boolean){const id=p.controller.createTask(spec());setTaskId(id);setFrameId(null);setRunId(null);if(start)p.controller.start(id);else p.controller.generateGuesses(id);}
 function startSampling(){if(kind==='docking')throw Error(DOCKING_PAUSED);if(!p.computeResources)throw Error('全局计算资源尚未就绪。');hydration.current=null;setHistoricalReason('');const id=p.controller.createTask(spec());setTaskId(id);bindCreatedTask(id);const startedRun=p.controller.startSampling(id);setRunId(startedRun);pendingCompletion.current={taskId:id,runId:startedRun,targetId:p.displayTargetId,source:currentSource!,sampling:true};}
 function selectConformerTask(id:string,observe=true){
  const selected=visibleTasks.find(row=>row.id===id);if(!selected){setTaskId(null);setRunId(null);hydration.current=null;setHistoricalReason('');return;}
  const restored=restoreConformerTaskDraft(selected.spec);captureRequest.current++;setCapturing(false);hydration.current={taskId:id};
  const savedStages=selected.spec.kind==='conformer-search'?selected.spec.search.stages:selected.spec.kind==='sampling'||selected.spec.kind==='docking'?selected.spec.optimizationStages:[];
  restoredClustering.current=new Map(restored.stages.map((stage,index)=>[stage.id,{displayValue:stage.energyThresholdKcalMol,clustering:structuredClone(savedStages[index].clustering)}]));
  if(selected.spec.kind==='conformer-search')restoredTorsionSource.current=selected.spec.source;
  setSource(selected.spec.source);setKind(selected.spec.kind as ConfiguredTaskKind);lastConformerKind.current=selected.spec.kind as Exclude<ConfiguredTaskKind,'path'>;setSampling(restored.sampling);setStages(restored.stages.length?restored.stages:[{id:'stage-1',method:{...initialAdvancedMethod,maxSteps:500},energyThresholdKcalMol:.25,rmsdThresholdAngstrom:.1,rmsdMatching:'symmetry',inputStride:1,advanceCount:10,checkpointAfter:true}]);setCandidateLimit(restored.candidateLimit);setHistoricalReason(restored.reason);
  if(selected.spec.kind==='conformer-search')setTorsionRows(restored.torsions);
  const selectedOperation=selected.spec.kind==='conformer-search'?'conformer-search':selected.spec.kind==='sampling'?restored.sampling.operation:null;
  if(selectedOperation&&selectedOperation!=='spherical-md'){setLocalSamplingOperation(selectedOperation);p.onSamplingOperationChange?.(selectedOperation);}
  if(selected.spec.kind==='sampling'){const fitted=createSamplingSphereDraft(selected.spec.source.ref.documentId,selected.spec.source.ref.revision,selected.spec.source.structure.atoms.map(atom=>[atom.x,atom.y,atom.z]),restored.sampling.spherePaddingAngstrom);setSphereDraft({...fitted,centerAngstrom:restored.sampling.sphere.centerAngstrom,radiusAngstrom:restored.sampling.sphere.radiusAngstrom,marginAngstrom:Math.max(0,restored.sampling.sphere.radiusAngstrom-fitted.minimumRadiusAngstrom),previewEnabled:false});}
  if(selected.spec.kind==='docking'){setDocking({...initialDockingDraft,...selected.spec.docking,search:{...initialDockingDraft.search,...selected.spec.docking.search},refinement:{...initialDockingDraft.refinement,...selected.spec.docking.refinement},calculator:{...initialDockingDraft.calculator,...selected.spec.docking.calculator}});setFragments(selected.spec.fragments??{aAtomIds:[],bAtomIds:[],electronicStates:[{charge:0,multiplicity:1},{charge:0,multiplicity:1}]});setFragmentStatesConfirmed(!!selected.spec.fragments);}
  if(selected.spec.kind==='conformer-search'){const quantity=selected.spec.search.quantity,target=quantity.mode==='total-effective'?quantity.targetCount:null;setExpectedTarget(target);setTargetText(target===null?'':String(target));}
  setTaskId(id);setRunId(null);setFrameId(null);setCollectionId('');setOverlay(null);if(observe)p.onObserve(selected.spec.source);
 }
 const currentSamplingSpec=(()=>{try{return spec();}catch{return null;}})(),currentSamplingKey=currentSamplingSpec?conformerSamplingConfigKey(currentSamplingSpec):'',taskSamplingKey=task?conformerSamplingConfigKey(task.spec):'',hydratedSampling=hydration.current?.taskId===task?.id&&(!hydration.current?.key||hydration.current.key===currentSamplingKey),samplingMatches=Boolean(!historicalReason&&task&&(kind==='docking'&&task.spec.kind==='docking'&&hydratedSampling||currentSamplingKey&&(currentSamplingKey===taskSamplingKey||hydratedSampling)));
 useEffect(()=>{
  if(hydration.current&&task&&hydration.current.taskId===task.id&&!hydration.current.key){hydration.current.key=currentSamplingKey;return;}
  if(historicalReason)return;
  if(!task||!currentSamplingSpec||!currentSamplingKey||samplingMatches||task.spec.kind!==currentSamplingSpec.kind||!sameDisplaySource(task.spec.source,currentSource)||run&&['queued','running','stopping'].includes(run.status))return;
  act(()=>{if(currentSamplingSpec.kind==='sampling')p.controller.configureSampling(task.id,{kind:'sampling',sampling:currentSamplingSpec.sampling});else if(currentSamplingSpec.kind==='conformer-search'){const{stages,checkpointAfterGuesses,...search}=currentSamplingSpec.search;p.controller.configureSampling(task.id,{kind:'conformer-search',search});}});
 },[task?.id,currentSamplingKey,taskSamplingKey,run?.status,p.controller,currentSource,historicalReason]);
 function startOptimization(index?:number){if(!task)throw Error('请先完成采样并保留候选。');if(!samplingMatches)throw Error('当前采样配置与候选来源不同，请重新采样。');p.controller.configureStages(task.id,optimizationStages());const startedRun=index===undefined?p.controller.runAllStages(task.id):p.controller.startStage(task.id,stages[index].id);setRunId(startedRun);pendingCompletion.current={taskId:task.id,runId:startedRun,targetId:p.displayTargetId,source:task.spec.source,stageId:index===undefined?undefined:stages[index].id,sampling:false};}
 function slot(host:HTMLElement|null,content:ReactNode){return host?createPortal(content,host):null;}
 const samplerRun=task?.runs.slice().reverse().find(value=>value.intent==='sampling'||value.sampling||value.docking)??(task?.spec.kind==='conformer-search'?task.runs[0]:undefined)??(run&&!run.stages.length?run:undefined);
 const ownsSamplingMode=Boolean(task&&(kind==='conformer-search'?task.spec.kind==='conformer-search':kind==='sampling'&&task.spec.kind==='sampling'&&task.spec.sampling.operation===sampling.operation));
 const workProgress=(configurationId?:string)=>{if(!ownsSamplingMode)return null;const owned=configurationId?task?.runs.slice().reverse().find(value=>value.stages.some(stage=>stage.configurationId===configurationId||stage.id===configurationId)):samplerRun,stageId=configurationId?owned?.stages.find(stage=>stage.configurationId===configurationId||stage.id===configurationId)?.id:undefined;return task&&owned?ConformerWorkProgressDisplay({controller:p.controller,taskId:task.id,run:owned,stageId,active:p.active,onStop:()=>act(()=>p.controller.stop(task.id,owned.id))}):null;};
 const samplingAction=<InputSettingsAction variant="primary" disabled={kind==='docking'||!currentSource||!p.computeResources||capturing||!!historicalReason} onClick={()=>act(startSampling)}>开始采样</InputSettingsAction>;
 const samplingSchedule=currentSamplingSpec?.kind==='sampling'?conformerSamplingSchedule(currentSamplingSpec.sampling):null;
 const theoreticalCombinations=(()=>{try{return conformerTorsionCombinationCount(torsionRows);}catch{return '待有效点数';}})();
 const samplingFrames=<output aria-label="采样候选帧数">{kind==='conformer-search'?<>理论组合数 {theoreticalCombinations}{expectedTarget!==null&&` · 目标有效帧数 ${expectedTarget}`} · 实际有效帧数 {ownsSamplingMode?task?.conformerWorkflow?.candidateSet?.frameIds.length??0:0}</>:<>预计采样 {samplingSchedule?.candidateCount??'待有效参数'} 帧{ownsSamplingMode&&task?.conformerWorkflow?.candidateSet&&` · 已采样 ${task.conformerWorkflow.candidateSet.frameIds.length} 帧`}</>}</output>;
 function commitExpectedTarget(){act(()=>{const target=targetText.trim()===''?null:Number(targetText);if(target!==null&&(!Number.isSafeInteger(target)||target<1))throw Error('预期有效帧数须为正整数或留空。');setExpectedTarget(target);setTorsionRows(rows=>allocateConformerTorsionPoints(rows,target));});}
 const changeTorsions=(rows:ConformerTorsionDraft[])=>{try{setTorsionRows(allocateConformerTorsionPoints(rows,expectedTarget));}catch{setTorsionRows(rows);}};
 const showSettings=section!=='conformer'||samplingOperation!==null||kind==='docking';
 const configuration=<div className="advanced-configuration" hidden={!p.active} data-testid="advanced-configuration"><WorkflowSessionBar label={section==='path'?'反应路径探索（开发中）':'构象搜索'}/>{!p.navigationInShell&&<AdvancedWorkflowNavigation activeSection={section} onSectionChange={changeSection} samplingOperation={samplingOperation} onSamplingOperation={chooseSampling}/>} {showSettings&&<WorkflowContentCard title={section==='path'?'任务设置':'构象搜索'}><div className="engine-step-content"><InputSettingsLayout>
  <InputSettingsCard title="当前帧来源" actions={<InputSettingsAction variant="surface" disabled={capturing} onClick={()=>void capture()}>{capturing?'读取中…':'取用当前帧'}</InputSettingsAction>}>
   <p className="muted-note">{currentSource?.label??'尚未取用结构'}</p>
   {currentSource&&<><p className="muted-note">{molecularFormula(currentSource.structure.atoms)} · {currentSource.structure.atoms.length} 原子</p><InputSettingsRow><InputSettingsField label="电荷"><NumericInput aria-label="本次任务电荷" stepper disabled={electronicBusy} step={1} value={Number.isFinite(electronicDraft.charge)?electronicDraft.charge:''} onChange={event=>{const charge=event.currentTarget.valueAsNumber;act(()=>changeElectronicState({charge}));}}/></InputSettingsField><InputSettingsField label="自旋多重度"><NumericInput aria-label="本次任务自旋多重度" stepper disabled={electronicBusy} min={1} step={1} value={Number.isFinite(electronicDraft.multiplicity)?electronicDraft.multiplicity:''} onChange={event=>{const multiplicity=event.currentTarget.valueAsNumber;act(()=>changeElectronicState({multiplicity}));}}/></InputSettingsField><InputSettingsAction variant="primary" disabled={electronicBusy||electronicConfirmed||!!baseElectronicStateError(currentSource.structure,electronicDraft)} onClick={()=>act(commitElectronicState)}>{electronicConfirmed?'已确认':'确认'}</InputSettingsAction></InputSettingsRow>{baseElectronicStateError(currentSource.structure,electronicDraft)&&<DismissibleNotice role="alert">{baseElectronicStateError(currentSource.structure,electronicDraft)}</DismissibleNotice>}</>}
   {currentSource&&!selectionEnabled&&(kind==='path'||kind==='sampling')&&<InputSettingsAction variant="surface" onClick={()=>p.onObserve(currentSource)}>显示任务来源以选择原子</InputSettingsAction>}
  </InputSettingsCard>
  {section==='conformer'&&kind==='docking'&&<InputSettingsCard title="历史对接"><output role="status">{DOCKING_PAUSED}</output><AdvancedWorkflowNavigation activeSection="conformer" onSectionChange={changeSection} samplingOperation={null} onSamplingOperation={chooseSampling}/></InputSettingsCard>}
  {kind==='path'&&<AdvancedPathControls value={{...path,threads:p.computeResources?.threads??1}} readOnlyThreads onChange={setPath} source={currentSource} product={product} coordinatePort={coordinateCapture.selectionPort} selectionEnabled={selectionEnabled} onCoordinateRequest={()=>{regionCapture.cancel();coreCapture.cancel();}} onCaptureProduct={()=>act(async()=>{const next=await p.onCaptureSource();setProduct(next);setPath(previous=>({...previous,mapping:[],mappingConfirmed:false}));})} onPreview={()=>act(()=>{if(!currentSource)return;const id=p.controller.createTask({kind:'path',source:currentSource,budget:{maxSubjobSeconds:path.maxWallTimeSeconds},productSource:product??undefined,path:compilePath({...path,threads:p.computeResources?.threads??1},currentSource,product,true)});setTaskId(id);setRunId(p.controller.start(id));setFrameId(null);})}/>}
  {!historicalReason&&kind==='sampling'&&<AdvancedSamplingControls value={sampling} onChange={changeSampling} source={currentSource} regionPort={regionCapture.selectionPort} selectionEnabled={selectionEnabled} onRegionRequest={()=>{coordinateCapture.cancel();coreCapture.cancel();}} progress={workProgress()} frameSummary={samplingFrames} actions={samplingAction} sphereControls={<SamplingSphereEditor draft={sphereDraft} disabled={!currentSource} onChange={acceptSphereDraft} onRefit={()=>act(refitSphere)}/>}/>}
  {sphereState.error&&<DismissibleNotice role="alert">{sphereState.error}</DismissibleNotice>}
  {!historicalReason&&kind==='conformer-search'&&<>
   <InputSettingsCard title="柔性键与初猜">{workProgress()}<ConformerTorsionControls source={currentSource} rows={torsionRows} onChange={changeTorsions} activeId={activeTorsion} onActive={setActiveTorsion} onHover={setHoverTorsion} onPreview={setPreviewTorsion} previewId={previewTorsion} selectionPort={coordinateCapture.selectionPort} selectionEnabled={selectionEnabled} onRequest={()=>{regionCapture.cancel();coreCapture.cancel();}} onAutomatic={()=>act(()=>{if(currentSource)changeTorsions(discoverConformerTorsionRows(createConformerSnapshot(currentSource.structure,currentSource.ref,currentSource.constraints)));})} validate={ids=>{if(!currentSource)throw Error('请先载入当前帧。');const inspected=inspectManualConformerTorsion(createConformerSnapshot(currentSource.structure,currentSource.ref,currentSource.constraints),ids as TorsionAtoms);if(!inspected.accepted)throw Error(inspected.reason==='closed-ring'?'该轴存在闭环，不能旋转整侧。':`二面角定义不可旋转：${inspected.reason}`);}}/><InputSettingsField label="预期有效帧数（可选）"><NumericInput aria-label="预期有效帧数（可选）" min={1} value={targetText} onChange={event=>setTargetText(event.currentTarget.value)} onBlur={commitExpectedTarget} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commitExpectedTarget();}}}/></InputSettingsField>{samplingFrames}{task?.guesses?.status==='partial'&&<p role="status">实际有效 {task.guesses.guesses.length} / 目标 {task.guesses.requestedEffectiveCount} · {task.guesses.stopReason==='combination-space-exhausted'?'已耗尽允许的角度组合':'已达到本次有界采样容量'}</p>}{samplingAction}
   </InputSettingsCard>
  </>}
  {section==='conformer'&&<>{historicalReason?<output role="status">{historicalReason}</output>:kind!=='docking'&&task&&(!samplingMatches||task.conformerWorkflow?.candidateSet?.valid===false)&&<output role="status">采样配置已调整，待重新采样；已有任务仍可浏览或停止。</output>}<ConformerOptimizationStages stages={stages} samplingInputCount={task?.conformerWorkflow?.candidateSet?.valid?task.conformerWorkflow.candidateSet.frameIds.length:undefined} upstreamForStage={index=>conformerUpstreamSummary(task,index,stages[index].inputClusterCount??10,stages[index].inputStride??1)} progressForStage={id=>workProgress(id)} onChange={next=>{setStages(next);if(task&&samplingMatches)act(()=>p.controller.configureStages(task.id,optimizationStages(next)));}} canStart={index=>Boolean(samplingMatches&&p.computeResources&&task?.conformerWorkflow?.candidateSet?.valid&&(index===0||task.conformerWorkflow.stages.find(row=>row.stageId===stages[index-1].id)?.valid&&conformerUpstreamSummary(task,index,stages[index].inputClusterCount??10,stages[index].inputStride??1).ready))} busy={!!historicalReason||run?.status==='running'||run?.status==='queued'||run?.status==='stopping'} onStart={index=>act(()=>startOptimization(index))} onRunAll={()=>act(()=>startOptimization())}/></>}
  {section==='path'&&<InputSettingsAction variant="primary" disabled={!currentSource||!p.computeResources} onClick={()=>act(()=>create(true))}>开始任务</InputSettingsAction>}
 </InputSettingsLayout></div></WorkflowContentCard>}</div>;
 const legacyResults=<div className="advanced-results" hidden={!p.active} data-testid="advanced-results"><WorkflowSessionBar label="任务与结果"/><InputSettingsLayout><InputSettingsCard title="任务与进度"><InputSettingsField label="任务"><select aria-label="当前高级任务" value={task?.id??''} onChange={event=>{setTaskId(event.target.value||null);setFrameId(null);const selected=visibleTasks.find(row=>row.id===event.target.value);if(selected)p.onObserve(selected.spec.source);}}><option value="">选择任务</option>{visibleTasks.map(row=><option key={row.id} value={row.id}>{row.spec.label??TASK_LABELS[row.spec.kind]} · {row.spec.source.label}</option>)}</select></InputSettingsField>
  {task&&task.runs.length>1&&<InputSettingsField label="运行记录"><select aria-label="高级任务运行记录" value={run?.id??''} onChange={event=>{setRunId(event.target.value);setFrameId(null);}}>{task.runs.map((row,index)=><option key={row.id} value={row.id}>运行 {index+1} · {STATUS[row.status]}</option>)}</select></InputSettingsField>}
  {run&&<><p className="muted-note" role="status">{STATUS[run.status]} · 已用 {Math.round(run.elapsedMs/1000)} s · {run.subjobCount} 个子作业</p><InputSettingsRow>{['queued','running','stopping'].includes(run.status)&&<InputSettingsAction variant="surface" disabled={run.status==='stopping'} onClick={()=>act(()=>p.controller.stop(task!.id,run.id))}>停止</InputSettingsAction>}{task&&advancedCheckpointAvailable(task.spec.kind,run)&&<InputSettingsAction variant="primary" onClick={()=>act(()=>{setRunId(p.controller.resume(task!.id,run.id));setFrameId(null);})}>继续下一阶段</InputSettingsAction>}{['failed','stopped'].includes(run.status)&&<InputSettingsAction variant="primary" onClick={()=>act(()=>{setRunId(p.controller.retry(task!.id,run.id));setFrameId(null);})}>重试未完成项</InputSettingsAction>}</InputSettingsRow>{run.error&&<DismissibleNotice identity={run.id}>{run.error}</DismissibleNotice>}{run.stopReason&&<p role="status">{run.stopReason}</p>}</>}
  {task?.guesses&&<p className="muted-note">初猜 {task.guesses.guesses.length} / 目标 {task.guesses.requestedEffectiveCount} · {task.guesses.status==='complete'?'生成完成':'未足量'}</p>}
  {task&&!run&&<InputSettingsAction variant="primary" onClick={()=>act(()=>p.controller.start(task.id))}>开始已选任务</InputSettingsAction>}
  {run?.stages.map((stage,index)=><p className="muted-note" key={stage.id}>第 {index+1} 级 · {stage.status==='completed'?'完成':stage.status==='running'?'运行中':stage.status==='failed'?'失败':stage.status==='stopped'?'已停止':'等待'} · {stage.results.length}/{stage.inputCandidateIds.length}</p>)}
  {run?.path&&<InputSettingsSection level="subcard" title="路径阶段" collapsible defaultOpen>{[...new Map(run.path.stageEvents.map(event=>[event.stageId,event])).values()].map(event=><p key={event.stageId} className="muted-note">{processStageLabel(event.stageId)} · {event.phase==='completed'?'结束':'运行中'}{event.searchConverged===false?' · 未收敛':''}</p>)}</InputSettingsSection>}
  {run?.sampling&&<InputSettingsSection level="subcard" title="采样阶段" collapsible defaultOpen>{[...new Map(run.sampling.stageEvents.map(event=>[event.stageId,event])).values()].map(event=><p key={event.stageId} className="muted-note">{processStageLabel(event.stageId)} · {event.status==='completed'?'结束':'运行中'}{event.skipped?' · 零时长跳过':''}</p>)}{run.sampling.biasEvents.length>0&&<p className="muted-note">已保留 {run.sampling.biasEvents.length} 条完整偏置历史</p>}</InputSettingsSection>}
  {task&&run?.sampling&&<AdvancedSamplingTimeRemaining controller={p.controller} taskId={task.id} runId={run.id} active={p.active}/>}
  {run?.docking&&<AdvancedDockingProgress docking={run.docking}/>}
 </InputSettingsCard><InputSettingsCard title="结构帧">{collections.length>0&&<InputSettingsField label="过程集合"><select aria-label="高级过程集合" value={selectedCollection?.id??''} onChange={event=>setCollectionId(event.target.value)}>{collections.map(row=><option key={row.id} value={row.id}>{row.label} · {row.frames.length} 帧</option>)}</select></InputSettingsField>}<ScientificDataTable selectionScope={`${run?.id??task?.id??'advanced-empty'}:${selectedCollection?.id??''}`} activeRowKey={frameId??undefined} onRowActivate={row=>{const frame=visibleFrames.find(value=>value.id===row.key);if(frame){setFrameId(frame.id);activateDisplayFrame(frame);}}} projection={advancedFrameTable(visibleFrames,run)}/>
  {run?.path?.terminal?.event==='completed'&&run.path.terminal.resultKind==='ts-candidate'&&<p role="status">TS 搜索候选 · 未作频率驻点验证</p>}
  <InputSettingsRow><InputSettingsAction variant="surface" disabled={!observed} onClick={()=>act(()=>observed&&p.onExtract(observed.source))}>取帧建模</InputSettingsAction><InputSettingsAction variant="surface" disabled={!observed} onClick={()=>act(()=>observed&&p.onPrepareInput(observed.source))}>准备输入</InputSettingsAction>{task?.spec.kind==='singlepoint'&&run?.status==='completed'&&p.onOpenAnalysis&&<InputSettingsAction variant="surface" onClick={()=>p.onOpenAnalysis?.(task.id,run.id)}>查看后处理</InputSettingsAction>}</InputSettingsRow>
 </InputSettingsCard><InputSettingsCard title="帧输出"><InputSettingsAction variant="surface" disabled={!p.active||!p.onCaptureInputTemplate} onClick={()=>act(()=>{const template=p.onCaptureInputTemplate?.();if(!template)throw Error('尚无当前输入任务模板，请先在输入文件中配置并保留所需的 Gaussian / ORCA 请求。');setInputTemplate(template);})}>取用当前输入模板</InputSettingsAction>{inputTemplate&&<p className="muted-note">已取用 {inputTemplate.engine==='gaussian'?'Gaussian':'ORCA'} 输入模板快照</p>}<AdvancedFrameOutputControls candidates={outputCandidates} template={inputTemplate} bridge={p.outputBridge??null} disabled={!p.active} onError={p.onError}/></InputSettingsCard></InputSettingsLayout></div>;
 const conformerCollections=useMemo(()=>buildConformerResultCollections(task,stages),[conformerCollectionRevision(task),stages]);
 const conformerDisplayFrames=useMemo(()=>{if(task?.spec.kind!=='conformer-search')return new Map<string,AdvancedResultFrame[]>();try{const snapshot=createConformerSnapshot(task.spec.source.structure,task.spec.source.ref,task.spec.source.constraints),hierarchy=planConformerTorsionHierarchy(snapshot,task.spec.search.torsions.map(row=>row.torsion));return new Map(conformerCollections.filter(collection=>!collection.includeEnergies&&!collection.id.endsWith(':interrupted')).map(collection=>[collection.id,orderConformerTorsionFrames(collection.frames,hierarchy,frame=>frame.source.structure)]));}catch{return new Map<string,AdvancedResultFrame[]>();}},[conformerCollections,task]);
 const collectionStates=Object.fromEntries(conformerCollections.map(collection=>{const owned=task?.runs.find(run=>run.id===collection.identity.runId),stage=owned?.stages.find(stage=>stage.id===collection.identity.stageId),outcome=stage?.outcome;
  const detail=stage?`已处理 ${outcome?.processed??stage.results.length} / ${outcome?.target??stage.inputCandidateIds.length} · 有效 ${outcome?.valid??stage.results.filter(result=>result.status==='completed').length} · 失败 ${outcome?.failed??stage.results.filter(result=>result.status==='failed').length}`:'';
  const reason=outcome?.reason??owned?.error??owned?.stopReason;
  const message=stage?`${STATUS[stage.status==='pending'?'queued':stage.status]}${detail?' · '+detail:''}${reason?' · '+reason:stage.status==='running'?' · 完成本级归簇后显示最终代表':''}`:owned?`${STATUS[owned.status]}${reason?' · '+reason:''}`:collection.frames.length?undefined:'尚未运行';
  return[collection.id,{runId:owned?.id,message}];}));
 const conformerCollection=conformerCollections.find(row=>row.id===collectionId)??conformerCollections[0];
 const viewedFrames=useRef(new Map<string,string>());
 function openConformerCollection(collection:ConformerResultCollection,requestedFrameId?:string){
  setCollectionId(collection.id);
  const remembered=requestedFrameId??viewedFrames.current.get(collection.id),frame=collection.frames.find(row=>row.id===remembered)??collection.frames[0];
  if(collection.playbackAvailable===false){if(frame){setFrameId(frame.id);p.onObserve(frame.source);}return;}
  if(!frame)return;setCollectionId(collection.id);setFrameId(frame.id);viewedFrames.current.set(collection.id,frame.id);p.onOpenConformerCollection?.(collection,frame.id);
 }
 useEffect(()=>{const frame=p.activeConformerFrame;if(frame?.taskId!==task?.id||!frame)return;const collection=conformerCollections.find(row=>row.id===frame.collectionId);if(collection?.frames.some(row=>row.id===frame.frameId)){setCollectionId(collection.id);viewedFrames.current.set(collection.id,frame.frameId);}},[p.activeConformerFrame,task?.id,conformerCollections]);
 useEffect(()=>{
  const pending=pendingCompletion.current;if(!pending)return;
  if(!p.active||section!=='conformer'||task?.id!==pending.taskId||!sameDisplaySource(currentSource,pending.source)||(p.displayTargetId!==pending.targetId&&p.activeConformerFrame?.taskId!==pending.taskId)){pendingCompletion.current=null;return;}
  const completed=task.runs.find(row=>row.id===pending.runId);if(!completed||['running','queued','stopping'].includes(completed.status))return;
  pendingCompletion.current=null;
  if(!['checkpoint','completed'].includes(completed.status))return;
  const completedStageId=pending.stageId?completed.stages.find(stage=>stage.configurationId===pending.stageId||stage.id===pending.stageId)?.id:undefined;
  const destination=pending.sampling?conformerCollections.find(row=>!row.includeEnergies&&row.identity.runId===completed.id):conformerCollections.filter(row=>row.includeEnergies&&row.identity.runId===completed.id&&(!pending.stageId||row.identity.stageId===completedStageId)&&row.frames.length).at(-1);
  if(destination?.frames.length){setOverlay(null);openConformerCollection(destination);}
 },[task,conformerCollections,p.active,section,p.displayTargetId,currentSource,p.activeConformerFrame]);
 const conformerCoreAvailable=Boolean(task&&conformerCollection?.frames.length&&task.spec.source.structure.atoms.every(atom=>conformerCollection.frames[0].source.structure.atoms.some(current=>current.id===atom.id&&current.element===atom.element)));
 const conformerOverlay=undefined;
 const controlsCallback=useRef(p.onConformerViewControls);controlsCallback.current=p.onConformerViewControls;
 const displayedIdentity=JSON.stringify([p.displayedSource?.ref,p.displayedSource?.stamp]);
 useEffect(()=>{controlsCallback.current?.(p.active&&section==='conformer'?conformerOverlay:undefined);return()=>controlsCallback.current?.(undefined);},[Boolean(p.onConformerViewControls),p.active,section,conformerCollection,shownOverlay,displayMode,displayRange,displayStride,displayError,conformerCoreAvailable,coreIds.join('|'),displayedIdentity]);
 const conformerResults=<div className="advanced-results" hidden={!p.active} data-testid="conformer-results"><WorkflowSessionBar label="采样与优化结果"/><InputSettingsLayout>
  {visibleTasks.length>0&&<InputSettingsCard title="当前任务"><InputSettingsField label="任务"><select aria-label="当前高级任务" value={task?.id??''} onChange={event=>act(()=>selectConformerTask(event.target.value))}><option value="">选择任务</option>{visibleTasks.map(row=><option key={row.id} value={row.id}>{row.spec.label??TASK_LABELS[row.spec.kind]} · {row.spec.source.label}</option>)}</select></InputSettingsField></InputSettingsCard>}
  <ConformerStageResults busy={!!run&&['running','queued','stopping'].includes(run.status)} onOrganize={id=>act(()=>{const collection=conformerCollections.find(row=>row.id===id);if(task&&collection?.clusterCollection)p.controller.organizeStage(task.id,collection.clusterCollection.configurationId);})} collections={conformerCollections} collectionStates={collectionStates} collectionId={conformerCollection?.id} selectedFrameId={frameId} run={run} runs={task?.runs} active={p.active} onFrameOrder={p.onConformerFrameOrder} displayFramesForCollection={id=>conformerDisplayFrames.get(id)} onCollection={id=>{setOverlay(null);const collection=conformerCollections.find(row=>row.id===id);if(collection){setCollectionId(id);openConformerCollection(collection);}}} onFrame={frame=>{const collection=conformerCollections.find(row=>row.frames.some(value=>value.id===frame.id));if(collection)openConformerCollection(collection,frame.id);}} actions={<InputSettingsRow><InputSettingsAction disabled={!observed} onClick={()=>observed&&p.onExtract(observed.source)}>取帧建模</InputSettingsAction><InputSettingsAction disabled={!observed} onClick={()=>observed&&p.onPrepareInput(observed.source)}>准备输入</InputSettingsAction></InputSettingsRow>} output={<div className="conformer-output-actions"><InputSettingsAction disabled={!p.active||!p.onCaptureInputTemplate} onClick={()=>act(()=>{const template=p.onCaptureInputTemplate?.();if(!template)throw Error('请先保留当前Gaussian或ORCA输入任务模板。');setInputTemplate(template);})}>取用当前输入模板</InputSettingsAction><AdvancedFrameOutputControls compact candidates={conformerCollection?.frames??[]} template={inputTemplate} bridge={p.outputBridge??null} disabled={!p.active} onError={p.onError}/></div>}/>
 </InputSettingsLayout></div>;
 return <>{slot(p.configurationHost,section===null?!p.navigationInShell&&<AdvancedWorkflowNavigation activeSection={null} onSectionChange={changeSection}/>:configuration)}{section!==null&&slot(p.resultHost,section==='path'?legacyResults:conformerResults)}</>;
}
