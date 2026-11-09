import type { Structure } from '../../core/types';
import { captureAdvancedProjectSnapshot, restoreAdvancedProjectSnapshot, type AdvancedProjectSnapshot } from '../../projects/advanced-snapshot';
import { effectiveSharedFreezes } from '../constraints';
import type { DocumentStamp } from '../../core/modeling/contracts';
import { builderCoordinateValue } from '../../core/builder-geometry';
import { assertBuilderStereoPreserved } from '../../core/builder-stereo';
import { XTB_INTERNAL_CONSTRAINT_POLICY } from '../xtb/accept-result';
import { coordinatesFingerprint, graphFingerprint } from '../../core/modeling/graph';
import {baseElectronicStateError} from '../../core/base-electronic-state';
import { XTB_METHOD_LABELS, type XtbEvent, type XtbRequest, type XtbElectronicArtifactReceipt,
  type XtbElectronicArtifactBundle } from '../xtb/contracts';
import { createConformerSnapshot, generateConformerGuesses, selectConformerRepresentatives,
  prepareSameFrameDocking, DEFAULT_CONFORMER_CLUSTERING_POLICY, type ConformerOptimizationResult } from '../conformers';
import { captureAdvancedFrame, advancedFrameWorkingCopy, assertAdvancedIsolated, type AdvancedFrameSource, type AdvancedFrameRef } from './frame-source';
import { DEFAULT_ADVANCED_RUN_BUDGET, type AdvancedCalculationResult, type AdvancedControllerDependencies,
  type AdvancedControllerState, type AdvancedOptimizationMethod, type AdvancedOptimizationStageConfig,
  type AdvancedResultFrame, type AdvancedRunBudget, type AdvancedStageRun, type AdvancedTaskRecord,
  type AdvancedTaskRun, type AdvancedTaskSpec, type AdvancedXtbOptions, type AdvancedSamplingConfiguration,
  type AdvancedMixedSamplingDefinition, type AdvancedSamplingTaskOptions } from './contracts';
import type {AdvancedSamplingBatch,AdvancedSamplingCardState,AdvancedSamplingSegment,AdvancedDiscardConformerPlan} from './contracts';
import {mixedCardScienceKey,mixedCardTargetTimeFs,mixedCardTargetCount,makeSamplingCardState,samplingCardNeedsWork,syncSamplingBatch} from './mixed-workflow';
import { captureMixedInitial } from './mixed-sampling';
import { applyNativeTemperatureObservations } from './native-temperature-observations';
import { assertConformerGeometryProtected } from '../conformers/geometry';
import { advancedXtbCoordinates, validateAdvancedXtbResult } from './xtb-result';
import type { AdvancedPathRequest, AdvancedPathFrameData, AdvancedPathEvent } from './path-contracts';
import { CONFORMER_SAMPLING_CAPABILITIES, getConformerSamplingCapability, type ConformerSamplingRequest, type ConformerSamplingFramePayload, type ConformerSamplingEvent } from './sampling-contracts';
import {conformerSamplingBudgetPlan, conformerSamplingSchedule} from './sampling-progress';
import { startOwnedPath, startOwnedSampling } from './route-session';
import { startOwnedDocking } from './route-session';
import type { AissRequest, AissEvent } from './docking-contracts';
import type { ComputeResourceEvidence } from '../resource-preferences';
import {prepareSamplingOptimization} from '../conformers/sampling-preparation';
import { startSamplingWork, type SamplingWorkRequest, type SamplingDeduplicationResult } from './sampling-work';
import { advancedElectronicSourceConfirmationKey } from './electronic-confirmation';
import {normalizeConformerStageConfigs,selectAdvancedClusterInputs,selectConformerInputsByStride} from './conformer-cluster-collection';
import {resolveConformerProtection,conformerProtectionKey,conformerSamplingProtectionOptions,sharedFreezeRunDefinition,type ConformerProtectionSnapshot} from './conformer-protection';
import type {AdvancedStageInputSelection} from './contracts';
import { routePayload, validatePathFrame, validatePathCompletion, validateSamplingFrame, validateSamplingCompletion, pathScanPointCount,
  dockingSettings, validateDockingCompletion, validateDockingSearchCheckpoint, routeStructure } from './route-data';

interface CandidateInput { candidateId: string; source: AdvancedFrameSource }
interface RunPlan { stageIndex: number; inputs?: CandidateInput[]; reuse?: AdvancedCalculationResult[]; electronic?: ElectronicPending; samplingFromRunId?: string; dockingFromRunId?: string;
  protection?:ConformerProtectionSnapshot;
  inputSelection?:AdvancedStageInputSelection;
  reclusterOnly?:boolean;reclusterCompleted?:boolean;
  configurations?:AdvancedOptimizationStageConfig[];
  reorganizeOnly?:boolean;
  samplingMode?: 'replace' | 'append'|'continue';batchId?:string;forceRecalculate?:boolean;
    intent?: 'sampling' | 'stage' | 'batch'; endStageIndex?: number; inputCollectionId?: string;inputCollectionRevision?:number }
interface ElectronicPending { receipt: XtbElectronicArtifactReceipt; request: XtbRequest; sessionId: string; result: AdvancedCalculationResult }
interface NativeJob {
  task: AdvancedTaskRecord; run: AdvancedTaskRun; stage: AdvancedStageRun; input: CandidateInput;
  sessionId: string; request: XtbRequest; lastSequence: number; lastStep: number; stopPending?: Promise<void>;
  observedFrames: number;
  protocolError?: string; terminal: boolean; resolve(event: XtbEvent): void; reject(error: Error): void;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const withoutDeadline = <T extends { maxWallTimeSeconds?: number }>(value: T): T => {
  const { maxWallTimeSeconds: _legacyDeadline, ...rest } = value; return rest as T;
};
const isStopping = (run: AdvancedTaskRun) => run.status === 'stopping';
const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'checkpoint']);
const closedExit = (event: XtbEvent) => !!event.exit && (event.exit.code === null || Number.isSafeInteger(event.exit.code))
  && (event.exit.signal === null || typeof event.exit.signal === 'string');
function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const part of Object.values(value)) frozen(part); Object.freeze(value); }
  return value;
}
class RunStopped extends Error {}

/** Owns in-memory task runs, never a mutable model or a global native scheduler.
 * One controller executes one run at a time with a managed candidate pool; event ownership is
 * bound to issued task/run/session/stamp, independent of the active page. */
export class AdvancedController {
  private tasks = new Map<string, AdvancedTaskRecord>();
  private plans = new Map<string, RunPlan>();
  private queue: { taskId: string; runId: string }[] = [];
  private state: AdvancedControllerState = { tasks: [], activeNative: null, queue: [], ignoredEvents: 0, disposed: false };
  private listeners = new Set<() => void>();
  private activeJobs = new Map<string, NativeJob>();
  private cacheReleases: Promise<void>[] = [];
  private activeRun?: { task: AdvancedTaskRecord; run: AdvancedTaskRun; started: number };
  private waiters = new Map<string, (() => void)[]>();
  private electronicPending = new Map<string, ElectronicPending>();
  private disposed = false;
  private deletingTasks = new Set<string>();
  private pumping = false;
  private unsubscribe?: () => void;
  private activeForcefields = new Map<string, { info: NonNullable<AdvancedControllerState['activeNative']>; stop(): Promise<void> }>();
  private issuedSessions = new Set<string>();
  private frameSerial = 0;
  private activeRoute?: { info: NonNullable<AdvancedControllerState['activeNative']>; stop(): Promise<void> };
  private activeSamplingWork?: { runId: string; stop(): void };
  private samplingFrameIndex = new Map<string, Map<number, AdvancedResultFrame>>();
  private pathFrameIndex = new Map<string, Map<number, AdvancedResultFrame>>();
  private progressTimer?: ReturnType<typeof setTimeout>;
  private assetSnapshots = new WeakMap<object, unknown>();
  private activeBatch?:{runId:string;batchId:string};
  /** Sources, result frames and generated structures are immutable assets. Only
   * small lifecycle metadata is copied when a progress counter changes. */
  private snapshot<T>(value:T,key=''):T {
    if(!value||typeof value!=='object')return value;
    const asset=key==='source'||key==='input'||key==='originalInput'||key==='structure'
      || ('parentRef' in value && 'candidateId' in value && 'source' in value);
    if(asset){const cached=this.assetSnapshots.get(value);if(cached)return cached as T;}
    const copy=Array.isArray(value)?value.map(part=>this.snapshot(part)):Object.fromEntries(Object.entries(value).map(([name,part])=>[name,this.snapshot(part,name)]));
    const result=frozen(copy) as T;if(asset)this.assetSnapshots.set(value,result);return result;
  }
  private publishProgress() {
    this.progressTimer ??= setTimeout(() => { this.progressTimer = undefined;
      if(this.activeBatch&&this.activeRun){const {task,run}=this.activeRun,stage=run.stages.find(stage=>stage.batchId===this.activeBatch!.batchId);
        if(stage){this.publishBatchProgress(task,run,stage);return;}}
      this.publish(); }, 250);
  }
  private publishBatchProgress(task:AdvancedTaskRecord,run:AdvancedTaskRun,stage:AdvancedStageRun):void {
    this.state=frozen({...this.state,tasks:this.state.tasks.map(previous=>previous.id!==task.id?previous:{...previous,
      conformerWorkflow:previous.conformerWorkflow?{...previous.conformerWorkflow,stages:previous.conformerWorkflow.stages.map(item=>item.stageRunId===stage.id?{...item,progress:this.snapshot(stage.progress)}:item)}:undefined,
      runs:previous.runs.map(item=>item.id===run.id?{...item,status:run.status,stages:item.stages.map(item=>item.id===stage.id?{...item,batchId:stage.batchId,progress:this.snapshot(stage.progress)}:item)}:item)})});
    for(const listener of this.listeners)listener();
  }
  private publishGenerationProgress(task:AdvancedTaskRecord,run:AdvancedTaskRun):void {
    const progress=this.snapshot(run.backgroundProgress),generation=progress?.generation;
    this.state=frozen({...this.state,tasks:this.state.tasks.map(previous=>previous.id!==task.id?previous:{...previous,
      mixedSampling:previous.mixedSampling&&generation?{...previous.mixedSampling,batches:previous.mixedSampling.batches?.map(batch=>batch.id!==generation.batchId?batch:{...batch,cards:batch.cards.map(card=>card.id!==generation.cardId?card:{...card,receivedFrameCount:generation.received})})}:previous.mixedSampling,
      runs:previous.runs.map(item=>item.id===run.id?{...item,backgroundProgress:progress}:item)})});
    for(const listener of this.listeners)listener();
  }
  private async background<T>(run: AdvancedTaskRun, request: SamplingWorkRequest, cancellable = true,stageId?:string): Promise<T> {
    let started=this.now();
    const mixed=request.kind==='generate'?run.mixedSampling:undefined,card=mixed?.definition.cards[mixed.currentCardIndex];
    const generationOwner=mixed&&card&&mixed.batchId&&mixed.currentSegmentId?{taskId:run.taskId,runId:run.id,cardId:card.id,batchId:mixed.batchId,segmentId:mixed.currentSegmentId}:undefined;
    run.backgroundProgress = { phase: request.kind,stageId, completed: 0, total: request.kind === 'deduplicate' ? request.candidates.length : null,elapsedMs:0,etaMs:null };
    if(request.kind==='generate'&&generationOwner&&card){const baselineReceived=request.options.resume?.accepted.length??0,baselineAttempts=request.options.resume?.continuation.attempts??0,target=mixedCardTargetCount(card);
      run.backgroundProgress={...run.backgroundProgress,completed:baselineReceived,total:target,valid:baselineReceived,generation:{...generationOwner,received:baselineReceived,target,baselineReceived,attempts:baselineAttempts,baselineAttempts,startedAt:started,elapsedMs:0,etaMs:null}};}
    this.publish();
    if(cancellable&&isStopping(run)){
      run.backgroundProgress=undefined;this.publish();
      if(request.kind==='deduplicate')return {acceptedIndices:request.candidates.map((_,index)=>index),processed:0,completed:request.candidates.length===0} as T;
      throw new RunStopped('后台采样已停止，未启动新的几何工作。');
    }
    const bridge=this.deps.workerResourceBridge,id=bridge?this.nextSession():undefined;
    let grant:ComputeResourceEvidence|undefined,work:ReturnType<typeof startSamplingWork<T>>|undefined;
    const stop=()=>{if(work)work.stop();else if(bridge&&id)void bridge.cancelWorkerResources(id).catch(error=>{run.error=`后台资源等待取消尚未确认：${message(error)}`;this.publish();});};
    if (cancellable) this.activeSamplingWork = { runId: run.id, stop };
    try {
      if(bridge&&id){
        grant=await bridge.acquireWorkerResources({id,stamp:structuredClone(this.task(run.taskId).spec.source.stamp)});
        if(!Number.isSafeInteger(grant.threads)||grant.threads<1||!Number.isSafeInteger(grant.memoryBudgetBytes)||grant.memoryBudgetBytes<1)throw new Error('后台几何任务缺少有效全局资源grant。');
      }
      if(cancellable&&isStopping(run)){
        if(request.kind==='deduplicate')return {acceptedIndices:request.candidates.map((_,index)=>index),processed:0,completed:false} as T;
        throw new RunStopped('后台采样在开始工作前已停止。');
      }
      started=this.now();
      work=startSamplingWork<T>(request, progress => {
        if(progress.phase&&progress.phase!==run.backgroundProgress?.phase)started=this.now();
        const elapsedMs=Math.max(0,this.now()-started),count=progress.generation,delta=count?count.received-count.baselineReceived:progress.completed;
        const etaMs=progress.total!==null&&delta>0?elapsedMs/delta*Math.max(0,progress.total-progress.completed):null;
        const generation=count&&generationOwner?{...generationOwner,...count,startedAt:started,elapsedMs,etaMs}:undefined;
        run.backgroundProgress={phase:progress.phase??request.kind,stageId,completed:progress.completed,total:progress.total,valid:progress.valid,elapsedMs,etaMs,...(generation?{generation}:{})};
        if(generation){const task=this.task(run.taskId),state=task.mixedSampling?.batches?.find(batch=>batch.id===generation.batchId)?.cards.find(card=>card.id===generation.cardId);if(state)state.receivedFrameCount=generation.received;this.publishGenerationProgress(task,run);}
        else this.publishProgress();
      },grant);
      return await work.promise;
    } finally {
      work?.stop();
      // Every worker has terminated before its shared scheduler lease is freed.
      if(bridge&&id&&grant)await bridge.releaseWorkerResources(id);
      if (this.activeSamplingWork?.runId === run.id) this.activeSamplingWork = undefined;
      run.backgroundProgress = undefined; this.publish();
    }
  }
  constructor(private readonly deps: AdvancedControllerDependencies) {
    this.unsubscribe = deps.bridge?.onXtbEvent(event => this.handleEvent(event));
    this.publish();
  }
  getSnapshot = (): AdvancedControllerState => this.state;
  exportProjectSnapshot(): AdvancedProjectSnapshot { return captureAdvancedProjectSnapshot([...this.tasks.values()]); }
  /** Restore only into an empty, idle owner; no queue/grant/process is revived. */
  restoreProjectSnapshot(snapshot: AdvancedProjectSnapshot): void {
    if (this.disposed || this.tasks.size || this.queue.length || this.activeRun || this.activeJobs.size || this.activeRoute || this.activeForcefields.size) throw new Error('高级任务恢复要求空闲且未装载任务的控制器。');
    const tasks = restoreAdvancedProjectSnapshot(snapshot);
    for (const task of tasks) this.tasks.set(task.id, task);
    for(const task of tasks)if(task.mixedSampling)this.ensureSamplingBatches(task);
    // Frame IDs carry a serial suffix; fresh frames must not reuse saved IDs.
    this.frameSerial = tasks.reduce((maximum, task) => [...task.guessFrames, ...task.runs.flatMap(run => run.frames)]
      .reduce((serial, frame) => Math.max(serial, Number(frame.id.match(/-(\d+)$/)?.[1]) || 0), maximum), 0);
    this.publish();
  }
  canDeleteTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return !!task && !this.deletingTasks.has(taskId) && !this.busy(task) && !this.queue.some(item => item.taskId === taskId)
      && this.activeRun?.task.id !== taskId && ![...this.activeJobs.values()].some(job => job.task.id === taskId)
      && this.activeRoute?.info.taskId !== taskId && ![...this.activeForcefields.values()].some(job => job.info.taskId === taskId);
  }
  async deleteTask(taskId: string): Promise<void> {
    const task = this.task(taskId);
    if (!this.canDeleteTask(taskId)) throw new Error('请先停止任务并等待原生进程实际关闭，再删除整个组。');
    this.deletingTasks.add(taskId);
    try {
      const artifacts = new Set(task.runs.flatMap(run => { const pending = this.electronicPending.get(run.id); return pending ? [pending.receipt.artifactId] : []; }));
      for (const artifactId of artifacts) {
        if (!this.deps.bridge?.releaseXtbElectronicArtifacts || !(await this.deps.bridge.releaseXtbElectronicArtifacts(artifactId)).released) throw new Error('任务电子来源缓存尚未确认释放，未删除任务。');
      }
      const sessions = task.runs.flatMap(run => run.results.filter(result => result.diagnosticDirectory).flatMap(result => result.sessionId ? [result.sessionId] : []));
      this.releaseOptimizationCaches(sessions); await this.settleCacheReleases();
      if (this.tasks.get(taskId) !== task || this.busy(task)) throw new Error('任务状态在删除期间改变，未移除任务。');
      for (const run of task.runs) { this.plans.delete(run.id); this.electronicPending.delete(run.id); this.finishWaiters(run.id); }
      this.tasks.delete(taskId); this.publish();
    } finally { this.deletingTasks.delete(taskId); }
  }
  private discardRevision(task:AdvancedTaskRecord):string {
    return JSON.stringify([task.id,task.conformerWorkflow,task.mixedSampling?.selectedInitialGuessId,task.mixedSampling?.draft,
      task.mixedSampling?.initialGuesses.map(initial=>[initial.id,initial.source.stamp]),task.mixedSampling?.batches?.map(batch=>[batch.id,batch.sealed,batch.cards.map(card=>[card.id,card.configurationRevision,card.frameIds,card.mergedFrameIds])]),
      task.guessFrames.map(frame=>frame.id),task.runs.map(run=>[run.id,run.status,run.frames.map(frame=>frame.id),run.stages.map(stage=>[stage.id,stage.inputCandidateIds,stage.results.map(result=>[result.candidateId,result.status,result.frameId])])]),this.stageConfigs(task)]);
  }
  planDiscardConformer(selection:{taskId:string;initialId?:string;collectionId?:string;stageId?:string}):AdvancedDiscardConformerPlan {
    if(selection.collectionId?.endsWith(':interrupted'))selection={...selection,collectionId:selection.collectionId.slice(0,-':interrupted'.length)};
    const task=this.task(selection.taskId),frames=[...task.guessFrames,...task.runs.flatMap(run=>run.frames)],configs=this.stageConfigs(task),states=[...task.conformerWorkflow?.stages??[],...task.conformerWorkflow?.history??[]];
    let scope:AdvancedDiscardConformerPlan['scope']='task',initialIds:string[]=[],index=-1;
    if(selection.initialId){if(!task.mixedSampling?.initialGuesses.some(initial=>initial.id===selection.initialId))throw new Error('待丢弃初猜身份不存在。');initialIds=[selection.initialId];scope=task.mixedSampling.initialGuesses.length===1?'task':'initial';}
    else if(selection.collectionId===task.conformerWorkflow?.candidateSet?.id)scope='sampling';
    else if(selection.collectionId||selection.stageId){
      const state=states.find(state=>state.collectionId===selection.collectionId||state.stageId===selection.stageId||state.stageRunId===selection.stageId);
      const stage=task.runs.flatMap(run=>run.stages).find(stage=>stage.id===selection.stageId||stage.configurationId===selection.stageId||stage.collectionId===selection.collectionId);
      index=state?configs.findIndex(config=>config.id===state.stageId):stage?.index??-1;if(index<0)throw new Error('待丢弃优化集合身份不存在。');scope='stage';
    }
    const stageRecords=task.runs.flatMap(run=>run.stages),removed=new Set<string>();
    if(scope==='task'||scope==='sampling')for(const frame of frames)removed.add(frame.id);
    else if(scope==='stage'){const ids=new Set(stageRecords.filter(stage=>stage.index>=index).map(stage=>stage.id));for(const frame of frames)if(ids.has(frame.stageId))removed.add(frame.id);}
    else for(const frame of frames)if(frame.samplingOrigin&&initialIds.includes(frame.samplingOrigin.initialGuessId))removed.add(frame.id);
    let changed=true;while(changed){changed=false;for(const frame of frames)if(!removed.has(frame.id)&&!frame.samplingOrigin&&frame.parentRef.frameId&&removed.has(frame.parentRef.frameId)){removed.add(frame.id);changed=true;}
      for(const stage of stageRecords)for(const result of stage.results){const input=result.originalInput??result.input;if(input.ref.frameId&&removed.has(input.ref.frameId)&&result.frameId&&!removed.has(result.frameId)){removed.add(result.frameId);changed=true;}}
    }
    const affected=scope==='task'||scope==='sampling'?stageRecords:scope==='stage'?stageRecords.filter(stage=>stage.index>=index):stageRecords.filter(stage=>(stage.inputs??[]).some(input=>input.source.ref.frameId&&removed.has(input.source.ref.frameId))||stage.results.some(result=>result.frameId&&removed.has(result.frameId)));
    const collectionIds=new Set<string>();if(scope!=='stage'&&task.conformerWorkflow?.candidateSet)collectionIds.add(task.conformerWorkflow.candidateSet.id);
    for(const stage of affected)if(stage.collectionId){collectionIds.add(stage.collectionId);collectionIds.add(`${stage.collectionId}:interrupted`);}
    // Removing an initial changes the shared global ranking, although unrelated
    // calculated structures remain available as scientific cache/history.
    for(const state of states)if(scope!=='stage'||configs.findIndex(config=>config.id===state.stageId)>=index)collectionIds.add(state.collectionId);
    return frozen({taskId:task.id,revision:this.discardRevision(task),scope,initialIds:scope==='task'?task.mixedSampling?.initialGuesses.map(initial=>initial.id)??[]:initialIds,collectionIds:[...collectionIds],stageIds:[...new Set([...affected.flatMap(stage=>[stage.id,...(stage.configurationId?[stage.configurationId]:[])]),...(scope==='stage'?configs.slice(index).map(config=>config.id):[])])],frameIds:[...removed]});
  }
  assertDiscardConformer(plan:AdvancedDiscardConformerPlan):void {
    const task=this.task(plan.taskId);if(this.discardRevision(task)!==plan.revision)throw new Error('构象内容在确认期间改变；未执行旧丢弃计划。');
    if(!this.canDeleteTask(task.id))throw new Error('构象任务或所属资源仍在运行；未丢弃内容。');
  }
  async prepareDiscardConformer(plan:AdvancedDiscardConformerPlan):Promise<{assertCurrent():void;commit():void;release():Promise<void>}> {
    this.assertDiscardConformer(plan);const task=this.task(plan.taskId),removed=new Set(plan.frameIds);let remainingCandidates:string[]=[];
    if(plan.scope==='initial'){
      const candidates=(task.mixedSampling?.batches??[]).filter(batch=>!plan.initialIds.includes(batch.initialGuessId)).flatMap(batch=>batch.cards.flatMap(card=>card.frameIds)).map(id=>this.findFrame(task,id)!).filter(frame=>frame&&!removed.has(frame.id));
      const transient:AdvancedTaskRun={id:this.id('run'),taskId:task.id,mode:'start',status:'running',createdAt:this.now(),stages:[],frames:[],results:[],subjobCount:0,elapsedMs:0};
      this.deletingTasks.add(task.id);
      try{const result=await this.background<SamplingDeduplicationResult>(transient,{kind:'deduplicate',candidates:candidates.map(frame=>frame.source.structure),retained:[],threshold:task.mixedSampling?.draft.dedupRmsdAngstrom??.01});remainingCandidates=result.acceptedIndices.map(index=>candidates[index].id);}
      finally{this.deletingTasks.delete(task.id);}
      this.assertDiscardConformer(plan);
    }
    const sessions=[...new Set(task.runs.flatMap(run=>run.results.filter(result=>result.diagnosticDirectory&&(plan.scope==='task'||plan.scope==='sampling'||Boolean(result.frameId&&removed.has(result.frameId))||plan.stageIds.includes(result.stageId))).flatMap(result=>result.sessionId?[result.sessionId]:[])))];
    const artifacts=task.runs.flatMap(run=>{const pending=this.electronicPending.get(run.id);return pending&&plan.scope==='task'?[pending.receipt.artifactId]:[];});
    let committed=false,released=false;
    const assertCurrent=()=>{if(!committed)this.assertDiscardConformer(plan);};
    return{assertCurrent,commit:()=>{
      if(committed)return;this.assertDiscardConformer(plan);
      if(plan.scope==='task'){for(const run of task.runs){this.plans.delete(run.id);this.electronicPending.delete(run.id);this.finishWaiters(run.id);}this.tasks.delete(task.id);}
      else if(plan.scope==='sampling')this.clearWorkflowResults(task,undefined,false);
      else if(plan.scope==='stage'){const indices=task.runs.flatMap(run=>run.stages.filter(stage=>plan.stageIds.includes(stage.id)).map(stage=>stage.index));const first=this.stageConfigs(task).findIndex(config=>plan.stageIds.includes(config.id));this.clearWorkflowResults(task,indices.length?Math.min(...indices):first,false);}
      else{
        const state=task.mixedSampling!;state.initialGuesses=state.initialGuesses.filter(initial=>!plan.initialIds.includes(initial.id));state.batches=(state.batches??[]).filter(batch=>!plan.initialIds.includes(batch.initialGuessId));
        if(plan.initialIds.includes(state.selectedInitialGuessId)){state.selectedInitialGuessId=state.initialGuesses[0].id;state.electronicConfirmation=undefined;}task.spec.source=state.initialGuesses[0].source;
        if(!state.batches.some(batch=>batch.id===state.currentBatchId))state.currentBatchId=state.batches.at(-1)?.id;
        for(const run of task.runs){run.frames=run.frames.filter(frame=>!removed.has(frame.id));run.results=run.results.filter(result=>!result.frameId||!removed.has(result.frameId));
          if(run.sampling)run.sampling.candidateFrameIds=run.sampling.candidateFrameIds.filter(id=>!removed.has(id));
          for(const stage of run.stages){const discarded=new Set((stage.inputs??[]).filter(input=>input.source.ref.frameId&&removed.has(input.source.ref.frameId)).map(input=>input.candidateId));stage.inputs=stage.inputs?.filter(input=>!discarded.has(input.candidateId));stage.inputCandidateIds=stage.inputCandidateIds.filter(id=>!discarded.has(id));stage.results=stage.results.filter(result=>!discarded.has(result.candidateId)&&(!result.frameId||!removed.has(result.frameId)));if(discarded.size){stage.clustering=undefined;stage.promotedCandidateIds=[];stage.status='stopped';}}
        }
        task.runs=task.runs.filter(run=>!run.mixedSampling||!plan.initialIds.includes(run.mixedSampling.initialGuessId));
        const workflow=task.conformerWorkflow!;workflow.revision++;workflow.candidateSet={id:workflow.candidateSet?.id??`${task.id}-candidates`,revision:workflow.revision,frameIds:remainingCandidates,valid:remainingCandidates.length>0};
        for(const stage of [...workflow.stages,...workflow.history??[]]){stage.resultFrameIds=stage.resultFrameIds?.filter(id=>!removed.has(id));stage.representativeFrameIds=stage.representativeFrameIds.filter(id=>!removed.has(id));stage.promotedFrameIds=[];stage.valid=false;stage.completed=false;}
        task.usage.retainedFrames=task.guessFrames.length+task.runs.reduce((sum,run)=>sum+run.frames.length,0);task.usage.retainedCoordinates=[...task.guessFrames,...task.runs.flatMap(run=>run.frames)].reduce((sum,frame)=>sum+frame.source.structure.atoms.length,0);
      }
      committed=true;this.publish();
    },release:async()=>{if(!committed)throw new Error('丢弃尚未提交，不能释放有效来源。');if(released)return;
      for(const artifact of artifacts)if(!this.deps.bridge?.releaseXtbElectronicArtifacts||!(await this.deps.bridge.releaseXtbElectronicArtifacts(artifact)).released)throw new Error('构象内容已丢弃，电子来源缓存仍待收尾。');
      this.releaseOptimizationCaches(sessions);await this.settleCacheReleases();released=true;
    }};
  }
  async discardConformer(plan:AdvancedDiscardConformerPlan):Promise<void>{const transaction=await this.prepareDiscardConformer(plan);transaction.commit();await transaction.release();}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private now() { return this.deps.now?.() ?? Date.now(); }
  private id(kind: 'task' | 'run' | 'session') {
    const id = this.deps.createId?.(kind) ?? `${kind}-${crypto.randomUUID()}`;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('高级任务身份无效。');
    return id;
  }
  private publish() {
    if (this.progressTimer) { clearTimeout(this.progressTimer); this.progressTimer = undefined; }
    const job = this.activeJobs.values().next().value as NativeJob | undefined;
    const activeNative = job ? { taskId: job.task.id, runId: job.run.id,
      sessionId: job.sessionId, stageId: job.stage.id, candidateId: job.input.candidateId } : this.activeForcefields.values().next().value?.info ?? this.activeRoute?.info ?? null;
    // Retained frames are immutable. Reuse their frozen buffers between UI
    // snapshots instead of recopying the whole growing native trajectory on
    // every progress event; mutable lifecycle/result metadata stays detached.
    const tasks=[...this.tasks.values()].map(task=>this.snapshot(task));
    this.state = frozen({ tasks, activeNative, queue: structuredClone(this.queue),
      ignoredEvents: this.state.ignoredEvents, disposed: this.disposed });
    for (const listener of this.listeners) listener();
  }
  private task(taskId: string) { const task = this.tasks.get(taskId); if (!task) throw new Error('高级任务不存在。'); return task; }
  private nextSession() { const id = this.id('session'); if (this.issuedSessions.has(id)) throw new Error('原生会话身份不得复用。'); this.issuedSessions.add(id); return id; }
  private run(task: AdvancedTaskRecord, runId: string) { const run = task.runs.find(r => r.id === runId); if (!run) throw new Error('高级运行不存在。'); return run; }
  private explicit(_task: AdvancedTaskRecord) {
    // A captured task owns its immutable source independently of any current
    // document/activation. Only createTask captures a new source and invokes
    // the Shell's source guard; start/resume/retry act on the retained task.
    if (this.disposed) throw new Error('高级任务控制器已关闭。');
    if (this.deletingTasks.has(_task.id)) throw new Error('高级任务正在删除。');
  }
  private busy(task: AdvancedTaskRecord) { return task.runs.some(r => !terminalStatuses.has(r.status)); }
  private budget(input: Partial<AdvancedRunBudget> | undefined): AdvancedRunBudget {
    const budget = { ...DEFAULT_ADVANCED_RUN_BUDGET, ...input };
    if (![budget.maxCandidates, budget.maxStages, budget.maxNativeJobs, budget.maxRetainedFrames, budget.maxRetainedCoordinates, budget.maxProcessStages, budget.maxBiasHistoryEntries]
        .every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('高级任务容量必须为有效正整数。');
    return budget;
  }
  /** Capacity follows the accepted workload, including preserved earlier runs.
   * This is an admission estimate, not allocation or a claim of an RSS hard limit. */
  private workflowCapacity(spec: AdvancedTaskSpec, budget: AdvancedRunBudget, usage?: AdvancedTaskRecord['usage'],
    request: { candidates?: number; samplingRecords?: number; stageIndex?: number; endStageIndex?: number } = {}): AdvancedRunBudget {
    if (!['sampling', 'conformer-search'].includes(spec.kind)) return budget;
    const schedule = spec.kind === 'sampling' ? conformerSamplingSchedule(spec.sampling) : null;
    const mixedCards = spec.kind === 'sampling' ? spec.mixedSampling?.cards : undefined;
    const checkedSchedule = (options: AdvancedSamplingTaskOptions) => {
      const value = conformerSamplingSchedule(options); if (!value) throw new Error('采样卡时间须对应完整积分步。'); return value;
    };
    const mixedSchedules = mixedCards?.filter(card => card.kind === 'sampling').map(card => ({ options: card.sampling, schedule: checkedSchedule(card.sampling) }));
    const mixedTarget = mixedCards?.reduce((sum, card) => sum + (card.kind === 'sampling' ? checkedSchedule(card.sampling).candidateCount
      : card.search.quantity.mode === 'total-effective' ? card.search.quantity.targetCount : card.search.torsions.reduce((count, row) => count * (row.pointCount ?? card.search.quantity.pointsPerTorsion), 1)), 0);
    const target = (mixedTarget === 0 ? 1 : mixedTarget) ?? (spec.kind === 'conformer-search' ? spec.search.quantity.mode === 'total-effective' ? spec.search.quantity.targetCount
      : spec.search.torsions.reduce((count, item) => count * (item.pointCount ?? spec.search.quantity.pointsPerTorsion), 1) : schedule?.candidateCount);
    const retainedCandidates=usage?[...this.tasks.values()].find(task=>task.usage===usage)?.conformerWorkflow?.candidateSet?.frameIds.length??0:0;
    const candidates = request.candidates ?? (target===undefined?undefined:target+retainedCandidates);
    if (!Number.isSafeInteger(candidates) || candidates! < 1) throw new Error('本次候选数量必须是可精确表示的正整数。');
    const stages = spec.kind === 'conformer-search' ? spec.search.stages : spec.kind === 'sampling' ? spec.optimizationStages : [];
    let count = candidates!, jobs = request.stageIndex === undefined && spec.kind === 'sampling' ? mixedSchedules?.length ?? 1 : 0, stageFrames = 0;
    for (let index = request.stageIndex ?? 0; index < stages.length && index <= (request.endStageIndex ?? stages.length); index++) {
      jobs += count; stageFrames += count * 2; count = Math.min(count, stages[index+1]?.inputClusterCount??stages[index].advanceCount??count);
    }
    const mixedRecords = mixedCards?.reduce((sum, card) => sum + (card.kind === 'sampling' ? checkedSchedule(card.sampling).recordCount
      : card.search.quantity.mode === 'total-effective' ? card.search.quantity.targetCount : card.search.torsions.reduce((count, row) => count * (row.pointCount ?? card.search.quantity.pointsPerTorsion), 1)), 0);
    const records = request.samplingRecords ?? (request.stageIndex === undefined ? mixedRecords ?? schedule?.recordCount ?? candidates! : 0);
    const sampling = spec.kind === 'sampling' && request.stageIndex === undefined ? spec.sampling : undefined;
    const biasFor = (options: AdvancedSamplingTaskOptions, steps: number) => options.operation === 'metadynamics' ? Math.floor(steps * (options.dtFs ?? .5) / (options.metadynamics?.depositEveryFs ?? 100)) + 1 : 0;
    const biasCount = mixedSchedules && request.stageIndex === undefined ? mixedSchedules.reduce((sum, card) => sum + biasFor(card.options, card.schedule.totalSteps), 0)
      : sampling && schedule ? biasFor(sampling, schedule.totalSteps) : 0;
    const biasCoordinates = mixedSchedules && request.stageIndex === undefined ? mixedSchedules.reduce((sum, card) => sum + biasFor(card.options, card.schedule.totalSteps)
      * (card.options.operation === 'metadynamics' ? card.options.metadynamics?.atomIds?.length ?? spec.source.structure.atoms.length : 0), 0)
      : biasCount * (sampling?.operation === 'metadynamics' ? sampling.metadynamics?.atomIds?.length ?? spec.source.structure.atoms.length : 0);
    const annealing = sampling?.operation === 'anneal' ? sampling.annealing : undefined;
    const legacyAnnealing = annealing && [annealing.heatingFs, annealing.highHoldFs, annealing.coolingFs, annealing.lowHoldFs].some(value => value !== undefined);
    const processStages = sampling?.operation === 'anneal' ? (annealing?.cycles ?? 5) * (legacyAnnealing ? 4 : 3) : sampling ? 1 : 0;
    const frames = (usage?.retainedFrames ?? 0) + records + stageFrames;
    const coordinates = (usage?.retainedCoordinates ?? 0) + (records + stageFrames) * spec.source.structure.atoms.length + biasCoordinates;
    if (![coordinates, frames, jobs].every(Number.isSafeInteger)) throw new Error('任务规模超过可精确表示的整数范围。');
    return { ...budget, maxCandidates: Math.max(budget.maxCandidates, candidates!), maxNativeJobs: Math.max(budget.maxNativeJobs, (usage?.nativeJobs ?? 0) + jobs),
      maxRetainedFrames: Math.max(budget.maxRetainedFrames, frames), maxRetainedCoordinates: Math.max(budget.maxRetainedCoordinates, coordinates),
      maxProcessStages: Math.max(budget.maxProcessStages, (usage?.processStages ?? 0) + processStages),
      maxBiasHistoryEntries: Math.max(budget.maxBiasHistoryEntries, (usage?.biasHistoryEntries ?? 0) + biasCount) };
  }
  private validateOptions(options: AdvancedXtbOptions) {
    if (!['gfn0', 'gfn1', 'gfn2', 'gfnff'].includes(options.method) || !Number.isSafeInteger(options.threads) || options.threads < 1
      || !Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1 || !options.solvent
      || typeof options.internalConstraintsConfirmed !== 'boolean') throw new Error('高级xTB方法、核数、步数或约束确认无效。');
    if (options.solvation && (!['alpb', 'gbsa'].includes(options.solvation.model) || !options.solvation.solvent
      || options.method === 'gfn0' || options.method === 'gfnff' && options.solvation.model !== 'alpb')) throw new Error('所选xTB方法没有该隐式溶剂模型，未更换方法或回退气相。');
    if (options.solvation && !['none', 'gas', '', options.solvation.solvent, `${options.solvation.model}:${options.solvation.solvent}`].includes(options.solvent)) throw new Error('溶剂名称与显式模型配置冲突。');
  }
  private validateMethod(method: AdvancedOptimizationMethod) {
    if (method.backend === 'xtb') this.validateOptions(method.options);
    else if (method.backend !== 'forcefield' || !['auto', 'MMFF94', 'MMFF94s', 'UFF'].includes(method.forcefield)
      || !Number.isSafeInteger(method.threads) || method.threads < 1 || !Number.isSafeInteger(method.maxSteps)
      || method.maxSteps < 1 || !method.solvent) throw new Error('高级优化方法无效。');
  }
  createTask(spec: AdvancedTaskSpec): string {
    if(spec.kind==='sampling')spec={...spec,optimizationStages:normalizeConformerStageConfigs(spec.optimizationStages)};
    else if(spec.kind==='conformer-search')spec={...spec,search:{...spec.search,stages:normalizeConformerStageConfigs(spec.search.stages)}};
    if(spec.kind==='sampling'&&spec.sampling.operation==='anneal')throw new Error('退火已停用，历史结果仍可查看。');
    if (this.disposed) throw new Error('高级任务控制器已关闭。');
    this.deps.currentSourceGuard?.(spec.source); assertAdvancedIsolated(spec.source);
    const normalizedConstraints = { ...structuredClone(spec.source.constraints), coordinates: spec.source.constraints.coordinates.map(row => ({
      ...structuredClone(row), ...(spec.source.constraints.enabled===false?{}:{value: row.value ?? builderCoordinateValue(spec.source.structure, row.type, row.atomIds)}),
    })) };
    if (spec.kind !== 'singlepoint' && effectiveSharedFreezes(normalizedConstraints).coordinates.some(row => row.action !== 'freeze')) throw new Error('高级优化不能将扫描定义当成冻结。');
    if (effectiveSharedFreezes(normalizedConstraints).coordinates.some(row => row.images?.some(image => image.some(Boolean)))) throw new Error('孤立高级任务不能解释带非零晶胞图像的冻结坐标。');
    const source = captureAdvancedFrame(spec.source.structure, spec.source.ref, spec.source.stamp, spec.source.label, normalizedConstraints);
    const budget = this.workflowCapacity(spec, this.budget(spec.kind === 'path' ? { maxCandidates: 128, ...spec.budget } : spec.budget)), id = this.id('task');
    if (this.tasks.has(id)) throw new Error('高级任务身份重复。');
    if (spec.kind === 'singlepoint') { this.validateOptions(spec.options); if (spec.options.method !== 'gfn2') throw new Error('电子来源单点目前要求GFN2。'); }
    else if (spec.kind === 'optimization') this.validateMethod(spec.method);
    else if (spec.kind === 'path') {
      this.validateRouteOptions(spec.path);
      if (spec.path.operation === 'scan') budget.maxCandidates=Math.max(budget.maxCandidates,pathScanPointCount(spec.path.scan));
      if (spec.path.operation === 'ci-neb-ts') {
        if (!spec.productSource) throw new Error('双端路径需要完整产品端来源快照。');
        this.deps.currentSourceGuard?.(spec.productSource); assertAdvancedIsolated(spec.productSource);
        if (graphFingerprint(spec.productSource.structure) !== graphFingerprint(spec.path.neb.product)
          || coordinatesFingerprint(spec.productSource.structure) !== coordinatesFingerprint(spec.path.neb.product)) throw new Error('路径产品端结构与所捕获来源不一致。');
      }
    } else if (spec.kind === 'conformer-search' || spec.kind === 'sampling' || spec.kind === 'docking') {
      const stages = spec.kind === 'conformer-search' ? spec.search.stages : spec.optimizationStages;
      if (spec.kind === 'docking') {
        if (spec.fragments && spec.partnerSource) throw new Error('同帧A/B与旧双来源模式不能混用。');
        if (!spec.fragments) { if (!spec.partnerSource) throw new Error('请定义同帧A/B片段。'); this.deps.currentSourceGuard?.(spec.partnerSource); assertAdvancedIsolated(spec.partnerSource); }
        const settings = dockingSettings(spec.docking);
        const pair = spec.fragments ? prepareSameFrameDocking(source, spec.fragments).sources : [source, spec.partnerSource!];
        for (const input of pair) {
          if (input.structure.charge !== 0 || input.structure.multiplicity !== 1) throw new Error('首批aISS需要两个显式中性闭壳层完整来源，未改变电荷或自旋。');
          if (input.constraints.frozenAtomIds.length || input.constraints.coordinates.length || input.structure.modelLayers?.some(layer => layer.frozen)) throw new Error('aISS尚无来源冻结适配，不能静默丢弃XYZ、B/A/D或冻结层。');
        }
        if (pair.reduce((n, s) => n + s.structure.atoms.length, 0) > 500 || settings.refinement.candidateCount > budget.maxCandidates) throw new Error('aISS合并原子或候选数超过本任务有界预算。');
      }
      if (spec.kind === 'sampling') {
        this.validateRouteOptions(spec.sampling, 7200);
        conformerSamplingBudgetPlan(spec.sampling,source.structure.atoms.length,budget);
        if (!CONFORMER_SAMPLING_CAPABILITIES.implementedMethods.includes(spec.sampling.method)) throw new Error('采样方法尚无该路线适配，没有自动更换计算方法。');
        if (!spec.mixedSampling && effectiveSharedFreezes(source.constraints).coordinates.length) throw new Error('MD采样尚未验证B/A/D动量约束，不能静默丢弃来源冻结；XYZ冻结与核心软保护另行保留。');
      }
      if (stages.length > budget.maxStages) throw new Error('构象优化级数超出本任务预算。');
      const ids = new Set<string>();
      for (const [index,stage] of stages.entries()) {
        this.validateMethod(stage.method);
        const count=spec.kind==='docking'?stage.advanceCount:index?stage.inputClusterCount:1;
        if (!stage.id || ids.has(stage.id) || !Number.isSafeInteger(count) || count! < 1) throw new Error('构象级次身份或输入簇数无效。');
        if(!Number.isSafeInteger(stage.inputStride??1)||(stage.inputStride??1)<1)throw Error('抽帧间隔须为正整数。');
        if(stage.clustering?.rmsdMatching!==undefined&&!['fixed','symmetry'].includes(stage.clustering.rmsdMatching))throw Error('RMSD匹配方式无效。');
        ids.add(stage.id);
      }
    } else throw new Error('未知高级任务类型。');
    const storedSpec: AdvancedTaskSpec = spec.kind === 'docking' ? { ...structuredClone(spec), source,
      partnerSource: spec.partnerSource ? captureAdvancedFrame(spec.partnerSource.structure, spec.partnerSource.ref, spec.partnerSource.stamp, spec.partnerSource.label, spec.partnerSource.constraints) : undefined,
      docking: { ...dockingSettings(spec.docking), threads: spec.docking.threads } } : spec.kind === 'sampling'
      ? { ...structuredClone(spec), source, sampling: withoutDeadline(structuredClone(spec.sampling)) }
      : { ...structuredClone(spec), source };
    if (spec.kind === 'sampling' && spec.mixedSampling) this.validateMixedDefinition({ spec: storedSpec }, spec.mixedSampling);
    this.tasks.set(id, { id, createdAt: this.now(), spec: storedSpec, budget,
      guessFrames: [], runs: [], ...(['sampling','docking','conformer-search'].includes(spec.kind) ? { conformerWorkflow: { revision: 0, stages: [],...(spec.kind!=='docking'?{inputSemantics:2 as const}:{}) } } : {}),
      usage: { elapsedMs: 0, nativeJobs: 0, retainedFrames: 0, retainedCoordinates: 0, processStages: 0, biasHistoryEntries: 0 } });
    if (spec.kind === 'sampling' && spec.mixedSampling) {
      const task = this.task(id), initialId = `${id}-initial-1`;
      task.mixedSampling = { initialGuesses: [{ id: initialId, label: '初猜帧1', source,
        atomMapping: source.structure.atoms.map(atom => ({ sourceAtomId: atom.id!, taskAtomId: atom.id! })) }],
      selectedInitialGuessId: initialId, draft: structuredClone(spec.mixedSampling),batches:[] };
    }
    this.publish(); return id;
  }
  generateGuesses(taskId: string): void {
    const task = this.task(taskId); this.explicit(task);
    if (task.spec.kind !== 'conformer-search' || this.busy(task) || task.guesses) throw new Error('仅空闲且尚无初猜的构象任务可生成；新配置请创建新任务。');
    if (typeof Worker !== 'undefined') { this.enqueue(task, 'start', { stageIndex: 0, intent: 'sampling' }); return; }
    const { spec } = task, snapshot = createConformerSnapshot(spec.source.structure, spec.source.ref, spec.source.constraints);
    const guesses = generateConformerGuesses(snapshot, spec.search.torsions, spec.search.quantity, {
      limits: { ...spec.search.samplingLimits, maxCandidates: Math.min(task.budget.maxCandidates, spec.search.samplingLimits?.maxCandidates ?? task.budget.maxCandidates) },
      clashPolicy: spec.search.clashPolicy,
    });
    if (task.usage.retainedFrames + guesses.guesses.length > task.budget.maxRetainedFrames
      || task.usage.retainedCoordinates + guesses.guesses.length * spec.source.structure.atoms.length > task.budget.maxRetainedCoordinates) throw new Error('初猜集合超过本任务完整帧保留预算，未发布部分集合。');
    const frames = guesses.guesses.map(guess => this.makeFrame(task, undefined, 'guesses', guess.id, guess.structure, 'guess', spec.source));
    task.guesses = guesses; task.guessFrames.push(...frames); this.setCandidateSet(task, frames); this.publish();
  }
  private preflight(task: AdvancedTaskRecord, methodsOverride?: AdvancedOptimizationMethod[], skipRoute = false) {
    if (task.spec.kind === 'path') { if (!this.deps.pathBridge) throw new Error('当前没有受管路径执行入口。'); return; }
    if (!skipRoute && task.spec.kind === 'sampling' && !this.deps.samplingBridge
      && (!task.mixedSampling || task.mixedSampling.draft.cards.some(card => card.kind === 'sampling'))) throw new Error('当前没有受管构象采样入口。');
    if (!skipRoute && task.spec.kind === 'docking' && !this.deps.aissBridge) throw new Error('当前没有受管aISS对接入口。');
    const methods = methodsOverride ?? (task.spec.kind === 'singlepoint' ? [{ backend: 'xtb' as const, options: task.spec.options }]
      : task.spec.kind === 'optimization' ? [task.spec.method] : task.spec.kind === 'sampling' || task.spec.kind === 'docking' ? task.spec.optimizationStages.map(s => s.method) : task.spec.search.stages.map(s => s.method));
    for (const method of methods) {
      const solvent = method.backend === 'xtb' ? method.options.solvent : method.solvent;
      if (method.backend === 'forcefield' && !['none', 'gas', ''].includes(solvent)) throw new Error('当前力场没有溶剂适配，未回退气相。');
      if (method.backend === 'xtb' && !method.options.solvation && !['none', 'gas', ''].includes(solvent)) throw new Error('请显式提供含模型与规范名称的溶剂配置，未猜测溶剂。');
      if (method.backend === 'forcefield') {
        if (!this.deps.forcefieldAdapter) throw new Error('当前ChemistryPort缺少可核线程、时间和关闭回执的力场适配。');
      } else {
        if (!this.deps.bridge) throw new Error('当前没有随包xTB执行入口。');
        const constraints = task.spec.kind === 'docking' && task.spec.fragments ? [] : effectiveSharedFreezes(task.spec.source.constraints).coordinates;
        if (task.spec.kind !== 'singlepoint' && constraints.length && !method.options.internalConstraintsConfirmed) throw new Error('请明确确认本次原生内坐标约束。');
      }
    }
    if (task.spec.kind === 'singlepoint' && (!this.deps.bridge?.readXtbElectronicArtifacts
      || !this.deps.bridge.releaseXtbElectronicArtifacts || !this.deps.onElectronicResult)) throw new Error('GFN2单点尚缺受管电子来源交接入口。');
  }
  private conformerTask(taskId: string) {
    const task = this.task(taskId); this.explicit(task);
    if (!task.conformerWorkflow) throw new Error('此任务不是构象采样/优化工作流。');
    if (this.busy(task)) throw new Error('构象任务正在运行，不能改变或并发提交同一任务。');
    return task;
  }
  private stageConfigKey(config: AdvancedOptimizationStageConfig): string {
    const method = config.method.backend === 'xtb' ? { backend: 'xtb', method: config.method.options.method,
      solvent: config.method.options.solvent, solvation: config.method.options.solvation, internalConstraintsConfirmed: config.method.options.internalConstraintsConfirmed }
      : { backend: 'forcefield', forcefield: config.method.forcefield, solvent: config.method.solvent };
    return JSON.stringify({ method, clustering: { rmsdThresholdAngstrom: config.clustering?.rmsdThresholdAngstrom ?? DEFAULT_CONFORMER_CLUSTERING_POLICY.rmsdThresholdAngstrom,
      maxDeltaEnergyHartree: config.clustering && 'maxDeltaEnergyHartree' in config.clustering ? config.clustering.maxDeltaEnergyHartree : DEFAULT_CONFORMER_CLUSTERING_POLICY.maxDeltaEnergyHartree,
      ...(config.clustering?.rmsdMatching==='symmetry'?{rmsdMatching:'symmetry'}:{}),...(config.clustering?.eliminateEquivalent!==undefined?{eliminateEquivalent:config.clustering.eliminateEquivalent}:{}) },...(config.advanceCount!==undefined?{advanceCount:config.advanceCount}:{}),...(config.inputClusterCount!==undefined?{inputClusterCount:config.inputClusterCount}:{}),...((config.inputStride??1)!==1?{inputStride:config.inputStride}:{}) });
  }
  private calculationMethodKey(method:AdvancedOptimizationMethod):string {
    return JSON.stringify(method.backend==='xtb'?{backend:'xtb',method:method.options.method,solvent:method.options.solvent,solvation:method.options.solvation,internalConstraintsConfirmed:method.options.internalConstraintsConfirmed}:{backend:'forcefield',forcefield:method.forcefield,solvent:method.solvent});
  }
  private sameInput(a:CandidateInput,b:CandidateInput):boolean {
    return a.candidateId===b.candidateId&&a.source.ref.frameId===b.source.ref.frameId&&coordinatesFingerprint(a.source.structure)===coordinatesFingerprint(b.source.structure)
      &&graphFingerprint(a.source.structure)===graphFingerprint(b.source.structure)&&same(a.source.constraints,b.source.constraints);
  }
  previewStageConfiguration(taskId:string,configs:AdvancedOptimizationStageConfig[]) {
    const task=this.task(taskId),old=this.stageConfigs(task);
    let boundary=Math.min(configs.length,old.length);
    for(const [index,config]of configs.entries()){
      const previous=old[index];if(!previous)continue;
      if(config.id!==previous.id||this.calculationMethodKey(config.method)!==this.calculationMethodKey(previous.method))boundary=Math.min(boundary,index);
      else if(this.stageConfigKey(config)!==this.stageConfigKey(previous)){
        // Retained calculations at this level can be reorganized/reselected.
        // Changing their resulting collection invalidates downstream results.
        boundary=Math.min(boundary,index+1);
      }
    }
    const affectedStageIds=old.slice(boundary).map(config=>config.id);
    const stages=new Set(task.runs.flatMap(run=>run.stages.filter(stage=>stage.index>=boundary).map(stage=>stage.id)));
    const affectedFrameCount=task.runs.reduce((sum,run)=>sum+run.frames.filter(frame=>stages.has(frame.stageId)).length,0);
    return{requiresConfirmation:affectedFrameCount>0,affectedStageIds,affectedFrameCount};
  }
  private captureResources(run: AdvancedTaskRun, stageId: string, candidateId: string, forcefield = false) {
    const configured = this.deps.resolveResources?.(); if (!configured) return;
    if (!Number.isSafeInteger(configured.effective.threads) || configured.effective.threads < 1
      || !Number.isSafeInteger(configured.effective.memoryBudgetBytes) || configured.effective.memoryBudgetBytes < 1) throw new Error('全局计算资源快照无效。');
    const record = { stageId, candidateId, configured: structuredClone(configured),
      requested: { threads: forcefield ? 1 : configured.effective.threads, memoryBudgetBytes: configured.effective.memoryBudgetBytes } } as NonNullable<AdvancedTaskRun['resourceRequests']>[number];
    (run.resourceRequests ??= []).push(record); return record;
  }
  confirmMixedElectronicState(taskId: string, source: AdvancedFrameSource, electronic: {charge:number;multiplicity:number}): void {
    const task=this.conformerTask(taskId);
    if(!task.mixedSampling || !Number.isSafeInteger(electronic.charge) || !Number.isSafeInteger(electronic.multiplicity) || electronic.multiplicity<1
      || task.spec.source.structure.charge!==electronic.charge || task.spec.source.structure.multiplicity!==electronic.multiplicity) throw new Error('电子态确认与任务实际电荷/多重度不一致。');
    task.mixedSampling.electronicConfirmation=advancedElectronicSourceConfirmationKey(source,electronic);this.publish();
  }
  clearMixedElectronicConfirmation(taskId:string):void {
    const task=this.conformerTask(taskId);if(task.mixedSampling?.electronicConfirmation){task.mixedSampling.electronicConfirmation=undefined;this.publish();}
  }
  private setCandidateSet(task: AdvancedTaskRecord, frames: AdvancedResultFrame[], producerRunId?: string) {
    const workflow = task.conformerWorkflow!;
    workflow.candidateSet = { id: task.mixedSampling ? `${task.id}-candidates` : `${task.id}-candidates-${workflow.revision}`, revision: workflow.revision,
      frameIds: frames.map(frame => frame.id), producerRunId, valid: frames.length > 0 };
    for (const stage of workflow.stages) stage.valid = false;
  }
  /** Four stage controls; operational resources never become scientific keys. */
  configureStages(taskId: string, configs: AdvancedOptimizationStageConfig[]): void {
    const task = this.conformerTask(taskId);
    if(task.conformerWorkflow?.inputSemantics===2)configs=normalizeConformerStageConfigs(configs);
    if (configs.length > task.budget.maxStages || new Set(configs.map(config => config.id)).size !== configs.length) throw new Error('优化级数或级次身份无效。');
    const normalized = configs.map((config,index) => {
      const method = structuredClone(config.method);
      this.validateMethod(method);
      const count=task.conformerWorkflow?.inputSemantics===2?index?config.inputClusterCount:1:config.advanceCount;
      if (!config.id || !Number.isSafeInteger(count) || count! < 1) throw new Error('选取上一级簇数须为正整数。');
      if(!Number.isSafeInteger(config.inputStride??1)||(config.inputStride??1)<1)throw Error('抽帧间隔须为正整数。');
      const clustering = { ...DEFAULT_CONFORMER_CLUSTERING_POLICY, ...config.clustering };
      if (!Number.isFinite(clustering.rmsdThresholdAngstrom) || clustering.rmsdThresholdAngstrom < 0
        || clustering.rmsdMatching!==undefined&&!['fixed','symmetry'].includes(clustering.rmsdMatching)
        || clustering.maxDeltaEnergyHartree !== undefined && (!Number.isFinite(clustering.maxDeltaEnergyHartree) || clustering.maxDeltaEnergyHartree < 0)) throw new Error('归簇双阈值无效。');
      return { ...structuredClone(config), method, clustering };
    });
    const old = this.stageConfigs(task), firstChanged = normalized.findIndex((config, index) => config.id !== old[index]?.id || this.stageConfigKey(config) !== this.stageConfigKey(old[index]));
    const methodChanged=normalized.findIndex((config,index)=>!old[index]||config.id!==old[index].id||this.calculationMethodKey(config.method)!==this.calculationMethodKey(old[index].method));
    const clearFrom=methodChanged>=0?methodChanged:normalized.length<old.length?normalized.length:undefined;
    if(clearFrom!==undefined)this.clearWorkflowResults(task,clearFrom);
    const boundary = firstChanged < 0 ? Math.min(old.length, normalized.length) : firstChanged;
    if (boundary === old.length && boundary === normalized.length) {
      if (task.spec.kind === 'conformer-search') task.spec.search.stages = normalized;
      else if (task.spec.kind === 'sampling' || task.spec.kind === 'docking') task.spec.optimizationStages = normalized;
      this.publish(); return;
    }
    task.conformerWorkflow!.revision++;
    for (const stage of task.conformerWorkflow!.stages) if (normalized.findIndex(config => config.id === stage.stageId) >= boundary || !normalized.some(config => config.id === stage.stageId)) stage.valid = false;
    if (task.spec.kind === 'conformer-search') task.spec.search.stages = normalized;
    else if (task.spec.kind === 'sampling' || task.spec.kind === 'docking') task.spec.optimizationStages = normalized;
    this.publish();
  }
  private ensureSamplingBatches(task:AdvancedTaskRecord):AdvancedSamplingBatch[] {
    const state=task.mixedSampling!;if(state.batches)return state.batches;
    state.batches=[];state.batchSerial=0;
    // Older projects retain their scientific prefix but did not save a valid
    // torsion cursor. Import those records as immutable historical batches.
    for(const run of task.runs){const mixed=run.mixedSampling;if(!mixed)continue;
      const batch:AdvancedSamplingBatch={id:`${task.id}-batch-${++state.batchSerial}`,initialGuessId:mixed.initialGuessId,source:mixed.source,definition:structuredClone(mixed.definition),createdAt:run.createdAt,sealed:true,sealedReason:'legacy',cards:[],mergedFrameIds:mixed.cards.flatMap(card=>card.frameIds)};
      for(const configuration of mixed.definition.cards){const prior=mixed.cards.find(card=>card.id===configuration.id),card=makeSamplingCardState(configuration,mixed.definition,mixed.source);
        card.frameIds=run.frames.filter(frame=>frame.samplingOrigin?.cardId===card.id&&(frame.kind==='guess'||frame.kind==='sampled-candidate')).map(frame=>frame.id);
        card.mergedFrameIds=prior?.frameIds??[];card.generated=card.frameIds.length;card.accepted=card.mergedFrameIds.length;card.duplicates=card.generated-card.accepted;card.status=prior?.status??'stopped';
        if(configuration.kind==='sampling'){const frames=run.frames.filter(frame=>frame.samplingOrigin?.cardId===card.id&&frame.process?.kind==='sampling');card.completedTimeFs=Math.max(0,...frames.map(frame=>frame.process?.kind==='sampling'?frame.process.data.timeFs:0));}
        batch.cards.push(card);
      }
      mixed.batchId=batch.id;state.batches.push(batch);state.currentBatchId=batch.id;
    }
    return state.batches;
  }
  private selectedMixedSource(task:AdvancedTaskRecord,definition=task.mixedSampling!.draft,baseSource?:AdvancedFrameSource) {
    const state=task.mixedSampling!,selected=state.initialGuesses.find(initial=>initial.id===state.selectedInitialGuessId)!;
    const source=baseSource??selected.source;
    // F/shared constraints belong to the document. Soft-core definitions never
    // overwrite them; a run resolves their union in its own snapshot.
    resolveConformerProtection(source,definition);
    return {initialId:selected.id,source};
  }
  private newSamplingBatch(task:AdvancedTaskRecord):AdvancedSamplingBatch {
    const state=task.mixedSampling!,batches=this.ensureSamplingBatches(task),definition=sharedFreezeRunDefinition(state.draft),selected=this.selectedMixedSource(task,definition);
    state.batchSerial=(state.batchSerial??batches.length)+1;
    const batch:AdvancedSamplingBatch={id:`${task.id}-batch-${state.batchSerial}`,initialGuessId:selected.initialId,source:selected.source,definition:structuredClone(definition),createdAt:this.now(),sealed:false,cards:[],mergedFrameIds:[]};
    batch.cards=batch.definition.cards.map(card=>makeSamplingCardState(card,batch.definition,batch.source));batches.push(batch);state.currentBatchId=batch.id;return batch;
  }
  private sealSamplingBatches(task:AdvancedTaskRecord,reason:'append'|'optimization') {
    if(!task.mixedSampling)return;for(const batch of this.ensureSamplingBatches(task))if(!batch.sealed){batch.sealed=true;batch.sealedReason=reason;}
  }
  previewMixedConfiguration(taskId:string,definition:AdvancedMixedSamplingDefinition) {
    const task=this.task(taskId);this.validateMixedDefinition(task,definition);const batches=task.mixedSampling?.batches??[],batch=batches.find(batch=>batch.id===task.mixedSampling?.currentBatchId);
    const source=task.mixedSampling?this.selectedMixedSource(task,definition).source:task.spec.source;
    const affected=batch&&!batch.sealed?batch.cards.filter(card=>card.frameIds.length&&(!definition.cards.some(next=>next.id===card.id)||definition.cards.some(next=>next.id===card.id&&mixedCardScienceKey(next,definition,source)!==card.scienceKey))):[];
    const sealed=batch?.sealed??Boolean(!task.mixedSampling?.batches&&task.runs.some(run=>run.mixedSampling));
    const pendingCardIds=definition.cards.filter(configuration=>{const old=batch?.cards.find(card=>card.id===configuration.id);return!old||old.scienceKey!==mixedCardScienceKey(configuration,definition,source)||samplingCardNeedsWork({...old,configuration});}).map(card=>card.id);
    return {requiresConfirmation:affected.length>0,affectedCardIds:affected.map(card=>card.id),affectedFrameCount:affected.reduce((sum,card)=>sum+card.frameIds.length,0),sealed,pendingCardIds,canContinue:!sealed&&pendingCardIds.length>0};
  }
  continueSampling(taskId:string):string{return this.startSampling(taskId,'continue');}
  appendSampling(taskId:string):string{return this.startSampling(taskId,'append');}
  restartSampling(taskId:string):string{return this.startSampling(taskId,'replace');}
  reorganizeSampling(taskId:string):string {
    const task=this.conformerTask(taskId);this.preflight(task,[]);const state=task.mixedSampling;
    if(!state?.currentBatchId)throw Error('没有可整理的采样批。');
    return this.enqueue(task,'start',{stageIndex:0,intent:'sampling',batchId:state.currentBatchId,reorganizeOnly:true});
  }
  startSampling(taskId: string, mode: 'replace' | 'append'|'continue' = 'continue'): string {
    const task = this.conformerTask(taskId); this.preflight(task, []);
    if (task.mixedSampling) {
      const currentBatch=task.mixedSampling.batches?.find(batch=>batch.id===task.mixedSampling!.currentBatchId);
      const fresh=this.deps.resolveInitialSource?.(task.id,task.spec.source);if(fresh)this.updateInitialSource(task.id,fresh);
      const definition=sharedFreezeRunDefinition(task.mixedSampling.draft);
      this.validateMixedDefinition(task, definition, true);
      if (mode === 'replace') this.clearWorkflowResults(task);
      const batches=this.ensureSamplingBatches(task);
      if(mode==='append')this.sealSamplingBatches(task,'append');
      let batch=mode==='continue'?batches.find(batch=>batch.id===task.mixedSampling!.currentBatchId):undefined;
      // A next-run F/enable change creates a new owner instead of rewriting
      // the stopped batch and dropping its raw frames or completion ledger.
      if(batch&&!batch.sealed&&conformerProtectionKey(resolveConformerProtection(batch.source,batch.definition))!==conformerProtectionKey(resolveConformerProtection(this.selectedMixedSource(task,definition).source,definition))){
        this.sealSamplingBatches(task,'append');batch=undefined;
      }
      if(batch?.sealed)throw new Error('本批采样已封存；请追加新批次，不能继续或回改旧批。');
      if(!batch)batch=this.newSamplingBatch(task);
      else syncSamplingBatch(batch,definition,this.selectedMixedSource(task,definition).source,batch.initialGuessId);
      return this.enqueue(task, 'start', { stageIndex: 0, intent: 'sampling', samplingMode: mode,batchId:batch.id });
    }
    if (mode === 'replace') this.clearWorkflowResults(task);
    return this.enqueue(task, 'start', { stageIndex: 0, intent: 'sampling' });
  }
  private validateMixedDefinition(task: Pick<AdvancedTaskRecord, 'spec'>, definition: AdvancedMixedSamplingDefinition, requireCards = false): void {
    if (!Array.isArray(definition.cards) || requireCards && !definition.cards.length || definition.cards.length > 64
      || definition.cards.some(card => !card.id) || new Set(definition.cards.map(card => card.id)).size !== definition.cards.length)
      throw new Error('请添加有效且身份唯一的采样卡，最多64张。');
    if (!Number.isFinite(definition.dedupRmsdAngstrom ?? .01) || (definition.dedupRmsdAngstrom ?? .01) < 0) throw new Error('采样去重阈值无效。');
    const ids = new Set(task.spec.source.structure.atoms.map(atom => atom.id));
    if(definition.protectionMode!==undefined&&definition.protectionMode!=='shared-freeze')throw Error('构象保护模式不受支持。');
    if(definition.protectionMode!=='shared-freeze'&&definition.coreProtectionEnabled!==undefined&&typeof definition.coreProtectionEnabled!=='boolean')throw Error('保护核心启用状态无效。');
    const active=definition.protectionMode!=='shared-freeze'&&definition.coreProtectionEnabled!==false;
    for (const id of active?[...(definition.protectedAtomIds ?? []), ...(definition.coreProtection?.atomIds ?? []), ...(definition.nativeProtection?.core?.atomIds ?? [])]:[]) if (!ids.has(id)) throw new Error('共享保护核心不匹配搜索原子身份。');
    if (active&&definition.protectedAtomIds && new Set(definition.protectedAtomIds).size !== definition.protectedAtomIds.length) throw new Error('共享保护核心存在重复原子。');
    if (active&&definition.protectedAtomIds !== undefined && [...(definition.coreProtection?.atomIds ?? []), ...(definition.nativeProtection?.core?.atomIds ?? [])]
      .some(id => !definition.protectedAtomIds!.includes(id))) throw new Error('共享保护核心与当前原子范围不一致，请更新保护设置。');
    for (const card of definition.cards) if (card.kind === 'sampling') {
      if (card.sampling.operation === 'anneal') throw new Error('退火已停用。');
      this.validateRouteOptions(card.sampling);
      if (!CONFORMER_SAMPLING_CAPABILITIES.implementedMethods.includes(card.sampling.method)) throw new Error('采样方法不可用。');
      if(requireCards&&card.sampling.metadynamics?.atomIds?.some(id=>!ids.has(id)))throw Error('RMSD 偏置原子配置已失效，需重新指定；原草稿已保留。');
    }
    if(requireCards)for(const card of definition.cards)if(card.kind==='conformer-search'&&card.search.torsions.some(row=>[...row.torsion.atomIds,...row.torsion.movingAtomIds].some(id=>!ids.has(id))))throw Error('柔性键原子配置已失效，需重新指定；原草稿已保留。');
  }
  configureMixedSampling(taskId: string, definition: AdvancedMixedSamplingDefinition): void {
    const task = this.conformerTask(taskId);
    if (!task.mixedSampling) throw new Error('此任务不是混合采样搜索。');
    this.validateMixedDefinition(task, definition); task.mixedSampling.draft = structuredClone(definition);
    if (task.spec.kind === 'sampling') task.spec.mixedSampling = structuredClone(definition);
    this.publish();
  }
  setCoreProtectionEnabled(taskId:string,enabled:boolean):void {
    if(typeof enabled!=='boolean')throw Error('保护核心启用状态无效。');
    const task=this.conformerTask(taskId),state=task.mixedSampling;if(!state)throw Error('此任务不是混合采样搜索。');
    if(state.draft.protectionMode==='shared-freeze')throw Error('当前冻结由初始模型统一管理，请通过初始页修改。');
    state.draft={...state.draft,coreProtectionEnabled:enabled};
    if(task.spec.kind==='sampling')task.spec.mixedSampling=structuredClone(state.draft);
    task.revision=(task.revision??0)+1;this.publish();
  }
  updateInitialSource(taskId:string,source:AdvancedFrameSource,publish=true):void {
    const task=this.conformerTask(taskId),state=task.mixedSampling;
    if(!state)throw Error('此任务不是混合采样搜索。');
    const hasResults=task.guessFrames.length>0||task.runs.some(run=>run.frames.length>0)||state.batches?.some(batch=>batch.cards.some(card=>card.frameIds.length>0));
    // An empty search owns an editable canonical source. Never reuse an old
    // index mapping after atoms were added/deleted/replaced; atom-bound drafts
    // stay intact and are validated against the new IDs before use.
    const captured=captureMixedInitial(source,task.spec.source,!hasResults&&!this.busy(task)),initial=state.initialGuesses.find(row=>row.id===state.selectedInitialGuessId)!;
    if(same(initial.source,captured.source))return;
    const previous=initial.source,qm={charge:previous.structure.charge!,multiplicity:previous.structure.multiplicity!};
    const sameScience=same([previous.ref.documentId,previous.ref.documentEpoch,previous.ref.sourceId,previous.ref.frameId],[captured.source.ref.documentId,captured.source.ref.documentEpoch,captured.source.ref.sourceId,captured.source.ref.frameId])
      &&source.structure.charge===previous.structure.charge&&source.structure.multiplicity===previous.structure.multiplicity
      &&graphFingerprint(previous.structure)===graphFingerprint(captured.source.structure)&&coordinatesFingerprint(previous.structure)===coordinatesFingerprint(captured.source.structure)
      &&same(effectiveSharedFreezes(previous.constraints).coordinates,effectiveSharedFreezes(captured.source.constraints).coordinates);
    const confirmed=sameScience&&(state.electronicConfirmation===advancedElectronicSourceConfirmationKey(previous,qm)||state.electronicConfirmation===advancedElectronicSourceConfirmationKey(captured.source,qm));
    initial.source=captured.source;initial.atomMapping=captured.atomMapping;initial.revision=(initial.revision??1)+1;
    task.spec.source=captured.source;state.electronicConfirmation=confirmed?advancedElectronicSourceConfirmationKey(captured.source,qm):undefined;task.revision=(task.revision??0)+1;if(publish)this.publish();
  }
  /** One synchronous source + electronic confirmation transaction. The caller
   * has just re-read the real initial owner after applying its numeric draft. */
  confirmMixedInitialSource(taskId:string,source:AdvancedFrameSource,electronic:{charge:number;multiplicity:number}):string {
    const task=this.conformerTask(taskId),state=task.mixedSampling;
    if(!state||this.busy(task))throw Error('当前构象任务不可更改初猜。');
    if(!Number.isSafeInteger(electronic.charge)||!Number.isSafeInteger(electronic.multiplicity)||electronic.multiplicity<1)throw Error('搜索电荷或多重度无效。');
    const electronicIssue=baseElectronicStateError(source.structure,electronic);if(electronicIssue)throw Error(electronicIssue);
    const current=this.deps.resolveInitialSource?.(taskId,task.spec.source);
    if(current&&!same(current,source))throw Error('初始帧在确认期间已变化，请重新确认。');
    const hasResults=task.guessFrames.length>0||task.runs.some(run=>run.frames.length>0)||state.batches?.some(batch=>batch.cards.some(card=>card.frameIds.length>0));
    // Validate before either controller-owned value is changed.
    captureMixedInitial(source,task.spec.source,!hasResults);
    this.setMixedElectronicState(taskId,electronic,false);
    this.updateInitialSource(taskId,source,false);
    const key=advancedElectronicSourceConfirmationKey(task.spec.source,electronic);
    state.electronicConfirmation=key;this.publish();return key;
  }
  prepareProtectionChange(taskId:string,ids:string[]):{assertCurrent():void;commit():void;release():Promise<void>} {
    const task=this.conformerTask(taskId),state=task.mixedSampling;if(!state)throw Error('此任务不是混合采样搜索。');
    if(state.draft.protectionMode==='shared-freeze')throw Error('当前冻结由初始模型统一管理，请通过初始页修改。');
    const atomIds=new Set(task.spec.source.structure.atoms.map(atom=>atom.id));
    if(new Set(ids).size!==ids.length||ids.some(id=>!atomIds.has(id)))throw Error('保护集合原子身份无效。');
    const revision=this.discardRevision(task);let committed=false;
    const changed=!same([...(state.draft.protectedAtomIds??effectiveSharedFreezes(task.spec.source.constraints).frozenAtomIds)].sort(),[...ids].sort());
    const sessions=task.runs.flatMap(run=>run.results.filter(result=>result.diagnosticDirectory).flatMap(result=>result.sessionId?[result.sessionId]:[]));
    const assertCurrent=()=>{if(this.discardRevision(task)!==revision||!this.canDeleteTask(taskId))throw Error('构象任务在确认期间改变；未更改保护集合。');};
    const draft=structuredClone(state.draft);draft.protectedAtomIds=[...ids];
    if(draft.coreProtection)draft.coreProtection=ids.length?{...draft.coreProtection,atomIds:[...ids]}:undefined;
    if(draft.nativeProtection?.core)draft.nativeProtection.core=ids.length?{...draft.nativeProtection.core,atomIds:[...ids]}:undefined;
    this.validateMixedDefinition(task,draft);assertCurrent();
    return {assertCurrent,commit:()=>{if(committed)throw Error('保护事务已提交。');assertCurrent();
      if(changed)this.clearWorkflowResults(task,undefined,false);state.draft=draft;if(task.spec.kind==='sampling')task.spec.mixedSampling=structuredClone(draft);
      task.revision=(task.revision??0)+1;committed=true;this.publish();},release:async()=>{if(committed&&changed){this.releaseOptimizationCaches(sessions);await this.settleCacheReleases();}}};
  }
  addInitialGuess(taskId: string, source: AdvancedFrameSource): string {
    this.updateInitialSource(taskId,source);return this.task(taskId).mixedSampling!.selectedInitialGuessId;
  }
  selectInitialGuess(taskId: string, initialGuessId: string): void {
    const task = this.conformerTask(taskId), state = task.mixedSampling;
    if (!state?.initialGuesses.some(initial => initial.id === initialGuessId)) throw new Error('搜索初猜不存在。');
    if (state.selectedInitialGuessId === initialGuessId) return;
    state.selectedInitialGuessId = initialGuessId;
    // A sphere center is an absolute geometry draft; selecting another initial must re-establish it.
    state.draft.sphere = undefined;
    if (state.draft.nativeProtection) state.draft.nativeProtection.sphere = undefined;
    this.publish();
  }
  clearSampling(taskId: string): Promise<void> {
    const task = this.conformerTask(taskId);
    if (!task.mixedSampling) throw new Error('此任务不是混合采样搜索。');
    this.clearWorkflowResults(task); this.publish();const released=this.settleCacheReleases();void released.catch(()=>{});return released;
  }
  /** Discard only this stopped workflow's runtime caches. Native hosts already
   * clean owned work directories after actual child close; exported files and
   * recovery evidence are never addressed by this in-memory transaction. */
  private clearWorkflowResults(task: AdvancedTaskRecord, fromStage?: number,releaseCaches=true): void {
    if (this.busy(task)) throw new Error('请先停止并等待所有原生子任务实际关闭。');
    const configs = this.stageConfigs(task);
    const removedStages = new Set(task.runs.flatMap(run => run.stages.filter(stage => fromStage === undefined || stage.index >= fromStage).map(stage => stage.id)));
    if(releaseCaches)this.releaseOptimizationCaches(task.runs.flatMap(run => run.results.filter(result => (fromStage === undefined || removedStages.has(result.stageId)) && result.diagnosticDirectory).flatMap(result => result.sessionId ? [result.sessionId] : [])));
    if (fromStage === undefined) {
      for (const run of task.runs) { this.plans.delete(run.id); this.electronicPending.delete(run.id); }
      task.runs = []; task.guesses = undefined; task.guessFrames = [];
      if(task.mixedSampling){task.mixedSampling.batches=[];task.mixedSampling.currentBatchId=undefined;}
      task.conformerWorkflow!.candidateSet = { id: task.conformerWorkflow!.candidateSet?.id ?? `${task.id}-candidates`,
        revision: task.conformerWorkflow!.revision + 1, frameIds: [], valid: false };
    } else for (const run of task.runs) {
      run.stages = run.stages.filter(stage => stage.index < fromStage);
      run.results = run.results.filter(result => !removedStages.has(result.stageId));
      run.frames = run.frames.filter(frame => !removedStages.has(frame.stageId));
      if (run.resourceRequests) run.resourceRequests = run.resourceRequests.filter(row => !removedStages.has(row.stageId));
      run.intermediateCache = undefined;
      if (run.checkpoint?.kind === 'stage' && run.checkpoint.nextStageIndex > fromStage) run.checkpoint = undefined;
      this.plans.delete(run.id);
    }
    task.conformerWorkflow!.stages = task.conformerWorkflow!.stages.filter(stage => fromStage !== undefined && configs.findIndex(config => config.id === stage.stageId) < fromStage);
    task.conformerWorkflow!.history=task.conformerWorkflow!.history?.filter(stage=>fromStage!==undefined&&configs.findIndex(config=>config.id===stage.stageId)<fromStage);
    task.conformerWorkflow!.revision++;
    const retained = [...task.guessFrames, ...task.runs.flatMap(run => run.frames)];
    task.usage.retainedFrames = retained.length;
    task.usage.retainedCoordinates = retained.reduce((sum, frame) => sum + frame.source.structure.atoms.length, 0);
  }
  private releaseOptimizationCaches(sessionIds: string[]): void {
    const release = this.deps.bridge?.releaseXtbOptimizationCaches;
    if (!release || !sessionIds.length) return;
    const unique = [...new Set(sessionIds)];
    const pending = release(unique).then(receipt => { if (!unique.every(id => receipt.released.includes(id))) throw new Error('旧优化原始缓存尚未确认释放。'); });
    void pending.catch(() => {}); this.cacheReleases.push(pending);
  }
  private async settleCacheReleases(): Promise<void> {
    const pending = this.cacheReleases.splice(0); await Promise.all(pending);
  }
  /** Caller performs the visible data-impact confirmation before invoking this transaction. */
  setMixedElectronicState(taskId: string, electronic: { charge: number; multiplicity: number },publish=true): void {
    const task = this.conformerTask(taskId), state = task.mixedSampling;
    if (!state || task.spec.kind !== 'sampling') throw new Error('此任务不是混合采样搜索。');
    if (!Number.isSafeInteger(electronic.charge) || !Number.isSafeInteger(electronic.multiplicity) || electronic.multiplicity < 1) throw new Error('搜索电荷或多重度无效。');
    if (task.spec.source.structure.charge === electronic.charge && task.spec.source.structure.multiplicity === electronic.multiplicity) return;
    state.electronicConfirmation=undefined;
    const update = (source: AdvancedFrameSource) => {
      const structure = { ...structuredClone(source.structure), ...electronic };
      return captureAdvancedFrame(structure, source.ref, { ...source.stamp, graphFingerprint: graphFingerprint(structure) }, source.label, source.constraints);
    };
    task.spec.source = update(task.spec.source);
    state.initialGuesses = state.initialGuesses.map(initial => ({ ...initial, source: update(initial.source) }));
    const workflow=task.conformerWorkflow!;workflow.history??=[];
    for(const stage of workflow.stages)if(!workflow.history.some(old=>old.stageRunId===stage.stageRunId))workflow.history.push(structuredClone(stage));
    this.publishMixedCandidates(task, [], undefined, false);workflow.stages=[];if(publish)this.publish();
  }
  /** Editing only the sampling source/config invalidates all successors, while
   * retaining old runs/frames and their original configuration snapshots. */
  configureSampling(taskId: string, configuration: AdvancedSamplingConfiguration): void {
    const task = this.conformerTask(taskId);
    if (configuration.kind !== task.spec.kind) throw new Error('切换采样方式请建立新任务，不重绑旧任务身份。');
    if (configuration.kind === 'sampling' && task.spec.kind === 'sampling') {
      this.validateRouteOptions(configuration.sampling, 7200);
      const capacity = this.workflowCapacity({ ...task.spec, sampling: configuration.sampling }, task.budget, task.usage);
      conformerSamplingBudgetPlan(configuration.sampling,task.spec.source.structure.atoms.length,capacity);
      if (!CONFORMER_SAMPLING_CAPABILITIES.implementedMethods.includes(configuration.sampling.method)) throw new Error('采样方法不可用。');
      if (same(task.spec.sampling, configuration.sampling)) return;
      task.spec.sampling = withoutDeadline(structuredClone(configuration.sampling)); task.budget = capacity;
    } else if (configuration.kind === 'conformer-search' && task.spec.kind === 'conformer-search') {
      const { stages: _stages, checkpointAfterGuesses: _checkpoint, ...old } = task.spec.search;
      if (same(old, configuration.search)) return;
      const next = { ...task.spec, search: { ...structuredClone(configuration.search), stages: task.spec.search.stages, checkpointAfterGuesses: task.spec.search.checkpointAfterGuesses } };
      const capacity = this.workflowCapacity(next, task.budget, task.usage);
      task.spec.search = next.search; task.budget = capacity;
    } else if (configuration.kind === 'docking' && task.spec.kind === 'docking') {
      if (!task.spec.fragments) throw new Error('旧双来源任务请保留原记录，并新建同帧A/B任务。');
      prepareSameFrameDocking(task.spec.source, configuration.fragments); const docking = dockingSettings(configuration.docking);
      if (same(task.spec.fragments, configuration.fragments) && same(task.spec.docking, docking)) return;
      task.spec.fragments = structuredClone(configuration.fragments); task.spec.partnerSource = undefined; task.spec.docking = { ...docking, threads: configuration.docking.threads };
    }
    task.conformerWorkflow!.revision++;
    if (task.conformerWorkflow!.candidateSet) task.conformerWorkflow!.candidateSet!.valid = false;
    for (const stage of task.conformerWorkflow!.stages) stage.valid = false;
    task.guesses = undefined; this.publish();
  }
  private workflowStageInput(task: AdvancedTaskRecord, index: number,freshInitial?:AdvancedFrameSource): { inputs: CandidateInput[]; collectionId: string;revision:number;selection?:AdvancedStageInputSelection } {
    const workflow = task.conformerWorkflow!, candidates = workflow.candidateSet;
    if (!candidates?.valid) throw new Error('缺少当前配置的有效采样候选。');
    const previous = index ? workflow.stages.find(stage => stage.stageId === this.stageConfigs(task)[index - 1].id && stage.valid) : undefined;
    if (index && !previous) throw new Error('本级上游尚未完成或已失效。');
    if(index&&task.conformerWorkflow?.inputSemantics===2){const selected=selectAdvancedClusterInputs(task,this.stageConfigs(task)[index-1].id,this.stageConfigs(task)[index].inputClusterCount!,this.stageConfigs(task)[index].inputStride);
      const inputs=freshInitial&&task.mixedSampling?selected.inputs.map(input=>this.nextOptimizationInput(task,input,freshInitial)):selected.inputs;
      const selection=inputs===selected.inputs?selected.selection:{...selected.selection,collectionSignature:JSON.stringify([selected.selection.collectionSignature,inputs.map(input=>[input.source.stamp,input.source.constraints])])};
      return {inputs,collectionId:selected.selection.collectionId,revision:selected.selection.collectionRevision,selection};}
    const inputStride=this.stageConfigs(task)[index].inputStride??1;
    const ids = selectConformerInputsByStride(previous?.promotedFrameIds ?? candidates.frameIds,inputStride);
    const inputs = ids.map(id => { const frame = this.findFrame(task, id); if (!frame) throw new Error('候选来源完整帧缺失。');
      if(freshInitial&&task.mixedSampling)return this.nextOptimizationInput(task,{candidateId:frame.candidateId,source:frame.source},freshInitial,frame);
      return task.mixedSampling && !index && frame.samplingOrigin ? this.preparedSamplingInput(frame, frame.samplingOrigin.source, frame.samplingOrigin.protectedAtomIds,frame.samplingOrigin.protection)
        : { candidateId: frame.candidateId, source: frame.source }; });
    if (!inputs.length) throw new Error('上游没有可晋级代表。');
    const collectionId=previous?.collectionId??candidates.id,revision=previous?.revision??candidates.revision;
    return { inputs, collectionId,revision,...(!index&&task.conformerWorkflow?.inputSemantics===2?{selection:{schema:1 as const,mode:'sampling-all' as const,collectionId,collectionRevision:revision,inputStride,collectionSignature:JSON.stringify(inputs.map(input=>[input.candidateId,input.source.ref,input.source.stamp,input.source.constraints,input.source.structure.charge,input.source.structure.multiplicity])),actualCount:inputs.length,clusterIds:[],representativeFrameIds:inputs.flatMap(input=>input.source.ref.frameId?[input.source.ref.frameId]:[])}}:{}) };
  }
  private submitStage(taskId:string,stageId:string,force=false,batch=false):string {
    const task=this.conformerTask(taskId);const configs=this.stageConfigs(task),index=configs.findIndex(config=>config.id===stageId);
    if(index<0)throw new Error('优化级不存在。');
    if((batch?configs.slice(index):[configs[index]]).some(config=>config.clustering?.rmsdMatching==='symmetry'))throw Error('此级保留旧图同构归簇结果；请确认当前固定对应与等价消除设置后显式重新整理，再开始或继续。');
    if(!force&&task.runs.some(run=>run.stages.some(stage=>stage.configurationId===stageId&&stage.adoptionError)))throw Error('本级存在后台结果接管异常；请先处理保留的规范结果，或显式重新开始，未重新提交候选。');
    this.preflight(task,batch?configs.slice(index).map(config=>config.method):[configs[index].method],true);
    const fresh=task.mixedSampling?this.deps.resolveInitialSource?.(task.id,task.spec.source)??task.spec.source:undefined;
    const input=this.workflowStageInput(task,index,fresh);
    this.sealSamplingBatches(task,'optimization');
    if(force)this.clearWorkflowResults(task,index);
    return this.enqueue(task,force?'start':'resume',{stageIndex:index,endStageIndex:batch?undefined:index,intent:batch?'batch':'stage',inputs:structuredClone(input.inputs),inputSelection:input.selection,inputCollectionId:input.collectionId,inputCollectionRevision:input.revision,forceRecalculate:force,
      ...(fresh?{protection:resolveConformerProtection(fresh,sharedFreezeRunDefinition(task.mixedSampling!.draft))}:{})});
  }
  startStage(taskId:string,stageId:string):string{return this.submitStage(taskId,stageId);}
  continueStage(taskId:string,stageId:string):string{return this.submitStage(taskId,stageId);}
  /** Explicit organization of retained optimized assets; never submits a native
   * candidate or treats an interrupted stage as formally completed. */
  organizeStage(taskId:string,stageId:string):string {
    const task=this.conformerTask(taskId),configs=this.stageConfigs(task),index=configs.findIndex(config=>config.id===stageId);
    if(task.conformerWorkflow?.inputSemantics!==2||index<0||this.busy(task))throw Error('当前级次不可整理。');
    if(configs[index].clustering?.rmsdMatching==='symmetry')throw Error('请先确认当前固定对应与等价消除设置，再显式重新整理；旧结果保持原算法身份。');
    const state=task.conformerWorkflow.stages.find(stage=>stage.stageId===stageId),run=task.runs.find(run=>run.id===state?.producerRunId),stage=run?.stages.find(stage=>stage.id===state?.stageRunId);
    if(!stage?.results.some(result=>result.status==='completed')||!stage.configuration||this.calculationMethodKey(stage.configuration.method)!==this.calculationMethodKey(configs[index].method))throw Error('没有可按当前方法整理的完整有效结果。');
    const current=this.workflowStageInput(task,index);
    return this.enqueue(task,'resume',{stageIndex:index,endStageIndex:index,intent:'stage',inputs:current.inputs,inputSelection:current.selection,
      inputCollectionId:current.collectionId,inputCollectionRevision:current.revision,reclusterOnly:true,reclusterCompleted:!!state?.completed});
  }
  restartStage(taskId:string,stageId:string):string{return this.submitStage(taskId,stageId,true);}
  pauseOptimization(taskId:string,runId:string):Promise<void>{return this.stop(taskId,runId);}
  runAllStages(taskId:string):string {
    const task=this.conformerTask(taskId),first=this.stageConfigs(task)[0];if(!first)throw new Error('请先配置优化级。');return this.submitStage(taskId,first.id,false,true);
  }
  restartAllStages(taskId:string):string {
    const task=this.conformerTask(taskId),first=this.stageConfigs(task)[0];if(!first)throw new Error('请先配置优化级。');return this.submitStage(taskId,first.id,true,true);
  }
  start(taskId: string): string {
    const task = this.task(taskId);
    if (task.mixedSampling) return this.startSampling(taskId);
    this.explicit(task); this.preflight(task);
    if (this.busy(task) || task.runs.length) throw new Error('任务已有运行；请显式继续或重试并保留原运行记录。');
    return this.enqueue(task, 'start', { stageIndex: 0 });
  }
  resume(taskId: string, runId: string): string {
    const task = this.task(taskId), previous = this.run(task, runId); this.explicit(task); this.preflight(task);
    if (this.busy(task) || previous.status !== 'checkpoint' || !previous.checkpoint) throw new Error('只能显式继续检查停点。');
    if(task.mixedSampling){const config=this.stageConfigs(task)[previous.checkpoint.nextStageIndex];if(!config)throw new Error('没有后续优化级。');return this.submitStage(taskId,config.id,false,true);}
    if (task.conformerWorkflow?.candidateSet && !task.conformerWorkflow.candidateSet.valid) throw new Error('上游采样配置已变，旧停点不可作为新来源。');
    if (previous.checkpoint.kind === 'stage' && task.conformerWorkflow) {
      const priorConfig = this.stageConfigs(task)[previous.checkpoint.nextStageIndex - 1];
      if (!priorConfig || !task.conformerWorkflow.stages.some(stage => stage.stageId === priorConfig.id && stage.valid && stage.configKey === this.stageConfigKey(priorConfig))) throw new Error('上游级次配置已变，旧晋级停点不可继续。');
    }
    const index = previous.checkpoint.nextStageIndex;
    const inputs = index === 0 ? task.spec.kind === 'docking' ? this.dockedInputs(task, previous) : task.spec.kind === 'sampling' ? this.sampledInputs(task, previous) : task.guessFrames.map(f => ({ candidateId: f.candidateId, source: f.source }))
      : this.promotedInputs(task, previous.stages.at(-1)!);
    if(task.conformerWorkflow?.inputSemantics===2){const selected=this.workflowStageInput(task,index);return this.enqueue(task,'resume',{stageIndex:index,inputs:selected.inputs,inputSelection:selected.selection,inputCollectionId:selected.collectionId,inputCollectionRevision:selected.revision},runId);}
    return this.enqueue(task, 'resume', { stageIndex: index, inputs, ...(task.spec.kind === 'sampling' ? { samplingFromRunId: runId } : task.spec.kind === 'docking' ? { dockingFromRunId: runId } : {}) }, runId);
  }
  private unfinishedStage(task: AdvancedTaskRecord, index: number, collectionId: string) {
    const config = this.stageConfigs(task)[index];
    return [...task.runs].reverse().find(run => ['stopped', 'failed'].includes(run.status) && run.stages.some(stage => stage.index === index
      && stage.status !== 'completed' && stage.inputCollectionId === collectionId && stage.configuration
      && this.stageConfigKey(stage.configuration) === this.stageConfigKey(config)));
  }
  retry(taskId: string, runId: string, intent?: 'stage' | 'batch'): string {
    const task = this.task(taskId), previous = this.run(task, runId); this.explicit(task); this.preflight(task);
    if (this.busy(task) || !terminalStatuses.has(previous.status) || previous.status === 'checkpoint') throw new Error('只能重试已结束运行的失败项。');
    if(task.mixedSampling&&previous.intent==='sampling'&&!previous.stages.length)return this.continueSampling(taskId);
    const electronic = this.electronicPending.get(runId);
    if (electronic) return this.enqueue(task, 'retry', { stageIndex: 0, electronic }, runId);
    if (task.spec.kind === 'path') {
      if (!['failed', 'stopped'].includes(previous.status)) throw new Error('已完成路径没有失败路线可重试。');
      return this.enqueue(task, 'retry', { stageIndex: 0 }, runId);
    }
    if (task.spec.kind === 'sampling' && !previous.sampling?.acceptedCompletion && !previous.stages.length) throw new Error('采样终止后不能续跑同次任务；请使用追加采样开始新运行。');
    if (task.spec.kind === 'docking' && !previous.docking?.acceptedCompletion && !previous.docking?.acceptedSearchCheckpoint) return this.enqueue(task, 'retry', { stageIndex: 0 }, runId);
    if (task.spec.kind === 'docking' && !previous.stages.length) return this.enqueue(task, 'retry', {
      stageIndex: 0, dockingFromRunId: runId, inputs: this.dockedInputs(task, previous),
    }, runId);
    if (task.spec.kind === 'sampling' && !previous.stages.length) return this.enqueue(task, 'retry', {
      stageIndex: 0, samplingFromRunId: runId, inputs: this.sampledInputs(task, previous),
    }, runId);
    if (previous.status === 'stopped' && !previous.stages.length) return this.enqueue(task, 'retry', { stageIndex: 0 }, runId);
    // A view-preparation failure can follow a scientifically completed level.
    // Retry that publication explicitly; S and terminal D remain accepted data.
    if(previous.status==='failed'&&task.conformerWorkflow&&!previous.stages.some(stage=>stage.adoptionError)){
      const completed=previous.stages.find(stage=>stage.status==='completed'&&stage.configurationId
        &&previous.stages.every(later=>later.index<=stage.index||later.status==='completed'||!later.inputCandidateIds.length&&!later.results.length)
        &&task.conformerWorkflow!.stages.some(state=>state.stageRunId===stage.id&&state.valid&&state.completed));
      if(completed){
        const config=this.stageConfigs(task)[completed.index];
        if(!config||!completed.configuration||this.stageConfigKey(config)!==this.stageConfigKey(completed.configuration))throw Error('优化级科学配置已变，请从当前有效上游开始该级。');
        return this.submitStage(taskId,completed.configurationId!,false,(intent??previous.intent)!=='stage');
      }
    }
    const stage = previous.stages.find(s => s.results.some(r => r.status !== 'completed') || s.status !== 'completed');
    if (!stage) throw new Error('该运行没有可重试失败项。');
    if(stage.adoptionError)throw Error('后台结果接管异常尚未处理；未按普通失败重新提交候选。');
    const currentConfig = this.stageConfigs(task)[stage.index];
    if (!currentConfig || stage.configuration && this.stageConfigKey(stage.configuration) !== this.stageConfigKey(currentConfig)) throw new Error('优化级科学配置已变，请从当前有效上游开始该级。');
    const inputs = stage.results.map(r => ({ candidateId: r.candidateId,
      source: r.status === 'completed' ? r.input : [...previous.frames].reverse().find(frame => frame.stageId === stage.id && frame.candidateId === r.candidateId && frame.kind === 'intermediate')?.source ?? r.input }));
    // If stop occurred before some candidates were submitted, recover their original input identity too.
    const all = this.inputsForStage(task, previous, stage.index);
    for (const item of all) if (!inputs.some(i => i.candidateId === item.candidateId)) inputs.push(item);
    const resumedById=new Map(inputs.map(input=>[input.candidateId,input]));
    const resumedInputs=all.map(input=>resumedById.get(input.candidateId)??input);
    return this.enqueue(task, 'retry', { stageIndex: stage.index, inputs:resumedInputs, reuse: stage.results.filter(r => r.status === 'completed'),
      intent: intent ?? previous.intent, endStageIndex: (intent ?? previous.intent) === 'stage' ? stage.index : undefined, inputCollectionId: stage.inputCollectionId,
      inputSelection:stage.inputSelection,inputCollectionRevision:stage.inputCollectionRevision,
      ...(task.spec.kind === 'sampling' ? { samplingFromRunId: runId } : task.spec.kind === 'docking' ? { dockingFromRunId: runId } : {}) }, runId);
  }
  private enqueue(task: AdvancedTaskRecord, mode: AdvancedTaskRun['mode'], plan: RunPlan, fromRunId?: string) {
    plan={...plan,configurations:structuredClone(this.stageConfigs(task))};
    if(plan.intent!=='sampling')for(const config of plan.configurations!.slice(plan.stageIndex,plan.endStageIndex===undefined?undefined:plan.endStageIndex+1)){
      if(!Number.isSafeInteger(config.inputStride??1)||(config.inputStride??1)<1)throw Error('抽帧间隔须为正整数。');
      if(config.clustering?.rmsdMatching!==undefined&&!['fixed','symmetry'].includes(config.clustering.rmsdMatching))throw Error('此优化级的RMSD匹配方式不受支持，原结果保留；未启动运行。');
      if(config.clustering?.rmsdMatching==='symmetry')throw Error('旧图同构归簇不再执行；请确认当前归簇设置并显式重新整理。');
      if(config.clustering?.eliminateEquivalent!==undefined&&typeof config.clustering.eliminateEquivalent!=='boolean')throw Error('等价构象消除设置无效。');
    }
    if (task.conformerWorkflow && ['sampling', 'conformer-search'].includes(task.spec.kind)) task.budget = this.workflowCapacity(task.spec, task.budget, task.usage,
      plan.inputs ? { candidates: plan.inputs.length, stageIndex: plan.stageIndex, endStageIndex: plan.endStageIndex } : {});
    if (!plan.reclusterOnly&&task.usage.nativeJobs >= task.budget.maxNativeJobs) throw new Error('本任务累计原生子作业容量已耗尽。');
    const id = this.id('run');
    if ([...this.tasks.values()].some(t => t.runs.some(r => r.id === id))) throw new Error('高级运行身份重复。');
    const sourceConfiguration: AdvancedSamplingConfiguration | undefined = task.spec.kind === 'sampling' ? { kind: 'sampling', sampling: structuredClone(task.spec.sampling) }
      : task.spec.kind === 'conformer-search' ? { kind: 'conformer-search', search: { torsions: structuredClone(task.spec.search.torsions), quantity: structuredClone(task.spec.search.quantity), samplingLimits: structuredClone(task.spec.search.samplingLimits), clashPolicy: structuredClone(task.spec.search.clashPolicy) } }
      : task.spec.kind === 'docking' && task.spec.fragments ? { kind: 'docking', fragments: structuredClone(task.spec.fragments), docking: structuredClone(task.spec.docking) } : undefined;
    const run: AdvancedTaskRun = { id, taskId: task.id, mode, fromRunId, status: 'queued', createdAt: this.now(),
      ...(plan.protection?{protection:structuredClone(plan.protection)}:{}),
      stages: plan.intent === 'stage' || plan.intent === 'batch' ? this.stageConfigs(task).flatMap((config, index) => index < plan.stageIndex || index > (plan.endStageIndex ?? Infinity) ? [] : [{
        id: `${id}-stage-${index + 1}`, index, status: 'pending' as const, configurationId: config.id, configuration: structuredClone(config),
        inputs:index===plan.stageIndex?plan.inputs:undefined,inputSelection:index===plan.stageIndex?plan.inputSelection:undefined,inputCollectionRevision:index===plan.stageIndex?plan.inputCollectionRevision:undefined,inputCollectionId: index === plan.stageIndex ? plan.inputCollectionId : undefined, inputCandidateIds: index === plan.stageIndex ? (plan.inputs?.map(input => input.candidateId) ?? []) : [], results: [], promotedCandidateIds: [],
      }]) : [], frames: [], results: [], subjobCount: 0, elapsedMs: 0,
      ...(sourceConfiguration ? { sourceConfiguration } : {}),
      ...(plan.intent ? { intent: plan.intent, workflowRevision: task.conformerWorkflow!.revision } : {}) };
    if (task.mixedSampling && plan.intent === 'sampling') {
      const batch=this.ensureSamplingBatches(task).find(batch=>batch.id===plan.batchId)!;
      if(!batch)throw new Error('采样批次身份缺失。');
      const definition=structuredClone(batch.definition),source=batch.source;
      run.protection=resolveConformerProtection(source,definition);
      run.mixedSampling = { batchId:batch.id,mode: plan.samplingMode ?? 'continue', initialGuessId: batch.initialGuessId, source,
        definition, currentCardIndex: -1, generated: 0, duplicates: 0, coreRejected: 0, accepted: 0,
        cards: batch.cards.map(card => ({ id:card.id,status:card.status,generated:card.generated,duplicates:card.duplicates,coreRejected:card.coreRejected,accepted:card.accepted,frameIds:[...card.mergedFrameIds] })) };
    }
    task.runs.push(run); this.plans.set(id, plan); this.queue.push({ taskId: task.id, runId: id }); this.publish();
    queueMicrotask(() => { void this.pump(); }); return id;
  }
  waitForRun(taskId: string, runId: string): Promise<void> {
    const run = this.run(this.task(taskId), runId);
    if (terminalStatuses.has(run.status)) return Promise.resolve();
    return new Promise(resolve => { const list = this.waiters.get(runId) ?? []; list.push(resolve); this.waiters.set(runId, list); });
  }
  async stop(taskId: string, runId: string): Promise<void> {
    const task = this.task(taskId), run = this.run(task, runId);
    if (terminalStatuses.has(run.status)) return;
    run.stopReason ??= 'user-stop';
    if (run.status === 'queued') {
      this.queue = this.queue.filter(item => item.runId !== runId); run.status = 'stopped'; run.finishedAt = this.now();
      for (const stage of run.stages) { stage.status = 'stopped'; stage.outcome = { processed: 0, valid: 0, failed: 0,
        target: stage.configuration?.advanceCount ?? 1, actual: 0, reason: '用户在原生作业提交前取消排队。' }; }
      this.finishWaiters(runId); this.publish(); return;
    }
    run.status = 'stopping'; this.publish();
    if (this.activeSamplingWork?.runId === runId) this.activeSamplingWork.stop();
    if(this.activeBatch?.runId===runId)await this.deps.conformerBatchBridge!.stop(this.activeBatch.batchId);
    await Promise.all([...this.activeJobs.values()].filter(job => job.run === run).map(job => this.requestStop(job))
      .concat([...this.activeForcefields.values()].filter(job => job.info.runId === runId).map(job => job.stop())));
    if (this.activeRoute?.info.runId === runId) await this.activeRoute.stop();
    await this.waitForRun(taskId, runId);
  }
  private finishWaiters(runId: string) { for (const resolve of this.waiters.get(runId) ?? []) resolve(); this.waiters.delete(runId); }
  private async pump() {
    if (this.pumping || this.disposed) return; this.pumping = true;
    try {
      while (this.queue.length && !this.disposed) {
        const item = this.queue.shift()!, task = this.task(item.taskId), run = this.run(task, item.runId);
        if (run.status !== 'queued') continue;
        this.activeRun = { task, run, started: this.now() }; run.startedAt = this.now(); run.status = 'running'; this.publish();
        try {
          await this.execute(task, run, this.plans.get(run.id)!);
          if (isStopping(run)) run.status = 'stopped';
          else if (run.status === 'running') run.status = 'completed';
        } catch (error) {
          run.error = message(error); run.status = error instanceof RunStopped || isStopping(run) ? 'stopped' : 'failed';
          for (const stage of run.stages) if (stage.status !== 'completed') {
            stage.status = run.status === 'stopped' ? 'stopped' : 'failed';
            stage.outcome = { processed: stage.results.length, valid: stage.results.filter(row => row.status === 'completed').length,
              failed: stage.results.filter(row => row.status !== 'completed').length, target: stage.configuration?.advanceCount ?? 1,
              actual: stage.promotedCandidateIds.length, reason: run.error };
          }
        } finally {
          run.elapsedMs = Math.max(0, this.now() - this.activeRun.started); task.usage.elapsedMs += run.elapsedMs;
          run.finishedAt = this.now(); this.plans.delete(run.id); this.activeRun = undefined; this.finishWaiters(run.id); this.publish();
        }
      }
    } finally { this.pumping = false; }
  }
  private checkRun(task: AdvancedTaskRecord, run: AdvancedTaskRun) {
    if (run.status === 'stopping' || this.disposed) throw new RunStopped('高级任务已停止；完整中间帧已保留。');
  }
  private stageConfigs(task: AdvancedTaskRecord): AdvancedOptimizationStageConfig[] {
    if (task.spec.kind === 'conformer-search') return task.spec.search.stages;
    if (task.spec.kind === 'sampling' || task.spec.kind === 'docking') return task.spec.optimizationStages;
    if (task.spec.kind === 'path') return [];
    return [{ id: task.spec.kind, method: task.spec.kind === 'singlepoint' ? { backend: 'xtb', options: task.spec.options } : task.spec.method,
      advanceCount: 1, checkpointAfter: false }];
  }
  private reusableCalculation(task: AdvancedTaskRecord, config: AdvancedOptimizationStageConfig, input: CandidateInput) {
    for (const prior of [...task.runs].reverse()) for (const stage of [...prior.stages].reverse()) {
      if (stage.configurationId !== config.id || !stage.configuration || this.calculationMethodKey(stage.configuration.method) !== this.calculationMethodKey(config.method)) continue;
      const result = stage.results.find(row => row.candidateId === input.candidateId && row.status === 'completed' && row.frameId
        && this.findFrame(task, row.frameId) && this.sameInput({candidateId:row.candidateId,source:row.originalInput??row.input},input));
      if (result) return { result, runId: prior.id };
    }
  }
  private interruptedCalculation(task:AdvancedTaskRecord,config:AdvancedOptimizationStageConfig,input:CandidateInput,excludeRunId:string) {
    for(const prior of [...task.runs].reverse())for(const stage of [...prior.stages].reverse()){
      if(prior.id===excludeRunId||stage.configurationId!==config.id||!stage.configuration||this.calculationMethodKey(stage.configuration.method)!==this.calculationMethodKey(config.method))continue;
      const result=stage.results.find(result=>result.status!=='completed'&&this.sameInput({candidateId:result.candidateId,source:result.originalInput??result.input},input));
      if(!result)continue;
      const last=[...prior.frames].reverse().find(frame=>frame.stageId===stage.id&&frame.candidateId===input.candidateId&&frame.kind==='intermediate'&&(!result.sessionId||frame.sessionId===result.sessionId));
      return{result,source:last?.source??result.input,runId:prior.id};
    }
  }
  private completedWorkflowStage(task:AdvancedTaskRecord,config:AdvancedOptimizationStageConfig,inputs:CandidateInput[],collectionId:string,revision:number) {
    const state=task.conformerWorkflow?.stages.find(state=>state.stageId===config.id&&state.valid&&state.completed
      &&state.configKey===this.stageConfigKey(config)&&state.inputCollectionId===collectionId&&state.inputCollectionRevision===revision);
    if(!state)return;
    const run=task.runs.find(run=>run.id===state.producerRunId),stage=run?.stages.find(stage=>stage.id===state.stageRunId);
    if(!run||!stage||stage.status!=='completed'||stage.adoptionError||!stage.clustering||!stage.configuration
      ||stage.inputCollectionId!==collectionId||stage.inputCollectionRevision!==revision||this.stageConfigKey(stage.configuration)!==state.configKey
      ||stage.inputs?.length!==inputs.length||stage.results.length!==inputs.length||new Set(stage.results.map(result=>result.candidateId)).size!==inputs.length
      ||!same(stage.inputCandidateIds,inputs.map(input=>input.candidateId)))return;
    if(!inputs.every((input,index)=>{const old=stage.inputs![index];return this.sameInput(old,input)&&same(old.source.ref,input.source.ref)
      &&same(old.source.stamp,input.source.stamp)&&old.source.structure.charge===input.source.structure.charge&&old.source.structure.multiplicity===input.source.structure.multiplicity;}))return;
    const inputById=new Map(inputs.map(input=>[input.candidateId,input]));
    if(!stage.results.every(result=>{const input=inputById.get(result.candidateId);return input&&this.sameInput(input,{candidateId:result.candidateId,source:result.originalInput??result.input});}))return;
    const results=stage.results.filter(result=>result.status==='completed'),resultById=new Map(results.map(result=>[result.candidateId,result]));
    const frameIds=new Set([...task.guessFrames,...task.runs.flatMap(run=>run.frames)].map(frame=>frame.id));
    if(!results.every(result=>result.frameId&&frameIds.has(result.frameId))
      ||!same(state.resultFrameIds,results.map(result=>result.frameId))
      ||!same(state.promotedFrameIds,stage.promotedCandidateIds.map(id=>resultById.get(id)?.frameId)))return;
    return{run,stage,state};
  }
  private publishStageResults(task:AdvancedTaskRecord,run:AdvancedTaskRun,stage:AdvancedStageRun,completed:boolean):void {
    if(!task.conformerWorkflow||!stage.configuration)return;
    const workflow=task.conformerWorkflow,old=workflow.stages.find(value=>value.stageId===stage.configurationId),ids=new Set(stage.inputCandidateIds);
    const valid=stage.results.filter(result=>ids.has(result.candidateId)&&result.status==='completed'&&result.frameId&&this.findFrame(task,result.frameId));
    if(old&&old.stageRunId!==stage.id){workflow.history??=[];if(!workflow.history.some(value=>value.stageRunId===old.stageRunId))workflow.history.push(structuredClone(old));}
    workflow.revision++;
    const frameId=(candidateId:string)=>valid.find(result=>result.candidateId===candidateId)?.frameId;
    const currentConfiguration=this.stageConfigs(task).find(config=>config.id===stage.configurationId);
    const state={stageId:stage.configurationId??stage.configuration.id,configKey:this.stageConfigKey(stage.configuration),inputCollectionId:stage.inputCollectionId??'source',collectionId:stage.collectionId??`${task.id}:stage-${stage.configuration.id}:representatives`,producerRunId:run.id,stageRunId:stage.id,valid:completed&&!!currentConfiguration&&this.stageConfigKey(currentConfiguration)===this.stageConfigKey(stage.configuration),completed,revision:workflow.revision,
      inputFrameIds:(stage.inputs??[]).flatMap(input=>input.source.ref.frameId?[input.source.ref.frameId]:[]),inputCollectionRevision:stage.inputCollectionRevision,resultFrameIds:valid.map(result=>result.frameId!),
      representativeFrameIds:completed?stage.clustering?.groups.flatMap(group=>group.clusters.flatMap(cluster=>frameId(cluster.representative.candidateId)?[frameId(cluster.representative.candidateId)!]:[]))??valid.map(result=>result.frameId!):[],
      promotedFrameIds:completed?stage.promotedCandidateIds.flatMap(id=>frameId(id)?[frameId(id)!]:[]):[],progress:stage.progress??{total:stage.inputCandidateIds.length,completed:valid.length,interrupted:0,failed:stage.results.filter(result=>result.status!=='completed').length,succeeded:valid.length,discarded:stage.results.filter(result=>result.status!=='completed').length,pending:Math.max(0,stage.inputCandidateIds.length-stage.results.length)}};
    workflow.stages=[...workflow.stages.filter(value=>value.stageId!==state.stageId),state];
    if(workflow.inputSemantics===2){const configs=this.stageConfigs(task),index=configs.findIndex(config=>config.id===state.stageId);for(const downstream of workflow.stages)if(configs.findIndex(config=>config.id===downstream.stageId)>index)downstream.valid=false;}
  }
  private publishMixedCandidates(task: AdvancedTaskRecord, frames: AdvancedResultFrame[], producerRunId?: string, append = false) {
    const workflow = task.conformerWorkflow!;
    const ids=frames.map(frame=>frame.id),changed=!same(workflow.candidateSet?.frameIds??[],ids);
    if(changed)workflow.revision++;
    workflow.candidateSet = { id: `${task.id}-candidates`, revision:changed?workflow.revision:workflow.candidateSet?.revision??workflow.revision,frameIds:ids,producerRunId,valid:frames.length>0 };
    if(!changed)return;
    for (const stage of workflow.stages) {
      stage.valid = false;stage.completed=false;
      if(stage.stageId===this.stageConfigs(task)[0]?.id&&stage.progress)stage.progress={...stage.progress,total:ids.length,pending:Math.max(0,ids.length-stage.progress.completed-stage.progress.interrupted-stage.progress.failed)};
      if (!append) { stage.representativeFrameIds = []; stage.promotedFrameIds = []; }
    }
  }
  private attachSamplingOrigin(frame: AdvancedResultFrame, run: AdvancedTaskRun) {
    const mixed = run.mixedSampling!, definition = mixed.definition;
    frame.samplingOrigin = { initialGuessId: mixed.initialGuessId, cardId: definition.cards[mixed.currentCardIndex].id,
      batchId:mixed.batchId,segmentId:mixed.currentSegmentId,cardRevision:this.task(run.taskId).mixedSampling?.batches?.find(batch=>batch.id===mixed.batchId)?.cards[mixed.currentCardIndex]?.configurationRevision,
      source: mixed.source, protectedAtomIds:[...(run.protection??resolveConformerProtection(mixed.source,definition)).restorationAtomIds],
      protection:run.protection??resolveConformerProtection(mixed.source,definition)};
  }
  private mixedCardOptions(options: AdvancedSamplingTaskOptions, definition: AdvancedMixedSamplingDefinition,source:AdvancedFrameSource): AdvancedSamplingTaskOptions {
    return conformerSamplingProtectionOptions(options,definition,source).options;
  }
  private async rebuildMixedCandidates(task:AdvancedTaskRecord,run:AdvancedTaskRun):Promise<void> {
    const accepted:AdvancedResultFrame[]=[],mixed=run.mixedSampling!;
    let completed=true;
    mixed.deduplicationCompleted=undefined;mixed.deduplicationProcessed=0;mixed.deduplicationTotal=0;
    const draft=task.mixedSampling!.draft,dedupKey=JSON.stringify([draft.deduplicationEnabled!==false,draft.dedupRmsdAngstrom??.01]);
    const reuseSealed=task.mixedSampling!.lastDeduplicationKey===dedupKey;
    for(const batch of this.ensureSamplingBatches(task)){
      if(batch.source.structure.charge!==task.spec.source.structure.charge||batch.source.structure.multiplicity!==task.spec.source.structure.multiplicity)continue;
      if(batch.sealed&&reuseSealed){accepted.push(...batch.mergedFrameIds.map(id=>this.findFrame(task,id)!).filter(Boolean));continue;}
      const merged:string[]=[];
      for(const card of batch.cards){
        const candidates=card.frameIds.map(id=>this.findFrame(task,id)!).filter(Boolean);
        let result:SamplingDeduplicationResult;
        try{result=!candidates.length||draft.deduplicationEnabled===false?{acceptedIndices:candidates.map((_,index)=>index),processed:candidates.length,completed:true}:await this.background(run,{kind:'deduplicate',candidates:candidates.map(frame=>frame.source.structure),retained:accepted.map(frame=>frame.source.structure),threshold:draft.dedupRmsdAngstrom??.01});}
        catch(error){result={acceptedIndices:candidates.map((_,index)=>index),processed:0,completed:false};mixed.deduplicationCompleted=false;run.error=`有效轨迹已保留，汇总去重未完成：${message(error)}`;}
        completed=completed&&result.completed;if(!completed)mixed.deduplicationCompleted=false;
        mixed.deduplicationProcessed+=result.processed;mixed.deduplicationTotal+=candidates.length;
        card.mergedFrameIds=result.acceptedIndices.map(index=>candidates[index].id);card.accepted=card.mergedFrameIds.length;card.duplicates=card.frameIds.length-card.accepted;
        accepted.push(...result.acceptedIndices.map(index=>candidates[index]));merged.push(...card.mergedFrameIds);
      }
      batch.mergedFrameIds=merged;
    }
    task.budget.maxCandidates=Math.max(task.budget.maxCandidates,accepted.length);
    mixed.deduplicationCompleted=completed;
    task.mixedSampling!.lastDeduplicationKey=completed?dedupKey:undefined;
    this.publishMixedCandidates(task,accepted,run.id,true);
    const batch=this.ensureSamplingBatches(task).find(batch=>batch.id===mixed.batchId)!;
    mixed.cards=batch.cards.map(card=>({id:card.id,status:card.status,error:card.error,generated:card.generated,duplicates:card.duplicates,coreRejected:card.coreRejected,accepted:card.accepted,frameIds:[...card.mergedFrameIds],sampling:card.sampling}));
    mixed.generated=batch.cards.reduce((sum,card)=>sum+card.generated,0);mixed.accepted=batch.mergedFrameIds.length;mixed.duplicates=batch.cards.reduce((sum,card)=>sum+card.duplicates,0);mixed.coreRejected=batch.cards.reduce((sum,card)=>sum+card.coreRejected,0);
    this.publish();
  }
  private async executeMixedSampling(task: AdvancedTaskRecord, run: AdvancedTaskRun): Promise<void> {
    const mixed=run.mixedSampling!,batch=this.ensureSamplingBatches(task).find(batch=>batch.id===mixed.batchId);
    if(!batch||batch.sealed)throw new Error('当前采样批次已封存或不存在。');
    let failure:unknown;
    for(let index=0;index<batch.cards.length;index++){
      this.checkRun(task,run);mixed.currentCardIndex=index;const state=batch.cards[index],card=state.configuration;
      if(!samplingCardNeedsWork(state)){state.status='completed';mixed.cards[index].status='completed';continue;}
      state.status='running';state.error=undefined;mixed.cards[index].status='running';run.sampling=undefined;this.publish();
      const firstFrame=run.frames.length;let segment:AdvancedSamplingSegment|undefined;
      try{
        if(card.kind==='sampling'){
          const options=this.mixedCardOptions(card.sampling,batch.definition,batch.source),remaining=mixedCardTargetTimeFs(card)-state.completedTimeFs,dt=options.dtFs??2;
          const previous=state.segments.at(-1),last=previous?.frameIds.at(-1),start=last?this.findFrame(task,last)?.source:undefined;
          segment={id:`${run.id}-card-${index+1}-segment-${state.segments.length+1}`,runId:run.id,source:start??batch.source,targetTimeFs:remaining,completedTimeFs:0,completedTimeBeforeFs:state.completedTimeFs,frameIds:[],candidateFrameIds:[],status:'running'};
          state.segments.push(segment);mixed.currentSegmentId=segment.id;
          if(options.operation==='md')options.molecularMD={...options.molecularMD,durationFs:remaining};
          else if(options.operation==='metadynamics')options.metadynamics={...options.metadynamics,durationFs:remaining};
          else options.sphericalMD={...options.sphericalMD,durationFs:remaining};
          options.maxSteps=Math.round(remaining/dt);options.maxEvaluations=getConformerSamplingCapability(options).driver==='native-xtb-md'?options.maxSteps+2:2*options.maxSteps+1;
          const requested={...options,...(['md','metadynamics'].includes(options.operation)?{segment:{id:segment.id,...(previous?{previousSegmentId:previous.id}:{}),completedStepsBefore:Math.round(state.completedTimeFs/dt)}}:{})};
          await this.executeSampling(task,run,segment.source,requested);
          segment.status='completed';
        }else{
          const snapshot=createConformerSnapshot(batch.source.structure,batch.source.ref,{frozenAtomIds:[],coordinates:[]});
          const constraints=structuredClone(batch.source.constraints);constraints.enabled=true;constraints.frozenAtomIds=[...(run.protection??resolveConformerProtection(batch.source,batch.definition)).restorationAtomIds];
          const protectedSnapshot=createConformerSnapshot(batch.source.structure,batch.source.ref,constraints);
          let generationSegment=0;
          do {
          const prior=state.guesses;
          mixed.currentSegmentId=`${run.id}-card-${index+1}-generate-${++generationSegment}`;
          const options={limits:{...card.search.samplingLimits,maxCandidates:Math.max(task.budget.maxCandidates,mixedCardTargetCount(card)),maxAtoms:snapshot.structure.atoms.length},clashPolicy:card.search.clashPolicy,
            countMode:'received' as const,protection:{snapshot:protectedSnapshot,manualAxisBonds:card.search.torsions.filter(row=>row.torsion.origin==='manual').map(row=>[row.torsion.atomIds[1],row.torsion.atomIds[2]] as [string,string])},
            ...(prior?.continuation?{resume:{continuation:prior.continuation,accepted:prior.guesses}}:{})};
          const guesses=await this.background<NonNullable<AdvancedTaskRecord['guesses']>>(run,{kind:'generate',snapshot,entries:card.search.torsions,quantity:card.search.quantity,options});
          const oldIds=new Set(prior?.guesses.map(guess=>guess.id)??[]);
          for(const guess of guesses.guesses){if(oldIds.has(guess.id))continue;
            assertConformerGeometryProtected(protectedSnapshot,guess.structure,options.protection.manualAxisBonds);
            const frame=this.makeFrame(task,run,card.id,`${batch.id}-${card.id}-v${state.configurationRevision}-${guess.id}`,guess.structure,'guess',batch.source,undefined,undefined,undefined,{collectionId:`${batch.id}:${card.id}`,sourceFrameIndex:guess.attempt});
            this.attachSamplingOrigin(frame,run);
            frame.samplingOrigin!.discreteTorsions=guess.torsions.flatMap(row=>row.pointIndex!==undefined&&row.pointCount!==undefined?[{atomIds:[...row.atomIds] as [string,string,string,string],pointIndex:row.pointIndex,pointCount:row.pointCount,targetDegrees:row.targetDegrees}]:[]);
            run.frames.push(frame);state.frameIds.push(frame.id);
          }
          state.guesses=guesses;state.torsionContinuation=guesses.continuation;state.coreRejected=guesses.rejected.coreProtection??0;state.exhausted=guesses.stopReason==='combination-space-exhausted';
          if(state.exhausted&&state.frameIds.length<mixedCardTargetCount(card))state.error=`允许的组合已耗尽；本卡有效${state.frameIds.length}/${mixedCardTargetCount(card)}帧。`;
          if(isStopping(run))break;
          if(samplingCardNeedsWork(state)&&guesses.attempts<=(prior?.attempts??0))throw new Error('二面角遍历未前进，已保留完整游标；未自动重复尝试同一组合。');
          this.publishProgress();
          }while(samplingCardNeedsWork(state));
        }
        state.status=samplingCardNeedsWork(state)?'stopped':'completed';
      }catch(error){
        const stopped=isStopping(run)||error instanceof RunStopped;state.status=stopped?'stopped':'failed';state.error=message(error);if(segment)segment.status=stopped?'stopped':'failed';if(!stopped)failure??=error;
      }finally{
        if(segment){
          const frames=run.frames.slice(firstFrame).filter(frame=>frame.process?.kind==='sampling');segment.frameIds=frames.map(frame=>frame.id);segment.candidateFrameIds=frames.filter(frame=>frame.kind==='sampled-candidate').map(frame=>frame.id);
          segment.completedTimeFs=Math.max(0,...frames.map(frame=>frame.process?.kind==='sampling'?frame.process.data.timeFs:0));state.completedTimeFs=(segment.completedTimeBeforeFs??0)+segment.completedTimeFs;
          for(const id of segment.candidateFrameIds)if(!state.frameIds.includes(id))state.frameIds.push(id);state.sampling=run.sampling?structuredClone(run.sampling):undefined;
          if(segment.status==='completed'&&!samplingCardNeedsWork(state))state.status='completed';
        }
        state.generated=state.frameIds.length;state.receivedFrameCount=state.generated;state.accepted=state.mergedFrameIds.length;
        mixed.cards[index]={id:state.id,status:state.status,error:state.error,generated:state.generated,duplicates:state.duplicates,coreRejected:state.coreRejected,accepted:state.accepted,frameIds:[...state.mergedFrameIds],sampling:state.sampling};this.publish();
      }
      if(isStopping(run)){await this.rebuildMixedCandidates(task,run);await this.conformerResultsReady(task);throw new RunStopped('采样已终止；完整有效前缀和分卡进度已保留。');}
    }
    await this.rebuildMixedCandidates(task,run);
    await this.conformerResultsReady(task);
    this.checkRun(task,run);
    if(failure)throw failure;
    run.status='checkpoint';run.checkpoint={kind:'sampling',nextStageIndex:0};
  }
  private async execute(task: AdvancedTaskRecord, run: AdvancedTaskRun, plan: RunPlan) {
    await this.settleCacheReleases();
    if (task.mixedSampling && plan.intent === 'sampling') {
      if(plan.reorganizeOnly){await this.rebuildMixedCandidates(task,run);await this.conformerResultsReady(task);this.checkRun(task,run);run.status='checkpoint';run.checkpoint={kind:'sampling',nextStageIndex:0};}
      else await this.executeMixedSampling(task, run);return;
    }
    if (task.spec.kind === 'path') { await this.executePath(task, run); return; }
    if (plan.electronic) {
      const result = structuredClone(plan.electronic.result); result.reusedFromRunId = run.fromRunId; result.error = undefined;
      const stage: AdvancedStageRun = { id: `${run.id}-stage-1`, index: 0, status: 'running', inputCandidateIds: [result.candidateId], results: [], promotedCandidateIds: [] };
      result.stageId = stage.id; run.stages.push(stage); stage.results.push(result); run.results.push(result);
      this.electronicPending.set(run.id, { ...plan.electronic, result });
      await this.deliverElectronic(task, run, { ...plan.electronic, result }); stage.status = 'completed'; return;
    }
    let inputs = plan.inputs;
    if (plan.intent === 'sampling' && task.spec.kind === 'conformer-search' && task.guesses) {
      const candidate = task.conformerWorkflow!.candidateSet;
      if (!candidate?.valid) throw new Error('没有有效柔性键初猜。');
      candidate.producerRunId = run.id; run.status = 'checkpoint'; run.checkpoint = { kind: 'guesses', nextStageIndex: 0 }; return;
    }
    if (task.spec.kind === 'docking' && plan.intent !== 'stage' && plan.intent !== 'batch') {
      if (plan.dockingFromRunId) {
        const origin = this.run(task, plan.dockingFromRunId);
        if (!origin.docking?.acceptedCompletion && !origin.docking?.acceptedSearchCheckpoint) throw new Error('缺少已完成且映射核对的aISS候选来源。');
        run.docking = { ...structuredClone(origin.docking), reusedFromRunId: origin.id }; inputs ??= this.dockedInputs(task, origin);
      } else {
        inputs = await this.executeDocking(task, run);
        this.setCandidateSet(task, inputs.map(input => this.findFrame(task, input.source.ref.frameId!)!), run.id);
        if (task.spec.checkpointAfterDocking || plan.intent === 'sampling') { run.status = 'checkpoint'; run.checkpoint = { kind: 'docking', nextStageIndex: 0 }; return; }
      }
    }
    if (task.spec.kind === 'sampling' && plan.intent !== 'stage' && plan.intent !== 'batch') {
      if (plan.samplingFromRunId) {
        const origin = this.run(task, plan.samplingFromRunId);
        if (!origin.sampling?.acceptedCompletion) throw new Error('缺少已完成的无回填采样来源。');
        run.sampling = { ...structuredClone(origin.sampling), reusedFromRunId: origin.id };
        inputs ??= this.sampledInputs(task, origin);
      } else {
        try { inputs = await this.executeSampling(task, run); }
        catch (error) {
          const prefix = (run.sampling?.candidateFrameIds ?? []).map(id => this.findFrame(task, id)!).filter(Boolean);
          if (prefix.length) this.setCandidateSet(task, prefix, run.id);
          throw error;
        }
        this.setCandidateSet(task, inputs.map(input => this.findFrame(task, input.source.ref.frameId!)!), run.id);
        await this.conformerResultsReady(task);
        if (task.spec.checkpointAfterSampling || plan.intent === 'sampling') { run.status = 'checkpoint'; run.checkpoint = { kind: 'sampling', nextStageIndex: 0 }; return; }
      }
    }
    if (task.spec.kind === 'conformer-search' && !task.guesses) {
      // Internal generation uses the already captured task. No current/activation guard.
      const s = task.spec, snapshot = createConformerSnapshot(s.source.structure, s.source.ref, s.source.constraints);
      const guesses = await this.background<NonNullable<AdvancedTaskRecord['guesses']>>(run, { kind: 'generate', snapshot, entries: s.search.torsions, quantity: s.search.quantity, options: {
        limits: { ...s.search.samplingLimits, maxCandidates: task.budget.maxCandidates, maxAtoms: snapshot.structure.atoms.length }, clashPolicy: s.search.clashPolicy } });
      if (task.usage.retainedFrames + guesses.guesses.length > task.budget.maxRetainedFrames
        || task.usage.retainedCoordinates + guesses.guesses.length * s.source.structure.atoms.length > task.budget.maxRetainedCoordinates) throw new Error('初猜集合超过完整帧保留预算，未发布部分集合。');
      const frames = guesses.guesses.map(g => this.makeFrame(task, undefined, 'guesses', g.id, g.structure, 'guess', s.source));
      task.guessFrames.push(...frames); this.setCandidateSet(task, frames, run.id);
      task.guesses = guesses; this.publish();
      this.checkRun(task, run);
      if (s.search.checkpointAfterGuesses || plan.intent === 'sampling') { run.status = 'checkpoint'; run.checkpoint = { kind: 'guesses', nextStageIndex: 0 }; return; }
    }
    inputs ??= task.spec.kind === 'conformer-search' ? (task.conformerWorkflow!.candidateSet?.frameIds.map(id => this.findFrame(task, id)!) ?? task.guessFrames).map(f => ({ candidateId: f.candidateId, source: f.source }))
      : [{ candidateId: 'source', source: task.spec.source }];
    const configs = plan.configurations??this.stageConfigs(task);
    if(!plan.inputs&&task.conformerWorkflow?.inputSemantics===2){
      const selected=this.workflowStageInput(task,plan.stageIndex);inputs=selected.inputs;
      plan={...plan,inputSelection:selected.selection,inputCollectionId:selected.collectionId,inputCollectionRevision:selected.revision};
    }
    let inputCollectionId = plan.inputCollectionId ?? task.conformerWorkflow?.candidateSet?.id ?? 'source';
    let inputCollectionRevision=plan.inputCollectionRevision??task.conformerWorkflow?.candidateSet?.revision??0;
    // Reopened collections have scientific assets but no prepared view cache.
    // Settle their owner preparation before any optimization can claim a lease.
    // The Shell reuses prepared collections by their stable result signature.
    await this.conformerResultsReady(task);
    for (let index = plan.stageIndex; index < configs.length && index <= (plan.endStageIndex ?? configs.length); index++) {
      this.checkRun(task, run);
      let inputSelection=index===plan.stageIndex?plan.inputSelection:undefined;
      if(index>plan.stageIndex&&task.conformerWorkflow?.inputSemantics===2){
        const selected=selectAdvancedClusterInputs(task,configs[index-1].id,configs[index].inputClusterCount!,configs[index].inputStride);
        inputs=selected.inputs;inputCollectionId=selected.selection.collectionId;inputCollectionRevision=selected.selection.collectionRevision;inputSelection=selected.selection;
      }
      if (!inputs.length || inputs.length > task.budget.maxCandidates) throw new Error('没有有效级次输入或输入数量超过候选预算。');
      const config = configs[index],completed=!plan.forceRecalculate&&!plan.reclusterOnly?this.completedWorkflowStage(task,config,inputs,inputCollectionId,inputCollectionRevision):undefined;
      if(completed){
        // Keep the scientific collection's original owner/revision and frame
        // IDs. This new run is only a receipt for explicit preparation/reuse.
        const id=`${run.id}-stage-${index+1}`,succeeded=completed.stage.results.filter(result=>result.status==='completed').length;
        const stage:AdvancedStageRun={...completed.stage,id,results:completed.stage.results.map(result=>({...result,stageId:id,reusedFromRunId:completed.run.id})),
          progress:completed.stage.progress?{...completed.stage.progress,startedAt:this.now(),baselineSucceeded:succeeded,baselineDiscarded:completed.stage.results.length-succeeded,elapsedMs:0,etaMs:0}:undefined};
        const pendingIndex=run.stages.findIndex(item=>item.index===index);if(pendingIndex>=0)run.stages[pendingIndex]=stage;else run.stages.push(stage);
        run.results.push(...stage.results);await this.conformerResultsReady(task,stage.id);this.checkRun(task,run);
        inputs=this.promotedInputs(task,stage);inputCollectionId=completed.state.collectionId;inputCollectionRevision=completed.state.revision??inputCollectionRevision;
        if(!inputs.length)return;
        if(!plan.intent&&config.checkpointAfter&&index+1<configs.length){run.status='checkpoint';run.checkpoint={kind:'stage',nextStageIndex:index+1};return;}
        continue;
      }
      const stage: AdvancedStageRun = { id: `${run.id}-stage-${index + 1}`, index, status: 'running',
        inputs:structuredClone(inputs),inputSelection,inputCollectionRevision,configurationId: config.id, inputCollectionId, collectionId: task.mixedSampling ? `${task.id}:stage-${config.id}:representatives` : `${run.id}:stage-${index + 1}:representatives`,
        configuration: structuredClone(config), inputCandidateIds: inputs.map(i => i.candidateId), results: [], promotedCandidateIds: [] };
      const pendingIndex = run.stages.findIndex(item => item.index === index);
      if (pendingIndex >= 0) run.stages[pendingIndex] = stage; else run.stages.push(stage);
      this.publish();
      const stageInputs = inputs, ordered = new Map(stageInputs.map((input, ordinal) => [input.candidateId, ordinal]));
      const pendingInputs:CandidateInput[]=[];
      for(const input of stageInputs){
        const cached=!plan.forceRecalculate?this.reusableCalculation(task,config,input):undefined;
        if(cached)stage.results.push({...cached.result,stageId:stage.id,reusedFromRunId:cached.runId,originalInput:input.source});
        else{const discarded=!plan.forceRecalculate?this.interruptedCalculation(task,config,input,run.id):undefined;
          if(discarded&&(task.spec.kind==='sampling'||task.spec.kind==='conformer-search'))stage.results.push({...discarded.result,status:'failed',stageId:stage.id,reusedFromRunId:discarded.runId,originalInput:input.source});else pendingInputs.push(input);}
      }
      run.results=[...run.results.filter(result=>result.stageId!==stage.id),...stage.results];
      this.updateStageProgress(task,stage);this.publishStageResults(task,run,stage,false);this.publish();
      const pooled = ['conformer-search', 'sampling', 'docking'].includes(task.spec.kind);
      const parallel = pooled && this.deps.optimizationScheduling !== 'serial' && (!!this.deps.resolveResources || this.deps.optimizationScheduling === 'parallel') && stageInputs.length > 1;
      const threads = this.deps.resolveResources?.().effective.threads ?? (config.method.backend === 'xtb' ? config.method.options.threads : 1);
      const width = parallel ? Math.min(threads, Math.max(1,pendingInputs.length)) : 1;
      let cursor = 0, failure: unknown;
      const worker = async () => {
        while (cursor < pendingInputs.length && !failure && run.status !== 'stopping') {
          const input = pendingInputs[cursor++];
          try {
            this.checkRun(task, run);
            const conformer=task.spec.kind==='sampling'||task.spec.kind==='conformer-search';
            const interrupted=!conformer&&!plan.forceRecalculate?this.interruptedCalculation(task,config,input,run.id):undefined;
            const result=await this.calculate(task,run,stage,interrupted?{...input,source:interrupted.source}:input,config.method,pooled);
            if(conformer&&result.status==='stopped')result.status='failed';
            result.originalInput=input.source;
            stage.results=stage.results.filter(row=>row.candidateId!==input.candidateId);stage.results.push(result);stage.results.sort((a,b)=>ordered.get(a.candidateId)!-ordered.get(b.candidateId)!);
            run.results = [...run.results.filter(row => row.stageId !== stage.id), ...stage.results];
            const stageFrames = run.frames.filter(frame => frame.stageId === stage.id);
            stageFrames.sort((a, b) => ordered.get(a.candidateId)! - ordered.get(b.candidateId)!);
            run.frames = [...run.frames.filter(frame => frame.stageId !== stage.id), ...stageFrames];
            stage.resultRevision=(stage.resultRevision??0)+1;this.updateStageProgress(task,stage);this.publish();
            if (isStopping(run)||result.status==='stopped') { stage.status = 'stopped'; failure = new RunStopped('高级任务已停止；停止项未标为收敛。'); }
          } catch (error) { failure ??= error; }
        }
      };
      // Host admission owns the native group lease and partitions the grant.
      // Await every submitted child before letting this stage/run finish.
      if(!plan.reclusterOnly){
        if((task.spec.kind==='sampling'||task.spec.kind==='conformer-search')&&this.deps.conformerBatchBridge)await this.executeBatchStage(task,run,stage,pendingInputs,config.method);
        else await Promise.all(Array.from({ length: width }, worker));
      }
      stage.results.sort((a,b)=>ordered.get(a.candidateId)!-ordered.get(b.candidateId)!);
      run.results=[...run.results.filter(result=>result.stageId!==stage.id),...stage.results];
      if(failure||isStopping(run)){stage.status='stopped';this.publishStageResults(task,run,stage,false);await this.conformerResultsReady(task,stage.id);if(failure)throw failure;this.checkRun(task,run);}
      this.checkRun(task, run);
      if (task.spec.kind === 'conformer-search' || task.spec.kind === 'sampling' || task.spec.kind === 'docking') {
        const records: ConformerOptimizationResult[] = stage.results.map(result => {
          const frame = result.frameId ? this.findFrame(task, result.frameId) : undefined;
          return { candidateId: result.candidateId, source: { documentId: result.input.ref.documentId, revision: result.input.ref.revision,
            frameId: result.input.ref.frameId, sourceId: result.input.ref.sourceId }, structure: frame?.source.structure ?? result.input.structure,
            identity: result.identity ?? { method: this.methodLabel(config.method), solvent: 'none', charge: task.spec.source.structure.charge!, multiplicity: task.spec.source.structure.multiplicity! },
            constraints:result.input.constraints,converged: result.status === 'completed', energyHartree: result.energyHartree ?? null, failureReason: result.error };
        });
        try{
          stage.clustering = await this.background<NonNullable<AdvancedStageRun['clustering']>>(run, { kind: 'cluster', records, policy: { ...config.clustering, maxRecords: Math.max(task.budget.maxCandidates, records.length) } },true,stage.id);
        }
        catch(error){this.publishStageResults(task,run,stage,false);throw error;}
        if (!stage.clustering.groups.length&&stage.results.every(result=>result.status!=='completed')){
          stage.status='completed';stage.outcome={processed:stage.results.length,valid:0,failed:stage.results.length,target:config.advanceCount??stage.inputs?.length??0,actual:0,reason:'全部候选已丢弃。'};
          this.publishStageResults(task,run,stage,true);await this.conformerResultsReady(task,stage.id);this.publish();return;
        }
        if (stage.clustering.groups.length !== 1) { stage.status = 'failed'; throw new Error('级次产生多个不可比科学身份，未混排晋级。'); }
        const selected = selectConformerRepresentatives(stage.clustering.groups[0], task.conformerWorkflow?.inputSemantics===2?stage.clustering.groups[0].clusters.length:config.advanceCount??1);
        stage.promotedCandidateIds = selected.map(p => p.representativeCandidateId); inputs = this.promotedInputs(task, stage);
      } else {
        if (stage.results[0]?.status !== 'completed') { stage.status = 'failed'; throw new Error(stage.results[0]?.error ?? '高级任务没有有效完成结果。'); }
        if (stage.results[0].electronic?.status === 'retained' && stage.results[0].error) { stage.status = 'failed'; throw new Error(stage.results[0].error); }
        stage.promotedCandidateIds = [stage.results[0].candidateId];
      }
      const formallyCompleted=!plan.reclusterOnly||!!plan.reclusterCompleted&&stage.results.length===stage.inputCandidateIds.length;
      stage.status = formallyCompleted?'completed':'stopped';
      stage.outcome = { processed: stage.results.length, valid: stage.results.filter(row => row.status === 'completed').length,
        failed: stage.results.filter(row => row.status !== 'completed').length, target: config.advanceCount??stage.inputs?.length??0, actual: stage.promotedCandidateIds.length,
        ...(config.advanceCount!==undefined&&stage.promotedCandidateIds.length < config.advanceCount ? { reason: '有效收敛结果归簇后的不同代表少于目标晋级数。' } : {}) };
      if (task.conformerWorkflow && stage.clustering) {
        this.publishStageResults(task,run,stage,formallyCompleted);
        const state=task.conformerWorkflow.stages.find(state=>state.stageId===config.id)!;inputCollectionId=state.collectionId;inputCollectionRevision=state.revision??inputCollectionRevision;
      }
      await this.conformerResultsReady(task,stage.id);
      this.publish();
      if(plan.reclusterOnly){if(!formallyCompleted)run.status='stopped';return;}
      if (!plan.intent && config.checkpointAfter && index + 1 < configs.length) { run.status = 'checkpoint'; run.checkpoint = { kind: 'stage', nextStageIndex: index + 1 }; return; }
    }
  }
  private methodLabel(method: AdvancedOptimizationMethod) { return method.backend === 'xtb' ? XTB_METHOD_LABELS[method.options.method] : method.forcefield; }
  private async conformerResultsReady(task:AdvancedTaskRecord,stageId?:string):Promise<void> {
    if(task.conformerWorkflow&&this.deps.onConformerResultsReady){
      // Preparation checks the public task/source/collection identity again
      // after awaiting its work. Commit the terminal collection before that
      // boundary, so the guard observes the same revision as the request.
      const run=this.activeRun?.task===task?this.activeRun.run:undefined;
      if(run)run.backgroundProgress={phase:'prepare-results',stageId,completed:0,total:null};
      this.publish();
      try{await this.deps.onConformerResultsReady(this.state.tasks.find(value=>value.id===task.id)!);}
      finally{if(run){run.backgroundProgress=undefined;this.publish();}}
    }
  }
  private updateStageProgress(task:AdvancedTaskRecord,stage:AdvancedStageRun,values?:Partial<NonNullable<AdvancedStageRun['progress']>>):void {
    const succeeded=stage.results.filter(result=>result.status==='completed').length,discarded=stage.results.length-succeeded;
    const previous=stage.progress,startedAt=previous?.startedAt??this.now(),baselineSucceeded=previous?.baselineSucceeded??succeeded,baselineDiscarded=previous?.baselineDiscarded??discarded;
    const elapsedMs=Math.max(0,this.now()-startedAt),delta=succeeded-baselineSucceeded+discarded-baselineDiscarded;
    stage.progress={total:stage.inputCandidateIds.length,completed:succeeded,interrupted:0,failed:discarded,succeeded,discarded,running:0,pending:Math.max(0,stage.inputCandidateIds.length-succeeded-discarded),
      startedAt,baselineSucceeded,baselineDiscarded,elapsedMs,etaMs:delta>0?elapsedMs/delta*(stage.inputCandidateIds.length-succeeded-discarded):null,...values};
    const state=task.conformerWorkflow?.stages.find(state=>state.stageRunId===stage.id);if(state)state.progress={...stage.progress};
  }
  private async executeBatchStage(task:AdvancedTaskRecord,run:AdvancedTaskRun,stage:AdvancedStageRun,inputs:CandidateInput[],method:AdvancedOptimizationMethod):Promise<void> {
    const bridge=this.deps.conformerBatchBridge!,resources=this.deps.resolveResources?.(),baselineSucceeded=stage.results.filter(row=>row.status==='completed').length,baselineDiscarded=stage.results.length-baselineSucceeded;
    if(!inputs.length)return;
    const identity={taskId:task.id,runId:run.id,stageId:stage.id,revision:stage.inputCollectionRevision??0};
    const {batchId}=await bridge.begin({identity,total:inputs.length,method,resources});stage.batchId=batchId;this.activeBatch={runId:run.id,batchId};
    const requests=new Map<string,XtbRequest>();let terminalResolve!:(value:import('./batch-contracts').ConformerBatchProgress)=>void;
    const terminal=new Promise<import('./batch-contracts').ConformerBatchProgress>(resolve=>terminalResolve=resolve);
    let sequence=-1,adopting=false;
    const accept=(event:import('./batch-contracts').ConformerBatchProgress)=>{
      if(event.batchId!==batchId||!same(event.identity,identity)||event.seq<=sequence)return;sequence=event.seq;
      this.updateStageProgress(task,stage,{succeeded:baselineSucceeded+event.succeeded,discarded:baselineDiscarded+event.discarded,completed:baselineSucceeded+event.succeeded,failed:baselineDiscarded+event.discarded,
        pending:event.pending,running:event.running,elapsedMs:event.elapsedMs,etaMs:event.etaMs});this.publishProgress();
      if(event.phase==='stopped')run.status='stopping';
      if(['completed','stopped','error'].includes(event.phase))terminalResolve(event);
    };
    const unsubscribe=bridge.onProgress(accept);
    try{
      for(let offset=0;offset<inputs.length;){
        const packet:import('./batch-contracts').ConformerBatchInput[]=[];let bytes=0;
        while(offset+packet.length<inputs.length&&packet.length<32){const input=inputs[offset+packet.length];
          let request:import('./batch-contracts').ConformerBatchInput['request'];
          if(method.backend==='xtb'){const native=this.request(task,run,input,{...method.options,threads:1,...(resources?{memoryBudgetBytes:resources.effective.memoryBudgetBytes}:{})});native.optimizationPool={stageId:stage.id,candidateId:input.candidateId};requests.set(input.candidateId,native);request={backend:'xtb',request:native};}
          const entry={...input,originalInput:input.source,...(request?{request}:{})},size=new TextEncoder().encode(JSON.stringify(entry)).length;
          if(size>8*1024*1024)throw Error('单候选超过后台批注册大小上限。');if(packet.length&&bytes+size>8*1024*1024)break;bytes+=size;packet.push(entry);
        }
        await bridge.upload(batchId,{offset,inputs:packet});offset+=packet.length;
      }
      await bridge.seal(batchId);accept(isStopping(run)?await bridge.stop(batchId):await bridge.start(batchId));
      const settled=await terminal;
      task.usage.nativeJobs+=settled.succeeded+settled.discarded;run.subjobCount+=settled.succeeded+settled.discarded;adopting=true;
      for(let offset=0;offset<inputs.length;){const page=await bridge.read(batchId,{offset,limit:64});
        if(page.total!==inputs.length||!page.entries.length||page.entries.length>64||offset+page.entries.length>inputs.length)throw Error('后台批终态分页不完整。');
        for(const [position,entry] of page.entries.entries()){
          if(entry.index!==offset+position||entry.candidateId!==inputs[entry.index]?.candidateId||!this.sameInput(inputs[entry.index],{candidateId:entry.candidateId,source:entry.source}))throw Error('后台批终态候选顺序或原始来源不符。');
          if(entry.status==='pending')continue;
          if(entry.status!=='succeeded'&&entry.status!=='discarded')throw Error('后台批终态候选状态无效。');
          const result:AdvancedCalculationResult={candidateId:entry.candidateId,stageId:stage.id,input:entry.source,originalInput:entry.originalInput??entry.source,status:'failed',error:entry.reason?.message??'未收敛候选已丢弃。'};
          if(entry.status==='succeeded'){
            if(!entry.result)throw Error('后台成功结果缺少规范终态。');
            const raw=entry.result,native=requests.get(entry.candidateId);
            if(raw.resourceGrant&&resources)(run.resourceRequests??=[]).push({stageId:stage.id,candidateId:entry.candidateId,configured:structuredClone(resources),requested:structuredClone(raw.resourceGrant.requested),actualThreads:raw.resourceGrant.threads,actualGrant:structuredClone(raw.resourceGrant)});
            const structure=native?validateAdvancedXtbResult(native,raw.structure.atoms.map(atom=>({...atom,id:atom.id!})),raw.metadata!,raw.resourceGrant):raw.structure;
            if(!Number.isFinite(raw.energyHartree)||structure.atoms.length!==entry.source.structure.atoms.length||structure.atoms.some((atom,index)=>atom.id!==entry.source.structure.atoms[index]?.id||atom.element!==entry.source.structure.atoms[index]?.element||![atom.x,atom.y,atom.z].every(Number.isFinite)))throw Error('后台结果缺少有限能量或稳定原子对应。');
            const frame=this.makeFrame(task,run,stage.id,entry.candidateId,structure,'optimized',entry.source,raw.sessionId,undefined,raw.energyHartree);run.frames.push(frame);
            Object.assign(result,{status:'completed',error:undefined,frameId:frame.id,energyHartree:raw.energyHartree,metadata:raw.metadata,sessionId:raw.sessionId,
              identity:raw.identity??{method:native?`${XTB_METHOD_LABELS[native.method]}:${raw.metadata!.version}`:this.methodLabel(method),solvent:native?.solvation?`${native.solvation.model}:${native.solvation.solvent}`:'none',energyKind:native?.method==='gfnff'||method.backend==='forcefield'?'forcefield-potential':'electronic',charge:structure.charge!,multiplicity:structure.multiplicity!,settingsKey:native?JSON.stringify({constraints:native.constraints,frozenAtomIds:native.frozenAtomIds}):undefined}});
          }
          stage.results.push(result);run.results.push(result);
        }
        offset+=page.entries.length;
      }
      stage.resultRevision=(stage.resultRevision??0)+1;this.updateStageProgress(task,stage,{running:0,pending:settled.pending,etaMs:settled.pending?null:0});
      if(settled.phase==='error')throw Error(settled.error?.message??'后台批任务失败。');
      adopting=false;
      if(!(await bridge.destroy(batchId)).destroyed)throw Error('规范结果已接管，后台批句柄尚未确认释放。');
    }catch(error){
      if(adopting){const reason=`后台规范结果接管失败，已保留规范结果 ${batchId}：${message(error)}`;
        stage.adoptionError={code:'BATCH_RESULT_ADOPTION_FAILED',batchId,message:reason};stage.resultRevision=(stage.resultRevision??0)+1;
        stage.status='failed';run.status='running';this.updateStageProgress(task,stage,{running:0,etaMs:null});this.publishStageResults(task,run,stage,false);
        throw Error(reason);
      }
      throw error;
    }finally{unsubscribe();if(this.activeBatch?.batchId===batchId)this.activeBatch=undefined;}
  }
  private promotedInputs(task: AdvancedTaskRecord, stage: AdvancedStageRun): CandidateInput[] {
    return stage.promotedCandidateIds.map(candidateId => {
      const result = stage.results.find(r => r.candidateId === candidateId && r.status === 'completed');
      const frame = result?.frameId ? this.findFrame(task, result.frameId) : undefined;
      if (!frame) throw new Error('晋级代表缺少完整来源帧。');
      return { candidateId, source: frame.source };
    });
  }
  private inputsForStage(task: AdvancedTaskRecord, run: AdvancedTaskRun, index: number): CandidateInput[] {
    const fixed=run.stages.find(stage=>stage.index===index)?.inputs;if(fixed)return fixed.map(input=>({...input}));
    if (index === 0) return task.spec.kind === 'docking' ? this.dockedInputs(task, run) : task.spec.kind === 'sampling' ? this.sampledInputs(task, run) : task.spec.kind === 'conformer-search' ? task.guessFrames.map(f => ({ candidateId: f.candidateId, source: f.source }))
      : [{ candidateId: 'source', source: task.spec.source }];
    const prior = run.stages.find(s => s.index === index - 1);
    if (prior) return this.promotedInputs(task, prior);
    if (run.fromRunId) return this.inputsForStage(task, this.run(task, run.fromRunId), index);
    throw new Error('不能恢复缺少谱系的级次输入。');
  }
  private findFrame(task: AdvancedTaskRecord, id: string) { return task.guessFrames.find(f => f.id === id) ?? task.runs.flatMap(r => r.frames).find(f => f.id === id); }
  private validateRouteOptions(options: { threads: number; maxSteps: number; maxEvaluations: number; maxWallTimeSeconds?: number }, _legacyWallLimit?: number) {
    if (![options.threads, options.maxSteps, options.maxEvaluations].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('路径/采样资源必须显式、有限且为有效正值。');
  }
  private reserveRoute(task: AdvancedTaskRecord, run: AdvancedTaskRun, _legacyConfiguredSeconds?: number) {
    this.checkRun(task, run);
    if (this.activeJobs.size || this.activeForcefields.size || this.activeRoute) throw new Error('高级控制器原生槽尚未关闭。');
    if (task.usage.nativeJobs >= task.budget.maxNativeJobs) throw new Error('累计原生子作业预算已耗尽。');
    task.usage.nativeJobs++; run.subjobCount++; return { sessionId: this.nextSession() };
  }
  private routeCallbacks<E>(task: AdvancedTaskRecord, run: AdvancedTaskRun, onEvent: (event: E) => void) {
    return { onEvent, onIgnored: () => { this.state = { ...this.state, ignoredEvents: this.state.ignoredEvents + 1 }; this.publish(); },
      onProtocolError: (error: Error) => { run.error = error.message; run.status = 'stopping'; run.stopReason ??= 'route-protocol-or-budget'; this.publish(); } };
  }
  private processStage(task: AdvancedTaskRecord, prior: readonly { stageId: string }[], stageId: string) {
    if (prior.some(e => e.stageId === stageId)) return;
    if (task.spec.kind==='path')task.budget.maxProcessStages=Math.max(task.budget.maxProcessStages,task.usage.processStages+1);
    if (task.usage.processStages >= task.budget.maxProcessStages) throw new Error('原生过程阶段预算已耗尽。');
    task.usage.processStages++;
  }
  private retainPathFrame(task: AdvancedTaskRecord, run: AdvancedTaskRun, request: AdvancedPathRequest, sessionId: string, raw: AdvancedPathFrameData) {
    const data = routePayload(raw);let index=this.pathFrameIndex.get(sessionId);if(!index){index=new Map();this.pathFrameIndex.set(sessionId,index);}
    const existing = index.get(data.frameIndex);
    if (existing) { if (!same(existing.process!.data, data)) throw new Error('路径终态帧与已保留完整帧冲突。'); return existing; }
    const count = index.size;
    if (data.frameIndex !== count) throw new Error('路径帧源编号不连续，不能伪补中间帧。');
    const structure = validatePathFrame(request, data);
    const kind = data.role === 'initial-path' ? 'path-preview' : data.role === 'candidate' ? 'ts-candidate' : data.role === 'point-result' ? 'path-point' : 'path-optimizer';
    const candidateId = data.pointIndex === undefined ? data.imageIndex === undefined ? data.stageId : `${data.stageId}-image-${data.imageIndex}` : `scan-point-${data.pointIndex}`;
    const frame = this.makeFrame(task, run, data.stageId, candidateId, structure, kind, task.spec.source, sessionId, undefined, undefined,
      { collectionId: `${run.id}:${data.collectionId}`, sourceFrameIndex: data.frameIndex });
    frame.process = { kind: 'path', data }; run.frames.push(frame);index.set(data.frameIndex,frame);this.publishProgress(); return frame;
  }
  private dockedInputs(task: AdvancedTaskRecord, run: AdvancedTaskRun): CandidateInput[] {
    if (!run.docking?.acceptedCompletion && !run.docking?.acceptedSearchCheckpoint) throw new Error('aISS没有完整有效候选来源，不能启动无偏优化。');
    const kind = run.docking.acceptedSearchCheckpoint ? 'docking-screened' : 'docking-refined';
    return (run.docking.acceptedSearchCheckpoint ? run.docking.screenedFrameIds : run.docking.refinedFrameIds).map(id => {
      const frame = this.findFrame(task, id);
      if (!frame || frame.kind !== kind) throw new Error('aISS候选完整来源缺失。');
      return { candidateId: frame.candidateId, source: frame.source };
    });
  }
  private async executeDocking(task: AdvancedTaskRecord, run: AdvancedTaskRun): Promise<CandidateInput[]> {
    if (task.spec.kind !== 'docking') throw new Error('aISS任务身份不符。');
    const spec = task.spec, settings = dockingSettings(spec.docking), count = settings.refinement.candidateCount;
    const sourcePair = spec.fragments ? prepareSameFrameDocking(spec.source, spec.fragments).sources : [spec.source, spec.partnerSource!] as const;
    if (!sourcePair[1]) throw new Error('对接第二来源缺失。');
    const atomCount = sourcePair.reduce((n, source) => n + source.structure.atoms.length, 0);
    if (task.usage.retainedFrames + 2 * count > task.budget.maxRetainedFrames
      || task.usage.retainedCoordinates + 2 * count * atomCount > task.budget.maxRetainedCoordinates) throw new Error('aISS两姿态集合超过剩余完整帧保留预算，未提交或静默抽样。');
    const resources = this.captureResources(run, 'aiss', 'source-pair');
    const owned = this.reserveRoute(task, run, spec.docking.maxWallTimeSeconds); if (resources) resources.sessionId = owned.sessionId;
    const request: AissRequest = { ...settings, schema: 1, operation: 'aiss-docking', stamp: structuredClone(spec.source.stamp),
      ...(resources ? resources.requested : {}),
      runIdentity: { taskId: task.id, runId: run.id }, sources: sourcePair.map(source => ({
        stamp: structuredClone(source.stamp), structure: advancedFrameWorkingCopy(source), charge: 0 as const, uhf: 0 as const,
      })) as AissRequest['sources'] };
    run.docking = { phaseEvents: [], acceptedCompletion: false, sourceRefs: [structuredClone(sourcePair[0].ref), structuredClone(sourcePair[1].ref)],
      sourceAtomMapping: [], screenedFrameIds: [], refinedFrameIds: [] };
    const callbacks = this.routeCallbacks(task, run, (event: AissEvent) => {
      if (event.event === 'progress') {
        if (!['monomer-precomputation', 'screening', 'stack-search', 'angular-search', 'genetic-search', 'native-refinement'].includes(event.phase) || event.evaluations !== null
          || task.usage.processStages >= task.budget.maxProcessStages) throw new Error('aISS过程阶段身份或累计预算无效。');
        task.usage.processStages++; run.docking!.phaseEvents.push(event); this.publish();
      }
    });
    const session = startOwnedDocking(this.deps.aissBridge!, request, owned.sessionId, callbacks);
    this.activeRoute = { info: { taskId: task.id, runId: run.id, sessionId: owned.sessionId, stageId: 'aiss', candidateId: 'source-pair' },
      stop: () => session.stop().catch(error => { run.error = `aISS停止尚未确认，原生槽继续保留：${message(error)}`; this.publish(); throw error; }) }; this.publish();
    try {
      const { event, protocolError } = await session.terminal;
      if (event.event !== 'completed' && event.event !== 'search-checkpoint') {
        run.docking.terminal = event;
        if (run.status === 'stopping' || event.event === 'stopped') throw new RunStopped(protocolError ?? 'aISS已停止，没有接受原生候选为收敛结果。');
        throw new Error(protocolError ?? event.error.message);
      }
      let combined: Structure;
      try { combined = event.event === 'search-checkpoint' ? validateDockingSearchCheckpoint(request, event) : validateDockingCompletion(request, event); }
      catch (error) { run.docking.rejectedCompletion = { reason: message(error), diagnosticDirectory: event.diagnosticDirectory, artifacts: structuredClone(event.artifacts) }; throw error; }
      run.docking.terminal = event; run.docking.sourceAtomMapping = structuredClone(event.sourceAtomMapping);
      const scientificStructure = (structure: Structure): Structure => !spec.fragments ? structure : {
        ...structure, atoms: structure.atoms.map((atom, index) => {
          const originalId = event.sourceAtomMapping[index].sourceAtomId, original = spec.source.structure.atoms.find(a => a.id === originalId)!;
          return { ...structuredClone(original), x: atom.x, y: atom.y, z: atom.z };
        }), sourceAtomIds: event.sourceAtomMapping.map(row => row.sourceAtomId),
      };
      const scienceCombined = scientificStructure(combined);
      const parent = captureAdvancedFrame(scienceCombined, { ...spec.source.ref, taskId: task.id, runId: run.id, stageId: 'aiss', collectionId: `${run.id}:source-pair`, frameId: `${run.id}-source-pair` },
        { ...spec.source.stamp, graphFingerprint: graphFingerprint(scienceCombined), coordinatesFingerprint: coordinatesFingerprint(scienceCombined), constraintsFingerprint: JSON.stringify({ frozenAtomIds: [], coordinates: [] }) }, `${sourcePair[0].label} + ${sourcePair[1].label}`);
      const retain = (kind: 'docking-screened' | 'docking-refined', data: import('./docking-contracts').AissScreenedPose | import('./docking-contracts').AissRefinedCandidate, index: number) => {
        const structure = scientificStructure(routeStructure(combined, data.coordinates, []));
        assertBuilderStereoPreserved(scienceCombined, structure);
        const frame = this.makeFrame(task, run, 'aiss', `${kind}-${index + 1}`, structure, kind, parent, owned.sessionId, undefined, undefined,
          { collectionId: `${run.id}:${kind}`, sourceFrameIndex: index });
        frame.parentRef = structuredClone(spec.source.ref); frame.parentRefs = [structuredClone(sourcePair[0].ref), structuredClone(sourcePair[1].ref)];
        frame.process = kind === 'docking-screened' ? { kind, data: structuredClone(data as typeof event.screenedPoses[number]) }
          : { kind, data: structuredClone(data as import('./docking-contracts').AissRefinedCandidate) };
        run.frames.push(frame); (kind === 'docking-screened' ? run.docking!.screenedFrameIds : run.docking!.refinedFrameIds).push(frame.id);
      };
      event.screenedPoses.forEach((data, index) => retain('docking-screened', data, index));
      if (event.event === 'completed') event.refinedCandidates.forEach((data, index) => retain('docking-refined', data, index));
      if (event.event === 'search-checkpoint') run.docking.nativeRefinement = structuredClone(event.nativeRefinement);
      if (run.status === 'stopping' || protocolError) throw new RunStopped(protocolError ?? 'aISS停止时保留完整原生姿态，但没有接受或继续无偏优化。');
      run.docking.acceptedCompletion = event.event === 'completed'; run.docking.acceptedSearchCheckpoint = event.event === 'search-checkpoint'; this.publish();
      const last = run.frames.at(-1)!;
      try { await this.deps.onFrameResult?.(structuredClone(last), { taskId: task.id, runId: run.id, activate: false }); }
      catch (error) { run.error = `aISS姿态已保留，显示交接失败：${message(error)}`; }
      this.checkRun(task, run); return this.dockedInputs(task, run);
    } finally { this.activeRoute = undefined; this.publish(); }
  }
  private async executePath(task: AdvancedTaskRecord, run: AdvancedTaskRun) {
    if (task.spec.kind !== 'path') throw new Error('路径任务身份不符。');
    const resources = this.captureResources(run, 'path', 'source');
    const owned = this.reserveRoute(task, run, task.spec.path.maxWallTimeSeconds), source = task.spec.source;
    if (resources) resources.sessionId = owned.sessionId;
    const request = { ...withoutDeadline(structuredClone(task.spec.path)), schema: 1, stamp: structuredClone(source.stamp), runIdentity: { taskId: task.id, runId: run.id },
      ...(resources ? resources.requested : {}),
      structure: advancedFrameWorkingCopy(source), charge: source.structure.charge!, uhf: source.structure.multiplicity! - 1,
      frozenAtomIds: [...effectiveSharedFreezes(source.constraints).frozenAtomIds], constraints: effectiveSharedFreezes(source.constraints).coordinates.map(row => ({ id: row.id, objectId: row.objectId,
        type: row.type, atomIds: [...row.atomIds], action: 'freeze' as const, value: row.value, source: row.source, steps: 1 as const, increment: null })) } as AdvancedPathRequest;
    run.path = { stageEvents: [], acceptedCompletion: false };
    const callbacks = this.routeCallbacks(task, run, (event: AdvancedPathEvent) => {
      if (event.event === 'frame') this.retainPathFrame(task, run, request, owned.sessionId, event);
      else if (event.event === 'stage') { this.processStage(task, run.path!.stageEvents, event.stageId); run.path!.stageEvents.push(event); this.publish(); }
    });
    const session = startOwnedPath(this.deps.pathBridge!, request, owned.sessionId, callbacks);
    this.activeRoute = { info: { taskId: task.id, runId: run.id, sessionId: owned.sessionId, stageId: 'path', candidateId: 'source' },
      stop: () => session.stop().catch(error => { run.error = `路径停止尚未确认，原生槽继续保留：${message(error)}`; this.publish(); throw error; }) }; this.publish();
    try {
      const { event, protocolError } = await session.terminal; run.path.terminal = event;
      if (event.lastFrame) this.retainPathFrame(task, run, request, owned.sessionId, event.lastFrame);
      if (run.status === 'stopping' || event.event === 'stopped') throw new RunStopped(protocolError ?? '路径运行已停止，完整过程帧已保留。');
      if (event.event === 'error' || protocolError) throw new Error(protocolError ?? (event.event === 'error' ? event.error.message : '路径协议失败。'));
      validatePathCompletion(request, event);
      run.path.acceptedCompletion = true;
      const frame = run.frames.at(-1)!;
      try { await this.deps.onFrameResult?.(structuredClone(frame), { taskId: task.id, runId: run.id, activate: false }); }
      catch (error) { run.error = `路径结果已保留，显示交接失败：${message(error)}`; }
    } finally { this.pathFrameIndex.delete(owned.sessionId);this.activeRoute = undefined; this.publish(); }
  }
  private retainSamplingFrame(task: AdvancedTaskRecord, run: AdvancedTaskRun, request: ConformerSamplingRequest, sessionId: string, raw: ConformerSamplingFramePayload, source = task.spec.source,notify=true) {
    const data = routePayload(raw);
    let index = this.samplingFrameIndex.get(sessionId); if (!index) { index = new Map(); this.samplingFrameIndex.set(sessionId, index); }
    const existing = index.get(data.frameIndex);
    if (existing) { if (!same(existing.process!.data, data)) throw new Error('采样终态帧与已保留速度/坐标/偏置帧冲突。'); return existing; }
    const count = index.size;
    if (data.frameIndex !== count) throw new Error('采样完整帧源编号不连续，不能伪补。');
    if (data.biasHistoryCount !== run.sampling!.biasEvents.length) throw new Error('采样帧与实际RMSD偏置历史归属不一致。');
    const structure = validateSamplingFrame(request, data), sampled = data.role === 'sampled-candidate';
    if (sampled && run.sampling!.candidateFrameIds.length >= task.budget.maxCandidates) throw new Error('有效采样候选超过本任务候选预算。');
    const frame = this.makeFrame(task, run, data.stageId, `${run.mixedSampling ? sessionId + '-' : ''}${sampled ? 'sample' : 'trajectory'}-${data.frameIndex + 1}`, structure,
      sampled ? 'sampled-candidate' : 'sampling-trajectory', source, sessionId, data.step, undefined,
      { collectionId: `${run.id}:${data.collectionId}`, sourceFrameIndex: data.frameIndex });
    if (run.mixedSampling) this.attachSamplingOrigin(frame, run);
    frame.process = { kind: 'sampling', data }; run.frames.push(frame); index.set(data.frameIndex, frame);
    if(run.mixedSampling?.batchId&&run.mixedSampling.currentSegmentId){
      const batch=task.mixedSampling?.batches?.find(batch=>batch.id===run.mixedSampling!.batchId),card=batch?.cards[run.mixedSampling.currentCardIndex],segment=card?.segments.find(segment=>segment.id===run.mixedSampling!.currentSegmentId);
      if(card&&segment){segment.frameIds.push(frame.id);if(sampled){segment.candidateFrameIds.push(frame.id);card.frameIds.push(frame.id);}segment.completedTimeFs=Math.max(segment.completedTimeFs,data.timeFs);card.completedTimeFs=(segment.completedTimeBeforeFs??0)+segment.completedTimeFs;card.generated=card.frameIds.length;card.sampling=run.sampling;}
    }
    if (sampled) run.sampling!.candidateFrameIds.push(frame.id);if(notify)this.publishProgress();return frame;
  }
  private sampledInputs(task: AdvancedTaskRecord, run: AdvancedTaskRun): CandidateInput[] {
    if (!run.sampling?.acceptedCompletion && !run.mixedSampling) throw new Error('采样尚未完全完成，不能启动候选优化。');
    if(task.spec.kind!=='sampling')throw Error('采样任务身份不符。');
    const initial=task.spec.source,options=task.spec.sampling;
    const protectedIds=[...new Set([...effectiveSharedFreezes(initial.constraints).frozenAtomIds,
      ...(options.nativeProtection?.core?.atomIds??options.coreProtection?.atomIds??[])])];
    return (run.sampling?.candidateFrameIds ?? []).map(id => {
      const frame=this.findFrame(task,id);if(!frame||frame.kind!=='sampled-candidate')throw Error('采样候选来源帧缺失。');
      return this.preparedSamplingInput(frame, frame.samplingOrigin?.source ?? initial, frame.samplingOrigin?.protectedAtomIds ?? protectedIds);
    });
  }
  private nextOptimizationInput(task:AdvancedTaskRecord,input:CandidateInput,fresh:AdvancedFrameSource,frame?:AdvancedResultFrame):CandidateInput {
    frame??=input.source.ref.frameId?this.findFrame(task,input.source.ref.frameId):undefined;
    const initial=frame?.samplingOrigin?.source??input.source.protection?.reference??input.source.samplingPreparation?.protection?.reference??task.spec.source;
    const hard=effectiveSharedFreezes(fresh.constraints).frozenAtomIds;
    const constraints={...structuredClone(initial.constraints),enabled:true,frozenAtomIds:[...hard],coordinates:structuredClone(effectiveSharedFreezes(initial.constraints).coordinates)};
    const reference=frozen({...initial,stamp:{...initial.stamp,constraintsFingerprint:JSON.stringify(constraints)},constraints});
    const protection=resolveConformerProtection(reference,sharedFreezeRunDefinition(task.mixedSampling!.draft));
    const projected=frame??{candidateId:input.candidateId,source:input.source} as AdvancedResultFrame;
    return this.preparedSamplingInput({...projected,source:input.source},reference,protection.restorationAtomIds,protection);
  }
  private preparedSamplingInput(frame: AdvancedResultFrame, initial: AdvancedFrameSource, protectedIds: string[],protection?:ConformerProtectionSnapshot): CandidateInput {
      if(!protectedIds.length){
        if(!protection)return{candidateId:frame.candidateId,source:frame.source};
        const constraints={...structuredClone(frame.source.constraints),frozenAtomIds:[],coordinates:structuredClone(effectiveSharedFreezes(frame.source.constraints).coordinates),enabled:true};
        const source=captureAdvancedFrame(frame.source.structure,frame.source.ref,{...frame.source.stamp,constraintsFingerprint:JSON.stringify(constraints)},frame.source.label,constraints);
        return{candidateId:frame.candidateId,source:frozen({...source,protection})};
      }
      const prepared=prepareSamplingOptimization(frame.source.structure,initial.structure,protectedIds);
      const constraints={...structuredClone(frame.source.constraints),enabled:true,frozenAtomIds:protectedIds};
      const source=captureAdvancedFrame(prepared.structure,{...frame.source.ref,stageId:'sampling-initial-restored'},
        {...frame.source.stamp,coordinatesFingerprint:coordinatesFingerprint(prepared.structure),constraintsFingerprint:JSON.stringify(constraints)},
        frame.source.label+' · 恢复初始核心',constraints);
      return{candidateId:frame.candidateId,source:frozen({...source,...(protection?{protection}:{}),samplingPreparation:{kind:'rigid-fit-then-exact-core-restore' as const,...(protection?{protection}:{}),
        rawFrame:frame.source.ref,referenceFrame:initial.ref,protectedAtomIds:protectedIds,fitRmsdAngstrom:prepared.fitRmsdAngstrom,
        maxResidualAngstrom:prepared.maxResidualAngstrom,rotationAmbiguous:prepared.rotationAmbiguous}})};
  }
  private async executeSampling(task: AdvancedTaskRecord, run: AdvancedTaskRun, source = task.spec.source,
    options?: AdvancedSamplingTaskOptions): Promise<CandidateInput[]> {
    if (task.spec.kind !== 'sampling') throw new Error('采样任务身份不符。');
    const sampling = options ?? task.spec.sampling;
    if (effectiveSharedFreezes(source.constraints).coordinates.length) throw new Error('MD采样尚未验证B/A/D动量约束；此卡未执行。');
    conformerSamplingBudgetPlan(sampling,source.structure.atoms.length,{
      maxCandidates:task.budget.maxCandidates,maxRetainedFrames:task.budget.maxRetainedFrames-task.usage.retainedFrames,
      maxRetainedCoordinates:task.budget.maxRetainedCoordinates-task.usage.retainedCoordinates});
    const resources = this.captureResources(run, 'sampling', 'source');
    const owned = this.reserveRoute(task, run, sampling.maxWallTimeSeconds);
    if (resources) resources.sessionId = owned.sessionId;
    const frameSpace = Math.min(task.budget.maxRetainedFrames - task.usage.retainedFrames,
      Math.floor((task.budget.maxRetainedCoordinates - task.usage.retainedCoordinates) / source.structure.atoms.length));
    if (frameSpace < 1) throw new Error('本任务没有剩余完整帧保留空间。');
    const nativeMD = getConformerSamplingCapability(sampling).driver === 'native-xtb-md';
    const protectedIds = effectiveSharedFreezes(source.constraints).frozenAtomIds;
    const nativeProtection = sampling.nativeProtection;
    if (nativeMD && protectedIds.length>1&&protectedIds.some(id => !nativeProtection?.core?.atomIds.includes(id))) throw new Error('原生MD的保护原子需要明确的原子对约束定义，未静默丢弃坐标保护。');
    if(!run.protection)run.protection=resolveConformerProtection(source,{nativeProtection:sampling.nativeProtection,coreProtection:sampling.coreProtection});
    const request = { ...withoutDeadline(structuredClone(sampling)), schema: 1, stamp: structuredClone(source.stamp), runIdentity: { taskId: task.id, runId: run.id },
      ...(resources ? resources.requested : {}),
      structure: advancedFrameWorkingCopy(source), charge: source.structure.charge!, uhf: source.structure.multiplicity! - 1,
      frozenAtomIds: nativeMD ? [] : [...protectedIds], constraints: [],
      maxFrames: conformerSamplingSchedule(sampling)!.recordCount } as ConformerSamplingRequest;
    run.sampling = { stageEvents: [], biasEvents: [], candidateFrameIds: [], acceptedCompletion: false,
      startedAt: this.now() };
    // OwnedRouteSession checks session/stamp/run/sequence before this callback.
    // Resource admission is host evidence, not part of a frame's scientific payload.
    const acceptResources = (event: ConformerSamplingEvent) => {
      const value = event.effectiveResources;
      if (!resources && !value) return;
      const positive = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
      if (!value || typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version)
        || typeof value.source !== 'string' || !value.source.trim() || value.memoryEnforced !== false
        || !positive(value.threads) || !positive(value.memoryBudgetBytes)
        || !positive(value.configured?.threads) || !positive(value.configured?.memoryBudgetBytes)
        || !positive(value.requested?.threads) || !positive(value.requested?.memoryBudgetBytes)
        || value.requested?.threads !== request.threads || value.requested?.memoryBudgetBytes !== request.memoryBudgetBytes
        || value.threads > value.configured!.threads
        || value.threads < value.configured!.threads && !value.threadLimitReason?.trim()
        || !Number.isSafeInteger(value.reservedBytes) || value.reservedBytes! < 0
        || value.memoryBudgetBytes! + value.reservedBytes! !== value.configured!.memoryBudgetBytes
        || value.actual && (value.actual.threads !== value.threads || value.actual.memoryBudgetBytes !== value.memoryBudgetBytes)
        || event.event === 'stage' && event.configuration && (event.configuration.method !== request.method
          || event.configuration.threads !== value.threads || event.configuration.memoryBudgetBytes !== value.memoryBudgetBytes)) throw new Error('采样缺少匹配的受管全局资源授权回执。');
      const grant: ComputeResourceEvidence = { threads: value.threads, memoryBudgetBytes: value.memoryBudgetBytes!, version: value.version,
        source: value.source, configured: { threads: value.configured!.threads, memoryBudgetBytes: value.configured!.memoryBudgetBytes! },
        requested: { threads: value.requested!.threads!, memoryBudgetBytes: value.requested!.memoryBudgetBytes! }, reservedBytes: value.reservedBytes!,
        memoryEnforced: false, ...(value.threadLimitReason ? { threadLimitReason: value.threadLimitReason } : {}) };
      if (resources) {
        if (resources.actualGrant && !same(resources.actualGrant, grant)) throw new Error('采样同一子作业的资源授权回执发生冲突。');
        resources.actualGrant = structuredClone(grant); resources.actualThreads = grant.threads;
      }
    };
    const callbacks = this.routeCallbacks(task, run, (event: ConformerSamplingEvent) => {
      acceptResources(event);
      if (event.event === 'frame') this.retainSamplingFrame(task, run, request, owned.sessionId, event, source);
      else if(event.event==='progress'){
        if(event.step<(run.sampling!.progress?.step??0))throw new Error('采样实际步数倒退。');
        run.sampling!.progress=event;
        if(run.mixedSampling){const mixed=run.mixedSampling,batch=task.mixedSampling?.batches?.find(batch=>batch.id===mixed.batchId),card=batch?.cards[mixed.currentCardIndex],segment=card?.segments.find(segment=>segment.id===mixed.currentSegmentId);
          if(card&&segment){segment.completedTimeFs=Math.max(segment.completedTimeFs,event.step*(request.dtFs??2));card.completedTimeFs=(segment.completedTimeBeforeFs??0)+segment.completedTimeFs;
            card.receivedFrameCount=card.frameIds.length+(event.candidateCount??0);}}
        this.publishProgress();
      }
      else if (event.event === 'stage') { this.processStage(task, run.sampling!.stageEvents, event.stageId); run.sampling!.stageEvents.push(event); this.publish(); }
      else if (event.event === 'bias') {this.retainSamplingBias(task,run,request,event);this.publish();}
    });
    const session = startOwnedSampling(this.deps.samplingBridge!, request, owned.sessionId, callbacks);
    this.activeRoute = { info: { taskId: task.id, runId: run.id, sessionId: owned.sessionId, stageId: 'sampling', candidateId: 'source' },
      stop: () => session.stop().catch(error => { run.error = `采样停止尚未确认，原生槽继续保留：${message(error)}`; this.publish(); throw error; }) }; this.publish();
    try {
      const { event, protocolError } = await session.terminal; run.sampling.terminal = event;
      if(event.resultHandle){
        const handle=event.resultHandle,bridge=this.deps.samplingBridge!;
        if(!bridge.readConformerSamplingResult||!Number.isSafeInteger(handle.frameCount)||handle.frameCount<0)throw Error('采样规范结果句柄不可读取。');
        for(let offset=0;offset<handle.frameCount;){const page=await bridge.readConformerSamplingResult(handle.id,offset,64);
          if(page.offset!==offset||page.total!==handle.frameCount||!page.frames.length||page.frames.length>64||offset+page.frames.length>handle.frameCount)throw Error('采样规范结果分页不完整。');
          for(const frame of page.frames){if(frame.sessionId!==owned.sessionId||!same(frame.stamp,request.stamp)||!same(frame.runIdentity,request.runIdentity)||frame.operation!==request.operation||frame.method!==request.method)throw Error('采样规范结果归属不符。');
            while(run.sampling.biasEvents.length<frame.biasHistoryCount){const index=run.sampling.biasEvents.length,entry=event.biasHistory?.[index];if(!entry||entry.index!==index||request.operation!=='metadynamics')throw Error('采样规范结果缺少对应偏置历史。');
              this.retainSamplingBias(task,run,request,{schema:1,sessionId:owned.sessionId,stamp:request.stamp,runIdentity:request.runIdentity,operation:request.operation,method:request.method,seq:frame.seq,event:'bias',stageId:'metadynamics',historyEntry:entry});}
            this.retainSamplingFrame(task,run,request,owned.sessionId,frame,source,false);}
          offset+=page.frames.length;if(page.done!==(offset===handle.frameCount))throw Error('采样规范结果分页终点不符。');
        }
        if((this.samplingFrameIndex.get(owned.sessionId)?.size??0)!==handle.frameCount)throw Error('采样规范结果接收计数不符。');
        await bridge.releaseConformerSamplingResult?.(handle.id);
      }
      if (event.lastFrame) this.retainSamplingFrame(task, run, request, owned.sessionId, event.lastFrame, source);
      if (!protocolError) {
        const observation = applyNativeTemperatureObservations(run.frames, owned.sessionId, request, event.nativeTemperatureObservations);
        if(observation.applied)for(const frame of run.frames)if(frame.sessionId===owned.sessionId)this.assetSnapshots.delete(frame);
        if (observation.diagnostic) (run.sampling.optionalDiagnostics ??= []).push(observation.diagnostic);
      }
      if (run.status === 'stopping' || event.event === 'stopped') throw new RunStopped(protocolError ?? '采样已停止；已保留候选仍为未优化状态。');
      if (event.event === 'error' || protocolError) throw new Error(protocolError ?? (event.event === 'error' ? event.error.message : '采样协议失败。'));
      acceptResources(event);
      const frames = run.frames.filter(frame => frame.sessionId === owned.sessionId && frame.process?.kind === 'sampling').length;
      validateSamplingCompletion(request, event, frames, run.sampling.candidateFrameIds.length);
      if (!same(event.biasHistory, run.sampling.biasEvents.map(e => e.historyEntry))) throw new Error('完成事件与实际偏置历史不一致。');
      run.sampling.acceptedCompletion = true;
      return this.sampledInputs(task, run);
    } finally { this.samplingFrameIndex.delete(owned.sessionId); this.activeRoute = undefined; this.publish(); }
  }
  private retainSamplingBias(task:AdvancedTaskRecord,run:AdvancedTaskRun,request:ConformerSamplingRequest,event:Extract<ConformerSamplingEvent,{event:'bias'}>):void {
    const entry=event.historyEntry;
    if(request.operation!=='metadynamics'||entry.index!==run.sampling!.biasEvents.length||task.usage.biasHistoryEntries>=task.budget.maxBiasHistoryEntries
      ||!Array.isArray(entry.coordinatesAngstrom)||entry.coordinatesAngstrom.length!==entry.atomIds.length
      ||entry.coordinatesAngstrom.some(p=>p.length!==3||!p.every(Number.isFinite))
      ||task.usage.retainedCoordinates+entry.coordinatesAngstrom.length>task.budget.maxRetainedCoordinates)throw Error('RMSD偏置历史身份、坐标或累计保留预算无效。');
    task.usage.biasHistoryEntries++;task.usage.retainedCoordinates+=entry.coordinatesAngstrom.length;run.sampling!.biasEvents.push(event);
  }
  private makeFrame(task: AdvancedTaskRecord, run: AdvancedTaskRun | undefined, stageId: string, candidateId: string,
    structure: Structure, kind: AdvancedResultFrame['kind'], parent: AdvancedFrameSource, sessionId?: string, step?: number, energyHartree?: number, refPatch?: Partial<AdvancedFrameRef>): AdvancedResultFrame {
    if(task.spec.kind==='path'){
      task.budget.maxRetainedFrames=Math.max(task.budget.maxRetainedFrames,task.usage.retainedFrames+1);
      task.budget.maxRetainedCoordinates=Math.max(task.budget.maxRetainedCoordinates,task.usage.retainedCoordinates+structure.atoms.length);
    }
    if (task.usage.retainedFrames >= task.budget.maxRetainedFrames || task.usage.retainedCoordinates + structure.atoms.length > task.budget.maxRetainedCoordinates) throw new Error('完整帧保留预算已达上限；未静默丢帧。');
    const id = `${task.id}-frame-${++this.frameSerial}`;
    const stamp: DocumentStamp = { ...structuredClone(parent.stamp), graphFingerprint: graphFingerprint(structure), coordinatesFingerprint: coordinatesFingerprint(structure) };
    const capturedSource = captureAdvancedFrame(structure, { ...parent.ref, taskId: task.id, runId: run?.id, stageId,
      collectionId: `${run?.id ?? task.id}-${stageId}-${kind === 'intermediate' ? candidateId : 'results'}`, frameId: id, ...refPatch }, stamp, parent.label, parent.constraints);
    const protection=['sampled-candidate','sampling-trajectory'].includes(kind)?run?.protection??parent.protection:parent.protection;
    const source=parent.samplingPreparation||protection?frozen({...capturedSource,...(parent.samplingPreparation?{samplingPreparation:parent.samplingPreparation}:{}),...(protection?{protection}:{})}):capturedSource;
    const frame: AdvancedResultFrame = { id, taskId: task.id, runId: run?.id, stageId, candidateId, kind, source,
      parentRef: structuredClone(parent.ref), sessionId, step, energyHartree };
    task.usage.retainedFrames++; task.usage.retainedCoordinates += structure.atoms.length; return frame;
  }
  private request(task: AdvancedTaskRecord, run: AdvancedTaskRun, input: CandidateInput, options: AdvancedXtbOptions): XtbRequest {
    const structure = advancedFrameWorkingCopy(input.source), singlepoint = task.spec.kind === 'singlepoint';
    const constraints = singlepoint ? [] : effectiveSharedFreezes(input.source.constraints).coordinates.map(row => ({
      id: row.id, objectId: row.objectId, type: row.type, atomIds: [...row.atomIds], action: 'freeze' as const,
      steps: row.steps, increment: row.increment, source: row.source,
      value: row.value ?? builderCoordinateValue(input.source.structure, row.type, row.atomIds) }));
    const frozenAtomIds = [...effectiveSharedFreezes(input.source.constraints).frozenAtomIds];
    const stamp: DocumentStamp = { ...structuredClone(input.source.stamp), graphFingerprint: graphFingerprint(structure),
      coordinatesFingerprint: coordinatesFingerprint(structure), constraintsFingerprint: JSON.stringify({ frozenAtomIds, coordinates: constraints }) };
    return { stamp, structure, method: options.method, calculation: singlepoint ? 'singlepoint' : 'optimize',
      runIdentity: { taskId: task.id, runId: run.id }, electronicProperties: singlepoint,
      ...(options.solvation ? { solvation: structuredClone(options.solvation) } : {}),
      ...(options.memoryBudgetBytes !== undefined ? { memoryBudgetBytes: options.memoryBudgetBytes } : {}),
      charge: structure.charge!, ...(options.method === 'gfnff' ? {} : { uhf: structure.multiplicity! - 1 }),
      frozenAtomIds, constraints, internalConstraintsConfirmed: !singlepoint && !!constraints.length && options.internalConstraintsConfirmed,
      threads: options.threads, maxSteps: options.maxSteps, ...(options.maxSccIterations===undefined?{}:{maxSccIterations:options.maxSccIterations}) };
  }
  private async calculate(task: AdvancedTaskRecord, run: AdvancedTaskRun, stage: AdvancedStageRun, input: CandidateInput,
    method: AdvancedOptimizationMethod, pooled = false): Promise<AdvancedCalculationResult> {
    if (task.usage.nativeJobs >= task.budget.maxNativeJobs) throw new Error('本任务累计原生子作业预算已耗尽。');
    const resources = this.captureResources(run, stage.id, input.candidateId, method.backend === 'forcefield');
    if (resources && pooled) resources.requested.threads = 1;
    if (resources) method = method.backend === 'xtb' ? { ...method, options: { ...method.options, ...resources.requested } } : { ...method, threads: 1 };
    if (pooled && method.backend === 'xtb') method = { ...method, options: { ...method.options, threads: 1 } };
    if (method.backend === 'forcefield') return this.calculateForcefield(task, run, stage, input, method, resources, pooled);
    const request = this.request(task, run, input, method.options), sessionId = this.nextSession();
    if (pooled) request.optimizationPool = { stageId: stage.id, candidateId: input.candidateId };
    if (resources) resources.sessionId = sessionId;
    task.usage.nativeJobs++; run.subjobCount++;
    let resolve!: (event: XtbEvent) => void, reject!: (error: Error) => void;
    const terminal = new Promise<XtbEvent>((yes, no) => { resolve = yes; reject = no; });
    const job: NativeJob = { task, run, stage, input, sessionId, request, lastSequence: -1, lastStep: -1, observedFrames: 0, terminal: false, resolve, reject };
    if (!pooled && this.activeJobs.size) throw new Error('高级控制器原生槽仍被占用。');
    this.activeJobs.set(sessionId, job); this.publish();
    let diagnosticDirectory: string | undefined;
    try {
      void this.deps.bridge!.startXtb(request, sessionId).catch(error => {
        // The current host emits terminal errors after a session was registered;
        // a rejected submission with no event means admission itself failed.
        if (job.lastSequence < 0) { job.terminal = true; job.reject(new Error(message(error))); }
        else { job.protocolError = message(error); void this.requestStop(job).catch(failure => { run.error = message(failure); this.publish(); }); }
      });
      const event = await terminal;
      diagnosticDirectory = event.diagnosticDirectory;
      if (event.event !== 'completed' || run.status === 'stopping') return { candidateId: input.candidateId, stageId: stage.id,
        status: event.event === 'stopped' || run.status === 'stopping' ? 'stopped' : 'failed', input: input.source, sessionId,
        diagnosticDirectory: event.diagnosticDirectory,
        error: job.protocolError ?? event.error?.message ?? event.reason ?? '原生任务没有有效完成。' };
      const structure = validateAdvancedXtbResult(request, event.coordinates!, event.metadata!, event.effectiveResources);
      if (resources) { resources.actualThreads = event.metadata!.threads; resources.actualGrant = structuredClone(event.metadata!.resourceGrant!); }
      const frame = this.makeFrame(task, run, stage.id, input.candidateId, structure,
        request.calculation === 'singlepoint' ? 'singlepoint' : 'optimized', input.source, sessionId, undefined, event.metadata!.energyHartree);
      run.frames.push(frame);
      const result: AdvancedCalculationResult = { candidateId: input.candidateId, stageId: stage.id, status: 'completed',
        input: input.source, frameId: frame.id, energyHartree: event.metadata!.energyHartree, metadata: structuredClone(event.metadata), sessionId,
        diagnosticDirectory: event.diagnosticDirectory,
        identity: { method: `${XTB_METHOD_LABELS[request.method]}:${event.metadata!.version}`, solvent: request.solvation ? `${request.solvation.model}:${request.solvation.solvent}` : 'none',
          energyKind: request.method === 'gfnff' ? 'forcefield-potential' : 'electronic',
          charge: request.charge, multiplicity: structure.multiplicity!, settingsKey: JSON.stringify({ constraints: request.constraints, frozenAtomIds: request.frozenAtomIds }) } };
      if (job.observedFrames > 1 && !diagnosticDirectory?.trim()) return { ...result, status: 'failed',
        error: '优化显示缓存已更新，但完成事件缺少完整原始轨迹目录；最终帧仍保留，未接受为可追溯完成结果。' };
      if (request.calculation === 'singlepoint') {
        if (!event.electronicArtifacts) { result.error = 'GFN2单点未返回受管电子来源回执。'; result.electronic = undefined; return { ...result, status: 'failed' }; }
        const pending = { receipt: event.electronicArtifacts, request, sessionId, result };
        this.electronicPending.set(run.id, pending);
        try { await this.deliverElectronic(task, run, pending); }
        catch (error) { result.error = message(error); result.electronic = { artifactId: pending.receipt.artifactId, status: 'retained', error: result.error }; }
      }
      try { await this.deps.onFrameResult?.(structuredClone(frame), { taskId: task.id, runId: run.id, activate: false }); }
      catch (error) { result.error = `完整结果已保留，显示来源交接失败：${message(error)}`; }
      return result;
    } catch (error) { return { candidateId: input.candidateId, stageId: stage.id, status: 'failed', input: input.source, sessionId, diagnosticDirectory, error: message(error) }; }
    finally { this.activeJobs.delete(sessionId); this.publish(); }
  }
  private async calculateForcefield(task: AdvancedTaskRecord, run: AdvancedTaskRun, stage: AdvancedStageRun,
    input: CandidateInput, method: Extract<AdvancedOptimizationMethod, { backend: 'forcefield' }>, resources?: NonNullable<AdvancedTaskRun['resourceRequests']>[number], pooled = false): Promise<AdvancedCalculationResult> {
    const adapter = this.deps.forcefieldAdapter;
    if (!adapter) throw new Error('当前缺少受控力场适配。');
    const sessionId = this.nextSession();
    if (resources) resources.sessionId = sessionId;
    if (!pooled && (this.activeJobs.size || this.activeForcefields.size)) throw new Error('高级控制器原生槽仍被占用。');
    task.usage.nativeJobs++; run.subjobCount++;
    const job = adapter.optimize({ source: structuredClone(input.source), method: structuredClone(method), taskId: task.id, runId: run.id,
      ...(pooled ? { optimizationPool: { stageId: stage.id, candidateId: input.candidateId } } : {}),
      ...(resources ? { memoryBudgetBytes: resources.requested.memoryBudgetBytes } : {}) });
    this.activeForcefields.set(sessionId, { info: { taskId: task.id, runId: run.id, sessionId, stageId: stage.id, candidateId: input.candidateId }, stop: () => job.stop() }); this.publish();
    try {
      const result = await job.promise;
      if (run.status === 'stopping') return { candidateId: input.candidateId, stageId: stage.id, status: 'stopped', input: input.source, sessionId, error: '力场任务已停止，结果未作收敛接受。' };
      if (resources && (!result.resourceGrant
        || result.resourceGrant.requested.threads !== resources.requested.threads
        || result.resourceGrant.requested.memoryBudgetBytes !== resources.requested.memoryBudgetBytes
        || result.resourceGrant.threads !== result.effectiveResources?.threads
        || result.resourceGrant.memoryBudgetBytes !== result.effectiveResources?.memoryBudgetBytes)) throw new Error('力场缺少与本次资源请求对应的实际host grant。');
      if (!result.converged || !Number.isFinite(result.energyHartree) || result.energyKind !== 'forcefield-potential'
        || !result.engine || !result.version || !['MMFF94', 'MMFF94s', 'UFF'].includes(result.forcefield)
        || result.effectiveResources?.threads !== method.threads
        || method.forcefield !== 'auto' && result.forcefield !== method.forcefield) throw new Error('力场缺少真实收敛、势能或实际方法回执。');
      if (resources) { resources.actualThreads = result.effectiveResources.threads; resources.actualGrant = structuredClone(result.resourceGrant!); }
      const structure = structuredClone(result.structure), original = input.source.structure;
      if (graphFingerprint(structure) !== graphFingerprint(original) || structure.atoms.length !== original.atoms.length
        || structure.atoms.some((a, i) => a.id !== original.atoms[i].id || a.element !== original.atoms[i].element
          || ![a.x, a.y, a.z].every(Number.isFinite))) throw new Error('力场结果改变了原子对应、连接或电子态。');
    const fixed = new Set(effectiveSharedFreezes(input.source.constraints).frozenAtomIds);
      for (let i = 0; i < original.atoms.length; i++) if (fixed.has(original.atoms[i].id!)) {
        if (!(['x', 'y', 'z'] as const).every(key => Object.is(original.atoms[i][key], structure.atoms[i][key]))) throw new Error('力场结果改变了固定原子。');
      }
      for (const row of effectiveSharedFreezes(input.source.constraints).coordinates) {
        const target = row.value!, actual = builderCoordinateValue(structure, row.type, row.atomIds);
        const residual = row.type === 'D' ? ((actual - target + 180) % 360 + 360) % 360 - 180 : actual - target;
        const tolerance = row.type === 'B' ? XTB_INTERNAL_CONSTRAINT_POLICY.bondToleranceAngstrom : XTB_INTERNAL_CONSTRAINT_POLICY.angleToleranceDegree;
        if (!Number.isFinite(residual) || Math.abs(residual) > tolerance) throw new Error('力场结果冻结内坐标残差未达标。');
      }
      assertBuilderStereoPreserved(original, structure);
      structure.preparation = undefined;
      const frame = this.makeFrame(task, run, stage.id, input.candidateId, structure, 'optimized', input.source, sessionId, undefined, result.energyHartree);
      run.frames.push(frame);
      const accepted: AdvancedCalculationResult = { candidateId: input.candidateId, stageId: stage.id, status: 'completed', input: input.source, frameId: frame.id,
        sessionId, energyHartree: result.energyHartree, identity: { method: `${result.engine}:${result.version}:${result.forcefield}`,
          solvent: 'none', energyKind: 'forcefield-potential', charge: structure.charge!, multiplicity: structure.multiplicity!, settingsKey: JSON.stringify({
            energyKind: 'forcefield-potential', actualForcefield: result.forcefield, constraints: effectiveSharedFreezes(input.source.constraints).coordinates, frozenAtomIds: [...fixed],
          }) } };
      try { await this.deps.onFrameResult?.(structuredClone(frame), { taskId: task.id, runId: run.id, activate: false }); }
      catch (error) { accepted.error = `完整结果已保留，显示来源交接失败：${message(error)}`; }
      return accepted;
    } catch (error) { return { candidateId: input.candidateId, stageId: stage.id, status: run.status === 'stopping' ? 'stopped' : 'failed', input: input.source, sessionId, error: message(error) }; }
    finally { this.activeForcefields.delete(sessionId); this.publish(); }
  }
  private async deliverElectronic(task: AdvancedTaskRecord, run: AdvancedTaskRun, pending: ElectronicPending) {
    const bridge = this.deps.bridge!;
    if (pending.result.electronic?.status === 'release-failed' || pending.result.electronic?.status === 'transferred') {
      if (!(await bridge.releaseXtbElectronicArtifacts!(pending.receipt.artifactId)).released) throw new Error('已交接电子来源仍未确认释放。');
      pending.result.electronic.status = 'transferred'; pending.result.electronic.error = undefined;
      this.electronicPending.delete(run.id); if (run.fromRunId) this.electronicPending.delete(run.fromRunId); return;
    }
    const bundle = await bridge.readXtbElectronicArtifacts!(pending.receipt.artifactId);
    this.validateBundle(bundle, pending, task.id, pending.request.runIdentity!.runId);
    if (run.status === 'stopping') throw new RunStopped('已停止后续交接，原始电子来源已保留。');
    pending.result.electronic = { artifactId: bundle.artifactId, status: 'retained' };
    await this.deps.onElectronicResult!(bundle, { sessionId: pending.sessionId, request: structuredClone(pending.request), taskId: task.id,
      runId: pending.request.runIdentity!.runId, ...(pending.request.runIdentity!.runId !== run.id ? { deliveryRunId: run.id } : {}), activate: false });
    pending.result.electronic.status = 'transferred';
    try {
      if (!(await bridge.releaseXtbElectronicArtifacts!(bundle.artifactId)).released) throw new Error('电子来源已接收，但原始受管副本未确认释放。');
      this.electronicPending.delete(run.id); if (run.fromRunId) this.electronicPending.delete(run.fromRunId);
    } catch (error) { pending.result.electronic = { artifactId: bundle.artifactId, status: 'release-failed', error: message(error) }; }
  }
  private validateBundle(bundle: XtbElectronicArtifactBundle, pending: ElectronicPending, taskId: string, runId: string) {
    if (bundle.artifactId !== pending.receipt.artifactId || bundle.sessionId !== pending.sessionId || !same(bundle.stamp, pending.request.stamp)
      || !same(bundle.runIdentity, { taskId, runId }) || !bundle.files.some(f => f.role === 'molden') || !bundle.files.some(f => f.role === 'stdout')
      || !same(bundle.files.map(({ text: _text, ...file }) => file), pending.receipt.files) || bundle.files.some(f => typeof f.text !== 'string')) throw new Error('受管电子来源身份或文件清单不匹配，未释放。');
    validateAdvancedXtbResult(pending.request, bundle.metadata.orderedAtoms, bundle.metadata);
    if (bundle.metadata.energyHartree !== pending.result.energyHartree) throw new Error('受管电子来源能量与完成事件不匹配。');
  }
  private handleEvent(event: XtbEvent) {
    const job = this.activeJobs.get(event.sessionId);
    if (!job || job.terminal || event.sessionId !== job.sessionId) return;
    if (event.schema !== 1 || event.method !== job.request.method || event.operation !== (job.request.calculation === 'singlepoint' ? 'xtb-singlepoint' : 'xtb-optimize')
      || !same(event.stamp, job.request.stamp) || !same(event.runIdentity, job.request.runIdentity)
      || !Number.isSafeInteger(event.seq) || event.seq <= job.lastSequence) {
      this.state = { ...this.state, ignoredEvents: this.state.ignoredEvents + 1 }; this.publish(); return;
    }
    job.lastSequence = event.seq;
    if (['completed', 'stopped', 'error'].includes(event.event)) {
      if (!closedExit(event)) { job.protocolError = '原生终态缺少实际退出回执。'; void this.requestStop(job).catch(error => { job.run.error = message(error); this.publish(); }); return; }
      if (event.event === 'completed' && (event.exit!.code !== 0 || event.exit!.signal !== null)) {
        event = { ...event, event: 'error', error: { code: 'INVALID_COMPLETION_EXIT', message: '原生完成事件不是正常退出。' } };
      }
      if (event.coordinates && (event.event === 'stopped' || job.run.status === 'stopping') && job.request.calculation === 'optimize') {
        try {
          const shouldKeep = event.step === undefined || (Number.isSafeInteger(event.step) && event.step >= 0 && event.step > job.lastStep);
          if (shouldKeep) {
            const structure = advancedXtbCoordinates(job.request, event.coordinates);
            this.retainIntermediate(job, structure, event.step);
          }
        } catch (error) { job.protocolError ??= message(error); }
      }
      job.terminal = true; job.resolve(structuredClone(event)); return;
    }
    if (event.event === 'frame') {
      if(job.request.optimizationPool&&(job.task.spec.kind==='sampling'||job.task.spec.kind==='conformer-search'))return;
      if (job.run.status === 'stopping') return;
      try {
        if (job.request.calculation !== 'optimize' || event.stepKind !== 'native-log-frame'
          || !Number.isSafeInteger(event.step) || event.step! <= job.lastStep) throw new Error('原生中间帧过程或步序无效。');
        const structure = advancedXtbCoordinates(job.request, event.coordinates!);
        this.retainIntermediate(job, structure, event.step);
        job.lastStep = event.step!; this.publishProgress();
      } catch (error) { job.protocolError = message(error); job.run.error = job.protocolError; job.run.status = 'stopping';
        job.run.stopReason = 'frame-validation-or-budget'; this.publish(); void this.requestStop(job).catch(failure => { job.run.error = message(failure); this.publish(); }); }
    } else this.publishProgress();
  }
  /** Display cache only. The native directory is the original trajectory source;
   * final accepted frames are separately retained and never evicted here. */
  private retainIntermediate(job: NativeJob, structure: Structure, step?: number) {
    const index = job.run.frames.findIndex(frame => frame.kind === 'intermediate' && frame.sessionId === job.sessionId);
    const prior = index < 0 ? undefined : job.run.frames[index];
    if (prior) { job.task.usage.retainedFrames--; job.task.usage.retainedCoordinates -= prior.source.structure.atoms.length; }
    let frame: AdvancedResultFrame;
    try { frame = this.makeFrame(job.task, job.run, job.stage.id, job.input.candidateId, structure, 'intermediate', job.input.source, job.sessionId, step); }
    catch (error) { if (prior) { job.task.usage.retainedFrames++; job.task.usage.retainedCoordinates += prior.source.structure.atoms.length; } throw error; }
    if (index < 0) job.run.frames.push(frame); else job.run.frames[index] = frame;
    const cache = job.run.intermediateCache ??= { policy: 'latest-per-candidate', observedFrameCount: 0, cachedFrameCount: 0 };
    job.observedFrames++; cache.observedFrameCount++; cache.cachedFrameCount = job.run.frames.filter(item => item.kind === 'intermediate').length;
  }
  private async requestStop(job: NativeJob): Promise<void> {
    if (job.terminal) return;
    if (job.stopPending) return job.stopPending;
    job.stopPending = this.deps.bridge!.commandXtb(job.sessionId, { command: 'stop' }).then(value => {
      // Current host command resolves after closeTask. It can confirm termination
      // if a terminal event was lost, but never creates a successful result.
      const receipt = value as { sessionId?: string; status?: string } | undefined;
      if (!job.terminal && receipt?.sessionId === job.sessionId && receipt.status === 'stopped') {
        job.terminal = true; job.resolve({ schema: 1, sessionId: job.sessionId, stamp: job.request.stamp,
          runIdentity: job.request.runIdentity, seq: job.lastSequence + 1, method: job.request.method,
          operation: job.request.calculation === 'singlepoint' ? 'xtb-singlepoint' : 'xtb-optimize', event: 'stopped',
          reason: 'confirmed-stop-command', exit: { code: null, signal: null } });
      }
    }).catch(error => { job.stopPending = undefined; job.run.error = `停止请求未确认，原生槽保持占用：${message(error)}`; this.publish(); throw new Error(job.run.error); });
    return job.stopPending;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true;
    for (const item of [...this.queue]) await this.stop(item.taskId, item.runId);
    if (this.activeRun) await this.stop(this.activeRun.task.id, this.activeRun.run.id);
    this.releaseOptimizationCaches([...this.tasks.values()].flatMap(task => task.runs.flatMap(run => run.results.filter(result => result.diagnosticDirectory).flatMap(result => result.sessionId ? [result.sessionId] : []))));
    await this.settleCacheReleases();
    this.unsubscribe?.(); this.unsubscribe = undefined; this.publish();
  }
}
